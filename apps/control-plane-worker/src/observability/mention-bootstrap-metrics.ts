// Datadog counter for GitHub mention-bootstrap outcomes (ARC-1515).
// Mirrors automation-metrics.ts: gate on `env.DD_API_KEY` (a no-op in local
// dev / tests) and emit a low-cardinality COUNT tagged by a bounded outcome.
import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "./pr-metrics";

export type MentionBootstrapOutcome =
  | "created"
  | "handed_off"
  | "other_business"
  | "no_write_permission"
  | "fork"
  | "closed"
  | "unsafe_head_ref"
  | "admission_rejected"
  | "skip_ambiguous"
  | "retry_claim_contended"
  | "retry_github_fetch_failed"
  | "retry_permission_indeterminate";

export async function emitMentionBootstrapOutcomeMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  outcome: MentionBootstrapOutcome,
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const tags = [...baseControlPlaneMetricTags(env), `outcome:${outcome}`];
  const series: CountMetricSeries[] = [{ metric: "cycloid.mention_bootstrap", tags, value: 1 }];
  await postCountMetricSeries(apiKey, series, "mention-bootstrap");
}
