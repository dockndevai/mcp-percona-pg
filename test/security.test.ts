import { describe, expect, it } from "vitest";
import { PolicyError, SecurityPolicy, type SecurityConfig } from "../src/security.js";

function makePolicy(overrides: Partial<SecurityConfig> = {}): SecurityPolicy {
  return new SecurityPolicy({
    mode: "read-only",
    namespaceAllowlist: [],
    clusterAllowlist: [],
    protectedClusters: ["prod-pg"],
    contextAllowlist: [],
    allowDelete: false,
    allowRestore: false,
    allowUpgrade: false,
    requireConfirmation: true,
    dryRun: false,
    auditLog: false,
    ...overrides,
  });
}

describe("capability vs. access mode", () => {
  it("read-only exposes only read", () => {
    const p = makePolicy({ mode: "read-only" });
    expect(p.isCapabilityEnabled("read")).toBe(true);
    expect(p.isCapabilityEnabled("write")).toBe(false);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });

  it("read-write exposes read + write, not admin", () => {
    const p = makePolicy({ mode: "read-write" });
    expect(p.isCapabilityEnabled("write")).toBe(true);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });

  it("admin exposes everything", () => {
    const p = makePolicy({ mode: "admin" });
    expect(p.isCapabilityEnabled("admin")).toBe(true);
  });

  it("guard throws when capability exceeds mode", () => {
    const p = makePolicy({ mode: "read-only" });
    expect(() => p.guard({ tool: "scale_cluster", capability: "write" })).toThrow(PolicyError);
  });
});

describe("namespace + cluster scoping", () => {
  it("enforces the namespace allowlist", () => {
    const p = makePolicy({ mode: "read-write", namespaceAllowlist: ["pg"] });
    expect(() => p.guard({ tool: "get_cluster", capability: "read", namespace: "other" })).toThrow(PolicyError);
    expect(() => p.guard({ tool: "get_cluster", capability: "read", namespace: "pg" })).not.toThrow();
  });

  it("enforces the cluster allowlist", () => {
    const p = makePolicy({ mode: "read-write", clusterAllowlist: ["dev-pg"] });
    expect(() => p.guard({ tool: "scale_cluster", capability: "write", cluster: "prod-pg" })).toThrow(PolicyError);
  });

  it("allows reading a protected cluster but refuses mutation", () => {
    const p = makePolicy({ mode: "admin" });
    expect(() => p.guard({ tool: "get_cluster", capability: "read", cluster: "prod-pg" })).not.toThrow();
    expect(() => p.guard({ tool: "scale_cluster", capability: "write", cluster: "prod-pg" })).toThrow(PolicyError);
  });
});

describe("destructive / restore / upgrade gating", () => {
  it("refuses delete without allowDelete", () => {
    const p = makePolicy({ mode: "admin", allowDelete: false, requireConfirmation: false });
    expect(() =>
      p.guard({ tool: "delete_cluster", capability: "admin", cluster: "dev-pg", destructive: true }),
    ).toThrow(/PERCONA_ALLOW_DELETE/);
  });

  it("allows delete with allowDelete", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, requireConfirmation: false });
    expect(() =>
      p.guard({ tool: "delete_cluster", capability: "admin", cluster: "dev-pg", destructive: true }),
    ).not.toThrow();
  });

  it("refuses restore without allowRestore", () => {
    const p = makePolicy({ mode: "admin", requireConfirmation: false });
    expect(() =>
      p.guard({ tool: "restore_cluster", capability: "admin", cluster: "dev-pg", requiresRestore: true }),
    ).toThrow(/PERCONA_ALLOW_RESTORE/);
  });

  it("refuses upgrade without allowUpgrade", () => {
    const p = makePolicy({ mode: "admin", requireConfirmation: false });
    expect(() =>
      p.guard({ tool: "upgrade_cluster", capability: "admin", cluster: "dev-pg", requiresUpgrade: true }),
    ).toThrow(/PERCONA_ALLOW_UPGRADE/);
  });
});

describe("typed confirmation for high-impact ops", () => {
  it("refuses when confirmation is missing or wrong", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, requireConfirmation: true });
    expect(() =>
      p.guard({ tool: "delete_cluster", capability: "admin", cluster: "dev-pg", destructive: true, requiresConfirmation: true }),
    ).toThrow(/confirm=/);
    expect(() =>
      p.guard({
        tool: "delete_cluster",
        capability: "admin",
        cluster: "dev-pg",
        destructive: true,
        requiresConfirmation: true,
        confirmProvided: "wrong",
      }),
    ).toThrow(PolicyError);
  });

  it("passes when confirmation matches the cluster name", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, requireConfirmation: true });
    expect(() =>
      p.guard({
        tool: "delete_cluster",
        capability: "admin",
        cluster: "dev-pg",
        destructive: true,
        requiresConfirmation: true,
        confirmProvided: "dev-pg",
      }),
    ).not.toThrow();
  });

  it("skips confirmation when requireConfirmation is off", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, requireConfirmation: false });
    expect(() =>
      p.guard({ tool: "delete_cluster", capability: "admin", cluster: "dev-pg", destructive: true, requiresConfirmation: true }),
    ).not.toThrow();
  });
});

describe("dry-run", () => {
  it("flags mutating ops as dry-run, never reads", () => {
    const p = makePolicy({ mode: "read-write", dryRun: true });
    expect(p.guard({ tool: "get_cluster", capability: "read" }).dryRun).toBe(false);
    expect(p.guard({ tool: "scale_cluster", capability: "write", cluster: "dev-pg" }).dryRun).toBe(true);
  });
});
