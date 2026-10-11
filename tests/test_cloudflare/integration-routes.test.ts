import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetIntegrationLifecycleEventsPage = vi.fn();
const mockGetIntegrationLifecycleSummaries = vi.fn();
const mockGetIntegrationScopes = vi.fn();
const mockGetSessionState = vi.fn();
const mockCanAccessSession = vi.fn();
const mockListMcpServers = vi.fn();
const mockCreateMcpServer = vi.fn();
const mockGetMcpServer = vi.fn();
const mockUpdateMcpServer = vi.fn();
const mockDeleteMcpServer = vi.fn();
const mockMarkMcpServerValidationUnsupported = vi.fn();
const mockMarkMcpServerValidating = vi.fn();
const mockValidateMcpServerTools = vi.fn();

vi.mock("../../apps/control-plane-worker/src/integrations/lifecycle/service", () => ({
  getIntegrationLifecycleEventsPage: (...args: unknown[]) => mockGetIntegrationLifecycleEventsPage(...args),
  getIntegrationLifecycleSummaries: (...args: unknown[]) => mockGetIntegrationLifecycleSummaries(...args),
  mapReasonCodeToUserMessage: vi.fn((integrationId: string) => `Check ${integrationId}`),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/service", () => ({
  getIntegrationScopes: (...args: unknown[]) => mockGetIntegrationScopes(...args),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/mcp-registry", () => {
  class McpRegistryValidationError extends Error {}
  return {
    McpRegistryValidationError,
    listMcpServers: (...args: unknown[]) => mockListMcpServers(...args),
    createMcpServer: (...args: unknown[]) => mockCreateMcpServer(...args),
    getMcpServer: (...args: unknown[]) => mockGetMcpServer(...args),
    updateMcpServer: (...args: unknown[]) => mockUpdateMcpServer(...args),
    deleteMcpServer: (...args: unknown[]) => mockDeleteMcpServer(...args),
    markMcpServerValidationUnsupported: (...args: unknown[]) => mockMarkMcpServerValidationUnsupported(...args),
    markMcpServerValidating: (...args: unknown[]) => mockMarkMcpServerValidating(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/integrations/mcp-validation", () => ({
  validateMcpServerTools: (...args: unknown[]) => mockValidateMcpServerTools(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/db", () => ({
  canAccessSession: (...args: unknown[]) => mockCanAccessSession(...args),
}));

import { McpRegistryValidationError } from "../../apps/control-plane-worker/src/integrations/mcp-registry";
import { integrationRoutes } from "../../apps/control-plane-worker/src/routes/integrations";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 42,
      login: "user-42",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "admin",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    },
    ...overrides,
  };
}

function makeEnv(): Env {
  return { DB: {} as D1Database } as Env;
}

function getRoute(method: string, path: string) {
  const route = integrationRoutes.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (!route) throw new Error(`Route not found for ${method} ${path}`);
  return route;
}

describe("integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIntegrationScopes.mockResolvedValue({});
    mockGetIntegrationLifecycleSummaries.mockResolvedValue(new Map());
  });

  it("rejects non-admin access to debug endpoints", async () => {
    const route = getRoute("GET", "/api/integrations/debug");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/debug"),
      makeEnv(),
      route.pattern.exec("/api/integrations/debug")!,
      makeAuth({
        user: {
          ...makeAuth().user!,
          businessRole: "member",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(mockGetIntegrationLifecycleEventsPage).not.toHaveBeenCalled();
  });

  it("rejects non-admin access to MCP registry routes", async () => {
    const route = getRoute("GET", "/api/integrations/mcp-servers");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers"),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers")!,
      makeAuth({
        user: {
          ...makeAuth().user!,
          businessRole: "member",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(mockListMcpServers).not.toHaveBeenCalled();
  });

  it("lists MCP servers for the caller business", async () => {
    mockListMcpServers.mockResolvedValue([{ id: "mcp_1", name: "Docs" }]);

    const route = getRoute("GET", "/api/integrations/mcp-servers");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers"),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    expect(mockListMcpServers).toHaveBeenCalledWith(expect.anything(), "biz-1");
    await expect(response.json()).resolves.toMatchObject({ ok: true, servers: [{ id: "mcp_1" }] });
  });

  it("creates MCP servers for the caller business", async () => {
    mockCreateMcpServer.mockResolvedValue({ id: "mcp_1", name: "Docs" });

    const route = getRoute("POST", "/api/integrations/mcp-servers");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "Docs", transport: "http", url: "https://mcp.example.com" }),
      }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers")!,
      makeAuth(),
    );

    expect(response.status).toBe(201);
    expect(mockCreateMcpServer).toHaveBeenCalledWith(
      expect.anything(),
      "biz-1",
      42,
      expect.objectContaining({ name: "Docs" }),
    );
  });

  it("rejects non-object MCP server create bodies before calling the registry service", async () => {
    const route = getRoute("POST", "/api/integrations/mcp-servers");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers", {
        method: "POST",
        body: JSON.stringify("not-an-object"),
      }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers")!,
      makeAuth(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/expected object/i),
    });
    expect(mockCreateMcpServer).not.toHaveBeenCalled();
  });

  it("returns validation errors from MCP server creation", async () => {
    mockCreateMcpServer.mockRejectedValue(new McpRegistryValidationError("url is required for remote MCP servers"));

    const route = getRoute("POST", "/api/integrations/mcp-servers");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "Docs", transport: "http" }),
      }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers")!,
      makeAuth(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "url is required for remote MCP servers",
    });
  });

  it("updates MCP servers for the caller business", async () => {
    mockUpdateMcpServer.mockResolvedValue({ id: "mcp_1", name: "Docs v2" });

    const route = getRoute("PUT", "/api/integrations/mcp-servers/mcp_1");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_1", {
        method: "PUT",
        body: JSON.stringify({ name: "Docs v2", transport: "http", url: "https://mcp.example.com/v2" }),
      }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers/mcp_1")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    expect(mockUpdateMcpServer).toHaveBeenCalledWith(
      expect.anything(),
      "biz-1",
      "mcp_1",
      expect.objectContaining({ name: "Docs v2" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      server: { id: "mcp_1", name: "Docs v2" },
    });
  });

  it("rejects non-object MCP server update bodies before calling the registry service", async () => {
    const route = getRoute("PUT", "/api/integrations/mcp-servers/mcp_1");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_1", {
        method: "PUT",
        body: JSON.stringify(["not", "an", "object"]),
      }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers/mcp_1")!,
      makeAuth(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/expected object/i),
    });
    expect(mockUpdateMcpServer).not.toHaveBeenCalled();
  });

  it("returns 404 for missing MCP server reads and deletes", async () => {
    mockGetMcpServer.mockResolvedValue(null);
    mockDeleteMcpServer.mockResolvedValue(false);

    const getRouteForServer = getRoute("GET", "/api/integrations/mcp-servers/mcp_missing");
    const getResponse = await getRouteForServer.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_missing"),
      makeEnv(),
      getRouteForServer.pattern.exec("/api/integrations/mcp-servers/mcp_missing")!,
      makeAuth(),
    );

    const deleteRouteForServer = getRoute("DELETE", "/api/integrations/mcp-servers/mcp_missing");
    const deleteResponse = await deleteRouteForServer.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_missing", { method: "DELETE" }),
      makeEnv(),
      deleteRouteForServer.pattern.exec("/api/integrations/mcp-servers/mcp_missing")!,
      makeAuth(),
    );

    expect(getResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(mockGetMcpServer).toHaveBeenCalledWith(expect.anything(), "biz-1", "mcp_missing");
    expect(mockDeleteMcpServer).toHaveBeenCalledWith(expect.anything(), "biz-1", "mcp_missing");
  });

  it("schedules MCP validation for the caller business", async () => {
    const validationPromise = Promise.resolve();
    const waitUntil = vi.fn();
    mockGetMcpServer.mockResolvedValue({ id: "mcp_1", transport: "http", updatedAt: 123 });
    mockMarkMcpServerValidating.mockResolvedValue({
      server: {
        id: "mcp_1",
        name: "Docs",
        validationStatus: "validating",
      },
      validationJobId: "mcp_validation_1",
    });
    mockValidateMcpServerTools.mockReturnValue(validationPromise);

    const route = getRoute("POST", "/api/integrations/mcp-servers/mcp_1/validate");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_1/validate", { method: "POST" }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers/mcp_1/validate")!,
      makeAuth(),
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(mockMarkMcpServerValidating).toHaveBeenCalledWith(expect.anything(), "biz-1", "mcp_1", {
      transport: "http",
      updatedAt: 123,
    });
    expect(mockValidateMcpServerTools).toHaveBeenCalledWith(expect.anything(), "biz-1", "mcp_1", "mcp_validation_1");
    expect(waitUntil).toHaveBeenCalledWith(validationPromise);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      server: { id: "mcp_1", validationStatus: "validating" },
    });
  });

  it("marks unsupported MCP validation without clearing prior tools", async () => {
    mockGetMcpServer.mockResolvedValue({
      id: "mcp_stdio",
      transport: "stdio",
      updatedAt: 456,
      validationStatus: "valid",
      discoveredTools: [{ name: "search" }],
      lastValidatedAt: 123,
    });
    mockMarkMcpServerValidationUnsupported.mockResolvedValue({
      id: "mcp_stdio",
      transport: "stdio",
      validationStatus: "untested",
      validationError: "stdio MCP validation requires sandbox runtime discovery",
      discoveredTools: [{ name: "search" }],
      lastValidatedAt: 123,
    });

    const route = getRoute("POST", "/api/integrations/mcp-servers/mcp_stdio/validate");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_stdio/validate", { method: "POST" }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers/mcp_stdio/validate")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    expect(mockMarkMcpServerValidating).not.toHaveBeenCalled();
    expect(mockValidateMcpServerTools).not.toHaveBeenCalled();
    expect(mockMarkMcpServerValidationUnsupported).toHaveBeenCalledWith(
      expect.anything(),
      "biz-1",
      "mcp_stdio",
      "stdio MCP validation requires sandbox runtime discovery",
      { transport: "stdio", updatedAt: 456 },
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      server: {
        id: "mcp_stdio",
        discoveredTools: [{ name: "search" }],
        lastValidatedAt: 123,
      },
    });
  });

  it("rejects stale MCP validation transitions", async () => {
    mockGetMcpServer.mockResolvedValue({ id: "mcp_1", transport: "http", updatedAt: 123 });
    mockMarkMcpServerValidating.mockResolvedValue(null);

    const route = getRoute("POST", "/api/integrations/mcp-servers/mcp_1/validate");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_1/validate", { method: "POST" }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers/mcp_1/validate")!,
      makeAuth(),
    );

    expect(response.status).toBe(409);
    expect(mockValidateMcpServerTools).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "MCP server changed during validation request",
    });
  });

  it("returns 404 when scheduling validation for a missing MCP server", async () => {
    mockGetMcpServer.mockResolvedValue(null);

    const route = getRoute("POST", "/api/integrations/mcp-servers/mcp_missing/validate");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/mcp-servers/mcp_missing/validate", { method: "POST" }),
      makeEnv(),
      route.pattern.exec("/api/integrations/mcp-servers/mcp_missing/validate")!,
      makeAuth(),
    );

    expect(response.status).toBe(404);
    expect(mockMarkMcpServerValidating).not.toHaveBeenCalled();
    expect(mockValidateMcpServerTools).not.toHaveBeenCalled();
  });

  it("scopes debug endpoint reads to the business for browser admins", async () => {
    mockGetIntegrationLifecycleEventsPage.mockResolvedValue({ events: [], nextCursor: null });

    const route = getRoute("GET", "/api/integrations/debug");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/debug"),
      makeEnv(),
      route.pattern.exec("/api/integrations/debug")!,
      makeAuth({
        user: {
          ...makeAuth().user!,
          businessRole: "admin",
          businessId: "biz-1",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockGetIntegrationLifecycleEventsPage).toHaveBeenCalledWith(expect.anything(), {
      integrationId: undefined,
      businessId: "biz-1",
      limit: 50,
      cursor: null,
    });
  });

  it("rejects unsupported integration ids for debug reads", async () => {
    const route = getRoute("GET", "/api/integrations/debug/unknown");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/debug/unknown"),
      makeEnv(),
      route.pattern.exec("/api/integrations/debug/unknown")!,
      makeAuth(),
    );

    expect(response.status).toBe(400);
    expect(mockGetIntegrationLifecycleEventsPage).not.toHaveBeenCalled();
  });

  it("returns 404 for unauthorized session lifecycle reads", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-1",
      businessId: "biz-2",
    });
    mockCanAccessSession.mockReturnValue(false);

    const route = getRoute("GET", "/api/sessions/sess-1/integrations");
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/integrations"),
      makeEnv(),
      route.pattern.exec("/api/sessions/sess-1/integrations")!,
      makeAuth(),
    );

    expect(response.status).toBe(404);
  });

  it("returns owner-scoped me lifecycle data", async () => {
    mockGetIntegrationLifecycleSummaries.mockResolvedValue(
      new Map([
        [
          "github",
          {
            integrationId: "github",
            stage: "provider_probe_passed",
            status: "failed",
            reasonCode: "repo_access_denied",
            message: "GitHub repo probe failed.",
            createdAt: 123,
          },
        ],
        [
          "sentry",
          {
            integrationId: "sentry",
            stage: "credential_resolved",
            status: "failed",
            reasonCode: "token_missing",
            message: "Sentry credentials are missing.",
            createdAt: 456,
          },
        ],
      ]),
    );

    const route = getRoute("GET", "/api/integrations/me");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/me"),
      makeEnv(),
      route.pattern.exec("/api/integrations/me")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mockGetIntegrationLifecycleSummaries).toHaveBeenCalledTimes(1);
    expect(mockGetIntegrationLifecycleSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        {
          integrationId: "github",
          businessId: "biz-1",
          userId: 42,
        },
        {
          integrationId: "sentry",
          businessId: "biz-1",
        },
      ]),
    );
    expect(body.integrations.github.userMessage).toBe("Check github");
    expect(body.integrations.sentry.userMessage).toBe("Check sentry");
    expect(body.integrations.sentry.message).toBe("Sentry credentials are missing.");
  });

  it("uses business-wide lifecycle data for business-scoped dual-scope integrations", async () => {
    mockGetIntegrationScopes.mockResolvedValue({ openai: "business" });

    const route = getRoute("GET", "/api/integrations/me");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/me"),
      makeEnv(),
      route.pattern.exec("/api/integrations/me")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    expect(mockGetIntegrationScopes).toHaveBeenCalledWith(expect.anything(), "biz-1");
    expect(mockGetIntegrationLifecycleSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        {
          integrationId: "openai",
          businessId: "biz-1",
        },
      ]),
    );
  });

  it("keeps user-scoped lifecycle data owner-filtered for dual-scope integrations", async () => {
    mockGetIntegrationScopes.mockResolvedValue({ openai: "user" });

    const route = getRoute("GET", "/api/integrations/me");
    const response = await route.handler(
      new Request("https://worker.test/api/integrations/me"),
      makeEnv(),
      route.pattern.exec("/api/integrations/me")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    expect(mockGetIntegrationLifecycleSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        {
          integrationId: "openai",
          businessId: "biz-1",
          userId: 42,
        },
      ]),
    );
  });

  it("passes string cursors through for session lifecycle pagination", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-1",
      businessId: "biz-1",
    });
    mockCanAccessSession.mockReturnValue(true);
    mockGetIntegrationLifecycleEventsPage.mockResolvedValue({ events: [], nextCursor: "123:evt-2" });

    const route = getRoute("GET", "/api/sessions/sess-1/integrations");
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/integrations?cursor=1700000000000:evt-9&limit=75"),
      makeEnv(),
      route.pattern.exec("/api/sessions/sess-1/integrations")!,
      makeAuth(),
    );

    expect(response.status).toBe(200);
    expect(mockGetIntegrationLifecycleEventsPage).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "sess-1",
      limit: 75,
      cursor: "1700000000000:evt-9",
    });
  });
});
