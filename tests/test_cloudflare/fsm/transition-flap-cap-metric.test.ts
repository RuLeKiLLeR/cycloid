// PR 26 (§17-D / tech-spec Locked decision 5b): the MERGE_READY⇄REVIEW flap cap emits a DEDICATED
// `emit_cap_trip` count metric when it trips, so the bound (`MAX_MERGE_READY_REOPENS`) can be retuned
// post-shadow from the live trip rate. Pure-fn suite: `transition` is a pure function of (state, event,
// guards), so these assert the returned Decision's `sideEffects` directly — no DB harness. The cap routing
// itself (→ NEEDS_YOU{ci_flapping}) is owned by PR 18's terminal-reentry suite; this file pins the METRIC:
// it rides ONLY the trip terminal (not the under-cap re-opens) and carries the cap name + the limit it
// tripped at.
import { describe, expect, it } from "vitest";

import { MAX_MERGE_READY_REOPENS } from "../../../apps/control-plane-worker/src/constants/review-loop";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { SideEffect } from "../../../apps/control-plane-worker/src/session/fsm/types";

const BASE: Guards = {
  sandboxAlive: true,
  newEpochId: "epoch-flap-1",
  ciFixRounds: 0,
  mergeReadyReopenCount: 0,
  underMergeReadyReopenCap: true,
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...BASE, ...over });

const RED_CI = { type: "ci.signal", ciState: "failing" } as const;
const EMIT_CAP_TRIP: SideEffect = {
  kind: "emit_cap_trip",
  args: { cap: "merge_ready_reopen", limit: MAX_MERGE_READY_REOPENS },
};

const capTrips = (effects: readonly SideEffect[]): boolean => effects.some((e) => e.kind === "emit_cap_trip");

describe("PR 26 — MERGE_READY flap cap emits a cap-trip metric (§17-D / decision 5b)", () => {
  it("at/over the cap, the trip Decision carries `emit_cap_trip{ cap, limit }` alongside `loud`", () => {
    const d = transition("MERGE_READY", RED_CI, g({ underMergeReadyReopenCap: false }));
    expect(d?.to).toBe("NEEDS_YOU");
    expect(d?.fieldWrites).toEqual({ blockedReason: "ci_flapping" });
    expect(d?.sideEffects).toContainEqual(EMIT_CAP_TRIP);
    // The metric names the tripped cap and the value it tripped at (the retune signal's tags).
    const trip = d?.sideEffects.find((e) => e.kind === "emit_cap_trip");
    expect(trip?.args).toEqual({ cap: "merge_ready_reopen", limit: MAX_MERGE_READY_REOPENS });
  });

  it("a normal under-cap red re-open does NOT emit the cap-trip metric (it re-opens to REVIEW)", () => {
    const d = transition("MERGE_READY", RED_CI, g({ mergeReadyReopenCount: 2, underMergeReadyReopenCap: true }));
    expect(d?.to).toBe("REVIEW");
    expect(capTrips(d?.sideEffects ?? [])).toBe(false);
  });

  it("metric emitted exactly once — on the (N+1)-th flap, never on the N allowed re-opens", () => {
    let count = 0;
    let tripCount = 0;
    let reopenCount = 0;
    for (let i = 0; i < MAX_MERGE_READY_REOPENS + 1; i++) {
      const underCap = count < MAX_MERGE_READY_REOPENS;
      const d = transition(
        "MERGE_READY",
        RED_CI,
        g({ mergeReadyReopenCount: count, underMergeReadyReopenCap: underCap }),
      );
      if (d?.to === "REVIEW") {
        reopenCount += 1;
        // No metric on the allowed re-opens — only the trip is a retune signal.
        expect(capTrips(d.sideEffects)).toBe(false);
        count = (d.fieldWrites.mergeReadyReopenCount as number) ?? count;
      } else if (capTrips(d?.sideEffects ?? [])) {
        tripCount += 1;
      }
    }
    expect(reopenCount).toBe(MAX_MERGE_READY_REOPENS);
    expect(tripCount).toBe(1);
  });
});
