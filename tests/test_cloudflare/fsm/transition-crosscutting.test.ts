// Per-edge unit tests for the ARC-1330 lifecycle-FSM cross-cutting edges (PR 19, design §10). Pure-fn suite:
// `transition` is a pure function of (state, event, guards), so these import it directly and assert the
// returned Decision per edge — no DB harness. Scope: the hard-failure group → FAILED (loud, set reason), the
// AWAITING_INPUT wait-state death → STOPPED(resumable) F4 exception, the post-publish `pr.merged/closed`
// close-out, `user.stop` / `session.archived`, every `deadline_exceeded` target (incl. the {REVIEW}/{VERIFYING}
// drain + the {MERGE_READY} cron-reconcile self-loop), `kill_verification` on every VERIFYING-leaving terminal,
// and the phase-aware `STOPPED — user.input` resume.
// The three spec-named test surfaces are asserted explicitly: GROUP MEMBERSHIP (each state in the §10 group
// routes; non-members fall through to null), RESUME TOTALITY (every resumable phase maps to a target), and
// DEADLINE loud() (every →FAILED/→NEEDS_YOU deadline carries loud, D1).
import { describe, expect, it } from "vitest";

import {
  type Guards,
  isDwellNeutralSelfLoop,
  transition,
} from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { Decision, FsmEvent, FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";

const BASE: Guards = { sandboxAlive: true, verificationChildId: "vchild-1" };
const g = (over: Partial<Guards> = {}): Guards => ({ ...BASE, ...over });

const LOUD = { kind: "loud" } as const;
const LOG_NOOP = { kind: "log_noop" } as const;
const RELEASE = { kind: "release_queued_reviews" } as const;
const KILL_VCHILD = { kind: "kill_verification", args: { verificationChildId: "vchild-1" } } as const;
// R4: the FINAL-terminal VM reclaim rides the close-out bag AFTER the verifier kill.
const TERMINATE_RUNTIME = { kind: "terminate_runtime" } as const;
const NULL_KILL = { kind: "kill_verification", args: { verificationChildId: null } } as const;

const HARD_FAILURE_STATES: readonly FsmState[] = ["CREATED", "PROVISIONING", "GENERATING", "FINALIZING", "PUBLISHING"];
const POST_PUBLISH_PR_STATES: readonly FsmState[] = ["REVIEW", "VERIFYING", "MERGE_READY", "NEEDS_YOU", "STOPPED"];
const NON_TERMINAL_STATES: readonly FsmState[] = [
  "CREATED",
  "PROVISIONING",
  "GENERATING",
  "AWAITING_INPUT",
  "FINALIZING",
  "PUBLISHING",
  "REVIEW",
  "VERIFYING",
];
const FINAL_TERMINAL_STATES: readonly FsmState[] = ["MERGED", "CLOSED", "SUPERSEDED", "ARCHIVED"];
const ALL_STATES: readonly FsmState[] = [
  "CREATED",
  "PROVISIONING",
  "GENERATING",
  "AWAITING_INPUT",
  "FINALIZING",
  "PUBLISHING",
  "ANSWERED_NO_PR",
  "REVIEW",
  "VERIFYING",
  "MERGE_READY",
  "NEEDS_YOU",
  "FAILED",
  "STOPPED",
  "MERGED",
  "CLOSED",
  "SUPERSEDED",
  "ARCHIVED",
];

describe("cross-cutting — hard-failure group → FAILED (loud, set failure_reason)", () => {
  it.each(HARD_FAILURE_STATES)("%s — sandbox.death → FAILED(sandbox_failed) / loud", (state) => {
    expect(transition(state, { type: "sandbox.death" }, g())).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "sandbox_failed" },
      sideEffects: [LOUD],
    });
  });

  it.each(HARD_FAILURE_STATES)("%s — sandbox.liveness_expired → FAILED(sandbox_failed)", (state) => {
    expect(transition(state, { type: "sandbox.liveness_expired" }, g())?.to).toBe("FAILED");
  });

  it.each(HARD_FAILURE_STATES)("%s — sandbox.spawn_failed → FAILED(sandbox_failed)", (state) => {
    expect(transition(state, { type: "sandbox.spawn_failed" }, g())).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "sandbox_failed" },
      sideEffects: [LOUD],
    });
  });

  it.each(HARD_FAILURE_STATES)("%s — prompt.max_duration_exceeded → FAILED(execution_timeout)", (state) => {
    expect(transition(state, { type: "prompt.max_duration_exceeded" }, g())).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "execution_timeout" },
      sideEffects: [LOUD],
    });
  });

  it.each(HARD_FAILURE_STATES)("%s — prompt.terminal{error} → FAILED(codegen_error)", (state) => {
    expect(transition(state, { type: "prompt.terminal", outcome: "error" }, g())?.fieldWrites).toEqual({
      failureReason: "codegen_error",
    });
  });

  it("GENERATING — prompt.terminal{error} keeps its core codegen_error Decision", () => {
    // The per-state core edge (PR 5) wins; it carries loud only — the cross-cutting layer is never reached.
    expect(transition("GENERATING", { type: "prompt.terminal", outcome: "error" }, g())).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "codegen_error" },
      sideEffects: [LOUD],
    });
  });

  it("AWAITING_INPUT is NOT in the hard-failure group (F4): sandbox.death → STOPPED(resumable), not FAILED", () => {
    expect(transition("AWAITING_INPUT", { type: "sandbox.death" }, g())).toEqual({
      to: "STOPPED",
      fieldWrites: { stopMode: "resumable", preStopState: "AWAITING_INPUT" },
      sideEffects: [],
    });
    expect(transition("AWAITING_INPUT", { type: "sandbox.liveness_expired" }, g())?.to).toBe("STOPPED");
  });

  it("a non-group, non-AWAITING_INPUT state ignores hard-failure events (post-publish death is not pre-publish FAILED)", () => {
    expect(transition("REVIEW", { type: "sandbox.death" }, g())).toBeNull();
    expect(transition("MERGE_READY", { type: "sandbox.spawn_failed" }, g())).toBeNull();
  });

  it("prompt.terminal{changes|no_changes} is NOT a hard failure outside GENERATING (not handled here)", () => {
    expect(transition("FINALIZING", { type: "prompt.terminal", outcome: "no_changes" }, g())).toBeNull();
  });

  it("prompt.terminal{error} in the post-publish listening states is an unhandled noop, never FAILED(codegen_error) (ARC-1470)", () => {
    // A verifier child's transport terminal only projects codegen_error on ITS OWN record's hard-failure
    // states; the parent's REVIEW/VERIFYING record must never absorb one as a failure.
    expect(transition("REVIEW", { type: "prompt.terminal", outcome: "error" }, g())).toBeNull();
    expect(transition("VERIFYING", { type: "prompt.terminal", outcome: "error" }, g())).toBeNull();
  });
});

describe("cross-cutting — corroborated aborted prompt terminal = user stop (quiet STOPPED, never a loud codegen_error)", () => {
  // The bridge reports a user stop of an active prompt as errorCode "aborted" and the DO corroborates
  // it (stoppedByUser: the terminal's error text matches the bridge's deliberate stop reason). That
  // terminal is the transport-delivered `user.stop` signal, NOT a codegen failure: it takes the same
  // STOPPED(user) close-out as the user.stop edge (quiet — no loud alert, no failure_reason).
  const ABORTED_STOP = {
    type: "prompt.terminal",
    outcome: "error",
    errorCode: "aborted",
    stoppedByUser: true,
  } as const;

  it.each(HARD_FAILURE_STATES)(
    "%s — prompt.terminal{error, aborted, stoppedByUser} → STOPPED(user, pre_stop_state=state), quiet",
    (state) => {
      const d = transition(state, ABORTED_STOP, g());
      expect(d?.to).toBe("STOPPED");
      expect(d?.fieldWrites).toEqual({ stopMode: "user", preStopState: state });
      expect(d?.sideEffects).not.toContainEqual(LOUD);
      expect(d?.sideEffects).toContainEqual(KILL_VCHILD);
    },
  );

  it("a corroborated stop terminal never carries terminate_runtime (a user stop keeps the VM, like user.stop → STOPPED)", () => {
    for (const state of HARD_FAILURE_STATES) {
      expect(transition(state, ABORTED_STOP, g())?.sideEffects).not.toContainEqual(TERMINATE_RUNTIME);
    }
  });

  it("an UNCORROBORATED aborted terminal stays FAILED(codegen_error)/loud — bridge 'aborted' is overloaded (init AbortError, external delete, failsafe)", () => {
    for (const state of HARD_FAILURE_STATES) {
      const d = transition(state, { type: "prompt.terminal", outcome: "error", errorCode: "aborted" }, g());
      expect(d?.to).toBe("FAILED");
      expect(d?.fieldWrites).toEqual({ failureReason: "codegen_error" });
      expect(d?.sideEffects).toContainEqual(LOUD);
    }
  });

  it("a corroborated stop with a NON-aborted errorCode stays FAILED (a real crash raced the stop; the crash terminated it)", () => {
    for (const state of HARD_FAILURE_STATES) {
      expect(
        transition(
          state,
          { type: "prompt.terminal", outcome: "error", errorCode: "api_error", stoppedByUser: true },
          g(),
        )?.fieldWrites,
      ).toEqual({ failureReason: "codegen_error" });
    }
  });

  it("a non-aborted errorCode keeps the FAILED(codegen_error) hard-failure Decision", () => {
    for (const state of HARD_FAILURE_STATES) {
      expect(
        transition(state, { type: "prompt.terminal", outcome: "error", errorCode: "unknown" }, g())?.fieldWrites,
      ).toEqual({ failureReason: "codegen_error" });
    }
  });

  it("corroborated stop terminals outside the hard-failure group stay unhandled (post-publish/resting states)", () => {
    expect(transition("REVIEW", ABORTED_STOP, g())).toBeNull();
    expect(transition("VERIFYING", ABORTED_STOP, g())).toBeNull();
    expect(transition("STOPPED", ABORTED_STOP, g())).toBeNull();
    expect(transition("FAILED", ABORTED_STOP, g())).toBeNull();
  });
});

describe("cross-cutting — PR closed out → terminal-final (post-publish group)", () => {
  it.each(POST_PUBLISH_PR_STATES)("%s — pr.merged → MERGED", (state) => {
    const d = transition(state, { type: "pr.merged" }, g());
    expect(d?.to).toBe("MERGED");
  });

  it.each(POST_PUBLISH_PR_STATES)("%s — pr.closed → CLOSED", (state) => {
    const d = transition(state, { type: "pr.closed" }, g());
    expect(d?.to).toBe("CLOSED");
  });

  it("VERIFYING close-out runs kill_verification THEN terminate_runtime (leaving VERIFYING tears the run down + reclaims the VM)", () => {
    expect(transition("VERIFYING", { type: "pr.merged" }, g())).toEqual({
      to: "MERGED",
      fieldWrites: {},
      sideEffects: [KILL_VCHILD, TERMINATE_RUNTIME],
    });
    expect(transition("VERIFYING", { type: "pr.closed" }, g())?.sideEffects).toEqual([KILL_VCHILD, TERMINATE_RUNTIME]);
  });

  it("a publish-time verifier child that outlived REVIEW into MERGE_READY / NEEDS_YOU is killed on close-out (A3)", () => {
    // Post-A3 the fire-and-forget verifier can still be running when the CI ladder advances the parent to
    // MERGE_READY (or NEEDS_YOU); a merge/close from there must still tear the child down.
    expect(transition("MERGE_READY", { type: "pr.merged" }, g())?.sideEffects).toContainEqual(KILL_VCHILD);
    expect(transition("NEEDS_YOU", { type: "pr.closed" }, g())?.sideEffects).toContainEqual(KILL_VCHILD);
  });

  it("a non-post-publish state ignores pr.merged/closed (no live PR yet)", () => {
    expect(transition("GENERATING", { type: "pr.merged" }, g())).toBeNull();
    expect(transition("CREATED", { type: "pr.closed" }, g())).toBeNull();
  });
});

describe("cross-cutting — benign publish supersede → SUPERSEDED (ARC-1389)", () => {
  it("REVIEW — publish.superseded → SUPERSEDED, killing a publish-time verifier child owned by the REVIEW row (A3)", () => {
    // A3: a fire-and-forget verifier spawned at publish rides the REVIEW row. The close-out must tear it
    // down so it can't keep running against the abandoned PR — the kill is gated on the handle, not on
    // being in VERIFYING.
    expect(transition("REVIEW", { type: "publish.superseded" }, g())).toEqual({
      to: "SUPERSEDED",
      fieldWrites: {},
      sideEffects: [KILL_VCHILD, TERMINATE_RUNTIME],
    });
  });

  it("REVIEW — publish.superseded → SUPERSEDED with NO owned verifier child is an inert null kill + terminate_runtime", () => {
    expect(transition("REVIEW", { type: "publish.superseded" }, g({ verificationChildId: undefined }))).toEqual({
      to: "SUPERSEDED",
      fieldWrites: {},
      sideEffects: [NULL_KILL, TERMINATE_RUNTIME],
    });
  });

  it("VERIFYING — publish.superseded → SUPERSEDED / kill_verification THEN terminate_runtime", () => {
    expect(transition("VERIFYING", { type: "publish.superseded" }, g())).toEqual({
      to: "SUPERSEDED",
      fieldWrites: {},
      sideEffects: [KILL_VCHILD, TERMINATE_RUNTIME],
    });
  });

  it("publish.superseded is unhandled outside the review-listening states (the benign block can't fire there)", () => {
    for (const state of ALL_STATES) {
      if (state === "REVIEW" || state === "VERIFYING") continue;
      expect(transition(state, { type: "publish.superseded" }, g()), `${state} must not handle it`).toBeNull();
    }
  });

  it("SUPERSEDED is a FINAL terminal: archived/stop/pr-close/deadline are all unhandled there", () => {
    expect(transition("SUPERSEDED", { type: "session.archived" }, g())).toBeNull();
    expect(transition("SUPERSEDED", { type: "user.stop" }, g())).toBeNull();
    expect(transition("SUPERSEDED", { type: "pr.merged" }, g())).toBeNull();
    expect(transition("SUPERSEDED", { type: "pr.closed" }, g())).toBeNull();
    expect(transition("SUPERSEDED", { type: "deadline_exceeded" }, g())).toBeNull();
  });
});

describe("cross-cutting — stop / archive", () => {
  it.each(NON_TERMINAL_STATES)("%s — user.stop → STOPPED(user, pre_stop_state=state)", (state) => {
    const d = transition(state, { type: "user.stop" }, g());
    expect(d?.to).toBe("STOPPED");
    expect(d?.fieldWrites).toEqual({ stopMode: "user", preStopState: state });
  });

  it("VERIFYING — user.stop also kills the live verification run", () => {
    expect(transition("VERIFYING", { type: "user.stop" }, g())?.sideEffects).toContainEqual(KILL_VCHILD);
  });

  it("user.stop is unhandled in the resting terminals (only non-terminal states stop)", () => {
    for (const state of ["MERGE_READY", "NEEDS_YOU", "STOPPED", "FAILED", "MERGED", "CLOSED", "ARCHIVED"] as const) {
      expect(transition(state, { type: "user.stop" }, g())).toBeNull();
    }
  });

  it("session.archived → ARCHIVED for every state EXCEPT the final terminals (F26)", () => {
    for (const state of ALL_STATES) {
      const d = transition(state, { type: "session.archived" }, g());
      if (FINAL_TERMINAL_STATES.includes(state)) {
        expect(d, `${state} is already final — archived is a no-op`).toBeNull();
      } else {
        expect(d?.to, `${state} → ARCHIVED`).toBe("ARCHIVED");
      }
    }
  });

  it("VERIFYING — session.archived also kills the live verification run", () => {
    expect(transition("VERIFYING", { type: "session.archived" }, g())?.sideEffects).toContainEqual(KILL_VCHILD);
  });
});

// R4: the FINAL-terminal VM reclaim (`terminate_runtime`) rides every final-terminal close-out AFTER the
// verifier kill, and the N9 PUBLISHING race arms too — but NEVER `user.stop → STOPPED` (which stays
// resumable and must keep its VM). This is the whole safety contract of the unit.
describe("R4 — terminate_runtime on FINAL terminals (never on user.stop)", () => {
  it("the four cross-cutting final-terminal close-outs carry [kill_verification, terminate_runtime]", () => {
    expect(transition("REVIEW", { type: "pr.merged" }, g())?.sideEffects).toEqual([KILL_VCHILD, TERMINATE_RUNTIME]);
    expect(transition("MERGE_READY", { type: "pr.closed" }, g())?.sideEffects).toEqual([
      KILL_VCHILD,
      TERMINATE_RUNTIME,
    ]);
    expect(transition("REVIEW", { type: "publish.superseded" }, g())?.sideEffects).toEqual([
      KILL_VCHILD,
      TERMINATE_RUNTIME,
    ]);
    expect(transition("REVIEW", { type: "session.archived" }, g())?.sideEffects).toEqual([
      KILL_VCHILD,
      TERMINATE_RUNTIME,
    ]);
  });

  it("both PUBLISHING N9 race arms carry terminate_runtime (verifier not yet spawned → null-safe kill)", () => {
    // At PUBLISHING no verifier child exists yet, so the kill fires null-safe; terminate_runtime still reclaims the VM.
    expect(transition("PUBLISHING", { type: "pr.merged" }, g({ verificationChildId: undefined }))).toEqual({
      to: "MERGED",
      fieldWrites: {},
      sideEffects: [NULL_KILL, TERMINATE_RUNTIME],
    });
    expect(transition("PUBLISHING", { type: "pr.closed" }, g({ verificationChildId: undefined }))).toEqual({
      to: "CLOSED",
      fieldWrites: {},
      sideEffects: [NULL_KILL, TERMINATE_RUNTIME],
    });
  });

  it("user.stop → STOPPED never carries terminate_runtime (STOPPED stays resumable, VM retained)", () => {
    for (const state of NON_TERMINAL_STATES) {
      const d = transition(state, { type: "user.stop" }, g());
      expect(d?.to).toBe("STOPPED");
      expect(d?.sideEffects, `${state} user.stop keeps the VM`).not.toContainEqual(TERMINATE_RUNTIME);
    }
  });
});

describe("cross-cutting — deadline_exceeded targets (§10) + loud()", () => {
  it("{CREATED,PROVISIONING} → FAILED(spawn_timeout) / loud", () => {
    for (const state of ["CREATED", "PROVISIONING"] as const) {
      expect(transition(state, { type: "deadline_exceeded" }, g())).toEqual({
        to: "FAILED",
        fieldWrites: { failureReason: "spawn_timeout" },
        sideEffects: [LOUD],
      });
    }
  });

  it("{GENERATING,FINALIZING,PUBLISHING} → FAILED(execution_timeout) / loud", () => {
    for (const state of ["GENERATING", "FINALIZING", "PUBLISHING"] as const) {
      expect(transition(state, { type: "deadline_exceeded" }, g())).toEqual({
        to: "FAILED",
        fieldWrites: { failureReason: "execution_timeout" },
        sideEffects: [LOUD],
      });
    }
  });

  it("{AWAITING_INPUT} → STOPPED(resumable, NO blocked_reason)", () => {
    expect(transition("AWAITING_INPUT", { type: "deadline_exceeded" }, g())).toEqual({
      to: "STOPPED",
      fieldWrites: { stopMode: "resumable", preStopState: "AWAITING_INPUT" },
      sideEffects: [],
    });
  });

  it("{REVIEW} → NEEDS_YOU(review_stuck) / release_queued_reviews, loud (B2 drain, D1)", () => {
    expect(transition("REVIEW", { type: "deadline_exceeded" }, g())).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "review_stuck" },
      sideEffects: [RELEASE, LOUD],
    });
  });

  it("{VERIFYING} → NEEDS_YOU(verification_stopped) / drain + kill_verification + loud (coarse backstop, P2/B2/D1)", () => {
    expect(transition("VERIFYING", { type: "deadline_exceeded" }, g())).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "verification_stopped" },
      sideEffects: [RELEASE, KILL_VCHILD, LOUD],
    });
  });

  it("{MERGE_READY} → cron reconcile: a NON-terminal handled self-loop (log_noop), re-arms via the universal deadline (D17)", () => {
    expect(transition("MERGE_READY", { type: "deadline_exceeded" }, g())).toEqual({
      to: "MERGE_READY",
      fieldWrites: {},
      sideEffects: [LOG_NOOP],
    });
  });

  it("the resting terminals have no §10 deadline target → unhandled (null)", () => {
    for (const state of ["NEEDS_YOU", "STOPPED", "ANSWERED_NO_PR", "FAILED", "MERGED", "CLOSED", "ARCHIVED"] as const) {
      expect(transition(state, { type: "deadline_exceeded" }, g())).toBeNull();
    }
  });

  it("deadline loud(): every →FAILED / →NEEDS_YOU deadline edge carries loud() (D1)", () => {
    for (const state of [
      "CREATED",
      "PROVISIONING",
      "GENERATING",
      "FINALIZING",
      "PUBLISHING",
      "REVIEW",
      "VERIFYING",
    ] as const) {
      expect(transition(state, { type: "deadline_exceeded" }, g())?.sideEffects).toContainEqual(LOUD);
    }
  });

  // ── SF10 (W11-V5): the epoch retry-budget re-expression, form (b) ──
  // The legacy `pr_review_response_epochs.transient_failure_count` cap (blocks an epoch after N
  // transient poll failures) is NOT re-expressed as an FSM guard/field. Instead THIS edge — the
  // in-flight epoch's {REVIEW} deadline → NEEDS_YOU(review_stuck) — is the accepted LOUD give-up.
  // D-53 drops the legacy counter columns on the strength of this pin. An `epoch.deferred` self-loop
  // (an active retry, above) re-arms this deadline as a keep-alive; the give-up fires once retrying
  // stops. This test is the SF10 anchor D-53's gate evidence cites.
  it("SF10: the in-flight-epoch {REVIEW} deadline → NEEDS_YOU(review_stuck) IS the accepted give-up replacing transient_failure_count", () => {
    const give_up = transition("REVIEW", { type: "deadline_exceeded" }, g());
    expect(give_up).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "review_stuck" },
      sideEffects: [RELEASE, LOUD],
    });
    // It is LOUD (hands the session to the user) — the "loud give-up" SF10 requires.
    expect(give_up?.sideEffects).toContainEqual(LOUD);
  });
});

describe("cross-cutting — epoch.deferred journal self-loop (W11-V5, §17-B / SF10)", () => {
  const DEFERRALS = [
    { type: "epoch.deferred", epochId: "ep-1", deferralKind: "contention" },
    { type: "epoch.deferred", epochId: "ep-1", deferralKind: "transient" },
  ] as const;

  it("is a REVIEW log_noop self-loop — journals the deferral, NO state change, epoch stays in-flight", () => {
    for (const event of DEFERRALS) {
      expect(transition("REVIEW", event, g())).toEqual({ to: "REVIEW", fieldWrites: {}, sideEffects: [LOG_NOOP] });
    }
  });

  it("is unhandled (null) everywhere but REVIEW — an epoch only lives in REVIEW; elsewhere it's a benign no-op", () => {
    for (const state of ALL_STATES) {
      if (state === "REVIEW") continue;
      for (const event of DEFERRALS) {
        expect(transition(state, event, g())).toBeNull();
      }
    }
  });
});

describe("SF10 dwell-neutrality — the DECISION-SHAPE authority (W11-V5 re-review fix)", () => {
  const d = (over: Partial<Decision>): Decision => ({ to: "REVIEW", fieldWrites: {}, sideEffects: [], ...over });

  it("TRUE for a pure-churn REVIEW→REVIEW self-loop (empty writes, log_noop-only, no registration)", () => {
    expect(isDwellNeutralSelfLoop("REVIEW", d({ sideEffects: [LOG_NOOP] }))).toBe(true);
    expect(isDwellNeutralSelfLoop("REVIEW", d({ sideEffects: [] }))).toBe(true);
    // The actual churn edges the FSM produces (via `transition`) qualify:
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        transition("REVIEW", { type: "epoch.deferred", epochId: "e", deferralKind: "contention" }, g())!,
      ),
    ).toBe(true);
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        transition("REVIEW", { type: "ci.signal", ciState: "green" }, g({ noInflightEpoch: false }))!,
      ),
    ).toBe(true);
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        transition("REVIEW", { type: "ci.signal", ciState: "failing" }, g({ noInflightEpoch: false }))!,
      ),
    ).toBe(true);
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        transition("REVIEW", { type: "review.received", reviewerKind: "bot", actionable: false }, g())!,
      ),
    ).toBe(true);
    // MAJOR-1 value-gate: a no-inflight GREEN re-observe with ci_fix_rounds ALREADY 0 is a no-op reset →
    // the FG-2 edge emits an EMPTY decision → churn (would otherwise re-arm the no-inflight-green cohort).
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        transition(
          "REVIEW",
          { type: "ci.signal", ciState: "green" },
          g({ noInflightEpoch: true, ciSettled: true, epoch1Fired: true, actionableExists: false, ciFixRounds: 0 }),
        )!,
      ),
    ).toBe(true);
    // VERIFYING churn: ci.signal is ignored during VERIFYING (§9 QA contract) → empty log_noop self-loop.
    expect(
      isDwellNeutralSelfLoop("VERIFYING", transition("VERIFYING", { type: "ci.signal", ciState: "green" }, g())!),
    ).toBe(true);
    expect(
      isDwellNeutralSelfLoop(
        "VERIFYING",
        transition("VERIFYING", { type: "review.received", reviewerKind: "bot", actionable: false }, g())!,
      ),
    ).toBe(true);
  });

  it("FALSE for a field-WRITING self-loop (progress) — the value-gated FG-2 green reset re-arms when a budget exists", () => {
    expect(isDwellNeutralSelfLoop("REVIEW", d({ fieldWrites: { ciFixRounds: 0 }, sideEffects: [LOG_NOOP] }))).toBe(
      false,
    );
    // A green with no in-flight epoch AND ci_fix_rounds > 0 runs a REAL resetCiFixRounds → writes → re-arms.
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        transition(
          "REVIEW",
          { type: "ci.signal", ciState: "green" },
          g({ noInflightEpoch: true, ciSettled: true, epoch1Fired: true, actionableExists: false, ciFixRounds: 2 }),
        )!,
      ),
    ).toBe(false);
  });

  it("FALSE for a REGISTERING self-loop (an actionable review is activity, not churn)", () => {
    expect(
      isDwellNeutralSelfLoop(
        "REVIEW",
        d({ worklistRegistrations: [{ sourceId: "r1", origin: "review", disposition: "none" }] }),
      ),
    ).toBe(false);
  });

  it("FALSE for a non-log_noop side-effect, a non-REVIEW from-state, and a state change (MERGE_READY reconcile is exempt)", () => {
    expect(isDwellNeutralSelfLoop("REVIEW", d({ sideEffects: [{ kind: "loud" }] }))).toBe(false);
    expect(isDwellNeutralSelfLoop("MERGE_READY", { to: "MERGE_READY", fieldWrites: {}, sideEffects: [LOG_NOOP] })).toBe(
      false,
    );
    expect(isDwellNeutralSelfLoop("REVIEW", d({ to: "NEEDS_YOU", sideEffects: [LOG_NOOP] }))).toBe(false);
  });
});

// MINOR (lockstep): the EXHAUSTIVE dwell classification of EVERY REVIEW & VERIFYING self-loop edge the
// FSM can produce. A future edge that silently rides the give-up (a churn shape that should re-arm) or
// escapes it (a progress shape mis-shaped as churn) fails HERE. If you add a self-loop edge, add its row.
describe("SF10 dwell classification — exhaustive self-loop lockstep (W11-V5)", () => {
  interface Row {
    label: string;
    from: FsmState;
    event: FsmEvent;
    guards: Guards;
    neutral: boolean;
  }
  const ROWS: Row[] = [
    // ── REVIEW self-loops ──
    {
      label: "epoch.deferred",
      from: "REVIEW",
      event: { type: "epoch.deferred", epochId: "e", deferralKind: "contention" },
      guards: g(),
      neutral: true,
    },
    {
      label: "ci.signal(failing)[in_flight]",
      from: "REVIEW",
      event: { type: "ci.signal", ciState: "failing" },
      guards: g({ noInflightEpoch: false }),
      neutral: true,
    },
    {
      label: "ci.signal(green)[in_flight]",
      from: "REVIEW",
      event: { type: "ci.signal", ciState: "green" },
      guards: g({ noInflightEpoch: false }),
      neutral: true,
    },
    {
      label: "ci.signal(green)[no_inflight, FG-2 reset=0 → no-op]",
      from: "REVIEW",
      event: { type: "ci.signal", ciState: "green" },
      guards: g({ noInflightEpoch: true, ciSettled: true, epoch1Fired: true, actionableExists: false, ciFixRounds: 0 }),
      neutral: true,
    },
    {
      label: "ci.signal(green)[no_inflight, FG-2 reset>0 → real reset]",
      from: "REVIEW",
      event: { type: "ci.signal", ciState: "green" },
      guards: g({ noInflightEpoch: true, ciSettled: true, epoch1Fired: true, actionableExists: false, ciFixRounds: 2 }),
      neutral: false,
    },
    {
      label: "ci.signal(failing)[no_inflight, dispatch ciFix]",
      from: "REVIEW",
      event: { type: "ci.signal", ciState: "failing" },
      guards: g({ noInflightEpoch: true, underCiFixCap: true, ciFixRounds: 0, newEpochId: "e" }),
      neutral: false,
    },
    {
      label: "review.received[¬actionable]",
      from: "REVIEW",
      event: { type: "review.received", reviewerKind: "bot", actionable: false },
      guards: g(),
      neutral: true,
    },
    {
      label: "review.received[actionable, in_flight → register]",
      from: "REVIEW",
      event: { type: "review.received", reviewerKind: "bot", actionable: true },
      guards: g({ noInflightEpoch: false, reviewSourceId: "r" }),
      neutral: false,
    },
    {
      label: "review.received[actionable, no_inflight → dispatch+register]",
      from: "REVIEW",
      event: { type: "review.received", reviewerKind: "bot", actionable: true },
      guards: g({ noInflightEpoch: true, newEpochId: "e", reviewSourceId: "r" }),
      neutral: false,
    },
    {
      label: "review.item_ready[in_flight]",
      from: "REVIEW",
      event: { type: "review.item_ready", itemId: "i" },
      guards: g({ noInflightEpoch: false }),
      neutral: true,
    },
    {
      label: "review.item_ready[no_inflight → dispatch]",
      from: "REVIEW",
      event: { type: "review.item_ready", itemId: "i" },
      guards: g({ noInflightEpoch: true, newEpochId: "e" }),
      neutral: false,
    },
    {
      label: "head.noop_changed[¬code_changed → restamp]",
      from: "REVIEW",
      event: { type: "head.noop_changed", headSha: "h" },
      guards: g({ codeChangedSinceVerification: false }),
      neutral: false,
    },
    {
      label: "head.noop_changed[code_changed → advance]",
      from: "REVIEW",
      event: { type: "head.noop_changed", headSha: "h" },
      guards: g({ codeChangedSinceVerification: true }),
      neutral: false,
    },
    {
      label: "head.changed",
      from: "REVIEW",
      event: { type: "head.changed", headSha: "h" },
      guards: g(),
      neutral: false,
    },
    {
      label: "epoch.committed",
      from: "REVIEW",
      event: { type: "epoch.committed", epochId: "e" },
      guards: g(),
      neutral: false,
    },
    {
      label: "epoch.replied",
      from: "REVIEW",
      event: { type: "epoch.replied", epochId: "e" },
      guards: g(),
      neutral: false,
    },
    {
      label: "epoch.declined",
      from: "REVIEW",
      event: { type: "epoch.declined", epochId: "e" },
      guards: g(),
      neutral: false,
    },
    {
      label: "caught_up row-5 (ci_pending WAIT)",
      from: "REVIEW",
      event: { type: "caught_up", headSha: "h" },
      guards: g({ codeChangedSinceVerification: false, ciBucket: "ci_pending" }),
      neutral: true,
    },
    {
      label: "caught_up row-3 (ciFix dispatch)",
      from: "REVIEW",
      event: { type: "caught_up", headSha: "h" },
      guards: g({
        codeChangedSinceVerification: false,
        ciBucket: "ci_red",
        underCiFixCap: true,
        ciFixRounds: 0,
        newEpochId: "e",
      }),
      neutral: false,
    },
    {
      label: "R: verification.pass[fresh] (records verdict — progress)",
      from: "REVIEW",
      event: { type: "verification.pass", headSha: "vh", runId: 5 },
      guards: g({ verificationRunId: 5, verificationChildId: "c" }),
      neutral: false,
    },
    {
      label: "R: verification.stopped[fresh] (notify_qa_issue — not log_noop-only)",
      from: "REVIEW",
      event: { type: "verification.stopped", runId: 5 },
      guards: g({ verificationRunId: 5, verificationChildId: "c" }),
      neutral: false,
    },
    {
      label: "R: verification.pass[stale] (ghost-discard carries a kill — not log_noop-only)",
      from: "REVIEW",
      event: { type: "verification.pass", headSha: "gh", runId: 99 },
      guards: g({ verificationRunId: 5, verdictVerificationChildId: "gc" }),
      neutral: false,
    },
    // ── VERIFYING self-loops ──
    {
      label: "V: ci.signal (ignored during VERIFYING)",
      from: "VERIFYING",
      event: { type: "ci.signal", ciState: "green" },
      guards: g(),
      neutral: true,
    },
    {
      label: "V: review.received[¬actionable]",
      from: "VERIFYING",
      event: { type: "review.received", reviewerKind: "bot", actionable: false },
      guards: g(),
      neutral: true,
    },
    {
      label: "V: review.received[actionable → queue_review register]",
      from: "VERIFYING",
      event: { type: "review.received", reviewerKind: "bot", actionable: true },
      guards: g({ reviewSourceId: "r" }),
      neutral: false,
    },
    {
      label: "V: head.noop_changed (restamp)",
      from: "VERIFYING",
      event: { type: "head.noop_changed", headSha: "h" },
      guards: g(),
      neutral: false,
    },
    {
      label: "V: head.changed (re-run)",
      from: "VERIFYING",
      event: { type: "head.changed", headSha: "h" },
      guards: g(),
      neutral: false,
    },
    {
      label: "V: verification.pass ghost (!fresh, kill)",
      from: "VERIFYING",
      event: { type: "verification.pass", headSha: "h", runId: 2 },
      guards: g({ verificationRunId: 1 }),
      neutral: false,
    },
    {
      label: "V: verification.stopped ghost (!fresh, kill)",
      from: "VERIFYING",
      event: { type: "verification.stopped", runId: 2 },
      guards: g({ verificationRunId: 1 }),
      neutral: false,
    },
  ];

  it.each(ROWS)("$label → self-loop, dwell-neutral=$neutral", ({ from, event, guards, neutral }) => {
    const decision = transition(from, event, guards);
    expect(decision).not.toBeNull();
    expect(decision!.to).toBe(from); // it IS a self-loop (the classification only applies to self-loops)
    expect(isDwellNeutralSelfLoop(from, decision!)).toBe(neutral);
  });

  it("MERGE_READY log_noop self-loops are NEVER dwell-neutral (the reconcile keep-alive is intentional)", () => {
    // deadline_exceeded → MERGE_READY / log_noop, and review.received[¬actionable] → MERGE_READY / log_noop.
    for (const event of [
      { type: "deadline_exceeded" },
      { type: "review.received", reviewerKind: "bot", actionable: false },
    ] as const) {
      const decision = transition("MERGE_READY", event, g());
      expect(decision).not.toBeNull();
      expect(decision!.to).toBe("MERGE_READY");
      expect(isDwellNeutralSelfLoop("MERGE_READY", decision!)).toBe(false);
    }
  });
});

describe("cross-cutting — phase-aware resume (STOPPED — user.input[resumable])", () => {
  const resume = (preStopState: FsmState, over: Partial<Guards> = {}) =>
    transition("STOPPED", { type: "user.input" }, g({ stopMode: "resumable", preStopState, ...over }));

  it("codegen-phase + live sandbox → GENERATING / dispatch_prompt", () => {
    for (const phase of ["GENERATING", "AWAITING_INPUT"] as const) {
      expect(resume(phase, { sandboxAlive: true })).toEqual({
        to: "GENERATING",
        fieldWrites: { stopMode: null, preStopState: null },
        sideEffects: [{ kind: "dispatch_prompt" }],
      });
    }
  });

  it("codegen-phase + dead sandbox → PROVISIONING / spawn_sandbox", () => {
    expect(resume("GENERATING", { sandboxAlive: false })).toEqual({
      to: "PROVISIONING",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [{ kind: "spawn_sandbox" }],
    });
  });

  it("publish-phase → re-enter the phase (FINALIZING re-runs post-exec; PUBLISHING retries open_pr)", () => {
    expect(resume("FINALIZING", { sandboxAlive: true })).toEqual({
      to: "FINALIZING",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [],
    });
    expect(resume("PUBLISHING", { sandboxAlive: true })).toEqual({
      to: "PUBLISHING",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [{ kind: "open_pr" }],
    });
  });

  it("publish-phase + dead sandbox + unpushed diff → PROVISIONING (nothing to retry, SF12)", () => {
    expect(resume("PUBLISHING", { sandboxAlive: false, unpushedDiff: true })).toEqual({
      to: "PROVISIONING",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [{ kind: "spawn_sandbox" }],
    });
    // dead sandbox but the diff WAS pushed (branch exists) → still retry open_pr, don't discard it.
    expect(resume("PUBLISHING", { sandboxAlive: false, unpushedDiff: false })?.to).toBe("PUBLISHING");
  });

  it("review-phase → re-enter REVIEW and re-arm the watch (no dispatch)", () => {
    expect(resume("REVIEW")).toEqual({
      to: "REVIEW",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [],
    });
  });

  it("VERIFYING-phase → re-enter REVIEW (QA non-blocking; CI ladder owns merge-readiness), no spawn side effect", () => {
    const d = resume("VERIFYING", { verificationRunId: 7 });
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { stopMode: null, preStopState: null },
      sideEffects: [],
    });
    // No verification re-dispatch / spawn: the resume lands in the live REVIEW phase, not a new VERIFYING run.
    expect(d?.sideEffects).toEqual([]);
  });

  it("resume totality: every resumable pre_stop_state phase maps to a non-null target", () => {
    for (const phase of ["GENERATING", "AWAITING_INPUT", "FINALIZING", "PUBLISHING", "REVIEW", "VERIFYING"] as const) {
      expect(resume(phase), `phase ${phase} must resume`).not.toBeNull();
    }
  });

  it("a non-resumable (user) stop does NOT resume on user.input → null", () => {
    expect(transition("STOPPED", { type: "user.input" }, g({ stopMode: "user", preStopState: "REVIEW" }))).toBeNull();
  });

  it("a resumable stop with no recorded phase is unhandled → null (defensive totality floor)", () => {
    expect(transition("STOPPED", { type: "user.input" }, g({ stopMode: "resumable" }))).toBeNull();
  });
});
