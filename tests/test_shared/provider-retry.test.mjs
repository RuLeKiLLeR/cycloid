import { describe, expect, it, vi } from "vitest";

import { getProviderRetryAttemptCount, isTransientProviderError, withProviderRetry } from "../../shared/llm/retry.mjs";

describe("provider retry helper", () => {
  it("retries transient provider errors and honors retry-after-ms", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const op = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after-ms": "800" }) }),
      )
      .mockResolvedValueOnce("ok");

    await expect(
      withProviderRetry({
        maxAttempts: 3,
        op,
        sleep,
        random: () => 0.5,
      }),
    ).resolves.toEqual({ value: "ok", attempts: 2 });

    expect(op).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(800, expect.any(AbortSignal));
  });

  it("does not retry non-transient provider errors", async () => {
    const error = Object.assign(new Error("bad request"), { status: 400 });
    const op = vi.fn().mockRejectedValue(error);

    await expect(withProviderRetry({ maxAttempts: 3, op, sleep: vi.fn() })).rejects.toBe(error);

    expect(op).toHaveBeenCalledTimes(1);
    expect(getProviderRetryAttemptCount(error, 0)).toBe(1);
  });

  it("records final attempt count after retry exhaustion", async () => {
    const error = Object.assign(new Error("unavailable"), { status: 503 });
    const op = vi.fn().mockRejectedValue(error);

    await expect(withProviderRetry({ maxAttempts: 3, op, sleep: vi.fn(), random: () => 0.5 })).rejects.toBe(error);

    expect(op).toHaveBeenCalledTimes(3);
    expect(getProviderRetryAttemptCount(error, 0)).toBe(3);
  });

  it("invokes onRetry before each sleep with the upcoming attempt details", async () => {
    const calls = [];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = Object.assign(new Error("unavailable"), { status: 503 });
    const op = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValueOnce("ok");

    await expect(
      withProviderRetry({
        maxAttempts: 3,
        op,
        sleep,
        random: () => 0.5,
        onRetry: (info) => calls.push(info),
      }),
    ).resolves.toEqual({ value: "ok", attempts: 3 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ attempt: 2, maxAttempts: 3, error });
    expect(calls[1]).toMatchObject({ attempt: 3, maxAttempts: 3, error });
    expect(calls[0].delayMs).toBeGreaterThan(0);
  });

  it("does not invoke onRetry when the first attempt succeeds", async () => {
    const onRetry = vi.fn();
    await withProviderRetry({ maxAttempts: 3, op: vi.fn().mockResolvedValue("ok"), sleep: vi.fn(), onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("fires onRetry for each retry up to exhaustion and never on the terminal failure", async () => {
    const onRetry = vi.fn();
    const error = Object.assign(new Error("unavailable"), { status: 503 });
    const op = vi.fn().mockRejectedValue(error);

    await expect(withProviderRetry({ maxAttempts: 3, op, sleep: vi.fn(), random: () => 0.5, onRetry })).rejects.toBe(
      error,
    );

    // 3 attempts → 2 retries scheduled; the final exhausted attempt does not retry.
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("swallows onRetry callback errors so the retry loop still proceeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const op = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }))
      .mockResolvedValueOnce("ok");

    await expect(
      withProviderRetry({
        maxAttempts: 3,
        op,
        sleep,
        random: () => 0.5,
        onRetry: () => {
          throw new Error("callback boom");
        },
      }),
    ).resolves.toEqual({ value: "ok", attempts: 2 });
  });

  it("treats fetch network failures and retryable status codes as transient", () => {
    expect(isTransientProviderError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("conflict"), { status: 409 }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false);
  });
});
