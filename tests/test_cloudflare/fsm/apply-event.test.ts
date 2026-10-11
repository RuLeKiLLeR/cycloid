// Integration tests for the ARC-1330 `applyEvent` single-writer write path (PR 34, design §8/§18.4).
//
// Drives the SPINE over a real migrated SQLite (the Wave-1 DAO idiom: createMigratedSqlite/asD1) with
// in-memory fakes for the injected live-read resolver + bucket-a/b sinks. Covers the write-path
// contract the spec names: CAS commit, commit-before-side-effect, the lost-race re-read, the
// observability emit (dwell_ms/stage_from/stage_to/flattened metadata), O2 emit isolation, the
// unhandled-event noop, the caught_up recompute re-entry to MERGE_READY, and the off-mode short-circuit.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REVIEW_STUCK_DEADLINE_MS,
  VERIFYING_BACKSTOP_DEADLINE_MS,
} from "../../../apps/control-plane-worker/src/constants/review-loop";
import {
  applyEvent,
  type ApplyEventDeps,
  type FsmGuardResolver,
  type FsmSideEffectSink,
  noopSideEffectSink,
  noopWorklistSink,
  type SideEffectDispatch,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { deadlineWouldFire } from "../../../apps/control-plane-worker/src/session/fsm/deadline-producer";
import { caughtUp } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import type { Guards } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { EventMetadata, FsmEvent, FsmRecord } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import { SqliteD1 } from "../sqlite-d1-helper";

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

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

const SID = "sess-1";
const NOW = 1_700_000_010_000;

function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "CREATED",
    prUrl: null,
    headSha: null,
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: true,
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

/** A configurable resolver: per-event guards + caught_up snapshot, plus a no-op deadline class. */
function makeResolver(opts: {
  guards?: (rec: FsmRecord, event: FsmEvent) => Guards;
  resetGreen?: boolean;
  resetNoInflight?: boolean;
  undispositioned?: number;
}): FsmGuardResolver {
  return {
    guards: opts.guards ?? (() => ({ sandboxAlive: true })),
    resetContext: () => ({ ciGreen: opts.resetGreen ?? false, noInflightEpoch: opts.resetNoInflight ?? true }),
    caughtUpInputs: () => ({
      noInflightEpoch: opts.resetNoInflight ?? true,
      store: {
        countUndispositionedActionable: () => opts.undispositioned ?? 0,
      },
    }),
    deadlineMs: () => null,
  };
}

function baseDeps(db: D1Database, resolver: FsmGuardResolver, over: Partial<ApplyEventDeps> = {}): ApplyEventDeps {
  return {
    db,
    env: { DD_API_KEY: undefined, WORKER_ENV: "test" },
    now: () => NOW,
    resolver,
    sideEffects: noopSideEffectSink,
    worklist: noopWorklistSink,
    emit: vi.fn(async () => true),
    ...over,
  };
}

describe("applyEvent write path (PR 34, §8)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("commits the CAS row, appends the event log with dwell_ms + metadata, and returns handled", async () => {
    await insertPrCoordination(db, buildRecord());
    const resolver = makeResolver({});
    const emit = vi.fn(async () => true);
    const meta: EventMetadata = { type: "sandbox.spawn_requested" };

    const result = await applyEvent(baseDeps(db, resolver, { emit }), {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      metadata: meta,
      actor: "transport",
    });

    expect(result).toEqual({ outcome: "handled", from: "CREATED", to: "PROVISIONING", version: 1 });

    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("PROVISIONING");
    expect(rec?.version).toBe(1);
    expect(rec?.stateEnteredAt).toBe(NOW); // arm_deadline re-anchored the dwell clock

    const log = await listPrCoordinationEvents(db, SID);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      version: 1,
      fromState: "CREATED",
      toState: "PROVISIONING",
      event: "sandbox.spawn_requested",
      actor: "transport",
      dwellMs: 5_000, // NOW − stateEnteredAt
    });

    // The structured DD event carries the design §18.4 fields.
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "fsm.transition",
      session_id: SID,
      from: "CREATED",
      to: "PROVISIONING",
      fsm_event: "sandbox.spawn_requested",
      dwell_ms: 5_000,
    });
    expect(typeof payload.stage_from).toBe("string");
    expect(typeof payload.stage_to).toBe("string");
    expect(payload.stage).toBe(payload.stage_from);
    // W11-G4 producer-latency: the commit-latency field is present on every committed transition (0 here
    // because the fake clock is constant — the pinned-producer case).
    expect(typeof payload.commit_latency_ms).toBe("number");
    expect(payload.commit_latency_ms).toBe(0);
  });

  it("stamps commit_latency_ms = entry→commit span from the injected clock (W11-G4)", async () => {
    await insertPrCoordination(db, buildRecord());
    const emit = vi.fn(async () => true);
    // An advancing wall clock (the live `Date.now`-wired producer case): applyEvent reads `now` at entry
    // (applyStartedAt), then for the state mutation, then at the emit — so the measured latency is the
    // span across those reads (3rd − 1st), strictly positive.
    let clock = NOW;
    const advancingNow = () => {
      clock += 1_000;
      return clock;
    };

    await applyEvent(baseDeps(db, makeResolver({}), { emit, now: advancingNow }), {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof payload.commit_latency_ms).toBe("number");
    // entry read = NOW+1000, emit-latency read = NOW+3000 → 2000ms span.
    expect(payload.commit_latency_ms).toBe(2_000);
  });

  it("dispatches bucket-b side-effects AFTER commit (commit-before-side-effect)", async () => {
    await insertPrCoordination(db, buildRecord());
    let versionSeenAtDispatch: number | null = null;
    let dispatchArgs: SideEffectDispatch | null = null;
    const sink: FsmSideEffectSink = {
      async dispatch(d) {
        dispatchArgs = d;
        // The CAS row must already be committed when side-effects run.
        const rec = await getPrCoordination(db, SID);
        versionSeenAtDispatch = rec?.version ?? null;
      },
    };

    await applyEvent(baseDeps(db, makeResolver({}), { sideEffects: sink }), {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    expect(versionSeenAtDispatch).toBe(1);
    expect(dispatchArgs).not.toBeNull();
    const d = dispatchArgs as unknown as SideEffectDispatch;
    expect(d.version).toBe(1);
    expect(d.sideEffects.map((s) => s.kind)).toContain("spawn_sandbox");
    // The universal `project` post-action rides every committed transition.
    expect(d.sideEffects.map((s) => s.kind)).toContain("project");
  });

  it("flattens typed metadata onto the DD event (reviewer_id is the count-metric tag)", async () => {
    // A non-actionable review is a handled REVIEW self-loop (appends + emits); an undispositioned item
    // remains so the caught_up recompute does NOT fire — so exactly one transition is emitted.
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", headSha: "h1", codeChangedSinceVerification: false }),
    );
    const emit = vi.fn(async () => true);
    const resolver = makeResolver({
      guards: () => ({ sandboxAlive: true, noInflightEpoch: true }),
      undispositioned: 1,
    });
    const meta: EventMetadata = {
      type: "review.received",
      reviewerKind: "bot",
      reviewerId: "greptile",
      reviewSourceId: "src-7",
      actionable: false,
    };

    await applyEvent(baseDeps(db, resolver, { emit }), {
      sessionId: SID,
      event: { type: "review.received", reviewerKind: "bot", actionable: false },
      metadata: meta,
      actor: "webhook",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      fsm_event: "review.received",
      reviewer_kind: "bot",
      reviewer_id: "greptile",
      review_source_id: "src-7",
      actionable: false,
    });
    expect(payload.type).toBeUndefined(); // the metadata discriminator is dropped (fsm_event carries it)
  });

  it("isolates a thrown observability emit — the commit still lands (O2)", async () => {
    await insertPrCoordination(db, buildRecord());
    const emit = vi.fn(async () => {
      throw new Error("datadog down");
    });

    const result = await applyEvent(baseDeps(db, makeResolver({}), { emit }), {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    expect(result.outcome).toBe("handled");
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("PROVISIONING");
    expect(rec?.version).toBe(1);
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(1);
  });

  it("writes no row and emits noop=unhandled for an unhandled event", async () => {
    await insertPrCoordination(db, buildRecord());
    const emit = vi.fn(async () => true);

    const result = await applyEvent(baseDeps(db, makeResolver({}), { emit }), {
      sessionId: SID,
      event: { type: "pr.merged" }, // no edge out of CREATED
      actor: "webhook",
    });

    expect(result).toEqual({ outcome: "unhandled", from: "CREATED", to: "CREATED", version: 0 });
    const rec = await getPrCoordination(db, SID);
    expect(rec?.version).toBe(0); // untouched
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0); // no append
    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    // The row exists → `noop:unhandled` carrying the real current `from` state.
    expect(payload).toMatchObject({
      event: "fsm.transition",
      noop: "unhandled",
      from: "CREATED",
      fsm_event: "pr.merged",
    });
  });

  it("re-reads and re-evaluates idempotently on a lost CAS race", async () => {
    await insertPrCoordination(db, buildRecord());
    let bumped = false;
    // Simulate a concurrent writer that bumps the version between the read and the CAS, on the first
    // attempt only. The spine's CAS then fails (changed === 0) and re-reads at the bumped version.
    const resolver = makeResolver({
      guards: () => {
        if (!bumped) {
          bumped = true;
          sqlite.prepare("UPDATE pr_coordination SET version = version + 1 WHERE session_id = ?").run(SID);
        }
        return { sandboxAlive: true };
      },
    });

    const result = await applyEvent(baseDeps(db, resolver), {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    // Interloper bumped 0 → 1; the re-evaluated commit lands 1 → 2.
    expect(result).toEqual({ outcome: "handled", from: "CREATED", to: "PROVISIONING", version: 2 });
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("PROVISIONING");
    expect(rec?.version).toBe(2);
  });

  it("recomputes caught_up after the trigger and re-enters to MERGE_READY end-to-end", async () => {
    // REVIEW, no code change, clean green pass that is fresh — a settled queue should cascade to
    // MERGE_READY via the internal caught_up re-entry (PR-20A producer + PR-16 cascade row 7).
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        headSha: "h1",
        codeChangedSinceVerification: false,
        verdict: "pass",
        verdictHeadSha: "h1",
      }),
    );

    const resolver: FsmGuardResolver = {
      guards: (_rec, event) => {
        if (event.type === "caught_up") {
          return {
            sandboxAlive: true,
            // W11-T1: row 7 now requires no_inflight_epoch (the stale-green race conjunct).
            noInflightEpoch: true,
            codeChangedSinceVerification: false,
            ciBucket: "ci_green",
            verificationPass: true,
            verificationFresh: true,
          };
        }
        return { sandboxAlive: true, noInflightEpoch: true };
      },
      resetContext: () => ({ ciGreen: true, noInflightEpoch: true }),
      caughtUpInputs: () => ({
        noInflightEpoch: true,
        store: { countUndispositionedActionable: () => 0 },
      }),
      deadlineMs: () => null,
    };

    const result = await applyEvent(baseDeps(db, resolver), {
      sessionId: SID,
      event: { type: "review.received", reviewerKind: "bot", actionable: false },
      actor: "webhook",
    });

    // The TRIGGER transition itself stays in REVIEW (a non-actionable self-loop)…
    expect(result).toEqual({ outcome: "handled", from: "REVIEW", to: "REVIEW", version: 1 });
    // …but the recompute re-entered applyEvent(caught_up) and the cascade reached MERGE_READY.
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("MERGE_READY");
    expect(rec?.version).toBe(2);

    const log = await listPrCoordinationEvents(db, SID);
    expect(log.map((e) => e.event)).toEqual(["review.received", "caught_up"]);
    expect(log[1]).toMatchObject({ fromState: "REVIEW", toState: "MERGE_READY", actor: "internal" });
    // Sanity: the guard the recompute consulted truly held.
    expect(caughtUp(true, { countUndispositionedActionable: () => 0 })).toBe(true);
  });

  it("emits noop=no_record (no from placeholder) when the row is absent", async () => {
    // No record yet (pre-genesis / backfill gap): `noop:no_record`, and the fabricated `from:"CREATED"`
    // placeholder is DROPPED (the row doesn't exist, so there is no originating state).
    const emit = vi.fn(async () => true);
    const missing = await applyEvent(baseDeps(db, makeResolver({}), { emit }), {
      sessionId: "ghost",
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });
    expect(missing.outcome).toBe("no_record");
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "fsm.transition",
      noop: "no_record",
      fsm_event: "sandbox.spawn_requested",
    });
    expect(payload).not.toHaveProperty("from");
  });
});

describe("applyEvent — the transition emit rides waitUntil (W11-G4)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("routes the transition emit through waitUntil when provided (never blocks the commit path)", async () => {
    await insertPrCoordination(db, buildRecord());
    const waitUntil = vi.fn();

    await applyEvent(baseDeps(db, makeResolver({}), { waitUntil }), {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    // The best-effort DD transition post rides waitUntil off the commit path (W11-G4), as a Promise.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});

// W11-V5 SF10 (the adversarial-review BLOCKER-1 fix): the epoch.deferred keep-alive is DWELL-NEUTRAL.
// A handled REVIEW self-loop that journals but does NOT re-arm the deadline, so the §10 give-up
// (review_stuck) stays REACHABLE under unbounded contention — the monotonic give-up anchor.
describe("SF10 dwell-neutral give-up: epoch.deferred never pushes review_stuck out (W11-V5)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const FIVE_MIN = 5 * 60 * 1000;

  it("continuous epoch.deferred every tick for >24h does NOT re-stamp the dwell anchor; review_stuck STILL fires", async () => {
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        inFlightEpochId: "ep-1",
        stateEnteredAt: T0,
        deadlineAt: T0 + REVIEW_STUCK_DEADLINE_MS,
      }),
    );
    const resolver = makeResolver({}); // epoch.deferred reads no guards; deadlineMs null

    // Simulate ~26h of sweep ticks, each re-deferring the still-in-flight epoch (contention churn).
    const ticks = Math.ceil((26 * 60 * 60 * 1000) / FIVE_MIN);
    for (let i = 1; i <= ticks; i += 1) {
      const now = T0 + i * FIVE_MIN;
      const r = await applyEvent(baseDeps(db, resolver, { now: () => now }), {
        sessionId: SID,
        event: { type: "epoch.deferred", epochId: "ep-1", deferralKind: "contention" },
        metadata: { type: "epoch.deferred", epochId: "ep-1", deferralKind: "contention", reason: "ci_checks_pending" },
        actor: "cron",
      });
      expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
      // The dwell anchor is PRESERVED at T0 on EVERY tick — contrast the re-arm at the top-of-file test.
      expect((await getPrCoordination(db, SID))?.stateEnteredAt).toBe(T0);
    }

    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.inFlightEpochId).toBe("ep-1"); // still in flight — the deferrals never terminated it
    expect(rec?.stateEnteredAt).toBe(T0); // 26h of churn did NOT move the give-up anchor

    // The 24h give-up is REACHABLE: the deadline producer WOULD fire after >24h of pure deferral churn.
    const nowAfter = T0 + ticks * FIVE_MIN;
    expect(deadlineWouldFire({ state: "REVIEW", stateEnteredAt: rec!.stateEnteredAt }, nowAfter)).toBe(true);

    // And the loud give-up lands: deadline_exceeded → NEEDS_YOU(review_stuck).
    const giveUp = await applyEvent(baseDeps(db, resolver, { now: () => nowAfter }), {
      sessionId: SID,
      event: { type: "deadline_exceeded" },
      actor: "cron",
    });
    expect(giveUp).toMatchObject({ outcome: "handled", to: "NEEDS_YOU" });
    expect((await getPrCoordination(db, SID))?.blockedReason).toBe("review_stuck");
  });

  it("MIXED churn (the re-review fix): epoch.deferred AND re-observed ci.signal(green) every tick for >24h — give-up STILL fires", async () => {
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        inFlightEpochId: "ep-1",
        stateEnteredAt: T0,
        deadlineAt: T0 + REVIEW_STUCK_DEADLINE_MS,
      }),
    );
    // Non-caught-up (undispositioned=1) so the ci.signal(green) `ci_green_flip` recompute never settles.
    const resolver = makeResolver({ undispositioned: 1 });

    const ticks = Math.ceil((26 * 60 * 60 * 1000) / FIVE_MIN);
    for (let i = 1; i <= ticks; i += 1) {
      const now = T0 + i * FIVE_MIN;
      // Alternate the TWO per-tick churn vectors the sweep actually co-emits for an in-flight-epoch row:
      // the epoch re-defer AND the re-observed settled-CI signal (an in-flight ci.signal(green) → log_noop).
      const event: FsmEvent =
        i % 2 === 0
          ? { type: "epoch.deferred", epochId: "ep-1", deferralKind: "contention" }
          : { type: "ci.signal", ciState: "green" };
      const metadata: EventMetadata =
        i % 2 === 0
          ? { type: "epoch.deferred", epochId: "ep-1", deferralKind: "contention", reason: "ci_checks_pending" }
          : { type: "ci.signal", ciState: "green" };
      const r = await applyEvent(baseDeps(db, resolver, { now: () => now }), {
        sessionId: SID,
        event,
        metadata,
        actor: "cron",
      });
      expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
      // BOTH vectors are pure REVIEW churn (empty writes, log_noop) → the anchor is preserved on EVERY tick.
      expect((await getPrCoordination(db, SID))?.stateEnteredAt).toBe(T0);
    }

    const rec = await getPrCoordination(db, SID);
    expect(rec?.stateEnteredAt).toBe(T0); // 26h of MIXED churn did not move the give-up anchor
    const nowAfter = T0 + ticks * FIVE_MIN;
    expect(deadlineWouldFire({ state: "REVIEW", stateEnteredAt: rec!.stateEnteredAt }, nowAfter)).toBe(true);
    const giveUp = await applyEvent(baseDeps(db, resolver, { now: () => nowAfter }), {
      sessionId: SID,
      event: { type: "deadline_exceeded" },
      actor: "cron",
    });
    expect(giveUp).toMatchObject({ outcome: "handled", to: "NEEDS_YOU" });
    expect((await getPrCoordination(db, SID))?.blockedReason).toBe("review_stuck");
  });

  it("CONTRAST: a green→failing ci.signal flip (field-writing dispatch) DOES re-arm — a real CI state change is progress", async () => {
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        stateEnteredAt: T0,
      }),
    );
    // A genuine red (no in-flight epoch, under cap) dispatches a ciFix epoch — writes fields → NOT churn.
    const resolver = makeResolver({
      guards: () => ({
        sandboxAlive: true,
        noInflightEpoch: true,
        underCiFixCap: true,
        ciFixRounds: 0,
        newEpochId: "epoch-new",
      }),
      undispositioned: 1,
    });
    const later = T0 + FIVE_MIN;
    await applyEvent(baseDeps(db, resolver, { now: () => later }), {
      sessionId: SID,
      event: { type: "ci.signal", ciState: "failing" },
      metadata: { type: "ci.signal", ciState: "failing" },
      actor: "webhook",
    });
    const rec = await getPrCoordination(db, SID);
    expect(rec?.inFlightEpochId).toBe("epoch-new"); // it dispatched a ciFix epoch (field-write)
    expect(rec?.stateEnteredAt).toBe(later); // a real CI change re-anchors the dwell clock (progress, not churn)
  });

  it("CONTRAST (kept): epoch.deferred-only continuous churn still fires the give-up at 24h", async () => {
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        inFlightEpochId: "ep-1",
        stateEnteredAt: T0,
      }),
    );
    const resolver = makeResolver({});
    const ticks = Math.ceil((25 * 60 * 60 * 1000) / FIVE_MIN);
    for (let i = 1; i <= ticks; i += 1) {
      const now = T0 + i * FIVE_MIN;
      await applyEvent(baseDeps(db, resolver, { now: () => now }), {
        sessionId: SID,
        event: { type: "epoch.deferred", epochId: "ep-1", deferralKind: "transient" },
        metadata: { type: "epoch.deferred", epochId: "ep-1", deferralKind: "transient", reason: "github_502" },
        actor: "cron",
      });
    }
    const rec = await getPrCoordination(db, SID);
    expect(rec?.stateEnteredAt).toBe(T0);
    expect(deadlineWouldFire({ state: "REVIEW", stateEnteredAt: rec!.stateEnteredAt }, T0 + ticks * FIVE_MIN)).toBe(
      true,
    );
  });

  // MAJOR-1: the value-gated FG-2 green reset. A no-inflight green re-observe with ci_fix_rounds ALREADY
  // 0 is a no-op reset → empty decision → churn (anchor preserved). With ci_fix_rounds > 0 it is a REAL
  // reset → writes a field → re-arms (progress: CI recovered).
  it("MAJOR-1: no-inflight green re-observe with ci_fix_rounds=0 does NOT re-arm; with >0 it resets AND re-arms", async () => {
    const greenNoInflight = {
      guards: () => ({
        sandboxAlive: true,
        noInflightEpoch: true,
        ciSettled: true,
        epoch1Fired: true,
        actionableExists: false,
        ciFixRounds: 0,
      }),
      resetGreen: true,
      resetNoInflight: true,
      undispositioned: 1,
    };

    // (a) ci_fix_rounds already 0 → churn → anchor unmoved.
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        ciFixRounds: 0,
        stateEnteredAt: T0,
      }),
    );
    await applyEvent(baseDeps(db, makeResolver(greenNoInflight), { now: () => T0 + FIVE_MIN }), {
      sessionId: SID,
      event: { type: "ci.signal", ciState: "green" },
      metadata: { type: "ci.signal", ciState: "green" },
      actor: "webhook",
    });
    expect((await getPrCoordination(db, SID))?.stateEnteredAt).toBe(T0); // NOT re-armed (the MAJOR-1 fix)

    // (b) ci_fix_rounds = 2 → a REAL reset → re-arms + clears the budget.
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-rearm",
        state: "REVIEW",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        ciFixRounds: 2,
        stateEnteredAt: T0,
      }),
    );
    const resolverB = makeResolver({
      ...greenNoInflight,
      guards: () => ({ ...greenNoInflight.guards(), ciFixRounds: 2 }),
    });
    await applyEvent(baseDeps(db, resolverB, { now: () => T0 + FIVE_MIN }), {
      sessionId: "sess-rearm",
      event: { type: "ci.signal", ciState: "green" },
      metadata: { type: "ci.signal", ciState: "green" },
      actor: "webhook",
    });
    const rearmed = await getPrCoordination(db, "sess-rearm");
    expect(rearmed?.stateEnteredAt).toBe(T0 + FIVE_MIN); // re-armed (real progress)
    expect(rearmed?.ciFixRounds).toBe(0); // the budget was actually cleared
  });
});

// MAJOR-2: extend churn-immunity to VERIFYING (the D-50 blocker class). ci.signal is ignored during
// VERIFYING but the sweep co-emits it per tick → a log_noop self-loop that must NOT re-arm the 1h backstop.
describe("SF10 dwell-neutral give-up: VERIFYING churn never pushes the 1h backstop out (W11-V5 re-review)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });
  const FIVE_MIN = 5 * 60 * 1000;

  it("continuous per-tick ci.signal against a VERIFYING row for >1h — anchor unmoved → verification_stopped fires", async () => {
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        verificationRunHead: "h1",
        verificationRunId: 1,
        stateEnteredAt: T0,
        deadlineAt: T0 + VERIFYING_BACKSTOP_DEADLINE_MS,
      }),
    );
    const resolver = makeResolver({ undispositioned: 1 });
    const ticks = Math.ceil((2 * 60 * 60 * 1000) / FIVE_MIN); // ~2h of settled-CI polling
    for (let i = 1; i <= ticks; i += 1) {
      const now = T0 + i * FIVE_MIN;
      const r = await applyEvent(baseDeps(db, resolver, { now: () => now }), {
        sessionId: SID,
        event: { type: "ci.signal", ciState: "green" },
        metadata: { type: "ci.signal", ciState: "green" },
        actor: "cron",
      });
      expect(r).toMatchObject({ outcome: "handled", to: "VERIFYING" });
      expect((await getPrCoordination(db, SID))?.stateEnteredAt).toBe(T0); // VERIFYING churn preserves the anchor
    }
    const rec = await getPrCoordination(db, SID);
    expect(rec?.stateEnteredAt).toBe(T0);
    const nowAfter = T0 + ticks * FIVE_MIN;
    expect(deadlineWouldFire({ state: "VERIFYING", stateEnteredAt: rec!.stateEnteredAt }, nowAfter)).toBe(true);
    const giveUp = await applyEvent(baseDeps(db, resolver, { now: () => nowAfter }), {
      sessionId: SID,
      event: { type: "deadline_exceeded" },
      actor: "cron",
    });
    expect(giveUp).toMatchObject({ outcome: "handled", to: "NEEDS_YOU" });
    expect((await getPrCoordination(db, SID))?.blockedReason).toBe("verification_stopped");
  });

  it("CONTRAST: a field-writing VERIFYING edge (head.noop_changed → restamp) re-arms", async () => {
    const T0 = NOW;
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        version: 1,
        prUrl: "https://github.com/o/r/pull/1",
        headSha: "h1",
        verificationRunHead: "h1",
        stateEnteredAt: T0,
      }),
    );
    const later = T0 + FIVE_MIN;
    await applyEvent(baseDeps(db, makeResolver({}), { now: () => later }), {
      sessionId: SID,
      event: { type: "head.noop_changed", headSha: "h2" },
      actor: "webhook",
    });
    expect((await getPrCoordination(db, SID))?.stateEnteredAt).toBe(later); // a head change is activity → re-arm
  });
});
