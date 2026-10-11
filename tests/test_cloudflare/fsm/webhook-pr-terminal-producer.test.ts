// ARC-1330 (W11-T2) — the WEBHOOK PR-terminal producer + the generic actor-parameterized emit.
//
// Proves the `pull_request.closed` webhook producer (`emitWebhookPrTerminal`) reuses the ONE terminal
// mapping and lands the same §10 POST_PUBLISH edge as the cron poll, tagged with the `webhook` actor — in
// BOTH shadow and live modes — and that a re-delivered emit on an already-terminal row is an idempotent
// no-op (FINAL_TERMINAL_STATES leave `pr.merged` unhandled). Drives a real migrated SQLite (the Wave-1 DAO
// idiom), so the CAS write + event journal are exercised end to end without a Session DO.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  emitObservedPrTerminal,
  emitWebhookPrTerminal,
} from "../../../apps/control-plane-worker/src/session/fsm/cron-producer";
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

const SID = "sess-webhook";

function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "REVIEW",
    prUrl: "https://github.com/o/r/pull/1",
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

function envFor(db: D1Database, mode: string | undefined = "shadow"): Env {
  return { DB: db, FSM_MODE: mode, DD_API_KEY: undefined, WORKER_ENV: "test" } as unknown as Env;
}

describe("emitWebhookPrTerminal — the pull_request.closed webhook producer", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("shadow: a webhook-observed merge advances REVIEW → MERGED, journaled to the `webhook` actor", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    await emitWebhookPrTerminal(envFor(db, "shadow"), SID, "merged");
    expect((await getPrCoordination(db, SID))?.state).toBe("MERGED");
    const log = await listPrCoordinationEvents(db, SID);
    expect(log.map((e) => e.event)).toEqual(["pr.merged"]);
    expect(log[0]).toMatchObject({ fromState: "REVIEW", toState: "MERGED", actor: "webhook" });
  });

  it("live: a webhook-observed merge still advances REVIEW → MERGED (fires in mode ∈ {shadow, live})", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    await emitWebhookPrTerminal(envFor(db, "live"), SID, "merged");
    expect((await getPrCoordination(db, SID))?.state).toBe("MERGED");
    const log = await listPrCoordinationEvents(db, SID);
    expect(log[0]).toMatchObject({ toState: "MERGED", actor: "webhook" });
  });

  it("the CRITICAL wedge: a webhook-observed merge on a NEEDS_YOU PR advances NEEDS_YOU → MERGED", async () => {
    // The exact G3 divergence signature: spine wedged in NEEDS_YOU while the PR is merged. The webhook the
    // legacy handler ignored now delivers the terminal — no manual re-emit needed.
    await insertPrCoordination(db, buildRecord({ state: "NEEDS_YOU", blockedReason: "review_stuck" }));
    await emitWebhookPrTerminal(envFor(db, "live"), SID, "merged");
    expect((await getPrCoordination(db, SID))?.state).toBe("MERGED");
  });

  it("a webhook-observed close advances STOPPED → CLOSED", async () => {
    await insertPrCoordination(db, buildRecord({ state: "STOPPED", stopMode: "user", preStopState: "REVIEW" }));
    await emitWebhookPrTerminal(envFor(db, "shadow"), SID, "closed");
    expect((await getPrCoordination(db, SID))?.state).toBe("CLOSED");
  });

  it("double-emit no-op: a re-delivered webhook on an already-MERGED row never moves it (idempotent)", async () => {
    await insertPrCoordination(db, buildRecord({ state: "MERGED" }));
    await emitWebhookPrTerminal(envFor(db, "live"), SID, "merged");
    expect((await getPrCoordination(db, SID))?.state).toBe("MERGED");
    // Unhandled in a final terminal → no committed transition → no journal row.
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });
});

describe("emitObservedPrTerminal — the shared generic emit (actor-parameterized)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("returns the ApplyEventResult so callers can count a handled transition vs a no-op", async () => {
    await insertPrCoordination(db, buildRecord({ state: "NEEDS_YOU" }));
    const handled = await emitObservedPrTerminal(envFor(db, "shadow"), SID, "merged", "internal");
    expect(handled).toMatchObject({ outcome: "handled", from: "NEEDS_YOU", to: "MERGED" });
    // A second emit on the now-final row is unhandled (idempotent) — the reconcile counts this as skipped.
    const noop = await emitObservedPrTerminal(envFor(db, "shadow"), SID, "merged", "internal");
    expect(noop?.outcome).toBe("unhandled");
  });

  it("unbound-D1 returns null (the emit never ran)", async () => {
    const noDbEnv = {} as unknown as Env;
    expect(await emitObservedPrTerminal(noDbEnv, SID, "merged", "cron")).toBeNull();
  });
});
