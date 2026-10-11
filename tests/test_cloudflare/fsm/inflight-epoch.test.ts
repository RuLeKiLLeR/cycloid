// PR 24 — `in_flight_epoch_id` + inc anchor (§17-B). Pure-fn suite proving the in-flight-epoch model:
// every `dispatch_epoch` edge stamps `in_flight_epoch_id` under the SAME CAS as the dispatch (so the
// `no_inflight_epoch` guard flips in lockstep), every epoch terminal CLEARS it, and the two coupled
// soundness properties the design names:
//   • the commit→dispatch window can't double-count `ci_fix_rounds` (a re-fired CI signal while an
//     epoch is in flight is a `log_noop` — no second inc, no second dispatch);
//   • inc/reset mutual exclusion in one `applyEvent` — a ciFix dispatch leaves `in_flight_epoch_id`
//     non-null, so the resulting state reads `no_inflight_epoch=false` and the conditional
//     `reset_ci_fix_rounds` universal post-action (PR 20) CANNOT also fire, so the inc survives.
// `transition` is a pure function of (state, event, guards), so this imports it directly — no DB harness.
import { describe, expect, it } from "vitest";

import { noInflightEpoch } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import { applyCiFixResetPostAction } from "../../../apps/control-plane-worker/src/session/fsm/post-actions";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { Decision, FsmEvent, FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";

const NEW_EPOCH = "epoch-new-42";

// A fully-populated guard bag; each case overrides only the conjuncts its edge reads. `noInflightEpoch`
// defaults true (so a dispatch edge actually dispatches) and `newEpochId` is the pre-allocated id the
// spine would mint; the dispatch sites stamp it into `in_flight_epoch_id`.
const BASE: Guards = {
  sandboxAlive: true,
  noInflightEpoch: true,
  newEpochId: NEW_EPOCH,
  underCiFixCap: true,
  ciFixRounds: 0,
  epoch1Fired: false,
  actionableExists: true,
  ciSettled: true,
  codeChangedSinceVerification: false,
  reviewSourceId: "rs-1",
  committedHead: "head-c",
  underMergeReadyReopenCap: true,
  mergeReadyReopenCount: 0,
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...BASE, ...over });

const hasDispatch = (d: Decision): boolean => d.sideEffects.some((e) => e.kind === "dispatch_epoch");

// Every (state, event) that DISPATCHES an epoch — the complete set of `dispatch_epoch` sites across the
// REVIEW / MERGE_READY / NEEDS_YOU edges. Each must stamp `in_flight_epoch_id := newEpochId` (the §17-B
// "set under the same CAS as dispatch_epoch" contract).
const DISPATCH_EDGES: ReadonlyArray<{ from: FsmState; event: FsmEvent; over?: Partial<Guards> }> = [
  { from: "REVIEW", event: { type: "ci.signal", ciState: "failing" } }, // ciFix self-loop
  { from: "REVIEW", event: { type: "ci.signal", ciState: "green" } }, // CI-settled epoch-1
  { from: "REVIEW", event: { type: "review.received", reviewerKind: "bot", actionable: true } }, // eager epoch-1
  { from: "REVIEW", event: { type: "review.item_ready", itemId: "i1" } }, // released item
  { from: "MERGE_READY", event: { type: "review.received", reviewerKind: "bot", actionable: true } }, // re-open
  { from: "MERGE_READY", event: { type: "ci.signal", ciState: "failing" } }, // red-CI flap re-open
  { from: "NEEDS_YOU", event: { type: "review.received", reviewerKind: "bot", actionable: true } }, // re-open
];

describe("§17-B — every dispatch_epoch edge stamps in_flight_epoch_id under the same CAS", () => {
  it.each(DISPATCH_EDGES)(
    "$from / $event.type → dispatch_epoch ∧ in_flight_epoch_id := newEpochId",
    ({ from, event, over }) => {
      const d = transition(from, event, g(over));
      expect(d).not.toBeNull();
      expect(hasDispatch(d!)).toBe(true);
      expect(d!.fieldWrites.inFlightEpochId).toBe(NEW_EPOCH);
      // The committed non-null id flips the guard false in the RESULTING state (lockstep with dispatch).
      expect(noInflightEpoch(d!.fieldWrites.inFlightEpochId ?? null)).toBe(false);
    },
  );

  it("a NON-dispatching edge (an epoch already in flight) does NOT stamp in_flight_epoch_id", () => {
    // review.received[actionable] with an epoch in flight registers only — no dispatch, no id stamp.
    const d = transition(
      "REVIEW",
      { type: "review.received", reviewerKind: "bot", actionable: true },
      g({ noInflightEpoch: false }),
    );
    expect(hasDispatch(d!)).toBe(false);
    expect(d!.fieldWrites).not.toHaveProperty("inFlightEpochId");
  });
});

describe("§17-B — every epoch terminal clears in_flight_epoch_id", () => {
  const TERMINALS: ReadonlyArray<FsmEvent> = [
    { type: "epoch.committed", epochId: "e1" },
    { type: "epoch.replied", epochId: "e2" },
    { type: "epoch.declined", epochId: "e3" },
    { type: "epoch.blocked", epochId: "e4", reason: "owner_approval", trigger: "review" },
  ];
  it.each(TERMINALS)("%o clears in_flight_epoch_id := null (re-arms no_inflight_epoch)", (event) => {
    const d = transition("REVIEW", event, g());
    expect(d).not.toBeNull();
    expect(d!.fieldWrites.inFlightEpochId).toBeNull();
    expect(noInflightEpoch(d!.fieldWrites.inFlightEpochId ?? null)).toBe(true);
  });
});

describe("§17-B — inc anchor: inc_ci_fix_rounds rides the NULL→non-null transition", () => {
  it("a ciFix dispatch sets BOTH ci_fix_rounds (inc) AND in_flight_epoch_id in ONE Decision (one CAS)", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g({ ciFixRounds: 1 }));
    expect(d!.fieldWrites.ciFixRounds).toBe(2);
    expect(d!.fieldWrites.inFlightEpochId).toBe(NEW_EPOCH);
  });

  it("commit→dispatch window can't double-count: a re-fired CI signal while an epoch is in flight is a log_noop (no second inc, no second dispatch, no id overwrite)", () => {
    const inFlight = transition(
      "REVIEW",
      { type: "ci.signal", ciState: "failing" },
      g({ noInflightEpoch: false, ciFixRounds: 2 }),
    );
    expect(inFlight!.to).toBe("REVIEW");
    expect(inFlight!.sideEffects).toEqual([{ kind: "log_noop" }]);
    expect(inFlight!.fieldWrites).not.toHaveProperty("ciFixRounds");
    expect(inFlight!.fieldWrites).not.toHaveProperty("inFlightEpochId");
  });
});

describe("§17-B — inc/reset mutual exclusion in one applyEvent (in_flight_epoch_id is the read-source)", () => {
  it("a ciFix dispatch's resulting state reads no_inflight_epoch=false → the conditional reset_ci_fix_rounds CANNOT fire (the inc survives)", () => {
    // 1. The dispatch incs ci_fix_rounds AND stamps in_flight_epoch_id in the SAME Decision.
    const dispatch = transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g({ ciFixRounds: 1 }));
    expect(dispatch!.fieldWrites.ciFixRounds).toBe(2);
    // 2. The RESULTING no_inflight_epoch is derived from the freshly-written id — non-null → false.
    const resultingNoInflight = noInflightEpoch(dispatch!.fieldWrites.inFlightEpochId ?? null);
    expect(resultingNoInflight).toBe(false);
    // 3. So even at ci_green, the PR-20 conditional reset (gated on ci_green ∧ no_inflight_epoch) leaves
    //    the Decision UNCHANGED — the inc and the reset are mutually exclusive in one applyEvent.
    const out = applyCiFixResetPostAction(dispatch!, { ciGreen: true, noInflightEpoch: resultingNoInflight });
    expect(out.fieldWrites.ciFixRounds).toBe(2);
  });

  it("contrast: an epoch terminal clears the id → resulting no_inflight_epoch=true → a ci_green reset DOES apply", () => {
    const committed = transition("REVIEW", { type: "epoch.committed", epochId: "e1" }, g({ ciFixRounds: 3 }));
    const resultingNoInflight = noInflightEpoch(committed!.fieldWrites.inFlightEpochId ?? null);
    expect(resultingNoInflight).toBe(true);
    const out = applyCiFixResetPostAction(committed!, { ciGreen: true, noInflightEpoch: resultingNoInflight });
    expect(out.fieldWrites.ciFixRounds).toBe(0);
  });
});
