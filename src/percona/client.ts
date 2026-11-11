/**
 * Thin wrapper over @kubernetes/client-node for the Percona Operator for
 * PostgreSQL custom resources (group `pgv2.percona.com/v2`):
 *   - PerconaPGCluster  (the DB + PgBouncer cluster)
 *   - PerconaPGBackup   (on-demand backups)
 *   - PerconaPGRestore  (restore / PITR)
 *   - PerconaPGUpgrade  (major-version upgrades)
 *
 * Loads a standard kube-config (or in-cluster), scopes calls per context, and
 * exposes just the operations the tools need. Loading is best-effort so the
 * server can start and advertise its tools (introspection) without a cluster.
 */
import { createHash } from "node:crypto";
import { ApiException, CustomObjectsApi, KubeConfig, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type { PerconaConnection } from "../config.js";

export const GROUP = "pgv2.percona.com";
export const VERSION = "v2";
export const PLURAL = {
  cluster: "perconapgclusters",
  backup: "perconapgbackups",
  restore: "perconapgrestores",
  upgrade: "perconapgupgrades",
} as const;

/** Deterministic JSON (sorted keys) so equal specs hash equally regardless of key order. */
function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * Version token for a custom resource, pinned across an approval prompt: `uid` (identity) plus a hash of
 * `spec` (content). Deliberately NOT `metadata.resourceVersion`, `generation` or `status`: the operator
 * rewrites status continuously, so those would invalidate every approval. Limits: a change that only
 * touches labels, annotations or finalizers is not detected, and neither is a status change (a backup
 * that finishes while the prompt is open). A recreate is caught because it gets a new uid.
 */
export function versionToken(obj: Record<string, any> | undefined): string | undefined {
  if (!obj) return undefined;
  const uid = obj.metadata?.uid ?? "no-uid";
  const specHash = createHash("sha256").update(canonical(obj.spec ?? null)).digest("hex").slice(0, 12);
  return `${uid}:${specHash}`;
}

/** The uid half of a {@link versionToken} (for delete preconditions), or undefined when absent. */
export function uidOf(token: string | undefined): string | undefined {
  const uid = token?.split(":")[0];
  return uid && uid !== "no-uid" ? uid : undefined;
}

const mergeHeader = () => setHeaderOptions("Content-Type", PatchStrategy.MergePatch);

export class PerconaClient {
  private readonly base: KubeConfig;

  constructor(conn: PerconaConnection) {
    this.base = new KubeConfig();
    try {
      if (conn.inCluster) {
        this.base.loadFromCluster();
      } else if (conn.kubeconfigPath) {
        this.base.loadFromFile(conn.kubeconfigPath);
      } else {
        this.base.loadFromDefault();
      }
      if (conn.defaultContext) this.base.setCurrentContext(conn.defaultContext);
    } catch (err) {
      process.stderr.write(
        `[percona-pg-mcp] WARNING: could not load kube-config (${(err as Error).message}); ` +
          "tool calls will fail until a valid config is available.\n",
      );
    }
  }

  listContextNames(): { name: string; cluster: string; current: boolean }[] {
    const current = this.base.getCurrentContext();
    return this.base.getContexts().map((c) => ({ name: c.name, cluster: c.cluster, current: c.name === current }));
  }

  currentContext(): string {
    return this.base.getCurrentContext();
  }

  private scoped(context?: string): KubeConfig {
    if (!context) return this.base;
    const kc = new KubeConfig();
    kc.loadFromString(this.base.exportConfig());
    kc.setCurrentContext(context);
    return kc;
  }

  private custom(context?: string): CustomObjectsApi {
    return this.scoped(context).makeApiClient(CustomObjectsApi);
  }

  // --- Reads -----------------------------------------------------------------

  async listClusters(namespace: string | undefined, context?: string): Promise<any> {
    const api = this.custom(context);
    if (namespace) {
      return api.listNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL.cluster });
    }
    return api.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL.cluster });
  }

  getCluster(name: string, namespace: string, context?: string): Promise<any> {
    return this.custom(context).getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.cluster,
      name,
    });
  }

  /** Version token of a PerconaPGCluster (see {@link versionToken}); undefined if it does not exist. */
  async clusterVersion(name: string, namespace: string, context?: string): Promise<string | undefined> {
    return this.objectVersion(PLURAL.cluster, name, namespace, context);
  }

  /** Version token of a PerconaPGBackup (see {@link versionToken}); undefined if it does not exist. */
  async backupVersion(name: string, namespace: string, context?: string): Promise<string | undefined> {
    return this.objectVersion(PLURAL.backup, name, namespace, context);
  }

  private async objectVersion(plural: string, name: string, namespace: string, context?: string): Promise<string | undefined> {
    try {
      const obj = await this.custom(context).getNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural, name });
      return versionToken(obj as Record<string, any>);
    } catch (err) {
      if (err instanceof ApiException && err.code === 404) return undefined;
      throw err;
    }
  }

  listBackups(namespace: string, context?: string): Promise<any> {
    return this.custom(context).listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.backup,
    });
  }

  listRestores(namespace: string, context?: string): Promise<any> {
    return this.custom(context).listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.restore,
    });
  }

  listUpgrades(namespace: string, context?: string): Promise<any> {
    return this.custom(context).listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.upgrade,
    });
  }

  // --- Writes / admin (merge-patch the cluster, or create companion CRs) ------

  patchCluster(name: string, namespace: string, patch: unknown, context?: string, dryRun = false): Promise<any> {
    return this.custom(context).patchNamespacedCustomObject(
      {
        group: GROUP,
        version: VERSION,
        namespace,
        plural: PLURAL.cluster,
        name,
        body: patch,
        ...(dryRun ? { dryRun: "All" } : {}),
      },
      mergeHeader(),
    );
  }

  createBackup(namespace: string, body: unknown, context?: string, dryRun = false): Promise<any> {
    return this.custom(context).createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.backup,
      body,
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }

  createRestore(namespace: string, body: unknown, context?: string, dryRun = false): Promise<any> {
    return this.custom(context).createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.restore,
      body,
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }

  createUpgrade(namespace: string, body: unknown, context?: string, dryRun = false): Promise<any> {
    return this.custom(context).createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.upgrade,
      body,
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }

  /** `uid` (from the approved version token) makes the API server refuse the delete if the object was recreated. */
  deleteCluster(name: string, namespace: string, context?: string, dryRun = false, uid?: string): Promise<any> {
    return this.custom(context).deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.cluster,
      name,
      ...(uid ? { body: { preconditions: { uid } } } : {}),
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }

  deleteBackup(name: string, namespace: string, context?: string, dryRun = false, uid?: string): Promise<any> {
    return this.custom(context).deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.backup,
      name,
      ...(uid ? { body: { preconditions: { uid } } } : {}),
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }
}
