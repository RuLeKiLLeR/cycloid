import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const postStructuredEventToDdMock = vi.hoisted(() => vi.fn());

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

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => postStructuredEventToDdMock(...args),
}));

import { SESSION_WS_TELEMETRY_ACTIONS as SERVER_SESSION_WS_TELEMETRY_ACTIONS } from "../../apps/control-plane-worker/src/services/session-ws-telemetry";
import { SESSION_WS_TELEMETRY_ACTIONS as UI_SESSION_WS_TELEMETRY_ACTIONS } from "../../apps/ui/src/api/sessionTelemetry";
import { createWorkerEnv, seedAuthUser, sessionTokenHeaders, workerFetch, type WorkerModule } from "./helpers";

function createDenyingRateLimiter() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, allowed: false, remaining: 0 }), {
          headers: { "content-type": "application/json" },
        }),
    }),
  };
}

describe("smoke: session WebSocket telemetry", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    postStructuredEventToDdMock.mockReset().mockResolvedValue(true);
  });

  it("keeps the UI telemetry actions in sync with the server allow-list", () => {
    expect([...UI_SESSION_WS_TELEMETRY_ACTIONS]).toEqual([...SERVER_SESSION_WS_TELEMETRY_ACTIONS]);
  });

  it("records owner WebSocket telemetry with sanitized server-derived fields", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 1001, "owner");
    const headers = sessionTokenHeaders("owner-token");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-ws-owner", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(createRes.status).toBe(201);

    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-ws-owner/ws-telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "ws_watchdog_reconnect",
        staleDurationMs: 4000,
        consecutiveWatchdogStalls: 2,
        closeReason: "watchdog_stall",
        ignored: "not exported",
      }),
    });

    expect(telemetryRes.status).toBe(204);
    await vi.waitFor(() => expect(postStructuredEventToDdMock).toHaveBeenCalled());
    expect(postStructuredEventToDdMock).toHaveBeenCalledWith(expect.objectContaining({ DB: env.DB }), {
      event: "session_ws_telemetry",
      action: "ws_watchdog_reconnect",
      sessionId: "s-ws-owner",
      userId: "1001",
      viewerRelation: "owner",
      attempts: null,
      closeReason: "watchdog_stall",
      consecutiveWatchdogStalls: 2,
      staleDurationMs: 4000,
    });
  });

  it("derives shared viewer relation server-side", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 1001, "owner");
    db.businesses.set("biz-1", { id: "biz-1", shared_sessions: 1 });
    seedAuthUser(db, "viewer-token", 1002, "viewer");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
      body: JSON.stringify({ sessionId: "s-ws-shared", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(createRes.status).toBe(201);

    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-ws-shared/ws-telemetry", {
      method: "POST",
      headers: sessionTokenHeaders("viewer-token"),
      body: JSON.stringify({ action: "ws_error" }),
    });

    expect(telemetryRes.status).toBe(204);
    await vi.waitFor(() => expect(postStructuredEventToDdMock).toHaveBeenCalled());
    expect(postStructuredEventToDdMock.mock.calls.at(-1)?.[1]).toMatchObject({
      event: "session_ws_telemetry",
      action: "ws_error",
      sessionId: "s-ws-shared",
      userId: "1002",
      viewerRelation: "shared",
    });
  });

  it("rejects invalid telemetry bodies without emitting", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 1001, "owner");
    const headers = sessionTokenHeaders("owner-token");
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-ws-invalid", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    postStructuredEventToDdMock.mockClear();

    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-ws-invalid/ws-telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "not_a_ws_signal" }),
    });

    expect(telemetryRes.status).toBe(400);
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });

  it("truncates long close reasons instead of dropping them", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 1001, "owner");
    const headers = sessionTokenHeaders("owner-token");
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-ws-long-close", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    const closeReason = "x".repeat(80);
    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-ws-long-close/ws-telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "ws_error", closeReason }),
    });

    expect(telemetryRes.status).toBe(204);
    await vi.waitFor(() => expect(postStructuredEventToDdMock).toHaveBeenCalled());
    expect(postStructuredEventToDdMock.mock.calls.at(-1)?.[1]).toMatchObject({
      closeReason: "x".repeat(64),
    });
  });

  it("requires authentication", async () => {
    const { env } = createWorkerEnv(workerModule);

    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-any/ws-telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "ws_error" }),
    });

    expect(telemetryRes.status).toBe(401);
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });

  it("rate limits accepted telemetry before exporting", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 1001, "owner");
    const headers = sessionTokenHeaders("owner-token");
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-ws-limited", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(createRes.status).toBe(201);
    postStructuredEventToDdMock.mockClear();
    env.SESSION_RESUME_RATE_LIMITER = createDenyingRateLimiter();

    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-ws-limited/ws-telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "ws_blocked_fallback", attempts: 10 }),
    });

    expect(telemetryRes.status).toBe(429);
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });
});
