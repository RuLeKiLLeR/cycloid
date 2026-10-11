// ARC-1330 (PR 47, the 4b emitter rewire) — the LIVE guard-resolver matrix + the flip's core proofs.
//
// Proves, end-to-end through the REAL producer entry points against a migrated D1:
//   1. THE PAIR PROOF (the flip's heart): an identical fully-satisfied caught_up world CANNOT mint
//      MERGE_READY under `FSM_MODE=shadow` (the hard floors hold) and DOES reach MERGE_READY under
//      `live` (REVIEW → real recompute → cascade row 7 → emit_settle dispatched).
//   2. The live verification pipeline: epoch terminal → row-1 VERIFYING enter (the ONE enter driver at
//      live) → §17-A run-id echo → H→H′→H ghost-discard → fresh accept → green flip → MERGE_READY.
//   3. The two spec-mandated QA-dispatch soundness traps: (i) only the row-1 `request_verification`
//      burns `verification_run_count` (a redispatch never does); (ii) `record_verification` stamps
//      `verdict_head_sha` from the fresh verdict's validated live head only — no pinned/earlier-SHA
//      path exists (the ghost is discarded without stamping).
//   4. DE-3: the deadline producer fires the teardown bag on a due dwell.
//   5. FG-2 on the eager dispatch (the #6046-deferred item a): a dispatch transition never resets
//      `ci_fix_rounds`; the green `ci.signal` self-loop is the live reset carrier.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { REVIEW_STUCK_DEADLINE_MS } from "../../../apps/control-plane-worker/src/constants/review-loop";
import type { ReviewLoopCiState } from "../../../apps/control-plane-worker/src/services/review-loop-rollup";
import { shadowEmitCiSignal } from "../../../apps/control-plane-worker/src/session/fsm/ci-producer";
import { shadowFireDueDeadline } from "../../../apps/control-plane-worker/src/session/fsm/deadline-producer";
import { shadowEmitEpochTerminal } from "../../../apps/control-plane-worker/src/session/fsm/epoch-producer";
import { shadowEmitHeadChange } from "../../../apps/control-plane-worker/src/session/fsm/head-producer";
import { buildLiveGuardResolver } from "../../../apps/control-plane-worker/src/session/fsm/live-resolver";
import { buildLiveSideEffectSink } from "../../../apps/control-plane-worker/src/session/fsm/live-side-effects";
import { applyCiFixResetPostAction } from "../../../apps/control-plane-worker/src/session/fsm/post-actions";
import { shadowEmitReviewReceived } from "../../../apps/control-plane-worker/src/session/fsm/review-producer";
import { transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import {
  shadowEmitVerificationOutcome,
  shadowEmitVerifierTerminalVerdict,
} from "../../../apps/control-plane-worker/src/session/fsm/verification-producer";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import {
  registerDispositionIfAbsent,
  upsertDisposition,
} from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import type { Env, SessionState } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

// The live executors reach the session DO + the verification scheduler + Datadog; all are mocked
// module-wide (the repo's vi.hoisted pattern) so the REAL default executors run without a DO harness.
const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  closeSessionState: vi.fn(),
  syncSessionProjection: vi.fn(async () => {}),
  scheduleAutoVerification: vi.fn(),
  postDd: vi.fn(async () => true),
  // W11-T1 honest one-head CI read (`caughtUpInputs` `!callerSuppliedCi` branch). Default undefined =
  // the real behaviour in this harness (env has no GITHUB_APP_ID → the real read returns undefined), so
  // the CI-producer-driven cases are untouched. Overridden only by the no-CI-caller / absent-head case.
  readSettleableHeadCi: vi.fn(async () => undefined as ReviewLoopCiState | undefined),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
  closeSessionState: mocks.closeSessionState,
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: mocks.syncSessionProjection,
}));

// W11-T1: override ONLY the settleable honest read; keep every other honest-ci-read export real so the
// row7/verdict-return seams that transitively import this module are unaffected (importOriginal spread).
vi.mock("../../../apps/control-plane-worker/src/session/fsm/honest-ci-read", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), readSettleableHeadCiForRecord: mocks.readSettleableHeadCi };
});

// W11-V3(a): the spawn executor inlines scheduling via `verification-spawn.ts` (the FSM-owned
// destination); the legacy `verification-auto-scheduler.ts` is now a dead-under-live re-export. Mock moves.
vi.mock("../../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: mocks.scheduleAutoVerification,
}));

// Capture BOTH the §18.4 transition emits and the live sink's fsm.* events (filter by `event`).
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), postStructuredEventToDd: mocks.postDd };
});

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

const SID = "sess-live-resolver-1";
const PR_URL = "https://github.com/x/y/pull/9";
const NOW = 1_700_000_050_000;

function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "REVIEW",
    prUrl: PR_URL,
    headSha: "h1",
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: NOW - 5_000,
    ...overrides,
  };
}

const SESSION: SessionState = {
  sessionId: SID,
  ownerUserId: "7",
  businessId: "biz-1",
  status: "active",
  createdAt: "",
  updatedAt: "",
  closedAt: null,
  lastEventId: null,
  title: null,
  repoOwner: "x",
  repoName: "y",
  installationId: 42,
} as SessionState;

function env(db: D1Database, mode: "shadow" | "live"): Env {
  return { DD_API_KEY: undefined, WORKER_ENV: "test", DB: db, FSM_MODE: mode } as unknown as Env;
}

function ddEvents(name: string): Record<string, unknown>[] {
  return mocks.postDd.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((e) => e.event === name);
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = createMigratedSqlite();
  db = new SqliteD1(sqlite) as unknown as D1Database;
  mocks.getSessionState.mockReset().mockResolvedValue(SESSION);
  mocks.closeSessionState.mockReset().mockResolvedValue(null);
  mocks.syncSessionProjection.mockReset().mockResolvedValue(undefined);
  mocks.scheduleAutoVerification.mockReset().mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });
  mocks.postDd.mockReset().mockResolvedValue(true);
  mocks.readSettleableHeadCi.mockReset().mockResolvedValue(undefined);
});

// ── 1. THE PAIR PROOF (spec item 8 — the flip's core) ─────────────────────────

describe("PR 47 — the shadow/live pair proof: identical satisfied world, floors vs the real recompute", () => {
  // A fully-satisfied caught_up world: REVIEW, fresh approving verdict on unchanged code, no
  // undispositioned items (none registered), no pending reviewers (vacuously settled), no epoch.
  const satisfiedWorld = () =>
    buildRecord({
      codeChangedSinceVerification: false,
      verdict: "pass",
      verdictHeadSha: "h1",
      verificationRunHead: "h1",
      verificationRunId: 1,
    });

  it("LIVE: the identical world reaches MERGE_READY end-to-end (green flip → real recompute → row 7 → emit_settle)", async () => {
    await insertPrCoordination(db, satisfiedWorld());
    await shadowEmitCiSignal(env(db, "live"), SID, "green");
    const rec = await getPrCoordination(db, SID);
    // v1 = the green self-loop, v2 = the cascade's row-7 commit.
    expect(rec!.state).toBe("MERGE_READY");
    expect(rec!.version).toBe(2);
    expect(rec!.blockedReason).toBeNull();
    // Row 7's emit_settle executed through the live sink (the flip-visible settle signal).
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  it("LIVE: an UNsatisfied world (an undispositioned actionable item) does NOT settle — the real store gates honestly", async () => {
    await insertPrCoordination(db, satisfiedWorld());
    await registerDispositionIfAbsent(db, { sessionId: SID, prUrl: PR_URL, sourceId: "review:11" }, NOW);
    await shadowEmitCiSignal(env(db, "live"), SID, "green");
    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("REVIEW"); // green self-loop only; the recompute read count=1
    expect(ddEvents("fsm.settle")).toHaveLength(0);
  });
});

// ── 2+3. The live verification pipeline + the two QA-dispatch soundness traps ──

describe("PR 47 — live pipeline: epoch terminal → row-1 enter → §17-A echo → ghost discard → MERGE_READY", () => {
  it("VERIFYING drain arc under live: run-token ABA ghost-discard → fresh accept → green → MERGE_READY", async () => {
    // ARC-1330 CI-ladder cut: VERIFYING is no longer ENTERED via the cascade (row-1 is gone) — it is
    // drain-only. Seed a VERIFYING row mid-run directly to exercise the still-live VERIFYING drain
    // edges (run-token ABA, the FG-1 ghost-discard, the fresh-accept exit) under the live spine.
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        codeChangedSinceVerification: true,
        verificationRunId: 1,
        verificationRunHead: "h1",
        verificationRunCount: 1,
        headSha: "h1",
      }),
    );
    const live = env(db, "live");
    let rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("VERIFYING");

    // (b) H→H′: a real head change mid-verification REDISPATCHES — run id advances, the count does
    //     NOT (trap i: a redispatch never increments verification_run_count).
    await shadowEmitHeadChange(live, SID, { kind: "head.changed", headSha: "h2", prevHeadSha: "h1" });
    rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("VERIFYING");
    expect(rec!.verificationRunId).toBe(2);
    expect(rec!.verificationRunHead).toBe("h2");
    expect(rec!.verificationRunCount).toBe(1); // UNCHANGED — the redispatch is not a run-of-record burn
    expect(mocks.scheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleAutoVerification.mock.calls[0][0]).toMatchObject({ headSha: "h2", verificationRunId: 2 });

    // (c) H′→H: revert to the original head — the ABA shape. Run id 3 now owns head h1.
    await shadowEmitHeadChange(live, SID, { kind: "head.changed", headSha: "h1", prevHeadSha: "h2" });
    rec = await getPrCoordination(db, SID);
    expect(rec!.verificationRunId).toBe(3);
    expect(rec!.verificationRunHead).toBe("h1");
    expect(rec!.verificationRunCount).toBe(1);

    // (d) THE GHOST: run 1's late verdict arrives with the OLD echoed token — and the MATCHING head
    //     (the ABA hole a bare head-match would fall into). Run-scoped freshness discards it: no
    //     record, no verdict stamp (trap ii: no earlier-run path ever stamps verdict_head_sha).
    const ghostVersion = rec!.version;
    await shadowEmitVerifierTerminalVerdict(
      live,
      SID,
      {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "h1",
        summary: "",
        evidence: [],
        blockers: [],
        verificationRunId: 1, // the superseded run's echoed token
      },
      { exhausted: false },
    );
    rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("VERIFYING"); // log_noop self-loop — never terminalizes, never records
    expect(rec!.verdict).toBeNull();
    expect(rec!.verdictHeadSha).toBeNull();
    expect(rec!.version).toBe(ghostVersion + 1); // the handled self-loop committed (sense ii)

    // (e) THE FRESH ACCEPT: the ACTIVE run (3) reports pass @ h1 — records, returns to REVIEW, and
    //     stamps verdict_head_sha from the fresh verdict's validated live head ONLY (trap ii).
    await shadowEmitVerifierTerminalVerdict(
      live,
      SID,
      {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "h1",
        summary: "",
        evidence: [],
        blockers: [],
        verificationRunId: 3,
      },
      { exhausted: false },
    );
    rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("REVIEW");
    expect(rec!.verdict).toBe("pass");
    expect(rec!.verdictHeadSha).toBe("h1"); // == the live head — the only stamp path
    expect(rec!.headSha).toBe("h1");
    expect(rec!.codeChangedSinceVerification).toBe(false);
    expect(rec!.verificationRunCount).toBe(0); // approving accept resets the consecutive-failed budget
    // The verdict-return recompute ran but waited at row 5 (an honest ci_pending — no CI observation).
    expect(rec!.state).toBe("REVIEW");

    // (f) The green flip supplies the real CI bucket → row 7 → MERGE_READY + emit_settle.
    await shadowEmitCiSignal(live, SID, "green");
    rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("MERGE_READY");
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  it("LIVE rejects a verdict WITHOUT an echoed run id (self-sourcing is shadow-only — B4 fail-toward-NOT-fresh)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        codeChangedSinceVerification: true,
        verificationRunId: 2,
        verificationRunHead: "h1",
        verificationRunCount: 1,
      }),
    );
    await shadowEmitVerifierTerminalVerdict(
      env(db, "live"),
      SID,
      { verdict: "CONCLUSIVE", verifiedHeadSha: "h1", summary: "", evidence: [], blockers: [] },
      { exhausted: false },
    );
    const rec = await getPrCoordination(db, SID);
    // No spine verdict minted at all: no transition, no record — the VERIFYING deadline backstop owns
    // unwedging a session whose every verdict lacked the echo.
    expect(rec!.version).toBe(0);
    expect(rec!.state).toBe("VERIFYING");
    expect(rec!.verdict).toBeNull();
  });

  it("a STALE verification.stopped at live is ghost-discarded end-to-end (the #6046-deferred run-scope fix)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        codeChangedSinceVerification: true,
        verificationRunId: 3,
        verificationRunHead: "h1",
        verificationRunCount: 1,
      }),
    );
    const live = env(db, "live");
    await shadowEmitVerificationOutcome(live, SID, { outcome: "stopped", runId: 1, headSha: null });
    let rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("VERIFYING"); // the stale teardown did NOT terminalize the newer run
    expect(rec!.blockedReason).toBeNull();
    // A FRESH stopped still terminalizes loudly.
    await shadowEmitVerificationOutcome(live, SID, { outcome: "stopped", runId: 3, headSha: null });
    rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("NEEDS_YOU");
    expect(rec!.blockedReason).toBe("verification_stopped");
  });
});

// ── 4. DE-3: the deadline producer teardown bag ──────

describe("PR 47 — shadowFireDueDeadline: live executes the teardown bag; shadow stays would-fire", () => {
  const dweltPastReviewDeadline = () =>
    buildRecord({ stateEnteredAt: NOW - REVIEW_STUCK_DEADLINE_MS - 1, verdict: null });

  it("LIVE: a dwelt-past-deadline REVIEW routes to NEEDS_YOU(review_stuck) with drain + loud dispatched", async () => {
    await insertPrCoordination(db, dweltPastReviewDeadline());
    const calls: string[] = [];
    const executors = Object.fromEntries(
      ["release_queued_reviews", "loud", "project", "kill_verification"].map((kind) => [
        kind,
        async () => {
          calls.push(kind);
        },
      ]),
    );
    const live = env(db, "live");
    const sink = buildLiveSideEffectSink(live, { executors: executors as never, emit: mocks.postDd as never });
    const result = await shadowFireDueDeadline(live, SID, NOW, undefined, sink);
    expect(result).toEqual({ wouldFire: true, from: "REVIEW", to: "NEEDS_YOU" });
    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("NEEDS_YOU");
    expect(rec!.blockedReason).toBe("review_stuck");
    // The §10 REVIEW-deadline bag executed: drain + loud (+ the universal project).
    expect(calls).toContain("release_queued_reviews");
    expect(calls).toContain("loud");
    // DE-3 re-arm: the resulting state's deadline is derived from the REAL class map (NEEDS_YOU = a
    // resting terminal → cleared).
    expect(rec!.deadlineAt).toBeNull();
  });

  it("LIVE: a dwelt VERIFYING routes to NEEDS_YOU(verification_stopped) with the run-scoped kill in the bag", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        stateEnteredAt: NOW - 48 * 60 * 60 * 1000,
        verificationChildId: "child-9",
        verificationRunId: 1,
        verificationRunHead: "h1",
      }),
    );
    const live = env(db, "live");
    const killed: unknown[] = [];
    const executors = {
      kill_verification: async (ctx: { effect: { args?: Record<string, unknown> } }) => {
        killed.push(ctx.effect.args?.verificationChildId);
      },
    };
    const sink = buildLiveSideEffectSink(live, { executors: executors as never, emit: mocks.postDd as never });
    const result = await shadowFireDueDeadline(live, SID, NOW, undefined, sink);
    expect(result.to).toBe("NEEDS_YOU");
    expect((await getPrCoordination(db, SID))!.blockedReason).toBe("verification_stopped");
    expect(killed).toEqual(["child-9"]); // the live resolver threaded the record's child handle
  });
});

// ── 6. FG-2 on the eager dispatch (the #6046-deferred item a) ──────────────────

describe("PR 47 — FG-2 reset vs the eager dispatch (item a verdict: exclusion-by-design, green self-loop carries)", () => {
  it("PURE: a dispatch decision (resulting in-flight epoch) is structurally excluded from the reset — even under a green read", () => {
    const eager = transition(
      "REVIEW",
      { type: "review.received", reviewerKind: "bot", actionable: true },
      { sandboxAlive: true, noInflightEpoch: true, newEpochId: "e-eager", reviewSourceId: "r1", ciFixRounds: 2 },
    );
    expect(eager?.fieldWrites.inFlightEpochId).toBe("e-eager");
    // Even if the observed world were green at dispatch time, the resulting state has an in-flight
    // epoch → `ci_green ∧ no_inflight_epoch` is false → no reset (inv 11's conjunct, not a gap).
    const post = applyCiFixResetPostAction(eager!, { ciGreen: true, noInflightEpoch: false });
    expect(post.fieldWrites).not.toHaveProperty("ciFixRounds");
  });

  it("LIVE e2e: the carried rounds survive in-flight green + a conservative epoch terminal, then reset on the green self-loop", async () => {
    // Mid-ciFix world: rounds=2, an epoch in flight, with the epoch's OWNED item still undispositioned.
    // The reply terminal below must stay conservative for FG-2 (clear-only, no reset) — not the ARC-1556
    // drain arm, which applies only when OTHER uncovered actionable items remain.
    await insertPrCoordination(db, buildRecord({ ciFixRounds: 2, inFlightEpochId: "epoch-cifix-1" }));
    await upsertDisposition(
      db,
      { sessionId: SID, prUrl: PR_URL, sourceId: "review:owned", disposition: "none", basis: null, epochId: null },
      NOW,
    );
    const live = env(db, "live");

    // (a) green while the epoch is in flight: log_noop, NO reset (deferred to the terminal, FG-2).
    await shadowEmitCiSignal(live, SID, "green");
    expect((await getPrCoordination(db, SID))!.ciFixRounds).toBe(2);

    // (b) the epoch terminal: an epoch terminal holds no honest CI read (resetContext.ciGreen=false,
    //     the documented conservative), so the reset defers again — never fabricated. With no OTHER
    //     uncovered actionable items remaining, ARC-1556's same-head drain arm stays inert and the
    //     terminal clears the in-flight marker.
    await shadowEmitEpochTerminal(live, SID, PR_URL, {
      kind: "replied",
      epochId: "epoch-cifix-1",
      epochTrigger: "ci_fix",
      sourceIds: ["review:owned"],
      headSha: "h1",
    });
    let rec = await getPrCoordination(db, SID);
    expect(rec!.inFlightEpochId).toBeNull();
    expect(rec!.ciFixRounds).toBe(2);

    // (c) the next green ci.signal (webhook or the ≤5-min cron re-poll) is the live FG-2 carrier: the
    //     REVIEW green self-loop's own reset field-write + the post-action (real ciGreen) zero it.
    await shadowEmitCiSignal(live, SID, "green");
    rec = await getPrCoordination(db, SID);
    expect(rec!.ciFixRounds).toBe(0);
    expect(rec!.state).toBe("MERGE_READY"); // green + no in-flight/no undispositioned items settles immediately
  });
});

// ── The resolver matrix itself (unit) ──────────────────────────────────────────

describe("PR 47 — buildLiveGuardResolver (the matrix units)", () => {
  it("guards are record-sourced; the epoch id prefers the threaded legacy id, else the synthetic version key", () => {
    const rec = buildRecord({
      version: 7,
      verdict: "pass",
      verdictHeadSha: "h1",
      verificationRunCount: 2,
      verificationRunId: 4,
      verificationChildId: "child-4",
      ciFixRounds: 1,
      mergeReadyReopenCount: 1,
    }) as never;
    const event = { type: "caught_up", headSha: "h1" } as never;

    const synthetic = buildLiveGuardResolver(env(db, "live"), SID).guards(rec, event);
    expect(synthetic).toMatchObject({
      noInflightEpoch: true,
      newEpochId: `epoch-${SID}-7`,
      codeChangedSinceVerification: false,
      verificationPass: true,
      verificationFresh: true,
      underVerificationCap: true,
      verificationRunCount: 2,
      verificationRunId: 4,
      verificationChildId: "child-4",
      // FG-1 (W11-V1): the ghost-discard target is NEVER the active child — sourcing it from the
      // stamped `verificationChildId` would kill the LIVE run. The record can't recover a superseded
      // run's (already-killed) child, so the ghost kill resolves to `null` (a safe idempotent no-op).
      verdictVerificationChildId: null,
      underCiFixCap: true,
      ciFixRounds: 1,
      underMergeReadyReopenCap: true,
      mergeReadyReopenCount: 1,
      ciBucket: "ci_pending", // the honest default — a WAIT, never a fabricated green
    });

    const threaded = buildLiveGuardResolver(env(db, "live"), SID, {
      legacyEpochId: "epoch-real-9",
      ciBucket: "ci_green",
      reviewSourceId: "review:5",
    }).guards(rec, event);
    expect(threaded).toMatchObject({ newEpochId: "epoch-real-9", ciBucket: "ci_green", reviewSourceId: "review:5" });
  });

  it("A4: the QA re-run guards are record-sourced (verdict/heads) and the QA-finding flag rides the ctx", () => {
    const rec = buildRecord({ verdict: "app_breaks", verdictHeadSha: "oldh", headSha: "newh" }) as never;
    const event = { type: "epoch.committed", epochId: "e1" } as never;

    const noCtx = buildLiveGuardResolver(env(db, "live"), SID).guards(rec, event);
    expect(noCtx).toMatchObject({
      recordedVerdict: "app_breaks",
      verdictHeadSha: "oldh",
      currentHeadSha: "newh",
      committedEpochDispositionedQaFinding: false, // absent ctx → no re-run
    });

    const withQa = buildLiveGuardResolver(env(db, "live"), SID, {
      committedEpochDispositionedQaFinding: true,
    }).guards(rec, event);
    expect(withQa.committedEpochDispositionedQaFinding).toBe(true);
  });

  it("resetContext.ciGreen follows the honest CI source (true only for a threaded green)", () => {
    const rec = buildRecord() as never;
    expect(buildLiveGuardResolver(env(db, "live"), SID).resetContext(rec).ciGreen).toBe(false);
    expect(buildLiveGuardResolver(env(db, "live"), SID, { ciBucket: "ci_green" }).resetContext(rec).ciGreen).toBe(true);
    expect(buildLiveGuardResolver(env(db, "live"), SID, { ciBucket: "ci_red" }).resetContext(rec).ciGreen).toBe(false);
  });

  it("deadlineMs wires the REAL class map (DE-3): REVIEW arms, resting terminals clear", () => {
    const resolver = buildLiveGuardResolver(env(db, "live"), SID);
    expect(resolver.deadlineMs("REVIEW")).toBe(REVIEW_STUCK_DEADLINE_MS);
    expect(resolver.deadlineMs("NEEDS_YOU")).toBeNull();
    expect(resolver.deadlineMs("MERGED")).toBeNull();
  });

  it("caughtUpInputs reads the AUTHORITATIVE store; a no-PR record floors conservatively", async () => {
    const liveEnv = env(db, "live");
    await registerDispositionIfAbsent(db, { sessionId: SID, prUrl: PR_URL, sourceId: "review:1" }, NOW);
    const resolver = buildLiveGuardResolver(liveEnv, SID);
    const inputs = await resolver.caughtUpInputs(buildRecord() as never, { type: "caught_up", headSha: "h1" } as never);
    expect(inputs.store.countUndispositionedActionable()).toBe(1);

    // Disposition the item → the disposition count flips (the sole caught_up store input now).
    await upsertDisposition(
      db,
      { sessionId: SID, prUrl: PR_URL, sourceId: "review:1", disposition: "fixed", basis: null, epochId: "e1" },
      NOW,
    );
    const settled = await resolver.caughtUpInputs(
      buildRecord() as never,
      { type: "caught_up", headSha: "h1" } as never,
    );
    expect(settled.store.countUndispositionedActionable()).toBe(0);

    // No PR url → the conservative floor (nothing post-publish exists to settle).
    const floored = await resolver.caughtUpInputs(
      buildRecord({ prUrl: null, state: "GENERATING" }) as never,
      { type: "caught_up", headSha: "h1" } as never,
    );
    expect(floored.store.countUndispositionedActionable()).toBe(1);
  });

  it("the review producer at live registers via the worklist AND anchors in_flight_epoch_id to the threaded legacy id", async () => {
    await insertPrCoordination(db, buildRecord());
    // Materialize the legacy epoch row so the live sink's dispatch_epoch exists-check binds cleanly.
    sqlite
      .prepare(
        `INSERT INTO pr_review_response_epochs (
           id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha,
           expected_bots_hash, expected_bots_json, expected_bot_keys_json,
           first_activity_at, fallback_after_at, status, created_at, updated_at
         ) VALUES (?, ?, 1, 'x', 'y', 9, ?, 'h1', 'hash', '[]', '[]', ?, ?, 'ready', ?, ?)`,
      )
      .run("epoch-ingest-7", SID, PR_URL, NOW, NOW, NOW, NOW);

    await shadowEmitReviewReceived(
      env(db, "live"),
      SID,
      { reviewerKind: "bot", reviewerId: "greptile", reviewSourceId: "review:77", actionable: true },
      undefined,
      { legacyEpochId: "epoch-ingest-7" },
    );
    const rec = await getPrCoordination(db, SID);
    // Legacy created the epoch; the FSM RECORDED its real id (the PR 46 dispatch_epoch deferral closed).
    expect(rec!.inFlightEpochId).toBe("epoch-ingest-7");
    // The triggering review is durably registered (FG-5) — caught_up stays false until dispositioned.
    const row = sqlite
      .prepare(`SELECT disposition FROM pr_review_item_dispositions WHERE session_id = ? AND source_id = ?`)
      .get(SID, "review:77") as { disposition: string } | undefined;
    expect(row?.disposition).toBe("none");
    // The exists-check bound on the real id: no "not materialized" skip event.
    const skips = ddEvents("fsm.sideeffect.skipped").filter((e) => e.kind === "dispatch_epoch");
    expect(skips).toHaveLength(0);
  });
});

// Reviewer-settle no longer gates caught_up (ARC-1330 decouple, PR-A1/A2); the reviewer no-show / first-contact-settle subsystem has been deleted (PR-A2).

// ── AUTO-VERIFY WAIVER (2026-07-06 decision on the verification-spawn OPEN question) ──────────────

describe("verification off-gate — a green-CI settled world settles MERGE_READY regardless of the auto-verify waiver", () => {
  // ARC-1330 CI-ladder cut: verification is no longer a merge-ready gate for ANY cohort — the cascade
  // reads only CI + no_inflight_epoch. A green-CI, 0-undispositioned world settles MERGE_READY whether or
  // not auto-verify is enabled: neither cohort enters VERIFYING via the cascade (row-1 is gone), so no run
  // is burned and no verifier is spawned from the cascade. The waiver is still RESOLVED by the resolver
  // (the publish-time spawn decline consumes it), but the cascade never reads it.
  const optedOutWorld = () => buildRecord({ codeChangedSinceVerification: true, verdict: null, verdictHeadSha: null });

  it("LIVE: an opted-out session settles MERGE_READY on a green ci.signal — no VERIFYING, no run burned, no spawn", async () => {
    mocks.getSessionState.mockResolvedValue({ ...SESSION, autoVerifyDisabled: true } as SessionState);
    await insertPrCoordination(db, optedOutWorld());
    await shadowEmitCiSignal(env(db, "live"), SID, "green");
    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("MERGE_READY");
    expect(rec!.verificationRunCount).toBe(0); // no request_verification — verification was never a gate
    expect(mocks.scheduleAutoVerification).not.toHaveBeenCalled();
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  it("LIVE: the identical world WITH auto-verify ON ALSO settles MERGE_READY — verification is off-gate (no VERIFYING)", async () => {
    mocks.getSessionState.mockResolvedValue({ ...SESSION, autoVerifyDisabled: false } as SessionState);
    await insertPrCoordination(db, optedOutWorld());
    await shadowEmitCiSignal(env(db, "live"), SID, "green");
    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("MERGE_READY");
    expect(rec!.verificationRunCount).toBe(0); // the cascade never dispatches verification anymore
    expect(mocks.scheduleAutoVerification).not.toHaveBeenCalled();
  });

  it("LIVE: a FAILED session read still settles MERGE_READY on green — the resolver read never gates the merge path", async () => {
    mocks.getSessionState.mockRejectedValue(new Error("DO unavailable"));
    await insertPrCoordination(db, optedOutWorld());
    await shadowEmitCiSignal(env(db, "live"), SID, "green");
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
  });

  it("LIVE: av-ON, NO verdict, uncovered-CI head — a NON-CI recompute fires the honest one-head poll; a corroborated absent classifies ci_green → MERGE_READY", async () => {
    // The re-keyed poll gate (W11-T1 / A1 CI-ladder): the `caughtUpInputs` honest read is now gated ONLY
    // on the merge-ready door (state===REVIEW ∧ noInflightEpoch ∧ 0 undispositioned) — the verification
    // conjuncts (pass ∧ fresh ∧ ¬code_changed / the auto-verify waiver) are DROPPED. This case exercises
    // that branch for the cohort the old gate would have starved: auto-verify ON, no verdict, and the CI
    // fed ONLY by the honest poll (no `ci.signal` ever emitted → callerSuppliedCi=false). An epoch
    // terminal (a §6 recompute that supplies no ciBucket) dispositions the last item and clears the
    // epoch; the door then holds, so the poll fires and a corroborated `absent` (no-CI repo) classifies
    // to ci_green → MERGE_READY. If the poll were still gated on verification, this world (verdict=null)
    // would sit at row-5 ci_pending forever.
    mocks.getSessionState.mockResolvedValue({ ...SESSION, autoVerifyDisabled: false } as SessionState);
    mocks.readSettleableHeadCi.mockResolvedValue("absent" as ReviewLoopCiState);
    await insertPrCoordination(db, buildRecord({ inFlightEpochId: "epoch-t1", verdict: null, verdictHeadSha: null }));
    await registerDispositionIfAbsent(db, { sessionId: SID, prUrl: PR_URL, sourceId: "review:owned" }, NOW);
    const live = env(db, "live");
    await shadowEmitEpochTerminal(live, SID, PR_URL, {
      kind: "replied",
      epochId: "epoch-t1",
      epochTrigger: "ci_fix",
      sourceIds: ["review:owned"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, SID);
    expect(rec!.inFlightEpochId).toBeNull(); // the terminal cleared the epoch
    expect(rec!.state).toBe("MERGE_READY"); // settled through the honest poll — no ci.signal was ever fed
    expect(mocks.readSettleableHeadCi).toHaveBeenCalled(); // the poll fired at the merge-ready door
    expect(mocks.readSettleableHeadCi.mock.calls[0].slice(1)).toEqual([SID, PR_URL, "h1"]); // current head
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  it("LIVE: an UNSETTLEABLE (uncorroborated absent → pending) honest read leaves the row at REVIEW — never a fabricated green", async () => {
    // Guard the soundness edge: when the honest read returns `pending` (an uncorroborated absent degrades
    // to pending inside readSettleableHeadCiForRecord), the resolver keeps its conservative ci_pending
    // (row-5 WAIT). The door held (the poll DID fire) but the CI column is not green → no settle.
    mocks.getSessionState.mockResolvedValue({ ...SESSION, autoVerifyDisabled: false } as SessionState);
    mocks.readSettleableHeadCi.mockResolvedValue("pending" as ReviewLoopCiState);
    await insertPrCoordination(db, buildRecord({ inFlightEpochId: "epoch-t2", verdict: null, verdictHeadSha: null }));
    await registerDispositionIfAbsent(db, { sessionId: SID, prUrl: PR_URL, sourceId: "review:owned" }, NOW);
    const live = env(db, "live");
    await shadowEmitEpochTerminal(live, SID, PR_URL, {
      kind: "replied",
      epochId: "epoch-t2",
      epochTrigger: "ci_fix",
      sourceIds: ["review:owned"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, SID);
    expect(rec!.inFlightEpochId).toBeNull();
    expect(rec!.state).toBe("REVIEW"); // conservative ci_pending — the poll fired but read non-green
    expect(mocks.readSettleableHeadCi).toHaveBeenCalled();
    expect(ddEvents("fsm.settle")).toHaveLength(0);
  });

  it("guards() exposes the resolver-read opt-out after the caughtUpInputs snapshot (the resolvedCiBucket seam)", async () => {
    mocks.getSessionState.mockResolvedValue({ ...SESSION, autoVerifyDisabled: true } as SessionState);
    const resolver = buildLiveGuardResolver(env(db, "live"), SID);
    const settledWorld = optedOutWorld(); // no items/reviewers registered → conjunction holds
    // Before the snapshot: the outer event's guards read the un-waived default (harmless — only the
    // caught_up cascade consults the waiver, and it runs after the snapshot).
    expect(
      resolver.guards(settledWorld as never, { type: "caught_up", headSha: "h1" } as never).autoVerifyDisabled,
    ).toBe(false);
    await resolver.caughtUpInputs(settledWorld as never, { type: "caught_up", headSha: "h1" } as never);
    expect(
      resolver.guards(settledWorld as never, { type: "caught_up", headSha: "h1" } as never).autoVerifyDisabled,
    ).toBe(true);
  });
});
