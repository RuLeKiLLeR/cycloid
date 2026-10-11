import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LazyFactoryResult<T> = {
  factory: () => Promise<{ default: T }>;
};

const reactMocks = vi.hoisted(() => ({
  lazy: vi.fn((factory: () => Promise<{ default: unknown }>) => ({ factory })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    lazy: reactMocks.lazy,
  };
});

describe("lazyWithRetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function importHelper() {
    return import("../../apps/ui/src/lazy-with-retry.js");
  }

  function installWindowForPreloadTest(reloadSpy: ReturnType<typeof vi.fn>) {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(handler);
      },
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      location: {
        href: "https://app.trycycloid.com/sessions/abc",
        origin: "https://app.trycycloid.com",
        reload: reloadSpy,
      },
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    return listeners;
  }

  it("retries once when a stale dynamic import fails and then succeeds", async () => {
    const { lazyWithRetry } = await importHelper();
    const component = () => null;
    const firstError = new Error(
      "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js",
    );
    const load = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce({ default: component });

    const lazyComponent = lazyWithRetry(load) as unknown as LazyFactoryResult<typeof component>;
    const result = lazyComponent.factory();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ default: component });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rethrows the second stale dynamic import failure", async () => {
    const { lazyWithRetry } = await importHelper();
    const firstError = new Error(
      "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js",
    );
    const secondError = new Error(
      "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js",
    );
    const load = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError);

    const lazyComponent = lazyWithRetry(load) as unknown as LazyFactoryResult<() => null>;
    const result = lazyComponent.factory();
    const rejection = expect(result).rejects.toBe(secondError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("cancels pending preload reload before the retry load resolves", async () => {
    const reloadSpy = vi.fn();
    const listeners = installWindowForPreloadTest(reloadSpy);
    const stale = await import("../../apps/ui/src/stale-chunk-reload.js");
    stale.handleStaleChunks();
    for (const handler of listeners["vite:preloadError"] ?? []) {
      handler({
        payload: new Error(
          "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js",
        ),
      });
    }

    const { lazyWithRetry } = await importHelper();
    const component = () => null;
    const firstError = new Error(
      "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js",
    );
    let resolveRetry: (value: { default: typeof component }) => void = () => {
      throw new Error("retry resolver was not initialized");
    };
    const retryPromise = new Promise<{ default: typeof component }>((resolve) => {
      resolveRetry = resolve;
    });
    const load = vi.fn().mockRejectedValueOnce(firstError).mockReturnValueOnce(retryPromise);

    const lazyComponent = lazyWithRetry(load) as unknown as LazyFactoryResult<typeof component>;
    const result = lazyComponent.factory();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(250);

    expect(reloadSpy).not.toHaveBeenCalled();

    resolveRetry({ default: component });
    await expect(result).resolves.toEqual({ default: component });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not retry module evaluation errors", async () => {
    const { lazyWithRetry } = await importHelper();
    const error = new Error("Cannot read properties of undefined");
    const load = vi.fn().mockRejectedValueOnce(error);

    const lazyComponent = lazyWithRetry(load) as unknown as LazyFactoryResult<() => null>;

    await expect(lazyComponent.factory()).rejects.toBe(error);
    expect(load).toHaveBeenCalledOnce();
  });
});
