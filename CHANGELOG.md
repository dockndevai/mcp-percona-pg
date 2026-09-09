# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-10

### Added
- **Human-in-the-loop confirmation for destructive actions**, via MCP [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation). When the connected client supports elicitation, `delete_cluster`, `delete_backup`, `restore_cluster`, `upgrade_cluster`, and `promote_standby` now pause and ask the **human** to approve the exact action before it runs — a model can echo a confirmation string, but it cannot approve a prompt shown to the user. Clients that don't advertise elicitation fall back to the existing `*_ALLOW_*` flag gate, so enabling this is never *more* permissive than before.

## [0.1.2] - 2026-09-09

### Changed
- Require **Node 22** (previously Node 20); the updated dependency tree needs Node ≥ 22.19. CI and release workflows, the Dockerfile base image, and `engines` were updated.
- Bump the test runner `vitest` to ^5.0.0.

### Security
- Refresh the dependency tree so `npm audit` reports **0 vulnerabilities**.

## [0.1.1] - 2026-08-30

### Changed
- Bump `@modelcontextprotocol/sdk` to ^1.30.0 to clear known dependency advisories flagged by supply-chain scanners.

## [0.1.0]

### Added
- Initial release: a safe-by-default MCP server for the Percona Operator for
  PostgreSQL. 20 tools across read/read-write/admin covering cluster discovery
  and status, PgBouncer connection pooling, PostgreSQL tuning, scaling,
  pause/resume, built-in extensions, on-demand backups, restore/PITR, standby
  promotion, major-version upgrades, and deletes.
- Security model: access modes, namespace/cluster allowlists, protected
  clusters, restore/upgrade/delete opt-ins, typed confirmation for high-impact
  operations, dry-run, and JSON audit logging.
- MCP tool annotations derived from each tool's access capability, with a test
  keeping them consistent.
