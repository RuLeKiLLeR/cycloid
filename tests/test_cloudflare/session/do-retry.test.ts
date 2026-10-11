/**
 * Tests for withDORetry -- exponential backoff retry for DO stub.fetch calls.
 */
import { describe, expect, it, vi } from "vitest";

import { ENVIRONMENT } from "../../../shared/constants/environment";

// Mock the observability module before importing state.ts
vi.mock("../../../apps/control-plane-worker/src/observability/context", () => ({
  currentContext: () => null,
  injectTraceparent: () => null,
}));

vi.mock("../../../apps/control-plane-worker/src/session/db", () => ({
  buildUpsertReplayMetadataStatement: vi.fn(),
  buildUpsertSessionIndexStatement: vi.fn(),
}));

import {
  computeDoRetryBackoffMs,
  createSessionState,
  withDORetry,
} from "../../../apps/control-plane-worker/src/session/state";
import type { Env } from "../../../apps/control-plane-worker/src/types";

function makeRetryableError(message: string): Error & { retryable: boolean } {
  const err = new Error(message) as Error & { retryable: boolean };
  err.retryable = true;
  return err;
}

function makeOverloadedError(message: string): Error & { retryable: boolean; overloaded: boolean } {
  const err = new Error(message) as Error & { retryable: boolean; overloaded: boolean };
  err.retryable = true;
  err.overloaded = true;
  return err;
}

function makeNonRetryableError(message: string): Error {
  return new Error(message);
}

function createMockEnv(stubFn: (...args: unknown[]) => unknown) {
  return {
    WORKER_ENV: ENVIRONMENT.Test,
    SESSION: {
      idFromName: vi.fn().mockReturnValue("fake-do-id"),
      get: vi.fn().mockImplementation(() => stubFn()),
    },
  } as unknown as Env;
}

describe("withDORetry", () => {
  it("returns result on first success", async () => {
    const mockStub = { fetch: vi.fn().mockResolvedValue("ok") };
    const env = createMockEnv(() => mockStub);

    const result = await withDORetry(env, "session-1", async (stub) => {
      return (stub as typeof mockStub).fetch("https://internal/test");
    });

    expect(result).toBe("ok");
    expect(env.SESSION.get).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    let attempt = 0;
    const env = createMockEnv(() => ({
      fetch: vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt === 1) throw makeRetryableError("internal error; reference = abc123");
        return Promise.resolve("ok");
      }),
    }));

    const result = await withDORetry(env, "session-1", async (stub) => {
      return (stub as { fetch: () => Promise<string> }).fetch();
    });

    expect(result).toBe("ok");
    expect(env.SESSION.get).toHaveBeenCalledTimes(2); // fresh stub each attempt
  });

  it("creates a fresh stub on each retry attempt", async () => {
    let attempt = 0;
    const stubs: object[] = [];
    const env = createMockEnv(() => {
      const stub = {
        fetch: vi.fn().mockImplementation(() => {
          attempt++;
          if (attempt < 3) throw makeRetryableError("transient");
          return Promise.resolve("ok");
        }),
      };
      stubs.push(stub);
      return stub;
    });

    await withDORetry(env, "session-1", async (stub) => {
      return (stub as { fetch: () => Promise<string> }).fetch();
    });

    expect(stubs).toHaveLength(3);
    expect(stubs[0]).not.toBe(stubs[1]);
    expect(stubs[1]).not.toBe(stubs[2]);
  });

  it("does not retry non-retryable errors", async () => {
    const env = createMockEnv(() => ({
      fetch: vi.fn().mockImplementation(() => {
        throw makeNonRetryableError("permanent failure");
      }),
    }));

    await expect(
      withDORetry(env, "session-1", async (stub) => {
        return (stub as { fetch: () => Promise<string> }).fetch();
      }),
    ).rejects.toThrow("permanent failure");

    expect(env.SESSION.get).toHaveBeenCalledTimes(1);
  });

  it("does not retry overloaded errors", async () => {
    const env = createMockEnv(() => ({
      fetch: vi.fn().mockImplementation(() => {
        throw makeOverloadedError("overloaded");
      }),
    }));

    await expect(
      withDORetry(env, "session-1", async (stub) => {
        return (stub as { fetch: () => Promise<string> }).fetch();
      }),
    ).rejects.toThrow("overloaded");

    expect(env.SESSION.get).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all attempts", async () => {
    const env = createMockEnv(() => ({
      fetch: vi.fn().mockImplementation(() => {
        throw makeRetryableError("keeps failing");
      }),
    }));

    await expect(
      withDORetry(env, "session-1", async (stub) => {
        return (stub as { fetch: () => Promise<string> }).fetch();
      }),
    ).rejects.toThrow("keeps failing");

    expect(env.SESSION.get).toHaveBeenCalledTimes(3); // default maxAttempts = 3
  });

  it("respects custom maxAttempts", async () => {
    const env = createMockEnv(() => ({
      fetch: vi.fn().mockImplementation(() => {
        throw makeRetryableError("keeps failing");
      }),
    }));

    await expect(
      withDORetry(
        env,
        "session-1",
        async (stub) => {
          return (stub as { fetch: () => Promise<string> }).fetch();
        },
        5,
      ),
    ).rejects.toThrow("keeps failing");

    expect(env.SESSION.get).toHaveBeenCalledTimes(5);
  });
});

describe("createSessionState DO retry", () => {
  it("retries the initial initialize fetch on retryable Durable Object errors", async () => {
    let attempt = 0;
    const env = createMockEnv(() => ({
      fetch: vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt === 1) throw makeRetryableError("internal error; reference = abc123");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              session: { sessionId: "session-1", ownerUserId: "42", businessId: "biz-a" },
              replay: {},
            }),
          ),
        );
      }),
    }));

    await expect(
      createSessionState(env, "session-1", "42", {
        businessId: "biz-a",
        auth: { userId: "42", businessId: "biz-a", canAccessAllSessions: false },
        credentialGate: { mode: "skip", reason: "unit test" },
      }),
    ).resolves.toMatchObject({ session: { sessionId: "session-1" } });

    expect(attempt).toBe(2);
    expect(env.SESSION.get).toHaveBeenCalledTimes(2);
  });
});

describe("computeDoRetryBackoffMs", () => {
  const opts = (random: number) => ({ baseBackoffMs: 100, maxBackoffMs: 5_000, random: () => random });

  it("keeps a non-zero floor at 50% of the exponential term even when random() is 0", () => {
    // Old formula (base * random * 2^attempt) returned 0 here -- a busy spin.
    expect(computeDoRetryBackoffMs(0, opts(0))).toBe(50);
    expect(computeDoRetryBackoffMs(2, opts(0))).toBe(200);
  });

  it("reaches the full exponential term when random() is 1", () => {
    expect(computeDoRetryBackoffMs(0, opts(1))).toBe(100);
    expect(computeDoRetryBackoffMs(2, opts(1))).toBe(400);
  });

  it("grows exponentially across attempts (floor doubles each attempt)", () => {
    const floors = [0, 1, 2, 3].map((attempt) => computeDoRetryBackoffMs(attempt, opts(0)));
    expect(floors).toEqual([50, 100, 200, 400]);
  });

  it("clamps to maxBackoffMs", () => {
    expect(computeDoRetryBackoffMs(20, opts(1))).toBe(5_000);
  });
});
