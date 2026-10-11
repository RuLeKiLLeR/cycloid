import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT,
  E2B_RUNTIME_CLEANUP_BATCH_LIMIT_HARD_CAP,
  E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT,
  getE2BRuntimeCleanupBatchLimit,
} from "../../apps/control-plane-worker/src/constants/e2b-cleanup";
import type {
  E2BRuntimeCleanupOutcome,
  E2BRuntimeCleanupReasonCode,
  E2BRuntimeCleanupRunResponse,
} from "../../apps/control-plane-worker/src/session/internal-routes";

// ---------------------------------------------------------------------------
// Batch limit constants
// ---------------------------------------------------------------------------

describe("getE2BRuntimeCleanupBatchLimit", () => {
  it("returns default when env var is unset", () => {
    expect(getE2BRuntimeCleanupBatchLimit({})).toBe(E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT);
  });

  it("returns parsed value when within range", () => {
    expect(getE2BRuntimeCleanupBatchLimit({ E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "50" })).toBe(50);
  });

  it("caps at hard cap when env exceeds it", () => {
    expect(getE2BRuntimeCleanupBatchLimit({ E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "200" })).toBe(
      E2B_RUNTIME_CLEANUP_BATCH_LIMIT_HARD_CAP,
    );
  });

  it("returns default for non-numeric input", () => {
    expect(getE2BRuntimeCleanupBatchLimit({ E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "abc" })).toBe(
      E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT,
    );
  });

  it("returns default for zero", () => {
    expect(getE2BRuntimeCleanupBatchLimit({ E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "0" })).toBe(
      E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT,
    );
  });

  it("returns default for negative value", () => {
    expect(getE2BRuntimeCleanupBatchLimit({ E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "-5" })).toBe(
      E2B_RUNTIME_CLEANUP_BATCH_LIMIT_DEFAULT,
    );
  });

  it("floors fractional values", () => {
    expect(getE2BRuntimeCleanupBatchLimit({ E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "10.9" })).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredE2BRuntimes integration tests
//
// The worker sweep now makes a single `/internal/runtime/e2b/cleanup-run` call
// per candidate and tallies counters from the returned outcome/reasonCode. The
// provider terminate moved into the DO, so the worker no longer builds an E2B
// client.
// ---------------------------------------------------------------------------

vi.mock("e2b", () => ({
  Sandbox: { create: vi.fn(), connect: vi.fn(), kill: vi.fn() },
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: vi.fn(() => loggerMocks),
}));

const stubFetchMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionStub: vi.fn(() => ({ fetch: stubFetchMock })),
}));

import {
  cleanupExpiredE2BRuntimes,
  KILLED_RUNTIME_REAP_GRACE_MS,
} from "../../apps/control-plane-worker/src/session/cleanup";
import type { Env } from "../../apps/control-plane-worker/src/types";

interface MockRow {
  session_id: string;
  runtime_sandbox_id: string;
  runtime_backend?: string | null;
  candidate_at: number;
  // Only meaningful on running-branch rows: the query CASE expression that marks
  // a NULL-lease (aged) candidate vs a set-and-expired-lease candidate.
  lease_was_null?: number;
}

interface PreparedCapture {
  sql: string;
  binds: unknown[];
}

// The candidate SELECTs run through a single `db.batch([...])` whose results are
// POSITIONAL. Fixtures are keyed by batch statement order:
//   [0] paused, [1] running, [2] malformed, [3] killed.
// `.bind()` returns the statement handle (captured for sql/bind assertions); the
// old positional `.all()` mock is gone so a regression to `.all()` throws loudly.
function createMockD1(
  pausedRows: MockRow[] = [],
  runningRows: MockRow[] = [],
  malformedRows: MockRow[] = [],
  killedRows: MockRow[] = [],
) {
  const fixtures: MockRow[][] = [pausedRows, runningRows, malformedRows, killedRows];
  const prepared: PreparedCapture[] = [];
  return {
    prepare: vi.fn((sql: string) => {
      const record: PreparedCapture = { sql, binds: [] };
      prepared.push(record);
      return {
        bind: vi.fn(function bind(this: unknown, ...args: unknown[]) {
          record.binds = args;
          return this;
        }),
      };
    }),
    batch: vi.fn((statements: unknown[]) => {
      // A batch carrying more statements than we have fixture arrays means a new
      // candidate branch was wired without extending this harness. Throw instead
      // of silently returning [] for the extra statement, which would mask the
      // regression (the new branch would look empty and its cases would pass).
      if (statements.length > fixtures.length) {
        throw new Error(
          `createMockD1 batch received ${statements.length} statements but only ${fixtures.length} fixture arrays are defined`,
        );
      }
      return Promise.resolve(statements.map((_statement, index) => ({ results: fixtures[index] ?? [] })));
    }),
    __prepared: prepared,
  } as unknown as D1Database;
}

function getPreparedCaptures(db: D1Database): PreparedCapture[] {
  return (db as unknown as { __prepared: PreparedCapture[] }).__prepared;
}

function createMockEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    SESSION: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ fetch: stubFetchMock })),
    },
    E2B_API_KEY: "test-e2b-key",
    SANDBOX_RUNTIME_CLEANUP_SECRET: "test-cleanup-secret",
    ...overrides,
  } as unknown as Env;
}

function runResponse(
  outcome: E2BRuntimeCleanupOutcome,
  reasonCode: E2BRuntimeCleanupReasonCode,
  runtimeSandboxId = "sb",
) {
  return new Response(
    JSON.stringify({ ok: true, outcome, reasonCode, runtimeSandboxId } satisfies E2BRuntimeCleanupRunResponse),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("cleanupExpiredE2BRuntimes", () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues exactly one cleanup-run call per candidate", async () => {
    const db = createMockD1([
      { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 },
    ]);
    const env = createMockEnv(db);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(env, NOW);

    expect(stubFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = stubFetchMock.mock.calls[0];
    expect(String(url)).toContain("/internal/runtime/e2b/cleanup-run");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      sessionId: "s1",
      projectedRuntimeSandboxId: "sb1",
      projectedRuntimeBackend: "e2b_cloud",
      reason: "paused_expired",
      nowMs: NOW,
    });
    expect(result.scanned).toBe(1);
  });

  it("maps a terminated clear to killed + cleared", async () => {
    const db = createMockD1([
      { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 },
    ]);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 1, killed: 1, cleared: 1, terminalDisabled: 0, errors: 0 });
  });

  it("maps a missing-sandbox clear to killed + cleared", async () => {
    const db = createMockD1([
      { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 },
    ]);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "missing_sandbox", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ killed: 1, cleared: 1, terminalDisabled: 0, errors: 0 });
  });

  it("maps a terminal_disabled clear to terminalDisabled (not killed)", async () => {
    const db = createMockD1([
      {
        session_id: "s1",
        runtime_sandbox_id: "sb1",
        runtime_backend: "e2b_cloud",
        candidate_at: NOW - 1000,
      },
    ]);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminal_disabled", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ killed: 0, cleared: 1, terminalDisabled: 1, errors: 0 });
  });

  it("maps a paused outcome to paused", async () => {
    const db = createMockD1(
      [],
      [{ session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 }],
    );
    stubFetchMock.mockResolvedValue(runResponse("paused", "paused", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ paused: 1, killed: 0, cleared: 0, errors: 0 });
  });

  it("does not tally counters for a skipped outcome", async () => {
    const db = createMockD1([
      { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 },
    ]);
    stubFetchMock.mockResolvedValue(runResponse("skipped", "skipped_sandbox_changed", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 1, paused: 0, killed: 0, cleared: 0, terminalDisabled: 0, errors: 0 });
  });

  it("counts retry_scheduled and terminal_failed as errors", async () => {
    const db = createMockD1(
      [{ session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 2000 }],
      [{ session_id: "s2", runtime_sandbox_id: "sb2", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 }],
    );
    stubFetchMock
      .mockResolvedValueOnce(runResponse("retry_scheduled", "terminate_failed_retry", "sb1"))
      .mockResolvedValueOnce(runResponse("terminal_failed", "terminal_failed_max_attempts", "sb2"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 2, errors: 2, cleared: 0 });
  });

  it("counts a failed DO call as an error without aborting the sweep", async () => {
    const db = createMockD1([
      { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 2000 },
      { session_id: "s2", runtime_sandbox_id: "sb2", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 },
    ]);
    stubFetchMock
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(runResponse("cleared", "terminated", "sb2"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 2, errors: 1, killed: 1, cleared: 1 });
  });

  it("dedupes a session that matches multiple candidate queries", async () => {
    const row = { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 };
    const db = createMockD1([row], [row], [row]);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(stubFetchMock).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
  });

  it("respects the batch limit and reports backlog", async () => {
    const rows: MockRow[] = Array.from({ length: 5 }, (_, i) => ({
      session_id: `s${i}`,
      runtime_sandbox_id: `sb${i}`,
      runtime_backend: "e2b_cloud",
      candidate_at: NOW - (100 - i),
    }));
    const db = createMockD1(rows);
    const env = createMockEnv(db, { E2B_RUNTIME_CLEANUP_BATCH_LIMIT: "2" });
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb"));

    const result = await cleanupExpiredE2BRuntimes(env, NOW);

    expect(result.scanned).toBe(2);
    expect(stubFetchMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Running-branch NULL-lease widening (deep-plan 6.2): in prod all e2b rows
  // carry a NULL live lease, so a running row only becomes a cleanup candidate
  // via the aged-created_at leg. The DO decision handler stays the authority and
  // returns skip for fresh activity, so selection-only widening is safe.
  // -------------------------------------------------------------------------

  it("selects a NULL-lease running row aged past retention and tags running_null_lease_aged", async () => {
    const db = createMockD1(
      [],
      [
        {
          session_id: "s1",
          runtime_sandbox_id: "sb1",
          runtime_backend: "e2b_cloud",
          candidate_at: NOW - 3_600_000,
          lease_was_null: 1,
        },
      ],
    );
    stubFetchMock.mockResolvedValue(runResponse("paused", "paused", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 1, paused: 1, errors: 0 });
    expect(stubFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = stubFetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reason).toBe("running_null_lease_aged");
  });

  it("does not select a NULL-lease running row that is still recent (no row from the query)", async () => {
    // A recent NULL-lease row fails the WHERE created_at < ? leg, so D1 returns
    // no running rows: the sweep makes no DO call.
    const db = createMockD1([], []);
    stubFetchMock.mockResolvedValue(runResponse("paused", "paused", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result.scanned).toBe(0);
    expect(stubFetchMock).not.toHaveBeenCalled();
  });

  it("gates the NULL-lease running leg on the live-lease age cutoff, not now", async () => {
    // The NULL-lease leg must bind `now - liveLease` so freshly
    // created runtimes are not selected and paused before their lease window.
    const db = createMockD1([], []);
    stubFetchMock.mockResolvedValue(runResponse("paused", "paused", "sb1"));

    await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    const running = getPreparedCaptures(db).find((p) => p.sql.includes("runtime_state = 'running'"));
    expect(running).toBeDefined();
    // First bind = live-lease-expired leg (now); second = NULL-lease age cutoff.
    expect(running?.binds).toEqual([NOW, NOW - E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT]);
  });

  it("still selects a non-null expired-lease running row and tags live_lease_expired", async () => {
    const db = createMockD1(
      [],
      [
        {
          session_id: "s1",
          runtime_sandbox_id: "sb1",
          runtime_backend: "e2b_cloud",
          candidate_at: NOW - 1000,
          lease_was_null: 0,
        },
      ],
    );
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 1, killed: 1, cleared: 1, errors: 0 });
    const [, init] = stubFetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reason).toBe("live_lease_expired");
  });

  it("leaves a NULL-lease row untouched when the DO returns skip", async () => {
    const db = createMockD1(
      [],
      [
        {
          session_id: "s1",
          runtime_sandbox_id: "sb1",
          runtime_backend: "e2b_cloud",
          candidate_at: NOW - 3_600_000,
          lease_was_null: 1,
        },
      ],
    );
    stubFetchMock.mockResolvedValue(runResponse("skipped", "skipped_live_activity", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(result).toMatchObject({ scanned: 1, paused: 0, killed: 0, cleared: 0, errors: 0 });
  });

  it("dedupes a NULL-lease row that also matches the malformed branch (single DO call)", async () => {
    const runningRow: MockRow = {
      session_id: "s1",
      runtime_sandbox_id: "sb1",
      runtime_backend: "e2b_cloud",
      candidate_at: NOW - 3_600_000,
      lease_was_null: 1,
    };
    const malformedRow: MockRow = {
      session_id: "s1",
      runtime_sandbox_id: "sb1",
      runtime_backend: "e2b_cloud",
      candidate_at: NOW - 3_600_000,
    };
    const db = createMockD1([], [runningRow], [malformedRow]);
    stubFetchMock.mockResolvedValue(runResponse("paused", "paused", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(stubFetchMock).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
    // running branch wins dedupe (added before malformed), tagging the distinct reason.
    const [, init] = stubFetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reason).toBe("running_null_lease_aged");
  });

  it("skips candidates with an unparseable runtime backend", async () => {
    const db = createMockD1([
      { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "not-a-backend", candidate_at: NOW - 1000 },
    ]);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(stubFetchMock).not.toHaveBeenCalled();
    expect(result.scanned).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Batch harness + killed sweep branch (R2). The candidate SELECTs now run
  // through one positional db.batch([...]); the fourth statement selects
  // `runtime_state = 'killed'` rows aged past KILLED_RUNTIME_REAP_GRACE_MS. The
  // DO re-decides live and its malformed/unknown-state fallthrough terminates.
  // -------------------------------------------------------------------------

  it("pins the candidate SELECT batch statement order (paused, running, malformed, killed)", async () => {
    const db = createMockD1();
    stubFetchMock.mockResolvedValue(runResponse("skipped", "skipped_not_e2b", "sb"));

    await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    const caps = getPreparedCaptures(db);
    // Batch results are positional, so the DO-side branch mapping depends on this
    // exact statement order — pin it.
    expect(caps).toHaveLength(4);
    expect(caps[0].sql).toContain("runtime_state = 'paused'");
    expect(caps[1].sql).toContain("runtime_state = 'running'");
    expect(caps[2].sql).toContain("runtime_state IS NULL");
    expect(caps[3].sql).toContain("runtime_state = 'killed'");
  });

  it("binds the killed sweep cutoff to now minus the reap grace (within-grace rows excluded)", async () => {
    const db = createMockD1();
    stubFetchMock.mockResolvedValue(runResponse("skipped", "skipped_not_e2b", "sb"));

    await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    const killed = getPreparedCaptures(db).find((p) => p.sql.includes("runtime_state = 'killed'"));
    expect(killed).toBeDefined();
    // A killed row is only eligible once its kill timestamp is older than the grace
    // window, so a transiently-killed-but-alive VM (ARC-1248) is not swept early.
    expect(killed?.binds).toEqual([NOW - KILLED_RUNTIME_REAP_GRACE_MS]);
    // NULL-expiry fallback: a killed row missing runtime_state_expires_at (drifted
    // future setter, damaged row) must still be sweepable — the grace anchors on
    // updated_at via COALESCE instead of the row being excluded forever.
    expect(killed?.sql).toContain("COALESCE(runtime_state_expires_at, updated_at)");
    expect(killed?.sql).not.toContain("runtime_state_expires_at IS NOT NULL");
  });

  it("selects a killed row past the grace window, tags killed_stale, and reaches the DO", async () => {
    const db = createMockD1(
      [],
      [],
      [],
      [
        {
          session_id: "s1",
          runtime_sandbox_id: "sb1",
          runtime_backend: "e2b_cloud",
          candidate_at: NOW - KILLED_RUNTIME_REAP_GRACE_MS - 1_000,
        },
      ],
    );
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(stubFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = stubFetchMock.mock.calls[0];
    expect(String(url)).toContain("/internal/runtime/e2b/cleanup-run");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ sessionId: "s1", projectedRuntimeSandboxId: "sb1", reason: "killed_stale" });
    // Tally mapping unchanged: a terminated clear counts as killed + cleared.
    expect(result).toMatchObject({ scanned: 1, killed: 1, cleared: 1, terminalDisabled: 0, errors: 0 });
  });

  it("dedupes a session that matches all four candidate branches (single DO call)", async () => {
    const row = { session_id: "s1", runtime_sandbox_id: "sb1", runtime_backend: "e2b_cloud", candidate_at: NOW - 1000 };
    const db = createMockD1([row], [row], [row], [row]);
    stubFetchMock.mockResolvedValue(runResponse("cleared", "terminated", "sb1"));

    const result = await cleanupExpiredE2BRuntimes(createMockEnv(db), NOW);

    expect(stubFetchMock).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
    // Paused branch is added first, so it wins dedupe and tags the reason.
    const [, init] = stubFetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reason).toBe("paused_expired");
  });

  it("the batch mock throws when more statements than fixture arrays are provided (masks no wiring regression)", () => {
    const db = createMockD1();
    const statements = Array.from({ length: 5 }, () => db.prepare("SELECT 1").bind());
    // A fifth candidate branch wired without extending the harness must fail loudly
    // rather than silently return [] for the unmapped statement.
    expect(() => db.batch(statements)).toThrow(/only 4 fixture arrays/);
  });
});
