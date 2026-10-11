import { d1Changed } from "../db/errors";

export type SlackPostStage =
  "completed" | "failed" | "recovered" | "verification_blocked" | "session_stopped" | "session_archived" | "pr_opened";

const SLACK_POST_LEASE_MS = 60_000;
export const SLACK_POST_MAX_ATTEMPTS = 5;
// Excludes one-shot PR-opened posts: they are released immediately on failure,
// but not swept for retries after the original PR-created event has passed.
export const SLACK_POST_RETRY_STAGES = ["completed", "failed", "verification_blocked", "session_stopped"] as const;
type SlackPostRetryStage = (typeof SLACK_POST_RETRY_STAGES)[number];
const SLACK_POST_RETRY_STAGE_SQL = SLACK_POST_RETRY_STAGES.map((stage) => `'${stage}'`).join(", ");

export interface SlackPostRetryRow {
  sessionId: string;
  promptId: string;
  stage: SlackPostRetryStage;
  attemptCount: number;
}

export type SlackPostRetryStatus = "pending" | "exhausted";

export async function insertSlackPostIfAbsent(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    stage: SlackPostStage;
    channel?: string | null;
    messageTs?: string | null;
    nextAttemptAt?: number | null;
    now?: number;
  },
): Promise<boolean> {
  const createdAt = params.now ?? Date.now();
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO slack_posts
       (id, session_id, prompt_id, stage, channel, message_ts, created_at, status, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.sessionId,
      params.promptId,
      params.stage,
      params.channel ?? null,
      params.messageTs ?? null,
      createdAt,
      params.messageTs ? "delivered" : "pending",
      params.messageTs ? null : (params.nextAttemptAt ?? createdAt),
    )
    .run();

  return d1Changed(result);
}

export async function claimSlackPostForDelivery(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    stage: SlackPostStage;
    channel?: string | null;
    now?: number;
    leaseOwner?: string;
  },
): Promise<boolean> {
  const now = params.now ?? Date.now();
  // Stamp the fresh row's next_attempt_at with the same `now` the claim UPDATE
  // below filters on. Reading Date.now() separately inside the insert can cross a
  // millisecond boundary, making next_attempt_at > now so the very first claim
  // matches zero rows and skips the initial post (deferred to the retry sweep).
  await insertSlackPostIfAbsent(db, {
    sessionId: params.sessionId,
    promptId: params.promptId,
    stage: params.stage,
    channel: params.channel,
    now,
  });
  await db
    .prepare(
      `UPDATE slack_posts
       SET status = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE session_id = ?
         AND prompt_id = ?
         AND stage = ?
         AND status = 'sending'
         AND lease_expires_at <= ?`,
    )
    .bind(params.sessionId, params.promptId, params.stage, now)
    .run();
  await db
    .prepare(
      `UPDATE slack_posts
       SET status = 'exhausted',
           next_attempt_at = NULL,
           last_error = COALESCE(last_error, 'max_attempts_exhausted'),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE session_id = ?
         AND prompt_id = ?
         AND stage = ?
         AND status = 'pending'
         AND attempt_count >= ?`,
    )
    .bind(params.sessionId, params.promptId, params.stage, SLACK_POST_MAX_ATTEMPTS)
    .run();
  const result = await db
    .prepare(
      `UPDATE slack_posts
       SET status = 'sending',
           attempt_count = attempt_count + 1,
           lease_owner = ?,
           lease_expires_at = ?,
           last_error = NULL
       WHERE session_id = ?
         AND prompt_id = ?
         AND stage = ?
         AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND attempt_count < ?`,
    )
    .bind(
      params.leaseOwner ?? crypto.randomUUID(),
      now + SLACK_POST_LEASE_MS,
      params.sessionId,
      params.promptId,
      params.stage,
      now,
      SLACK_POST_MAX_ATTEMPTS,
    )
    .run();
  return d1Changed(result);
}

export async function markSlackPostPendingRetry(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    stage: SlackPostStage;
    nextAttemptAt: number;
    error: string;
  },
): Promise<SlackPostRetryStatus | null> {
  const row = await db
    .prepare(
      `UPDATE slack_posts
       SET status = CASE WHEN attempt_count >= ? THEN 'exhausted' ELSE 'pending' END,
           next_attempt_at = CASE WHEN attempt_count >= ? THEN NULL ELSE ? END,
           last_error = ?,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE session_id = ? AND prompt_id = ? AND stage = ? AND status = 'sending'
       RETURNING status`,
    )
    .bind(
      SLACK_POST_MAX_ATTEMPTS,
      SLACK_POST_MAX_ATTEMPTS,
      params.nextAttemptAt,
      params.error,
      params.sessionId,
      params.promptId,
      params.stage,
    )
    .first<{ status: SlackPostRetryStatus }>();
  return row?.status ?? null;
}

export async function hasDeliveredSlackPost(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    stage: SlackPostStage;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present
       FROM slack_posts
       WHERE session_id = ? AND prompt_id = ? AND stage = ? AND status = 'delivered' AND message_ts IS NOT NULL
       LIMIT 1`,
    )
    .bind(params.sessionId, params.promptId, params.stage)
    .first<{ present: number }>();

  return Boolean(row);
}

export async function markSlackPostDelivered(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    stage: SlackPostStage;
    messageTs: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE slack_posts
       SET message_ts = ?
           , status = 'delivered'
           , next_attempt_at = NULL
           , last_error = NULL
           , lease_owner = NULL
           , lease_expires_at = NULL
       WHERE session_id = ? AND prompt_id = ? AND stage = ?`,
    )
    .bind(params.messageTs, params.sessionId, params.promptId, params.stage)
    .run();
}

export async function listDueSlackPostRetries(
  db: D1Database,
  sessionId: string,
  now: number,
): Promise<SlackPostRetryRow[]> {
  const rows = await db
    .prepare(
      `SELECT session_id, prompt_id, stage, attempt_count
       FROM slack_posts
       WHERE session_id = ?
         AND stage IN (${SLACK_POST_RETRY_STAGE_SQL})
         AND (
           (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (status = 'sending' AND lease_expires_at <= ?)
         )
       ORDER BY COALESCE(next_attempt_at, created_at) ASC, prompt_id ASC`,
    )
    .bind(sessionId, now, now)
    .all<{
      session_id: string;
      prompt_id: string;
      stage: SlackPostRetryStage;
      attempt_count: number;
    }>();
  return (rows.results ?? []).map((row) => ({
    sessionId: row.session_id,
    promptId: row.prompt_id,
    stage: row.stage,
    attemptCount: row.attempt_count,
  }));
}

export async function getNextDueSlackPostRetry(db: D1Database, sessionId: string, now: number): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(COALESCE(next_attempt_at, created_at)) AS next_attempt_at
       FROM slack_posts
       WHERE session_id = ?
         AND stage IN (${SLACK_POST_RETRY_STAGE_SQL})
         AND (
           status = 'pending'
           OR (status = 'sending' AND lease_expires_at <= ?)
         )`,
    )
    .bind(sessionId, now)
    .first<{ next_attempt_at: number | null }>();
  return typeof row?.next_attempt_at === "number" ? row.next_attempt_at : null;
}

export async function deleteSlackPostMarker(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    stage: SlackPostStage;
  },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM slack_posts
       WHERE session_id = ? AND prompt_id = ? AND stage = ?`,
    )
    .bind(params.sessionId, params.promptId, params.stage)
    .run();
}

/**
 * Claim the right to post the PR-merged Slack reply for `(session_id, pr_url)`.
 * Returns true only for the first caller; concurrent or redelivered merge
 * triggers (webhook, review-loop sweep, self-redelivery) return false so the
 * notice posts at most once. PR-merge is PR-scoped, not prompt-scoped, so this
 * keys on the PR url rather than overloading `slack_posts` (whose prompt_id is
 * NOT NULL and has no real value here).
 */
export async function claimSlackPrMergedPost(
  db: D1Database,
  params: { sessionId: string; prUrl: string; channel?: string | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO slack_pr_merged_posts
       (id, session_id, pr_url, channel, message_ts, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .bind(crypto.randomUUID(), params.sessionId, params.prUrl, params.channel ?? null, Date.now())
    .run();
  return d1Changed(result);
}

/**
 * Release a PR-merged claim after a failed Slack post so a later merge trigger
 * re-posts. Without this, one transient Slack failure permanently suppresses the
 * PR-merged notice (mirrors the completion/failure delete-marker-before-retry
 * path). The delete is idempotent.
 */
export async function deleteSlackPrMergedPostMarker(
  db: D1Database,
  params: { sessionId: string; prUrl: string },
): Promise<void> {
  await db
    .prepare(`DELETE FROM slack_pr_merged_posts WHERE session_id = ? AND pr_url = ?`)
    .bind(params.sessionId, params.prUrl)
    .run();
}
