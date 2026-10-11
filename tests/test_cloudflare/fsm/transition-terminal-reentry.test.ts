// Per-edge unit tests for the ARC-1330 lifecycle-FSM terminal re-entry edges (PR 18, design §9 lines
// 296-306 / §17-D). Pure-fn suite: `transition` is a pure function of (state, event, guards), so these
// import it directly and assert the returned Decision per edge — no DB harness. Scope: the `MERGE_READY`
// re-opens (actionable review / head.changed / head.noop / red-CI flap + the §17-D `ci_flapping` cap),
// the `NEEDS_YOU` re-opens (actionable review / user.retrigger / head.changed / head.noop, all with the
// queue drain + both cap resets), and the `FAILED → PROVISIONING` infra retrigger. The three spec-named
// guarantees are asserted explicitly: a re-open NEVER drops the triggering review (it is registered, not
// merely consumed), the `MERGE_READY` re-opens OMIT the drain (the queue is provably empty), and the
// flap cap trips at N (`MAX_MERGE_READY_REOPENS`).
import { describe, expect, it } from "vitest";

import { MAX_MERGE_READY_REOPENS } from "../../../apps/control-plane-worker/src/constants/review-loop";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";

// A fully-populated terminal-reentry guard bag; each test overrides only the conjuncts its edge reads.
const NEW_EPOCH = "epoch-reentry-1";
const BASE: Guards = {
  sandboxAlive: true,
  reviewSourceId: "review-src-1",
  newEpochId: NEW_EPOCH,
  ciFixRounds: 0,
  mergeReadyReopenCount: 0,
  underMergeReadyReopenCap: true,
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...BASE, ...over });

const REGISTER_TRIGGER = { sourceId: "review-src-1", origin: "review", disposition: "none" } as const;
const DISPATCH_REVIEW = { kind: "dispatch_epoch", args: { trigger: "review" } } as const;
const DISPATCH_CIFIX = { kind: "dispatch_epoch", args: { trigger: "ci_fix" } } as const;
const RELEASE = { kind: "release_queued_reviews" } as const;
const LOG_NOOP = { kind: "log_noop" } as const;
const LOUD = { kind: "loud" } as const;
// PR 26 (Locked decision 5b): the §17-D flap-cap trip carries a dedicated retune metric alongside `loud`.
const EMIT_CAP_TRIP = {
  kind: "emit_cap_trip",
  args: { cap: "merge_ready_reopen", limit: MAX_MERGE_READY_REOPENS },
} as const;

describe("MERGE_READY — terminal re-entry edges (design §9 lines 296-300)", () => {
  it("verification.requested[under_cap] → VERIFYING / request_verification without dispatching a side effect", () => {
    const d = transition(
      "MERGE_READY",
      { type: "verification.requested", headSha: "h-verify" },
      g({ verificationRunCount: 1, verificationRunId: 4, underVerificationCap: true }),
    );

    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {
        headSha: "h-verify",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        verificationRunCount: 2,
        verificationRunHead: "h-verify",
        verificationRunId: 5,
        verificationChildId: null,
      },
      sideEffects: [],
    });
  });

  it("verification.requested[cap_exhausted] → NEEDS_YOU(verification_run_limit)", () => {
    const d = transition(
      "MERGE_READY",
      { type: "verification.requested", headSha: "h-verify" },
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
      "MERGE_READY",
      { type: "verification.requested", headSha: "h-verify", bypassRunLimitForMergeConflict: true },
      g({ verificationRunCount: 3, verificationRunId: 4, underVerificationCap: false }),
    );

    expect(d).toMatchObject({
      to: "VERIFYING",
      fieldWrites: {
        verificationRunCount: 4,
        verificationRunHead: "h-verify",
        verificationRunId: 5,
      },
      sideEffects: [],
    });
  });

  it("review.received[actionable] → REVIEW / register_review(undispositioned), dispatch_epoch, reset qa_runs (Defect 3)", () => {
    const d = transition("MERGE_READY", { type: "review.received", reviewerKind: "bot", actionable: true }, g());
    expect(d).toEqual({
      to: "REVIEW",
      // §17-B: the re-open dispatch stamps `in_flight_epoch_id` under the same CAS.
      fieldWrites: { verificationRunCount: 0, inFlightEpochId: NEW_EPOCH },
      sideEffects: [DISPATCH_REVIEW],
      worklistRegistrations: [REGISTER_TRIGGER],
    });
  });

  it("review.received[actionable] re-open NEVER drops the triggering review (registered, not merely consumed; B6)", () => {
    const d = transition("MERGE_READY", { type: "review.received", reviewerKind: "human", actionable: true }, g());
    // The triggering review is registered UNDISPOSITIONED so `caught_up` stays false on re-entry.
    expect(d?.worklistRegistrations).toEqual([REGISTER_TRIGGER]);
  });

  it("MERGE_READY re-opens OMIT the drain (queue provably empty — reached via caught_up, no transient queue)", () => {
    const d = transition("MERGE_READY", { type: "review.received", reviewerKind: "bot", actionable: true }, g());
    expect(d?.sideEffects).not.toContainEqual(RELEASE);
  });

  it("review.received[¬actionable] → MERGE_READY / log_noop (informational review does not re-open a Ready PR)", () => {
    const d = transition("MERGE_READY", { type: "review.received", reviewerKind: "bot", actionable: false }, g());
    expect(d).toEqual({ to: "MERGE_READY", fieldWrites: {}, sideEffects: [LOG_NOOP] });
    expect(d).not.toHaveProperty("worklistRegistrations");
  });

  it("head.changed → REVIEW / advance_head, set_code_changed, clear_verification, reset qa_runs", () => {
    const d = transition("MERGE_READY", { type: "head.changed", headSha: "h2" }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        headSha: "h2",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        verificationRunCount: 0,
      },
      sideEffects: [],
    });
  });

  it("head.noop_changed → MERGE_READY / advance_head, restamp_verification (stays Ready, no re-QA)", () => {
    const d = transition("MERGE_READY", { type: "head.noop_changed", headSha: "noop-h" }, g());
    expect(d).toEqual({
      to: "MERGE_READY",
      fieldWrites: { headSha: "noop-h", updateBranchQueuedAt: null, verdictHeadSha: "noop-h" },
      sideEffects: [],
    });
  });

  it("ci.signal(failing) under cap → REVIEW / dispatch_epoch(ciFix), inc_ci_fix_rounds, inc reopen count — NO set_code_changed (SF7)", () => {
    const d = transition(
      "MERGE_READY",
      { type: "ci.signal", ciState: "failing" },
      g({ mergeReadyReopenCount: 2, ciFixRounds: 0 }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { mergeReadyReopenCount: 3, ciFixRounds: 1, inFlightEpochId: NEW_EPOCH },
      sideEffects: [DISPATCH_CIFIX],
    });
    // SF7: a flaky CI flip on identical code must NOT force a spurious re-QA.
    expect(d?.fieldWrites).not.toHaveProperty("codeChangedSinceVerification");
  });

  it("ci.signal(green|absent) → unhandled (null) — a Ready PR going greener is a no-op, not an edge", () => {
    expect(transition("MERGE_READY", { type: "ci.signal", ciState: "green" }, g())).toBeNull();
    expect(transition("MERGE_READY", { type: "ci.signal", ciState: "absent" }, g())).toBeNull();
  });
});

describe("MERGE_READY — §17-D flap cap (ci_flapping trips at MAX_MERGE_READY_REOPENS)", () => {
  it("red-CI re-open at/over the cap → NEEDS_YOU{ci_flapping} / loud (instead of re-opening again)", () => {
    const d = transition(
      "MERGE_READY",
      { type: "ci.signal", ciState: "failing" },
      g({ underMergeReadyReopenCap: false }),
    );
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "ci_flapping" },
      sideEffects: [LOUD, EMIT_CAP_TRIP],
    });
  });

  it("flap cap trips at N: the first MAX_MERGE_READY_REOPENS red flaps re-open, the next trips ci_flapping", () => {
    // Drive the cap exactly as the spine would: `underMergeReadyReopenCap` = count < MAX, recomputed per flap.
    let count = 0;
    const reopens: number[] = [];
    for (let i = 0; i < MAX_MERGE_READY_REOPENS + 1; i++) {
      const underCap = count < MAX_MERGE_READY_REOPENS;
      const d = transition(
        "MERGE_READY",
        { type: "ci.signal", ciState: "failing" },
        g({ mergeReadyReopenCount: count, underMergeReadyReopenCap: underCap }),
      );
      if (d?.to === "REVIEW") {
        reopens.push(i);
        count = (d.fieldWrites.mergeReadyReopenCount as number) ?? count;
      } else {
        // The (N+1)-th flap trips the cap.
        expect(d).toEqual({
          to: "NEEDS_YOU",
          fieldWrites: { blockedReason: "ci_flapping" },
          sideEffects: [LOUD, EMIT_CAP_TRIP],
        });
        expect(i).toBe(MAX_MERGE_READY_REOPENS);
      }
    }
    // Exactly MAX_MERGE_READY_REOPENS re-opens were allowed before the trip.
    expect(reopens).toHaveLength(MAX_MERGE_READY_REOPENS);
    expect(count).toBe(MAX_MERGE_READY_REOPENS);
  });
});

describe("NEEDS_YOU — terminal re-entry edges (design §9 lines 301-305)", () => {
  it("verification.requested[under_cap] → VERIFYING / clear_block, drain, reset ci cap, request QA", () => {
    const d = transition(
      "NEEDS_YOU",
      { type: "verification.requested", headSha: "h-verify" },
      g({ verificationRunCount: 1, verificationRunId: 8, ciFixRounds: 2, underVerificationCap: true }),
    );

    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {
        blockedReason: null,
        ciFixRounds: 0,
        headSha: "h-verify",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        verificationRunCount: 2,
        verificationRunHead: "h-verify",
        verificationRunId: 9,
        verificationChildId: null,
      },
      sideEffects: [RELEASE],
    });
  });

  it("verification.requested[cap_exhausted] → NEEDS_YOU(verification_run_limit)", () => {
    const d = transition(
      "NEEDS_YOU",
      { type: "verification.requested", headSha: "h-verify" },
      g({ verificationRunCount: 3, verificationRunId: 8, ciFixRounds: 2, underVerificationCap: false }),
    );

    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "verification_run_limit" },
      sideEffects: [{ kind: "notify_qa_issue" }],
    });
  });

  it("verification.requested[cap_exhausted + merge_conflict_bypass] → VERIFYING", () => {
    const d = transition(
      "NEEDS_YOU",
      { type: "verification.requested", headSha: "h-verify", bypassRunLimitForMergeConflict: true },
      g({ verificationRunCount: 3, verificationRunId: 8, ciFixRounds: 2, underVerificationCap: false }),
    );

    expect(d).toMatchObject({
      to: "VERIFYING",
      fieldWrites: {
        blockedReason: null,
        verificationRunCount: 4,
        verificationRunHead: "h-verify",
        verificationRunId: 9,
      },
      sideEffects: [RELEASE],
    });
  });

  it("verification.requested[new_head, cap_exhausted] → VERIFYING with a fresh per-head QA budget", () => {
    const d = transition(
      "NEEDS_YOU",
      { type: "verification.requested", headSha: "new-head" },
      g({
        headSha: "old-head",
        verificationRunCount: 3,
        verificationRunId: 8,
        ciFixRounds: 2,
        underVerificationCap: false,
      }),
    );

    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {
        blockedReason: null,
        ciFixRounds: 0,
        headSha: "new-head",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        verificationRunCount: 1,
        verificationRunHead: "new-head",
        verificationRunId: 9,
        verificationChildId: null,
      },
      sideEffects: [RELEASE],
    });
  });

  it("review.received[actionable] → REVIEW / clear_block, release_queued_reviews, register_review, dispatch_epoch, reset both caps", () => {
    const d = transition("NEEDS_YOU", { type: "review.received", reviewerKind: "bot", actionable: true }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { blockedReason: null, verificationRunCount: 0, ciFixRounds: 0, inFlightEpochId: NEW_EPOCH },
      sideEffects: [RELEASE, DISPATCH_REVIEW],
      worklistRegistrations: [REGISTER_TRIGGER],
    });
    // The triggering review is registered, never dropped.
    expect(d?.worklistRegistrations).toEqual([REGISTER_TRIGGER]);
  });

  it("review.received[¬actionable] → NEEDS_YOU / log_noop (does not re-open or re-arm the caps)", () => {
    const d = transition("NEEDS_YOU", { type: "review.received", reviewerKind: "human", actionable: false }, g());
    expect(d).toEqual({ to: "NEEDS_YOU", fieldWrites: {}, sideEffects: [LOG_NOOP] });
    expect(d).not.toHaveProperty("worklistRegistrations");
  });

  it("user.retrigger from review_stuck → REVIEW / clear_block, release_queued_reviews, set_code_changed, reset caps, clear stale in-flight", () => {
    const d = transition("NEEDS_YOU", { type: "user.retrigger" }, g({ blockedReason: "review_stuck" }));
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        blockedReason: null,
        codeChangedSinceVerification: true,
        verificationRunCount: 0,
        ciFixRounds: 0,
        inFlightEpochId: null,
      },
      sideEffects: [RELEASE],
    });
  });

  it("user.retrigger from non-review-stuck blocker preserves a live in-flight epoch marker", () => {
    const d = transition("NEEDS_YOU", { type: "user.retrigger" }, g({ blockedReason: "owner_approval" }));
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        blockedReason: null,
        codeChangedSinceVerification: true,
        verificationRunCount: 0,
        ciFixRounds: 0,
      },
      sideEffects: [RELEASE],
    });
  });

  it("head.changed → REVIEW / advance_head, set_code_changed, clear_verification, clear_block, drain, reset caps, clear in-flight", () => {
    const d = transition("NEEDS_YOU", { type: "head.changed", headSha: "h9" }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        headSha: "h9",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        blockedReason: null,
        verificationRunCount: 0,
        ciFixRounds: 0,
        inFlightEpochId: null,
      },
      sideEffects: [RELEASE],
    });
  });

  it("head.noop_changed → NEEDS_YOU / advance_head, restamp_verification (stays blocked)", () => {
    const d = transition("NEEDS_YOU", { type: "head.noop_changed", headSha: "noop-h" }, g());
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { headSha: "noop-h", updateBranchQueuedAt: null, verdictHeadSha: "noop-h" },
      sideEffects: [],
    });
  });

  it("an unrelated event (e.g. ci.signal) is unhandled in NEEDS_YOU → null", () => {
    expect(transition("NEEDS_YOU", { type: "ci.signal", ciState: "failing" }, g())).toBeNull();
  });
});

describe("FAILED — infra retrigger (design §9 line 306) + system-retry re-entry (ARC-1470)", () => {
  it("user.retrigger → PROVISIONING / re-spawn (spawn_sandbox), clear failure_reason (N6)", () => {
    const d = transition("FAILED", { type: "user.retrigger" }, g());
    expect(d).toEqual({
      to: "PROVISIONING",
      fieldWrites: { failureReason: null },
      sideEffects: [{ kind: "spawn_sandbox" }],
    });
  });

  it("prompt.enqueued → GENERATING / dispatch_prompt, clear failure_reason — quiet system-retry recovery (ARC-1470)", () => {
    // A platform re-enqueue (verifier reuse, auto-retry) after a transient prompt error recovers the record
    // instead of resting FAILED forever on a session that heals. No re-spawn (live sandbox), no loud.
    const d = transition("FAILED", { type: "prompt.enqueued" }, g());
    expect(d).toEqual({
      to: "GENERATING",
      fieldWrites: { failureReason: null },
      sideEffects: [{ kind: "dispatch_prompt" }],
    });
  });

  it("a retry that dies re-fails the recovered record (GENERATING core codegen_error edge)", () => {
    expect(transition("GENERATING", { type: "prompt.terminal", outcome: "error" }, g())?.to).toBe("FAILED");
  });

  it("any other event is unhandled in FAILED → null", () => {
    expect(transition("FAILED", { type: "head.changed", headSha: "h" }, g())).toBeNull();
    expect(transition("FAILED", { type: "user.input" }, g())).toBeNull();
    // A late success terminal for an ALREADY-FAILED prompt does not resurrect by itself — recovery is
    // keyed on the retry ENQUEUE, which precedes the retry's own terminal on the recovered spine.
    expect(transition("FAILED", { type: "prompt.terminal", outcome: "changes" }, g())).toBeNull();
  });
});

describe("STOPPED — re-prompt re-entry (quiet recovery, mirrors the FAILED ARC-1470 edge)", () => {
  it("prompt.enqueued → GENERATING / dispatch_prompt, clear stop fields (N6)", () => {
    // A user-stopped session resumes via a new composer prompt, which reaches the spine as
    // prompt.enqueued (user.input is plan-approval-only) — without this edge the record rests
    // STOPPED forever while the session actually resumes and runs.
    const d = transition("STOPPED", { type: "prompt.enqueued" }, g());
    expect(d).toEqual({
      to: "GENERATING",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [{ kind: "dispatch_prompt" }],
    });
  });

  it("re-prompt re-entry is stop_mode-agnostic (a user cancel and a resumable stop both recover)", () => {
    const d = transition("STOPPED", { type: "prompt.enqueued" }, g({ stopMode: "user", preStopState: "GENERATING" }));
    expect(d?.to).toBe("GENERATING");
    const r = transition(
      "STOPPED",
      { type: "prompt.enqueued" },
      g({ stopMode: "resumable", preStopState: "AWAITING_INPUT" }),
    );
    expect(r?.to).toBe("GENERATING");
  });

  it("a POST-publish stop (pre_stop_state REVIEW/VERIFYING) re-prompts into REVIEW, never pre-publish GENERATING", () => {
    // A stopped session with a live PR (backfill materializes STOPPED(resumable, REVIEW) for these)
    // must re-enter its post-publish phase — flipping the record to GENERATING would misproject a
    // published, in-review session as pre-publish codegen.
    const review = transition(
      "STOPPED",
      { type: "prompt.enqueued" },
      g({ stopMode: "resumable", preStopState: "REVIEW" }),
    );
    expect(review).toEqual({
      to: "REVIEW",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [],
    });
    // VERIFYING resumes to REVIEW like the user.input map: QA is non-blocking and drain-only.
    const verifying = transition(
      "STOPPED",
      { type: "prompt.enqueued" },
      g({ stopMode: "user", preStopState: "VERIFYING" }),
    );
    expect(verifying?.to).toBe("REVIEW");
    expect(verifying?.fieldWrites).toEqual({ stopMode: null, preStopState: null });
  });

  it("EVERY post-publish pre_stop_state re-prompts into REVIEW (MERGE_READY/NEEDS_YOU hardening)", () => {
    // user.stop is unhandled in the resting terminals today, so these pre_stop_states are currently
    // unreachable — but the edge must stay wrong-re-entry-proof if the stoppable set ever grows.
    // REVIEW is the drain-consistent target: the loop re-arms and the caught_up cascade re-derives
    // MERGE_READY; NEEDS_YOU re-opens to REVIEW like its user.retrigger edge.
    for (const preStopState of ["MERGE_READY", "NEEDS_YOU"] as const) {
      const d = transition("STOPPED", { type: "prompt.enqueued" }, g({ stopMode: "user", preStopState }));
      expect(d).toEqual({
        to: "REVIEW",
        fieldWrites: { stopMode: null, preStopState: null },
        sideEffects: [],
      });
    }
  });
});

describe("MERGE_READY / NEEDS_YOU — record-only verification bookkeeping (off-gate self-loops)", () => {
  const RUN = 5;
  const vg = (over: Partial<Guards> = {}): Guards => ({
    sandboxAlive: true,
    verificationRunId: RUN,
    verificationChildId: "child-active",
    verdictVerificationChildId: null,
    ...over,
  });

  it.each(["MERGE_READY", "NEEDS_YOU"] as const)(
    "%s — verification.pass[fresh] → self-loop / record_verification + kill(active), state unchanged",
    (state) => {
      const d = transition(state, { type: "verification.pass", headSha: "vh", runId: RUN }, vg());
      expect(d?.to).toBe(state);
      expect(d?.fieldWrites.verdict).toBe("pass");
      expect(d?.fieldWrites.verdictHeadSha).toBe("vh");
      expect(d?.sideEffects).toEqual([{ kind: "kill_verification", args: { verificationChildId: "child-active" } }]);
    },
  );

  it.each(["MERGE_READY", "NEEDS_YOU"] as const)(
    "%s — verification.stopped[fresh] → self-loop / notify_qa_issue + kill(active), NO blocked_reason change",
    (state) => {
      const d = transition(state, { type: "verification.stopped", runId: RUN }, vg());
      expect(d?.to).toBe(state);
      expect(d?.fieldWrites.blockedReason).toBeUndefined();
      expect(d?.sideEffects).toEqual([
        { kind: "notify_qa_issue" },
        { kind: "kill_verification", args: { verificationChildId: "child-active" } },
      ]);
    },
  );

  it.each(["MERGE_READY", "NEEDS_YOU"] as const)(
    "%s — verification.app_breaks[STALE run] → ghost-discard self-loop / log_noop + kill(verdict's run)",
    (state) => {
      const d = transition(
        state,
        { type: "verification.app_breaks", headSha: "gh", runId: 99 },
        vg({ verdictVerificationChildId: "ghost-child" }),
      );
      expect(d).toEqual({
        to: state,
        fieldWrites: {},
        sideEffects: [
          { kind: "log_noop" },
          { kind: "kill_verification", args: { verificationChildId: "ghost-child" } },
        ],
      });
    },
  );
});
