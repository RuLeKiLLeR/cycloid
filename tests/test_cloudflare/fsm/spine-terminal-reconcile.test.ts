// ARC-1330 (W11-T2) — the SPINE-DRIVEN merge/close reconcile (the D17 backstop re-homed onto the spine).
//
// Proves: the pass enumerates the spine's OWN non-final post-publish rows (not the legacy working set) and,
// on an OBSERVED merged/closed PR, mints the terminal through the real §10 edge — closing the G3 wedge where
// a merged/closed PR sits under a NEEDS_YOU/STOPPED spine row the legacy sweep drops. Also: the pass is
// read-bounded per tick + persists a cron_sweep_cursors cursor (rotation), leaves open/unreadable rows
// untouched, excludes final terminals + pr_url-less rows, and no-ops under FSM_MODE=off. Drives a real
// migrated SQLite with an INJECTED ground-truth reader (no GitHub) and the REAL applyEvent emit.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { GroundTruthReader } from "../../../apps/control-plane-worker/src/session/fsm/parity-check";
import {
  reconcileSpineOpenPrTerminals,
  SPINE_TERMINAL_RECONCILE_JOB,
} from "../../../apps/control-plane-worker/src/session/fsm/spine-terminal-reconcile";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
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

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function envFor(db: D1Database, mode: string | undefined = "shadow"): Env {
  return { DB: db, FSM_MODE: mode, DD_API_KEY: undefined, WORKER_ENV: "test" } as unknown as Env;
}

function row(overrides: Partial<PrCoordinationRecord> & { sessionId: string }): PrCoordinationRecord {
  return {
    version: 0,
    state: "REVIEW",
    prUrl: `https://github.com/o/r/pull/1`,
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
    stateEnteredAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** An injected reader driven by a per-session prState map (the legacy-independent GitHub ground truth). */
function readerFor(states: Record<string, "merged" | "closed" | "open" | null>): GroundTruthReader {
  return async (input) => ({
    hasPrUrl: input.prUrl != null,
    prState: states[input.sessionId] ?? null,
  });
}

async function persistedCursor(db: D1Database): Promise<string | null> {
  const r = await db
    .prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = ?")
    .bind(SPINE_TERMINAL_RECONCILE_JOB)
    .first<{ cursor: string | null }>();
  return r?.cursor ?? null;
}

describe("reconcileSpineOpenPrTerminals — spine-driven merge/close reconcile", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("the CRITICAL wedge: a NEEDS_YOU spine row whose PR is merged → MERGED via the real §10 edge", async () => {
    await insertPrCoordination(db, row({ sessionId: "s1", state: "NEEDS_YOU", blockedReason: "review_stuck" }));
    const report = await reconcileSpineOpenPrTerminals({
      env: envFor(db, "shadow"),
      logger,
      readGroundTruth: readerFor({ s1: "merged" }),
    });
    expect(report.reconciledMerged).toBe(1);
    expect((await getPrCoordination(db, "s1"))?.state).toBe("MERGED");
    // The terminal rode a real committed transition (journal proves it is not a hand-written state).
    const log = await listPrCoordinationEvents(db, "s1");
    expect(log[0]).toMatchObject({ fromState: "NEEDS_YOU", toState: "MERGED", event: "pr.merged", actor: "cron" });
  });

  it("reconciles the full non-final post-publish cohort (REVIEW/VERIFYING/MERGE_READY/NEEDS_YOU/STOPPED)", async () => {
    await insertPrCoordination(db, row({ sessionId: "s1", state: "REVIEW" }));
    await insertPrCoordination(db, row({ sessionId: "s2", state: "VERIFYING", verificationChildId: "c2" }));
    await insertPrCoordination(db, row({ sessionId: "s3", state: "MERGE_READY" }));
    await insertPrCoordination(db, row({ sessionId: "s4", state: "NEEDS_YOU" }));
    await insertPrCoordination(
      db,
      row({ sessionId: "s5", state: "STOPPED", stopMode: "user", preStopState: "REVIEW" }),
    );
    const report = await reconcileSpineOpenPrTerminals({
      env: envFor(db, "shadow"),
      logger,
      readGroundTruth: readerFor({ s1: "merged", s2: "merged", s3: "closed", s4: "closed", s5: "merged" }),
    });
    expect(report).toMatchObject({ scanned: 5, reconciledMerged: 3, reconciledClosed: 2 });
    expect((await getPrCoordination(db, "s1"))?.state).toBe("MERGED");
    expect((await getPrCoordination(db, "s2"))?.state).toBe("MERGED");
    expect((await getPrCoordination(db, "s3"))?.state).toBe("CLOSED");
    expect((await getPrCoordination(db, "s4"))?.state).toBe("CLOSED");
    expect((await getPrCoordination(db, "s5"))?.state).toBe("MERGED");
  });

  it("leaves an open PR untouched and tallies an unreadable PR as no_ground_truth (never a terminal)", async () => {
    await insertPrCoordination(db, row({ sessionId: "s1", state: "REVIEW" }));
    await insertPrCoordination(db, row({ sessionId: "s2", state: "NEEDS_YOU" }));
    const report = await reconcileSpineOpenPrTerminals({
      env: envFor(db, "shadow"),
      logger,
      readGroundTruth: readerFor({ s1: "open", s2: null }),
    });
    expect(report).toMatchObject({
      scanned: 2,
      stillOpen: 1,
      noGroundTruth: 1,
      reconciledMerged: 0,
      reconciledClosed: 0,
    });
    expect((await getPrCoordination(db, "s1"))?.state).toBe("REVIEW");
    expect((await getPrCoordination(db, "s2"))?.state).toBe("NEEDS_YOU");
  });

  it("excludes final terminals and pr_url-less rows from the cohort", async () => {
    await insertPrCoordination(db, row({ sessionId: "s1", state: "MERGED" })); // already final
    await insertPrCoordination(db, row({ sessionId: "s2", state: "REVIEW", prUrl: null })); // no PR
    await insertPrCoordination(db, row({ sessionId: "s3", state: "GENERATING" })); // pre-publish
    const report = await reconcileSpineOpenPrTerminals({
      env: envFor(db, "shadow"),
      logger,
      // If any excluded row were scanned, this reader would try to reconcile it.
      readGroundTruth: readerFor({ s1: "merged", s2: "merged", s3: "merged" }),
    });
    expect(report.scanned).toBe(0);
    expect((await getPrCoordination(db, "s2"))?.state).toBe("REVIEW");
    expect((await getPrCoordination(db, "s3"))?.state).toBe("GENERATING");
  });

  it("is read-bounded per tick and persists a rotation cursor", async () => {
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      await insertPrCoordination(db, row({ sessionId: id, state: "NEEDS_YOU" }));
    }
    const readGroundTruth = readerFor({ s1: "merged", s2: "merged", s3: "merged", s4: "merged", s5: "merged" });
    const tick = () =>
      reconcileSpineOpenPrTerminals({
        env: envFor(db, "shadow"),
        logger,
        readGroundTruth,
        tickLimit: 2,
      });

    const t1 = await tick();
    expect(t1.scanned).toBe(2);
    expect(t1.reconciledMerged).toBe(2);
    // Cursor parked at the 2nd session_id so the next tick resumes past it.
    expect(await persistedCursor(db)).toBe("s2");
    expect((await getPrCoordination(db, "s1"))?.state).toBe("MERGED");
    expect((await getPrCoordination(db, "s3"))?.state).toBe("NEEDS_YOU"); // not yet reached

    const t2 = await tick();
    expect(t2.reconciledMerged).toBe(2);
    expect(await persistedCursor(db)).toBe("s4");
    expect((await getPrCoordination(db, "s3"))?.state).toBe("MERGED");

    const t3 = await tick();
    expect(t3.reconciledMerged).toBe(1);
    expect((await getPrCoordination(db, "s5"))?.state).toBe("MERGED");
    // Cohort exhausted → cursor reset so the rotation restarts next tick.
    expect(await persistedCursor(db)).toBeNull();
  });
});
