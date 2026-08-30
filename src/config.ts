/**
 * Configuration from environment variables. Cluster connection details come
 * from a standard kube-config (KUBECONFIG or ~/.kube/config, or in-cluster) —
 * the same kube-config that can reach the Percona Operator's namespaces.
 */
import type { AccessMode, SecurityConfig } from "./security.js";

export interface PerconaConnection {
  /** Explicit path to a kube-config file. Empty = default resolution. */
  kubeconfigPath?: string;
  /** Load in-cluster config (service account) instead of a kube-config file. */
  inCluster: boolean;
  /** Default context to use when a tool call omits one. Empty = current-context. */
  defaultContext?: string;
}

export interface AppConfig {
  connection: PerconaConnection;
  security: SecurityConfig;
  /** Default namespace used when a tool omits one. Empty = must be supplied per call. */
  defaultNamespace?: string;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMode(): AccessMode {
  const raw = (process.env.PERCONA_MODE ?? "read-only").toLowerCase();
  if (raw === "read-only" || raw === "read-write" || raw === "admin") return raw;
  throw new Error(`Invalid PERCONA_MODE '${raw}'. Expected one of: read-only, read-write, admin.`);
}

export function loadConfig(): AppConfig {
  return {
    connection: {
      kubeconfigPath: process.env.KUBECONFIG_PATH || undefined,
      inCluster: bool("PERCONA_IN_CLUSTER", false),
      defaultContext: process.env.PERCONA_CONTEXT || undefined,
    },
    defaultNamespace: process.env.PERCONA_NAMESPACE || undefined,
    security: {
      mode: parseMode(),
      namespaceAllowlist: list("PERCONA_NAMESPACE_ALLOWLIST"),
      clusterAllowlist: list("PERCONA_CLUSTER_ALLOWLIST"),
      protectedClusters: list("PERCONA_PROTECTED_CLUSTERS"),
      contextAllowlist: list("PERCONA_CONTEXT_ALLOWLIST"),
      allowDelete: bool("PERCONA_ALLOW_DELETE", false),
      allowRestore: bool("PERCONA_ALLOW_RESTORE", false),
      allowUpgrade: bool("PERCONA_ALLOW_UPGRADE", false),
      requireConfirmation: bool("PERCONA_REQUIRE_CONFIRMATION", true),
      dryRun: bool("PERCONA_DRY_RUN", false),
      auditLog: bool("PERCONA_AUDIT_LOG", true),
    },
  };
}
