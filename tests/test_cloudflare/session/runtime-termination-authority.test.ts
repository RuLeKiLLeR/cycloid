import { describe, expect, it } from "vitest";

import {
  decideRuntimeTerminationOnDisconnect,
  type RuntimeTerminationInputs,
} from "../../../apps/control-plane-worker/src/session/sandbox-state-owners/runtime-termination-authority.ts";

/** A baseline with independently confirmed sustained provider loss. */
function confirmedDead(overrides: Partial<RuntimeTerminationInputs> = {}): RuntimeTerminationInputs {
  return {
    killSwitchEnabled: true,
    hasE2BRuntime: true,
    lossWindowElapsed: true,
    liveness: "dead",
    ...overrides,
  };
}

describe("decideRuntimeTerminationOnDisconnect", () => {
  it("terminates only on provider-confirmed loss after the observation window", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead())).toBe("terminate");
  });

  it("defers when provider probing is disabled", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead({ killSwitchEnabled: false }))).toBe("defer");
  });

  it("defers when provider metadata is unavailable", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead({ hasE2BRuntime: false }))).toBe("defer");
  });

  it("defers a dead reading until transport loss is sustained", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead({ lossWindowElapsed: false }))).toBe("defer");
  });

  it("never terminalizes a provider-alive runtime", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead({ liveness: "alive" }))).toBe("defer");
  });

  it("never turns an unknown/error probe into a disconnect", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead({ liveness: "unknown" }))).toBe("defer");
  });

  it("never turns a skipped probe into a disconnect", () => {
    expect(decideRuntimeTerminationOnDisconnect(confirmedDead({ liveness: null }))).toBe("defer");
  });
});
