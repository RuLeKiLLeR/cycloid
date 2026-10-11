import { describe, expect, it } from "vitest";

import {
  drainSpans,
  endSpan,
  extractTraceparent,
  injectTraceparent,
  runInExporterContext,
  runInSpan,
  startSpan,
} from "../../apps/control-plane-worker/src/observability/context";
import {
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  serializeTraceparent,
} from "../../shared/observability/trace.js";

describe("control-plane traceparent compatibility", () => {
  it("accepts shared traceparent strings in the worker extractor", () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const traceparent = serializeTraceparent({ traceId, spanId });

    expect(extractTraceparent(traceparent)).toEqual({
      traceId,
      parentSpanId: spanId,
    });
  });

  it("rejects malformed traceparent strings through the shared parser", () => {
    expect(extractTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(extractTraceparent(`01-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(extractTraceparent(`00-${"g".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
  });

  it("accepts unsampled W3C traceparent strings at worker ingress", () => {
    const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-00`;

    expect(extractTraceparent(traceparent)).toEqual({
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
    });
  });

  it("emits worker traceparent strings accepted by shared parsing", () => {
    const span = startSpan("compat.worker");

    runInSpan(span, () => {
      const traceparent = injectTraceparent();

      expect(parseTraceparent(traceparent)).toEqual({
        traceId: span.traceId,
        spanId: span.spanId,
        traceFlags: "01",
      });
    });
  });

  it("does not create trace context or completed spans inside exporter context", () => {
    runInExporterContext(() => {
      expect(injectTraceparent()).toBeNull();

      const span = startSpan("exporter.self");
      endSpan(span, "ok");

      expect(drainSpans()).toEqual([]);
    });
  });
});
