import * as Sentry from "@sentry/cloudflare";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedSpan } from "../../apps/control-plane-worker/src/observability/context";
import { parsePattern, type Route } from "../../apps/control-plane-worker/src/routes/shared";

const routeState = vi.hoisted(() => ({
  routes: [] as Route[],
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
  loggerState.info.mockClear();
  loggerState.warn.mockClear();
  loggerState.error.mockClear();
  vi.mocked(Sentry.setTag).mockClear();
  vi.mocked(Sentry.setUser).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function route(method: string, template: string, handler: Route["handler"], auth: Route["auth"] = "public"): Route {
  return {
    method,
    pattern: parsePattern(template),
    auth,
    handler,
  };
}

function createEnv(traceQueueSend = vi.fn().mockResolvedValue(undefined)): Record<string, unknown> {
  return {
    TRACE_QUEUE: { send: traceQueueSend },
    WORKER_ENV: "test",
    LOG_LEVEL: "info",
    FRONTEND_URL: "https://app.trycycloid.com",
    ARCANIST_ADMIN_TOKEN: "admin-secret",
    CI_AUTOMATION_TOKEN: "ci-secret",
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

function requestHandledLog(): Record<string, unknown> {
  const call = loggerState.info.mock.calls.find((entry) => entry[1] === "Request handled");
  expect(call).toBeDefined();
  return call![0] as Record<string, unknown>;
}

function fetchSpan(traceQueueSend: ReturnType<typeof vi.fn>): CompletedSpan {
  const message = traceQueueSend.mock.calls[0]?.[0] as { spans?: CompletedSpan[] } | undefined;
  const span = message?.spans?.find((entry) => entry.name === "worker.fetch");
  expect(span).toBeDefined();
  return span!;
}

function lastSentryRouteTag(): unknown {
  const calls = vi.mocked(Sentry.setTag).mock.calls.filter(([key]) => key === "route");
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)?.[1];
}

async function expectRouteTelemetry(path: string, expectedRoute: string, init: RequestInit = {}) {
  const { response, traceQueueSend } = await fetchThroughRouter(path, init);

  expect(requestHandledLog().route).toBe(expectedRoute);
  expect(fetchSpan(traceQueueSend).attributes["http.route"]).toBe(expectedRoute);
  expect(lastSentryRouteTag()).toBe(expectedRoute);
  return response;
}

describe("router route telemetry", () => {
  it("records the template for a matched dynamic route", async () => {
    routeState.routes.push(route("GET", "/api/items/:itemId", async () => Response.json({ ok: true })));

    const response = await expectRouteTelemetry("/api/items/it_123", "/api/items/:itemId");

    expect(response.status).toBe(200);
    expect(requestHandledLog().path).toBe("/api/items/it_123");
  });

  it("records the template for a matched static route", async () => {
    routeState.routes.push(route("GET", "/api/static", async () => Response.json({ ok: true })));

    const response = await expectRouteTelemetry("/api/static", "/api/static");

    expect(response.status).toBe(200);
  });

  it("records the template for a matched multi-param route", async () => {
    routeState.routes.push(route("GET", "/api/repos/:owner/:repo", async () => Response.json({ ok: true })));

    const response = await expectRouteTelemetry("/api/repos/trycycloid/cycloid", "/api/repos/:owner/:repo");

    expect(response.status).toBe(200);
  });

  it("sets the Sentry template tag before the matched handler runs", async () => {
    const handledError = new Error("handled");
    routeState.routes.push(
      route("GET", "/api/sessions/:sessionId/files", async () => {
        expect(lastSentryRouteTag()).toBe("/api/sessions/:sessionId/files");
        Sentry.captureException(handledError);
        return Response.json({ ok: false }, { status: 502 });
      }),
    );

    const response = await expectRouteTelemetry("/api/sessions/sess_123/files", "/api/sessions/:sessionId/files");

    expect(response.status).toBe(502);
    expect(Sentry.captureException).toHaveBeenCalledWith(handledError);
  });

  it("records the template when the matched handler throws", async () => {
    const error = new Error("boom");
    routeState.routes.push(
      route("POST", "/api/sessions/:sessionId/send", async () => {
        throw error;
      }),
    );

    const response = await expectRouteTelemetry("/api/sessions/sess_123/send", "/api/sessions/:sessionId/send", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(loggerState.error).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/api/sessions/:sessionId/send" }),
      "Unhandled request error",
    );
  });

  it("records the template when auth fails before the matched handler runs", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    routeState.routes.push(route("GET", "/api/private/:id", handler, "authenticated"));

    const response = await expectRouteTelemetry("/api/private/secret_123", "/api/private/:id");

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches sandbox-DO-verified routes without router-level user auth", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    routeState.routes.push(route("GET", "/api/sessions/:sessionId/clone-token", handler, "sandbox_do_verified"));

    const response = await expectRouteTelemetry(
      "/api/sessions/sess_123/clone-token",
      "/api/sessions/:sessionId/clone-token",
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("records preflight for OPTIONS requests", async () => {
    routeState.routes.push(route("GET", "/api/items/:itemId", async () => Response.json({ ok: true })));

    const response = await expectRouteTelemetry("/api/items/it_123", "preflight", { method: "OPTIONS" });

    expect(response.status).toBe(204);
  });

  it("records unmatched for 404s without leaking the raw path", async () => {
    routeState.routes.push(route("GET", "/api/items/:itemId", async () => Response.json({ ok: true })));

    const response = await expectRouteTelemetry("/api/nope/raw_123", "unmatched");

    expect(response.status).toBe(404);
  });
});
