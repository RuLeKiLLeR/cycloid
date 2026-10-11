import { resolvePublicAppBaseUrl } from "../services/public-url";
import * as doDb from "../session/do-db.js";
import type { Env, SessionDOResponse } from "../types";
import { buildStatusBlocks, buildStatusFallbackText, type SlackStatusBlocksInput } from "./blocks";
import { type CardControlRequestIds, syncCardControlRequests } from "./card-control-requests";
import { updateMessage } from "./notify";
import { buildAuthoritativeStatusInput } from "./status-card";
import { resolveSlackBotTokenForCallback } from "./tokens";

type PhaseUpdateLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

/**
 * Every card stage except the pre-session `starting` value (the starting card
 * is posted by the webhook before any phase exists; nothing edits INTO it).
 */
type SlackPhaseUpdateStage = Exclude<SlackStatusBlocksInput["stage"], "starting">;

/**
 * Edits the durable Slack status card in place when the session moves into a
 * new lifecycle stage. Phase updates are best-effort and update-only: when
 * there is no stored statusMessageTs or the edit fails, we skip rather than
 * post a new thread reply (terminal done/failed delivery owns the fallback).
 */
export async function updateSlackStatusStageInPlace(opts: {
  sql: SqlStorage;
  env: Env;
  log: PhaseUpdateLogger;
  sessionId: string;
  stage: SlackPhaseUpdateStage;
  /** Live-activity line for running cards (narration ticks rebuild the card). */
  narrationLine?: string;
  /**
   * Reconcile the Resume/Retry interaction-request rows for this stage and
   * bind the card buttons to them. Phase-change renders pass true (once per
   * transition, deduped by the DO); per-tick narration renders pass false so
   * the hot path never touches D1.
   */
  manageControls?: boolean;
}): Promise<boolean> {
  const { sql, env, log, sessionId, stage, narrationLine, manageControls } = opts;

  const ext = doDb.getSessionExtended(sql, sessionId);
  const callbackContext = ext?.callbackContext;
  if (!callbackContext || callbackContext.source !== "slack") return false;

  const statusMessageTs = callbackContext.statusMessageTs;
  if (!statusMessageTs) {
    log.info({ sessionId, stage }, "Slack phase update skipped: no status message ts");
    return false;
  }

  const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
    sessionId,
    operation: "updateSlackStatusStageInPlace",
  });
  if (!token) {
    log.info({ sessionId, stage, slackTeamId: callbackContext.slackTeamId }, "Slack phase update skipped: no token");
    return false;
  }

  let controlIds: CardControlRequestIds = {};
  if (manageControls && env.DB) {
    const businessId = doDb.getSession(sql, sessionId)?.businessId;
    if (businessId) {
      controlIds = await syncCardControlRequests(env.DB, {
        stage,
        businessId,
        sessionId,
        slackTeamId: callbackContext.slackTeamId,
        slackChannelId: callbackContext.channel,
        messageTs: statusMessageTs,
      });
    }
  }

  const statusInput = buildAuthoritativeStatusInput(sql, env, sessionId, {
    stage,
    statusOnly: true,
    narrationLine,
    resumeRequestId: controlIds.resumeRequestId,
    retryRequestId: controlIds.retryRequestId,
    ext,
  });

  const result = await updateMessage(
    token,
    callbackContext.channel,
    statusMessageTs,
    buildStatusFallbackText(statusInput),
    buildStatusBlocks(statusInput),
  );
  if (!result.ok) {
    log.warn(
      { sessionId, stage, channel: callbackContext.channel, statusMessageTs, slackError: result.error },
      "Slack phase update failed",
    );
    return false;
  }

  log.info({ sessionId, stage, channel: callbackContext.channel, statusMessageTs }, "Slack phase update sent");
  return true;
}

/**
 * Worker-side sibling of `updateSlackStatusStageInPlace` for callers that hold
 * a SessionDO state response instead of the DO's SqlStorage (e.g. the Slack
 * interactions webhook acking a Resume/Retry click). Same contract: best-effort,
 * update-only, silent-skip without a status anchor. `prNumber` is not on the DO
 * state response, so the PR link renders without a number — acceptable for an
 * ack render the DO's next authoritative update replaces.
 */
export async function updateSlackStatusCardFromSessionState(opts: {
  env: Env;
  log: PhaseUpdateLogger;
  session: Pick<
    SessionDOResponse,
    "callbackContext" | "createdAt" | "repoOwner" | "repoName" | "prUrl" | "verificationState" | "verificationResult"
  > & { sessionId: string };
  stage: SlackPhaseUpdateStage;
  narrationLine?: string;
  controlIds?: CardControlRequestIds;
}): Promise<boolean> {
  const { env, log, session, stage, narrationLine, controlIds } = opts;
  const sessionId = session.sessionId;

  const callbackContext = session.callbackContext;
  if (!callbackContext || callbackContext.source !== "slack") return false;
  const statusMessageTs = callbackContext.statusMessageTs;
  if (!statusMessageTs) {
    log.info({ sessionId, stage }, "Slack card update skipped: no status message ts");
    return false;
  }

  const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
    sessionId,
    operation: "updateSlackStatusCardFromSessionState",
  });
  if (!token) {
    log.info({ sessionId, stage, slackTeamId: callbackContext.slackTeamId }, "Slack card update skipped: no token");
    return false;
  }

  const repoOwner = session.repoOwner ?? undefined;
  const repoName = session.repoName ?? undefined;
  const statusInput: SlackStatusBlocksInput = {
    stage,
    sessionId,
    frontendUrl: resolvePublicAppBaseUrl(env),
    repoFullName: repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined,
    prUrl: session.prUrl ?? undefined,
    statusOnly: true,
    narrationLine,
    verificationState: session.verificationState ?? null,
    verificationResult: session.verificationResult ?? null,
    resumeRequestId: controlIds?.resumeRequestId,
    retryRequestId: controlIds?.retryRequestId,
  };

  const result = await updateMessage(
    token,
    callbackContext.channel,
    statusMessageTs,
    buildStatusFallbackText(statusInput),
    buildStatusBlocks(statusInput),
  );
  if (!result.ok) {
    log.warn(
      { sessionId, stage, channel: callbackContext.channel, statusMessageTs, slackError: result.error },
      "Slack card update failed",
    );
    return false;
  }
  return true;
}
