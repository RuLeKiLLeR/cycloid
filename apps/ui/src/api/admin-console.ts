import { z } from "zod";

import { swr } from "./cache";
import { requestJson as apiRequestJson } from "./client";

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

export type AdminMember = {
  userId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: "admin" | "member";
  joinedAt: number;
  lastSessionAt: number | null;
};

export type AdminBusinessDetail = AdminBusinessSummary & {
  members: AdminMember[];
  recentSessions: AdminSessionRow[];
};

export type AdminUserDetail = AdminUserSummary & {
  memberships: Array<{ businessId: string; businessName: string; role: "admin" | "member"; joinedAt: number }>;
  recentSessions: AdminSessionRow[];
  sessionCount: number;
};

export type SessionFilters = {
  businessId?: string;
  userId?: number;
  status?: "active" | "closed" | "archived";
  limit?: number;
};

// Hard cap that matches MAX_LIST_LIMIT in the backend service.
const BUSINESSES_LIST_LIMIT = 200;

const adminBusinessSummaryObjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  memberCount: z.number(),
  sessionCount: z.number(),
  lastSessionAt: z.number().nullable(),
});
const adminBusinessSummarySchema: z.ZodType<AdminBusinessSummary> = adminBusinessSummaryObjectSchema;

const adminUserSummaryObjectSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  businessId: z.string(),
  businessName: z.string().nullable(),
  createdAt: z.number(),
});
const adminUserSummarySchema: z.ZodType<AdminUserSummary> = adminUserSummaryObjectSchema;

const adminSessionRowSchema: z.ZodType<AdminSessionRow> = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  richStatus: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable(),
  ownerUserId: z.number().nullable(),
  ownerLogin: z.string().nullable(),
  businessId: z.string(),
  businessName: z.string().nullable(),
});

const adminMemberSchema: z.ZodType<AdminMember> = z.object({
  userId: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(["admin", "member"]),
  joinedAt: z.number(),
  lastSessionAt: z.number().nullable(),
});

const adminBusinessDetailSchema: z.ZodType<AdminBusinessDetail> = adminBusinessSummaryObjectSchema.extend({
  members: z.array(adminMemberSchema),
  recentSessions: z.array(adminSessionRowSchema),
});

const adminUserDetailSchema: z.ZodType<AdminUserDetail> = adminUserSummaryObjectSchema.extend({
  memberships: z.array(
    z.object({
      businessId: z.string(),
      businessName: z.string(),
      role: z.enum(["admin", "member"]),
      joinedAt: z.number(),
    }),
  ),
  recentSessions: z.array(adminSessionRowSchema),
  sessionCount: z.number(),
});

const adminBusinessesResponseSchema: z.ZodType<{ ok: boolean; businesses: AdminBusinessSummary[] }> = z.object({
  ok: z.boolean(),
  businesses: z.array(adminBusinessSummarySchema),
});

const adminBusinessResponseSchema: z.ZodType<{ ok: boolean; business: AdminBusinessDetail }> = z.object({
  ok: z.boolean(),
  business: adminBusinessDetailSchema,
});

const adminUsersResponseSchema: z.ZodType<{ ok: boolean; users: AdminUserSummary[] }> = z.object({
  ok: z.boolean(),
  users: z.array(adminUserSummarySchema),
});

const adminUserResponseSchema: z.ZodType<{ ok: boolean; user: AdminUserDetail }> = z.object({
  ok: z.boolean(),
  user: adminUserDetailSchema,
});

const adminSessionsResponseSchema: z.ZodType<{ ok: boolean; sessions: AdminSessionRow[] }> = z.object({
  ok: z.boolean(),
  sessions: z.array(adminSessionRowSchema),
});

function getAdminJson<T>(url: string, errorMsg: string, schema: z.ZodType<T>): Promise<T> {
  return apiRequestJson<T>(url, undefined, errorMsg, { schema });
}

const consoleKey = {
  businesses: (orderBy: "name" | "createdAt", q: string | undefined) =>
    `/api/admin/console/businesses?orderBy=${orderBy}&limit=${BUSINESSES_LIST_LIMIT}&q=${encodeURIComponent(q ?? "")}`,
  businessesPrefix: (orderBy: "name" | "createdAt") =>
    `/api/admin/console/businesses?orderBy=${orderBy}&limit=${BUSINESSES_LIST_LIMIT}&q=`,
  business: (id: string) => `/api/admin/console/businesses/${id}`,
  users: (q: string | undefined) => `/api/admin/console/users?q=${encodeURIComponent(q ?? "")}`,
  user: (id: number) => `/api/admin/console/users/${id}`,
  sessions: (f: SessionFilters) => {
    const params = new URLSearchParams();
    if (f.businessId) params.set("businessId", f.businessId);
    if (f.userId !== undefined && Number.isSafeInteger(f.userId) && f.userId > 0) {
      params.set("userId", String(f.userId));
    }
    if (f.status) params.set("status", f.status);
    if (f.limit !== undefined) params.set("limit", String(f.limit));
    return `/api/admin/console/sessions?${params.toString()}`;
  },
};

export async function searchAdminBusinesses(
  orderBy: "name" | "createdAt" = "name",
  query: string | undefined,
): Promise<AdminBusinessSummary[]> {
  const result = await swr(
    consoleKey.businesses(orderBy, query),
    () =>
      getAdminJson(
        consoleKey.businesses(orderBy, query),
        "Failed to fetch businesses",
        adminBusinessesResponseSchema,
      ).then((data) => data.businesses),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function fetchAdminBusinessDetail(id: string): Promise<AdminBusinessDetail> {
  const result = await swr(
    consoleKey.business(id),
    () =>
      getAdminJson(consoleKey.business(id), "Failed to fetch business", adminBusinessResponseSchema).then(
        (data) => data.business,
      ),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function searchAdminUsers(query: string | undefined): Promise<AdminUserSummary[]> {
  const result = await swr(
    consoleKey.users(query),
    () =>
      getAdminJson(consoleKey.users(query), "Failed to fetch users", adminUsersResponseSchema).then(
        (data) => data.users,
      ),
    { staleMs: 15_000 },
  );
  return result.value;
}

export async function fetchAdminUserDetail(id: number): Promise<AdminUserDetail> {
  const result = await swr(
    consoleKey.user(id),
    () => getAdminJson(consoleKey.user(id), "Failed to fetch user", adminUserResponseSchema).then((data) => data.user),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function fetchAdminSessions(filters: SessionFilters): Promise<AdminSessionRow[]> {
  const result = await swr(
    consoleKey.sessions(filters),
    () =>
      getAdminJson(consoleKey.sessions(filters), "Failed to fetch sessions", adminSessionsResponseSchema).then(
        (data) => data.sessions,
      ),
    { staleMs: 15_000 },
  );
  return result.value;
}
