// ARC-1330 (PR 30) — the `stageSection` surface of `project(record)` + the exposed `stageOf(record)`
// (design §12 "Stage copy" / §18.3 stage taxonomy).
//
// The contract this PR lands:
//   1. `stageOf(record)` is TOTAL over every one of the 16 spine states (incl. `ARCHIVED`, N8) AND over
//      every `blocked_reason` in the closed enum — no input falls through to `undefined`.
//   2. The §12 "Stage copy" mapping is exact, in the product's `verification` voice (design's conceptual
//      "QA" copy → "Testing the app" / "Fixing verification findings").
//   3. The single `REVIEW` state splits into its three §12 sub-stages from RECORD FIELDS (not states):
//      `ci_fix_rounds > 0` → "Fixing CI"; else `verdict=app_breaks` → "Fixing verification findings";
//      else → "Addressing reviews".
//   4. `ANSWERED_NO_PR` folds in the PR 27 `prompt_intends_change` split.
//   5. `project(record).stageSection` threads the record through `stageOf`.
import { describe, expect, it } from "vitest";

import { FSM_STATES, project, stageOf } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type {
  BlockedReason,
  FsmRecord,
  FsmState,
  Verdict,
} from "../../../apps/control-plane-worker/src/session/fsm/types";

// A minimal record for the stage surface: `state` (+ the fields the REVIEW/ANSWERED splits read).
function rec(state: FsmState, over: Partial<FsmRecord> = {}): FsmRecord {
  return { state, verdict: null, ciFixRounds: 0, promptIntendsChange: null, ...over } as FsmRecord;
}

// The §12 "Stage copy" table as an INDEPENDENT local oracle. `REVIEW` is field-dependent (covered
// separately); this is the expectation for the verdict/round-independent rest. `MERGED`/`CLOSED` are the
// §12 "—" cleared cells → empty copy.
const EXPECTED_BASE: Record<FsmState, string> = {
  CREATED: "Starting",
  PROVISIONING: "Starting",
  GENERATING: "Working",
  AWAITING_INPUT: "Needs your input",
  FINALIZING: "Finalizing / Opening PR",
  PUBLISHING: "Finalizing / Opening PR",
  ANSWERED_NO_PR: "Answered", // prompt_intends_change null/false; the =true split is covered below
  REVIEW: "Cycloid is working on the review", // ci_fix_rounds=0 ∧ verdict≠app_breaks
  VERIFYING: "Testing the app",
  MERGE_READY: "Ready to merge — watching for reviews",
  NEEDS_YOU: "Blocked — needs you",
  FAILED: "Session failed",
  STOPPED: "Stopped",
  MERGED: "",
  CLOSED: "",
  SUPERSEDED: "",
  ARCHIVED: "Archived",
};

// The closed `blocked_reason` enum (design §12 / tech-spec §4) — a local oracle for the totality sweep.
const BLOCKED_REASONS: readonly BlockedReason[] = [
  "owner_approval",
  "verification_noconverge",
  "verification_unresolved",
  "verification_run_limit",
  "verification_stopped",
  "ci_fix_exhausted",
  "ci_flapping",
  "review_stuck",
  "internal_inconsistency",
];

describe("stageOf — record → stage copy projection (design §12, totality incl. ARCHIVED)", () => {
  it("is total over the 16 spine states (no fall-through to undefined)", () => {
    expect(FSM_STATES).toHaveLength(17);
    for (const state of FSM_STATES) {
      const stage = stageOf(rec(state));
      expect(stage, `stageOf(${state}) must be defined`).toBeDefined();
      expect(typeof stage, `stageOf(${state}) must be a string`).toBe("string");
    }
  });

  it("is total over every state × blocked_reason (the closed enum, SF10) — never undefined", () => {
    for (const state of FSM_STATES) {
      for (const blockedReason of BLOCKED_REASONS) {
        const stage = stageOf(rec(state, { blockedReason }));
        expect(stage, `stageOf(${state}, ${blockedReason}) must be a defined string`).toBeDefined();
        expect(typeof stage).toBe("string");
      }
    }
  });

  it.each(FSM_STATES.map((s) => [s] as const))("%s → the §12 base stage copy", (state) => {
    expect(stageOf(rec(state))).toBe(EXPECTED_BASE[state]);
  });

  it("NEEDS_YOU with no blocked_reason → the generic blocked copy (defensive fallback)", () => {
    expect(stageOf(rec("NEEDS_YOU"))).toBe("Blocked — needs you");
  });

  it("NEEDS_YOU splices the per-reason copy after 'Blocked — needs you: ' for EVERY blocked_reason (PR 33)", () => {
    // The §12 total map is asserted exhaustively in project-blocked-reason.test.ts; here we only pin
    // that stageOf threads it (prefix + a defined non-empty per-reason suffix) for every enum value.
    for (const blockedReason of BLOCKED_REASONS) {
      const stage = stageOf(rec("NEEDS_YOU", { blockedReason }));
      expect(stage.startsWith("Blocked — needs you: "), `stageOf(NEEDS_YOU,${blockedReason})`).toBe(true);
      expect(stage.length).toBeGreaterThan("Blocked — needs you: ".length);
    }
  });

  it("MERGED/CLOSED → empty copy (the §12 '—' cleared cell, N8)", () => {
    expect(stageOf(rec("MERGED"))).toBe("");
    expect(stageOf(rec("CLOSED"))).toBe("");
  });
});

describe("stageOf — REVIEW sub-stage split from record fields (one state, three §12 copies)", () => {
  it("ci_fix_rounds > 0 → 'Fixing CI' (active/last epoch = ciFix), even with a verdict present", () => {
    expect(stageOf(rec("REVIEW", { ciFixRounds: 1 }))).toBe("Fixing CI");
    // ciFix precedence wins over the verdict per the §12 table order.
    expect(stageOf(rec("REVIEW", { ciFixRounds: 2, verdict: "app_breaks" }))).toBe("Fixing CI");
  });

  it("ci_fix_rounds = 0 ∧ verdict = app_breaks → 'Fixing verification findings' (design 'Fixing QA findings')", () => {
    expect(stageOf(rec("REVIEW", { ciFixRounds: 0, verdict: "app_breaks" }))).toBe("Fixing verification findings");
  });

  it.each(["pass", "skipped", "none"] as const)(
    "ci_fix_rounds = 0 ∧ verdict = %s → 'Cycloid is working on the review'",
    (verdict: Verdict) => {
      expect(stageOf(rec("REVIEW", { ciFixRounds: 0, verdict }))).toBe("Cycloid is working on the review");
    },
  );

  it("ci_fix_rounds = 0 ∧ verdict = null → 'Cycloid is working on the review'", () => {
    expect(stageOf(rec("REVIEW", { ciFixRounds: 0, verdict: null }))).toBe("Cycloid is working on the review");
  });
});

describe("stageOf — ANSWERED_NO_PR folds in the PR 27 prompt_intends_change split", () => {
  it("prompt_intends_change = true → 'No change produced'", () => {
    expect(stageOf(rec("ANSWERED_NO_PR", { promptIntendsChange: true }))).toBe("No change produced");
  });

  it.each([false, null] as const)("prompt_intends_change = %s → 'Answered'", (intends) => {
    expect(stageOf(rec("ANSWERED_NO_PR", { promptIntendsChange: intends }))).toBe("Answered");
  });
});

describe("project(record).stageSection — aggregate surface threads the record → stageOf", () => {
  it.each(FSM_STATES.map((s) => [s] as const))("project({ state: %s }).stageSection matches stageOf", (state) => {
    expect(project(rec(state)).stageSection).toBe(stageOf(rec(state)));
  });

  it("project surfaces the REVIEW ciFix sub-stage through the aggregate too", () => {
    expect(project(rec("REVIEW", { ciFixRounds: 1 })).stageSection).toBe("Fixing CI");
  });
});
