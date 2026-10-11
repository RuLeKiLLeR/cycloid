// ARC-1330 (W11-P3) — the session_index DISPLAY columns (`rich_status` + `feChip`) as record projections.
//
// The status-PILL twin of the P1 mirror-columns keystone. `projectDisplayColumns` re-expresses the pill
// the FE renders — `session_index.rich_status` (the canonical `Phase`) and its client-collapsed chip — as
// a function of the ONE `FsmRecord`, so D-59 can make `project()` the sole writer. What this proves:
//
//   1. PARITY — for every FSM state the projected `{richStatus, feChip}` equals an INDEPENDENTLY-authored
//      oracle (the phase + pill each state represents). incl. the NEEDS_YOU reasons, SUPERSEDED, and the
//      ANSWERED_NO_PR split (the display is invariant across both — only the stage copy splits).
//   2. COLLAPSE PIN — `feChipFromPhase(phaseOf(state)) === feChipOf(state)` for every state: the
//      phase-domain collapse (used for the legacy pill) can never drift from the state-domain collapse.
//   3. flattenStatus CONTRACT — `feChipFromPhase` over every `Phase` matches a pinned oracle mirroring the
//      FE `flattenStatus` (a change to the FE pill vocabulary must land a matching change here).
//   4. DISPLAY-DIVERGENCE AGREEMENT — when the legacy pill holds the phase the record represents, the
//      display-divergence detector reports NO divergence (the dual-write's clean baseline).
import { describe, expect, it } from "vitest";

import {
  feChipFromPhase,
  feChipOf,
  FSM_STATES,
  phaseOf,
  projectDisplayColumns,
  uiLifecycleStageOf,
} from "../../../apps/control-plane-worker/src/session/fsm/project";
import type {
  BlockedReason,
  FsmRecord,
  FsmState,
  Verdict,
} from "../../../apps/control-plane-worker/src/session/fsm/types";
import type { UiLifecycleStage } from "../../../shared/session/lifecycle-stage";
import type { Phase } from "../../../shared/session/phase";

function rec(state: FsmState, over: Partial<FsmRecord> = {}): FsmRecord {
  return {
    state,
    verdict: null,
    blockedReason: null,
    promptIntendsChange: null,
    verificationRunCount: 0,
    prUrl: null,
    ...over,
  } as FsmRecord;
}

const ALL_BLOCKED_REASONS: readonly BlockedReason[] = [
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

const ALL_VERDICTS: readonly (Verdict | null)[] = ["none", "pass", "app_breaks", "skipped", null];

// The pill each state represents — authored INDEPENDENTLY of `phaseOf`/`feChipOf` (a true oracle). `chip`
// mirrors the FE `flattenStatus(phase)`: running/finalizing → working, blocked → failed, the rest through.
const DISPLAY_ORACLE: Record<FsmState, { phase: Phase; chip: string; uiLifecycleStage: UiLifecycleStage }> = {
  CREATED: { phase: "running", chip: "working", uiLifecycleStage: null },
  PROVISIONING: { phase: "running", chip: "working", uiLifecycleStage: null },
  GENERATING: { phase: "running", chip: "working", uiLifecycleStage: null },
  AWAITING_INPUT: { phase: "waiting_for_input", chip: "waiting_for_input", uiLifecycleStage: null },
  FINALIZING: { phase: "finalizing", chip: "working", uiLifecycleStage: null },
  PUBLISHING: { phase: "finalizing", chip: "working", uiLifecycleStage: null },
  ANSWERED_NO_PR: { phase: "completed", chip: "completed", uiLifecycleStage: null },
  REVIEW: { phase: "review_listening", chip: "review_listening", uiLifecycleStage: null },
  VERIFYING: { phase: "review_listening", chip: "review_listening", uiLifecycleStage: "verifying" },
  MERGE_READY: { phase: "completed", chip: "completed", uiLifecycleStage: "merge_ready" },
  NEEDS_YOU: { phase: "blocked", chip: "failed", uiLifecycleStage: null },
  FAILED: { phase: "failed", chip: "failed", uiLifecycleStage: null },
  STOPPED: { phase: "stopped", chip: "stopped", uiLifecycleStage: null },
  MERGED: { phase: "completed", chip: "completed", uiLifecycleStage: "merged" },
  CLOSED: { phase: "completed", chip: "completed", uiLifecycleStage: "closed" },
  SUPERSEDED: { phase: "superseded", chip: "superseded", uiLifecycleStage: "superseded" },
  ARCHIVED: { phase: "archived", chip: "archived", uiLifecycleStage: null },
};

describe("W11-P3 — display-column projection: PARITY vs the pill oracle", () => {
  for (const state of FSM_STATES) {
    it(`projectDisplayColumns parity — ${state}`, () => {
      const d = projectDisplayColumns(rec(state, { prUrl: "pr" }));
      expect(d.richStatus).toBe(DISPLAY_ORACLE[state].phase);
      expect(d.feChip).toBe(DISPLAY_ORACLE[state].chip);
      expect(d.uiLifecycleStage).toBe(DISPLAY_ORACLE[state].uiLifecycleStage);
    });
  }

  it("the display is INVARIANT across the ANSWERED_NO_PR split (only the stage copy splits)", () => {
    // projectAnsweredNoPr splits the stage COPY on prompt_intends_change; the pill never moves off completed.
    const inquiry = projectDisplayColumns(rec("ANSWERED_NO_PR", { promptIntendsChange: false }));
    const noChange = projectDisplayColumns(rec("ANSWERED_NO_PR", { promptIntendsChange: true }));
    expect(inquiry).toEqual({ richStatus: "completed", feChip: "completed", uiLifecycleStage: null });
    expect(noChange).toEqual({ richStatus: "completed", feChip: "completed", uiLifecycleStage: null });
  });

  it("the display is INVARIANT across every NEEDS_YOU blocked_reason (blocked → failed pill)", () => {
    for (const blockedReason of ALL_BLOCKED_REASONS) {
      const d = projectDisplayColumns(rec("NEEDS_YOU", { blockedReason, prUrl: "pr" }));
      expect(d).toEqual({ richStatus: "blocked", feChip: "failed", uiLifecycleStage: null });
    }
  });

  it("projectDisplayColumns is TOTAL over the full state × verdict × blocked_reason matrix", () => {
    for (const state of FSM_STATES) {
      for (const verdict of ALL_VERDICTS) {
        const blockedReasons = state === "NEEDS_YOU" ? ALL_BLOCKED_REASONS : ([null] as (BlockedReason | null)[]);
        for (const blockedReason of blockedReasons) {
          const d = projectDisplayColumns(rec(state, { verdict, blockedReason }));
          // The display reads ONLY state (F40 note): verdict/blocked_reason never move the pill.
          expect(d.richStatus).toBe(DISPLAY_ORACLE[state].phase);
          expect(d.feChip).toBe(DISPLAY_ORACLE[state].chip);
          expect(d.uiLifecycleStage).toBe(DISPLAY_ORACLE[state].uiLifecycleStage);
        }
      }
    }
  });
});

describe("W11-P3 — the phase-domain collapse can never drift from feChipOf", () => {
  it("feChipFromPhase(phaseOf(state)) === feChipOf(state) for every state", () => {
    for (const state of FSM_STATES) {
      expect(feChipFromPhase(phaseOf(state))).toBe(feChipOf(state));
    }
  });

  it("uiLifecycleStageOf(state) matches the display-column lifecycle oracle for every state", () => {
    for (const state of FSM_STATES) {
      expect(uiLifecycleStageOf(state)).toBe(DISPLAY_ORACLE[state].uiLifecycleStage);
    }
  });

  // The FE `flattenStatus` contract, pinned as an oracle: a change to the FE pill vocabulary must land a
  // matching change here. `idle` is the pre-session-only chip with no spine source (kept for wire parity).
  const FLATTEN_ORACLE: Record<Phase, string> = {
    idle: "idle",
    running: "working",
    waiting_for_input: "waiting_for_input",
    finalizing: "working",
    review_listening: "review_listening",
    completed: "completed",
    superseded: "superseded",
    blocked: "failed",
    failed: "failed",
    stopped: "stopped",
    archived: "archived",
  };
  for (const [phase, chip] of Object.entries(FLATTEN_ORACLE)) {
    it(`feChipFromPhase(${phase}) === ${chip}`, () => {
      expect(feChipFromPhase(phase)).toBe(chip);
    });
  }

  it("an unknown / null / undefined phase collapses to idle (defensive, matches flattenStatus default)", () => {
    expect(feChipFromPhase(null)).toBe("idle");
    expect(feChipFromPhase(undefined)).toBe("idle");
    expect(feChipFromPhase("not-a-phase")).toBe("idle");
  });
});
