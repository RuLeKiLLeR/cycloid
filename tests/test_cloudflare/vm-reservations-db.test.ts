import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import {
  insertVmReservation,
  listKilledRowVms,
  listReservedVmIdsForBackend,
  listSessionIndexVmIdsForBackend,
  listSupersededCreatedReservations,
  listUnresolvedFreestyleReservations,
  markVmReservationCreated,
  markVmReservationFailed,
} from "../../apps/control-plane-worker/src/sandbox/vm-reservations-db";
import { SqliteD1 } from "./sqlite-d1-helper";

let sqlite: Database.Database;
let db: D1Database;

const NOW = 1_800_000_000_000;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0247_runtime_vm_reservations.sql", "utf8"));
  // Subset of session_index the registry belt-and-braces query touches.
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

function baseParams(overrides: Partial<Parameters<typeof insertVmReservation>[1]> = {}) {
  return {
    reservationId: "res-1",
    sessionId: "sess-1",
    spawnAttemptId: "attempt-1",
    attempt: 1,
    runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
    vmName: "cycloid-sess-1-sbx-1",
    nowMs: NOW,
    ...overrides,
  };
}

describe("runtime_vm_reservations DAO", () => {
  it("inserts a pending row and is idempotent on the reservation id", async () => {
    expect(await insertVmReservation(db, baseParams())).toBe(true);
    expect(await insertVmReservation(db, baseParams())).toBe(false);
    const row = sqlite.prepare("SELECT * FROM runtime_vm_reservations WHERE reservation_id = 'res-1'").get() as {
      outcome: string;
      runtime_sandbox_id: string | null;
      vm_name: string;
    };
    expect(row.outcome).toBe("pending");
    expect(row.runtime_sandbox_id).toBeNull();
    expect(row.vm_name).toBe("cycloid-sess-1-sbx-1");
  });

  it("CAS-resolves pending to created with the VM id, once", async () => {
    await insertVmReservation(db, baseParams());
    expect(
      await markVmReservationCreated(db, { reservationId: "res-1", runtimeSandboxId: "vm-1", nowMs: NOW + 1 }),
    ).toBe(true);
    // Replay cannot clobber the resolved row.
    expect(
      await markVmReservationCreated(db, { reservationId: "res-1", runtimeSandboxId: "vm-2", nowMs: NOW + 2 }),
    ).toBe(false);
    const row = sqlite
      .prepare("SELECT outcome, runtime_sandbox_id FROM runtime_vm_reservations WHERE reservation_id = 'res-1'")
      .get() as { outcome: string; runtime_sandbox_id: string };
    expect(row).toEqual({ outcome: "created", runtime_sandbox_id: "vm-1" });
  });

  it("CAS-resolves pending to a failure outcome and cannot overwrite created", async () => {
    await insertVmReservation(db, baseParams());
    expect(
      await markVmReservationFailed(db, {
        reservationId: "res-1",
        outcome: "possible_orphan",
        errorCode: "timeout",
        nowMs: NOW + 1,
      }),
    ).toBe(true);

    await insertVmReservation(db, baseParams({ reservationId: "res-2" }));
    await markVmReservationCreated(db, { reservationId: "res-2", runtimeSandboxId: "vm-2", nowMs: NOW + 1 });
    expect(
      await markVmReservationFailed(db, {
        reservationId: "res-2",
        outcome: "failed",
        errorCode: "auth",
        nowMs: NOW + 2,
      }),
    ).toBe(false);
  });

  it("lists distinct reserved VM ids per backend", async () => {
    await insertVmReservation(db, baseParams({ reservationId: "res-1" }));
    await markVmReservationCreated(db, { reservationId: "res-1", runtimeSandboxId: "vm-1", nowMs: NOW });
    await insertVmReservation(db, baseParams({ reservationId: "res-2", spawnAttemptId: "attempt-2" }));
    await markVmReservationCreated(db, { reservationId: "res-2", runtimeSandboxId: "vm-1", nowMs: NOW });
    await insertVmReservation(db, baseParams({ reservationId: "res-3", runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND }));
    await markVmReservationCreated(db, { reservationId: "res-3", runtimeSandboxId: "e2b-vm", nowMs: NOW });
    // Unresolved rows contribute no id.
    await insertVmReservation(db, baseParams({ reservationId: "res-4" }));

    expect(await listReservedVmIdsForBackend(db, FREESTYLE_RUNTIME_BACKEND)).toEqual(["vm-1"]);
    expect(await listReservedVmIdsForBackend(db, E2B_CLOUD_RUNTIME_BACKEND)).toEqual(["e2b-vm"]);
  });

  it("lists session_index VM ids by backend, including legacy provider-skewed rows", async () => {
    sqlite.exec(`
      INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id) VALUES
        ('s1', 'freestyle', 'freestyle', 'vm-modern'),
        ('s2', 'e2b', 'freestyle', 'vm-legacy'),
        ('s3', 'freestyle', NULL, 'vm-provider-only'),
        ('s4', 'e2b', 'e2b_cloud', 'e2b-live'),
        ('s5', 'freestyle', 'freestyle', NULL);
    `);
    // Modern (backend match), legacy pre-derive skew provider='e2b' (backend match),
    // and provider-only belt-and-braces (provider match) all register; a real e2b
    // row is excluded and a null sandbox id is dropped.
    expect((await listSessionIndexVmIdsForBackend(db, FREESTYLE_RUNTIME_BACKEND)).sort()).toEqual([
      "vm-legacy",
      "vm-modern",
      "vm-provider-only",
    ]);
  });

  it("lists unresolved Freestyle reservations: possible_orphan plus stale pending, excluding reconciled", async () => {
    // possible_orphan — always flagged, regardless of age.
    await insertVmReservation(db, baseParams({ reservationId: "res-orphan", nowMs: NOW }));
    await markVmReservationFailed(db, {
      reservationId: "res-orphan",
      outcome: "possible_orphan",
      errorCode: "timeout",
      nowMs: NOW,
    });
    // Fresh pending — still in flight, not flagged.
    await insertVmReservation(db, baseParams({ reservationId: "res-fresh", nowMs: NOW - 1_000 }));
    // Stale pending — the DO died mid-create; flagged.
    await insertVmReservation(db, baseParams({ reservationId: "res-stale", nowMs: NOW - 3_600_000 }));
    // Reconciled — human already handled it; silenced.
    await insertVmReservation(db, baseParams({ reservationId: "res-done", nowMs: NOW - 3_600_000 }));
    sqlite.exec("UPDATE runtime_vm_reservations SET outcome = 'reconciled' WHERE reservation_id = 'res-done'");
    // E2B rows never surface in the Freestyle audit query.
    await insertVmReservation(
      db,
      baseParams({ reservationId: "res-e2b", runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND, nowMs: NOW - 3_600_000 }),
    );

    const rows = await listUnresolvedFreestyleReservations(db, { pendingBeforeMs: NOW - 1_800_000, limit: 10 });
    expect(rows.map((row) => row.reservationId).sort()).toEqual(["res-orphan", "res-stale"]);
    const orphan = rows.find((row) => row.reservationId === "res-orphan");
    expect(orphan?.outcome).toBe("possible_orphan");
    expect(orphan?.errorCode).toBe("timeout");
    expect(orphan?.vmName).toBe("cycloid-sess-1-sbx-1");
  });
});

// A db stub whose prepare() throws — pins that empty vmIds short-circuits
// without issuing any D1 statement.
const throwingDb = {
  prepare() {
    throw new Error("expected no D1 call for empty vmIds");
  },
} as unknown as D1Database;

describe("listSupersededCreatedReservations", () => {
  async function created(reservationId: string, sessionId: string, vmId: string, backend = FREESTYLE_RUNTIME_BACKEND) {
    await insertVmReservation(db, baseParams({ reservationId, sessionId, runtimeBackend: backend }));
    await markVmReservationCreated(db, { reservationId, runtimeSandboxId: vmId, nowMs: NOW });
  }

  it("returns a created reservation whose session projection points at a different VM id", async () => {
    await created("res-1", "s1", "vm-old");
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_sandbox_id) VALUES ('s1','freestyle','vm-new')",
    );
    const rows = await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: ["vm-old", "vm-new"],
      createdBeforeMs: NOW + 1,
    });
    expect(rows.map((r) => r.reservationId)).toEqual(["res-1"]);
    expect(rows[0].runtimeSandboxId).toBe("vm-old");
    expect(rows[0].sessionId).toBe("s1");
  });

  it("excludes a created reservation whose projection still matches its VM id", async () => {
    await created("res-1", "s1", "vm-old");
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_sandbox_id) VALUES ('s1','freestyle','vm-old')",
    );
    expect(
      await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
        vmIds: ["vm-old"],
        createdBeforeMs: NOW + 1,
      }),
    ).toEqual([]);
  });

  it("excludes a divergent reservation whose VM id is not in the live set (already terminated)", async () => {
    await created("res-dead", "s-dead", "vm-dead"); // no session_index row — divergent
    expect(
      await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
        vmIds: ["vm-something-else"],
        createdBeforeMs: NOW + 1,
      }),
    ).toEqual([]);
  });

  it("applies a strict less-than boundary on createdBeforeMs (young reservations excluded)", async () => {
    await created("res-young", "s-young", "vm-young"); // created_at = NOW (baseParams)
    expect(
      await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
        vmIds: ["vm-young"],
        createdBeforeMs: NOW, // created_at == cutoff → excluded
      }),
    ).toEqual([]);
    expect(
      (
        await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
          vmIds: ["vm-young"],
          createdBeforeMs: NOW + 1, // created_at < cutoff → included
        })
      ).map((r) => r.reservationId),
    ).toEqual(["res-young"]);
  });

  it("classifies via LEFT JOIN when the session_index row is missing or its projection is NULL", async () => {
    await created("res-missing", "s-missing", "vm-a"); // no session_index row at all
    await created("res-null", "s-null", "vm-b");
    sqlite.exec(
      "INSERT INTO session_index (session_id, runtime_provider, runtime_sandbox_id) VALUES ('s-null','freestyle',NULL)",
    );
    const rows = await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: ["vm-a", "vm-b"],
      createdBeforeMs: NOW + 1,
    });
    expect(rows.map((r) => r.reservationId).sort()).toEqual(["res-missing", "res-null"]);
  });

  it("excludes non-created outcomes and cross-backend reservations", async () => {
    // Pending — has no projection but is not 'created'.
    await insertVmReservation(db, baseParams({ reservationId: "res-pending", sessionId: "s-pending" }));
    // possible_orphan — not 'created'.
    await insertVmReservation(db, baseParams({ reservationId: "res-orphan", sessionId: "s-orphan" }));
    await markVmReservationFailed(db, {
      reservationId: "res-orphan",
      outcome: "possible_orphan",
      errorCode: null,
      nowMs: NOW,
    });
    // E2B created with a divergent (missing) projection — excluded by the backend filter.
    await created("res-e2b", "s-e2b", "e2b-vm", E2B_CLOUD_RUNTIME_BACKEND);
    expect(
      await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
        vmIds: ["e2b-vm"],
        createdBeforeMs: NOW + 1,
      }),
    ).toEqual([]);
  });

  it("chunks a >80-id vmIds set across multiple statements and concatenates results", async () => {
    // Two divergent reservations whose VM ids land in different ≤80-id chunks.
    await created("res-first", "s-first", "vm-000");
    await created("res-last", "s-last", "vm-100");
    const vmIds = Array.from({ length: 101 }, (_, i) => `vm-${String(i).padStart(3, "0")}`);
    const rows = await listSupersededCreatedReservations(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds,
      createdBeforeMs: NOW + 1,
    });
    expect(rows.map((r) => r.reservationId).sort()).toEqual(["res-first", "res-last"]);
  });

  it("returns [] for empty vmIds without touching D1", async () => {
    await expect(
      listSupersededCreatedReservations(throwingDb, FREESTYLE_RUNTIME_BACKEND, {
        vmIds: [],
        createdBeforeMs: NOW,
      }),
    ).resolves.toEqual([]);
  });
});

describe("listKilledRowVms", () => {
  function killedRow(
    sessionId: string,
    vmId: string | null,
    expiresAt: number | null,
    opts: { backend?: string | null; provider?: string | null; state?: string; updatedAt?: number | null } = {},
  ) {
    const backend = opts.backend === undefined ? "freestyle" : opts.backend;
    const provider = opts.provider === undefined ? "freestyle" : opts.provider;
    const state = opts.state ?? "killed";
    const updatedAt = opts.updatedAt === undefined ? NOW : opts.updatedAt;
    sqlite
      .prepare(
        `INSERT INTO session_index (session_id, runtime_provider, runtime_backend, runtime_sandbox_id, runtime_state, runtime_state_expires_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(sessionId, provider, backend, vmId, state, expiresAt, updatedAt);
  }

  it("returns killed rows whose kill timestamp is before the cutoff, ordered by expiry ASC", async () => {
    killedRow("s-old", "vm-old", NOW - 3_600_000);
    killedRow("s-older", "vm-older", NOW - 7_200_000);
    const rows = await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: ["vm-old", "vm-older"],
      killedBeforeMs: NOW,
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["s-older", "s-old"]);
    expect(rows[0]).toEqual({
      sessionId: "s-older",
      runtimeSandboxId: "vm-older",
      runtimeStateExpiresAt: NOW - 7_200_000,
    });
  });

  it("returns empty when no rows are in the killed state", async () => {
    killedRow("s-running", "vm-r", NOW - 3_600_000, { state: "running" });
    expect(await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, { vmIds: ["vm-r"], killedBeforeMs: NOW })).toEqual([]);
  });

  it("excludes a killed row whose VM id is not in the live set (already terminated)", async () => {
    killedRow("s-dead", "vm-dead", NOW - 3_600_000);
    expect(await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, { vmIds: ["vm-other"], killedBeforeMs: NOW })).toEqual(
      [],
    );
  });

  it("applies a strict less-than boundary on the grace cutoff", async () => {
    const cutoff = NOW - 3_600_000;
    killedRow("s-at", "vm-at", cutoff); // == cutoff → excluded
    killedRow("s-below", "vm-below", cutoff - 1); // < cutoff → included
    const rows = await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: ["vm-at", "vm-below"],
      killedBeforeMs: cutoff,
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["s-below"]);
  });

  it("falls back to updated_at when runtime_state_expires_at is NULL (never-stamped kill)", async () => {
    killedRow("s-null-past", "vm-null-past", null, { updatedAt: NOW - 7_200_000 }); // updated_at past cutoff → included
    killedRow("s-null-fresh", "vm-null-fresh", null, { updatedAt: NOW - 1 }); // updated_at within grace → excluded
    const rows = await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: ["vm-null-past", "vm-null-fresh"],
      killedBeforeMs: NOW - 3_600_000,
    });
    expect(rows).toEqual([{ sessionId: "s-null-past", runtimeSandboxId: "vm-null-past", runtimeStateExpiresAt: null }]);
  });

  it("matches on backend OR provider skew and drops null sandbox rows", async () => {
    killedRow("s-backend", "vm-backend", NOW - 3_600_000, { backend: "freestyle", provider: "e2b" }); // backend match, legacy provider skew
    killedRow("s-provider", "vm-provider", NOW - 3_600_000, { backend: null, provider: "freestyle" }); // provider-only match
    killedRow("s-e2b", "vm-e2b", NOW - 3_600_000, { backend: "e2b_cloud", provider: "e2b" }); // neither → excluded
    killedRow("s-nullvm", null, NOW - 3_600_000); // null sandbox id → excluded (never in vmIds)
    const rows = await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: ["vm-backend", "vm-provider", "vm-e2b"],
      killedBeforeMs: NOW,
    });
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["s-backend", "s-provider"]);
  });

  it("chunks a >80-id vmIds set across multiple statements and concatenates results", async () => {
    killedRow("s-first", "vm-000", NOW - 3_600_000);
    killedRow("s-last", "vm-100", NOW - 7_200_000);
    const vmIds = Array.from({ length: 101 }, (_, i) => `vm-${String(i).padStart(3, "0")}`);
    const rows = await listKilledRowVms(db, FREESTYLE_RUNTIME_BACKEND, { vmIds, killedBeforeMs: NOW });
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["s-first", "s-last"]);
  });

  it("returns [] for empty vmIds without touching D1", async () => {
    await expect(
      listKilledRowVms(throwingDb, FREESTYLE_RUNTIME_BACKEND, { vmIds: [], killedBeforeMs: NOW }),
    ).resolves.toEqual([]);
  });
});
