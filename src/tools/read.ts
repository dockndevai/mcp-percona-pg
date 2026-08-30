import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, resolveNamespace, summarizeCluster } from "./types.js";

const contextArg = {
  context: z.string().optional().describe("kube-config context to target (defaults to current-context)"),
};
const nsArg = {
  namespace: z.string().optional().describe("Namespace (defaults to PERCONA_NAMESPACE if set)"),
};
const nameNs = {
  name: z.string().describe("PerconaPGCluster name"),
  ...nsArg,
  ...contextArg,
};

export const readTools: ToolDef[] = [
  {
    name: "list_contexts",
    capability: "read",
    config: {
      title: "List kube-config contexts",
      description: "List the contexts (clusters) available in the loaded kube-config.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_contexts", capability: "read" });
      return jsonResult(client.listContextNames().filter((c) => policy.isContextAllowed(c.name)));
    },
  },
  {
    name: "list_clusters",
    capability: "read",
    config: {
      title: "List PostgreSQL clusters",
      description:
        "List PerconaPGCluster resources (PostgreSQL + PgBouncer). Omit `namespace` to list across all " +
        "namespaces. Results are filtered by the namespace/cluster allowlists; protected clusters are flagged.",
      inputSchema: { ...nsArg, ...contextArg },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const namespace = (args.namespace as string | undefined) || defaultNamespace;
      const context = args.context as string | undefined;
      policy.guard({ tool: "list_clusters", capability: "read", namespace, context });
      const res = await client.listClusters(namespace, context);
      const items = ((res.items as Array<Record<string, any>>) ?? [])
        .filter((c) => policy.isNamespaceAllowed(c.metadata?.namespace ?? "") && policy.isClusterAllowed(c.metadata?.name ?? ""))
        .map((c) => ({ ...summarizeCluster(c), protected: policy.isClusterProtected(c.metadata?.name ?? "") }));
      return jsonResult(items);
    },
  },
  {
    name: "get_cluster",
    capability: "read",
    config: {
      title: "Get cluster (summary)",
      description: "Summary of a PerconaPGCluster: state, PostgreSQL size, PgBouncer, version, standby, host.",
      inputSchema: { ...nameNs },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "get_cluster", capability: "read", namespace, cluster: name, context });
      const c = await client.getCluster(name, namespace, context);
      return jsonResult(summarizeCluster(c as Record<string, any>));
    },
  },
  {
    name: "get_cluster_status",
    capability: "read",
    config: {
      title: "Get cluster status (raw)",
      description:
        "The full `.status` of a PerconaPGCluster — Patroni members, PostgreSQL/PgBouncer readiness, host, and conditions.",
      inputSchema: { ...nameNs },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "get_cluster_status", capability: "read", namespace, cluster: name, context });
      const c = (await client.getCluster(name, namespace, context)) as Record<string, any>;
      return jsonResult({ name, namespace, status: c.status ?? {} });
    },
  },
  {
    name: "get_connection_info",
    capability: "read",
    config: {
      title: "Get connection info",
      description:
        "Connection endpoints for a cluster: the primary/replica Service hosts, port, and the declared users " +
        "(names only — passwords live in Secrets and are never returned).",
      inputSchema: { ...nameNs },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "get_connection_info", capability: "read", namespace, cluster: name, context });
      const c = (await client.getCluster(name, namespace, context)) as Record<string, any>;
      const pgbouncerPort = c.spec?.proxy?.pgBouncer?.expose?.port ?? 5432;
      return jsonResult({
        name,
        namespace,
        host: c.status?.host ?? `${name}-pgbouncer.${namespace}.svc`,
        services: {
          pgbouncer: `${name}-pgbouncer.${namespace}.svc`,
          primary: `${name}-primary.${namespace}.svc`,
          replicas: `${name}-replicas.${namespace}.svc`,
        },
        port: pgbouncerPort,
        users: (c.spec?.users ?? []).map((u: any) => ({ name: u.name, databases: u.databases })),
        note: "Credentials are stored in the cluster's Secrets; this server never reads or returns them.",
      });
    },
  },
  {
    name: "get_pgbouncer_config",
    capability: "read",
    config: {
      title: "Get PgBouncer config",
      description: "The PgBouncer settings for a cluster: replicas, pool_mode, and the global pool tunables.",
      inputSchema: { ...nameNs },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "get_pgbouncer_config", capability: "read", namespace, cluster: name, context });
      const c = (await client.getCluster(name, namespace, context)) as Record<string, any>;
      const pgb = c.spec?.proxy?.pgBouncer ?? {};
      return jsonResult({
        name,
        namespace,
        replicas: pgb.replicas,
        exposeSuperusers: pgb.exposeSuperusers ?? false,
        config: pgb.config ?? {},
      });
    },
  },
  {
    name: "get_pg_parameters",
    capability: "read",
    config: {
      title: "Get PostgreSQL parameters",
      description:
        "The tuned PostgreSQL parameters from `spec.patroni.dynamicConfiguration.postgresql.parameters` " +
        "(the only correct place to set them — direct postgresql.conf edits are reverted by Patroni).",
      inputSchema: { ...nameNs },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "get_pg_parameters", capability: "read", namespace, cluster: name, context });
      const c = (await client.getCluster(name, namespace, context)) as Record<string, any>;
      return jsonResult({
        name,
        namespace,
        parameters: c.spec?.patroni?.dynamicConfiguration?.postgresql?.parameters ?? {},
      });
    },
  },
  {
    name: "list_backups",
    capability: "read",
    config: {
      title: "List backups",
      description: "List PerconaPGBackup resources in a namespace, with their state, repo, and completion time.",
      inputSchema: { ...nsArg, ...contextArg },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "list_backups", capability: "read", namespace, context });
      const res = await client.listBackups(namespace, context);
      const items = ((res.items as Array<Record<string, any>>) ?? []).map((b) => ({
        name: b.metadata?.name,
        cluster: b.spec?.pgCluster,
        repo: b.spec?.repoName,
        type: b.spec?.options,
        state: b.status?.state,
        completed: b.status?.completed,
      }));
      return jsonResult(items);
    },
  },
  {
    name: "list_restores",
    capability: "read",
    config: {
      title: "List restores",
      description: "List PerconaPGRestore resources in a namespace, with their target cluster and state.",
      inputSchema: { ...nsArg, ...contextArg },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      policy.guard({ tool: "list_restores", capability: "read", namespace, context });
      const res = await client.listRestores(namespace, context);
      const items = ((res.items as Array<Record<string, any>>) ?? []).map((r) => ({
        name: r.metadata?.name,
        cluster: r.spec?.pgCluster,
        repo: r.spec?.repoName,
        options: r.spec?.options,
        state: r.status?.state,
      }));
      return jsonResult(items);
    },
  },
];
