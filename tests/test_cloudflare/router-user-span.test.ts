import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedSpan } from "../../apps/control-plane-worker/src/observability/context";
import { parsePattern, type Route } from "../../apps/control-plane-worker/src/routes/shared";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

const routeState = vi.hoisted(() => ({
  routes: [] as Route[],
}));

const authState = vi.hoisted(() => ({
  result: null as { ok: true; auth: AuthInfo } | { ok: false; response: Response } | null,
}));

const loggerState = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

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
  setTag: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/routes/table", () => ({
  controlPlaneRoutes: routeState.routes,
}));

vi.mock("../../apps/control-plane-worker/src/auth/routes", () => ({
  authenticateRequest: vi.fn(async () => {
    if (!authState.result) throw new Error("authState.result not set for test");
    return authState.result;
  }),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => loggerState,
  setLoggerErrorHandler: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedEnv: (env: unknown) => env,
  tracedFetch: vi.fn(),
}));

type RouterModule = typeof import("../../apps/control-plane-worker/src/router");

let router: RouterModule["default"];

beforeAll(async () => {
  ({ default: router } = await import("../../apps/control-plane-worker/src/router"));
});

beforeEach(() => {
  routeState.routes.length = 0;
  authState.result = null;
  loggerState.info.mockClear();
  loggerState.warn.mockClear();
  loggerState.error.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function user(overrides: Partial<AuthInfo["user"]> = {}): NonNullable<AuthInfo["user"]> {
  return {
    id: 7,
    login: "alice",
    name: "Alice",
    email: "alice@example.com",
    businessId: "biz-1",
    ...overrides,
  };
}

function createEnv(traceQueueSend = vi.fn().mockResolvedValue(undefined)): Record<string, unknown> {
  return {
    TRACE_QUEUE: { send: traceQueueSend },
    WORKER_ENV: "test",
    LOG_LEVEL: "info",
    FRONTEND_URL: "https://app.trycycloid.com",
  };
}

async function fetchThroughRouter(path: string, init: RequestInit = {}) {
  const waitUntil: Promise<unknown>[] = [];
  const traceQueueSend = vi.fn().mockResolvedValue(undefined);
  const env = createEnv(traceQueueSend);
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntil.push(promise);
    },
  } as ExecutionContext;

  const response = await router.fetch!(new Request(`https://worker.test${path}`, init), env, ctx);
  await Promise.all(waitUntil);
  return { response, traceQueueSend };
}

function fetchSpan(traceQueueSend: ReturnType<typeof vi.fn>): CompletedSpan {
  const message = traceQueueSend.mock.calls[0]?.[0] as { spans?: CompletedSpan[] } | undefined;
  const span = message?.spans?.find((entry) => entry.name === "worker.fetch");
  expect(span).toBeDefined();
  return span!;
}

function authenticatedRoute(): void {
  routeState.routes.push({
    method: "GET",
    pattern: parsePattern("/api/private/:id"),
    auth: "authenticated",
    handler: async () => Response.json({ ok: true }),
  });
}

function automationRoute(): void {
  routeState.routes.push({
    method: "GET",
    pattern: parsePattern("/api/health/warm"),
    auth: "automation",
    handler: async () => Response.json({ ok: true }),
  });
}

describe("router root-span user tagging", () => {
  it("tags the worker.fetch span with the authenticated user's id and login", async () => {
    authState.result = {
      ok: true,
      auth: {
        userId: "7",
        tokenSource: "session_token",
        authMode: "user_session",
        canAccessAllSessions: false,
        user: user(),
      },
    };
    authenticatedRoute();

    const { response, traceQueueSend } = await fetchThroughRouter("/api/private/x_1");

    expect(response.status).toBe(200);
    const span = fetchSpan(traceQueueSend);
    expect(span.attributes["user.id"]).toBe("7");
    expect(span.attributes["user.login"]).toBe("alice");
  });

  it("omits user.login when the authenticated user has no login, keeping user.id", async () => {
    authState.result = {
      ok: true,
      auth: {
        userId: "7",
        tokenSource: "session_token",
        authMode: "user_session",
        canAccessAllSessions: false,
        user: user({ login: null }),
      },
    };
    authenticatedRoute();

    const { response, traceQueueSend } = await fetchThroughRouter("/api/private/x_1");

    expect(response.status).toBe(200);
    const span = fetchSpan(traceQueueSend);
    expect(span.attributes["user.id"]).toBe("7");
    expect(span.attributes["user.login"]).toBeUndefined();
  });

  it("tags the operator (actor) principal under impersonation, never the target", async () => {
    authState.result = {
      ok: true,
      auth: {
        userId: "7",
        tokenSource: "session_token",
        authMode: "user_session",
        canAccessAllSessions: false,
        user: user({ id: 7, login: "alice" }),
        actorUserId: "99",
        actorUser: user({ id: 99, login: "operator", email: "op@cycloid.dev" }),
        impersonationId: "imp_1",
        readOnly: true,
      },
    };
    authenticatedRoute();

    const { response, traceQueueSend } = await fetchThroughRouter("/api/private/x_1");

    expect(response.status).toBe(200);
    const span = fetchSpan(traceQueueSend);
    // id and login must reference the SAME (actor) principal.
    expect(span.attributes["user.id"]).toBe("99");
    expect(span.attributes["user.login"]).toBe("operator");
  });

  it("tags automation-mode requests with the authenticated principal", async () => {
    authState.result = {
      ok: true,
      auth: {
        userId: "7",
        tokenSource: "admin_token",
        authMode: "admin_token",
        canAccessAllSessions: true,
        user: user(),
      },
    };
    automationRoute();

    const { response, traceQueueSend } = await fetchThroughRouter("/api/health/warm");

    expect(response.status).toBe(200);
    const span = fetchSpan(traceQueueSend);
    expect(span.attributes["user.id"]).toBe("7");
    expect(span.attributes["user.login"]).toBe("alice");
  });

  it("does not tag a user on public (unauthenticated) routes", async () => {
    routeState.routes.push({
      method: "GET",
      pattern: parsePattern("/api/public"),
      auth: "public",
      handler: async () => Response.json({ ok: true }),
    });

    const { response, traceQueueSend } = await fetchThroughRouter("/api/public");

    expect(response.status).toBe(200);
    const span = fetchSpan(traceQueueSend);
    expect(span.attributes["user.id"]).toBeUndefined();
    expect(span.attributes["user.login"]).toBeUndefined();
  });
});
