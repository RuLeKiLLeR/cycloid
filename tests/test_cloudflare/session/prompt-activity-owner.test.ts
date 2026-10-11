import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

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

type FakeLogger = { info: (payload: Record<string, unknown>, message: string) => void };

const schemaModule = await import("../../../apps/control-plane-worker/src/session/schema.js");
const doDbModule = await import("../../../apps/control-plane-worker/src/session/do-db.js");
const ownerModule =
  await import("../../../apps/control-plane-worker/src/session/sandbox-state-owners/prompt-activity.js");

const helpersModule = await import("./helpers.ts");
const { setActivePromptIdViaPromptRow } = helpersModule;

const { initSchema } = schemaModule;
const { createSession, ensureSandboxState, getSandboxState } = doDbModule;

const { clearPromptActivityForPrompt, clearPromptActivityOnSessionClose, recordPromptActivityForCurrentActive } =
  ownerModule;

const SESSION_ID = "s-1";
const ACTIVE_PROMPT_ID = "p-active";
const OTHER_PROMPT_ID = "p-other";
const ENV = { DD_API_KEY: "test-dd-key", WORKER_ENV: "test" };

describe("prompt-activity owner", () => {
  let sql: TransactionCapableSqlStorage;
  let logger: FakeLogger & { info: ReturnType<typeof vi.fn> };
  let waitUntil: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPostStructuredEventToDd.mockClear();
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: SESSION_ID, ownerUserId: "u-1" });
    ensureSandboxState(sql, SESSION_ID);
    setActivePromptIdViaPromptRow(sql, SESSION_ID, ACTIVE_PROMPT_ID);
    logger = { info: vi.fn() } as FakeLogger & { info: ReturnType<typeof vi.fn> };
    waitUntil = vi.fn();
  });

  describe("clearPromptActivityForPrompt", () => {
    it("clears timestamp when expectedPromptId matches", () => {
      // seed an existing activity timestamp
      sql.exec("UPDATE sandbox_state SET prompt_last_activity_at = ? WHERE session_id = ?", 999, SESSION_ID);

      const result = clearPromptActivityForPrompt({
        sql,
        env: ENV,
        sessionId: SESSION_ID,
        expectedPromptId: ACTIVE_PROMPT_ID,
        logger,
        waitUntil,
      });

      expect(result).toEqual({ accepted: true });
      expect(getSandboxState(sql, SESSION_ID)!.promptLastActivityAt).toBeNull();
    });

    it("refuses and logs when expectedPromptId is stale", () => {
      sql.exec("UPDATE sandbox_state SET prompt_last_activity_at = ? WHERE session_id = ?", 999, SESSION_ID);
      setActivePromptIdViaPromptRow(sql, SESSION_ID, OTHER_PROMPT_ID);

      const result = clearPromptActivityForPrompt({
        sql,
        env: ENV,
        sessionId: SESSION_ID,
        expectedPromptId: ACTIVE_PROMPT_ID,
        logger,
        waitUntil,
      });

      expect(result).toEqual({ accepted: false, reason: "stale_prompt_id" });
      // existing timestamp is preserved
      expect(getSandboxState(sql, SESSION_ID)!.promptLastActivityAt).toBe(999);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "prompt_activity_refused_clear" }),
        expect.any(String),
      );
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        ENV,
        expect.objectContaining({
          event: "prompt_activity_refused_clear",
          sessionId: SESSION_ID,
          expectedPromptId: ACTIVE_PROMPT_ID,
          observedActivePromptId: OTHER_PROMPT_ID,
          reason: "stale_prompt_id",
        }),
      );
      expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    });
  });

  describe("recordPromptActivityForCurrentActive", () => {
    it("records activity for the currently-active prompt without requiring a captured id", () => {
      const result = recordPromptActivityForCurrentActive({
        sql,
        sessionId: SESSION_ID,
        at: 1700000000000,
      });

      expect(result).toEqual({ accepted: true });
      expect(getSandboxState(sql, SESSION_ID)!.promptLastActivityAt).toBe(1700000000000);
    });

    it("no-ops when no active prompt is set", () => {
      setActivePromptIdViaPromptRow(sql, SESSION_ID, null);

      const result = recordPromptActivityForCurrentActive({
        sql,
        sessionId: SESSION_ID,
        at: 1700000000000,
      });

      expect(result.accepted).toBe(false);
      expect(getSandboxState(sql, SESSION_ID)!.promptLastActivityAt).toBeNull();
    });

    it("attributes activity to whichever prompt is now active (handles mid-handler swaps)", () => {
      // Simulate handler captured 'p-old' but D1 has since shifted to a new active.
      setActivePromptIdViaPromptRow(sql, SESSION_ID, "p-new");

      const result = recordPromptActivityForCurrentActive({
        sql,
        sessionId: SESSION_ID,
        at: 1700000000000,
      });

      expect(result).toEqual({ accepted: true });
      // Activity is recorded against the current active row -- no stale-id refusal.
      expect(getSandboxState(sql, SESSION_ID)!.promptLastActivityAt).toBe(1700000000000);
    });
  });

  describe("clearPromptActivityOnSessionClose", () => {
    it("clears timestamp unconditionally (no prompt-id guard)", () => {
      sql.exec("UPDATE sandbox_state SET prompt_last_activity_at = ? WHERE session_id = ?", 999, SESSION_ID);
      // even with a stale active-prompt assumption, session-close clear must succeed
      setActivePromptIdViaPromptRow(sql, SESSION_ID, null);

      clearPromptActivityOnSessionClose({ sql, sessionId: SESSION_ID });

      expect(getSandboxState(sql, SESSION_ID)!.promptLastActivityAt).toBeNull();
    });
  });
});
