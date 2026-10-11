import { isResumeAvailable, isRetryAvailable } from "../../../../shared/session/eligibility.js";
import type { Phase } from "../../../../shared/session/phase.js";
import { getUserBusinessIdOrNull, getUserBySlackId, getUserBySlackIdForTeam } from "../auth/db";
import { businessIdsMatch } from "../constants/businesses";
import { SLACK_INTERACTION_ACTION_PREFIX } from "../constants/slack";
import { isSlackInteractionKind, SlackInteractionKind } from "../enums/slack-interaction";
import { createLogger } from "../logger";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import { checkSessionResumeRateLimit } from "../services/session-resume-rate-limiter";
import {
  approveSessionPlan,
  closeSessionForWebhook,
  getSessionState,
  resumeSession,
  retrySessionPrompt,
} from "../session/state";
import { SLACK_REPO_DISAMBIGUATION_ACTION_ID, slackStatusStageForPhase } from "../slack/blocks";
import { syncCardControlRequests } from "../slack/card-control-requests";
import {
  consumeInteractionRequest,
  getInteractionRequest,
  type SlackInteractionRequestRecord,
} from "../slack/interaction-requests-db";
import { updateSlackStatusCardFromSessionState } from "../slack/phase-updates";
import {
  parsePlanApprovalInteractionPayload,
  planApprovalRequestMatchesBusiness,
  replacePlanApprovalInteractionRequest,
  updatePlanApprovalInteractionMessage,
} from "../slack/plan-approval-interactions";
import type { Env, SessionDOResponse } from "../types";
import { computeSha256Hex, jsonErrorResponse, jsonResponse } from "../utils";
import {
  authorizeSessionCloseActor,
  claimOrSkip,
  getSlackTeamIdFromInteractionPayload,
  handleSlackRepoDisambiguationSelection,
  postSlackInteractionEphemeral,
  verifySlackRequest,
  WEBHOOK_SOURCE_SLACK_INTERACTIONS,
} from "./shared";

const log = createLogger({ bindings: { component: "slack-interactions" } });

export async function handleSlackInteractionsWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const verifyResult = await verifySlackRequest(request, env);
  if (verifyResult instanceof Response) return verifyResult;
  const { rawBody, timestamp, signature } = verifyResult;

  let payload: Record<string, unknown>;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get("payload") || "");
  } catch {
    return jsonErrorResponse("Invalid payload", 400);
  }

  const db = env.DB;
  const payloadHash = await computeSha256Hex(rawBody);
  const { duplicate } = await claimOrSkip(
    db,
    WEBHOOK_SOURCE_SLACK_INTERACTIONS,
    (payload?.trigger_id as string) || `${timestamp}:${signature}`,
    payloadHash,
  );
  if (duplicate) return duplicate;

  const actions = payload?.actions as Array<Record<string, unknown>> | undefined;
  const action = Array.isArray(actions) ? actions[0] : null;
  const rawActionId = typeof action?.action_id === "string" ? (action.action_id as string) : "";

  if (rawActionId === "stop_session" && typeof action?.value === "string" && (action.value as string).length > 0) {
    const sessionId = action.value as string;

    const actorSlackUserId =
      payload?.user && typeof payload.user === "object" ? (payload.user as { id?: unknown }).id : null;
    if (typeof actorSlackUserId !== "string" || actorSlackUserId.length === 0) {
      return jsonResponse({ ok: true, skipped: true, reason: "missing_actor" });
    }
    const actor = await getUserBySlackId(db, actorSlackUserId);
    if (!actor) {
      return jsonResponse({ ok: true, skipped: true, reason: "unknown_actor" });
    }
    const session = await getSessionState(env, sessionId);
    if (!session) {
      return jsonResponse({ ok: true, skipped: true, reason: "session_not_found" });
    }
    const authorization = await authorizeSessionCloseActor(db, String(actor.id), session);
    if (!authorization.authorized) {
      return jsonResponse({ ok: true, skipped: true, reason: authorization.reason });
    }

    const result = await closeSessionForWebhook(env, db, sessionId, {
      reason: "slack_stop_interaction",
      metadata: { closeSource: "slack_stop_interaction", actorUserId: String(actor.id), actorSlackUserId },
    });
    if (!result.session) {
      return jsonResponse({ ok: true, skipped: true, reason: "session_not_found" });
    }
    return jsonResponse({ ok: true, stopped: result.closed, sessionId });
  }

  if (rawActionId.startsWith(`${SLACK_REPO_DISAMBIGUATION_ACTION_ID}:`)) {
    return handleSlackRepoDisambiguationSelection({ env, db, ctx, payload, action });
  }

  if (rawActionId.startsWith(`${SLACK_INTERACTION_ACTION_PREFIX}:`)) {
    return handleSlackInteractionRequestAction({ env, db, ctx, payload, rawActionId });
  }

  return jsonResponse({ ok: true, skipped: true });
}

// ---------------------------------------------------------------------------
// Durable interaction requests (`cycloid:<kind>:<requestId>` action ids)
// ---------------------------------------------------------------------------

type SlackInteractionConsumeOutcome = "consumed" | "denied_authz" | "expired" | "replay";

/**
 * Security log fired on EVERY consume attempt for an `cycloid:` action id
 * (docs/security.md). Metadata only — never `payload_json` contents.
 */
function logInteractionConsumeAttempt(fields: {
  kind: string;
  requestId: string;
  sessionId: string | null;
  businessId: string | null;
  userId: number | null;
  outcome: SlackInteractionConsumeOutcome;
  reason: string;
}): void {
  const entry = {
    action: "slack.interaction.consume_attempt",
    kind: fields.kind,
    requestId: fields.requestId,
    sessionId: fields.sessionId,
    businessId: fields.businessId,
    userId: fields.userId,
    outcome: fields.outcome,
    reason: fields.reason,
  };
  if (fields.outcome === "denied_authz") {
    log.warn(entry, "Slack interaction request consume denied");
  } else {
    log.info(entry, "Slack interaction request consume attempt");
  }
}

interface SlackInteractionHandlerParams {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  payload: Record<string, unknown>;
  request: SlackInteractionRequestRecord;
  actorUserId: number;
}

type SlackInteractionRequestHandler = (params: SlackInteractionHandlerParams) => Promise<Response>;

/**
 * Kind → handler registry. Kinds gain real handlers per spec PR (resume/retry
 * here in PR 1.4, answer_question in PR 2.4, ...). A consumed request whose
 * kind has no registered handler no-ops safely with a structured log, so an
 * early-shipped button can never dispatch an unauthorized side effect. Partial
 * on purpose: absence of a kind means "not wired yet", which the dispatcher
 * handles explicitly.
 *
 * The legacy `stop_session` button (value = raw sessionId, no request row) is
 * deliberately NOT migrated into this registry: its rows would have to be
 * minted on every running-card render — the per-tick narration hot path —
 * which is exactly the row explosion the create-or-reuse pattern exists to
 * avoid. It keeps its own authz block in the webhook entry above.
 */
const slackInteractionRequestHandlers: Partial<Record<SlackInteractionKind, SlackInteractionRequestHandler>> = {
  [SlackInteractionKind.ApprovePlan]: (params) => handleApprovePlanInteraction(params),
  [SlackInteractionKind.ResumeSession]: (params) => handleSessionControlInteraction(params, "resume"),
  [SlackInteractionKind.RetrySession]: (params) => handleSessionControlInteraction(params, "retry"),
};

type ApprovePlanInteractionOutcome =
  | "approved"
  | "stale"
  | "session_not_found"
  | "business_mismatch"
  | "denied_repo_access"
  | "invalid_payload"
  | "conflict"
  | "replacement_published"
  | "replacement_failed";

function logApprovePlanOutcome(
  row: SlackInteractionRequestRecord,
  actorUserId: number,
  revision: number | null,
  outcome: ApprovePlanInteractionOutcome,
): void {
  const entry = {
    action: "slack.interaction.approve_plan",
    kind: row.kind,
    requestId: row.id,
    sessionId: row.sessionId,
    businessId: row.businessId,
    userId: actorUserId,
    revision,
    outcome,
  };
  if (outcome === "business_mismatch" || outcome === "denied_repo_access") {
    log.warn(entry, "Slack plan approval denied");
  } else {
    log.info(entry, "Slack plan approval outcome");
  }
}

async function replaceFailedPlanApproval(
  env: Env,
  row: SlackInteractionRequestRecord,
  actorUserId: number,
  revision: number | null,
): Promise<void> {
  try {
    const replacementId = await replacePlanApprovalInteractionRequest(env, row);
    logApprovePlanOutcome(row, actorUserId, revision, replacementId ? "replacement_published" : "replacement_failed");
  } catch (error) {
    log.error(
      {
        action: "slack.interaction.approve_plan",
        requestId: row.id,
        sessionId: row.sessionId,
        businessId: row.businessId,
        userId: actorUserId,
        revision,
        outcome: "replacement_failed",
        error: String(error),
      },
      "Slack plan approval replacement failed",
    );
  }
}

async function runApprovePlanInteraction(params: SlackInteractionHandlerParams): Promise<void> {
  const { env, db, request: row, actorUserId } = params;
  const parsed = parsePlanApprovalInteractionPayload(row.payloadJson);
  if (!parsed) {
    logApprovePlanOutcome(row, actorUserId, null, "invalid_payload");
    await updatePlanApprovalInteractionMessage(env, row, "unavailable");
    return;
  }

  const state = await getSessionState(env, row.sessionId);
  if (!state) {
    logApprovePlanOutcome(row, actorUserId, parsed.revision, "session_not_found");
    await updatePlanApprovalInteractionMessage(env, row, "unavailable");
    return;
  }
  const session = state as typeof state & Partial<SessionDOResponse>;
  if (!planApprovalRequestMatchesBusiness(row, session.businessId)) {
    logApprovePlanOutcome(row, actorUserId, parsed.revision, "business_mismatch");
    await updatePlanApprovalInteractionMessage(env, row, "unavailable");
    return;
  }

  const repoOwner = typeof session.repoOwner === "string" && session.repoOwner.length > 0 ? session.repoOwner : null;
  const repoName = typeof session.repoName === "string" && session.repoName.length > 0 ? session.repoName : null;
  if (!repoOwner || !repoName) {
    logApprovePlanOutcome(row, actorUserId, parsed.revision, "denied_repo_access");
    await updatePlanApprovalInteractionMessage(env, row, "unavailable");
    return;
  }
  const gate = await verifyRepoAccessAndInstallation(
    db,
    { userId: String(actorUserId), canAccessAllSessions: false, businessRole: null },
    repoOwner,
    repoName,
    { githubTokenEnv: env, sessionId: row.sessionId, reposCacheEnv: env },
  );
  if (!gate.ok) {
    if (gate.reason === "access_unverifiable") {
      await replaceFailedPlanApproval(env, row, actorUserId, parsed.revision);
      return;
    }
    logApprovePlanOutcome(row, actorUserId, parsed.revision, "denied_repo_access");
    await updatePlanApprovalInteractionMessage(env, row, "unavailable");
    return;
  }

  const actorId = String(actorUserId);
  const result = await approveSessionPlan(
    env,
    row.sessionId,
    null,
    {
      userId: actorId,
      canAccessAllSessions: false,
      businessId: row.businessId,
      sharedSessions: true,
      repoAccessVerifiedSessionId: row.sessionId,
      repoAccessVerifiedRepoOwner: repoOwner,
      repoAccessVerifiedRepoName: repoName,
    },
    { revision: parsed.revision, actorUserId: actorId, source: "slack" },
  );
  if (result.ok && result.payload) {
    logApprovePlanOutcome(row, actorUserId, parsed.revision, "approved");
    await updatePlanApprovalInteractionMessage(env, row, "approved");
    return;
  }
  if (result.error === "stale_revision") {
    logApprovePlanOutcome(row, actorUserId, parsed.revision, "stale");
    await updatePlanApprovalInteractionMessage(env, row, "stale");
    return;
  }
  if (result.status === 429 || result.status >= 500) {
    await replaceFailedPlanApproval(env, row, actorUserId, parsed.revision);
    return;
  }
  logApprovePlanOutcome(row, actorUserId, parsed.revision, "conflict");
  await updatePlanApprovalInteractionMessage(env, row, "unavailable");
}

function handleApprovePlanInteraction(params: SlackInteractionHandlerParams): Promise<Response> {
  const work = runApprovePlanInteraction(params).catch(async (error) => {
    const revision = parsePlanApprovalInteractionPayload(params.request.payloadJson)?.revision ?? null;
    log.error(
      {
        action: "slack.interaction.approve_plan",
        requestId: params.request.id,
        sessionId: params.request.sessionId,
        businessId: params.request.businessId,
        userId: params.actorUserId,
        revision,
        outcome: "approval_failed",
        error: String(error),
      },
      "Slack plan approval background work failed",
    );
    await replaceFailedPlanApproval(params.env, params.request, params.actorUserId, revision);
  });
  if (params.ctx) {
    params.ctx.waitUntil(work);
  } else {
    // Production webhook dispatch always supplies ExecutionContext. Keep the
    // ack-first contract in direct/test callers while making the missing
    // durability hook visible in logs.
    log.error(
      { action: "slack.interaction.approve_plan", requestId: params.request.id, outcome: "missing_wait_until" },
      "Slack plan approval could not register durable background work",
    );
    void work;
  }
  return Promise.resolve(jsonResponse({ ok: true, handled: true, kind: params.request.kind, outcome: "scheduled" }));
}

type SessionControlAction = "resume" | "retry";

type SessionControlHandlerOutcome =
  | "executed"
  | "session_not_found"
  | "business_mismatch"
  | "rate_limited"
  | "denied_repo_access"
  | "stale_phase"
  | "service_failed";

/** Metadata-only handler-outcome log (docs/security.md); never payload contents. */
function logSessionControlOutcome(fields: {
  action: SessionControlAction;
  request: SlackInteractionRequestRecord;
  userId: number;
  outcome: SessionControlHandlerOutcome;
}): void {
  const entry = {
    action: "slack.interaction.session_control",
    controlAction: fields.action,
    kind: fields.request.kind,
    requestId: fields.request.id,
    sessionId: fields.request.sessionId,
    businessId: fields.request.businessId,
    userId: fields.userId,
    outcome: fields.outcome,
  };
  if (fields.outcome === "denied_repo_access" || fields.outcome === "business_mismatch") {
    log.warn(entry, "Slack session-control interaction denied");
  } else {
    log.info(entry, "Slack session-control interaction outcome");
  }
}

/**
 * Resume/Retry card-button handler. Runs AFTER the dispatcher's consume +
 * business-membership authz; this layer adds what the dispatcher cannot prove:
 * repo access (the canonical `verifyRepoAccessAndInstallation` gate — business
 * membership alone never authorizes a session action), the resume-family rate
 * limit, and the click-time phase gate. Then it calls the same session SERVICE
 * functions the public routes use (`resumeSession` / `retrySessionPrompt`) —
 * never DAOs or the DO directly.
 *
 * Fail-closed row semantics (documented decision): the one-shot request row is
 * consumed by the dispatcher BEFORE this handler runs, and a denial here does
 * NOT release it. A denied click therefore burns the button until the next
 * phase-change render mints a fresh row. That is the safe direction — a
 * replayable row after a denial would let a rejected actor grind the consume
 * path, and the recovery cost (re-render or use the web UI) is low.
 */
async function handleSessionControlInteraction(
  params: SlackInteractionHandlerParams,
  action: SessionControlAction,
): Promise<Response> {
  const { env, db, ctx, payload, request: row, actorUserId } = params;

  const finish = (outcome: SessionControlHandlerOutcome, ephemeralText: string | null): Response => {
    logSessionControlOutcome({ action, request: row, userId: actorUserId, outcome });
    if (ephemeralText) {
      postSlackInteractionEphemeral({ ctx, payload, text: ephemeralText, operation: "slackSessionControl" });
    }
    return jsonResponse({ ok: true, handled: outcome === "executed", kind: row.kind, outcome });
  };

  const state = await getSessionState(env, row.sessionId);
  if (!state) {
    return finish("session_not_found", "This session no longer exists.");
  }
  // The DO state response carries phase/prUrl beyond the declared SessionState
  // shape (buildSessionDoResponse); sessionId is threaded from the row.
  const session = state as typeof state & Partial<Pick<SessionDOResponse, "phase" | "prUrl">>;

  // Fail closed: the session's business (per the DO, the authority) must match
  // the request row the dispatcher authorized against.
  if (!session.businessId || !businessIdsMatch(session.businessId, row.businessId)) {
    return finish("business_mismatch", null);
  }

  const rateLimit = await checkSessionResumeRateLimit(env, row.sessionId, String(actorUserId));
  if (rateLimit.limited) {
    return finish("rate_limited", "Too many attempts — please wait a moment and try again.");
  }

  // Repo access for the CLICKER. Slack identity binding + business membership
  // (dispatcher) is not repo authority; re-prove against GitHub, fail closed on
  // missing context or an unverifiable gate.
  const repoOwner = typeof session.repoOwner === "string" && session.repoOwner.length > 0 ? session.repoOwner : null;
  const repoName = typeof session.repoName === "string" && session.repoName.length > 0 ? session.repoName : null;
  if (!repoOwner || !repoName) {
    return finish("denied_repo_access", "This session has no repository context; open it in the web app.");
  }
  const gate = await verifyRepoAccessAndInstallation(
    db,
    { userId: String(actorUserId), canAccessAllSessions: false, businessRole: null },
    repoOwner,
    repoName,
    { githubTokenEnv: env, sessionId: row.sessionId, reposCacheEnv: env },
  );
  if (!gate.ok) {
    return finish("denied_repo_access", "You don't have access to this session's repository.");
  }

  // Click-time phase gate (the card may be stale). Refresh the card to the
  // current stage so the dead button disappears.
  const phase = typeof session.phase === "string" ? (session.phase as Phase) : null;
  const eligible = phase !== null && (action === "resume" ? isResumeAvailable(phase) : isRetryAvailable(phase));
  if (!eligible) {
    if (phase) {
      await refreshSessionControlCard(env, db, row, session, slackStatusStageForPhase(phase));
    }
    return finish("stale_phase", "This action no longer applies — the session has moved on.");
  }

  const result =
    action === "resume" ? await resumeSession(env, row.sessionId) : await retrySessionPrompt(env, row.sessionId);
  if (!result.ok) {
    const reason = (result as { reason?: string }).reason;
    return finish(
      "service_failed",
      reason === "retry_in_progress"
        ? "A retry is already in flight for this session."
        : `Couldn't ${action} the session — try again from the session page.`,
    );
  }

  // In-place ack: the card leaves its stopped/failed state immediately; the
  // DO's authoritative phase/narration updates take over from here.
  await refreshSessionControlCard(
    env,
    db,
    row,
    session,
    "running",
    action === "resume" ? "Resuming…" : "Retrying the last prompt…",
  );
  return finish("executed", null);
}

/**
 * Re-render the status card from the worker with control rows reconciled to
 * `stage` (superseding rows the stage no longer supports). Best-effort — an
 * ack/refresh render failure never fails the handled action.
 */
async function refreshSessionControlCard(
  env: Env,
  db: D1Database,
  row: SlackInteractionRequestRecord,
  session: Pick<
    SessionDOResponse,
    "callbackContext" | "createdAt" | "repoOwner" | "repoName" | "verificationState" | "verificationResult"
  > &
    Partial<Pick<SessionDOResponse, "prUrl">>,
  stage: ReturnType<typeof slackStatusStageForPhase>,
  narrationLine?: string,
): Promise<void> {
  try {
    const controlIds =
      stage === "starting"
        ? {}
        : await syncCardControlRequests(db, {
            stage,
            businessId: row.businessId,
            sessionId: row.sessionId,
            slackTeamId: row.slackTeamId,
            slackChannelId: row.slackChannelId,
            messageTs:
              session.callbackContext?.source === "slack" ? (session.callbackContext.statusMessageTs ?? null) : null,
          });
    if (stage === "starting") return;
    await updateSlackStatusCardFromSessionState({
      env,
      log,
      session: {
        sessionId: row.sessionId,
        callbackContext: session.callbackContext,
        createdAt: session.createdAt,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        prUrl: session.prUrl ?? null,
        verificationState: session.verificationState ?? null,
        verificationResult: session.verificationResult ?? null,
      },
      stage,
      narrationLine,
      controlIds,
    });
  } catch (err) {
    log.warn(
      { sessionId: row.sessionId, requestId: row.id, stage, error: String(err) },
      "Slack session-control card refresh failed",
    );
  }
}

export function parseSlackInteractionActionId(
  actionId: string,
): { kind: SlackInteractionKind; requestId: string } | null {
  const parts = actionId.split(":");
  if (parts.length !== 3) return null;
  const [prefix, kind, requestId] = parts;
  if (prefix !== SLACK_INTERACTION_ACTION_PREFIX || requestId.length === 0) return null;
  if (!isSlackInteractionKind(kind)) return null;
  return { kind, requestId };
}

/**
 * Dispatch a durable interaction-request button click. Order is deliberate:
 * authorize BEFORE consuming so an unauthorized clicker cannot burn the
 * one-shot request, and consume BEFORE routing so a handler can never run
 * twice. The Slack payload contributes only hints (actor id, team id); the
 * stored row is the authority for session/business binding. Fail closed on
 * every unprovable step.
 */
async function handleSlackInteractionRequestAction(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  payload: Record<string, unknown>;
  rawActionId: string;
}): Promise<Response> {
  const { env, db, ctx, payload, rawActionId } = params;

  const parsed = parseSlackInteractionActionId(rawActionId);
  if (!parsed) {
    // Malformed or unknown-kind action id under our prefix: safe no-op. The
    // segment count/length is logged instead of the raw id so a hostile value
    // never lands in logs verbatim.
    log.warn(
      {
        action: "slack.interaction.invalid_action_id",
        segments: rawActionId.split(":").length,
        length: rawActionId.length,
      },
      "Slack interaction action id rejected: malformed or unknown kind",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "invalid_action_id" });
  }
  const { kind, requestId } = parsed;

  const row = await getInteractionRequest(db, requestId);
  if (!row) {
    // Unknown id: either a forged request id or a click on a button whose row
    // was pruned long after handling. Both are safe to treat as already
    // handled — nothing consumable exists.
    logInteractionConsumeAttempt({
      kind,
      requestId,
      sessionId: null,
      businessId: null,
      userId: null,
      outcome: "replay",
      reason: "request_not_found",
    });
    postSlackInteractionEphemeral({
      ctx,
      payload,
      text: "Already handled.",
      operation: "slackInteractionAlreadyHandled",
    });
    return jsonResponse({ ok: true, skipped: true, reason: "request_not_found" });
  }

  const deny = (reason: string, userId: number | null = null): Response => {
    logInteractionConsumeAttempt({
      kind,
      requestId,
      sessionId: row.sessionId,
      businessId: row.businessId,
      userId,
      outcome: "denied_authz",
      reason,
    });
    return jsonResponse({ ok: true, skipped: true, reason: "actor_not_authorized" });
  };

  // The action id's kind and the stored row's kind must agree; a mismatch
  // means a crafted id is pointing at someone else's request row.
  if (row.kind !== kind) {
    return deny("kind_mismatch");
  }

  const actorSlackUserId =
    payload?.user && typeof payload.user === "object" ? (payload.user as { id?: unknown }).id : null;
  if (typeof actorSlackUserId !== "string" || actorSlackUserId.length === 0) {
    return deny("missing_actor");
  }

  const teamId = getSlackTeamIdFromInteractionPayload(payload);
  if (!teamId) {
    return deny("missing_team_id");
  }
  // The click must originate in the workspace the request was posted to. Slack
  // user ids are workspace-scoped, so a same-id user in another workspace must
  // never reach the team-scoped lookup with this row's team.
  if (teamId !== row.slackTeamId) {
    return deny("team_mismatch");
  }

  const actor = await getUserBySlackIdForTeam(db, actorSlackUserId, teamId);
  if (!actor) {
    return deny("unknown_actor");
  }

  const actorBusinessId = await getUserBusinessIdOrNull(db, actor.id);
  if (!actorBusinessId || !businessIdsMatch(actorBusinessId, row.businessId)) {
    return deny("business_mismatch", actor.id);
  }

  const now = Date.now();
  const consumed = await consumeInteractionRequest(db, requestId, String(actor.id), now);
  if (!consumed) {
    // Zero rows changed: the request was already consumed/superseded (replay)
    // or sat past its expiry. Re-read to classify; a row deleted in between
    // classifies as replay.
    const fresh = await getInteractionRequest(db, requestId);
    const isExpired =
      fresh !== null &&
      (fresh.status === "expired" ||
        (fresh.status === "pending" && fresh.expiresAt !== null && fresh.expiresAt <= now));
    // Superseded = the card moved on (a newer render replaced this button's
    // row); distinct copy from a double-click replay.
    const isSuperseded = fresh?.status === "superseded";
    logInteractionConsumeAttempt({
      kind,
      requestId,
      sessionId: row.sessionId,
      businessId: row.businessId,
      userId: actor.id,
      outcome: isExpired ? "expired" : "replay",
      reason: fresh ? `status_${fresh.status}` : "request_deleted",
    });
    postSlackInteractionEphemeral({
      ctx,
      payload,
      text: isExpired
        ? "This request has expired."
        : isSuperseded
          ? "This action is no longer available — the session has moved on."
          : "Already handled.",
      operation: "slackInteractionAlreadyHandled",
    });
    return jsonResponse({ ok: true, skipped: true, reason: isExpired ? "expired" : "already_handled" });
  }

  logInteractionConsumeAttempt({
    kind,
    requestId,
    sessionId: row.sessionId,
    businessId: row.businessId,
    userId: actor.id,
    outcome: "consumed",
    reason: "consumed",
  });

  const handler = slackInteractionRequestHandlers[kind];
  if (!handler) {
    log.info(
      {
        action: "slack.interaction.handler_unwired",
        kind,
        requestId,
        sessionId: row.sessionId,
        businessId: row.businessId,
        userId: actor.id,
      },
      "Slack interaction request consumed with no wired handler (placeholder no-op)",
    );
    return jsonResponse({ ok: true, consumed: true, handled: false, kind });
  }

  return handler({ env, db, ctx, payload, request: row, actorUserId: actor.id });
}
