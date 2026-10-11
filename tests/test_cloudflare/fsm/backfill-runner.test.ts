// ARC-1330 (PR 35A wiring) — the one-shot FSM backfill RUNNER.
//
// Proves the operational enumeration → per-session BackfillInput mapping → batch-insert orchestration
// that materializes `pr_coordination` rows for in-flight legacy sessions (the flip precondition + the
// divergence-soak cohort). The runner is dependency-injected (session loader + settings loader + session
// enumerator) so it is unit-testable without a Session DO; only the D1 insert path is real (sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveSessionRow,
  buildBackfillInputFromSession,
  DEFAULT_BACKFILL_STALE_CUTOFF_MS,
  listActiveSessionsForBackfill,
  normalizeSessionIndexTimestamp,
  runFsmBackfill,
} from "../../../apps/control-plane-worker/src/session/fsm/backfill-runner";
import { getPrCoordination } from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { SessionState } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

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

const NOW = 1_700_000_000_000;
/** Baseline opts: the default stale fence armed (rows in these tests carry a fresh `updatedAt: NOW`). */
const OPTS = { staleActivityCutoffMs: DEFAULT_BACKFILL_STALE_CUTOFF_MS };
/** An activity timestamp safely past the default cutoff — the fence must treat it as stale. */
const STALE_AT = NOW - DEFAULT_BACKFILL_STALE_CUTOFF_MS - 60_000;

function session(overrides: Partial<SessionState>): SessionState {
  return {
    sessionId: "sess-1",
    ownerUserId: "10",
    businessId: "biz-1",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    lastEventId: null,
    title: null,
    ...overrides,
  };
}

describe("buildBackfillInputFromSession", () => {
  it("maps a review_listening session into a BackfillInput carrying non-circular legacy signals", () => {
    const input = buildBackfillInputFromSession(
      "sess-1",
      "review_listening",
      session({
        reviewListeningPrUrl: "https://gh/x/pull/1",
        reviewListeningHeadSha: "h1",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationVerdictHeadSha: "h1",
        verificationAttemptCount: 2,
        businessId: "biz-1",
      }),
    );

    expect(input).not.toBeNull();
    expect(input!.phase).toBe("review_listening");
    expect(input!.prUrl).toBe("https://gh/x/pull/1");
    expect(input!.headSha).toBe("h1");
    expect(input!.verificationState).toBe("verification-done");
    expect(input!.verificationResult).toBe("merge-ready");
    expect(input!.reviewLoopDoneState).toBeNull();
    expect(input!.cycloidDone).toEqual({ state: "working", outcome: null, reasons: [] });
    expect(input!.verificationRunCount).toBe(2);
    expect(input!.verificationVerdictHeadSha).toBe("h1"); // the ARC-1243 settle anchor rides through
    expect(input!.ciFixRounds).toBe(0);
    expect(input!.businessId).toBe("biz-1");
  });

  it("preserves completed merge-ready PRs from direct verification signals", () => {
    const input = buildBackfillInputFromSession(
      "sess-1",
      "completed",
      session({
        reviewListeningPrUrl: "https://gh/x/pull/1",
        reviewListeningHeadSha: "h1",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationVerdictHeadSha: "h1",
      }),
    );

    expect(input).not.toBeNull();
    expect(input!.cycloidDone).toEqual({ state: "done", outcome: "success", reasons: [] });
  });

  it("returns null for an idle phase (no spine state)", () => {
    expect(buildBackfillInputFromSession("sess-1", "idle", session({}))).toBeNull();
  });

  it("returns null for an unknown/empty rich_status", () => {
    expect(buildBackfillInputFromSession("sess-1", "", session({}))).toBeNull();
  });
});

describe("runFsmBackfill", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const deps = (over: { rows?: ActiveSessionRow[]; sessions?: Record<string, SessionState | null> }) => {
    const sessions = over.sessions ?? {};
    return {
      deps: {
        db,
        now: () => NOW,
        listActiveSessions: vi.fn(async () => over.rows ?? []),
        loadSession: vi.fn(async (id: string) => sessions[id] ?? null),
      },
    };
  };

  it("materializes a pr_coordination row for an in-flight review_listening session", async () => {
    const { deps: d } = deps({
      rows: [{ sessionId: "sess-1", phase: "review_listening", ownerUserId: 10, updatedAt: NOW }],
      sessions: {
        "sess-1": session({ reviewListeningPrUrl: "https://gh/x/pull/1", reviewListeningHeadSha: "h1" }),
      },
    });

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.enumerated).toBe(1);
    expect(report.inserted).toBe(1);
    const row = await getPrCoordination(db, "sess-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("REVIEW");
    expect(row!.version).toBe(0);
  });

  it("materializes completed merge-ready PR sessions instead of skipping them as merged", async () => {
    const { deps: d } = deps({
      rows: [{ sessionId: "sess-1", phase: "completed", ownerUserId: 10, updatedAt: NOW }],
      sessions: {
        "sess-1": session({
          reviewListeningPrUrl: "https://gh/x/pull/1",
          reviewListeningHeadSha: "h1",
          verificationState: "verification-done",
          verificationResult: "merge-ready",
          verificationVerdictHeadSha: "h1",
        }),
      },
    });

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.inserted).toBe(1);
    const row = await getPrCoordination(db, "sess-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("MERGE_READY");
    expect(row!.verdictHeadSha).toBeNull(); // no settled-fresh stamping — adapter default
  });

  it("skips idle sessions (no spine state) and counts them separately", async () => {
    const { deps: d } = deps({
      rows: [
        { sessionId: "a", phase: "review_listening", ownerUserId: 10, updatedAt: NOW },
        { sessionId: "b", phase: "idle", ownerUserId: 10, updatedAt: NOW },
      ],
      sessions: { a: session({ sessionId: "a" }), b: session({ sessionId: "b" }) },
    });

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.enumerated).toBe(2);
    expect(report.skippedIdle).toBe(1);
    expect(report.inserted).toBe(1);
  });

  it("counts sessions whose DO lookup returns null as missingSession, never throwing", async () => {
    const { deps: d } = deps({
      rows: [{ sessionId: "gone", phase: "review_listening", ownerUserId: 10, updatedAt: NOW }],
      sessions: { gone: null },
    });

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.missingSession).toBe(1);
    expect(report.inserted).toBe(0);
  });

  it("is idempotent: a second run over the same session reports exists, not a second insert", async () => {
    const { deps: d } = deps({
      rows: [{ sessionId: "sess-1", phase: "review_listening", ownerUserId: 10, updatedAt: NOW }],
      sessions: { "sess-1": session({}) },
    });

    await runFsmBackfill(d, { ...OPTS });
    const second = await runFsmBackfill(d, { ...OPTS });

    expect(second.inserted).toBe(0);
    expect(second.exists).toBe(1);
  });

  it("dryRun classifies would-be inserts WITHOUT writing any row", async () => {
    const { deps: d } = deps({
      rows: [{ sessionId: "sess-1", phase: "review_listening", ownerUserId: 10, updatedAt: NOW }],
      sessions: { "sess-1": session({}) },
    });

    const report = await runFsmBackfill(d, { ...OPTS, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.inserted).toBe(1); // would-insert
    expect(await getPrCoordination(db, "sess-1")).toBeNull(); // nothing persisted
  });

  it("respects a limit, enumerating all but only processing the first N", async () => {
    const { deps: d } = deps({
      rows: [
        { sessionId: "a", phase: "review_listening", ownerUserId: 10, updatedAt: NOW },
        { sessionId: "b", phase: "review_listening", ownerUserId: 10, updatedAt: NOW },
      ],
      sessions: { a: session({ sessionId: "a" }), b: session({ sessionId: "b" }) },
    });

    const report = await runFsmBackfill(d, { ...OPTS, limit: 1 });

    expect(report.enumerated).toBe(2);
    expect(report.inserted).toBe(1);
  });
});

describe("runFsmBackfill — rebaseline mode (PR 46)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  const settledSession = () =>
    session({
      reviewListeningPrUrl: "https://gh/x/pull/1",
      reviewListeningHeadSha: "h1",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationVerdictHeadSha: "h1",
      verificationAttemptCount: 3,
    });

  const runnerDeps = () => ({
    db,
    now: () => NOW,
    listActiveSessions: async () => [
      { sessionId: "sess-1", phase: "review_listening", ownerUserId: 10, updatedAt: NOW },
    ],
    loadSession: async () => settledSession(),
  });

  it("rebaseline repairs an old-shape v0 row from current legacy state", async () => {
    // First pass: today's insert (which, pre-fix, would have seeded the broken shape; here we simulate
    // the broken cohort by mangling the row back to the old seed at version 0).
    await runFsmBackfill(runnerDeps(), { ...OPTS });
    sqlite
      .prepare(
        "UPDATE pr_coordination SET code_changed_since_verification = 0, verdict_head_sha = NULL, verification_run_count = 3 WHERE session_id = ?",
      )
      .run("sess-1");

    const report = await runFsmBackfill(runnerDeps(), { ...OPTS, rebaseline: true });

    expect(report.rebaselined).toBe(1);
    expect(report.inserted).toBe(0);
    const row = await getPrCoordination(db, "sess-1");
    expect(row!.version).toBe(0);
    expect(row!.verdictHeadSha).toBeNull(); // no settled-fresh stamping — adapter default
    expect(row!.codeChangedSinceVerification).toBe(false);
    expect(row!.verificationRunCount).toBe(3); // lifetime count carried raw
  });

  it("rebaseline dryRun classifies (would-rebaseline vs exists) WITHOUT writing", async () => {
    await runFsmBackfill(runnerDeps(), { ...OPTS }); // seed the v0 row
    const before = await getPrCoordination(db, "sess-1");

    const report = await runFsmBackfill(runnerDeps(), { ...OPTS, dryRun: true, rebaseline: true });

    expect(report.dryRun).toBe(true);
    expect(report.rebaselined).toBe(1); // would-rebaseline (row exists at v0)
    expect(report.inserted).toBe(0);
    expect(await getPrCoordination(db, "sess-1")).toEqual(before); // nothing written

    // A missing row classifies as would-insert in the same dry run mode.
    const fresh = asD1(createMigratedSqlite());
    const freshReport = await runFsmBackfill(
      { ...runnerDeps(), db: fresh },
      { ...OPTS, dryRun: true, rebaseline: true },
    );
    expect(freshReport.inserted).toBe(1);
    expect(freshReport.rebaselined).toBe(0);
    expect(await getPrCoordination(fresh, "sess-1")).toBeNull();
  });
});

describe("runFsmBackfill — stale-session fence (PR 46, Jag 2026-07-01)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  const row = (updatedAt: number | null): ActiveSessionRow => ({
    sessionId: "sess-1",
    phase: "review_listening",
    ownerUserId: 10,
    updatedAt,
  });

  const fenceDeps = (over: { db?: D1Database; rows?: ActiveSessionRow[] } = {}) => {
    const loadSession = vi.fn(async () => session({ reviewListeningPrUrl: "https://gh/x/pull/1" }));
    return {
      deps: {
        db: over.db ?? db,
        now: () => NOW,
        listActiveSessions: async () => over.rows ?? [row(STALE_AT)],
        loadSession,
      },
      loadSession,
    };
  };

  it("fence skips a stale session: no row written, the DO is never even loaded", async () => {
    const { deps: d, loadSession } = fenceDeps();

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.skippedStale).toBe(1);
    expect(report.inserted).toBe(0);
    expect(await getPrCoordination(db, "sess-1")).toBeNull(); // frozen at live: no_record → no-op forever
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("a fresh session passes the fence and materializes normally", async () => {
    const { deps: d } = fenceDeps({ rows: [row(NOW - DEFAULT_BACKFILL_STALE_CUTOFF_MS + 60_000)] });

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.skippedStale).toBe(0);
    expect(report.inserted).toBe(1);
    expect(await getPrCoordination(db, "sess-1")).not.toBeNull();
  });

  it("an unparseable activity timestamp counts as stale (the fence fails closed)", async () => {
    const { deps: d } = fenceDeps({ rows: [row(null)] });

    const report = await runFsmBackfill(d, { ...OPTS });

    expect(report.skippedStale).toBe(1);
    expect(report.inserted).toBe(0);
  });

  it("cutoff disabled (null) materializes a stale session — the deliberate-manual-backfill escape hatch", async () => {
    const { deps: d } = fenceDeps();

    const report = await runFsmBackfill(d, { staleActivityCutoffMs: null });

    expect(report.skippedStale).toBe(0);
    expect(report.inserted).toBe(1);
    expect(await getPrCoordination(db, "sess-1")).not.toBeNull();
  });

  it("rebaseline DELETES a stale session's v0 seed row (removed_stale) but REPAIRS a fresh one (rebaselined)", async () => {
    // Seed two v0 rows via the fence-off path, then rebaseline with the fence armed: the stale
    // session's seed is pruned back to frozen no-record; the fresh session's seed is repaired in place.
    const rows = [
      { ...row(STALE_AT), sessionId: "stale-1" },
      { ...row(NOW), sessionId: "fresh-1" },
    ];
    const { deps: seed } = fenceDeps({ rows });
    await runFsmBackfill(seed, { staleActivityCutoffMs: null });
    expect(await getPrCoordination(db, "stale-1")).not.toBeNull();

    const { deps: d } = fenceDeps({ rows });
    const report = await runFsmBackfill(d, { ...OPTS, rebaseline: true });

    expect(report.removedStale).toBe(1);
    expect(report.rebaselined).toBe(1);
    expect(await getPrCoordination(db, "stale-1")).toBeNull(); // seed-only content — nothing lost
    expect((await getPrCoordination(db, "fresh-1"))!.version).toBe(0);
  });

  it("rebaseline never deletes a producer-advanced row: stale + version >= 1 reports exists, untouched", async () => {
    const { deps: seed } = fenceDeps();
    await runFsmBackfill(seed, { staleActivityCutoffMs: null });
    sqlite.prepare("UPDATE pr_coordination SET version = 1 WHERE session_id = 'sess-1'").run();

    const { deps: d } = fenceDeps();
    const report = await runFsmBackfill(d, { ...OPTS, rebaseline: true });

    expect(report.removedStale).toBe(0);
    expect(report.exists).toBe(1);
    expect((await getPrCoordination(db, "sess-1"))!.version).toBe(1); // real spine history survives
  });

  it("race guard: a producer bumping the version BETWEEN the read and the delete wins (row survives, exists)", async () => {
    const { deps: seed } = fenceDeps();
    await runFsmBackfill(seed, { staleActivityCutoffMs: null });

    // Rig the DB so the moment the runner issues its DELETE, a producer has already CASed the row —
    // the read saw version 0, but the DELETE's own `version = 0` predicate must lose cleanly.
    const rigged = {
      prepare(query: string) {
        if (query.includes("DELETE FROM pr_coordination")) {
          sqlite.prepare("UPDATE pr_coordination SET version = version + 1 WHERE session_id = 'sess-1'").run();
        }
        return (db as unknown as { prepare: (q: string) => unknown }).prepare(query);
      },
    } as unknown as D1Database;

    const { deps: d } = fenceDeps({ db: rigged });
    const report = await runFsmBackfill(d, { ...OPTS, rebaseline: true });

    expect(report.removedStale).toBe(0);
    expect(report.exists).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.version).toBe(1); // the producer's row survives the losing delete
  });

  it("dryRun classifies removed_stale and skipped_stale WITHOUT deleting or writing", async () => {
    const rows = [
      { ...row(STALE_AT), sessionId: "stale-seeded" }, // has a v0 row → would delete
      { ...row(STALE_AT), sessionId: "stale-bare" }, // no row → already frozen
      { ...row(NOW), sessionId: "fresh-bare" }, // no row → would insert
    ];
    const { deps: seed } = fenceDeps({ rows: [{ ...row(STALE_AT), sessionId: "stale-seeded" }] });
    await runFsmBackfill(seed, { staleActivityCutoffMs: null });
    const before = await getPrCoordination(db, "stale-seeded");

    const { deps: d } = fenceDeps({ rows });
    const report = await runFsmBackfill(d, { ...OPTS, dryRun: true, rebaseline: true });

    expect(report.dryRun).toBe(true);
    expect(report.removedStale).toBe(1); // would-delete
    expect(report.skippedStale).toBe(1); // already frozen
    expect(report.inserted).toBe(1); // would-insert
    expect(await getPrCoordination(db, "stale-seeded")).toEqual(before); // nothing deleted
    expect(await getPrCoordination(db, "fresh-bare")).toBeNull(); // nothing written
  });
});

describe("listActiveSessionsForBackfill", () => {
  const insertSessionIndex = async (
    db: D1Database,
    id: string,
    richStatus: string,
    status = "active",
    updatedAt: number | string = 0,
  ) => {
    await db
      .prepare(
        `INSERT INTO session_index (session_id, owner_user_id, status, created_at, updated_at, business_id, rich_status)
         VALUES (?, 10, ?, 0, ?, 'biz', ?)`,
      )
      .bind(id, status, updatedAt, richStatus)
      .run();
  };

  it("enumerates all active sessions when no phase filter is given", async () => {
    const db = asD1(createMigratedSqlite());
    await insertSessionIndex(db, "rl", "review_listening");
    await insertSessionIndex(db, "stopped", "stopped");
    await insertSessionIndex(db, "gone", "review_listening", "archived"); // not active

    const rows = await listActiveSessionsForBackfill(db);

    expect(rows.map((r) => r.sessionId).sort()).toEqual(["rl", "stopped"]);
  });

  it("scopes to a single phase when phase is given (the soak-cohort run)", async () => {
    const db = asD1(createMigratedSqlite());
    await insertSessionIndex(db, "rl1", "review_listening");
    await insertSessionIndex(db, "rl2", "review_listening");
    await insertSessionIndex(db, "stopped", "stopped");
    await insertSessionIndex(db, "running", "running");

    const rows = await listActiveSessionsForBackfill(db, { phase: "review_listening" });

    expect(rows.map((r) => r.sessionId).sort()).toEqual(["rl1", "rl2"]);
    expect(rows.every((r) => r.phase === "review_listening")).toBe(true);
  });

  it("normalizes updated_at to epoch ms — prod stores BOTH ISO strings and epoch-ms integers", async () => {
    const db = asD1(createMigratedSqlite());
    await insertSessionIndex(db, "iso", "review_listening", "active", "2023-11-14T22:13:20.000Z"); // = NOW
    await insertSessionIndex(db, "ms", "review_listening", "active", NOW);

    const rows = await listActiveSessionsForBackfill(db);
    const byId = new Map(rows.map((r) => [r.sessionId, r.updatedAt]));

    expect(byId.get("iso")).toBe(NOW);
    expect(byId.get("ms")).toBe(NOW);
  });
});

describe("normalizeSessionIndexTimestamp", () => {
  it("passes epoch-ms numbers through and parses ISO-8601 strings", () => {
    expect(normalizeSessionIndexTimestamp(NOW)).toBe(NOW);
    expect(normalizeSessionIndexTimestamp("2023-11-14T22:13:20.000Z")).toBe(NOW);
  });

  it("returns null for unparseable values (the fence fails closed on null)", () => {
    expect(normalizeSessionIndexTimestamp(null)).toBeNull();
    expect(normalizeSessionIndexTimestamp("")).toBeNull();
    expect(normalizeSessionIndexTimestamp("not-a-date")).toBeNull();
    expect(normalizeSessionIndexTimestamp(Number.NaN)).toBeNull();
  });
});
