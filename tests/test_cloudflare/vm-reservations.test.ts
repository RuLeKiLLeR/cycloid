import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { E2BSandboxRuntimeError } from "../../apps/control-plane-worker/src/sandbox/e2b-client";
import { FREESTYLE_RUNTIME_BACKEND } from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import {
  classifyCreateFailureOutcome,
  createSandboxWithReservationTrace,
} from "../../apps/control-plane-worker/src/sandbox/vm-reservations";
import { SqliteD1 } from "./sqlite-d1-helper";

const fakeLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof createSandboxWithReservationTrace
>[0]["logger"];

const CREATE_RESULT = {
  runtimeProvider: "freestyle" as const,
  runtimeSandboxId: "vm-123",
  runtimeTemplateId: "sh-snap",
  status: "running" as const,
  createdAt: 1,
  createDurationMs: 1,
};

const CONTEXT = {
  sessionId: "sess-1",
  spawnAttemptId: "attempt-1",
  attempt: 1,
  runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
  vmName: "cycloid-sess-1-sbx-1",
  operation: "spawn",
};

describe("classifyCreateFailureOutcome", () => {
  it.each(["timeout", "network", "unknown", "killed"] as const)(
    "classifies ambiguous runtime code %s as possible_orphan",
    (code) => {
      const err = new E2BSandboxRuntimeError("boom", { code, requestSent: true });
      expect(classifyCreateFailureOutcome(err)).toEqual({ outcome: "possible_orphan", errorCode: code });
    },
  );

  it.each([
    "missing_config",
    "auth",
    "quota",
    "rate_limit",
    "missing_template",
    "missing_sandbox",
    "network_policy",
  ] as const)("classifies provably-rejected code %s as failed", (code) => {
    const err = new E2BSandboxRuntimeError("boom", { code, requestSent: true });
    expect(classifyCreateFailureOutcome(err)).toEqual({ outcome: "failed", errorCode: code });
  });

  it("classifies requestSent=false as failed regardless of code", () => {
    const err = new E2BSandboxRuntimeError("boom", { code: "timeout", requestSent: false });
    expect(classifyCreateFailureOutcome(err)).toEqual({ outcome: "failed", errorCode: "timeout" });
  });

  it("classifies a non-runtime error as possible_orphan (server outcome unknowable)", () => {
    expect(classifyCreateFailureOutcome(new Error("socket hang up"))).toEqual({
      outcome: "possible_orphan",
      errorCode: null,
    });
  });
});

describe("createSandboxWithReservationTrace", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0247_runtime_vm_reservations.sql", "utf8"));
    db = new SqliteD1(sqlite) as unknown as D1Database;
  });

  function reservationRows() {
    return sqlite
      .prepare("SELECT session_id, outcome, runtime_sandbox_id, error_code FROM runtime_vm_reservations")
      .all() as Array<{
      session_id: string;
      outcome: string;
      runtime_sandbox_id: string | null;
      error_code: string | null;
    }>;
  }

  it("resolves the pre-create row to created with the VM id on success", async () => {
    const result = await createSandboxWithReservationTrace({
      db,
      create: async () => CREATE_RESULT,
      context: CONTEXT,
      logger: fakeLogger,
    });
    expect(result).toBe(CREATE_RESULT);
    expect(reservationRows()).toEqual([
      { session_id: "sess-1", outcome: "created", runtime_sandbox_id: "vm-123", error_code: null },
    ]);
  });

  it("marks possible_orphan and fires the event hook when create fails ambiguously", async () => {
    const onPossibleOrphan = vi.fn();
    await expect(
      createSandboxWithReservationTrace({
        db,
        create: async () => {
          throw new E2BSandboxRuntimeError("lost response", { code: "timeout", requestSent: true });
        },
        context: CONTEXT,
        logger: fakeLogger,
        onPossibleOrphan,
      }),
    ).rejects.toThrow("lost response");
    expect(reservationRows()).toEqual([
      { session_id: "sess-1", outcome: "possible_orphan", runtime_sandbox_id: null, error_code: "timeout" },
    ]);
    expect(onPossibleOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", errorCode: "timeout", vmName: "cycloid-sess-1-sbx-1" }),
    );
  });

  it("marks failed without firing the hook when the provider provably rejected the create", async () => {
    const onPossibleOrphan = vi.fn();
    await expect(
      createSandboxWithReservationTrace({
        db,
        create: async () => {
          throw new E2BSandboxRuntimeError("no key", { code: "auth", requestSent: true });
        },
        context: CONTEXT,
        logger: fakeLogger,
        onPossibleOrphan,
      }),
    ).rejects.toThrow("no key");
    expect(reservationRows()).toEqual([
      { session_id: "sess-1", outcome: "failed", runtime_sandbox_id: null, error_code: "auth" },
    ]);
    expect(onPossibleOrphan).not.toHaveBeenCalled();
  });

  it("still resolves the row when the insert reports changes=0 (retried committed insert)", async () => {
    // D1_RETRY_SAFE contract: a transient retry of a COMMITTED insert re-runs
    // the statement, hits ON CONFLICT DO NOTHING, and reports changes=0 even
    // though the row exists. Simulate by executing the insert for real but
    // reporting zero changes — the resolve CAS must still fire.
    const inner = new SqliteD1(sqlite);
    const zeroChangesOnInsertDb = {
      prepare(query: string) {
        const statement = inner.prepare(query);
        if (!query.includes("INSERT INTO runtime_vm_reservations")) return statement;
        return {
          bind: (...values: unknown[]) => {
            statement.bind(...values);
            return {
              run: async () => {
                await statement.run();
                return { success: true, meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const result = await createSandboxWithReservationTrace({
      db: zeroChangesOnInsertDb,
      create: async () => CREATE_RESULT,
      context: CONTEXT,
      logger: fakeLogger,
    });
    expect(result).toBe(CREATE_RESULT);
    expect(reservationRows()).toEqual([
      { session_id: "sess-1", outcome: "created", runtime_sandbox_id: "vm-123", error_code: null },
    ]);
  });

  it("never fails or blocks the create when D1 writes throw", async () => {
    const brokenDb = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    const result = await createSandboxWithReservationTrace({
      db: brokenDb,
      create: async () => CREATE_RESULT,
      context: CONTEXT,
      logger: fakeLogger,
    });
    expect(result).toBe(CREATE_RESULT);
  });

  it("passes through untraced when the DB binding is absent", async () => {
    const result = await createSandboxWithReservationTrace({
      db: undefined,
      create: async () => CREATE_RESULT,
      context: CONTEXT,
      logger: fakeLogger,
    });
    expect(result).toBe(CREATE_RESULT);
  });
});
