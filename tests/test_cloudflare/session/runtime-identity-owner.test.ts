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
  await import("../../../apps/control-plane-worker/src/session/sandbox-state-owners/runtime-identity.js");

const { initSchema } = schemaModule;
const { createSession, ensureSandboxState, updateSandboxState, getSandboxState } = doDbModule;
const { refreshLease } = ownerModule;

const SESSION_ID = "s-1";
const ENV_WITHOUT_DB = { DB: null } as unknown as Parameters<typeof refreshLease>[0]["env"];

const runtimeState = {
  runtimeProvider: "e2b" as const,
  runtimeBackend: null,
  runtimeState: "running" as const,
  runtimeSandboxId: "sb-1",
  runtimeTemplateId: null,
  runtimeStateExpiresAt: null,
  runtimeLiveLeaseExpiresAt: 2000,
  runtimePreviewUrl: null,
  runtimeCreatedAt: 100,
  runtimeLastResumedAt: 100,
  runtimeLastPausedAt: null,
  runtimeLastProviderRefreshedAt: null,
  runtimeProviderTtlExpiresAt: null,
};

describe("refreshLease", () => {
  let sql: TransactionCapableSqlStorage;
  let logger: FakeLogger & { info: ReturnType<typeof vi.fn> };
  let waitUntil: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPostStructuredEventToDd.mockClear();
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: SESSION_ID, ownerUserId: "u-1" });
    ensureSandboxState(sql, SESSION_ID);
    updateSandboxState(sql, SESSION_ID, {
      runtimeProvider: "e2b",
      runtimeSandboxId: "sb-1",
      runtimeState: "running",
      runtimeLiveLeaseExpiresAt: 1000,
    });
    logger = { info: vi.fn() } as FakeLogger & { info: ReturnType<typeof vi.fn> };
    waitUntil = vi.fn();
  });

  it("accepts the refresh when sandboxId matches the row", async () => {
    const originalExec = sql.exec.bind(sql);
    let sandboxStateWrites = 0;
    sql.exec = ((query: string, ...params: unknown[]) => {
      if (query.includes("UPDATE sandbox_state SET")) {
        sandboxStateWrites += 1;
      }
      return originalExec(query, ...params);
    }) as typeof sql.exec;

    const result = await refreshLease({
      sql,
      env: ENV_WITHOUT_DB,
      sessionId: SESSION_ID,
      expectedSandboxId: "sb-1",
      runtimeState,
      sandboxState: runtimeState,
    });

    expect(result).toEqual({ accepted: true });
    expect(getSandboxState(sql, SESSION_ID)!.runtimeLiveLeaseExpiresAt).toBe(2000);
    expect(sandboxStateWrites).toBe(1);
  });

  it("skips the sandbox_state write when the refresh patch is unchanged", async () => {
    updateSandboxState(sql, SESSION_ID, runtimeState);
    const originalExec = sql.exec.bind(sql);
    let sandboxStateWrites = 0;
    sql.exec = ((query: string, ...params: unknown[]) => {
      if (query.includes("UPDATE sandbox_state SET")) {
        sandboxStateWrites += 1;
      }
      return originalExec(query, ...params);
    }) as typeof sql.exec;

    const result = await refreshLease({
      sql,
      env: ENV_WITHOUT_DB,
      sessionId: SESSION_ID,
      expectedSandboxId: "sb-1",
      expectedProvider: "e2b",
      runtimeState,
      sandboxState: runtimeState,
    });

    expect(result).toEqual({ accepted: true });
    expect(sandboxStateWrites).toBe(0);
  });

  it("does not skip the write when projection sync is requested", async () => {
    updateSandboxState(sql, SESSION_ID, runtimeState);
    const originalExec = sql.exec.bind(sql);
    let sandboxStateWrites = 0;
    sql.exec = ((query: string, ...params: unknown[]) => {
      if (query.includes("UPDATE sandbox_state SET")) {
        sandboxStateWrites += 1;
      }
      return originalExec(query, ...params);
    }) as typeof sql.exec;

    const result = await refreshLease({
      sql,
      env: ENV_WITHOUT_DB,
      sessionId: SESSION_ID,
      expectedSandboxId: "sb-1",
      expectedProvider: "e2b",
      runtimeState,
      sandboxState: runtimeState,
      syncProjection: true,
    });

    expect(result).toEqual({ accepted: true });
    expect(sandboxStateWrites).toBe(1);
  });

  it("refuses the refresh when sandboxId is stale (different row)", async () => {
    const result = await refreshLease({
      sql,
      env: ENV_WITHOUT_DB,
      sessionId: SESSION_ID,
      expectedSandboxId: "sb-OLD",
      runtimeState,
      sandboxState: runtimeState,
      logger,
      waitUntil,
    });

    expect(result.accepted).toBe(false);
    if (!result.accepted && result.reason === "sandbox_id_mismatch") {
      expect(result.expectedSandboxId).toBe("sb-OLD");
      expect(result.observedSandboxId).toBe("sb-1");
    } else {
      throw new Error("expected sandbox_id_mismatch rejection");
    }
    // The existing row is untouched
    expect(getSandboxState(sql, SESSION_ID)!.runtimeLiveLeaseExpiresAt).toBe(1000);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime_lease_refresh_refused",
        expectedSandboxId: "sb-OLD",
        observedSandboxId: "sb-1",
        reason: "sandbox_id_mismatch",
      }),
      expect.any(String),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      ENV_WITHOUT_DB,
      expect.objectContaining({
        event: "runtime_lease_refresh_refused",
        sessionId: SESSION_ID,
        expectedSandboxId: "sb-OLD",
        observedSandboxId: "sb-1",
        reason: "sandbox_id_mismatch",
      }),
    );
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("refuses when row has null runtimeSandboxId (released)", async () => {
    updateSandboxState(sql, SESSION_ID, { runtimeSandboxId: null });

    const result = await refreshLease({
      sql,
      env: ENV_WITHOUT_DB,
      sessionId: SESSION_ID,
      expectedSandboxId: "sb-1",
      runtimeState,
      sandboxState: runtimeState,
    });

    expect(result.accepted).toBe(false);
  });

  it("refuses with reason='provider_mismatch' when expectedProvider does not match observed provider", async () => {
    updateSandboxState(sql, SESSION_ID, { runtimeProvider: null });

    const result = await refreshLease({
      sql,
      env: ENV_WITHOUT_DB,
      sessionId: SESSION_ID,
      expectedSandboxId: "sb-1",
      expectedProvider: "e2b",
      runtimeState,
      sandboxState: runtimeState,
      logger,
      waitUntil,
    });

    expect(result.accepted).toBe(false);
    if (!result.accepted && result.reason === "provider_mismatch") {
      expect(result.expectedProvider).toBe("e2b");
      expect(result.observedProvider).toBeNull();
    } else {
      throw new Error("expected provider_mismatch rejection");
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime_lease_refresh_refused",
        reason: "provider_mismatch",
        expectedProvider: "e2b",
        observedProvider: null,
      }),
      expect.any(String),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      ENV_WITHOUT_DB,
      expect.objectContaining({
        event: "runtime_lease_refresh_refused",
        sessionId: SESSION_ID,
        reason: "provider_mismatch",
        expectedProvider: "e2b",
        observedProvider: null,
      }),
    );
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
