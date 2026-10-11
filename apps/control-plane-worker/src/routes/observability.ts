import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import { PROMPT_RUNS_DEFAULT_LIMIT, PROMPT_RUNS_MAX_LIMIT } from "../constants/observability";
import { createLogger } from "../logger";
import { verifyCycloidMember } from "../services/internal-feature-gate";
import {
  buildSessionDebugSummary,
  getSessionFeedbackSummaries,
  getSessionTelemetry,
  queryPromptRuns,
  querySessionOutcomeHarm,
  searchSessions,
} from "../services/observability";
import { canAccessSession } from "../session/db";
import { assertDatabase, getSessionSandboxState, getSessionState, listSessionArtifactsAuthed } from "../session/state";
import type { AuthInfo, Env, SessionState } from "../types";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { authorizeSessionRepoAccess, type SessionRouteState } from "./sessions";
import type { Route } from "./shared";
import { paginateQuery, parsePattern, requireRouteAuth } from "./shared";

const log = createLogger();

function internalDebugActorLogFields(auth: AuthInfo) {
  return {
    actorUserId: auth.actorUserId ?? auth.userId,
    actorBusinessId: auth.actorUser?.businessId ?? auth.user?.businessId ?? null,
  };
}

async function authorizeObservabilitySession(env: Env, auth: AuthInfo, sessionId: string, operation: string) {
  const session = await getSessionState(env, sessionId);
  if (!session) {
    return { ok: false as const, response: jsonErrorResponse("Session not found", 404) };
  }
  if (!canAccessSession(auth, session)) {
    return { ok: false as const, response: jsonErrorResponse("Session not found", 404) };
  }
  const repoAccess = await authorizeSessionRepoAccess(env, auth, sessionId, session as SessionRouteState, operation);
  if (!repoAccess.ok) return { ok: false as const, response: repoAccess.response };
  return { ok: true as const, session, authCtx: repoAccess.authCtx };
}

function parseIsoTimestampParam(value: string | null, name: string) {
  if (!value) return { ok: true as const, value: undefined };

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return {
      ok: false as const,
      response: jsonErrorResponse(`${name} must be an ISO timestamp`, 400),
    };
  }
  return { ok: true as const, value: parsed };
}

function parsePromptRunsLimitParam(value: string | null) {
  if (value === null || value.trim() === "") {
    return { ok: true as const, value: PROMPT_RUNS_DEFAULT_LIMIT };
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false as const, response: jsonErrorResponse("limit must be a non-negative integer", 400) };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false as const, response: jsonErrorResponse("limit must be a non-negative integer", 400) };
  }
  if (parsed === 0) {
    return { ok: false as const, response: jsonErrorResponse("limit must be greater than zero", 400) };
  }
  return { ok: true as const, value: Math.min(parsed, PROMPT_RUNS_MAX_LIMIT) };
}

async function canUseInternalSessionDebug(env: Env, auth: AuthInfo): Promise<boolean> {
  if (
    auth.authMode !== "user_session" &&
    auth.authMode !== "cli_token" &&
    auth.authMode !== "impersonated_user_session"
  ) {
    return false;
  }
  return verifyCycloidMember(env.DB, auth);
}

async function authorizeInternalSessionDebug(env: Env, auth: AuthInfo, sessionId: string, requestId?: string | null) {
  const session = await getSessionState(env, sessionId, requestId);
  if (!session) {
    log.info(
      {
        event: "internal_session_debug_access",
        ...internalDebugActorLogFields(auth),
        targetSessionId: sessionId,
        outcome: "session_not_found",
      },
      "Internal session debug request target was not found",
    );
    return { ok: false as const, response: jsonErrorResponse("Session not found", 404) };
  }

  if (!(await canUseInternalSessionDebug(env, auth))) {
    log.info(
      {
        event: "internal_session_debug_access",
        ...internalDebugActorLogFields(auth),
        targetSessionId: sessionId,
        targetBusinessId: session.businessId ?? null,
        targetOwnerUserId: session.ownerUserId,
        outcome: "denied",
      },
      "Denied internal session debug request",
    );
    return { ok: false as const, response: jsonErrorResponse("Session not found", 404) };
  }

  return { ok: true as const, session };
}

export const observabilityRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/debug-summary"),
    auth: "authenticated",
    // ARC-830: gated by canUseInternalSessionDebug. Customer CLI tokens
    // (and any cli_token whose business is not Cycloid-internal) fail
    // that gate and receive 404. Cycloid-internal CLI tokens are an
    // intentional carve-out: they can read any business's debug summary
    // for admin debugging. The flag here means "customer cross-business
    // reads are blocked", not "cross-business reads are impossible".
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;

      const requestId = request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID);
      const sessionAccess = await authorizeInternalSessionDebug(env, routeAuth, sessionId, requestId);
      if (!sessionAccess.ok) return sessionAccess.response;

      const limit = parsePromptRunsLimitParam(new URL(request.url).searchParams.get("limit"));
      if (!limit.ok) return limit.response;

      const summary = await buildSessionDebugSummary(env, sessionId, requestId, sessionAccess.session, limit.value);
      if (!summary) return jsonErrorResponse("Session not found", 404);

      log.info(
        {
          event: "internal_session_debug_access",
          ...internalDebugActorLogFields(routeAuth),
          targetSessionId: sessionId,
          targetBusinessId: sessionAccess.session.businessId ?? null,
          targetOwnerUserId: sessionAccess.session.ownerUserId,
          outcome: "allowed",
        },
        "Allowed internal session debug request",
      );
      return jsonResponse(summary);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/telemetry"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;

      const db = assertDatabase(env);

      const sessionAccess = await authorizeObservabilitySession(env, routeAuth, sessionId, "telemetry");
      if (!sessionAccess.ok) return sessionAccess.response;

      const limit = parsePromptRunsLimitParam(new URL(request.url).searchParams.get("limit"));
      if (!limit.ok) return limit.response;

      const telemetry = await getSessionTelemetry(db, sessionId, limit.value);
      return jsonResponse({ ok: true, ...telemetry });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/observability/runs"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);

      const db = assertDatabase(env);

      const url = new URL(request.url);
      const createdAfter = parseIsoTimestampParam(url.searchParams.get("createdAfter"), "createdAfter");
      if (!createdAfter.ok) return createdAfter.response;
      const createdBefore = parseIsoTimestampParam(url.searchParams.get("createdBefore"), "createdBefore");
      if (!createdBefore.ok) return createdBefore.response;

      const result = await queryPromptRuns(
        db,
        {
          repo: url.searchParams.get("repo"),
          model: url.searchParams.get("model"),
          agent: url.searchParams.get("agent"),
          outcome: url.searchParams.get("outcome"),
          errorCode: url.searchParams.get("errorCode"),
          sessionId: url.searchParams.get("sessionId"),
          promptId: url.searchParams.get("promptId"),
          source: url.searchParams.get("source"),
          createdAfter: createdAfter.value,
          createdBefore: createdBefore.value,
          limit: Number(url.searchParams.get("limit")) || undefined,
          offset: Number(url.searchParams.get("offset")) || undefined,
        },
        routeAuth,
      );

      return jsonResponse({ ok: true, ...result });
    },
  },
  {
    // Session-deduped harm ranking (outcome-truth layer). Admin-only: a per-owner harm
    // aggregate is not meaningful, so non-admins get 403 rather than an owner-scoped slice.
    method: "GET",
    pattern: parsePattern("/api/observability/session-outcomes"),
    auth: "authenticated",
    adminTokenOnly: true,
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      if (!routeAuth.canAccessAllSessions) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);

      const db = assertDatabase(env);

      const url = new URL(request.url);
      const createdAfter = parseIsoTimestampParam(url.searchParams.get("createdAfter"), "createdAfter");
      if (!createdAfter.ok) return createdAfter.response;
      const createdBefore = parseIsoTimestampParam(url.searchParams.get("createdBefore"), "createdBefore");
      if (!createdBefore.ok) return createdBefore.response;

      const result = await querySessionOutcomeHarm(db, {
        createdAfter: createdAfter.value,
        createdBefore: createdBefore.value,
      });

      return jsonResponse({ ok: true, ...result });
    },
  },

  // Sandbox state (DO-internal diagnostics)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox-state"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups?.sessionId;
      if (!sessionId) return jsonErrorResponse("Missing sessionId", 400);

      const sessionAccess = await authorizeObservabilitySession(env, routeAuth, sessionId, "sandbox_state");
      if (!sessionAccess.ok) return sessionAccess.response;

      const result = await getSessionSandboxState(
        env,
        sessionId,
        request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID),
        sessionAccess.authCtx,
      );
      if (!result.ok) return jsonResponse({ ok: false, error: "Session not found" }, result.status);
      return jsonResponse(result.payload);
    },
  },

  // Session artifacts list (DO-internal)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/artifacts/list"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups?.sessionId;
      if (!sessionId) return jsonErrorResponse("Missing sessionId", 400);

      // Single DO hop: fetch the artifacts list once (without a prior
      // getSessionState), then authorize in the worker using the session
      // identity carried in the payload. We do NOT forward auth headers to the
      // DO (its checkAccess is redundant defense-in-depth that only gates 404),
      // and we prove access before returning any artifacts.
      const result = await listSessionArtifactsAuthed(
        env,
        sessionId,
        request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID),
        undefined,
      );
      if (!result.ok || !result.payload) {
        return jsonResponse({ ok: false, error: "Session not found" }, result.ok ? 502 : result.status);
      }

      const session = result.payload.session;
      // Fail closed: the DO must return identity for the worker to authorize.
      if (!session) {
        return jsonResponse({ ok: false, error: "Session not found" }, 404);
      }
      // Identity mismatch -> 404 (no existence leak), before any repo check.
      if (!canAccessSession(routeAuth, session as unknown as SessionState)) {
        return jsonResponse({ ok: false, error: "Session not found" }, 404);
      }
      // Prove repo access (403 denied / 404 missing-repo / 503) before returning
      // artifacts. The payload's session carries repoOwner/repoName/installationId,
      // so no second DO hop is needed to supply repo context.
      const repoAccess = await authorizeSessionRepoAccess(
        env,
        routeAuth,
        sessionId,
        session as unknown as SessionRouteState,
        "artifacts_list",
      );
      if (!repoAccess.ok) return repoAccess.response;

      // Access proven: return the artifacts payload only now.
      return jsonResponse({ ok: true, artifacts: result.payload.artifacts });
    },
  },

  // All feedback for a session (D1)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/feedback/all"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups?.sessionId;
      if (!sessionId) return jsonErrorResponse("Missing sessionId", 400);

      const db = env.DB;
      if (!db) return jsonErrorResponse("Database not configured", 503);

      const sessionAccess = await authorizeObservabilitySession(env, routeAuth, sessionId, "feedback_all");
      if (!sessionAccess.ok) return sessionAccess.response;

      const feedback = await getSessionFeedbackSummaries(db, sessionId);
      return jsonResponse({ ok: true, feedback });
    },
  },

  // Search sessions (cross-session query with repo/status/date filters)
  {
    method: "GET",
    pattern: parsePattern("/api/observability/sessions"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);

      const db = env.DB;
      if (!db) return jsonErrorResponse("Database not configured", 503);
      const url = new URL(request.url);
      const createdAfter = parseIsoTimestampParam(url.searchParams.get("createdAfter"), "createdAfter");
      if (!createdAfter.ok) return createdAfter.response;
      const createdBefore = parseIsoTimestampParam(url.searchParams.get("createdBefore"), "createdBefore");
      if (!createdBefore.ok) return createdBefore.response;
      const pagination = paginateQuery(null, url.searchParams.get("limit"), 200);

      const result = await searchSessions(
        db,
        {
          repo: url.searchParams.get("repo"),
          status: url.searchParams.get("status"),
          model: url.searchParams.get("model"),
          outcome: url.searchParams.get("outcome"),
          createdAfter: createdAfter.value,
          createdBefore: createdBefore.value,
          limit: pagination.limit,
        },
        routeAuth,
      );

      return jsonResponse({ ok: true, ...result });
    },
  },
];
