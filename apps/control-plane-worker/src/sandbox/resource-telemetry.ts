// Per-session sandbox resource gauges (memory/swap/disk/cpu). The bridge samples
// cgroup/PSI/statfs every ~30s and ships a `sandbox_resource_sample` event; this
// turns each sample into Datadog GAUGE points so pressure is visible BEFORE a
// kernel OOM tears the session down. Pure side-effect: never broadcast,
// persisted, or projected into the customer's session timeline. No-ops when
// DD_API_KEY is absent (local dev).
//
// Tag cardinality: repo_owner/repo_name/business_id ONLY — matching
// undersize-notify.ts and the deliberate no-per-session-tag rule in pr-metrics.ts
// (session_id/owner_user_id would make every ephemeral session its own gauge
// series and bill as unbounded custom metrics at a 30s cadence). The exact
// session/sandbox is recoverable from the structured bridge log; the monitors
// alert per repo/business, which is the actionable grain.

import { baseControlPlaneMetricTags } from "../observability/metric-tags";
import { type GaugeMetricSeries, postGaugeMetricSeries } from "../observability/pr-metrics";
import type { Env } from "../types";

export interface SandboxResourceGaugesInput {
  repoOwner: string | null;
  repoName: string | null;
  businessId: string | null;
  memoryUsedBytes?: number;
  memoryLimitBytes?: number;
  memoryUsedPercent?: number;
  swapUsedBytes?: number;
  cpuUsedPercent?: number;
  cpuThrottledPeriodsPercent?: number;
  cpuPressureAvg10?: number;
  memoryPressureAvg10?: number;
  memoryHighEventsDelta?: number;
  memoryOomEventsDelta?: number;
  memoryOomKillEventsDelta?: number;
  pidsCurrent?: number;
  pidsLimit?: number;
  pidsUsedPercent?: number;
  pidsMaxEventsDelta?: number;
  disks?: Array<{ mount: string; usedPercent?: number; usedBytes?: number; totalBytes?: number; availBytes?: number }>;
}

type ResourceTelemetryEnv = Pick<Env, "DD_API_KEY" | "WORKER_ENV">;

const METRIC = {
  memoryUsedPercent: "arcanist.sandbox.memory.used_percent",
  memoryUsedBytes: "arcanist.sandbox.memory.used_bytes",
  swapUsedBytes: "arcanist.sandbox.swap.used_bytes",
  cpuUsedPercent: "arcanist.sandbox.cpu.used_percent",
  cpuThrottledPeriodsPercent: "arcanist.sandbox.cpu.throttled_periods_percent",
  cpuPressureAvg10: "arcanist.sandbox.cpu.pressure_avg10",
  memoryPressureAvg10: "arcanist.sandbox.memory.pressure_avg10",
  memoryHighEventsDelta: "arcanist.sandbox.memory.high_events_delta",
  memoryOomEventsDelta: "arcanist.sandbox.memory.oom_events_delta",
  memoryOomKillEventsDelta: "arcanist.sandbox.memory.oom_kill_events_delta",
  pidsCurrent: "arcanist.sandbox.pids.current",
  pidsLimit: "arcanist.sandbox.pids.limit",
  pidsUsedPercent: "arcanist.sandbox.pids.used_percent",
  pidsMaxEventsDelta: "arcanist.sandbox.pids.max_events_delta",
  diskUsedPercent: "arcanist.sandbox.disk.used_percent",
  diskUsedBytes: "arcanist.sandbox.disk.used_bytes",
  // Absolute free bytes — dashboard gauge only (no alert). Kept alongside
  // used_percent so dashboards show both the relative and absolute picture. The
  // ENOSPC outcome counter (arcanist.sandbox.disk.enospc) is what pages, not a
  // floor threshold on this gauge (a floor false-positives on repos whose disk
  // baseline is structurally high, e.g. xyla at ~250-643 MB free while succeeding).
  diskAvailBytes: "arcanist.sandbox.disk.avail_bytes",
} as const;

function baseTags(env: ResourceTelemetryEnv, input: SandboxResourceGaugesInput): string[] {
  return [
    ...baseControlPlaneMetricTags(env),
    `repo_owner:${input.repoOwner ?? "unknown"}`,
    `repo_name:${input.repoName ?? "unknown"}`,
    ...(input.businessId ? [`business_id:${input.businessId}`] : []),
  ];
}

// Builds the gauge series for a single sample. Exported for unit testing (which
// series appear, tag content) without a live us5 endpoint. Only fields present
// on the sample produce a series — a missing source stays absent rather than
// emitting a misleading zero.
export function buildSandboxResourceGaugeSeries(
  env: ResourceTelemetryEnv,
  input: SandboxResourceGaugesInput,
): GaugeMetricSeries[] {
  const tags = baseTags(env, input);
  const series: GaugeMetricSeries[] = [];
  const add = (metric: string, value: number | undefined, extra: string[] = []) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      series.push({ metric, tags: extra.length ? [...tags, ...extra] : tags, value });
    }
  };

  add(METRIC.memoryUsedPercent, input.memoryUsedPercent);
  add(METRIC.memoryUsedBytes, input.memoryUsedBytes);
  add(METRIC.swapUsedBytes, input.swapUsedBytes);
  add(METRIC.cpuUsedPercent, input.cpuUsedPercent);
  add(METRIC.cpuThrottledPeriodsPercent, input.cpuThrottledPeriodsPercent);
  add(METRIC.cpuPressureAvg10, input.cpuPressureAvg10);
  add(METRIC.memoryPressureAvg10, input.memoryPressureAvg10);
  add(METRIC.memoryHighEventsDelta, input.memoryHighEventsDelta);
  add(METRIC.memoryOomEventsDelta, input.memoryOomEventsDelta);
  add(METRIC.memoryOomKillEventsDelta, input.memoryOomKillEventsDelta);
  add(METRIC.pidsCurrent, input.pidsCurrent);
  add(METRIC.pidsLimit, input.pidsLimit);
  add(METRIC.pidsUsedPercent, input.pidsUsedPercent);
  add(METRIC.pidsMaxEventsDelta, input.pidsMaxEventsDelta);
  for (const disk of input.disks ?? []) {
    const mountTag = [`mount:${disk.mount}`];
    add(METRIC.diskUsedPercent, disk.usedPercent, mountTag);
    add(METRIC.diskUsedBytes, disk.usedBytes, mountTag);
    add(METRIC.diskAvailBytes, disk.availBytes, mountTag);
  }
  return series;
}

export async function emitSandboxResourceGauges(
  env: ResourceTelemetryEnv,
  input: SandboxResourceGaugesInput,
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  const series = buildSandboxResourceGaugeSeries(env, input);
  await postGaugeMetricSeries(apiKey, series, "sandbox-resource-sample");
}
