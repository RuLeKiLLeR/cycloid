import { describe, expect, it } from "vitest";

import { isWatchTerminal } from "../../apps/cli/src/constants/watch.js";

describe("isWatchTerminal", () => {
  it("treats every terminal phase as terminal", () => {
    for (const phase of ["completed", "blocked", "failed", "stopped", "archived"] as const) {
      expect(isWatchTerminal(phase)).toBe(true);
    }
  });

  it("does NOT treat idle as terminal for repo sessions", () => {
    // A brand-new repo session sits in `idle` between prompt enqueue and pickup
    // and the watch loop must keep polling.
    expect(isWatchTerminal("idle")).toBe(false);
  });

  it("does NOT treat running / waiting_for_input / finalizing as terminal", () => {
    for (const phase of ["running", "waiting_for_input", "finalizing"] as const) {
      expect(isWatchTerminal(phase)).toBe(false);
    }
  });

  it("treats superseded as terminal so watch exits on benign review-loop block", () => {
    // Regression: superseded was missing from VALID_PHASES in parseSsePayload,
    // coercing it to null and causing arc watch to poll forever.
    expect(isWatchTerminal("superseded")).toBe(true);
  });

  it("does NOT treat review_listening as terminal", () => {
    // review_listening is an active (non-terminal) phase; watch must keep polling.
    expect(isWatchTerminal("review_listening")).toBe(false);
  });
});
