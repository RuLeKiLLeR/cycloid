import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  correlationLogFields,
  createLogger,
  LOG_CORRELATION_FIELD_NAMES,
  LOG_LEVEL_ORDINALS,
  LOG_PARENT_SPAN_FIELD_NAME,
  LOG_TRACE_FIELD_NAMES,
  phaseLogFields,
  setLoggerErrorHandler,
  traceLogFields,
} from "../../shared/observability/logger.js";

describe("shared logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setLoggerErrorHandler(null);
  });

  it("attaches trace and correlation fields before allowing bindings and payload overrides", () => {
    const sink = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test", sessionId: "binding-session" },
      traceProvider: () => ({ traceId: "trace-123", spanId: "span-456" }),
      correlationProvider: () => ({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        sessionId: "session-1",
        promptId: "prompt-1",
        sandboxId: "sb-1",
      }),
      entrySink: sink,
    });

    log.info({ promptId: "prompt-override" }, "Hello logger");

    const serialized = consoleSpy.mock.calls[0]?.[0];
    expect(typeof serialized).toBe("string");

    const entry = JSON.parse(String(serialized)) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      msg: "Hello logger",
      component: "shared-test",
      "dd.trace_id": "trace-123",
      "dd.span_id": "span-456",
      correlationTraceId: "a".repeat(32),
      correlationSpanId: "b".repeat(16),
      correlationParentSpanId: "c".repeat(16),
      sessionId: "binding-session",
      promptId: "prompt-override",
      sandboxId: "sb-1",
    });
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(entry);
  });

  it("uses the shared error handler for error-level logs", () => {
    const handler = vi.fn();
    setLoggerErrorHandler(handler);

    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test", attempt: 3 },
    });

    log.error({ error: "boom" }, "Exploded");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(handler.mock.calls[0]?.[0]?.message).toBe("boom");
    expect(handler.mock.calls[0]?.[1]).toEqual({
      operation: "Exploded",
      component: "shared-test",
      attempt: "3",
      error: "boom",
    });
  });

  it("applies entry redaction before console, sink, and error handler context", () => {
    const sink = vi.fn();
    const handler = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rawSecret = "raw-secret-value";

    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test", apiKey: rawSecret },
      entrySink: sink,
      errorHandler: handler,
      entryRedactor: (entry) => {
        const redacted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(entry)) {
          redacted[key] = value === rawSecret ? "[REDACTED]" : value;
        }
        return redacted;
      },
    });

    log.error({ error: rawSecret }, "Operation failed");

    expect(String(consoleSpy.mock.calls[0]?.[0])).not.toContain(rawSecret);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "[REDACTED]", error: "[REDACTED]" }));
    expect(handler.mock.calls[0]?.[0]?.message).toBe("[REDACTED]");
    expect(handler.mock.calls[0]?.[1]).toMatchObject({
      apiKey: "[REDACTED]",
      error: "[REDACTED]",
    });
  });

  it("forwards per-call log fields into the error handler context", () => {
    const handler = vi.fn();
    setLoggerErrorHandler(handler);

    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test", requestId: "binding-request" },
    });

    log.error({ error: "boom", requestId: "request-1", sessionId: "session-1", retry: 2 }, "Exploded");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[1]).toEqual({
      operation: "Exploded",
      component: "shared-test",
      requestId: "request-1",
      sessionId: "session-1",
      retry: "2",
      error: "boom",
    });
  });

  it("reconstructs an Error from a serialized-error object for the handler", () => {
    const handler = vi.fn();
    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test" },
      errorHandler: handler,
    });

    // Shape produced by serializeError(): a plain object, not an Error instance.
    log.error(
      {
        error: {
          name: "TypeError",
          message: "real failure",
          type: "TypeError",
          stack: "TypeError: real failure\n  at x",
        },
      },
      "Generic log message",
    );

    expect(handler).toHaveBeenCalledOnce();
    const captured = handler.mock.calls[0]?.[0] as Error;
    // Must keep the real error message, not fall back to the generic log message.
    expect(captured.message).toBe("real failure");
    expect(captured.name).toBe("TypeError");
    expect(captured.stack).toContain("real failure");
  });

  it("folds aggregated sub-errors into a non-empty message for the handler", () => {
    const handler = vi.fn();
    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test" },
      errorHandler: handler,
    });

    // Shape produced by serializeError() for an AggregateError: empty own message,
    // real failures in `errors`.
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
      "Generic log message",
    );

    expect(handler).toHaveBeenCalledOnce();
    const captured = handler.mock.calls[0]?.[0] as Error;
    expect(captured.name).toBe("AggregateError");
    expect(captured.message).not.toBe("");
    expect(captured.message).toContain("TypeError: fetch failed");
    expect(captured.message).toContain("Error: connection reset");
  });

  it("falls back to the error class when a serialized error has an empty message", () => {
    const handler = vi.fn();
    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      bindings: { component: "shared-test" },
      errorHandler: handler,
    });

    log.error({ error: { name: "AggregateError", message: "", type: "AggregateError" } }, "Generic log message");

    expect(handler).toHaveBeenCalledOnce();
    const captured = handler.mock.calls[0]?.[0] as Error;
    expect(captured.message).toBe("AggregateError");
  });

  it("builds reusable trace and correlation field maps", () => {
    expect(
      traceLogFields({
        traceId: "trace-123",
        spanId: "span-456",
        parentSpanId: "parent-789",
      }),
    ).toEqual({
      [LOG_TRACE_FIELD_NAMES[0]]: "trace-123",
      [LOG_TRACE_FIELD_NAMES[1]]: "span-456",
    });

    expect(
      traceLogFields(
        {
          traceId: "trace-123",
          spanId: "span-456",
          parentSpanId: "parent-789",
        },
        { includeParentSpanId: true },
      ),
    ).toEqual({
      [LOG_TRACE_FIELD_NAMES[0]]: "trace-123",
      [LOG_TRACE_FIELD_NAMES[1]]: "span-456",
      [LOG_PARENT_SPAN_FIELD_NAME]: "parent-789",
    });

    expect(
      correlationLogFields({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        sessionId: "session-1",
        promptId: "prompt-1",
        sandboxId: "sandbox-1",
      }),
    ).toEqual({
      [LOG_CORRELATION_FIELD_NAMES[0]]: "a".repeat(32),
      [LOG_CORRELATION_FIELD_NAMES[1]]: "b".repeat(16),
      [LOG_CORRELATION_FIELD_NAMES[2]]: "c".repeat(16),
      [LOG_CORRELATION_FIELD_NAMES[3]]: "session-1",
      [LOG_CORRELATION_FIELD_NAMES[4]]: "prompt-1",
      [LOG_CORRELATION_FIELD_NAMES[5]]: "sandbox-1",
    });
  });

  it("builds canonical phase log fields", () => {
    const canonicalFields = phaseLogFields("prompt.complete", { step: "execution", phase_status: "completed" });
    expect(canonicalFields).toEqual({
      event: "prompt.complete",
      step: "execution",
      phase_status: "completed",
    });
    expect(canonicalFields).not.toHaveProperty("status");

    const remappedFields = phaseLogFields("prompt.complete", {
      event: "malicious.override",
      step: "execution",
      status: "completed",
    } as unknown as Record<string, unknown> & { event?: never });
    expect(remappedFields).toEqual({
      event: "prompt.complete",
      step: "execution",
      phase_status: "completed",
    });
    expect(remappedFields).not.toHaveProperty("status");
  });
});
