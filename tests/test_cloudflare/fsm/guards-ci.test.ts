// PR 7 — CI-ternary guard tests (ARC-1330, design §6 FG-4).
//
// The 4→3 partition table: `reduceCiState`'s four return values
// (`green | absent | failing | pending`) partition EXHAUSTIVELY and DISJOINTLY into
// the three cascade buckets (`ci_green | ci_red | ci_pending`). The compile-time proof
// (the `Record<ReviewLoopCiState, CiBucket>` total map) lives in guards.ts because
// `src/` is the only typechecked surface; this suite is the runtime mirror — it walks
// every CI state and asserts exactly ONE predicate is true (disjoint) and every state
// is covered (exhaustive).
import { describe, expect, it } from "vitest";

import type { ReviewLoopCiState } from "../../../apps/control-plane-worker/src/services/review-loop-rollup";
import {
  CI_BUCKET_OF,
  type CiBucket,
  ciGreen,
  ciPending,
  ciRed,
  classifyCi,
} from "../../../apps/control-plane-worker/src/session/fsm/guards";

// The four values reduceCiState can return (review-loop-rollup.ts:7). Kept as an
// explicit list so a drift between this table and the real CI states fails the
// coverage assertion below rather than silently under-testing.
const ALL_CI_STATES = ["green", "absent", "failing", "pending"] as const satisfies readonly ReviewLoopCiState[];

// The expected bucket per CI state (the design §6 / FG-4 mapping).
const PARTITION: ReadonlyArray<{ state: ReviewLoopCiState; bucket: CiBucket }> = [
  { state: "green", bucket: "ci_green" },
  { state: "absent", bucket: "ci_green" },
  { state: "failing", bucket: "ci_red" },
  { state: "pending", bucket: "ci_pending" },
];

describe("CI-ternary guards (FG-4 partition)", () => {
  it("covers every reduceCiState return value (exhaustive)", () => {
    // The partition table and CI_BUCKET_OF both enumerate exactly the 4 CI states.
    expect(new Set(PARTITION.map((r) => r.state))).toEqual(new Set(ALL_CI_STATES));
    expect(new Set(Object.keys(CI_BUCKET_OF))).toEqual(new Set(ALL_CI_STATES));
  });

  it("classifies each CI state to its single design bucket", () => {
    for (const { state, bucket } of PARTITION) {
      expect(classifyCi(state)).toBe(bucket);
      expect(CI_BUCKET_OF[state]).toBe(bucket);
    }
  });

  it("is disjoint: exactly one of ci_green/ci_red/ci_pending is true per state", () => {
    for (const { state, bucket } of PARTITION) {
      const truths = {
        ci_green: ciGreen(state),
        ci_red: ciRed(state),
        ci_pending: ciPending(state),
      };
      // Exactly one predicate fires...
      expect(Object.values(truths).filter(Boolean)).toHaveLength(1);
      // ...and it is the one this state partitions into.
      expect(truths[bucket]).toBe(true);
    }
  });

  it("ci_green covers BOTH green and absent (no-CI repo is not gating)", () => {
    expect(ciGreen("green")).toBe(true);
    expect(ciGreen("absent")).toBe(true);
    expect(ciGreen("failing")).toBe(false);
    expect(ciGreen("pending")).toBe(false);
  });

  it("¬ci_green is NOT synonymous with ci_red — pending is also ¬ci_green (FG-4)", () => {
    // The whole point of the ternary: a pending CI is neither green nor red, so a
    // `¬ci_green` binary would wrongly treat a still-running CI as a red.
    expect(ciGreen("pending")).toBe(false);
    expect(ciRed("pending")).toBe(false);
    expect(ciPending("pending")).toBe(true);
  });

  it("ci_red fires only on a genuine failing live-read", () => {
    expect(ciRed("failing")).toBe(true);
    for (const s of ["green", "absent", "pending"] as const) {
      expect(ciRed(s)).toBe(false);
    }
  });
});
