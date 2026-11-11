import { ApiException } from "@kubernetes/client-node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { PerconaClient } from "./percona/client.js";
import { canonicalArgs, makeConfirmer } from "./elicit.js";
import { GuardClient, loadGuardConfig } from "./guard.js";
import { PolicyError, SecurityPolicy } from "./security.js";
import { adminTools } from "./tools/admin.js";
import { annotationsFor } from "./tools/annotations.js";
import { readTools } from "./tools/read.js";
import type { ToolContext, ToolDef } from "./tools/types.js";
import { writeTools } from "./tools/write.js";

export const ALL_TOOLS: ToolDef[] = [...readTools, ...writeTools, ...adminTools];

export function buildServer(config: AppConfig): { server: McpServer; enabled: string[] } {
  const policy = new SecurityPolicy(config.security);
  const client = new PerconaClient(config.connection);
  const server = new McpServer({ name: "mcp-percona-pg", version: "0.4.0" });
  const guard = new GuardClient(loadGuardConfig());
  const confirmer = makeConfirmer(server, {
    name: "mcp-percona-pg",
    requireHuman: config.security.requireHumanApproval,
    audit: config.security.auditLog,
  });
  const ctx: ToolContext = { client, policy, defaultNamespace: config.defaultNamespace, confirm: confirmer, guard };

  const enabled: string[] = [];
  for (const tool of ALL_TOOLS) {
    if (!policy.isCapabilityEnabled(tool.capability)) continue;
    if (tool.enabledWhen && !tool.enabledWhen(policy)) continue;
    enabled.push(tool.name);

    server.registerTool(
      tool.name,
      { ...tool.config, annotations: annotationsFor(tool) },
      async (args: Record<string, unknown>) => {
        try {
          // Every approval prompt in this call is bound to this tool + these exact arguments.
          const callCtx: ToolContext = { ...ctx, confirm: confirmer.forCall(tool.name, args ?? {}) };
          // laya-guard: assess every mutating op before it runs (no-op unless *_GUARD_MODE is set).
          if (tool.capability !== "read") {
            await guard.enforce({ tool: tool.name, command: `${tool.name} ${canonicalArgs(args ?? {})}`, context: tool.name }, callCtx.confirm);
          }
          return await tool.handler(args ?? {}, callCtx);
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );
  }

  return { server, enabled };
}

function toErrorResult(err: unknown) {
  let message: string;
  if (err instanceof PolicyError) {
    message = `Policy denied: ${err.message}`;
  } else if (err instanceof ApiException) {
    message = `Kubernetes API error (${err.code}): ${truncate(String(err.body ?? err.message))}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function truncate(s: string, max = 800): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
