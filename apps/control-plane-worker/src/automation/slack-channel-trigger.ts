export type SlackChannelAutomationSkipReason =
  | "unsupported_event_type"
  | "unconfigured_channel"
  | "thread_reply"
  | "ignored_subtype"
  | "self_bot_event"
  | "unsupported_sender";

export interface SlackChannelAutomationTriggerConfig {
  teamId: string;
  channelId: string;
  botUserId: string | null;
  botId?: string | null;
  allowedAppIds: readonly string[];
  allowedBotIds: readonly string[];
}

export interface SlackChannelAutomationEvent {
  type?: unknown;
  subtype?: unknown;
  team?: unknown;
  team_id?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  user?: unknown;
  bot_id?: unknown;
  app_id?: unknown;
  text?: unknown;
  attachments?: unknown;
}

export type SlackChannelAutomationTriggerResult =
  | { shouldTrigger: true; senderType: "allowed_app" | "human_mention" }
  | { shouldTrigger: false; reason: SlackChannelAutomationSkipReason };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasValue(values: readonly string[], value: string | null): boolean {
  return value !== null && values.includes(value);
}

function mentionsBot(text: string | null, botUserId: string | null): boolean {
  return Boolean(text && botUserId && text.includes(`<@${botUserId}>`));
}

function isRootMessage(ts: string | null, threadTs: string | null): boolean {
  return Boolean(ts && (!threadTs || threadTs === ts));
}

/**
 * Slack channel alert automation is intentionally stricter than normal Slack
 * session entrypoints: only configured channel root messages may start jobs.
 * Human chatter is ignored unless it explicitly mentions Cycloid. Alert-app
 * messages may use Slack's `bot_message` subtype, but edits, deletes, joins,
 * pins, and every other subtype are ignored before any session is created.
 */
export function evaluateSlackChannelAutomationTrigger(
  event: SlackChannelAutomationEvent,
  config: SlackChannelAutomationTriggerConfig,
): SlackChannelAutomationTriggerResult {
  if (event.type !== "message" && event.type !== "app_mention") {
    return { shouldTrigger: false, reason: "unsupported_event_type" };
  }

  const teamId = nonEmptyString(event.team) ?? nonEmptyString(event.team_id);
  const channelId = nonEmptyString(event.channel);
  if (!teamId || teamId !== config.teamId || channelId !== config.channelId) {
    return { shouldTrigger: false, reason: "unconfigured_channel" };
  }

  const ts = nonEmptyString(event.ts);
  const threadTs = nonEmptyString(event.thread_ts);
  if (!isRootMessage(ts, threadTs)) {
    return { shouldTrigger: false, reason: "thread_reply" };
  }

  const subtype = nonEmptyString(event.subtype);
  const appId = nonEmptyString(event.app_id);
  const botId = nonEmptyString(event.bot_id);
  const isAllowedAppSender = hasValue(config.allowedAppIds, appId) || hasValue(config.allowedBotIds, botId);

  if (subtype && !(subtype === "bot_message" && isAllowedAppSender)) {
    return { shouldTrigger: false, reason: "ignored_subtype" };
  }

  if (
    (config.botUserId && nonEmptyString(event.user) === config.botUserId) ||
    (config.botId && botId === config.botId)
  ) {
    return { shouldTrigger: false, reason: "self_bot_event" };
  }

  if (isAllowedAppSender) {
    return { shouldTrigger: true, senderType: "allowed_app" };
  }

  if (mentionsBot(nonEmptyString(event.text), config.botUserId)) {
    return { shouldTrigger: true, senderType: "human_mention" };
  }

  return { shouldTrigger: false, reason: "unsupported_sender" };
}
