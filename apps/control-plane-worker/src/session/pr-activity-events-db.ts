// Persistence for the durable PR-conversation capture log (migration 0248).
// One append-only row per received GitHub webhook event on a Cycloid-tracked
// PR. Pure DAO: an idempotent single-row insert and a per-PR ordered list. NO
// gating, parsing, or classification lives here — the capture service
// (src/webhooks/pr-activity-capture.ts) resolves the tracking gate + ownership
// session and builds the redacted, size-capped row; this file only writes/reads.
//
// Idempotency: `recordPrActivityEvent` is `INSERT ... ON CONFLICT(delivery_id)
// DO NOTHING`. GitHub redelivers a webhook (with the SAME X-GitHub-Delivery GUID)
// after a transient failure, so first-seen wins and redelivery is a no-op — never
// gate behavior on rows-changed. A genuine edit/delete arrives as a NEW delivery
// (new `delivery_id`, `action: "edited"|"deleted"`) and appends its own row, so the
// full history is retained rather than last-write-wins.
//
// `session_id` is the canonical coordinating session; it is the offboarding key
// (this table is registered in OFFBOARDING_SESSION_ID_TABLES, business/offboarding-tables.ts).
// All timestamps are unix-ms integers (docs/database.md); reconstruction orders by
// `occurred_at, id`.

/** The fields a capture writes for one event. `delivery_id` keys the row. */
export interface PrActivityEventInput {
  deliveryId: string;
  /** Canonical coordinating session for the PR (ownership / offboarding key). */
  sessionId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  installationId: number | null;
  /** issue_comment | pull_request_review | pull_request_review_comment | pull_request */
  eventType: string;
  action: string;
  /** GitHub id of the comment/review (null for PR-level events). */
  subjectId: string | null;
  inReplyToId: string | null;
  reviewState: string | null;
  /** The ACTION actor (payload.sender) — who performed this event. */
  actorLogin: string | null;
  actorType: string | null;
  /** human | bot | cycloid, derived from the bot registry for the action actor. */
  actorClass: string | null;
  /** The CONTENT author (comment.user / review.user / PR author). */
  subjectAuthorLogin: string | null;
  subjectAuthorType: string | null;
  /** Redacted + size-capped body text. */
  body: string | null;
  filePath: string | null;
  line: number | null;
  side: string | null;
  diffHunk: string | null;
  headSha: string | null;
  /** GitHub's real timestamps as unix-ms (Date.parse of the ISO string); null if absent/unparseable. */
  githubCreatedAt: number | null;
  githubUpdatedAt: number | null;
  /** Action-time used for ordering (see the capture builder for the per-action mapping). */
  occurredAt: number;
  /** Our ingest clock (unix-ms). */
  receivedAt: number;
  /** Redacted, field-whitelisted, size-capped JSON for full-fidelity reconstruction. */
  rawJson: string;
}

/** In-memory shape of one `pr_activity_events` row. */
export interface PrActivityEvent extends PrActivityEventInput {
  id: number;
}

/** Raw column shape as it comes back from SQLite (snake_case). */
interface PrActivityEventRow {
  id: number;
  delivery_id: string;
  session_id: string;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  pr_url: string;
  installation_id: number | null;
  event_type: string;
  action: string;
  subject_id: string | null;
  in_reply_to_id: string | null;
  review_state: string | null;
  actor_login: string | null;
  actor_type: string | null;
  actor_class: string | null;
  subject_author_login: string | null;
  subject_author_type: string | null;
  body: string | null;
  file_path: string | null;
  line: number | null;
  side: string | null;
  diff_hunk: string | null;
  head_sha: string | null;
  github_created_at: number | null;
  github_updated_at: number | null;
  occurred_at: number;
  received_at: number;
  raw_json: string;
}

function rowToRecord(row: PrActivityEventRow): PrActivityEvent {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    sessionId: row.session_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    installationId: row.installation_id,
    eventType: row.event_type,
    action: row.action,
    subjectId: row.subject_id,
    inReplyToId: row.in_reply_to_id,
    reviewState: row.review_state,
    actorLogin: row.actor_login,
    actorType: row.actor_type,
    actorClass: row.actor_class,
    subjectAuthorLogin: row.subject_author_login,
    subjectAuthorType: row.subject_author_type,
    body: row.body,
    filePath: row.file_path,
    line: row.line,
    side: row.side,
    diffHunk: row.diff_hunk,
    headSha: row.head_sha,
    githubCreatedAt: row.github_created_at,
    githubUpdatedAt: row.github_updated_at,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    rawJson: row.raw_json,
  };
}

const RECORD_PR_ACTIVITY_EVENT_SQL = `INSERT INTO pr_activity_events (
  delivery_id, session_id, repo_owner, repo_name, pr_number, pr_url, installation_id,
  event_type, action, subject_id, in_reply_to_id, review_state,
  actor_login, actor_type, actor_class, subject_author_login, subject_author_type,
  body, file_path, line, side, diff_hunk, head_sha,
  github_created_at, github_updated_at, occurred_at, received_at, raw_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (delivery_id) DO NOTHING`;

/**
 * Idempotently record one PR activity event. First-seen wins: a redelivered
 * webhook (same `delivery_id`) is a no-op via `ON CONFLICT DO NOTHING`. Do NOT
 * turn this into an UPSERT — a genuine edit/delete carries a new `delivery_id`
 * and must append, not overwrite.
 */
export async function recordPrActivityEvent(db: D1Database, input: PrActivityEventInput): Promise<void> {
  await db
    .prepare(RECORD_PR_ACTIVITY_EVENT_SQL)
    .bind(
      input.deliveryId,
      input.sessionId,
      input.repoOwner,
      input.repoName,
      input.prNumber,
      input.prUrl,
      input.installationId,
      input.eventType,
      input.action,
      input.subjectId,
      input.inReplyToId,
      input.reviewState,
      input.actorLogin,
      input.actorType,
      input.actorClass,
      input.subjectAuthorLogin,
      input.subjectAuthorType,
      input.body,
      input.filePath,
      input.line,
      input.side,
      input.diffHunk,
      input.headSha,
      input.githubCreatedAt,
      input.githubUpdatedAt,
      input.occurredAt,
      input.receivedAt,
      input.rawJson,
    )
    .run();
}

/** The PR whose captured activity to list. */
export interface PrActivityEventQuery {
  repoOwner: string;
  repoName: string;
  prNumber: number;
}

/**
 * List every captured event for one PR, oldest first, ordered by the action-time
 * (`occurred_at`) then insertion order (`id`) — the order reconstruction folds.
 */
export async function listPrActivityEvents(db: D1Database, query: PrActivityEventQuery): Promise<PrActivityEvent[]> {
  const result = await db
    .prepare(
      `SELECT * FROM pr_activity_events
       WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?
       ORDER BY occurred_at ASC, id ASC`,
    )
    .bind(query.repoOwner, query.repoName, query.prNumber)
    .all<PrActivityEventRow>();
  return (result.results ?? []).map(rowToRecord);
}
