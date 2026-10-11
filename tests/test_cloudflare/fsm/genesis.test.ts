// ARC-1330 (PR 35) — `pr_coordination` ROW GENESIS at `CREATED`.
//
// Proves "row exists from genesis": `insertGenesisRecord` stamps the `CREATED` shell row against a real
// migrated D1, the FSM_MODE kill-switch suppresses it (`off`), and a re-run is idempotent (the
// session-create funnel can retry with the same `sessionId`). `buildGenesisRecord` is the pure shape.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { buildGenesisRecord, insertGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import { getPrCoordination } from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
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

const NOW = 1_700_000_000_000;

describe("fsm genesis: buildGenesisRecord", () => {
  it("builds a CREATED shell: version 0, all nullables null, counters 0, dwell anchor armed", () => {
    expect(buildGenesisRecord("sess-1", NOW)).toEqual({
      sessionId: "sess-1",
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
      codeChangedSinceVerification: false,
      promptIntendsChange: null,
      mergeReadyReopenCount: 0,
      blockedReason: null,
      failureReason: null,
      stopMode: null,
      preStopState: null,
      updateBranchQueuedAt: null,
      deadlineAt: null,
      stateEnteredAt: NOW,
    });
  });
});

describe("fsm genesis: insertGenesisRecord", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("inserts the CREATED row in shadow mode (row exists from genesis)", async () => {
    const outcome = await insertGenesisRecord({ db, now: () => NOW }, "sess-1");
    expect(outcome).toBe("inserted");
    const got = await getPrCoordination(db, "sess-1");
    expect(got).not.toBeNull();
    expect(got!.state).toBe("CREATED");
    expect(got!.version).toBe(0);
    expect(got!.stateEnteredAt).toBe(NOW);
  });

  it("inserts the CREATED row in live mode too", async () => {
    expect(await insertGenesisRecord({ db, now: () => NOW }, "sess-1")).toBe("inserted");
    expect((await getPrCoordination(db, "sess-1"))!.state).toBe("CREATED");
  });

  it("is idempotent: a re-run leaves the existing row untouched and does not throw", async () => {
    await insertGenesisRecord({ db, now: () => NOW }, "sess-1");
    // A later transition advanced the row; a genesis retry must not clobber it back to CREATED.
    const { casUpdatePrCoordination } =
      await import("../../../apps/control-plane-worker/src/session/pr-coordination-db");
    await casUpdatePrCoordination(db, "sess-1", 0, { state: "PROVISIONING" });

    const outcome = await insertGenesisRecord({ db, now: () => NOW + 5 }, "sess-1");
    expect(outcome).toBe("exists");
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.state).toBe("PROVISIONING");
    expect(got!.version).toBe(1);
  });
});
