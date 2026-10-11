import { stringifyError } from "../../../../shared/utils/errors.js";
import { SLACK_API_BASE, SLACK_THREAD_CONTEXT_MAX_MESSAGES } from "../constants/slack";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";

const log = createLogger({ bindings: { component: "slack-api" } });

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export interface SlackThreadMessage {
  user?: string;
  text?: string;
  ts?: string;
  type?: string;
  subtype?: string;
  bot_id?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: unknown[];
}

export interface SlackPostMessageResponse extends SlackApiResponse {
  ts?: string;
  channel?: string;
}

interface SlackUploadUrlResponse extends SlackApiResponse {
  upload_url?: string;
  file_id?: string;
}

interface SlackRepliesResponse extends SlackApiResponse {
  messages?: SlackThreadMessage[];
}

interface SlackConversationInfo {
  id: string;
  name: string | null;
  isChannel: boolean;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
  /** Whether the installed bot is a member of the channel (can post with chat:write). */
  isMember: boolean;
}

interface SlackConversationInfoResponse extends SlackApiResponse {
  channel?: {
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_member?: boolean;
  };
}

function extractSlackMessages(result: Record<string, unknown>): string | undefined {
  const responseMeta = result.response_metadata;
  if (!responseMeta || typeof responseMeta !== "object") {
    return undefined;
  }
  const messages = (responseMeta as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const textMessages = messages.filter((message): message is string => typeof message === "string");
  return textMessages.length > 0 ? textMessages.join("; ") : undefined;
}

function logSlackApiFailure(
  method: string,
  result: SlackApiResponse & Record<string, unknown>,
  httpStatus: number,
  details: Record<string, unknown> = {},
): void {
  log
    .child({ slackMethod: method })
    .error(
      { error: result.error, slackMessages: extractSlackMessages(result), httpStatus, ...details },
      "Slack API call failed",
    );
}

// Slack returns HTTP 429 with a `Retry-After` (seconds) header when rate limited.
// Honor it instead of treating the throttle as a hard failure that drops the message.
const SLACK_RATE_LIMIT_MAX_RETRIES = 3;
const SLACK_RATE_LIMIT_DEFAULT_WAIT_MS = 1_000;
const SLACK_RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** Parse Slack's `Retry-After` (integer seconds) into ms, clamped and with a sane default. */
export function parseSlackRetryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : SLACK_RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(SLACK_RATE_LIMIT_MAX_WAIT_MS, ms);
}

/**
 * Strip message content from a Slack request body before it reaches a log line.
 * `chat.postMessage` (incl. DMs) carries `text`/`blocks`/`attachments` that may
 * include user- or session-specific copy; we log only the stable routing
 * metadata so message bodies never land in logs.
 */
export function redactSlackBodyForLog(body: Record<string, unknown>): Record<string, unknown> {
  const { text, blocks, attachments, initial_comment, ...rest } = body;
  return {
    ...rest,
    ...(text !== undefined ? { text: "[redacted]" } : {}),
    ...(blocks !== undefined ? { blocks: "[redacted]" } : {}),
    ...(attachments !== undefined ? { attachments: "[redacted]" } : {}),
    ...(initial_comment !== undefined ? { initial_comment: "[redacted]" } : {}),
  };
}

async function slackApi<T extends SlackApiResponse = SlackApiResponse>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  encoding: "json" | "form" = "json",
): Promise<T> {
  log.debug({ method, body: redactSlackBodyForLog(body) }, "Slack API call");
  const init = {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type":
        encoding === "form" ? "application/x-www-form-urlencoded; charset=utf-8" : "application/json; charset=utf-8",
    },
    body:
      encoding === "form"
        ? new URLSearchParams(
            Object.entries(body).map(([k, v]) => {
              if (v !== null && v !== undefined && typeof v === "object") {
                throw new Error(`slackApi: form encoding does not support object value for key "${k}"`);
              }
              return [k, String(v)];
            }),
          ).toString()
        : JSON.stringify(body),
  };

  for (let attempt = 0; ; attempt++) {
    const response = await tracedFetch(`${SLACK_API_BASE}/${method}`, init, `slack.${method}`);
    if (response.status === 429 && attempt < SLACK_RATE_LIMIT_MAX_RETRIES) {
      const waitMs = parseSlackRetryAfterMs(response.headers.get("retry-after") ?? null);
      log
        .child({ slackMethod: method })
        .warn({ httpStatus: 429, attempt, waitMs }, "Slack API rate limited; honoring Retry-After before retrying");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (response.status === 429) {
      // Reached only after the retry branch above exhausted its budget. Emit a
      // distinct log so an operator can tell this 429 ended a full retry cycle
      // rather than being a first-and-only failure.
      log
        .child({ slackMethod: method })
        .warn({ httpStatus: 429, attempt }, "Slack API rate limited; retry budget exhausted");
      return { ok: false, error: "ratelimited" } as T;
    }
    const result = (await response.json()) as T;
    if (!result.ok) {
      logSlackApiFailure(method, result as T & Record<string, unknown>, response.status);
    }
    return result;
  }
}

export async function postThreadReply(
  token: string,
  channel: string,
  threadTs: string | undefined,
  text: string,
  blocks?: unknown[],
  attachments?: unknown[],
): Promise<SlackPostMessageResponse> {
  return slackApi<SlackPostMessageResponse>(token, "chat.postMessage", {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
    ...(blocks ? { blocks } : {}),
    ...(attachments ? { attachments } : {}),
  });
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
  attachments?: unknown[],
): Promise<SlackPostMessageResponse> {
  return slackApi<SlackPostMessageResponse>(token, "chat.postMessage", {
    channel,
    text,
    ...(blocks ? { blocks } : {}),
    ...(attachments ? { attachments } : {}),
  });
}

interface SlackConversationOpenResponse extends SlackApiResponse {
  channel?: { id?: string };
}

/** Open (or fetch) the IM channel with a user. Returns the channel id or null. */
export async function openDirectMessage(token: string, userId: string): Promise<string | null> {
  const result = await slackApi<SlackConversationOpenResponse>(token, "conversations.open", { users: userId });
  if (!result.ok || !result.channel?.id) return null;
  return result.channel.id;
}

/**
 * DM a user. Opens the IM channel first, then posts with link/media unfurling
 * disabled (magic links and similar should not render preview cards). Returns
 * `{ ok: false }` if the IM could not be opened.
 */
export async function postDirectMessage(
  token: string,
  userId: string,
  text: string,
  blocks?: unknown[],
): Promise<SlackPostMessageResponse> {
  const channelId = await openDirectMessage(token, userId);
  if (!channelId) return { ok: false, error: "dm_open_failed" };
  return slackApi<SlackPostMessageResponse>(token, "chat.postMessage", {
    channel: channelId,
    text,
    ...(blocks ? { blocks } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
}

export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[],
  attachments?: unknown[],
): Promise<SlackApiResponse> {
  return slackApi(token, "chat.update", {
    channel,
    ts,
    text,
    ...(blocks ? { blocks } : {}),
    attachments: attachments ?? [],
  });
}

interface DeliverThreadStatusParams {
  token: string;
  channel: string;
  threadTs: string | undefined;
  statusMessageTs: string | undefined;
  text: string;
  blocks: unknown[];
  attachments?: unknown[];
}

interface DeliverThreadStatusResult extends SlackApiResponse {
  updatedInPlace: boolean;
  fallbackTs?: string;
}

function combineFallbackErrors(updateError: string | undefined, replyError: string | undefined): string | undefined {
  if (updateError && replyError) return `update: ${updateError}; fallback: ${replyError}`;
  return updateError ?? replyError;
}

/**
 * Update the durable status card in place; when the anchored message is gone,
 * fall back to a new post. The fallback is card-anchor REPAIR under the
 * thread-budget law (callers re-persist `fallbackTs` as the new
 * `statusMessageTs`), not budget growth — the card slot is simply re-seated.
 */
export async function deliverThreadStatus(params: DeliverThreadStatusParams): Promise<DeliverThreadStatusResult> {
  const { token, channel, threadTs, statusMessageTs, text, blocks, attachments } = params;

  if (statusMessageTs) {
    let updateError: string | undefined;
    try {
      const updateResult = await updateMessage(token, channel, statusMessageTs, text, blocks, attachments);
      if (updateResult.ok) {
        return { ok: true, updatedInPlace: true };
      }
      updateError = updateResult.error;
    } catch (err) {
      updateError = stringifyError(err);
    }

    const replyResult = await postThreadReply(token, channel, threadTs, text, blocks, attachments);
    return {
      ok: replyResult.ok,
      updatedInPlace: false,
      fallbackTs: replyResult.ts,
      error: combineFallbackErrors(updateError, replyResult.error),
    };
  }

  const replyResult = await postThreadReply(token, channel, threadTs, text, blocks, attachments);
  return { ok: replyResult.ok, updatedInPlace: false, fallbackTs: replyResult.ts, error: replyResult.error };
}

export async function uploadFile(
  token: string,
  channel: string,
  threadTs: string,
  filename: string,
  content: string,
  // ci-sync
  initialComment?: string,
): Promise<SlackApiResponse> {
  const length = new TextEncoder().encode(content).byteLength;

  // Step 1: Get presigned upload URL
  // files.getUploadURLExternal requires application/x-www-form-urlencoded, not JSON
  const urlResp = await slackApi<SlackUploadUrlResponse>(
    token,
    "files.getUploadURLExternal",
    { filename, length },
    "form",
  );
  if (!urlResp.ok || !urlResp.upload_url || !urlResp.file_id) {
    return urlResp;
  }

  // Step 2: Upload content to presigned URL.
  // Use raw fetch (not tracedFetch) to avoid injecting traceparent or other
  // headers that would break Slack's signed URL validation.
  const putResp = await fetch(urlResp.upload_url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: content,
  });
  if (!putResp.ok) {
    log.error({ status: putResp.status, filename }, "Slack file upload to presigned URL failed");
    return { ok: false, error: `upload_failed_${putResp.status}` };
  }

  // Step 3: Complete upload and share to channel thread
  return slackApi(token, "files.completeUploadExternal", {
    files: [{ id: urlResp.file_id, title: filename }],
    channel_id: channel,
    thread_ts: threadTs,
    ...(initialComment !== undefined ? { initial_comment: initialComment } : {}),
  });
}

export async function addReaction(
  token: string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<SlackApiResponse> {
  return slackApi(token, "reactions.add", { channel, timestamp, name });
}

export async function removeReaction(
  token: string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<SlackApiResponse> {
  return slackApi(token, "reactions.remove", { channel, timestamp, name });
}

interface SlackAuthTestResponse extends SlackApiResponse {
  user_id?: string;
  bot_id?: string;
}

const slackBotUserIdCache = new Map<string, string>();

/**
 * Get the bot user ID via Slack's `auth.test` endpoint.
 * Returns null on failure so callers can degrade gracefully.
 */
export async function getSlackBotUserId(token: string): Promise<string | null> {
  const cachedUserId = slackBotUserIdCache.get(token);
  if (cachedUserId) return cachedUserId;

  log.debug({ method: "auth.test" }, "Slack API call");
  const response = await tracedFetch(
    `${SLACK_API_BASE}/auth.test`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
    "slack.auth.test",
  );
  const result = (await response.json()) as SlackAuthTestResponse;
  if (!result.ok || typeof result.user_id !== "string") {
    logSlackApiFailure("auth.test", result as SlackAuthTestResponse & Record<string, unknown>, response.status);
    return null;
  }
  slackBotUserIdCache.set(token, result.user_id);
  return result.user_id;
}

/**
 * Fetch all replies in a Slack thread via `conversations.replies`.
 * Returns an empty array on failure so callers can degrade gracefully.
 */
export async function getThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
  limit = SLACK_THREAD_CONTEXT_MAX_MESSAGES,
): Promise<SlackThreadMessage[]> {
  // conversations.replies is a read method -- Slack requires query params, not JSON body
  const requestParams = { channel, ts: threadTs, limit };
  const params = new URLSearchParams({ channel, ts: threadTs, limit: String(limit) });
  log.debug({ method: "conversations.replies", params: requestParams }, "Slack API call");
  const response = await tracedFetch(
    `${SLACK_API_BASE}/conversations.replies?${params}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    "slack.conversations.replies",
  );
  const result = (await response.json()) as SlackRepliesResponse;
  if (!result.ok) {
    logSlackApiFailure(
      "conversations.replies",
      result as SlackRepliesResponse & Record<string, unknown>,
      response.status,
      { params: requestParams },
    );
    return [];
  }
  if (!Array.isArray(result.messages)) {
    return [];
  }
  return result.messages;
}

interface SlackUserInfoResponse extends SlackApiResponse {
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

/** Normalized Slack user identity. Name precedence is decided by the caller. */
export interface SlackUserInfo {
  id: string;
  displayName: string | null;
  realName: string | null;
  name: string | null;
}

/**
 * Fetch Slack user identity via `users.info`. Returns null on `ok:false`
 * (e.g. `missing_scope`, deactivated/unknown user) or HTTP failure so callers
 * can fail open and keep the raw `<@ID>` token. Requires the `users:read` scope.
 */
export async function getUserInfo(token: string, userId: string): Promise<SlackUserInfo | null> {
  const requestParams = { user: userId };
  const params = new URLSearchParams({ user: userId });
  log.debug({ method: "users.info", params: requestParams }, "Slack API call");
  const response = await tracedFetch(
    `${SLACK_API_BASE}/users.info?${params}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    "slack.users.info",
  );
  const result = (await response.json()) as SlackUserInfoResponse;
  if (!result.ok) {
    logSlackApiFailure("users.info", result as SlackUserInfoResponse & Record<string, unknown>, response.status, {
      params: requestParams,
    });
    return null;
  }

  const user = result.user;
  if (!user || typeof user.id !== "string") {
    return null;
  }

  const profile = user.profile ?? {};
  return {
    id: user.id,
    displayName: typeof profile.display_name === "string" ? profile.display_name : null,
    realName:
      typeof profile.real_name === "string"
        ? profile.real_name
        : typeof user.real_name === "string"
          ? user.real_name
          : null,
    name: typeof user.name === "string" ? user.name : null,
  };
}

/**
 * Fetch Slack conversation metadata. Returns null on failure so callers can
 * continue without channel names when Slack lacks scope or the API is down.
 */
export async function getConversationInfo(token: string, channel: string): Promise<SlackConversationInfo | null> {
  const requestParams = { channel };
  const params = new URLSearchParams({ channel });
  log.debug({ method: "conversations.info", params: requestParams }, "Slack API call");
  const response = await tracedFetch(
    `${SLACK_API_BASE}/conversations.info?${params}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    "slack.conversations.info",
  );
  const result = (await response.json()) as SlackConversationInfoResponse;
  if (!result.ok) {
    logSlackApiFailure(
      "conversations.info",
      result as SlackConversationInfoResponse & Record<string, unknown>,
      response.status,
      { params: requestParams },
    );
    return null;
  }

  const conversation = result.channel;
  if (!conversation || typeof conversation.id !== "string") {
    return null;
  }

  return {
    id: conversation.id,
    name: typeof conversation.name === "string" ? conversation.name : null,
    isChannel: Boolean(conversation.is_channel),
    isPrivate: Boolean(conversation.is_private),
    isIm: Boolean(conversation.is_im),
    isMpim: Boolean(conversation.is_mpim),
    isMember: Boolean(conversation.is_member),
  };
}
