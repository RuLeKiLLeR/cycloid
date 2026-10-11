/**
 * Constants for the Wave-0 UX-overhaul read/aggregation APIs (PR inbox, repo
 * context aggregate, activity). Thresholds, page sizes, and window bounds live
 * here per the repo's constants-placement convention — never inline in the
 * services/DAOs that consume them.
 */

// ── PR inbox (GET /api/pr-inbox) ──────────────────────────────────────────────
export const PR_INBOX_DEFAULT_LIMIT = 25;
export const PR_INBOX_MAX_LIMIT = 100;
export const PR_INBOX_MAX_SEARCH_LENGTH = 200;
export const PR_INBOX_MAX_SEARCH_TERMS = 8;

/**
 * The derived cross-session PR review buckets. A pure projection of the FSM
 * `pr_coordination` record (state / verdict / blocked_reason) plus the PR's
 * draft flag — see `services/pr-inbox.ts` `derivePrBucket`. NOT GitHub's own
 * review-decision state (approved/changes-requested there mean a human review
 * verdict, which Cycloid does not persist); these buckets describe where the
 * PR sits in Cycloid's post-publish lifecycle.
 */
export const PR_INBOX_BUCKETS = [
  "draft", // PR opened as a draft (session_pr_metadata.pr_draft = 1)
  "needs_review", // active review loop / a human-action block (owner_approval, review_stuck)
  "changes_requested", // Cycloid is addressing verification/QA findings (app_breaks) or a verification block
  "checks_failing", // CI failing terminally (ci_fix_exhausted / ci_flapping)
  "approved", // Cycloid done — ready for human review & merge (MERGE_READY)
  "open", // published, still in the loop, no more specific bucket
  "closed", // MERGED or CLOSED
] as const;
export type PrInboxBucket = (typeof PR_INBOX_BUCKETS)[number];

export function isPrInboxBucket(value: unknown): value is PrInboxBucket {
  return typeof value === "string" && (PR_INBOX_BUCKETS as readonly string[]).includes(value);
}

export const PR_INBOX_LANE_FILTERS = ["all", "open", "closed", "none"] as const;
export type PrInboxLaneFilter = (typeof PR_INBOX_LANE_FILTERS)[number];

export function isPrInboxLaneFilter(value: unknown): value is PrInboxLaneFilter {
  return typeof value === "string" && (PR_INBOX_LANE_FILTERS as readonly string[]).includes(value);
}

// ── Activity (GET /api/activity) ──────────────────────────────────────────────
/** Supported look-back windows, in days. */
export const ACTIVITY_WINDOW_DAYS = [7, 30] as const;
export type ActivityWindowDays = (typeof ACTIVITY_WINDOW_DAYS)[number];
export const ACTIVITY_DEFAULT_WINDOW_DAYS: ActivityWindowDays = 7;

export function isActivityWindowDays(value: number): value is ActivityWindowDays {
  return (ACTIVITY_WINDOW_DAYS as readonly number[]).includes(value);
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Max recent lifecycle events returned in one activity response. */
export const ACTIVITY_RECENT_EVENTS_LIMIT = 50;

/**
 * The session-source buckets derivable from D1 today. The finer product
 * surfaces (UI vs API vs Jira vs Linear vs GitHub) are NOT persisted on
 * `session_index` — the discriminating `SessionEntrypoint` is in-memory only —
 * so they collapse into `user`. Only `slack` is separable (via
 * `callback_context_json.source`), and `automation`/`child` via `initiation_mode`.
 */
export const ACTIVITY_SOURCES = ["slack", "automation", "child", "user"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];
