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

const { initSchema } = schemaModule;
const {
  casUpsertPlatformLlmPromptStatus,
  casDisarmLifecycleWatchdog,
  upsertPlatformLlmPromptStatus,
  getPlatformLlmPromptStatus,
} = doDbModule;

const SESSION_ID = "s-1";
const PROMPT_ID = "p-1";

describe("casUpsertPlatformLlmPromptStatus", () => {
  let sql: TransactionCapableSqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
  });

  it("accepts the write when the row is new and 'new' is expected", () => {
    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "executing",
      updatedAt: 1000,
      expectedPriorStatuses: "new",
    });

    expect(result).toEqual({ accepted: true });
    expect(getPlatformLlmPromptStatus(sql, PROMPT_ID)!.status).toBe("executing");
  });

  it("refuses the write when an existing row is present but 'new' is expected", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "executing",
      updatedAt: 500,
    });

    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "executing",
      updatedAt: 1000,
      expectedPriorStatuses: "new",
    });

    expect(result).toEqual({ accepted: false, reason: "stale_prior", observedStatus: "executing" });
    expect(getPlatformLlmPromptStatus(sql, PROMPT_ID)!.updatedAt).toBe(500);
  });

  it("accepts the transition when prior matches the expected set", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "executing",
      updatedAt: 500,
    });

    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 1000,
      startedAt: 1000,
      expectedPriorStatuses: ["executing"],
    });

    expect(result).toEqual({ accepted: true });
    const row = getPlatformLlmPromptStatus(sql, PROMPT_ID)!;
    expect(row.status).toBe("post_execution_pending");
    expect(row.startedAt).toBe(1000);
  });

  it("accepts a new-row insert when allowNewRow is true and the expected priors are non-empty", () => {
    // Skip-executing path: no executing row was ever written, but a later
    // transition (e.g. terminal) still needs to land. allowNewRow lets it
    // through with a single read.
    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "terminal",
      updatedAt: 1000,
      expectedPriorStatuses: ["executing", "post_execution_pending"],
      allowNewRow: true,
    });

    expect(result).toEqual({ accepted: true });
    expect(getPlatformLlmPromptStatus(sql, PROMPT_ID)!.status).toBe("terminal");
  });

  it("rejects a missing row when allowNewRow is unset", () => {
    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 1000,
      startedAt: 1000,
      expectedPriorStatuses: ["executing"],
    });

    expect(result).toEqual({ accepted: false, reason: "stale_prior", observedStatus: null });
  });

  it("rejects terminal → executing (the core alarm-incident bug class)", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "terminal",
      updatedAt: 500,
    });

    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "executing",
      updatedAt: 1000,
      expectedPriorStatuses: "new",
    });

    expect(result).toEqual({ accepted: false, reason: "stale_prior", observedStatus: "terminal" });
    expect(getPlatformLlmPromptStatus(sql, PROMPT_ID)!.status).toBe("terminal");
  });

  it("rejects a late post_execution_pending re-arm after terminal", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "terminal",
      updatedAt: 500,
      startedAt: null,
    });

    const result = casUpsertPlatformLlmPromptStatus(sql, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 1000,
      startedAt: 1000,
      expectedPriorStatuses: ["executing"],
    });

    expect(result).toEqual({ accepted: false, reason: "stale_prior", observedStatus: "terminal" });
    const row = getPlatformLlmPromptStatus(sql, PROMPT_ID)!;
    expect(row.status).toBe("terminal");
    expect(row.startedAt).toBeNull();
  });
});

describe("casDisarmLifecycleWatchdog", () => {
  let sql: TransactionCapableSqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
  });

  it("clears started_at on non-terminal rows for the session", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 500,
      startedAt: 1000,
    });

    const { clearedCount } = casDisarmLifecycleWatchdog(sql, { sessionId: SESSION_ID, updatedAt: 2000 });

    expect(clearedCount).toBe(1);
    const row = getPlatformLlmPromptStatus(sql, "p-1")!;
    expect(row.startedAt).toBeNull();
    expect(row.updatedAt).toBe(2000);
  });

  it("does not clear started_at on terminal rows (prevents post-execution overwrite race)", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      status: "terminal",
      updatedAt: 500,
      startedAt: 1000,
    });

    const { clearedCount } = casDisarmLifecycleWatchdog(sql, { sessionId: SESSION_ID, updatedAt: 2000 });

    expect(clearedCount).toBe(0);
    const row = getPlatformLlmPromptStatus(sql, "p-1")!;
    expect(row.startedAt).toBe(1000);
  });

  it("clears across multiple non-terminal rows for the session", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 500,
      startedAt: 1000,
    });
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-2",
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 600,
      startedAt: 1500,
    });

    const { clearedCount } = casDisarmLifecycleWatchdog(sql, { sessionId: SESSION_ID, updatedAt: 2000 });

    expect(clearedCount).toBe(2);
  });

  it("does not touch rows from other sessions", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      status: "post_execution_pending",
      updatedAt: 500,
      startedAt: 1000,
    });
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-other",
      sessionId: "s-other",
      status: "post_execution_pending",
      updatedAt: 500,
      startedAt: 1000,
    });

    const { clearedCount } = casDisarmLifecycleWatchdog(sql, { sessionId: SESSION_ID, updatedAt: 2000 });

    expect(clearedCount).toBe(1);
    expect(getPlatformLlmPromptStatus(sql, "p-other")!.startedAt).toBe(1000);
  });
});
