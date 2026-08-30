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
import { CustomObjectsApi, KubeConfig, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type { PerconaConnection } from "../config.js";

export const GROUP = "pgv2.percona.com";
export const VERSION = "v2";
export const PLURAL = {
  cluster: "perconapgclusters",
  backup: "perconapgbackups",
  restore: "perconapgrestores",
  upgrade: "perconapgupgrades",
} as const;

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

  deleteCluster(name: string, namespace: string, context?: string, dryRun = false): Promise<any> {
    return this.custom(context).deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.cluster,
      name,
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }

  deleteBackup(name: string, namespace: string, context?: string, dryRun = false): Promise<any> {
    return this.custom(context).deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL.backup,
      name,
      ...(dryRun ? { dryRun: "All" } : {}),
    });
  }
}
