import { describe, expect, it } from "vitest";

import { type Correlation, parseCorrelation, serializeCorrelation } from "../../shared/correlation.js";
import {
  buildTracingReadiness,
  generateSpanId,
  generateTraceId,
  normalizeSpanId,
  normalizeTraceId,
  observabilityReadinessFromTracing,
  observabilityReadinessLogFields,
  parseTraceparent,
  serializeTraceparent,
  type SpanAttributes,
  TRACING_STATES,
} from "../../shared/observability/trace.js";
import type { ObservabilityReadiness } from "../../shared/types/sandbox.js";

describe("shared observability trace primitives", () => {
  it("normalizes trace and span IDs into canonical lowercase OTel IDs", () => {
    expect(normalizeTraceId("A".repeat(32))).toBe("a".repeat(32));
    expect(normalizeSpanId("B".repeat(16))).toBe("b".repeat(16));

    expect(normalizeTraceId("0".repeat(32))).toBeUndefined();
    expect(normalizeTraceId("g".repeat(32))).toBeUndefined();
    expect(normalizeTraceId("a".repeat(31))).toBeUndefined();
    expect(normalizeSpanId("0".repeat(16))).toBeUndefined();
    expect(normalizeSpanId("g".repeat(16))).toBeUndefined();
    expect(normalizeSpanId("b".repeat(15))).toBeUndefined();
  });

  it("generates non-zero IDs that serialize into canonical traceparent strings", () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe("0".repeat(32));
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanId).not.toBe("0".repeat(16));

    expect(parseTraceparent(serializeTraceparent({ traceId, spanId }))).toEqual({
      traceId,
      spanId,
      traceFlags: "01",
    });
  });

  it("keeps generated child span IDs distinct from an excluded parent span", () => {
    const parentSpanId = "b".repeat(16);
    const spanIds = new Set<string>();

    for (let index = 0; index < 25; index += 1) {
      const childSpanId = generateSpanId(parentSpanId);
      expect(childSpanId).not.toBe(parentSpanId);
      spanIds.add(childSpanId);
    }

    expect(spanIds.size).toBe(25);
  });

  it("parses Cycloid canonical sampled traceparent strings by default", () => {
    const traceparent = `00-${"A".repeat(32)}-${"B".repeat(16)}-01`;

    expect(parseTraceparent(traceparent)).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: "01",
    });

    expect(parseTraceparent("bad")).toBeNull();
    expect(parseTraceparent(`ff-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-00`)).toBeNull();
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`)).toBeNull();
  });

  it("accepts unsampled traceparent flags only when requested for external ingress", () => {
    const traceparent = `00-${"A".repeat(32)}-${"B".repeat(16)}-00`;

    expect(parseTraceparent(traceparent)).toBeNull();
    expect(parseTraceparent(traceparent, { allowUnsampled: true })).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: "00",
    });
  });

  it("uses the same traceparent contract as serialized correlation", () => {
    const correlation: Correlation = {
      traceId: "A".repeat(32),
      spanId: "B".repeat(16),
      parentSpanId: null,
      sessionId: "session-1",
      promptId: "prompt-1",
    };

    const serialized = serializeCorrelation(correlation);

    expect(serialized.traceparent).toBe(serializeTraceparent(correlation));
    expect(parseTraceparent(serialized.traceparent)).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: "01",
    });
    expect(parseCorrelation(serialized)).toMatchObject({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      sessionId: "session-1",
      promptId: "prompt-1",
    });
  });

  it("exports the shared span attribute and tracing readiness vocabulary", () => {
    const attributes: SpanAttributes = {
      "session.id": "session-1",
      "duration.ms": 123,
      "trace.export": true,
    };
    const readiness: ObservabilityReadiness = {
      traceExport: false,
      traceExportConfigured: false,
      ddLogs: true,
      tracingState: TRACING_STATES[0],
    };

    expect(attributes).toEqual({
      "session.id": "session-1",
      "duration.ms": 123,
      "trace.export": true,
    });
    expect(readiness.tracingState).toBe("disabled");
    expect(TRACING_STATES).toEqual(["disabled", "init_failed", "enabled"]);
  });

  it("reports Datadog log readiness only; the sandbox bridge no longer exports OTLP traces", () => {
    expect(buildTracingReadiness({})).toEqual({
      traceExportEnabled: false,
      ddLogsEnabled: false,
      tracingState: "disabled",
    });

    expect(buildTracingReadiness({ ddApiKey: "dd-api-key" })).toEqual({
      traceExportEnabled: false,
      ddLogsEnabled: true,
      tracingState: "disabled",
    });
  });

  it("projects shared tracing readiness into log-only session readiness and log fields", () => {
    const tracingReadiness = buildTracingReadiness({ ddApiKey: "dd-api-key" });
    const readiness = observabilityReadinessFromTracing(tracingReadiness);

    expect(readiness).toEqual({
      traceExport: false,
      traceExportConfigured: false,
      ddLogs: true,
      tracingState: "disabled",
    });
    expect(observabilityReadinessLogFields(readiness)).toEqual({
      trace_export_enabled: false,
      trace_export_configured: false,
      dd_logs_enabled: true,
      tracing_state: "disabled",
    });
  });
});
