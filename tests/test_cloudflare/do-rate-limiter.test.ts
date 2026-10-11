import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
}));

import * as Sentry from "@sentry/cloudflare";

import { checkDurableObjectRateLimit } from "../../apps/control-plane-worker/src/services/do-rate-limiter";
import type { Env } from "../../apps/control-plane-worker/src/types";

const OPTIONS = { max: 5, windowSeconds: 60 };

type FailOpenLog = { event?: string; reason?: string; keyPrefix?: string };

/**
 * Capture structured warn lines emitted by the worker logger. The shared logger
 * writes `console.warn(JSON.stringify(entry))`, so we parse the JSON payloads.
 */
function captureWarnLogs(): { logs: FailOpenLog[]; restore: () => void } {
  const logs: FailOpenLog[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    if (typeof line === "string") {
      try {
        logs.push(JSON.parse(line) as FailOpenLog);
      } catch {
        // ignore non-JSON warn output
      }
    }
  });
  return { logs, restore: () => spy.mockRestore() };
}

function failOpenLogs(logs: FailOpenLog[]): FailOpenLog[] {
  return logs.filter((entry) => entry.event === "rate_limiter.fail_open");
}

/**
 * Build a minimal SESSION_RESUME_RATE_LIMITER binding whose DO fetch is driven
 * by the supplied responder.
 */
function makeEnv(fetchImpl: () => Promise<Response>): Pick<Env, "SESSION_RESUME_RATE_LIMITER"> {
  const stub = { fetch: fetchImpl } as unknown as DurableObjectStub;
  const binding = {
    idFromName: (_name: string) => ({}) as DurableObjectId,
    get: (_id: DurableObjectId) => stub,
  } as unknown as Env["SESSION_RESUME_RATE_LIMITER"];
  return { SESSION_RESUME_RATE_LIMITER: binding };
}

describe("checkDurableObjectRateLimit fail-open signaling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails open and emits backend_unavailable WITHOUT capturing to Sentry when the DO fetch throws", async () => {
    const { logs, restore } = captureWarnLogs();
    const env = makeEnv(() => Promise.reject(new Error("boom")));

    const result = await checkDurableObjectRateLimit(env, "api_key_validation:rl:user:openai", OPTIONS);
    restore();

    expect(result).toMatchObject({ limited: false, max: OPTIONS.max, windowSeconds: OPTIONS.windowSeconds });
    const signals = failOpenLogs(logs);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      event: "rate_limiter.fail_open",
      reason: "backend_unavailable",
      keyPrefix: "api_key_validation",
    });
    // Fail-open is non-fatal by design, so a DO storage fault here must NOT be
    // captured to Sentry (it would misattribute a regional DO/D1 wobble to the
    // limiter). The structured fail_open log above is the incident signal.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("fails open and emits non_2xx on a non-2xx response", async () => {
    const { logs, restore } = captureWarnLogs();
    const env = makeEnv(() => Promise.resolve(new Response("nope", { status: 500 })));

    const result = await checkDurableObjectRateLimit(env, "sandbox-auth:1.2.3.4", OPTIONS);
    restore();

    expect(result).toMatchObject({ limited: false, max: OPTIONS.max, windowSeconds: OPTIONS.windowSeconds });
    const signals = failOpenLogs(logs);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      event: "rate_limiter.fail_open",
      reason: "non_2xx",
      keyPrefix: "sandbox-auth",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("fails open and emits invalid_body on a malformed response body", async () => {
    const { logs, restore } = captureWarnLogs();
    const env = makeEnv(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, allowed: "yes" }), { status: 200 })),
    );

    const result = await checkDurableObjectRateLimit(env, "api_key_validation:rl:user:openai", OPTIONS);
    restore();

    expect(result).toMatchObject({ limited: false, max: OPTIONS.max, windowSeconds: OPTIONS.windowSeconds });
    const signals = failOpenLogs(logs);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      event: "rate_limiter.fail_open",
      reason: "invalid_body",
      keyPrefix: "api_key_validation",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("fails open and emits missing_binding when the limiter binding is absent", async () => {
    const { logs, restore } = captureWarnLogs();

    const result = await checkDurableObjectRateLimit(
      { SESSION_RESUME_RATE_LIMITER: undefined } as unknown as Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
      "abc-session:user-1",
      OPTIONS,
    );
    restore();

    expect(result).toMatchObject({ limited: false, max: OPTIONS.max, windowSeconds: OPTIONS.windowSeconds });
    const signals = failOpenLogs(logs);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      event: "rate_limiter.fail_open",
      reason: "missing_binding",
      keyPrefix: "abc-session",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not emit a fail_open signal on the happy path", async () => {
    const { logs, restore } = captureWarnLogs();
    const env = makeEnv(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, allowed: true, remaining: 4 }), { status: 200 })),
    );

    const result = await checkDurableObjectRateLimit(env, "abc-session:user-1", OPTIONS);
    restore();

    expect(result).toMatchObject({
      limited: false,
      remaining: 4,
      max: OPTIONS.max,
      windowSeconds: OPTIONS.windowSeconds,
    });
    expect(failOpenLogs(logs)).toHaveLength(0);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
