import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMemoryReviewCohortQueryPlan, getMemoryReviewCohortReport } from "./cohorts";

class SelectBatchSqliteD1Statement {
  private boundValues: string[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: string[]): this {
    this.boundValues = values;
    return this;
  }

  allSync(): { success: true; results: unknown[]; meta: { changes: number } } {
    const rows = this.db.prepare(this.query).all(...this.boundValues) as unknown[];
    return { success: true, results: rows, meta: { changes: 0 } };
  }
}

class SelectBatchSqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SelectBatchSqliteD1Statement {
    return new SelectBatchSqliteD1Statement(this.db, query);
  }

  async batch(
    statements: SelectBatchSqliteD1Statement[],
  ): Promise<Array<{ success: true; results: unknown[]; meta: { changes: number } }>> {
    return this.db.transaction(() => statements.map((statement) => statement.allSync()))();
  }
}

describe("memory-review-bot/cohorts", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    createSchema(sqlite);
    db = new SelectBatchSqliteD1(sqlite) as unknown as D1Database;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("reports generated memory counts, recall observations, review labels, and coverage caveats", async () => {
    seedFullCohort(sqlite);

    const report = await getMemoryReviewCohortReport(db, {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(report.generated_total).toBe(5);
    expect(report.active_total).toBe(3);
    expect(report.observed_recalled).toBe(3);
    expect(report.never_observed_recalled).toBe(2);
    expect(report.reviewed_useful).toBe(1);
    expect(report.reviewed_not_useful).toBe(2);
    expect(report.false_positive).toBe(1);
    expect(report.false_positive_hurt).toBe(1);
    expect(report.never_observed_recalled_rate).toBeCloseTo(0.4);
    expect(report.recalled_not_useful_rate).toBeCloseTo(2 / 3);
    expect(report.false_positive_rate).toBeCloseTo(1 / 2);
    expect(report.false_positive_hurt_rate).toBeCloseTo(1 / 2);
    expect(report.root_cause_distribution).toEqual({
      provenance_missing: 1,
      retrieval: 1,
      stale_memory: 1,
      supersession_missing: 1,
    });
    expect(report.lifecycle_scope_failures).toEqual({
      lifecycle: 1,
      superseded: 0,
      expired: 1,
      rejected: 0,
      stale_memory: 1,
      supersession_missing: 1,
      provenance_missing: 1,
      scope: 1,
    });
    expect(report.coverage_status).toBe("partial");
    expect(report.coverage_notes.join(" ")).toContain("company_bootstrap");
    expect(report.coverage_notes.join(" ")).toContain("not per-memory exposure labels");
  });

  it("does not query repo columns from memory review run rows", () => {
    const plan = buildMemoryReviewCohortQueryPlan({
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    const sql = plan.queries.map((query) => query.sql).join("\n");
    expect(sql).not.toContain("r.repo_owner");
    expect(sql).not.toContain("r.repo_name");
  });

  it("marks coverage unknown when explicit recall telemetry is absent and business-only repo memories are omitted", async () => {
    insertRepoMemory(sqlite, "trycycloid", "cycloid", "mem-business-only", "active", 1);
    insertFact(sqlite, "fact-business", "biz-1", "active", "brain", 2);

    const report = await getMemoryReviewCohortReport(db, { businessId: "biz-1" });

    expect(report.generated_total).toBe(1);
    expect(report.active_total).toBe(1);
    expect(report.observed_recalled).toBe(0);
    expect(report.never_observed_recalled).toBe(1);
    expect(report.never_observed_recalled_rate).toBe(1);
    expect(report.recalled_not_useful_rate).toBeNull();
    expect(report.false_positive_rate).toBeNull();
    expect(report.coverage_status).toBe("unknown");
    expect(report.coverage_notes.join(" ")).toContain("repo_memories rows are omitted");
    expect(report.coverage_notes.join(" ")).toContain("No explicit recall telemetry");
  });
});

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE repo_memories (
      memory_id TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE ingestion_events (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      scope_type TEXT,
      scope_id TEXT
    );

    CREATE TABLE memory_provenance (
      memory_kind TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      business_id TEXT NOT NULL
    );

    CREATE TABLE memory_pages (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      page_type TEXT NOT NULL,
      slug TEXT NOT NULL
    );

    CREATE TABLE memory_facts (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      status TEXT NOT NULL,
      holder TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expired_at_ms INTEGER
    );

    CREATE TABLE memory_takes (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      page_id TEXT,
      holder TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL
    );

    CREATE TABLE memory_usage_events (
      id TEXT PRIMARY KEY,
      repo_owner TEXT,
      repo_name TEXT,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      source TEXT NOT NULL,
      used_at INTEGER NOT NULL
    );

    CREATE TABLE memory_review_bot_runs (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      session_event_status TEXT NOT NULL DEFAULT 'pending',
      slack_post_status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE memory_review_bot_recall_results (
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      prompt_outcome TEXT NOT NULL,
      aggregate_effect TEXT NOT NULL
    );

    CREATE TABLE memory_review_bot_item_results (
      run_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      source TEXT NOT NULL,
      relevance TEXT NOT NULL,
      usefulness TEXT NOT NULL,
      effect TEXT NOT NULL,
      lifecycle_state TEXT,
      root_causes_json TEXT
    );
  `);
}

function seedFullCohort(db: Database.Database): void {
  insertRepoMemory(db, "trycycloid", "cycloid", "mem-repo-active", "active", 1);
  insertRepoMemory(db, "trycycloid", "cycloid", "mem-repo-superseded", "superseded", 2);
  insertRepoMemory(db, "trycycloid", "other", "mem-other-repo", "active", 3);
  insertFact(db, "fact-active", "biz-1", "active", "trycycloid/cycloid", 4);
  insertFact(db, "fact-expired", "biz-1", "expired", "repo:trycycloid/cycloid", 5);
  insertFact(db, "fact-other-repo", "biz-1", "active", "trycycloid/other", 6);
  insertFact(db, "fact-other-business", "biz-2", "active", "trycycloid/cycloid", 7);
  db.prepare("INSERT INTO memory_pages (id, business_id, page_type, slug) VALUES (?, ?, 'repo', ?)").run(
    "repo-page",
    "biz-1",
    "trycycloid/cycloid",
  );
  db.prepare(
    "INSERT INTO memory_takes (id, business_id, page_id, holder, active, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("take-active", "biz-1", "repo-page", "brain", 1, 8);
  db.prepare(
    "INSERT INTO memory_takes (id, business_id, page_id, holder, active, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("take-other-business", "biz-2", "repo-page", "brain", 1, 9);

  db.prepare("INSERT INTO session_index (session_id, business_id) VALUES (?, ?)").run("s-1", "biz-1");
  db.prepare("INSERT INTO session_index (session_id, business_id) VALUES (?, ?)").run("s-2", "biz-1");
  db.prepare("INSERT INTO session_index (session_id, business_id) VALUES (?, ?)").run("s-3", "biz-1");
  db.prepare("INSERT INTO session_index (session_id, business_id) VALUES (?, ?)").run("s-other", "biz-2");
  insertUsage(db, "u-1", "trycycloid", "cycloid", "s-1", "p-1", "mem-repo-active", "recall", 10);
  insertUsage(db, "u-2", null, null, "s-2", "p-2", "fact-active", "company_recall", 11);
  insertUsage(db, "u-3", null, null, "s-3", "company-memory-recall", "fact-expired", "company_bootstrap", 12);
  insertUsage(db, "u-other-business", null, null, "s-other", "p-3", "fact-active", "company_recall", 13);
  insertUsage(db, "u-other-repo", "trycycloid", "other", "s-1", "p-4", "mem-repo-active", "recall", 14);

  db.prepare("INSERT INTO memory_review_bot_runs (id, business_id) VALUES (?, ?)").run("run-1", "biz-1");
  insertReviewItem(db, "run-1", "mem-repo-active", "recall", "relevant", "useful", "helped", "active", []);
  insertReviewItem(db, "run-1", "fact-active", "company_recall", "irrelevant", "not_useful", "hurt", "active", [
    "retrieval",
    "provenance_missing",
  ]);
  insertReviewItem(db, "run-1", "fact-expired", "company_recall", "irrelevant", "not_useful", "neutral", "expired", [
    "stale_memory",
    "supersession_missing",
  ]);
  insertReviewItem(db, "run-1", "mem-other-repo", "recall", "irrelevant", "not_useful", "hurt", "active", [
    "retrieval",
  ]);
  insertRecallReview(db, "run-1", "recall", "true_positive", "helped");
  insertRecallReview(db, "run-1", "company_recall", "false_positive", "hurt");
}

function insertRepoMemory(
  db: Database.Database,
  owner: string,
  name: string,
  memoryId: string,
  status: string,
  createdAtMs: number,
): void {
  db.prepare(
    "INSERT INTO repo_memories (memory_id, repo_owner, repo_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(memoryId, owner, name, status, createdAtMs, createdAtMs);
}

function insertFact(
  db: Database.Database,
  id: string,
  businessId: string,
  status: string,
  holder: string,
  createdAtMs: number,
): void {
  const sourceEventId = `event-${id}`;
  db.prepare("INSERT INTO ingestion_events (id, business_id, scope_type, scope_id) VALUES (?, ?, 'repo', ?)").run(
    sourceEventId,
    businessId,
    holder.replace(/^repo:/, ""),
  );
  db.prepare(
    "INSERT INTO memory_facts (id, business_id, status, holder, source_event_id, created_at_ms, expired_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, businessId, status, holder, sourceEventId, createdAtMs, status === "expired" ? createdAtMs + 1 : null);
}

function insertUsage(
  db: Database.Database,
  id: string,
  repoOwner: string | null,
  repoName: string | null,
  sessionId: string,
  promptId: string,
  memoryId: string,
  source: string,
  usedAt: number,
): void {
  db.prepare(
    "INSERT INTO memory_usage_events (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, repoOwner, repoName, sessionId, promptId, memoryId, source, usedAt);
}

function insertReviewItem(
  db: Database.Database,
  runId: string,
  memoryId: string,
  source: string,
  relevance: string,
  usefulness: string,
  effect: string,
  lifecycleState: string,
  rootCauses: string[],
): void {
  db.prepare(
    "INSERT INTO memory_review_bot_item_results (run_id, memory_id, source, relevance, usefulness, effect, lifecycle_state, root_causes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, memoryId, source, relevance, usefulness, effect, lifecycleState, JSON.stringify(rootCauses));
}

function insertRecallReview(
  db: Database.Database,
  runId: string,
  source: string,
  promptOutcome: string,
  effect: string,
): void {
  db.prepare(
    "INSERT INTO memory_review_bot_recall_results (run_id, source, prompt_outcome, aggregate_effect) VALUES (?, ?, ?, ?)",
  ).run(runId, source, promptOutcome, effect);
}
