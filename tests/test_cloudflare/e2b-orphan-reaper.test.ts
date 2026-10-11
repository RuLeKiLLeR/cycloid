import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import { getE2BOrphanReaperBatchLimit } from "../../apps/control-plane-worker/src/constants/e2b-cleanup";
import type { E2BListedSandbox } from "../../apps/control-plane-worker/src/sandbox/e2b-client";
import {
  type E2BOrphanReaperListedSandbox,
  listE2BSandboxD1References,
  runE2BOrphanSandboxReaper,
  selectE2BOrphanReaperCandidates,
} from "../../apps/control-plane-worker/src/sandbox/e2b-orphan-reaper";
import { E2B_CLOUD_RUNTIME_BACKEND } from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { FakeD1 } from "../smoke/helpers";

const NOW = 1_700_000_000_000;

function sandbox(id: string, createdAt: number): E2BListedSandbox {
  return {
    runtimeSandboxId: id,
    runtimeTemplateId: "tmpl",
    status: "running",
    createdAt,
    metadata: { runtime_provider: "e2b", sandbox_id: id },
  };
}

// A listed sandbox that carries metadata.session_id, so the reaper consults the
// owner guard before terminating it.
function ownedSandbox(id: string, createdAt: number, sessionId: string): E2BListedSandbox {
  return { ...sandbox(id, createdAt), metadata: { runtime_provider: "e2b", sandbox_id: id, session_id: sessionId } };
}

function reaperSandbox(
  id: string,
  createdAt: number,
  runtimeBackend = E2B_CLOUD_RUNTIME_BACKEND,
): E2BOrphanReaperListedSandbox {
  return { ...sandbox(id, createdAt), runtimeBackend };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("getE2BOrphanReaperBatchLimit", () => {
  it("uses the orphan-specific env var instead of the runtime-cleanup env var", () => {
    expect(
      getE2BOrphanReaperBatchLimit({
        E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "5",
        E2B_ORPHAN_REAPER_BATCH_LIMIT: "7",
      }),
    ).toBe(7);
  });
});

describe("selectE2BOrphanReaperCandidates", () => {
  it("keeps D1-referenced and young sandboxes, and selects old unreferenced sandboxes", () => {
    const selected = selectE2BOrphanReaperCandidates(
      [
        reaperSandbox("referenced", NOW - 60 * 60 * 1_000),
        reaperSandbox("young", NOW - 60_000),
        reaperSandbox("orphan", NOW - 900_000),
      ],
      [
        {
          runtimeSandboxId: "referenced",
          runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
          source: "session_index",
          state: "running",
          ownerId: "sess-1",
        },
      ],
      NOW,
      10 * 60 * 1_000,
    );

    expect(selected).toMatchObject({
      referenced: 1,
      young: 1,
      candidates: [{ runtimeSandboxId: "orphan", ageMs: 900_000 }],
    });
  });
});

describe("runE2BOrphanSandboxReaper", () => {
  beforeEach(() => {
    mockPostStructuredEventToDd.mockClear();
  });

  it("direct-posts a swept heartbeat on a zero-orphan sweep (distinguishes clean-no-work from never-ran)", async () => {
    const db = new FakeD1();
    const client = {
      // Only a young sandbox -> no candidates, nothing reaped: the silent path.
      listCycloidSandboxes: vi.fn(async () => [sandbox("sbx-young", NOW - 60_000)]),
      terminateSandbox: vi.fn(async () => ({ status: "killed" as const })),
    };

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client,
      logger: createLogger() as never,
    });

    expect(result.reaped).toBe(0);
    expect(result.candidates).toBe(0);
    expect(mockPostStructuredEventToDd).toHaveBeenCalledTimes(1);
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "e2b_orphan_reaper.swept",
        listed: 1,
        reaped: 0,
        candidates: 0,
        deferred: 0,
        errors: 0,
      }),
    );
  });

  it("uses FakeD1 references to keep recorded sandboxes, keeps young orphans, and terminates old unreferenced sandboxes", async () => {
    const db = new FakeD1();
    db.sessionIndex.set("sess-1", {
      session_id: "sess-1",
      runtime_provider: "e2b",
      runtime_backend: E2B_CLOUD_RUNTIME_BACKEND,
      runtime_sandbox_id: "sbx-session",
      runtime_state: "running",
      status: "active",
    } as never);
    await expect(
      listE2BSandboxD1References(db as unknown as D1Database, ["sbx-session", "sbx-orphan"]),
    ).resolves.toEqual([
      {
        runtimeSandboxId: "sbx-session",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        source: "session_index",
        state: "running",
        ownerId: "sess-1",
      },
    ]);

    const terminateSandbox = vi.fn(async () => ({ status: "killed" as const }));
    const client = {
      listCycloidSandboxes: vi.fn(async () => [
        sandbox("sbx-session", NOW - 60 * 60 * 1_000),
        sandbox("sbx-young", NOW - 60_000),
        sandbox("sbx-orphan", NOW - 60 * 60 * 1_000),
      ]),
      terminateSandbox,
    };
    const logger = createLogger();

    const result = await runE2BOrphanSandboxReaper(
      {
        DB: db as unknown as D1Database,
        E2B_API_KEY: "e2b-key",
      } as Env,
      {
        nowMs: NOW,
        minAgeMs: 10 * 60 * 1_000,
        client,
        logger: logger as never,
      },
    );

    expect(result).toEqual({
      listed: 3,
      referenced: 1,
      young: 1,
      candidates: 1,
      reaped: 1,
      missing: 0,
      protected: 0,
      deferred: 0,
      errors: 0,
    });
    expect(terminateSandbox).toHaveBeenCalledTimes(1);
    expect(terminateSandbox).toHaveBeenCalledWith("sbx-orphan", "orphan_reaper");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "e2b_orphan_reaped",
        runtimeSandboxId: "sbx-orphan",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        d1Reference: null,
        terminateStatus: "killed",
      }),
      "E2B orphan sandbox reaped",
    );
  });

  it("lists and reaps E2B orphans via the single client", async () => {
    const db = new FakeD1();
    const cloudClient = {
      listCycloidSandboxes: vi.fn(async () => [
        sandbox("sbx-cloud-young", NOW - 60_000),
        sandbox("sbx-cloud-orphan", NOW - 60 * 60 * 1_000),
      ]),
      terminateSandbox: vi.fn(async () => ({ status: "killed" as const })),
    };

    const result = await runE2BOrphanSandboxReaper(
      {
        DB: db as unknown as D1Database,
        E2B_API_KEY: "e2b-key",
      } as Env,
      {
        nowMs: NOW,
        minAgeMs: 10 * 60 * 1_000,
        client: cloudClient,
      },
    );

    expect(result).toMatchObject({ listed: 2, young: 1, candidates: 1, reaped: 1, errors: 0 });
    expect(cloudClient.terminateSandbox).toHaveBeenCalledWith("sbx-cloud-orphan", "orphan_reaper");
  });

  it("uses one batched fresh reference read for candidates and skips candidates referenced by it", async () => {
    const db = new FakeD1();
    let referenceReadCount = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((query: string) => {
      const statement = originalPrepare(query);
      if (isE2BReferenceQuery(query)) {
        const originalBind = statement.bind.bind(statement);
        statement.bind = ((...values: unknown[]) => {
          const boundStatement = originalBind(...values);
          const originalAll = boundStatement.all.bind(boundStatement);
          boundStatement.all = (async () => {
            referenceReadCount++;
            if (referenceReadCount === 2) {
              setSessionIndexRow(db, "sess-refreshed", "sbx-refreshed", "running");
            }
            return originalAll();
          }) as typeof boundStatement.all;
          return boundStatement;
        }) as typeof statement.bind;
      }
      return statement;
    }) as typeof db.prepare;

    const terminateSandbox = vi.fn(async () => ({ status: "killed" as const }));
    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: vi.fn(async () => [
          sandbox("sbx-oldest", NOW - 80 * 60 * 1_000),
          sandbox("sbx-refreshed", NOW - 70 * 60 * 1_000),
          sandbox("sbx-newest", NOW - 60 * 60 * 1_000),
        ]),
        terminateSandbox,
      },
      logger: createLogger() as never,
    });

    expect(result).toMatchObject({ referenced: 0, candidates: 3, reaped: 2, errors: 0 });
    expect(terminateSandbox).toHaveBeenCalledTimes(2);
    expect(terminateSandbox).toHaveBeenCalledWith("sbx-oldest", "orphan_reaper");
    expect(terminateSandbox).toHaveBeenCalledWith("sbx-newest", "orphan_reaper");
    expect(terminateSandbox).not.toHaveBeenCalledWith("sbx-refreshed", "orphan_reaper");
    expect(countE2BReferenceQueries(db)).toBe(2);
  });

  it("returns an empty result without listing when E2B is unconfigured (no E2B_API_KEY)", async () => {
    const db = new FakeD1();

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
    });

    expect(result).toEqual({
      listed: 0,
      referenced: 0,
      young: 0,
      candidates: 0,
      reaped: 0,
      missing: 0,
      protected: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("consults the owner guard for candidates carrying metadata.session_id", async () => {
    const db = new FakeD1();
    const logger = createLogger();
    const terminateSandbox = vi.fn(async () => ({ status: "killed" as const }));
    const ownerGuard = vi.fn(async (req: { sessionId: string }) => {
      if (req.sessionId === "sess-protect")
        return { ok: true as const, decision: "protect" as const, reasonCode: "protected_owned" as const };
      if (req.sessionId === "sess-defer")
        return { ok: true as const, decision: "defer" as const, reasonCode: "defer_state_changed" as const };
      return { ok: true as const, decision: "terminate" as const, reasonCode: "terminate_terminal" as const };
    });

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: vi.fn(async () => [
          ownedSandbox("sbx-protect", NOW - 60 * 60 * 1_000, "sess-protect"),
          ownedSandbox("sbx-defer", NOW - 60 * 60 * 1_000, "sess-defer"),
          ownedSandbox("sbx-terminate", NOW - 60 * 60 * 1_000, "sess-terminate"),
          sandbox("sbx-true-orphan", NOW - 60 * 60 * 1_000),
        ]),
        terminateSandbox,
      },
      ownerGuard,
      logger: logger as never,
    });

    // protect + defer are NOT terminated; owner-guard terminate + true orphan (no
    // session_id) ARE terminated.
    expect(result).toMatchObject({ reaped: 2, protected: 1, deferred: 1, errors: 0 });
    expect(terminateSandbox).toHaveBeenCalledWith("sbx-terminate", "orphan_reaper");
    expect(terminateSandbox).toHaveBeenCalledWith("sbx-true-orphan", "orphan_reaper");
    expect(terminateSandbox).not.toHaveBeenCalledWith("sbx-protect");
    expect(terminateSandbox).not.toHaveBeenCalledWith("sbx-defer");
    // The true orphan has no session_id, so the guard is never consulted for it.
    expect(ownerGuard).toHaveBeenCalledTimes(3);
    // ARC-1248: the reaper threads the physical E2B status it already observed
    // into the guard so the guard can prove liveness without a second probe.
    expect(ownerGuard).toHaveBeenCalledWith(expect.objectContaining({ candidateE2bStatus: "running" }));
    // ARC-1248 observability: a session-tagged owner-guard reap records WHY.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "e2b_orphan_reaped",
        runtimeSandboxId: "sbx-terminate",
        ownerSessionId: "sess-terminate",
        ownerSessionTagged: true,
        ownerGuardReasonCode: "terminate_terminal",
      }),
      "E2B orphan sandbox reaped",
    );
    // A true orphan has no owner guard, so the reason code is null + untagged.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "e2b_orphan_reaped",
        runtimeSandboxId: "sbx-true-orphan",
        ownerSessionTagged: false,
        ownerGuardReasonCode: null,
      }),
      "E2B orphan sandbox reaped",
    );
  });

  it("fails closed (defers, never terminates) when the owner guard call throws", async () => {
    const db = new FakeD1();
    const terminateSandbox = vi.fn(async () => ({ status: "killed" as const }));
    const ownerGuard = vi.fn(async () => {
      throw new Error("DO unreachable");
    });

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: vi.fn(async () => [ownedSandbox("sbx-owned", NOW - 60 * 60 * 1_000, "sess-x")]),
        terminateSandbox,
      },
      ownerGuard,
      logger: createLogger() as never,
    });

    expect(result).toMatchObject({ reaped: 0, protected: 0, deferred: 1, errors: 0 });
    expect(terminateSandbox).not.toHaveBeenCalled();
  });

  it("logs the owner-guard null-read defer reason and counter without terminating", async () => {
    const db = new FakeD1();
    const logger = createLogger();
    const terminateSandbox = vi.fn(async () => ({ status: "killed" as const }));
    const ownerGuard = vi.fn(async () => ({
      ok: true as const,
      decision: "defer" as const,
      reasonCode: "defer_runtime_read_unavailable" as const,
      runtimeReadUnavailableKind: "sandbox_runtime" as const,
      runtimeReadUnavailableSweeps: 2,
    }));

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: vi.fn(async () => [ownedSandbox("sbx-owned", NOW - 60 * 60 * 1_000, "sess-x")]),
        terminateSandbox,
      },
      ownerGuard,
      logger: logger as never,
    });

    expect(result).toMatchObject({ reaped: 0, protected: 0, deferred: 1, errors: 0 });
    expect(terminateSandbox).not.toHaveBeenCalled();
    expect(ownerGuard).toHaveBeenCalledWith(expect.objectContaining({ sweepStartedAtMs: NOW }));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "e2b_orphan_owner_guard_skipped",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableKind: "sandbox_runtime",
        runtimeReadUnavailableSweeps: 2,
      }),
      "E2B orphan owner guard skipped termination",
    );
  });

  it("logs already-missing reap outcomes at warn", async () => {
    const db = new FakeD1();
    const logger = createLogger();

    const result = await runE2BOrphanSandboxReaper(
      {
        DB: db as unknown as D1Database,
        E2B_API_KEY: "e2b-key",
      } as Env,
      {
        nowMs: NOW,
        minAgeMs: 10 * 60 * 1_000,
        client: {
          listCycloidSandboxes: vi.fn(async () => [sandbox("sbx-missing", NOW - 60 * 60 * 1_000)]),
          terminateSandbox: vi.fn(async () => ({ status: "missing" as const })),
        },
        logger: logger as never,
      },
    );

    expect(result).toMatchObject({ reaped: 0, missing: 1, errors: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "e2b_orphan_reaped",
        runtimeSandboxId: "sbx-missing",
        terminateStatus: "missing",
      }),
      "E2B orphan sandbox reaped",
    );
  });
});

// ---------------------------------------------------------------------------
// Protect-set truth filtering (deep-plan 6.1): only non-terminal owners shield
// a sandbox from the reaper. Terminal/expired-lease rows still retain
// runtime_sandbox_id, so without these filters a leaked sandbox is shielded
// forever.
// ---------------------------------------------------------------------------

function setSessionIndexRow(
  db: FakeD1,
  sessionId: string,
  runtimeSandboxId: string,
  runtimeState: string | null,
): void {
  db.sessionIndex.set(sessionId, {
    session_id: sessionId,
    runtime_provider: "e2b",
    runtime_backend: E2B_CLOUD_RUNTIME_BACKEND,
    runtime_sandbox_id: runtimeSandboxId,
    runtime_state: runtimeState,
    status: "active",
  } as never);
}

function isE2BReferenceQuery(query: string): boolean {
  return (
    query.includes("SELECT runtime_sandbox_id") &&
    query.includes("FROM session_index") &&
    query.includes("runtime_sandbox_id IN")
  );
}

function countE2BReferenceQueries(db: FakeD1): number {
  return db.preparedQueries.filter(isE2BReferenceQuery).length;
}

describe("listE2BSandboxD1References protect-set truth filtering", () => {
  it("does NOT shield a killed session_index row that still carries runtime_sandbox_id", async () => {
    const db = new FakeD1();
    setSessionIndexRow(db, "sess-killed", "sbx-killed", "killed");

    const refs = await listE2BSandboxD1References(db as unknown as D1Database, ["sbx-killed"]);

    expect(refs).toEqual([]);
  });

  it("shields running and paused session_index rows", async () => {
    const db = new FakeD1();
    setSessionIndexRow(db, "sess-running", "sbx-running", "running");
    setSessionIndexRow(db, "sess-paused", "sbx-paused", "paused");

    const refs = await listE2BSandboxD1References(db as unknown as D1Database, ["sbx-running", "sbx-paused"]);

    expect(refs.map((r) => r.runtimeSandboxId).sort()).toEqual(["sbx-paused", "sbx-running"]);
  });

  it("reaps a killed-shielded sandbox while sparing an active running one", async () => {
    const db = new FakeD1();
    // A killed session_index row that still retains runtime_sandbox_id no longer
    // shields its leaked sandbox; a running row does.
    setSessionIndexRow(db, "sess-killed", "sbx-killed", "killed");
    setSessionIndexRow(db, "sess-running", "sbx-running", "running");

    const terminateSandbox = vi.fn(async () => ({ status: "killed" as const }));
    const client = {
      listCycloidSandboxes: vi.fn(async () => [
        sandbox("sbx-killed", NOW - 60 * 60 * 1_000),
        sandbox("sbx-running", NOW - 60 * 60 * 1_000),
      ]),
      terminateSandbox,
    };

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client,
      logger: createLogger() as never,
    });

    expect(result).toMatchObject({ referenced: 1, candidates: 1, reaped: 1, errors: 0 });
    expect(terminateSandbox).toHaveBeenCalledTimes(1);
    expect(terminateSandbox).toHaveBeenCalledWith("sbx-killed", "orphan_reaper");
    expect(terminateSandbox).not.toHaveBeenCalledWith("sbx-running");
  });

  it("round-trips a freestyle runtime_backend through the protect-set without throwing", async () => {
    const db = new FakeD1();
    db.sessionIndex.set("sess-freestyle", {
      session_id: "sess-freestyle",
      runtime_provider: "e2b",
      runtime_backend: "freestyle",
      runtime_sandbox_id: "sbx-freestyle",
      runtime_state: "running",
      status: "active",
    } as never);

    const refs = await listE2BSandboxD1References(db as unknown as D1Database, ["sbx-freestyle"]);

    expect(refs).toEqual([
      {
        runtimeSandboxId: "sbx-freestyle",
        runtimeBackend: "freestyle",
        source: "session_index",
        state: "running",
        ownerId: "sess-freestyle",
      },
    ]);
  });

  it("preserves an invalid runtime_backend as null instead of falling back to cloud", async () => {
    const db = new FakeD1();
    db.sessionIndex.set("sess-invalid", {
      session_id: "sess-invalid",
      runtime_provider: "e2b",
      runtime_backend: "legacy-e2b",
      runtime_sandbox_id: "sbx-invalid",
      runtime_state: "running",
      status: "active",
    } as never);

    const refs = await listE2BSandboxD1References(db as unknown as D1Database, ["sbx-invalid"]);

    expect(refs).toEqual([
      {
        runtimeSandboxId: "sbx-invalid",
        runtimeBackend: null,
        source: "session_index",
        state: "running",
        ownerId: "sess-invalid",
      },
    ]);
    expect(
      selectE2BOrphanReaperCandidates(
        [reaperSandbox("sbx-invalid", NOW - 60 * 60 * 1_000)],
        refs,
        NOW,
        10 * 60 * 1_000,
      ),
    ).toMatchObject({ referenced: 1, candidates: [] });
  });

  it("parses runtime_backend from sandbox metadata when present", async () => {
    const db = new FakeD1();

    const listSandboxes = vi.fn(async () => [
      {
        ...sandbox("sbx-1", NOW - 60 * 60 * 1_000),
        metadata: { runtime_provider: "e2b", sandbox_id: "sbx-1", runtime_backend: "freestyle" },
      },
    ]);

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: listSandboxes,
        terminateSandbox: vi.fn(async () => ({ status: "killed" as const })),
      },
      logger: createLogger() as never,
    });

    expect(result.listed).toBe(1);
    expect(listSandboxes).toHaveBeenCalled();
  });

  it("falls back to e2b_cloud when metadata.runtime_backend is absent", async () => {
    const db = new FakeD1();

    const listSandboxes = vi.fn(async () => [sandbox("sbx-1", NOW - 60 * 60 * 1_000)]);

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: listSandboxes,
        terminateSandbox: vi.fn(async () => ({ status: "killed" as const })),
      },
      logger: createLogger() as never,
    });

    expect(result.listed).toBe(1);
    expect(listSandboxes).toHaveBeenCalled();
  });

  it("falls back to e2b_cloud when metadata.runtime_backend is invalid", async () => {
    const db = new FakeD1();

    const listSandboxes = vi.fn(async () => [
      {
        ...sandbox("sbx-1", NOW - 60 * 60 * 1_000),
        metadata: { runtime_provider: "e2b", sandbox_id: "sbx-1", runtime_backend: "invalid_backend" },
      },
    ]);

    const result = await runE2BOrphanSandboxReaper({ DB: db as unknown as D1Database, E2B_API_KEY: "e2b-key" } as Env, {
      nowMs: NOW,
      minAgeMs: 10 * 60 * 1_000,
      client: {
        listCycloidSandboxes: listSandboxes,
        terminateSandbox: vi.fn(async () => ({ status: "killed" as const })),
      },
      logger: createLogger() as never,
    });

    expect(result.listed).toBe(1);
    expect(listSandboxes).toHaveBeenCalled();
  });
});
