import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { upsertMemoryPrTracking } from "../../apps/control-plane-worker/src/memory/db";

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

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0047_memory_pr_tracking.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0054_memory_pr_suggestions_json.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    repoOwner: "acme",
    repoName: "repo",
    sourcePrUrl: "https://github.com/acme/repo/pull/12",
    sourcePrNumber: 12,
    sourceSessionId: "s1",
    memoryPrUrl: null as string | null,
    memoryPrNumber: null as number | null,
    memoriesAdded: 1,
    memoriesUpdated: 0,
    memoriesRemoved: 0,
    suggestionsJson: "{}",
    ...overrides,
  };
}

async function rowCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM memory_pr_tracking").bind().first<{ c: number }>();
  return Number(row?.c ?? 0);
}

describe("upsertMemoryPrTracking null-URL idempotency", () => {
  it("two null-URL upserts for the same source PR produce one row", async () => {
    await upsertMemoryPrTracking(db, baseParams({ memoriesAdded: 1 }));
    await upsertMemoryPrTracking(db, baseParams({ memoriesAdded: 3 }));
    expect(await rowCount()).toBe(1);

    const row = await db
      .prepare("SELECT id, memories_added FROM memory_pr_tracking LIMIT 1")
      .bind()
      .first<{ id: string; memories_added: number }>();
    // Deterministic id keyed on the source PR, and the latest counts win.
    expect(row?.id).toBe("source:acme/repo#12");
    expect(row?.memories_added).toBe(3);
  });

  it("still keys URL-bearing rows on memory_pr_url (one row per memory PR)", async () => {
    const url = "https://github.com/acme/repo/pull/99";
    await upsertMemoryPrTracking(db, baseParams({ memoryPrUrl: url, memoryPrNumber: 99 }));
    await upsertMemoryPrTracking(db, baseParams({ memoryPrUrl: url, memoryPrNumber: 99, memoriesAdded: 7 }));
    expect(await rowCount()).toBe(1);
    const row = await db
      .prepare("SELECT memories_added FROM memory_pr_tracking WHERE memory_pr_url = ?")
      .bind(url)
      .first<{ memories_added: number }>();
    expect(row?.memories_added).toBe(7);
  });

  it("a null-URL row and a later URL-bearing row for the same source PR are distinct rows", async () => {
    await upsertMemoryPrTracking(db, baseParams());
    await upsertMemoryPrTracking(
      db,
      baseParams({ memoryPrUrl: "https://github.com/acme/repo/pull/99", memoryPrNumber: 99 }),
    );
    // The URL-keyed insert is a different id, so the suggestion row is preserved
    // and the PR row is created (matches prior behavior for the happy path).
    expect(await rowCount()).toBe(2);
  });
});
