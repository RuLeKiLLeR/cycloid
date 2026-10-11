import {
  getAdminBusinessDetail,
  getAdminUserDetail,
  listAdminBusinessesDetailed,
  listAdminSessions,
  searchAdminBusinesses,
  searchAdminUsers,
} from "../services/admin-console";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { getRequestSearchParams, getTrimmedQueryParam, parsePattern, requireCycloidAdmin } from "./shared";

function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseSessionStatus(raw: string | null): "active" | "closed" | "archived" | undefined {
  if (raw === "active" || raw === "closed" || raw === "archived") return raw;
  return undefined;
}

export const adminConsoleRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/console/businesses"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const db = assertDatabase(env);
      const searchParams = getRequestSearchParams(request);
      const limit = parsePositiveInt(searchParams.get("limit")) ?? undefined;
      const orderByParam = searchParams.get("orderBy");
      const orderBy = orderByParam === "createdAt" ? "createdAt" : "name";
      const query = getTrimmedQueryParam(searchParams, "q") ?? undefined;
      const businesses = query
        ? await searchAdminBusinesses(db, { query, limit, orderBy })
        : await listAdminBusinessesDetailed(db, { limit, orderBy });
      return jsonResponse({ ok: true, businesses });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/console/businesses/:id"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const businessId = match.groups?.id;
      if (!businessId) return jsonErrorResponse("Invalid business id", 400);
      const db = assertDatabase(env);
      const detail = await getAdminBusinessDetail(db, businessId);
      if (!detail) return jsonErrorResponse("Business not found", 404);
      return jsonResponse({ ok: true, business: detail });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/console/users"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const db = assertDatabase(env);
      const url = new URL(request.url);
      const query = url.searchParams.get("q") ?? undefined;
      const limit = parsePositiveInt(url.searchParams.get("limit")) ?? undefined;
      const users = await searchAdminUsers(db, { query, limit });
      return jsonResponse({ ok: true, users });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/console/users/:id"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const userId = parsePositiveInt(match.groups?.id);
      if (userId === null) return jsonErrorResponse("Invalid user id", 400);
      const db = assertDatabase(env);
      const detail = await getAdminUserDetail(db, userId);
      if (!detail) return jsonErrorResponse("User not found", 404);
      return jsonResponse({ ok: true, user: detail });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/console/sessions"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const db = assertDatabase(env);
      const url = new URL(request.url);
      const sessions = await listAdminSessions(db, {
        businessId: url.searchParams.get("businessId") ?? undefined,
        userId: parsePositiveInt(url.searchParams.get("userId")) ?? undefined,
        status: parseSessionStatus(url.searchParams.get("status")),
        limit: parsePositiveInt(url.searchParams.get("limit")) ?? undefined,
      });
      return jsonResponse({ ok: true, sessions });
    },
  },
];
