// KEYSTONE test for the ARC-1330 lifecycle-FSM `REVIEW.caught_up` cascade AFTER the CI-ladder cut
// (verification decoupled from the merge-ready gate). Pure-fn suite: `transition` is a pure function of
// (state, event, guards), so these import it directly and assert the returned Decision — no DB harness.
//
// The cascade is now a PURE CI LADDER over the 3-valued live-read bucket (FG-4), gated by
// `no_inflight_epoch` at the green rung:
//   ci_red   ∧ under_ci_fix_cap  → REVIEW / inc_ci_fix_rounds, set_in_flight_epoch, dispatch_epoch(ci_fix)
//   ci_red   ∧ ¬under_ci_fix_cap → NEEDS_YOU(ci_fix_exhausted) / loud
//   ci_pending                   → REVIEW / log_noop            (the WAIT rung)
//   ci_green ∧ no_inflight_epoch → MERGE_READY / reset_ci_fix_rounds, emit_settle, notify_user
//   ci_green ∧ ¬no_inflight      → REVIEW / log_noop            (stale-green WAIT, W11-T1)
// Verification (pass/fresh/cap) and code_changed no longer participate — those columns are GONE from
// the cascade. MERGE_READY is emitted from the ci_green rung ALONE (the sole emitter, D10).
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";

const HEAD = "head-cascade";
const CIFIX_ROUNDS = 1;
const NEW_EPOCH = "epoch-cascade-1";
const CAUGHT_UP: FsmEvent = { type: "caught_up", headSha: HEAD };

// A fully-populated cascade guard bag; each test overrides the bucket / cap / no_inflight it exercises.
const base = (over: Partial<Guards> = {}): Guards => ({
  sandboxAlive: true,
  noInflightEpoch: true,
  ciBucket: "ci_pending",
  underCiFixCap: true,
  ciFixRounds: CIFIX_ROUNDS,
  newEpochId: NEW_EPOCH,
  ...over,
});

describe("REVIEW.caught_up — pure CI ladder (verification decoupled)", () => {
  it("ci_red ∧ under_ci_fix_cap → REVIEW / inc_ci_fix_rounds, set_in_flight_epoch, dispatch_epoch(ci_fix)", () => {
    const d = transition("REVIEW", CAUGHT_UP, base({ ciBucket: "ci_red", underCiFixCap: true }));
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { ciFixRounds: CIFIX_ROUNDS + 1, inFlightEpochId: NEW_EPOCH },
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }],
    });
  });

  it("ci_red ∧ ¬under_ci_fix_cap → NEEDS_YOU(ci_fix_exhausted) / loud", () => {
    const d = transition("REVIEW", CAUGHT_UP, base({ ciBucket: "ci_red", underCiFixCap: false }));
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "ci_fix_exhausted" },
      sideEffects: [{ kind: "loud" }],
    });
  });

  it("ci_pending → REVIEW / log_noop (the WAIT rung)", () => {
    const d = transition("REVIEW", CAUGHT_UP, base({ ciBucket: "ci_pending" }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
  });

  it("ci_green ∧ no_inflight_epoch → MERGE_READY / reset_ci_fix_rounds, emit_settle, notify_user (sole emitter, D10)", () => {
    const d = transition("REVIEW", CAUGHT_UP, base({ ciBucket: "ci_green", noInflightEpoch: true }));
    expect(d).toEqual({
      to: "MERGE_READY",
      fieldWrites: { ciFixRounds: 0 },
      sideEffects: [{ kind: "emit_settle" }, { kind: "notify_user" }],
    });
  });

  it("ci_green ∧ in-flight epoch → REVIEW / log_noop (W11-T1 stale-green WAIT, never MERGE_READY)", () => {
    const d = transition("REVIEW", CAUGHT_UP, base({ ciBucket: "ci_green", noInflightEpoch: false }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
  });

  it("green with the no_inflight guard ABSENT → fail-safe WAIT, never MERGE_READY", () => {
    const guards = base({ ciBucket: "ci_green" }) as Guards & { noInflightEpoch?: boolean };
    delete guards.noInflightEpoch;
    const d = transition("REVIEW", CAUGHT_UP, guards);
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
  });

  it("a missing ciBucket defaults to ci_pending → WAIT (never a false MERGE_READY on an under-populated bag)", () => {
    const guards = base() as Guards & { ciBucket?: unknown };
    delete guards.ciBucket;
    const d = transition("REVIEW", CAUGHT_UP, guards as Guards);
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
  });

  it("verification columns are IGNORED: a code_changed / no-verdict green cell still mints MERGE_READY", () => {
    // Pre-cut this cell was cascade row 1 → VERIFYING. Post-cut verification is off-gate.
    const d = transition(
      "REVIEW",
      CAUGHT_UP,
      base({
        ciBucket: "ci_green",
        noInflightEpoch: true,
        codeChangedSinceVerification: true,
        verificationPass: false,
        verificationFresh: false,
        underVerificationCap: true,
      }),
    );
    expect(d?.to).toBe("MERGE_READY");
    expect(d?.sideEffects).not.toContainEqual({ kind: "spawn_verification_child" });
    expect(d?.fieldWrites.verificationRunCount).toBeUndefined();
  });

  it("DETERMINISM: re-evaluating any rung yields a deep-equal Decision (pure fn)", () => {
    for (const ci of ["ci_green", "ci_red", "ci_pending"] as const) {
      const g = base({ ciBucket: ci });
      expect(transition("REVIEW", CAUGHT_UP, g)).toEqual(transition("REVIEW", CAUGHT_UP, g));
    }
  });

  it("ci_red under cap with newEpochId ABSENT throws (an empty in_flight_epoch_id poisons no_inflight_epoch)", () => {
    const guards = base({ ciBucket: "ci_red", underCiFixCap: true }) as Guards & { newEpochId?: string };
    delete guards.newEpochId;
    expect(() => transition("REVIEW", CAUGHT_UP, guards)).toThrow(/newEpochId/);
  });
});

describe("REVIEW.caught_up cascade — handled only in REVIEW (no stray emitter)", () => {
  it("caught_up in a non-REVIEW state is unhandled → null (MERGE_READY has no other door)", () => {
    for (const state of ["VERIFYING", "MERGE_READY", "NEEDS_YOU", "PUBLISHING"] as const) {
      expect(transition(state, CAUGHT_UP, { sandboxAlive: true })).toBeNull();
    }
  });
});
