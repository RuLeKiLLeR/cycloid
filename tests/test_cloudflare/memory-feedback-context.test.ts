import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { submitMemoryFeedback } from "../../apps/control-plane-worker/src/services/memory-feedback";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

function applyMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE session_evaluations (id TEXT PRIMARY KEY)");
  db.exec(readFileSync("apps/control-plane-worker/migrations/0108_memory_usage_events_and_eval_reviews.sql", "utf8"));
  db.exec(readFileSync("apps/control-plane-worker/migrations/0136_memory_usage_company_sources.sql", "utf8"));
  db.exec(readFileSync("apps/control-plane-worker/migrations/0146_memory_feedback.sql", "utf8"));
  db.exec(readFileSync("apps/control-plane-worker/migrations/0187_memory_feedback_company_recall.sql", "utf8"));
  db.exec(readFileSync("apps/control-plane-worker/migrations/0153_repo_memory_d1_sink.sql", "utf8"));
  db.exec(readFileSync("apps/control-plane-worker/migrations/0235_honcho_style_memory_context_graph.sql", "utf8"));
}

function seedConclusion(db: Database.Database): void {
  db.prepare(
    `INSERT INTO memory_scopes
     (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
     VALUES ('scope-1', 'biz-1', 'repo', 'trycycloid/cycloid', 'trycycloid', 'cycloid', '{}', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_peers
     (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
     VALUES ('peer-agent', 'biz-1', 'agent', 'cycloid', '{}', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_peers
     (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
     VALUES ('peer-repo', 'biz-1', 'repo', 'trycycloid/cycloid', '{}', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_collections
     (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
     VALUES ('collection-1', 'biz-1', 'scope-1', 'peer-agent', 'peer-repo', 'repo', '{}', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_conclusions
     (id, business_id, collection_id, scope_id, kind, content, level, status, confidence, authority,
      enforcement, created_at_ms, updated_at_ms, metadata_json)
     VALUES ('conclusion-1', 'biz-1', 'collection-1', 'scope-1', 'fact', 'Routes call services.', 'explicit',
      'active', 'high', 'reviewed', 'none', 1000, 1000, '{}')`,
  ).run();
}

function seedMemoryUsage(db: Database.Database, memoryId: string, source: "recall" | "company_recall"): void {
  db.prepare(
    `INSERT INTO memory_usage_events
     (id, session_id, prompt_id, memory_id, source, used_at)
     VALUES (?, 'session-1', 'prompt-1', ?, ?, 1000)`,
  ).run(`usage-${memoryId}-${source}`, memoryId, source);
}

describe("memory feedback graph counters", () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    seedConclusion(sqlite);
    env = { DB: new SqliteD1(sqlite) as unknown as D1Database } as Env;
  });

  it("updates active graph conclusion feedback counters for recall feedback", async () => {
    seedMemoryUsage(sqlite, "memory_conclusion:conclusion-1", "company_recall");
    seedMemoryUsage(sqlite, "conclusion-1", "recall");

    await expect(
      submitMemoryFeedback({
        env,
        sessionId: "session-1",
        session: { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid" },
        auth: { userId: "user-1", userLogin: "octocat" },
        payload: {
          promptId: "prompt-1",
          activityEventId: "event-up",
          displayEventType: "memory_recall_usage",
          usageSource: "company_recall",
          memoryId: "memory_conclusion:conclusion-1",
          rating: "up",
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      submitMemoryFeedback({
        env,
        sessionId: "session-1",
        session: { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid" },
        auth: { userId: "user-1", userLogin: "octocat" },
        payload: {
          promptId: "prompt-1",
          activityEventId: "event-down",
          displayEventType: "memory_recall_usage",
          usageSource: "recall",
          memoryId: "conclusion-1",
          rating: "down",
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(
      sqlite
        .prepare(
          `SELECT positive_feedback_count AS positiveFeedbackCount,
                  negative_feedback_count AS negativeFeedbackCount
           FROM memory_conclusions
           WHERE id = 'conclusion-1'`,
        )
        .get(),
    ).toEqual({ positiveFeedbackCount: 1, negativeFeedbackCount: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT memory_id AS memoryId, source, review_outcome AS reviewOutcome
           FROM memory_usage_events
           ORDER BY memory_id ASC`,
        )
        .all(),
    ).toEqual([
      { memoryId: "conclusion-1", source: "recall", reviewOutcome: "incorrect" },
      { memoryId: "memory_conclusion:conclusion-1", source: "company_recall", reviewOutcome: "helpful" },
    ]);
  });
});
