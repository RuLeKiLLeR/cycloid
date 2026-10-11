import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import { getUserBusinessIdOrNull, getUserBySlackId } from "../auth/db";
import { processSlackChannelAutomationEvent } from "../automation/slack-channel-service";
import { getChannelIntake } from "../company-memory/db";
import {
  isCompanyMemorySlackSubtypeAllowed,
  recordSlackIngestion,
  resolveSlackWorkspaceForMemory,
} from "../company-memory/service";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import { closeSessionForWebhook, getSessionState } from "../session/state";
import { hasSlackFileAttachments } from "../slack/attachments";
import { sendSlackLinkDm } from "../slack/link-service";
import { getSlackBotUserId, postThreadReply } from "../slack/notify";
import type { Env } from "../types";
import { computeSha256Hex, jsonErrorResponse, jsonResponse, normalizeWebhookReference } from "../utils";
import { getSessionIdBySlackThreadRef } from "./db";
import {
  normalizeSlackPromptText,
  parseRepoPromptFromSlackMessage,
  resolveSlackTriggerDeletion,
  slackMessageMentionsUserOutsideQuotes,
} from "./prompts";
import {
  authorizeSessionCloseActor,
  claimOrSkip,
  emitLifecycleEvent,
  getSlackTeamIdFromEventPayload,
  handleSlackNewSession,
  handleSlackThreadFollowUp,
  isAllowedSlackAttachmentEvent,
  isSlackWebhookAvailable,
  lifecycleUserId,
  log,
  resolveSlackWebhookBotToken,
  runSlackSessionCreateInBackgroundSpan,
  scheduleWebhookTask,
  verifySlackRequest,
  WEBHOOK_SOURCE_SLACK_EVENTS,
} from "./shared";
import {
  slackLinkDmAlreadySentReply,
  slackLinkDmSentReply,
  slackUnconnectedAccountReply,
} from "./slack-operational-replies";

export async function handleSlackEventsWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // Webhook receipt time, used to measure mention -> "eyes" ack latency. Captured
  // first so the metric reflects the full server-side path.
  const eventReceivedMs = Date.now();
  if (request.headers.get("x-slack-retry-num")) {
    log.info({}, "Skipping: retry");
    return jsonResponse({ ok: true });
  }

  const verifyResult = await verifySlackRequest(request, env);
  if (verifyResult instanceof Response) return verifyResult;
  const { rawBody, timestamp, signature } = verifyResult;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonErrorResponse("Invalid JSON", 400);
  }

  if (payload?.type === "url_verification") {
    return jsonResponse({ challenge: (payload as Record<string, unknown>).challenge });
  }

  const db = env.DB;
  const payloadHash = await computeSha256Hex(rawBody);
  const { duplicate } = await claimOrSkip(
    db,
    WEBHOOK_SOURCE_SLACK_EVENTS,
    (payload?.event_id as string) || `${timestamp}:${signature}`,
    payloadHash,
  );
  if (duplicate) return duplicate;

  if (payload?.type !== "event_callback") {
    log.info({ type: payload?.type }, "Skipping: not event_callback");
    return jsonResponse({ ok: true, skipped: true });
  }

  const event = payload?.event as Record<string, unknown> | undefined;
  // Slack never dispatches `app_mention` inside a 1:1 DM; DMs arrive as
  // `message.im`. A DM that mentions the bot is the DM-channel equivalent of a
  // channel @mention, so once the bot user id is known it is promoted onto the
  // `app_mention` path below and handled by the exact same downstream code. A
  // DM without a bot mention is ignored, like a non-mention channel message.
  const channelType = normalizeWebhookReference(event?.channel_type);
  const isDirectMessage =
    event?.type === "message" &&
    (channelType === "im" || Boolean(normalizeWebhookReference(event?.channel)?.startsWith("D")));
  let isAppMention = event?.type === "app_mention";
  const channelId = normalizeWebhookReference(event?.channel);
  const threadTs = normalizeWebhookReference(event?.thread_ts || event?.ts);
  // Cheap presence check first, before the workspace D1 read below, so a
  // malformed event still skips without a DB hit.
  if (!channelId || !threadTs) {
    log.info({ hasChannelId: !!channelId, hasThreadTs: !!threadTs }, "Skipping: missing fields");
    return jsonResponse({ ok: true, skipped: true });
  }

  // Resolve the workspace bot user id before normalizing the prompt so the
  // normalizer can strip only the bot's own trigger mention and preserve other
  // user mentions for resolveSlackMentions. The stored botUserId is the canonical
  // bot identity (pinned to SLACK_BOT_USER_ID), the same id the live app_mention
  // gate below resolves via getSlackBotUserId.
  const slackTeamId = getSlackTeamIdFromEventPayload(payload, event);
  const slackWorkspace = await resolveSlackWorkspaceForMemory(env, slackTeamId);
  const slackBotUserId = slackWorkspace?.botUserId ? normalizeWebhookReference(slackWorkspace.botUserId) : null;

  // Deleting the message that triggered a session stops that session. Slack
  // delivers that deletion in two shapes (see resolveSlackTriggerDeletion):
  // `message_deleted` for a reply-less message, and — the common case for a
  // live session, because Cycloid has already posted an in-thread reply —
  // `message_changed` carrying an inner tombstone. Both resolve to the removed
  // message's ts (the thread-root ts sessions are bound on); `event.ts` here is
  // the deletion event's own ts, so the `threadTs` computed above does not
  // identify the deleted message. Handle it here, before the company-memory
  // subtype gate below drops these subtypes as `ignored_subtype`, reusing the
  // exact stop machinery the `stop` command uses (no new writer path). An
  // ordinary edit is also `message_changed` but returns null here, so it is not
  // treated as a deletion. Only the thread-root ref is bound, so deleting a
  // follow-up reply matches no session and is correctly a no-op.
  const triggerDeletion = resolveSlackTriggerDeletion(event);
  if (triggerDeletion) {
    const deletedTs = triggerDeletion.deletedTs;
    // team/channel/ts are structural fields the thread-ref lookup needs; the
    // business is resolved below from the actor (not gated here) so a null
    // workspace business id does not block finding the session.
    if (!slackTeamId || !channelId || !deletedTs) {
      log.info(
        { hasTeam: !!slackTeamId, hasChannel: !!channelId, hasDeletedTs: !!deletedTs },
        "Skipping Slack message_deleted: missing fields",
      );
      return jsonResponse({ ok: true, skipped: true, reason: "message_deleted_missing_fields" });
    }
    // Slack's deletion event never carries the deleter's id, only the original
    // author on `previous_message.user`. Resolve that author exactly like the
    // `stop` command and session creation do — the global `getUserBySlackId`
    // lookup — so the delete-to-stop path behaves identically to the stop
    // button. A team-scoped lookup here silently no-ops for every install whose
    // Slack links predate the `external_team_id` backfill (and have no
    // `slack_link_token_consumptions` fallback row), which is the common case.
    // The workspace boundary is still enforced below by authorizeSessionCloseActor,
    // which requires owner-match or same-business shared sessions.
    const deleterSlackUserId = triggerDeletion.authorSlackUserId;
    const deleterUser = deleterSlackUserId ? await getUserBySlackId(db, deleterSlackUserId) : null;
    if (!deleterUser) {
      return jsonResponse({ ok: true, created: false, skipped: true, reason: "missing_actor" });
    }
    // Prefer the workspace's business, falling back to the deleter's own
    // business (mirrors the normal session lookup's `slackWorkspace?.businessId
    // ?? slackLifecycleBusinessId`) so deletions still resolve in seeded/legacy
    // installs where the workspace row has no business id.
    const deletionBusinessId = slackWorkspace?.businessId ?? (await getUserBusinessIdOrNull(db, deleterUser.id));
    if (!deletionBusinessId) {
      return jsonResponse({ ok: true, created: false, skipped: true, reason: "business_missing" });
    }
    const deletedSessionId = await getSessionIdBySlackThreadRef(
      db,
      deletionBusinessId,
      slackTeamId,
      channelId,
      deletedTs,
    );
    if (!deletedSessionId) {
      return jsonResponse({ ok: true, skipped: true, reason: "message_deleted_no_session" });
    }
    const session = await getSessionState(env, deletedSessionId);
    if (!session) {
      return jsonResponse({ ok: true, created: false, skipped: true, reason: "session_not_found" });
    }
    const authorization = await authorizeSessionCloseActor(db, String(deleterUser.id), session);
    if (!authorization.authorized) {
      return jsonResponse({ ok: true, created: false, skipped: true, reason: authorization.reason });
    }
    const closeResult = await closeSessionForWebhook(env, db, deletedSessionId);
    return jsonResponse({
      ok: true,
      created: false,
      sessionId: deletedSessionId,
      stopped: closeResult.closed,
      reason: "message_deleted",
    });
  }

  const automationMessageTs = normalizeWebhookReference(event?.ts);
  const automationThreadTs = normalizeWebhookReference(event?.thread_ts);
  const isRootAutomationCandidate = Boolean(
    automationMessageTs && (!automationThreadTs || automationThreadTs === automationMessageTs),
  );
  const automationBusinessId = slackWorkspace?.businessId ?? null;
  if (automationBusinessId && slackTeamId && channelId && !isAppMention && isRootAutomationCandidate) {
    const normalizedSlackUserIdForAutomation = normalizeWebhookReference(event?.user);
    const subtypeAllowedForAutomation = isCompanyMemorySlackSubtypeAllowed(event) || event?.subtype === "bot_message";
    const isBotAutomationCandidate = Boolean(
      normalizeWebhookReference(event?.bot_id) ||
      normalizeWebhookReference(event?.app_id) ||
      event?.subtype === "bot_message",
    );
    const isSelfAutomationEvent = slackBotUserId && normalizedSlackUserIdForAutomation === slackBotUserId;
    if (subtypeAllowedForAutomation && isBotAutomationCandidate && !isSelfAutomationEvent) {
      const automationTask = runWithSentryTag(
        "processSlackChannelAutomationEvent",
        async () => {
          return await processSlackChannelAutomationEvent({
            env,
            businessId: automationBusinessId,
            resolveSlackBotToken: () =>
              resolveSlackWebhookBotToken(env, slackTeamId, "processSlackChannelAutomationEvent"),
            event: { ...(event ?? {}), team: slackTeamId },
            rawPayloadJson: rawBody,
          });
        },
        log,
        { tags: { teamId: slackTeamId, channelId } },
      );
      if (ctx) ctx.waitUntil(automationTask);
      else await automationTask;
      return jsonResponse({ ok: true, skipped: true, reason: "automation_candidate" });
    }
  }

  const text = normalizeSlackPromptText(payload, slackBotUserId) ?? "";
  const hasSlackAttachments = hasSlackFileAttachments(event);
  const canProcessSlackAttachments = hasSlackAttachments && isAllowedSlackAttachmentEvent(event);
  const hasAttachments = canProcessSlackAttachments;
  const isThreadAppMention = isAppMention && Boolean(normalizeWebhookReference(event?.thread_ts));
  if (!text && !hasAttachments && !isThreadAppMention) {
    log.info({ hasText: !!text, hasAttachments: hasSlackAttachments }, "Skipping: missing fields");
    return jsonResponse({ ok: true, skipped: true });
  }

  log.info(
    { hasText: text.length > 0, textLength: text.length, hasAttachments, channelId, threadTs },
    "Processing event",
  );
  const normalizedSlackUserId = normalizeWebhookReference(event?.user);
  if (slackBotUserId && normalizedSlackUserId === slackBotUserId) {
    log.info({ teamId: slackTeamId, channelId }, "Skipping Slack event from Cycloid bot user");
    return jsonResponse({ ok: true, skipped: true, reason: "self_bot_event" });
  }
  // Ignore other bots/apps (Linear, Datadog, etc.). A genuine channel-automation
  // event already returned earlier (lines ~119-148); anything reaching here from a
  // bot/app actor is not a human session trigger, so never resolve it as an actor
  // or nag it. Returns before company-memory ingestion to keep other bots out of
  // the business memory pile.
  const isExternalBotEvent = Boolean(
    normalizeWebhookReference(event?.bot_id) ||
    normalizeWebhookReference(event?.app_id) ||
    event?.subtype === "bot_message",
  );
  if (isExternalBotEvent) {
    log.info(
      {
        teamId: slackTeamId,
        channelId,
        subtype: normalizeWebhookReference(event?.subtype),
        botId: normalizeWebhookReference(event?.bot_id),
        appId: normalizeWebhookReference(event?.app_id),
      },
      "Skipping Slack event from external bot/app",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "external_bot_event" });
  }
  // Promote a bot-mentioning DM onto the app_mention path so it runs through the
  // identical channel flow (identity, repo resolution, session, follow-ups,
  // stop, company-memory capture). Requires a verifiable bot user id; without it
  // the mention can't be proven, so the DM is left to be ignored (fail closed).
  if (isDirectMessage && slackBotUserId && slackMessageMentionsUserOutsideQuotes(event, slackBotUserId)) {
    isAppMention = true;
  }
  if (!isCompanyMemorySlackSubtypeAllowed(event)) {
    log.info({ subtype: event?.subtype }, "Skipping Slack event subtype for company memory");
    return jsonResponse({ ok: true, skipped: true, reason: "ignored_subtype" });
  }
  // Best-effort lifecycle audit write - keep it off the ack path (it never throws
  // and nothing downstream reads it synchronously) so the D1 write doesn't gate
  // how fast we react to the mention.
  scheduleWebhookTask(
    ctx,
    emitLifecycleEvent({
      db,
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_VERIFIED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
      message: "Slack webhook signature verified.",
      details: {
        provider: "slack",
        teamId: slackTeamId,
        webhookDeliveryId: normalizeWebhookReference(payload?.event_id) ?? `${timestamp}:${signature}`,
      },
    }),
  );

  let slackBotToken: string | null | undefined;
  async function ensureSlackBotToken(): Promise<Response | null> {
    if (slackBotToken === undefined) {
      slackBotToken = await resolveSlackWebhookBotToken(env, slackTeamId, "handleSlackEventsWebhook");
    }
    if (!slackTeamId || !slackBotToken) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: slackTeamId ? "slack_workspace_token_missing" : "missing_slack_team_id",
      });
    }
    return null;
  }

  let slackIngestionScheduled = false;
  let cachedIntakeBusinessId: string | null = null;
  let cachedIntakeRow: Awaited<ReturnType<typeof getChannelIntake>> | null | undefined;
  async function resolveSlackIntakeRow(
    businessId: string | null | undefined,
  ): Promise<Awaited<ReturnType<typeof getChannelIntake>> | null> {
    const teamId = slackTeamId;
    const memoryChannelId = channelId;
    if (!businessId || !teamId || !memoryChannelId) return null;
    if (cachedIntakeBusinessId === businessId && cachedIntakeRow !== undefined) return cachedIntakeRow;
    cachedIntakeBusinessId = businessId;
    cachedIntakeRow = await getChannelIntake(db, businessId, teamId, memoryChannelId);
    return cachedIntakeRow;
  }
  async function scheduleSlackIngestion(
    businessId: string | null | undefined,
    resolvedIntakeRow?: Awaited<ReturnType<typeof getChannelIntake>> | null,
  ): Promise<void> {
    if (slackIngestionScheduled) return;
    const intakeRow = resolvedIntakeRow === undefined ? await resolveSlackIntakeRow(businessId) : resolvedIntakeRow;
    // Exclude DMs from company memory: a 1:1 DM is private to the sender, so its
    // text must not be vacuumed into the shared, business-wide memory pile the
    // way a public channel @mention is. DMs still start sessions identically;
    // only this capture step diverges.
    const shouldCaptureWithoutIntake = isAppMention && !isDirectMessage;
    if (!intakeRow && !shouldCaptureWithoutIntake) return;
    slackIngestionScheduled = true;
    const task = recordSlackIngestion(env, payload, event ?? {}, {
      businessId,
      workspace: slackWorkspace,
      intakeRow,
    }).catch((err) => {
      log.warn({ error: String(err), teamId: slackTeamId, channelId }, "Slack company memory ingestion failed");
    });
    if (ctx) ctx.waitUntil(task);
    else await task;
  }

  // Parsed up front (not at its original site below the actor-resolution block)
  // so downstream mentioned messages can route `qa=true` through verification.
  // The directive is not itself a Slack trigger: users still need @Cycloid.
  const parsedMessage = parseRepoPromptFromSlackMessage(text);

  let actorUserId = normalizedSlackUserId ? `slack:${normalizedSlackUserId}` : "slack:webhook";
  let actorLabel: string | null = normalizedSlackUserId;
  if (normalizedSlackUserId) {
    const linkedUser = await getUserBySlackId(db, normalizedSlackUserId);
    if (linkedUser) {
      if (!(await isSlackWebhookAvailable(db, linkedUser.id))) {
        log.info({ userId: linkedUser.id }, "Slack integration disabled for user's business");
        await scheduleSlackIngestion(slackWorkspace?.businessId);
        return jsonResponse({ ok: true, skipped: true, reason: "integration_disabled" });
      }
      actorUserId = String(linkedUser.id);
      actorLabel = linkedUser.login ?? `Cycloid user ${linkedUser.id}`;
    } else {
      // Only nag a genuine new-session trigger - an app_mention, which already
      // covers DM-to-bot promotion. A non-trigger message from an unconnected
      // actor (casual channel chatter, a mention-free QA directive, or a DM that
      // doesn't mention the bot) stays silent: no magic-link reply, and no
      // FAILED actor-resolution row (which would pollute the exact lifecycle
      // signal used to diagnose mis-fires, and risk tripping monitors).
      if (!isAppMention) {
        log.info({ slackUserId: normalizedSlackUserId }, "Ignoring non-trigger message from unconnected Slack user");
        await scheduleSlackIngestion(slackWorkspace?.businessId);
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: isDirectMessage ? "not_app_mention" : "unconnected_non_trigger",
        });
      }
      await emitLifecycleEvent({
        db,
        integrationId: "slack",
        stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
        status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
        reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
        message: "Slack webhook could not resolve the Slack actor to a connected Cycloid user.",
        details: {
          provider: "slack",
          teamId: slackTeamId,
          actor: normalizedSlackUserId,
        },
      });
      log.info({ slackUserId: normalizedSlackUserId }, "Slack user not connected");
      await scheduleSlackIngestion(slackWorkspace?.businessId);
      const tokenError = await ensureSlackBotToken();
      if (tokenError) return tokenError;
      // DM the user a one-click magic link to bind their identity instead of
      // forcing them to find the settings page. Fall back to the settings reply
      // if the link can't be sent.
      const postUnconnectedReply = runWithSentryTag(
        "postUnconnectedSlackReply",
        async () => {
          const dmResult = await sendSlackLinkDm(env, {
            slackUserId: normalizedSlackUserId,
            slackTeamId: slackTeamId as string,
            botToken: slackBotToken as string,
          });
          const reply =
            dmResult === "sent"
              ? slackLinkDmSentReply()
              : dmResult === "rate_limited"
                ? slackLinkDmAlreadySentReply()
                : slackUnconnectedAccountReply(`${env.FRONTEND_URL || DEFAULT_FRONTEND_URL}/settings`);
          const replyResult = await postThreadReply(slackBotToken as string, channelId, threadTs, reply);
          if (!replyResult.ok) {
            await reportSlackPostFailure(env, {
              operation: "postUnconnectedSlackReply",
              slackErrorCode: replyResult.error,
            });
          }
        },
        log,
      );
      scheduleWebhookTask(ctx, postUnconnectedReply);
      return jsonResponse({ ok: true, skipped: true, reason: "slack_not_connected" });
    }
  }

  const slackLifecycleUserId = lifecycleUserId(actorUserId);
  const slackLifecycleBusinessId = slackLifecycleUserId
    ? await getUserBusinessIdOrNull(db, slackLifecycleUserId).catch((err) => {
        // One lookup failure must not kill the event, but the DB error must not vanish silently:
        // log it before mapping to a routine "business unavailable" skip.
        log.warn(
          { error: String(err), slackLifecycleUserId },
          "Slack lifecycle business lookup failed; treating business as unavailable",
        );
        return null;
      })
    : null;
  const slackBusinessId = slackWorkspace?.businessId ?? slackLifecycleBusinessId;
  const intakeRow = await resolveSlackIntakeRow(slackBusinessId);
  await scheduleSlackIngestion(slackBusinessId, intakeRow);
  // Best-effort lifecycle audit write - deferred off the ack path (see above).
  scheduleWebhookTask(
    ctx,
    emitLifecycleEvent({
      db,
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
      businessId: slackLifecycleBusinessId,
      userId: actorUserId,
      message: "Slack webhook resolved the workspace and actor context.",
      details: {
        provider: "slack",
        teamId: slackTeamId,
        actor: normalizedSlackUserId,
        eventKind: isAppMention ? "app_mention" : normalizeWebhookReference(event?.type),
      },
    }),
  );

  if (!slackBusinessId || !slackTeamId) {
    log.warn({ teamId: slackTeamId, channelId }, "Skipping Slack event: business or team unavailable");
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: slackBusinessId ? "missing_slack_team_id" : "business_missing",
    });
  }

  const existingSessionId = await getSessionIdBySlackThreadRef(db, slackBusinessId, slackTeamId, channelId, threadTs);
  const isExistingSessionStop = Boolean(existingSessionId && text.toLowerCase() === "stop");
  let hasLiveAppMention = isAppMention;
  // Whether a live (non-quoted) @mention of the bot was positively proven.
  // hasLiveAppMention optimistically defaults to isAppMention and stays true when
  // the bot user id can't be resolved (preserving the existing new-session path);
  // this flag instead stays false unless the mention is confirmed, so the
  // follow-up mention gate below fails closed when the bot id is unknown. Only
  // consulted for non-DM follow-ups: the gate short-circuits on !isDirectMessage
  // first, so the value it takes for a DM-promoted mention is never read.
  let liveAppMentionProven = false;
  if (isAppMention && !isExistingSessionStop) {
    const tokenError = await ensureSlackBotToken();
    if (tokenError) return tokenError;
    const botUserId = slackBotUserId ?? (await getSlackBotUserId(slackBotToken as string));
    if (botUserId) {
      hasLiveAppMention = slackMessageMentionsUserOutsideQuotes(event, botUserId);
      liveAppMentionProven = hasLiveAppMention;
    }
    if (!hasLiveAppMention && !existingSessionId) {
      log.info({ eventType: event?.type }, "Skipping Slack event: app mention only present in quoted text");
      return jsonResponse({ ok: true, skipped: true, reason: "quoted_mention_only" });
    }
  }

  const messageTs = normalizeWebhookReference(event?.ts);
  const eventThreadTs = normalizeWebhookReference(event?.thread_ts);

  if (existingSessionId && !(isAppMention && parsedMessage.qa)) {
    if (text.toLowerCase() === "stop") {
      const session = await getSessionState(env, existingSessionId);
      if (!session) {
        return jsonResponse({ ok: true, created: false, skipped: true, reason: "session_not_found" });
      }
      const authorization = await authorizeSessionCloseActor(db, actorUserId, session);
      if (!authorization.authorized) {
        return jsonResponse({ ok: true, created: false, skipped: true, reason: authorization.reason });
      }
      const closeResult = await closeSessionForWebhook(env, db, existingSessionId, {
        reason: "slack_stop_message",
        metadata: { closeSource: "slack_stop_message", actorUserId, channelId, threadTs },
      });
      return jsonResponse({ ok: true, created: false, sessionId: existingSessionId, stopped: closeResult.closed });
    }

    // Require a live @Cycloid mention before adding a thread reply to the
    // session's context. Without this, a bound thread swept every reply into the
    // session (eyes reaction + enqueue), even pure chatter. 1:1 DMs are exempt:
    // every DM message is already an unambiguous address to the bot. `stop`
    // is handled above; QA directives still require a live mention before they
    // can start verification. The fail-closed `liveAppMentionProven` treats an
    // unprovable bot id as no mention.
    if (!isDirectMessage && !liveAppMentionProven) {
      log.info({ channelId, threadTs }, "Skipping Slack thread follow-up: live @mention required");
      return jsonResponse({ ok: true, skipped: true, reason: "followup_requires_mention" });
    }

    const tokenError = await ensureSlackBotToken();
    if (tokenError) return tokenError;
    return handleSlackThreadFollowUp({
      env,
      db,
      ctx,
      event,
      text,
      channelId,
      threadTs,
      messageTs,
      isAppMention,
      actorUserId,
      actorLabel,
      slackTeamId: slackTeamId as string,
      slackBotToken: slackBotToken as string,
      existingSessionId,
      eventReceivedMs,
    });
  }

  if (!isAppMention) {
    if (intakeRow) return jsonResponse({ ok: true, skipped: true, reason: "intake_captured" });
    log.info({ eventType: event?.type }, "Skipping Slack new-session event: not app_mention");
    return jsonResponse({ ok: true, skipped: true, reason: "not_app_mention" });
  }

  const tokenError = await ensureSlackBotToken();
  if (tokenError) return tokenError;

  log.info(
    {
      parsedMessage: {
        repoUrl: parsedMessage.repoUrl,
        directivePresent: parsedMessage.directivePresent,
        hasPrompt: Boolean(parsedMessage.prompt),
        promptLength: parsedMessage.prompt?.length ?? 0,
      },
    },
    "Parsed message",
  );

  const newSessionParams = {
    env,
    db,
    ctx,
    businessId: slackBusinessId,
    slackTeamId: slackTeamId as string,
    slackBotToken: slackBotToken as string,
    event,
    hasAttachments,
    channelId,
    threadTs,
    messageTs,
    eventThreadTs,
    isAppMention,
    actorUserId,
    actorLabel,
    text,
    parsedMessage,
    skipThreadClaim: Boolean(existingSessionId && parsedMessage.qa),
    eventReceivedMs,
  };

  if (ctx) {
    ctx.waitUntil(
      runSlackSessionCreateInBackgroundSpan({
        env,
        operation: "handleSlackEventsWebhook.newSessionBackground",
        logger: log,
        task: () => handleSlackNewSession(newSessionParams),
      }),
    );
    return jsonResponse({ ok: true, accepted: true, reason: "slack_new_session_queued" });
  }

  return handleSlackNewSession(newSessionParams);
}
