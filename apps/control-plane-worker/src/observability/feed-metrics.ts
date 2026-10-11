// Datadog counters for the per-business sidebar feed fan-out (ARC-1322).
// Mirrors the established `pr-metrics.ts` convention: gate on `env.DD_API_KEY`
// (a no-op in local dev / tests) and emit low-cardinality COUNT series tagged
// by delta type and delivery outcome, so "is the feed fanning out, and is the
// gate suppressing the expected share?" is a dashboard question.

import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "./pr-metrics";

export async function emitFeedDeliveryMetrics(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  args: { type: string; delivered: number; suppressed: number },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const tags = [...baseControlPlaneMetricTags(env), `type:${args.type}`];

  const series: CountMetricSeries[] = [];
  if (args.delivered > 0) {
    series.push({ metric: "arcanist.feed.delivered", tags, value: args.delivered });
  }
  if (args.suppressed > 0) {
    series.push({ metric: "arcanist.feed.suppressed", tags, value: args.suppressed });
  }

  await postCountMetricSeries(apiKey, series, "feed-delivery");
}
