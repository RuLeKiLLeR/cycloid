// Tests for the ARC-1330 lifecycle-FSM `caught_up` recompute / emitter (PR 20A, design §6/§9 — the
// cascade's PRODUCER). Pure-fn suite: `classifyCaughtUpTrigger` / `recomputeCaughtUp` are pure functions,
// so these import them directly and assert the result — no DB harness. The apply-event spine composes them
// as `classify → recompute`; these tests exercise that composition directly. The KEYSTONE drives a true
// `caught_up` from a real `transition` exit all the way to
// `MERGE_READY` through the real cascade, proving the producer→consumer wiring the blocker fix restores.
//
// Coverage:
//   • all SIX design §6 recompute triggers fire a recompute (the recompute-completeness class),
//   • the emit decision (conjunction + REVIEW-gating + idempotence),
//   • a true `caught_up` reaches `MERGE_READY` end-to-end in a harness.
import { describe, expect, it } from "vitest";

import {
  CAUGHT_UP_RECOMPUTE_TRIGGERS,
  classifyCaughtUpTrigger,
  recomputeCaughtUp,
} from "../../../apps/control-plane-worker/src/session/fsm/caught-up";
import type { CaughtUpStore } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";

const HEAD = "head-20a";

/** Stub disposition snapshot (PR 22 owns the real DAO reader). */
function stubStore(undispositioned: number): CaughtUpStore {
  return {
    countUndispositionedActionable: () => undispositioned,
  };
}

/** A `caught_up`-true snapshot: nothing undispositioned. */
const SETTLED: CaughtUpStore = stubStore(0);

// ── (1) Trigger classification — all six §6 recompute triggers ────────────────────────────────────────
describe("classifyCaughtUpTrigger — the design §6 recompute-trigger set (recompute-completeness)", () => {
  it("§6.1 epoch_terminal — every epoch terminal in REVIEW (committed/replied/declined/settled)", () => {
    for (const type of ["epoch.committed", "epoch.replied", "epoch.declined", "epoch.settled"] as const) {
      const event = { type, epochId: "e1" } as FsmEvent;
      expect(classifyCaughtUpTrigger("REVIEW", event, "REVIEW")).toBe("epoch_terminal");
    }
  });

  it("§6.2 review_received — a review.received REVIEW self-loop", () => {
    const event: FsmEvent = { type: "review.received", reviewerKind: "bot", actionable: true };
    expect(classifyCaughtUpTrigger("REVIEW", event, "REVIEW")).toBe("review_received");
    // A non-actionable review still re-runs the recompute (it is harmlessly idempotent; the emit decision,
    // not the trigger, is where actionability matters — via the store count).
    const noise: FsmEvent = { type: "review.received", reviewerKind: "human", actionable: false };
    expect(classifyCaughtUpTrigger("REVIEW", noise, "REVIEW")).toBe("review_received");
  });

  it("§6.4 ci_green_flip — only the green/absent ci.signal, NOT a failing red (FG-4)", () => {
    for (const ciState of ["green", "absent"] as const) {
      const event: FsmEvent = { type: "ci.signal", ciState };
      expect(classifyCaughtUpTrigger("REVIEW", event, "REVIEW")).toBe("ci_green_flip");
    }
    // A failing signal drives the reactive ciFix self-loop, never a caught_up recompute.
    const red: FsmEvent = { type: "ci.signal", ciState: "failing" };
    expect(classifyCaughtUpTrigger("REVIEW", red, "REVIEW")).toBeNull();
  });

  it("§6.5 verification_verdict_return — VERIFYING → REVIEW (the record_qa fresh-accept exit)", () => {
    const event: FsmEvent = { type: "verification.pass", headSha: HEAD, runId: 1 };
    expect(classifyCaughtUpTrigger("VERIFYING", event, "REVIEW")).toBe("verification_verdict_return");
  });

  it("§6.6 review_reopen — entry to REVIEW from a NEEDS_YOU/MERGE_READY re-open (any driving event)", () => {
    const reviewReopen: FsmEvent = { type: "review.received", reviewerKind: "bot", actionable: true };
    expect(classifyCaughtUpTrigger("MERGE_READY", reviewReopen, "REVIEW")).toBe("review_reopen");
    expect(classifyCaughtUpTrigger("NEEDS_YOU", reviewReopen, "REVIEW")).toBe("review_reopen");
    // A head.changed re-open is ALSO a review_reopen by (from,to) shape — the recompute then routes it
    // through the cascade to re-QA (the §6 "evaluate on arrival" requirement, regardless of driving event).
    const headReopen: FsmEvent = { type: "head.changed", headSha: HEAD };
    expect(classifyCaughtUpTrigger("MERGE_READY", headReopen, "REVIEW")).toBe("review_reopen");
    // A NEEDS_YOU manual retrigger re-open is likewise classified by shape.
    const retrigger: FsmEvent = { type: "user.retrigger" };
    expect(classifyCaughtUpTrigger("NEEDS_YOU", retrigger, "REVIEW")).toBe("review_reopen");
  });

  it("the FG-1 ghost-discard (VERIFYING → VERIFYING) is NOT a trigger (it never returns to REVIEW)", () => {
    const ghost: FsmEvent = { type: "verification.pass", headSha: HEAD, runId: 99 };
    expect(classifyCaughtUpTrigger("VERIFYING", ghost, "VERIFYING")).toBeNull();
  });

  it("non-REVIEW-landing transitions are not triggers (a VERIFYING queue, a terminal, a genesis edge)", () => {
    // review.received queued during VERIFYING (to = VERIFYING) — not a trigger.
    const queued: FsmEvent = { type: "review.received", reviewerKind: "bot", actionable: true };
    expect(classifyCaughtUpTrigger("VERIFYING", queued, "VERIFYING")).toBeNull();
    // A non-actionable review.received noop in MERGE_READY (to = MERGE_READY) — not a trigger.
    const noiseInReady: FsmEvent = { type: "review.received", reviewerKind: "bot", actionable: false };
    expect(classifyCaughtUpTrigger("MERGE_READY", noiseInReady, "MERGE_READY")).toBeNull();
    // A terminal close-out — not a trigger.
    const merged: FsmEvent = { type: "pr.merged" };
    expect(classifyCaughtUpTrigger("REVIEW", merged, "MERGED")).toBeNull();
    // A genesis edge — not a trigger.
    const ready: FsmEvent = { type: "sandbox.ready" };
    expect(classifyCaughtUpTrigger("PROVISIONING", ready, "GENERATING")).toBeNull();
  });

  it("publish_pr_opened — the PUBLISHING → REVIEW init_record edge (evaluate on arrival)", () => {
    const event: FsmEvent = { type: "publish.pr_opened", prHead: "deadbeef" };
    expect(classifyCaughtUpTrigger("PUBLISHING", event, "REVIEW")).toBe("publish_pr_opened");
    // A publish edge that does NOT land in REVIEW (the N9 pr.merged race) is not a trigger.
    expect(classifyCaughtUpTrigger("PUBLISHING", { type: "pr.merged" }, "MERGED")).toBeNull();
  });

  it("publish_pr_opened is a named trigger in the completeness list", () => {
    expect(CAUGHT_UP_RECOMPUTE_TRIGGERS).toContain("publish_pr_opened");
  });
});

// ── (2) The emit decision — conjunction, REVIEW-gating, idempotence, head presence ────────────────────
describe("recomputeCaughtUp — the emit decision", () => {
  it("emits caught_up{head} when the conjunction holds in REVIEW", () => {
    const ev = recomputeCaughtUp({ resultingState: "REVIEW", headSha: HEAD, noInflightEpoch: true, store: SETTLED });
    expect(ev).toEqual({ type: "caught_up", headSha: HEAD });
  });

  it("does NOT emit outside REVIEW — idempotence: an already-Ready session is in MERGE_READY, not REVIEW", () => {
    for (const state of ["MERGE_READY", "VERIFYING", "NEEDS_YOU", "GENERATING"] as const) {
      expect(
        recomputeCaughtUp({ resultingState: state, headSha: HEAD, noInflightEpoch: true, store: SETTLED }),
      ).toBeNull();
    }
  });

  it("does NOT emit when the §6 conjunction is unmet (inflight epoch / undispositioned item)", () => {
    // an epoch is in flight
    expect(
      recomputeCaughtUp({ resultingState: "REVIEW", headSha: HEAD, noInflightEpoch: false, store: SETTLED }),
    ).toBeNull();
    // an undispositioned actionable item remains
    expect(
      recomputeCaughtUp({ resultingState: "REVIEW", headSha: HEAD, noInflightEpoch: true, store: stubStore(1) }),
    ).toBeNull();
  });

  it("does NOT emit a headless caught_up (defensive — a REVIEW record always has a head, B5)", () => {
    expect(
      recomputeCaughtUp({ resultingState: "REVIEW", headSha: null, noInflightEpoch: true, store: SETTLED }),
    ).toBeNull();
  });
});

// ── (3) classify ∘ recompute — the spine's after-commit composition (apply-event inlines this) ────────
describe("classify ∘ recompute (the spine's after-commit composition)", () => {
  it("a non-trigger transition classifies null → no recompute (even if the conjunction would hold)", () => {
    // sandbox.ready (PROVISIONING → GENERATING) is not a §6 trigger; the spine skips the recompute entirely.
    expect(classifyCaughtUpTrigger("PROVISIONING", { type: "sandbox.ready" }, "GENERATING")).toBeNull();
  });

  it("a §6 trigger with the conjunction met recomputes the caught_up{head} event to re-feed", () => {
    const event: FsmEvent = { type: "verification.pass", headSha: HEAD, runId: 1 };
    expect(classifyCaughtUpTrigger("VERIFYING", event, "REVIEW")).not.toBeNull();
    const ev = recomputeCaughtUp({ resultingState: "REVIEW", headSha: HEAD, noInflightEpoch: true, store: SETTLED });
    expect(ev).toEqual({ type: "caught_up", headSha: HEAD });
  });

  it("a §6 trigger with the conjunction UNmet recomputes nothing (ran, did not newly hold)", () => {
    const event: FsmEvent = { type: "epoch.replied", epochId: "e1" };
    expect(classifyCaughtUpTrigger("REVIEW", event, "REVIEW")).not.toBeNull();
    const ev = recomputeCaughtUp({
      resultingState: "REVIEW",
      headSha: HEAD,
      noInflightEpoch: true,
      store: stubStore(1),
    });
    expect(ev).toBeNull();
  });
});

// ── (4) KEYSTONE — a true caught_up reaches MERGE_READY end-to-end through the real transition fn ──────
describe("KEYSTONE — producer→consumer: a clean QA pass reaches MERGE_READY end-to-end", () => {
  it("VERIFYING.verification.pass → REVIEW → recompute emits caught_up → cascade row 7 → MERGE_READY", () => {
    const RUN_ID = 4;
    // Step 1 (real transition): a fresh QA pass exits VERIFYING back into REVIEW (record_qa: verdict=pass,
    // qa_head_sha := head, code_changed := false).
    const verdict: FsmEvent = { type: "verification.pass", headSha: HEAD, runId: RUN_ID };
    const exit = transition("VERIFYING", verdict, { sandboxAlive: true, verificationRunId: RUN_ID });
    expect(exit?.to).toBe("REVIEW");

    // Step 2: the spine classifies the committed transition as the §6.5 verification_verdict_return trigger.
    expect(classifyCaughtUpTrigger("VERIFYING", verdict, exit!.to)).toBe("verification_verdict_return");

    // Step 3: recompute off the post-commit snapshot — caught_up holds (no epoch, nothing undispositioned,
    // reviewers settled), so the producer emits the internal caught_up{head} event.
    const caughtUpEvent = recomputeCaughtUp({
      resultingState: exit!.to,
      headSha: HEAD,
      noInflightEpoch: true,
      store: SETTLED,
    });
    expect(caughtUpEvent).toEqual({ type: "caught_up", headSha: HEAD });

    // Step 4 (real transition): feed caught_up back into the REVIEW cascade with row-7 live-reads
    // (¬code_changed ∧ ci_green ∧ pass ∧ fresh) — the SOLE MERGE_READY emitter (D10).
    const row7Guards: Guards = {
      sandboxAlive: true,
      // W11-T1: the green rung now requires no_inflight_epoch (the stale-green race conjunct). Verification
      // fields are no longer read by the CI-ladder cascade (decoupled).
      noInflightEpoch: true,
      ciBucket: "ci_green",
    };
    const ready = transition("REVIEW", caughtUpEvent!, row7Guards);
    expect(ready?.to).toBe("MERGE_READY");
    expect(ready?.sideEffects).toEqual([{ kind: "emit_settle" }, { kind: "notify_user" }]);
  });

  it("the emitted caught_up is unhandled in a non-REVIEW state (re-emission is a safe log_noop, idempotence)", () => {
    // If a caught_up ever reaches MERGE_READY (a race), transition leaves it unhandled → null → the spine
    // logs a noop. The emitter's REVIEW-gate prevents the emit in the first place; this is the second layer.
    const caughtUpEvent: FsmEvent = { type: "caught_up", headSha: HEAD };
    expect(transition("MERGE_READY", caughtUpEvent, { sandboxAlive: true })).toBeNull();
  });
});
