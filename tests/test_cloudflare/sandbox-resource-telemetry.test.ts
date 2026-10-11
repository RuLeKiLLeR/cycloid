import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSandboxResourceGaugeSeries,
  emitSandboxResourceGauges,
} from "../../apps/control-plane-worker/src/sandbox/resource-telemetry";

const ENV = { DD_API_KEY: "key-123", WORKER_ENV: "production" } as never;

describe("buildSandboxResourceGaugeSeries", () => {
  it("emits one series per present metric with low-cardinality repo/business tags", () => {
    const series = buildSandboxResourceGaugeSeries(ENV, {
      repoOwner: "openevidence",
      repoName: "xyla",
      businessId: "biz-1",
      memoryUsedPercent: 91.2,
      memoryUsedBytes: 15_000,
      swapUsedBytes: 700,
      cpuUsedPercent: 100,
      cpuThrottledPeriodsPercent: 25,
      cpuPressureAvg10: 20,
      memoryPressureAvg10: 40,
      memoryHighEventsDelta: 2,
      memoryOomEventsDelta: 1,
      memoryOomKillEventsDelta: 1,
      pidsCurrent: 900,
      pidsLimit: 1000,
      pidsUsedPercent: 90,
      pidsMaxEventsDelta: 1,
      disks: [{ mount: "workspace", usedPercent: 95, usedBytes: 95, totalBytes: 100, availBytes: 5 }],
    });

    const byMetric = Object.fromEntries(series.map((s) => [s.metric, s]));
    expect(byMetric["arcanist.sandbox.memory.used_percent"].value).toBe(91.2);
    expect(byMetric["arcanist.sandbox.cpu.used_percent"].value).toBe(100);
    expect(byMetric["arcanist.sandbox.cpu.throttled_periods_percent"].value).toBe(25);
    expect(byMetric["arcanist.sandbox.memory.oom_kill_events_delta"].value).toBe(1);
    expect(byMetric["arcanist.sandbox.pids.used_percent"].value).toBe(90);
    expect(byMetric["arcanist.sandbox.pids.max_events_delta"].value).toBe(1);
    expect(byMetric["arcanist.sandbox.disk.used_percent"].value).toBe(95);
    // Absolute free-bytes gauge — the floor monitor's signal.
    expect(byMetric["arcanist.sandbox.disk.avail_bytes"].value).toBe(5);
    expect(byMetric["arcanist.sandbox.disk.avail_bytes"].tags).toContain("mount:workspace");

    const memTags = byMetric["arcanist.sandbox.memory.used_percent"].tags;
    expect(memTags).toEqual(expect.arrayContaining(["repo_owner:openevidence", "repo_name:xyla", "business_id:biz-1"]));
    // No per-session / per-owner tags (unbounded custom-metric cardinality).
    expect(memTags.some((t) => t.startsWith("session_id:") || t.startsWith("owner_user_id:"))).toBe(false);
    // Disk series carries the mount dimension.
    expect(byMetric["arcanist.sandbox.disk.used_percent"].tags).toContain("mount:workspace");
  });

  it("omits series for absent fields and skips business tag when null", () => {
    const series = buildSandboxResourceGaugeSeries(ENV, {
      repoOwner: null,
      repoName: null,
      businessId: null,
      memoryUsedPercent: 50,
    });
    expect(series).toHaveLength(1);
    expect(series[0].metric).toBe("arcanist.sandbox.memory.used_percent");
    expect(series[0].tags).toEqual(expect.arrayContaining(["repo_owner:unknown", "repo_name:unknown"]));
    expect(series[0].tags.some((t) => t.startsWith("business_id:"))).toBe(false);
  });
});

describe("emitSandboxResourceGauges", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs GAUGE (type 3) points to us5", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitSandboxResourceGauges(ENV, {
      repoOwner: "openevidence",
      repoName: "xyla",
      businessId: "biz-1",
      memoryUsedPercent: 88,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.us5.datadoghq.com/api/v2/series");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.series[0].type).toBe(3);
    expect(body.series[0].metric).toBe("arcanist.sandbox.memory.used_percent");
  });

  it("no-ops without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await emitSandboxResourceGauges({ WORKER_ENV: "production" } as never, {
      repoOwner: "a",
      repoName: "b",
      businessId: null,
      memoryUsedPercent: 88,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
