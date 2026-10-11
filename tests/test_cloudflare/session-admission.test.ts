import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { admitSessionCreate } from "../../apps/control-plane-worker/src/services/session-admission";
import { countActiveSessionsForBusiness } from "../../apps/control-plane-worker/src/session/db";
import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  MAX_ACTIVE_SESSIONS_PER_BUSINESS,
  SESSION_CREATE_RATE_LIMIT_MAX,
  SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS,
} from "../../shared/constants/session";
import { TERMINAL_PHASES_ARRAY } from "../../shared/session/phase";

// Fake SessionResumeRateLimiterDO: returns a fixed allow/deny verdict in the
// shape checkDurableObjectRateLimit expects. `undefined` exercises the fail-open
// path (limiter backend absent -> request allowed).
function makeRateLimitEnv(allowed: boolean | "absent"): Pick<Env, "SESSION_RESUME_RATE_LIMITER"> {
  if (allowed === "absent") return { SESSION_RESUME_RATE_LIMITER: undefined as never };
  return {
    SESSION_RESUME_RATE_LIMITER: {
      idFromName: () => ({}) as never,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, allowed, remaining: allowed ? 5 : 0 }), { status: 200 }),
      }),
    } as unknown as Env["SESSION_RESUME_RATE_LIMITER"],
  };
}

// Minimal D1 shim over better-sqlite3 so the COUNT runs against the real query
// planner and the real active predicate, not a mock.
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
  async run(): Promise<{ meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { meta: { changes: info.changes } };
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
let nextId = 0;

function insertSession(businessId: string | null, status: string, richStatus: string | null = null): void {
  nextId += 1;
  sqlite
    .prepare(
      "INSERT INTO session_index (session_id, created_at, business_id, status, rich_status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`s-${nextId}`, String(1700000000000 + nextId), businessId, status, richStatus);
}

beforeEach(() => {
  nextId = 0;
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      business_id TEXT,
      status TEXT NOT NULL,
      rich_status TEXT
    );
  `);
  // The migration under test, loaded from disk so the test exercises the real DDL.
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0194_session_active_cap_index.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("countActiveSessionsForBusiness", () => {
  it("counts only active (non-closed, non-archived) sessions for the business", () => {
    insertSession("biz-1", "active");
    insertSession("biz-1", "active");
    insertSession("biz-1", "closed"); // excluded
    insertSession("biz-1", "archived"); // excluded
    insertSession("biz-2", "active"); // other business, excluded

    return expect(countActiveSessionsForBusiness(db, "biz-1")).resolves.toBe(2);
  });

  it("counts compute-holding phases (idle/running, and rich_status NULL idle/fresh) as active", async () => {
    // `status` only holds active/closed/archived; the lifecycle phase lives in
    // `rich_status`. A running session and a fresh session with no rich_status
    // yet (derives to idle) both count.
    insertSession("biz-1", "active", "running");
    insertSession("biz-1", "active", null);
    insertSession("biz-1", "active", "idle");
    expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(3);
  });

  it("does not count review_listening sessions against the compute cap", async () => {
    insertSession("biz-1", "active", "review_listening");
    insertSession("biz-1", "active", "running");
    insertSession("biz-1", "active", "idle");

    expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(2);
  });

  it("does not count terminal-phase rows that still have status='active'", async () => {
    // A finished session keeps status='active' until explicitly closed; its
    // terminal rich_status must free a cap slot. Iterate the canonical set so a
    // future terminal phase cannot silently slip through an undertested subset.
    for (const phase of TERMINAL_PHASES_ARRAY) insertSession("biz-1", "active", phase);
    insertSession("biz-1", "active", "running"); // one genuinely live session
    expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(1);
  });

  it("admits when terminal-phase rows would otherwise inflate the count past the cap", async () => {
    // Regression: N stale terminal rows + M live rows must admit while M < cap,
    // even when N + M >= cap.
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS; i += 1) insertSession("biz-1", "active", "completed");
    insertSession("biz-1", "active", "running");
    expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(1);
    expect(await admitSessionCreate({ db, env: makeRateLimitEnv(true), businessId: "biz-1" })).toEqual({ ok: true });
  });

  it("admits when review_listening rows would otherwise inflate the count past the cap", async () => {
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS; i += 1) {
      insertSession("biz-1", "active", "review_listening");
    }
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS - 1; i += 1) {
      insertSession("biz-1", "active", "running");
    }

    expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(MAX_ACTIVE_SESSIONS_PER_BUSINESS - 1);
    expect(await admitSessionCreate({ db, env: makeRateLimitEnv(true), businessId: "biz-1" })).toEqual({ ok: true });
  });

  it("returns 0 for an unknown business and for an empty business id", async () => {
    insertSession("biz-1", "active");
    expect(await countActiveSessionsForBusiness(db, "biz-unknown")).toBe(0);
    expect(await countActiveSessionsForBusiness(db, "")).toBe(0);
  });
});

describe("admitSessionCreate", () => {
  it("admits when under the rate limit and the active-session cap", async () => {
    insertSession("biz-1", "active");
    expect(await admitSessionCreate({ db, env: makeRateLimitEnv(true), businessId: "biz-1" })).toEqual({ ok: true });
  });

  it("rejects with 429 when the create rate limit is exceeded (before counting the cap)", async () => {
    // No active sessions: only the rate limiter can reject here.
    const decision = await admitSessionCreate({ db, env: makeRateLimitEnv(false), businessId: "biz-1" });
    expect(decision).toMatchObject({ ok: false, status: 429, code: "session_create_rate_limited" });
    expect(decision).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          `${SESSION_CREATE_RATE_LIMIT_MAX} per ${SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS}s`,
        ),
      }),
    );
  });

  it("rejects with 429 + structured code when the cap is reached", async () => {
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS; i += 1) insertSession("biz-1", "active");
    const decision = await admitSessionCreate({ db, env: makeRateLimitEnv(true), businessId: "biz-1" });
    expect(decision).toMatchObject({
      ok: false,
      status: 429,
      code: "active_session_limit_exceeded",
      activeCount: MAX_ACTIVE_SESSIONS_PER_BUSINESS,
    });
  });

  it("fails open on the rate limit when the limiter backend is absent, still enforcing the cap", async () => {
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS; i += 1) insertSession("biz-1", "active");
    const decision = await admitSessionCreate({ db, env: makeRateLimitEnv("absent"), businessId: "biz-1" });
    expect(decision).toMatchObject({ ok: false, code: "active_session_limit_exceeded" });
  });

  it("does not count another business's sessions toward the cap", async () => {
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS; i += 1) insertSession("biz-2", "active");
    expect(await admitSessionCreate({ db, env: makeRateLimitEnv(true), businessId: "biz-1" })).toEqual({ ok: true });
  });

  it("bypasses both gates for a trusted all-access caller (null business id)", async () => {
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_BUSINESS + 5; i += 1) insertSession("biz-1", "active");
    expect(await admitSessionCreate({ db, env: makeRateLimitEnv(false), businessId: null })).toEqual({ ok: true });
  });
});
