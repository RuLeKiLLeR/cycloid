// ARC-1330 (PR 28) — the `project(record)` skeleton + the `phase` surface (design §12).
//
// The contract this PR lands:
//   1. `phaseOf(state)` is TOTAL over every one of the 16 spine states (incl. `ARCHIVED`, N8) — no
//      state falls through to `undefined`, and every result is a real `Phase` member.
//   2. The §12 table mapping is exact (the design's conceptual `QA` is `VERIFYING` → `review_listening`,
//      reusing the existing Phase — no new member is introduced).
//   3. `project(record)` threads the record's `state` through that mapping (the aggregate surface this
//      PR populates; PRs 29–32 add the remaining fields).
import { describe, expect, it } from "vitest";

import { FSM_STATES, phaseOf, project } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { FsmRecord, FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";
import type { Phase } from "../../../shared/session/phase";

// The exact §12 state → Phase table. Kept as a local literal (NOT imported from the impl) so the test
// is an independent oracle: a drift in the impl's mapping fails here.
const EXPECTED: Record<FsmState, Phase> = {
  CREATED: "running",
  PROVISIONING: "running",
  GENERATING: "running",
  AWAITING_INPUT: "waiting_for_input",
  FINALIZING: "finalizing",
  PUBLISHING: "finalizing",
  ANSWERED_NO_PR: "completed",
  REVIEW: "review_listening",
  VERIFYING: "review_listening",
  MERGE_READY: "completed",
  NEEDS_YOU: "blocked",
  FAILED: "failed",
  STOPPED: "stopped",
  MERGED: "completed",
  CLOSED: "completed",
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
};

const ALL_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "idle",
  "running",
  "waiting_for_input",
  "finalizing",
  "review_listening",
  "completed",
  "superseded",
  "blocked",
  "failed",
  "stopped",
  "archived",
]);

describe("phaseOf — state → Phase projection (design §12, totality incl. ARCHIVED)", () => {
  it("maps every one of the 16 spine states (no fall-through)", () => {
    // FSM_STATES is the closed union; iterating it proves totality at runtime (the const Record proves
    // it at compile time). 16 is the locked count.
    expect(FSM_STATES).toHaveLength(17);
    for (const state of FSM_STATES) {
      const phase = phaseOf(state);
      expect(phase, `phaseOf(${state}) must be defined`).toBeDefined();
      expect(ALL_PHASES.has(phase), `phaseOf(${state})=${phase} must be a real Phase`).toBe(true);
    }
  });

  it.each(FSM_STATES.map((s) => [s] as const))("%s → the §12 table phase", (state) => {
    expect(phaseOf(state)).toBe(EXPECTED[state]);
  });

  it("ARCHIVED → archived (N8 — terminal totality)", () => {
    expect(phaseOf("ARCHIVED")).toBe("archived");
  });

  it("VERIFYING (design QA) → review_listening (reuses the existing Phase, no new member)", () => {
    expect(phaseOf("VERIFYING")).toBe("review_listening");
  });
});

describe("project(record) — aggregate surface threads state → phase", () => {
  it.each(FSM_STATES.map((s) => [s] as const))("project({ state: %s }).phase matches phaseOf", (state) => {
    // Only `state` is read this PR; cast a minimal record (later PRs read more typed fields).
    const record = { state } as FsmRecord;
    expect(project(record).phase).toBe(phaseOf(state));
  });
});
