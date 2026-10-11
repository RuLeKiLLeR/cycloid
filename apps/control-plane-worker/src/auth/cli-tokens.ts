import { D1_RETRY_SAFE_MARKER } from "../db/errors";
import type { CliTokenScope } from "../types";
import { type BusinessRole, toBusinessRole } from "./business-role";

// ---------------------------------------------------------------------------
// DAO functions (DB queries only)
// ---------------------------------------------------------------------------

/**
 * Insert a CLI token only while the user is below `maxActive` active tokens,
 * enforced in a single statement so N concurrent creates cannot each pass a
 * separate count-then-insert and overshoot the cap. Returns the new id, or null
 * when the cap is already reached (0 rows inserted). Mirrors
 * createImpersonationIfActorBelowLimit. The active-count predicate counts
 * non-revoked, unexpired tokens.
 */
export async function insertCliTokenIfBelowLimit(
  db: D1Database,
  userId: number,
  tokenHash: string,
  tokenPrefix: string,
  scope: CliTokenScope,
  maxActive: number,
  expiresAt?: number,
  now = Date.now(),
): Promise<number | null> {
  const result = await db
    .prepare(
      `INSERT INTO cli_tokens (user_id, token_hash, token_prefix, scope, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM cli_tokens
         WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ) < ?`,
    )
    .bind(userId, tokenHash, tokenPrefix, scope, now, expiresAt ?? null, userId, now, maxActive)
    .run();
  if ((result.meta?.changes ?? 0) !== 1) return null;
  return result.meta.last_row_id as number;
}

export async function findCliTokenByHash(
  db: D1Database,
  tokenHash: string,
): Promise<{
  tokenId: number;
  scope: CliTokenScope;
  lastUsedAt: number | null;
  user: {
    id: number;
    login: string | null;
    name: string | null;
    email: string | null;
    githubUserId: number | null;
    businessId: string;
    businessRole: BusinessRole | null;
    sharedSessions: boolean;
  };
} | null> {
  const row = await db
    .prepare(
      `SELECT ct.id AS token_id, ct.scope, ct.last_used_at, u.id, u.github_id, u.login, u.name, u.email, u.business_id, b.shared_sessions,
              bm.role AS business_role
       FROM cli_tokens ct
       INNER JOIN users u ON u.id = ct.user_id
       INNER JOIN businesses b ON b.id = u.business_id
       LEFT JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = u.business_id
       WHERE ct.token_hash = ? AND ct.revoked_at IS NULL AND (ct.expires_at IS NULL OR ct.expires_at > ?)`,
    )
    .bind(tokenHash, Date.now())
    .first<{
      token_id: number;
      scope: CliTokenScope;
      last_used_at: number | null;
      id: number;
      github_id: number | null;
      login: string;
      name: string;
      email: string;
      business_id: string;
      business_role: string | null;
      shared_sessions: number | null;
    }>();

  if (!row) return null;

  return {
    tokenId: row.token_id,
    scope: row.scope,
    lastUsedAt: row.last_used_at,
    user: {
      id: row.id,
      login: row.login ?? null,
      name: row.name ?? null,
      email: row.email ?? null,
      githubUserId: row.github_id ?? null,
      businessId: row.business_id,
      businessRole: toBusinessRole(row.business_role),
      sharedSessions: row.shared_sessions === 1,
    },
  };
}

// Atomic, validity-checked touch. This write is fire-and-forget and can land after
// the token was revoked or expired (the auth SELECT and this UPDATE are a race), so
// re-check validity here rather than blindly overwriting. The `last_used_at < ?`
// guard also no-ops the losers when concurrent stale reads both decide to write.
export async function updateLastUsedAt(db: D1Database, tokenId: number, staleBeforeMs: number): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} UPDATE cli_tokens SET last_used_at = ?
       WHERE id = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
         AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(now, tokenId, now, staleBeforeMs)
    .run();
}

export interface CliTokenRow {
  id: number;
  tokenPrefix: string;
  scope: CliTokenScope;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export async function listCliTokensByUser(
  db: D1Database,
  userId: number,
  limit: number,
  cursor?: string,
): Promise<{ data: CliTokenRow[]; nextCursor: string | null }> {
  const effectiveLimit = Math.min(Math.max(limit, 1), 100);
  const cursorId = cursor ? Number(cursor) : null;

  const query = cursorId
    ? "SELECT id, token_prefix, scope, created_at, expires_at, revoked_at, last_used_at FROM cli_tokens WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
    : "SELECT id, token_prefix, scope, created_at, expires_at, revoked_at, last_used_at FROM cli_tokens WHERE user_id = ? ORDER BY id DESC LIMIT ?";

  const stmt = cursorId
    ? db.prepare(query).bind(userId, cursorId, effectiveLimit + 1)
    : db.prepare(query).bind(userId, effectiveLimit + 1);

  const result = await stmt.all<{
    id: number;
    token_prefix: string;
    scope: CliTokenScope;
    created_at: number;
    expires_at: number | null;
    revoked_at: number | null;
    last_used_at: number | null;
  }>();

  const rows = result.results ?? [];
  const hasMore = rows.length > effectiveLimit;
  const data = (hasMore ? rows.slice(0, effectiveLimit) : rows).map((r) => ({
    id: r.id,
    tokenPrefix: r.token_prefix,
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
  }));

  const nextCursor = hasMore ? String(data[data.length - 1].id) : null;
  return { data, nextCursor };
}

export async function findCliTokenByUserAndId(
  db: D1Database,
  userId: number,
  tokenId: number,
): Promise<{ id: number; scope: CliTokenScope } | null> {
  const row = await db
    .prepare("SELECT id, scope FROM cli_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(tokenId, userId)
    .first<{ id: number; scope: CliTokenScope }>();

  return row ? { id: row.id, scope: row.scope } : null;
}

export async function setRevokedAt(db: D1Database, userId: number, tokenId: number): Promise<void> {
  await db
    .prepare("UPDATE cli_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), tokenId, userId)
    .run();
}

export async function deleteCliTokenRow(db: D1Database, userId: number, tokenId: number): Promise<void> {
  await db.prepare("DELETE FROM cli_tokens WHERE id = ? AND user_id = ?").bind(tokenId, userId).run();
}

export async function deleteExpiredCliTokens(db: D1Database, userId: number, now = Date.now()): Promise<void> {
  await db
    .prepare(
      "DELETE FROM cli_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .bind(userId, now)
    .run();
}
