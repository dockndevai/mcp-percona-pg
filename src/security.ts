/**
 * Security policy engine for the Percona PostgreSQL MCP server.
 *
 * Flags decide which tools are registered (capability vs. access mode) and
 * whether each individual call is allowed at runtime (namespace + cluster
 * scoping, protected clusters, destructive/restore/upgrade gating, typed
 * confirmation for high-impact operations, dry-run).
 *
 * Pure logic, no I/O, so it is fully unit-testable.
 */

export type Capability = "read" | "write" | "admin";
export type AccessMode = "read-only" | "read-write" | "admin";

const MODE_RANK: Record<AccessMode, number> = { "read-only": 0, "read-write": 1, admin: 2 };
const CAPABILITY_RANK: Record<Capability, number> = { read: 0, write: 1, admin: 2 };

export interface SecurityConfig {
  /** Highest capability the server may expose. */
  mode: AccessMode;
  /** If set, only these namespaces may be touched. Empty = all. */
  namespaceAllowlist: string[];
  /** If set, only these PerconaPGCluster names may be touched. Empty = all. */
  clusterAllowlist: string[];
  /** Clusters that can be read but never mutated, restored over, or deleted. */
  protectedClusters: string[];
  /** If set, only these kube-config contexts may be used. Empty = all. */
  contextAllowlist: string[];
  /** Destructive delete_* operations require this to be true. */
  allowDelete: boolean;
  /** restore_cluster (PITR / repo replay — overwrites data) requires this. */
  allowRestore: boolean;
  /** upgrade_cluster (major-version PerconaPGUpgrade) requires this. */
  allowUpgrade: boolean;
  /** High-impact ops (delete/restore/promote/upgrade) require echoing the cluster name. */
  requireConfirmation: boolean;
  /** Validate + log writes without sending them to the cluster. */
  dryRun: boolean;
  /** Emit a structured JSON audit line to stderr per guarded operation. */
  auditLog: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface GuardContext {
  tool: string;
  capability: Capability;
  namespace?: string;
  /** The target PerconaPGCluster name (for allowlist + protection checks). */
  cluster?: string;
  context?: string;
  /** Destructive delete operation — needs allowDelete. */
  destructive?: boolean;
  /** Requires the restore opt-in. */
  requiresRestore?: boolean;
  /** Requires the upgrade opt-in. */
  requiresUpgrade?: boolean;
  /** High-impact op that needs typed confirmation when requireConfirmation is on. */
  requiresConfirmation?: boolean;
  /** The confirmation value the caller supplied (should equal `cluster`). */
  confirmProvided?: string;
}

export class SecurityPolicy {
  constructor(private readonly config: SecurityConfig) {}

  get mode(): AccessMode {
    return this.config.mode;
  }

  isCapabilityEnabled(capability: Capability): boolean {
    return CAPABILITY_RANK[capability] <= MODE_RANK[this.config.mode];
  }

  isNamespaceAllowed(ns: string): boolean {
    if (this.config.namespaceAllowlist.length === 0) return true;
    return this.config.namespaceAllowlist.includes(ns);
  }

  isClusterAllowed(name: string): boolean {
    if (this.config.clusterAllowlist.length === 0) return true;
    return this.config.clusterAllowlist.includes(name);
  }

  isClusterProtected(name: string): boolean {
    return this.config.protectedClusters.includes(name);
  }

  isContextAllowed(ctx: string): boolean {
    if (this.config.contextAllowlist.length === 0) return true;
    return this.config.contextAllowlist.includes(ctx);
  }

  guard(ctx: GuardContext): { dryRun: boolean } {
    if (!this.isCapabilityEnabled(ctx.capability)) {
      this.audit(ctx, "DENY", `capability '${ctx.capability}' exceeds mode '${this.config.mode}'`);
      throw new PolicyError(
        `Operation '${ctx.tool}' requires '${ctx.capability}' access but the server runs in '${this.config.mode}' mode.`,
      );
    }

    if (ctx.context !== undefined && !this.isContextAllowed(ctx.context)) {
      this.audit(ctx, "DENY", `context '${ctx.context}' not in allowlist`);
      throw new PolicyError(`Context '${ctx.context}' is not in the allowlist (PERCONA_CONTEXT_ALLOWLIST).`);
    }

    if (ctx.namespace !== undefined && !this.isNamespaceAllowed(ctx.namespace)) {
      this.audit(ctx, "DENY", `namespace '${ctx.namespace}' not in allowlist`);
      throw new PolicyError(`Namespace '${ctx.namespace}' is not in the allowlist (PERCONA_NAMESPACE_ALLOWLIST).`);
    }

    if (ctx.cluster !== undefined) {
      if (!this.isClusterAllowed(ctx.cluster)) {
        this.audit(ctx, "DENY", `cluster '${ctx.cluster}' not in allowlist`);
        throw new PolicyError(`Cluster '${ctx.cluster}' is not in the allowlist (PERCONA_CLUSTER_ALLOWLIST).`);
      }
      if (ctx.capability !== "read" && this.isClusterProtected(ctx.cluster)) {
        this.audit(ctx, "DENY", `cluster '${ctx.cluster}' is protected`);
        throw new PolicyError(
          `Cluster '${ctx.cluster}' is protected (PERCONA_PROTECTED_CLUSTERS); mutations are refused.`,
        );
      }
    }

    if (ctx.requiresRestore && !this.config.allowRestore) {
      this.audit(ctx, "DENY", "restore not enabled");
      throw new PolicyError(
        `Operation '${ctx.tool}' is disabled. Set PERCONA_ALLOW_RESTORE=true to enable restores/PITR.`,
      );
    }

    if (ctx.requiresUpgrade && !this.config.allowUpgrade) {
      this.audit(ctx, "DENY", "upgrade not enabled");
      throw new PolicyError(
        `Operation '${ctx.tool}' is disabled. Set PERCONA_ALLOW_UPGRADE=true to enable major-version upgrades.`,
      );
    }

    if (ctx.destructive && !this.config.allowDelete) {
      this.audit(ctx, "DENY", "delete not enabled");
      throw new PolicyError(
        `Destructive operation '${ctx.tool}' is disabled. Set PERCONA_ALLOW_DELETE=true to enable it.`,
      );
    }

    if (ctx.requiresConfirmation && this.config.requireConfirmation) {
      if (!ctx.cluster || ctx.confirmProvided !== ctx.cluster) {
        this.audit(ctx, "DENY", "confirmation mismatch");
        throw new PolicyError(
          `Operation '${ctx.tool}' is high-impact and requires confirmation: pass confirm="${ctx.cluster ?? "<cluster-name>"}" to proceed.`,
        );
      }
    }

    const dryRun = ctx.capability !== "read" && this.config.dryRun;
    this.audit(ctx, dryRun ? "DRY_RUN" : "ALLOW");
    return { dryRun };
  }

  private audit(ctx: GuardContext, decision: string, reason?: string): void {
    if (!this.config.auditLog) return;
    const line = {
      ts: new Date().toISOString(),
      audit: "percona-pg-mcp",
      decision,
      tool: ctx.tool,
      capability: ctx.capability,
      context: ctx.context ?? null,
      namespace: ctx.namespace ?? null,
      cluster: ctx.cluster ?? null,
      destructive: ctx.destructive ?? false,
      ...(reason ? { reason } : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }
}
