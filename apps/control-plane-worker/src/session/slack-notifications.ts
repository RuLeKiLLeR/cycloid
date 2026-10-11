import * as Sentry from "@sentry/cloudflare";

import { serializeError } from "../../../../shared/observability/error-utils.js";
import { isErrorCode } from "../../../../shared/types/error-codes.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { recordScheduledRuleDelivery } from "../automation/db";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../constants/verification";
import { InitiationMode } from "../enums/initiation-mode.js";
import type { Logger } from "../logger";
import { emitAutomationSlackDeliveryMetric } from "../observability/automation-metrics";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import { resolvePublicSessionUrl } from "../services/public-url";
import {
  buildPlainDigestBlocks,
  buildPlainDigestFallbackText,
  buildPromptReplyBlocks,
  buildPromptReplyFallbackText,
  buildQuotedReplyContext,
  buildQuotedReplyContextFromSource,
  buildStatusBlocks,
  buildStatusFallbackText,
  extractResponseFromEvents,
} from "../slack/blocks";
import { syncCardControlRequests } from "../slack/card-control-requests";
import { deliverThreadStatus, removeReaction } from "../slack/notify";
import { buildAuthoritativeStatusInput } from "../slack/status-card";
import { postSessionThreadMessage } from "../slack/thread-budget";
import { resolveSlackBotTokenForCallback } from "../slack/tokens";
import type { Env } from "../types";
import * as doDb from "./do-db.js";
import { SLACK_NOTIFICATION_RECOVERY_DELAY_MS } from "./prompt-queue.js";
import {
  claimSlackPostForDelivery,
  deleteSlackPostMarker,
  hasDeliveredSlackPost,
  listDueSlackPostRetries,
  markSlackPostDelivered,
  markSlackPostPendingRetry,
} from "./slack-posts-db";
import {
  parseSlackVerificationBlockerPromptId,
  resolveAttemptCount,
  SLACK_VERIFICATION_BLOCKED_STAGE,
  SLACK_VERIFICATION_BLOCKER_OPERATION,
  slackVerificationBlockerText,
} from "./verification-state.js";

interface SessionSlackNotificationsHost {
  state: DurableObjectState;
  env: Env;
  log: Logger;
  sql: DurableObjectStorage["sql"];
  rescheduleSessionAlarm(): Promise<void>;
}

function promptTimestampMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface SessionSlackNotifications {
  recoverMissingSlackNotifications(sessionId: string): Promise<void>;
  notifySlackVerificationBlocker(sessionId: string, promptId: string): Promise<void>;
  notifySlackSessionArchived(sessionId: string): Promise<void>;
  notifySlackSessionStopped(sessionId: string): Promise<void>;
  notifySlackThread(sessionId: string, promptId: string, success: boolean): Promise<void>;
}

export function createSessionSlackNotifications(host: SessionSlackNotificationsHost): SessionSlackNotifications {
  const notifications: SessionSlackNotifications = {
    async recoverMissingSlackNotifications(sessionId: string): Promise<void> {
      const env = host.env;
      if (!env.DB) return;
      const now = Date.now();
      const dueRows = await listDueSlackPostRetries(env.DB, sessionId, now);
      if (dueRows.length === 0) return;
      const ext = doDb.getSessionExtended(host.sql, sessionId);
      if (ext?.callbackContext?.source !== "slack") return;
      const token = await resolveSlackBotTokenForCallback(env, ext.callbackContext, {
        sessionId,
        operation: "recoverMissingSlackNotifications",
      });
      if (!token) {
        host.log.warn(
          {
            event: "slack_notification_recovery.blocked",
            sessionId,
            slackTeamId: ext.callbackContext.slackTeamId,
            reason: "missing_bot_token",
          },
          "Slack prompt notification recovery stopped because no bot token is available",
        );
        return;
      }

      const sessionPrompts = doDb.getPrompts(host.sql, sessionId);
      let recovered = 0;
      let pending = 0;
      let staleCleared = 0;
      for (const row of dueRows) {
        if (row.stage === "verification_blocked") {
          pending++;
          await notifications.notifySlackVerificationBlocker(sessionId, row.promptId);
          if (
            await hasDeliveredSlackPost(env.DB, {
              sessionId,
              promptId: row.promptId,
              stage: row.stage,
            })
          ) {
            recovered++;
          }
          continue;
        }

        if (row.stage === "session_stopped") {
          pending++;
          await notifications.notifySlackSessionStopped(sessionId);
          if (
            await hasDeliveredSlackPost(env.DB, {
              sessionId,
              promptId: row.promptId,
              stage: row.stage,
            })
          ) {
            recovered++;
          }
          continue;
        }

        const prompt = doDb.getPrompt(host.sql, row.promptId);
        if (!prompt || (prompt.status !== "completed" && prompt.status !== "failed") || prompt.reviewLoopEpochId)
          continue;
        if (row.stage === "failed") {
          const failedPromptCompletedAtMs = promptTimestampMs(prompt.completedAt);
          const staleFailedRetry =
            failedPromptCompletedAtMs !== null &&
            sessionPrompts.some((candidate) => {
              if (
                candidate.promptId === row.promptId ||
                candidate.status !== "completed" ||
                candidate.reviewLoopEpochId
              ) {
                return false;
              }
              const candidateCompletedAtMs = promptTimestampMs(candidate.completedAt);
              return candidateCompletedAtMs !== null && candidateCompletedAtMs > failedPromptCompletedAtMs;
            });
          if (staleFailedRetry) {
            await deleteSlackPostMarker(env.DB, {
              sessionId,
              promptId: row.promptId,
              stage: row.stage,
            });
            host.log.info(
              { event: "slack_notification_recovery.stale_failed_cleared", sessionId, promptId: row.promptId },
              "Cleared stale failed Slack notification retry after a later successful prompt",
            );
            staleCleared++;
            continue;
          }
        }
        pending++;
        const promptEvents = doDb.getEvents(host.sql, sessionId, { promptId: row.promptId });
        await host.state.storage.put(
          `slack_summary:${row.promptId}`,
          extractResponseFromEvents(promptEvents, row.promptId),
        );
        await notifications.notifySlackThread(sessionId, row.promptId, row.stage === "completed");
        if (
          await hasDeliveredSlackPost(env.DB, {
            sessionId,
            promptId: row.promptId,
            stage: row.stage,
          })
        ) {
          recovered++;
        }
      }

      // Stale-cleared rows are removed from the retry queue, so they neither count as a
      // pending delivery nor as a recovery. A row still needs a future alarm only when it
      // was left in the queue this pass (delivery not yet confirmed, or prompt not ready).
      const outstanding = dueRows.length - recovered - staleCleared;
      if (outstanding === 0) {
        host.log.info(
          { event: "slack_notification_recovery.completed", sessionId, recovered, staleCleared },
          "Recovered Slack prompt notifications",
        );
        return;
      }

      await host.rescheduleSessionAlarm();
      host.log.warn(
        { event: "slack_notification_recovery.pending", sessionId, recovered, pending, staleCleared, outstanding },
        "Slack prompt notification recovery still has pending deliveries",
      );
    },

    async notifySlackVerificationBlocker(sessionId: string, promptId: string): Promise<void> {
      const env = host.env;
      const retry = async (reason: string): Promise<void> => {
        const status = await markSlackPostPendingRetry(env.DB, {
          sessionId,
          promptId,
          stage: SLACK_VERIFICATION_BLOCKED_STAGE,
          nextAttemptAt: Date.now() + SLACK_NOTIFICATION_RECOVERY_DELAY_MS,
          error: reason,
        });
        if (status === "exhausted") {
          await reportSlackPostFailure(env, {
            operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
            sessionId,
            stage: SLACK_VERIFICATION_BLOCKED_STAGE,
            reason: "exhausted",
            errorMessage: reason,
          });
          return;
        }
        if (status === "pending") await host.rescheduleSessionAlarm();
      };

      const parsed = parseSlackVerificationBlockerPromptId(promptId);
      if (!parsed) {
        host.log.warn({ sessionId, promptId }, "Slack verification blocker retry skipped: invalid prompt id");
        await retry("invalid_prompt_id");
        return;
      }

      try {
        const slackExt = doDb.getSessionExtended(host.sql, sessionId);
        const callbackContext = slackExt?.callbackContext ?? undefined;
        if (!callbackContext || callbackContext.source !== "slack") return;
        if (!callbackContext.channel || !callbackContext.threadTs) {
          host.log.warn(
            { sessionId, channel: callbackContext.channel, threadTsPresent: Boolean(callbackContext.threadTs) },
            "Slack verification blocker retry skipped: missing thread routing",
          );
          const shouldRetry = await claimSlackPostForDelivery(env.DB, {
            sessionId,
            promptId,
            stage: SLACK_VERIFICATION_BLOCKED_STAGE,
            channel: callbackContext.channel ?? null,
          });
          if (shouldRetry) await retry("missing_thread_routing");
          return;
        }

        const shouldPost = await claimSlackPostForDelivery(env.DB, {
          sessionId,
          promptId,
          stage: SLACK_VERIFICATION_BLOCKED_STAGE,
          channel: callbackContext.channel,
        });
        if (!shouldPost) {
          host.log.info(
            { sessionId, promptId, stage: SLACK_VERIFICATION_BLOCKED_STAGE },
            "Slack verification blocker retry skipped: duplicate stage",
          );
          return;
        }

        const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
          sessionId,
          operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
        });
        if (!token) {
          host.log.info(
            { sessionId, source: callbackContext.source, slackTeamId: callbackContext.slackTeamId },
            "Slack verification blocker retry skipped: no bot token",
          );
          await retry("no_bot_token");
          return;
        }

        const attemptCount = await resolveAttemptCount(env, parsed.prUrl, null, host.log);
        const text = slackVerificationBlockerText({
          state: parsed.state,
          prUrl: parsed.prUrl,
          attemptCount,
          maxAttempts: slackExt?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
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
          persistAnchors: (patch) => {
            doDb.patchSessionCallbackContext(host.sql, sessionId, patch);
          },
        });
        if (!result.ok) {
          await reportSlackPostFailure(env, {
            operation: SLACK_VERIFICATION_BLOCKER_OPERATION,
            sessionId,
            stage: SLACK_VERIFICATION_BLOCKED_STAGE,
            slackErrorCode: result.error,
          });
          await retry("verification_blocked_api_error");
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
          await retry("verification_blocked_missing_ts");
          return;
        }
        await markSlackPostDelivered(env.DB, {
          sessionId,
          promptId,
          stage: SLACK_VERIFICATION_BLOCKED_STAGE,
          messageTs: result.ts,
        });
      } catch (err) {
        host.log.error({ sessionId, promptId, error: serializeError(err) }, "Slack verification blocker retry error");
        await retry("verification_blocked_exception").catch(() => {});
      }
    },

    // Slack thread notification
    // ---------------------------------------------------------------------------

    async notifySlackSessionArchived(sessionId: string): Promise<void> {
      const stage = "session_archived";
      const promptId = "session-archived";

      try {
        const env = host.env;
        const slackExt = doDb.getSessionExtended(host.sql, sessionId);
        const callbackContext = slackExt?.callbackContext ?? undefined;
        if (!callbackContext || callbackContext.source !== "slack") {
          host.log.info({ sessionId }, "Slack session archive notification skipped: no callback context");
          return;
        }
        if (!callbackContext.channel || !callbackContext.threadTs) {
          host.log.warn(
            { sessionId, channel: callbackContext.channel, threadTsPresent: Boolean(callbackContext.threadTs) },
            "Slack session archive notification skipped: missing thread routing",
          );
          return;
        }

        const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
          sessionId,
          operation: "notifySlackSessionArchived",
        });
        if (!token) {
          host.log.info(
            {
              sessionId,
              source: callbackContext.source,
              slackTeamId: callbackContext.slackTeamId,
            },
            "Slack session archive notification skipped: no bot token",
          );
          return;
        }

        const shouldPost = await claimSlackPostForDelivery(env.DB, {
          sessionId,
          promptId,
          stage,
          channel: callbackContext.channel,
        });
        if (!shouldPost) {
          host.log.info({ sessionId, promptId, stage }, "Slack session archive notification skipped: duplicate stage");
          return;
        }

        const sessionUrl = resolvePublicSessionUrl(env, sessionId);
        const text = `📦 Session archived. <${sessionUrl}|View session>`;
        let result: Awaited<ReturnType<typeof postSessionThreadMessage>>;
        try {
          result = await postSessionThreadMessage({
            token,
            channel: callbackContext.channel,
            threadTs: callbackContext.threadTs,
            kind: "expansion",
            text,
            sessionId,
            anchors: callbackContext,
            persistAnchors: (patch) => {
              doDb.patchSessionCallbackContext(host.sql, sessionId, patch);
            },
          });
        } catch (err) {
          host.log.error(
            {
              sessionId,
              channel: callbackContext.channel,
              threadTs: callbackContext.threadTs,
              error: serializeError(err),
            },
            "Slack session archive notification error",
          );
          await reportSlackPostFailure(env, {
            operation: "notifySlackSessionArchived",
            sessionId,
            stage,
            reason: "exception",
            errorMessage: stringifyError(err),
          });
          return;
        }
        if (!result.ok) {
          await reportSlackPostFailure(env, {
            operation: "notifySlackSessionArchived",
            sessionId,
            stage,
            slackErrorCode: result.error,
          });
          host.log.error(
            {
              sessionId,
              channel: callbackContext.channel,
              threadTs: callbackContext.threadTs,
              slackError: result.error,
            },
            "Slack session archive notification failed",
          );
          return;
        }

        await markSlackPostDelivered(env.DB, {
          sessionId,
          promptId,
          stage,
          messageTs: result.ts ?? callbackContext.threadTs,
        });
      } catch (err) {
        host.log.error({ sessionId, error: serializeError(err) }, "Slack session archive notification error");
      }
    },

    async notifySlackSessionStopped(sessionId: string): Promise<void> {
      const stage = "session_stopped";
      const promptId = "session-stopped";
      const scheduleStopNotificationRetry = async (reason: string): Promise<void> => {
        const env = host.env;
        await markSlackPostPendingRetry(env.DB, {
          sessionId,
          promptId,
          stage,
          nextAttemptAt: Date.now() + SLACK_NOTIFICATION_RECOVERY_DELAY_MS,
          error: reason,
        });
        await host.rescheduleSessionAlarm();
      };

      try {
        const env = host.env;
        const slackExt = doDb.getSessionExtended(host.sql, sessionId);
        const callbackContext = slackExt?.callbackContext ?? undefined;
        if (!callbackContext || callbackContext.source !== "slack") {
          host.log.info({ sessionId }, "Slack session stop notification skipped: no callback context");
          return;
        }
        if (!callbackContext.channel || !callbackContext.threadTs) {
          host.log.warn(
            { sessionId, channel: callbackContext.channel, threadTsPresent: Boolean(callbackContext.threadTs) },
            "Slack session stop notification skipped: missing thread routing",
          );
          return;
        }

        const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
          sessionId,
          operation: "notifySlackSessionStopped",
        });
        if (!token) {
          host.log.info(
            {
              sessionId,
              source: callbackContext.source,
              slackTeamId: callbackContext.slackTeamId,
            },
            "Slack session stop notification skipped: no bot token",
          );
          return;
        }

        const shouldPost = await claimSlackPostForDelivery(env.DB, {
          sessionId,
          promptId,
          stage,
          channel: callbackContext.channel,
        });
        if (!shouldPost) {
          host.log.info({ sessionId, promptId, stage }, "Slack session stop notification skipped: duplicate stage");
          return;
        }

        const sessionUrl = resolvePublicSessionUrl(env, sessionId);
        const text = `🛑 Session stopped from the dashboard. <${sessionUrl}|View session>`;
        let result: Awaited<ReturnType<typeof postSessionThreadMessage>>;
        try {
          result = await postSessionThreadMessage({
            token,
            channel: callbackContext.channel,
            threadTs: callbackContext.threadTs,
            kind: "expansion",
            text,
            sessionId,
            anchors: callbackContext,
            persistAnchors: (patch) => {
              doDb.patchSessionCallbackContext(host.sql, sessionId, patch);
            },
          });
        } catch (err) {
          host.log.error(
            {
              sessionId,
              channel: callbackContext.channel,
              threadTs: callbackContext.threadTs,
              error: serializeError(err),
            },
            "Slack session stop notification error",
          );
          await scheduleStopNotificationRetry("session_stopped_exception");
          return;
        }
        if (!result.ok) {
          await reportSlackPostFailure(env, {
            operation: "notifySlackSessionStopped",
            sessionId,
            stage,
            slackErrorCode: result.error,
          });
          host.log.error(
            {
              sessionId,
              channel: callbackContext.channel,
              threadTs: callbackContext.threadTs,
              slackError: result.error,
            },
            "Slack session stop notification failed",
          );
          await scheduleStopNotificationRetry("session_stopped_api_error");
          return;
        }

        await markSlackPostDelivered(env.DB, {
          sessionId,
          promptId,
          stage,
          messageTs: result.ts ?? callbackContext.threadTs,
        });
      } catch (err) {
        host.log.error({ sessionId, error: serializeError(err) }, "Slack session stop notification error");
      }
    },

    async notifySlackThread(sessionId: string, promptId: string, success: boolean): Promise<void> {
      const env = host.env;
      const slackExt = doDb.getSessionExtended(host.sql, sessionId);

      // Record the scheduled-automation Slack delivery outcome (ARC-1195). An
      // AUTOMATION session with a scheduled rule folds its digest into this
      // status card, so a successful deliverThreadStatus IS the digest delivery.
      // Route EVERY terminal AND early-exit path (no bot token, thrown Slack
      // error) through here so a silently-undelivered digest still records
      // `last_delivery_error` + the metric. No-ops for non-automation sessions.
      // Observability only — a recording error must never escape the notifier.
      const recordAutomationDelivery = async (
        outcome: "delivered" | "empty" | "workspace_not_connected" | "post_failed",
        detail?: string,
      ): Promise<void> => {
        if (slackExt?.initiationMode !== InitiationMode.AUTOMATION || !slackExt.scheduledRuleId) return;
        const delivered = outcome === "delivered" || outcome === "empty";
        const now = Date.now();
        try {
          await recordScheduledRuleDelivery(env.DB, slackExt.scheduledRuleId, now, {
            deliveredAt: delivered ? now : null,
            error: delivered ? null : (detail ?? outcome),
          });
          await emitAutomationSlackDeliveryMetric(env, outcome);
        } catch (err) {
          host.log.warn(
            { sessionId, ruleId: slackExt.scheduledRuleId, outcome, error: serializeError(err) },
            "automation_slack_delivery_record_failed",
          );
        }
      };

      const callbackContext = slackExt?.callbackContext ?? undefined;
      if (!callbackContext || callbackContext.source !== "slack") {
        host.log.info({ sessionId }, "Slack notification skipped: no callback context");
        return;
      }
      const token = await resolveSlackBotTokenForCallback(env, callbackContext, {
        sessionId,
        operation: "notifySlackThread",
      });
      if (!token) {
        host.log.info(
          {
            sessionId,
            source: callbackContext.source,
            slackTeamId: callbackContext.source === "slack" ? callbackContext.slackTeamId : undefined,
          },
          "Slack notification skipped: no bot token",
        );
        // Workspace disconnected between the scheduler's starting post and now:
        // record it so the digest isn't silently dropped from delivery status.
        await recordAutomationDelivery("workspace_not_connected");
        return;
      }

      const stage = success ? "completed" : "failed";
      const shouldPost = await claimSlackPostForDelivery(env.DB, {
        sessionId,
        promptId,
        stage,
        channel: callbackContext.channel,
      });
      if (!shouldPost) {
        host.log.info({ sessionId, promptId, stage }, "Slack notification skipped: duplicate stage");
        return;
      }

      let retryScheduled = false;
      const scheduleSlackRetry = async (reason: string): Promise<void> => {
        if (retryScheduled) return;
        retryScheduled = true;
        await markSlackPostPendingRetry(env.DB, {
          sessionId,
          promptId,
          stage,
          nextAttemptAt: Date.now() + SLACK_NOTIFICATION_RECOVERY_DELAY_MS,
          error: reason,
        });
        await host.rescheduleSessionAlarm();
        host.log.warn(
          { event: "slack_notification_retry_scheduled", sessionId, promptId, stage, reason },
          "Scheduled Slack prompt notification retry",
        );
      };

      try {
        const response = ((await host.state.storage.get(`slack_summary:${promptId}`)) as {
          text: string;
          prUrl?: string;
          branchName?: string;
        }) || { text: "" };

        const rawErrorCode = doDb.getPromptTelemetry(host.sql, sessionId)[promptId]?.errorCode ?? null;
        const errorCode = isErrorCode(rawErrorCode) ? rawErrorCode : null;
        const promptStage = success ? ("done" as const) : ("failed" as const);
        const shouldAppendPromptReply = slackExt?.initiationMode !== InitiationMode.AUTOMATION;
        // Scheduled automations (a rule-fired session) deliver ONLY their final
        // digest as a single plain top-level message — no status card, no thread.
        // Slack-alert automations are AUTOMATION but have no scheduledRuleId and
        // keep the card + thread, so the scheduledRuleId conjunct is load-bearing.
        const isScheduledAutomation =
          slackExt?.initiationMode === InitiationMode.AUTOMATION && Boolean(slackExt?.scheduledRuleId);
        const prompt = shouldAppendPromptReply ? doDb.getPrompt(host.sql, promptId) : null;
        // Reconcile the card's Resume/Retry request rows for this terminal:
        // failed renders a Retry button bound to a pending row (create-or-
        // reuse); done supersedes any lingering control rows. Best-effort —
        // a D1 hiccup renders the card without buttons.
        const businessId = doDb.getSession(host.sql, sessionId)?.businessId ?? null;
        const controlIds =
          env.DB && businessId
            ? await syncCardControlRequests(env.DB, {
                stage: promptStage,
                businessId,
                sessionId,
                slackTeamId: callbackContext.slackTeamId,
                slackChannelId: callbackContext.channel,
                messageTs: callbackContext.statusMessageTs ?? null,
              })
            : {};
        const statusInput = buildAuthoritativeStatusInput(host.sql, env, sessionId, {
          stage: promptStage,
          summaryText: shouldAppendPromptReply ? undefined : response.text,
          branchName: response.branchName,
          errorCode,
          statusOnly: shouldAppendPromptReply,
          retryRequestId: controlIds.retryRequestId,
        });
        if (promptStage === "done") {
          host.log.info(
            { event: "slack_done_card_pr_url", sessionId, promptId, prUrlPresent: Boolean(statusInput.prUrl) },
            "Slack done card PR-metadata source",
          );
        }
        const blocks = isScheduledAutomation ? buildPlainDigestBlocks(response.text) : buildStatusBlocks(statusInput);
        const fallback = isScheduledAutomation
          ? buildPlainDigestFallbackText(response.text)
          : buildStatusFallbackText(statusInput);
        const replyInput = {
          stage: promptStage,
          replyToText: prompt?.replyToText ?? null,
          quoteContext:
            buildQuotedReplyContextFromSource(prompt?.replyToQuoteSource) ??
            buildQuotedReplyContext(prompt?.replyToText ?? null),
          summaryText: response.text,
        };
        const replyBlocks = buildPromptReplyBlocks(replyInput);
        const replyFallback = buildPromptReplyFallbackText(replyInput);
        const expectsPromptReply = shouldAppendPromptReply && replyBlocks.length > 0 && Boolean(replyFallback);
        let promptReplyDelivered = false;
        let statusDeliveryFailed = false;
        let deliveredMessageTs: string | null = null;

        // For Slack sessions, edit the durable status reply in place when we know
        // its timestamp. Triage and legacy sessions still post a normal reply.
        // Scheduled automations always deliver top-level (channel-only), even if
        // an in-flight session predates the no-starting-message change.
        const threadTs =
          isScheduledAutomation || callbackContext.source !== "slack" ? undefined : callbackContext.threadTs;
        const statusMessageTs =
          isScheduledAutomation || callbackContext.source !== "slack" ? undefined : callbackContext.statusMessageTs;
        let effectiveStatusMessageTs = statusMessageTs;
        const result = await deliverThreadStatus({
          token,
          channel: callbackContext.channel,
          threadTs,
          statusMessageTs,
          text: fallback,
          blocks,
        });
        if (callbackContext.source === "slack" && result.fallbackTs) {
          effectiveStatusMessageTs = result.fallbackTs;
          deliveredMessageTs = result.fallbackTs;
          doDb.patchSessionCallbackContext(host.sql, sessionId, { statusMessageTs: result.fallbackTs });
        } else if (result.ok && statusMessageTs) {
          deliveredMessageTs = statusMessageTs;
        } else if (result.ok && threadTs) {
          deliveredMessageTs = threadTs;
        }
        if (!result.ok) {
          statusDeliveryFailed = true;
          await reportSlackPostFailure(env, {
            operation: "notifySlackThread.status",
            sessionId,
            stage,
            slackErrorCode: result.error,
          });
          host.log.error(
            { sessionId, channel: callbackContext.channel, threadTs, slackError: result.error },
            "Slack notification failed",
          );
        } else if (!result.updatedInPlace && statusMessageTs) {
          if (result.error) {
            await reportSlackPostFailure(env, {
              operation: "notifySlackThread.status",
              sessionId,
              stage,
              reason: "status_update_fallback",
              slackErrorCode: result.error,
            });
          }
          host.log.warn(
            { sessionId, channel: callbackContext.channel, statusMessageTs, slackError: result.error },
            "Slack status message update failed; delivered as a new thread reply",
          );
        } else {
          host.log.info(
            { sessionId, channel: callbackContext.channel, threadTs, updatedInPlace: result.updatedInPlace },
            "Slack notification sent",
          );
        }

        const preserveReplyInStatus = async (reason: "api_error" | "exception"): Promise<boolean> => {
          const statusWithReplyInput = {
            ...statusInput,
            summaryText: response.text,
            statusOnly: false,
          };
          const statusWithReplyResult = await deliverThreadStatus({
            token,
            channel: callbackContext.channel,
            threadTs,
            statusMessageTs: effectiveStatusMessageTs,
            text: buildStatusFallbackText(statusWithReplyInput),
            blocks: buildStatusBlocks(statusWithReplyInput),
          });
          if (callbackContext.source === "slack" && statusWithReplyResult.fallbackTs) {
            effectiveStatusMessageTs = statusWithReplyResult.fallbackTs;
            deliveredMessageTs = statusWithReplyResult.fallbackTs;
            doDb.patchSessionCallbackContext(host.sql, sessionId, {
              statusMessageTs: statusWithReplyResult.fallbackTs,
            });
          } else if (statusWithReplyResult.ok && effectiveStatusMessageTs) {
            deliveredMessageTs = effectiveStatusMessageTs;
          } else if (statusWithReplyResult.ok && threadTs) {
            deliveredMessageTs = threadTs;
          }
          if (!statusWithReplyResult.ok) {
            await reportSlackPostFailure(env, {
              operation: "notifySlackThread.status_with_reply",
              sessionId,
              stage,
              reason,
              slackErrorCode: statusWithReplyResult.error,
            });
            host.log.error(
              {
                sessionId,
                channel: callbackContext.channel,
                threadTs,
                reason,
                slackError: statusWithReplyResult.error,
              },
              "Slack prompt reply fallback status update failed",
            );
            return false;
          }
          return true;
        };

        if (expectsPromptReply) {
          try {
            const replyResult = await postSessionThreadMessage({
              token,
              channel: callbackContext.channel,
              threadTs,
              kind: "result",
              text: replyFallback,
              blocks: replyBlocks,
              sessionId,
              promptId,
              anchors: callbackContext,
              persistAnchors: (patch) => {
                doDb.patchSessionCallbackContext(host.sql, sessionId, patch);
              },
            });
            if (!replyResult.ok) {
              await reportSlackPostFailure(env, {
                operation: "notifySlackThread.prompt_reply",
                sessionId,
                stage,
                slackErrorCode: replyResult.error,
              });
              host.log.error(
                { sessionId, channel: callbackContext.channel, threadTs, slackError: replyResult.error },
                "Slack prompt reply failed",
              );
              if (!(await preserveReplyInStatus("api_error"))) {
                await scheduleSlackRetry("prompt_reply_api_error");
              } else {
                promptReplyDelivered = true;
              }
            } else {
              promptReplyDelivered = true;
              deliveredMessageTs = replyResult.ts ?? deliveredMessageTs;
            }
          } catch (err) {
            host.log.error(
              { sessionId, channel: callbackContext.channel, threadTs, error: serializeError(err) },
              "Slack prompt reply error",
            );
            if (!(await preserveReplyInStatus("exception"))) {
              await scheduleSlackRetry("prompt_reply_exception");
            } else {
              promptReplyDelivered = true;
            }
          }
        }

        if (statusDeliveryFailed && (!expectsPromptReply || !promptReplyDelivered)) {
          await scheduleSlackRetry("status_delivery_failed");
        }

        if (!retryScheduled && deliveredMessageTs) {
          await markSlackPostDelivered(env.DB, { sessionId, promptId, stage, messageTs: deliveredMessageTs });
        }

        // Record the scheduled-automation delivery outcome for this terminal.
        if (!retryScheduled && deliveredMessageTs) {
          await recordAutomationDelivery(response.text?.trim() ? "delivered" : "empty");
        } else {
          await recordAutomationDelivery("post_failed", result.error ?? "status_delivery_failed");
        }

        // Remove "eyes" reaction from every follow-up message that received one (only for slack source)
        const reactionTimestamps =
          callbackContext.source === "slack" ? (callbackContext.reactionMessageTimestamps ?? []) : [];
        await Promise.all(
          reactionTimestamps.map((ts) =>
            removeReaction(token, callbackContext.channel, ts, "eyes").catch((err) => {
              host.log.error({ sessionId, ts, error: serializeError(err) }, "Failed to remove eyes reaction");
              Sentry.captureException(err, { tags: { sessionId, operation: "removeReaction" } });
            }),
          ),
        );
      } catch (err) {
        host.log.error({ sessionId, error: serializeError(err) }, "Slack notification failed");
        // A thrown delivery (e.g. Slack API/network throw) would otherwise skip
        // the terminal recorder above — capture it so it isn't silent.
        await recordAutomationDelivery("post_failed", stringifyError(err));
        await scheduleSlackRetry("notification_exception");
      }
    },
  };

  return notifications;
}
