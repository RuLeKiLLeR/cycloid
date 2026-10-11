import { beforeEach, describe, expect, it, vi } from "vitest";

import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";
import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";

const mockAuthorizeSessionRepoAccess = vi.fn();
const mockBuildSessionDebugSummary = vi.fn();
const mockCanAccessSession = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetSessionTelemetry = vi.fn();
const mockLogInfo = vi.fn();
const mockQueryPromptRuns = vi.fn();
const mockResolveInternalFeatureGateUser = vi.fn();
const mockListSessionArtifactsAuthed = vi.fn();

vi.mock("../../apps/control-plane-worker/src/routes/sessions", () => ({
  authorizeSessionRepoAccess: (...args: unknown[]) => mockAuthorizeSessionRepoAccess(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/db", () => ({
  canAccessSession: (...args: unknown[]) => mockCanAccessSession(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionSandboxState: vi.fn(),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  listSessionArtifactsAuthed: (...args: unknown[]) => mockListSessionArtifactsAuthed(...args),
  assertDatabase: (env: { DB?: unknown }) => {
    if (!env.DB) throw new Error("D1 binding DB is not configured");
    return env.DB;
  },
}));

vi.mock("../../apps/control-plane-worker/src/services/observability", () => ({
  buildSessionDebugSummary: (...args: unknown[]) => mockBuildSessionDebugSummary(...args),
  getSessionFeedbackSummaries: vi.fn(),
  getSessionTelemetry: (...args: unknown[]) => mockGetSessionTelemetry(...args),
  queryPromptRuns: (...args: unknown[]) => mockQueryPromptRuns(...args),
  searchSessions: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  resolveInternalFeatureGateUser: (...args: unknown[]) => mockResolveInternalFeatureGateUser(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
  }),
}));

import { observabilityRoutes } from "../../apps/control-plane-worker/src/routes/observability";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

function findRoute(path: string) {
  const route = observabilityRoutes.find((candidate) => candidate.pattern.test(path));
  if (!route) throw new Error(`Route not found for ${path}`);
  return route;
}

function makeAuth(): AuthInfo {
  return {
    userId: "user-1",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 1,
      githubUserId: null,
      login: "user-1",
      name: null,
      email: null,
      businessId: "biz-1",
    },
  };
}

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
  } as Env;
}

describe("observability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveInternalFeatureGateUser.mockResolvedValue(null);
  });

  it("checks session visibility before repo authorization for session-scoped observability reads", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-1",
      businessId: "biz-2",
      repoOwner: null,
      repoName: null,
    });
    mockCanAccessSession.mockReturnValue(false);

    const route = findRoute("/api/sessions/sess-1/telemetry");
    const match = route.pattern.exec("/api/sessions/sess-1/telemetry");
    if (!match) throw new Error("Route did not match");

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/telemetry"),
      makeEnv(),
      match,
      makeAuth(),
    );

    expect(response.status).toBe(404);
    expect(mockAuthorizeSessionRepoAccess).not.toHaveBeenCalled();
    expect(mockGetSessionTelemetry).not.toHaveBeenCalled();
  });

  it("passes default and requested telemetry prompt-run limits to the service", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "user-1",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
    });
    mockCanAccessSession.mockReturnValue(true);
    mockAuthorizeSessionRepoAccess.mockResolvedValue({ ok: true, authCtx: {} });
    mockGetSessionTelemetry.mockResolvedValue({ sessionId: "sess-1", promptRuns: [], links: {} });

    const route = findRoute("/api/sessions/sess-1/telemetry");
    const match = route.pattern.exec("/api/sessions/sess-1/telemetry");
    if (!match) throw new Error("Route did not match");

    await route.handler(new Request("https://api.test/api/sessions/sess-1/telemetry"), makeEnv(), match, makeAuth());
    await route.handler(
      new Request("https://api.test/api/sessions/sess-1/telemetry?limit=25"),
      makeEnv(),
      match,
      makeAuth(),
    );
    await route.handler(
      new Request("https://api.test/api/sessions/sess-1/telemetry?limit=999"),
      makeEnv(),
      match,
      makeAuth(),
    );

    expect(mockGetSessionTelemetry).toHaveBeenNthCalledWith(1, expect.anything(), "sess-1", 50);
    expect(mockGetSessionTelemetry).toHaveBeenNthCalledWith(2, expect.anything(), "sess-1", 25);
    expect(mockGetSessionTelemetry).toHaveBeenNthCalledWith(3, expect.anything(), "sess-1", 200);
  });

  it("rejects invalid telemetry prompt-run limits", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "user-1",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
    });
    mockCanAccessSession.mockReturnValue(true);
    mockAuthorizeSessionRepoAccess.mockResolvedValue({ ok: true, authCtx: {} });

    const route = findRoute("/api/sessions/sess-1/telemetry");
    const match = route.pattern.exec("/api/sessions/sess-1/telemetry");
    if (!match) throw new Error("Route did not match");

    for (const limit of ["abc", "-1", "1.5", "0"]) {
      const response = await route.handler(
        new Request(`https://api.test/api/sessions/sess-1/telemetry?limit=${encodeURIComponent(limit)}`),
        makeEnv(),
        match,
        makeAuth(),
      );
      expect(response.status).toBe(400);
    }
    expect(mockGetSessionTelemetry).not.toHaveBeenCalled();
  });

  it("passes the agent filter from query_prompt_runs through to the service", async () => {
    mockQueryPromptRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });

    const route = findRoute("/api/observability/runs");
    const match = route.pattern.exec("/api/observability/runs");
    if (!match) throw new Error("Route did not match");

    await route.handler(
      new Request("https://api.test/api/observability/runs?agent=default"),
      makeEnv(),
      match,
      makeAuth(),
    );

    expect(mockQueryPromptRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agent: "default" }),
      expect.anything(),
    );
  });

  it("allows internal Cycloid users to read debug summaries for any session", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockBuildSessionDebugSummary.mockResolvedValue({ ok: true, session: { sessionId: "sess-1" }, prompts: [] });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 42162445,
      businessId: ARCANIST_BUSINESS_ID,
    });

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(200);
    expect(mockBuildSessionDebugSummary).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      null,
      expect.objectContaining({ sessionId: "sess-1" }),
      50,
    );
    expect(mockAuthorizeSessionRepoAccess).not.toHaveBeenCalled();
    expect(mockCanAccessSession).not.toHaveBeenCalled();
  });

  it("passes requested and clamped debug-summary prompt-run limits to the service", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockBuildSessionDebugSummary.mockResolvedValue({ ok: true, session: { sessionId: "sess-1" }, prompts: [] });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 42162445,
      businessId: ARCANIST_BUSINESS_ID,
    });

    await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary?limit=25"),
      makeEnv(),
      match,
      auth,
    );
    await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary?limit=999"),
      makeEnv(),
      match,
      auth,
    );

    expect(mockBuildSessionDebugSummary).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "sess-1",
      null,
      expect.objectContaining({ sessionId: "sess-1" }),
      25,
    );
    expect(mockBuildSessionDebugSummary).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "sess-1",
      null,
      expect.objectContaining({ sessionId: "sess-1" }),
      200,
    );
  });

  it("rejects invalid debug-summary prompt-run limits", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 42162445,
      businessId: ARCANIST_BUSINESS_ID,
    });

    for (const limit of ["abc", "-1", "1.5", "0"]) {
      const response = await route.handler(
        new Request(`https://api.test/api/sessions/sess-1/debug-summary?limit=${encodeURIComponent(limit)}`),
        makeEnv(),
        match,
        auth,
      );
      expect(response.status).toBe(400);
    }
    expect(mockBuildSessionDebugSummary).not.toHaveBeenCalled();
  });

  it("allows internal QA users to read debug summaries for any session", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockBuildSessionDebugSummary.mockResolvedValue({ ok: true, session: { sessionId: "sess-1" }, prompts: [] });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.user = { ...auth.user!, id: 123, githubUserId: 32455319, businessId: SEEDED_BUSINESS_IDS.cycloidQa };
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 32455319,
      businessId: SEEDED_BUSINESS_IDS.cycloidQa,
    });

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(200);
  });

  it("allows impersonated browser sessions when the actor is an internal Cycloid user", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockBuildSessionDebugSummary.mockResolvedValue({ ok: true, session: { sessionId: "sess-1" }, prompts: [] });
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 42162445,
      businessId: ARCANIST_BUSINESS_ID,
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.authMode = "impersonated_user_session";
    auth.readOnly = true;
    auth.impersonationId = "imp-1";
    auth.userId = "2";
    auth.actorUserId = "99";
    auth.user = {
      id: 2,
      githubUserId: 99999999,
      businessId: "biz-customer",
      login: "customer",
      email: null,
      name: null,
    };
    auth.actorUser = {
      id: 99,
      githubUserId: 42162445,
      businessId: ARCANIST_BUSINESS_ID,
      login: "operator",
      email: null,
      name: null,
    };

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(200);
    expect(mockResolveInternalFeatureGateUser).toHaveBeenCalledWith(expect.anything(), 99);
    expect(mockBuildSessionDebugSummary).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      null,
      expect.objectContaining({ sessionId: "sess-1" }),
      50,
    );
    expect(mockAuthorizeSessionRepoAccess).not.toHaveBeenCalled();
    expect(mockCanAccessSession).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "99",
        actorBusinessId: ARCANIST_BUSINESS_ID,
        outcome: "allowed",
      }),
      "Allowed internal session debug request",
    );
  });

  it("returns 404 for impersonated browser sessions when the actor is not internal", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 99999999,
      businessId: "biz-external",
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.authMode = "impersonated_user_session";
    auth.readOnly = true;
    auth.impersonationId = "imp-1";
    auth.userId = "2";
    auth.actorUserId = "99";
    auth.user = {
      id: 2,
      githubUserId: 42162445,
      businessId: "biz-customer",
      login: "customer",
      email: null,
      name: null,
    };
    auth.actorUser = {
      id: 99,
      githubUserId: 99999999,
      businessId: "biz-external",
      login: "operator",
      email: null,
      name: null,
    };

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(404);
    expect(mockBuildSessionDebugSummary).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "99",
        actorBusinessId: "biz-external",
        outcome: "denied",
      }),
      "Denied internal session debug request",
    );
  });

  it("returns 404 for non-internal users on debug summaries", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      makeAuth(),
    );

    expect(response.status).toBe(404);
    expect(mockBuildSessionDebugSummary).not.toHaveBeenCalled();
  });

  it("returns 404 for admin-token auth on debug summaries", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.authMode = "admin_token";
    auth.canAccessAllSessions = true;
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(404);
    expect(mockBuildSessionDebugSummary).not.toHaveBeenCalled();
  });

  it("returns 404 for ci-automation-token auth on debug summaries", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.authMode = "ci_automation_token";
    auth.canAccessAllSessions = true;
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(404);
    expect(mockBuildSessionDebugSummary).not.toHaveBeenCalled();
  });

  it("allows cli-token auth for internal users on debug summaries", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockBuildSessionDebugSummary.mockResolvedValue({ ok: true, session: { sessionId: "sess-1" }, prompts: [] });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.authMode = "cli_token";
    auth.tokenSource = "cli";
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 42162445,
      businessId: ARCANIST_BUSINESS_ID,
    });

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(200);
  });

  it("denies debug summaries when the authoritative user row is no longer internal", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      ownerUserId: "owner-2",
      businessId: "biz-customer",
      status: "idle",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      githubUserId: 99999999,
      businessId: "biz-customer",
    });

    const route = findRoute("/api/sessions/sess-1/debug-summary");
    const match = route.pattern.exec("/api/sessions/sess-1/debug-summary");
    if (!match) throw new Error("Route did not match");

    const auth = makeAuth();
    auth.user = { ...auth.user!, id: 99, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID };

    const response = await route.handler(
      new Request("https://api.test/api/sessions/sess-1/debug-summary"),
      makeEnv(),
      match,
      auth,
    );

    expect(response.status).toBe(404);
    expect(mockBuildSessionDebugSummary).not.toHaveBeenCalled();
  });
});

describe("artifacts/list route (single DO hop)", () => {
  function makeArtifactsSession(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: "sess-1",
      ownerUserId: "owner-1",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 555,
      ...overrides,
    };
  }

  function artifactsRoute() {
    return findRoute("/api/sessions/sess-1/artifacts/list");
  }

  function callArtifacts(auth = makeAuth()) {
    const route = artifactsRoute();
    const match = route.pattern.exec("/api/sessions/sess-1/artifacts/list");
    if (!match) throw new Error("Route did not match");
    return route.handler(new Request("https://api.test/api/sessions/sess-1/artifacts/list"), makeEnv(), match, auth);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveInternalFeatureGateUser.mockResolvedValue(null);
    mockListSessionArtifactsAuthed.mockResolvedValue({
      status: 200,
      ok: true,
      payload: { ok: true, artifacts: [{ id: "a-1" }], session: makeArtifactsSession() },
    });
    mockCanAccessSession.mockReturnValue(true);
    mockAuthorizeSessionRepoAccess.mockResolvedValue({ ok: true, authCtx: {} });
  });

  it("returns 200 with artifacts for the owner via a single DO hop", async () => {
    const response = await callArtifacts();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, artifacts: [{ id: "a-1" }] });
    // Exactly one DO hop: listSessionArtifactsAuthed. getSessionState is not used.
    expect(mockListSessionArtifactsAuthed).toHaveBeenCalledTimes(1);
    expect(mockGetSessionState).not.toHaveBeenCalled();
    // Fetched WITHOUT auth headers (the worker is the authoritative boundary).
    expect(mockListSessionArtifactsAuthed).toHaveBeenCalledWith(expect.anything(), "sess-1", null, undefined);
  });

  it("returns 404 on identity mismatch for a non-owner (no existence leak)", async () => {
    mockCanAccessSession.mockReturnValue(false);

    const response = await callArtifacts();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Session not found" });
    // Identity is rejected before any repo-access check runs.
    expect(mockAuthorizeSessionRepoAccess).not.toHaveBeenCalled();
    // Still a single DO hop, never getSessionState.
    expect(mockListSessionArtifactsAuthed).toHaveBeenCalledTimes(1);
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("returns 403 when a shared-business member fails repo access", async () => {
    mockCanAccessSession.mockReturnValue(true);
    mockAuthorizeSessionRepoAccess.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "Forbidden" }), { status: 403 }),
    });

    const response = await callArtifacts();

    expect(response.status).toBe(403);
    expect(mockAuthorizeSessionRepoAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "sess-1",
      expect.objectContaining({ repoOwner: "acme", repoName: "widgets", installationId: 555 }),
      "artifacts_list",
    );
  });

  it("returns 404 (fail closed) when repo context is missing", async () => {
    mockListSessionArtifactsAuthed.mockResolvedValue({
      status: 200,
      ok: true,
      payload: {
        ok: true,
        artifacts: [{ id: "a-1" }],
        session: makeArtifactsSession({ repoOwner: null, repoName: null, installationId: null }),
      },
    });
    mockCanAccessSession.mockReturnValue(true);
    mockAuthorizeSessionRepoAccess.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "Session not found" }), { status: 404 }),
    });

    const response = await callArtifacts();

    expect(response.status).toBe(404);
  });

  it("returns 404 when the DO list 404s (session missing)", async () => {
    mockListSessionArtifactsAuthed.mockResolvedValue({ status: 404, ok: false, payload: null });

    const response = await callArtifacts();

    expect(response.status).toBe(404);
    expect(mockCanAccessSession).not.toHaveBeenCalled();
    expect(mockAuthorizeSessionRepoAccess).not.toHaveBeenCalled();
  });

  it("returns 404 (fail closed) when the DO omits session identity", async () => {
    mockListSessionArtifactsAuthed.mockResolvedValue({
      status: 200,
      ok: true,
      payload: { ok: true, artifacts: [{ id: "a-1" }] },
    });

    const response = await callArtifacts();

    expect(response.status).toBe(404);
    expect(mockCanAccessSession).not.toHaveBeenCalled();
    expect(mockAuthorizeSessionRepoAccess).not.toHaveBeenCalled();
  });
});
