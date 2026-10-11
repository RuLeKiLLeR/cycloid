import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

class QueryCapture {
  queries: { sql: string; binds: unknown[] }[] = [];
  nextFirstResult: unknown = null;
  nextAllResults: unknown[] = [];
  nextRunChanges = 0;
  nextRunResultOverride: unknown = undefined;

  prepare(sql: string) {
    const self = this;
    const binds: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        binds.push(...args);
        return this;
      },
      async first<T>(): Promise<T | null> {
        self.queries.push({ sql, binds });
        return self.nextFirstResult as T | null;
      },
      async run() {
        self.queries.push({ sql, binds });
        if (self.nextRunResultOverride !== undefined) return self.nextRunResultOverride as never;
        return { meta: { changes: self.nextRunChanges } };
      },
      async all<T>() {
        self.queries.push({ sql, binds });
        return { results: self.nextAllResults as T[] };
      },
    };
  }

  async batch(stmts: unknown[]) {
    const results = [];
    for (const stmt of stmts) {
      const s = stmt as { run: () => Promise<{ meta: { changes: number } }> };
      results.push(await s.run());
    }
    return results;
  }
}

type DbModule = typeof import("../../apps/control-plane-worker/src/memory/db");

describe("memory/db", () => {
  let mod: DbModule;
  let db: QueryCapture;

  beforeEach(async () => {
    db = new QueryCapture();
    mod = (await import("../../apps/control-plane-worker/src/memory/db")) as unknown as DbModule;
  });

  describe("repo memory D1 sink", () => {
    it("records repo memory judge rationale for stored and rejected candidates", async () => {
      await mod.insertRepoMemoryJudgment(db as unknown as D1Database, {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        sourcePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        sourcePrNumber: 123,
        sourceSessionIds: ["sess-1"],
        suggestionKind: "add",
        targetMemoryId: null,
        memoryId: "mem_123",
        verdict: "reject",
        confidence: 0.82,
        rationale: "Duplicate of existing memory.",
        issues: ["duplicate"],
        candidateJson: '{"context_hint":"When updating memory"}',
        judgeModel: "gpt-5.4-mini",
      });

      expect(db.queries).toHaveLength(1);
      expect(db.queries[0].sql).toContain("INSERT INTO repo_memory_judgments");
      expect(db.queries[0].sql).toContain("ON CONFLICT(id) DO UPDATE");
      expect(db.queries[0].binds).toContain("repo-memory-judgment:trycycloid:cycloid:123:add:mem_123");
      expect(db.queries[0].binds).toContain("reject");
      expect(db.queries[0].binds).toContain(0.82);
      expect(db.queries[0].binds).toContain("Duplicate of existing memory.");
      expect(db.queries[0].binds).toContain('["duplicate"]');
      expect(db.queries[0].binds).toContain("gpt-5.4-mini");
    });

    it("batches accepted repo memory writes with their judge rationale", async () => {
      await mod.upsertRepoMemoryWithJudgment(db as unknown as D1Database, {
        memory: {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          sourcePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
          sourcePrNumber: 123,
          sourceSessionIds: ["sess-1"],
          memory: {
            id: "mem_123",
            vertical: "engineering",
            memory_type: "action",
            action_type: "procedure",
            level: "tactical",
            primitive: "procedure",
            engineering_domains: ["code_structure"],
            subjects: ["memory"],
            symbols: [],
            tags: ["process"],
            status: "active",
            confidence: "high",
            authority: "reviewed",
            owner: "cycloid",
            applies_to: ["src/example.ts"],
            context_hint: "When updating memory",
            source_pr_urls: ["https://github.com/trycycloid/cycloid/pull/123"],
            source_session_ids: ["sess-1"],
            evidence: [],
            enforcement: "none",
            triggers: null,
            supersedes: [],
            contradicts: [],
            created_at: "2026-06-12",
            updated_at: "2026-06-12",
            content: "Use the D1 sink for accepted repo memories.",
          },
        },
        judgment: {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          sourcePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
          sourcePrNumber: 123,
          sourceSessionIds: ["sess-1"],
          suggestionKind: "add",
          targetMemoryId: null,
          memoryId: "mem_123",
          verdict: "store",
          confidence: 0.91,
          rationale: "Grounded and reusable.",
          issues: [],
          candidateJson: '{"context_hint":"When updating memory"}',
          judgeModel: "gpt-5.4-mini",
        },
      });

      expect(db.queries).toHaveLength(2);
      expect(db.queries[0].sql).toContain("INSERT INTO repo_memories");
      expect(db.queries[1].sql).toContain("INSERT INTO repo_memory_judgments");
      expect(db.queries[1].sql).toContain("ON CONFLICT(id) DO UPDATE");
      expect(db.queries[1].binds).toContain("repo-memory-judgment:trycycloid:cycloid:123:add:mem_123");
      expect(db.queries[1].binds).toContain("store");
      expect(db.queries[1].binds).toContain("Grounded and reusable.");
    });

    it("tracks direct-D1 analyzer suggestions by source PR without a memory PR URL", async () => {
      await mod.upsertMemorySuggestionTracking(db as unknown as D1Database, {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        sourcePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        sourcePrNumber: 123,
        sourceSessionId: "sess-1",
        memoryPrUrl: null,
        memoryPrNumber: null,
        memoriesAdded: 1,
        memoriesUpdated: 0,
        memoriesRemoved: 0,
        suggestionsJson: '{"candidate_audit":[]}',
      });

      expect(db.queries).toHaveLength(1);
      expect(db.queries[0].sql).toContain("INSERT INTO memory_pr_tracking");
      expect(db.queries[0].sql).toContain("ON CONFLICT(id) DO UPDATE");
      expect(db.queries[0].binds).toContain("source:trycycloid/cycloid#123");
      expect(db.queries[0].binds).toContain(null);
      expect(db.queries[0].binds).toContain('{"candidate_audit":[]}');
    });

    it("lists active repo memories from stored MemoryFile JSON", async () => {
      db.nextAllResults = [
        {
          memoryJson: JSON.stringify({
            id: "mem_123",
            vertical: "engineering",
            memory_type: "action",
            action_type: "procedure",
            level: "tactical",
            primitive: "procedure",
            engineering_domains: ["code_structure"],
            subjects: [],
            symbols: [],
            tags: [],
            status: "active",
            confidence: "high",
            authority: "reviewed",
            owner: "cycloid",
            applies_to: ["src/example.ts"],
            context_hint: "When updating memory",
            source_pr_urls: [],
            source_session_ids: [],
            evidence: [],
            enforcement: "none",
            triggers: null,
            supersedes: [],
            contradicts: [],
            created_at: "2026-06-12",
            updated_at: "2026-06-12",
            content: "Use the D1 sink for accepted repo memories.",
          }),
        },
      ];

      const memories = await mod.listActiveRepoMemoriesForRepo(db as unknown as D1Database, "trycycloid", "cycloid");

      expect(memories).toHaveLength(1);
      expect(memories[0].id).toBe("mem_123");
      expect(db.queries[0].sql).toContain("FROM repo_memories");
      expect(db.queries[0].sql).toContain("status = 'active'");
      expect(db.queries[0].binds).toEqual(["trycycloid", "cycloid", 200]);
    });
  });

  describe("recordMemoryUsage (telemetry)", () => {
    it("uses INSERT OR IGNORE for idempotency", async () => {
      await mod.recordMemoryUsage(db as unknown as D1Database, ["mem-1", "mem-2"], "sess-1", "p-1");
      const insertQueries = db.queries.filter((q) => q.sql.includes("INSERT OR IGNORE"));
      expect(insertQueries.length).toBe(2);
      expect(insertQueries[0].binds).toContain("sess-1");
      expect(insertQueries[0].binds).toContain("p-1");
    });

    it("skips empty arrays", async () => {
      await mod.recordMemoryUsage(db as unknown as D1Database, [], "sess-1", "p-1");
      expect(db.queries).toHaveLength(0);
    });

    it("records rich memory usage events", async () => {
      await mod.recordMemoryUsageEvents(db as unknown as D1Database, [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          sessionId: "sess-1",
          promptId: "p-1",
          memoryId: "mem-1",
          source: "prompt_start",
          selectionRank: 1,
          selectionScore: 0.92,
          explanation: "matched auth flow",
          expectedEffect: "reuse existing helper",
        },
      ]);
      expect(db.queries).toHaveLength(1);
      expect(db.queries[0].sql).toContain("INSERT OR IGNORE INTO memory_usage_events");
      expect(db.queries[0].binds).toContain("trycycloid");
      expect(db.queries[0].binds).toContain("mem-1");
      expect(db.queries[0].binds).toContain("prompt_start");
      expect(db.queries[0].binds).toContain(0.92);
    });

    it("updates review outcome for matching memory usage telemetry", async () => {
      db.nextRunChanges = 1;
      const updated = await mod.updateMemoryUsageReviewOutcome(db as unknown as D1Database, {
        sessionId: "sess-1",
        promptId: "p-1",
        memoryId: "mem-1",
        source: "prompt_start",
        reviewOutcome: "helpful",
      });

      expect(updated).toBe(true);
      expect(db.queries[0].sql).toContain("UPDATE memory_usage_events");
      expect(db.queries[0].sql).toContain("review_outcome = ?");
      expect(db.queries[0].binds).toEqual(["helpful", "sess-1", "p-1", "mem-1", "prompt_start"]);
    });

    it("checks whether a feedback target was recorded by memory usage telemetry", async () => {
      db.nextFirstResult = { id: "usage-1" };
      const exists = await mod.memoryUsageFeedbackTargetExists(db as unknown as D1Database, {
        sessionId: "sess-1",
        promptId: "p-1",
        memoryId: "mem-1",
        source: "recall",
      });

      expect(exists).toBe(true);
      expect(db.queries[0].sql).toContain("FROM memory_usage_events");
      expect(db.queries[0].binds).toEqual(["sess-1", "p-1", "mem-1", "recall"]);
    });
  });

  describe("createMemoryAnalysisJob", () => {
    it("returns job ID when insert succeeds", async () => {
      db.nextRunChanges = 1;
      const id = await mod.createMemoryAnalysisJob(db as unknown as D1Database, "acme", "repo", 42, '{"test":true}');
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
      const insert = db.queries.find((q) => q.sql.includes("INSERT INTO memory_analysis_jobs"));
      expect(insert).toBeTruthy();
      expect(insert!.binds).toContain("acme");
      expect(insert!.binds).toContain("repo");
      expect(insert!.binds).toContain(42);
      expect(insert!.binds).toContain('{"test":true}');
    });

    it("returns null when PR already has a job (duplicate)", async () => {
      db.nextRunChanges = 0;
      const id = await mod.createMemoryAnalysisJob(db as unknown as D1Database, "acme", "repo", 42, "{}");
      expect(id).toBeNull();
    });

    it("uses ON CONFLICT(repo_owner, repo_name, pr_number) DO NOTHING", async () => {
      db.nextRunChanges = 1;
      await mod.createMemoryAnalysisJob(db as unknown as D1Database, "acme", "repo", 42, "{}");
      const insert = db.queries.find((q) => q.sql.includes("INSERT INTO memory_analysis_jobs"));
      expect(insert!.sql).toContain("ON CONFLICT(repo_owner, repo_name, pr_number) DO NOTHING");
    });
  });

  describe("getMemoryAnalysisJob", () => {
    it("returns job row when found", async () => {
      const fakeRow = { id: "job-1", review_id: 7001, status: "pending", params_json: "{}", attempt_count: 0 };
      db.nextFirstResult = fakeRow;
      const job = await mod.getMemoryAnalysisJob(db as unknown as D1Database, "job-1");
      expect(job).toEqual(fakeRow);
    });

    it("returns null when not found", async () => {
      db.nextFirstResult = null;
      const job = await mod.getMemoryAnalysisJob(db as unknown as D1Database, "nonexistent");
      expect(job).toBeNull();
    });
  });

  describe("claimMemoryAnalysisJob", () => {
    it("returns attempt_count when job is claimed", async () => {
      db.nextFirstResult = { attempt_count: 1 };
      const attemptCount = await mod.claimMemoryAnalysisJob(db as unknown as D1Database, "job-1", 240_000, 3);
      expect(attemptCount).toBe(1);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update).toBeTruthy();
      expect(update!.sql).toContain("status = 'processing'");
      expect(update!.sql).toContain("attempt_count = attempt_count + 1");
      expect(update!.sql).toContain("RETURNING attempt_count");
    });

    it("returns null when job is not claimable", async () => {
      db.nextFirstResult = null;
      const attemptCount = await mod.claimMemoryAnalysisJob(db as unknown as D1Database, "job-1", 240_000, 3);
      expect(attemptCount).toBeNull();
    });

    it("binds computed staleCutoff (Date.now() - threshold), not raw threshold", async () => {
      const before = Date.now();
      db.nextFirstResult = null;
      await mod.claimMemoryAnalysisJob(db as unknown as D1Database, "job-1", 240_000, 3);
      const after = Date.now();
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      // Bind order: $1=now, $2=jobId, $3=maxAttempts, $4=staleCutoff
      const staleCutoff = update!.binds[3] as number;
      expect(staleCutoff).toBeGreaterThanOrEqual(before - 240_000);
      expect(staleCutoff).toBeLessThanOrEqual(after - 240_000);
    });

    it("claims pending, failed, and stale-processing jobs", async () => {
      db.nextFirstResult = { attempt_count: 1 };
      await mod.claimMemoryAnalysisJob(db as unknown as D1Database, "job-1", 240_000, 3);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update!.sql).toContain("status = 'pending'");
      expect(update!.sql).toContain("status = 'failed'");
      expect(update!.sql).toContain("status = 'processing' AND started_at <");
    });

    it("respects maxAttempts guard", async () => {
      db.nextFirstResult = { attempt_count: 1 };
      await mod.claimMemoryAnalysisJob(db as unknown as D1Database, "job-1", 240_000, 3);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update!.sql).toContain("attempt_count <");
      // maxAttempts is bound as $3
      expect(update!.binds[2]).toBe(3);
    });
  });

  describe("completeMemoryAnalysisJob", () => {
    it("sets status, completed_at, and guards on attempt_count", async () => {
      await mod.completeMemoryAnalysisJob(db as unknown as D1Database, "job-1", "complete", 2);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update!.binds[0]).toBe("complete");
      expect(typeof update!.binds[1]).toBe("number"); // completed_at timestamp
      expect(update!.binds[2]).toBe("job-1");
      expect(update!.binds[3]).toBe(2); // attempt_count guard
      expect(update!.sql).toContain("attempt_count = ?");
    });

    it("accepts 'skipped' status", async () => {
      await mod.completeMemoryAnalysisJob(db as unknown as D1Database, "job-1", "skipped", 1);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update!.binds[0]).toBe("skipped");
    });
  });

  describe("failMemoryAnalysisJob", () => {
    it("sets status to failed with truncated error and attempt_count guard", async () => {
      const longError = "x".repeat(2000);
      await mod.failMemoryAnalysisJob(db as unknown as D1Database, "job-1", longError, 3);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update!.sql).toContain("status = 'failed'");
      expect(update!.sql).toContain("attempt_count = ?");
      const errorBind = update!.binds[0] as string;
      expect(errorBind.length).toBe(1000); // truncated
      expect(update!.binds[3]).toBe(3); // attempt_count guard
    });
  });

  describe("getReenqueueableMemoryJobs", () => {
    it("returns matching job IDs", async () => {
      db.nextAllResults = [{ id: "job-1" }, { id: "job-2" }];
      const jobs = await mod.getReenqueueableMemoryJobs(db as unknown as D1Database, 240_000, 3);
      expect(jobs).toEqual([{ id: "job-1" }, { id: "job-2" }]);
    });

    it("binds computed staleCutoff, not raw threshold", async () => {
      const before = Date.now();
      db.nextAllResults = [];
      await mod.getReenqueueableMemoryJobs(db as unknown as D1Database, 240_000, 3);
      const after = Date.now();
      const select = db.queries.find((q) => q.sql.includes("SELECT id FROM memory_analysis_jobs"));
      // staleCutoff is $3 in bind order: $1=maxAttempts, $2=maxAttempts, $3=staleCutoff, $4=maxAttempts
      const staleCutoff = select!.binds[2] as number;
      expect(staleCutoff).toBeGreaterThanOrEqual(before - 240_000);
      expect(staleCutoff).toBeLessThanOrEqual(after - 240_000);
    });

    it("limits results to 10", async () => {
      db.nextAllResults = [];
      await mod.getReenqueueableMemoryJobs(db as unknown as D1Database, 240_000, 3);
      const select = db.queries.find((q) => q.sql.includes("SELECT id FROM memory_analysis_jobs"));
      expect(select!.sql).toContain("LIMIT 10");
    });
  });

  describe("terminalizeExhaustedJobs", () => {
    it("updates stale processing jobs at max attempts to failed", async () => {
      await mod.terminalizeExhaustedJobs(db as unknown as D1Database, 240_000, 3);
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      expect(update!.sql).toContain("status = 'failed'");
      expect(update!.sql).toContain("error = 'max attempts exhausted'");
      expect(update!.sql).toContain("status = 'processing'");
      expect(update!.sql).toContain("attempt_count >=");
      expect(update!.sql).toContain("started_at <");
    });

    it("binds computed staleCutoff, not raw threshold", async () => {
      const before = Date.now();
      await mod.terminalizeExhaustedJobs(db as unknown as D1Database, 240_000, 3);
      const after = Date.now();
      const update = db.queries.find((q) => q.sql.includes("UPDATE memory_analysis_jobs"));
      // Bind order: $1=Date.now() (completed_at), $2=maxAttempts, $3=staleCutoff
      const staleCutoff = update!.binds[2] as number;
      expect(staleCutoff).toBeGreaterThanOrEqual(before - 240_000);
      expect(staleCutoff).toBeLessThanOrEqual(after - 240_000);
    });

    it("returns the number of terminalized jobs", async () => {
      db.nextRunChanges = 2;
      await expect(mod.terminalizeExhaustedJobs(db as unknown as D1Database, 240_000, 3)).resolves.toBe(2);
      db.nextRunChanges = 0;
      await expect(mod.terminalizeExhaustedJobs(db as unknown as D1Database, 240_000, 3)).resolves.toBe(0);
    });

    it("returns 0 when D1 omits meta", async () => {
      db.nextRunResultOverride = {};
      await expect(mod.terminalizeExhaustedJobs(db as unknown as D1Database, 240_000, 3)).resolves.toBe(0);
    });
  });
});
