import { listOpenPendingSignups, purgeDeniedPendingSignupsOlderThan } from "../auth/pending-signups-db";
import { listBusinesses } from "../business/db";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import { createLogger } from "../logger";
import { approvePendingSignup, ApprovePendingSignupSchema, denyPendingSignup } from "../services/admin-approvals";
import { invalidateModelsMemoryCache, modelsCacheKey } from "../services/bootstrap";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parseBody, parsePattern, requireCycloidAdmin } from "./shared";
const log = createLogger({ bindings: { component: "admin-approvals-routes" } });
const DENIED_PENDING_SIGNUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parsePendingId(match: RegExpMatchArray): number | null {
  return parsePositiveInt(match.groups?.id);
}

async function bestEffortPurgeExpiredDeniedPendingSignups(db: D1Database): Promise<void> {
  try {
    const purged = await purgeDeniedPendingSignupsOlderThan(db, Date.now() - DENIED_PENDING_SIGNUP_RETENTION_MS);
    if (purged > 0) {
      log.info({ purged, action: "pending_signups_purged" }, "Purged expired denied pending signups");
    }
  } catch (error) {
    log.warn({ error: String(error) }, "Failed to purge expired denied pending signups");
  }
}

export const adminApprovalRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/pending-signups"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const db = assertDatabase(env);
      await bestEffortPurgeExpiredDeniedPendingSignups(db);
      const signups = await listOpenPendingSignups(db);
      return jsonResponse({ ok: true, signups });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/businesses"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const db = assertDatabase(env);
      const businesses = await listBusinesses(db);
      return jsonResponse({ ok: true, businesses });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/pending-signups/:id/approve"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const pendingId = parsePendingId(match);
      if (pendingId === null) return jsonErrorResponse("Invalid pending signup id", 400);

      const parsedBody = await parseBody(request, ApprovePendingSignupSchema);
      if (!parsedBody.ok) return parsedBody.response;

      const approverUserId = parsePositiveInt(auth!.userId);
      if (approverUserId === null) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
      const db = assertDatabase(env);
      await bestEffortPurgeExpiredDeniedPendingSignups(db);
      const result = await approvePendingSignup(db, pendingId, parsedBody.value, approverUserId);
      switch (result.status) {
        case "ok":
          invalidateModelsMemoryCache(result.userId);
          await env.DERIVED_MODELS.delete(modelsCacheKey(result.userId)).catch(() => {});
          return jsonResponse({ ok: true, userId: result.userId, businessId: result.businessId });
        case "not_found":
          return jsonErrorResponse("Pending signup not found", 404);
        case "already_denied":
          return jsonErrorResponse("Pending signup is already denied", 409);
        case "business_not_found":
          return jsonErrorResponse("Business not found", 404);
        case "existing_user_conflict":
          return jsonErrorResponse("Pending signup conflicts with an existing user", 409);
      }
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/pending-signups/:id/deny"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const guard = await requireCycloidAdmin(env, auth!);
      if (guard) return guard;
      const pendingId = parsePendingId(match);
      if (pendingId === null) return jsonErrorResponse("Invalid pending signup id", 400);

      const denierUserId = parsePositiveInt(auth!.userId);
      if (denierUserId === null) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
      const db = assertDatabase(env);
      await bestEffortPurgeExpiredDeniedPendingSignups(db);
      const result = await denyPendingSignup(db, pendingId, denierUserId);
      switch (result.status) {
        case "ok":
          return jsonResponse({ ok: true });
        case "not_found":
          return jsonErrorResponse("Pending signup not found", 404);
        case "already_denied":
          return jsonErrorResponse("Pending signup is already denied", 409);
      }
    },
  },
];
