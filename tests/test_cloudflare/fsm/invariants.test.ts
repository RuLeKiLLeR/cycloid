// ARC-1330 lifecycle-FSM INVARIANTS property suite (PR 21 — the soundness backstop, design §15).
//
// Pure-fn suite: `transition` is a pure function of (state, event, guards), so this imports it directly and
// asserts STRUCTURAL invariants over an EXHAUSTIVE sweep of (state × event × guard-bag) — no DB harness. The
// per-PR tests (cascade PR 16, cross-cutting PR 19, caught_up PR 20A) prove their own edges; THIS file proves
// the cross-edge invariants that no single per-state test can: properties that must hold over the WHOLE map.
//
// The seven invariants asserted (spec PR 21 keystone, design §15):
//   1. SINGLE EMITTER (inv 4 / N7) — `MERGE_READY` has exactly one ENTERING edge `from ≠ to`
//      (the `REVIEW.caught_up` row-7 emitter, D10); its `head.noop_changed`/noise self-loops (from = to)
//      are the carve-out, NOT extra in-edges.
//   2. RUN-SCOPED VERDICT (inv 10 / FG-1) — a verdict whose `run_id ≠ verification_run_id` is a ghost:
//      discarded as a `VERIFYING → VERIFYING log_noop`, NEVER recorded / re-dispatched / terminating, and its
//      `kill_verification` targets the VERDICT's run, never the active one.
//   3. NO SILENT REST (cascade total + loud catch-all) — the `caught_up` cascade is TOTAL (never `null`) over
//      its 96-cell partition, every NEEDS_YOU exit is `loud()`, the `ci_pending` cell is an explicit
//      `log_noop` wait (acknowledged, not silent), and the row-8 residual is loud.
//   4. NO NEEDS_YOU FROM THE GENESIS GROUP (P1) — no event drives `{CREATED…PUBLISHING}` to `NEEDS_YOU`
//      (owner-approval / blocking is post-publish only).
//   5. EVERY ACTIVE/WAIT STATE HAS A DEADLINE TARGET (inv 5 / 12) — `deadline_exceeded` is handled (non-null)
//      from every active/wait state and only those; active timeouts are `loud()`, never silent.
//   6. caught_up RECOMPUTE-COMPLETENESS (PR 20A / design §6) — every §6 transition-derivable recompute
//      trigger is produced by a REAL edge, the no-show alarm trigger is alarm-only (never classified from a
//      transition), and the trigger set is the closed §6 six.
//   7. PROJECTION TOTALITY HOOK (inv 3) — every state a transition can produce is a member of the closed
//      `FSM_STATES` domain a future total projector (PR 28–33) must cover.
import { describe, expect, it } from "vitest";

import {
  CAUGHT_UP_RECOMPUTE_TRIGGERS,
  type CaughtUpRecomputeTrigger,
  classifyCaughtUpTrigger,
} from "../../../apps/control-plane-worker/src/session/fsm/caught-up";
import type { CiBucket } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import {
  type Decision,
  FSM_EVENT_TYPES,
  FSM_STATES,
  type FsmEvent,
  type FsmState,
} from "../../../apps/control-plane-worker/src/session/fsm/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const HEAD = "head-inv";
const RUN_ID = 7;
const STALE_RUN_ID = 999; // ≠ RUN_ID — drives the FG-1 ghost-discard branch.
const ACTIVE_CHILD = "vchild-active";
const GHOST_CHILD = "vchild-ghost";

// A fully-populated guard bag so every guarded edge is exercisable (a missing guard would silently route to a
// conservative default and hide an edge). Individual sweeps override the cascade axes via the 96-cell matrix.
const BASE: Guards = {
  sandboxAlive: true,
  prUrl: "https://example.test/pr/1",
  noInflightEpoch: true,
  newEpochId: "epoch-inv-1",
  underCiFixCap: true,
  ciFixRounds: 1,
  epoch1Fired: true,
  actionableExists: true,
  ciSettled: true,
  codeChangedSinceVerification: false,
  reviewSourceId: "src-1",
  committedHead: "head-committed",
  underVerificationCap: true,
  ciBucket: "ci_green",
  verificationPass: true,
  verificationFresh: true,
  verificationRunCount: 1,
  verificationRunId: RUN_ID,
  verificationChildId: ACTIVE_CHILD,
  verdictVerificationChildId: GHOST_CHILD,
  findingSourceIds: ["f1"],
  underMergeReadyReopenCap: true,
  mergeReadyReopenCount: 1,
  stopMode: "resumable",
  preStopState: "REVIEW",
  unpushedDiff: false,
};

const ALL_STATES: readonly FsmState[] = FSM_STATES;

// Concrete instances of EVERY FsmEvent variant (incl. payload sub-variants). The sweep feeds each across every
// state, so the invariants see the full event surface. Verdict events appear FRESH (run_id = RUN_ID) and STALE
// (run_id = STALE_RUN_ID) so the run-scoped invariant sees both branches.
const ALL_EVENTS: readonly FsmEvent[] = [
  { type: "sandbox.spawn_requested" },
  { type: "sandbox.ready" },
  { type: "sandbox.spawn_failed" },
  { type: "sandbox.death" },
  { type: "sandbox.liveness_expired" },
  { type: "prompt.enqueued" },
  { type: "prompt.awaiting_input" },
  { type: "prompt.terminal", outcome: "changes" },
  { type: "prompt.terminal", outcome: "no_changes" },
  { type: "prompt.terminal", outcome: "error" },
  { type: "prompt.max_duration_exceeded" },
  { type: "postexec.done", hasChanges: true, promptIntendsChange: true },
  { type: "postexec.done", hasChanges: false, promptIntendsChange: false },
  { type: "publish.pr_opened", prHead: HEAD },
  { type: "publish.no_changes" },
  { type: "publish.failed" },
  { type: "publish.superseded" },
  { type: "user.input" },
  { type: "user.stop" },
  { type: "user.retrigger" },
  { type: "session.archived" },
  { type: "ci.signal", ciState: "green" },
  { type: "ci.signal", ciState: "failing" },
  { type: "ci.signal", ciState: "absent" },
  { type: "review.received", reviewerKind: "bot", actionable: true },
  { type: "review.received", reviewerKind: "human", actionable: false },
  { type: "review.item_ready", itemId: "item-1" },
  { type: "epoch.committed", epochId: "ep-1" },
  { type: "epoch.replied", epochId: "ep-2" },
  { type: "epoch.declined", epochId: "ep-3" },
  { type: "epoch.blocked", epochId: "ep-4", reason: "owner_approval", trigger: "review" },
  { type: "epoch.deferred", epochId: "ep-5", deferralKind: "contention" },
  { type: "epoch.deferred", epochId: "ep-6", deferralKind: "transient" },
  { type: "epoch.settled", epochId: "ep-7" },
  { type: "caught_up", headSha: HEAD },
  { type: "verification.pass", headSha: HEAD, runId: RUN_ID },
  { type: "verification.pass", headSha: HEAD, runId: STALE_RUN_ID },
  { type: "verification.app_breaks", headSha: HEAD, runId: RUN_ID },
  { type: "verification.app_breaks", headSha: HEAD, runId: STALE_RUN_ID },
  { type: "verification.skipped", headSha: HEAD, runId: RUN_ID },
  { type: "verification.skipped", headSha: HEAD, runId: STALE_RUN_ID },
  { type: "verification.requested", headSha: HEAD },
  { type: "verification.stopped", runId: RUN_ID },
  { type: "verification.failed", runId: RUN_ID },
  { type: "verification.run_limit", runId: RUN_ID },
  { type: "head.changed", headSha: HEAD },
  { type: "head.noop_changed", headSha: HEAD },
  { type: "pr.merged" },
  { type: "pr.closed" },
  { type: "deadline_exceeded" },
];

// The 96-cell `caught_up` cascade partition (design §9 / PR 16) realized as full guard bags — fed across the
// whole sweep so the single-emitter / no-silent-rest invariants see every cascade outcome, not just the
// happy cell. Mirrors the cascade keystone's axes (6 booleans/enums → 2×3×2×2×2×2).
const CI_BUCKETS: readonly CiBucket[] = ["ci_green", "ci_red", "ci_pending"];
const BOOLS = [true, false] as const;
const CASCADE_BAGS: readonly Guards[] = (() => {
  const bags: Guards[] = [];
  for (const codeChangedSinceVerification of BOOLS)
    for (const ciBucket of CI_BUCKETS)
      for (const verificationPass of BOOLS)
        for (const verificationFresh of BOOLS)
          for (const underVerificationCap of BOOLS)
            for (const underCiFixCap of BOOLS)
              bags.push({
                ...BASE,
                codeChangedSinceVerification,
                ciBucket,
                verificationPass,
                verificationFresh,
                underVerificationCap,
                underCiFixCap,
              });
  return bags;
})();

const hasKind = (d: Decision, kind: string): boolean => d.sideEffects.some((e) => e.kind === kind);

interface SweepRow {
  from: FsmState;
  event: FsmEvent;
  decision: Decision;
}

/** Run `transition` over states × events × guard-bags; collect every NON-null Decision with its (from, event). */
function sweep(states: readonly FsmState[], events: readonly FsmEvent[], bags: readonly Guards[]): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const from of states)
    for (const event of events)
      for (const guards of bags) {
        const decision = transition(from, event, guards);
        if (decision !== null) rows.push({ from, event, decision });
      }
  return rows;
}

const FULL_SWEEP = sweep(ALL_STATES, ALL_EVENTS, CASCADE_BAGS);

// ── 0. Sweep coverage — the event axis IS the whole event domain ──
// Guards every invariant below: a new FsmEventType added to types.ts but NOT to ALL_EVENTS would be swept by
// zero invariants (a silent coverage hole). Payload sub-variants repeat a `type`, so compare the type SETS.
describe("sweep coverage: ALL_EVENTS spans every FsmEventType", () => {
  it("the sweep's event axis is exactly the closed FSM_EVENT_TYPES domain", () => {
    expect(new Set(ALL_EVENTS.map((e) => e.type))).toEqual(new Set(FSM_EVENT_TYPES));
  });
});

// ── 1. Single emitter — `MERGE_READY` has exactly one ENTERING edge `from ≠ to` (inv 4 / N7) ──
describe("invariant: MERGE_READY single emitter (inv 4 / N7)", () => {
  const toMergeReady = FULL_SWEEP.filter((r) => r.decision.to === "MERGE_READY");
  const entering = toMergeReady.filter((r) => r.from !== "MERGE_READY");
  const selfLoops = toMergeReady.filter((r) => r.from === "MERGE_READY");

  it("the only ENTERING edge is (REVIEW, caught_up) — the row-7 cascade emitter (D10)", () => {
    const enteringPairs = [...new Set(entering.map((r) => `${r.from}:${r.event.type}`))].sort();
    expect(enteringPairs).toEqual(["REVIEW:caught_up"]);
  });

  it("that entering edge is REACHABLE (not vacuously single)", () => {
    expect(entering.length).toBeGreaterThan(0);
  });

  it("every other to=MERGE_READY transition is a self-loop FROM MERGE_READY (the N7 carve-out)", () => {
    expect(selfLoops.every((r) => r.from === "MERGE_READY")).toBe(true);
    // Sanity: the carve-out is non-empty (head.noop_changed / noise-review / reconcile self-loops exist).
    expect(selfLoops.length).toBeGreaterThan(0);
  });
});

// ── 2. Run-scoped verdict — FG-1 ghost-discard (inv 10) ──
describe("invariant: run-scoped verdict / FG-1 ghost-discard (inv 10)", () => {
  const VERDICTS = ["verification.pass", "verification.skipped", "verification.app_breaks"] as const;

  for (const type of VERDICTS) {
    it(`${type}: a STALE run_id verdict is discarded as a VERIFYING log_noop, never recorded`, () => {
      const stale = transition("VERIFYING", { type, headSha: HEAD, runId: STALE_RUN_ID } as FsmEvent, BASE);
      expect(stale).not.toBeNull();
      // Stays in VERIFYING (a self-loop, NOT an exit) and DOES NOT record a verdict (the ghost is dropped).
      expect(stale!.to).toBe("VERIFYING");
      expect(stale!.fieldWrites.verdict).toBeUndefined();
      expect(stale!.fieldWrites.verdictHeadSha).toBeUndefined();
      expect(hasKind(stale!, "log_noop")).toBe(true);
      // Not an exit: no queue drain, no re-dispatch.
      expect(hasKind(stale!, "release_queued_reviews")).toBe(false);
      expect(hasKind(stale!, "spawn_verification_child")).toBe(false);
      // kill_verification targets the VERDICT's (ghost) run, NEVER the active run.
      const kill = stale!.sideEffects.find((e) => e.kind === "kill_verification");
      expect(kill?.args?.verificationChildId).toBe(GHOST_CHILD);
    });

    it(`${type}: a FRESH run_id verdict is recorded and exits VERIFYING`, () => {
      const fresh = transition("VERIFYING", { type, headSha: HEAD, runId: RUN_ID } as FsmEvent, BASE);
      expect(fresh).not.toBeNull();
      expect(fresh!.to).toBe("REVIEW");
      // record_verification stamps the verdict + clears code_changed.
      expect(fresh!.fieldWrites.verdict).toBeDefined();
      expect(fresh!.fieldWrites.codeChangedSinceVerification).toBe(false);
      // Every exit drains the queue + kills the ACTIVE run.
      expect(hasKind(fresh!, "release_queued_reviews")).toBe(true);
      const kill = fresh!.sideEffects.find((e) => e.kind === "kill_verification");
      expect(kill?.args?.verificationChildId).toBe(ACTIVE_CHILD);
    });
  }
});

// ── 3. No silent rest — cascade total + loud catch-all (design §9 rows 1-8) ──
describe("invariant: no silent rest — cascade totality + loud catch-all", () => {
  const CAUGHT_UP: FsmEvent = { type: "caught_up", headSha: HEAD };
  const cells = CASCADE_BAGS.map((g) => ({ g, d: transition("REVIEW", CAUGHT_UP, g) }));

  it("the cascade is TOTAL — every one of the 96 cells returns a non-null Decision", () => {
    expect(cells.length).toBe(96);
    expect(cells.every((c) => c.d !== null)).toBe(true);
  });

  it("every cascade cell emits ≥1 side-effect — no silent no-effect rest (§15 inv 3)", () => {
    // Each of the 96 cells must DO something observable (request_verification / dispatch_epoch / loud /
    // log_noop / emit_settle…). A cell that returned a Decision with an EMPTY side-effect list would be a
    // silent rest the totality check alone can't catch.
    for (const { g, d } of cells) {
      expect(d!.sideEffects.length, `cascade cell ${JSON.stringify(g)} emitted no side-effect`).toBeGreaterThan(0);
    }
  });

  it("MERGE_READY fires IFF ci_green ∧ no_inflight_epoch (verification decoupled — CI-ladder cut)", () => {
    for (const { g, d } of cells) {
      const mergeReady = g.ciBucket === "ci_green" && (g.noInflightEpoch ?? false);
      expect(d!.to === "MERGE_READY").toBe(mergeReady);
    }
  });

  it("every NEEDS_YOU cascade exit is loud() — no silent terminal", () => {
    for (const { d } of cells) {
      if (d!.to === "NEEDS_YOU") expect(hasKind(d!, "loud")).toBe(true);
    }
  });

  it("the ci_pending wait cell is an explicit log_noop (acknowledged wait, not a silent rest)", () => {
    const pendingWaits = cells.filter(
      ({ g }) => !(g.codeChangedSinceVerification ?? false) && g.ciBucket === "ci_pending",
    );
    expect(pendingWaits.length).toBeGreaterThan(0);
    for (const { d } of pendingWaits) {
      expect(d!.to).toBe("REVIEW");
      expect(hasKind(d!, "log_noop")).toBe(true);
    }
  });

  it("verification columns are decoupled: a ci_green ∧ pass ∧ ¬fresh cell still mints MERGE_READY (no row-8 catch-all)", () => {
    // Pre-cut this was the loud row-8 residual (internal_inconsistency). Post-cut the cascade ignores the
    // verification columns entirely — ci_green ∧ no_inflight_epoch settles MERGE_READY regardless of fresh.
    const cell = transition("REVIEW", CAUGHT_UP, {
      ...BASE,
      codeChangedSinceVerification: false,
      ciBucket: "ci_green",
      verificationPass: true,
      verificationFresh: false,
    });
    expect(cell!.to).toBe("MERGE_READY");
    expect(hasKind(cell!, "emit_settle")).toBe(true);
  });
});

// ── 4. No NEEDS_YOU from the genesis group (P1) ──
describe("invariant: no NEEDS_YOU between CREATED and PUBLISHING (P1)", () => {
  const GENESIS_GROUP: readonly FsmState[] = [
    "CREATED",
    "PROVISIONING",
    "GENERATING",
    "AWAITING_INPUT",
    "FINALIZING",
    "PUBLISHING",
  ];

  it("no event from any genesis-group state drives to NEEDS_YOU", () => {
    const offenders = sweep(GENESIS_GROUP, ALL_EVENTS, CASCADE_BAGS)
      .filter((r) => r.decision.to === "NEEDS_YOU")
      .map((r) => `${r.from}:${r.event.type}`);
    expect([...new Set(offenders)]).toEqual([]);
  });
});

// ── 5. Every active/wait state has a deadline target (inv 5 / 12) ──
describe("invariant: every active/wait state has a deadline_exceeded target (inv 5 / 12)", () => {
  // Active states — a missed deadline is a LOUD failure/block.
  const ACTIVE_STATES: readonly FsmState[] = [
    "CREATED",
    "PROVISIONING",
    "GENERATING",
    "FINALIZING",
    "PUBLISHING",
    "REVIEW",
    "VERIFYING",
  ];
  // Wait states — a deadline is handled but NOT a loud failure (resumable stop / cron reconcile self-loop).
  const WAIT_STATES: readonly FsmState[] = ["AWAITING_INPUT", "MERGE_READY"];
  // Resting states — no FSM deadline edge (abandon handling is cron/archival, not a transition; §10 note).
  const RESTING_STATES: readonly FsmState[] = [
    "ANSWERED_NO_PR",
    "NEEDS_YOU",
    "FAILED",
    "STOPPED",
    "MERGED",
    "CLOSED",
    "SUPERSEDED",
    "ARCHIVED",
  ];

  const DEADLINE: FsmEvent = { type: "deadline_exceeded" };

  it("the active/wait/resting split partitions all 17 states exactly once", () => {
    const union = [...ACTIVE_STATES, ...WAIT_STATES, ...RESTING_STATES].sort();
    expect(union).toEqual([...FSM_STATES].sort());
    expect(union.length).toBe(FSM_STATES.length);
  });

  it("every active state has a LOUD deadline target", () => {
    for (const s of ACTIVE_STATES) {
      const d = transition(s, DEADLINE, BASE);
      expect(d, `active state ${s} must handle deadline_exceeded`).not.toBeNull();
      expect(hasKind(d!, "loud"), `active state ${s} deadline must be loud`).toBe(true);
    }
  });

  it("every wait state has a (non-loud) deadline target", () => {
    for (const s of WAIT_STATES) {
      const d = transition(s, DEADLINE, BASE);
      expect(d, `wait state ${s} must handle deadline_exceeded`).not.toBeNull();
    }
    // AWAITING_INPUT → resumable STOPPED; MERGE_READY → cron-reconcile self-loop (stays Ready).
    expect(transition("AWAITING_INPUT", DEADLINE, BASE)!.to).toBe("STOPPED");
    expect(transition("MERGE_READY", DEADLINE, BASE)!.to).toBe("MERGE_READY");
  });

  it("resting states have NO FSM deadline edge (unhandled → null)", () => {
    for (const s of RESTING_STATES) {
      expect(transition(s, DEADLINE, BASE), `resting state ${s} must not handle deadline_exceeded`).toBeNull();
    }
  });
});

// ── 6. caught_up recompute-completeness (PR 20A / design §6) ──
describe("invariant: caught_up recompute-completeness (design §6, PR 20A)", () => {
  it("the §6 trigger set is the closed six", () => {
    expect([...CAUGHT_UP_RECOMPUTE_TRIGGERS].sort()).toEqual(
      [
        "ci_green_flip",
        "epoch_terminal",
        "verification_verdict_return",
        "review_received",
        "review_reopen",
        "publish_pr_opened",
      ].sort(),
    );
    expect(new Set(CAUGHT_UP_RECOMPUTE_TRIGGERS).size).toBe(6);
  });

  it("EVERY §6 trigger is produced by a REAL edge in the sweep", () => {
    const observed = new Set<CaughtUpRecomputeTrigger>();
    for (const { from, event, decision } of FULL_SWEEP) {
      const t = classifyCaughtUpTrigger(from, event, decision.to);
      if (t !== null) observed.add(t);
    }
    // All SIX triggers are reachable from a concrete (from, event, to) edge.
    expect([...observed].sort()).toEqual(
      [
        "ci_green_flip",
        "epoch_terminal",
        "verification_verdict_return",
        "review_received",
        "review_reopen",
        "publish_pr_opened",
      ].sort(),
    );
  });

  it("classifies EVERY canonical §6 edge shape (completeness DIRECTION — a narrowed classifier breaks here)", () => {
    // Test #2 proves each trigger is OBSERVED somewhere (⊇). This proves the OTHER direction: each §6 shape
    // is still classified, so dropping a case (e.g. `epoch.declined`, the `absent` CI flip, a re-open `from`)
    // — a "too-narrow classify" regression that test #2 would miss — fails HERE.
    // §6.5 — every VERIFYING → REVIEW exit, regardless of which verdict drove it.
    for (const type of ["verification.pass", "verification.skipped", "verification.app_breaks"] as const) {
      expect(classifyCaughtUpTrigger("VERIFYING", { type, headSha: HEAD, runId: RUN_ID }, "REVIEW")).toBe(
        "verification_verdict_return",
      );
    }
    // §6.6 — every NEEDS_YOU/MERGE_READY → REVIEW re-open (keyed on `from`, regardless of the driving event).
    expect(
      classifyCaughtUpTrigger(
        "NEEDS_YOU",
        { type: "review.received", reviewerKind: "bot", actionable: true },
        "REVIEW",
      ),
    ).toBe("review_reopen");
    expect(classifyCaughtUpTrigger("MERGE_READY", { type: "head.changed", headSha: HEAD }, "REVIEW")).toBe(
      "review_reopen",
    );
    // §6.1 — ALL THREE epoch terminals (dropping any one is a too-narrow regression).
    for (const type of ["epoch.committed", "epoch.replied", "epoch.declined"] as const) {
      expect(classifyCaughtUpTrigger("REVIEW", { type, epochId: "e" } as FsmEvent, "REVIEW")).toBe("epoch_terminal");
    }
    // §6.2 — review.received self-loop.
    expect(
      classifyCaughtUpTrigger("REVIEW", { type: "review.received", reviewerKind: "human", actionable: true }, "REVIEW"),
    ).toBe("review_received");
    // §6.4 — ci_green_flip fires on green/absent, NOT on failing (FG-4).
    expect(classifyCaughtUpTrigger("REVIEW", { type: "ci.signal", ciState: "green" }, "REVIEW")).toBe("ci_green_flip");
    expect(classifyCaughtUpTrigger("REVIEW", { type: "ci.signal", ciState: "absent" }, "REVIEW")).toBe("ci_green_flip");
    expect(classifyCaughtUpTrigger("REVIEW", { type: "ci.signal", ciState: "failing" }, "REVIEW")).toBeNull();
    // A plain REVIEW self-loop with no cascade-input event is NOT a trigger (no spurious recompute).
    expect(classifyCaughtUpTrigger("REVIEW", { type: "head.noop_changed", headSha: HEAD }, "REVIEW")).toBeNull();
  });
});

// ── 7. Projection totality hook (inv 3) ──
describe("invariant: projection totality hook (inv 3)", () => {
  it("the projector domain (FSM_STATES) is closed at 17 with no duplicates", () => {
    expect(FSM_STATES.length).toBe(17);
    expect(new Set(FSM_STATES).size).toBe(17);
  });

  it("every state a transition can produce is a member of the closed FSM_STATES domain", () => {
    const domain = new Set<FsmState>(FSM_STATES);
    const offDomain = FULL_SWEEP.map((r) => r.decision.to).filter((to) => !domain.has(to));
    expect(offDomain).toEqual([]);
    // Hook for PR 28–33: the set below is exactly what a TOTAL `project(record)` must cover — any reachable
    // `to` not in FSM_STATES would surface here before the projector is even written.
    const reachable = new Set<FsmState>(FULL_SWEEP.map((r) => r.decision.to));
    expect([...reachable].every((s) => domain.has(s))).toBe(true);
  });
});
