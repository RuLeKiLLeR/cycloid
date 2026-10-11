import { d1Changed } from "../db/errors";
import { isCycloidAdmin } from "../services/internal-feature-gate";
import type { UserInfo } from "../types";
import { toBusinessRole } from "./business-role";

interface ImpersonationRow {
  id: string;
  actorUserId: number;
  targetUserId: number;
  reason: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

interface ResolvedImpersonation {
  row: ImpersonationRow;
  target: UserInfo;
  actor: UserInfo;
}

type ResolveImpersonationResult = { status: "ok"; resolved: ResolvedImpersonation } | { status: "invalid" };

const IMPERSONATION_SEARCH_LIMIT = 8;
const IMPERSONATION_DIRECTORY_LIMIT = 500;
const IMPERSONATION_DIRECTORY_QUERY_LIMIT = IMPERSONATION_DIRECTORY_LIMIT + 1;

type ImpersonationDirectoryUserRow = {
  id: number;
  login: string | null;
  name: string | null;
  business_id: string;
  business_name: string | null;
};

type ImpersonationSearchSessionRow = {
  session_id: string;
  title: string | null;
  updated_at: string | number | null;
  owner_user_id: number;
  owner_login: string | null;
  owner_name: string | null;
  owner_email: string | null;
  business_id: string;
  business_name: string | null;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function listImpersonationDirectory(db: D1Database): Promise<{
  truncated: boolean;
  businesses: Array<{
    id: string;
    name: string | null;
    users: Array<{
      id: number;
      login: string | null;
      name: string | null;
      businessId: string;
      businessName: string | null;
    }>;
  }>;
}> {
  const result = await db
    .prepare(
      `SELECT u.id,
              u.login,
              u.name,
              u.business_id,
              b.name AS business_name
       FROM users u
       INNER JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = u.business_id
       LEFT JOIN businesses b ON b.id = u.business_id
       ORDER BY
         COALESCE(b.name, u.business_id) COLLATE NOCASE ASC,
         u.login COLLATE NOCASE ASC,
         u.id ASC
       LIMIT ?`,
    )
    .bind(IMPERSONATION_DIRECTORY_QUERY_LIMIT)
    .all<ImpersonationDirectoryUserRow>();

  const rows = result.results ?? [];
  const truncated = rows.length > IMPERSONATION_DIRECTORY_LIMIT;

  const businesses = new Map<
    string,
    {
      id: string;
      name: string | null;
      users: Array<{
        id: number;
        login: string | null;
        name: string | null;
        businessId: string;
        businessName: string | null;
      }>;
    }
  >();

  for (const row of rows.slice(0, IMPERSONATION_DIRECTORY_LIMIT)) {
    const businessId = row.business_id;
    const business = businesses.get(businessId) ?? {
      id: businessId,
      name: row.business_name ?? null,
      users: [],
    };
    business.users.push({
      id: row.id,
      login: row.login ?? null,
      name: row.name ?? null,
      businessId,
      businessName: row.business_name ?? null,
    });
    businesses.set(businessId, business);
  }

  return { truncated, businesses: Array.from(businesses.values()) };
}

export async function searchImpersonationTargets(
  db: D1Database,
  query: string,
): Promise<{
  sessions: Array<{
    sessionId: string;
    title: string | null;
    updatedAt: string | number | null;
    owner: { id: number; login: string | null; name: string | null; email: string | null };
    businessId: string;
    businessName: string | null;
  }>;
}> {
  const like = `%${escapeLike(query.toLowerCase())}%`;

  const sessionsResult = await db
    .prepare(
      `SELECT s.session_id, s.title, s.updated_at,
              u.id AS owner_user_id, u.login AS owner_login, u.name AS owner_name, NULL AS owner_email,
              s.business_id, b.name AS business_name
       FROM session_index s
       INNER JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN businesses b ON b.id = s.business_id
       WHERE LOWER(s.session_id) = LOWER(?) OR LOWER(s.session_id) LIKE ? ESCAPE '\\'
       ORDER BY
         CASE WHEN LOWER(s.session_id) = LOWER(?) THEN 0 ELSE 1 END,
         s.updated_at DESC,
         s.session_id DESC
       LIMIT ?`,
    )
    .bind(query, like, query, IMPERSONATION_SEARCH_LIMIT)
    .all<ImpersonationSearchSessionRow>();

  return {
    sessions: (sessionsResult.results ?? []).map((row) => ({
      sessionId: row.session_id,
      title: row.title ?? null,
      updatedAt: row.updated_at ?? null,
      owner: {
        id: row.owner_user_id,
        login: row.owner_login ?? null,
        name: row.owner_name ?? null,
        email: row.owner_email ?? null,
      },
      businessId: row.business_id,
      businessName: row.business_name ?? null,
    })),
  };
}

export async function getActiveImpersonationTarget(
  db: D1Database,
  targetUserId: number,
): Promise<{ id: number; login: string | null; businessId: string } | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.login, u.business_id, bm.user_id AS member_id
       FROM users u
       LEFT JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = u.business_id
       WHERE u.id = ? LIMIT 1`,
    )
    .bind(targetUserId)
    .first<{ id: number; login: string | null; business_id: string | null; member_id: number | null }>();
  if (!row?.business_id || !row.member_id) return null;
  return { id: row.id, login: row.login ?? null, businessId: row.business_id };
}

export async function createImpersonationIfActorBelowLimit(
  db: D1Database,
  params: {
    id: string;
    tokenHash: string;
    actorUserId: number;
    targetUserId: number;
    reason: string;
    ttlMs: number;
    maxActivePerActor: number;
    now?: number;
  },
): Promise<ImpersonationRow | null> {
  const now = params.now ?? Date.now();
  const expiresAt = now + params.ttlMs;
  const result = await db
    .prepare(
      `INSERT INTO impersonation_sessions
        (id, token_hash, actor_user_id, target_user_id, reason, expires_at, revoked_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL, ?
       WHERE (
         SELECT COUNT(*)
         FROM impersonation_sessions
         WHERE actor_user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ) < ?`,
    )
    .bind(
      params.id,
      params.tokenHash,
      params.actorUserId,
      params.targetUserId,
      params.reason,
      expiresAt,
      now,
      params.actorUserId,
      now,
      params.maxActivePerActor,
    )
    .run();

  if (result.meta?.changes !== 1) return null;

  return {
    id: params.id,
    actorUserId: params.actorUserId,
    targetUserId: params.targetUserId,
    reason: params.reason,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  };
}

export async function revokeImpersonation(
  db: D1Database,
  id: string,
  actorUserId: number,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE impersonation_sessions
       SET revoked_at = ?
       WHERE id = ? AND actor_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, id, actorUserId)
    .run();
  return d1Changed(result);
}

/**
 * Revoke an impersonation row by token hash. Returns the row info if a row was
 * actually revoked (so callers can emit an audit log), or null when the cookie
 * did not correspond to an active session.
 */
export async function revokeImpersonationByTokenHash(
  db: D1Database,
  tokenHash: string,
  now = Date.now(),
): Promise<{ id: string; actorUserId: number; targetUserId: number } | null> {
  const row = await db
    .prepare(
      `SELECT id, actor_user_id, target_user_id
       FROM impersonation_sessions
       WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{ id: string; actor_user_id: number; target_user_id: number }>();
  if (!row) return null;
  const result = await db
    .prepare(
      `UPDATE impersonation_sessions
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(now, row.id)
    .run();
  if (!d1Changed(result)) return null;
  return { id: row.id, actorUserId: row.actor_user_id, targetUserId: row.target_user_id };
}

type ImpersonationJoinRow = {
  id: string;
  actor_user_id: number;
  target_user_id: number;
  reason: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  // target user
  t_id: number;
  t_github_id: number | null;
  t_login: string | null;
  t_name: string | null;
  t_email: string | null;
  t_business_id: string | null;
  t_shared_sessions: number | null;
  t_business_role: string | null;
  t_member_ids: string | null;
  // actor user
  a_id: number;
  a_github_id: number | null;
  a_login: string | null;
  a_name: string | null;
  a_email: string | null;
  a_business_id: string | null;
  a_business_role: string | null;
};

export async function resolveImpersonationByTokenHash(
  db: D1Database,
  tokenHash: string,
  now = Date.now(),
): Promise<ResolveImpersonationResult> {
  const row = await db
    .prepare(
      `SELECT i.id, i.actor_user_id, i.target_user_id, i.reason, i.expires_at, i.revoked_at, i.created_at,
              t.id AS t_id, t.github_id AS t_github_id, t.login AS t_login, t.name AS t_name, t.email AS t_email,
              t.business_id AS t_business_id, tb.shared_sessions AS t_shared_sessions,
              tbm.role AS t_business_role,
              CASE WHEN tb.shared_sessions = 1
                   THEN (SELECT GROUP_CONCAT(id) FROM users WHERE business_id = t.business_id)
                   ELSE NULL
              END AS t_member_ids,
              a.id AS a_id, a.github_id AS a_github_id, a.login AS a_login, a.name AS a_name, a.email AS a_email,
              a.business_id AS a_business_id, abm.role AS a_business_role
       FROM impersonation_sessions i
       INNER JOIN users t ON t.id = i.target_user_id
       INNER JOIN businesses tb ON tb.id = t.business_id
       LEFT JOIN business_members tbm ON tbm.user_id = t.id AND tbm.business_id = t.business_id
       INNER JOIN users a ON a.id = i.actor_user_id
       LEFT JOIN business_members abm ON abm.user_id = a.id AND abm.business_id = a.business_id
       WHERE i.token_hash = ? LIMIT 1`,
    )
    .bind(tokenHash)
    .first<ImpersonationJoinRow>();

  if (!row) return { status: "invalid" };
  if (row.revoked_at !== null) return { status: "invalid" };
  if (Number(row.expires_at) <= now) return { status: "invalid" };
  if (!row.t_business_id || !row.a_business_id) return { status: "invalid" };

  const sharedSessions = row.t_shared_sessions === 1;
  const businessMemberIds = row.t_member_ids ? row.t_member_ids.split(",") : undefined;

  const target: UserInfo = {
    id: row.t_id,
    githubUserId: row.t_github_id ?? null,
    login: row.t_login ?? null,
    name: row.t_name ?? null,
    email: row.t_email ?? null,
    businessId: row.t_business_id,
    businessRole: toBusinessRole(row.t_business_role),
    sharedSessions,
    businessMemberIds,
  };

  const actor: UserInfo = {
    id: row.a_id,
    githubUserId: row.a_github_id ?? null,
    login: row.a_login ?? null,
    name: row.a_name ?? null,
    email: row.a_email ?? null,
    businessId: row.a_business_id,
    businessRole: toBusinessRole(row.a_business_role),
    sharedSessions: false,
  };

  // Re-check the operator's authority on every request, not just at mint time.
  // The joined row already carries the actor's current github id, business, and
  // role, so a demoted (or off-business) operator's still-unexpired token must
  // fail closed here rather than retain access until natural expiry. Mirrors
  // the verifyCycloidAdmin gate used to mint the token.
  if (!isCycloidAdmin(actor)) {
    // Defense in depth: the recheck above already denies this request, but the
    // row is neither expired nor revoked, so it would still look "active" in
    // audit views and could be replayed against any future path that only
    // checks revoked_at/expires_at. Proactively revoke it. Best-effort: a
    // failed write must not turn the denial into an allow.
    await revokeImpersonation(db, row.id, row.actor_user_id, now).catch(() => false);
    return { status: "invalid" };
  }

  return {
    status: "ok",
    resolved: {
      row: {
        id: row.id,
        actorUserId: row.actor_user_id,
        targetUserId: row.target_user_id,
        reason: row.reason,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      },
      target,
      actor,
    },
  };
}

export async function getImpersonationById(db: D1Database, id: string): Promise<ImpersonationRow | null> {
  const row = await db
    .prepare(
      `SELECT id, actor_user_id, target_user_id, reason, expires_at, revoked_at, created_at
       FROM impersonation_sessions WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<{
      id: string;
      actor_user_id: number;
      target_user_id: number;
      reason: string;
      expires_at: number;
      revoked_at: number | null;
      created_at: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    targetUserId: row.target_user_id,
    reason: row.reason,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}
