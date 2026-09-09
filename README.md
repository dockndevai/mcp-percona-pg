# mcp-percona-pg

[![CI](https://github.com/dockndevai/mcp-percona-pg/actions/workflows/ci.yml/badge.svg)](https://github.com/dockndevai/mcp-percona-pg/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@dockndevai/mcp-percona-pg)](https://www.npmjs.com/package/@dockndevai/mcp-percona-pg)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **[Percona Operator for PostgreSQL](https://docs.percona.com/percona-operator-for-postgresql/2.0/)**. It lets an MCP-capable client (Claude Desktop, Claude Code, Cursor, …) **operate PostgreSQL + PgBouncer clusters on Kubernetes** — topology, connection pooling, tuning, backups/PITR, DR, extensions, and lifecycle — with behaviour controlled entirely by flags.

It drives the operator's custom resources (`PerconaPGCluster`, `PerconaPGBackup`, `PerconaPGRestore`, `PerconaPGUpgrade`) through your kube-config, so the model works the way you already do: *"scale dev-pg to 3 replicas"*, *"switch pooling to transaction mode"*, *"restore prod-pg to 12:00 UTC"*.

Safe by default: it starts **read-only**, can be scoped to an allowlist of namespaces and clusters, protects critical clusters from mutation, gates restore / upgrade / delete behind separate opt-ins, and requires typed confirmation for high-impact actions. It never reads or returns database credentials.

## Features

- **Discovery & status** — list clusters, per-cluster summary and raw `.status` (Patroni members, PostgreSQL/PgBouncer readiness), connection endpoints, backups and restores.
- **Connection pooling** — read and update PgBouncer `pool_mode` and the global pool tunables (`default_pool_size`, `max_client_conn`, …).
- **PostgreSQL tuning** — read/merge parameters via `spec.patroni.dynamicConfiguration` (the only Patroni-safe path).
- **Lifecycle** — scale PostgreSQL/PgBouncer, pause/resume, toggle built-in extensions, on-demand backups.
- **DR & recovery** — restore / point-in-time recovery, promote a standby, major-version upgrades — each individually gated.

## Security model

| Layer | Flag | Effect |
|---|---|---|
| Access mode | `PERCONA_MODE` | `read-only` → `read-write` → `admin`; over-privileged tools are never registered |
| Namespace/cluster allowlists | `PERCONA_NAMESPACE_ALLOWLIST`, `PERCONA_CLUSTER_ALLOWLIST` | scope what the agent can touch |
| Protected clusters | `PERCONA_PROTECTED_CLUSTERS` | readable, never mutated/restored/deleted |
| Restore / upgrade / delete | `PERCONA_ALLOW_RESTORE`, `PERCONA_ALLOW_UPGRADE`, `PERCONA_ALLOW_DELETE` | separate opt-ins on top of admin mode |
| Confirmation | `PERCONA_REQUIRE_CONFIRMATION` | high-impact ops require echoing the cluster name |
| Dry-run / audit | `PERCONA_DRY_RUN`, `PERCONA_AUDIT_LOG` | validate-only; JSON audit line per guarded op |
| Interactive confirmation | *(automatic)* | destructive & high-impact ops prompt the human to approve via MCP elicitation before running; fall back to the `PERCONA_ALLOW_*` gates when the client can't elicit |

## Tools

**Read** (`read-only`+): `list_contexts`, `list_clusters`, `get_cluster`, `get_cluster_status`, `get_connection_info`, `get_pgbouncer_config`, `get_pg_parameters`, `list_backups`, `list_restores`

**Write** (`read-write`+): `scale_cluster`, `set_pgbouncer_config`, `set_pg_parameters`, `pause_cluster`, `toggle_builtin_extension`, `create_backup`

**Admin** (`admin`): `restore_cluster` (needs `PERCONA_ALLOW_RESTORE`), `upgrade_cluster` (needs `PERCONA_ALLOW_UPGRADE`), `promote_standby`, `delete_backup` / `delete_cluster` (need `PERCONA_ALLOW_DELETE`)

## Quickstart — add to your agent

Published on npm as [`@dockndevai/mcp-percona-pg`](https://www.npmjs.com/package/@dockndevai/mcp-percona-pg). No clone or build needed — your MCP client runs it on demand with `npx`. **Start in `read-only` mode**; see [`.env.example`](.env.example) for every variable and [docs/CLIENTS.md](docs/CLIENTS.md) for the full per-client guide.

**Claude Code** (CLI)

```bash
claude mcp add percona-pg -e PERCONA_MODE="read-only" -e PERCONA_NAMESPACE="postgres-operator" -- npx -y @dockndevai/mcp-percona-pg
```

**Claude Desktop · Cursor · Windsurf** — same block in `claude_desktop_config.json`, `.cursor/mcp.json`, or `~/.codeium/windsurf/mcp_config.json`:

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

**OpenAI Codex CLI** — in `~/.codex/config.toml`:

```toml
[mcp_servers.percona-pg]
command = "npx"
args = ["-y", "@dockndevai/mcp-percona-pg"]
env = { PERCONA_MODE = "read-only", PERCONA_NAMESPACE = "postgres-operator" }
```

## Example prompts

- *"List the PostgreSQL clusters and show me the status of `dev-pg`."*
- *"What pool_mode is `dev-pg` using, and how big is the default pool?"* → `get_pgbouncer_config`
- *"Set `dev-pg` PgBouncer to transaction pooling with default_pool_size 25."* (needs `read-write`)
- *"Bump `shared_buffers` to 512MB on `dev-pg`."* (needs `read-write`)
- *"Take a full backup of `dev-pg` to repo1."* (needs `read-write`)
- *"Restore `dev-pg` to 2026-08-30 12:00:00+00."* (needs `admin` + `PERCONA_ALLOW_RESTORE` + confirmation)

## Prerequisites

- A Kubernetes cluster running the **Percona Operator for PostgreSQL v2** (`pgv2.percona.com/v2`).
- A kube-config the server can read. For safety, use a ServiceAccount/RBAC scoped to the operator's namespaces and to the `pgv2.percona.com` resources you want the agent to see.

## Run from source (development)

Prefer the published package above. To run from a clone:

```bash
npm install
npm run build
node dist/index.js   # with the environment variables set
```

## Develop

```bash
npm run dev
npm test          # security policy + annotations
npm run typecheck
```

## Publishing

This server ships a [`server.json`](server.json) for the official MCP registry and an [`mcpName`](package.json) for npm ownership validation. See **[PUBLISHING.md](PUBLISHING.md)**.

## License

MIT
