import {
  MAX_UPLOADED_FILES,
  MAX_UPLOADED_IMAGES,
  UPLOADED_FILE_EXTENSIONS,
} from "../../../../shared/constants/uploads.js";

/** Base URL for Slack Web API. */
export const SLACK_API_BASE = "https://slack.com/api";

/**
 * Re-notify cadence for the DO-local "Cycloid done needs operator attention" alert dedup key.
 * A persistent failure can alert again after this window; within it, same-fingerprint re-dispatches dedupe.
 */
export const CYCLOID_DONE_ATTENTION_ALERT_DEDUP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Internal channel for "review loop turned CI red" operator alerts (#review-loop-feedback).
 * A channel id (not a name): chat.postMessage resolves ids reliably, whereas a `#name` is
 * deprecated for bot tokens and can 404.
 */
export const REVIEW_LOOP_FEEDBACK_SLACK_CHANNEL = "C0BA83SNN1G";

/** When truncating, look for a sentence break after this percentage of the limit. */
export const SLACK_SMART_TRUNCATION_THRESHOLD = 0.5;

/** Slack Block Kit rejects messages with more than 50 blocks total. */
export const SLACK_BLOCK_KIT_MAX_BLOCKS = 50;

/** Slack mrkdwn section text is capped at 3000 characters. */
export const SLACK_BLOCK_SECTION_TEXT_LIMIT = 3000;

/** Slack truncates the top-level message `text` field past 40,000 characters. */
export const SLACK_MESSAGE_TEXT_LIMIT = 40000;

/** Maximum characters of quoted parent-message context in a mirrored Slack reply. */
export const SLACK_REPLY_QUOTE_TEXT_LIMIT = 500;

/** Maximum number of prior thread messages to fetch via conversations.replies. */
export const SLACK_THREAD_CONTEXT_MAX_MESSAGES = 50;

/** Maximum total characters of thread context to include in the bootstrap prompt. */
export const SLACK_THREAD_CONTEXT_MAX_CHARS = 10_000;

/** Slack OAuth v2 token endpoint (used for code exchange and token refresh). */
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

/**
 * Action-id namespace for durable Slack interaction requests:
 * `cycloid:<kind>:<requestId>` (kinds in enums/slack-interaction.ts). The
 * interactions webhook only dispatches ids under this prefix through the
 * request-row consume path.
 */
export const SLACK_INTERACTION_ACTION_PREFIX = "cycloid";

/**
 * Retention for terminal (consumed/expired/superseded) slack_interaction_requests
 * rows before the hourly GC deletes them. Terminal rows only serve the
 * "already handled" replay reply and debugging; a click replayed after pruning
 * still fails closed (request not found).
 */
export const SLACK_INTERACTION_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Lifetime of a Slack magic-link identity-binding token. Short on purpose: the
 * link is DMed on demand and consumed once, so it never needs to outlive a
 * single sign-in. Matches the OAuth state cookie window.
 */
export const SLACK_LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Maximum number of Slack files to attempt from one signed event payload. */
export const SLACK_MAX_ATTACHMENTS_PER_EVENT = MAX_UPLOADED_FILES + MAX_UPLOADED_IMAGES;

/** Maximum number of unique Slack files to attempt from one thread bootstrap. */
export const SLACK_MAX_ATTACHMENTS_PER_THREAD = SLACK_MAX_ATTACHMENTS_PER_EVENT;

/** Text-like MIME types accepted from Slack when the type is not in the text/* family. */
export const SLACK_TEXT_ATTACHMENT_MIME_TYPES = [
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  "application/x-sh",
] as const;

/** File extensions accepted from Slack as text prompt context after UTF-8 decoding. */
export const SLACK_TEXT_ATTACHMENT_EXTENSIONS = [
  ...UPLOADED_FILE_EXTENSIONS,
  ".log",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".toml",
  ".ini",
] as const;
