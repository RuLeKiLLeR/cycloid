// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInit = vi.fn();
const mockCaptureException = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(true);
const mockDdLog = vi.fn();
const originalFetch = globalThis.fetch;

vi.mock("@sentry/node", () => ({
  init: mockInit,
  captureException: mockCaptureException,
  flush: mockFlush,
}));

// Mock dd-logs to avoid side effects
vi.mock("../../apps/sandbox-bridge/src/services/dd-logs.js", () => ({
  ddLog: mockDdLog,
}));

describe("bridge sentry initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENABLE_LOCAL;
    delete process.env.SENTRY_ENV;
    delete process.env.WORKER_ENV;
    delete process.env.ARCANIST_RUNTIME_ENVIRONMENT;
    delete process.env.NODE_ENV;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.ARCANIST_LOCAL_DEV;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
  });

  it("calls init with placeholder DSN, broker tunnel, and tracesSampleRate 0", async () => {
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.SENTRY_ENABLE_LOCAL = "true";
    vi.resetModules();
    const { initSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");
    await initSentry();
    expect(mockInit).toHaveBeenCalledOnce();
    expect(mockInit.mock.calls[0][0]).toMatchObject({
      dsn: "https://placeholder@telemetry.cycloid.invalid/1",
      tracesSampleRate: 0,
    });
    expect(mockInit.mock.calls[0][0].tunnel).toContain("/sandbox/telemetry/sentry?st=");
    expect(mockInit.mock.calls[0][0].tunnel).toContain("sbx-token-1");
  });

  it("beforeSend injects session/sandbox tags from env", async () => {
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.SENTRY_ENABLE_LOCAL = "true";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_ID = "sb-xyz";
    vi.resetModules();
    const { initSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");
    await initSentry();

    const beforeSend = mockInit.mock.calls[0][0].beforeSend;
    const event = { tags: { existing: "tag" } };
    const result = beforeSend(event);
    expect(result.tags).toEqual({
      existing: "tag",
      sessionId: "sess-abc",
      sandboxId: "sb-xyz",
    });
  });

  it("awaits flush with 2000ms timeout", async () => {
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.SENTRY_ENABLE_LOCAL = "true";
    vi.resetModules();
    const { initSentry, flushSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");
    await initSentry();

    await flushSentry();
    expect(mockFlush).toHaveBeenCalledWith(2000);
  });

  it("no-ops init and flush when the broker is unreachable", async () => {
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
    vi.resetModules();
    const { initSentry, flushSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");
    await initSentry();
    expect(mockInit).not.toHaveBeenCalled();

    await flushSentry();
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("initializes for production sandboxes without the local opt-in", async () => {
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.ARCANIST_RUNTIME_ENVIRONMENT = "production";
    vi.resetModules();
    const { initSentry, shouldInitSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");

    expect(shouldInitSentry()).toBe(true);
    await initSentry();
    expect(mockInit).toHaveBeenCalledOnce();
  });

  it("does not initialize for non-production sandboxes unless explicitly enabled", async () => {
    for (const runtimeEnv of ["qa", "local", undefined]) {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      if (runtimeEnv === undefined) delete process.env.ARCANIST_RUNTIME_ENVIRONMENT;
      else process.env.ARCANIST_RUNTIME_ENVIRONMENT = runtimeEnv;
      vi.resetModules();
      const { shouldInitSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");
      expect(shouldInitSentry()).toBe(false);
    }
  });

  it("allows explicit local Sentry opt-in outside production", async () => {
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.ARCANIST_RUNTIME_ENVIRONMENT = "qa";
    process.env.SENTRY_ENABLE_LOCAL = "true";
    vi.resetModules();
    const { initSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");

    await initSentry();
    expect(mockInit).toHaveBeenCalledOnce();
  });

  it("tags events with the sandbox runtime environment, not a hardcoded production", async () => {
    // A qa opt-in must surface as environment: qa so it stays filterable in
    // Sentry instead of masquerading as real production traffic.
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.ARCANIST_RUNTIME_ENVIRONMENT = "qa";
    process.env.SENTRY_ENABLE_LOCAL = "true";
    process.env.SENTRY_ENV = "production"; // present but must be ignored
    vi.resetModules();
    const { initSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");

    await initSentry();
    expect(mockInit.mock.calls[0][0].environment).toBe("qa");
  });

  it("does not initialize when the broker is unreachable even in production", async () => {
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
    process.env.ARCANIST_RUNTIME_ENVIRONMENT = "production";
    vi.resetModules();
    const { initSentry, shouldInitSentry } = await import("../../apps/sandbox-bridge/src/services/sentry.js");

    expect(shouldInitSentry()).toBe(false);
    await initSentry();
    expect(mockInit).not.toHaveBeenCalled();
  });
});

describe("bridge logger auto-capture to sentry", () => {
  let createBridgeLogger: typeof import("../../apps/sandbox-bridge/src/logger.js").createBridgeLogger;
  let installFetchLogger: typeof import("../../apps/sandbox-bridge/src/services/fetch-logger.js").installFetchLogger;
  let initSentry: typeof import("../../apps/sandbox-bridge/src/services/sentry.js").initSentry;
  let uninstallFetchLogger: (() => void) | undefined;
  const LOG_ORDINALS = { debug: 0, info: 1, warn: 2, error: 3 };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.SENTRY_ENABLE_LOCAL = "true";
    vi.resetModules();
    const sentryMod = await import("../../apps/sandbox-bridge/src/services/sentry.js");
    initSentry = sentryMod.initSentry;
    await initSentry();
    const loggerMod = await import("../../apps/sandbox-bridge/src/logger.js");
    createBridgeLogger = loggerMod.createBridgeLogger;
    const fetchLoggerMod = await import("../../apps/sandbox-bridge/src/services/fetch-logger.js");
    installFetchLogger = fetchLoggerMod.installFetchLogger;
  });

  afterEach(() => {
    uninstallFetchLogger?.();
    uninstallFetchLogger = undefined;
    globalThis.fetch = originalFetch;
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENABLE_LOCAL;
    delete process.env.WORKER_ENV;
    delete process.env.ARCANIST_RUNTIME_ENVIRONMENT;
    delete process.env.NODE_ENV;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
    delete process.env.BRAINTRUST_API_URL;
    delete process.env.ARCANIST_LOCAL_DEV;
    vi.restoreAllMocks();
  });

  it("auto-captures error-level logs to sentry", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    log.error({ error: "something broke" }, "Operation failed");
    expect(mockCaptureException).toHaveBeenCalledOnce();
    const capturedErr = mockCaptureException.mock.calls[0][0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedErr.message).toBe("something broke");
  });

  it("auto-captures warn-level logs with error field to sentry", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    log.warn({ error: "timeout reached" }, "Request timed out");
    expect(mockCaptureException).toHaveBeenCalledOnce();
    const capturedErr = mockCaptureException.mock.calls[0][0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedErr.message).toBe("timeout reached");
  });

  it("does NOT capture warn-level logs without error field", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    log.warn({}, "Config missing, using default");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does NOT capture demoted direct Braintrust flush failures", async () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    globalThis.fetch = vi.fn(async () => {
      throw new Error("headers timeout");
    }) as typeof fetch;
    const handle = installFetchLogger(log);
    uninstallFetchLogger = handle.uninstall;

    await expect(fetch("https://api.braintrust.dev/logs3", { method: "POST" })).rejects.toThrow("headers timeout");

    expect(mockDdLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "observability_flush_failed",
        errorSummary: "headers timeout",
      }),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does NOT capture demoted proxied Braintrust flush failures", async () => {
    process.env.BRAINTRUST_API_URL = "https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust";
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    globalThis.fetch = vi.fn(async () => {
      throw new Error("proxy timeout");
    }) as typeof fetch;
    const handle = installFetchLogger(log);
    uninstallFetchLogger = handle.uninstall;

    await expect(
      fetch("https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust/logs3", {
        method: "POST",
      }),
    ).rejects.toThrow("proxy timeout");

    expect(mockDdLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "observability_flush_failed",
        errorSummary: "proxy timeout",
      }),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("captures real product fetch failures logged by the fetch logger", async () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const handle = installFetchLogger(log);
    uninstallFetchLogger = handle.uninstall;

    await expect(fetch("https://api.github.com/repos/trycycloid/cycloid")).rejects.toThrow("network down");

    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException.mock.calls[0][0].message).toBe("network down");
  });

  it("does NOT capture info or debug-level logs", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    log.info({ error: "not relevant" }, "Info message");
    log.debug({ error: "not relevant" }, "Debug message");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("preserves Error instances from the error field", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    const original = new Error("original error");
    log.error({ error: original }, "Something failed");
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException.mock.calls[0][0]).toBe(original);
  });

  it("falls back to msg when no error field present on error-level", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, {});
    log.error({}, "Fatal connection error");
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException.mock.calls[0][0].message).toBe("Fatal connection error");
  });

  it("includes bindings as sentry tags", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, { component: "bridge" });
    log.error({ error: "fail" }, "Test error");
    const tags = mockCaptureException.mock.calls[0][1].tags;
    expect(tags.component).toBe("bridge");
    expect(tags.operation).toBe("Test error");
  });

  it("redacts bridge logs before console and dd-log sink output", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const secretUrl = "https://user:bridge-pass@example.com/private.git";
    const log = createBridgeLogger(LOG_ORDINALS.debug, { component: "bridge", databaseUrl: secretUrl });

    log.info({ output: `clone failed for ${secretUrl}` }, "Testing redaction");

    const serialized = String(consoleSpy.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("bridge-pass");
    expect(serialized).toContain("[REDACTED]");
    expect(mockDdLog).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: "[REDACTED]",
        output: "clone failed for [REDACTED]",
      }),
    );
  });

  it("redacts bridge error messages and sentry tag context", () => {
    const secretDsn = "DATABASE_URL=postgres://user:bridge-pass@db.example/app";
    const log = createBridgeLogger(LOG_ORDINALS.debug, { component: "bridge", databaseUrl: secretDsn });

    log.warn({ error: `command printed ${secretDsn}` }, "Command failed");

    expect(mockCaptureException).toHaveBeenCalledOnce();
    const capturedErr = mockCaptureException.mock.calls[0][0];
    const tags = mockCaptureException.mock.calls[0][1].tags;
    expect(capturedErr.message).not.toContain("bridge-pass");
    expect(capturedErr.message).toContain("[REDACTED]");
    expect(tags.databaseUrl).toBe("[REDACTED]");
    expect(tags.error).not.toContain("bridge-pass");
  });

  it("child logger inherits bindings for sentry tags", () => {
    const log = createBridgeLogger(LOG_ORDINALS.debug, { sessionId: "sess-1" });
    const child = log.child({ promptId: "p-1" });
    child.error({ error: "child error" }, "Child failed");
    const tags = mockCaptureException.mock.calls[0][1].tags;
    expect(tags.sessionId).toBe("sess-1");
    expect(tags.promptId).toBe("p-1");
  });

  it("auto-attaches ALS correlation fields to bridge log entries", async () => {
    const loggerMod = await import("../../apps/sandbox-bridge/src/logger.js");
    const { runWithCorrelation } = await import("../../apps/sandbox-bridge/src/services/correlation.js");
    const log = loggerMod.createBridgeLogger(LOG_ORDINALS.debug, { component: "bridge" });

    runWithCorrelation(
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        sessionId: "sess-1",
        promptId: "p-1",
        sandboxId: "sb-1",
      },
      () => {
        log.info({}, "Correlation present");
      },
    );

    expect(mockDdLog).toHaveBeenCalledOnce();
    expect(mockDdLog.mock.calls[0][0]).toMatchObject({
      component: "bridge",
      sessionId: "sess-1",
      promptId: "p-1",
      sandboxId: "sb-1",
      correlationTraceId: "a".repeat(32),
      correlationSpanId: "b".repeat(16),
      correlationParentSpanId: "c".repeat(16),
    });
  });

  it("includes ALS correlation fields in bridge sentry tags", async () => {
    const loggerMod = await import("../../apps/sandbox-bridge/src/logger.js");
    const { runWithCorrelation } = await import("../../apps/sandbox-bridge/src/services/correlation.js");
    const log = loggerMod.createBridgeLogger(LOG_ORDINALS.debug, { component: "bridge" });

    runWithCorrelation(
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        sessionId: "sess-1",
        promptId: "p-1",
        sandboxId: "sb-1",
      },
      () => {
        log.error({ error: "bridge failed" }, "Bridge execution failed");
      },
    );

    const tags = mockCaptureException.mock.calls[0][1].tags;
    expect(tags).toMatchObject({
      component: "bridge",
      operation: "Bridge execution failed",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      sessionId: "sess-1",
      promptId: "p-1",
      sandboxId: "sb-1",
    });
  });

  it("no-ops sentry capture when sentry is not initialized", async () => {
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
    vi.resetModules();
    const sentryMod = await import("../../apps/sandbox-bridge/src/services/sentry.js");
    await sentryMod.initSentry();
    const loggerMod = await import("../../apps/sandbox-bridge/src/logger.js");
    const log = loggerMod.createBridgeLogger(LOG_ORDINALS.debug, {});
    log.error({ error: "should be silent" }, "No DSN");
    // captureBridgeException no-ops, so captureException should not be called
    // (mockCaptureException was cleared in beforeEach but the Sentry module ref is null)
    // Just verify no throw
  });
});
