import { afterEach, describe, expect, it, vi } from "vitest";

import { ENVIRONMENT } from "../../shared/constants/environment";

// Capture the structured logger so we can assert the canonical
// `session_start.do_initialize_failed` event. The DO-fetch RETRY itself lives in
// `withDORetry` (opted in via `retryDurableObjectFetch: true`) and is tested by
// tests/test_cloudflare/session/do-retry.test.ts; this suite owns only the
// entrypoint-agnostic failure event that createSessionState emits when initialize
// ultimately fails (after any retry is exhausted). `vi.hoisted` so the spy exists
// before the hoisted mock factory runs (createLogger runs at module load).
const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error }),
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
  instrumentDurableObjectWithSentry: (_o: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_o: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

import { createSessionState } from "../../apps/control-plane-worker/src/session/state";

const TRANSIENT_MESSAGE = "Internal error in Durable Object storage caused object to be reset";

// withDORetry only retries errors Cloudflare tags with `retryable: true` (and not
// `overloaded`). Build one to exercise the retry-then-{recover,exhaust} paths.
function retryableError(message: string): Error {
  return Object.assign(new Error(message), { retryable: true });
}

function okInitializeResponse(sessionId: string): Response {
  return new Response(
    JSON.stringify({
      session: { sessionId, ownerUserId: "user-123", businessId: "biz-1", status: "active" },
      replay: { sessionId, lastEventSequence: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function envWithSessionFetch(fetchMock: ReturnType<typeof vi.fn>) {
  return {
    WORKER_ENV: ENVIRONMENT.Test,
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetchMock }),
    },
  } as unknown as Parameters<typeof createSessionState>[0];
}

const BASE_OPTIONS = {
  businessId: "biz-1",
  credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
} as unknown as Parameters<typeof createSessionState>[3];

describe("createSessionState session-start DO retry", () => {
  afterEach(() => {
    error.mockClear();
  });

  it("emits the canonical failure event (reason=threw) and rethrows when initialize throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(TRANSIENT_MESSAGE);
    });

    await expect(
      createSessionState(envWithSessionFetch(fetchMock), "session-threw", "user-123", BASE_OPTIONS),
    ).rejects.toThrow(/object to be reset/);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "session_start.do_initialize_failed",
        sessionId: "session-threw",
        reason: "threw",
      }),
      expect.any(String),
    );
  });

  it("still emits the canonical failure event after the DO retry is exhausted", async () => {
    // A persistently-retryable fault drives withDORetry through its budget; the
    // final throw must still reach createSessionState's catch and emit the event.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      throw retryableError(TRANSIENT_MESSAGE);
    });

    await expect(
      createSessionState(envWithSessionFetch(fetchMock), "session-exhaust", "user-123", BASE_OPTIONS),
    ).rejects.toThrow(/object to be reset/);

    // Retried (more than the single initial attempt) before giving up. A
    // retryable fault that exhausts the budget is reported as retry_exhausted,
    // distinct from a first-attempt non-retryable throw.
    expect(calls).toBeGreaterThan(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_start.do_initialize_failed", reason: "retry_exhausted" }),
      expect.any(String),
    );
  });

  it("emits no failure event when a retryable fault recovers within the retry budget", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw retryableError(TRANSIENT_MESSAGE);
      return okInitializeResponse("session-recover");
    });

    const result = await createSessionState(
      envWithSessionFetch(fetchMock),
      "session-recover",
      "user-123",
      BASE_OPTIONS,
    );

    expect(result.session.sessionId).toBe("session-recover");
    expect(calls).toBeGreaterThan(1);
    expect(error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_start.do_initialize_failed" }),
      expect.anything(),
    );
  });

  it("emits the canonical failure event with a status reason when the DO returns non-ok", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));

    await expect(
      createSessionState(envWithSessionFetch(fetchMock), "session-503", "user-123", BASE_OPTIONS),
    ).rejects.toThrow(/status 503/);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_start.do_initialize_failed", reason: "status_503" }),
      expect.any(String),
    );
  });

  it("emits no failure event when initialize succeeds on the first attempt", async () => {
    const fetchMock = vi.fn(async () => okInitializeResponse("session-ok"));

    const result = await createSessionState(envWithSessionFetch(fetchMock), "session-ok", "user-123", BASE_OPTIONS);

    expect(result.session.sessionId).toBe("session-ok");
    expect(error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_start.do_initialize_failed" }),
      expect.anything(),
    );
  });
});
