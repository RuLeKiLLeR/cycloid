import type { MemoryReconciliationRepoTarget } from "../company-memory/reconcile";
import type { MemoryReviewStatus } from "../company-memory/review-db";
import {
  getMemoryReviewForBusiness,
  listMemoryReviewForBusiness,
  type MemoryReviewSourceFilter,
  resolveMemoryReviewForBusiness,
  runMemoryReviewReconciliation,
} from "../company-memory/review-service";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { Route } from "./shared";
import { getRequestSearchParams, paginateQueryFromRequest, parsePattern, requireBusinessAdmin } from "./shared";

const REVIEW_STATUSES = new Set<MemoryReviewStatus>(["pending", "applied", "approved", "rejected", "dismissed"]);

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseStatus(value: string | null): MemoryReviewStatus | null {
  if (!value) return null;
  return REVIEW_STATUSES.has(value as MemoryReviewStatus) ? (value as MemoryReviewStatus) : null;
}

function parseRepoTargets(value: unknown): MemoryReconciliationRepoTarget[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const targets: MemoryReconciliationRepoTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const owner = optionalString(record.owner);
    const name = optionalString(record.name);
    const ref = optionalString(record.ref);
    if (!owner || !name) return null;
    targets.push(ref ? { owner, name, ref } : { owner, name });
  }
  return targets;
}

export const memoryReviewRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/memory-review"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const params = getRequestSearchParams(request);
      const businessId = params.get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const statusParam = params.get("status")?.trim() ?? null;
      const status = parseStatus(statusParam);
      if (statusParam && !status) return jsonErrorResponse("Invalid status", 400);
      const source = params.get("source")?.trim() ?? null;
      if (source && source !== "d1" && source !== "repo" && source !== "cross_store") {
        return jsonErrorResponse("Invalid source", 400);
      }
      const { cursor, limit } = paginateQueryFromRequest(request, 100);
      const result = await listMemoryReviewForBusiness(db, {
        businessId,
        status,
        source: source as MemoryReviewSourceFilter | null,
        cursor,
        limit: limit ?? 100,
      });
      return jsonResponse({ ok: true, candidates: result.candidates, nextCursor: result.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/memory-review/:id"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const db = assertDatabase(env);
      const businessId = getRequestSearchParams(request).get("business_id")?.trim();
      const id = match.groups?.id;
      if (!businessId || !id) return jsonErrorResponse("business_id and id are required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const candidate = await getMemoryReviewForBusiness(db, businessId, id);
      if (!candidate) return jsonErrorResponse("Not found", 404);
      return jsonResponse({ ok: true, candidate });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/memory-review/:id/resolve"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const db = assertDatabase(env);
      const body = await parseJsonBody(request);
      if (!body) return jsonErrorResponse("Invalid JSON body", 400);
      const businessId = optionalString(body.business_id ?? body.businessId);
      const action = optionalString(body.action);
      const id = match.groups?.id;
      if (!businessId || !id || !action) return jsonErrorResponse("business_id, id, and action are required", 400);
      if (action !== "approve" && action !== "reject" && action !== "dismiss")
        return jsonErrorResponse("Invalid action", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const userId = Number(auth!.userId);
      const candidate = await resolveMemoryReviewForBusiness(db, {
        businessId,
        id,
        action,
        resolvedByUserId: Number.isSafeInteger(userId) ? userId : null,
      });
      if (!candidate) return jsonErrorResponse("Review candidate is not pending", 409);
      return jsonResponse({ ok: true, candidate });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/memory-review/reconcile"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const body = await parseJsonBody(request);
      if (!body) return jsonErrorResponse("Invalid JSON body", 400);
      const businessId = optionalString(body.business_id ?? body.businessId);
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const repoTargets = parseRepoTargets(body.repos ?? body.repoTargets);
      if (!repoTargets) return jsonErrorResponse("Invalid repos", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const result = await runMemoryReviewReconciliation(env, { businessId, repoTargets });
      return jsonResponse({ ok: true, result });
    },
  },
];
