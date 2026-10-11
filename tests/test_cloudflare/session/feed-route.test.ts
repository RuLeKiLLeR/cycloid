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

vi.mock("../../../apps/control-plane-worker/src/logger", () => {
  const stub: Record<string, unknown> = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  stub.child = () => stub;
  return { createLogger: () => stub };
});

const mockAuthenticateRequest = vi.fn();
const mockListAccessibleReposForUser = vi.fn();

vi.mock("../../../apps/control-plane-worker/src/auth/routes", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/auth/routes")>(
    "../../../apps/control-plane-worker/src/auth/routes",
  );
  return { ...actual, authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args) };
});

vi.mock("../../../apps/control-plane-worker/src/services/repos", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/services/repos")>(
    "../../../apps/control-plane-worker/src/services/repos",
  );
  return { ...actual, listAccessibleReposForUser: (...args: unknown[]) => mockListAccessibleReposForUser(...args) };
});

import { sessionRoutes } from "../../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env } from "../../../apps/control-plane-worker/src/types";

function feedRoute() {
  const route = sessionRoutes.find(
    (candidate) => candidate.method === "GET" && String(candidate.pattern).includes("users\\/me\\/feed\\/ws"),
  );
  if (!route) throw new Error("Feed WS route not registered");
  return route;
}

function userAuth(
  userId: string,
  over: { businessId?: string | null; readOnly?: true; sharedSessions?: boolean } = {},
): AuthInfo {
  return {
    userId,
    tokenSource: "session_token",
    authMode: "user_session",
    canAccessAllSessions: false,
    ...(over.readOnly ? { readOnly: true as const } : {}),
    user: {
      id: Number(userId),
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId: over.businessId === undefined ? "biz-1" : (over.businessId as string),
      sharedSessions: over.sharedSessions ?? false,
      businessMemberIds: [],
    },
  } as unknown as AuthInfo;
}

let feedFetch: ReturnType<typeof vi.fn>;
let feedGet: ReturnType<typeof vi.fn>;
let idFromName: ReturnType<typeof vi.fn>;

function makeEnv(): Env {
  feedFetch = vi.fn().mockResolvedValue({ status: 101 });
  feedGet = vi.fn().mockReturnValue({ fetch: feedFetch });
  idFromName = vi.fn().mockImplementation((name: string) => `id:${name}`);
  return { SESSION_FEED: { idFromName, get: feedGet } } as unknown as Env;
}

const route = feedRoute();
const upgradeRequest = () =>
  new Request("https://worker.test/api/users/me/feed/ws", { headers: { upgrade: "websocket" } });

function callRoute(request: Request, env: Env) {
  return (route.handler as (r: Request, e: Env) => Promise<Response>)(request, env);
}

describe("GET /api/users/me/feed/ws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 426 without a websocket upgrade header", async () => {
    const res = await callRoute(new Request("https://worker.test/api/users/me/feed/ws"), makeEnv());
    expect(res.status).toBe(426);
  });

  it("returns the authenticator's 401 response when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: false, response: new Response("no", { status: 401 }) });
    const res = await callRoute(upgradeRequest(), makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 403 (fail closed) when the auth has no business", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, auth: userAuth("42", { businessId: null }) });
    const res = await callRoute(upgradeRequest(), makeEnv());
    expect(res.status).toBe(403);
  });

  it("matches the business list/bootstrap gate: disabled sharedSessions opens owner-only and skips repo snapshot", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, auth: userAuth("42", { sharedSessions: false }) });
    mockListAccessibleReposForUser.mockResolvedValue({
      ok: true,
      repos: [{ fullName: "Acme/Widgets" }],
      ssoOrgs: [],
      cacheStatus: "hit",
    });
    const env = makeEnv();
    const res = await callRoute(upgradeRequest(), env);

    expect(res.status).toBe(101);
    const forwarded = feedFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-auth-user-id")).toBe("42");
    expect(JSON.parse(forwarded.headers.get("x-feed-repos")!)).toEqual([]);
    expect(mockListAccessibleReposForUser).not.toHaveBeenCalled();
  });

  it("matches the business list/bootstrap gate: enabled sharedSessions forwards the lowercased repo set", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, auth: userAuth("42", { sharedSessions: true }) });
    mockListAccessibleReposForUser.mockResolvedValue({
      ok: true,
      repos: [{ fullName: "Acme/Widgets" }, { fullName: "Acme/Tools" }],
      ssoOrgs: [],
      cacheStatus: "hit",
    });
    const env = makeEnv();
    const res = await callRoute(upgradeRequest(), env);

    expect(res.status).toBe(101);
    expect(idFromName).toHaveBeenCalledWith("biz-1");
    expect(feedGet).toHaveBeenCalledWith("id:biz-1");
    const forwarded = feedFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-auth-user-id")).toBe("42");
    expect(JSON.parse(forwarded.headers.get("x-feed-repos")!)).toEqual(["acme/widgets", "acme/tools"]);
  });

  it("allows read-only impersonation and still applies the target user's sharedSessions gate", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      auth: userAuth("99", { readOnly: true, sharedSessions: false }),
    });
    mockListAccessibleReposForUser.mockResolvedValue({
      ok: true,
      repos: [{ fullName: "Acme/Widgets" }],
      ssoOrgs: [],
      cacheStatus: "hit",
    });
    const env = makeEnv();
    const res = await callRoute(upgradeRequest(), env);

    expect(res.status).toBe(101);
    const forwarded = feedFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-auth-user-id")).toBe("99");
    expect(JSON.parse(forwarded.headers.get("x-feed-repos")!)).toEqual([]);
    expect(mockListAccessibleReposForUser).not.toHaveBeenCalled();
  });

  it("allows read-only impersonation with sharedSessions enabled, tagging by the target user id", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      auth: userAuth("99", { readOnly: true, sharedSessions: true }),
    });
    mockListAccessibleReposForUser.mockResolvedValue({ ok: true, repos: [], ssoOrgs: [], cacheStatus: "hit" });
    const env = makeEnv();
    const res = await callRoute(upgradeRequest(), env);

    expect(res.status).toBe(101);
    const forwarded = feedFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-auth-user-id")).toBe("99");
  });

  it("forwards an empty repo set (and still opens the socket) on the snapshot 503 failure shape", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, auth: userAuth("42", { sharedSessions: true }) });
    mockListAccessibleReposForUser.mockResolvedValue({ ok: false, status: 500, error: "boom" });
    const env = makeEnv();
    const res = await callRoute(upgradeRequest(), env);

    expect(res.status).toBe(101);
    const forwarded = feedFetch.mock.calls[0][0] as Request;
    expect(JSON.parse(forwarded.headers.get("x-feed-repos")!)).toEqual([]);
  });

  it("forwards an empty repo set (and still opens the socket) when the user has no GitHub token", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, auth: userAuth("42", { sharedSessions: true }) });
    mockListAccessibleReposForUser.mockResolvedValue({ ok: false, status: 401, tokenReason: "token_missing" });
    const env = makeEnv();
    const res = await callRoute(upgradeRequest(), env);

    expect(res.status).toBe(101);
    const forwarded = feedFetch.mock.calls[0][0] as Request;
    expect(JSON.parse(forwarded.headers.get("x-feed-repos")!)).toEqual([]);
  });

  it("returns 503 when the SESSION_FEED binding is absent", async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, auth: userAuth("42") });
    const res = await callRoute(upgradeRequest(), {} as Env);
    expect(res.status).toBe(503);
  });
});
