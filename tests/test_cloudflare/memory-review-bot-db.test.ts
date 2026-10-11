import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  type InsertMemoryReviewBotRunInput,
  insertMemoryReviewBotRunResults,
  listPendingMemoryReviewBotDigestRuns,
} from "../../apps/control-plane-worker/src/memory-review-bot/review-db";
import {
  runMemoryReviewBotDailyDigest,
  runMemoryReviewBotForCompletedPrompt,
} from "../../apps/control-plane-worker/src/memory-review-bot/review-service";
import type { Env } from "../../apps/control-plane-worker/src/types";

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

  runSync(): { success: true; meta: { changes: number }; results?: Array<Record<string, unknown>> } {
    const normalized = this.query.trim().toUpperCase();
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      return {
        success: true,
        meta: { changes: 0 },
        results: this.db.prepare(this.query).all(...this.boundValues) as Array<Record<string, unknown>>,
      };
    }
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: result.changes } };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(
    statements: SqliteD1Statement[],
  ): Promise<Array<{ success: true; meta: { changes: number }; results?: Array<Record<string, unknown>> }>> {
    const tx = this.db.transaction(() => statements.map((statement) => statement.runSync()));
    return tx();
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0153_repo_memory_d1_sink.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0185_memory_review_bot.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0200_cron_sweep_cursors.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0235_honcho_style_memory_context_graph.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("memory review bot DAO", () => {
  it("runs directly for a completed prompt and persists results", async () => {
    seedPromptMemoryInputs();

    const result = await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async () => ({
          prompt_outcome: "true_positive",
          confidence: 0.8,
          summary: "The memory helped.",
          memory_results: [
            {
              memory_id: "mem-1",
              relevance: "relevant",
              usefulness: "useful",
              effect: "helped",
              lifecycle_state: "active",
              root_causes: [],
              evidence_ids: ["prompt", "completion", "usage:mem-1", "memory:mem-1"],
              rationale: "The memory matched the requested webhook route.",
            },
          ],
        }),
      },
    );

    expect(result.status).toBe("complete");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_bot_runs").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_bot_item_results").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT slack_post_status AS status FROM memory_review_bot_runs").get()).toEqual({
      status: "pending",
    });
  });

  it("posts one daily Slack digest for pending prior-day runs", async () => {
    await insertMemoryReviewBotRunResults(
      db,
      buildRunInput({
        runId: "run-fp",
        outcome: "false_positive",
        inputSnapshotJson: JSON.stringify({
          evidence: [
            {
              kind: "context_query",
              text: "trace_id=trace-1; selector_status=timeout; candidate_count=30",
            },
          ],
        }),
      }),
    );
    await insertMemoryReviewBotRunResults(
      db,
      buildRunInput({
        runId: "run-tp",
        outcome: "true_positive",
        usefulCount: 1,
        hurtCount: 0,
        summary: "Memory helped the route edit.",
        inputSnapshotJson: JSON.stringify({
          evidence: [
            {
              kind: "context_query",
              text: "trace_id=trace-2; selector_status=selected; intent=debug text; selector_status=timeout; selected=mem-1",
            },
          ],
        }),
      }),
    );
    sqlite.prepare("UPDATE memory_review_bot_runs SET slack_post_status = 'failed' WHERE id = 'run-tp'").run();
    await insertMemoryReviewBotRunResults(
      db,
      buildRunInput({
        runId: "run-today",
        outcome: "false_negative",
        completedAtMs: Date.UTC(2026, 6, 2, 1),
      }),
    );

    const posts: Array<{ text: string; blocks: unknown[] | undefined }> = [];
    const result = await runMemoryReviewBotDailyDigest(
      {
        DB: db,
        SLACK_BOT_TOKEN: "xoxb-test",
        FRONTEND_URL: "https://app.trycycloid.com",
      } as Env,
      {
        nowMs: Date.UTC(2026, 6, 2, 0, 5),
        postSlackMessage: async (_token, _channel, text, blocks) => {
          posts.push({ text, blocks });
          return { ok: true, channel: "C123", ts: "123.456" };
        },
      },
    );

    expect(result).toEqual({ status: "sent", runCount: 2 });
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("Memory recall daily review (2026-07-01 UTC)");
    expect(posts[0].text).toContain(
      "Runs: 2; evaluated: 1; selector failure runs: 1; TP: 1; FP: 0; TN: 0; FN: 0; hurt: 0",
    );
    expect(posts[0].text).toContain("selector_failure | evaluation excluded");
    expect(posts[0].text).not.toContain("selector_failure 80%");
    expect(posts[0].text).not.toContain("1 hurt");
    expect(JSON.stringify(posts[0].blocks)).toContain("Selector failure runs");
    expect(
      sqlite
        .prepare(
          "SELECT id, slack_post_status AS status, slack_channel_id AS channel FROM memory_review_bot_runs ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "run-fp", status: "sent", channel: "C123" },
      { id: "run-today", status: "pending", channel: null },
      { id: "run-tp", status: "sent", channel: "C123" },
    ]);
    expect(
      sqlite.prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = ?").get("memory_review_bot_daily_digest"),
    ).toEqual({
      cursor: "2026-07-01",
    });

    const second = await runMemoryReviewBotDailyDigest({ DB: db, SLACK_BOT_TOKEN: "xoxb-test" } as Env, {
      nowMs: Date.UTC(2026, 6, 2, 0, 10),
      postSlackMessage: async () => {
        throw new Error("should not post twice");
      },
    });
    expect(second).toEqual({ status: "skipped", runCount: 0, reason: "already_sent" });
  });

  it("keeps digest root causes intact even when a root cause contains a pipe", async () => {
    const input = buildRunInput({ runId: "run-pipe", outcome: "false_positive", hurtCount: 1 });
    input.itemResults[0].rootCauses = ["scope|leak across tenants", "stale_supersession"];
    await insertMemoryReviewBotRunResults(db, input);

    const runs = await listPendingMemoryReviewBotDigestRuns(db, {
      startMs: Date.UTC(2026, 6, 1, 0),
      endMs: Date.UTC(2026, 6, 2, 0),
      limit: 10,
    });

    const pipeRun = runs.find((entry) => entry.run.id === "run-pipe");
    expect(pipeRun?.rootCauses).toEqual(["scope|leak across tenants", "stale_supersession"]);
  });

  it("passes populated platform telemetry (memory phase, session context) to the wrapper", async () => {
    seedPromptMemoryInputs();

    let captured: { env: unknown; telemetry: Record<string, unknown> } | undefined;
    await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async (env, _options, telemetry) => {
          captured = { env, telemetry: telemetry as unknown as Record<string, unknown> };
          return {
            prompt_outcome: "true_positive",
            confidence: 0.8,
            summary: "The memory helped.",
            memory_results: [
              {
                memory_id: "mem-1",
                relevance: "relevant",
                usefulness: "useful",
                effect: "helped",
                lifecycle_state: "active",
                root_causes: [],
                evidence_ids: ["prompt", "completion", "usage:mem-1", "memory:mem-1"],
                rationale: "The memory matched the requested webhook route.",
              },
            ],
          };
        },
      },
    );

    expect(captured?.telemetry).toMatchObject({
      subsystem: "memory_review_bot",
      callType: "review",
      phase: "memory",
      sourceId: "prompt-2",
      sessionId: "sess-1",
      promptId: "prompt-2",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    expect((captured?.env as { ARCANIST_OPENAI_API_KEY?: string })?.ARCANIST_OPENAI_API_KEY).toBe("test-key");
  });

  it("reviews live recall usage recorded under an agent bridge prompt id", async () => {
    seedPromptMemoryInputs();
    sqlite.prepare("DELETE FROM memory_usage_events WHERE id = 'usage-1'").run();
    sqlite
      .prepare(
        `INSERT INTO session_completions
         (business_id, session_id, prompt_id, repo_owner, repo_name, prompt_text, title, diff_summary, success, completed_at)
         VALUES ('biz-1', 'sess-1', 'prompt-1', 'trycycloid', 'cycloid', 'Earlier task.', 'Earlier', 'Earlier done.', 1, 500)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO memory_usage_events
         (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source, selection_rank, selection_score, used_at)
         VALUES ('usage-old', 'trycycloid', 'cycloid', 'sess-1', 'codex-message-old', 'mem-old', 'recall', 1, 0.8, 400)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO memory_usage_events
         (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source, selection_rank, selection_score, used_at)
         VALUES ('usage-bridge', 'trycycloid', 'cycloid', 'sess-1', 'codex-message-current', 'mem-1', 'recall', 1, 0.9, 900)`,
      )
      .run();

    const result = await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async (_env, options) => {
          const input = JSON.parse(options.userPrompt);
          expect(input.returnedMemories.map((memory: { memoryId: string }) => memory.memoryId)).toEqual(["mem-1"]);
          return {
            prompt_outcome: "true_positive",
            confidence: 0.8,
            summary: "The memory helped.",
            memory_results: [
              {
                memory_id: "mem-1",
                relevance: "relevant",
                usefulness: "useful",
                effect: "helped",
                lifecycle_state: "active",
                root_causes: [],
                evidence_ids: ["prompt", "completion", "usage:mem-1", "memory:mem-1"],
                rationale: "The memory matched the requested webhook route.",
              },
            ],
          };
        },
      },
    );

    expect(result.status).toBe("complete");
  });

  it("reviews first-prompt live recall usage from the start of the session window", async () => {
    seedPromptMemoryInputs();
    sqlite.prepare("DELETE FROM memory_usage_events").run();
    sqlite
      .prepare(
        `INSERT INTO memory_usage_events
         (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source, selection_rank, selection_score, used_at)
         VALUES ('usage-first-window', 'trycycloid', 'cycloid', 'sess-1', 'codex-message-current', 'mem-1', 'recall', 1, 0.9, 100)`,
      )
      .run();

    const result = await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async (_env, options) => {
          const input = JSON.parse(options.userPrompt);
          expect(input.returnedMemories.map((memory: { memoryId: string }) => memory.memoryId)).toEqual(["mem-1"]);
          return {
            prompt_outcome: "true_positive",
            confidence: 0.8,
            summary: "The memory helped.",
            memory_results: [
              {
                memory_id: "mem-1",
                relevance: "relevant",
                usefulness: "useful",
                effect: "helped",
                lifecycle_state: "active",
                root_causes: [],
                evidence_ids: ["prompt", "completion", "usage:mem-1", "memory:mem-1"],
                rationale: "The memory matched the requested webhook route.",
              },
            ],
          };
        },
      },
    );

    expect(result.status).toBe("complete");
  });

  it("reviews a memory context query that returned no memories", async () => {
    seedPromptMemoryInputs();
    sqlite.prepare("DELETE FROM memory_usage_events").run();
    sqlite
      .prepare(
        `INSERT INTO memory_context_queries
         (id, business_id, session_id, prompt_id, scope_id, intent, request_json, lane_counts_json,
          vector_available, vector_unavailable_reason, fusion_mode, candidate_ids_json, selected_ids_json,
          rejected_json, selector_status, selector_model, selector_latency_ms, trace_json, created_at_ms)
         VALUES ('trace-empty', 'biz-1', 'sess-1', 'memory-context', NULL, 'Fix webhook route.', '{}', '{}',
          1, NULL, 'rrf', '["candidate-1"]', '[]', '[]', 'empty', 'gpt-5.4', 12, '{}', 900)`,
      )
      .run();

    const result = await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async (_env, options) => {
          const input = JSON.parse(options.userPrompt);
          expect(input.returnedMemories).toEqual([]);
          expect(input.evidence.map((entry: { kind: string }) => entry.kind)).toContain("context_query");
          return {
            prompt_outcome: "true_negative",
            confidence: 0.7,
            summary: "The memory query did not return applicable memories.",
            failure_code: null,
            memory_results: [],
          };
        },
      },
    );

    expect(result.status).toBe("complete");
    expect(sqlite.prepare("SELECT prompt_outcome AS outcome FROM memory_review_bot_runs").get()).toEqual({
      outcome: "true_negative",
    });
  });

  it("hydrates graph conclusion and message memories for review evidence", async () => {
    seedPromptMemoryInputs();
    sqlite.prepare("DELETE FROM memory_usage_events").run();
    seedGraphMemoryRows();
    sqlite
      .prepare(
        `INSERT INTO memory_usage_events
         (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source, selection_rank, selection_score, used_at)
         VALUES
         ('usage-conclusion', 'trycycloid', 'cycloid', 'sess-1', 'prompt-2', 'memory_conclusion:conclusion-1', 'recall', 1, 0.9, 900),
         ('usage-message', 'trycycloid', 'cycloid', 'sess-1', 'prompt-2', 'memory-message:biz-1:evt-1', 'recall', 2, 0.8, 901)`,
      )
      .run();

    const result = await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async (_env, options) => {
          const input = JSON.parse(options.userPrompt);
          const byId = new Map(
            input.returnedMemories.map((memory: { memoryId: string; content: string }) => [memory.memoryId, memory]),
          );
          expect(byId.get("memory_conclusion:conclusion-1")?.content).toContain("Use service helpers");
          expect(byId.get("memory-message:biz-1:evt-1")?.content).toContain("Customer mentioned webhook routing");
          return {
            prompt_outcome: "true_positive",
            confidence: 0.8,
            summary: "Graph memories were available for review.",
            failure_code: null,
            memory_results: [
              {
                memory_id: "memory_conclusion:conclusion-1",
                relevance: "relevant",
                usefulness: "useful",
                effect: "helped",
                lifecycle_state: "active",
                root_causes: [],
                evidence_ids: [
                  "prompt",
                  "completion",
                  "usage:memory_conclusion:conclusion-1",
                  "memory:memory_conclusion:conclusion-1",
                ],
                rationale: "The conclusion matched the webhook route change.",
              },
              {
                memory_id: "memory-message:biz-1:evt-1",
                relevance: "borderline",
                usefulness: "not_useful",
                effect: "neutral",
                lifecycle_state: "active",
                root_causes: [],
                evidence_ids: ["usage:memory-message:biz-1:evt-1", "memory:memory-message:biz-1:evt-1"],
                rationale: "The raw message was related but not directly useful.",
              },
            ],
          };
        },
      },
    );

    expect(result.status).toBe("complete");
  });

  it("fails validation errors without writing partial run results", async () => {
    seedPromptMemoryInputs();

    const result = await runMemoryReviewBotForCompletedPrompt(
      { DB: db, ARCANIST_OPENAI_API_KEY: "test-key" } as Env,
      { businessId: "biz-1", sessionId: "sess-1", promptId: "prompt-2" },
      {
        queryStructuredOutput: async () => ({
          prompt_outcome: "false_positive",
          confidence: 0.8,
          summary: "Invalid because memory result is missing.",
          memory_results: [],
        }),
      },
    );

    expect(result).toMatchObject({ status: "failed", failureCode: "missing_memory_result" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_bot_runs").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_review_bot_item_results").get()).toEqual({ count: 0 });
  });
});

function seedPromptMemoryInputs(): void {
  sqlite.exec(`
    CREATE TABLE session_completions (
      business_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      repo_owner TEXT,
      repo_name TEXT,
      prompt_text TEXT NOT NULL,
      title TEXT,
      diff_summary TEXT,
      success INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );

    CREATE TABLE memory_usage_events (
      id TEXT PRIMARY KEY,
      repo_owner TEXT,
      repo_name TEXT,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      source TEXT NOT NULL,
      selection_rank INTEGER,
      selection_score REAL,
      explanation TEXT,
      expected_effect TEXT,
      observed_effect TEXT,
      intent TEXT,
      files_json TEXT,
      symbols_json TEXT,
      review_outcome TEXT,
      used_at INTEGER NOT NULL
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO session_completions
       (business_id, session_id, prompt_id, repo_owner, repo_name, prompt_text, title, diff_summary, success, completed_at)
       VALUES ('biz-1', 'sess-1', 'prompt-2', 'trycycloid', 'cycloid', 'Fix webhook route.', 'Webhook fix', 'Updated route.', 1, 1000)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_usage_events
       (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source, selection_rank, selection_score, used_at)
       VALUES ('usage-1', 'trycycloid', 'cycloid', 'sess-1', 'prompt-2', 'mem-1', 'recall', 1, 0.9, 900)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO repo_memories
       (id, repo_owner, repo_name, memory_id, status, memory_type, level, primitive, confidence, authority,
        enforcement, context_hint, content, applies_to_json, source_session_ids_json, memory_json, created_at_ms, updated_at_ms)
       VALUES ('repo-memory-row-1', 'trycycloid', 'cycloid', 'mem-1', 'active', 'procedural', 'repo',
        'rule', 'high', 'reviewed', 'warn', 'When editing webhooks', 'Use the webhook helper.', '[]', '[]', '{}', 100, 100)`,
    )
    .run();
}

function seedGraphMemoryRows(): void {
  sqlite
    .prepare(
      `INSERT INTO memory_scopes
       (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
       VALUES ('scope-1', 'biz-1', 'repo', 'trycycloid/cycloid', 'trycycloid', 'cycloid', '{}', 100, 100)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_peers
       (id, business_id, peer_type, peer_key, display_name, metadata_json, created_at_ms, updated_at_ms)
       VALUES
       ('peer-observer', 'biz-1', 'agent', 'cycloid', 'Cycloid', '{}', 100, 100),
       ('peer-observed', 'biz-1', 'repo', 'trycycloid/cycloid', 'trycycloid/cycloid', '{}', 100, 100)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_sessions
       (id, business_id, scope_id, source_kind, source_id, title, started_at_ms, metadata_json, created_at_ms, updated_at_ms)
       VALUES ('memory-session-1', 'biz-1', 'scope-1', 'arcanist_session', 'sess-1', 'Session', 100, '{}', 100, 100)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_collections
       (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
       VALUES ('collection-1', 'biz-1', 'scope-1', 'peer-observer', 'peer-observed', 'repo', '{}', 100, 100)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_conclusions
       (id, business_id, collection_id, scope_id, kind, content, level, status, confidence, authority, enforcement,
        source_kind, source_id, repo_owner, repo_name, created_at_ms, updated_at_ms, metadata_json)
       VALUES ('conclusion-1', 'biz-1', 'collection-1', 'scope-1', 'rule', 'Use service helpers before route logic.',
        'explicit', 'active', 'high', 'reviewed', 'warn', 'repo_memory', 'repo-1', 'trycycloid', 'cycloid', 100, 100, '{}')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_messages
       (id, business_id, session_id, seq_in_session, role, content_text, source_uri, occurred_at_ms, created_at_ms)
       VALUES ('memory-message:biz-1:evt-1', 'biz-1', 'memory-session-1', 1, 'user', 'Customer mentioned webhook routing constraints.',
        'session://sess-1', 100, 100)`,
    )
    .run();
}

function buildRunInput(overrides: {
  runId: string;
  outcome: InsertMemoryReviewBotRunInput["promptOutcome"];
  usefulCount?: number;
  hurtCount?: number;
  summary?: string;
  completedAtMs?: number;
  inputSnapshotJson?: string;
}): InsertMemoryReviewBotRunInput {
  const usefulCount = overrides.usefulCount ?? 0;
  const hurtCount = overrides.hurtCount ?? 1;
  return {
    runId: overrides.runId,
    businessId: "biz-1",
    sessionId: `sess-${overrides.runId}`,
    promptId: `prompt-${overrides.runId}`,
    reviewerModel: "gpt-5.4-mini",
    promptVersion: "memory-review-bot-v1",
    schemaVersion: "memory-review-bot-output-v1",
    inputSnapshotJson: overrides.inputSnapshotJson ?? "{}",
    outputJson: "{}",
    promptOutcome: overrides.outcome,
    confidence: 0.8,
    summary: overrides.summary ?? "Memory was not useful.",
    evidenceJson: "[]",
    recallResults: [
      {
        source: "recall",
        memoryCount: 1,
        relevantCount: usefulCount,
        usefulCount,
        hurtCount,
        promptOutcome: overrides.outcome,
        aggregateEffect: hurtCount > 0 ? "hurt" : usefulCount > 0 ? "helped" : "neutral",
        provenanceNotes: [],
        evidenceIds: ["prompt", "usage:mem-1"],
      },
    ],
    itemResults: [
      {
        memoryId: `mem-${overrides.runId}`,
        source: "recall",
        relevance: usefulCount > 0 ? "relevant" : "irrelevant",
        usefulness: usefulCount > 0 ? "useful" : "not_useful",
        effect: hurtCount > 0 ? "hurt" : usefulCount > 0 ? "helped" : "neutral",
        lifecycleState: "active",
        rootCauses: hurtCount > 0 ? ["retrieval"] : [],
        evidenceIds: ["prompt", "usage:mem-1"],
        rationale: "Fixture memory result.",
        scopeStatus: "in_scope",
      },
    ],
    startedAtMs: Date.UTC(2026, 6, 1, 11, 59),
    completedAtMs: overrides.completedAtMs ?? Date.UTC(2026, 6, 1, 12),
  };
}
