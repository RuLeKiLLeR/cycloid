import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Safety net: restore the console spy (and any other spy) even if a test throws
// before its inline mockRestore, so it can't leak into later tests.
afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
}));

describe("control-plane logger auto-capture to sentry", () => {
  let createLogger: typeof import("../../apps/control-plane-worker/src/logger.js").createLogger;
  let setLoggerErrorHandler: typeof import("../../apps/control-plane-worker/src/logger.js").setLoggerErrorHandler;
  const mockHandler = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("../../apps/control-plane-worker/src/logger.js");
    createLogger = mod.createLogger;
    setLoggerErrorHandler = mod.setLoggerErrorHandler;
    setLoggerErrorHandler(mockHandler);
  });

  it("auto-captures error-level logs via error handler", () => {
    const log = createLogger();
    log.error({ error: "db connection lost" }, "Database error");
    expect(mockHandler).toHaveBeenCalledOnce();
    const capturedErr = mockHandler.mock.calls[0][0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedErr.message).toBe("db connection lost");
  });

  it("auto-captures warn-level logs with error field", () => {
    const log = createLogger();
    log.warn({ error: "token expired" }, "Auth refresh failed");
    expect(mockHandler).toHaveBeenCalledOnce();
  });

  it("does NOT capture warn-level logs without error field", () => {
    const log = createLogger();
    log.warn({}, "Informational warning");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("does NOT capture info or debug-level logs", () => {
    const log = createLogger();
    log.info({ error: "not relevant" }, "Info message");
    log.debug({ error: "not relevant" }, "Debug message");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("preserves Error instances from the error field", () => {
    const log = createLogger();
    const original = new Error("original");
    log.error({ error: original }, "Caught error");
    expect(mockHandler.mock.calls[0][0]).toBe(original);
  });

  it("surfaces AggregateError sub-error messages through the production redactor", () => {
    const log = createLogger();
    // Shape produced by serializeError() for an AggregateError: empty own message,
    // real failures in `errors`. The full-entry redactor would otherwise truncate
    // these sub-errors to `{ _truncated: true }` before they reach the handler.
    log.error(
      {
        error: {
          name: "AggregateError",
          message: "",
          type: "AggregateError",
          errors: [
            { name: "TypeError", message: "fetch failed" },
            { name: "Error", message: "connection reset" },
          ],
        },
      },
      "Outbound request failed",
    );
    expect(mockHandler).toHaveBeenCalledOnce();
    const capturedErr = mockHandler.mock.calls[0][0];
    expect(capturedErr.name).toBe("AggregateError");
    expect(capturedErr.message).not.toBe("");
    expect(capturedErr.message).toContain("fetch failed");
    expect(capturedErr.message).toContain("connection reset");
  });

  it("still redacts secrets in AggregateError sub-errors on the standalone path", () => {
    const log = createLogger();
    log.error(
      {
        error: {
          name: "AggregateError",
          message: "",
          type: "AggregateError",
          errors: [{ name: "Error", message: "auth failed for ghp_0123456789abcdefghijABCDEF" }],
        },
      },
      "Outbound request failed",
    );
    const capturedErr = mockHandler.mock.calls[0][0];
    expect(capturedErr.message).not.toContain("ghp_0123456789abcdefghijABCDEF");
    expect(capturedErr.message).toContain("[REDACTED]");
  });

  it("includes bindings as context tags", () => {
    const log = createLogger({ bindings: { component: "webhook" } });
    log.error({ error: "fail" }, "Handler error");
    const tags = mockHandler.mock.calls[0][1];
    expect(tags.component).toBe("webhook");
    expect(tags.operation).toBe("Handler error");
  });

  it("child logger inherits bindings for context tags", () => {
    const log = createLogger({ bindings: { component: "session" } });
    const child = log.child({ sessionId: "sess-1" });
    child.error({ error: "timeout" }, "Session timeout");
    const tags = mockHandler.mock.calls[0][1];
    expect(tags.component).toBe("session");
    expect(tags.sessionId).toBe("sess-1");
  });

  it("attaches current span correlation identifiers to structured output when available", async () => {
    vi.resetModules();
    vi.doMock("../../apps/control-plane-worker/src/observability/context.js", () => ({
      currentContext: () => ({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        isExporterContext: false,
        attributes: {
          "session.id": "sess-1",
          "prompt.id": "p-1",
          "sandbox.id": "sb-1",
        },
        pendingSpans: [],
      }),
    }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("../../apps/control-plane-worker/src/logger.js");
    const log = mod.createLogger();
    log.info({}, "Correlation emitted");

    const entry = JSON.parse(String(consoleSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      "dd.trace_id": "a".repeat(32),
      "dd.span_id": "b".repeat(16),
      correlationTraceId: "a".repeat(32),
      correlationSpanId: "b".repeat(16),
      correlationParentSpanId: "c".repeat(16),
      sessionId: "sess-1",
      promptId: "p-1",
      sandboxId: "sb-1",
    });
    consoleSpy.mockRestore();
  });

  it("passes current correlation identifiers through the logger error handler context", async () => {
    vi.resetModules();
    vi.doMock("../../apps/control-plane-worker/src/observability/context.js", () => ({
      currentContext: () => ({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        isExporterContext: false,
        attributes: {
          "session.id": "sess-1",
          "prompt.id": "p-1",
          "sandbox.id": "sb-1",
        },
        pendingSpans: [],
      }),
    }));

    const mod = await import("../../apps/control-plane-worker/src/logger.js");
    mod.setLoggerErrorHandler(mockHandler);
    const log = mod.createLogger({ bindings: { component: "queue", requestId: "req-1" } });

    log.error({ error: "prompt failed" }, "Queue publish failed");

    expect(mockHandler).toHaveBeenCalledOnce();
    expect(mockHandler.mock.calls[0][1]).toMatchObject({
      component: "queue",
      requestId: "req-1",
      operation: "Queue publish failed",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      sessionId: "sess-1",
      promptId: "p-1",
      sandboxId: "sb-1",
    });
  });

  it("no-ops when no error handler is registered", async () => {
    vi.resetModules();
    const mod = await import("../../apps/control-plane-worker/src/logger.js");
    const log = mod.createLogger();
    // No setLoggerErrorHandler call -- should not throw
    log.error({ error: "should be silent" }, "No handler");
    expect(mockHandler).not.toHaveBeenCalled();
  });
});
