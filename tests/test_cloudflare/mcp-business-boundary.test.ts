/**
 * ARC-830: business-boundary defense-in-depth for MCP / CLI-token requests
 * against session-scoped routes.
 *
 * Two layers under test:
 *   1. Build-time invariant: every CLI-token-allowlisted entry that targets
 *      /api/sessions/* must point at a Route declaring
 *      `mcpBusinessScopeEnforced: true`. This prevents adding a new MCP-
 *      reachable session route without business-filter review.
 *   2. Runtime behavior: a cli_token authenticated as business A receives
 *      404 (not 403, not 200) when targeting a session in business B.
 */
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
  setLoggerErrorHandler: () => {},
}));

const mockGetSessionState = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  };
});

const mockVerifyUserRepoAccess = vi.fn().mockResolvedValue(true);
vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

import { CLI_TOKEN_ROUTE_ALLOWLIST } from "../../apps/control-plane-worker/src/constants/cli-tokens";
import { isSessionScopedPath } from "../../apps/control-plane-worker/src/router";
import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import { controlPlaneRoutes } from "../../apps/control-plane-worker/src/routes/table";
import type { AuthInfo, Env, UserInfo } from "../../apps/control-plane-worker/src/types";

// ---------------------------------------------------------------------------
// 1. Build-time invariant
// ---------------------------------------------------------------------------

describe("MCP business-scope guardrail (ARC-830)", () => {
  function patternToRegex(pattern: string): RegExp {
    return new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
  }

  it("every CLI-allowlisted session route declares mcpBusinessScopeEnforced", () => {
    const sessionAllowlistEntries = new Set<string>();
    for (const scope of Object.keys(CLI_TOKEN_ROUTE_ALLOWLIST) as Array<keyof typeof CLI_TOKEN_ROUTE_ALLOWLIST>) {
      for (const [method, pattern] of CLI_TOKEN_ROUTE_ALLOWLIST[scope]) {
        if (isSessionScopedPath(pattern.replace(/:(\w+)/g, "x"))) {
          sessionAllowlistEntries.add(`${method} ${pattern}`);
        }
      }
    }

    expect(sessionAllowlistEntries.size).toBeGreaterThan(0);

    const unflagged: string[] = [];
    for (const entry of sessionAllowlistEntries) {
      const [method, pattern] = entry.split(" ");
      const regex = patternToRegex(pattern);
      const route = controlPlaneRoutes.find((r) => r.method === method && String(r.pattern) === String(regex));
      if (!route) {
        unflagged.push(`${entry} -- no matching route registered`);
        continue;
      }
      if (!route.mcpBusinessScopeEnforced) {
        unflagged.push(`${entry} -- route is missing mcpBusinessScopeEnforced: true`);
      }
    }

    expect(unflagged).toEqual([]);
  });

  it("isSessionScopedPath matches /api/sessions and descendants only", () => {
    expect(isSessionScopedPath("/api/sessions")).toBe(true);
    expect(isSessionScopedPath("/api/sessions/abc")).toBe(true);
    expect(isSessionScopedPath("/api/sessions/abc/prompts")).toBe(true);
    expect(isSessionScopedPath("/api/sessions/abc/child-sessions/xyz/status")).toBe(true);

    expect(isSessionScopedPath("/api/cli-tokens")).toBe(false);
    expect(isSessionScopedPath("/api/auth/whoami")).toBe(false);
    expect(isSessionScopedPath("/api/sessionsfoo")).toBe(false);
    expect(isSessionScopedPath("/api/session/abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Runtime behavior: cross-business cli_token sees 404
// ---------------------------------------------------------------------------

function createCliTokenAuth(userId: string, businessId: string, overrides: Partial<UserInfo> = {}): AuthInfo {
  return {
    userId,
    tokenSource: "bearer",
    authMode: "cli_token",
    canAccessAllSessions: false,
    cliTokenScope: "read",
    cliTokenId: 1,
    user: {
      id: Number(userId),
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId,
      sharedSessions: false,
      businessMemberIds: [],
      ...overrides,
    },
  };
}

function createMinimalEnv(): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      })),
    } as unknown as D1Database,
  } as unknown as Env;
}

function findRoute(method: string, pattern: string) {
  const expected = new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
  const route = sessionRoutes.find((r) => r.method === method && String(r.pattern) === String(expected));
  if (!route) throw new Error(`route ${method} ${pattern} not found`);
  return route;
}

describe("cross-business cli_token returns 404 on session-scoped routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    // Session exists, owned by user 99 in business B; the cli token is for
    // user 42 in business A.
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-cross",
      ownerUserId: "99",
      businessId: "biz-B",
      status: "active",
      createdAt: "2026-04-07T09:00:00.000Z",
      updatedAt: "2026-04-07T10:05:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: "cross-business session",
      repoOwner: null,
      repoName: null,
    });
  });

  const cases: Array<{ name: string; method: string; pattern: string; url: string }> = [
    {
      name: "GET /api/sessions/:sessionId",
      method: "GET",
      pattern: "/api/sessions/:sessionId",
      url: "https://worker.test/api/sessions/sess-cross",
    },
    {
      name: "GET /api/sessions/:sessionId/prompts",
      method: "GET",
      pattern: "/api/sessions/:sessionId/prompts",
      url: "https://worker.test/api/sessions/sess-cross/prompts",
    },
    {
      name: "GET /api/sessions/:sessionId/events",
      method: "GET",
      pattern: "/api/sessions/:sessionId/events",
      url: "https://worker.test/api/sessions/sess-cross/events",
    },
    {
      name: "DELETE /api/sessions/:sessionId",
      method: "DELETE",
      pattern: "/api/sessions/:sessionId",
      url: "https://worker.test/api/sessions/sess-cross",
    },
  ];

  for (const c of cases) {
    it(`${c.name} returns 404 (existence-oracle safe) for cross-business cli_token`, async () => {
      const route = findRoute(c.method, c.pattern);
      const auth = createCliTokenAuth("42", "biz-A");
      const env = createMinimalEnv();
      const match = route.pattern.exec(new URL(c.url).pathname)!;
      const response = await route.handler(new Request(c.url, { method: c.method }), env, match, auth, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext);
      expect(response.status).toBe(404);
    });
  }

  it("same-business cli_token is NOT rejected by canAccessSession", async () => {
    // Sanity: switch the session into business A and the route handler should
    // get past the business-boundary check (it may still 404 for downstream
    // reasons, but it must not be the cross-business 404 path).
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-same",
      ownerUserId: "42",
      businessId: "biz-A",
      status: "active",
      createdAt: "2026-04-07T09:00:00.000Z",
      updatedAt: "2026-04-07T10:05:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: null,
      repoOwner: null,
      repoName: null,
    });

    const route = findRoute("GET", "/api/sessions/:sessionId");
    const auth = createCliTokenAuth("42", "biz-A");
    const env = createMinimalEnv();
    const url = "https://worker.test/api/sessions/sess-same";
    const match = route.pattern.exec(new URL(url).pathname)!;
    const response = await route.handler(new Request(url), env, match, auth, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
    // Owner-match path; canAccessSession returns true.
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. Integration: router gate fires when a session route is unflagged
//
// The build-time invariant above proves no allowlisted session route ships
// without the flag today. The gate path in router.ts is therefore unreachable
// under current routes. This test temporarily clears the flag on a real
// route, drives a request through the full worker fetch handler, and asserts
// the router itself (not the route handler) returns 404 with no body leak.
// Catches a future refactor that reorders or short-circuits the gate.
// ---------------------------------------------------------------------------

const mockResolveCliToken = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/cli-tokens", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCliToken: (...args: unknown[]) => mockResolveCliToken(...args),
  };
});

describe("router gate (integration): cli_token + unflagged session route -> 404", () => {
  type WorkerModule = import("./helpers/worker-harness").WorkerModule;

  let workerModule: WorkerModule;
  let env: Record<string, unknown>;
  let createWorkerEnv: (typeof import("../smoke/helpers"))["createWorkerEnv"];
  let seedAuthUser: (typeof import("../smoke/helpers"))["seedAuthUser"];
  let workerFetch: (typeof import("./helpers/worker-harness"))["workerFetch"];

  const validUser = {
    id: 42,
    login: "cliuser",
    name: null,
    email: null,
    businessId: "biz-A",
    sharedSessions: false,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const helpers = await import("../smoke/helpers");
    const harness = await import("./helpers/worker-harness");
    createWorkerEnv = helpers.createWorkerEnv;
    seedAuthUser = helpers.seedAuthUser;
    workerFetch = harness.workerFetch;
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as unknown as WorkerModule;
    const created = createWorkerEnv(workerModule);
    env = created.env;
    seedAuthUser(created.db, "session-token-x", 1, "testuser");
  });

  it("returns 404 when an allowlisted session route is temporarily missing the flag", async () => {
    mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", tokenId: 1, user: validUser });

    // Strip the flag from /api/sessions/:sessionId/prompts, fire the request,
    // restore. Mutating the shared routes array is safe within a single test
    // because vitest isolates files and we restore in `finally`.
    const target = controlPlaneRoutes.find(
      (r) => r.method === "GET" && String(r.pattern) === String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/prompts$/),
    );
    if (!target) throw new Error("prompts route not found");
    const original = target.mcpBusinessScopeEnforced;
    try {
      delete (target as { mcpBusinessScopeEnforced?: true }).mcpBusinessScopeEnforced;
      const res = await workerFetch(workerModule, env, "/api/sessions/sess-x/prompts", {
        headers: { authorization: "Bearer arc_token" },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Not found");
    } finally {
      if (original !== undefined) target.mcpBusinessScopeEnforced = original;
    }
  });

  it("does NOT fire on /api/cli-tokens (non-session-scoped) regardless of flag", async () => {
    mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", tokenId: 1, user: validUser });
    const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
      headers: { authorization: "Bearer arc_token" },
    });
    // 200 from the cli-tokens list handler proves the gate did not apply.
    expect(res.status).toBe(200);
  });
});
