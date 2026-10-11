import * as Sentry from "@sentry/cloudflare";

import type { PublishStatus } from "../../../../shared/types/publish.js";
import type { PrReadinessEvidence } from "../../../../shared/types/sandbox.js";
import { PR_READINESS_STORAGE_KEY } from "../constants/sessions";
import { InitiationMode } from "../enums/initiation-mode.js";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import {
  buildPrClosedBlocks,
  buildPrMergedBlocks,
  buildPrOpenedCard,
  buildStatusBlocks,
  buildStatusFallbackText,
} from "../slack/blocks";
import { deliverThreadStatus } from "../slack/notify";
import { buildAuthoritativeStatusInput } from "../slack/status-card";
import { postSessionThreadMessage } from "../slack/thread-budget";
import { resolveSlackBotTokenForCallback } from "../slack/tokens";
import type { CallbackContext, Env } from "../types";
import { nowIso } from "../utils";
import * as doDb from "./do-db.js";
import type { DurableEntry } from "./events";
import { publishSessionFeedDelta } from "./feed-delta";
import {
  claimSlackPostForDelivery,
  claimSlackPrMergedPost,
  deleteSlackPostMarker,
  deleteSlackPrMergedPostMarker,
  markSlackPostDelivered,
} from "./slack-posts-db";

type SlackCallbackContext = Extract<CallbackContext, { source: "slack" }>;

export type PrEventOptions = {
  draft?: boolean;
  manualReviewReason?: string;
};

/** Provenance fields stamped onto publish lifecycle logs. */
export function readPublishProvenanceTags(
  sql: SqlStorage,
  sessionId: string,
): { initiation_mode: InitiationMode; scheduled_rule_id: string | null } {
  const ext = doDb.getSessionExtended(sql, sessionId);
  return {
    initiation_mode: ext?.initiationMode ?? InitiationMode.USER,
    scheduled_rule_id: ext?.scheduledRuleId ?? null,
  };
}

type PrWorkflowNotificationHost = {
  readonly env: Env;
  // SessionDO state; used for the replay-stable blocked-DM idempotency flag.
  readonly state: DurableObjectState;
  readonly log: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
  broadcast(message: Record<string, unknown>): void;
  appendAndMirrorEvents(sessionId: string, entries: DurableEntry[], promptId?: string): Promise<unknown>;
};

export class PrWorkflowNotifications {
  constructor(
    private readonly sql: SqlStorage,
    private readonly host: PrWorkflowNotificationHost,
  ) {}

  notifyPrCreatedFireAndForget(sessionId: string): void {
    this.notifySlackPrCreated(sessionId).catch((err) => {
      this.host.log.error({ sessionId, error: String(err) }, "Slack PR notification error");
      Sentry.captureException(err, { tags: { sessionId, operation: "notifySlackPrCreated" } });
    });
  }

  /**
   * Scheduled automations deliver a single plain top-level digest and (in
   * practice) never open PRs. A PR-created/merged card would post as an extra
   * top-level message, defeating the single-message contract — so suppress
   * PR-workflow notices for them. Slack-alert automations (no scheduledRuleId)
   * keep their PR notices.
   */
  private isScheduledAutomation(sessionId: string): boolean {
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    return ext?.initiationMode === InitiationMode.AUTOMATION && Boolean(ext?.scheduledRuleId);
  }

  async notifySlackPrMerged(sessionId: string, prUrl: string): Promise<boolean> {
    if (this.isScheduledAutomation(sessionId)) {
      this.host.log.info({ sessionId }, "Slack PR-merged notification skipped: scheduled automation");
      return false;
    }
    const callbackContext = this.getSlackCallbackContext(sessionId);
    if (!callbackContext) {
      this.host.log.info({ sessionId }, "Slack PR-merged notification skipped: no callback context");
      return false;
    }

    // Track whether THIS call holds the (session_id, pr_url) claim so the catch
    // releases only our own claim, never a marker left by a prior successful post.
    let claimedHere = false;
    try {
      const token = await resolveSlackBotTokenForCallback(this.host.env, callbackContext, {
        sessionId,
        operation: "notifySlackPrMerged",
      });
      if (!token) {
        this.host.log.info(
          {
            sessionId,
            source: callbackContext.source,
            slackTeamId: callbackContext.source === "slack" ? callbackContext.slackTeamId : undefined,
          },
          "Slack PR-merged notification skipped: no bot token",
        );
        return false;
      }

      // Claim before posting: PR-merge has three unreconciled triggers (webhook,
      // review-loop sweep, self-redelivery) and no per-prompt key, so dedupe on
      // (session_id, pr_url). Skip when the claim was already taken.
      const claimed = await claimSlackPrMergedPost(this.host.env.DB, {
        sessionId,
        prUrl,
        channel: callbackContext.channel,
      });
      if (!claimed) {
        this.host.log.info(
          { event: "slack_pr_merged_skipped_duplicate", sessionId, prUrl },
          "Slack PR-merged notification skipped: already posted",
        );
        return false;
      }
      claimedHere = true;

      const blocks = buildPrMergedBlocks();
      const fallback = `PR merged: ${prUrl}`;
      const threadTs = callbackContext.source === "slack" ? callbackContext.threadTs : undefined;
      const result = await postSessionThreadMessage({
        token,
        channel: callbackContext.channel,
        threadTs,
        kind: "result",
        text: fallback,
        blocks,
        sessionId,
        promptId: prUrl,
        anchors: callbackContext,
        persistAnchors: (patch) => {
          doDb.patchSessionCallbackContext(this.sql, sessionId, patch);
        },
      });
      if (!result.ok) {
        // Release the claim so a later merge trigger can re-post; one transient
        // Slack failure must not permanently suppress the PR-merged notice.
        await deleteSlackPrMergedPostMarker(this.host.env.DB, { sessionId, prUrl });
        await reportSlackPostFailure(this.host.env, {
          operation: "notifySlackPrMerged",
          sessionId,
          slackErrorCode: result.error,
        });
        this.host.log.error(
          { sessionId, channel: callbackContext.channel, threadTs, prUrl, slackError: result.error },
          "Slack PR-merged notification failed",
        );
      } else {
        this.host.log.info(
          { sessionId, channel: callbackContext.channel, threadTs, prUrl },
          "Slack PR-merged notification sent",
        );
      }
      return result.ok;
    } catch (err) {
      // A throw after we claimed leaves a pending marker that would suppress
      // every future merge notice for this PR; release our own claim.
      if (claimedHere) {
        await deleteSlackPrMergedPostMarker(this.host.env.DB, { sessionId, prUrl }).catch(() => {});
      }
      this.host.log.error({ sessionId, prUrl, error: String(err) }, "Slack PR-merged notification error");
      return false;
    }
  }

  /**
   * Post the "session archived because its PR was closed" notice, naming who
   * closed it. Fired only from the pr-closed webhook and only on the delivery
   * that actually transitioned the session to archived (github.ts gates on the
   * close result), so it posts at most once — no separate claim table needed.
   * Best-effort: a failed post is logged, not retried.
   */
  async notifySlackPrClosed(sessionId: string, prUrl: string, closedByLogin: string | null): Promise<boolean> {
    if (this.isScheduledAutomation(sessionId)) {
      this.host.log.info({ sessionId }, "Slack PR-closed notification skipped: scheduled automation");
      return false;
    }
    const callbackContext = this.getSlackCallbackContext(sessionId);
    if (!callbackContext) {
      this.host.log.info({ sessionId }, "Slack PR-closed notification skipped: no callback context");
      return false;
    }

    try {
      const token = await resolveSlackBotTokenForCallback(this.host.env, callbackContext, {
        sessionId,
        operation: "notifySlackPrClosed",
      });
      if (!token) {
        this.host.log.info(
          {
            sessionId,
            source: callbackContext.source,
            slackTeamId: callbackContext.source === "slack" ? callbackContext.slackTeamId : undefined,
          },
          "Slack PR-closed notification skipped: no bot token",
        );
        return false;
      }

      const blocks = buildPrClosedBlocks(prUrl, closedByLogin);
      const fallback = `Session archived: PR ${prUrl} was closed by ${closedByLogin ?? "someone"}.`;
      const threadTs = callbackContext.source === "slack" ? callbackContext.threadTs : undefined;
      const result = await postSessionThreadMessage({
        token,
        channel: callbackContext.channel,
        threadTs,
        kind: "result",
        text: fallback,
        blocks,
        sessionId,
        promptId: prUrl,
        anchors: callbackContext,
        persistAnchors: (patch) => {
          doDb.patchSessionCallbackContext(this.sql, sessionId, patch);
        },
      });
      if (!result.ok) {
        await reportSlackPostFailure(this.host.env, {
          operation: "notifySlackPrClosed",
          sessionId,
          slackErrorCode: result.error,
        });
        this.host.log.error(
          { sessionId, channel: callbackContext.channel, threadTs, prUrl, slackError: result.error },
          "Slack PR-closed notification failed",
        );
      } else {
        this.host.log.info(
          { sessionId, channel: callbackContext.channel, threadTs, prUrl, closedByLogin },
          "Slack PR-closed notification sent",
        );
      }
      return result.ok;
    } catch (err) {
      this.host.log.error({ sessionId, prUrl, error: String(err) }, "Slack PR-closed notification error");
      return false;
    }
  }

  private async notifySlackPrCreated(sessionId: string): Promise<void> {
    if (this.isScheduledAutomation(sessionId)) return;
    const callbackContext = this.getSlackCallbackContext(sessionId);
    if (!callbackContext) return;

    let claimedPrOpenedPromptId: string | null = null;
    try {
      const token = await resolveSlackBotTokenForCallback(this.host.env, callbackContext, {
        sessionId,
        operation: "notifySlackPrCreated",
      });
      if (!token) {
        this.host.log.info(
          {
            sessionId,
            source: callbackContext.source,
            slackTeamId: callbackContext.source === "slack" ? callbackContext.slackTeamId : undefined,
          },
          "Slack PR-created notification skipped: no bot token",
        );
        return;
      }

      const threadTs = callbackContext.source === "slack" ? callbackContext.threadTs : undefined;
      const statusMessageTs = callbackContext.source === "slack" ? callbackContext.statusMessageTs : undefined;
      const ext = doDb.getSessionExtended(this.sql, sessionId);
      const readiness = (await this.host.state.storage.get<PrReadinessEvidence>(PR_READINESS_STORAGE_KEY)) ?? undefined;
      const repoFullName = ext?.repoOwner && ext?.repoName ? `${ext.repoOwner}/${ext.repoName}` : undefined;
      const prOpenedUrl = ext?.prUrl ?? null;
      const prOpenedPromptId = prOpenedUrl ? `pr:${prOpenedUrl}` : null;
      const prOpenedCard =
        prOpenedUrl && ext?.prNumber
          ? buildPrOpenedCard({
              sessionId,
              frontendUrl: resolvePublicAppBaseUrl(this.host.env),
              repoFullName,
              prUrl: prOpenedUrl,
              prNumber: ext.prNumber,
              prTitle: ext.prTitleLastApplied ?? ext.title,
              branchName: ext.publishedBranch ?? ext.lastBranch,
              diffStats: readiness?.diffStats,
              checksState: "pending",
            })
          : null;
      const statusInput = buildAuthoritativeStatusInput(this.sql, this.host.env, sessionId, { stage: "running" });
      const result = await deliverThreadStatus({
        token,
        channel: callbackContext.channel,
        threadTs,
        statusMessageTs,
        text: buildStatusFallbackText(statusInput),
        blocks: buildStatusBlocks(statusInput),
      });
      if (callbackContext.source === "slack" && result.fallbackTs) {
        doDb.patchSessionCallbackContext(this.sql, sessionId, { statusMessageTs: result.fallbackTs });
      }
      if (!result.ok) {
        await reportSlackPostFailure(this.host.env, {
          operation: "notifySlackPrCreated",
          sessionId,
          slackErrorCode: result.error,
        });
        this.host.log.error({ sessionId, slackError: result.error }, "Slack PR notification failed");
      } else if (!result.updatedInPlace && statusMessageTs) {
        if (result.error) {
          await reportSlackPostFailure(this.host.env, {
            operation: "notifySlackPrCreated",
            sessionId,
            reason: "status_update_fallback",
            slackErrorCode: result.error,
          });
        }
        this.host.log.warn(
          { sessionId, statusMessageTs, slackError: result.error },
          "Slack PR status update failed; delivered as a new thread reply",
        );
      }
      if (prOpenedCard && prOpenedPromptId) {
        const claimed = await claimSlackPostForDelivery(this.host.env.DB, {
          sessionId,
          promptId: prOpenedPromptId,
          stage: "pr_opened",
          channel: callbackContext.channel,
        });
        if (!claimed) {
          this.host.log.info({ sessionId, prUrl: prOpenedUrl }, "Slack PR-opened notification skipped: duplicate");
          return;
        }
        claimedPrOpenedPromptId = prOpenedPromptId;
        const postResult = await postSessionThreadMessage({
          token,
          channel: callbackContext.channel,
          threadTs,
          kind: "expansion",
          text: prOpenedCard.text,
          blocks: prOpenedCard.blocks,
          attachments: prOpenedCard.attachments,
          sessionId,
          anchors: callbackContext,
          persistAnchors: (patch) => {
            doDb.patchSessionCallbackContext(this.sql, sessionId, patch);
          },
        });
        if (!postResult.ok || !postResult.ts) {
          await deleteSlackPostMarker(this.host.env.DB, {
            sessionId,
            promptId: prOpenedPromptId,
            stage: "pr_opened",
          });
          await reportSlackPostFailure(this.host.env, {
            operation: "notifySlackPrCreated.pr_opened",
            sessionId,
            slackErrorCode: postResult.error,
            ...(postResult.ts ? {} : { reason: "missing_message_ts" }),
          });
          this.host.log.error(
            { sessionId, channel: callbackContext.channel, threadTs, prUrl: prOpenedUrl, slackError: postResult.error },
            "Slack PR-opened notification failed",
          );
          return;
        }
        await markSlackPostDelivered(this.host.env.DB, {
          sessionId,
          promptId: prOpenedPromptId,
          stage: "pr_opened",
          messageTs: postResult.ts,
        });
      }
    } catch (err) {
      if (claimedPrOpenedPromptId) {
        await deleteSlackPostMarker(this.host.env.DB, {
          sessionId,
          promptId: claimedPrOpenedPromptId,
          stage: "pr_opened",
        }).catch(() => {});
      }
      this.host.log.error({ sessionId, error: String(err) }, "Slack PR notification error");
    }
  }

  // -------------------------------------------------------------------------
  // Publish lifecycle session events (broadcast + durable entries)
  // -------------------------------------------------------------------------

  async emitPublishStarted(sessionId: string, branch: string, promptId?: string): Promise<void> {
    const ts = nowIso();
    await this.appendEntries(
      sessionId,
      [
        {
          type: "publish.started",
          timestamp: ts,
          data: { sessionId, ...(promptId ? { promptId } : {}), branchName: branch },
        },
        {
          type: "agent_timeline",
          timestamp: ts,
          data: {
            eventType: "pr.open",
            source: "observed",
            observer: "control_plane",
            status: "started",
            summary: "Opening pull request on GitHub.",
            ...(promptId ? { promptId } : {}),
            metadata: { branchName: branch },
          },
        },
      ],
      promptId,
    );
  }

  async emitPublishPushConfirmed(
    sessionId: string,
    branch: string,
    commitSha: string,
    promptId?: string,
  ): Promise<void> {
    await this.appendEntries(
      sessionId,
      [
        {
          type: "publish.push.confirmed",
          timestamp: nowIso(),
          data: { sessionId, ...(promptId ? { promptId } : {}), branchName: branch, commitSha },
        },
      ],
      promptId,
    );
  }

  async emitPublishPrEvent(
    type: "publish.pr.created" | "publish.pr.updated",
    sessionId: string,
    prUrl: string,
    prNumber: number,
    branchName: string,
    promptId?: string,
    options: PrEventOptions = {},
  ): Promise<void> {
    const legacyType = type === "publish.pr.created" ? "pr_created" : "pr_updated";
    const manualReviewReason = options.manualReviewReason?.trim();
    const summary = type === "publish.pr.created" ? "Opened pull request." : "Updated pull request.";
    // One timestamp for the whole batch so consumers ordering by time see the
    // three entries as a single instant.
    const ts = nowIso();
    this.host.broadcast({
      type: legacyType,
      prUrl,
      prNumber,
      branchName,
      ...(manualReviewReason ? { manualReviewReason } : {}),
    });
    // Surface the new PR link/draft state to the per-business sidebar feed so
    // list rows show the PR badge live (ARC-1322). Blocked publishes carry no PR
    // URL, so the sidebar learns of them via the phase (status) delta instead.
    publishSessionFeedDelta(this.host.env, this.sql, {
      type: "pr",
      sessionId,
      source: type === "publish.pr.created" ? "pr:created" : "pr:updated",
      prUrl,
      ...(options.draft !== undefined ? { prDraft: options.draft } : {}),
      ...(manualReviewReason ? { prManualReviewReason: manualReviewReason } : {}),
    });
    await this.appendEntries(
      sessionId,
      [
        {
          type,
          timestamp: ts,
          data: {
            sessionId,
            ...(promptId ? { promptId } : {}),
            prUrl,
            prNumber,
            branchName,
            ...(manualReviewReason ? { manualReviewReason } : {}),
          },
        },
        {
          type: legacyType,
          timestamp: ts,
          data: {
            sessionId,
            ...(promptId ? { promptId } : {}),
            prUrl,
            prNumber,
            branchName,
            ...(manualReviewReason ? { manualReviewReason } : {}),
          },
        },
        {
          type: "agent_timeline",
          timestamp: ts,
          data: {
            eventType: "pr.open",
            source: "observed",
            observer: "control_plane",
            status: "completed",
            summary,
            ...(promptId ? { promptId } : {}),
            metadata: {
              prUrl,
              prNumber,
              branchName,
              ...(manualReviewReason ? { manualReviewReason } : {}),
            },
          },
        },
      ],
      promptId,
    );
  }

  // Emitter for BENIGN guard blocks (the PR/session moved on — merged/closed,
  // head advanced under us, stale epoch). Neutral outcome: an INFO log (not warn), a `publish.superseded`
  // durable event, and a `pr.open` agent-timeline event with status "completed" + metadata.superseded
  // (the contract the UI renders neutrally). Deliberately NO `pr_failed` broadcast and NO pr_failed entry.
  async emitPublishSuperseded(sessionId: string, reason: string, branchName: string, promptId?: string): Promise<void> {
    const provenance = readPublishProvenanceTags(this.sql, sessionId);
    this.host.log.info(
      { event: "publish_superseded", sessionId, branchName, reason, ...provenance },
      "Review-loop publish superseded — PR/session moved on",
    );
    // NOTE: deliberately NO `pr_failed` broadcast — this is a neutral outcome, not a failure.
    await this.appendEntries(
      sessionId,
      [
        {
          type: "publish.superseded",
          timestamp: nowIso(),
          data: { sessionId, ...(promptId ? { promptId } : {}), reason, branchName },
        },
        {
          type: "agent_timeline",
          timestamp: nowIso(),
          data: {
            eventType: "pr.open",
            source: "observed",
            observer: "control_plane",
            status: "completed",
            summary: "Review loop superseded — PR moved on.",
            ...(promptId ? { promptId } : {}),
            metadata: { superseded: true, reason },
          },
        },
      ],
      promptId,
    );
  }

  async emitPublishCompleted(
    sessionId: string,
    publishStatus: PublishStatus,
    promptId?: string,
    prUrl?: string,
    prNumber?: number,
  ): Promise<void> {
    await this.appendEntries(
      sessionId,
      [
        {
          type: "publish.completed",
          timestamp: nowIso(),
          data: {
            sessionId,
            ...(promptId ? { promptId } : {}),
            publishStatus,
            ...(prUrl ? { prUrl } : {}),
            ...(prNumber ? { prNumber } : {}),
          },
        },
      ],
      promptId,
    );
  }

  private async appendEntries(sessionId: string, entries: DurableEntry[], promptId?: string): Promise<void> {
    if (promptId) {
      await this.host.appendAndMirrorEvents(sessionId, entries, promptId);
      return;
    }
    await this.host.appendAndMirrorEvents(sessionId, entries);
  }

  private getSlackCallbackContext(sessionId: string): SlackCallbackContext | undefined {
    const callbackContext = doDb.getSessionExtended(this.sql, sessionId)?.callbackContext ?? undefined;
    if (!callbackContext || callbackContext.source !== "slack") {
      return undefined;
    }
    return callbackContext;
  }
}
