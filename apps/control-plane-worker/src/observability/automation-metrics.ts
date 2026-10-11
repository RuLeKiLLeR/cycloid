// Datadog counter for scheduled-automation Slack delivery outcomes (ARC-1195).
// Mirrors feed-metrics.ts / pr-metrics.ts: gate on `env.DD_API_KEY` (a no-op in
// local dev / tests) and emit a low-cardinality COUNT tagged by a bounded
// outcome, so "are scheduled digests being delivered, and where are they
// failing?" is a dashboard/monitor question rather than a log grep.
import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "./pr-metrics";

/**
 * Bounded outcome tag for `arcanist.automation.slack_delivery`. Keep this small
 * — it is a metric tag, not free text.
 * - `delivered`: the digest reached the channel.
 * - `empty`: the session produced no deliverable text (nothing posted).
 * - `workspace_not_connected`: no installed bot token for the rule's team.
 * - `post_failed`: chat.postMessage failed (bot removed, channel gone, throttled).
 */
export type AutomationSlackDeliveryOutcome = "delivered" | "empty" | "workspace_not_connected" | "post_failed";

export async function emitAutomationSlackDeliveryMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  outcome: AutomationSlackDeliveryOutcome,
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const tags = [...baseControlPlaneMetricTags(env), `outcome:${outcome}`];
  const series: CountMetricSeries[] = [{ metric: "arcanist.automation.slack_delivery", tags, value: 1 }];
  await postCountMetricSeries(apiKey, series, "automation-slack-delivery");
}
