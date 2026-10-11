import { describe, expect, it } from "vitest";

import { TERMINAL_RICH_STATUSES } from "../../apps/control-plane-worker/src/automation/db";
import { TERMINAL_PHASES as UI_TERMINAL_PHASES } from "../../apps/ui/src/constants";
import { TERMINAL_PHASES, TERMINAL_PHASES_ARRAY } from "../../shared/session/phase";

/**
 * Regression guard for the constants consolidation: every "terminal" set in
 * the repo must derive from `shared/session/phase.ts`. Drift here used to
 * mean the UI hid actions on phases the server still treated as live (or vice
 * versa), and the automation DAO would silently miss a new terminal phase
 * when filtering completed runs.
 */
describe("terminal-phases consolidation", () => {
  it("UI TERMINAL_PHASES is the same identity as the shared one", () => {
    // Re-export should preserve reference identity so future contributors
    // can't subclass or wrap it without the test catching the divergence.
    expect(UI_TERMINAL_PHASES).toBe(TERMINAL_PHASES);
  });

  it("automation TERMINAL_RICH_STATUSES is the same identity as the shared array", () => {
    expect(TERMINAL_RICH_STATUSES).toBe(TERMINAL_PHASES_ARRAY);
  });

  it("array and Set forms agree", () => {
    expect(new Set(TERMINAL_PHASES_ARRAY)).toEqual(TERMINAL_PHASES);
    expect(TERMINAL_PHASES_ARRAY.length).toBe(TERMINAL_PHASES.size);
  });

  it("preserves the terminal-phase membership the pre-consolidation Sets had", () => {
    expect([...TERMINAL_PHASES].sort()).toEqual([
      "archived",
      "blocked",
      "completed",
      "failed",
      "stopped",
      "superseded",
    ]);
  });
});
