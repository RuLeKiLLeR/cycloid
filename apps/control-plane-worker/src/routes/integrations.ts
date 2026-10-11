import { z } from "zod";

import {
  BUSINESS_ONLY_SET,
  isLifecycleDebugIntegrationId,
  LIFECYCLE_DEBUG_INTEGRATION_IDS,
  TOGGLEABLE_INTEGRATION_IDS,
  type ToggleableIntegrationId,
} from "../../../../shared/constants/integration-helpers.js";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import {
  getIntegrationLifecycleEventsPage,
  getIntegrationLifecycleSummaries,
  mapReasonCodeToUserMessage,
} from "../integrations/lifecycle/service";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  markMcpServerValidating,
  markMcpServerValidationUnsupported,
  McpRegistryValidationError,
  updateMcpServer,
} from "../integrations/mcp-registry";
import { validateMcpServerTools } from "../integrations/mcp-validation";
import { getIntegrationScopes } from "../integrations/service";
import { canAccessSession } from "../session/db";
import { getSessionState } from "../session/state";
import type { AuthInfo } from "../types";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { paginateQuery, parseBody, parsePattern, requireRouteAuth } from "./shared";

type IntegrationDebugScope = { ok: true; businessId: string | undefined } | { ok: false; response: Response };
type BusinessAdminScope = { ok: true; businessId: string; userId: number | null } | { ok: false; response: Response };
const TOGGLEABLE_INTEGRATION_ID_SET = new Set<string>(TOGGLEABLE_INTEGRATION_IDS);
const McpServerBodySchema = z.object({}).catchall(z.unknown());

function isToggleableIntegrationId(value: string): value is ToggleableIntegrationId {
  return TOGGLEABLE_INTEGRATION_ID_SET.has(value);
}

function resolveIntegrationDebugScope(auth: AuthInfo | null | undefined): IntegrationDebugScope {
  if (!auth) return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
  if (auth.canAccessAllSessions) {
    return { ok: true, businessId: undefined };
  }
  if (auth.user?.businessRole === "admin" && auth.user.businessId) {
    return { ok: true, businessId: auth.user.businessId };
  }
  return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403) };
}

function resolveBusinessAdminScope(auth: AuthInfo | null | undefined): BusinessAdminScope {
  if (!auth) return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
  if (auth.canAccessAllSessions) {
    return { ok: false, response: jsonErrorResponse("business-scoped user session is required", 400) };
  }
  if (auth.user?.businessRole === "admin" && auth.user.businessId) {
    return { ok: true, businessId: auth.user.businessId, userId: auth.user.id };
  }
  return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403) };
}

function mcpValidationErrorResponse(error: unknown): Response | null {
  if (error instanceof McpRegistryValidationError) {
    return jsonErrorResponse(error.message, 400);
  }
  return null;
}

export const integrationRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/integrations/mcp-servers"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) => {
      const scope = resolveBusinessAdminScope(auth);
      if (!scope.ok) return scope.response;
      const servers = await listMcpServers(env.DB, scope.businessId);
      return jsonResponse({ ok: true, servers });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/integrations/mcp-servers"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const scope = resolveBusinessAdminScope(auth);
      if (!scope.ok) return scope.response;
      const parsedBody = await parseBody(request, McpServerBodySchema);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const server = await createMcpServer(env.DB, scope.businessId, scope.userId, parsedBody.value);
        return jsonResponse({ ok: true, server }, 201);
      } catch (error) {
        const response = mcpValidationErrorResponse(error);
        if (response) return response;
        throw error;
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/integrations/mcp-servers/:serverId"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const scope = resolveBusinessAdminScope(auth);
      if (!scope.ok) return scope.response;
      const serverId = match.groups?.serverId;
      if (!serverId) return jsonErrorResponse("Missing serverId", 400);
      const server = await getMcpServer(env.DB, scope.businessId, serverId);
      if (!server) return jsonErrorResponse("MCP server not found", 404);
      return jsonResponse({ ok: true, server });
    },
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/integrations/mcp-servers/:serverId"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const scope = resolveBusinessAdminScope(auth);
      if (!scope.ok) return scope.response;
      const serverId = match.groups?.serverId;
      if (!serverId) return jsonErrorResponse("Missing serverId", 400);
      const parsedBody = await parseBody(request, McpServerBodySchema);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const server = await updateMcpServer(env.DB, scope.businessId, serverId, parsedBody.value);
        if (!server) return jsonErrorResponse("MCP server not found", 404);
        return jsonResponse({ ok: true, server });
      } catch (error) {
        const response = mcpValidationErrorResponse(error);
        if (response) return response;
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/integrations/mcp-servers/:serverId"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const scope = resolveBusinessAdminScope(auth);
      if (!scope.ok) return scope.response;
      const serverId = match.groups?.serverId;
      if (!serverId) return jsonErrorResponse("Missing serverId", 400);
      const deleted = await deleteMcpServer(env.DB, scope.businessId, serverId);
      if (!deleted) return jsonErrorResponse("MCP server not found", 404);
      return jsonResponse({ ok: true });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/integrations/mcp-servers/:serverId/validate"),
    auth: "authenticated",
    handler: async (_request, env, match, auth, ctx) => {
      const scope = resolveBusinessAdminScope(auth);
      if (!scope.ok) return scope.response;
      const serverId = match.groups?.serverId;
      if (!serverId) return jsonErrorResponse("Missing serverId", 400);
      const existing = await getMcpServer(env.DB, scope.businessId, serverId);
      if (!existing) return jsonErrorResponse("MCP server not found", 404);
      if (existing.transport === "stdio" || existing.transport === "sse") {
        const message = `${existing.transport} MCP validation requires sandbox runtime discovery`;
        const server =
          (await markMcpServerValidationUnsupported(env.DB, scope.businessId, serverId, message, {
            transport: existing.transport,
            updatedAt: existing.updatedAt,
          })) ?? null;
        if (!server) return jsonErrorResponse("MCP server changed during validation request", 409);
        return jsonResponse({ ok: true, server });
      }
      const validationStart = await markMcpServerValidating(env.DB, scope.businessId, serverId, {
        transport: existing.transport,
        updatedAt: existing.updatedAt,
      });
      if (!validationStart) return jsonErrorResponse("MCP server changed during validation request", 409);
      const { server, validationJobId } = validationStart;
      const validation = validateMcpServerTools(env, scope.businessId, serverId, validationJobId);
      if (ctx) {
        ctx.waitUntil(validation);
      } else {
        await validation;
      }
      return jsonResponse({ ok: true, server });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/integrations/debug"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const scope = resolveIntegrationDebugScope(auth);
      if (!scope.ok) return scope.response;
      const url = new URL(request.url);
      const pagination = paginateQuery(url.searchParams.get("cursor"), url.searchParams.get("limit"), 100);
      const rawIntegrationId = url.searchParams.get("integrationId");
      if (rawIntegrationId && !isLifecycleDebugIntegrationId(rawIntegrationId)) {
        return jsonErrorResponse("Unsupported integrationId", 400);
      }
      const integrationId =
        rawIntegrationId && isLifecycleDebugIntegrationId(rawIntegrationId) ? rawIntegrationId : undefined;
      const result = await getIntegrationLifecycleEventsPage(env.DB, {
        integrationId,
        businessId: scope.businessId,
        limit: pagination.limit ?? 50,
        cursor: pagination.cursor,
      });
      return jsonResponse({ ok: true, events: result.events, nextCursor: result.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/integrations/debug/:integrationId"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const scope = resolveIntegrationDebugScope(auth);
      if (!scope.ok) return scope.response;
      const integrationId = match.groups?.integrationId;
      if (!integrationId) return jsonErrorResponse("Missing integrationId", 400);
      if (!isLifecycleDebugIntegrationId(integrationId)) {
        return jsonErrorResponse("Unsupported integrationId", 400);
      }
      const url = new URL(request.url);
      const pagination = paginateQuery(url.searchParams.get("cursor"), url.searchParams.get("limit"), 100);
      const result = await getIntegrationLifecycleEventsPage(env.DB, {
        integrationId,
        businessId: scope.businessId,
        limit: pagination.limit ?? 50,
        cursor: pagination.cursor,
      });
      return jsonResponse({ ok: true, events: result.events, nextCursor: result.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/integrations"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;
      const url = new URL(request.url);
      const pagination = paginateQuery(url.searchParams.get("cursor"), url.searchParams.get("limit"), 100);
      const session = await getSessionState(env, sessionId);
      if (!session || !canAccessSession(routeAuth, session)) {
        return jsonErrorResponse("Session not found", 404);
      }
      const result = await getIntegrationLifecycleEventsPage(env.DB, {
        sessionId,
        limit: pagination.limit ?? 50,
        cursor: pagination.cursor,
      });
      return jsonResponse({ ok: true, events: result.events, nextCursor: result.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/integrations/me"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) => {
      if (!auth?.user) return jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401);
      const user = auth.user;
      const scopes = await getIntegrationScopes(env.DB, user.businessId);
      const summaryScopes = LIFECYCLE_DEBUG_INTEGRATION_IDS.map((integrationId) => {
        const isBusinessScoped =
          BUSINESS_ONLY_SET.has(integrationId) ||
          (isToggleableIntegrationId(integrationId) && scopes[integrationId] === "business");
        return {
          integrationId,
          businessId: user.businessId,
          ...(isBusinessScoped ? {} : { userId: user.id }),
        };
      });
      const summaries = await getIntegrationLifecycleSummaries(env.DB, summaryScopes);
      return jsonResponse({
        ok: true,
        integrations: Object.fromEntries(
          LIFECYCLE_DEBUG_INTEGRATION_IDS.map((integrationId) => {
            const summary = summaries.get(integrationId) ?? null;
            return [
              integrationId,
              summary
                ? {
                    ...summary,
                    ...(summary.status !== "passed"
                      ? { userMessage: mapReasonCodeToUserMessage(integrationId, summary.reasonCode) }
                      : {}),
                  }
                : null,
            ] as const;
          }),
        ),
      });
    },
  },
];
