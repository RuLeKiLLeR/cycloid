/// <reference types="@cloudflare/workers-types" />
/**
 * Tests for the durableStep memoize-on-success helper (ARC-1012).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDurableStep,
  clearDurableStepsByPrefix,
  durableStep,
  hasDurableStep,
} from "../../apps/control-plane-worker/src/session/durable-step";

class FakeStorage {
  readonly map = new Map<string, unknown>();
  putInterceptor: ((key: string, value: unknown) => void) | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (this.putInterceptor) this.putInterceptor(key, value);
    this.map.set(key, value);
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) {
      for (const k of keyOrKeys) this.map.delete(k);
      return true;
    }
    return this.map.delete(keyOrKeys);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) {
      if (!options.prefix || k.startsWith(options.prefix)) {
        out.set(k, v as T);
      }
    }
    return out;
  }
}

// FakeStorage implements the subset of DurableObjectStorage that durableStep
// touches.
function storage(): DurableObjectStorage {
  return new FakeStorage() as unknown as DurableObjectStorage;
}

describe("durableStep", () => {
  let warn: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.fn>;
  let logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: () => void; debug: () => void };

  beforeEach(() => {
    warn = vi.fn();
    info = vi.fn();
    logger = { warn, info, error: () => {}, debug: () => {} };
  });

  it("memoizes on success: second invocation does not re-run fn", async () => {
    const s = storage();
    const fn = vi.fn().mockResolvedValue({ id: "abc" });

    const a = await durableStep(s, "spawn_x", fn);
    const b = await durableStep(s, "spawn_x", fn);

    expect(a).toEqual({ id: "abc" });
    expect(b).toEqual({ id: "abc" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows and does not cache on fn failure", async () => {
    const s = storage();
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(durableStep(s, "spawn_x", fn)).rejects.toThrow("boom");

    const ok = vi.fn().mockResolvedValue("ok");
    await expect(durableStep(s, "spawn_x", ok)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("storage.put throws after fn succeeded: documents the crash window (replay re-runs fn)", async () => {
    const fake = new FakeStorage();
    const s = fake as unknown as DurableObjectStorage;
    fake.putInterceptor = () => {
      throw new Error("storage_put_failed");
    };
    const fn = vi.fn().mockResolvedValue("v1");

    await expect(durableStep(s, "spawn_x", fn)).rejects.toThrow("storage_put_failed");
    expect(fn).toHaveBeenCalledTimes(1);

    // Replay: storage now works; fn must be re-invoked because nothing was cached.
    fake.putInterceptor = null;
    const fn2 = vi.fn().mockResolvedValue("v2");
    await expect(durableStep(s, "spawn_x", fn2)).resolves.toBe("v2");
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("warns when result exceeds 32 KiB", async () => {
    const s = storage();
    const big = "x".repeat(33 * 1024);

    await durableStep(s, "big_step", async () => ({ payload: big }), logger as never);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stepName: "big_step" }),
      "durable_step_oversize_result",
    );
  });

  it("does not warn when result is under 32 KiB", async () => {
    const s = storage();
    await durableStep(s, "small_step", async () => ({ ok: true }), logger as never);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs replay on cache hit", async () => {
    const s = storage();
    await durableStep(s, "replayed_step", async () => "v", logger as never);
    info.mockClear();
    await durableStep(s, "replayed_step", async () => "v", logger as never);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ stepName: "replayed_step", durableStepReplayed: true }),
      "durable_step_replayed",
    );
  });

  it("deduplicates concurrent same-step callers in the same DO instance", async () => {
    const s = storage();
    let resolveFn: ((value: { id: string }) => void) | undefined;
    let signalCalled!: () => void;
    const fnCalled = new Promise<void>((resolve) => {
      signalCalled = resolve;
    });
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveFn = resolve;
          signalCalled();
        }),
    );

    const callA = durableStep(s, "concurrent_step", fn);
    const callB = durableStep(s, "concurrent_step", fn);

    await fnCalled;
    resolveFn?.({ id: "shared" });

    const [a, b] = await Promise.all([callA, callB]);
    expect(a).toEqual({ id: "shared" });
    expect(b).toEqual({ id: "shared" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("warns oversize using UTF-8 byte length, not UTF-16 length", async () => {
    const s = storage();
    // A repeated 4-byte UTF-8 emoji: string.length = 16384 (under 32 KiB),
    // but UTF-8 byte length = 32768 (above 32 KiB warn threshold).
    const emoji = "\u{1F600}"; // 4 bytes in UTF-8, length 2 in UTF-16
    const payload = emoji.repeat(8192);
    expect(payload.length).toBe(16384);
    await durableStep(s, "utf8_step", async () => payload, logger as never);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stepName: "utf8_step", resultSize: expect.any(Number) }),
      "durable_step_oversize_result",
    );
    const call = warn.mock.calls.find(
      (args: unknown[]): args is [Record<string, unknown>, string] =>
        Array.isArray(args) &&
        args[1] === "durable_step_oversize_result" &&
        typeof args[0] === "object" &&
        args[0] !== null &&
        (args[0] as Record<string, unknown>).stepName === "utf8_step",
    );
    expect((call?.[0] as { resultSize: number }).resultSize).toBeGreaterThan(32 * 1024);
  });

  it("isolates steps across storages (multi-DO)", async () => {
    const s1 = storage();
    const s2 = storage();
    const fn1 = vi.fn().mockResolvedValue("a");
    const fn2 = vi.fn().mockResolvedValue("b");

    await durableStep(s1, "shared_name", fn1);
    await durableStep(s2, "shared_name", fn2);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("hasDurableStep reports presence without running or caching fn", async () => {
    const s = storage();
    expect(await hasDurableStep(s, "probe_step")).toBe(false);
    await durableStep(s, "probe_step", async () => ({ v: 1 }));
    expect(await hasDurableStep(s, "probe_step")).toBe(true);
    // Reading presence must not create the step for a different name.
    expect(await hasDurableStep(s, "other_step")).toBe(false);
  });
});

describe("clearDurableStepsByPrefix", () => {
  it("clearDurableStepsByPrefix removes only steps whose name starts with the prefix", async () => {
    const fake = new FakeStorage();
    const s = fake as unknown as DurableObjectStorage;
    await durableStep(s, "spawn_e2b_attempt1_attempt_1", async () => 1);
    await durableStep(s, "spawn_e2b_attempt1_attempt_2", async () => 2);
    await durableStep(s, "spawn_e2b_attempt2_attempt_1", async () => 3);
    await durableStep(s, "create_pr_xyz", async () => 4);

    const removed = await clearDurableStepsByPrefix(s, "spawn_e2b_attempt1_");
    expect(removed).toBe(2);
    expect(fake.map.has("step:spawn_e2b_attempt1_attempt_1")).toBe(false);
    expect(fake.map.has("step:spawn_e2b_attempt1_attempt_2")).toBe(false);
    expect(fake.map.has("step:spawn_e2b_attempt2_attempt_1")).toBe(true);
    expect(fake.map.has("step:create_pr_xyz")).toBe(true);
  });
});

describe("clearDurableStep", () => {
  it("removes exactly one step, leaving sibling steps intact", async () => {
    const fake = new FakeStorage();
    const s = fake as unknown as DurableObjectStorage;
    await durableStep(s, "attempt:bootstrap", async () => "boot");
    await durableStep(s, "attempt:runtime_attached", async () => "claim");
    await durableStep(s, "attempt:bridge_started", async () => "bridge");

    await clearDurableStep(s, "attempt:runtime_attached");

    expect(await hasDurableStep(s, "attempt:runtime_attached")).toBe(false);
    expect(await hasDurableStep(s, "attempt:bootstrap")).toBe(true);
    expect(await hasDurableStep(s, "attempt:bridge_started")).toBe(true);
  });

  it("is a no-op for a step that was never written", async () => {
    const fake = new FakeStorage();
    const s = fake as unknown as DurableObjectStorage;
    await expect(clearDurableStep(s, "attempt:missing")).resolves.toBeUndefined();
  });
});
