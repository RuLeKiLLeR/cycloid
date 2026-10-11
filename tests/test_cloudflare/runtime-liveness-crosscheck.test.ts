import { describe, expect, it } from "vitest";

import type { E2BListedSandbox, E2BSandboxInfoResult } from "../../apps/control-plane-worker/src/sandbox/e2b-client.ts";
import {
  classifyCrossCheckSignal,
  crossCheckRuntimeLiveness,
  crossCheckRuntimeViaProbe,
  sanitizeErrorCode,
} from "../../apps/control-plane-worker/src/sandbox/runtime-liveness-crosscheck.ts";

function listed(runtimeSandboxId: string, status: E2BListedSandbox["status"] = "running"): E2BListedSandbox {
  return {
    runtimeSandboxId,
    runtimeTemplateId: "tmpl-1",
    status,
    createdAt: 0,
    metadata: {},
  };
}

// Deterministic clock: each call advances 10ms so durationMs is a stable positive.
function fakeClock(): () => number {
  let t = 1_000;
  return () => {
    t += 10;
    return t;
  };
}

describe("crossCheckRuntimeLiveness", () => {
  it("reports the VM as listed (H2 signal) when it is still in the running/paused list", async () => {
    const result = await crossCheckRuntimeLiveness({
      runtimeSandboxId: "e2b-1",
      timeoutMs: 1_000,
      now: fakeClock(),
      list: async () => [listed("other"), listed("e2b-1", "paused")],
    });

    expect(result).toMatchObject({
      runtimeSandboxId: "e2b-1",
      status: "ok",
      listed: true,
      listedState: "paused",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports absent when the list does not contain the id", async () => {
    const result = await crossCheckRuntimeLiveness({
      runtimeSandboxId: "e2b-1",
      timeoutMs: 1_000,
      now: fakeClock(),
      list: async () => [listed("other")],
    });

    expect(result).toMatchObject({ status: "ok", listed: false });
    expect(result.listedState).toBeUndefined();
  });

  it("captures a throwing list as status:error and never rejects", async () => {
    const result = await crossCheckRuntimeLiveness({
      runtimeSandboxId: "e2b-1",
      timeoutMs: 1_000,
      now: fakeClock(),
      list: async () => {
        throw new Error("rate limited");
      },
    });

    expect(result).toMatchObject({ status: "error", listed: false, errorCode: "Error" });
  });

  it("classifies a hung list as timeout and never rejects", async () => {
    const result = await crossCheckRuntimeLiveness({
      runtimeSandboxId: "e2b-1",
      timeoutMs: 20,
      now: fakeClock(),
      list: () => new Promise<E2BListedSandbox[]>(() => {}),
    });

    expect(result).toMatchObject({ status: "timeout", listed: false, errorCode: "timeout" });
  });
});

// ARC-1484: providers without a usable account list (Freestyle — its list is
// account-wide and shared across envs) cross-check the session's OWN VM via a
// per-VM getSandboxInfo read. The result must map onto the SAME CrossCheckResult
// shape the list path produces so classifyCrossCheckSignal is unchanged.
describe("crossCheckRuntimeViaProbe", () => {
  it("reports the VM as listed (H2 signal) when the per-VM read is running", async () => {
    const result = await crossCheckRuntimeViaProbe({
      runtimeSandboxId: "vm-abc",
      now: fakeClock(),
      probe: async () => ({ status: "running" }),
    });

    expect(result).toMatchObject({
      runtimeSandboxId: "vm-abc",
      status: "ok",
      listed: true,
      listedState: "running",
    });
    // The signal parity: a listed VM after a `dead` probe is the H2 false-negative.
    expect(classifyCrossCheckSignal({ listed: result.listed, status: result.status, liveness: "dead" })).toBe(
      "probe_false_negative_suspected",
    );
  });

  it("treats a paused VM as listed (a suspended Freestyle VM is still present)", async () => {
    const result = await crossCheckRuntimeViaProbe({
      runtimeSandboxId: "vm-abc",
      now: fakeClock(),
      probe: async () => ({ status: "paused", rawState: "hibernating" }),
    });

    expect(result).toMatchObject({ status: "ok", listed: true, listedState: "paused" });
  });

  it("reports genuine loss (absent) only on a decisive missing read", async () => {
    const result = await crossCheckRuntimeViaProbe({
      runtimeSandboxId: "vm-abc",
      now: fakeClock(),
      probe: async () => ({ status: "missing" }),
    });

    expect(result).toMatchObject({ status: "ok", listed: false });
    expect(result.listedState).toBeUndefined();
    expect(classifyCrossCheckSignal({ listed: result.listed, status: result.status, liveness: "dead" })).toBe(
      "absent_from_all_backends",
    );
  });

  it("does NOT claim absence on an unknown (transient) read -> inconclusive", async () => {
    // getSandboxInfo exhausts its retries and returns unknown; absence is unproven,
    // so the cross-check must surface `error` (never a false absent_from_all_backends).
    const result = await crossCheckRuntimeViaProbe({
      runtimeSandboxId: "vm-abc",
      now: fakeClock(),
      probe: async (): Promise<E2BSandboxInfoResult> => ({ status: "unknown", errorCode: "network" }),
    });

    expect(result).toMatchObject({ status: "error", listed: false, errorCode: "network" });
    expect(classifyCrossCheckSignal({ listed: result.listed, status: result.status, liveness: "dead" })).toBe(
      "inconclusive",
    );
  });

  it("never rejects even if the probe violates its non-throwing contract", async () => {
    const result = await crossCheckRuntimeViaProbe({
      runtimeSandboxId: "vm-abc",
      now: fakeClock(),
      probe: async () => {
        throw new Error("connect ECONNREFUSED token=secret");
      },
    });

    // Sanitized code only (never the raw message) and treated as unproven absence.
    expect(result).toMatchObject({ status: "error", listed: false, errorCode: "Error" });
  });
});

describe("sanitizeErrorCode", () => {
  // This is the hygiene guard for the disconnect diagnostic error events
  // (sandbox_disconnect_crosscheck_error / _probe_error): they direct-post to
  // Datadog, so the code must be a bounded identifier, never the raw message.
  it("returns the Error name, not the message", () => {
    class RateLimitError extends Error {
      constructor() {
        super("connect ECONNREFUSED 10.0.0.7:443 token=secret");
        this.name = "RateLimitError";
      }
    }
    const code = sanitizeErrorCode(new RateLimitError());
    expect(code).toBe("RateLimitError");
    expect(code).not.toContain("ECONNREFUSED");
    expect(code).not.toContain("10.0.0.7");
    expect(code).not.toContain("secret");
  });

  it("never leaks the message of a plain Error (name defaults to 'Error')", () => {
    expect(sanitizeErrorCode(new Error("10.0.0.7 internal detail"))).toBe("Error");
  });

  it("falls back to 'error' for non-Error throwables (no stringified value)", () => {
    expect(sanitizeErrorCode("raw string with 10.0.0.7")).toBe("error");
    expect(sanitizeErrorCode({ secret: "value" })).toBe("error");
  });
});

describe("classifyCrossCheckSignal", () => {
  it("flags H2 only when the VM is listed AND the probe affirmatively read dead", () => {
    expect(classifyCrossCheckSignal({ listed: true, status: "ok", liveness: "dead" })).toBe(
      "probe_false_negative_suspected",
    );
  });

  it("does not flag H2 when the VM is listed but the probe was not dead (hold-exhausted/kill-switch -> null)", () => {
    expect(classifyCrossCheckSignal({ listed: true, status: "ok", liveness: null })).toBe("listed_without_dead_probe");
  });

  it("does not flag H2 when the VM is listed but the probe was unknown (probe error)", () => {
    expect(classifyCrossCheckSignal({ listed: true, status: "ok", liveness: "unknown" })).toBe(
      "listed_without_dead_probe",
    );
  });

  it("reports absent_from_all_backends only when the cross-check answered and did not list the VM", () => {
    expect(classifyCrossCheckSignal({ listed: false, status: "ok", liveness: "dead" })).toBe(
      "absent_from_all_backends",
    );
  });

  it("reports inconclusive when not listed but the cross-check timed out (absence unproven)", () => {
    expect(classifyCrossCheckSignal({ listed: false, status: "timeout", liveness: "dead" })).toBe("inconclusive");
  });

  it("reports inconclusive when not listed but the cross-check errored", () => {
    expect(classifyCrossCheckSignal({ listed: false, status: "error", liveness: "dead" })).toBe("inconclusive");
  });
});
