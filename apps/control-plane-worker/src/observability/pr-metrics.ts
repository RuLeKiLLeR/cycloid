import { DD_DEFAULT_SITE } from "../constants/observability";
import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";

// Counts every PR Cycloid opens for any user, tagged `draft:true|false` so the
// drafts-vs-ready ("green") split can be read off one metric. Fires once per
// genuine PR creation (the create path, gated for at-most-once); republishes /
// body updates are NOT counted. Non-alerting. Query (us5):
//   all PRs:  sum:arcanist.pr.created{*}.as_count()
//   drafts:   sum:arcanist.pr.created{draft:true}.as_count()
//   green:    sum:arcanist.pr.created{draft:false}.as_count()
//
// Tags are deliberately low-cardinality (service, worker, repo, draft, env),
// matching phase-metrics so this metric is filterable alongside the other
// control-plane custom metrics. No session_id or owner_user_id: this fires on
// every PR, so per-session/per-user tags would accumulate unbounded time series.
const US5_SERIES_URL = `https://api.${DD_DEFAULT_SITE}/api/v2/series`;
// The callers dispatch these off the publish critical path (waitUntil), but cap
// it anyway so a slow/unreachable us5 endpoint can't hold an extension handle
// open for the full Cloudflare request budget.
const POST_TIMEOUT_MS = 2000;

export interface CountMetricSeries {
  metric: string;
  tags: string[];
  value: number;
}

// Builds the shared low-cardinality tag set every control-plane PR/review-loop
// count metric uses, so they stay filterable alongside each other.
function buildSeriesTags(
  env: Pick<Env, "WORKER_ENV">,
  tags: { repo: string; ownerUserId: number; draft: boolean },
): string[] {
  const seriesTags = [...baseControlPlaneMetricTags(env), `repo:${tags.repo}`, `draft:${tags.draft}`];
  return seriesTags;
}

function buildReviewLoopInstallationCapabilityTags(
  env: { WORKER_ENV?: string },
  tags: {
    repo: string;
    owner: string;
    ownerUserId: number;
    installationId: number;
    missingPermissions: string[];
    missingEvents: string[];
  },
): string[] {
  const seriesTags = [
    ...baseControlPlaneMetricTags(env),
    `repo:${tags.repo}`,
    `owner:${tags.owner}`,
    `installation_id:${tags.installationId}`,
    `missing_permissions:${tags.missingPermissions.length > 0 ? [...tags.missingPermissions].sort().join(",") : "none"}`,
    `missing_events:${tags.missingEvents.length > 0 ? [...tags.missingEvents].sort().join(",") : "none"}`,
  ];
  return seriesTags;
}

export async function postCountMetric(
  apiKey: string,
  metric: string,
  seriesTags: string[],
  label: string,
  value = 1,
): Promise<void> {
  await postCountMetricSeries(apiKey, [{ metric, tags: seriesTags, value }], label);
}

export async function postCountMetricSeries(apiKey: string, series: CountMetricSeries[], label: string): Promise<void> {
  await postMetricSeries(apiKey, series, label, 1 /* COUNT */);
}

async function postMetricSeries(
  apiKey: string,
  series: CountMetricSeries[],
  label: string,
  type: 1 | 3,
): Promise<void> {
  if (series.length === 0) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    series: series.map((item) => ({
      metric: item.metric,
      type,
      points: [{ timestamp, value: item.value }],
      tags: item.tags,
    })),
  };
  try {
    const response = await fetch(US5_SERIES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[pr-metrics] ${label} metric POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`[pr-metrics] ${label} metric POST threw: ${String(err)}`);
  }
}

export interface GaugeMetricSeries {
  metric: string;
  tags: string[];
  value: number;
}

// Posts one or more GAUGE points (type 3) to the us5 v2 series API via the shared
// postMetricSeries path — a gauge reports the latest sampled value (memory %,
// disk %, cpu %, oldest-dwell age), not an additive count. Same best-effort +
// low-cardinality-tag discipline as the COUNT path.
export async function postGaugeMetricSeries(apiKey: string, series: GaugeMetricSeries[], label: string): Promise<void> {
  await postMetricSeries(apiKey, series, label, 3 /* GAUGE */);
}

export async function emitPrCreatedMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { repo: string; ownerUserId: number; draft: boolean },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  await postCountMetric(apiKey, "arcanist.pr.created", buildSeriesTags(env, tags), "pr-created");
}

// Counts every PR that arms the review loop after a publish, tagged
// `draft:true|false` so the share of unverified (draft) PRs entering the loop can
// be read off one metric. Replaces the removed `arcanist.review_loop.skipped_draft`
// signal (ARC-1112): drafts and ready PRs now share one arming path, so this fires
// at the eligibility-success point for both and the draft tag carries the split.
// Fires once per successful arming (the same call path that enters review
// listening). Non-alerting. Query (us5):
//   all armed:    sum:arcanist.review_loop.armed{*}.as_count()
//   draft armed:  sum:arcanist.review_loop.armed{draft:true}.as_count()
//   ready armed:  sum:arcanist.review_loop.armed{draft:false}.as_count()
export async function emitReviewLoopArmedMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { repo: string; ownerUserId: number; draft: boolean },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  await postCountMetric(apiKey, "arcanist.review_loop.armed", buildSeriesTags(env, tags), "review-loop-armed");
}

export async function emitReviewLoopInstallationCapabilitiesMissingMetric(
  env: { DD_API_KEY?: string; WORKER_ENV?: string },
  tags: {
    repo: string;
    owner: string;
    ownerUserId: number;
    installationId: number;
    missingPermissions: string[];
    missingEvents: string[];
  },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  await postCountMetric(
    apiKey,
    "arcanist.review_loop.installation_capabilities_missing",
    buildReviewLoopInstallationCapabilityTags(env, tags),
    "review-loop-installation-capabilities-missing",
  );
}

// Shared minimal tag set for the RLA v2 counters below: repo + bounded dimension tags.
// No owner_user_id/session/epoch ids (unbounded series).
function buildReviewLoopV2Tags(
  env: { WORKER_ENV?: string },
  tags: { repo: string; ownerUserId: number },
  extra: string[],
): string[] {
  const seriesTags = [...baseControlPlaneMetricTags(env), `repo:${tags.repo}`, ...extra];
  return seriesTags;
}

/**
 * Counts review-loop dispatch deferrals from the verification handshake (RLA v2): the pause while
 * a run is in progress, and the CI-first pre-verdict queueing of comment epochs. One count per
 * deferred sweep claim. Resumes are read as this counter going quiet for a PR while
 * `arcanist.review_loop.qa_tester_intake` / normal epoch dispatch picks back up.
 */
export async function emitReviewLoopDispatchDeferredMetric(
  env: { DD_API_KEY?: string; WORKER_ENV?: string },
  tags: {
    repo: string;
    ownerUserId: number;
    reason: "verification_in_progress";
  },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  await postCountMetric(
    apiKey,
    "arcanist.review_loop.dispatch_deferred",
    buildReviewLoopV2Tags(env, tags, [`reason:${tags.reason}`]),
    "review-loop-dispatch-deferred",
  );
}

/**
 * Counts review-loop triage outcomes (RLA v2): `outcome:used` vs `outcome:fallback` (with the
 * fallback reason and platform-LLM category when present). On a used outcome, also counts
 * LLM-dropped worklist items and discarded (unknown-source-id) action items as separate series so
 * coverage loss is visible.
 */
export async function emitReviewLoopTriageMetric(
  env: { DD_API_KEY?: string; WORKER_ENV?: string },
  tags: {
    repo: string;
    ownerUserId: number;
    outcome: "used" | "fallback";
    reason: string | null;
    category: string | null;
    droppedItemCount: number;
    conflictCount: number;
    conflictDroppedCount: number;
    discardedActionItemCount: number;
  },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  const seriesTags = buildReviewLoopV2Tags(env, tags, [
    `outcome:${tags.outcome}`,
    `reason:${tags.reason ?? "none"}`,
    `category:${tags.category ?? "none"}`,
  ]);
  // The payloads are independent; post them in parallel so a slow us5 endpoint costs the sweep at
  // most one POST_TIMEOUT_MS, not 4x (triage + dropped + discarded + conflicts).
  const posts = [postCountMetric(apiKey, "arcanist.review_loop.triage", seriesTags, "review-loop-triage")];
  if (tags.droppedItemCount > 0) {
    posts.push(
      postCountMetric(
        apiKey,
        "arcanist.review_loop.triage_dropped_items",
        seriesTags,
        "review-loop-triage-dropped-items",
        tags.droppedItemCount,
      ),
    );
  }
  if (tags.discardedActionItemCount > 0) {
    posts.push(
      postCountMetric(
        apiKey,
        "arcanist.review_loop.triage_discarded_action_items",
        seriesTags,
        "review-loop-triage-discarded-action-items",
        tags.discardedActionItemCount,
      ),
    );
  }
  if (tags.conflictCount > 0) {
    posts.push(
      postCountMetric(
        apiKey,
        "arcanist.review_loop.triage_conflicts",
        seriesTags,
        "review-loop-triage-conflicts",
        tags.conflictCount,
      ),
    );
  }
  // Separate series for conflicts the model proposed but validation pruned (under-specified, empty
  // summary, or same-action-item). Lets a flat triage_conflicts line be diagnosed as "model
  // under-fired" vs "filter over-pruned" — the question conflict tuning hinges on. Mirrors the
  // dropped/discarded series; tags stay low-cardinality (no per-conflict ids).
  if (tags.conflictDroppedCount > 0) {
    posts.push(
      postCountMetric(
        apiKey,
        "arcanist.review_loop.triage_conflicts_dropped",
        seriesTags,
        "review-loop-triage-conflicts-dropped",
        tags.conflictDroppedCount,
      ),
    );
  }
  await Promise.all(posts);
}

/**
 * Counts review-loop dispatches whose worklist was truncated by the 64KB total body budget (ARC-1226)
 * — one count per truncated dispatch plus the number of dropped items as a separate series. Distinct
 * from `arcanist.review_loop.triage_dropped_items` (LLM-triage drops); this is the GitHub-fetch body
 * budget drop, which is now carried forward and re-dispatched rather than lost. A non-zero rate means
 * PRs are exceeding the single-wave budget often enough to warrant attention.
 */
export async function emitReviewLoopWorklistTruncatedMetric(
  env: { DD_API_KEY?: string; WORKER_ENV?: string },
  tags: { repo: string; ownerUserId: number; sourceKind: string; droppedItemCount: number },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  const seriesTags = buildReviewLoopV2Tags(env, tags, [`source_kind:${tags.sourceKind}`]);
  await Promise.all([
    postCountMetric(apiKey, "arcanist.review_loop.worklist_truncated", seriesTags, "review-loop-worklist-truncated"),
    postCountMetric(
      apiKey,
      "arcanist.review_loop.worklist_dropped_items",
      seriesTags,
      "review-loop-worklist-dropped-items",
      tags.droppedItemCount,
    ),
  ]);
}

/**
 * Counts budget-truncated review-loop tails recovered on a foreign head change (ARC-1244): instead of
 * stale-blocking an epoch that still owes an un-prompted carried tail, the head-change reconciler
 * re-keys it onto the new head as a re-driveable `ready` epoch so the tail drains without a fresh bot
 * signal. `rekeyed` is the number of epochs re-keyed in this reconcile (posted as the count value). A
 * non-zero rate confirms the recovery path is firing in prod (the bug it fixes is a silent "Waiting
 * on" wedge, so the recovery would otherwise be invisible). Emitted from both head-change callers (the
 * sweep and the `synchronize` webhook) since either can win the head-advance race.
 */
export async function emitReviewLoopTruncatedTailRekeyedMetric(
  env: { DD_API_KEY?: string; WORKER_ENV?: string },
  tags: { repo: string; ownerUserId: number; rekeyed: number },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey || tags.rekeyed <= 0) return;
  await postCountMetric(
    apiKey,
    "arcanist.review_loop.head_change_truncated_tail_rekeyed",
    buildReviewLoopV2Tags(env, tags, []),
    "review-loop-truncated-tail-rekeyed",
    tags.rekeyed,
  );
}
