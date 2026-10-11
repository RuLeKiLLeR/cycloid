// ARC-1330 (PR 31) — the `feChip` surface of `project(record)` + the exposed `feChipOf(state)`
// (design §12 `fe_chip`, the session-view/websocket sidebar-pill wire field).
//
// The contract this PR lands:
//   1. `feChipOf(state)` is TOTAL over every one of the 16 spine states (incl. `ARCHIVED`, N8) — no
//      state falls through to `undefined`, and every result is a real `FeChip` member.
//   2. The chip is exactly the FE's existing phase→pill collapse `flattenStatus(phaseOf(state))`
//      (`apps/ui/src/utils/status-display.ts`): `running`/`finalizing → working`, `blocked → failed`,
//      the rest pass through. This is the parity proof — the projection reproduces what the FE renders
//      today client-side, so the FE can read the record instead (design §12).
//   3. The spine never emits `idle` (the pre-session-only chip).
//   4. `project(record).feChip` threads the record's `state` through that mapping.
import { describe, expect, it } from "vitest";

import type { FeChip } from "../../../apps/control-plane-worker/src/session/fsm/project";
import { feChipOf, FSM_STATES, phaseOf, project } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { FsmRecord, FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";

// The exact §12 state → FE chip table. Kept as a local literal (NOT imported from the impl) so the test
// is an independent oracle: a drift in the impl's mapping fails here.
const EXPECTED: Record<FsmState, FeChip> = {
  CREATED: "working",
  PROVISIONING: "working",
  GENERATING: "working",
  AWAITING_INPUT: "waiting_for_input",
  FINALIZING: "working",
  PUBLISHING: "working",
  ANSWERED_NO_PR: "completed",
  REVIEW: "review_listening",
  VERIFYING: "review_listening",
  MERGE_READY: "completed",
  NEEDS_YOU: "failed",
  FAILED: "failed",
  STOPPED: "stopped",
  MERGED: "completed",
  CLOSED: "completed",
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
};

const ALL_CHIPS: ReadonlySet<FeChip> = new Set<FeChip>([
  "working",
  "waiting_for_input",
  "review_listening",
  "completed",
  "superseded",
  "failed",
  "idle",
  "stopped",
  "archived",
]);

// The FE's `flattenStatus` (apps/ui/src/utils/status-display.ts), inlined as an INDEPENDENT oracle so
// the parity assertion (feChip === flattenStatus(phase)) does not depend on importing UI code into the
// worker test. A drift on either side fails here.
function flattenStatus(phase: string): FeChip {
  switch (phase) {
    case "archived":
      return "archived";
    case "stopped":
      return "stopped";
    case "running":
    case "finalizing":
      return "working";
    case "waiting_for_input":
      return "waiting_for_input";
    case "completed":
      return "completed";
    case "review_listening":
      return "review_listening";
    case "superseded":
      return "superseded";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

describe("feChipOf — state → FE chip projection (design §12, totality incl. ARCHIVED)", () => {
  it("maps every one of the 16 spine states (no fall-through)", () => {
    expect(FSM_STATES).toHaveLength(17);
    for (const state of FSM_STATES) {
      const chip = feChipOf(state);
      expect(chip, `feChipOf(${state}) must be defined`).toBeDefined();
      expect(ALL_CHIPS.has(chip), `feChipOf(${state})=${chip} must be a real FeChip`).toBe(true);
    }
  });

  it.each(FSM_STATES.map((s) => [s] as const))("%s → the §12 table chip", (state) => {
    expect(feChipOf(state)).toBe(EXPECTED[state]);
  });

  it.each(FSM_STATES.map((s) => [s] as const))(
    "%s chip equals flattenStatus(phase) — FE-render parity (design §12)",
    (state) => {
      expect(feChipOf(state)).toBe(flattenStatus(phaseOf(state)));
    },
  );

  it("never emits `idle` (the pre-session-only chip has no spine source)", () => {
    for (const state of FSM_STATES) {
      expect(feChipOf(state), `${state} must not project the pre-session idle chip`).not.toBe("idle");
    }
  });

  it("collapses the multi-phase pills: running/finalizing → working, blocked → failed", () => {
    expect(feChipOf("CREATED")).toBe("working"); // running
    expect(feChipOf("FINALIZING")).toBe("working"); // finalizing
    expect(feChipOf("PUBLISHING")).toBe("working"); // finalizing
    expect(feChipOf("NEEDS_YOU")).toBe("failed"); // blocked
  });

  it("ARCHIVED → archived (N8 — terminal totality)", () => {
    expect(feChipOf("ARCHIVED")).toBe("archived");
  });
});

describe("project(record).feChip — aggregate surface threads state → feChip", () => {
  it.each(FSM_STATES.map((s) => [s] as const))("project({ state: %s }).feChip matches feChipOf", (state) => {
    // Only `state` is read for this surface; cast a minimal record (other surfaces read more fields).
    const record = { state } as FsmRecord;
    expect(project(record).feChip).toBe(feChipOf(state));
  });
});
