import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const mockGetSessionState = vi.fn();
const mockGetAuthedSessionArtifact = vi.fn();
const mockGetPublicSessionArtifact = vi.fn();
const mockVerifyUserRepoAccess = vi.fn().mockResolvedValue(true);
const mockAuthenticateRequest = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    getAuthedSessionArtifact: (...args: unknown[]) => mockGetAuthedSessionArtifact(...args),
    getPublicSessionArtifact: (...args: unknown[]) => mockGetPublicSessionArtifact(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/routes", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/auth/routes")>(
    "../../apps/control-plane-worker/src/auth/routes",
  );
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  };
});

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env, UserInfo } from "../../apps/control-plane-worker/src/types";

function createUserAuth(userId: string, userOverrides: Partial<UserInfo> = {}): AuthInfo {
  return {
    userId,
    tokenSource: "session_token",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: Number(userId),
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId: "biz-1",
      sharedSessions: false,
      businessMemberIds: [],
      ...userOverrides,
    },
  };
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    REPOS_CACHE: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace,
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    } as unknown as D1Database,
    SANDBOX_CALLBACK_SECRET: "secret-for-tests",
    ...overrides,
  } as Env;
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    ownerUserId: "42",
    businessId: "biz-1",
    status: "idle",
    sandboxStatus: null,
    createdAt: "2026-04-07T09:00:00.000Z",
    updatedAt: "2026-04-07T10:05:00.000Z",
    closedAt: null,
    lastEventId: "evt-1",
    title: "title",
    model: null,
    reasoningEffort: null,
    repoOwner: null,
    repoName: null,
    repoUrl: null,
    baseBranch: null,
    installationId: null,
    lastBranch: null,
    prUrl: null,
    prCreating: false,
    closeReason: null,
    spawnDurationMs: null,
    ...overrides,
  };
}

function getRoute() {
  const route = sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" &&
      String(candidate.pattern) ===
        String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/artifacts\/(?<artifactId>[^/]+)\/(?<filename>[^/]+)$/),
  );
  if (!route) throw new Error("Public artifact proxy route not registered");
  return route;
}

function getAuthedViewRoute() {
  const route = sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" &&
      String(candidate.pattern) ===
        String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/artifacts\/(?<artifactId>[^/]+)\/view$/),
  );
  if (!route) throw new Error("Authenticated artifact view route not registered");
  return route;
}

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

describe("public artifact proxy route", () => {
  const route = getRoute();

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetSessionState.mockResolvedValue(makeSession());
    mockGetAuthedSessionArtifact.mockResolvedValue(
      new Response("authed-image-bytes", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    mockGetPublicSessionArtifact.mockResolvedValue(
      new Response("public-image-bytes", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    // Default: no auth presented.
    mockAuthenticateRequest.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 }),
    });
  });

  function dispatch(path: string, init?: RequestInit, envOverrides: Partial<Env> = {}) {
    const url = new URL(`https://worker.test${path}`);
    const match = url.pathname.match(route.pattern);
    if (!match) throw new Error(`Path did not match route: ${path}`);
    return route.handler(new Request(url.toString(), init), createEnv(envOverrides), match, null, execCtx);
  }

  it("returns 404 when neither artifactToken nor session cookie is present", async () => {
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png");
    expect(response.status).toBe(404);
    expect(mockGetPublicSessionArtifact).not.toHaveBeenCalled();
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("redirects browser navigations without a cookie into GitHub auth with returnTo", async () => {
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png", {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "sec-fetch-mode": "navigate",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/github?returnTo=%2Fapi%2Fsessions%2Fsess-1%2Fartifacts%2Fart-1%2Fshot.png",
    );
    expect(mockGetPublicSessionArtifact).not.toHaveBeenCalled();
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("starts local private-artifact auth on the configured callback origin", async () => {
    const response = await dispatch(
      "/api/sessions/sess-1/artifacts/art-1/shot.png",
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-mode": "navigate",
        },
      },
      {
        WORKER_ENV: "local",
        GITHUB_CALLBACK_URL: "http://localhost:5173/auth/callback",
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost:5173/auth/github?returnTo=%2Fapi%2Fsessions%2Fsess-1%2Fartifacts%2Fart-1%2Fshot.png",
    );
  });

  it("delegates to the public proxy when artifactToken is present (anonymous PR-body image renderer)", async () => {
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png?artifactToken=signed-token");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public-image-bytes");
    expect(mockGetPublicSessionArtifact).toHaveBeenCalledTimes(1);
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("preserves server errors from the public artifact proxy instead of flattening them to 404", async () => {
    mockGetPublicSessionArtifact.mockResolvedValueOnce(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png?artifactToken=signed-token");

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(mockGetPublicSessionArtifact).toHaveBeenCalledTimes(1);
  });

  it("rejects encoded traversal segments on the public-token path before calling the proxy", async () => {
    const response = await dispatch(
      "/api/sessions/sess-1/artifacts/art-1/..%2F..%2Fsess-2%2Fartifacts%2Fart-2%2Fsecret.png?artifactToken=signed-token",
    );

    expect(response.status).toBe(404);
    expect(mockGetPublicSessionArtifact).not.toHaveBeenCalled();
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("falls back to cookie auth when artifactToken is absent and session-cookie auth resolves to the session owner", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({ ok: true, auth: createUserAuth("42") });
    mockGetSessionState.mockResolvedValueOnce(makeSession({ ownerUserId: "42" }));

    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png", {
      headers: { cookie: "cycloid_session=cookie-value" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("authed-image-bytes");
    expect(mockGetAuthedSessionArtifact).toHaveBeenCalledTimes(1);
    const callArgs = mockGetAuthedSessionArtifact.mock.calls[0];
    expect(callArgs[1]).toBe("sess-1");
    expect(callArgs[2]).toBe("art-1");
    expect(callArgs[3]).toBe("shot.png");
    expect(mockGetPublicSessionArtifact).not.toHaveBeenCalled();
  });

  it("allows a shared-session business member when GitHub repo access is verified", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      ok: true,
      auth: createUserAuth("7", { businessId: "biz-1", sharedSessions: true }),
    });
    mockGetSessionState.mockResolvedValueOnce(
      makeSession({ ownerUserId: "42", businessId: "biz-1", repoOwner: "trycycloid", repoName: "demo-env" }),
    );

    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png", {
      headers: { cookie: "cycloid_session=cookie-value" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("authed-image-bytes");
    expect(mockVerifyUserRepoAccess).toHaveBeenCalledWith(
      expect.anything(),
      "7",
      "trycycloid",
      "demo-env",
      expect.any(Object),
    );
    expect(mockGetAuthedSessionArtifact).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for shared-session business members when GitHub repo access is denied", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      ok: true,
      auth: createUserAuth("7", { businessId: "biz-1", sharedSessions: true }),
    });
    mockGetSessionState.mockResolvedValueOnce(
      makeSession({ ownerUserId: "42", businessId: "biz-1", repoOwner: "trycycloid", repoName: "demo-env" }),
    );
    mockVerifyUserRepoAccess.mockResolvedValueOnce(false);

    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png", {
      headers: { cookie: "cycloid_session=cookie-value" },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when the cookie-authed user does not own the session (no leak of existence)", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({ ok: true, auth: createUserAuth("42") });
    mockGetSessionState.mockResolvedValueOnce(makeSession({ ownerUserId: "999" }));

    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png", {
      headers: { cookie: "cycloid_session=cookie-value" },
    });

    expect(response.status).toBe(404);
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 for non-cookie auth modes (admin/MCP/CLI tokens) so this surface stays user-session-only", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      ok: true,
      auth: { userId: "admin-token", tokenSource: "bearer", authMode: "admin_token", canAccessAllSessions: true },
    });

    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/shot.png", {
      headers: { authorization: "Bearer some-admin-token" },
    });

    expect(response.status).toBe(404);
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
    expect(mockGetPublicSessionArtifact).not.toHaveBeenCalled();
  });

  it("rejects encoded traversal segments on the cookie-auth path before touching session artifacts", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({ ok: true, auth: createUserAuth("42") });
    mockGetSessionState.mockResolvedValueOnce(makeSession({ ownerUserId: "42" }));

    const response = await dispatch(
      "/api/sessions/sess-1/artifacts/art-1/..%2F..%2Fsess-2%2Fartifacts%2Fart-2%2Fsecret.png",
      {
        headers: { cookie: "cycloid_session=cookie-value" },
      },
    );

    expect(response.status).toBe(404);
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
    expect(mockGetPublicSessionArtifact).not.toHaveBeenCalled();
  });
});

describe("authenticated artifact view route", () => {
  const route = getAuthedViewRoute();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionState.mockResolvedValue(makeSession());
    mockGetAuthedSessionArtifact.mockResolvedValue(
      new Response("authed-image-bytes", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
  });

  function dispatch(path: string, auth: AuthInfo, init?: RequestInit, envOverrides: Partial<Env> = {}) {
    const url = new URL(`https://worker.test${path}`);
    const match = url.pathname.match(route.pattern);
    if (!match) throw new Error(`Path did not match route: ${path}`);
    return route.handler(new Request(url.toString(), init), createEnv(envOverrides), match, auth, execCtx);
  }

  it("delegates valid filename queries to the authenticated artifact reader", async () => {
    const response = await dispatch(
      "/api/sessions/sess-1/artifacts/art-1/view?filename=shot.png",
      createUserAuth("42"),
      { headers: { cookie: "cycloid_session=cookie-value" } },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("authed-image-bytes");
    expect(mockGetAuthedSessionArtifact).toHaveBeenCalledTimes(1);
    const callArgs = mockGetAuthedSessionArtifact.mock.calls[0];
    expect(callArgs[1]).toBe("sess-1");
    expect(callArgs[2]).toBe("art-1");
    expect(callArgs[3]).toBe("shot.png");
  });

  it("rejects traversal filename queries before calling the authenticated artifact reader", async () => {
    const response = await dispatch(
      "/api/sessions/sess-1/artifacts/art-1/view?filename=../../sess-2/artifacts/art-2/secret.png",
      createUserAuth("42"),
      { headers: { cookie: "cycloid_session=cookie-value" } },
    );

    expect(response.status).toBe(404);
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });
});
