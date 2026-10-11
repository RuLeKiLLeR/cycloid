/**
 * Which surface created a session. Powers the "Entrypoint" line in the
 * customer-session-tracking Slack alert so we can tell at a glance whether a
 * session came from the API/CLI/UI, a child spawn, a chat integration, or
 * automation. In-memory only (resolved at creation time and read by the alert);
 * Persisted immutably in SessionDO SQLite and `session_index`. Null is reserved
 * for sessions created before provenance persistence was introduced.
 *
 * Every `createSessionState` caller in docs/session-creation-entrypoints.md
 * sets one of these. A safe default in the alert keeps the line from ever
 * rendering "unknown" if a future surface forgets.
 */
export const SessionEntrypoint = {
  /** POST /api/sessions -- the interactive HTTP API, also backing CLI and web UI create. */
  API: "api",
  /** A parent session spawning a child via POST /api/sessions/:id/child-sessions. */
  CHILD_SESSION: "child_session",
  /** Slack app-mention / DM / `qa` directive. */
  SLACK: "slack",
  /** A Slack channel automation rule firing. */
  SLACK_AUTOMATION: "slack_automation",
  /** Jira issue webhook (trigger label). */
  JIRA: "jira",
  /** Linear issue webhook (trigger label). */
  LINEAR: "linear",
  /** PagerDuty incident-open webhook. */
  PAGERDUTY: "pagerduty",
  /** GitHub issue-comment webhook (@cycloid). */
  GITHUB: "github",
  /** Scheduled automation rule (cron tick). */
  SCHEDULED: "scheduled",
  /** A configured failed GitHub check rule. */
  GITHUB_CHECK_AUTOMATION: "github_check_automation",
  /**
   * Automatic QA verification scheduled after a review loop completes. This is
   * rendered in customer-session tracking for external production verification
   * sessions.
   */
  AUTO_QA: "auto_qa",
  /** Automatic internal-business reviewer spawned after a genuine PR create. */
  AUTO_PR_REVIEW: "auto_pr_review",
} as const;

export type SessionEntrypoint = (typeof SessionEntrypoint)[keyof typeof SessionEntrypoint];

const SESSION_ENTRYPOINTS = new Set<string>(Object.values(SessionEntrypoint));

export function parseSessionEntrypoint(value: unknown): SessionEntrypoint | null {
  return typeof value === "string" && SESSION_ENTRYPOINTS.has(value) ? (value as SessionEntrypoint) : null;
}
