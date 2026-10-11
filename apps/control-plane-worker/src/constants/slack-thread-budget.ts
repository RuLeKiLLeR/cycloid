/**
 * Thread-budget substrate constants (slack/thread-budget.ts).
 *
 * Budget law: at most 3 Cycloid messages per session thread — the status card,
 * one unresolved ask at a time, and the result. Everything else updates in
 * place or stays silent.
 */

/**
 * Maximum ask-anchor REPAIRS (re-posts after Slack reports the anchored ask
 * message lost). Not a "new asks" allowance — new asks always supersede the
 * anchor via chat.update.
 */
export const SLACK_MAX_ASK_REPOSTS_PER_SESSION = 3;

/** Minimum spacing (unix-ms) between narration chat.update edits of the status card. */
export const NARRATION_MIN_UPDATE_INTERVAL_MS = 3000;

/**
 * Slack chat.update error codes that mean the anchored message is gone (deleted
 * message / deleted channel). These are the only failures that justify a
 * bounded repair re-post; every other error is surfaced to the caller.
 */
export const SLACK_LOST_ANCHOR_ERROR_CODES = ["message_not_found", "channel_not_found"] as const;
