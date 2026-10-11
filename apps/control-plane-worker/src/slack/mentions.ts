import { stringifyError } from "../../../../shared/utils/errors.js";
import { createLogger } from "../logger";
import { getUserInfo, type SlackUserInfo } from "./notify";

const log = createLogger({ bindings: { component: "slack-mentions" } });

// Slack encodes user mentions as `<@U...>` (regular users) or `<@W...>`
// (enterprise-grid users), optionally with a label suffix `<@U...|name>` (Slack
// Connect, some bot/legacy formats). Capture the ID and discard any label. Both
// render paths in the webhook converge on these tokens, so one pass over the
// final string catches every mention.
const SLACK_MENTION_PATTERN = "<@([UW][A-Z0-9]+)(?:\\|[^>]*)?>";

// Bound the work done per message: protects webhook latency and the Slack
// `users.info` rate limit. Overflow tokens past this cap are left unresolved.
const MAX_UNIQUE_MENTIONS = 25;

const CACHE_PREFIX = "slack-user:";
const POSITIVE_TTL_SECONDS = 24 * 60 * 60; // 24h: display names change rarely.
const NEGATIVE_TTL_SECONDS = 60 * 60; // 1h: stop re-hitting the API for unresolvable IDs.
// Empty string marks a known-unresolved ID (missing scope, deactivated/unknown
// user). A real resolved name is never empty after sanitization.
const NEGATIVE_SENTINEL = "";

const MAX_NAME_LENGTH = 80;

export interface ResolveSlackMentionsOptions {
  /** Workspace bot token. Null skips resolution (fail open). */
  token: string | null;
  /** Cache namespace. Absent disables caching but still resolves. */
  kv: KVNamespace | null | undefined;
  /** Slack team ID. Null skips resolution: no workspace boundary for the cache. */
  teamId: string | null;
  /**
   * When true (agent-prompt surface), keep the stable ID alongside the name as
   * `@Name (<@ID>)`. A display name is self-set and untrusted; retaining the ID
   * prevents a crafted name from impersonating another user to the agent. When
   * false (UI display surface), substitute `@Name` to match Slack's rendering.
   */
  keepRawId?: boolean;
}

/**
 * Resolve Slack `<@ID>` user mentions to display names. Cosmetic and fail-open:
 * any missing token/team, cache error, or `users.info` failure leaves the raw
 * token in place and never blocks task creation.
 */
export async function resolveSlackMentions(text: string, opts: ResolveSlackMentionsOptions): Promise<string> {
  const { token, kv, teamId, keepRawId = false } = opts;
  if (!text) return text;

  const ids = extractUniqueMentionIds(text);
  if (ids.length === 0) return text;
  if (!token || !teamId) return text;

  const resolvable = ids.slice(0, MAX_UNIQUE_MENTIONS);
  const names = new Map<string, string>();
  await Promise.all(
    resolvable.map(async (id) => {
      const name = await resolveOneMention(id, token, kv, teamId);
      if (name) names.set(id, name);
    }),
  );
  if (names.size === 0) return text;

  return text.replace(new RegExp(SLACK_MENTION_PATTERN, "g"), (raw, id: string) => {
    const name = names.get(id);
    if (!name) return raw;
    return keepRawId ? `@${name} (<@${id}>)` : `@${name}`;
  });
}

function extractUniqueMentionIds(text: string): string[] {
  const regex = new RegExp(SLACK_MENTION_PATTERN, "g");
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of text.matchAll(regex)) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

async function resolveOneMention(
  userId: string,
  token: string,
  kv: KVNamespace | null | undefined,
  teamId: string,
): Promise<string | null> {
  const cacheKey = `${CACHE_PREFIX}${teamId}:${userId}`;

  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        return cached === NEGATIVE_SENTINEL ? null : cached;
      }
    } catch (error) {
      log.debug({ error: stringifyError(error), userId }, "Slack mention cache read failed; resolving live");
    }
  }

  let resolvedName: string | null = null;
  let lookupThrew = false;
  try {
    const info = await getUserInfo(token, userId);
    resolvedName = info ? pickDisplayName(info) : null;
  } catch (error) {
    // A thrown error (DNS, timeout, fetch failure) is transient, unlike a
    // stable `ok:false` (missing scope, deactivated user). Skip the cache write
    // so the next message retries instead of being silenced for the negative
    // TTL after the network recovers.
    lookupThrew = true;
    log.debug({ error: stringifyError(error), userId }, "Slack users.info threw; leaving mention unresolved");
  }

  if (kv && !lookupThrew) {
    try {
      await kv.put(cacheKey, resolvedName ?? NEGATIVE_SENTINEL, {
        expirationTtl: resolvedName ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
      });
    } catch (error) {
      log.debug({ error: stringifyError(error), userId }, "Slack mention cache write failed");
    }
  }

  return resolvedName;
}

/** First non-empty of display_name -> real_name -> name, sanitized. */
function pickDisplayName(info: SlackUserInfo): string | null {
  const candidate = firstNonEmpty(info.displayName, info.realName, info.name);
  if (!candidate) return null;
  const sanitized = sanitizeName(candidate);
  return sanitized.length > 0 ? sanitized : null;
}

function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Strip newlines and angle brackets and collapse whitespace so a self-set
 * display name cannot inject prompt structure, fake a `<@…>` token, or break
 * markdown quoting when substituted into rendered text.
 */
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_NAME_LENGTH ? `${cleaned.slice(0, MAX_NAME_LENGTH)}…` : cleaned;
}
