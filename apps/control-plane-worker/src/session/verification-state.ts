import type { VerificationResult, VerificationState } from "../../../../shared/session/phase.js";
import type { QaRunTerminalSummary } from "../../../../shared/types/qa-run.js";
import type { VerificationNeedsWorkLabel } from "../../../../shared/types/sandbox.js";
import { MAX_VERIFICATION_RUNS_PER_PR, SESSION_DO_FANOUT_CONCURRENCY } from "../constants/verification";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import { resolvePublicSessionUrl } from "../services/public-url";
import { postSessionThreadMessage } from "../slack/thread-budget";
import { resolveSlackBotTokenForCallback } from "../slack/tokens";
import type { Env, SessionState } from "../types";
import { mapBounded, normalizeWebhookReference } from "../utils";
import {
  countVerificationSessionsByGithubPrRef,
  listSessionIdsByWebhookRef,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
} from "../webhooks/db";
import { SLACK_NOTIFICATION_RECOVERY_DELAY_MS } from "./slack-notification-recovery.js";
import { claimSlackPostForDelivery, markSlackPostDelivered, markSlackPostPendingRetry } from "./slack-posts-db";
import {
  getSessionState,
  setSessionVerificationResult,
  setSessionVerificationState,
  updateSessionCallbackContext,
  wakeSessionSlackRetry,
} from "./state";

// ARC-1330 D-59b: the verification-* label list (`VERIFICATION_STATE_LABELS` + `ALL_VERIFICATION_LABELS`
// + the `VERIFICATION_LABEL_META` rank map / `highestRankedVerificationLabel` / `labelSetsDiffer` rank
// validator) and its writers (`syncVerificationStateLabels` / `syncVerificationStateLabelsForPr`) are
// deleted. The canonical `labelsOf(record)` reconcile (`fsm-label-sync.ts`) is the
// sole writer of the managed label namespace; illegal multi-verification-label combos become
// unrepresentable in the projection. The `verification-*` PR-label constants (`constants/pr-labels.ts`)
// survive — `fsm/label-projection.ts` re-derives the same styled labels from the spine record.
export const SLACK_VERIFICATION_BLOCKED_STAGE = "verification_blocked";
export const SLACK_VERIFICATION_BLOCKER_OPERATION = "notifySlackVerificationBlocker";
export type SlackVerificationBlockerState = Extract<
  VerificationState,
  "verification-exhausted" | "verification-stopped"
>;

export interface VerificationStateForPrInput {
  sessionId: string;
  prUrl: string;
  state: VerificationState;
  attemptCount?: number;
  maxAttempts?: number;
  installationId?: number | null;
  repoOwner?: string | null;
  repoName?: string | null;
}

export function isImplementationSessionForPr(session: SessionState | null, prUrl: string): boolean {
  if (!session || session.status === "archived") return false;
  if (session.agentRole !== "implementation") return false;
  return session.reviewListeningActive === true && session.reviewListeningPrUrl === prUrl;
}

export async function resolveAttemptCount(
  env: Env,
  prUrl: string,
  explicitAttemptCount: number | null | undefined,
  logger: Logger,
): Promise<number> {
  if (typeof explicitAttemptCount === "number" && Number.isInteger(explicitAttemptCount) && explicitAttemptCount >= 0) {
    return explicitAttemptCount;
  }
  try {
    return await countVerificationSessionsByGithubPrRef(env.DB, prUrl);
  } catch (error) {
    logger.warn({ prUrl, error: String(error) }, "Verification state attempt-count lookup failed");
    return 0;
  }
}

async function resolveImplementationSessionIds(env: Env, prUrl: string, logger: Logger): Promise<string[]> {
  const sessions = await resolveImplementationSessionsForPr(env, prUrl, logger);
  return sessions.map((session) => session.sessionId);
}

async function resolveImplementationSessionsForPr(env: Env, prUrl: string, logger: Logger): Promise<SessionState[]> {
  try {
    const sessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
    const sessions = await mapBounded(sessionIds, SESSION_DO_FANOUT_CONCURRENCY, (sessionId) =>
      getSessionState(env, sessionId).catch((error: unknown) => {
        logger.warn({ sessionId, prUrl, error: String(error) }, "Verification state linked-session fetch failed");
        return null;
      }),
    );
    return sessions.filter((session): session is SessionState => isImplementationSessionForPr(session, prUrl));
  } catch (error) {
    logger.warn({ prUrl, error: String(error) }, "Verification state linked-session lookup failed");
    return [];
  }
}

async function resolveExhaustedVerificationSession(
  env: Env,
  sessionIds: Iterable<string>,
  logger: Logger,
): Promise<{ attemptCount: number; maxAttempts: number } | null> {
  const sessions = await mapBounded([...sessionIds], SESSION_DO_FANOUT_CONCURRENCY, (sessionId) =>
    getSessionState(env, sessionId).catch((error: unknown) => {
      logger.warn({ sessionId, error: String(error) }, "Verification state terminal lookup failed");
      return null;
    }),
  );
  for (const session of sessions) {
    if (session?.verificationState === "verification-exhausted") {
      return {
        attemptCount: session.verificationAttemptCount ?? 0,
        maxAttempts: session.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
      };
    }
  }
  return null;
}

function shouldNotifySlackForVerificationState(
  state: VerificationState | null,
): state is SlackVerificationBlockerState {
  return state === "verification-exhausted" || state === "verification-stopped";
}

export function slackVerificationBlockerPromptId(
  prUrl: string,
  state: SlackVerificationBlockerState,
  headSha?: string | null,
) {
  return `verification:${state}:${headSha?.trim() || "unknown-head"}:${prUrl}`;
}

export function parseSlackVerificationBlockerPromptId(
  promptId: string,
): { state: SlackVerificationBlockerState; prUrl: string } | null {
  if (!promptId.startsWith("verification:")) return null;
  const parts = promptId.split(":");
  const state = parts[1];
  if (state !== "verification-exhausted" && state !== "verification-stopped") return null;
  if (parts.length < 4) return null;
  return { state, prUrl: parts.slice(3).join(":") };
}

export function slackVerificationBlockerText(input: {
  state: SlackVerificationBlockerState;
  prUrl: string;
  attemptCount: number;
  maxAttempts: number;
  sessionUrl: string;
}): string {
  const headline =
    input.state === "verification-exhausted"
      ? `QA testing exhausted after ${input.attemptCount}/${input.maxAttempts} attempts.`
      : "QA testing stopped before it could produce a verdict.";
  return `${headline}\nPR: ${input.prUrl}\nSession: ${input.sessionUrl}`;
}

async function scheduleVerificationBlockerRetry(
  env: Env,
  options: {
    sessionId: string;
    promptId: string;
    reason: string;
    requestId?: string | null;
    logger: Logger;
  },
): Promise<void> {
  const status = await markSlackPostPendingRetry(env.DB, {
    sessionId: options.sessionId,
    promptId: options.promptId,
    stage: SLACK_VERIFICATION_BLOCKED_STAGE,
    nextAttemptAt: Date.now() + SLACK_NOTIFICATION_RECOVERY_DELAY_MS,
    error: options.reason,
  });
  if (status === "exhausted") {
    await reportSlackPostFailure(env, {
      operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
      sessionId: options.sessionId,
      stage: SLACK_VERIFICATION_BLOCKED_STAGE,
      reason: "exhausted",
      errorMessage: options.reason,
    });
    return;
  }
  if (status !== "pending") return;
  const wake = await wakeSessionSlackRetry(env, options.sessionId, options.requestId ?? null);
  if (!wake.ok) {
    options.logger.warn(
      { sessionId: options.sessionId, promptId: options.promptId, status: wake.status, reason: options.reason },
      "Slack verification blocker retry wake failed",
    );
  }
}

async function notifySlackForTerminalVerificationState(
  env: Env,
  options: {
    prUrl: string;
    state: VerificationState | null;
    sessionIds: Iterable<string>;
    attemptCount: number;
    maxAttempts: number;
    requestId?: string | null;
    logger: Logger;
    prefetchedSessions?: ReadonlyMap<string, SessionState>;
  },
): Promise<void> {
  if (!shouldNotifySlackForVerificationState(options.state)) return;
  const terminalState = options.state;

  await mapBounded([...options.sessionIds], SESSION_DO_FANOUT_CONCURRENCY, async (sessionId) => {
    let session: SessionState | null = options.prefetchedSessions?.get(sessionId) ?? null;
    if (!session) {
      try {
        session = await getSessionState(env, sessionId, options.requestId ?? undefined);
      } catch (error) {
        options.logger.warn(
          { sessionId, prUrl: options.prUrl, state: terminalState, error: String(error) },
          "Slack verification blocker session lookup failed",
        );
        return;
      }
    }

    if (!session || !isImplementationSessionForPr(session, options.prUrl)) return;
    const callbackContext = session.callbackContext;
    if (!callbackContext || callbackContext.source !== "slack") return;

    const promptId = slackVerificationBlockerPromptId(options.prUrl, terminalState, session.reviewListeningHeadSha);

    try {
      const shouldPost = await claimSlackPostForDelivery(env.DB, {
        sessionId,
        promptId,
        stage: SLACK_VERIFICATION_BLOCKED_STAGE,
        channel: callbackContext.channel,
      });
      if (!shouldPost) return;

      const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
        sessionId,
        operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
      });
      if (!token) {
        await scheduleVerificationBlockerRetry(env, {
          sessionId,
          promptId,
          reason: "no_bot_token",
          requestId: options.requestId ?? null,
          logger: options.logger,
        });
        options.logger.info(
          {
            sessionId,
            prUrl: options.prUrl,
            state: terminalState,
            slackTeamId: callbackContext.slackTeamId,
          },
          "Slack verification blocker notification skipped: no bot token",
        );
        return;
      }

      const text = slackVerificationBlockerText({
        state: terminalState,
        prUrl: options.prUrl,
        attemptCount: options.attemptCount,
        maxAttempts: options.maxAttempts,
        sessionUrl: resolvePublicSessionUrl(env, sessionId),
      });
      const result = await postSessionThreadMessage({
        token,
        channel: callbackContext.channel,
        threadTs: callbackContext.threadTs,
        kind: "ask",
        text,
        sessionId,
        anchors: callbackContext,
        persistAnchors: async (patch) => {
          // Worker-side persist: route through the DO's merge (anchors survive
          // partial updates via mergeCallbackContextUpdate).
          await updateSessionCallbackContext(env, sessionId, { ...callbackContext, ...patch });
        },
      });
      if (!result.ok) {
        await reportSlackPostFailure(env, {
          operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
          sessionId,
          stage: SLACK_VERIFICATION_BLOCKED_STAGE,
          slackErrorCode: result.error,
        });
        await scheduleVerificationBlockerRetry(env, {
          sessionId,
          promptId,
          reason: "verification_blocked_api_error",
          requestId: options.requestId ?? null,
          logger: options.logger,
        });
        options.logger.warn(
          { sessionId, prUrl: options.prUrl, state: terminalState, slackError: result.error },
          "Slack verification blocker notification failed",
        );
        return;
      }
      if (!result.ts) {
        await reportSlackPostFailure(env, {
          operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
          sessionId,
          stage: SLACK_VERIFICATION_BLOCKED_STAGE,
          reason: "missing_message_ts",
          errorMessage: "slack_missing_message_ts",
        });
        await scheduleVerificationBlockerRetry(env, {
          sessionId,
          promptId,
          reason: "verification_blocked_missing_ts",
          requestId: options.requestId ?? null,
          logger: options.logger,
        });
        options.logger.warn(
          { sessionId, prUrl: options.prUrl, state: terminalState },
          "Slack verification blocker notification missing message timestamp",
        );
        return;
      }
      await markSlackPostDelivered(env.DB, {
        sessionId,
        promptId,
        stage: SLACK_VERIFICATION_BLOCKED_STAGE,
        messageTs: result.ts,
      });
    } catch (error) {
      await scheduleVerificationBlockerRetry(env, {
        sessionId,
        promptId,
        reason: "verification_blocked_exception",
        requestId: options.requestId ?? null,
        logger: options.logger,
      }).catch(() => {});
      options.logger.warn(
        { sessionId, prUrl: options.prUrl, state: terminalState, error: String(error) },
        "Slack verification blocker notification error",
      );
    }
  });
}

// ARC-1330 D-59b: `syncVerificationStateLabels` / `syncVerificationStateLabelsForPr` (legacy label
// writer #1 of 3) are deleted. Both call sites — the DO verification-transition path
// (`setCurrentSessionVerificationStateForPr`) and `syncVerificationStateForPr` below — already delegate
// to the canonical `labelsOf(record)` reconcile (`syncFsmLabelsForPr`); that
// reconcile is now the sole verification-label writer.

export async function syncVerificationStateForPr(
  env: Env,
  options: {
    prUrl: string;
    state: VerificationState | null;
    sessionIds?: string[];
    attemptCount?: number | null;
    maxAttempts?: number;
    installationId?: number | null;
    repoOwner?: string | null;
    repoName?: string | null;
    requestId?: string | null;
    logger: Logger;
    updateLinkedImplementationSessions?: boolean;
    // Head-change reset only: clear `verification-exhausted` instead of re-promoting it. The run cap
    // itself remains PR-scoped; every other caller keeps exhausted sticky.
    allowExhaustedClear?: boolean;
    runBaseline?: number | null;
  },
): Promise<void> {
  const prUrl = normalizeWebhookReference(options.prUrl);
  if (!prUrl) return;
  const maxAttempts = options.maxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR;
  const attemptCount = await resolveAttemptCount(env, prUrl, options.attemptCount, options.logger);
  const sessionIds = new Set(options.sessionIds ?? []);
  const prefetchedSessions = new Map<string, SessionState>();

  if (options.updateLinkedImplementationSessions !== false) {
    for (const session of await resolveImplementationSessionsForPr(env, prUrl, options.logger)) {
      sessionIds.add(session.sessionId);
      prefetchedSessions.set(session.sessionId, session);
    }
  }

  let state = options.state;
  let effectiveAttemptCount = attemptCount;
  let effectiveMaxAttempts = maxAttempts;
  // On a head-change clear we WANT exhausted to drop, so skip the re-promotion that otherwise keeps it
  // sticky across the fan-out (the DO guard is bypassed in lockstep via allowExhaustedClear).
  if (!options.allowExhaustedClear && state !== "verification-exhausted") {
    const exhausted = await resolveExhaustedVerificationSession(env, sessionIds, options.logger);
    if (exhausted) {
      state = "verification-exhausted";
      effectiveAttemptCount = exhausted.attemptCount;
      effectiveMaxAttempts = exhausted.maxAttempts;
    }
  }

  await mapBounded([...sessionIds], SESSION_DO_FANOUT_CONCURRENCY, (sessionId) =>
    setSessionVerificationState(
      env,
      sessionId,
      {
        state,
        attemptCount: effectiveAttemptCount,
        maxAttempts: effectiveMaxAttempts,
        allowExhaustedClear: options.allowExhaustedClear,
        ...(typeof options.runBaseline === "number" ? { runBaseline: options.runBaseline } : {}),
      },
      options.requestId ?? null,
    ).catch((error: unknown) => {
      options.logger.warn(
        {
          sessionId,
          prUrl,
          state,
          attemptCount: effectiveAttemptCount,
          maxAttempts: effectiveMaxAttempts,
          error: String(error),
        },
        "Verification state session update failed",
      );
    }),
  );

  // ARC-1330 D-59b: the legacy verification-* label reconcile (writer #1) is deleted. The canonical
  // `labelsOf(record)` projection is the sole label writer,
  // driven by the owning session's spine row via the DO transition path
  // (`setCurrentSessionVerificationStateForPr`) and the periodic sweep reconcile.

  await notifySlackForTerminalVerificationState(env, {
    prUrl,
    state,
    sessionIds,
    attemptCount: effectiveAttemptCount,
    maxAttempts: effectiveMaxAttempts,
    requestId: options.requestId ?? null,
    logger: options.logger,
    prefetchedSessions,
  });
}

export async function syncVerificationResultForPr(
  env: Env,
  options: {
    prUrl: string;
    result: VerificationResult | null;
    needsWorkLabel?: VerificationNeedsWorkLabel | null;
    qaRun?: QaRunTerminalSummary | null;
    sessionIds?: string[];
    requestId?: string | null;
    logger: Logger;
    updateLinkedImplementationSessions?: boolean;
  },
): Promise<void> {
  const prUrl = normalizeWebhookReference(options.prUrl);
  if (!prUrl) return;
  const sessionIds = new Set(options.sessionIds ?? []);

  if (options.updateLinkedImplementationSessions !== false) {
    for (const sessionId of await resolveImplementationSessionIds(env, prUrl, options.logger)) {
      sessionIds.add(sessionId);
    }
  }

  await mapBounded([...sessionIds], SESSION_DO_FANOUT_CONCURRENCY, (sessionId) =>
    setSessionVerificationResult(
      env,
      sessionId,
      {
        result: options.result,
        needsWorkLabel: options.needsWorkLabel ?? null,
        ...(options.qaRun !== undefined || options.result === null ? { qaRun: options.qaRun ?? null } : {}),
      },
      options.requestId ?? null,
    ).catch((error: unknown) => {
      options.logger.warn(
        {
          sessionId,
          prUrl,
          result: options.result,
          needsWorkLabel: options.needsWorkLabel ?? null,
          error: String(error),
        },
        "Verification result session update failed",
      );
    }),
  );
}

/**
 * Discard a settled verification verdict (both result AND state) for a session whose PR head just
 * advanced. A verdict describes the head it was produced at; once the head moves, the prior-head
 * verdict is stale and must not bind to the new head — it would gate `review-loop:done` onto the new
 * head before that head's own verification concludes, or be re-ingested as a verification-intake
 * epoch keyed on the live head. BOTH fields are reset because a null-result terminal state
 * (`verification-skipped`) still reads as a terminal approval, so the bare state must be cleared too.
 *
 * Best-effort (`allSettled`): a transient clear failure self-heals when the new head's own
 * verification concludes and overwrites these fields. Passes the originating session and (like the
 * verdict sync itself) fans out to the PR's linked implementation sessions, since the verdict is a
 * per-PR concept mirrored across them.
 *
 * Both PR-head-advance paths MUST call this so a stale verdict cannot survive on a new head: the
 * sweep head-change handler (sweep-detected change) and the `synchronize` webhook (out-of-band head
 * advance that bypasses the sweep's branch on the next tick). Keeping the logic here prevents the two
 * equivalent paths from drifting (ARC-1227 / ARC-1231).
 *
 * For `verification-exhausted` this also clears the exhausted state for the new head. The run cap
 * remains PR-scoped: a branch/PR gets `MAX_VERIFICATION_RUNS_PER_PR` total verifier runs, not a fresh
 * budget per head SHA.
 */
export async function clearVerificationVerdictForHeadChange(
  env: Env,
  options: { prUrl: string; sessionId: string; logger: Logger },
): Promise<void> {
  const settled = await Promise.allSettled([
    syncVerificationResultForPr(env, {
      prUrl: options.prUrl,
      result: null,
      sessionIds: [options.sessionId],
      requestId: null,
      logger: options.logger,
    }),
    syncVerificationStateForPr(env, {
      prUrl: options.prUrl,
      state: null,
      sessionIds: [options.sessionId],
      requestId: null,
      logger: options.logger,
      allowExhaustedClear: true,
    }),
  ]);

  // A rejected clear strands an outdated `needs-work` verdict that blocks the new head's verification. The
  // SessionDO pino warn this used to leave does not reach Datadog (logpush off), so surface the failure as a
  // structured event the verification family can query. Best-effort and non-blocking (it self-heals on the
  // next head advance); we only ADD telemetry, the clear flow is unchanged.
  const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (rejected.length > 0) {
    await postStructuredEventToDd(env, {
      // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
      event: "verification.verdict_clear.failed",
      reason_code: "verdict_clear_failed_on_head_change",
      error: rejected
        .map((outcome) => String(outcome.reason))
        .join("; ")
        .slice(0, 500),
      session_id: options.sessionId,
      pr_url: options.prUrl,
    });
  }
}

/**
 * Sibling of `clearVerificationVerdictForHeadChange` for a CONTENT NO-OP head advance (rebase /
 * reword / no-op force-push: identical tree). The verdict is preserved (not cleared); this stamps the
 * head SHA the verdict is now validated for so the auto-verification scheduler can positively identify
 * the no-op and skip re-verification (ARC-1243 follow-up). Only the stamp changes — the verdict
 * state/result/attempt fields are passed through unchanged.
 *
 * Why a positive stamp rather than "verdict present": `clearVerificationVerdictForHeadChange` is
 * best-effort, so a transient failure on a REAL change can strand a stale settled verdict. The
 * scheduler skips only when the stamp equals the head being settled — a real change is stamped for a
 * different (or no) head, so it still re-verifies and self-heals. Best-effort: a failed stamp only
 * means the no-op may be re-verified (wasted, never wrong).
 */
export async function stampVerificationVerdictHeadForHeadChange(
  env: Env,
  options: {
    sessionId: string;
    headSha: string;
    currentState: VerificationState | null;
    attemptCount?: number;
    maxAttempts?: number;
    logger: Logger;
  },
): Promise<void> {
  try {
    const result = await setSessionVerificationState(
      env,
      options.sessionId,
      {
        state: options.currentState,
        attemptCount: options.attemptCount ?? 0,
        maxAttempts: options.maxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
        verdictHeadSha: options.headSha,
      },
      null,
    );
    if (!result.ok) {
      options.logger.warn(
        { sessionId: options.sessionId, headSha: options.headSha, status: result.status },
        "Verdict-head stamp on no-op head change failed; the no-op head may be re-verified",
      );
    }
  } catch (error) {
    options.logger.warn(
      { sessionId: options.sessionId, headSha: options.headSha, error: String(error) },
      "Verdict-head stamp on no-op head change threw; the no-op head may be re-verified",
    );
  }
}
