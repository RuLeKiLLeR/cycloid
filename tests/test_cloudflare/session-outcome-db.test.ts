import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { querySessionOutcomeHarm } from "../../apps/control-plane-worker/src/services/observability";
import {
  recordSessionOutcome,
  type SessionOutcomeRow,
} from "../../apps/control-plane-worker/src/session/session-outcome-db";

// Minimal D1-over-better-sqlite3 shim (mirrors review-loop-ci-cap-dao.test.ts).
class SqliteD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

function applySessionOutcomeSchema(target: Database.Database): void {
  target.exec(readFileSync("apps/control-plane-worker/migrations/0172_session_outcomes.sql", "utf8"));
  target.exec(readFileSync("apps/control-plane-worker/migrations/0174_session_outcome_termination_reason.sql", "utf8"));
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySessionOutcomeSchema(sqlite);
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

function row(overrides: Partial<SessionOutcomeRow> & { sessionId: string }): SessionOutcomeRow {
  return {
    ownerUserId: "user-1",
    businessId: "biz-1",
    repo: "acme/repo",
    sessionKind: "repo",
    outcome: "succeeded",
    reachedTerminal: true,
    terminalStage: "pr_created",
    failureCause: null,
    closeReason: "user_closed",
    prCreated: true,
    promptCount: 1,
    completedPromptCount: 1,
    failedPromptCount: 0,
    createdAtMs: 1_000,
    recordedAtMs: 2_000,
    terminationReason: null,
    ...overrides,
  };
}

describe("recordSessionOutcome", () => {
  it("persists one row per session and is idempotent (deduped by session_id)", async () => {
    await recordSessionOutcome(db, row({ sessionId: "s1", outcome: "failed", failureCause: "sandbox_disconnected" }));
    // Re-close with a more-accurate terminal overwrites in place, not a second row.
    await recordSessionOutcome(db, row({ sessionId: "s1", outcome: "succeeded", failureCause: null }));

    const all = sqlite.prepare("SELECT * FROM session_outcomes").all() as Array<Record<string, unknown>>;
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe("succeeded");
    expect(all[0].failure_cause).toBeNull();
    expect(all[0].reached_terminal).toBe(1);
  });

  it("stores booleans as integers", async () => {
    await recordSessionOutcome(
      db,
      row({ sessionId: "s2", reachedTerminal: false, prCreated: false, outcome: "failed", failureCause: "unknown" }),
    );
    const stored = sqlite
      .prepare("SELECT reached_terminal, pr_created FROM session_outcomes WHERE session_id = ?")
      .get("s2") as {
      reached_terminal: number;
      pr_created: number;
    };
    expect(stored.reached_terminal).toBe(0);
    expect(stored.pr_created).toBe(0);
  });

  it("persists the server-side termination reason (null until the producer threads it in)", async () => {
    await recordSessionOutcome(
      db,
      row({ sessionId: "t1", outcome: "failed", failureCause: "unknown", terminationReason: "orphan_reaper" }),
    );
    await recordSessionOutcome(db, row({ sessionId: "t2", outcome: "abandoned", failureCause: null }));
    const rows = sqlite
      .prepare("SELECT session_id, termination_reason FROM session_outcomes ORDER BY session_id")
      .all() as Array<{ session_id: string; termination_reason: string | null }>;
    expect(rows).toEqual([
      { session_id: "t1", termination_reason: "orphan_reaper" },
      { session_id: "t2", termination_reason: null },
    ]);
  });
});

describe("querySessionOutcomeHarm", () => {
  beforeEach(async () => {
    await recordSessionOutcome(db, row({ sessionId: "ok1", outcome: "succeeded", recordedAtMs: 100 }));
    await recordSessionOutcome(db, row({ sessionId: "ok2", outcome: "succeeded", recordedAtMs: 200 }));
    await recordSessionOutcome(
      db,
      row({ sessionId: "f1", outcome: "failed", failureCause: "sandbox_disconnected", recordedAtMs: 300 }),
    );
    await recordSessionOutcome(
      db,
      row({ sessionId: "f2", outcome: "failed", failureCause: "sandbox_disconnected", recordedAtMs: 400 }),
    );
    await recordSessionOutcome(
      db,
      row({ sessionId: "f3", outcome: "failed", failureCause: "spawn_timeout", recordedAtMs: 500 }),
    );
    // Abandoned must not move the harm rate.
    await recordSessionOutcome(
      db,
      row({ sessionId: "ab1", outcome: "abandoned", failureCause: null, recordedAtMs: 600 }),
    );
  });

  it("ranks failure causes by distinct failed sessions and excludes abandoned from the rate", async () => {
    const result = await querySessionOutcomeHarm(db, {});
    expect(result.totals).toMatchObject({ total: 6, succeeded: 2, failed: 3, abandoned: 1 });
    // harm rate = failed / (succeeded + failed) = 3/5, abandoned excluded.
    expect(result.totals.harmRate).toBeCloseTo(0.6);
    expect(result.byCause).toEqual([
      { failureCause: "sandbox_disconnected", failedSessions: 2 },
      { failureCause: "spawn_timeout", failedSessions: 1 },
    ]);
  });

  it("filters by recorded_at range", async () => {
    const result = await querySessionOutcomeHarm(db, { createdAfter: 350, createdBefore: 550 });
    // Only f2 (400) and f3 (500) fall in range.
    expect(result.totals).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
    expect(result.totals.harmRate).toBeCloseTo(1);
    expect(result.byCause).toEqual([
      { failureCause: "sandbox_disconnected", failedSessions: 1 },
      { failureCause: "spawn_timeout", failedSessions: 1 },
    ]);
  });

  it("returns a null harm rate when no session attempted work", async () => {
    const empty = new SqliteD1(new Database(":memory:")) as unknown as D1Database;
    applySessionOutcomeSchema((empty as unknown as SqliteD1).db);
    const result = await querySessionOutcomeHarm(empty, {});
    expect(result.totals.total).toBe(0);
    expect(result.totals.harmRate).toBeNull();
    expect(result.byCause).toEqual([]);
  });
});
