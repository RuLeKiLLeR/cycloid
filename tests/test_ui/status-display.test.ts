import { describe, expect, it } from "vitest";

import { STATUS_DISPLAY_RAIL } from "../../apps/ui/src/constants";
import { isActivePrompt, isWatchdogActivePhase, STATUS_DISPLAY_LABEL } from "../../apps/ui/src/utils/status-display";

describe("STATUS_DISPLAY_LABEL", () => {
  it("provides a human label for each DisplayStatus", () => {
    expect(STATUS_DISPLAY_LABEL.working).toBe("Working");
    expect(STATUS_DISPLAY_LABEL.waiting_for_input).toBe("Waiting for input");
    expect(STATUS_DISPLAY_LABEL.completed).toBe("Completed");
    expect(STATUS_DISPLAY_LABEL.failed).toBe("Failed");
    expect(STATUS_DISPLAY_LABEL.stopped).toBe("Stopped");
    expect(STATUS_DISPLAY_LABEL.archived).toBe("Archived");
  });
});

describe("isActivePrompt", () => {
  it("distinguishes a parked plan from a live pending question", () => {
    expect(isActivePrompt("waiting_for_input", true)).toBe(false);
    expect(isActivePrompt("running", true)).toBe(false);
    expect(isActivePrompt("waiting_for_input", false)).toBe(true);
  });

  it("is true for running and waiting_for_input", () => {
    expect(isActivePrompt("running", false)).toBe(true);
    expect(isActivePrompt("waiting_for_input", false)).toBe(true);
  });

  it("is false for finalizing and other non-prompt phases (transcript-liveness gate)", () => {
    // isActivePrompt drives SessionTurn's transcript-liveness affordance; there
    // is no live prompt during finalizing/review_listening/terminal phases, so
    // it must stay false to avoid rendering a finished turn as in-progress. The
    // WS watchdog uses isWatchdogActivePhase instead (ARC-1318).
    expect(isActivePrompt("finalizing", false)).toBe(false);
    expect(isActivePrompt("review_listening", false)).toBe(false);
    expect(isActivePrompt("idle", false)).toBe(false);
    expect(isActivePrompt("stopped", false)).toBe(false);
    expect(isActivePrompt("archived", false)).toBe(false);
  });
});

describe("isWatchdogActivePhase", () => {
  it("disarms the watchdog for a parked plan without changing real-question behavior", () => {
    expect(isWatchdogActivePhase("waiting_for_input", true)).toBe(false);
    expect(isWatchdogActivePhase("finalizing", true)).toBe(false);
    expect(isWatchdogActivePhase("waiting_for_input", false)).toBe(true);
  });

  it("is true for running, waiting_for_input, and finalizing", () => {
    // finalizing keeps the WS liveness watchdog armed through the publish/verify
    // window so a half-open socket is force-reconnected and recovers the fresh
    // `subscribed` snapshot (which carries the side-channel verification/PR/phase
    // state) instead of silently going stale until a manual refresh (ARC-1318).
    expect(isWatchdogActivePhase("running", false)).toBe(true);
    expect(isWatchdogActivePhase("waiting_for_input", false)).toBe(true);
    expect(isWatchdogActivePhase("finalizing", false)).toBe(true);
  });

  it("is false for review_listening and terminal/idle phases", () => {
    // review_listening is long-lived and emits no liveness heartbeat for >90s,
    // so arming the watchdog there would cause a 90s-cadence reconnect storm.
    for (const phase of [
      "idle",
      "completed",
      "stopped",
      "failed",
      "blocked",
      "archived",
      "review_listening",
    ] as const) {
      expect(isWatchdogActivePhase(phase, false)).toBe(false);
    }
  });
});

describe("STATUS_DISPLAY_RAIL", () => {
  it("provides a vertical-rail color + opacity for each DisplayStatus", () => {
    expect(STATUS_DISPLAY_RAIL.working.bg).toContain("warning");
    expect(STATUS_DISPLAY_RAIL.waiting_for_input.bg).toContain("accent");
    expect(STATUS_DISPLAY_RAIL.completed.bg).toContain("success");
    expect(STATUS_DISPLAY_RAIL.failed.bg).toContain("error");
    expect(STATUS_DISPLAY_RAIL.stopped.bg).toContain("text-muted");
    expect(STATUS_DISPLAY_RAIL.archived.opacity).toBe("opacity-30");
  });
});
