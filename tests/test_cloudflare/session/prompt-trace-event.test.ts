import { describe, expect, it } from "vitest";

import {
  buildPromptTraceFinalizationEvent,
  serializeErrorDetails,
} from "../../../apps/control-plane-worker/src/session/prompt-trace-event";

describe("buildPromptTraceFinalizationEvent", () => {
  const base = {
    sessionId: "sess-1",
    promptId: "p-1",
    repo: "trycycloid/cycloid",
    model: "gpt-5.5",
    agent: "codex",
    durationMs: 1234,
    ddTraceId: null,
    btSpanId: null,
    traceExpected: false,
    source: "execution_complete" as const,
  };

  it("carries the control-plane terminal error_code so the failure metric can group by it", () => {
    const event = buildPromptTraceFinalizationEvent({
      ...base,
      outcome: "failed",
      errorCode: "sandbox_disconnected",
      runtimeProvider: "e2b",
      runtimeBackend: "e2b_cloud",
    });

    expect(event.event).toBe("prompt.trace.finalized");
    expect(event.outcome).toBe("failed");
    expect(event.error_code).toBe("sandbox_disconnected");
    expect(event.repo).toBe("trycycloid/cycloid");
    expect(event.runtime_provider).toBe("e2b");
    expect(event.runtime_backend).toBe("e2b_cloud");
  });

  it("emits both telemetry_complete and the trace_complete alias from btSpanId", () => {
    const withSpan = buildPromptTraceFinalizationEvent({
      ...base,
      outcome: "completed",
      errorCode: null,
      btSpanId: "bt-span-1",
      traceExpected: true,
    });
    expect(withSpan.trace_expected).toBe(true);
    expect(withSpan.telemetry_complete).toBe(true);
    // Alias the TF metric/monitor (arcanist.prompt.trace_finalization) reads.
    expect(withSpan.trace_complete).toBe(true);
    expect(withSpan.bt_span_id).toBe("bt-span-1");

    const withoutSpan = buildPromptTraceFinalizationEvent({
      ...base,
      outcome: "failed",
      errorCode: "max_duration_exceeded",
      traceExpected: true,
    });
    expect(withoutSpan.trace_expected).toBe(true);
    expect(withoutSpan.telemetry_complete).toBe(false);
    expect(withoutSpan.trace_complete).toBe(false);
  });

  it("marks pre-execution control-plane terminals as trace_expected false", () => {
    const event = buildPromptTraceFinalizationEvent({
      ...base,
      outcome: "failed",
      errorCode: "spawn_provider_error",
      traceExpected: false,
    });
    expect(event.trace_expected).toBe(false);
    expect(event.trace_complete).toBe(false);
  });

  it("omits optional tags when null (no error_code, no runtime, no repo)", () => {
    const event = buildPromptTraceFinalizationEvent({
      ...base,
      repo: null,
      outcome: "completed",
      errorCode: null,
      runtimeProvider: null,
      runtimeBackend: null,
    });
    expect(event).not.toHaveProperty("error_code");
    expect(event).not.toHaveProperty("runtime_provider");
    expect(event).not.toHaveProperty("runtime_backend");
    expect(event).not.toHaveProperty("repo");
    // error_details_present is always emitted (not a conditional spread), so pin it.
    expect(event.error_details_present).toBe(false);
  });

  it("emits only bounded structured error fields, never free-form ones (CWE-532)", () => {
    const event = buildPromptTraceFinalizationEvent({
      ...base,
      outcome: "failed",
      errorCode: "spawn_provider_error",
      errorDetails: {
        message: "secret provider response",
        name: "E2BError",
        code: "ECONN",
        isRetryable: true,
        hostname: "internal-host",
        cause: { code: "ETIMEDOUT", message: "raw cause detail" },
      },
    });
    // Bounded, structured fields are kept for triage.
    expect(event.error_details_present).toBe(true);
    expect(event.error_name).toBe("E2BError");
    expect(event.error_detail_code).toBe("ECONN");
    expect(event.error_retryable).toBe(true);
    expect(event.error_cause_code).toBe("ETIMEDOUT");
    // Free-form fields must NOT reach Datadog (they stay in D1/S3 only).
    expect(event).not.toHaveProperty("error_message");
    expect(event).not.toHaveProperty("error_details_json");
    expect(event).not.toHaveProperty("error_hostname");
    expect(event).not.toHaveProperty("error_cause_message");
  });
});

describe("serializeErrorDetails", () => {
  it("returns null for missing details", () => {
    expect(serializeErrorDetails(null)).toBeNull();
    expect(serializeErrorDetails(undefined)).toBeNull();
  });

  it("serializes details to JSON", () => {
    expect(serializeErrorDetails({ message: "x" })).toBe(JSON.stringify({ message: "x" }));
  });
});
