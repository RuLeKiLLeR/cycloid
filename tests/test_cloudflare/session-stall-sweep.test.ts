// Session-stall sweep: the DAO aggregate (readActiveStateDwell) over a migrated
// pr_coordination table, and the pure gauge projection (computeStallGauges).
// Guards the live-stall signal that the transition-based fsm.stage_dwell_ms
// cannot emit (a wedged session never transitions).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionStubFetch = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionStub: () => ({ fetch: sessionStubFetch }),
}));

import {
  FINALIZING_STALL_THRESHOLD_MS,
  PRE_PUBLISH_STALL_BACKSTOP_MS,
} from "../../apps/control-plane-worker/src/constants/session-stall";
import {
  computeStallGauges,
  computeVerificationStallGauges,
  runSessionStallSweep,
  type StallGaugeResult,
} from "../../apps/control-plane-worker/src/services/session-stall-sweep";
import {
  insertPrCoordination,
  listStalledPrePublishCandidates,
  type PrCoordinationRecord,
  readActiveStateDwell,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import { readActiveVerificationAge } from "../../apps/control-plane-worker/src/session/session-stall-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function record(overrides: Partial<PrCoordinationRecord>): PrCoordinationRecord {
  return {
    sessionId: "sess",
    version: 1,
    state: "FINALIZING",
    prUrl: null,
    headSha: null,
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: 1_000_000,
    ...overrides,
  };
}

async function insertSessionIndex(
  db: D1Database,
  input: {
    sessionId: string;
    status?: string;
    createdAt?: string | number;
    richStatus?: string | null;
    agentRole?: string | null;
    planApprovalPending?: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO session_index
         (session_id, owner_user_id, business_id, status, created_at, updated_at, rich_status, agent_role,
          plan_approval_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.sessionId,
      1,
      "biz",
      input.status ?? "active",
      input.createdAt ?? 1000,
      input.createdAt ?? 1000,
      input.richStatus ?? null,
      input.agentRole ?? null,
      input.planApprovalPending ? 1 : 0,
    )
    .run();
}

async function insertActivePrCoordination(db: D1Database, input: PrCoordinationRecord): Promise<void> {
  await insertSessionIndex(db, { sessionId: input.sessionId });
  await insertPrCoordination(db, input);
}

describe("readActiveStateDwell", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("returns per-state count, the OLDEST state_entered_at, and the past-cutoff stalled count", async () => {
    await insertActivePrCoordination(db, record({ sessionId: "a", state: "FINALIZING", stateEnteredAt: 5000 }));
    await insertActivePrCoordination(db, record({ sessionId: "b", state: "FINALIZING", stateEnteredAt: 2000 }));
    await insertActivePrCoordination(db, record({ sessionId: "c", state: "GENERATING", stateEnteredAt: 9000 }));

    // cutoff = 3000: only b (2000) is at/older than the cutoff → stalled; a (5000) and c (9000) are not.
    const rows = await readActiveStateDwell(db, ["FINALIZING", "GENERATING", "PUBLISHING"], 10_000, 3000);
    const byState = Object.fromEntries(rows.map((r) => [r.state, r]));

    expect(byState.FINALIZING).toEqual({ state: "FINALIZING", count: 2, oldestEnteredAt: 2000, stalledCount: 1 });
    expect(byState.GENERATING).toEqual({ state: "GENERATING", count: 1, oldestEnteredAt: 9000, stalledCount: 0 });
    expect(byState.PUBLISHING).toBeUndefined(); // no rows
  });

  it("counts only sessions past the stall cutoff, not every session in the state", async () => {
    // 1 wedged + 3 that just entered FINALIZING. count=4, but only the wedged one is stalled.
    await insertActivePrCoordination(db, record({ sessionId: "wedged", state: "FINALIZING", stateEnteredAt: 1000 }));
    await insertActivePrCoordination(db, record({ sessionId: "fresh1", state: "FINALIZING", stateEnteredAt: 9000 }));
    await insertActivePrCoordination(db, record({ sessionId: "fresh2", state: "FINALIZING", stateEnteredAt: 9500 }));
    await insertActivePrCoordination(db, record({ sessionId: "fresh3", state: "FINALIZING", stateEnteredAt: 9900 }));

    const rows = await readActiveStateDwell(db, ["FINALIZING"], 10_000, 5000);
    expect(rows).toEqual([{ state: "FINALIZING", count: 4, oldestEnteredAt: 1000, stalledCount: 1 }]);
  });

  it("excludes rows with a null/0 state_entered_at anchor (shadow/legacy)", async () => {
    await insertActivePrCoordination(db, record({ sessionId: "live", state: "FINALIZING", stateEnteredAt: 3000 }));
    await insertActivePrCoordination(db, record({ sessionId: "shadow", state: "FINALIZING", stateEnteredAt: null }));

    const rows = await readActiveStateDwell(db, ["FINALIZING"], 10_000, 0);
    expect(rows).toEqual([{ state: "FINALIZING", count: 1, oldestEnteredAt: 3000, stalledCount: 0 }]);
  });

  it("excludes archived session rows so closed sessions cannot page as live stalls", async () => {
    await insertSessionIndex(db, { sessionId: "archived", status: "archived" });
    await insertSessionIndex(db, { sessionId: "live" });
    await insertPrCoordination(db, record({ sessionId: "archived", state: "FINALIZING", stateEnteredAt: 1000 }));
    await insertPrCoordination(db, record({ sessionId: "live", state: "FINALIZING", stateEnteredAt: 4000 }));

    const rows = await readActiveStateDwell(db, ["FINALIZING"], 10_000, 5000);
    expect(rows).toEqual([{ state: "FINALIZING", count: 1, oldestEnteredAt: 4000, stalledCount: 1 }]);
  });

  it("still counts a stall-state row with no session_index row (fails open, not blind)", async () => {
    // A pr_coordination row whose session has no session_index entry (missing/lagging index) must still
    // surface as a live stall: the LEFT JOIN + null-safe archived check fails OPEN so the monitor cannot go
    // blind on a genuine wedge. Regression guard against reverting to an INNER JOIN / bare `!= 'archived'`.
    await insertPrCoordination(db, record({ sessionId: "orphan", state: "FINALIZING", stateEnteredAt: 1000 }));
    await insertActivePrCoordination(db, record({ sessionId: "fresh", state: "FINALIZING", stateEnteredAt: 9000 }));

    const rows = await readActiveStateDwell(db, ["FINALIZING"], 10_000, 5000);
    expect(rows).toEqual([{ state: "FINALIZING", count: 2, oldestEnteredAt: 1000, stalledCount: 1 }]);
  });

  it("returns empty for no requested states", async () => {
    expect(await readActiveStateDwell(db, [], 10_000, 0)).toEqual([]);
  });
});

describe("readActiveVerificationAge", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("measures total live verifier age and excludes terminal/non-verifier rows", async () => {
    await insertSessionIndex(db, {
      sessionId: "old-verifier",
      createdAt: new Date(1_000).toISOString(),
      agentRole: "verification",
      richStatus: "running",
    });
    await insertSessionIndex(db, {
      sessionId: "fresh-verifier",
      createdAt: new Date(9_000).toISOString(),
      agentRole: "verification",
      richStatus: "running",
    });
    await insertSessionIndex(db, {
      sessionId: "completed-verifier",
      createdAt: new Date(500).toISOString(),
      agentRole: "verification",
      richStatus: "completed",
    });
    await insertSessionIndex(db, {
      sessionId: "implementation",
      createdAt: new Date(200).toISOString(),
      agentRole: "implementation",
      richStatus: "running",
    });

    expect(await readActiveVerificationAge(db, 5_000)).toEqual({
      count: 2,
      stalledCount: 1,
      oldestCreatedAt: 1_000,
      oldestSessionId: "old-verifier",
      unanchoredCount: 0,
    });
  });

  it("surfaces malformed created_at anchors instead of treating them as zero-age", async () => {
    await insertSessionIndex(db, {
      sessionId: "bad-anchor",
      createdAt: "not-a-date",
      agentRole: "verification",
      richStatus: "running",
    });
    expect(await readActiveVerificationAge(db, 5_000)).toEqual({
      count: 1,
      stalledCount: 0,
      oldestCreatedAt: null,
      oldestSessionId: null,
      unanchoredCount: 1,
    });
  });
});

describe("listStalledPrePublishCandidates", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("enumerates only active, unparked sessions beyond the hard backstop", async () => {
    const now = 10_000_000;
    const cutoff = now - PRE_PUBLISH_STALL_BACKSTOP_MS;
    await insertActivePrCoordination(db, record({ sessionId: "oldest", state: "CREATED", stateEnteredAt: cutoff - 2 }));
    await insertActivePrCoordination(
      db,
      record({ sessionId: "at-cutoff", state: "GENERATING", stateEnteredAt: cutoff }),
    );
    await insertActivePrCoordination(
      db,
      record({ sessionId: "fresh", state: "FINALIZING", stateEnteredAt: cutoff + 1 }),
    );
    await insertSessionIndex(db, { sessionId: "archived", status: "archived" });
    await insertPrCoordination(db, record({ sessionId: "archived", state: "PUBLISHING", stateEnteredAt: cutoff - 3 }));
    await insertSessionIndex(db, { sessionId: "parked", planApprovalPending: true });
    await insertPrCoordination(db, record({ sessionId: "parked", state: "GENERATING", stateEnteredAt: cutoff - 4 }));

    expect(
      await listStalledPrePublishCandidates(db, ["CREATED", "GENERATING", "FINALIZING", "PUBLISHING"], cutoff, 10),
    ).toEqual([
      { sessionId: "oldest", state: "CREATED", stateEnteredAt: cutoff - 2 },
      { sessionId: "at-cutoff", state: "GENERATING", stateEnteredAt: cutoff },
    ]);
  });

  it("fails closed on a missing session index row and bounds the batch", async () => {
    await insertPrCoordination(db, record({ sessionId: "orphan", state: "CREATED", stateEnteredAt: 1 }));
    await insertActivePrCoordination(db, record({ sessionId: "b", state: "CREATED", stateEnteredAt: 2 }));
    await insertActivePrCoordination(db, record({ sessionId: "c", state: "CREATED", stateEnteredAt: 3 }));

    expect(await listStalledPrePublishCandidates(db, ["CREATED"], 5, 1)).toEqual([
      { sessionId: "b", state: "CREATED", stateEnteredAt: 2 },
    ]);
  });
});

describe("computeStallGauges", () => {
  const env = { WORKER_ENV: "production" };

  it("emits an oldest-age gauge per state and a stalled_count only past threshold", () => {
    const now = 100 * 60_000; // 100 min in ms
    const stalledEnteredAt = now - (FINALIZING_STALL_THRESHOLD_MS + 60_000); // 1 min past threshold
    const freshEnteredAt = now - 60_000; // 1 min old

    // FINALIZING has 5 sessions in state but only 1 past the cutoff (stalledCount) — the gauge must
    // report 1, not 5. GENERATING has a fresh anchor and 0 stalled.
    const result: StallGaugeResult = computeStallGauges(
      env,
      [
        { state: "FINALIZING", count: 5, oldestEnteredAt: stalledEnteredAt, stalledCount: 1 },
        { state: "GENERATING", count: 1, oldestEnteredAt: freshEnteredAt, stalledCount: 0 },
      ],
      now,
    );

    const dwell = result.series.filter((s) => s.metric === "arcanist.session.state_dwell_oldest_ms");
    const stalledCount = result.series.filter((s) => s.metric === "arcanist.session.stalled_count");

    // oldest-age gauge for BOTH states
    expect(dwell).toHaveLength(2);
    expect(dwell.find((s) => s.tags.includes("state:finalizing"))?.value).toBe(FINALIZING_STALL_THRESHOLD_MS + 60_000);
    expect(dwell.find((s) => s.tags.includes("state:generating"))?.value).toBe(60_000);

    // stalled_count only for the state past threshold, and it reports the precise stalled count (1), not count (5)
    expect(stalledCount).toHaveLength(1);
    expect(stalledCount[0].tags).toContain("state:finalizing");
    expect(stalledCount[0].value).toBe(1);

    expect(result.stalled).toEqual([
      { state: "FINALIZING", oldestAgeMs: FINALIZING_STALL_THRESHOLD_MS + 60_000, count: 5, stalledCount: 1 },
    ]);
  });

  it("carries the base control-plane tags and clamps negative ages to 0", () => {
    const now = 10_000;
    const result = computeStallGauges(
      env,
      [{ state: "PUBLISHING", count: 1, oldestEnteredAt: now + 5000, stalledCount: 0 }],
      now,
    );
    expect(result.series).toHaveLength(1);
    expect(result.series[0].value).toBe(0);
    expect(result.series[0].tags).toEqual(
      expect.arrayContaining([
        "service:cycloid-control-plane",
        "worker:control-plane",
        "env:production",
        "state:publishing",
      ]),
    );
    expect(result.stalled).toEqual([]);
  });
});

describe("computeVerificationStallGauges", () => {
  it("emits total age and a sparse over-budget count without session-id metric tags", () => {
    const result = computeVerificationStallGauges(
      { WORKER_ENV: "production" },
      {
        count: 2,
        stalledCount: 1,
        oldestCreatedAt: 1_000,
        oldestSessionId: "verifier-1",
        unanchoredCount: 0,
      },
      601_000,
    );
    expect(result.oldestAgeMs).toBe(600_000);
    expect(result.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "arcanist.verification.session_age_oldest_ms", value: 600_000 }),
        expect.objectContaining({ metric: "arcanist.verification.session_stalled_count", value: 1 }),
      ]),
    );
    expect(result.series.flatMap((entry) => entry.tags).some((tag) => tag.startsWith("session_id:"))).toBe(false);
  });
});

describe("runSessionStallSweep recovery", () => {
  beforeEach(() => {
    sessionStubFetch.mockReset();
  });

  it("asks each hard-stalled session DO to recheck and terminalize", async () => {
    const db = asD1(createMigratedSqlite());
    await insertActivePrCoordination(
      db,
      record({
        sessionId: "wedged",
        state: "PROVISIONING",
        stateEnteredAt: Date.now() - PRE_PUBLISH_STALL_BACKSTOP_MS - 1_000,
      }),
    );
    sessionStubFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, terminalized: true, reason: "stalled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runSessionStallSweep(
      {
        DB: db,
        WORKER_ENV: "test",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "cleanup-secret",
      } as never,
      { logger: logger as never },
    );

    expect(result).toEqual({ scanned: 1, terminalized: 1, skipped: 0, errors: 0 });
    expect(sessionStubFetch).toHaveBeenCalledOnce();
    const [url, init] = sessionStubFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://internal/internal/session/pre-publish-stall-fail");
    expect(init.headers).toMatchObject({ authorization: "Bearer cleanup-secret" });
    expect(JSON.parse(init.body as string)).toMatchObject({ sessionId: "wedged" });
  });
});
