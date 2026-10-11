import {
  type ReviewVerificationExemptReason,
  reviewVerificationExemptReason,
} from "../../../../shared/agent/constants.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { isTransientD1StorageError } from "../db/errors";
import { createInstallationToken } from "../github/octokit";
import { getPrState } from "../github/pr";
import { createLogger } from "../logger";
import { emitReviewListeningEntered } from "../session/publish-service";
import { getSessionState, warmSession } from "../session/state";
import type { Env, SessionState } from "../types";
import { SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, upsertSessionWebhookRef } from "../webhooks/db";
import { bootstrapReviewLoopEpochForHuman, selectHumanEpochCarryingSource } from "./review-loop-epochs";
import { resolveReviewLoopHumanEligibility } from "./review-loop-settings";

const log = createLogger({ bindings: { component: "review-loop-reengage" } });

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Emit a structured review_loop_reengage decision log then return the result. */
function logAndReturn(
  result: ReengageResult,
  meta: {
    sessionId: string;
    reviewId: number;
    reason?: string;
    epochId?: string;
  },
): ReengageResult {
  const isError =
    result.status === "session_archived" ||
    result.status === "warm_failed" ||
    result.status === "enter_review_listening_failed" ||
    result.status === "epoch_bootstrap_failed" ||
    result.status === "transient_pr_state";
  const logFn = isError ? log.warn.bind(log) : log.info.bind(log);
  logFn(
    {
      event: "review_loop_reengage",
      sessionId: meta.sessionId,
      reviewId: meta.reviewId,
      result: result.status,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      ...(meta.epochId !== undefined ? { epochId: meta.epochId } : {}),
    },
    "review-loop reengage decision",
  );
  return result;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReengageResult =
  | { status: "reengaged"; sessionId: string; epochId: string }
  | { status: "already_reengaged"; sessionId: string; epochId: string }
  | {
      status: "not_eligible";
      sessionId: string;
      // `review_handling_disabled` (ARC-1514): in manual review mode a human review does not re-engage a
      // finished session — the human-review arm is off (an @cycloid mention re-engages instead).
      reason: "installation_capabilities_missing" | "review_handling_disabled" | ReviewVerificationExemptReason;
    }
  | { status: "pr_not_open"; sessionId: string }
  // PR state could NOT be verified (transient GitHub 404/429/5xx). Distinct from pr_not_open
  // (a genuinely closed/merged PR) so the webhook caller can avoid finalizing the idempotency
  // claim and let GitHub redeliver — otherwise a transient blip permanently drops the human review.
  | { status: "transient_pr_state"; sessionId: string }
  | { status: "session_not_found"; sessionId: string }
  | { status: "session_archived"; sessionId: string }
  | { status: "warm_failed"; sessionId: string; error: string }
  | { status: "enter_review_listening_failed"; sessionId: string; error?: string }
  | { status: "epoch_bootstrap_failed"; sessionId: string; error: string; retryable: boolean };

export interface ReviewEventLite {
  reviewId: number;
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  /** commit_id from the review payload — the PR head SHA at the time of the review */
  headSha: string;
  reviewAuthor: string;
  reviewUserId: number;
  installationId: number;
}

// ---------------------------------------------------------------------------
// Runtime-state query helpers
// ---------------------------------------------------------------------------

interface SessionRuntimeRow {
  runtime_state_expires_at: number | null;
  runtime_live_lease_expires_at: number | null;
}

async function getSessionRuntimeExpiry(db: D1Database, sessionId: string): Promise<SessionRuntimeRow | null> {
  return db
    .prepare(
      `SELECT runtime_state_expires_at, runtime_live_lease_expires_at
       FROM session_index
       WHERE session_id = ?
       LIMIT 1`,
    )
    .bind(sessionId)
    .first<SessionRuntimeRow>();
}

function isRuntimeGone(row: SessionRuntimeRow | null, nowMs: number): boolean {
  if (!row) return true;
  const stateExpired = row.runtime_state_expires_at !== null && row.runtime_state_expires_at <= nowMs;
  const leaseExpired = row.runtime_live_lease_expires_at !== null && row.runtime_live_lease_expires_at <= nowMs;
  // Runtime is gone if both fields are null (no running runtime recorded) OR either expiry has elapsed.
  const noRuntimeRecorded = row.runtime_state_expires_at === null && row.runtime_live_lease_expires_at === null;
  return noRuntimeRecorded || stateExpired || leaseExpired;
}

/**
 * ARC-1407: is the session's agent actively working RIGHT NOW? Reused by the review-loop sweep's
 * stuck-epoch reclaim, which must not orphan an epoch whose agent is still working. This checks ONLY the
 * runtime LIVE LEASE (runtime_live_lease_expires_at) — the SessionDO refreshes it solely when it observes
 * live work (an active prompt, a pending dispatch, or fresh sandbox activity), and it is NULL/expired
 * when the session is idle or idle-paused.
 *
 * Deliberately NOT `isRuntimeGone`: that answers a different question ("is the sandbox unrecoverable / must
 * we warm it?") and treats the multi-hour sandbox STATE retention of a paused-but-resumable sandbox as
 * "not gone". Using `!isRuntimeGone` here would misread an idle-paused session (state expiry hours in the
 * future, live lease NULL) as a live agent and skip the reclaim forever — never re-driving or blocking the
 * stuck epoch. NOT `session_index.updated_at` either (a coarse boundary, not a liveness signal).
 */
export async function isSessionRuntimeLive(db: D1Database, sessionId: string, nowMs: number): Promise<boolean> {
  const row = await getSessionRuntimeExpiry(db, sessionId);
  return row?.runtime_live_lease_expires_at != null && row.runtime_live_lease_expires_at > nowMs;
}

// ---------------------------------------------------------------------------
// Shared PR-liveness scaffold (ARC-1514)
// ---------------------------------------------------------------------------

/**
 * Result of {@link ensureSessionLiveForPr}. Archived sessions are terminal and
 * return `session_archived`; callers skip re-engage and point users at a new session.
 */
export type EnsureSessionLiveResult =
  | { status: "live"; session: SessionState }
  | { status: "session_not_found" }
  | { status: "session_archived" }
  | { status: "warm_failed"; error: string };

/**
 * Generic "make the PR-bound session live again" scaffold shared by the human-review
 * re-engage path and the `@cycloid` mention triggers (PR6/7/8). It performs ONLY the
 * provider-agnostic revive steps:
 *  1. Load the session; missing → `session_not_found`.
 *  2. If archived → `session_archived`.
 *  3. If the runtime is gone/expired → warm (cold-boot the SAME PR-bound sandbox); else
 *     reuse the still-warm sandbox; warm failure → `warm_failed`.
 *  4. Idempotently register the `github_pr_url` webhook ref so future PR events route here.
 *
 * It deliberately DROPS every review-specific gate (`reviewVerificationExemptReason`,
 * `resolveReviewLoopHumanEligibility`, the human-epoch bootstrap) — a mention is a task,
 * not a review, so those belong to the review caller, which applies them around this call.
 *
 * The PR-open check is intentionally NOT here: it needs installation/repo/PR identifiers
 * that are outside this signature, and each caller already establishes PR state from its
 * own webhook context (the review path checks it before calling this).
 *
 * @param args.session   Optional pre-loaded session. When provided, the initial load is skipped and
 *   this session is used (the review path already loaded it for its gates, so it otherwise pays a
 *   redundant 2nd DO round-trip).
 *   only skips the FIRST load.
 * @param args.requestId Optional trace-correlation id, default `ensure-live-${sessionId}`. Callers with
 *   a triggering context (e.g. a review) pass their scoped id so traces correlate to the trigger.
 */
export async function ensureSessionLiveForPr(args: {
  env: Env;
  db: D1Database;
  sessionId: string;
  prUrl: string;
  nowMs: number;
  session?: SessionState;
  requestId?: string;
}): Promise<EnsureSessionLiveResult> {
  const { env, db, sessionId, prUrl, nowMs } = args;
  const requestId = args.requestId ?? `ensure-live-${sessionId}`;

  // ---- Load session (reuse the caller's pre-loaded session when provided) ----
  const session = args.session ?? (await getSessionState(env, sessionId, requestId));
  if (!session) {
    return { status: "session_not_found" };
  }

  // ---- Archived sessions are terminal ----
  let workingSession = session;
  if (session.status === "archived") {
    return { status: "session_archived" };
  }

  // ---- Warm the same PR-bound sandbox if the runtime is gone, else reuse it ----
  const runtimeRow = await getSessionRuntimeExpiry(db, sessionId);
  if (isRuntimeGone(runtimeRow, nowMs)) {
    const warm = await warmSession(env, sessionId, requestId);
    if (!warm.ok) {
      return { status: "warm_failed", error: warm.error ?? "warm failed (unknown error)" };
    }
  }

  // ---- Idempotently register the PR webhook ref (correct arg order: db, source, ref, sessionId) ----
  await upsertSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl, sessionId);

  return { status: "live", session: workingSession };
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

/**
 * Re-engages a Cycloid session for a human PR review that arrived after
 * the bot loop finished.
 *
 * Steps:
 *  1. Load session; missing → session_not_found.
 *  2. resolveReviewLoopHumanEligibility; not ok → not_eligible.
 *  3. Check PR state via installation token; not open → pr_not_open.
 *  4. If session is archived → session_archived.
 *  5. If runtime is gone/expired → warm; failure → warm_failed.
 *  6. Bootstrap human epoch; failure → epoch_bootstrap_failed.
 *  7. Emit review_listening.entered.
 *  8. Return reengaged (new) or already_reengaged (same reviewId already present).
 */
export async function reengageSessionForReview(args: {
  env: Env;
  db: D1Database;
  sessionId: string;
  ev: ReviewEventLite;
}): Promise<ReengageResult> {
  const { env, db, sessionId, ev } = args;
  const nowMs = Date.now();
  const requestId = `reengage-${sessionId}-${ev.reviewId}`;

  const meta = { sessionId, reviewId: ev.reviewId };

  // ---- Step 1: Load session ----
  const session = await getSessionState(env, sessionId, requestId);
  if (!session) {
    return logAndReturn({ status: "session_not_found", sessionId }, meta);
  }
  const exempt = reviewVerificationExemptReason(session);
  if (exempt) {
    return logAndReturn({ status: "not_eligible", sessionId, reason: exempt }, { ...meta, reason: exempt });
  }

  // ---- Step 2: Eligibility ----
  const elig = await resolveReviewLoopHumanEligibility(env, {
    ownerUserId: Number(session.ownerUserId),
    repoOwner: ev.repoOwner,
    repoName: ev.repoName,
  });
  if (!elig.ok) {
    return logAndReturn({ status: "not_eligible", sessionId, reason: elig.reason }, { ...meta, reason: elig.reason });
  }

  // ---- Step 3: PR state ----
  // getPrState returns null on a TRANSIENT GitHub failure (404/429/5xx) and "closed"/"merged" for a
  // genuinely-not-open PR. Treat the transient case as retryable (transient_pr_state) so the webhook
  // caller does not finalize its idempotency claim — letting GitHub redeliver — instead of silently
  // dropping the human review as pr_not_open. (A 401/403 throws and surfaces as `errored` upstream,
  // which the caller also treats as retryable.)
  const installationToken = await createInstallationToken(env, ev.installationId);
  const prState = await getPrState(installationToken, ev.repoOwner, ev.repoName, ev.prNumber);
  if (prState === null) {
    return logAndReturn({ status: "transient_pr_state", sessionId }, { ...meta, reason: "pr_state:transient" });
  }
  if (prState !== "open") {
    return logAndReturn({ status: "pr_not_open", sessionId }, { ...meta, reason: `pr_state:${prState}` });
  }

  // ---- Steps 4-5: Load/warm scaffold (shared with @cycloid mention re-engage) ----
  // The review-specific gates above (verification-exempt, human eligibility, PR-open) run BEFORE
  // this call, so an ineligible/exempt/closed-PR review never triggers a warm side
  // effect. ensureSessionLiveForPr performs only the generic revive (warm
  // the same PR-bound sandbox if the runtime is gone, else reuse it) plus the idempotent PR
  // webhook-ref upsert (a no-op here since the PR-bound session already owns the ref).
  // Pass the already-loaded `session` (skips the scaffold's redundant initial DO load) and the
  // review-scoped `requestId` so the revive traces correlate to the triggering review.
  const live = await ensureSessionLiveForPr({ env, db, sessionId, prUrl: ev.prUrl, nowMs, session, requestId });
  if (live.status === "session_not_found") {
    // Existed at Step 1 but vanished before the scaffold reloaded it — surface as not found.
    return logAndReturn({ status: "session_not_found", sessionId }, meta);
  }
  if (live.status === "session_archived") {
    return logAndReturn({ status: "session_archived", sessionId }, { ...meta, reason: "session_archived" });
  }
  if (live.status === "warm_failed") {
    return logAndReturn({ status: "warm_failed", sessionId, error: live.error }, { ...meta, reason: "warm_failed" });
  }
  const workingSession = live.session;

  // ---- Step 6: Idempotency pre-check ----
  // Scan every wave for this head, not just the latest: distinct human reviews now split into
  // separate waves, so a re-engage of this review must find the wave it already owns even when a
  // newer review took the top wave. A latest-wave-only lookup would miss it and re-bootstrap a
  // duplicate wave (upsert's guard would still catch it, but this keeps the pre-check accurate).
  const ownerUserId = Number(workingSession.ownerUserId);
  const triggeringSourceId = `human:${ev.reviewId}`;
  const alreadyReengagedEpoch = await selectHumanEpochCarryingSource(
    db,
    { ownerUserId, sessionId, prUrl: ev.prUrl, headSha: ev.headSha },
    triggeringSourceId,
  );

  // ---- Step 6b: Bootstrap human epoch (idempotent) ----
  let epoch = alreadyReengagedEpoch;
  if (!epoch) {
    try {
      epoch = await bootstrapReviewLoopEpochForHuman(db, {
        sessionId,
        ownerUserId,
        repoOwner: ev.repoOwner,
        repoName: ev.repoName,
        prNumber: ev.prNumber,
        prUrl: ev.prUrl,
        headSha: ev.headSha,
        triggeringSourceId,
        reviewerUserId: ev.reviewUserId,
        nowMs,
      });
    } catch (err) {
      const error = stringifyError(err);
      return logAndReturn(
        { status: "epoch_bootstrap_failed", sessionId, error, retryable: isTransientD1StorageError(err) },
        { ...meta, reason: "epoch_bootstrap_failed" },
      );
    }
  }

  // ---- Step 7: Emit review_listening.entered ----
  // The epoch is bootstrapped first so the triggering human review id is durable
  // before the session DO is marked as review-listening.
  const enterResult = await emitReviewListeningEntered(env, sessionId, {
    headSha: ev.headSha,
    prUrl: ev.prUrl,
  });
  if (!enterResult || !enterResult.ok || !enterResult.payload?.updated) {
    const reason = enterResult?.payload?.reason ?? (enterResult ? `http_${enterResult.status}` : "no_pr_url");
    // A re-archive between bootstrap and this emit leaves the epoch collecting/ready, which is
    // fail-open: the sweep skips epochs whose session is not review-listening and dispatches them
    // once the session is live, while this retryable failure makes GitHub redeliver the review.
    return logAndReturn(
      { status: "enter_review_listening_failed", sessionId, error: reason },
      { ...meta, reason: "enter_review_listening_failed" },
    );
  }

  // ---- Step 8: Return result ----
  if (alreadyReengagedEpoch) {
    return logAndReturn({ status: "already_reengaged", sessionId, epochId: epoch.id }, { ...meta, epochId: epoch.id });
  }
  return logAndReturn({ status: "reengaged", sessionId, epochId: epoch.id }, { ...meta, epochId: epoch.id });
}
