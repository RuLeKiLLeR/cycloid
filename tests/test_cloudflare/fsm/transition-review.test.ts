// Per-edge unit tests for the ARC-1330 lifecycle-FSM REVIEW non-cascade self-loops (PR 15,
// design §9). Pure-fn suite: `transition` is a pure function of (state, event, guards), so these
// import it directly and assert the returned Decision per edge — no DB harness. Scope: the
// CI ciFix/cap/green self-loops (folded PR 14), the CI-settled epoch-1 trigger + its late-check
// guard, the v8 EAGER epoch-1 dispatch for the actionable-review-present cohort, the eager
// review-epoch self-loops, the epoch terminals, the head edges (N4 noop totality), and the SOLE
// owner_approval path. The 8-row `caught_up` cascade is PR 16 and is NOT exercised here.
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";

// A fully-populated REVIEW guard bag; each test overrides only the conjuncts its edge reads.
const NEW_EPOCH = "epoch-new-1";
const REVIEW_BASE: Guards = {
  sandboxAlive: true,
  noInflightEpoch: true,
  newEpochId: NEW_EPOCH,
  underCiFixCap: true,
  ciFixRounds: 0,
  epoch1Fired: false,
  actionableExists: false,
  ciSettled: false,
  codeChangedSinceVerification: false,
  reviewSourceId: "review-src-1",
  committedHead: "newhead",
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...REVIEW_BASE, ...over });

describe("REVIEW — explicit verification request", () => {
  it("verification.requested[under_cap] → VERIFYING / request_verification without dispatching a side effect", () => {
    const d = transition(
      "REVIEW",
      { type: "verification.requested", headSha: "head-2" },
      g({ verificationRunCount: 1, verificationRunId: 7, underVerificationCap: true }),
    );

    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {
        headSha: "head-2",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        verificationRunCount: 2,
        verificationRunHead: "head-2",
        verificationRunId: 8,
        verificationChildId: null,
      },
      sideEffects: [],
    });
  });

  it("verification.requested[cap_exhausted] → NEEDS_YOU(verification_run_limit)", () => {
    const d = transition(
      "REVIEW",
      { type: "verification.requested", headSha: "head-2" },
      g({ underVerificationCap: false }),
    );

    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "verification_run_limit" },
      sideEffects: [{ kind: "notify_qa_issue" }],
    });
  });

  it("verification.requested[cap_exhausted + merge_conflict_bypass] → VERIFYING", () => {
    const d = transition(
      "REVIEW",
      { type: "verification.requested", headSha: "head-2", bypassRunLimitForMergeConflict: true },
      g({ verificationRunCount: 3, verificationRunId: 7, underVerificationCap: false }),
    );

    expect(d).toMatchObject({
      to: "VERIFYING",
      fieldWrites: {
        verificationRunCount: 4,
        verificationRunHead: "head-2",
        verificationRunId: 8,
      },
      sideEffects: [],
    });
  });
});

describe("REVIEW — CI ciFix self-loops (folded PR 14, FG-4)", () => {
  it("ci.signal(failing)[no_inflight ∧ under_cap] → REVIEW / dispatch_epoch(ciFix), inc_ci_fix_rounds", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g({ ciFixRounds: 1 }));
    expect(d).toEqual({
      to: "REVIEW",
      // §17-B: the ciFix dispatch stamps `in_flight_epoch_id` under the SAME CAS as `inc_ci_fix_rounds`
      // (the NULL→non-null inc anchor).
      fieldWrites: { ciFixRounds: 2, inFlightEpochId: NEW_EPOCH },
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }],
    });
  });

  it("ci.signal(failing)[in_flight_epoch] → REVIEW / log_noop (no double-dispatch, no double-count)", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g({ noInflightEpoch: false }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
  });

  it("ci.signal(failing)[no_inflight ∧ ¬under_cap] → NEEDS_YOU(ci_fix_exhausted) / loud (the cap trip)", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g({ underCiFixCap: false }));
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "ci_fix_exhausted" },
      sideEffects: [{ kind: "loud" }],
    });
  });
});

describe("REVIEW — green CI self-loop (FG-2 counter reset)", () => {
  it("ci.signal(green)[no_inflight] → REVIEW / reset_ci_fix_rounds, log_noop (clears a stale ciFix carry)", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "green" }, g({ ciFixRounds: 2 }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: { ciFixRounds: 0 }, sideEffects: [{ kind: "log_noop" }] });
  });

  it("ci.signal(absent) is bucketed green: same FG-2 reset self-loop", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "absent" }, g({ ciFixRounds: 3 }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: { ciFixRounds: 0 }, sideEffects: [{ kind: "log_noop" }] });
  });

  it("ci.signal(green)[in_flight_epoch] → REVIEW / log_noop (NO reset while an epoch runs)", () => {
    const d = transition("REVIEW", { type: "ci.signal", ciState: "green" }, g({ noInflightEpoch: false }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
  });
});

describe("REVIEW — CI-settled epoch-1 trigger + late-check guard (NET-NEW, PR 15)", () => {
  it("CI settles with something actionable → fires epoch 1 (dispatch_epoch review)", () => {
    const d = transition(
      "REVIEW",
      { type: "ci.signal", ciState: "green" },
      g({ ciSettled: true, epoch1Fired: false, actionableExists: true }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      // §17-B: epoch 1 dispatch stamps `in_flight_epoch_id`.
      fieldWrites: { inFlightEpochId: NEW_EPOCH },
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "review" } }],
    });
  });

  it("epoch 1 does NOT fire on green-with-nothing-actionable (falls to the FG-2 reset self-loop)", () => {
    const d = transition(
      "REVIEW",
      { type: "ci.signal", ciState: "green" },
      g({ ciSettled: true, epoch1Fired: false, actionableExists: false, ciFixRounds: 1 }),
    );
    expect(d).toEqual({ to: "REVIEW", fieldWrites: { ciFixRounds: 0 }, sideEffects: [{ kind: "log_noop" }] });
  });

  it("late-check guard: a not-yet-settled signal (ci_settled=false, e.g. a required check still pending / within debounce) does NOT false-fire epoch 1", () => {
    // `ci_settled` is keyed on REQUIRED checks + a short debounce, so a late-registered NON-required
    // check can't flip it to true — and while a required check is still un-terminal it stays false,
    // so even with an actionable item present, epoch 1 must NOT fire (it falls to the green self-loop).
    const d = transition(
      "REVIEW",
      { type: "ci.signal", ciState: "green" },
      g({ ciSettled: false, epoch1Fired: false, actionableExists: true }),
    );
    expect(d?.sideEffects).toEqual([{ kind: "log_noop" }]);
    expect(d?.sideEffects).not.toContainEqual({ kind: "dispatch_epoch", args: { trigger: "review" } });
  });

  it("epoch 1 does not re-fire once epoch_1_fired (the trigger is one-shot)", () => {
    const d = transition(
      "REVIEW",
      { type: "ci.signal", ciState: "green" },
      g({ ciSettled: true, epoch1Fired: true, actionableExists: true }),
    );
    expect(d?.sideEffects).toEqual([{ kind: "log_noop" }]);
  });
});

describe("REVIEW — review-epoch self-loops (v8 eager epoch-1 for the actionable-review cohort)", () => {
  it("review.received[actionable, no_inflight] → REVIEW / register + dispatch EAGERLY (no CI-settled wait)", () => {
    // v8: a review already actionable at entry dispatches epoch 1 on `no_inflight ∧ actionable`,
    // WITHOUT waiting for CI-settled (ci_settled is left false here on purpose).
    const d = transition(
      "REVIEW",
      { type: "review.received", reviewerKind: "bot", actionable: true },
      g({ ciSettled: false, epoch1Fired: false, reviewSourceId: "rs-9" }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      // §17-B: an eager epoch-1 dispatch stamps `in_flight_epoch_id` (the register rides bucket a).
      fieldWrites: { inFlightEpochId: NEW_EPOCH },
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "review" } }],
      worklistRegistrations: [{ sourceId: "rs-9", origin: "review", disposition: "none" }],
    });
  });

  it("review.received[actionable, in_flight] → REVIEW / register only (accumulate, no double-dispatch)", () => {
    const d = transition(
      "REVIEW",
      { type: "review.received", reviewerKind: "human", actionable: true },
      g({ noInflightEpoch: false, reviewSourceId: "rs-10" }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {},
      sideEffects: [],
      worklistRegistrations: [{ sourceId: "rs-10", origin: "review", disposition: "none" }],
    });
  });

  it("review.received[¬actionable] → REVIEW / log_noop (registers nothing, re-opens nothing)", () => {
    const d = transition("REVIEW", { type: "review.received", reviewerKind: "bot", actionable: false }, g());
    expect(d).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
    expect(d).not.toHaveProperty("worklistRegistrations");
  });

  it("the no-review cohort still WAITS for CI-settled: a green settle with no actionable item does not dispatch, but a failing check does (reactive ciFix)", () => {
    const noFire = transition(
      "REVIEW",
      { type: "ci.signal", ciState: "green" },
      g({ ciSettled: true, actionableExists: false }),
    );
    expect(noFire?.sideEffects).toEqual([{ kind: "log_noop" }]);
    const ciFix = transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g());
    expect(ciFix?.sideEffects).toEqual([{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }]);
  });

  it("review.item_ready[no_inflight] → dispatch_epoch; [in_flight] → log_noop", () => {
    expect(transition("REVIEW", { type: "review.item_ready", itemId: "i1" }, g())).toEqual({
      to: "REVIEW",
      // §17-B: the eager dispatch stamps `in_flight_epoch_id`; the in-flight branch stamps nothing.
      fieldWrites: { inFlightEpochId: NEW_EPOCH },
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "review" } }],
    });
    expect(transition("REVIEW", { type: "review.item_ready", itemId: "i1" }, g({ noInflightEpoch: false }))).toEqual({
      to: "REVIEW",
      fieldWrites: {},
      sideEffects: [{ kind: "log_noop" }],
    });
  });
});

describe("REVIEW — epoch terminals (disposition + thread resolution)", () => {
  it("epoch.committed → REVIEW / advance_head, set_code_changed, disposition(fixed), resolve_owned_threads", () => {
    const d = transition("REVIEW", { type: "epoch.committed", epochId: "e1" }, g({ committedHead: "abc123" }));
    expect(d).toEqual({
      to: "REVIEW",
      // §17-B: the terminal CLEARS `in_flight_epoch_id` in the same CAS write.
      fieldWrites: {
        headSha: "abc123",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        inFlightEpochId: null,
      },
      sideEffects: [
        { kind: "disposition", args: { epochId: "e1", disposition: "fixed" } },
        { kind: "resolve_owned_threads" },
      ],
    });
  });

  it("epoch.committed with NO committedHead → set_code_changed + clear epoch, but NO advance_head", () => {
    // The committed head rides via guards (the event carries only epochId). When the producer can't
    // resolve it, advance_head is SKIPPED — only set_code_changed + clear in_flight_epoch fire, and
    // headSha must NOT be written (a missing head must never land as a NULL/undefined headSha).
    const d = transition("REVIEW", { type: "epoch.committed", epochId: "e1" }, g({ committedHead: undefined }));
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { codeChangedSinceVerification: true, inFlightEpochId: null },
      sideEffects: [
        { kind: "disposition", args: { epochId: "e1", disposition: "fixed" } },
        { kind: "resolve_owned_threads" },
      ],
    });
    expect(d?.fieldWrites).not.toHaveProperty("headSha");
  });

  it("epoch.replied → REVIEW / disposition(replied), resolve_owned_threads (no code change)", () => {
    const d = transition("REVIEW", { type: "epoch.replied", epochId: "e2" }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { inFlightEpochId: null },
      sideEffects: [
        { kind: "disposition", args: { epochId: "e2", disposition: "replied" } },
        { kind: "resolve_owned_threads" },
      ],
    });
  });

  it("epoch.replied[uncovered items remain] → REVIEW / disposition(replied), resolve_owned_threads, dispatch_epoch(review) with a FRESH in-flight id (ARC-1556)", () => {
    const d = transition(
      "REVIEW",
      { type: "epoch.replied", epochId: "e2" },
      g({ uncoveredActionableSourceIds: ["u1", "u2"] }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { inFlightEpochId: NEW_EPOCH },
      sideEffects: [
        { kind: "disposition", args: { epochId: "e2", disposition: "replied" } },
        { kind: "resolve_owned_threads" },
        { kind: "dispatch_epoch", args: { trigger: "review" } },
      ],
    });
  });

  it("epoch.declined → REVIEW / disposition(declined) (no thread resolution)", () => {
    const d = transition("REVIEW", { type: "epoch.declined", epochId: "e3" }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { inFlightEpochId: null },
      sideEffects: [{ kind: "disposition", args: { epochId: "e3", disposition: "declined" } }],
    });
  });

  it("epoch.declined[uncovered items remain] → REVIEW / disposition(declined), dispatch_epoch(review) with a FRESH in-flight id (ARC-1556)", () => {
    const d = transition(
      "REVIEW",
      { type: "epoch.declined", epochId: "e3" },
      g({ uncoveredActionableSourceIds: ["u1", "u2"] }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { inFlightEpochId: NEW_EPOCH },
      sideEffects: [
        { kind: "disposition", args: { epochId: "e3", disposition: "declined" } },
        { kind: "dispatch_epoch", args: { trigger: "review" } },
      ],
    });
  });

  it("epoch.settled → REVIEW / clear in-flight ONLY (no disposition, head, or owner write)", () => {
    const d = transition("REVIEW", { type: "epoch.settled", epochId: "e5" }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { inFlightEpochId: null },
      sideEffects: [],
    });
  });

  it("epoch.settled[uncovered items remain] → REVIEW / ARM THE DRAIN: stamp FRESH in_flight + dispatch_epoch(review) (ARC-1445)", () => {
    // When an epoch settles in REVIEW leaving undispositioned items no LIVE epoch covers, the settle edge
    // itself must dispatch — at live `release_queued_reviews` is inert and `caught_up` can't fire with
    // undispositioned ≥ 1, so nothing else drains them. Mirrors the app_breaks arm-the-drain.
    // `setInFlightEpoch` OVERWRITES the settling epoch's id with a FRESH id (the producer supplies a
    // synthetic newEpochId, never the settling epoch's own id, so the executor CREATES and never re-strands).
    const d = transition(
      "REVIEW",
      { type: "epoch.settled", epochId: "e5" },
      g({ uncoveredActionableSourceIds: ["u1", "u2"] }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { inFlightEpochId: NEW_EPOCH },
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "review" } }],
    });
    // INTERLOCK: a future edit that drops the dispatch re-opens the ARC-1445 wedge (items stranded, nothing drains).
    expect(d?.sideEffects.filter((e) => e.kind === "dispatch_epoch")).toEqual([
      { kind: "dispatch_epoch", args: { trigger: "review" } },
    ]);
  });

  it("epoch.settled[no uncovered items] → REVIEW / clear in-flight ONLY (no dispatch, no dangling marker)", () => {
    // The no-actionable-work settle (bot-wait drain / benign block with nothing left undispositioned): keep
    // today's behavior — clear the marker so `caught_up` re-derives; never a bare-trigger dispatch.
    const d = transition("REVIEW", { type: "epoch.settled", epochId: "e5" }, g({ uncoveredActionableSourceIds: [] }));
    expect(d).toEqual({ to: "REVIEW", fieldWrites: { inFlightEpochId: null }, sideEffects: [] });
  });
});

describe("REVIEW — owner_approval (the sole owner-approval path, P1/D8)", () => {
  it("epoch.blocked{owner_approval} → NEEDS_YOU(owner_approval) / set blocked_reason, loud", () => {
    const d = transition(
      "REVIEW",
      { type: "epoch.blocked", epochId: "e4", reason: "owner_approval", trigger: "review" },
      g(),
    );
    expect(d).toEqual({
      to: "NEEDS_YOU",
      // §17-B: a blocked epoch stops running → clear `in_flight_epoch_id` (avoid wedging a non-dispatching re-open).
      fieldWrites: { blockedReason: "owner_approval", inFlightEpochId: null },
      sideEffects: [{ kind: "loud" }],
    });
  });

  it("epoch.blocked{response_failed} → NEEDS_YOU(review_response_failed) / clear in-flight, loud (ARC-1330)", () => {
    const d = transition(
      "REVIEW",
      { type: "epoch.blocked", epochId: "e5", reason: "response_failed", trigger: "review" },
      g(),
    );
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "review_response_failed", inFlightEpochId: null },
      sideEffects: [{ kind: "loud" }],
    });
  });
});

describe("REVIEW — head edges (N4: head.noop_changed is total over both branches)", () => {
  it("head.changed → REVIEW / advance_head, set_code_changed, clear_verification", () => {
    const d = transition("REVIEW", { type: "head.changed", headSha: "h2" }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        headSha: "h2",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
      },
      sideEffects: [],
    });
  });

  it("head.noop_changed[¬code_changed] → REVIEW / advance_head, restamp_verification (keep the fresh verdict)", () => {
    const d = transition(
      "REVIEW",
      { type: "head.noop_changed", headSha: "h3" },
      g({ codeChangedSinceVerification: false }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { headSha: "h3", updateBranchQueuedAt: null, verdictHeadSha: "h3" },
      sideEffects: [],
    });
  });

  it("head.noop_changed[code_changed] → REVIEW / advance_head only (verdict already stale, no restamp)", () => {
    const d = transition(
      "REVIEW",
      { type: "head.noop_changed", headSha: "h4" },
      g({ codeChangedSinceVerification: true }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { headSha: "h4", updateBranchQueuedAt: null },
      sideEffects: [],
    });
  });
});

describe("REVIEW — record-only verification bookkeeping (verification decoupled from the gate)", () => {
  const RUN = 5;
  // Guard bag with the active run + child handles the bookkeeping edges read.
  const vg = (over: Partial<Guards> = {}): Guards =>
    g({ verificationRunId: RUN, verificationChildId: "child-active", verdictVerificationChildId: null, ...over });

  it.each(["pass", "skipped", "app_breaks"] as const)(
    "verification.%s[fresh] → REVIEW / record_verification + kill(active), NO state change, NO dispatch",
    (kind) => {
      const d = transition("REVIEW", { type: `verification.${kind}`, headSha: "vh", runId: RUN } as FsmEvent, vg());
      const expectedVerdict = kind === "pass" ? "pass" : kind === "skipped" ? "skipped" : "app_breaks";
      expect(d?.to).toBe("REVIEW");
      expect(d?.fieldWrites.verdict).toBe(expectedVerdict);
      expect(d?.fieldWrites.verdictHeadSha).toBe("vh");
      expect(d?.sideEffects).toEqual([{ kind: "kill_verification", args: { verificationChildId: "child-active" } }]);
      // No dispatch, no in-flight stamp, no findings injection — the QA comment intake (Track INTAKE) owns
      // turning a failing verdict into an actionable worklist item.
      expect(d?.sideEffects).not.toContainEqual({ kind: "dispatch_epoch", args: { trigger: "review" } });
      expect(d?.fieldWrites.inFlightEpochId).toBeUndefined();
    },
  );

  it.each(["run_limit", "stopped", "failed"] as const)(
    "verification.%s[fresh] → REVIEW / notify_qa_issue + kill(active), non-blocking self-loop (no blocked_reason)",
    (kind) => {
      const d = transition("REVIEW", { type: `verification.${kind}`, runId: RUN } as FsmEvent, vg());
      expect(d?.to).toBe("REVIEW");
      expect(d?.fieldWrites.blockedReason).toBeUndefined();
      expect(d?.sideEffects).toEqual([
        { kind: "notify_qa_issue" },
        { kind: "kill_verification", args: { verificationChildId: "child-active" } },
      ]);
    },
  );

  it.each(["pass", "app_breaks", "run_limit", "stopped", "failed"] as const)(
    "verification.%s[STALE run] → REVIEW / log_noop + kill(verdict's run) — ghost-discard, never recorded",
    (kind) => {
      const ev = (
        kind === "pass" || kind === "app_breaks"
          ? { type: `verification.${kind}`, headSha: "gh", runId: 99 }
          : { type: `verification.${kind}`, runId: 99 }
      ) as FsmEvent;
      const d = transition("REVIEW", ev, vg({ verdictVerificationChildId: "ghost-child" }));
      expect(d).toEqual({
        to: "REVIEW",
        fieldWrites: {},
        sideEffects: [
          { kind: "log_noop" },
          { kind: "kill_verification", args: { verificationChildId: "ghost-child" } },
        ],
      });
    },
  );

  it("still leaves genuinely unrelated events unhandled → null", () => {
    expect(transition("REVIEW", { type: "user.input" }, g())).toBeNull();
  });
});
