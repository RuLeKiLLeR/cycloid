// Slack channel IDs for Cycloid-internal operator alerts in the `trycycloid`
// workspace. These are non-secret routing config, not credentials, so they live
// in code rather than SSM (SSM is for secrets only). All point at private,
// Cycloid-internal channels; the bot behind `SLACK_BOT_TOKEN` must be a member.
//
// Delivery still gates on `SLACK_BOT_TOKEN`, which is env-scoped: QA has no bot
// token, so these posts no-op there. See docs/slack-channels.md for the
// name -> ID map.

/** #cycloid-signups -- pending-signup notifications (carries name + email PII). */
export const PENDING_SIGNUP_NOTIFY_CHANNEL_ID = "C0BD5UM1N6A";

/** #session-feedback -- thumbs up/down feedback on a session. */
export const SESSION_FEEDBACK_CHANNEL_ID = "C0AN2RWPE0Z";

/** #memory-feedback -- memory usage feedback + memory-review-bot summaries. */
export const MEMORY_FEEDBACK_CHANNEL_ID = "C0B9G5TCATB";

/** #cycloid-memory -- memory PRs opened for trycycloid/cycloid. */
export const MEMORY_PR_CHANNEL_ID = "C0AQ18R4B8A";

/** #customer-session-tracking -- internal flywheel tracking for prod external-customer sessions (internal Cycloid dogfood excluded). */
export const CUSTOMER_SESSION_TRACKING_CHANNEL_ID = "C0BDFUCL9JP";

/** #project-code-review -- Zeus PR-review runs that surfaced actionable findings. */
export const PROJECT_CODE_REVIEW_CHANNEL_ID = "C0BGG6KD1PY";

/** #session-monitoring -- human GitHub activity on Cycloid-generated PRs; currently shares #customer-session-tracking. */
export const SESSION_MONITORING_CHANNEL_ID = CUSTOMER_SESSION_TRACKING_CHANNEL_ID;
