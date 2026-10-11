import { SLACK_RESUME_CONTROL_STAGES, SLACK_RETRY_CONTROL_STAGES } from "../constants/slack-card-controls";
import { SlackInteractionKind } from "../enums/slack-interaction";
import { createLogger } from "../logger";
import type { SlackStatusStage } from "./blocks";
import { getNewestPending, insertInteractionRequest, supersedePending } from "./interaction-requests-db";

const log = createLogger({ bindings: { component: "slack-card-control-requests" } });

export interface CardControlRequestIds {
  resumeRequestId?: string;
  retryRequestId?: string;
}

/**
 * Reconcile the durable `slack_interaction_requests` rows behind the status
 * card's Resume/Retry buttons with the stage being rendered.
 *
 * Create-or-reuse: cards re-render many times in place (phase flips, DO
 * restarts, terminal delivery + phase wiring double-render), so a render NEVER
 * unconditionally inserts — the newest pending row for `(session, kind)` is
 * reused and a fresh row is minted only when none is pending. Rows carry no
 * expiry: the dispatcher + service phase gates reject stale clicks, and rows
 * are superseded here the moment the stage makes them inapplicable.
 *
 * Best-effort by contract: card rendering must never fail on a D1 hiccup, so
 * errors degrade to "no button" (empty ids) with a warn log.
 */
export async function syncCardControlRequests(
  db: D1Database,
  params: {
    stage: SlackStatusStage;
    businessId: string;
    sessionId: string;
    slackTeamId: string;
    slackChannelId: string;
    /** The status card's message ts (the message the buttons live on), when known. */
    messageTs: string | null;
    now?: number;
  },
): Promise<CardControlRequestIds> {
  const now = params.now ?? Date.now();
  try {
    const [resumeRequestId, retryRequestId] = await Promise.all([
      reconcileKind(db, SlackInteractionKind.ResumeSession, SLACK_RESUME_CONTROL_STAGES.has(params.stage), params, now),
      reconcileKind(db, SlackInteractionKind.RetrySession, SLACK_RETRY_CONTROL_STAGES.has(params.stage), params, now),
    ]);
    return {
      ...(resumeRequestId ? { resumeRequestId } : {}),
      ...(retryRequestId ? { retryRequestId } : {}),
    };
  } catch (err) {
    log.warn(
      { sessionId: params.sessionId, stage: params.stage, error: String(err) },
      "Slack card control request sync failed; rendering card without control buttons",
    );
    return {};
  }
}

async function reconcileKind(
  db: D1Database,
  kind: SlackInteractionKind,
  applicable: boolean,
  params: {
    businessId: string;
    sessionId: string;
    slackTeamId: string;
    slackChannelId: string;
    messageTs: string | null;
  },
  now: number,
): Promise<string | null> {
  if (!applicable) {
    await supersedePending(db, params.sessionId, kind, now);
    return null;
  }
  const pending = await getNewestPending(db, params.sessionId, kind, now);
  if (pending) return pending.id;
  return insertInteractionRequest(db, {
    businessId: params.businessId,
    sessionId: params.sessionId,
    kind,
    payloadJson: "{}",
    slackTeamId: params.slackTeamId,
    slackChannelId: params.slackChannelId,
    messageTs: params.messageTs,
    expiresAt: null,
    now,
  });
}
