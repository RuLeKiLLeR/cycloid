import { d1Changed } from "../db/errors";
interface PendingSignupRow {
  id: number;
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  requestedAt: number;
  deniedAt: number | null;
  deniedByUserId: number | null;
}

interface RawPendingSignupRow {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  requested_at: number;
  denied_at: number | null;
  denied_by_user_id: number | null;
}

function mapRow(row: RawPendingSignupRow): PendingSignupRow {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    requestedAt: row.requested_at,
    deniedAt: row.denied_at,
    deniedByUserId: row.denied_by_user_id,
  };
}

export async function getPendingSignupByGithubId(db: D1Database, githubId: number): Promise<PendingSignupRow | null> {
  const row = await db
    .prepare(
      `SELECT id, github_id, login, name, email, avatar_url, requested_at, denied_at, denied_by_user_id
       FROM pending_signups WHERE github_id = ? LIMIT 1`,
    )
    .bind(githubId)
    .first<RawPendingSignupRow>();
  return row ? mapRow(row) : null;
}

export async function getPendingSignupById(db: D1Database, id: number): Promise<PendingSignupRow | null> {
  const row = await db
    .prepare(
      `SELECT id, github_id, login, name, email, avatar_url, requested_at, denied_at, denied_by_user_id
       FROM pending_signups WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<RawPendingSignupRow>();
  return row ? mapRow(row) : null;
}

export async function deletePendingSignupByGithubId(db: D1Database, githubId: number): Promise<void> {
  await db.prepare("DELETE FROM pending_signups WHERE github_id = ?").bind(githubId).run();
}

/**
 * Insert or refresh a pending signup row atomically. If a row already exists
 * for this github_id, profile fields are refreshed and denied_at is left
 * untouched. Single statement so two concurrent OAuth callbacks can't both
 * lose the UNIQUE-constraint race.
 *
 * Returns true if a new row was inserted, false if an existing row was updated.
 */
export async function upsertPendingSignup(
  db: D1Database,
  input: {
    githubId: number;
    login: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  },
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO pending_signups
         (github_id, login, name, email, avatar_url, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET
         login = excluded.login,
         name = excluded.name,
         email = excluded.email,
         avatar_url = excluded.avatar_url
       RETURNING requested_at`,
    )
    .bind(input.githubId, input.login, input.name, input.email, input.avatarUrl, now)
    .first<{ requested_at: number }>();
  if (!result) {
    throw new Error("upsertPendingSignup: RETURNING clause produced no row");
  }
  // If the returned requested_at matches `now`, this was an insert; otherwise it's an existing row.
  return result.requested_at === now;
}

export async function listOpenPendingSignups(db: D1Database): Promise<PendingSignupRow[]> {
  const result = await db
    .prepare(
      `SELECT id, github_id, login, name, email, avatar_url, requested_at, denied_at, denied_by_user_id
       FROM pending_signups
       WHERE denied_at IS NULL
       ORDER BY requested_at ASC`,
    )
    .all<RawPendingSignupRow>();
  return (result.results ?? []).map(mapRow);
}

export async function markPendingSignupDenied(
  db: D1Database,
  id: number,
  deniedByUserId: number,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE pending_signups
       SET denied_at = ?, denied_by_user_id = ?
       WHERE id = ? AND denied_at IS NULL`,
    )
    .bind(now, deniedByUserId, id)
    .run();
  return d1Changed(result);
}

export async function purgeDeniedPendingSignupsOlderThan(db: D1Database, cutoffMs: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM pending_signups
       WHERE denied_at IS NOT NULL AND denied_at < ?`,
    )
    .bind(cutoffMs)
    .run();
  return result.meta?.changes ?? 0;
}
