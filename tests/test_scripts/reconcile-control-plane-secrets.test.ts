import { describe, expect, it } from "vitest";

import { reconcileControlPlaneSecrets } from "../../scripts/reconcile-control-plane-secrets.mjs";

const parameter = (name: string, value: string, version: number) => ({
  Name: `/cycloid/${name}`,
  Value: value,
  Version: version,
  LastModifiedDate: `2026-07-11T00:00:0${version}.000Z`,
});

describe("reconcileControlPlaneSecrets", () => {
  const base = [parameter("A_SECRET", "a-value", 1), parameter("B_SECRET", "b-value", 1)];

  it("rejects a mismatched environment and worker", () => {
    expect(() =>
      reconcileControlPlaneSecrets({
        environment: "production",
        workerName: "cycloid-control-plane-qa",
        ssmParameters: base,
        generatedSecrets: { A_SECRET: "a-value", B_SECRET: "b-value" },
        fingerprints: null,
        providerNames: ["A_SECRET"],
      }),
    ).toThrow(/unexpected Worker/);
  });

  it("fails closed on first sync and returns sorted keys without exposing values in errors", () => {
    const result = reconcileControlPlaneSecrets({
      environment: "production",
      workerName: "cycloid-control-plane-production",
      ssmParameters: [parameter("Z_SECRET", "top-secret", 1), parameter("A_SECRET", "also-secret", 1)],
      generatedSecrets: { Z_SECRET: "top-secret", A_SECRET: "also-secret" },
      fingerprints: null,
      providerNames: [],
    });
    expect(result.changedKeys).toEqual(["A_SECRET", "Z_SECRET"]);
    expect(result.secretsChangedCount).toBe(2);
    expect(result.fullSync).toBe(true);
  });

  it("emits no upload for unchanged secrets and only includes an advanced secret", () => {
    const fingerprints = {
      A_SECRET: { version: 1, lastModifiedDate: "2026-07-11T00:00:01.000Z" },
      B_SECRET: { version: 1, lastModifiedDate: "2026-07-11T00:00:01.000Z" },
    };
    const unchanged = reconcileControlPlaneSecrets({
      environment: "qa",
      workerName: "cycloid-control-plane-qa",
      ssmParameters: base,
      generatedSecrets: { A_SECRET: "a-value", B_SECRET: "b-value" },
      fingerprints,
      providerNames: ["A_SECRET", "B_SECRET"],
    });
    expect(unchanged.changedKeys).toEqual([]);
    const changed = reconcileControlPlaneSecrets({
      environment: "qa",
      workerName: "cycloid-control-plane-qa",
      ssmParameters: [parameter("A_SECRET", "new-value", 2), base[1]],
      generatedSecrets: { A_SECRET: "new-value", B_SECRET: "b-value" },
      fingerprints,
      providerNames: ["A_SECRET", "B_SECRET"],
    });
    expect(changed.changedKeys).toEqual(["A_SECRET"]);
    expect(changed.changedSecrets).toEqual({ A_SECRET: "new-value" });
  });

  it("handles additions, removals, exclusions, and malformed provider metadata", () => {
    const result = reconcileControlPlaneSecrets({
      environment: "production",
      workerName: "cycloid-control-plane-production",
      ssmParameters: [parameter("NEW_SECRET", "value", 1), parameter("CONTROL_PLANE_URL", "public", 4)],
      generatedSecrets: { NEW_SECRET: "value" },
      fingerprints: {},
      providerNames: ["OLD_SECRET", "CONTROL_PLANE_URL"],
    });
    expect(result.changedKeys).toEqual(["NEW_SECRET"]);
    expect(result.removedKeys).toEqual(["OLD_SECRET"]);
    const missing = reconcileControlPlaneSecrets({
      environment: "qa",
      workerName: "cycloid-control-plane-qa",
      ssmParameters: base,
      generatedSecrets: { A_SECRET: "a-value", B_SECRET: "b-value" },
      fingerprints: {
        A_SECRET: { version: 1, lastModifiedDate: "2026-07-11T00:00:01.000Z" },
        B_SECRET: { version: 1, lastModifiedDate: "2026-07-11T00:00:01.000Z" },
      },
      providerNames: ["A_SECRET"],
    });
    expect(missing.changedKeys).toEqual(["B_SECRET"]);
    expect(() =>
      reconcileControlPlaneSecrets({
        environment: "qa",
        workerName: "cycloid-control-plane-qa",
        ssmParameters: base,
        generatedSecrets: { A_SECRET: "a-value", B_SECRET: "b-value" },
        fingerprints: {},
        providerNames: [{ nope: true }],
      }),
    ).toThrow(/malformed name/);
  });
});
