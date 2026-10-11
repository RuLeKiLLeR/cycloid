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
const mockVerifyUserRepoAccess = vi.fn().mockResolvedValue(true);

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    getAuthedSessionArtifact: (...args: unknown[]) => mockGetAuthedSessionArtifact(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env, UserInfo } from "../../apps/control-plane-worker/src/types";

function createAuth(userId: string, userOverrides: Partial<UserInfo> = {}): AuthInfo {
  return {
    userId,
    tokenSource: "session",
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

function createEnv(): Env {
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
        String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/artifacts\/(?<artifactId>[^/]+)\/view$/),
  );
  if (!route) throw new Error("Artifact view route not registered");
  return route;
}

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

describe("artifact view route", () => {
  const route = getRoute();

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetSessionState.mockResolvedValue(makeSession());
    mockGetAuthedSessionArtifact.mockResolvedValue(
      new Response("image-bytes", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
  });

  function dispatch(path: string, auth: AuthInfo) {
    const url = new URL(`https://worker.test${path}`);
    const match = route.pattern.exec(url.pathname);
    if (!match) throw new Error(`Path did not match route: ${path}`);
    return route.handler(new Request(url.toString()), createEnv(), match, auth, execCtx);
  }

  it("returns 404 when the session does not exist", async () => {
    mockGetSessionState.mockResolvedValueOnce(null);
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/view?filename=shot.png", createAuth("42"));
    expect(response.status).toBe(404);
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when the user does not own the session", async () => {
    mockGetSessionState.mockResolvedValueOnce(makeSession({ ownerUserId: "999" }));
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/view?filename=shot.png", createAuth("42"));
    expect(response.status).toBe(404);
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("returns 400 when the filename query param is missing", async () => {
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/view", createAuth("42"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Missing filename query param" });
    expect(mockGetAuthedSessionArtifact).not.toHaveBeenCalled();
  });

  it("happy path: returns the bytes from the DO", async () => {
    const response = await dispatch("/api/sessions/sess-1/artifacts/art-1/view?filename=shot.png", createAuth("42"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await response.text()).toBe("image-bytes");
    expect(mockGetAuthedSessionArtifact).toHaveBeenCalledTimes(1);
    const callArgs = mockGetAuthedSessionArtifact.mock.calls[0];
    expect(callArgs[1]).toBe("sess-1");
    expect(callArgs[2]).toBe("art-1");
    expect(callArgs[3]).toBe("shot.png");
  });

  it("is declared before the wildcard /:filename route so it actually matches", () => {
    // Route ordering matters: handleRequest iterates sessionRoutes in declaration order
    // and returns the first match. The wildcard `/:artifactId/:filename` route would
    // happily match `/<id>/view` (treating "view" as filename) and return 404 without
    // a signed token. The /view route MUST come first.
    const viewIdx = sessionRoutes.findIndex(
      (candidate) =>
        candidate.method === "GET" &&
        String(candidate.pattern) ===
          String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/artifacts\/(?<artifactId>[^/]+)\/view$/),
    );
    const wildcardIdx = sessionRoutes.findIndex(
      (candidate) =>
        candidate.method === "GET" &&
        String(candidate.pattern) ===
          String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/artifacts\/(?<artifactId>[^/]+)\/(?<filename>[^/]+)$/),
    );
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(wildcardIdx).toBeGreaterThanOrEqual(0);
    expect(viewIdx).toBeLessThan(wildcardIdx);
  });
});
