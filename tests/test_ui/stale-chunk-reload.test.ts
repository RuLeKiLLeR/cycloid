import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  captureUiError: vi.fn(),
}));

vi.mock("../../apps/ui/src/sentry", () => sentryMocks);
vi.mock("../../apps/ui/src/sentry.ts", () => sentryMocks);
vi.mock("../../apps/ui/src/sentry.js", () => sentryMocks);

describe("stale-chunk-reload", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let dispatchSpy: ReturnType<typeof vi.fn>;
  let listeners: Record<string, ((event: unknown) => void)[]>;
  let store: Record<string, string>;
  let locationState: {
    href: string;
    origin: string;
    pathname: string;
    search: string;
    reload: ReturnType<typeof vi.fn>;
  };

  function installWindowGlobals() {
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(handler);
      },
      removeEventListener: vi.fn(),
      dispatchEvent: dispatchSpy,
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      history: {
        state: null,
        replaceState: vi.fn(),
      },
      location: locationState,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T12:00:00.000Z"));
    vi.clearAllMocks();

    listeners = {};
    store = {};
    reloadSpy = vi.fn();
    dispatchSpy = vi.fn();
    locationState = {
      href: "https://app.trycycloid.com/sessions/abc",
      origin: "https://app.trycycloid.com",
      pathname: "/sessions/abc",
      search: "",
      reload: reloadSpy,
    };

    installWindowGlobals();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("performance", {
      now: () => 4242.4,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup() {
    const mod = await import("../../apps/ui/src/stale-chunk-reload.js");
    mod.handleStaleChunks();
    return mod;
  }

  function fireUnhandledRejection(reason: unknown) {
    for (const handler of listeners.unhandledrejection ?? []) {
      handler({ reason });
    }
  }

  function fireResourceError(target: unknown) {
    for (const handler of listeners.error ?? []) {
      handler({ target });
    }
  }

  function firePreloadError(payload: unknown) {
    for (const handler of listeners["vite:preloadError"] ?? []) {
      handler({ payload });
    }
  }

  function blockSessionStorage() {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("sessionStorage blocked");
      },
    });
  }

  const dynamicImportErrors = [
    {
      browser: "Chrome",
      message: "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/chunk-abc123.js",
    },
    {
      browser: "Firefox",
      message: "error loading dynamically imported module",
    },
    {
      browser: "Safari",
      message: "Importing a module script failed",
    },
  ];

  for (const { browser, message } of dynamicImportErrors) {
    it(`identifies ${browser} dynamic import errors`, async () => {
      const mod = await setup();
      expect(mod.isDynamicImportError(new Error(message))).toBe(true);
    });
  }

  it("ignores unrelated errors", async () => {
    const mod = await setup();
    expect(mod.isDynamicImportError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  // Regression (ARC-1541): Safari/WebKit rejects ALL network failures - including
  // normal fetch() calls - with "Load failed", so it must NOT be treated as a stale
  // dynamic import, or every Safari/iOS API blip triggers a spurious page reload.
  it("does not treat Safari's generic 'Load failed' as a dynamic import error", async () => {
    const mod = await setup();
    expect(mod.isDynamicImportError(new Error("Load failed"))).toBe(false);
    expect(mod.isDynamicImportError(new TypeError("Load failed"))).toBe(false);
  });

  it("does not reload when a Safari fetch failure surfaces as an unhandled rejection", async () => {
    await setup();

    fireUnhandledRejection(new TypeError("Load failed"));

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("reloads on dynamic import errors with a sanitized asset URL", async () => {
    await setup();
    fireUnhandledRejection(
      new Error(
        "Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/MarkdownContent-CBW32y9U.js?x=1",
      ),
    );

    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(store["stale-chunk-reload-pending"] ?? "{}")).toEqual(
      expect.objectContaining({
        assetUrl: "/assets/MarkdownContent-CBW32y9U.js",
        attempt: 1,
        uaSummary: "Chromium/123",
      }),
    );
  });

  it("reloads on stale stylesheet and script 404s", async () => {
    await setup();

    fireResourceError({
      tagName: "LINK",
      href: "https://app.trycycloid.com/assets/index-old.css",
    });
    expect(reloadSpy).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    fireResourceError({
      tagName: "SCRIPT",
      src: "https://app.trycycloid.com/assets/index-old.js",
    });
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores non-first-party asset load errors", async () => {
    await setup();

    fireResourceError({
      tagName: "IMG",
      src: "https://app.trycycloid.com/favicon-32.png",
    });
    fireResourceError({
      tagName: "LINK",
      href: "https://cdn.example.com/assets/index-old.css",
    });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("defers vite preload reloads so lazyWithRetry can cancel them", async () => {
    const mod = await setup();

    firePreloadError(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-abc.js"),
    );
    vi.advanceTimersByTime(500);
    expect(reloadSpy).not.toHaveBeenCalled();

    mod.clearPendingPreloadReload();
    vi.advanceTimersByTime(250);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("runs delayed vite preload reloads when no retry recovers", async () => {
    await setup();

    firePreloadError(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-abc.js"),
    );
    vi.advanceTimersByTime(750);

    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("flushes pending reload telemetry with sanitized tags", async () => {
    const mod = await setup();
    store["stale-chunk-reload-pending"] = JSON.stringify({
      assetUrl: "https://app.trycycloid.com/assets/MarkdownContent-CBW32y9U.js?token=secret",
      attempt: 2,
      uaSummary: "Chromium/123",
      pageSinceMs: 42,
      reloadAtMs: 100,
    });

    mod.flushPendingReloadTelemetry();
    await vi.dynamicImportSettled();

    expect(store["stale-chunk-reload-pending"]).toBeUndefined();
    expect(sentryMocks.captureUiError).toHaveBeenCalledWith(expect.any(Error), {
      assetUrl: "/assets/MarkdownContent-CBW32y9U.js",
      attempt: "2",
      uaSummary: "Chromium/123",
    });
  });

  it("flushPendingReloadTelemetry no-ops without pending payload", async () => {
    const mod = await setup();

    mod.flushPendingReloadTelemetry();
    await vi.dynamicImportSettled();

    expect(sentryMocks.captureUiError).not.toHaveBeenCalled();
  });

  it("persists guard state across reload attempts in sessionStorage", async () => {
    await setup();

    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(store["stale-chunk-reload-ts"]).toBe(String(Date.now()));
    expect(store["stale-chunk-reload-count"]).toBe("1");

    vi.advanceTimersByTime(60_000);
    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );
    expect(reloadSpy).toHaveBeenCalledTimes(2);
    expect(store["stale-chunk-reload-ts"]).toBe(String(Date.now()));
    expect(store["stale-chunk-reload-count"]).toBe("2");
  });

  it("dispatches unrecoverable after the third bounded reload attempt", async () => {
    await setup();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fireUnhandledRejection(
        new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
      );
      expect(store["stale-chunk-reload-count"]).toBe(String(attempt));
      vi.advanceTimersByTime(60_000);
    }

    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );
    expect(reloadSpy).toHaveBeenCalledTimes(3);
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it("increments the reload counter after the cooldown window elapses", async () => {
    await setup();

    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );
    expect(store["stale-chunk-reload-count"]).toBe("1");

    vi.advanceTimersByTime(60_000);
    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );
    expect(reloadSpy).toHaveBeenCalledTimes(2);
    expect(store["stale-chunk-reload-count"]).toBe("2");
  });

  it("surfaces manual recovery when sessionStorage is unavailable", async () => {
    blockSessionStorage();

    await setup();

    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it("clearReloadGuard removes sessionStorage guard state", async () => {
    const mod = await setup();
    store["stale-chunk-reload-ts"] = "123";
    store["stale-chunk-reload-count"] = "2";

    mod.clearReloadGuard();

    expect(store["stale-chunk-reload-ts"]).toBeUndefined();
    expect(store["stale-chunk-reload-count"]).toBeUndefined();
  });

  it("ignores stale URL fallback state", async () => {
    await setup();
    locationState.href = "https://app.trycycloid.com/sessions/abc?__arcStaleChunkTs=123&__arcStaleChunkCount=3&foo=bar";
    locationState.search = "?__arcStaleChunkTs=123&__arcStaleChunkCount=3&foo=bar";

    fireUnhandledRejection(
      new Error("Failed to fetch dynamically imported module: https://app.trycycloid.com/assets/Page-old.js"),
    );

    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
