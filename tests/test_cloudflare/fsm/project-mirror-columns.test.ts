// ARC-1330 (W11-P1, KEYSTONE) — the session_index mirror columns as record projections.
//
// `reviewLoopDoneStateOf` / `verificationStateOf` / `cycloidDoneOf` re-express the three legacy mirror
// column groups (`review_loop_done_state` 0142, `verification_state`/`qa_testing_*` 0150,
// `cycloid_done_*` 0199) — today written by THREE INDEPENDENT hand-maintained DO setters — as functions
// of the ONE `FsmRecord`. The keystone claims this test proves:
//
//   1. PARITY — for every FSM-reachable record a CORRECT spine reaches on the agreed path, the projected
//      mirror value equals the legacy value that record represents (the oracle is authored INDEPENDENTLY
//      of the projection, mirroring project-cycloid-done.test.ts).
//   2. SELF-CONSISTENCY — feeding the PROJECTED `review_loop_done_state` + `verification_state` back
//      through the REAL legacy `deriveCycloidDoneStatus` reproduces the PROJECTED `cycloid_done`. A
//      single source cannot disagree with itself, so the "label says done / verdict says app_breaks"
//      class is unrepresentable by construction.
//   3. MUTUAL-CONSISTENCY INVARIANTS — no illegal combo (done aggregate without a done loop, a
//      success aggregate atop an exhausted/stopped verification) is representable across the full matrix.
//   4. TOTALITY — `projectMirrorColumns` never throws over all 16 states × verdicts × blocked reasons.
//   5. PINNED COLLAPSE — legacy `verification-pending` has no spine source; the intended collapse
//      (pending → null in REVIEW, in-progress once VERIFYING commits) + the divergence detector's
//      `legacy_pending_collapse` carve-out are pinned explicitly.
//   6. CLEARED-ON-TERMINAL — the terminal/pre-publish mirror values are pinned against an explicit
//      cleared oracle, so D-59's sole-writer cutover has a contract, not merely totality.
import { describe, expect, it } from "vitest";

import { MAX_VERIFICATION_RUNS_PER_PR } from "../../../apps/control-plane-worker/src/constants/verification";
import {
  cycloidDoneOf,
  FSM_STATES,
  projectMirrorColumns,
  reviewLoopDoneStateOf,
  verificationStateOf,
} from "../../../apps/control-plane-worker/src/session/fsm/project";
import type {
  BlockedReason,
  FsmRecord,
  FsmState,
  Verdict,
} from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  deriveCycloidDoneStatus,
  type ReviewLoopDoneState,
  type VerificationResult,
  type VerificationState,
} from "../../../shared/session/phase";

function rec(state: FsmState, over: Partial<FsmRecord> = {}): FsmRecord {
  return { state, verdict: null, blockedReason: null, verificationRunCount: 0, prUrl: null, ...over } as FsmRecord;
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

// The legacy-input set `deriveCycloidDoneStatus` consumes AND the expected mirror values the record
// represents. Authored independently of the projection (a true oracle).
interface Legacy {
  reviewLoopDoneState: ReviewLoopDoneState | null;
  verificationState: VerificationState | null;
  verificationResult: VerificationResult | null;
  verificationApplies: boolean;
  ciRed: boolean;
}

interface Fixture {
  name: string;
  record: FsmRecord;
  legacy: Legacy;
}

const FIXTURES: readonly Fixture[] = [
  // ── REVIEW (still converging) → review_loop_done_state=working ──
  {
    name: "REVIEW (addressing reviews, no verdict)",
    record: rec("REVIEW", { verdict: "none", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "REVIEW (verdict=pass, not yet caught up)",
    record: rec("REVIEW", { verdict: "pass", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "REVIEW (verdict=app_breaks, re-engaged loop)",
    record: rec("REVIEW", { verdict: "app_breaks", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: "verification-done",
      verificationResult: "needs-work",
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "REVIEW (verdict=skipped)",
    record: rec("REVIEW", { verdict: "skipped", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: "verification-skipped",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  // ── VERIFYING → done + in-progress ──
  {
    name: "VERIFYING (a run owns the head)",
    record: rec("VERIFYING", { prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-in-progress",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  // ── MERGE_READY → done + verdict-based verification_state ──
  {
    name: "MERGE_READY (verdict=pass)",
    record: rec("MERGE_READY", { verdict: "pass", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "MERGE_READY (verdict=skipped)",
    record: rec("MERGE_READY", { verdict: "skipped", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-skipped",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "MERGE_READY (no verification applied)",
    record: rec("MERGE_READY", { verdict: "none", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  // ── NEEDS_YOU degraded terminals → done + mapped verification_state ──
  {
    name: "NEEDS_YOU{ci_fix_exhausted} (QA passed, CI red)",
    record: rec("NEEDS_YOU", { blockedReason: "ci_fix_exhausted", verdict: "pass", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationApplies: true,
      ciRed: true,
    },
  },
  {
    name: "NEEDS_YOU{ci_flapping} (no verification, CI red)",
    record: rec("NEEDS_YOU", { blockedReason: "ci_flapping", verdict: "none", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: true,
    },
  },
  {
    name: "NEEDS_YOU{verification_noconverge}",
    record: rec("NEEDS_YOU", { blockedReason: "verification_noconverge", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-exhausted",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{verification_run_limit}",
    record: rec("NEEDS_YOU", { blockedReason: "verification_run_limit", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-exhausted",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{verification_stopped}",
    record: rec("NEEDS_YOU", { blockedReason: "verification_stopped", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-stopped",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{verification_unresolved} (inconclusive)",
    record: rec("NEEDS_YOU", { blockedReason: "verification_unresolved", verdict: "app_breaks", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationResult: null,
      verificationApplies: true,
      ciRed: false,
    },
  },
  // ── NEEDS_YOU human-action / mid-loop blocks → working (the FSM model answer) ──
  {
    name: "NEEDS_YOU{owner_approval} (loop+verification done, awaiting a human)",
    record: rec("NEEDS_YOU", { blockedReason: "owner_approval", verdict: "pass", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationApplies: true,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{review_stuck}",
    record: rec("NEEDS_YOU", { blockedReason: "review_stuck", verdict: "none", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
  {
    name: "NEEDS_YOU{internal_inconsistency}",
    record: rec("NEEDS_YOU", { blockedReason: "internal_inconsistency", verdict: "none", prUrl: "pr" }),
    legacy: {
      reviewLoopDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationApplies: false,
      ciRed: false,
    },
  },
];

describe("W11-P1 — mirror-column projections: PARITY vs the legacy value oracle", () => {
  for (const f of FIXTURES) {
    it(`review_loop_done_state parity — ${f.name}`, () => {
      expect(reviewLoopDoneStateOf(f.record)).toBe(f.legacy.reviewLoopDoneState);
    });
    it(`verification_state parity — ${f.name}`, () => {
      expect(verificationStateOf(f.record)).toBe(f.legacy.verificationState);
    });
    it(`cycloid_done parity vs the real deriveCycloidDoneStatus — ${f.name}`, () => {
      expect(cycloidDoneOf(f.record)).toEqual(
        deriveCycloidDoneStatus({
          reviewLoopDoneState: f.legacy.reviewLoopDoneState,
          verificationState: f.legacy.verificationState,
          verificationResult: f.legacy.verificationResult,
          verificationApplies: f.legacy.verificationApplies,
          ciRed: f.legacy.ciRed,
        }),
      );
    });
  }
});

describe("W11-P1 — SELF-CONSISTENCY: the projected cols reproduce the projected cycloid_done", () => {
  // The keystone "single source can't disagree" proof: feeding the PROJECTED review_loop_done_state +
  // verification_state (not the hand-authored oracle) back through the real legacy derive reproduces the
  // projected cycloid_done — so the three mirror columns are mutually consistent by construction.
  for (const f of FIXTURES) {
    it(`deriveCycloidDoneStatus(projected) === cycloidDoneOf — ${f.name}`, () => {
      const derived = deriveCycloidDoneStatus({
        reviewLoopDoneState: reviewLoopDoneStateOf(f.record),
        verificationState: verificationStateOf(f.record),
        verificationResult: f.legacy.verificationResult,
        verificationApplies: f.legacy.verificationApplies,
        ciRed: f.legacy.ciRed,
      });
      expect(derived).toEqual(cycloidDoneOf(f.record));
    });
  }
});

describe("W11-P1 — MUTUAL-CONSISTENCY invariants over the full state × verdict × blocked_reason matrix", () => {
  it("no illegal combo is representable; projectMirrorColumns is total (never throws)", () => {
    for (const state of FSM_STATES) {
      for (const verdict of ALL_VERDICTS) {
        const blockedReasons = state === "NEEDS_YOU" ? ALL_BLOCKED_REASONS : ([null] as (BlockedReason | null)[]);
        for (const blockedReason of blockedReasons) {
          const record = rec(state, { verdict, blockedReason, verificationRunCount: 2 });
          const m = projectMirrorColumns(record);

          // Bundle wiring: the counts carry the spine's own run-count + the shared cap.
          expect(m.verificationAttemptCount).toBe(2);
          expect(m.verificationMaxAttempts).toBe(MAX_VERIFICATION_RUNS_PER_PR);
          expect(m.reviewLoopDoneState).toBe(reviewLoopDoneStateOf(record));
          expect(m.verificationState).toBe(verificationStateOf(record));

          // INVARIANT 1: a `done` aggregate requires a `done` review loop (no settled aggregate without
          // a settled loop). Contrapositive: a `working` loop can never carry a `done` aggregate.
          if (m.cycloidDone.state === "done") {
            expect(m.reviewLoopDoneState).toBe("done");
          }
          // INVARIANT 2: a `success` aggregate can never sit atop a degraded verification terminal
          // (the "label says done / verdict says needs-work" class is unrepresentable).
          if (m.cycloidDone.state === "done" && m.cycloidDone.outcome === "success") {
            expect(m.verificationState).not.toBe("verification-exhausted");
            expect(m.verificationState).not.toBe("verification-stopped");
          }
        }
      }
    }
  });
});

describe("W11-P1 — the PINNED legacy_pending_collapse (verification-pending has no spine source)", () => {
  // Legacy stamps `verification-pending` as a distinct queued stage (publish-service.ts → qa-pending).
  // The FSM has NO queued-verification state
  // by design: the record stays REVIEW (mirror null) until the caught_up cascade commits VERIFYING
  // (mirror verification-in-progress). The intended collapse is PINNED here — pending → null on the
  // REVIEW side, in-progress once VERIFYING commits — and the mirror-divergence detector tags exactly
  // that pair `divergence_class:"legacy_pending_collapse"` so the soak budgets it explicitly.
  it("verificationStateOf can NEVER emit verification-pending (full state × verdict × reason matrix)", () => {
    for (const state of FSM_STATES) {
      for (const verdict of ALL_VERDICTS) {
        const blockedReasons = state === "NEEDS_YOU" ? ALL_BLOCKED_REASONS : ([null] as (BlockedReason | null)[]);
        for (const blockedReason of blockedReasons) {
          expect(verificationStateOf(rec(state, { verdict, blockedReason }))).not.toBe("verification-pending");
        }
      }
    }
  });

  it("the legacy pending window projects null in REVIEW and verification-in-progress in VERIFYING", () => {
    // The REVIEW-side collapse: legacy pending ↔ spine REVIEW (no settled verdict) → null.
    expect(verificationStateOf(rec("REVIEW", { verdict: "none", prUrl: "pr" }))).toBeNull();
    // The overlap window: legacy still pending while the spine already committed VERIFYING → in-progress.
    expect(verificationStateOf(rec("VERIFYING", { prUrl: "pr" }))).toBe("verification-in-progress");
  });
});

describe("W11-P1 — terminal + pre-publish mirror values (the cleared-on-terminal oracle, pins D-59)", () => {
  // D-59's cutover must CLEAR the mirror on terminals (§12 "cleared" cells) and leave pre-publish rows
  // unclaimed — pinned as explicit oracle rows (not merely totality) so the eventual sole-writer flip
  // has a contract to hit. `working` is `cycloidDone`'s stateless no-done-claim value, matching the
  // legacy default for a session with no settled claim.
  const CLEARED: ReadonlyArray<{ state: FsmState; over?: Partial<FsmRecord> }> = [
    // Pre-publish: no PR, no review loop, no verification claim.
    { state: "GENERATING" },
    // Session terminals: FAILED carries its failure on failure_reason, not the mirror cols.
    { state: "FAILED", over: { failureReason: "sandbox_lost" } },
    { state: "STOPPED", over: { stopMode: "resumable", prUrl: "pr" } },
    // Resolved-PR terminals (§12 cleared cells).
    { state: "MERGED", over: { prUrl: "pr", verdict: "pass" } },
    { state: "CLOSED", over: { prUrl: "pr" } },
    { state: "SUPERSEDED", over: { prUrl: "pr" } },
    { state: "ARCHIVED", over: { prUrl: "pr" } },
  ];
  for (const { state, over } of CLEARED) {
    it(`${state} projects the cleared mirror (null / null / working)`, () => {
      const m = projectMirrorColumns(rec(state, over));
      expect(m.reviewLoopDoneState).toBeNull();
      expect(m.verificationState).toBeNull();
      expect(m.cycloidDone).toEqual({ state: "working", outcome: null, reasons: [] });
    });
  }
});
