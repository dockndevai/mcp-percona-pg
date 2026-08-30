# Per-client installation

`mcp-percona-pg` is a stdio MCP server published as
[`@dockndevai/mcp-percona-pg`](https://www.npmjs.com/package/@dockndevai/mcp-percona-pg).
Every client runs it the same way — `npx -y @dockndevai/mcp-percona-pg` — and is
configured entirely through environment variables (see [`.env.example`](../.env.example)).

**Always start in `read-only` mode.** Move up to `read-write` / `admin` only when
you need it, and turn on the restore/upgrade/delete opt-ins deliberately.

The server reaches the Percona Operator through your **kube-config** — the same
kubeconfig/context you use with `kubectl` against the operator's namespaces. Set
`KUBECONFIG_PATH` if it isn't at the default location, and `PERCONA_NAMESPACE`
to the namespace your `PerconaPGCluster` resources live in.

## Claude Code (CLI)

```bash
claude mcp add percona-pg \
  -e PERCONA_MODE="read-only" \
  -e PERCONA_NAMESPACE="postgres-operator" \
  -- npx -y @dockndevai/mcp-percona-pg
```

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "percona-pg": {
      "command": "npx",
      "args": ["-y", "@dockndevai/mcp-percona-pg"],
      "env": {
        "PERCONA_MODE": "read-only",
        "PERCONA_NAMESPACE": "postgres-operator"
      }
    }
  }
}
```

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) — same block as
Claude Desktop above.

## Windsurf

`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` block.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.percona-pg]
command = "npx"
args = ["-y", "@dockndevai/mcp-percona-pg"]
env = { PERCONA_MODE = "read-only", PERCONA_NAMESPACE = "postgres-operator" }
```

## VS Code (GitHub Copilot, Agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "percona-pg": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@dockndevai/mcp-percona-pg"],
      "env": {
        "PERCONA_MODE": "read-only",
        "PERCONA_NAMESPACE": "postgres-operator"
      }
    }
  }
}
```

## Enabling changes safely

To let the agent make changes, add the env vars you need — for example a
read-write server scoped to one namespace and one cluster, with dry-run on while
you build trust:

```jsonc
"env": {
  "PERCONA_MODE": "read-write",
  "PERCONA_NAMESPACE": "postgres-operator",
  "PERCONA_CLUSTER_ALLOWLIST": "dev-pg",
  "PERCONA_PROTECTED_CLUSTERS": "prod-pg",
  "PERCONA_DRY_RUN": "true"
}
```

For `admin` operations, opt in per verb: `PERCONA_ALLOW_RESTORE`,
`PERCONA_ALLOW_UPGRADE`, `PERCONA_ALLOW_DELETE` — and keep
`PERCONA_REQUIRE_CONFIRMATION=true` so the agent must echo the cluster name.
