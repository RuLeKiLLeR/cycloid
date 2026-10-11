import { describe, expect, it } from "vitest";

import { baseControlPlaneMetricTags } from "../../../apps/control-plane-worker/src/observability/metric-tags";

describe("baseControlPlaneMetricTags", () => {
  it("returns the shared service/worker/env trio for a known environment", () => {
    expect(baseControlPlaneMetricTags({ WORKER_ENV: "production" })).toEqual([
      "service:cycloid-control-plane",
      "worker:control-plane",
      "env:production",
    ]);
  });

  it("passes through non-production known environments (qa)", () => {
    expect(baseControlPlaneMetricTags({ WORKER_ENV: "qa" })).toContain("env:qa");
  });

  it("defaults env to production when WORKER_ENV is unset or unknown", () => {
    expect(baseControlPlaneMetricTags({})).toContain("env:production");
    expect(baseControlPlaneMetricTags({ WORKER_ENV: "bogus" })).toContain("env:production");
  });

  it("returns a fresh array each call so callers can append site tags without cross-talk", () => {
    const first = baseControlPlaneMetricTags({ WORKER_ENV: "production" });
    first.push("repo:acme/repo");
    expect(baseControlPlaneMetricTags({ WORKER_ENV: "production" })).not.toContain("repo:acme/repo");
  });
});
