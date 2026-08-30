import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, resolveNamespace, textResult } from "./types.js";

const contextArg = {
  context: z.string().optional().describe("kube-config context to target (defaults to current-context)"),
};
const nsArg = { namespace: z.string().optional().describe("Namespace (defaults to PERCONA_NAMESPACE if set)") };

export const writeTools: ToolDef[] = [
  {
    name: "scale_cluster",
    capability: "write",
    config: {
      title: "Scale a cluster",
      description:
        "Set the PostgreSQL instance replica count and/or the PgBouncer replica count for a cluster. " +
        "PostgreSQL scaling is read-modify-write so other instance settings (resources, volumes) are preserved.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name"),
        pgReplicas: z.number().int().min(1).max(9).optional().describe("Desired PostgreSQL instance replicas"),
        pgbouncerReplicas: z.number().int().min(0).max(9).optional().describe("Desired PgBouncer replicas"),
        instanceName: z.string().optional().describe("Which instance set to scale (defaults to the first)"),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const pgReplicas = args.pgReplicas as number | undefined;
      const pgbouncerReplicas = args.pgbouncerReplicas as number | undefined;
      if (pgReplicas === undefined && pgbouncerReplicas === undefined) {
        return textResult("Nothing to do: provide pgReplicas and/or pgbouncerReplicas.");
      }
      const { dryRun } = policy.guard({ tool: "scale_cluster", capability: "write", namespace, cluster: name, context });

      const patch: any = { spec: {} };
      if (pgReplicas !== undefined) {
        const c = (await client.getCluster(name, namespace, context)) as Record<string, any>;
        const instances = structuredClone(c.spec?.instances ?? []);
        if (instances.length === 0) {
          instances.push({ name: (args.instanceName as string) || "instance1", replicas: pgReplicas });
        } else {
          const target = args.instanceName
            ? instances.find((i: any) => i.name === args.instanceName)
            : instances[0];
          if (!target) throw new Error(`Instance set '${args.instanceName}' not found on cluster '${name}'.`);
          target.replicas = pgReplicas;
        }
        patch.spec.instances = instances;
      }
      if (pgbouncerReplicas !== undefined) {
        patch.spec.proxy = { pgBouncer: { replicas: pgbouncerReplicas } };
      }

      if (dryRun) return textResult(`[dry-run] Would patch ${namespace}/${name}: ${JSON.stringify(patch)}`);
      await client.patchCluster(name, namespace, patch, context);
      return jsonResult({ scaled: true, name, namespace, pgReplicas, pgbouncerReplicas });
    },
  },
  {
    name: "set_pgbouncer_config",
    capability: "write",
    config: {
      title: "Set PgBouncer config",
      description:
        "Update PgBouncer global pool settings (merged into spec.proxy.pgBouncer.config.global). " +
        "Common keys: pool_mode (session|transaction|statement), default_pool_size, max_client_conn, " +
        "min_pool_size, reserve_pool_size, server_idle_timeout, query_wait_timeout, max_db_connections.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name"),
        poolMode: z.enum(["session", "transaction", "statement"]).optional().describe("PgBouncer pool_mode"),
        settings: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('Other global settings, e.g. {"default_pool_size":"25","max_client_conn":"500"}'),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const global: Record<string, unknown> = { ...((args.settings as Record<string, unknown>) ?? {}) };
      if (args.poolMode) global.pool_mode = args.poolMode;
      if (Object.keys(global).length === 0) return textResult("Nothing to do: provide poolMode and/or settings.");
      const { dryRun } = policy.guard({ tool: "set_pgbouncer_config", capability: "write", namespace, cluster: name, context });
      const patch = { spec: { proxy: { pgBouncer: { config: { global } } } } };
      if (dryRun) return textResult(`[dry-run] Would patch ${namespace}/${name}: ${JSON.stringify(patch)}`);
      await client.patchCluster(name, namespace, patch, context);
      return jsonResult({ updated: true, name, namespace, global });
    },
  },
  {
    name: "set_pg_parameters",
    capability: "write",
    config: {
      title: "Set PostgreSQL parameters",
      description:
        "Merge PostgreSQL parameters into spec.patroni.dynamicConfiguration.postgresql.parameters (the correct, " +
        "Patroni-managed path). Keys are added/overridden; set a value to null to remove it. Some parameters need " +
        "a rolling restart (the operator sequences replicas before the primary).",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name"),
        parameters: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe('e.g. {"shared_buffers":"512MB","work_mem":"16MB","max_connections":"200"}'),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const parameters = args.parameters as Record<string, unknown>;
      const { dryRun } = policy.guard({ tool: "set_pg_parameters", capability: "write", namespace, cluster: name, context });
      const patch = { spec: { patroni: { dynamicConfiguration: { postgresql: { parameters } } } } };
      if (dryRun) return textResult(`[dry-run] Would patch ${namespace}/${name}: ${JSON.stringify(patch)}`);
      await client.patchCluster(name, namespace, patch, context);
      return jsonResult({ updated: true, name, namespace, parameters });
    },
  },
  {
    name: "pause_cluster",
    capability: "write",
    config: {
      title: "Pause / resume a cluster",
      description:
        "Set spec.pause. Pausing stops the PostgreSQL and PgBouncer pods (spec is retained) to free resources; " +
        "resuming brings them back. Useful for parking a dev cluster.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name"),
        paused: z.boolean().describe("true = pause (stop pods), false = resume"),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const paused = args.paused as boolean;
      const { dryRun } = policy.guard({ tool: "pause_cluster", capability: "write", namespace, cluster: name, context });
      const patch = { spec: { pause: paused } };
      if (dryRun) return textResult(`[dry-run] Would set pause=${paused} on ${namespace}/${name}.`);
      await client.patchCluster(name, namespace, patch, context);
      return jsonResult({ name, namespace, paused });
    },
  },
  {
    name: "toggle_builtin_extension",
    capability: "write",
    config: {
      title: "Toggle a built-in extension",
      description:
        "Enable or disable a built-in extension via spec.extensions.builtin (pg_stat_monitor, pg_stat_statements, " +
        "pg_audit, pgvector, pg_repack). Note: preload-requiring extensions also need shared_preload_libraries set " +
        "(via set_pg_parameters) and a restart before CREATE EXTENSION succeeds.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name"),
        extension: z
          .enum(["pg_stat_monitor", "pg_stat_statements", "pg_audit", "pgvector", "pg_repack"])
          .describe("Built-in extension"),
        enabled: z.boolean().describe("true = enable, false = disable"),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const extension = args.extension as string;
      const enabled = args.enabled as boolean;
      const { dryRun } = policy.guard({ tool: "toggle_builtin_extension", capability: "write", namespace, cluster: name, context });
      const patch = { spec: { extensions: { builtin: { [extension]: enabled } } } };
      if (dryRun) return textResult(`[dry-run] Would set builtin.${extension}=${enabled} on ${namespace}/${name}.`);
      await client.patchCluster(name, namespace, patch, context);
      return jsonResult({ name, namespace, extension, enabled });
    },
  },
  {
    name: "create_backup",
    capability: "write",
    config: {
      title: "Create an on-demand backup",
      description:
        "Create a PerconaPGBackup for a cluster (pgBackRest). repoName selects the configured repo (e.g. repo1 = PVC, " +
        "repo2 = S3). type maps to a pgBackRest --type option.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name to back up"),
        repoName: z.string().default("repo1").describe("pgBackRest repo name (repo1..repo4)"),
        type: z.enum(["full", "differential", "incremental"]).default("full").describe("Backup type"),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const repoName = (args.repoName as string) || "repo1";
      const type = (args.type as string) || "full";
      const { dryRun } = policy.guard({ tool: "create_backup", capability: "write", namespace, cluster: name, context });
      const body = {
        apiVersion: "pgv2.percona.com/v2",
        kind: "PerconaPGBackup",
        metadata: { generateName: `${name}-ondemand-`, namespace },
        spec: { pgCluster: name, repoName, options: [`--type=${type}`] },
      };
      if (dryRun) return textResult(`[dry-run] Would create PerconaPGBackup for ${name} (${repoName}, ${type}).`);
      const created = (await client.createBackup(namespace, body, context)) as Record<string, any>;
      return jsonResult({ created: true, backup: created.metadata?.name, cluster: name, repoName, type, namespace });
    },
  },
];
