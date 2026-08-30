import type { ZodRawShape } from "zod";
import type { PerconaClient } from "../percona/client.js";
import type { Capability, SecurityPolicy } from "../security.js";

export interface ToolContext {
  client: PerconaClient;
  policy: SecurityPolicy;
  /** Default namespace from config, used when a tool call omits one. */
  defaultNamespace?: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // Mirror the MCP SDK's open CallToolResult index signature.
  [key: string]: unknown;
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  capability: Capability;
  /** Marks a mutating tool as destructive (data loss possible). Defaults to `capability === "admin"`. */
  destructive?: boolean;
  /** Overrides the idempotency hint. Defaults to `true` for read tools, `false` otherwise. */
  idempotent?: boolean;
  /** If set, the tool is only registered when this predicate passes. */
  enabledWhen?: (policy: SecurityPolicy) => boolean;
  config: {
    title: string;
    description: string;
    inputSchema: Shape;
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Resolve the namespace for a call: explicit arg wins, else the configured default. */
export function resolveNamespace(arg: unknown, ctx: ToolContext): string {
  const ns = (arg as string | undefined) || ctx.defaultNamespace;
  if (!ns) {
    throw new Error(
      "No namespace given and PERCONA_NAMESPACE is not set. Pass `namespace` or set a default.",
    );
  }
  return ns;
}

/** Trim a PerconaPGCluster list/object to the fields a model actually needs. */
export function summarizeCluster(c: Record<string, any>) {
  const spec = c.spec ?? {};
  const status = c.status ?? {};
  const instances = (spec.instances ?? []).reduce((n: number, i: any) => n + (i.replicas ?? 1), 0);
  return {
    name: c.metadata?.name,
    namespace: c.metadata?.namespace,
    state: status.state ?? "unknown",
    postgres: status.postgres ?? { ready: status.postgres?.ready, size: instances },
    pgbouncer: {
      replicas: spec.proxy?.pgBouncer?.replicas,
      poolMode: spec.proxy?.pgBouncer?.config?.global?.pool_mode,
      ready: status.pgbouncer?.ready,
    },
    postgresVersion: spec.postgresVersion,
    crVersion: spec.crVersion,
    paused: spec.pause ?? false,
    standby: spec.standby?.enabled ?? false,
    host: status.host,
  };
}
