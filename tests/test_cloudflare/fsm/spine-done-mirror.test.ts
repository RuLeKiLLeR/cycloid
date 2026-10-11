import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { resolveSpineDoneMirror } from "../../../apps/control-plane-worker/src/session/fsm/spine-done-mirror";
import {
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
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

function record(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: "sess-1",
    version: 0,
    state: "REVIEW",
    prUrl: "https://github.com/acme/web/pull/7",
    headSha: "abc123",
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: true,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: null,
    ...overrides,
  };
}

describe("resolveSpineDoneMirror", () => {
  it("falls back when DB or the spine row is unavailable", async () => {
    const db = asD1(createMigratedSqlite());
    const fallback = {
      cycloidDone: { state: "working", outcome: null, reasons: [] },
      reviewLoopDoneState: null,
      uiLifecycleStage: null,
    };
    const timing = { durationMs: 0, outcome: "success" as "success" | "fallback" };

    expect(await resolveSpineDoneMirror(null, "sess-1")).toEqual(fallback);
    expect(await resolveSpineDoneMirror(db, "missing", timing)).toEqual(fallback);
    expect(timing.outcome).toBe("fallback");
  });

  it("falls back when the spine row state is not in the FSM domain", async () => {
    const db = asD1(createMigratedSqlite());
    const timing = { durationMs: 0, outcome: "success" as "success" | "fallback" };
    await expect(insertPrCoordination(db, record({ state: "NOT_A_STATE" }))).resolves.toBeUndefined();

    await expect(resolveSpineDoneMirror(db, "sess-1", timing)).resolves.toEqual({
      cycloidDone: { state: "working", outcome: null, reasons: [] },
      reviewLoopDoneState: null,
      uiLifecycleStage: null,
    });
    expect(timing.outcome).toBe("fallback");
  });

  it("projects merge-ready without requiring a review-listening flag", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(db, record({ state: "MERGE_READY" }));

    await expect(resolveSpineDoneMirror(db, "sess-1")).resolves.toEqual({
      cycloidDone: { state: "done", outcome: "success", reasons: [] },
      reviewLoopDoneState: "done",
      uiLifecycleStage: "merge_ready",
    });
  });

  it("projects terminal needs-attention done-state from the spine", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(db, record({ state: "NEEDS_YOU", blockedReason: "ci_fix_exhausted" }));

    await expect(resolveSpineDoneMirror(db, "sess-1")).resolves.toEqual({
      cycloidDone: { state: "done", outcome: "needs_attention", reasons: ["ci_red"] },
      reviewLoopDoneState: "done",
      uiLifecycleStage: null,
    });
  });

  it("projects verifying lifecycle stage from the same spine row", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(db, record({ state: "VERIFYING" }));

    await expect(resolveSpineDoneMirror(db, "sess-1")).resolves.toEqual({
      cycloidDone: { state: "working", outcome: null, reasons: [] },
      reviewLoopDoneState: "done",
      uiLifecycleStage: "verifying",
    });
  });
});
