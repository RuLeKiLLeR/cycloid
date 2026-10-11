import type { Phase, StopMode } from "../../../../shared/session/phase.js";
import { getUserBusinessIdOrNull } from "../auth/db";
import { businessIdsMatch } from "../constants/businesses";
import { BlockerKind } from "../enums/blocker.js";
import { InitiationMode } from "../enums/initiation-mode";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import { checkSessionResumeRateLimit } from "../services/session-resume-rate-limiter";
import { getChildSessionRow } from "../session/child-session-db";
import { notifyUserBlocked } from "../session/notify-user-blocked";
import { getPrCoordination } from "../session/pr-coordination-db";
import { getSessionState, resumeSession, setSessionRepo, updateSessionCallbackContext } from "../session/state";
import { updateSlackStatusCardFromSessionState } from "../slack/phase-updates";
import { postSessionThreadMessage, type SessionThreadAnchors } from "../slack/thread-budget";
import type { CallbackContext, Env, SessionState } from "../types";
import { parsePositiveIntegerUserId } from "../utils";
import {
  SLACK_WAKE_ARCHIVED_REPLY,
  SLACK_WAKE_RESUME_FAILED_REPLY,
  SLACK_WAKE_RETRY_NUDGE_REPLY,
} from "./slack-operational-replies";

const log = createLogger({ bindings: { component: "slack-wake" } });

/**
 * Wake-on-reply service: a Slack reply to a thread whose bound session is
 * user-stopped wakes the session through the SAME service gates the resume
 * route applies (resume rate limit, canonical repo-access + installation gate,
 * repo-context refresh), then re-enqueues the reply as the next prompt.
 * Archived sessions are terminal and get a fresh-session reply. `failed`/`blocked` phases do NOT wake in this unit:
 * the enqueue gate rejects them and the retry/`user.retrigger` paths land in
 * later PRs, so those replies get a single budget-path ask pointing at Retry.
 *
 * Surface gating (DM replies mention-free, channel replies require a live
 * @mention) is enforced upstream by the follow-up gate in slack-events.ts, so
 * every caller of this module already passed it. Execution continues under the
 * session OWNER's credentials exactly like live follow-ups — the waker only
 * needs to be a business member with repo access.
 */

/** Runtime shape of the DO `/session/state` response consulted by wake routing. */
export type SlackWakeSessionState = SessionState & {
  phase?: Phase;
  stopMode?: StopMode;
  prUrl?: string | null;
  publishedBranch?: string | null;
  baseBranch?: string | null;
};

export type SlackWakeDenyReason =
  | "unlinked_actor"
  | "business_unresolved"
  | "business_mismatch"
  | "child_session"
  | "rate_limited"
  | "repo_context_missing"
  | "repo_access"
  | "resume_failed";

export type SlackWakeOutcome =
  | { kind: "woken"; fromPhase: "archived" | "stopped" }
  | { kind: "retry_nudge" }
  | { kind: "denied"; reason: SlackWakeDenyReason }
  | { kind: "not_applicable"; reason: string };

async function emitWakeAttemptEvent(
  env: Env,
  fields: { sessionId: string; outcome: string; reason: string | null; fromPhase: string | null },
): Promise<void> {
  // Best-effort signal counter source (`slack.wake.attempt` / outcome=woken is
  // the success series). Never blocks or fails the wake itself.
  await postStructuredEventToDd(env, {
    event: "slack.wake.attempt",
    session_id: fields.sessionId,
    outcome: fields.outcome,
    reason_code: fields.reason ?? undefined,
    from_phase: fields.fromPhase ?? undefined,
  }).catch(() => undefined);
}

function slackAnchorsFromCallbackContext(callbackContext: CallbackContext | null | undefined): SessionThreadAnchors {
  return callbackContext?.source === "slack" ? callbackContext : {};
}

/**
 * Post (or supersede in place) the session's single ask-anchor message with
 * wake copy. All wake replies are ask-kind: they ride the thread budget and
 * never grow the thread past the budget law.
 */
async function postWakeAsk(params: {
  env: Env;
  sessionId: string;
  callbackContext: CallbackContext | null | undefined;
  token: string;
  channelId: string;
  threadTs: string;
  slackTeamId: string;
  text: string;
  blocks?: unknown[];
}): Promise<{ ok: boolean }> {
  const result = await postSessionThreadMessage({
    token: params.token,
    channel: params.channelId,
    threadTs: params.threadTs,
    kind: "ask",
    text: params.text,
    blocks: params.blocks,
    sessionId: params.sessionId,
    anchors: slackAnchorsFromCallbackContext(params.callbackContext),
    persistAnchors: async (patch) => {
      const base: CallbackContext =
        params.callbackContext?.source === "slack"
          ? params.callbackContext
          : {
              source: "slack",
              channel: params.channelId,
              threadTs: params.threadTs,
              slackTeamId: params.slackTeamId,
            };
      await updateSessionCallbackContext(params.env, params.sessionId, { ...base, ...patch });
    },
  });
  if (!result.ok) {
    log.warn(
      { sessionId: params.sessionId, channel: params.channelId, slackError: result.error },
      "Slack wake ask post failed",
    );
  }
  return { ok: result.ok };
}

/**
 * Same repo re-validation the resume route runs before its service
 * calls (`resolveAndRefreshSessionResumeAccess`, routes/sessions.ts): canonical
 * `verifyRepoAccessAndInstallation` gate for the WAKER, owner DM on a true
 * repo-access denial when the denied user IS the owner, then a repo-context
 * refresh so the woken session picks up the current installation. The wake path
 * calls the session/state services directly, so the route-level gate does not
 * run for it — this twin keeps the decision identical.
 */
async function resolveAndRefreshWakeRepoAccess(
  env: Env,
  db: D1Database,
  params: { sessionId: string; session: SlackWakeSessionState; actorUserId: number },
): Promise<{ ok: true } | { ok: false; reason: "repo_context_missing" | "repo_access" }> {
  const { sessionId, session, actorUserId } = params;
  const repoOwner = typeof session.repoOwner === "string" && session.repoOwner.length > 0 ? session.repoOwner : null;
  const repoName = typeof session.repoName === "string" && session.repoName.length > 0 ? session.repoName : null;
  if (!repoOwner || !repoName) {
    return { ok: false, reason: "repo_context_missing" };
  }

  const gate = await verifyRepoAccessAndInstallation(
    db,
    { userId: String(actorUserId), canAccessAllSessions: false, businessRole: null },
    repoOwner,
    repoName,
    { githubTokenEnv: env, sessionId, reposCacheEnv: env },
  );
  if (!gate.ok) {
    const ownerUserId = Number(session.ownerUserId);
    if (gate.reason === "repo_access_denied" && Number.isSafeInteger(ownerUserId) && ownerUserId > 0) {
      await notifyUserBlocked(env, {
        sessionId,
        ownerUserId,
        kind: BlockerKind.RepoAccessDenied,
        dedupKey: sessionId,
      });
    }
    log.warn(
      { sessionId, userId: actorUserId, repoOwner, repoName, reason: gate.reason },
      "Slack wake rejected by repo gate",
    );
    return { ok: false, reason: "repo_access" };
  }

  const baseBranch =
    typeof session.baseBranch === "string" && session.baseBranch.length > 0 ? session.baseBranch : undefined;
  const updateResult = await setSessionRepo(env, sessionId, repoOwner, repoName, baseBranch, gate.installationId);
  if (!updateResult.ok) {
    log.error(
      { sessionId, repoOwner, repoName, installationId: gate.installationId },
      "Failed to refresh session repo context before Slack wake",
    );
    return { ok: false, reason: "repo_access" };
  }
  return { ok: true };
}

/**
 * Gate + wake executor shared by the follow-up path and the wake-confirm
 * button. The caller has already verified the actor is a linked business member
 * of the session's business; this runs the per-action gates (child-session
 * exclusion, resume rate limit, repo re-validation, and resume transition.
 * Fail closed on every unprovable step.
 */
async function executeSlackSessionWake(params: {
  env: Env;
  db: D1Database;
  sessionId: string;
  session: SlackWakeSessionState;
  fromPhase: "stopped";
  actorUserId: number;
}): Promise<{ ok: true } | { ok: false; reason: SlackWakeDenyReason }> {
  const { env, db, sessionId, session, fromPhase, actorUserId } = params;

  // Child sessions are never Slack-thread-bound and carry per-user concurrency
  // reservations; a wake must not bypass them.
  const childRow = await getChildSessionRow(db, sessionId);
  if (childRow?.parent_session_id) {
    return { ok: false, reason: "child_session" };
  }

  const rateLimit = await checkSessionResumeRateLimit(env, sessionId, String(actorUserId));
  if (rateLimit.limited) {
    return { ok: false, reason: "rate_limited" };
  }

  const repoGate = await resolveAndRefreshWakeRepoAccess(env, db, { sessionId, session, actorUserId });
  if (!repoGate.ok) {
    return { ok: false, reason: repoGate.reason };
  }

  // User-stopped: the sandbox must leave the hard-stopped state before the
  // enqueue gate admits the prompt, so a failed resume fails the wake.
  const resumed = await resumeSession(env, sessionId);
  if (!resumed.ok) {
    log.warn({ sessionId, error: resumed.error }, "Slack wake resume failed");
    return { ok: false, reason: "resume_failed" };
  }
  return { ok: true };
}

export interface SlackFollowUpWakeParams {
  env: Env;
  db: D1Database;
  sessionId: string;
  /** Resolved Cycloid user id of the replier (string form, as the follow-up path carries it). */
  actorUserId: string;
  slackTeamId: string;
  slackBotToken: string;
  channelId: string;
  threadTs: string;
  /** Fully-built follow-up prompt (thread context + reply), enqueued post-wake. */
  promptText: string;
  replyToText: string | null;
  now?: number;
}

/**
 * Wake routing for a thread follow-up the enqueue gate rejected. Loads the
 * session, applies the conversational-wake exclusions and authz, then either
 * wakes stopped sessions, posts the archived terminal reply, or posts the
 * failed/blocked retry nudge.
 */
export async function wakeSlackSessionForFollowUp(params: SlackFollowUpWakeParams): Promise<SlackWakeOutcome> {
  const { env, db, sessionId } = params;
  const nowMs = params.now ?? Date.now();

  const settle = async (outcome: SlackWakeOutcome): Promise<SlackWakeOutcome> => {
    await emitWakeAttemptEvent(env, {
      sessionId,
      outcome: outcome.kind,
      reason: "reason" in outcome ? outcome.reason : null,
      fromPhase: outcome.kind === "woken" ? outcome.fromPhase : null,
    });
    return outcome;
  };

  let session: SlackWakeSessionState | null = null;
  try {
    session = (await getSessionState(env, sessionId)) as SlackWakeSessionState | null;
  } catch (err) {
    log.warn({ sessionId, error: String(err) }, "Slack wake session lookup failed");
    return settle({ kind: "not_applicable", reason: "session_unavailable" });
  }
  if (!session) {
    return settle({ kind: "not_applicable", reason: "session_not_found" });
  }

  // Automation-origin sessions (Slack channel automations, scheduled rules) are
  // excluded from conversational wake entirely.
  if (session.initiationMode === InitiationMode.AUTOMATION) {
    return settle({ kind: "not_applicable", reason: "automation_session" });
  }

  // Fail closed: the waker must resolve to a linked user in the session's
  // business. Unlinked actors never reach the follow-up path (the magic-link
  // flow handles them upstream), so an unparsable id here is a hard deny.
  const actorId = parsePositiveIntegerUserId(params.actorUserId);
  if (actorId === null) {
    return settle({ kind: "denied", reason: "unlinked_actor" });
  }
  if (!session.businessId) {
    return settle({ kind: "denied", reason: "business_unresolved" });
  }
  const actorBusinessId = await getUserBusinessIdOrNull(db, actorId).catch(() => null);
  if (!actorBusinessId || !businessIdsMatch(actorBusinessId, session.businessId)) {
    return settle({ kind: "denied", reason: "business_mismatch" });
  }

  const phase: string | null = session.phase ?? (session.status === "archived" ? "archived" : null);

  if (phase === "failed" || phase === "blocked") {
    await postWakeAsk({
      env,
      sessionId,
      callbackContext: session.callbackContext,
      token: params.slackBotToken,
      channelId: params.channelId,
      threadTs: params.threadTs,
      slackTeamId: params.slackTeamId,
      text: SLACK_WAKE_RETRY_NUDGE_REPLY,
    });
    return settle({ kind: "retry_nudge" });
  }

  if (phase !== "archived" && phase !== "stopped") {
    return settle({ kind: "not_applicable", reason: phase ?? "unknown_phase" });
  }

  if (phase === "archived") {
    await postWakeAsk({
      env,
      sessionId,
      callbackContext: session.callbackContext,
      token: params.slackBotToken,
      channelId: params.channelId,
      threadTs: params.threadTs,
      slackTeamId: params.slackTeamId,
      text: SLACK_WAKE_ARCHIVED_REPLY,
    });
    return settle({ kind: "not_applicable", reason: "session_archived" });
  }

  const wake = await executeSlackSessionWake({
    env,
    db,
    sessionId,
    session,
    fromPhase: "stopped",
    actorUserId: actorId,
  });
  if (!wake.ok) {
    return settle({ kind: "denied", reason: wake.reason });
  }
  return settle({ kind: "woken", fromPhase: "stopped" });
}

/**
 * Post-wake enqueue still rejected: surface a single budget-path ask instead of
 * silence (and never the retired dead-end copy).
 */
export async function postSlackWakeEnqueueFailedAsk(params: {
  env: Env;
  sessionId: string;
  slackBotToken: string;
  channelId: string;
  threadTs: string;
  slackTeamId: string;
}): Promise<void> {
  let session: SlackWakeSessionState | null = null;
  try {
    session = (await getSessionState(params.env, params.sessionId)) as SlackWakeSessionState | null;
  } catch {
    session = null;
  }
  await postWakeAsk({
    env: params.env,
    sessionId: params.sessionId,
    callbackContext: session?.callbackContext,
    token: params.slackBotToken,
    channelId: params.channelId,
    threadTs: params.threadTs,
    slackTeamId: params.slackTeamId,
    text: SLACK_WAKE_RESUME_FAILED_REPLY,
  });
}

/** Pull `#123` out of a GitHub PR url; null for non-PR urls. */
function prNumberFromUrl(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null;
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * First-person wake acknowledgment line rendered as the card's narration line:
 * "Picking this back up — PR #123 (merged 3 days ago), branch `feat/x`".
 */
export function buildSlackWakeAckLine(input: {
  prUrl: string | null;
  prNumber: number | null;
  publishedBranch: string | null;
  mergedAtMs: number | null;
  nowMs: number;
}): string {
  const parts: string[] = [];
  if (input.prUrl) {
    const prLabel = input.prNumber ? `PR #${input.prNumber}` : "the PR";
    if (input.mergedAtMs !== null) {
      const mergedDays = Math.max(0, Math.floor((input.nowMs - input.mergedAtMs) / (24 * 60 * 60 * 1000)));
      const mergedText =
        mergedDays === 0 ? "merged today" : `merged ${mergedDays} day${mergedDays === 1 ? "" : "s"} ago`;
      parts.push(`${prLabel} (${mergedText})`);
    } else {
      parts.push(prLabel);
    }
  }
  if (input.publishedBranch) {
    parts.push(`branch \`${input.publishedBranch}\``);
  }
  return parts.length > 0 ? `Picking this back up — ${parts.join(", ")}` : "Picking this back up.";
}

/**
 * Wake acknowledgment: NO new message — the status card updates in place (via
 * the existing worker-side card updater / narrationLine passthrough) with a
 * first-person "Picking this back up …" line rendered from the session's PR
 * metadata + the FSM coordination record. Best-effort: a failed edit only
 * means the next DO-side narration tick repaints the card.
 */
export async function postSlackWakeAcknowledgement(params: {
  env: Env;
  sessionId: string;
  now?: number;
}): Promise<void> {
  const { env, sessionId } = params;
  let session: SlackWakeSessionState | null = null;
  try {
    // Re-read post-wake so the card renders the live PR/branch/anchor state.
    session = (await getSessionState(env, sessionId)) as SlackWakeSessionState | null;
  } catch (err) {
    log.info({ sessionId, error: String(err) }, "Slack wake ack session lookup failed");
    return;
  }
  if (!session) return;

  let mergedAtMs: number | null = null;
  try {
    const coordination = await getPrCoordination(env.DB, sessionId);
    if (coordination?.state === "MERGED") {
      mergedAtMs = coordination.stateEnteredAt ?? params.now ?? Date.now();
    }
  } catch (err) {
    log.info({ sessionId, error: String(err) }, "Slack wake ack coordination lookup failed");
  }

  const prUrl = session.prUrl ?? null;
  const narrationLine = buildSlackWakeAckLine({
    prUrl,
    prNumber: prNumberFromUrl(prUrl),
    publishedBranch: session.publishedBranch ?? null,
    mergedAtMs,
    nowMs: params.now ?? Date.now(),
  });
  await updateSlackStatusCardFromSessionState({
    env,
    log,
    session: { ...session, sessionId },
    stage: "running",
    narrationLine,
  });
}
