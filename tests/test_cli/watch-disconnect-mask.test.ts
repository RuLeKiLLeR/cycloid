import { describe, expect, it } from "vitest";

import { advanceStatusDisconnectMask } from "../../apps/cli/src/commands/watch.js";
import { TRANSIENT_DISCONNECT_VISIBILITY_MS } from "../../shared/session/transient-disconnect";

const T0 = 1_000_000;

describe("watch status disconnect mask", () => {
  it("prints the pre-disconnect phase for a fresh reconnecting transition", () => {
    const first = advanceStatusDisconnectMask(
      { phase: "review_listening" as const, sandboxSubstate: "none" as const },
      null,
      null,
      T0,
    );
    expect(first.displayStatus.phase).toBe("review_listening");

    const second = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "reconnecting" as const },
      first.mask,
      first.view,
      T0 + 2_000,
    );
    expect(second.displayStatus.phase).toBe("review_listening");
    expect(second.displayStatus.sandboxSubstate).toBe("none");
  });

  it("prints the true reconnecting status once the disconnect outlives the threshold", () => {
    const first = advanceStatusDisconnectMask(
      { phase: "review_listening" as const, sandboxSubstate: "none" as const },
      null,
      null,
      T0,
    );
    const second = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "reconnecting" as const },
      first.mask,
      first.view,
      T0 + 2_000,
    );
    const third = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "reconnecting" as const },
      second.mask,
      second.view,
      T0 + 2_000 + TRANSIENT_DISCONNECT_VISIBILITY_MS,
    );
    expect(third.displayStatus.phase).toBe("running");
    expect(third.displayStatus.sandboxSubstate).toBe("reconnecting");
  });

  it("does not mask when watch starts mid-reconnect", () => {
    const first = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "reconnecting" as const },
      null,
      null,
      T0,
    );
    expect(first.displayStatus.sandboxSubstate).toBe("reconnecting");
  });

  it("returns to the true status when the sandbox reconnects", () => {
    const first = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "none" as const },
      null,
      null,
      T0,
    );
    const second = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "reconnecting" as const },
      first.mask,
      first.view,
      T0 + 2_000,
    );
    const third = advanceStatusDisconnectMask(
      { phase: "running" as const, sandboxSubstate: "none" as const },
      second.mask,
      second.view,
      T0 + 4_000,
    );
    expect(third.mask).toBeNull();
    expect(third.displayStatus.sandboxSubstate).toBe("none");
  });

  it("passes a null phase through untouched", () => {
    const result = advanceStatusDisconnectMask({ phase: null }, null, null, T0);
    expect(result.displayStatus.phase).toBeNull();
    expect(result.view).toBeNull();
    expect(result.mask).toBeNull();
  });
});
