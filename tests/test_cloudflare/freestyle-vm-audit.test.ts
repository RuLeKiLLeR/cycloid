import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import type { FreestyleAuditVm } from "../../apps/control-plane-worker/src/sandbox/freestyle-client";
import {
  FREESTYLE_VM_AUDIT_EVENT,
  runFreestyleVmAudit,
} from "../../apps/control-plane-worker/src/sandbox/freestyle-vm-audit";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import {
  insertVmReservation,
  markVmReservationCreated,
  markVmReservationFailed,
} from "../../apps/control-plane-worker/src/sandbox/vm-reservations-db";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

const NOW = 1_800_000_000_000;
const OLD_ISO = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
const FRESH_ISO = new Date(NOW - 60 * 1000).toISOString();
// KILLED_RUNTIME_REAP_GRACE_MS is 1h; a kill timestamp older than this is past
// grace, one newer is within grace.
const PAST_GRACE_AT = NOW - 2 * 60 * 60 * 1000;
const WITHIN_GRACE_AT = NOW - 30 * 60 * 1000;

let sqlite: Database.Database;
let db: D1Database;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    WORKER_ENV: "production",
    FREESTYLE_API_KEY: "fs-key",
    DD_API_KEY: "dd-key",
    ...overrides,
  } as unknown as Env;
}

function vm(id: string, overrides: Partial<FreestyleAuditVm> = {}): FreestyleAuditVm {
  return { id, state: "suspended", createdAt: OLD_ISO, deleted: false, ...overrides };
}

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as NonNullable<
    Parameters<typeof runFreestyleVmAudit>[1]
  >["logger"];
}

async function reserveCreated(reservationId: string, vmId: string) {
  await insertVmReservation(db, {
    reservationId,
    sessionId: `sess-${reservationId}`,
    spawnAttemptId: "attempt-1",
    attempt: 1,
    runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
    vmName: `cycloid-sess-${reservationId}`,
    nowMs: NOW - 3 * 60 * 60 * 1000,
  });
  await markVmReservationCreated(db, { reservationId, runtimeSandboxId: vmId, nowMs: NOW - 3 * 60 * 60 * 1000 });
}

beforeEach(() => {
  mockPostStructuredEventToDd.mockClear();
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0247_runtime_vm_reservations.sql", "utf8"));
  sqlite.exec(`
    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      runtime_provider TEXT,
      runtime_backend TEXT,
      runtime_sandbox_id TEXT,
      runtime_state TEXT,
      runtime_state_expires_at INTEGER,
      updated_at INTEGER
    );
  `);
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("runFreestyleVmAudit", () => {
  it("skips outside production so only one env audits the shared account", async () => {
    const result = await runFreestyleVmAudit(makeEnv({ WORKER_ENV: "qa" } as Partial<Env>), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-1")],
    });
    expect(result.skipped).toBe("not_production");
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });

  it("skips without a Freestyle API key", async () => {
    const result = await runFreestyleVmAudit(makeEnv({ FREESTYLE_API_KEY: undefined } as Partial<Env>), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [],
    });
    expect(result.skipped).toBe("missing_api_key");
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });

  it("flags aged VMs absent from both registry legs and reports them in the sweep event", async () => {
    await reserveCreated("res-1", "vm-known-reserved");
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_sandbox_id) VALUES ('s1','freestyle','vm-known-live')",
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [
        vm("vm-known-reserved"),
        vm("vm-known-live"),
        vm("vm-mystery"), // aged + unknown → flagged
        vm("vm-young", { createdAt: FRESH_ISO }), // young → in-flight spawn, skipped
        vm("vm-gone", { deleted: true }), // deleted → skipped
        vm("vm-no-age", { createdAt: null }), // unknown age + unknown id → flagged
      ],
    });

    expect(result).toMatchObject({
      skipped: null,
      listedTotal: 6,
      activeCount: 5,
      registeredCount: 2,
      unregisteredCount: 2,
      possibleOrphanCount: 0,
    });
    expect(mockPostStructuredEventToDd).toHaveBeenCalledTimes(1);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.event).toBe(FREESTYLE_VM_AUDIT_EVENT);
    expect((event.unregisteredVms as Array<{ id: string }>).map((entry) => entry.id).sort()).toEqual([
      "vm-mystery",
      "vm-no-age",
    ]);
  });

  it("registers a legacy provider-skewed session_index row so its VM is not false-flagged", async () => {
    // Pre-derive skew: a live Freestyle VM whose session_index row still stores
    // runtime_provider='e2b' with runtime_backend='freestyle'. The registry leg
    // must match it on the backend, or the audit reports an owned VM as orphaned.
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id) VALUES ('s-legacy','e2b','freestyle','vm-legacy-live')",
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-legacy-live"), vm("vm-mystery")],
    });

    expect(result).toMatchObject({
      skipped: null,
      registeredCount: 1,
      unregisteredCount: 1,
    });
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((event.unregisteredVms as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["vm-mystery"]);
  });

  it("reports unresolved reservations (possible_orphan + stale pending) with their session handles", async () => {
    await insertVmReservation(db, {
      reservationId: "res-orphan",
      sessionId: "sess-orphan",
      spawnAttemptId: "attempt-9",
      attempt: 2,
      runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
      vmName: "cycloid-sess-orphan-sbx",
      nowMs: NOW - 10 * 60 * 1000,
    });
    await markVmReservationFailed(db, {
      reservationId: "res-orphan",
      outcome: "possible_orphan",
      errorCode: "timeout",
      nowMs: NOW - 10 * 60 * 1000,
    });

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [],
    });

    expect(result.possibleOrphanCount).toBe(1);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.possibleOrphanReservations).toEqual([
      expect.objectContaining({
        sessionId: "sess-orphan",
        vmName: "cycloid-sess-orphan-sbx",
        outcome: "possible_orphan",
        errorCode: "timeout",
      }),
    ]);
  });

  it("classifies a created reservation whose projection moved on as superseded when its VM is live", async () => {
    // 'created' reservation → VM id lives in reservedIds (registered, not
    // unregistered); the session projection has since moved to a different id.
    await reserveCreated("res-sup", "vm-superseded");
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_sandbox_id) VALUES ('sess-res-sup','freestyle','vm-current')",
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-superseded"), vm("vm-current")],
    });

    expect(result.supersededCount).toBe(1);
    expect(result.unregisteredCount).toBe(0);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.supersededVms).toEqual([
      expect.objectContaining({ vmId: "vm-superseded", sessionId: "sess-res-sup" }),
    ]);
  });

  it("does not flag a superseded reservation whose VM is gone from the live account", async () => {
    await reserveCreated("res-sup", "vm-superseded");
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_sandbox_id) VALUES ('sess-res-sup','freestyle','vm-current')",
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-current")], // vm-superseded absent from live list
    });

    expect(result.supersededCount).toBe(0);
  });

  it("classifies a created reservation whose session_index row vanished (LEFT JOIN) as superseded", async () => {
    // No session_index row for the reservation's session at all.
    await reserveCreated("res-sup", "vm-superseded");

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-superseded")],
    });

    expect(result.supersededCount).toBe(1);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.supersededVms).toEqual([
      expect.objectContaining({ vmId: "vm-superseded", sessionId: "sess-res-sup" }),
    ]);
  });

  it("does not flag a young created reservation whose projection has not attached yet", async () => {
    // A sweep can land between markVmReservationCreated and attachRuntime on a
    // healthy spawn: reservation < 30min old, no projection, VM live.
    await insertVmReservation(db, {
      reservationId: "res-young",
      sessionId: "sess-young",
      spawnAttemptId: "attempt-1",
      attempt: 1,
      runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
      vmName: "cycloid-sess-young",
      nowMs: NOW - 10 * 60 * 1000,
    });
    await markVmReservationCreated(db, {
      reservationId: "res-young",
      runtimeSandboxId: "vm-young-spawn",
      nowMs: NOW - 10 * 60 * 1000,
    });

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-young-spawn")],
    });

    expect(result.supersededCount).toBe(0);
  });

  it("flags a killed-state row past the reap grace whose VM is still live", async () => {
    sqlite.exec(
      `INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id, runtime_state, runtime_state_expires_at)
       VALUES ('sk','freestyle','freestyle','vm-killed','killed',${PAST_GRACE_AT})`,
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-killed")],
    });

    expect(result.killedRowCount).toBe(1);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.killedRowVms).toEqual([expect.objectContaining({ vmId: "vm-killed", sessionId: "sk" })]);
  });

  it("does not flag a killed-state row still within the reap grace window", async () => {
    sqlite.exec(
      `INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id, runtime_state, runtime_state_expires_at)
       VALUES ('sk','freestyle','freestyle','vm-killed','killed',${WITHIN_GRACE_AT})`,
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-killed")],
    });

    expect(result.killedRowCount).toBe(0);
  });

  it("classifies a NULL-expiry killed row past grace via updated_at", async () => {
    // A killed-setter that never stamped runtime_state_expires_at must not make
    // the row invisible; the grace falls back to updated_at (mirrors the sweep).
    sqlite.exec(
      `INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id, runtime_state, runtime_state_expires_at, updated_at)
       VALUES ('sk-null','freestyle','freestyle','vm-killed-null','killed',NULL,${PAST_GRACE_AT})`,
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("vm-killed-null")],
    });

    expect(result.killedRowCount).toBe(1);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.killedRowVms).toEqual([
      expect.objectContaining({ vmId: "vm-killed-null", sessionId: "sk-null", runtimeStateExpiresAt: null }),
    ]);
  });

  it("flags nothing when the live account list is empty despite seeded leak rows", async () => {
    // Empty vmIds → both classification DAOs short-circuit without a query.
    await reserveCreated("res-sup", "vm-superseded"); // divergent (no projection)
    sqlite.exec(
      `INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id, runtime_state, runtime_state_expires_at)
       VALUES ('sk','freestyle','freestyle','vm-killed','killed',${PAST_GRACE_AT})`,
    );

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [],
    });

    expect(result.supersededCount).toBe(0);
    expect(result.killedRowCount).toBe(0);
  });

  it("excludes a cross-backend (E2B) created reservation from the superseded classification", async () => {
    await insertVmReservation(db, {
      reservationId: "res-e2b",
      sessionId: "sess-e2b",
      spawnAttemptId: "attempt-1",
      attempt: 1,
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      vmName: "e2b-vm-name",
      nowMs: NOW - 3 * 60 * 60 * 1000,
    });
    await markVmReservationCreated(db, { reservationId: "res-e2b", runtimeSandboxId: "e2b-vm", nowMs: NOW });
    // No session_index row → would be superseded if the backend filter admitted it.

    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [vm("e2b-vm")],
    });

    expect(result.supersededCount).toBe(0);
  });

  it("posts the heartbeat sweep event even when nothing is flagged", async () => {
    const result = await runFreestyleVmAudit(makeEnv(), {
      logger: fakeLogger(),
      nowMs: NOW,
      listVms: async () => [],
    });
    expect(result).toMatchObject({
      unregisteredCount: 0,
      possibleOrphanCount: 0,
      supersededCount: 0,
      killedRowCount: 0,
    });
    expect(mockPostStructuredEventToDd).toHaveBeenCalledTimes(1);
    const [, event] = mockPostStructuredEventToDd.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.supersededCount).toBe(0);
    expect(event.killedRowCount).toBe(0);
  });
});
