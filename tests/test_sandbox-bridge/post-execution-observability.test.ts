import { describe, expect, it, vi } from "vitest";

import {
  observePostExecution,
  postExecutionLogLevelForUtility,
  type PostExecutionObservationUtility,
} from "../../apps/sandbox-bridge/src/services/post-execution/observability.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

describe("post-execution observability", () => {
  it("maps utility tiers to log levels", () => {
    const cases: Array<[PostExecutionObservationUtility, "debug" | "info" | "warn" | "error"]> = [
      ["trace", "debug"],
      ["progress", "info"],
      ["decision", "info"],
      ["degraded", "warn"],
      ["failure", "error"],
    ];

    for (const [utility, level] of cases) {
      expect(postExecutionLogLevelForUtility(utility)).toBe(level);
    }
  });

  it("emits the utility marker and stable event at the mapped level", () => {
    const log = makeLogger();

    observePostExecution(log, {
      utility: "degraded",
      event: "post_execution.publish_gate_degraded",
      message: "Publish gate degraded",
      fields: { event: "ignored", gate: "tests" },
    });

    expect(log.warn).toHaveBeenCalledWith(
      {
        event: "post_execution.publish_gate_degraded",
        gate: "tests",
        observabilityUtility: "degraded",
      },
      "Publish gate degraded",
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
