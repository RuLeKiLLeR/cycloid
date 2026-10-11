import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  browserTracingIntegration: vi.fn(() => "browser-tracing"),
  replayIntegration: vi.fn(() => "replay"),
}));

vi.mock("@sentry/react", () => sentryMocks);

describe("sentry module exports", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("exports all expected functions", async () => {
    const mod = await import("../../apps/ui/src/sentry.js");
    expect(typeof mod.initSentry).toBe("function");
    expect(typeof mod.setSentryUser).toBe("function");
    expect(typeof mod.clearSentryUser).toBe("function");
    expect(typeof mod.captureUiError).toBe("function");
  });

  it("captureUiError no-ops before init", async () => {
    const mod = await import("../../apps/ui/src/sentry.js");
    // Should not throw when called before init
    expect(() => mod.captureUiError(new Error("test"))).not.toThrow();
    expect(() => mod.captureUiError(new Error("test"), { op: "foo" })).not.toThrow();
  });

  it("setSentryUser no-ops before init", async () => {
    const mod = await import("../../apps/ui/src/sentry.js");
    expect(() => mod.setSentryUser({ id: 1, name: "test" })).not.toThrow();
  });

  it("clearSentryUser no-ops before init", async () => {
    const mod = await import("../../apps/ui/src/sentry.js");
    expect(() => mod.clearSentryUser()).not.toThrow();
  });

  it("initializes Sentry and replays queued operations after the lazy import resolves", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_ENV", "production");
    const mod = await import("../../apps/ui/src/sentry.js");

    mod.setSentryUser({ id: 1, name: "test-user" });
    mod.captureUiError(new Error("boom"), { op: "save" });
    mod.clearSentryUser();

    await mod.initSentry();

    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: ["browser-tracing", "replay"],
      }),
    );
    expect(sentryMocks.browserTracingIntegration).toHaveBeenCalled();
    expect(sentryMocks.replayIntegration).toHaveBeenCalled();
    expect(sentryMocks.setUser).toHaveBeenNthCalledWith(1, {
      id: "1",
      username: "test-user",
    });
    expect(sentryMocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { op: "save" },
    });
    expect(sentryMocks.setUser).toHaveBeenNthCalledWith(2, null);
  });

  it("does not initialize Sentry outside production unless explicitly enabled", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_ENV", "qa");
    const mod = await import("../../apps/ui/src/sentry.js");

    await mod.initSentry();
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry locally only with the explicit opt-in flag", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_ENABLE_LOCAL", "true");
    const mod = await import("../../apps/ui/src/sentry.js");

    await mod.initSentry();
    expect(sentryMocks.init).toHaveBeenCalled();
  });
});
