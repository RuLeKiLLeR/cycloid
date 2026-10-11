// Read-only aggregation queries powering the /admin console.
//
// Auth and gating is handled by the route layer via requireCycloidAdmin.
// This module orchestrates D1 reads via DAO helpers and returns flat JSON-ready shapes.

import type { BusinessRole } from "../auth/business-role";
import { searchAdminBusinesses as searchAdminBusinessesDao } from "../business/db";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

export type AdminBusinessSummary = {
  id: string;
  name: string;
  createdAt: number;
  memberCount: number;
  sessionCount: number;
  lastSessionAt: number | null;
};

export type AdminUserSummary = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  businessId: string;
  businessName: string | null;
  createdAt: number;
};

export type AdminBusinessDetail = AdminBusinessSummary & {
  members: AdminMember[];
  recentSessions: AdminSessionRow[];
};

export type AdminMember = {
  userId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: BusinessRole;
  joinedAt: number;
  lastSessionAt: number | null;
};

export type AdminUserDetail = AdminUserSummary & {
  memberships: Array<{ businessId: string; businessName: string; role: BusinessRole; joinedAt: number }>;
  recentSessions: AdminSessionRow[];
  sessionCount: number;
};

export type AdminSessionRow = {
  sessionId: string;
  title: string | null;
  status: string;
  richStatus: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  ownerUserId: number | null;
  ownerLogin: string | null;
  businessId: string;
  businessName: string | null;
};

export type AdminSessionFilters = {
  businessId?: string;
  userId?: number;
  status?: "active" | "closed" | "archived";
  limit?: number;
};

export async function listAdminBusinessesDetailed(
  db: D1Database,
  options: { limit?: number; orderBy?: "createdAt" | "name" } = {},
): Promise<AdminBusinessSummary[]> {
  return searchAdminBusinesses(db, options);
}

export async function searchAdminBusinesses(
  db: D1Database,
  options: { query?: string; limit?: number; orderBy?: "createdAt" | "name" } = {},
): Promise<AdminBusinessSummary[]> {
  const limit = clampLimit(options.limit);
  return searchAdminBusinessesDao(db, {
    query: options.query?.trim() || undefined,
    limit,
    orderBy: options.orderBy,
  });
}

export async function getAdminBusinessDetail(db: D1Database, businessId: string): Promise<AdminBusinessDetail | null> {
  const biz = await db
    .prepare(
      `SELECT b.id, b.name, b.created_at,
              (SELECT COUNT(*) FROM business_members bm WHERE bm.business_id = b.id) AS member_count,
              (SELECT COUNT(*) FROM session_index s WHERE s.business_id = b.id) AS session_count,
              (SELECT MAX(s.created_at) FROM session_index s WHERE s.business_id = b.id) AS last_session_at
       FROM businesses b WHERE b.id = ? LIMIT 1`,
    )
    .bind(businessId)
    .first<{
      id: string;
      name: string;
      created_at: number;
      member_count: number;
      session_count: number;
      last_session_at: number | null;
    }>();
  if (!biz) return null;

  const [members, recentSessions] = await Promise.all([
    db
      .prepare(
        `SELECT u.id AS user_id, u.login, u.name, u.email, u.avatar_url,
                bm.role, bm.created_at AS joined_at,
                (SELECT MAX(s.created_at) FROM session_index s WHERE s.owner_user_id = u.id) AS last_session_at
         FROM business_members bm
         INNER JOIN users u ON u.id = bm.user_id
         WHERE bm.business_id = ?
         ORDER BY bm.role ASC, u.login COLLATE NOCASE ASC
         LIMIT 200`,
      )
      .bind(businessId)
      .all<{
        user_id: number;
        login: string;
        name: string | null;
        email: string | null;
        avatar_url: string | null;
        role: BusinessRole;
        joined_at: number;
        last_session_at: number | null;
      }>()
      .then((r) =>
        (r.results ?? []).map<AdminMember>((row) => ({
          userId: row.user_id,
          login: row.login,
          name: row.name,
          email: row.email,
          avatarUrl: row.avatar_url,
          role: row.role,
          joinedAt: row.joined_at,
          lastSessionAt: row.last_session_at,
        })),
      ),
    listAdminSessions(db, { businessId, limit: 20 }),
  ]);

  return {
    id: biz.id,
    name: biz.name,
    createdAt: biz.created_at,
    memberCount: biz.member_count,
    sessionCount: biz.session_count,
    lastSessionAt: biz.last_session_at,
    members,
    recentSessions,
  };
}

export async function searchAdminUsers(
  db: D1Database,
  options: { query?: string; limit?: number } = {},
): Promise<AdminUserSummary[]> {
  const limit = clampLimit(options.limit);
  const raw = options.query?.trim() ?? "";
  if (!raw) {
    return listAdminUsersRecent(db, limit);
  }
  const like = `%${raw.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const result = await db
    .prepare(
      `SELECT u.id, u.login, u.name, u.email, u.avatar_url, u.business_id, u.created_at, b.name AS business_name
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       WHERE u.login LIKE ? ESCAPE '\\'
          OR u.email LIKE ? ESCAPE '\\'
          OR u.name  LIKE ? ESCAPE '\\'
       ORDER BY u.login COLLATE NOCASE ASC
       LIMIT ?`,
    )
    .bind(like, like, like, limit)
    .all<UserRow>();
  return (result.results ?? []).map(mapUserRow);
}

export async function getAdminUserDetail(db: D1Database, userId: number): Promise<AdminUserDetail | null> {
  const user = await db
    .prepare(
      `SELECT u.id, u.login, u.name, u.email, u.avatar_url, u.business_id, u.created_at, b.name AS business_name
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       WHERE u.id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<UserRow>();
  if (!user) return null;

  const [memberships, recentSessions, totalSessions] = await Promise.all([
    db
      .prepare(
        `SELECT bm.business_id, b.name AS business_name, bm.role, bm.created_at AS joined_at
         FROM business_members bm
         INNER JOIN businesses b ON b.id = bm.business_id
         WHERE bm.user_id = ?
         ORDER BY bm.created_at ASC`,
      )
      .bind(userId)
      .all<{ business_id: string; business_name: string; role: BusinessRole; joined_at: number }>()
      .then((r) =>
        (r.results ?? []).map((row) => ({
          businessId: row.business_id,
          businessName: row.business_name,
          role: row.role,
          joinedAt: row.joined_at,
        })),
      ),
    listAdminSessions(db, { userId, limit: 20 }),
    db
      .prepare("SELECT COUNT(*) AS n FROM session_index WHERE owner_user_id = ?")
      .bind(userId)
      .first<{ n: number }>()
      .then((r) => r?.n ?? 0),
  ]);

  return {
    ...mapUserRow(user),
    memberships,
    recentSessions,
    sessionCount: totalSessions,
  };
}

export async function listAdminSessions(db: D1Database, filters: AdminSessionFilters): Promise<AdminSessionRow[]> {
  const limit = clampLimit(filters.limit);
  const businessId = filters.businessId ?? null;
  const userId = filters.userId ?? null;
  const status = filters.status ?? null;
  const result = await db
    .prepare(
      `SELECT s.session_id, s.title, s.status, s.rich_status,
              s.created_at, s.updated_at, s.closed_at,
              s.owner_user_id, u.login AS owner_login,
              s.business_id, b.name AS business_name
       FROM session_index s
       LEFT JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN businesses b ON b.id = s.business_id
       WHERE (? IS NULL OR s.business_id = ?)
         AND (? IS NULL OR s.owner_user_id = ?)
         AND (? IS NULL OR s.status = ?)
       ORDER BY s.created_at DESC, s.session_id DESC
       LIMIT ?`,
    )
    .bind(businessId, businessId, userId, userId, status, status, limit)
    .all<{
      session_id: string;
      title: string | null;
      status: string;
      rich_status: string | null;
      created_at: number;
      updated_at: number;
      closed_at: number | null;
      owner_user_id: number | null;
      owner_login: string | null;
      business_id: string;
      business_name: string | null;
    }>();
  return (result.results ?? []).map((row) => ({
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    richStatus: row.rich_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    ownerUserId: row.owner_user_id,
    ownerLogin: row.owner_login,
    businessId: row.business_id,
    businessName: row.business_name,
  }));
}

async function listAdminUsersRecent(db: D1Database, limit: number): Promise<AdminUserSummary[]> {
  const result = await db
    .prepare(
      `SELECT u.id, u.login, u.name, u.email, u.avatar_url, u.business_id, u.created_at, b.name AS business_name
       FROM users u
       LEFT JOIN businesses b ON b.id = u.business_id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ?`,
    )
    .bind(clampLimit(limit))
    .all<UserRow>();
  return (result.results ?? []).map(mapUserRow);
}

type UserRow = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  business_id: string;
  created_at: number;
  business_name: string | null;
};

function mapUserRow(row: UserRow): AdminUserSummary {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    businessId: row.business_id,
    businessName: row.business_name,
    createdAt: row.created_at,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const n = Math.floor(limit as number);
  if (n <= 0) return DEFAULT_LIST_LIMIT;
  if (n > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return n;
}
