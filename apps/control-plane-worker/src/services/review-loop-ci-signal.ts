import { SESSION_DO_FANOUT_CONCURRENCY } from "../constants/verification";
import { getCommitCheckRuns, getCommitStatusContexts } from "../github/pr";
import type { Logger } from "../logger";
import {
  emitVerificationScheduleFailedEvent,
  VERIFICATION_SCHEDULE_FAILED_REASON,
} from "../observability/review-loop-events";
import { shadowEmitCiSignal } from "../session/fsm/ci-producer";
import { getSessionState } from "../session/state";
import { isImplementationSessionForPr } from "../session/verification-state";
import type { Env } from "../types";
import { mapBounded } from "../utils";
import { listSessionIdsByWebhookRef, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR } from "../webhooks/db";
import { reduceCiState, type ReviewLoopCiState } from "./review-loop-rollup";

/**
 * CI-webhook → spine `ci.signal` producer. A terminal-success CI webhook (check_run / commit status)
 * may have just settled the tracked head; poll the head's full check-run + status-context set once,
 * collapse it via `reduceCiState`, and dual-emit the rollup onto the FSM spine as `ci.signal` so a
 * green (or failing/absent) verdict reaches the spine without waiting for the every-5-min sweep tick.
 *
 * ARC-1330 D-59a: the legacy done-state DECISION this webhook fast-path used to drive
 * (`reconcileReviewLoopDoneState`) is deleted with the rest of the cron done-state decision sites — the
 * FSM owns the settle (`caught_up` recompute → cascade) at live, with the periodic sweep + D17 redelivery
 * as backstops. What survives here is the ONE thing the webhook still owes the spine: the settled
 * `ci.signal`. Guard/cohort scoping and the once-per-head CI poll are preserved verbatim from the deleted
 * `reconcileReviewLoopDoneFromCiSignal` so the producer cohort is unchanged.
 *
 * Cheap in-memory guards run before any GitHub call, so already-settled / stale-head / wrong-PR signals
 * cost only a D1 read. Only when they pass do we poll CI for the head. May throw — callers (the CI
 * webhook handlers) wrap it in try/catch and treat it as best-effort (the sweep backstops).
 */
export async function emitReviewLoopCiSignalFromWebhook(
  env: Env,
  options: {
    prUrl: string;
    repoOwner: string;
    repoName: string;
    headSha: string;
    token: string;
    logger: Logger;
    /** PR 47: the webhook handler's ExecutionContext seam — live FSM side-effects defer through it. */
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<void> {
  const { prUrl, repoOwner, repoName, headSha, token, logger } = options;

  const sessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);

  // Resolve the per-session DO state with BOUNDED concurrency (was a serial N+1). Each getSessionState
  // is an independent DO RPC, so a fixed-width fan-out collapses the read latency without unbounded DO
  // contention. Per-session read errors are isolated (captured as null + logged) so one failed DO read
  // does not abort reconciling the others.
  const sessions = await mapBounded(sessionIds, SESSION_DO_FANOUT_CONCURRENCY, async (sessionId) => {
    try {
      return { sessionId, session: await getSessionState(env, sessionId) };
    } catch (error) {
      logger.warn({ prUrl, sessionId, error: String(error) }, "Review-loop ci-signal session read failed; skipping");
      return { sessionId, session: null };
    }
  });

  // Every session that clears the guards shares the same tracked head (asserted below), so the CI state
  // for `headSha` is identical across them — poll once and reuse. Lazy: nothing is polled until a session
  // actually clears the in-memory guards, so non-applicable webhooks still cost only D1 reads.
  let ci: ReviewLoopCiState | null = null;
  for (const { sessionId, session } of sessions) {
    if (!session || !isImplementationSessionForPr(session, prUrl)) continue;

    // In-memory guards (no GitHub calls): a verification run already owns the next step, and a signal
    // for a head the loop no longer tracks is left to the sweep. Do not gate on the QA cohort here:
    // auto-verify is advisory/off by default, while green CI is still the merge-ready unblock signal.
    if (session.verificationState === "verification-in-progress") continue;
    if (session.reviewListeningHeadSha !== headSha) continue;

    if (ci === null) {
      let checkRuns: Awaited<ReturnType<typeof getCommitCheckRuns>>;
      let statusContexts: Awaited<ReturnType<typeof getCommitStatusContexts>>;
      try {
        [checkRuns, statusContexts] = await Promise.all([
          getCommitCheckRuns(token, repoOwner, repoName, headSha),
          getCommitStatusContexts(token, repoOwner, repoName, headSha),
        ]);
      } catch (error) {
        // A transient GitHub 5xx/429/timeout on the CI poll kills this fast-path; the ~5min sweep then
        // backstops the ci.signal. The pino/Sentry wrap at the call sites never reaches Datadog
        // (control-plane logpush is off), so emit the structured event before re-throwing — INFRA_ERROR is
        // the bounded reason for a transient claim/lock/D1/timeout class, which a flaky CI poll is. We do
        // NOT change whether this function throws (callers treat it as best-effort, sweep backstops); we
        // only add the otherwise-missing telemetry. Guard the emit so an unexpected throw from the emit
        // chain can never replace the original CI-poll error callers expect to see.
        try {
          await emitVerificationScheduleFailedEvent(env, {
            reasonCode: VERIFICATION_SCHEDULE_FAILED_REASON.INFRA_ERROR,
            error: String(error),
            repo: `${repoOwner}/${repoName}`,
            ownerUserId: Number(session.ownerUserId),
            sessionId,
            verificationSessionId: null,
            prUrl,
            headSha,
          });
        } catch {
          // postStructuredEventToDd is best-effort telemetry; never let it mask the real error.
        }
        throw error;
      }
      ci = reduceCiState(checkRuns, statusContexts);
    }
    // ARC-1330 (PR 38) shadow / (PR 47) live: dual-emit the head's CI rollup as
    // `ci.signal{green|failing|absent}` onto the FSM spine (`pending` → no event). This is the single
    // place `reduceCiState` is computed with the resolved `session_id` off a CI webhook, so it is the
    // producer seam for "CI webhooks → ci.signal". Fully try-caught inside the producer.
    await shadowEmitCiSignal(env, sessionId, ci, logger, options.waitUntil);
  }
}
