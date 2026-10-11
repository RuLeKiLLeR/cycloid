import { describe, expect, it, vi } from "vitest";

import { createSingleFlight } from "../../apps/control-plane-worker/src/single-flight";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  it("collapses concurrent calls with the same key onto one fn invocation", async () => {
    const sf = createSingleFlight<string, number>();
    const d = deferred<number>();
    const fn = vi.fn(() => d.promise);

    const a = sf("k", fn);
    const b = sf("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);

    d.resolve(42);
    await expect(a).resolves.toBe(42);
    await expect(b).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("invokes fn once per distinct key", async () => {
    const sf = createSingleFlight<string, string>();
    const fnA = vi.fn(async () => "a");
    const fnB = vi.fn(async () => "b");

    await expect(sf("a", fnA)).resolves.toBe("a");
    await expect(sf("b", fnB)).resolves.toBe("b");
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it("re-invokes fn on a new call after the prior one settles (no stale retention)", async () => {
    const sf = createSingleFlight<string, number>();
    let n = 0;
    const fn = vi.fn(async () => ++n);

    await expect(sf("k", fn)).resolves.toBe(1);
    await expect(sf("k", fn)).resolves.toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates rejection to all in-flight callers and clears the key for retry", async () => {
    const sf = createSingleFlight<string, number>();
    const d = deferred<number>();
    const failing = vi.fn(() => d.promise);

    const a = sf("k", failing);
    const b = sf("k", failing);
    expect(failing).toHaveBeenCalledTimes(1);

    d.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");

    // Key cleared on settle: a subsequent call retries with a fresh invocation.
    const ok = vi.fn(async () => 7);
    await expect(sf("k", ok)).resolves.toBe(7);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("turns a synchronous throw in fn into a rejected promise and clears the key", async () => {
    const sf = createSingleFlight<string, number>();
    const throwing = vi.fn((): Promise<number> => {
      throw new Error("sync boom");
    });

    // Must not throw synchronously — the wrapper converts it to a rejection.
    const p = sf("k", throwing);
    await expect(p).rejects.toThrow("sync boom");

    // Key cleared: next call retries.
    const ok = vi.fn(async () => 1);
    await expect(sf("k", ok)).resolves.toBe(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
