#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`[percona-pg-mcp] Configuration error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const built = buildServer(config);

  process.stderr.write(
    `[percona-pg-mcp] Starting in '${config.security.mode}' mode` +
      `${config.security.dryRun ? " (DRY RUN)" : ""}. ` +
      `${built.enabled.length} tools enabled: ${built.enabled.join(", ")}\n`,
  );

  const transport = new StdioServerTransport();
  await built.server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[percona-pg-mcp] Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
