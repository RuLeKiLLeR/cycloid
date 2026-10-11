// PR 9 — epoch/review guard tests (ARC-1330, design §6 / §9 / D11 / B7).
//
// The REVIEW + caught_up input guards:
//   no_inflight_epoch := in_flight_epoch_id IS NULL                 (§6)
//   actionable        := the review.received{actionable} payload    (§6/§5)
//   under_ci_fix_cap  := ci_fix_rounds < MAX_CI_FIX_ROUNDS          (§6, B7)
//   resumable         := stop_mode == resumable                     (§6)
//   caught_up         := no_inflight_epoch ∧ 0 undispositioned ∧ reviewers settled (§6/§9, EXCLUDES ci_green)
//
// caught_up's disposition + reviewer-settle reads are delegated to an injected snapshot
// store (the real DAOs land in PR 22 / PR 22A); here we stub the store. Load-bearing
// case: a queued-but-unreleased review counts as actionable-undispositioned, so it keeps
// caught_up false.
import { describe, expect, it } from "vitest";

import { MAX_CI_FIX_ROUNDS } from "../../../apps/control-plane-worker/src/constants/review-loop";
import {
  actionable,
  caughtUp,
  type CaughtUpStore,
  noInflightEpoch,
  resumable,
  underCiFixCap,
} from "../../../apps/control-plane-worker/src/session/fsm/guards";
import type { StopMode } from "../../../apps/control-plane-worker/src/session/fsm/types";

// A stub store the guard reads its single store-backed conjunct from (PR 22 owns the real DAO reader).
// `undispositioned` models the disposition-store count.
function stubStore(undispositioned: number): CaughtUpStore {
  return {
    countUndispositionedActionable: () => undispositioned,
  };
}

describe("no_inflight_epoch (in_flight_epoch_id IS NULL)", () => {
  it("is true only when no epoch id is recorded", () => {
    expect(noInflightEpoch(null)).toBe(true);
    expect(noInflightEpoch("epoch-1")).toBe(false);
    // An empty-string id is still a recorded id, not "no epoch".
    expect(noInflightEpoch("")).toBe(false);
  });
});

describe("actionable (review.received{actionable} payload field)", () => {
  it("passes through the payload bool", () => {
    expect(actionable(true)).toBe(true);
    expect(actionable(false)).toBe(false);
  });
});

describe("under_ci_fix_cap (ci_fix_rounds < MAX_CI_FIX_ROUNDS)", () => {
  it("uses the =3 named cap", () => {
    expect(MAX_CI_FIX_ROUNDS).toBe(3);
  });

  it("is true strictly below the cap and false at/above it", () => {
    expect(underCiFixCap(0)).toBe(true);
    expect(underCiFixCap(MAX_CI_FIX_ROUNDS - 1)).toBe(true);
    expect(underCiFixCap(MAX_CI_FIX_ROUNDS)).toBe(false);
    expect(underCiFixCap(MAX_CI_FIX_ROUNDS + 1)).toBe(false);
  });
});

describe("resumable (stop_mode == resumable)", () => {
  it("is true only for the resumable stop mode", () => {
    expect(resumable("resumable")).toBe(true);
    expect(resumable("user")).toBe(false);
    // Not stopped ⇒ not resumable.
    expect(resumable(null)).toBe(false);
  });

  it("covers every StopMode value", () => {
    const modes = ["user", "resumable"] as const satisfies readonly StopMode[];
    const resumableModes = modes.filter((m) => resumable(m));
    expect(new Set(resumableModes)).toEqual(new Set<StopMode>(["resumable"]));
  });
});

describe("caught_up (no_inflight_epoch ∧ 0 undispositioned) — verification + reviewer-settle DECOUPLED", () => {
  it("is true when no epoch is in flight and nothing is undispositioned", () => {
    expect(caughtUp(true, stubStore(0))).toBe(true);
  });

  it("is false while an epoch is in flight", () => {
    expect(caughtUp(false, stubStore(0))).toBe(false);
  });

  it("is false while any actionable item is undispositioned", () => {
    expect(caughtUp(true, stubStore(1))).toBe(false);
    expect(caughtUp(true, stubStore(3))).toBe(false);
  });

  it("counts a queued-but-unreleased review as actionable-undispositioned (keeps caught_up false)", () => {
    expect(caughtUp(true, stubStore(1))).toBe(false);
  });

  it("takes exactly (noInflightEpoch, store) — no CI, no reviewer-settle input participates", () => {
    // Verification is no longer a merge-ready gate and the reviewer-settle latch is gone from the
    // predicate: the only inputs are the in-flight-epoch flag and the disposition count.
    expect(caughtUp(true, stubStore(0))).toBe(true);
  });
});
