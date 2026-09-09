import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, resolveNamespace, textResult } from "./types.js";

const contextArg = {
  context: z.string().optional().describe("kube-config context to target (defaults to current-context)"),
};
const nsArg = { namespace: z.string().optional().describe("Namespace (defaults to PERCONA_NAMESPACE if set)") };
const confirmArg = {
  confirm: z
    .string()
    .optional()
    .describe("Type the exact cluster name to confirm this high-impact action (required unless confirmation is disabled)"),
};

/**
 * Admin tools are registered only in admin mode, and each carries an extra
 * opt-in flag (restore/upgrade/delete) plus typed confirmation on top.
 */
export const adminTools: ToolDef[] = [
  {
    name: "restore_cluster",
    capability: "admin",
    config: {
      title: "Restore / PITR a cluster",
      description:
        "Create a PerconaPGRestore to restore a cluster from a pgBackRest repo — optionally point-in-time. " +
        "OVERWRITES the cluster's data. Requires admin mode AND PERCONA_ALLOW_RESTORE=true, and (by default) " +
        "confirmation. For PITR pass type='time' and a target timestamp.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name to restore"),
        repoName: z.string().default("repo1").describe("pgBackRest repo to restore from"),
        type: z.enum(["immediate", "time"]).default("immediate").describe("immediate = latest; time = PITR"),
        target: z.string().optional().describe("PITR target timestamp, e.g. '2026-08-30 12:00:00+00' (type=time)"),
        ...nsArg,
        ...confirmArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace, confirm }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const repoName = (args.repoName as string) || "repo1";
      const type = (args.type as string) || "immediate";
      const target = args.target as string | undefined;
      if (type === "time" && !target) throw new Error("type='time' requires a `target` timestamp for PITR.");
      const { dryRun } = policy.guard({
        tool: "restore_cluster",
        capability: "admin",
        namespace,
        cluster: name,
        context,
        requiresRestore: true,
        requiresConfirmation: true,
        confirmProvided: args.confirm as string | undefined,
      });
      const options = [`--type=${type}`, ...(target ? [`--target=${target}`] : [])];
      const body = {
        apiVersion: "pgv2.percona.com/v2",
        kind: "PerconaPGRestore",
        metadata: { generateName: `${name}-restore-`, namespace },
        spec: { pgCluster: name, repoName, options },
      };
      if (dryRun) return textResult(`[dry-run] Would create PerconaPGRestore for ${name} (${repoName}, ${options.join(" ")}).`);
      const ok = await confirm.confirm({ action: "restore cluster (OVERWRITES its data)", target: name, details: { namespace, repo: repoName, type } });
      if (!ok.approved) return textResult(`Restore cancelled — ${ok.reason}.`);
      const created = (await client.createRestore(namespace, body, context)) as Record<string, any>;
      return jsonResult({ restoring: true, restore: created.metadata?.name, cluster: name, repoName, options, namespace });
    },
  },
  {
    name: "promote_standby",
    capability: "admin",
    config: {
      title: "Promote a standby cluster",
      description:
        "Promote a DR standby cluster to primary by setting spec.standby.enabled=false. The cluster stops replaying " +
        "from the source repo and begins accepting writes. High-impact — requires admin mode and confirmation.",
      inputSchema: {
        name: z.string().describe("Standby PerconaPGCluster name"),
        ...nsArg,
        ...confirmArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace, confirm }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const { dryRun } = policy.guard({
        tool: "promote_standby",
        capability: "admin",
        namespace,
        cluster: name,
        context,
        requiresConfirmation: true,
        confirmProvided: args.confirm as string | undefined,
      });
      const patch = { spec: { standby: { enabled: false } } };
      if (dryRun) return textResult(`[dry-run] Would promote standby ${namespace}/${name} (standby.enabled=false).`);
      const ok = await confirm.confirm({ action: "promote standby to primary", target: name, details: { namespace } });
      if (!ok.approved) return textResult(`Promotion cancelled — ${ok.reason}.`);
      await client.patchCluster(name, namespace, patch, context);
      return jsonResult({ promoted: true, name, namespace });
    },
  },
  {
    name: "upgrade_cluster",
    capability: "admin",
    config: {
      title: "Major-version upgrade",
      description:
        "Create a PerconaPGUpgrade to perform a major PostgreSQL version upgrade (e.g. 17 → 18). Requires admin mode " +
        "AND PERCONA_ALLOW_UPGRADE=true, and confirmation. You must supply the target images for the operator to use.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name to upgrade"),
        fromPostgresVersion: z.number().int().describe("Current major version, e.g. 17"),
        toPostgresVersion: z.number().int().describe("Target major version, e.g. 18"),
        toPostgresImage: z.string().describe("Target PostgreSQL image"),
        toPgBouncerImage: z.string().describe("Target PgBouncer image"),
        toPgBackRestImage: z.string().describe("Target pgBackRest image"),
        ...nsArg,
        ...confirmArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace, confirm }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const { dryRun } = policy.guard({
        tool: "upgrade_cluster",
        capability: "admin",
        namespace,
        cluster: name,
        context,
        requiresUpgrade: true,
        requiresConfirmation: true,
        confirmProvided: args.confirm as string | undefined,
      });
      const body = {
        apiVersion: "pgv2.percona.com/v2",
        kind: "PerconaPGUpgrade",
        metadata: { generateName: `${name}-upgrade-`, namespace },
        spec: {
          postgresClusterName: name,
          fromPostgresVersion: args.fromPostgresVersion as number,
          toPostgresVersion: args.toPostgresVersion as number,
          toPostgresImage: args.toPostgresImage as string,
          toPgBouncerImage: args.toPgBouncerImage as string,
          toPgBackRestImage: args.toPgBackRestImage as string,
        },
      };
      if (dryRun) return textResult(`[dry-run] Would create PerconaPGUpgrade for ${name} (${args.fromPostgresVersion}→${args.toPostgresVersion}).`);
      const ok = await confirm.confirm({
        action: "major-version upgrade",
        target: name,
        details: { namespace, from: args.fromPostgresVersion as number, to: args.toPostgresVersion as number },
      });
      if (!ok.approved) return textResult(`Upgrade cancelled — ${ok.reason}.`);
      const created = (await client.createUpgrade(namespace, body, context)) as Record<string, any>;
      return jsonResult({ upgrading: true, upgrade: created.metadata?.name, cluster: name, namespace });
    },
  },
  {
    name: "delete_backup",
    capability: "admin",
    config: {
      title: "Delete a backup",
      description:
        "Delete a PerconaPGBackup resource. Requires admin mode AND PERCONA_ALLOW_DELETE=true. Irreversible.",
      inputSchema: {
        name: z.string().describe("PerconaPGBackup resource name"),
        ...nsArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace, confirm }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const { dryRun } = policy.guard({
        tool: "delete_backup",
        capability: "admin",
        namespace,
        context,
        destructive: true,
      });
      if (dryRun) return textResult(`[dry-run] Would delete PerconaPGBackup ${namespace}/${name}.`);
      const ok = await confirm.confirm({ action: "delete backup", target: name, details: { namespace } });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      await client.deleteBackup(name, namespace, context);
      return jsonResult({ deleted: true, backup: name, namespace });
    },
  },
  {
    name: "delete_cluster",
    capability: "admin",
    config: {
      title: "Delete a cluster",
      description:
        "Delete a PerconaPGCluster. Requires admin mode AND PERCONA_ALLOW_DELETE=true, and confirmation. " +
        "Protected clusters are refused. Irreversible — deletes PostgreSQL, PgBouncer, and (per finalizers) data.",
      inputSchema: {
        name: z.string().describe("PerconaPGCluster name"),
        ...nsArg,
        ...confirmArg,
        ...contextArg,
      },
    },
    handler: async (args, { client, policy, defaultNamespace, confirm }) => {
      const name = args.name as string;
      const namespace = resolveNamespace(args.namespace, { defaultNamespace } as any);
      const context = args.context as string | undefined;
      const { dryRun } = policy.guard({
        tool: "delete_cluster",
        capability: "admin",
        namespace,
        cluster: name,
        context,
        destructive: true,
        requiresConfirmation: true,
        confirmProvided: args.confirm as string | undefined,
      });
      if (dryRun) return textResult(`[dry-run] Would delete PerconaPGCluster ${namespace}/${name}.`);
      const ok = await confirm.confirm({ action: "delete cluster (PostgreSQL, PgBouncer, and its data)", target: name, details: { namespace } });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      await client.deleteCluster(name, namespace, context);
      return jsonResult({ deleted: true, cluster: name, namespace });
    },
  },
];
