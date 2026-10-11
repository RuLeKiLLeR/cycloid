// Datadog gauge for Slack @mention -> "eyes" reaction ack latency: the
// server-side time from webhook receipt to the reaction landing on the parent
// message, i.e. how snappy the mention feels. Mirrors mention-bootstrap-metrics.ts:
// gate on env.DD_API_KEY (a no-op in local dev / tests) and emit a
// low-cardinality GAUGE tagged only by the bounded ack path.
import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { type GaugeMetricSeries, postGaugeMetricSeries } from "./pr-metrics";

// Which handler posted the reaction: a brand-new session vs a reply into an
// already-bound thread. Bounded so the series stays low cardinality.
export type SlackAckPath = "new_session" | "follow_up";

export const SLACK_MENTION_ACK_LATENCY_METRIC = "arcanist.slack.mention_ack_latency_ms";

export async function emitSlackMentionAckLatencyMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  path: SlackAckPath,
  latencyMs: number,
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;

  const tags = [...baseControlPlaneMetricTags(env), `path:${path}`];
  const series: GaugeMetricSeries[] = [{ metric: SLACK_MENTION_ACK_LATENCY_METRIC, tags, value: latencyMs }];
  await postGaugeMetricSeries(apiKey, series, "slack-mention-ack-latency");
}
