import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCacheKeys, clearApiCache, dedupe, invalidate, swr } from "../../apps/ui/src/api/cache.js";
import { HOME_SNAPSHOT_KEY_PREFIX } from "../../apps/ui/src/api/home-snapshot.js";

const uiMocks = vi.hoisted(() => ({
  captureUiError: vi.fn(),
}));

vi.mock("../../apps/ui/src/sentry.ts", () => ({
  captureUiError: uiMocks.captureUiError,
}));
vi.mock("../../apps/ui/src/sentry", () => ({
  captureUiError: uiMocks.captureUiError,
}));

function installStorage(): Storage {
  const values = new Map<string, string>();
  const store: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
    }),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
  };
  vi.stubGlobal("localStorage", store);
  return store;
}

beforeEach(() => {
  vi.useRealTimers();
  installStorage();
  clearApiCache();
  uiMocks.captureUiError.mockReset();
});

describe("api cache", () => {
  it("dedupes concurrent calls", async () => {
    const fetcher = vi.fn(async () => "value");

    const [first, second] = await Promise.all([
      swr("key", fetcher, { staleMs: 1000 }),
      swr("key", fetcher, { staleMs: 1000 }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.value).toBe("value");
    expect(second.value).toBe("value");
  });

  it("serves stale values immediately and applies changed revalidation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValueOnce("old").mockResolvedValueOnce("new");

    await swr("key", fetcher, { staleMs: 100 });
    vi.setSystemTime(200);
    const onRevalidate = vi.fn();

    const result = await swr("key", fetcher, { staleMs: 100, onRevalidate });
    await vi.runAllTimersAsync();

    expect(result).toEqual({ value: "old", stale: true, revalidating: true });
    expect(onRevalidate).toHaveBeenCalledWith("new");
  });

  it("suppresses unchanged revalidation when isEqual returns true", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetcher = vi
      .fn<() => Promise<{ count: number }>>()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await swr("key", fetcher, { staleMs: 100 });
    vi.setSystemTime(200);
    const onRevalidate = vi.fn();

    await swr("key", fetcher, {
      staleMs: 100,
      onRevalidate,
      isEqual: (prev, next) => prev.count === next.count,
    });
    await vi.runAllTimersAsync();

    expect(onRevalidate).not.toHaveBeenCalled();
  });

  it("awaits fresh stale data when no revalidation handler exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValueOnce("old").mockResolvedValueOnce("new");

    await swr("key", fetcher, { staleMs: 100 });
    vi.setSystemTime(200);

    await expect(swr("key", fetcher, { staleMs: 100 })).resolves.toEqual({
      value: "new",
      stale: false,
      revalidating: false,
    });
  });

  it("does not call onRevalidate for force fetches awaited by the caller", async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const onRevalidate = vi.fn();

    await swr("key", fetcher, { staleMs: 1000 });
    await expect(swr("key", fetcher, { staleMs: 1000, force: true, onRevalidate })).resolves.toMatchObject({
      value: "new",
    });

    expect(onRevalidate).not.toHaveBeenCalled();
  });

  it("force fetches bypass in-flight dedupe and keep the fresh result authoritative", async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((res) => {
            resolveFirst = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((res) => {
            resolveSecond = res;
          }),
      );

    const first = swr("key", fetcher, { staleMs: 1000 });
    const forced = swr("key", fetcher, { staleMs: 1000, force: true });

    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveSecond("new");
    await expect(forced).resolves.toMatchObject({ value: "new" });

    resolveFirst("old");
    await expect(first).resolves.toMatchObject({ value: "old" });

    await expect(swr("key", fetcher, { staleMs: 1000 })).resolves.toMatchObject({ value: "new" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache an initial failure and allows retry", async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");

    await expect(swr("key", fetcher, { staleMs: 1000 })).rejects.toThrow("boom");
    await expect(swr("key", fetcher, { staleMs: 1000 })).resolves.toMatchObject({ value: "ok" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps stale data and logs rejected background revalidation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockRejectedValueOnce(new Error("nope"));

    await swr("key", fetcher, { staleMs: 100 });
    vi.setSystemTime(200);

    await swr("key", fetcher, { staleMs: 100, onRevalidate: vi.fn() });
    await vi.runAllTimersAsync();

    await vi.waitFor(() => expect(uiMocks.captureUiError).toHaveBeenCalled());
  });

  it("drops in-flight results after invalidate", async () => {
    let resolve!: (value: string) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolve = res;
        }),
    );

    const request = swr("prefix:key", fetcher, { staleMs: 1000 });
    invalidate("prefix:");
    resolve("old");
    await request;
  });

  it("repo list invalidation does not evict repo skills entries", async () => {
    await swr(apiCacheKeys.repoSkills("Owner", "Repo"), async () => ["skill"], {
      staleMs: 1000,
      serveStale: false,
    });

    invalidate(apiCacheKeys.repos());

    const fetcher = vi.fn(async () => ["fresh"]);
    await expect(
      swr(apiCacheKeys.repoSkills("Owner", "Repo"), fetcher, { staleMs: 1000, serveStale: false }),
    ).resolves.toMatchObject({ value: ["skill"] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("purges persisted home snapshots when repo data is invalidated", () => {
    localStorage.setItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`, "snapshot");

    invalidate(apiCacheKeys.repos());

    expect(localStorage.getItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`)).toBeNull();
  });

  it("keeps persisted home snapshots when repo skills data is invalidated", () => {
    localStorage.setItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`, "snapshot");

    invalidate(apiCacheKeys.repoSkills("Owner", "Repo"));

    expect(localStorage.getItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`)).toBe("snapshot");
  });

  it("purges persisted home snapshots when bootstrap data is invalidated", () => {
    localStorage.setItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`, "snapshot");

    invalidate(apiCacheKeys.bootstrap());

    expect(localStorage.getItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`)).toBeNull();
  });

  it("purges persisted home snapshots when the api cache is cleared", () => {
    localStorage.setItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`, "snapshot");

    clearApiCache();

    expect(localStorage.getItem(`${HOME_SNAPSHOT_KEY_PREFIX}user-1`)).toBeNull();
  });

  it("settings invalidation does not evict OpenAI usage entries", async () => {
    await swr(apiCacheKeys.openAiUsage(), async () => ({ totalCostCents: 10 }), {
      staleMs: 1000,
      serveStale: false,
    });

    invalidate(apiCacheKeys.settings());

    const fetcher = vi.fn(async () => ({ totalCostCents: 20 }));
    await expect(swr(apiCacheKeys.openAiUsage(), fetcher, { staleMs: 1000, serveStale: false })).resolves.toMatchObject(
      { value: { totalCostCents: 10 } },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("drops in-flight revalidation callbacks after clearApiCache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolve!: (value: string) => void;
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementationOnce(
        () =>
          new Promise<string>((res) => {
            resolve = res;
          }),
      );

    await swr("key", fetcher, { staleMs: 100 });
    vi.setSystemTime(200);
    const onRevalidate = vi.fn();
    await swr("key", fetcher, { staleMs: 100, onRevalidate });
    clearApiCache();
    resolve("new");
    await vi.runAllTimersAsync();

    expect(onRevalidate).not.toHaveBeenCalled();
  });

  it("dedupe is independent of caller abort state", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return "ok";
    });

    const [first, second] = await Promise.all([dedupe("key", fetcher), dedupe("key", fetcher)]);

    expect(first).toBe("ok");
    expect(second).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
