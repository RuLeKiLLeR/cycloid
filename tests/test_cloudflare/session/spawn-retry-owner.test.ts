import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

type TransactionCapableSqlStorage = SqlStorage & { transactionSync<T>(closure: () => T): T };

function createMockSqlStorage(): TransactionCapableSqlStorage {
  const db = new Database(":memory:");

  function makeCursor(rows: Record<string, unknown>[]): unknown {
    return {
      toArray: () => rows,
      rowsRead: rows.length,
      rowsWritten: 0,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  }
  function makeWriteCursor(rowsWritten: number): unknown {
    return {
      toArray: () => [],
      rowsRead: 0,
      rowsWritten,
      [Symbol.iterator]: () => [][Symbol.iterator](),
    };
  }

  const sql = {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
      if (params.length === 0) {
        if (isSelect) return makeCursor(db.prepare(query).all() as Record<string, unknown>[]);
        db.exec(query);
        return makeWriteCursor(0);
      }
      const stmt = db.prepare(query);
      if (isSelect) return makeCursor(stmt.all(...params) as Record<string, unknown>[]);
      const result = stmt.run(...params);
      return makeWriteCursor(result.changes);
    },
    get databaseSize() {
      return 0;
    },
    transactionSync<T>(closure: () => T): T {
      return db.transaction(closure)();
    },
  };

  return sql as unknown as TransactionCapableSqlStorage;
}

const schemaModule = await import("../../../apps/control-plane-worker/src/session/schema.js");
const doDbModule = await import("../../../apps/control-plane-worker/src/session/do-db.js");
const ownerModule = await import("../../../apps/control-plane-worker/src/session/sandbox-state-owners/spawn-retry.js");

const { initSchema } = schemaModule;
const { createSession, ensureSandboxState, updateSandboxState, getSandboxState } = doDbModule;
const { peekSpawnTimeoutRetryDecision, commitSpawnTimeoutRetryDecision, resetSpawnRetryOnSuccess } = ownerModule;

const SESSION_ID = "s-1";

describe("spawn-retry owner", () => {
  let sql: TransactionCapableSqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: SESSION_ID, ownerUserId: "u-1" });
    ensureSandboxState(sql, SESSION_ID);
  });

  describe("peekSpawnTimeoutRetryDecision", () => {
    it("returns retryCount=0, retryCapReached=false on a fresh row and does not write", () => {
      const decision = peekSpawnTimeoutRetryDecision({ sql, sessionId: SESSION_ID });

      expect(decision).toEqual({ retryCount: 0, retryCapReached: false });
      // No write yet -- peek is pure read.
      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(0);
    });

    it("returns retryCount=1, retryCapReached=false at 1", () => {
      updateSandboxState(sql, SESSION_ID, { spawnRetryCount: 1 });

      const decision = peekSpawnTimeoutRetryDecision({ sql, sessionId: SESSION_ID });

      expect(decision).toEqual({ retryCount: 1, retryCapReached: false });
    });

    it("reports cap reached at retryCount=2 without writing", () => {
      updateSandboxState(sql, SESSION_ID, { spawnRetryCount: 2 });

      const decision = peekSpawnTimeoutRetryDecision({ sql, sessionId: SESSION_ID });

      expect(decision).toEqual({ retryCount: 2, retryCapReached: true });
      // Still 2 -- commit not called.
      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(2);
    });
  });

  describe("commitSpawnTimeoutRetryDecision", () => {
    it("bumps to retryCount+1 in the non-cap branch", () => {
      commitSpawnTimeoutRetryDecision({
        sql,
        sessionId: SESSION_ID,
        decision: { retryCount: 1, retryCapReached: false },
      });

      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(2);
    });

    it("resets to 0 in the cap-reached branch", () => {
      updateSandboxState(sql, SESSION_ID, { spawnRetryCount: 2 });

      commitSpawnTimeoutRetryDecision({
        sql,
        sessionId: SESSION_ID,
        decision: { retryCount: 2, retryCapReached: true },
      });

      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(0);
    });

    it("preserves the counter when the caller never calls commit (defer-on-failure scenario)", () => {
      updateSandboxState(sql, SESSION_ID, { spawnRetryCount: 1 });

      // Caller peeks but never commits (simulates handler crash before commit).
      const decision = peekSpawnTimeoutRetryDecision({ sql, sessionId: SESSION_ID });
      expect(decision).toEqual({ retryCount: 1, retryCapReached: false });

      // No commit -- the next alarm-handler entry reads the unchanged counter.
      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(1);
    });
  });

  describe("resetSpawnRetryOnSuccess", () => {
    it("resets to 0 from non-zero", () => {
      updateSandboxState(sql, SESSION_ID, { spawnRetryCount: 2 });

      resetSpawnRetryOnSuccess({ sql, sessionId: SESSION_ID });

      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(0);
    });

    it("is idempotent at 0", () => {
      resetSpawnRetryOnSuccess({ sql, sessionId: SESSION_ID });
      resetSpawnRetryOnSuccess({ sql, sessionId: SESSION_ID });

      expect(getSandboxState(sql, SESSION_ID)!.spawnRetryCount).toBe(0);
    });
  });
});
