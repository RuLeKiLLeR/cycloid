import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CHILD_SESSION_IDS_FOR_PARENT_SQL,
  getChildSessionIdsForParent,
} from "../../apps/control-plane-worker/src/session/child-session-db";

// Minimal D1 shim over better-sqlite3 so we can call the real DAO and run a real
// query planner (FakeD1 has no planner and cannot EXPLAIN QUERY PLAN).
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

function insertSession(row: {
  session_id: string;
  created_at: string;
  parent_session_id: string | null;
  business_id: string | null;
}): void {
  sqlite
    .prepare("INSERT INTO session_index (session_id, created_at, parent_session_id, business_id) VALUES (?, ?, ?, ?)")
    .run(row.session_id, row.created_at, row.parent_session_id, row.business_id);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  // Representative subset of the production session_index shape for the child
  // lookup: session_id is a TEXT PRIMARY KEY (not a rowid alias) and created_at
  // is TEXT epoch-ms, matching migration 0001.
  sqlite.exec(`
    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      parent_session_id TEXT,
      business_id TEXT
    );
  `);
  // Pre-existing partial index (migration 0089) so the planner has a realistic
  // alternative to choose from; the new index must win.
  sqlite.exec(`
    CREATE INDEX idx_session_index_parent_session
      ON session_index(parent_session_id)
      WHERE parent_session_id IS NOT NULL;
  `);
  // The migration under test, loaded from disk so the test exercises the real DDL.
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0127_session_index_parent_business_created.sql", "utf8"),
  );

  // parent-1 in biz-1: three children at increasing created_at.
  insertSession({
    session_id: "c-old",
    created_at: "1700000000001",
    parent_session_id: "parent-1",
    business_id: "biz-1",
  });
  insertSession({
    session_id: "c-mid",
    created_at: "1700000000002",
    parent_session_id: "parent-1",
    business_id: "biz-1",
  });
  insertSession({
    session_id: "c-new",
    created_at: "1700000000003",
    parent_session_id: "parent-1",
    business_id: "biz-1",
  });
  // Same parent, different business — must be excluded by the business_id filter.
  insertSession({
    session_id: "c-otherbiz",
    created_at: "1700000000004",
    parent_session_id: "parent-1",
    business_id: "biz-2",
  });
  // parent-2 with NULL business_id (the `business_id IS ?` null-bind path).
  insertSession({ session_id: "n-old", created_at: "1700000000005", parent_session_id: "parent-2", business_id: null });
  insertSession({ session_id: "n-new", created_at: "1700000000006", parent_session_id: "parent-2", business_id: null });
  // Unrelated noise: a different parent and a root (NULL parent).
  insertSession({
    session_id: "c-otherparent",
    created_at: "1700000000007",
    parent_session_id: "parent-9",
    business_id: "biz-1",
  });
  insertSession({ session_id: "root", created_at: "1700000000008", parent_session_id: null, business_id: "biz-1" });

  sqlite.exec("ANALYZE;");
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("getChildSessionIdsForParent index coverage", () => {
  it("returns matching children newest-first, scoped to business_id", async () => {
    const ids = await getChildSessionIdsForParent(db, "parent-1", "biz-1");
    expect(ids).toEqual(["c-new", "c-mid", "c-old"]);
  });

  it("matches NULL business_id via `business_id IS ?` when bound null", async () => {
    const ids = await getChildSessionIdsForParent(db, "parent-2", null);
    expect(ids).toEqual(["n-new", "n-old"]);
  });

  it("returns empty for a parent with no children in the business", async () => {
    expect(await getChildSessionIdsForParent(db, "parent-1", "biz-2")).toEqual(["c-otherbiz"]);
    expect(await getChildSessionIdsForParent(db, "parent-1", "biz-9")).toEqual([]);
    expect(await getChildSessionIdsForParent(db, "missing", "biz-1")).toEqual([]);
  });

  it("uses the covering index with no temp-sort or table scan", () => {
    const plan = sqlite
      .prepare("EXPLAIN QUERY PLAN " + CHILD_SESSION_IDS_FOR_PARENT_SQL)
      .all("parent-1", "biz-1")
      .map((r) => (r as { detail: string }).detail)
      .join("\n");
    expect(plan).toContain("USING COVERING INDEX idx_session_index_parent_business_created");
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    expect(plan).not.toContain("SCAN session_index");
  });
});
