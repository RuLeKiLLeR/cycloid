import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { recordIngestionEvent } from "../../apps/control-plane-worker/src/company-memory/db";
import { runMemoryReconciliation } from "../../apps/control-plane-worker/src/company-memory/reconcile";
import {
  advanceSchedulerRoundRobinCursor,
  getSchedulerRoundRobinCursor,
  listBusinessesDueForMemoryReconciliation,
  listMemoryReviewCandidates,
  upsertMemoryReconciliationCursor,
  upsertMemoryReviewCandidate,
} from "../../apps/control-plane-worker/src/company-memory/review-db";
import {
  COMPANY_MEMORY_SOURCE_TYPE,
  MEMORY_RECONCILIATION_RECURRENCE_INTERVAL_MS,
} from "../../apps/control-plane-worker/src/constants/company-memory";
import { memoryReviewRoutes } from "../../apps/control-plane-worker/src/routes/memory-review";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";
import { StructuredOutputError } from "../../shared/llm/structured-output";

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
    return (this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }

  runSync(): { success: true; meta: { changes: number } } {
    const info = this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const runBatch = this.db.transaction((items: SqliteD1Statement[]) => items.map((statement) => statement.runSync()));
    return runBatch(statements);
  }
}

let sqlite: Database.Database;
let db: D1Database;
let env: Env;

const adminAuth: AuthInfo = {
  userId: "1",
  tokenSource: "cookie",
  authMode: "user_session",
  canAccessAllSessions: true,
};

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0132_ingestion_events.sql", "utf8"));
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  sqlite.exec("INSERT INTO users (id) VALUES (1), (42)");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0134_company_memory_core.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0138_memory_review_candidates.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = { DB: db } as Env;
});

async function seedEvent(sourceEventId: string, sourceTimeMs: number): Promise<string> {
  const result = await recordIngestionEvent(db, {
    businessId: "biz-1",
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
    sourceEventId,
    sourceUri: `slack://T/C/${sourceEventId}`,
    sourceTimeMs,
    contentText: `event ${sourceEventId}`,
    contentRef: null,
  });
  return result.id;
}

async function seedRepoScopedEvent(sourceEventId: string, sourceTimeMs: number): Promise<string> {
  const result = await recordIngestionEvent(db, {
    businessId: "biz-1",
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.GITHUB_PR_EVENT,
    sourceEventId,
    sourceUri: `github://trycycloid/cycloid/${sourceEventId}`,
    sourceTimeMs,
    contentText: `repo event ${sourceEventId}`,
    contentRef: null,
  });
  return result.id;
}

function insertFact(input: {
  id: string;
  sourceEventId: string;
  claim: string;
  holder?: string;
  createdAtMs?: number;
  validUntilMs?: number | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO memory_facts
       (id, business_id, kind, claim, holder, confidence, source_event_id, created_at_ms, valid_until_ms)
       VALUES (?, 'biz-1', 'constraint', ?, ?, 0.8, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.claim,
      input.holder ?? "repo:trycycloid/cycloid",
      input.sourceEventId,
      input.createdAtMs ?? 1_000,
      input.validUntilMs ?? null,
    );
}

function routeFor(method: string, path: string) {
  const route = memoryReviewRoutes.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (!route) throw new Error(`missing route for ${method} ${path}`);
  return route;
}

function structuredOutputError(status: number): StructuredOutputError {
  return new StructuredOutputError(
    {
      provider: "openai",
      model: "gpt-5.4-mini",
      toolName: "submit_memory_adjudication",
      status,
      attempts: 3,
      maxAttempts: 3,
      durationMs: 11_000,
      failureKind: "provider",
    },
    new Error(`provider ${status}`),
  );
}

describe("company memory Phase 3.5 reconciliation", () => {
  it("expires past-valid D1 facts and records an applied audit candidate", async () => {
    const eventId = await seedEvent("old-event", 1_000);
    insertFact({
      id: "fact-expired",
      sourceEventId: eventId,
      claim: "Use ngrok for Memory 2.0 local testing.",
      validUntilMs: 1_500,
    });

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 2_000,
      repoTargets: [],
      adjudicate: async () => null,
    });

    expect(result.expired).toBe(1);
    expect(sqlite.prepare("SELECT status, expired_at_ms FROM memory_facts WHERE id = 'fact-expired'").get()).toEqual({
      status: "expired",
      expired_at_ms: 2_000,
    });
    expect(
      sqlite.prepare("SELECT candidate_type, status, proposed_action FROM memory_review_candidates").get(),
    ).toEqual({
      candidate_type: "d1_expiration",
      status: "applied",
      proposed_action: "expire_d1",
    });
  });

  it("supersedes the older D1 fact when adjudication confidently cites both memories", async () => {
    const olderEventId = await seedEvent("older-event", 1_000);
    const newerEventId = await seedEvent("newer-event", 2_000);
    insertFact({
      id: "fact-old",
      sourceEventId: olderEventId,
      claim: "Use Cloudflare quick tunnels for local Memory 2.0 testing.",
      createdAtMs: 1_000,
    });
    insertFact({
      id: "fact-new",
      sourceEventId: newerEventId,
      claim: "Use ngrok for local Memory 2.0 testing.",
      createdAtMs: 2_000,
    });

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 3_000,
      repoTargets: [],
      adjudicate: async ({ older, newer }) => ({
        classification: "contradiction_needs_review",
        confidence: 0.92,
        proposed_action: "supersede_older_d1",
        rationale: "The newer sourced constraint replaces the older tunnel constraint.",
        cited_memory_ids: [older.id, newer.id],
      }),
    });

    expect(result.superseded).toBe(1);
    expect(
      sqlite.prepare("SELECT status, superseded_by, expired_at_ms FROM memory_facts WHERE id = 'fact-old'").get(),
    ).toEqual({
      status: "superseded",
      superseded_by: "fact-new",
      expired_at_ms: 3_000,
    });
    expect(sqlite.prepare("SELECT status, superseded_by FROM memory_facts WHERE id = 'fact-new'").get()).toEqual({
      status: "active",
      superseded_by: null,
    });
    expect(
      sqlite
        .prepare("SELECT candidate_type, status, primary_memory_id, secondary_memory_id FROM memory_review_candidates")
        .get(),
    ).toEqual({
      candidate_type: "d1_supersession",
      status: "applied",
      primary_memory_id: "fact-old",
      secondary_memory_id: "fact-new",
    });
  });

  it("does not supersede facts when adjudication is low confidence", async () => {
    const olderEventId = await seedEvent("older-low", 1_000);
    const newerEventId = await seedEvent("newer-low", 2_000);
    insertFact({ id: "fact-low-old", sourceEventId: olderEventId, claim: "Use quick tunnels.", createdAtMs: 1_000 });
    insertFact({ id: "fact-low-new", sourceEventId: newerEventId, claim: "Use ngrok.", createdAtMs: 2_000 });

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 3_000,
      repoTargets: [],
      adjudicate: async ({ older, newer }) => ({
        classification: "contradiction_needs_review",
        confidence: 0.4,
        proposed_action: "supersede_older_d1",
        rationale: "Weak evidence.",
        cited_memory_ids: [older.id, newer.id],
      }),
    });

    expect(result.superseded).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_candidates").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT status FROM memory_facts WHERE id = 'fact-low-old'").get()).toEqual({
      status: "active",
    });
  });

  it("skips D1 adjudication pairs on retryable provider failure and reports the skipped cause", async () => {
    const olderEventId = await seedEvent("older-provider-failure", 1_000);
    const newerEventId = await seedEvent("newer-provider-failure", 2_000);
    insertFact({
      id: "fact-provider-old",
      sourceEventId: olderEventId,
      claim: "Use quick tunnels.",
      createdAtMs: 1_000,
    });
    insertFact({
      id: "fact-provider-new",
      sourceEventId: newerEventId,
      claim: "Use ngrok.",
      createdAtMs: 2_000,
    });

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 3_000,
      repoTargets: [],
      adjudicate: async () => {
        throw structuredOutputError(503);
      },
    });

    expect(result.superseded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.adjudicationProviderFailures).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_candidates").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT status FROM memory_facts WHERE id = 'fact-provider-old'").get()).toEqual({
      status: "active",
    });
    // A retryable provider failure must not interval-suppress the business: the
    // 'd1' cursor is not written, so the business stays due on the next tick.
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM memory_reconciliation_cursors WHERE cursor_type = 'd1'").get(),
    ).toEqual({ count: 0 });
  });

  it.each([400, 409])("still throws non-retryable D1 adjudication provider error %i", async (status) => {
    const olderEventId = await seedEvent("older-nonretryable", 1_000);
    const newerEventId = await seedEvent("newer-nonretryable", 2_000);
    insertFact({
      id: `fact-bad-old-${status}`,
      sourceEventId: olderEventId,
      claim: "Use quick tunnels.",
      createdAtMs: 1_000,
    });
    insertFact({
      id: `fact-bad-new-${status}`,
      sourceEventId: newerEventId,
      claim: "Use ngrok.",
      createdAtMs: 2_000,
    });

    await expect(
      runMemoryReconciliation(env, {
        businessId: "biz-1",
        nowMs: 3_000,
        repoTargets: [],
        adjudicate: async () => {
          throw structuredOutputError(status);
        },
      }),
    ).rejects.toThrow("StructuredOutputError");
  });

  it("creates a pending repo PR candidate for stale repo memory during cross-store reconciliation", async () => {
    const eventId = await seedRepoScopedEvent("newer-repo-d1", 2_000);
    insertFact({
      id: "fact-cross-new",
      sourceEventId: eventId,
      claim: "Memory 2.0 local verification must use ngrok.",
      holder: "repo:trycycloid/cycloid",
      createdAtMs: 2_000,
    });

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 3_000,
      repoTargets: [{ owner: "trycycloid", name: "cycloid", token: "test-token", ref: "main" }],
      repoMemoryLoader: async () => [
        {
          id: "mem_repo_old",
          owner: "trycycloid",
          repo: "cycloid",
          path: ".cycloid/memory/engineering/gotchas/old.md",
          status: "active",
          claim: "Memory 2.0 local verification should use Cloudflare quick tunnels.",
          sourceTimeMs: 1_000,
          sourceUri: "github://trycycloid/cycloid/.cycloid/memory/engineering/gotchas/old.md",
        },
      ],
      adjudicatePair: async (_env, input) => ({
        classification: "repo_memory_stale",
        confidence: 0.91,
        proposed_action: "create_repo_memory_pr",
        rationale: "The repo memory is older than the D1 source and should be updated by PR.",
        cited_memory_ids: input.memories.map((memory) => memory.id),
      }),
    });

    expect(result.candidates).toBe(1);
    expect(
      sqlite
        .prepare(
          "SELECT candidate_type, status, primary_store, primary_memory_id, proposed_action, repo_memory_path FROM memory_review_candidates",
        )
        .get(),
    ).toEqual({
      candidate_type: "repo_pr_needed",
      status: "pending",
      primary_store: "repo",
      primary_memory_id: "mem_repo_old",
      proposed_action: "create_repo_memory_pr",
      repo_memory_path: ".cycloid/memory/engineering/gotchas/old.md",
    });
    expect(
      sqlite
        .prepare(
          "SELECT cursor_type, repo_owner, repo_name FROM memory_reconciliation_cursors WHERE cursor_type = 'cross_store'",
        )
        .get(),
    ).toEqual({ cursor_type: "cross_store", repo_owner: "trycycloid", repo_name: "cycloid" });
  });

  it("skips cross-store adjudication pairs on retryable provider failure and reports the skipped cause", async () => {
    const eventId = await seedRepoScopedEvent("cross-provider-failure", 2_000);
    insertFact({
      id: "fact-cross-provider",
      sourceEventId: eventId,
      claim: "Memory 2.0 local verification must use ngrok.",
      holder: "repo:trycycloid/cycloid",
      createdAtMs: 2_000,
    });

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 3_000,
      repoTargets: [{ owner: "trycycloid", name: "cycloid", token: "test-token", ref: "main" }],
      repoMemoryLoader: async () => [
        {
          id: "mem_repo_provider_failure",
          owner: "trycycloid",
          repo: "cycloid",
          path: ".cycloid/memory/engineering/gotchas/old.md",
          status: "active",
          claim: "Memory 2.0 local verification should use Cloudflare quick tunnels.",
          sourceTimeMs: 1_000,
          sourceUri: "github://trycycloid/cycloid/.cycloid/memory/engineering/gotchas/old.md",
        },
      ],
      adjudicatePair: async () => {
        throw structuredOutputError(503);
      },
    });

    expect(result.candidates).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.adjudicationProviderFailures).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_candidates").get()).toEqual({ count: 0 });
    const cursor = sqlite
      .prepare("SELECT cursor_json FROM memory_reconciliation_cursors WHERE cursor_type = 'cross_store'")
      .get() as { cursor_json: string };
    expect(JSON.parse(cursor.cursor_json)).toMatchObject({
      repo_memory_count: 1,
      d1_fact_count: 1,
      adjudication_provider_failures: 1,
    });
  });

  it("lists and resolves memory review candidates through admin routes", async () => {
    const candidate = await upsertMemoryReviewCandidate(db, {
      businessId: "biz-1",
      candidateType: "cross_store_conflict",
      primaryStore: "d1",
      primaryMemoryId: "fact-1",
      secondaryStore: "repo",
      secondaryMemoryId: "mem_repo_1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      repoMemoryPath: ".cycloid/memory/example.md",
      proposedAction: "manual_review",
      rationale: "D1 memory and repo memory disagree.",
      evidenceJson: JSON.stringify({ primary: "fact-1", secondary: "mem_repo_1" }),
    });

    const listPath = "/api/admin/memory-review";
    const listResponse = await routeFor("GET", listPath).handler(
      new Request(`https://example.com${listPath}?business_id=biz-1&source=cross_store`),
      env,
      listPath.match(routeFor("GET", listPath).pattern)!,
      adminAuth,
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      ok: true,
      candidates: [{ id: candidate.id, candidateType: "cross_store_conflict", status: "pending" }],
    });

    const resolvePath = `/api/admin/memory-review/${candidate.id}/resolve`;
    const resolveResponse = await routeFor("POST", resolvePath).handler(
      new Request(`https://example.com${resolvePath}`, {
        method: "POST",
        body: JSON.stringify({ business_id: "biz-1", action: "dismiss" }),
      }),
      env,
      resolvePath.match(routeFor("POST", resolvePath).pattern)!,
      adminAuth,
    );
    expect(resolveResponse.status).toBe(200);
    await expect(resolveResponse.json()).resolves.toMatchObject({
      ok: true,
      candidate: { id: candidate.id, status: "dismissed", resolvedByUserId: 1 },
    });
  });

  it("dedupes the same cross-store conflict to one row when the LLM candidate type and action flip", async () => {
    const conflict = {
      businessId: "biz-1",
      primaryStore: "d1" as const,
      primaryMemoryId: "fact-flip",
      secondaryStore: "repo" as const,
      secondaryMemoryId: "mem_repo_flip",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      repoMemoryPath: ".cycloid/memory/flip.md",
      evidenceJson: JSON.stringify({ primary: "fact-flip", secondary: "mem_repo_flip" }),
    };

    // First adjudication: classified as a stale repo memory needing a PR.
    const first = await upsertMemoryReviewCandidate(db, {
      ...conflict,
      candidateType: "repo_pr_needed",
      proposedAction: "create_repo_memory_pr",
      rationale: "First adjudication: repo memory is stale.",
    });

    // Re-adjudication of the SAME memory pair flips both LLM-derived fields.
    const second = await upsertMemoryReviewCandidate(db, {
      ...conflict,
      candidateType: "cross_store_conflict",
      proposedAction: "manual_review",
      rationale: "Second adjudication: needs manual review.",
    });

    // Same underlying conflict -> one row, stable id, latest fields win.
    expect(second.id).toBe(first.id);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_candidates").get()).toEqual({ count: 1 });
    expect(
      sqlite.prepare("SELECT candidate_type, proposed_action, rationale, status FROM memory_review_candidates").get(),
    ).toEqual({
      candidate_type: "cross_store_conflict",
      proposed_action: "manual_review",
      rationale: "Second adjudication: needs manual review.",
      status: "pending",
    });
  });

  it("paginates memory review candidates sharing created_at_ms without skipping rows", async () => {
    for (const memoryId of ["fact-a", "fact-b", "fact-c"]) {
      await upsertMemoryReviewCandidate(db, {
        businessId: "biz-1",
        candidateType: "d1_contradiction",
        primaryStore: "d1",
        primaryMemoryId: memoryId,
        secondaryStore: "d1",
        secondaryMemoryId: `${memoryId}-newer`,
        proposedAction: "manual_review",
        rationale: `Candidate for ${memoryId}`,
        evidenceJson: JSON.stringify({ memoryId }),
      });
    }
    sqlite.prepare("UPDATE memory_review_candidates SET created_at_ms = 5000").run();
    const expectedIds = sqlite
      .prepare("SELECT id FROM memory_review_candidates ORDER BY created_at_ms DESC, id DESC")
      .all()
      .map((row) => (row as { id: string }).id);

    const page1 = await listMemoryReviewCandidates(db, { businessId: "biz-1", limit: 1 });
    expect(page1.candidates.map((candidate) => candidate.id)).toEqual([expectedIds[0]]);
    expect(page1.nextCursor).toBe(`5000:${expectedIds[0]}`);

    const page2 = await listMemoryReviewCandidates(db, { businessId: "biz-1", limit: 1, cursor: page1.nextCursor });
    expect(page2.candidates.map((candidate) => candidate.id)).toEqual([expectedIds[1]]);
    expect(page2.nextCursor).toBe(`5000:${expectedIds[1]}`);

    const page3 = await listMemoryReviewCandidates(db, { businessId: "biz-1", limit: 1, cursor: page2.nextCursor });
    expect(page3.candidates.map((candidate) => candidate.id)).toEqual([expectedIds[2]]);
    expect(page3.nextCursor).toBeNull();
  });
});

async function seedEventForBusiness(businessId: string, sourceEventId: string, sourceTimeMs: number): Promise<string> {
  const result = await recordIngestionEvent(db, {
    businessId,
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
    sourceEventId,
    sourceUri: `slack://T/C/${sourceEventId}`,
    sourceTimeMs,
    contentText: `event ${sourceEventId}`,
    contentRef: null,
  });
  return result.id;
}

function insertFactForBusiness(input: {
  id: string;
  businessId: string;
  claim: string;
  sourceEventId: string;
  holder?: string;
  createdAtMs?: number;
}): void {
  sqlite
    .prepare(
      `INSERT INTO memory_facts
       (id, business_id, kind, claim, holder, confidence, source_event_id, created_at_ms, valid_until_ms)
       VALUES (?, ?, 'constraint', ?, ?, 0.8, ?, ?, NULL)`,
    )
    .run(
      input.id,
      input.businessId,
      input.claim,
      input.holder ?? "repo:trycycloid/cycloid",
      input.sourceEventId,
      input.createdAtMs ?? 1_000,
    );
}

function writeD1Cursor(businessId: string, lastScannedAtMs: number): void {
  sqlite
    .prepare(
      `INSERT INTO memory_reconciliation_cursors
       (business_id, cursor_type, repo_owner, repo_name, cursor_json, last_scanned_at_ms)
       VALUES (?, 'd1', '', '', NULL, ?)`,
    )
    .run(businessId, lastScannedAtMs);
}

function countD1Cursor(businessId: string): number {
  return (
    sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_reconciliation_cursors WHERE business_id = ? AND cursor_type = 'd1' AND repo_owner = '' AND repo_name = ''",
      )
      .get(businessId) as { c: number }
  ).c;
}

const keepBoth = (): {
  classification: "unrelated";
  confidence: number;
  proposed_action: "no_action";
  rationale: string;
  cited_memory_ids: string[];
} => ({
  classification: "unrelated",
  confidence: 0.9,
  proposed_action: "no_action",
  rationale: "Both memories stand; no supersession.",
  cited_memory_ids: [],
});

describe("listBusinessesDueForMemoryReconciliation (due-query DAO)", () => {
  const interval = MEMORY_RECONCILIATION_RECURRENCE_INTERVAL_MS;

  it("applies the interval gate, includes NULL-cursor businesses, and never returns the scheduler sentinel", async () => {
    const eventId = await seedEvent("due-evt", 1_000);
    insertFactForBusiness({ id: "f-a", businessId: "biz-a", claim: "a", sourceEventId: eventId });
    insertFactForBusiness({ id: "f-b", businessId: "biz-b", claim: "b", sourceEventId: eventId });
    insertFactForBusiness({ id: "f-c", businessId: "biz-c", claim: "c", sourceEventId: eventId });
    const now = 10_000_000;
    writeD1Cursor("biz-a", now - 1_000); // within interval -> excluded
    writeD1Cursor("biz-b", now - (interval + 1_000)); // past interval -> included
    // biz-c has no cursor -> included.
    // Write the scheduler sentinel row; it must never appear in the due list.
    await advanceSchedulerRoundRobinCursor(db, { expectedCursorJson: null, lastBusinessId: "biz-z", nowMs: now });

    const due = await listBusinessesDueForMemoryReconciliation(db, {
      nowMs: now,
      recurrenceIntervalMs: interval,
      afterBusinessId: "",
      limit: 10,
    });

    expect(due).toEqual(["biz-b", "biz-c"]);
    expect(due).not.toContain("__scheduler__");
  });

  it("honors nowMs (not voided): the same fixture yields different due sets across the interval boundary", async () => {
    const eventId = await seedEvent("now-evt", 1_000);
    insertFactForBusiness({ id: "f-x", businessId: "biz-x", claim: "x", sourceEventId: eventId });
    const scannedAt = 1_000_000;
    writeD1Cursor("biz-x", scannedAt);

    const within = await listBusinessesDueForMemoryReconciliation(db, {
      nowMs: scannedAt + 1_000,
      recurrenceIntervalMs: interval,
      afterBusinessId: "",
      limit: 10,
    });
    expect(within).toEqual([]);

    const past = await listBusinessesDueForMemoryReconciliation(db, {
      nowMs: scannedAt + interval + 1,
      recurrenceIntervalMs: interval,
      afterBusinessId: "",
      limit: 10,
    });
    expect(past).toEqual(["biz-x"]);
  });

  it("round-robins past afterBusinessId and round-trips the scheduler cursor", async () => {
    const eventId = await seedEvent("rr-evt", 1_000);
    for (const b of ["biz-1", "biz-2", "biz-3"]) {
      insertFactForBusiness({ id: `f-${b}`, businessId: b, claim: b, sourceEventId: eventId });
    }
    expect(await getSchedulerRoundRobinCursor(db)).toEqual({ lastBusinessId: "", rawCursorJson: null });

    const page1 = await listBusinessesDueForMemoryReconciliation(db, {
      nowMs: 1,
      recurrenceIntervalMs: 1_000,
      afterBusinessId: "",
      limit: 2,
    });
    expect(page1).toEqual(["biz-1", "biz-2"]);

    await advanceSchedulerRoundRobinCursor(db, { expectedCursorJson: null, lastBusinessId: "biz-2", nowMs: 1 });
    const cursor = await getSchedulerRoundRobinCursor(db);
    expect(cursor.lastBusinessId).toBe("biz-2");

    const page2 = await listBusinessesDueForMemoryReconciliation(db, {
      nowMs: 1,
      recurrenceIntervalMs: 1_000,
      afterBusinessId: cursor.lastBusinessId,
      limit: 2,
    });
    expect(page2).toEqual(["biz-3"]);
  });

  it("CAS advance no-ops when the expected cursor does not match (overlap guard)", async () => {
    await advanceSchedulerRoundRobinCursor(db, { expectedCursorJson: null, lastBusinessId: "biz-a", nowMs: 1 });
    const current = await getSchedulerRoundRobinCursor(db);

    // A stale tick that read a different value must not advance.
    await advanceSchedulerRoundRobinCursor(db, {
      expectedCursorJson: JSON.stringify({ last_business_id: "stale" }),
      lastBusinessId: "biz-z",
      nowMs: 2,
    });
    expect((await getSchedulerRoundRobinCursor(db)).lastBusinessId).toBe("biz-a");

    // The tick still holding the real value advances.
    await advanceSchedulerRoundRobinCursor(db, {
      expectedCursorJson: current.rawCursorJson,
      lastBusinessId: "biz-z",
      nowMs: 3,
    });
    expect((await getSchedulerRoundRobinCursor(db)).lastBusinessId).toBe("biz-z");
  });

  it("rejects a per-business cursor write to the reserved scheduler sentinel id", async () => {
    await advanceSchedulerRoundRobinCursor(db, { expectedCursorJson: null, lastBusinessId: "biz-keep", nowMs: 1 });

    await expect(
      upsertMemoryReconciliationCursor(db, {
        businessId: "__scheduler__",
        cursorType: "d1",
        cursorJson: JSON.stringify({ active_fact_count: 1 }),
        lastScannedAtMs: 2,
      }),
    ).rejects.toThrow("business_id is reserved");

    // The scheduler position is untouched.
    expect((await getSchedulerRoundRobinCursor(db)).lastBusinessId).toBe("biz-keep");
  });

  it("fails soft on a malformed sentinel cursor_json (start from beginning, raw preserved for CAS)", async () => {
    sqlite
      .prepare(
        `INSERT INTO memory_reconciliation_cursors
         (business_id, cursor_type, repo_owner, repo_name, cursor_json, last_scanned_at_ms)
         VALUES ('__scheduler__', 'd1', '', '', '{not valid json', 1)`,
      )
      .run();

    const cursor = await getSchedulerRoundRobinCursor(db);
    expect(cursor.lastBusinessId).toBe("");
    expect(cursor.rawCursorJson).toBe("{not valid json");

    // The CAS advance can still replace the bad row using the preserved raw value.
    await advanceSchedulerRoundRobinCursor(db, {
      expectedCursorJson: cursor.rawCursorJson,
      lastBusinessId: "biz-recovered",
      nowMs: 2,
    });
    expect((await getSchedulerRoundRobinCursor(db)).lastBusinessId).toBe("biz-recovered");
  });
});

describe("scheduled reconciliation convergence + isolation", () => {
  it("does not re-adjudicate a keep-both pair within the recurrence interval (convergence)", async () => {
    const olderEventId = await seedEvent("conv-old", 1_000);
    const newerEventId = await seedEvent("conv-new", 2_000);
    insertFact({ id: "keep-old", sourceEventId: olderEventId, claim: "Use tunnels.", createdAtMs: 1_000 });
    insertFact({ id: "keep-new", sourceEventId: newerEventId, claim: "Use ngrok.", createdAtMs: 2_000 });

    let adjudicateCalls = 0;
    const adjudicate = async () => {
      adjudicateCalls += 1;
      return keepBoth();
    };

    // Scheduled mode (no businessId): first tick adjudicates and writes the cursor.
    await runMemoryReconciliation(env, { nowMs: 5_000, repoTargets: [], adjudicate });
    expect(adjudicateCalls).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS c FROM memory_facts WHERE status = 'active'").get()).toEqual({ c: 2 });
    expect(countD1Cursor("biz-1")).toBe(1);

    // Second tick within the interval: the business is suppressed, so no re-adjudication.
    await runMemoryReconciliation(env, { nowMs: 6_000, repoTargets: [], adjudicate });
    expect(adjudicateCalls).toBe(1);
  });

  it("does not truncate the per-business fact scan to the scheduler's business-batch limit", async () => {
    // Three same-holder facts -> C(3,2) = 3 candidate pairs. The d1 cursor marks
    // the whole business scanned for the interval, so the fact scan must not be
    // truncated to the business-batch `limit`; otherwise pairs beyond it are
    // interval-suppressed for 24h.
    const e1 = await seedEvent("trunc-1", 1_000);
    const e2 = await seedEvent("trunc-2", 2_000);
    const e3 = await seedEvent("trunc-3", 3_000);
    insertFact({ id: "trunc-a", sourceEventId: e1, claim: "Use tunnels.", createdAtMs: 1_000 });
    insertFact({ id: "trunc-b", sourceEventId: e2, claim: "Use ngrok.", createdAtMs: 2_000 });
    insertFact({ id: "trunc-c", sourceEventId: e3, claim: "Use cloudflared.", createdAtMs: 3_000 });

    let adjudicateCalls = 0;
    const adjudicate = async () => {
      adjudicateCalls += 1;
      return keepBoth();
    };

    // Scheduled mode with a business-batch limit of 1 must still scan all 3 facts.
    await runMemoryReconciliation(env, { nowMs: 5_000, limit: 1, repoTargets: [], adjudicate });

    expect(adjudicateCalls).toBe(3);
  });

  it("isolates a per-business failure: a throwing business does not abort the tick and stays due", async () => {
    for (const b of ["biz-a", "biz-b"]) {
      const olderEventId = await seedEventForBusiness(b, `${b}-iso-old`, 1_000);
      const newerEventId = await seedEventForBusiness(b, `${b}-iso-new`, 2_000);
      insertFactForBusiness({
        id: `${b}-old`,
        businessId: b,
        claim: `${b} one`,
        sourceEventId: olderEventId,
        createdAtMs: 1_000,
      });
      insertFactForBusiness({
        id: `${b}-new`,
        businessId: b,
        claim: `${b} two`,
        sourceEventId: newerEventId,
        createdAtMs: 2_000,
      });
    }

    let bCalls = 0;
    const adjudicate = async ({ businessId }: { businessId: string }) => {
      if (businessId === "biz-a") throw new Error("boom");
      bCalls += 1;
      return keepBoth();
    };

    await runMemoryReconciliation(env, { nowMs: 5_000, repoTargets: [], adjudicate });

    expect(bCalls).toBe(1); // biz-b reconciled despite biz-a throwing
    expect(countD1Cursor("biz-a")).toBe(0); // threw -> no cursor -> still interval-due
    expect(countD1Cursor("biz-b")).toBe(1);
    // The round-robin still advanced past the batch so coverage progresses.
    expect((await getSchedulerRoundRobinCursor(db)).lastBusinessId).toBe("biz-b");
  });

  it("does not advance the scheduler cursor on a zero-due tick", async () => {
    const eventId = await seedEvent("zero-evt", 1_000);
    insertFactForBusiness({ id: "f-only", businessId: "biz-1", claim: "only", sourceEventId: eventId });
    // Already scanned within the interval -> nothing due this tick.
    writeD1Cursor("biz-1", 5_000);

    await runMemoryReconciliation(env, { nowMs: 5_500, repoTargets: [], adjudicate: async () => keepBoth() });

    expect(await getSchedulerRoundRobinCursor(db)).toEqual({ lastBusinessId: "", rawCursorJson: null });
  });

  it("leaves a business due when cross-store reconciliation throws after the D1 phase", async () => {
    const eventId = await seedRepoScopedEvent("cross-after", 2_000);
    insertFact({
      id: "fact-cross-after",
      sourceEventId: eventId,
      claim: "Memory verification must use ngrok.",
      holder: "repo:trycycloid/cycloid",
      createdAtMs: 2_000,
    });

    await expect(
      runMemoryReconciliation(env, {
        businessId: "biz-1",
        nowMs: 3_000,
        repoTargets: [{ owner: "trycycloid", name: "cycloid", token: "test-token", ref: "main" }],
        repoMemoryLoader: async () => {
          throw new Error("cross-store boom");
        },
      }),
    ).rejects.toThrow("cross-store boom");

    // The interval-gating 'd1' cursor write only lands on full-business success.
    expect(countD1Cursor("biz-1")).toBe(0);
  });
});
