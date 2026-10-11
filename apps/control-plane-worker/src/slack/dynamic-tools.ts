import { SLACK_API_BASE } from "../constants/slack";
import { getSlackUserTokens } from "../integrations/db";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { CallbackContext, Env } from "../types";
import { resolveInstalledSlackBotToken } from "./tokens";

const log = createLogger({ bindings: { component: "slack-dynamic-tools" } });

const SLACK_TEXT_MAX_CHARS = 4 * 1024;
const SLACK_SEARCH_DEFAULT_COUNT = 10;
const SLACK_SEARCH_MAX_COUNT = 20;
const SLACK_THREAD_LIMIT = 50;

type SlackApiResponse = {
  ok: boolean;
  error?: unknown;
};

type SlackDynamicToolErrorCode =
  | "invalid_input"
  | "not_connected"
  | "workspace_unknown"
  | "workspace_uninstalled"
  | "scope_missing"
  | "forbidden"
  | "not_found"
  | "token_expired"
  | "upstream_rate_limited"
  | "upstream_error";

export type SlackGetThreadInput = {
  channel: string;
  ts: string;
};

export type SlackSearchMessagesInput = {
  query: string;
  channel?: string;
  count?: number;
};

export type SlackSendMessageInput = {
  channel: string;
  threadTs?: string;
  text: string;
};

type SlackCallbackContext = Extract<CallbackContext, { source: "slack" }>;

export type SlackGetThreadResult = {
  messages: Array<{ user: string | null; ts: string; text: string; threadTs: string | null }>;
};

export type SlackSearchMessagesResult = {
  matches: Array<{
    channel: string | null;
    channelName: string | null;
    ts: string;
    text: string;
    permalink: string | null;
    user: string | null;
    username: string | null;
    threadTs: string | null;
  }>;
};

export type SlackSendMessageResult = {
  ts: string;
  channel: string;
  permalink: string | null;
};

export type SlackDynamicToolRouteResponse<T> =
  { ok: true; result: T } | { ok: false; errorCode: SlackDynamicToolErrorCode; error: string };

class SlackDynamicToolError extends Error {
  constructor(
    message: string,
    readonly code: SlackDynamicToolErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "SlackDynamicToolError";
  }
}

type SlackMessage = {
  user?: unknown;
  username?: unknown;
  ts?: unknown;
  text?: unknown;
  thread_ts?: unknown;
  blocks?: unknown;
  attachments?: unknown;
};

type SlackThreadResponse = SlackApiResponse & {
  messages?: unknown;
};

type SlackSearchResponse = SlackApiResponse & {
  messages?: {
    matches?: unknown;
  } | null;
};

type SlackPostMessageResponse = SlackApiResponse & {
  ts?: unknown;
  channel?: unknown;
};

type SlackPermalinkResponse = SlackApiResponse & {
  permalink?: unknown;
};

type SlackTokenKind = "workspace_bot" | "user";

function truncateSlackText(value: string): string {
  if (value.length <= SLACK_TEXT_MAX_CHARS) return value;
  const marker = "\n\n[truncated]";
  return `${value.slice(0, Math.max(0, SLACK_TEXT_MAX_CHARS - marker.length))}${marker}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseSlackErrorCode(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function looksLikeSlackConversationId(value: string): boolean {
  return /^[CDG][A-Z0-9]+$/i.test(value);
}

function uniqueRenderedSlackValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function expandSlackDisplayMarkup(text: string): string {
  return text.replace(/<([^>|]+)(?:\|([^>]+))?>/g, (_match, rawTarget: string, rawLabel?: string) => {
    const target = asNonEmptyString(rawTarget);
    const label = asNonEmptyString(rawLabel);
    if (!target) return label ?? "";
    if (/^https?:\/\//i.test(target) && label && label !== target) return `${label} (${target})`;
    if (target.startsWith("@")) {
      if (!label) return `<${target}>`;
      return label.startsWith("@") ? label : `@${label}`;
    }
    if (target.startsWith("#")) {
      if (!label) return `<${target}>`;
      return label.startsWith("#") ? label : `#${label}`;
    }
    if (target.startsWith("!")) {
      return label ?? `<${target}>`;
    }
    return label ?? target;
  });
}

function renderSlackTextObject(value: unknown): string {
  const textObject = asRecord(value);
  if (!textObject) return "";
  const text = asNonEmptyString(textObject.text);
  return text ? expandSlackDisplayMarkup(text) : "";
}

function renderSlackRichTextInline(value: unknown): string {
  const element = asRecord(value);
  if (!element) return "";
  const type = asNonEmptyString(element.type);
  switch (type) {
    case "text":
      return asString(element.text) ?? "";
    case "link": {
      const url = asNonEmptyString(element.url);
      const label = asNonEmptyString(element.text);
      if (!url) return label ?? "";
      return label && label !== url ? `${label} (${url})` : url;
    }
    case "user": {
      const userId = asNonEmptyString(element.user_id);
      return userId ? `<@${userId}>` : "";
    }
    case "channel": {
      const name = asNonEmptyString(element.name);
      if (name) return `#${name}`;
      const channelId = asNonEmptyString(element.channel_id);
      return channelId ? `<#${channelId}>` : "";
    }
    case "emoji": {
      const name = asNonEmptyString(element.name);
      return name ? `:${name}:` : "";
    }
    case "broadcast": {
      const range = asNonEmptyString(element.range);
      return range ? `<!${range}>` : "";
    }
    case "date":
      return asNonEmptyString(element.fallback) ?? "";
    default:
      return asString(element.text) ?? "";
  }
}

function renderSlackRichText(value: unknown): string {
  const node = asRecord(value);
  if (!node) return "";
  const type = asNonEmptyString(node.type);
  const elements = Array.isArray(node.elements) ? node.elements : [];
  switch (type) {
    case "rich_text":
      return uniqueRenderedSlackValues(elements.map(renderSlackRichText)).join("\n");
    case "rich_text_section":
    case "rich_text_preformatted":
      return elements.map(renderSlackRichTextInline).join("").trim();
    case "rich_text_quote": {
      const rendered = elements.map(renderSlackRichTextInline).join("").trim();
      return rendered
        ? rendered
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        : "";
    }
    case "rich_text_list": {
      const style = asNonEmptyString(node.style);
      return elements
        .map((element, index) => {
          const rendered = renderSlackRichText(element);
          if (!rendered) return "";
          const prefix = style === "ordered" ? `${index + 1}. ` : "- ";
          return rendered
            .split("\n")
            .map((line, lineIndex) => `${lineIndex === 0 ? prefix : "  "}${line}`)
            .join("\n");
        })
        .filter((value) => value.length > 0)
        .join("\n");
    }
    default:
      return renderSlackRichTextInline(value);
  }
}

function renderSlackBlock(value: unknown): string {
  const block = asRecord(value);
  if (!block) return "";
  const type = asNonEmptyString(block.type);
  switch (type) {
    case "rich_text":
      return renderSlackRichText(value);
    case "section": {
      const fields = Array.isArray(block.fields) ? block.fields.map(renderSlackTextObject) : [];
      return uniqueRenderedSlackValues([renderSlackTextObject(block.text), ...fields]).join("\n");
    }
    case "context": {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      return uniqueRenderedSlackValues(
        elements.map((element) => renderSlackTextObject(element) || renderSlackRichText(element)),
      ).join(" | ");
    }
    case "header":
      return renderSlackTextObject(block.text);
    case "markdown":
      return typeof block.text === "string" ? expandSlackDisplayMarkup(block.text) : "";
    default:
      return renderSlackTextObject(block.text);
  }
}

function renderSlackAttachment(value: unknown): string {
  const attachment = asRecord(value);
  if (!attachment) return "";
  const fields = Array.isArray(attachment.fields)
    ? attachment.fields.map((field) => {
        const record = asRecord(field);
        if (!record) return "";
        const title = asNonEmptyString(record.title);
        const valueText = asNonEmptyString(record.value);
        if (title && valueText) return `${title}: ${expandSlackDisplayMarkup(valueText)}`;
        return title ?? (valueText ? expandSlackDisplayMarkup(valueText) : "");
      })
    : [];
  const title = asNonEmptyString(attachment.title);
  const titleLink = asNonEmptyString(attachment.title_link) ?? asNonEmptyString(attachment.from_url);
  const titleText = titleLink && title && title !== titleLink ? `${title} (${titleLink})` : (title ?? titleLink ?? "");

  return uniqueRenderedSlackValues([
    asNonEmptyString(attachment.pretext) ? expandSlackDisplayMarkup(String(attachment.pretext)) : "",
    titleText,
    asNonEmptyString(attachment.text) ? expandSlackDisplayMarkup(String(attachment.text)) : "",
    ...fields,
    asNonEmptyString(attachment.fallback) ? expandSlackDisplayMarkup(String(attachment.fallback)) : "",
  ]).join("\n");
}

function renderSlackMessageText(message: SlackMessage): string {
  return uniqueRenderedSlackValues([
    Array.isArray(message.blocks) ? uniqueRenderedSlackValues(message.blocks.map(renderSlackBlock)).join("\n") : "",
    Array.isArray(message.attachments)
      ? uniqueRenderedSlackValues(message.attachments.map(renderSlackAttachment)).join("\n")
      : "",
    asNonEmptyString(message.text) ? expandSlackDisplayMarkup(String(message.text)) : "",
  ]).join("\n");
}

function invalidSlackToolInput(message: string): never {
  throw new SlackDynamicToolError(message, "invalid_input", 400);
}

function isSlackAccessRestrictionError(errorCode: string): boolean {
  return errorCode === "is_archived" || errorCode === "restricted_action" || errorCode.startsWith("restricted_action_");
}

function normalizeSlackToolInput(
  args: unknown,
  toolName: string,
  supportedFields: readonly string[],
): Record<string, unknown> {
  const input = asRecord(args);
  if (!input) {
    invalidSlackToolInput(`${toolName} requires an object input.`);
  }

  const extras = Object.keys(input).filter((key) => !supportedFields.includes(key));
  if (extras.length > 0) {
    invalidSlackToolInput(`${toolName} received unsupported fields: ${extras.join(", ")}.`);
  }

  return input;
}

function readRequiredSlackStringField(input: Record<string, unknown>, toolName: string, fieldName: string): string {
  const value = asNonEmptyString(input[fieldName]);
  if (!value) {
    invalidSlackToolInput(`${toolName} requires a non-empty '${fieldName}' string.`);
  }
  return value;
}

function readOptionalSlackStringField(
  input: Record<string, unknown>,
  toolName: string,
  fieldName: string,
): string | undefined {
  const rawValue = input[fieldName];
  if (rawValue === undefined) return undefined;
  const value = asNonEmptyString(rawValue);
  if (!value) {
    invalidSlackToolInput(`${toolName} requires '${fieldName}' to be a non-empty string when provided.`);
  }
  return value;
}

function readOptionalSlackIntegerField(
  input: Record<string, unknown>,
  toolName: string,
  fieldName: string,
): number | undefined {
  const rawValue = input[fieldName];
  if (rawValue === undefined) return undefined;
  const value = asCount(rawValue);
  if (value === null) {
    invalidSlackToolInput(`${toolName} requires '${fieldName}' to be an integer when provided.`);
  }
  return value;
}

function mapSlackApiError(tokenKind: SlackTokenKind, errorCode: string, fallback: string): SlackDynamicToolError {
  if (errorCode === "missing_scope" || errorCode === "no_permission") {
    return new SlackDynamicToolError(fallback, "scope_missing", 403);
  }
  if (isSlackAccessRestrictionError(errorCode)) {
    return new SlackDynamicToolError(fallback, "forbidden", 403);
  }
  if (errorCode === "ratelimited") {
    return new SlackDynamicToolError(fallback, "upstream_rate_limited", 429);
  }
  if (errorCode === "channel_not_found" || errorCode === "message_not_found" || errorCode === "thread_not_found") {
    return new SlackDynamicToolError(fallback, "not_found", 404);
  }
  if (
    errorCode === "invalid_auth" ||
    errorCode === "not_authed" ||
    errorCode === "account_inactive" ||
    errorCode === "token_revoked" ||
    errorCode === "token_expired"
  ) {
    return tokenKind === "workspace_bot"
      ? new SlackDynamicToolError(fallback, "workspace_uninstalled", 409)
      : new SlackDynamicToolError(fallback, "token_expired", 401);
  }
  return new SlackDynamicToolError(fallback, "upstream_error", 502);
}

function throwSlackApiBodyError(
  tokenKind: SlackTokenKind,
  method: string,
  rawErrorCode: unknown,
  options?: { logStructuredError?: boolean },
): never {
  const slackErrorCode = parseSlackErrorCode(rawErrorCode);
  const mapped = mapSlackApiError(tokenKind, slackErrorCode, `Slack ${method} failed.`);
  if (options?.logStructuredError !== false) {
    log.warn(
      {
        event: "slack_dynamic_tool_api_error",
        method,
        tokenKind,
        slackErrorCode: slackErrorCode || null,
        errorCode: mapped.code,
        status: mapped.status,
      },
      "Slack dynamic tool API error",
    );
  }
  throw mapped;
}

async function slackGet<T extends SlackApiResponse>(
  token: string,
  tokenKind: SlackTokenKind,
  method: string,
  query: Record<string, string>,
  options?: { logStructuredBodyError?: boolean },
): Promise<T> {
  const response = await tracedFetch(
    `${SLACK_API_BASE}/${method}?${new URLSearchParams(query).toString()}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    `slack.${method}`,
  );

  if (response.status === 429) {
    throw new SlackDynamicToolError(`Slack ${method} was rate limited.`, "upstream_rate_limited", 429);
  }
  if (!response.ok) {
    throw mapSlackApiError(tokenKind, "", `Slack ${method} failed with HTTP ${response.status}.`);
  }

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch {
    throw new SlackDynamicToolError(`Slack ${method} returned an invalid response body.`, "upstream_error", 502);
  }
  if (!body.ok) {
    throwSlackApiBodyError(tokenKind, method, body.error, { logStructuredError: options?.logStructuredBodyError });
  }
  return body;
}

async function slackPost<T extends SlackApiResponse>(
  token: string,
  tokenKind: SlackTokenKind,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await tracedFetch(
    `${SLACK_API_BASE}/${method}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    },
    `slack.${method}`,
  );

  if (response.status === 429) {
    throw new SlackDynamicToolError(`Slack ${method} was rate limited.`, "upstream_rate_limited", 429);
  }
  if (!response.ok) {
    throw mapSlackApiError(tokenKind, "", `Slack ${method} failed with HTTP ${response.status}.`);
  }

  let payload: T;
  try {
    payload = (await response.json()) as T;
  } catch {
    throw new SlackDynamicToolError(`Slack ${method} returned an invalid response body.`, "upstream_error", 502);
  }
  if (!payload.ok) {
    throwSlackApiBodyError(tokenKind, method, payload.error);
  }
  return payload;
}

function normalizeGetThreadInput(args: unknown): SlackGetThreadInput {
  const input = normalizeSlackToolInput(args, "Slack get_thread", ["channel", "ts"]);
  return {
    channel: readRequiredSlackStringField(input, "Slack get_thread", "channel"),
    ts: readRequiredSlackStringField(input, "Slack get_thread", "ts"),
  };
}

function normalizeSearchMessagesInput(args: unknown): SlackSearchMessagesInput {
  const input = normalizeSlackToolInput(args, "Slack search_messages", ["query", "channel", "count"]);

  const query = readRequiredSlackStringField(input, "Slack search_messages", "query");
  const channel = readOptionalSlackStringField(input, "Slack search_messages", "channel");
  const countValue = readOptionalSlackIntegerField(input, "Slack search_messages", "count");

  if (countValue != null && (countValue < 1 || countValue > SLACK_SEARCH_MAX_COUNT)) {
    invalidSlackToolInput(`Slack search_messages requires 'count' to be between 1 and ${SLACK_SEARCH_MAX_COUNT}.`);
  }
  if (channel && looksLikeSlackConversationId(channel)) {
    invalidSlackToolInput(
      "Slack search_messages requires 'channel' to be a Slack channel name like 'general', not a channel ID.",
    );
  }

  return {
    query,
    ...(channel ? { channel } : {}),
    ...(countValue != null ? { count: countValue } : {}),
  };
}

function normalizeSendMessageInput(args: unknown): SlackSendMessageInput {
  const input = normalizeSlackToolInput(args, "Slack send_message", ["channel", "threadTs", "text"]);
  const channel = readRequiredSlackStringField(input, "Slack send_message", "channel");
  const threadTs = readOptionalSlackStringField(input, "Slack send_message", "threadTs");
  const text = readRequiredSlackStringField(input, "Slack send_message", "text");
  if (text.length > SLACK_TEXT_MAX_CHARS) {
    invalidSlackToolInput(`Slack send_message requires 'text' to be at most ${SLACK_TEXT_MAX_CHARS} characters.`);
  }
  return { channel, ...(threadTs ? { threadTs } : {}), text };
}

function resolveBoundSlackSendTarget(
  input: SlackSendMessageInput,
  callbackContext: SlackCallbackContext | null | undefined,
): { channel: string; threadTs: string } {
  if (!callbackContext) {
    throw new SlackDynamicToolError(
      "Slack send_message is only available for Slack-originated sessions with a bound reply thread.",
      "workspace_unknown",
      409,
    );
  }
  if (!callbackContext.threadTs) {
    // Scheduled automations bind a channel-only context (no thread) and deliver
    // a single plain top-level digest at completion. The agent must not post
    // directly — that would emit an extra top-level message and break the
    // single-message contract. Fail closed.
    throw new SlackDynamicToolError(
      "Slack send_message is unavailable for this session: it delivers a single top-level message with no bound reply thread.",
      "invalid_input",
      400,
    );
  }
  if (input.channel !== callbackContext.channel) {
    throw new SlackDynamicToolError(
      "Slack send_message is restricted to the Slack channel that started this session.",
      "invalid_input",
      400,
    );
  }
  if (input.threadTs && input.threadTs !== callbackContext.threadTs) {
    throw new SlackDynamicToolError(
      "Slack send_message is restricted to the Slack thread that started this session.",
      "invalid_input",
      400,
    );
  }
  return { channel: callbackContext.channel, threadTs: callbackContext.threadTs };
}

async function requireSlackWorkspaceBotToken(env: Env, slackTeamId: string | null): Promise<string> {
  if (!slackTeamId) {
    throw new SlackDynamicToolError(
      "Slack tools are only available for Slack-originated sessions with a known workspace binding.",
      "workspace_unknown",
      409,
    );
  }
  const token = await resolveInstalledSlackBotToken(env, slackTeamId);
  if (!token) {
    throw new SlackDynamicToolError(
      "Slack workspace bot token is unavailable for this session.",
      "workspace_uninstalled",
      409,
    );
  }
  return token;
}

async function requireSlackUserToken(env: Env, ownerUserId: string): Promise<string> {
  const tokens = await getSlackUserTokens(env.DB, ownerUserId, env.TOKEN_ENCRYPTION_KEY);
  const accessToken = tokens?.accessToken?.trim() ?? "";
  if (!accessToken) {
    throw new SlackDynamicToolError(
      "Slack search requires the session owner to connect their Slack account.",
      "not_connected",
      409,
    );
  }
  return accessToken;
}

function normalizeThreadMessage(
  message: SlackMessage,
): { user: string | null; ts: string; text: string; threadTs: string | null } | null {
  const ts = asNonEmptyString(message.ts);
  const text = asNonEmptyString(message.text);
  if (!ts) return null;
  const renderedText = renderSlackMessageText(message);
  return {
    user: asNonEmptyString(message.user),
    ts,
    text: truncateSlackText(renderedText || text || ""),
    threadTs: asNonEmptyString(message.thread_ts),
  };
}

function normalizeSearchMatch(match: unknown): SlackSearchMessagesResult["matches"][number] | null {
  const record = asRecord(match);
  if (!record) return null;
  const ts = asNonEmptyString(record.ts);
  if (!ts) return null;
  const channel = asRecord(record.channel);
  return {
    channel: asNonEmptyString(channel?.id),
    channelName: asNonEmptyString(channel?.name),
    ts,
    text: truncateSlackText(asNonEmptyString(record.text) ?? ""),
    permalink: asNonEmptyString(record.permalink),
    user: asNonEmptyString(record.user),
    username: asNonEmptyString(record.username),
    threadTs: asNonEmptyString(record.thread_ts),
  };
}

export async function runSlackGetThreadTool(params: {
  env: Env;
  slackTeamId: string | null;
  args: unknown;
}): Promise<SlackGetThreadResult> {
  const input = normalizeGetThreadInput(params.args);
  const token = await requireSlackWorkspaceBotToken(params.env, params.slackTeamId);
  const response = await slackGet<SlackThreadResponse>(token, "workspace_bot", "conversations.replies", {
    channel: input.channel,
    ts: input.ts,
    limit: String(SLACK_THREAD_LIMIT),
  });
  const messages = Array.isArray(response.messages)
    ? response.messages
        .map((message) => normalizeThreadMessage(message as SlackMessage))
        .filter((message): message is NonNullable<typeof message> => message !== null)
    : [];
  return { messages };
}

export async function runSlackSearchMessagesTool(params: {
  env: Env;
  ownerUserId: string;
  args: unknown;
}): Promise<SlackSearchMessagesResult> {
  const input = normalizeSearchMessagesInput(params.args);
  const token = await requireSlackUserToken(params.env, params.ownerUserId);
  const query = input.channel ? `${input.query} in:${input.channel}` : input.query;
  const response = await slackGet<SlackSearchResponse>(token, "user", "search.messages", {
    query,
    count: String(input.count ?? SLACK_SEARCH_DEFAULT_COUNT),
    sort: "timestamp",
    sort_dir: "desc",
    highlight: "false",
  });
  const matches = Array.isArray(response.messages?.matches)
    ? response.messages.matches
        .map((match) => normalizeSearchMatch(match))
        .filter((match): match is NonNullable<typeof match> => match !== null)
    : [];
  return { matches };
}

export async function runSlackSendMessageTool(params: {
  env: Env;
  ownerUserId: string;
  sessionId: string;
  slackTeamId: string | null;
  callbackContext?: SlackCallbackContext | null;
  args: unknown;
}): Promise<SlackSendMessageResult> {
  const input = normalizeSendMessageInput(params.args);
  const boundTarget = resolveBoundSlackSendTarget(input, params.callbackContext);
  const token = await requireSlackWorkspaceBotToken(params.env, params.slackTeamId);
  const response = await slackPost<SlackPostMessageResponse>(token, "workspace_bot", "chat.postMessage", {
    channel: boundTarget.channel,
    thread_ts: boundTarget.threadTs,
    text: input.text,
    unfurl_links: false,
    unfurl_media: false,
  });
  const ts = asNonEmptyString(response.ts);
  const channel = asNonEmptyString(response.channel) ?? boundTarget.channel;
  if (!ts) {
    throw new SlackDynamicToolError("Slack chat.postMessage returned no message timestamp.", "upstream_error", 502);
  }
  let permalink: string | null = null;
  try {
    const permalinkResponse = await slackGet<SlackPermalinkResponse>(
      token,
      "workspace_bot",
      "chat.getPermalink",
      {
        channel,
        message_ts: ts,
      },
      { logStructuredBodyError: false },
    );
    permalink = asNonEmptyString(permalinkResponse.permalink);
  } catch (error) {
    log.warn(
      { event: "dynamic_tool_write_permalink_lookup_failed", tool: "slack.send_message", sessionId: params.sessionId },
      `Slack chat.getPermalink failed after postMessage: ${String(error)}`,
    );
  }
  const result = {
    ts,
    channel,
    permalink,
  };
  log.info(
    {
      event: "dynamic_tool_write",
      tool: "slack.send_message",
      userId: params.ownerUserId,
      sessionId: params.sessionId,
      targetChannel: boundTarget.channel,
      targetThreadTs: boundTarget.threadTs,
      textLength: input.text.length,
      outcome: "ok",
    },
    "Slack dynamic tool write",
  );
  return result;
}

export function toSlackDynamicToolFailureResponse(error: unknown): {
  ok: false;
  errorCode: SlackDynamicToolErrorCode;
  error: string;
  status: number;
} {
  if (error instanceof SlackDynamicToolError) {
    return {
      ok: false,
      errorCode: error.code,
      error: error.message,
      status: error.status,
    };
  }
  log.error({ error: String(error) }, "Slack dynamic tool failed unexpectedly");
  return {
    ok: false,
    errorCode: "upstream_error",
    error: "Slack dynamic tool failed unexpectedly.",
    status: 502,
  };
}
