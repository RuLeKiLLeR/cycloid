import { z } from "zod";

import { canAdministerCompanyMemory } from "../company-memory/admin-auth";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import type { Logger } from "../logger";
import { verifyCycloidAdmin } from "../services/internal-feature-gate";
import { assertDatabase } from "../session/state";
import type { AuthInfo, Env } from "../types";
import { jsonErrorResponse, parseJsonBody, parseNonNegativeInteger } from "../utils";

type AuthTier = "public" | "sandbox_do_verified" | "webhook" | "callback" | "automation" | "authenticated";

export interface Route {
  method: string;
  pattern: RouteRegExp;
  auth: AuthTier;
  handler: RouteHandler;
  /**
   * Defense-in-depth gate (ARC-830). Set to true on session-scoped routes
   * that have been reviewed for CLI-token / MCP access and block
   * customer-to-customer cross-business reads. Most flagged routes do this
   * via `withSession` -> `canAccessSession` (404 on cross-business). A
   * small number (e.g. debug-summary) intentionally allow Cycloid-internal
   * CLI tokens to traverse business boundaries for admin debugging; those
   * routes must still deny customer CLI tokens with 404. The router rejects
   * any cli_token request to `/api/sessions/...` whose matched route does
   * not declare this flag, so a new MCP-reachable session route cannot land
   * without explicit business-scope review.
   */
  mcpBusinessScopeEnforced?: true;
  /**
   * Set on routes whose handler hard-gates on canAccessAllSessions (admin
   * bearer token only). The router restricts the admin token to
   * ADMIN_TOKEN_ROUTE_ALLOWLIST, so an admin-only route absent from that list
   * is unreachable; an enforcing test asserts every adminTokenOnly route is
   * allowlisted.
   */
  adminTokenOnly?: true;
  /**
   * Opt-out from the impersonation read-only guard. By default the router
   * blocks every authenticated `POST`/`PUT`/`PATCH`/`DELETE` route when the
   * caller is an impersonated browser session. Routes that need to be
   * reachable under impersonation (e.g. the impersonation revoke endpoint,
   * logout) declare `impersonationReadOnlyAllowed: true`. Routes that mutate
   * via `GET` and must also be blocked under impersonation can declare
   * `impersonationMutatingGet: true`.
   */
  impersonationReadOnlyAllowed?: true;
  impersonationMutatingGet?: true;
}

export type RouteHandler = (
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  auth: AuthInfo | null,
  ctx?: ExecutionContext,
) => Promise<Response>;

export type RouteParseResult<T> = { ok: true; value: T } | { ok: false; response: Response };

export async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<RouteParseResult<T>> {
  const parsed = schema.safeParse(await parseJsonBody(request));
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    response: jsonErrorResponse(parsed.error.issues[0]?.message ?? "Invalid request body", 400),
  };
}

export interface RouteRegExp extends RegExp {
  routeTemplate: string;
}

export function parsePattern(pattern: string): RouteRegExp {
  const regexPattern = pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return Object.assign(new RegExp(`^${regexPattern}$`), { routeTemplate: pattern });
}

export function requireRouteAuth(auth: AuthInfo | null): AuthInfo {
  if (!auth) {
    throw new Error("BUG: requireRouteAuth called without auth on an authenticated route");
  }
  return auth;
}

interface CycloidAdminGateOptions {
  allowNonUserSession?: boolean;
  logger?: Pick<Logger, "info" | "warn">;
  logContext?: Record<string, unknown>;
}

function adminGateLogFields(
  auth: AuthInfo,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    userId: auth.userId,
    authMode: auth.authMode,
    tokenSource: auth.tokenSource ?? null,
    impersonation: Boolean(auth.impersonationId),
    readOnly: Boolean(auth.readOnly),
    status,
    ...extra,
  };
}

export async function requireCycloidAdmin(
  env: Env,
  auth: AuthInfo,
  options: CycloidAdminGateOptions = {},
): Promise<Response | null> {
  if (!options.allowNonUserSession && auth.authMode !== "user_session") {
    options.logger?.warn(
      adminGateLogFields(auth, "denied", { ...options.logContext, errorCode: "non_user_session" }),
      "Cycloid admin route denied",
    );
    return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  }
  if (auth.impersonationId || auth.readOnly) {
    options.logger?.warn(
      adminGateLogFields(auth, "denied", { ...options.logContext, errorCode: "readonly_or_impersonation" }),
      "Cycloid admin route denied",
    );
    return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  }
  if (!(await verifyCycloidAdmin(assertDatabase(env), auth))) {
    options.logger?.warn(
      adminGateLogFields(auth, "denied", { ...options.logContext, errorCode: "not_cycloid_admin" }),
      "Cycloid admin route denied",
    );
    return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  }
  options.logger?.info(adminGateLogFields(auth, "allowed", options.logContext), "Cycloid admin route allowed");
  return null;
}

export async function requireBusinessAdmin(
  db: D1Database,
  auth: AuthInfo,
  businessId: string,
): Promise<Response | null> {
  return (await canAdministerCompanyMemory(db, auth, businessId))
    ? null
    : jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
}

export function getRequestSearchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function getTrimmedQueryParam(searchParams: URLSearchParams, key: string): string | null {
  const value = searchParams.get(key)?.trim();
  return value ? value : null;
}

export function getCsvQueryParam(searchParams: URLSearchParams, key: string): string[] {
  const value = getTrimmedQueryParam(searchParams, key);
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

interface QueryPagination {
  cursor: string | null;
  limit: number | undefined;
}

export function paginateQuery(
  rawCursor: string | null | undefined,
  rawLimit: unknown,
  maxLimit = 100,
): QueryPagination {
  const normalizedCursor = rawCursor?.trim();
  const cursor = normalizedCursor ? normalizedCursor : null;

  const parsedLimit = parseNonNegativeInteger(rawLimit, 0);
  const effectiveMaxLimit = Number.isFinite(maxLimit) && maxLimit > 0 ? Math.floor(maxLimit) : 100;
  const limit = parsedLimit > 0 ? Math.min(parsedLimit, effectiveMaxLimit) : undefined;

  return { cursor, limit };
}

export function paginateQueryFromRequest(request: Request, maxLimit = 100): QueryPagination {
  const searchParams = getRequestSearchParams(request);
  return paginateQuery(searchParams.get("cursor"), searchParams.get("limit"), maxLimit);
}
