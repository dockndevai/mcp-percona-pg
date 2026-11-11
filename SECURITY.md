# Security

`mcp-percona-pg` exposes PostgreSQL cluster operations (via the Percona
Operator) to an AI agent. Treat it like any other privileged automation and
grant it the least access it needs.

## Principles

- **Start read-only.** Leave `PERCONA_MODE=read-only` until you specifically need
  the agent to make changes. Tools above the current mode are never registered,
  so a read-only server cannot mutate anything even if asked.
- **Scope with RBAC, not just flags.** The flags are defence in depth; the
  primary control is the kube-config / ServiceAccount RBAC. Bind the identity to
  a `Role` that grants only the `pgv2.percona.com` verbs and namespaces you
  intend.
- **Pin the blast radius.** Use `PERCONA_NAMESPACE_ALLOWLIST`,
  `PERCONA_CLUSTER_ALLOWLIST`, and `PERCONA_CONTEXT_ALLOWLIST` to constrain what
  is reachable. Mark critical clusters with `PERCONA_PROTECTED_CLUSTERS` — they
  can be read but never mutated, restored over, or deleted.
- **Gate the dangerous verbs explicitly.** `restore_cluster` needs
  `PERCONA_ALLOW_RESTORE`, `upgrade_cluster` needs `PERCONA_ALLOW_UPGRADE`, and
  `delete_cluster` / `delete_backup` need `PERCONA_ALLOW_DELETE` — each on top of
  admin mode.
- **Require confirmation.** With `PERCONA_REQUIRE_CONFIRMATION=true` (default),
  restore, promote, upgrade, and delete require echoing the exact cluster name.
- **Require a human for destructive ops.** Set `PERCONA_REQUIRE_HUMAN_APPROVAL=true` so
  `restore_cluster`, `promote_standby`, `upgrade_cluster`, `delete_backup` and `delete_cluster` are refused
  when the client cannot show an approval prompt. Each approval is bound to the exact tool and arguments
  (fingerprint) and to the target's version: the object's `uid` plus a hash of its `spec` (the `status` the
  operator rewrites continuously is deliberately excluded, as are labels, annotations and finalizers). If the
  target changed or was recreated while the human was deciding, the action is refused; `delete_cluster` and
  `delete_backup` additionally send the approved `uid` as a delete precondition. `delete_cluster` also asks
  the human to type the cluster name. Reading the version needs the `get` verb on the resource; if that read
  fails the approval is not version-bound. Approval receipts are written to the audit log
  (`"audit":"approval"`, with `approvedBy` = `human` or `flag-only`).
- **Preview with dry-run.** `PERCONA_DRY_RUN=true` validates and logs write
  intent (including the exact patch) without contacting the cluster.
- **Keep the audit log on.** `PERCONA_AUDIT_LOG=true` (default) writes a JSON
  line per guarded operation to stderr.

## Handling of credentials

- The server uses your kube-config or in-cluster ServiceAccount; it stores no
  credentials of its own.
- It **never reads database passwords**. Connection info returns service hosts,
  ports, and user names only — secrets stay in Kubernetes Secrets.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
