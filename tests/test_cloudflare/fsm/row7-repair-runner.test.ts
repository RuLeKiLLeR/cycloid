// ARC-1330 (W11-T1) — the one-shot row-7 parked-stock repair runner (parts 2 + 3).
//
// Drives `runRow7Repair` over a REAL migrated D1 (the backfill-runner test idiom: real DAO reads/writes +
// injected external seams — a deterministic CI verdict + a spy `ci.signal` emit). Proves:
//   • qualification: the pure-CI door (PR-E2) — only rows with `headSha !== null`, no in-flight epoch, and
//     0 undispositioned items are acted on. The old verification-gate conjuncts (fresh pass, unchanged
//     code, reviewers settled) are GONE — stale-verdict / code-changed / never-verified rows now qualify;
//   • dryRun accuracy: a dry run READS + classifies (green/red/pending/unknown) but WRITES/emits nothing,
//     and its would-settle count matches the subsequent live run;
//   • part 2 (REVIEW): re-emits the honest ci.signal, no state hand-written;
//   • part 3 (NEEDS_YOU review_stuck): CAS-reopens to REVIEW then re-emits — and leaves non-review_stuck /
//     non-qualifying NEEDS_YOU rows untouched;
//   • idempotency: a second pass over a settled/emptied cohort is a clean no-op;
//   • soundness: pending/unknown CI never emits or reopens (no false settle); non-live never writes.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewLoopCiState } from "../../../apps/control-plane-worker/src/services/review-loop-rollup";
import {
  type Row7RepairDeps,
  runRow7Repair,
} from "../../../apps/control-plane-worker/src/session/fsm/row7-repair-runner";
import {
  casUpdatePrCoordination,
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import {
  appendPrCoordinationEvent,
  listPrCoordinationEvents,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import { upsertDisposition } from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
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

const NOW = 1_700_000_000_000;

function record(sid: string, overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: sid,
    version: 1,
    state: "REVIEW",
    prUrl: `https://github.com/o/r/pull/${sid}`,
    headSha: "h1",
    verdict: "pass",
    verdictHeadSha: "h1",
    verificationRunHead: null,
    verificationRunId: 1,
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
    stateEnteredAt: NOW - 10_000,
    ...overrides,
  };
}

let sqlite: Database.Database;
let db: D1Database;
let emitCiSignal: ReturnType<typeof vi.fn>;
let readHeadCi: ReturnType<typeof vi.fn>;
let isAbsentCorroborated: ReturnType<typeof vi.fn>;
let emitRepairTelemetry: ReturnType<typeof vi.fn>;

function deps(): Row7RepairDeps {
  return {
    db,
    now: () => NOW,
    readHeadCi: readHeadCi as unknown as Row7RepairDeps["readHeadCi"],
    isAbsentCorroborated: isAbsentCorroborated as unknown as Row7RepairDeps["isAbsentCorroborated"],
    emitCiSignal: emitCiSignal as unknown as Row7RepairDeps["emitCiSignal"],
    emitRepairTelemetry: emitRepairTelemetry as unknown as Row7RepairDeps["emitRepairTelemetry"],
  };
}

beforeEach(() => {
  sqlite = createMigratedSqlite();
  db = new SqliteD1(sqlite) as unknown as D1Database;
  readHeadCi = vi.fn(async (): Promise<ReviewLoopCiState | undefined> => "green");
  // FIX-1 default: an absent read is NOT corroborated unless a test says so (the conservative posture).
  isAbsentCorroborated = vi.fn(async () => false);
  emitCiSignal = vi.fn(async () => {});
  emitRepairTelemetry = vi.fn(async () => true);
});

describe("W11-T1 row-7 repair — part 2 (REVIEW parked stock)", () => {
  it("re-emits the honest ci.signal for a qualifying REVIEW row; hand-writes NO state", async () => {
    await insertPrCoordination(db, record("a"));

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ enumerated: 1, qualified: 1, ciGreen: 1, emitted: 1, reopened: 0, failed: 0 });
    expect(emitCiSignal).toHaveBeenCalledTimes(1);
    expect(emitCiSignal).toHaveBeenCalledWith("a", "green");
    // The runner never touched the row (the injected emit is a spy, so the record is unchanged here).
    expect((await getPrCoordination(db, "a"))!.state).toBe("REVIEW");
  });

  it("skips rows that do not hold the new pure-CI door (undispositioned item; in-flight epoch)", async () => {
    await insertPrCoordination(db, record("undisp"));
    await upsertDisposition(
      db,
      { sessionId: "undisp", prUrl: record("undisp").prUrl!, sourceId: "s1", disposition: "none" },
      NOW,
    );
    await insertPrCoordination(db, record("inflight", { inFlightEpochId: "e-1" }));

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ enumerated: 2, qualified: 0, skippedNotQualified: 2, emitted: 0 });
    expect(emitCiSignal).not.toHaveBeenCalled();
  });

  it("qualifies rows the OLD verification-gated door rejected: stale verdict, changed code, never-verified", async () => {
    // Post the ARC-1330 CI-ladder cut the door reads NO verification predicate, so a stale/absent verdict
    // and code-changed-since-verification no longer disqualify — a green CI read settles them at row 7. A
    // never-verified row (verdict: null) qualifies exactly like any other; verification is not consulted.
    await insertPrCoordination(db, record("stale", { verdictHeadSha: "h0" })); // verdict not fresh — now OK
    await insertPrCoordination(db, record("changed", { codeChangedSinceVerification: true })); // now OK
    await insertPrCoordination(db, record("noverdict", { verdict: null, verdictHeadSha: null })); // now OK

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ enumerated: 3, qualified: 3, ciGreen: 3, emitted: 3, skippedNotQualified: 0 });
    expect(emitCiSignal).toHaveBeenCalledTimes(3);
  });

  it("dryRun classifies (incl. the CI poll) but emits nothing; the count matches the live run", async () => {
    await insertPrCoordination(db, record("g1"));
    await insertPrCoordination(db, record("g2"));

    const dry = await runRow7Repair(deps(), { target: "review", dryRun: true });
    expect(dry).toMatchObject({ qualified: 2, ciGreen: 2, emitted: 0, dryRun: true });
    expect(readHeadCi).toHaveBeenCalledTimes(2); // the CI poll DID run (accuracy)
    expect(emitCiSignal).not.toHaveBeenCalled(); // …but nothing was emitted

    const live = await runRow7Repair(deps(), { target: "review", dryRun: false });
    expect(live.ciGreen).toBe(dry.ciGreen); // dryRun would-settle count == live settle count
    expect(live.emitted).toBe(2);
  });

  it("pending / unreadable CI never emits (honest wait — no false settle)", async () => {
    await insertPrCoordination(db, record("pending"));
    await insertPrCoordination(db, record("unknown"));
    readHeadCi.mockImplementation(async (prUrl: string) => (prUrl.endsWith("pending") ? "pending" : undefined));

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ qualified: 2, ciPending: 1, ciUnknown: 1, ciGreen: 0, emitted: 0 });
    expect(emitCiSignal).not.toHaveBeenCalled();
  });

  it("FIX 1: a SINGLE absent read does NOT settle row 7 on the repair path (uncorroborated → skip)", async () => {
    await insertPrCoordination(db, record("aged"));
    readHeadCi.mockResolvedValue("absent"); // aged-out / not-yet-registered check runs read absent

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ qualified: 1, ciAbsentUnconfirmed: 1, ciGreen: 0, emitted: 0 });
    expect(isAbsentCorroborated).toHaveBeenCalledWith("aged");
    expect(emitCiSignal).not.toHaveBeenCalled();
  });

  it("FIX 1: a CORROBORATED absent (prior journaled ci.signal(absent)) settles — emits ci.signal(absent)", async () => {
    await insertPrCoordination(db, record("noci"));
    readHeadCi.mockResolvedValue("absent");
    isAbsentCorroborated.mockResolvedValue(true); // the #6403 debounce / sweep re-poll already saw absent

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ qualified: 1, ciGreen: 1, ciAbsentUnconfirmed: 0, emitted: 1 });
    expect(emitCiSignal).toHaveBeenCalledTimes(1);
    expect(emitCiSignal).toHaveBeenCalledWith("noci", "absent");
  });

  it("failing CI re-emits ci.signal(failing) (drives ciFix, honest forward progress)", async () => {
    await insertPrCoordination(db, record("red"));
    readHeadCi.mockResolvedValue("failing");

    const report = await runRow7Repair(deps(), { target: "review", dryRun: false });

    expect(report).toMatchObject({ qualified: 1, ciRed: 1, ciGreen: 0, emitted: 1 });
    expect(emitCiSignal).toHaveBeenCalledTimes(1);
    expect(emitCiSignal).toHaveBeenCalledWith("red", "failing");
  });
});

describe("W11-T1 row-7 repair — part 3 (NEEDS_YOU review_stuck)", () => {
  const stuck = (sid: string, overrides: Partial<PrCoordinationRecord> = {}) =>
    record(sid, { state: "NEEDS_YOU", blockedReason: "review_stuck", version: 3, ...overrides });

  it("CAS-reopens a qualifying stuck row to REVIEW, then re-emits the honest ci.signal", async () => {
    await insertPrCoordination(db, stuck("s1"));

    const report = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });

    expect(report).toMatchObject({ enumerated: 1, qualified: 1, ciGreen: 1, reopened: 1, emitted: 1 });
    const rec = await getPrCoordination(db, "s1");
    expect(rec!.state).toBe("REVIEW"); // rebaselined out of the stuck block
    expect(rec!.blockedReason).toBeNull();
    expect(rec!.version).toBe(4); // the reopen CAS bumped it
    expect(emitCiSignal).toHaveBeenCalledTimes(1);
    expect(emitCiSignal).toHaveBeenCalledWith("s1", "green");
  });

  it("FIX 3: the reopen is JOURNALED — the reopened version gets its pr_coordination_events row + telemetry", async () => {
    await insertPrCoordination(db, stuck("s1", { stateEnteredAt: NOW - 60_000 }));

    await runRow7Repair(deps(), { target: "needs_you", dryRun: false });

    // The journal row lands at the exact reopened version (no version gap for the §18/D17 reconstruction),
    // honestly named as the admin repair, with the dwell it spent stuck.
    const log = await listPrCoordinationEvents(db, "s1");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      sessionId: "s1",
      version: 4,
      fromState: "NEEDS_YOU",
      toState: "REVIEW",
      event: "admin.row7_repair_reopen",
      at: NOW,
      actor: "internal",
      dwellMs: 60_000,
    });
    expect(log[0]!.metadata).toMatchObject({
      type: "admin.row7_repair_reopen",
      ciState: "green",
      clearedBlockedReason: "review_stuck",
    });
    // ...and the fsm.transition-shaped telemetry emit fired for the same version.
    expect(emitRepairTelemetry).toHaveBeenCalledTimes(1);
    expect(emitRepairTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "fsm.transition",
        session_id: "s1",
        version: 4,
        from: "NEEDS_YOU",
        to: "REVIEW",
        fsm_event: "admin.row7_repair_reopen",
        dwell_ms: 60_000,
      }),
    );
  });

  it("does not double-count reopened when the journal append fails after CAS", async () => {
    await insertPrCoordination(db, stuck("journal-fail"));
    await appendPrCoordinationEvent(db, {
      sessionId: "journal-fail",
      version: 4,
      fromState: "NEEDS_YOU",
      toState: "REVIEW",
      event: "preexisting",
      at: NOW - 1,
      actor: "internal",
    });

    const report = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });

    expect(report).toMatchObject({ qualified: 1, ciGreen: 1, reopened: 0, emitted: 0, failed: 1 });
    expect((await getPrCoordination(db, "journal-fail"))!.state).toBe("REVIEW");
    expect(emitCiSignal).not.toHaveBeenCalled();
  });

  it("FIX 1: an uncorroborated absent NEVER reopens a stuck row (the aged-parked-stock false green)", async () => {
    await insertPrCoordination(db, stuck("aged"));
    readHeadCi.mockResolvedValue("absent"); // GC'd/aged-out check runs on old stock

    const report = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });

    expect(report).toMatchObject({ qualified: 1, ciAbsentUnconfirmed: 1, reopened: 0, emitted: 0 });
    expect((await getPrCoordination(db, "aged"))!.state).toBe("NEEDS_YOU"); // untouched
    expect(await listPrCoordinationEvents(db, "aged")).toHaveLength(0); // no journal row either
  });

  it("leaves a stuck row with a DIFFERENT block reason untouched (only review_stuck is in scope)", async () => {
    await insertPrCoordination(db, stuck("owner", { blockedReason: "owner_approval" }));

    const report = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });

    expect(report).toMatchObject({ enumerated: 0, reopened: 0, emitted: 0 });
    expect((await getPrCoordination(db, "owner"))!.state).toBe("NEEDS_YOU");
  });

  it("pending CI does NOT reopen (honest evidence does not yet support forward progress)", async () => {
    await insertPrCoordination(db, stuck("s-pend"));
    readHeadCi.mockResolvedValue("pending");

    const report = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });

    expect(report).toMatchObject({ qualified: 1, ciPending: 1, reopened: 0, emitted: 0 });
    expect((await getPrCoordination(db, "s-pend"))!.state).toBe("NEEDS_YOU"); // still stuck, untouched
  });

  it("dryRun reopens/emits nothing; the would-reopen count matches the live run", async () => {
    await insertPrCoordination(db, stuck("d1"));
    await insertPrCoordination(db, stuck("d2"));

    const dry = await runRow7Repair(deps(), { target: "needs_you", dryRun: true });
    expect(dry).toMatchObject({ qualified: 2, ciGreen: 2, reopened: 0, emitted: 0 });
    expect((await getPrCoordination(db, "d1"))!.state).toBe("NEEDS_YOU"); // untouched by the dry run

    const live = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });
    expect(live.ciGreen).toBe(dry.ciGreen);
    expect(live).toMatchObject({ reopened: 2, emitted: 2 });
  });
});

describe("W11-T1 row-7 repair — idempotency", () => {
  it("a second REVIEW pass no longer sees a row that settled out of REVIEW", async () => {
    await insertPrCoordination(db, record("a"));
    const first = await runRow7Repair(deps(), { target: "review", dryRun: false });
    expect(first.emitted).toBe(1);
    // The real ci.signal settles the row to MERGE_READY; the spy emit does not, so simulate that settle.
    const rec = await getPrCoordination(db, "a");
    await casUpdatePrCoordination(db, "a", rec!.version, { state: "MERGE_READY" });

    emitCiSignal.mockClear();
    const second = await runRow7Repair(deps(), { target: "review", dryRun: false });
    expect(second).toMatchObject({ enumerated: 0, qualified: 0, emitted: 0, failed: 0 });
    expect(emitCiSignal).not.toHaveBeenCalled();
  });

  it("a second needs_you pass finds nothing after the first reopened everything", async () => {
    await insertPrCoordination(db, record("s1", { state: "NEEDS_YOU", blockedReason: "review_stuck", version: 3 }));

    const first = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });
    expect(first.reopened).toBe(1);

    emitCiSignal.mockClear();
    const second = await runRow7Repair(deps(), { target: "needs_you", dryRun: false });
    // The row is now REVIEW (reopened), so the needs_you enumerator no longer sees it.
    expect(second).toMatchObject({ enumerated: 0, reopened: 0, emitted: 0, failed: 0 });
    expect(emitCiSignal).not.toHaveBeenCalled();
  });
});
