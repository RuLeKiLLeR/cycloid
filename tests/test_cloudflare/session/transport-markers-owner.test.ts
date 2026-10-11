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
const ownerModule =
  await import("../../../apps/control-plane-worker/src/session/sandbox-state-owners/transport-markers.js");

const { initSchema } = schemaModule;
const { createSession, ensureSandboxState, updateSandboxState, getSandboxState } = doDbModule;
const { setDisconnectStartedAt, scheduleAutoCloseAt, clearTransportMarkers } = ownerModule;

const SESSION_ID = "s-1";

describe("transport-markers owner", () => {
  let sql: TransactionCapableSqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: SESSION_ID, ownerUserId: "u-1" });
    ensureSandboxState(sql, SESSION_ID);
  });

  it("setDisconnectStartedAt writes the timestamp without touching auto-close", () => {
    updateSandboxState(sql, SESSION_ID, { autoCloseScheduledAt: 500 });

    setDisconnectStartedAt({ sql, sessionId: SESSION_ID, at: 1700000000000 });

    const state = getSandboxState(sql, SESSION_ID)!;
    expect(state.disconnectStartedAt).toBe(1700000000000);
    expect(state.autoCloseScheduledAt).toBe(500);
  });

  it("setDisconnectStartedAt accepts null to clear the timestamp", () => {
    updateSandboxState(sql, SESSION_ID, { disconnectStartedAt: 999, autoCloseScheduledAt: 500 });

    setDisconnectStartedAt({ sql, sessionId: SESSION_ID, at: null });

    const state = getSandboxState(sql, SESSION_ID)!;
    expect(state.disconnectStartedAt).toBeNull();
    expect(state.autoCloseScheduledAt).toBe(500);
  });

  it("scheduleAutoCloseAt writes the timestamp without touching disconnect", () => {
    updateSandboxState(sql, SESSION_ID, { disconnectStartedAt: 999 });

    scheduleAutoCloseAt({ sql, sessionId: SESSION_ID, at: 1700000000000 });

    const state = getSandboxState(sql, SESSION_ID)!;
    expect(state.autoCloseScheduledAt).toBe(1700000000000);
    expect(state.disconnectStartedAt).toBe(999);
  });

  it("clearTransportMarkers nulls both fields", () => {
    updateSandboxState(sql, SESSION_ID, { disconnectStartedAt: 999, autoCloseScheduledAt: 500 });

    clearTransportMarkers({ sql, sessionId: SESSION_ID });

    const state = getSandboxState(sql, SESSION_ID)!;
    expect(state.disconnectStartedAt).toBeNull();
    expect(state.autoCloseScheduledAt).toBeNull();
  });

  it("clearTransportMarkers is idempotent on already-clear state", () => {
    clearTransportMarkers({ sql, sessionId: SESSION_ID });
    clearTransportMarkers({ sql, sessionId: SESSION_ID });

    const state = getSandboxState(sql, SESSION_ID)!;
    expect(state.disconnectStartedAt).toBeNull();
    expect(state.autoCloseScheduledAt).toBeNull();
  });
});
