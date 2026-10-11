import { describe, expect, it } from "vitest";

import { type Correlation, parseCorrelation, serializeCorrelation } from "../../shared/correlation.js";

function expectValidTraceparent(traceparent: string, traceId: string, spanId: string): void {
  expect(traceparent).toBe(`00-${traceId}-${spanId}-01`);
}

describe("serializeCorrelation", () => {
  it("serializes a root correlation to a valid traceparent payload", () => {
    const correlation: Correlation = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: null,
      sessionId: "session-1",
      promptId: "prompt-1",
    };

    expect(serializeCorrelation(correlation)).toEqual({
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      sessionId: "session-1",
      promptId: "prompt-1",
    });
  });

  it("serializes child lineage and optional sandboxId", () => {
    const correlation: Correlation = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      sessionId: "session-1",
      promptId: "prompt-1",
      sandboxId: "sandbox-1",
    };
    const serialized = serializeCorrelation(correlation);

    expectValidTraceparent(serialized.traceparent, correlation.traceId, correlation.spanId);
    expect(serialized.parentSpanId).toBe("c".repeat(16));
    expect(serialized.sandboxId).toBe("sandbox-1");
  });

  it("rejects malformed correlations instead of emitting bad wire values", () => {
    expect(() =>
      serializeCorrelation({
        traceId: "0".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: null,
        sessionId: "session-1",
        promptId: "prompt-1",
      }),
    ).toThrow("Invalid traceId");

    expect(() =>
      serializeCorrelation({
        traceId: "a".repeat(32),
        spanId: "0".repeat(16),
        parentSpanId: null,
        sessionId: "session-1",
        promptId: "prompt-1",
      }),
    ).toThrow("Invalid spanId");

    expect(() =>
      serializeCorrelation({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "b".repeat(16),
        sessionId: "session-1",
        promptId: "prompt-1",
      }),
    ).toThrow("Invalid parentSpanId");
  });
});

describe("parseCorrelation", () => {
  it("round-trips a root correlation from the serialized object", () => {
    const correlation: Correlation = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: null,
      sessionId: "session-1",
      promptId: "prompt-1",
    };

    expect(parseCorrelation(serializeCorrelation(correlation))).toEqual(correlation);
  });

  it("round-trips a child correlation from a serialized JSON string", () => {
    const correlation: Correlation = {
      traceId: "a".repeat(32),
      spanId: "c".repeat(16),
      parentSpanId: "b".repeat(16),
      sessionId: "session-1",
      promptId: "prompt-1",
      sandboxId: "sandbox-1",
    };

    expect(parseCorrelation(JSON.stringify(serializeCorrelation(correlation)))).toEqual(correlation);
  });

  it("canonicalizes uppercase trace IDs from the serialized traceparent", () => {
    const parsed = parseCorrelation({
      traceparent: `00-${"A".repeat(32)}-${"B".repeat(16)}-01`,
      sessionId: "session-1",
      promptId: "prompt-1",
      parentSpanId: "C".repeat(16),
    });

    expect(parsed).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      sessionId: "session-1",
      promptId: "prompt-1",
    });
  });

  it.each([
    ["bad JSON string", "{not-json"],
    ["non-record input", null],
    ["missing traceparent", { sessionId: "session-1", promptId: "prompt-1" }],
    ["invalid traceparent shape", { traceparent: "bad", sessionId: "session-1", promptId: "prompt-1" }],
    [
      "invalid traceparent version",
      { traceparent: `ff-${"a".repeat(32)}-${"b".repeat(16)}-01`, sessionId: "session-1", promptId: "prompt-1" },
    ],
    [
      "non-canonical traceparent version",
      { traceparent: `01-${"a".repeat(32)}-${"b".repeat(16)}-01`, sessionId: "session-1", promptId: "prompt-1" },
    ],
    [
      "non-canonical traceparent flags",
      { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00`, sessionId: "session-1", promptId: "prompt-1" },
    ],
    [
      "all-zero trace ID",
      { traceparent: `00-${"0".repeat(32)}-${"b".repeat(16)}-01`, sessionId: "session-1", promptId: "prompt-1" },
    ],
    [
      "all-zero span ID",
      { traceparent: `00-${"a".repeat(32)}-${"0".repeat(16)}-01`, sessionId: "session-1", promptId: "prompt-1" },
    ],
    [
      "blank sessionId",
      { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`, sessionId: " ", promptId: "prompt-1" },
    ],
    [
      "blank promptId",
      { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`, sessionId: "session-1", promptId: " " },
    ],
    [
      "blank sandboxId",
      {
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
        sessionId: "session-1",
        promptId: "prompt-1",
        sandboxId: " ",
      },
    ],
    [
      "invalid parentSpanId",
      {
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
        sessionId: "session-1",
        promptId: "prompt-1",
        parentSpanId: "bad",
      },
    ],
    [
      "self-referential parentSpanId",
      {
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
        sessionId: "session-1",
        promptId: "prompt-1",
        parentSpanId: "b".repeat(16),
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseCorrelation(value)).toBeNull();
  });
});
