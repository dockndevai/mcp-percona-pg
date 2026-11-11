import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomObjectsApi } from "@kubernetes/client-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../src/config.js";
import { PerconaClient, uidOf, versionToken } from "../src/percona/client.js";
import { buildServer } from "../src/server.js";

const config = (requireHumanApproval = false): AppConfig => ({
  connection: { inCluster: false },
  defaultNamespace: "pg",
  security: {
    mode: "admin",
    namespaceAllowlist: [],
    clusterAllowlist: [],
    protectedClusters: [],
    contextAllowlist: [],
    allowDelete: true,
    allowRestore: true,
    allowUpgrade: true,
    requireConfirmation: true,
    dryRun: false,
    auditLog: false,
    requireHumanApproval,
  },
});

type Answer = { action: "accept" | "decline"; content?: Record<string, unknown> };

/** Connect an in-memory MCP client (optionally able to answer elicitation) to a freshly built server. */
async function connect(opts: { requireHuman?: boolean; answer?: (message: string) => Answer | Promise<Answer>; elicits?: boolean }) {
  const { server } = buildServer(config(opts.requireHuman));
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: opts.elicits === false ? {} : { elicitation: {} } });
  if (opts.elicits !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return (await opts.answer?.(req.params.message)) ?? { action: "accept", content: { confirm: true, typed: "prod-pg" } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

afterEach(() => vi.restoreAllMocks());

describe("delete_cluster approval (end to end)", () => {
  const args = { name: "prod-pg", confirm: "prod-pg" };

  it("shows the tool, full arguments, version and fingerprint, then deletes pinned to the approved uid", async () => {
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockResolvedValue("uid-1:abc");
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "delete_cluster", arguments: args });
    expect(text(res)).toContain('"deleted": true');
    expect(del).toHaveBeenCalledWith("prod-pg", "pg", undefined, false, "uid-1");
    expect(prompts[0]).toContain("tool: delete_cluster");
    expect(prompts[0]).toContain('{"confirm":"prod-pg","name":"prod-pg"}');
    expect(prompts[0]).toContain("resource version: uid-1:abc");
    expect(prompts[0]).toMatch(/fingerprint: [0-9a-f]{16}/);
  });

  it("does NOT delete when the cluster changed while the human was deciding", async () => {
    const versions = ["uid-1:abc", "uid-1:def"];
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_cluster", arguments: args });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });

  it("does NOT delete when the cluster was recreated (new uid) while the human was deciding", async () => {
    const versions = ["uid-1:abc", "uid-2:abc"];
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_cluster", arguments: args });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });

  it("asks the human to type the cluster name, and does NOT delete on a mismatch", async () => {
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockResolvedValue("uid-1:abc");
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client, prompts } = await connect({ answer: () => ({ action: "accept", content: { confirm: true, typed: "wrong" } }) });
    const res = await client.callTool({ name: "delete_cluster", arguments: args });
    expect(prompts).toHaveLength(1);
    expect(text(res)).toContain("typed confirmation did not match");
    expect(del).not.toHaveBeenCalled();
  });

  it("does NOT delete when the human declines", async () => {
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockResolvedValue("uid-1:abc");
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client } = await connect({ answer: () => ({ action: "decline" }) });
    await client.callTool({ name: "delete_cluster", arguments: args });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("PERCONA_REQUIRE_HUMAN_APPROVAL", () => {
  const args = { name: "prod-pg", confirm: "prod-pg" };

  it("falls back to the flags when the client cannot elicit (default)", async () => {
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockResolvedValue("uid-1:abc");
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client } = await connect({ elicits: false });
    await client.callTool({ name: "delete_cluster", arguments: args });
    expect(del).toHaveBeenCalled();
  });

  it("refuses to delete when the client cannot elicit and human approval is required", async () => {
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockResolvedValue("uid-1:abc");
    const del = vi.spyOn(PerconaClient.prototype, "deleteCluster").mockResolvedValue({});
    const { client } = await connect({ elicits: false, requireHuman: true });
    const res = await client.callTool({ name: "delete_cluster", arguments: args });
    expect(text(res)).toContain("no human approval channel");
    expect(del).not.toHaveBeenCalled();
  });
});

describe("other destructive tools bind their version too", () => {
  it("restore_cluster shows the exact arguments and refuses when the cluster's spec changed", async () => {
    const versions = ["uid-1:abc", "uid-1:def"];
    vi.spyOn(PerconaClient.prototype, "clusterVersion").mockImplementation(async () => versions.shift());
    const create = vi.spyOn(PerconaClient.prototype, "createRestore").mockResolvedValue({ metadata: { name: "r" } });
    const { client, prompts } = await connect({});
    const res = await client.callTool({
      name: "restore_cluster",
      arguments: { name: "prod-pg", type: "time", target: "2026-08-30 12:00:00+00", confirm: "prod-pg" },
    });
    expect(prompts[0]).toContain("tool: restore_cluster");
    expect(prompts[0]).toContain("2026-08-30 12:00:00+00");
    expect(text(res)).toContain("resource changed since the prompt");
    expect(create).not.toHaveBeenCalled();
  });

  it("delete_backup refuses when the backup was recreated, and deletes pinned to the uid when stable", async () => {
    const versions = ["b-1:x", "b-2:x"];
    vi.spyOn(PerconaClient.prototype, "backupVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(PerconaClient.prototype, "deleteBackup").mockResolvedValue({});
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_backup", arguments: { name: "bk" } });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();

    vi.spyOn(PerconaClient.prototype, "backupVersion").mockResolvedValue("b-1:x");
    const ok = await client.callTool({ name: "delete_backup", arguments: { name: "bk" } });
    expect(text(ok)).toContain('"deleted": true');
    expect(del).toHaveBeenCalledWith("bk", "pg", undefined, false, "b-1");
  });

  it("promote_standby and upgrade_cluster refuse when the cluster changed", async () => {
    const patch = vi.spyOn(PerconaClient.prototype, "patchCluster").mockResolvedValue({});
    const upgrade = vi.spyOn(PerconaClient.prototype, "createUpgrade").mockResolvedValue({ metadata: { name: "u" } });
    const { client } = await connect({});
    for (const call of [
      { name: "promote_standby", arguments: { name: "dr", confirm: "dr" } },
      {
        name: "upgrade_cluster",
        arguments: {
          name: "dr",
          confirm: "dr",
          fromPostgresVersion: 17,
          toPostgresVersion: 18,
          toPostgresImage: "pg:18",
          toPgBouncerImage: "pgb:1",
          toPgBackRestImage: "pgbr:1",
        },
      },
    ]) {
      const versions = ["u:1", "u:2"];
      const spy = vi.spyOn(PerconaClient.prototype, "clusterVersion").mockImplementation(async () => versions.shift());
      const res = await client.callTool(call);
      expect(text(res)).toContain("resource changed since the prompt");
      spy.mockRestore();
    }
    expect(patch).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  });
});

describe("version tokens", () => {
  const cr = (spec: unknown, extra: Record<string, unknown> = {}) => ({ metadata: { uid: "u1", resourceVersion: "9", ...extra }, spec, status: { state: "ready" } });

  it("is stable across status / resourceVersion churn and key order, and changes with uid or spec", () => {
    const a = versionToken(cr({ x: 1, y: { b: 2, a: 1 } }));
    expect(versionToken({ ...cr({ y: { a: 1, b: 2 }, x: 1 }), status: { state: "initializing" }, metadata: { uid: "u1", resourceVersion: "99" } })).toBe(a);
    expect(versionToken(cr({ x: 2 }))).not.toBe(a);
    expect(versionToken({ ...cr({ x: 1, y: { b: 2, a: 1 } }), metadata: { uid: "u2" } })).not.toBe(a);
    expect(versionToken(undefined)).toBeUndefined();
  });

  it("uidOf extracts the uid and ignores the no-uid placeholder", () => {
    expect(uidOf(versionToken(cr({})))).toBe("u1");
    expect(uidOf(versionToken({ spec: {} }))).toBeUndefined();
    expect(uidOf(undefined)).toBeUndefined();
  });

  it("clusterVersion reads the CR and maps 404 to undefined", async () => {
    const client = new PerconaClient({ inCluster: false });
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(cr({ x: 1 }) as never);
    expect(await client.clusterVersion("c", "pg")).toBe(versionToken(cr({ x: 1 })));
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ plural: "perconapgclusters", name: "c", namespace: "pg" }));
    const { ApiException } = await import("@kubernetes/client-node");
    get.mockRejectedValue(new ApiException(404, "nf", {}, {}));
    expect(await client.backupVersion("b", "pg")).toBeUndefined();
    get.mockRejectedValue(new ApiException(500, "boom", {}, {}));
    await expect(client.clusterVersion("c", "pg")).rejects.toThrow();
  });

  it("deleteCluster sends a uid precondition only when given one", async () => {
    const client = new PerconaClient({ inCluster: false });
    const del = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockResolvedValue({} as never);
    await client.deleteCluster("c", "pg", undefined, false, "u1");
    expect(del).toHaveBeenLastCalledWith(expect.objectContaining({ body: { preconditions: { uid: "u1" } } }));
    await client.deleteCluster("c", "pg");
    expect((del.mock.calls.at(-1)![0] as Record<string, unknown>).body).toBeUndefined();
  });
});
