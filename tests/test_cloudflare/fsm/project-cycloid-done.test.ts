// ARC-1330 (PR 32) — the `cycloidDone` surface of `project(record)` + the exposed
// `cycloidDoneOf(record)` (design §12 `cycloid_done`).
//
// The contract this PR lands: `cycloidDoneOf` re-expresses the legacy `deriveCycloidDoneStatus`
// (`shared/session/phase.ts`) as a pure projection of the FSM record. The keystone test is PARITY: for
// each FSM-reachable record, the projection's `CycloidDoneStatus` deep-equals what the legacy fn
// produces for the legacy-input set that same record represents.
//
//   1. PARITY over a fixture matrix — each fixture pairs an FSM record with the legacy inputs it stands
//      for; `cycloidDoneOf(record)` must equal `deriveCycloidDoneStatus(legacyInputs)`.
//   2. TOTALITY over every one of the 16 states and the closed `blocked_reason` enum (D14/SF10) — no
//      input throws or returns an ill-formed status.
//   3. `project(record).cycloidDone` threads the record through `cycloidDoneOf`.
import { describe, expect, it } from "vitest";

import { cycloidDoneOf, FSM_STATES, project } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { BlockedReason, FsmRecord, FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  type CycloidDoneStatus,
  deriveCycloidDoneStatus,
  type VerificationResult,
  type VerificationState,
} from "../../../shared/session/phase";

// A minimal record for this surface: only `state` (+ `blockedReason` for the NEEDS_YOU split) is read.
function rec(state: FsmState, over: Partial<FsmRecord> = {}): FsmRecord {
  return { state, blockedReason: null, ...over } as FsmRecord;
}

// Every `blocked_reason` in the closed enum — pinned locally so a new enum value (which forces a
// decision in the impl's total map) also forces a totality case here.
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

// The legacy-input shape `deriveCycloidDoneStatus` consumes. Kept partial; the fixtures fill only the
// fields that matter for the case (the rest default to the legacy fn's own handling of null/false).
interface LegacyInputs {
  reviewLoopDoneState: "working" | "done" | null;
  verificationState: VerificationState | null;
  verificationResult: VerificationResult | null;
  verificationApplies: boolean;
  ciRed: boolean;
}

// One fixture = an FSM record + the legacy inputs that same record represents. The parity assertion is
// `cycloidDoneOf(record)` === `deriveCycloidDoneStatus(legacy)`. The legacy inputs are constructed
// INDEPENDENTLY of the projection (not derived from it) so the test is a true oracle.
interface Fixture {
  name: string;
  record: FsmRecord;
  legacy: LegacyInputs;
}

const FIXTURES: readonly Fixture[] = [
  // ── MERGE_READY → done/success (cascade settled clean; ci_green is a MERGE_READY precondition) ──
  {
    name: "MERGE_READY (verdict=pass) → done/success",
    record: rec("MERGE_READY", { verdict: "pass" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "MERGE_READY (verdict=skipped) → done/success",
    record: rec("MERGE_READY", { verdict: "skipped" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-skipped",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "MERGE_READY (no verification applied) → done/success",
    record: rec("MERGE_READY", { verdict: "none" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },

  // ── REVIEW / VERIFYING still listening → working ──
  {
    name: "REVIEW (addressing reviews) → working",
    record: rec("REVIEW", { verdict: null }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "REVIEW (verdict=app_breaks, re-engaged needs-work loop) → working",
    record: rec("REVIEW", { verdict: "app_breaks" }),
    legacy: {
      // a needs-work verdict re-engages the loop (still working) and is still awaiting (#5005).
      reviewLoopDoneState: "working",
      verificationState: "verification-done",
      verificationResult: "needs-work",
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "VERIFYING (verification in progress) → working",
    record: rec("VERIFYING"),
    legacy: {
      // loop caught up + dispatched verification → done-claim, but awaiting the verdict → working.
      reviewLoopDoneState: "done",
      verificationState: "verification-in-progress",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },

  // ── NEEDS_YOU degraded ci/verification terminals → done/needs_attention[<mapped legacy reason>] ──
  {
    name: "NEEDS_YOU{ci_fix_exhausted} → done/needs_attention[ci_red]",
    record: rec("NEEDS_YOU", { blockedReason: "ci_fix_exhausted" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: true,
    },
  },
  {
    name: "NEEDS_YOU{ci_flapping} → done/needs_attention[ci_red]",
    record: rec("NEEDS_YOU", { blockedReason: "ci_flapping" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: true,
    },
  },
  {
    name: "NEEDS_YOU{verification_noconverge} → done/needs_attention[verification_exhausted]",
    record: rec("NEEDS_YOU", { blockedReason: "verification_noconverge" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-exhausted",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{verification_run_limit} → done/needs_attention[verification_exhausted]",
    record: rec("NEEDS_YOU", { blockedReason: "verification_run_limit" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-exhausted",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{verification_stopped} → done/needs_attention[verification_stopped]",
    record: rec("NEEDS_YOU", { blockedReason: "verification_stopped" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-stopped",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{verification_unresolved} → done/needs_attention[verification_inconclusive]",
    record: rec("NEEDS_YOU", { blockedReason: "verification_unresolved" }),
    legacy: {
      // legacy `verification_inconclusive` = verification-done with a null (inconclusive) result.
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },

  // ── NEEDS_YOU mid-loop / human-action blocks → working (no legacy done-claim for these) ──
  {
    name: "NEEDS_YOU{owner_approval} → working (waiting on a human, loop not done)",
    record: rec("NEEDS_YOU", { blockedReason: "owner_approval" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{review_stuck} → working",
    record: rec("NEEDS_YOU", { blockedReason: "review_stuck" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{internal_inconsistency} → working",
    record: rec("NEEDS_YOU", { blockedReason: "internal_inconsistency" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },

  // ── pre-PR working spine → working ──
  {
    name: "CREATED (pre-PR) → working",
    record: rec("CREATED"),
    legacy: {
      reviewLoopDoneState: null,
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "GENERATING (pre-PR) → working",
    record: rec("GENERATING"),
    legacy: {
      reviewLoopDoneState: null,
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "ANSWERED_NO_PR (no-diff terminal) → working",
    record: rec("ANSWERED_NO_PR"),
    legacy: {
      reviewLoopDoneState: null,
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
];

describe("cycloidDoneOf — legacy `deriveCycloidDoneStatus` parity (design §12 `cycloid_done`)", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const projected = cycloidDoneOf(fixture.record);
    const legacy = deriveCycloidDoneStatus({
      reviewLoopDoneState: fixture.legacy.reviewLoopDoneState,
      verificationState: fixture.legacy.verificationState,
      verificationResult: fixture.legacy.verificationResult,
      verificationApplies: fixture.legacy.verificationApplies,
      ciRed: fixture.legacy.ciRed,
      currentReasons: [],
    });
    expect(projected).toEqual(legacy);
  });
});

function isValidStatus(s: CycloidDoneStatus): boolean {
  const stateOk = s.state === "working" || s.state === "done";
  const outcomeOk = s.outcome === null || s.outcome === "success" || s.outcome === "needs_attention";
  // working ⟺ outcome null; done ⟺ a real outcome.
  const coupling = s.state === "working" ? s.outcome === null : s.outcome !== null;
  // needs_attention ⟺ exactly one of the 4 legacy reasons; success/working ⟺ no reasons.
  const reasonCoupling = s.outcome === "needs_attention" ? s.reasons.length === 1 : s.reasons.length === 0;
  return stateOk && outcomeOk && coupling && reasonCoupling;
}

describe("cycloidDoneOf — totality over every state and the closed blocked_reason enum", () => {
  it("maps every one of the 16 states to a well-formed status (no throw / no fall-through)", () => {
    expect(FSM_STATES).toHaveLength(17);
    for (const state of FSM_STATES) {
      const status = cycloidDoneOf(rec(state));
      expect(isValidStatus(status), `cycloidDoneOf(${state}) ill-formed: ${JSON.stringify(status)}`).toBe(true);
    }
  });

  it("maps NEEDS_YOU over every blocked_reason to a well-formed status", () => {
    for (const reason of ALL_BLOCKED_REASONS) {
      const status = cycloidDoneOf(rec("NEEDS_YOU", { blockedReason: reason }));
      expect(isValidStatus(status), `NEEDS_YOU{${reason}} ill-formed: ${JSON.stringify(status)}`).toBe(true);
    }
  });

  it("only MERGE_READY and a degraded NEEDS_YOU ever project the `done` state", () => {
    for (const state of FSM_STATES) {
      if (state === "MERGE_READY" || state === "NEEDS_YOU") continue;
      expect(cycloidDoneOf(rec(state)).state, `${state} must not be done`).toBe("working");
    }
    // NEEDS_YOU is done only for the ci/verification-degraded reasons.
    const degraded: readonly BlockedReason[] = [
      "verification_noconverge",
      "verification_unresolved",
      "verification_run_limit",
      "verification_stopped",
      "ci_fix_exhausted",
      "ci_flapping",
    ];
    for (const reason of ALL_BLOCKED_REASONS) {
      const status = cycloidDoneOf(rec("NEEDS_YOU", { blockedReason: reason }));
      expect(status.state, `NEEDS_YOU{${reason}}`).toBe(degraded.includes(reason) ? "done" : "working");
    }
  });
});

describe("project(record).cycloidDone — aggregate surface threads the record → cycloidDoneOf", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s matches cycloidDoneOf", (_name, fixture) => {
    expect(project(fixture.record).cycloidDone).toEqual(cycloidDoneOf(fixture.record));
  });
});
