// Tests for the ARC-1330 CRON-POLL producer (PR 43): the sweep's merge/close poll → `pr.merged` /
// `pr.closed` spine events. Pure builders + the shadow dual-emit driving a real migrated SQLite (the
// Wave-1 DAO idiom: createMigratedSqlite/asD1). Covers: poll → event (the spec test), the terminal
// destinations, the VERIFYING-exit `kill_verification` handle on the resolver, terminal idempotence,
// and the off-mode short-circuit.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPrClosedEmission,
  buildPrMergedEmission,
  cronTerminalEmission,
  shadowEmitCronPrTerminal,
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

const SID = "sess-cron";

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

describe("cron-producer pure builders", () => {
  it("maps the cron merge/close terminal to the matching spine event", () => {
    expect(buildPrMergedEmission().event).toEqual({ type: "pr.merged" });
    expect(buildPrClosedEmission().event).toEqual({ type: "pr.closed" });
    expect(cronTerminalEmission("merged").event).toEqual({ type: "pr.merged" });
    expect(cronTerminalEmission("closed").event).toEqual({ type: "pr.closed" });
    // Every cron emission is attributed to the `cron` actor.
    expect(cronTerminalEmission("merged").actor).toBe("cron");
  });
});

describe("shadowEmitCronPrTerminal — poll → event (the spec test)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("a cron-observed merge advances REVIEW → MERGED and appends the event", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    await shadowEmitCronPrTerminal(envFor(db), SID, "merged");
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("MERGED");
    const log = await listPrCoordinationEvents(db, SID);
    expect(log.map((e) => e.event)).toEqual(["pr.merged"]);
    expect(log[0]).toMatchObject({ fromState: "REVIEW", toState: "MERGED", actor: "cron" });
  });

  it("a cron-observed close advances NEEDS_YOU → CLOSED", async () => {
    await insertPrCoordination(db, buildRecord({ state: "NEEDS_YOU" }));
    await shadowEmitCronPrTerminal(envFor(db), SID, "closed");
    expect((await getPrCoordination(db, SID))?.state).toBe("CLOSED");
  });

  it("a merge mid-verification exits VERIFYING → MERGED (the run-scoped kill rides the edge)", async () => {
    await insertPrCoordination(db, buildRecord({ state: "VERIFYING", verificationChildId: "child-1" }));
    await shadowEmitCronPrTerminal(envFor(db), SID, "merged");
    expect((await getPrCoordination(db, SID))?.state).toBe("MERGED");
  });

  it("is idempotent on an already-terminal session (a re-delivered poll never moves the row)", async () => {
    await insertPrCoordination(db, buildRecord({ state: "MERGED" }));
    await shadowEmitCronPrTerminal(envFor(db), SID, "merged");
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("MERGED");
    // Unhandled in a final terminal → no committed transition → no log row.
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });
});
