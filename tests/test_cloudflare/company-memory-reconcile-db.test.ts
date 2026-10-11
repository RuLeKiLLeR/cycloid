import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { recordIngestionEvent } from "../../apps/control-plane-worker/src/company-memory/db";
import { expirePastValidFacts } from "../../apps/control-plane-worker/src/company-memory/reconcile-db";
import { COMPANY_MEMORY_SOURCE_TYPE } from "../../apps/control-plane-worker/src/constants/company-memory";

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
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number } } {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  batchCalls = 0;
  batchSizes: number[] = [];

  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    this.batchCalls += 1;
    this.batchSizes.push(statements.length);
    const runBatch = this.db.transaction((items: SqliteD1Statement[]) => items.map((statement) => statement.runSync()));
    return runBatch(statements);
  }
}

let sqlite: Database.Database;
let fake: SqliteD1;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0132_ingestion_events.sql", "utf8"));
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0134_company_memory_core.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0138_memory_review_candidates.sql", "utf8"));
  fake = new SqliteD1(sqlite);
  db = fake as unknown as D1Database;
});

async function seedEvent(sourceEventId: string): Promise<string> {
  const result = await recordIngestionEvent(db, {
    businessId: "biz-1",
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
    sourceEventId,
    sourceUri: `slack://T/C/${sourceEventId}`,
    sourceTimeMs: 1_000,
    contentText: `event ${sourceEventId}`,
    contentRef: null,
  });
  return result.id;
}

function insertFact(input: { id: string; sourceEventId: string; validUntilMs: number | null }): void {
  sqlite
    .prepare(
      `INSERT INTO memory_facts
       (id, business_id, kind, claim, holder, confidence, source_event_id, created_at_ms, valid_until_ms)
       VALUES (?, 'biz-1', 'constraint', ?, 'repo:trycycloid/cycloid', 0.8, ?, 1000, ?)`,
    )
    .run(input.id, `claim ${input.id}`, input.sourceEventId, input.validUntilMs);
}

function factStatuses(): Array<{ id: string; status: string }> {
  return sqlite.prepare("SELECT id, status FROM memory_facts ORDER BY id").all() as Array<{
    id: string;
    status: string;
  }>;
}

describe("expirePastValidFacts", () => {
  it("returns 0 and issues no batch when nothing is past valid", async () => {
    const eventId = await seedEvent("e1");
    insertFact({ id: "f-future", sourceEventId: eventId, validUntilMs: 10_000 });
    insertFact({ id: "f-open", sourceEventId: eventId, validUntilMs: null });

    const count = await expirePastValidFacts(db, "biz-1", 5_000);

    expect(count).toBe(0);
    expect(fake.batchCalls).toBe(0);
    expect(factStatuses().every((row) => row.status === "active")).toBe(true);
  });

  it("expires all past-valid facts and writes audit candidates in a single batch", async () => {
    const eventId = await seedEvent("e1");
    insertFact({ id: "f-a", sourceEventId: eventId, validUntilMs: 1_000 });
    insertFact({ id: "f-b", sourceEventId: eventId, validUntilMs: 2_000 });
    insertFact({ id: "f-c", sourceEventId: eventId, validUntilMs: 3_000 });
    insertFact({ id: "f-keep", sourceEventId: eventId, validUntilMs: 99_000 });

    const count = await expirePastValidFacts(db, "biz-1", 5_000);

    expect(count).toBe(3);
    expect(fake.batchCalls).toBe(1);
    expect(fake.batchSizes).toEqual([6]);
    expect(factStatuses()).toEqual([
      { id: "f-a", status: "expired" },
      { id: "f-b", status: "expired" },
      { id: "f-c", status: "expired" },
      { id: "f-keep", status: "active" },
    ]);

    const candidates = sqlite
      .prepare(
        `SELECT primary_memory_id, candidate_type, status, proposed_action
         FROM memory_review_candidates ORDER BY primary_memory_id`,
      )
      .all() as Array<{ primary_memory_id: string; candidate_type: string; status: string; proposed_action: string }>;
    expect(candidates).toEqual([
      { primary_memory_id: "f-a", candidate_type: "d1_expiration", status: "applied", proposed_action: "expire_d1" },
      { primary_memory_id: "f-b", candidate_type: "d1_expiration", status: "applied", proposed_action: "expire_d1" },
      { primary_memory_id: "f-c", candidate_type: "d1_expiration", status: "applied", proposed_action: "expire_d1" },
    ]);
  });

  it("scopes the sweep to the given business", async () => {
    const eventId = await seedEvent("e1");
    insertFact({ id: "f-mine", sourceEventId: eventId, validUntilMs: 1_000 });
    sqlite
      .prepare(
        `INSERT INTO memory_facts
         (id, business_id, kind, claim, holder, confidence, source_event_id, created_at_ms, valid_until_ms)
         VALUES ('f-other', 'biz-2', 'constraint', 'other claim', 'h', 0.8, ?, 1000, 1000)`,
      )
      .run(eventId);

    const count = await expirePastValidFacts(db, "biz-1", 5_000);

    expect(count).toBe(1);
    expect(factStatuses()).toEqual([
      { id: "f-mine", status: "expired" },
      { id: "f-other", status: "active" },
    ]);
  });
});
