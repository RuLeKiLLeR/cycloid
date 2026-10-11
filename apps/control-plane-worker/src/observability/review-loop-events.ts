// Telemetry for the Review Loop (RLA) and QA Testing (QTA) subsystems.
//
// Each unit of work emits ONE canonical structured Datadog log event; all
// dashboards, SLOs, and monitors are derived from these events as log-based
// metrics in infra/datadog-review-loop.tf (the same pattern as
// `post_execution.completed`). We deliberately do NOT also post v2 series
// counters here: a single structured event yields both count and distribution
// metrics via Terraform `group_by`, keeps one write per terminal transition,
// and lets monitors run as log alerts directly on the event.
//
// Cardinality discipline: every field below is safe to put on the event, but
// only BOUNDED ENUMS may be referenced in a metric `group_by` (Terraform owns
// that choice). Numeric fields (durations, counts, run_index) feed distribution
// metrics; identifiers (session_id, pr_url) are present for log drill-down ONLY
// and must never be grouped/tagged. Emits are fire-and-forget: postStructuredEventToDd
// never throws and no-ops when DD_API_KEY is unset, so callers can `await` on a
// cron path or dispatch via `waitUntil` on a request/DO path.

import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import type { PrReviewBotTelemetryLabel } from "../github/pr-review-bots";
import type { Env } from "../types";
import { postStructuredEventToDd } from "./events-exporter";

type EmitEnv = Pick<Env, "DD_API_KEY" | "WORKER_ENV">;

const UNKNOWN_MODEL = "unknown";

export type PrReviewModelPairing = "same_backend" | "cross_backend" | "unknown";

export function getPrReviewModelPairing(
  authorBackend: AgentRuntimeBackend | null | undefined,
  reviewerBackend: AgentRuntimeBackend,
): PrReviewModelPairing {
  if (!authorBackend) return "unknown";
  return authorBackend === reviewerBackend ? "same_backend" : "cross_backend";
}

export type ReviewLoopIngestWebhookKind =
  "review_submission" | "review_comment" | "issue_comment" | "check_run" | "commit_status";

export const QA_TESTER_TELEMETRY_EVENT = {
  RUN_COMPLETED: "qa_tester.run.completed",
  ROUTING_DECIDED: "qa_tester.routing.decided",
  SCHEDULE_FAILED: "qa_tester.schedule.failed",
  // NB: the `qa_tester_liveness.*` / `qa_tester_teardown.*` events were emitted by the ARC-1273
  // verification-liveness watchdog deleted in D-50 (ARC-1330 Wave 11). Their Datadog log-metrics +
  // dashboards (infra/datadog-*.tf) remain as string-literal filters and now measure quiescence —
  // retiring those infra definitions is the manager's DD-gate step, not this deletion PR's.
} as const;

/** Terminal review-loop statuses we emit telemetry for. */
type ReviewLoopTerminalStatus = "completed" | "blocked";

// Genuine convergence-failure caps — the loop ran out of attempts. Every other blocked reason is a
// restart (head_changed), a productive park (worklist_truncation_unresolved), teardown/disabled, or an
// operational failure — none are convergence failures. We classify here and emit a `convergence_failure`
// boolean so the settle-rate SLO/dashboard/monitor can filter with simple `{convergence_failure:true}`
// syntax: Datadog MONITOR queries reject the `IN (...)` tag operator, and negative-excluding the benign
// reasons would wrongly re-count operational failures.
//
// This deliberately DIVERGES from EXHAUSTED_BLOCKED_REASONS in review-loop-rollup.ts on
// `no_progress_unresolved` and `no_new_evidence_reprompt_cap` (ARC-1407): the rollup keeps both in the
// `working` bucket (NOT exhausted) so a human follows up rather than the head claiming caught-up, but for
// the settle-rate SLI they are genuine non-convergence caps (they fire only after re-driving/​re-prompting
// the same unresolved feedback exhausted its budget), so they must count as failures or the exact class
// this loop introduces is invisible in the metric.
const CONVERGENCE_FAILURE_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "attempt_cap_reached",
  "ci_attempt_cap_reached",
  "ci_checks_pending_cap_reached",
  "no_progress_unresolved",
  "no_new_evidence_reprompt_cap",
]);

/** Structural subset of a ReviewLoopEpoch row needed to describe a terminal transition. */
export interface ReviewLoopEpochTerminalFields {
  status: string;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  sourceKind: string;
  blockedReason: string | null;
  attemptCount: number;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  wave: number;
  triggeringSourceIds: string[];
  promptedSourceIds: string[];
  carriedForwardSourceIds: string[];
  createdAt: number;
  updatedAt: number;
  repoOwner: string;
  repoName: string;
  ownerUserId: number;
  sessionId: string;
  prUrl: string;
}

/**
 * Emit `review_loop.epoch.completed` when an epoch reaches a TERMINAL status.
 *
 * Gated on the freshly re-read row's status: `markReviewLoopEpochCompleted` is
 * misleadingly named and can settle to `ready`/`blocked` via the carry-forward
 * SQL, so a non-terminal status here means the epoch was re-driven, not settled —
 * we must not emit a false `completed`. Returns immediately (no event) in that case.
 *
 * Coverage: emitted from the completed/blocked/terminal-prompt setters (covering the
 * sweep + publish + reply-only paths). NOT emitted from the bulk head-change blocker
 * `markReviewLoopEpochsStaleForHeadChange` (a batch UPDATE that returns a row count,
 * not rows) — so `head_changed=true` events come only from the per-epoch sweep path.
 * This is fine for settle-rate (head-change restarts are excluded from it anyway);
 * it only undercounts head_changed event VOLUME. publish_failed/reply_failed blocked
 * tails are likewise not yet instrumented (see publish-service.ts).
 */
export async function emitReviewLoopEpochTerminalEvent(
  env: EmitEnv,
  epoch: ReviewLoopEpochTerminalFields,
  context: { model: string | null },
): Promise<void> {
  if (epoch.status !== "completed" && epoch.status !== "blocked") return;
  const terminalStatus: ReviewLoopTerminalStatus = epoch.status;
  const blockedReason = epoch.blockedReason ?? "none";
  // A head-change block is a fresh-round restart, not a convergence failure; surfacing it as its own
  // field lets settle-rate SLIs exclude it without re-deriving from blocked_reason.
  const headChanged = epoch.blockedReason === "head_changed";
  // The settle-rate denominator's failure term: a blocked terminal whose reason is a genuine cap.
  const convergenceFailure =
    terminalStatus === "blocked" &&
    epoch.blockedReason != null &&
    CONVERGENCE_FAILURE_BLOCKED_REASONS.has(epoch.blockedReason);

  await postStructuredEventToDd(env, {
    event: "review_loop.epoch.completed",
    terminal_status: terminalStatus,
    source_kind: epoch.sourceKind,
    blocked_reason: blockedReason,
    convergence_failure: convergenceFailure,
    head_changed: headChanged,
    model: context.model ?? UNKNOWN_MODEL,
    repo: `${epoch.repoOwner}/${epoch.repoName}`,
    owner_user_id: epoch.ownerUserId,
    attempt_count: epoch.attemptCount,
    wave: epoch.wave,
    items_in: epoch.triggeringSourceIds.length,
    items_addressed: epoch.promptedSourceIds.length,
    // True "ingested into this epoch but never put in front of the agent" = triggering − prompted
    // (promptedSourceIds is a strict subset of triggeringSourceIds). NOT carriedForwardSourceIds, which
    // is a distinct budget-carry set that is forced to [] on every clean `completed` settle — so the
    // three numbers now partition: items_addressed + items_dropped == items_in.
    items_dropped: Math.max(0, epoch.triggeringSourceIds.length - epoch.promptedSourceIds.length),
    duration_ms: Math.max(0, epoch.updatedAt - epoch.createdAt),
    session_id: epoch.sessionId,
    pr_url: epoch.prUrl,
  });
}

/**
 * What drove a review-loop epoch to dispatch, as a bounded telemetry tag on the dispatch-latency
 * metrics. `webhook_arrival` = the FSM `dispatch_epoch` sink dispatched on the webhook turn (the
 * immediate-dispatch happy path, ARC-1330 Phase B); `epoch_terminal` = the terminal-chain popped the
 * next queued item; `reclaim` = the stuck-epoch reclaim backstop re-drove a dead-agent epoch. The
 * cron poll passes no trigger (tag omitted) so its historical series is unchanged.
 */
export type ReviewLoopDispatchTrigger = "webhook_arrival" | "epoch_terminal" | "reclaim";

export async function emitReviewLoopArrivalToDispatchEvent(
  env: EmitEnv,
  fields: {
    sourceKind: string;
    repo: string;
    ownerUserId: number;
    arrivalToDispatchMs: number;
    sessionId: string;
    prUrl: string;
    epochId: string;
    trigger?: ReviewLoopDispatchTrigger;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.arrival_to_dispatch_ms",
    source_kind: fields.sourceKind,
    repo: fields.repo,
    owner_user_id: fields.ownerUserId,
    arrival_to_dispatch_ms: Math.max(0, fields.arrivalToDispatchMs),
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
    epoch_id: fields.epochId,
    ...(fields.trigger ? { trigger: fields.trigger } : {}),
  });
}

export async function emitReviewLoopReadyToClaimEvent(
  env: EmitEnv,
  fields: {
    sourceKind: string;
    repo: string;
    ownerUserId: number;
    readyToClaimMs: number;
    sessionId: string;
    prUrl: string;
    epochId: string;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.ready_to_claim_ms",
    source_kind: fields.sourceKind,
    repo: fields.repo,
    owner_user_id: fields.ownerUserId,
    ready_to_claim_ms: Math.max(0, fields.readyToClaimMs),
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
    epoch_id: fields.epochId,
  });
}

export async function emitReviewLoopArrivalToFirstOperationEvent(
  env: EmitEnv,
  fields: {
    sourceKind: string;
    operationKind: string;
    repo: string;
    ownerUserId: number;
    arrivalToFirstOperationMs: number;
    sessionId: string;
    prUrl: string;
    epochId: string;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.arrival_to_first_op_ms",
    source_kind: fields.sourceKind,
    operation_kind: fields.operationKind,
    repo: fields.repo,
    owner_user_id: fields.ownerUserId,
    arrival_to_first_op_ms: Math.max(0, fields.arrivalToFirstOperationMs),
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
    epoch_id: fields.epochId,
  });
}

export async function emitReviewLoopCiFirstFailToDispatchEvent(
  env: EmitEnv,
  fields: {
    repo: string;
    ownerUserId: number;
    ciFirstFailToDispatchMs: number;
    sessionId: string;
    prUrl: string;
    epochId: string;
    trigger?: ReviewLoopDispatchTrigger;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.ci_first_fail_to_dispatch_ms",
    source_kind: "ci",
    repo: fields.repo,
    owner_user_id: fields.ownerUserId,
    ci_first_fail_to_dispatch_ms: Math.max(0, fields.ciFirstFailToDispatchMs),
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
    epoch_id: fields.epochId,
    ...(fields.trigger ? { trigger: fields.trigger } : {}),
  });
}

export type ReviewLoopIngestIgnoredClass = "expected" | "suspicious";

// Only content-carrying review webhooks should count as suspicious dropped bot reviews. Background
// terminal signals (`check_run` / `commit_status`) are expected to see ambient no-listener traffic.
const REVIEW_LOOP_CONTENT_WEBHOOK_KINDS: ReadonlySet<ReviewLoopIngestWebhookKind> = new Set([
  "review_submission",
  "review_comment",
  "issue_comment",
]);

// A bot review arrived for a PR that Cycloid never tracked — no session webhook-ref exists for it at
// all (see the zero-session branch in runReviewLoopWebhookIngest). This is a human/third-party PR that a
// review bot happened to comment on, which is the expected steady state in any repo Cycloid watches, so
// it is deliberately kept OUT of the suspicious set below. Distinct from `no_review_listening_session`,
// which means a session IS registered for the PR but none is live+listening — a Cycloid-owned PR whose
// bot review was genuinely dropped, which stays suspicious.
export const REVIEW_LOOP_INGEST_NO_SESSION_FOR_PR_REASON = "no_session_for_pr";

const SUSPICIOUS_REVIEW_LOOP_INGEST_IGNORED_REASONS: ReadonlySet<string> = new Set([
  "missing_head_sha",
  "no_review_listening_session",
]);

export function classifyReviewLoopIngestIgnoredReason(input: {
  webhookKind: ReviewLoopIngestWebhookKind;
  reason: string;
}): ReviewLoopIngestIgnoredClass {
  if (!REVIEW_LOOP_CONTENT_WEBHOOK_KINDS.has(input.webhookKind)) return "expected";
  return SUSPICIOUS_REVIEW_LOOP_INGEST_IGNORED_REASONS.has(input.reason) ? "suspicious" : "expected";
}

export async function emitReviewLoopIngestOutcomeEvent(
  env: EmitEnv,
  fields: {
    sourceKind: string;
    webhookKind: ReviewLoopIngestWebhookKind;
    outcome: "handled" | "ignored";
    reason: string | null;
    repo: string;
    ownerUserId: number | null;
    sessionId: string | null;
    prUrl: string;
    bot: PrReviewBotTelemetryLabel | null;
    ignoredClass: ReviewLoopIngestIgnoredClass | null;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.ingest.outcome",
    source_kind: fields.sourceKind,
    webhook_kind: fields.webhookKind,
    outcome: fields.outcome,
    reason: fields.reason ?? "none",
    repo: fields.repo,
    owner_user_id: fields.ownerUserId,
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
    ...(fields.bot ? { bot: fields.bot } : {}),
    ...(fields.ignoredClass ? { ignored_class: fields.ignoredClass } : {}),
  });
}

/**
 * Emit `review_loop.noise_gated` when the worklist noise gate (D4) auto-dispositions a known bot's
 * purely-informational output (a "no findings" message / an empty commented review / an "in progress"
 * placeholder) instead of prompting it. `bot` and `reason` are BOUNDED enums safe for a metric `group_by`
 * (bot ∈ the 5 known review bots; reason ∈ {no_findings, in_progress}); `session_id` / `pr_url` /
 * `source_id` are log-only drill-down.
 * Fire-and-forget: never throws, no-ops without DD_API_KEY.
 */
export async function emitReviewLoopNoiseGatedEvent(
  env: EmitEnv,
  input: {
    bot: string;
    reason: string;
    repo: string;
    ownerUserId: number;
    sessionId: string;
    prUrl: string;
    sourceId: string;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.noise_gated",
    bot: input.bot,
    reason: input.reason,
    repo: input.repo,
    owner_user_id: input.ownerUserId,
    session_id: input.sessionId,
    pr_url: input.prUrl,
    source_id: input.sourceId,
  });
}

/**
 * Emit `review_loop.noise_near_miss` when a known bot's output matched a no-findings phrase but was
 * FORWARDED anyway because residual content survived the strip (the deterministic gate couldn't finish
 * the job). This is the sizing signal for a possible semantic/LLM tie-breaker: a near-zero rate means the
 * regex is sufficient; a material rate — especially with SMALL `residual_length` (footer-chrome, not real
 * feedback) — is the addressable market. `bot` is the only bounded dimension safe for a metric `group_by`
 * (∈ the 5 known review bots); `residual_length` is a numeric distribution; `session_id`/`pr_url`/
 * `source_id` are log-only drill-down (sample them to eyeball true-miss vs real-feedback). Fire-and-forget.
 */
export async function emitReviewLoopNoiseNearMissEvent(
  env: EmitEnv,
  input: {
    bot: string;
    residualLength: number;
    repo: string;
    ownerUserId: number;
    sessionId: string;
    prUrl: string;
    sourceId: string;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.noise_near_miss",
    bot: input.bot,
    residual_length: input.residualLength,
    repo: input.repo,
    owner_user_id: input.ownerUserId,
    session_id: input.sessionId,
    pr_url: input.prUrl,
    source_id: input.sourceId,
  });
}

/**
 * Emit `qa_tester.run.completed` when a QA Tester (QTA) child session settles a
 * terminal verdict. `result` is the merge-ready/needs-work projection of `verdict`;
 * `exhausted` is best-effort derived from the run index vs the per-PR cap (the true
 * exhaustion terminal is a separate pre-run path and never coincides with a verdict).
 */
export async function emitQaTesterRunCompletedEvent(
  env: EmitEnv,
  fields: {
    verdict: string;
    result: string;
    needsWorkLabel: string | null;
    needsAppRuntime: boolean;
    exhausted: boolean;
    model: string | null;
    verifierBackend?: string | null;
    parentModel: string | null;
    parentBackend?: string | null;
    repo: string | null;
    ownerUserId: number;
    runIndex: number | null;
    maxRuns: number | null;
    evidenceCount: number;
    blockerCount: number;
    durationMs: number | null;
    sessionId: string;
    prUrl: string | null;
  },
): Promise<void> {
  const payload = {
    verdict: fields.verdict,
    result: fields.result,
    needs_work_label: fields.needsWorkLabel ?? "none",
    needs_app_runtime: fields.needsAppRuntime,
    exhausted: fields.exhausted,
    model: fields.model ?? UNKNOWN_MODEL,
    verifier_backend: fields.verifierBackend ?? "unknown",
    parent_model: fields.parentModel ?? UNKNOWN_MODEL,
    parent_backend: fields.parentBackend ?? "unknown",
    repo: fields.repo ?? "unknown",
    owner_user_id: fields.ownerUserId,
    run_index: fields.runIndex,
    max_runs: fields.maxRuns,
    evidence_count: fields.evidenceCount,
    blocker_count: fields.blockerCount,
    duration_ms: fields.durationMs,
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
  };
  await postStructuredEventToDd(env, { event: QA_TESTER_TELEMETRY_EVENT.RUN_COMPLETED, ...payload });
}

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export async function emitVerificationRunCompletedEvent(
  env: EmitEnv,
  fields: Parameters<typeof emitQaTesterRunCompletedEvent>[1],
): Promise<void> {
  await emitQaTesterRunCompletedEvent(env, fields);
}

/**
 * Emit `review_loop.settled` once per transition of a PR's review loop into the
 * `done` state. `final_state` records what happened to verification at hand-off
 * (in-progress / skipped / exhausted / done). `review_listening_ms` is the
 * LAST-HEAD-armed -> settle duration: `reviewListeningEnteredAt` is re-stamped on
 * every head change (the no-show window restarts per head), so for a multi-push PR
 * this measures only the final head's window, NOT the full PR-open -> settle wall
 * clock. Read it as "time on the settling head", not total time-to-settle.
 * `total_tokens` is intentionally absent (no per-PR token aggregation exists yet).
 */
export async function emitReviewLoopSettledEvent(
  env: EmitEnv,
  fields: {
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    finalState: string;
    scheduleReason: string | null;
    capBlocked: boolean;
    whichCap: string | null;
    model: string | null;
    repo: string | null;
    ownerUserId: number;
    totalEpochs: number | null;
    totalVerificationRuns: number | null;
    reviewListeningMs: number | null;
    sessionId: string;
    prUrl: string | null;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.settled",
    final_state: fields.finalState,
    schedule_reason: fields.scheduleReason ?? "none",
    cap_blocked: fields.capBlocked,
    which_cap: fields.whichCap ?? "none",
    model: fields.model ?? UNKNOWN_MODEL,
    repo: fields.repo ?? "unknown",
    owner_user_id: fields.ownerUserId,
    total_epochs: fields.totalEpochs,
    total_verification_runs: fields.totalVerificationRuns,
    review_listening_ms: fields.reviewListeningMs,
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
  });
}

// Bounded reason-code enum for `qa_tester.schedule.failed`. Cardinality-safe to use as a metric
// `group_by` (see infra/datadog-log-metrics.tf `qa_tester_schedule_failed`). Any new value MUST be
// a closed enum, never a raw error string. `error` carries the raw message for log drill-down only.
export const VERIFICATION_SCHEDULE_FAILED_REASON = {
  /** Verifier session could not be created because the owner has no validated provider key for its
   *  model (e.g. a subscription-auth Codex parent → verifier needs a validated OpenAI BYOK key). */
  PROVIDER_KEY_NOT_VALIDATED: "provider_key_not_validated",
  /** Verifier inherited an opencode parent runtime that the owner is not entitled to start. */
  OPENCODE_ACCESS_DENIED: "opencode_access_denied",
  /** The verifier prompt enqueue was rejected (session not sendable, contention, etc.). */
  PROMPT_ENQUEUE_FAILED: "prompt_enqueue_failed",
  /** Verifier session create / DO initialize / model resolution failed. */
  SESSION_CREATE_FAILED: "session_create_failed",
  /** A claim/lock/D1 round-trip threw (transient infra). */
  INFRA_ERROR: "infra_error",
  /** Anything not matched above. */
  UNKNOWN: "unknown",
} as const;

export type VerificationScheduleFailedReason =
  (typeof VERIFICATION_SCHEDULE_FAILED_REASON)[keyof typeof VERIFICATION_SCHEDULE_FAILED_REASON];

/**
 * Classify a thrown `scheduleVerificationForPr` error into a bounded reason code.
 * Matches on the error `name`/message (NOT by importing the throwing classes) so this stays a light,
 * dependency-free pure function that the telemetry test can exercise directly. The
 * provider-credential gate sets `name = "ProviderCredentialNotValidatedError"`, so the name check is
 * the reliable primary signal; message patterns are the fallback for other throw sites.
 */
export function classifyVerificationScheduleFailureReason(error: unknown): VerificationScheduleFailedReason {
  const name = error instanceof Error ? error.name : "";
  const message = stringifyError(error);
  if (name === "ProviderCredentialNotValidatedError" || /No validated (?:OpenAI|Anthropic) key/i.test(message)) {
    return VERIFICATION_SCHEDULE_FAILED_REASON.PROVIDER_KEY_NOT_VALIDATED;
  }
  if (name === "OpencodeAccessDeniedError" || /opencode is only available to Cycloid team members/i.test(message)) {
    return VERIFICATION_SCHEDULE_FAILED_REASON.OPENCODE_ACCESS_DENIED;
  }
  if (/prompt enqueue/i.test(message)) {
    return VERIFICATION_SCHEDULE_FAILED_REASON.PROMPT_ENQUEUE_FAILED;
  }
  if (/Session DO initialize failed|Cannot create session|Invalid session start model/i.test(message)) {
    return VERIFICATION_SCHEDULE_FAILED_REASON.SESSION_CREATE_FAILED;
  }
  if (/\b(?:lock|claim|D1|database|timeout|status 5\d\d)\b/i.test(message)) {
    return VERIFICATION_SCHEDULE_FAILED_REASON.INFRA_ERROR;
  }
  return VERIFICATION_SCHEDULE_FAILED_REASON.UNKNOWN;
}

/**
 * Emit `review_listening.dormant_count` once per sweep tick with the snapshot count of
 * caught-up dormant review_listening sessions: sessions with rich_status='review_listening'
 * AND review_loop_done_state='done' AND arcanist_done_state='done'. A non-zero steady count
 * confirms dormancy reduction is working; a sudden rise flags a regression; a persistent zero
 * when sessions exist flags that dormancy never fires.
 *
 * `dormant_count` is log-only drill-down; only `event` (a bounded enum) is safe for metric
 * group_by. This emit itself never throws — `postStructuredEventToDd` catches all network errors
 * and no-ops without `DD_API_KEY`. The real throw risk is the D1 count query a caller runs first,
 * so the call site wraps both the query and this emit in a single `try/catch`.
 */
export async function emitReviewListeningDormantCountEvent(
  env: EmitEnv,
  fields: { dormantCount: number },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_listening.dormant_count",
    dormant_count: fields.dormantCount,
  });
}

/**
 * Emit `qa_tester.schedule.failed` when auto-verification scheduling throws (`schedule_failed`).
 *
 * This is the telemetry that was MISSING for the 2026-06-23 stuck-loop class: the only prior signal
 * was a SessionDO pino `warn`, and control-plane/DO console logs are NOT shipped to Datadog
 * (`logpush=false`) — only `postStructuredEventToDd` events + spans are. So a `schedule_failed` was
 * invisible to every metric/monitor, and the review loop silently retried the same failing hand-off
 * every sweep. This event makes the failure queryable (`@event:qa_tester.schedule.failed` carries
 * `@error`, `@pr_url`, `@session_id`) and drives `arcanist.qa_tester.schedule_failed` +
 * its monitor. See docs/debugging-runbook.md.
 *
 * `reason_code` is the only bounded dimension safe to tag/group; `error`, `pr_url`, `session_id`,
 * `verification_session_id`, `head_sha`, `repo` are for log drill-down and MUST NOT be grouped.
 */
export async function emitQaTesterScheduleFailedEvent(
  env: EmitEnv,
  fields: {
    reasonCode: VerificationScheduleFailedReason;
    error: string;
    repo: string | null;
    ownerUserId: number;
    sessionId: string | null;
    verificationSessionId: string | null;
    verifierBackend?: string | null;
    verifierModel?: string | null;
    prUrl: string | null;
    headSha: string | null;
  },
): Promise<void> {
  const payload = {
    reason_code: fields.reasonCode,
    // Cap the raw message so a stack-y error cannot bloat the log line; full detail lives in the
    // SessionDO pino warn (wrangler tail) when deeper inspection is needed.
    error: fields.error.slice(0, 500),
    repo: fields.repo ?? "unknown",
    owner_user_id: fields.ownerUserId,
    session_id: fields.sessionId,
    verification_session_id: fields.verificationSessionId,
    verifier_backend: fields.verifierBackend ?? null,
    verifier_model: fields.verifierModel ?? null,
    pr_url: fields.prUrl,
    head_sha: fields.headSha,
  };
  await postStructuredEventToDd(env, { event: QA_TESTER_TELEMETRY_EVENT.SCHEDULE_FAILED, ...payload });
}

export async function emitVerificationScheduleFailedEvent(
  env: EmitEnv,
  fields: Parameters<typeof emitQaTesterScheduleFailedEvent>[1],
): Promise<void> {
  await emitQaTesterScheduleFailedEvent(env, fields);
}
