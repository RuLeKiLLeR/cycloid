import { D1_RETRY_SAFE_MARKER, d1Changed } from "../db/errors";
import { SlackInteractionKind, SlackInteractionRequestStatus } from "../enums/slack-interaction";

/**
 * DAO for `slack_interaction_requests` (migration 0240): durable one-shot
 * requests behind actionable Slack buttons. A row is written `pending` when a
 * button posts and consumed exactly once by the interactions webhook; the
 * single UPDATE in `consumeInteractionRequest` is the race guard. `kind` and
 * `status` are code-validated (enums/slack-interaction.ts) — the table has no
 * CHECK constraints.
 */
export interface SlackInteractionRequestRecord {
  id: string;
  businessId: string;
  sessionId: string;
  /** Raw stored value; validate with `isSlackInteractionKind` before dispatch. */
  kind: string;
  payloadJson: string;
  slackTeamId: string;
  slackChannelId: string;
  messageTs: string | null;
  /** Raw stored value; one of enums/slack-interaction SlackInteractionRequestStatus. */
  status: string;
  expiresAt: number | null;
  createdAt: number;
  consumedAt: number | null;
  consumedByUserId: string | null;
}

interface SlackInteractionRequestRow {
  id: string;
  business_id: string;
  session_id: string;
  kind: string;
  payload_json: string;
  slack_team_id: string;
  slack_channel_id: string;
  message_ts: string | null;
  status: string;
  expires_at: number | null;
  created_at: number;
  consumed_at: number | null;
  consumed_by_user_id: string | null;
}

const SELECT_COLUMNS = `id, business_id, session_id, kind, payload_json, slack_team_id, slack_channel_id,
       message_ts, status, expires_at, created_at, consumed_at, consumed_by_user_id`;

function mapRow(row: SlackInteractionRequestRow): SlackInteractionRequestRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    sessionId: row.session_id,
    kind: row.kind,
    payloadJson: row.payload_json,
    slackTeamId: row.slack_team_id,
    slackChannelId: row.slack_channel_id,
    messageTs: row.message_ts,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    consumedByUserId: row.consumed_by_user_id,
  };
}

/** Insert a fresh `pending` request row and return its generated id. */
export async function insertInteractionRequest(
  db: D1Database,
  params: {
    businessId: string;
    sessionId: string;
    kind: SlackInteractionKind;
    payloadJson: string;
    slackTeamId: string;
    slackChannelId: string;
    messageTs: string | null;
    expiresAt: number | null;
    now?: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = params.now ?? Date.now();
  await db
    .prepare(
      `INSERT INTO slack_interaction_requests
       (id, business_id, session_id, kind, payload_json, slack_team_id, slack_channel_id,
        message_ts, status, expires_at, created_at, consumed_at, consumed_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      id,
      params.businessId,
      params.sessionId,
      params.kind,
      params.payloadJson,
      params.slackTeamId,
      params.slackChannelId,
      params.messageTs,
      SlackInteractionRequestStatus.Pending,
      params.expiresAt,
      createdAt,
    )
    .run();
  return id;
}

export async function getInteractionRequest(db: D1Database, id: string): Promise<SlackInteractionRequestRecord | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM slack_interaction_requests WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<SlackInteractionRequestRow>();
  return row ? mapRow(row) : null;
}

/**
 * Newest unexpired `pending` request for `(session, kind)`. Due-but-unswept
 * rows (past `expires_at`, not yet flipped by `expireDue`) are excluded so
 * callers never bind to a request the consume guard would reject anyway.
 */
export async function getNewestPending(
  db: D1Database,
  sessionId: string,
  kind: SlackInteractionKind,
  now = Date.now(),
): Promise<SlackInteractionRequestRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM slack_interaction_requests
       WHERE session_id = ? AND kind = ? AND status = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(sessionId, kind, SlackInteractionRequestStatus.Pending, now)
    .first<SlackInteractionRequestRow>();
  return row ? mapRow(row) : null;
}

/** All live pending requests for `(session, kind)`, newest first. */
export async function listPendingInteractionRequests(
  db: D1Database,
  sessionId: string,
  kind: SlackInteractionKind,
  now = Date.now(),
): Promise<SlackInteractionRequestRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM slack_interaction_requests
       WHERE session_id = ? AND kind = ? AND status = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(sessionId, kind, SlackInteractionRequestStatus.Pending, now)
    .all<SlackInteractionRequestRow>();
  return (result.results ?? []).map(mapRow);
}

/** Supersede one exact pending request without affecting a newer replacement. */
export async function supersedeInteractionRequest(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE slack_interaction_requests
       SET status = ?
       WHERE id = ? AND status = ?`,
    )
    .bind(SlackInteractionRequestStatus.Superseded, id, SlackInteractionRequestStatus.Pending)
    .run();
  return d1Changed(result);
}

/**
 * Atomically consume a pending, unexpired request. Returns true only for the
 * caller whose UPDATE changed the row; a concurrent double-click, a replayed
 * payload, or a click past `expires_at` returns false. Deliberately NOT marked
 * d1-retry-safe: a retry of a committed consume reports changes = 0, which
 * would misclassify the winning click as a replay.
 */
export async function consumeInteractionRequest(
  db: D1Database,
  id: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE slack_interaction_requests
       SET status = ?, consumed_at = ?, consumed_by_user_id = ?
       WHERE id = ? AND status = ? AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(SlackInteractionRequestStatus.Consumed, now, userId, id, SlackInteractionRequestStatus.Pending, now)
    .run();
  return d1Changed(result);
}

/**
 * Mark every live pending request for `(session, kind)` superseded (a newer
 * ask replaces it). Rows already past `expires_at` are left for `expireDue`
 * so their terminal status stays truthful. Returns the number superseded.
 */
export async function supersedePending(
  db: D1Database,
  sessionId: string,
  kind: SlackInteractionKind,
  now: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE slack_interaction_requests
       SET status = ?
       WHERE session_id = ? AND kind = ? AND status = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(SlackInteractionRequestStatus.Superseded, sessionId, kind, SlackInteractionRequestStatus.Pending, now)
    .run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * Flip due pending rows to `expired` (5-minute sweep). Idempotent under
 * replay: a re-run only reports 0 changes.
 */
export async function expireDue(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} UPDATE slack_interaction_requests
       SET status = ?
       WHERE status = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .bind(SlackInteractionRequestStatus.Expired, SlackInteractionRequestStatus.Pending, now)
    .run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * GC (hourly cron): delete terminal rows created before `cutoff`. Matches on
 * `status != 'pending'` rather than enumerating terminal statuses so a future
 * terminal status cannot dodge retention. Pending rows are never pruned —
 * `expireDue` terminalizes the dated ones first.
 */
export async function pruneOldInteractionRequests(db: D1Database, cutoff: number): Promise<number> {
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} DELETE FROM slack_interaction_requests
       WHERE status != ? AND created_at < ?`,
    )
    .bind(SlackInteractionRequestStatus.Pending, cutoff)
    .run();
  return Number(result.meta?.changes ?? 0);
}
