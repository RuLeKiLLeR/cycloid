import { describe, expect, it } from "vitest";

import {
  buildSandboxResourceSample,
  collectRuntimeResourceSnapshot,
  runtimeResourceDelta,
  runtimeResourceLogFields,
  type RuntimeResourceSnapshot,
} from "../../apps/sandbox-bridge/src/services/runtime-resource-snapshot.ts";

describe("runtime resource snapshots", () => {
  it("collects a best-effort snapshot without throwing", () => {
    const snapshot = collectRuntimeResourceSnapshot({ includeCodexConfig: false });

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.capturedAtMs).toBeGreaterThan(0);
    expect(snapshot.hostIdentity || snapshot.cgroup || snapshot.pressure || snapshot.disks).toBeTruthy();
    expect(snapshot.resourceSources?.procSelfStatus).toEqual(
      expect.objectContaining({
        exists: expect.any(Boolean),
      }),
    );
    expect(snapshot.process).toEqual(
      expect.objectContaining({
        pid: process.pid,
        memoryUsage: expect.any(Object),
        resourceUsage: expect.any(Object),
      }),
    );
  });

  it("computes CPU, memory, and pressure deltas", () => {
    const before: RuntimeResourceSnapshot = {
      schemaVersion: 2,
      capturedAtMs: 1000,
      cgroup: {
        cpu: {
          usage_usec: 10,
          nr_throttled: 1,
          throttled_usec: 20,
        },
        memory: {
          currentBytes: 100,
          events: {
            oom: 0,
            oom_kill: 0,
          },
        },
      },
      pressure: {
        cpu: { some: { total: 10 } },
        io: { full: { total: 20 } },
        memory: null,
      },
    };
    const after: RuntimeResourceSnapshot = {
      schemaVersion: 2,
      capturedAtMs: 1500,
      cgroup: {
        cpu: {
          usage_usec: 70,
          nr_throttled: 3,
          throttled_usec: 90,
        },
        memory: {
          currentBytes: 160,
          events: {
            oom: 1,
            oom_kill: 0,
          },
        },
      },
      pressure: {
        cpu: { some: { total: 25 } },
        io: { full: { total: 30 } },
        memory: null,
      },
    };

    const delta = runtimeResourceDelta(before, after);

    expect(delta).toEqual({
      elapsedMs: 500,
      cpu: {
        usage_usec: 60,
        nr_throttled: 2,
        throttled_usec: 70,
      },
      memoryEvents: {
        oom: 1,
        oom_kill: 0,
      },
      memoryCurrentBytes: 60,
      pressureTotals: {
        cpu: { some: { total: 15 } },
        io: { full: { total: 10 } },
      },
    });
  });

  it("flattens log fields so Datadog redaction keeps values queryable", () => {
    const snapshot: RuntimeResourceSnapshot = {
      schemaVersion: 2,
      capturedAtMs: 1000,
      hostIdentity: {
        hostname: "sandbox-runtime",
        bootIdHash: "abc123",
      },
      runtimeResources: {
        provider: "e2b",
        environment: "qa",
        sessionKind: "repo",
      },
      disks: {
        "/root": {
          path: "/root",
          exists: true,
          availableBytes: 10,
        },
        "/workspace/repo": {
          path: "/workspace/repo",
          exists: true,
          availableBytes: 20,
        },
      },
      resourceSources: {
        cgroupRoot: { exists: true, kind: "directory", readable: true },
        cgroupCpuStat: { exists: true, kind: "file", readable: true },
        cgroupCpuMax: { exists: true, kind: "file", readable: true },
        cgroupCpuWeight: { exists: true, kind: "file", readable: true },
        cgroupMemoryCurrent: { exists: true, kind: "file", readable: true },
        cgroupMemoryMax: { exists: true, kind: "file", readable: true },
        cgroupMemoryEvents: { exists: true, kind: "file", readable: true },
        cgroupMemoryPeak: { exists: false },
        cgroupPidsCurrent: { exists: true, kind: "file", readable: true },
        cgroupPidsMax: { exists: true, kind: "file", readable: true },
        cgroupPidsEvents: { exists: true, kind: "file", readable: true },
        psiCpu: { exists: true, kind: "file", readable: false },
        psiIo: { exists: true, kind: "file", readable: true },
        psiMemory: { exists: true, kind: "file", readable: true },
        procSelfStatus: { exists: true, kind: "file", readable: true },
        procLoadavg: { exists: true, kind: "file", readable: true },
      },
      process: {
        pid: 123,
        uptimeSeconds: 4,
        memoryUsage: {
          rss: 100,
          heapTotal: 200,
          heapUsed: 150,
          external: 10,
          arrayBuffers: 5,
        },
        resourceUsage: {
          userCPUTime: 1,
          systemCPUTime: 2,
          maxRSS: 3,
          sharedMemorySize: 0,
          unsharedDataSize: 0,
          unsharedStackSize: 0,
          minorPageFault: 4,
          majorPageFault: 0,
          swappedOut: 0,
          fsRead: 0,
          fsWrite: 0,
          ipcSent: 0,
          ipcReceived: 0,
          signalsCount: 0,
          voluntaryContextSwitches: 6,
          involuntaryContextSwitches: 7,
        },
        procSelfStatus: {
          vmRssBytes: 100,
          threads: 2,
        },
      },
    };

    const fields = runtimeResourceLogFields(snapshot, {
      elapsedMs: 50,
      cpu: { nr_throttled: 2 },
      pressureTotals: {
        cpu: { some: { total: 10 } },
      },
    });

    expect(fields.runtimeResourceSchemaVersion).toBe(2);
    expect(fields.runtimeHost).toEqual({ hostname: "sandbox-runtime", bootIdHash: "abc123" });
    expect(fields.runtimeResources).toEqual({ provider: "e2b", environment: "qa", sessionKind: "repo" });
    expect(fields.runtimeProcess).toEqual(snapshot.process);
    expect(fields.runtimeResourceAvailability).toEqual(
      expect.objectContaining({
        cgroupCpuStatReadable: true,
        cgroupMemoryPeakReadable: false,
        psiCpuReadable: false,
        procSelfStatusReadable: true,
      }),
    );
    expect(fields.runtimeDiskRoot).toEqual({ path: "/root", exists: true, availableBytes: 10 });
    expect(fields.runtimeDiskRepo).toEqual({ path: "/workspace/repo", exists: true, availableBytes: 20 });
    expect(fields.runtimeDeltaElapsedMs).toBe(50);
    expect(fields.runtimeCpuDelta).toEqual({ nr_throttled: 2 });
    expect(fields.runtimePressureTotalsDelta).toEqual({ cpu_some_total: 10 });
  });
});

describe("buildSandboxResourceSample", () => {
  const base = (over: Partial<RuntimeResourceSnapshot> = {}): RuntimeResourceSnapshot => ({
    schemaVersion: 2,
    capturedAtMs: 1_000_000,
    ...over,
  });

  it("derives memory percent, swap, pressure, and disks from one snapshot", () => {
    const snapshot = base({
      cgroup: {
        memory: { currentBytes: 8 * 1024 ** 3, maxBytes: 16 * 1024 ** 3, swapCurrentBytes: 1024 ** 3 },
      },
      pressure: { cpu: null, io: null, memory: { some: { avg10: 42.5 } } },
      disks: {
        "/workspace": { path: "/workspace", exists: true, totalBytes: 100, availableBytes: 10 },
        "/root": { path: "/root", exists: true, totalBytes: 200, freeBytes: 50 },
      },
    });

    const sample = buildSandboxResourceSample(snapshot);

    expect(sample.memoryUsedBytes).toBe(8 * 1024 ** 3);
    expect(sample.memoryLimitBytes).toBe(16 * 1024 ** 3);
    expect(sample.memoryUsedPercent).toBe(50);
    expect(sample.swapUsedBytes).toBe(1024 ** 3);
    expect(sample.memoryPressureAvg10).toBe(42.5);
    // usedPercent prefers availableBytes over freeBytes; 90 used / 100 total.
    // availBytes carries the free bytes through for the ENOSPC-floor monitor.
    expect(sample.disks).toEqual(
      expect.arrayContaining([
        { mount: "workspace", usedBytes: 90, totalBytes: 100, usedPercent: 90, availBytes: 10 },
        { mount: "root", usedBytes: 150, totalBytes: 200, usedPercent: 75, availBytes: 50 },
      ]),
    );
    // No previous snapshot → no CPU rate.
    expect(sample.cpuUsedPercent).toBeUndefined();
  });

  it("falls back to runtime memory limit when cgroup max is 'max'", () => {
    const sample = buildSandboxResourceSample(
      base({
        cgroup: { memory: { currentBytes: 2 * 1024 ** 2, maxBytes: "max" } },
        runtimeResources: { memoryLimitMb: 8 },
      }),
    );
    expect(sample.memoryLimitBytes).toBe(8 * 1024 ** 2);
    expect(sample.memoryUsedPercent).toBe(25);
  });

  it("computes CPU percent normalized to cgroup cores across two samples", () => {
    const previous = base({
      capturedAtMs: 1_000_000,
      cgroup: { cpu: { usage_usec: 0, cpuMax: "400000 100000" } },
    });
    // 1s wall later, 2s of CPU time consumed across 4 cores → 50% of capacity.
    const current = base({
      capturedAtMs: 1_001_000,
      cgroup: { cpu: { usage_usec: 2_000_000, cpuMax: "400000 100000" } },
    });
    const sample = buildSandboxResourceSample(current, previous);
    expect(sample.cpuUsedPercent).toBe(50);
  });

  it("derives CPU throttling, cgroup memory events, and PID pressure across samples", () => {
    const previous = base({
      capturedAtMs: 1_000_000,
      cgroup: {
        cpu: { usage_usec: 0, nr_periods: 100, nr_throttled: 10, cpuMax: "200000 100000" },
        memory: { events: { high: 2, oom: 1, oom_kill: 0 } },
        pids: { current: 200, max: 1000, events: { max: 3 } },
      },
    });
    const current = base({
      capturedAtMs: 1_001_000,
      cgroup: {
        cpu: { usage_usec: 1_000_000, nr_periods: 200, nr_throttled: 35, cpuMax: "200000 100000" },
        memory: { events: { high: 7, oom: 3, oom_kill: 1 } },
        pids: { current: 750, max: 1000, events: { max: 5 } },
      },
      pressure: { cpu: { some: { avg10: 12.5 } }, io: null, memory: null },
    });

    expect(buildSandboxResourceSample(current, previous)).toMatchObject({
      cpuUsedPercent: 50,
      cpuThrottledPeriodsPercent: 25,
      cpuPressureAvg10: 12.5,
      memoryHighEventsDelta: 5,
      memoryOomEventsDelta: 2,
      memoryOomKillEventsDelta: 1,
      pidsCurrent: 750,
      pidsLimit: 1000,
      pidsUsedPercent: 75,
      pidsMaxEventsDelta: 2,
    });
  });

  it("omits reset or unreadable resource deltas instead of emitting negative gauges", () => {
    const previous = base({
      cgroup: {
        cpu: { nr_periods: 10, nr_throttled: 5 },
        memory: { events: { oom: 5 } },
        pids: { events: { max: 4 } },
      },
    });
    const current = base({
      capturedAtMs: previous.capturedAtMs + 1000,
      cgroup: {
        cpu: { nr_periods: 1, nr_throttled: 0 },
        memory: { events: { oom: 0 } },
        pids: { events: { max: 0 } },
      },
    });
    const sample = buildSandboxResourceSample(current, previous);
    expect(sample.cpuThrottledPeriodsPercent).toBeUndefined();
    expect(sample.memoryOomEventsDelta).toBeUndefined();
    expect(sample.pidsMaxEventsDelta).toBeUndefined();
  });

  it("returns an empty sample when nothing is readable", () => {
    expect(buildSandboxResourceSample(base())).toEqual({});
  });
});
