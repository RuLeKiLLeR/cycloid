// ARC-1330 (W11-P2) — the canonical PR-label projection helpers (fsm/label-projection.ts).
//
// Keystone proofs this suite pins:
//   1. NO ILLEGAL MULTI-LABEL COMBO is representable through the canonical writer. The writer applies
//      `reconcileFsmLabelSet(current, labelsOf(record))`, so the managed labels on the PR become EXACTLY
//      `labelsOf(record)` — even starting from a PR carrying every managed label at once (the worst
//      legacy drift), the reconcile collapses the managed axis to the single coherent projected set.
//   2. PARITY vs all three legacy lists: the managed namespace is a SUPERSET of every label the three
//      legacy writers can produce, so a canonical reconcile tears every one of them down; and the
//      legacy-derived projection maps the §12 rename table faithfully over a fixture matrix.
//   3. The §12 renames: `ci-fix-exhausted` is reachable (via `NEEDS_YOU{ci_fix_exhausted}`) and
//      `review-loop:ci-red` is in the strip set but NEVER emitted by `labelsOf`.

import { describe, expect, it } from "vitest";

import {
  CI_FIX_EXHAUSTED_LABEL,
  E2E_TESTED_LABEL,
  INTERNAL_ERROR_LABEL,
  OWNER_APPROVAL_LABEL,
  REVIEW_STUCK_LABEL,
} from "../../../apps/control-plane-worker/src/constants/pr-labels";

// PR-E1: the review-loop:* / verification-* label constants are SCRAPPED. `labelsOf` never emits them,
// but they stay in the managed (strip) set as INLINE LITERALS so the reconcile tears them off in-flight
// PRs — asserted here via the same literals.
const VERIFICATION_PENDING_LABEL = "verification-pending";
const VERIFICATION_IN_PROGRESS_LABEL = "verification-in-progress";
const VERIFICATION_DONE_LABEL = "verification-done";
const VERIFICATION_SKIPPED_LABEL = "verification-skipped";
const VERIFICATION_STOPPED_LABEL = "verification-stopped";
const VERIFICATION_EXHAUSTED_LABEL = "verification-exhausted";
const VERIFICATION_NEEDS_WORK_LABEL = "verification-needs-work";
const REVIEW_LOOP_DONE_LABEL = "review-loop:done";
const REVIEW_LOOP_CI_RED_LABEL = "review-loop:ci-red";
import {
  FSM_MANAGED_LABELS,
  labelsForPersistedRecord,
  reconcileFsmLabelSet,
} from "../../../apps/control-plane-worker/src/session/fsm/label-projection";
import { labelsOf } from "../../../apps/control-plane-worker/src/session/fsm/project";
import {
  type BlockedReason,
  FSM_STATES,
  type FsmRecord,
  type FsmState,
  type Verdict,
} from "../../../apps/control-plane-worker/src/session/fsm/types";
import type { PrCoordinationRecord } from "../../../apps/control-plane-worker/src/session/pr-coordination-db";

const VERDICTS: readonly (Verdict | null)[] = ["pass", "app_breaks", "skipped", "none", null];
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

function rec(state: FsmState, over: Partial<FsmRecord> = {}): FsmRecord {
  return { state, verdict: null, blockedReason: null, ...over } as FsmRecord;
}

// The three mutually-exclusive verification-* labels: a coherent projection carries at most one.
const EXCLUSIVE_VERIFICATION = new Set<string>([
  VERIFICATION_IN_PROGRESS_LABEL,
  VERIFICATION_DONE_LABEL,
  VERIFICATION_NEEDS_WORK_LABEL,
]);

// The full legacy union the three writers own (the parity strip set). Verification axis + review-loop.
const LEGACY_LABEL_UNION: readonly string[] = [
  VERIFICATION_PENDING_LABEL,
  VERIFICATION_IN_PROGRESS_LABEL,
  VERIFICATION_DONE_LABEL,
  VERIFICATION_SKIPPED_LABEL,
  VERIFICATION_STOPPED_LABEL,
  VERIFICATION_EXHAUSTED_LABEL,
  REVIEW_LOOP_DONE_LABEL,
  REVIEW_LOOP_CI_RED_LABEL,
];

describe("W11-P2 label-projection — keystone #1: no illegal multi-label combo", () => {
  it("every projected set over the full (state × verdict × blocked_reason) matrix is coherent", () => {
    for (const state of FSM_STATES) {
      for (const verdict of VERDICTS) {
        for (const blockedReason of [null, ...BLOCKED_REASONS]) {
          const labels = labelsOf(rec(state, { verdict, blockedReason }));
          const set = new Set(labels);
          // Every label is managed (no unmanaged label can be projected).
          for (const label of labels) expect(FSM_MANAGED_LABELS.has(label)).toBe(true);
          // No duplicates.
          expect(set.size).toBe(labels.length);
          // At most one of the mutually-exclusive verification labels (PR-E1: `labelsOf` now emits NONE).
          expect([...set].filter((l) => EXCLUSIVE_VERIFICATION.has(l)).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("the writer collapses even a PR carrying EVERY managed label to the single coherent projected set", () => {
    // The worst possible legacy drift: the PR already has every managed label at once + a user label.
    const worstDrift = [...FSM_MANAGED_LABELS, "cycloid", "team:frontend"];
    for (const state of FSM_STATES) {
      const desired = labelsOf(rec(state, { verdict: "app_breaks", blockedReason: "ci_fix_exhausted" }));
      const { next } = reconcileFsmLabelSet(worstDrift, desired);
      const managedOnNext = next.filter((l) => FSM_MANAGED_LABELS.has(l));
      // The managed axis is EXACTLY the projected set — every stale/illegal label is gone.
      expect([...managedOnNext].sort()).toEqual([...desired].sort());
      // Non-managed labels survive untouched.
      expect(next).toContain("cycloid");
      expect(next).toContain("team:frontend");
    }
  });
});

describe("W11-P2 label-projection — keystone #2: parity vs the three legacy lists", () => {
  it("the managed namespace is a superset of every label the three legacy writers produce", () => {
    for (const label of LEGACY_LABEL_UNION) {
      expect(FSM_MANAGED_LABELS.has(label)).toBe(true);
    }
  });
});

describe("W11-P2 label-projection — keystone #3: §12 renames", () => {
  it("ci-fix-exhausted is reachable via NEEDS_YOU{ci_fix_exhausted}; ci_flapping shares it", () => {
    expect(labelsOf(rec("NEEDS_YOU", { blockedReason: "ci_fix_exhausted" }))).toEqual([CI_FIX_EXHAUSTED_LABEL]);
    expect(labelsOf(rec("NEEDS_YOU", { blockedReason: "ci_flapping" }))).toEqual([CI_FIX_EXHAUSTED_LABEL]);
  });

  it("the renamed-away review-loop:ci-red is in the strip set but is NEVER emitted by labelsOf", () => {
    expect(FSM_MANAGED_LABELS.has(REVIEW_LOOP_CI_RED_LABEL)).toBe(true);
    for (const state of FSM_STATES) {
      for (const verdict of VERDICTS) {
        for (const blockedReason of [null, ...BLOCKED_REASONS]) {
          expect(labelsOf(rec(state, { verdict, blockedReason }))).not.toContain(REVIEW_LOOP_CI_RED_LABEL);
        }
      }
    }
  });

  it("terminal states project the EMPTY managed set (the close-out strip: §12 'cleared' cells)", () => {
    // The W11-P2 close-out cutover relies on this: labelsOf on a terminal record is [], so the
    // canonical reconcile strips the FULL managed axis on merged/closed PRs (incl. verification-*).
    for (const state of ["MERGED", "CLOSED", "SUPERSEDED", "ARCHIVED"] as const) {
      for (const verdict of VERDICTS) {
        expect(labelsOf(rec(state, { verdict })), state).toEqual([]);
      }
    }
  });

  it("the net-new blocked_reason labels reach their NEEDS_YOU states", () => {
    expect(labelsOf(rec("NEEDS_YOU", { blockedReason: "owner_approval" }))).toEqual([OWNER_APPROVAL_LABEL]);
    expect(labelsOf(rec("NEEDS_YOU", { blockedReason: "review_stuck" }))).toEqual([REVIEW_STUCK_LABEL]);
    expect(labelsOf(rec("NEEDS_YOU", { blockedReason: "internal_inconsistency" }))).toEqual([INTERNAL_ERROR_LABEL]);
    // PR-E1: the four (now unreachable) verification_* reasons re-point onto the loud internal-error label.
    for (const r of [
      "verification_noconverge",
      "verification_unresolved",
      "verification_run_limit",
      "verification_stopped",
    ] as const) {
      expect(labelsOf(rec("NEEDS_YOU", { blockedReason: r }))).toEqual([INTERNAL_ERROR_LABEL]);
    }
  });

  it("the scrapped legacy labels stay in the managed strip set (torn down from in-flight PRs)", () => {
    expect(FSM_MANAGED_LABELS.has("verification-done")).toBe(true);
    expect(FSM_MANAGED_LABELS.has("review-loop:done")).toBe(true);
    expect(FSM_MANAGED_LABELS.has("verification-in-progress")).toBe(true);
    expect(FSM_MANAGED_LABELS.has("verification-needs-work")).toBe(true);
  });

  it("keeps the sticky E2E-Tested signal outside the FSM-managed strip set", () => {
    expect(FSM_MANAGED_LABELS.has(E2E_TESTED_LABEL)).toBe(false);
  });
});

describe("W11-P2 label-projection — reconcileFsmLabelSet", () => {
  it("preserves non-managed labels, strips stale managed labels, adds the desired set", () => {
    const current = ["cycloid", VERIFICATION_EXHAUSTED_LABEL, REVIEW_LOOP_CI_RED_LABEL];
    const desired = [VERIFICATION_IN_PROGRESS_LABEL];
    const r = reconcileFsmLabelSet(current, desired);
    expect(r.changed).toBe(true);
    expect(r.added).toEqual([VERIFICATION_IN_PROGRESS_LABEL]);
    expect(r.removed.sort()).toEqual([REVIEW_LOOP_CI_RED_LABEL, VERIFICATION_EXHAUSTED_LABEL].sort());
    expect(r.next).toContain("cycloid");
    expect(r.next.filter((l) => FSM_MANAGED_LABELS.has(l))).toEqual([VERIFICATION_IN_PROGRESS_LABEL]);
  });

  it("is a no-op when the managed axis already matches (empty desired, no managed present)", () => {
    const r = reconcileFsmLabelSet(["cycloid", "team:x"], []);
    expect(r.changed).toBe(false);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("is a no-op when desired already exactly matches the managed labels present", () => {
    const r = reconcileFsmLabelSet(
      ["cycloid", REVIEW_LOOP_DONE_LABEL, VERIFICATION_DONE_LABEL],
      [REVIEW_LOOP_DONE_LABEL, VERIFICATION_DONE_LABEL],
    );
    expect(r.changed).toBe(false);
  });
});

describe("W11-P2 label-projection — labelsForPersistedRecord", () => {
  function persisted(over: Partial<PrCoordinationRecord>): PrCoordinationRecord {
    return {
      sessionId: "s",
      version: 1,
      state: "REVIEW",
      prUrl: "p",
      headSha: "h",
      verdict: null,
      verdictHeadSha: null,
      verificationRunHead: null,
      verificationRunId: 0,
      verificationChildId: null,
      verificationRunCount: 0,
      ciFixRounds: 0,
      inFlightEpochId: null,
      codeChangedSinceVerification: false,
      promptIntendsChange: null,
      mergeReadyReopenCount: 0,
      blockedReason: null,
      failureReason: null,
      stopMode: null,
      preStopState: null,
      updateBranchQueuedAt: null,
      deadlineAt: null,
      stateEnteredAt: null,
      ...over,
    };
  }

  it("projects a persisted row's labels via labelsOf (PR-E1: review-loop/verification labels scrapped)", () => {
    expect(labelsForPersistedRecord(persisted({ state: "VERIFYING" }))).toEqual([]);
    expect(labelsForPersistedRecord(persisted({ state: "MERGE_READY" }))).toEqual([]);
    expect(labelsForPersistedRecord(persisted({ state: "REVIEW", verdict: "app_breaks" }))).toEqual([]);
    // The NEEDS_YOU terminal labels still project.
    expect(labelsForPersistedRecord(persisted({ state: "NEEDS_YOU", blockedReason: "ci_fix_exhausted" }))).toEqual([
      CI_FIX_EXHAUSTED_LABEL,
    ]);
  });

  it("throws LOUDLY on an unknown persisted state (the writer catches + skips)", () => {
    expect(() => labelsForPersistedRecord(persisted({ state: "NONSENSE" }))).toThrow(/unknown FSM state/);
  });
});
