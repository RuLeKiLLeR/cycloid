// Per-edge unit tests for the ARC-1330 lifecycle-FSM VERIFYING state (PR 17, design §9 QA contract).
// Pure-fn suite: `transition` is a pure function of (state, event, guards), so these import it directly
// and assert the returned Decision per edge — no DB harness. Scope: the in-place head/review/ci self-loops
// (the run keeps owning the head), the run-scoped-freshness verdict exits (every exit kills the ACTIVE run +
// `release_queued_reviews`), the FG-1 ghost-discard (a verdict from a SUPERSEDED run is dropped, never
// terminating, never consulting the cap, killing only the VERDICT's run), and the terminal exits.
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";

// A fully-populated VERIFYING guard bag; each test overrides only the conjuncts its edge reads.
// `verificationRunId` is the ACTIVE run token (freshness anchor); `verificationChildId` is the active run's
// child handle (killed on every exit); `verdictVerificationChildId` is the spine-resolved VERDICT's-run handle
// (killed ONLY by the FG-1 ghost-discard — a DIFFERENT handle from the live run, by FG-1).
const VERIFYING_BASE: Guards = {
  sandboxAlive: true,
  verificationRunId: 5,
  verificationChildId: "child-active",
  verdictVerificationChildId: "child-ghost",
  reviewSourceId: "rev-src",
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...VERIFYING_BASE, ...over });

const KILL_ACTIVE = { kind: "kill_verification", args: { verificationChildId: "child-active" } } as const;
const KILL_GHOST = { kind: "kill_verification", args: { verificationChildId: "child-ghost" } } as const;
const RELEASE = { kind: "release_queued_reviews" } as const;
const DISPATCH_REVIEW = { kind: "dispatch_epoch", args: { trigger: "review" } } as const;

describe("VERIFYING — in-place head self-loops (the run keeps owning the head)", () => {
  it("head.changed → VERIFYING / advance_head, kill_verification(active), redispatch_verification, spawn (re-run @ new head, NO count burn)", () => {
    const d = transition("VERIFYING", { type: "head.changed", headSha: "newh" }, g());
    expect(d).toEqual({
      to: "VERIFYING",
      // redispatch mints run_id 6 (=5+1) + re-points the run head; it does NOT touch verification_run_count (B1).
      // W11-V4: it also clears verification_child_id so the re-run's spawn anchor starts from a null child slot
      // (the KILL_ACTIVE side-effect already captured the OLD "child-active" handle from the pre-write guard bag).
      fieldWrites: {
        headSha: "newh",
        updateBranchQueuedAt: null,
        verificationRunHead: "newh",
        verificationRunId: 6,
        verificationChildId: null,
      },
      sideEffects: [KILL_ACTIVE, { kind: "spawn_verification_child" }],
    });
  });

  it("head.noop_changed → VERIFYING / advance_head, restamp_verification (keeps the in-flight verdict fresh, no kill, no re-run, SF9)", () => {
    const d = transition("VERIFYING", { type: "head.noop_changed", headSha: "noop-h" }, g());
    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: { headSha: "noop-h", updateBranchQueuedAt: null, verdictHeadSha: "noop-h" },
      sideEffects: [],
    });
    // restamp ONLY moves verdict_head_sha — it never burns a run or kills the child.
    expect(d?.fieldWrites).not.toHaveProperty("verificationRunId");
    expect(d?.sideEffects).toEqual([]);
  });
});

describe("VERIFYING — forced verification.requested (manual Verify button supersede, force-new-session)", () => {
  it("non-forced verification.requested → null (unhandled; the coordinator returns the in-flight verifier)", () => {
    expect(transition("VERIFYING", { type: "verification.requested", headSha: "req-h" }, g())).toBeNull();
    expect(transition("VERIFYING", { type: "verification.requested", headSha: "req-h", force: false }, g())).toBeNull();
  });

  it("forced[under_cap] → VERIFYING / advance_head, request_verification (burns a run), kill_verification(active); NO spawn (the coordinator owns the respawn, mirroring REVIEW→VERIFYING)", () => {
    const d = transition(
      "VERIFYING",
      { type: "verification.requested", headSha: "req-h", force: true },
      g({ verificationRunCount: 1, verificationRunId: 7, underVerificationCap: true }),
    );
    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {
        headSha: "req-h",
        updateBranchQueuedAt: null,
        codeChangedSinceVerification: true,
        verdict: "none",
        verdictHeadSha: null,
        verificationRunCount: 2,
        verificationRunHead: "req-h",
        verificationRunId: 8,
        verificationChildId: null,
      },
      sideEffects: [KILL_ACTIVE],
    });
    // The coordinator spawns the fresh verifier (like the REVIEW→VERIFYING dispatch), so the edge only
    // tears down the superseded child — it must NOT also emit a spawn (that would double-spawn).
    expect(d?.sideEffects).not.toContainEqual({ kind: "spawn_verification_child" });
  });

  it("forced[cap_exhausted] → NEEDS_YOU(verification_run_limit) — still fails closed at the per-PR run cap", () => {
    const d = transition(
      "VERIFYING",
      { type: "verification.requested", headSha: "req-h", force: true },
      g({ underVerificationCap: false }),
    );
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "verification_run_limit" },
      sideEffects: [{ kind: "notify_qa_issue" }],
    });
  });

  it("forced[cap_exhausted + merge_conflict_bypass] → VERIFYING", () => {
    const d = transition(
      "VERIFYING",
      { type: "verification.requested", headSha: "req-h", force: true, bypassRunLimitForMergeConflict: true },
      g({ verificationRunCount: 3, verificationRunId: 7, underVerificationCap: false }),
    );

    expect(d).toMatchObject({
      to: "VERIFYING",
      fieldWrites: {
        verificationRunCount: 4,
        verificationRunHead: "req-h",
        verificationRunId: 8,
      },
      sideEffects: [KILL_ACTIVE],
    });
  });
});

describe("VERIFYING — queue_review (the transient VERIFYING hold) + ci no-op", () => {
  it("review.received[actionable] → VERIFYING / register UNDISPOSITIONED, do NOT dispatch (queue into the disposition store)", () => {
    const d = transition("VERIFYING", { type: "review.received", reviewerKind: "bot", actionable: true }, g());
    expect(d).toEqual({
      to: "VERIFYING",
      fieldWrites: {},
      sideEffects: [],
      worklistRegistrations: [{ sourceId: "rev-src", origin: "review", disposition: "none" }],
    });
    // The queued review is NOT dispatched while VERIFYING owns the head — `release_queued_reviews` drains it on exit.
    expect(d?.sideEffects).not.toContainEqual({ kind: "dispatch_epoch", args: { trigger: "review" } });
  });

  it("review.received[¬actionable] → VERIFYING / log_noop (queues nothing)", () => {
    const d = transition("VERIFYING", { type: "review.received", reviewerKind: "human", actionable: false }, g());
    expect(d).toEqual({ to: "VERIFYING", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
    expect(d).not.toHaveProperty("worklistRegistrations");
  });

  it.each(["green", "failing", "absent"] as const)(
    "ci.signal(%s) → VERIFYING / log_noop (CI is re-checked at the MERGE_READY gate, S)",
    (ciState) => {
      const d = transition("VERIFYING", { type: "ci.signal", ciState }, g());
      expect(d).toEqual({ to: "VERIFYING", fieldWrites: {}, sideEffects: [{ kind: "log_noop" }] });
    },
  );
});

describe("VERIFYING — fresh verdict exits (run-scoped freshness; every exit drains + kills the ACTIVE run)", () => {
  it("verification.pass[fresh] → REVIEW / record_verification(pass), release_queued_reviews, kill_verification(active)", () => {
    const d = transition("VERIFYING", { type: "verification.pass", headSha: "passh", runId: 5 }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        verdict: "pass",
        verdictHeadSha: "passh",
        codeChangedSinceVerification: false,
        verificationRunCount: 0,
      },
      sideEffects: [RELEASE, KILL_ACTIVE],
    });
  });

  it("verification.skipped[fresh] → REVIEW / record_verification(skipped) (skipped resets the run count too, B1)", () => {
    const d = transition("VERIFYING", { type: "verification.skipped", headSha: "skh", runId: 5 }, g());
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        verdict: "skipped",
        verdictHeadSha: "skh",
        codeChangedSinceVerification: false,
        verificationRunCount: 0,
      },
      sideEffects: [RELEASE, KILL_ACTIVE],
    });
  });

  it("verification.app_breaks[fresh] → REVIEW / record_verification + release + kill(active) ONLY — NO inject_findings, NO dispatch, NO in_flight stamp (A4: QA re-intake rides the managed comment); PRESERVES run count (B1)", () => {
    // A4 retired the VERIFYING app_breaks arm-drain: the verdict exit is record-only. The QA verifier posts a
    // managed PR comment that the review-loop intake admits as `known:cycloid-qa`, so nothing is injected onto
    // the spine and no epoch is dispatched here. `record_verification` preserves `verification_run_count` for
    // app_breaks (resets only on an approving verdict, B1).
    const d = transition(
      "VERIFYING",
      { type: "verification.app_breaks", headSha: "abh", runId: 5 },
      g({ noInflightEpoch: true, newEpochId: "epoch-ab-1" }),
    );
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: { verdict: "app_breaks", verdictHeadSha: "abh", codeChangedSinceVerification: false },
      sideEffects: [RELEASE, KILL_ACTIVE],
    });
    // No run-count reset (app_breaks preserves the count); no in_flight stamp; no injected registrations.
    expect(d?.fieldWrites).not.toHaveProperty("verificationRunCount");
    expect(d?.fieldWrites).not.toHaveProperty("inFlightEpochId");
    expect(d?.worklistRegistrations ?? []).toEqual([]);
    // No epoch dispatch — the QA comment path owns re-intake now (retired arm-drain).
    expect(d?.sideEffects.filter((e) => e.kind === "dispatch_epoch")).toEqual([]);
    expect(d?.sideEffects).not.toContainEqual(DISPATCH_REVIEW);
  });
});

describe("VERIFYING — FG-1 ghost-discard (a verdict from a SUPERSEDED run)", () => {
  it.each(["verification.pass", "verification.skipped", "verification.app_breaks"] as const)(
    "%s[¬fresh] → VERIFYING / log_noop, kill_verification(VERDICT's run) — NOT an exit, NO drain",
    (type) => {
      const d = transition("VERIFYING", { type, headSha: "ghosth", runId: 99 } as FsmEvent, g());
      expect(d).toEqual({
        to: "VERIFYING",
        fieldWrites: {},
        sideEffects: [{ kind: "log_noop" }, KILL_GHOST],
      });
    },
  );

  it("ghost-discard does NOT terminate and does NOT consult the cap (stays VERIFYING even with the cap exhausted)", () => {
    const d = transition(
      "VERIFYING",
      { type: "verification.pass", headSha: "ghosth", runId: 99 },
      g({ underVerificationCap: false, verificationRunCount: 3 }),
    );
    // cap exhausted is IRRELEVANT to the ghost path: it never routes to NEEDS_YOU(verification_noconverge).
    expect(d?.to).toBe("VERIFYING");
    expect(d?.fieldWrites).toEqual({});
    expect(d?.sideEffects).not.toContainEqual({ kind: "release_queued_reviews" });
    expect(d?.sideEffects).not.toContainEqual({ kind: "spawn_verification_child" });
  });

  it("ghost kill is RUN-SCOPED to the verdict's run — it NEVER targets the live verification_run_head run (FG-1)", () => {
    const d = transition("VERIFYING", { type: "verification.pass", headSha: "ghosth", runId: 99 }, g());
    expect(d?.sideEffects).toContainEqual(KILL_GHOST);
    expect(d?.sideEffects).not.toContainEqual(KILL_ACTIVE);
  });

  it("a missing active run id fails toward NOT-fresh (the verdict is discarded as a ghost, never a false accept)", () => {
    const d = transition(
      "VERIFYING",
      { type: "verification.pass", headSha: "h", runId: 5 },
      g({ verificationRunId: undefined }),
    );
    expect(d?.to).toBe("VERIFYING");
    expect(d?.sideEffects).toEqual([{ kind: "log_noop" }, KILL_GHOST]);
  });
});

describe("VERIFYING — kill resolves run_id → child via verification_child_id (run-scoped teardown)", () => {
  it("a fresh accept kills the ACTIVE run's child; the ghost kills the VERDICT's run's child — distinct handles (FG-1)", () => {
    const fresh = transition("VERIFYING", { type: "verification.pass", headSha: "h", runId: 5 }, g());
    expect(fresh?.sideEffects).toContainEqual(KILL_ACTIVE);

    const ghost = transition("VERIFYING", { type: "verification.pass", headSha: "h", runId: 7 }, g());
    expect(ghost?.sideEffects).toContainEqual(KILL_GHOST);
    expect(ghost?.sideEffects).not.toContainEqual(KILL_ACTIVE);
  });

  it("a null child handle still yields a well-formed (idempotent no-op) kill descriptor", () => {
    const d = transition(
      "VERIFYING",
      { type: "verification.pass", headSha: "h", runId: 5 },
      g({ verificationChildId: null }),
    );
    expect(d?.sideEffects).toContainEqual({ kind: "kill_verification", args: { verificationChildId: null } });
  });
});

describe("VERIFYING — terminal exits (stopped/failed run-scoped since PR 47; run_limit deliberately not)", () => {
  it("verification.run_limit → NEEDS_YOU(verification_run_limit) / release_queued_reviews, loud, kill_verification(active)", () => {
    const d = transition("VERIFYING", { type: "verification.run_limit", runId: 5 }, g());
    expect(d).toEqual({
      to: "NEEDS_YOU",
      fieldWrites: { blockedReason: "verification_run_limit" },
      sideEffects: [RELEASE, { kind: "loud" }, KILL_ACTIVE],
    });
  });

  it.each(["verification.stopped", "verification.failed"] as const)(
    "FRESH %s (runId == active) → NEEDS_YOU(verification_stopped) / release_queued_reviews, loud, kill_verification(active)",
    (type) => {
      const d = transition("VERIFYING", { type, runId: 5 } as FsmEvent, g());
      expect(d).toEqual({
        to: "NEEDS_YOU",
        fieldWrites: { blockedReason: "verification_stopped" },
        sideEffects: [RELEASE, { kind: "loud" }, KILL_ACTIVE],
      });
    },
  );

  it.each(["verification.stopped", "verification.failed"] as const)(
    "STALE %s (runId ≠ active) is ghost-discarded — the killed old child's late teardown must NOT terminalize the NEWER live run (PR 47, #6046-deferred)",
    (type) => {
      const d = transition("VERIFYING", { type, runId: 4 } as FsmEvent, g());
      // Self-loop (NOT an exit → no drain), log_noop, and the kill is RUN-SCOPED to the VERDICT's
      // (already-dead) run — never the live one. The live run still reports its own terminal.
      expect(d).toEqual({
        to: "VERIFYING",
        fieldWrites: {},
        sideEffects: [{ kind: "log_noop" }, KILL_GHOST],
      });
    },
  );

  it("a missing active run id fails toward NOT-fresh for stopped/failed too (discarded, never a spurious terminal)", () => {
    const d = transition("VERIFYING", { type: "verification.stopped", runId: 5 }, g({ verificationRunId: undefined }));
    expect(d?.to).toBe("VERIFYING");
    expect(d?.sideEffects).toEqual([{ kind: "log_noop" }, KILL_GHOST]);
  });

  it("run_limit is deliberately NOT freshness-gated — the run cap is a per-PR budget, not a per-run verdict", () => {
    const d = transition("VERIFYING", { type: "verification.run_limit", runId: 999 }, g());
    expect(d?.to).toBe("NEEDS_YOU");
    expect(d?.fieldWrites).toEqual({ blockedReason: "verification_run_limit" });
  });
});

describe("VERIFYING — the §9 queue-drain rule audit (PR 47, #6046-deferred): which exits drain, which deliberately skip", () => {
  it("loop-continuing exits DRAIN: fresh verdicts, fresh stopped/failed, run_limit, and the deadline backstop", () => {
    const draining: FsmEvent[] = [
      { type: "verification.pass", headSha: "h", runId: 5 },
      { type: "verification.skipped", headSha: "h", runId: 5 },
      { type: "verification.app_breaks", headSha: "h", runId: 5 },
      { type: "verification.stopped", runId: 5 },
      { type: "verification.failed", runId: 5 },
      { type: "verification.run_limit", runId: 5 },
      { type: "deadline_exceeded" },
    ];
    for (const event of draining) {
      const d = transition("VERIFYING", event, g());
      expect(d?.sideEffects, event.type).toContainEqual(RELEASE);
    }
  });

  it("terminal close-outs DELIBERATELY skip the drain (no loop left to dispatch into) but still kill the run", () => {
    // pr.merged/pr.closed/publish.superseded/user.stop/session.archived land MERGED/CLOSED/SUPERSEDED/
    // STOPPED/ARCHIVED — draining would emit review.item_ready triggers against a dead/parked PR. The
    // §9 "every VERIFYING exit drains" rule is scoped to loop-continuing exits (see killOnVerifyingExit).
    const closeOuts: FsmEvent[] = [
      { type: "pr.merged" },
      { type: "pr.closed" },
      { type: "publish.superseded" },
      { type: "user.stop" },
      { type: "session.archived" },
    ];
    for (const event of closeOuts) {
      const d = transition("VERIFYING", event, g());
      expect(d, event.type).not.toBeNull();
      expect(d?.sideEffects, event.type).toContainEqual(KILL_ACTIVE);
      expect(d?.sideEffects, event.type).not.toContainEqual(RELEASE);
    }
  });

  it("the FG-1 ghost-discards (verdict AND stopped/failed) are self-loops, not exits — they never drain", () => {
    const ghosts: FsmEvent[] = [
      { type: "verification.pass", headSha: "h", runId: 4 },
      { type: "verification.stopped", runId: 4 },
    ];
    for (const event of ghosts) {
      const d = transition("VERIFYING", event, g());
      expect(d?.to, event.type).toBe("VERIFYING");
      expect(d?.sideEffects, event.type).not.toContainEqual(RELEASE);
    }
  });
});

describe("VERIFYING — unhandled events return null (the cascade lives in REVIEW; codegen events don't apply)", () => {
  const unhandled: ReadonlyArray<FsmEvent> = [
    // NOTE: `user.stop`/`pr.merged`/`pr.closed`/`deadline_exceeded` are now HANDLED by the PR 19 cross-cutting
    // layer (terminal close-out + the VERIFYING deadline backstop; see transition-crosscutting.test.ts).
    { type: "caught_up", headSha: "h" }, // the cascade lives in REVIEW, not VERIFYING
    { type: "epoch.committed", epochId: "e1" },
    { type: "user.input" },
  ];
  it.each(unhandled)("VERIFYING — %o → null (caller logs a noop, runs no post-actions)", (event) => {
    expect(transition("VERIFYING", event, g())).toBeNull();
  });
});
