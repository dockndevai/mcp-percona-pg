# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
