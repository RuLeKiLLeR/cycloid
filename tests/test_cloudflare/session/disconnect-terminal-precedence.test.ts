import { describe, expect, it } from "vitest";

import {
  DISCONNECT_PREEMPTED_PROMPT_DEADLINE_EVENTS,
  DISCONNECT_TERMINAL_LIFECYCLE_EVENTS,
  shouldDeferLifecycleTerminal,
} from "../../../apps/control-plane-worker/src/session/sandbox-state-owners/disconnect-terminal-precedence.js";

describe("shouldDeferLifecycleTerminal", () => {
  it("always defers disconnect-terminal events regardless of batch contents", () => {
    for (const eventType of DISCONNECT_TERMINAL_LIFECYCLE_EVENTS) {
      expect(shouldDeferLifecycleTerminal(eventType, false)).toBe(true);
      expect(shouldDeferLifecycleTerminal(eventType, true)).toBe(true);
    }
  });

  it("defers prompt-deadline terminalization only when a disconnect-terminal event shares the batch", () => {
    for (const eventType of DISCONNECT_PREEMPTED_PROMPT_DEADLINE_EVENTS) {
      // No disconnect event in the batch: the deadline terminalizes as usual.
      expect(shouldDeferLifecycleTerminal(eventType, false)).toBe(false);
      // A disconnect event is also due: defer so the bounded re-enqueue wins.
      expect(shouldDeferLifecycleTerminal(eventType, true)).toBe(true);
    }
  });

  it("liveness and reconnect-grace are both treated as disconnect-terminal", () => {
    expect(DISCONNECT_TERMINAL_LIFECYCLE_EVENTS.has("sandbox.liveness_expired")).toBe(true);
    expect(DISCONNECT_TERMINAL_LIFECYCLE_EVENTS.has("sandbox.reconnect_grace_expired")).toBe(true);
  });

  it("never defers unrelated lifecycle events", () => {
    for (const eventType of [
      "prompt.terminal_received",
      "sandbox.stop_completed",
      "boundary.close_finalize",
    ] as const) {
      expect(shouldDeferLifecycleTerminal(eventType, false)).toBe(false);
      expect(shouldDeferLifecycleTerminal(eventType, true)).toBe(false);
    }
  });
});
