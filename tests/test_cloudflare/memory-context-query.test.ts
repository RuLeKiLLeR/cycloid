import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMemoryContextQueryForSession } from "../../apps/control-plane-worker/src/company-memory/context-query";
import type { MemoryContextSelector } from "../../apps/control-plane-worker/src/company-memory/context-selector";
import type { MemoryVectorIndex } from "../../apps/control-plane-worker/src/company-memory/vector-index";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { createMemoryContextD1 } from "./helpers/memory-context-db";

function selectorSelecting(ids: string[]): MemoryContextSelector {
  return {
    async select(input) {
      const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
      const selectedIds = ids.filter((memoryId) => candidateIds.has(memoryId));
      return {
        status: selectedIds.length ? "selected" : "empty",
        selected: selectedIds.map((memoryId) => ({
          memoryId,
          score: 0.9,
          selectionRationale: "selected by test selector",
          expectedEffect: "use relevant memory",
          evidence: {
            matchedTaskAnchor: "task",
            matchedMemoryAnchor: "memory",
            retrievalLanes: input.candidates.find((candidate) => candidate.id === memoryId)?.lanes ?? [],
            sourceUri: null,
          },
        })),
        rejected: [],
        emptyReason: selectedIds.length ? null : "no relevant memory",
        selectorConfidence: 0.9,
      };
    },
  };
}

describe("memory context query", () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite, d1 } = createMemoryContextD1());
  });

  it("returns structured repo memories with trace metadata", async () => {
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall repo-rule-1 before updating apps/control-plane-worker/src/routes/sessions.ts auth checks",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          sourcePrNumbers: [123],
          maxMemories: 2,
          memories: [
            {
              id: "repo-rule-1",
              type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "reviewed",
              content: "Routes must call services instead of D1 directly.",
              context_hint: "Routes must call services",
              confidence: "high",
              enforcement: "warn",
              source_pr_number: 123,
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
              candidate_channels: ["path_match"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["repo-rule-1"]) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      memories: Array<{ id: string; kind: string; content: string; provenance: unknown[] }>;
      repoRankings: Array<{ id: string }>;
      traceId: string;
      retrievalTrace: { vectorAvailable: boolean; vectorUnavailableReason: string };
    };
    expect(body.traceId).toEqual(expect.any(String));
    expect(body.memories).toMatchObject([
      {
        id: "repo-rule-1",
        kind: "repo_rule",
        content: "Routes must call services instead of D1 directly.",
        provenance: [{ sourceKind: "repo_memory", sourceId: "repo-rule-1" }],
      },
    ]);
    expect(body.repoRankings).toMatchObject([{ id: "repo-rule-1" }]);
    expect(body.retrievalTrace).toMatchObject({
      vectorAvailable: false,
      vectorUnavailableReason: "missing_vectorize_binding",
    });
  });

  it("allows repo FTS memories to supplement sandbox repo rankings", async () => {
    sqlite
      .prepare(
        `INSERT INTO repo_memories
         (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
          primitive, confidence, authority, enforcement, context_hint, content,
          applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
          memory_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "row-fts-extra",
        "trycycloid",
        "cycloid",
        "repo-fts-extra",
        "active",
        "action",
        "procedure",
        "tactical",
        "procedure",
        "high",
        "reviewed",
        "warn",
        "routes services extra",
        "Unrelated routes services memory that only appears through repo FTS.",
        '["apps/control-plane-worker/src/routes/**"]',
        null,
        null,
        "[]",
        "{}",
        1000,
        1000,
      );

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Recall repo-ranked before updating apps/control-plane-worker/src/routes/sessions.ts services",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 5,
          memories: [
            {
              id: "repo-ranked",
              type: "action",
              content: "Routes must call services instead of D1 directly.",
              context_hint: "routes services",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-filter-repo-fts",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["repo-ranked", "repo-fts-extra"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      repoRankings: Array<{ id: string }>;
      retrievalTrace: { laneCounts: Record<string, number>; selector: { selected: Array<{ memoryId: string }> } };
    };

    expect(response.status).toBe(200);
    expect(body.repoRankings).toMatchObject([{ id: "repo-ranked" }]);
    expect(body.retrievalTrace.laneCounts.repo_fts).toBeGreaterThan(0);
    expect(body.retrievalTrace.selector.selected.map((selection) => selection.memoryId)).toContain("repo-fts-extra");
    expect(body.memories.map((memory) => memory.id)).toEqual(["repo-ranked", "repo-fts-extra"]);
  });

  it("excludes QA runtime memories from the repo FTS lane", async () => {
    sqlite
      .prepare(
        `INSERT INTO repo_memories
         (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
          primitive, confidence, authority, enforcement, context_hint, content,
          applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
          memory_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "row-qa-runtime",
        "trycycloid",
        "cycloid",
        "mem-qa-runtime",
        "active",
        "action",
        "procedure",
        "gotcha",
        "gotcha",
        "medium",
        "inferred",
        "none",
        "QA runtime: routes services ready check",
        "Unrelated routes services memory that would only appear through repo FTS.",
        "[]",
        null,
        null,
        "[]",
        JSON.stringify({ tags: ["qa-runtime", "gotcha"] }),
        1000,
        1000,
      );

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall routes services memory before updating apps/control-plane-worker/src/routes/sessions.ts",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 5,
          memories: [],
        }),
      }),
      {} as Env,
      d1,
      "session-qa-runtime-fts",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["mem-qa-runtime"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: { laneCounts: Record<string, number> };
    };

    expect(response.status).toBe(200);
    expect(body.retrievalTrace.laneCounts.repo_fts ?? 0).toBe(0);
    expect(body.memories.map((memory) => memory.id)).not.toContain("mem-qa-runtime");
  });

  it("emits query, candidate, vector, and selector metrics through the injected sink", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const waited: Array<Promise<unknown>> = [];
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall repo-rule-1 before updating session route handlers",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 2,
          memories: [
            {
              id: "repo-rule-1",
              type: "action",
              content: "Route handlers must call services instead of D1 directly.",
              context_hint: "routes services",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      {
        selector: selectorSelecting(["repo-rule-1"]),
        metrics: {
          waitUntil: (promise) => waited.push(promise),
          emit: async (_env, event) => {
            emitted.push(event);
          },
        },
      },
    );

    expect(response.status).toBe(200);
    await Promise.all(waited);
    expect(emitted.map((event) => event.event)).toEqual([
      "memory_context.query_started",
      "memory_context.candidates_generated",
      "memory_context.vector_unavailable",
      "memory_context.selector_returned",
    ]);
    expect(emitted[1]).toMatchObject({
      event: "memory_context.candidates_generated",
      businessId: "biz-1",
      sessionId: "session-1",
      candidateCount: 1,
    });
    expect(emitted[2]).toMatchObject({
      event: "memory_context.vector_unavailable",
      vectorUnavailableReason: "missing_vectorize_binding",
    });
    expect(emitted[3]).toMatchObject({
      event: "memory_context.selector_returned",
      selectedCount: 1,
      selectorStatus: "selected",
      selectorLatencyMs: expect.any(Number),
    });
    const traceRow = sqlite
      .prepare(
        "SELECT intent, request_json AS requestJson, selector_latency_ms AS selectorLatencyMs, trace_json AS traceJson FROM memory_context_queries",
      )
      .get() as { intent: string; requestJson: string; selectorLatencyMs: number; traceJson: string };
    expect(traceRow.selectorLatencyMs).toEqual(expect.any(Number));
    expect(traceRow.selectorLatencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(traceRow.traceJson)).toMatchObject({ selectorLatencyMs: traceRow.selectorLatencyMs });
    expect(traceRow.intent).toBe("Recall repo-rule-1 before updating session route handlers");
    const persistedRequest = JSON.parse(traceRow.requestJson) as Record<string, unknown>;
    expect(persistedRequest).toMatchObject({
      denoisedTaskExcerpt: "Recall repo-rule-1 before updating session route handlers",
      repoCandidateIds: ["repo-rule-1"],
      queryVector: null,
    });
    expect(traceRow.requestJson).not.toContain('"intent"');
  });

  it("honors retrieval and selector kill switches without falling back to top candidates", async () => {
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall repo-rule-1 before updating session route handlers",
          maxMemories: 2,
          memories: [
            {
              id: "repo-rule-1",
              type: "action",
              content: "Route handlers must call services instead of D1 directly.",
              context_hint: "routes services",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
          ],
        }),
      }),
      { MEMORY_CONTEXT_RETRIEVAL_DISABLED: "1" } as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      {
        selector: {
          async select() {
            throw new Error("selector should not run when retrieval is disabled");
          },
        },
      },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: {
        vectorUnavailableReason: string;
        candidates: unknown[];
        selectorStatus: string;
        selector: { failureReason: string };
      };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toEqual([]);
    expect(body.retrievalTrace.candidates).toEqual([]);
    expect(body.retrievalTrace.vectorUnavailableReason).toBe("retrieval_disabled");
    expect(body.retrievalTrace.selectorStatus).toBe("failed");
    expect(body.retrievalTrace.selector.failureReason).toBe("selector_disabled");
    expect(sqlite.prepare("SELECT selector_latency_ms AS selectorLatencyMs FROM memory_context_queries").get()).toEqual(
      {
        selectorLatencyMs: null,
      },
    );
  });

  it("preserves block-enforced repo memories even when the selector omits them", async () => {
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Update session route handlers",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 2,
          memories: [
            {
              id: "repo-block-1",
              type: "action",
              content: "Do not edit session routes without preserving the auth boundary.",
              context_hint: "session routes auth boundary",
              confidence: "high",
              enforcement: "block",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
            {
              id: "repo-warn-1",
              type: "action",
              content: "Prefer services from route handlers.",
              context_hint: "routes services",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-block-memory",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting([]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string; enforcement: string; whyReturned: string }>;
      retrievalTrace: { blockEnforcedIds: string[]; selectorStatus: string };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toMatchObject([
      {
        id: "repo-block-1",
        enforcement: "block",
        whyReturned: "deterministic_block_enforcement",
      },
    ]);
    expect(body.retrievalTrace.blockEnforcedIds).toEqual(["repo-block-1"]);
    expect(body.retrievalTrace.selectorStatus).toBe("empty");
    expect(sqlite.prepare("SELECT selected_ids_json AS selectedIdsJson FROM memory_context_queries").get()).toEqual({
      selectedIdsJson: JSON.stringify(["repo-block-1"]),
    });
  });

  it("retrieves active repo and conclusion memories from D1 FTS lanes", async () => {
    sqlite
      .prepare(
        `INSERT INTO repo_memories
         (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
          primitive, confidence, authority, enforcement, context_hint, content,
          applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
          memory_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "row-1",
        "trycycloid",
        "cycloid",
        "repo-route-service-rule",
        "active",
        "action",
        "procedure",
        "tactical",
        "procedure",
        "high",
        "reviewed",
        "warn",
        "routes services",
        "Route handlers must call services before DAO functions.",
        '["apps/control-plane-worker/src/routes/**"]',
        null,
        null,
        "[]",
        "{}",
        1000,
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-a", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-r", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_collections
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("collection-1", "biz-1", "scope-repo", "peer-a", "peer-r", "repo", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_conclusions
         (id, business_id, collection_id, scope_id, kind, content, level, status,
          confidence, authority, enforcement, repo_owner, repo_name, created_at_ms, updated_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "conclusion-route-service",
        "biz-1",
        "collection-1",
        "scope-repo",
        "repo_rule",
        "Sessions routes should preserve service-layer boundaries.",
        "explicit",
        "active",
        "high",
        "reviewed",
        "warn",
        "trycycloid",
        "cycloid",
        1000,
        1000,
        "{}",
      );
    const batchStatementCounts: number[] = [];
    const originalBatch = d1.batch.bind(d1);
    d1.batch = async (statements) => {
      batchStatementCounts.push(statements.length);
      return originalBatch(statements);
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Update sessions routes while preserving service boundaries",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 5,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      {
        selector: selectorSelecting(["repo-route-service-rule", "memory_conclusion:conclusion-route-service"]),
        nowMs: 2000,
      },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string; level: string | null }>;
      block: string;
      retrievalTrace: { laneCounts: Record<string, number>; candidateIdsJson?: string };
    };

    expect(response.status).toBe(200);
    expect(batchStatementCounts).toEqual(expect.arrayContaining([2, 2]));
    expect(body.memories.map((memory) => memory.id)).toContain("repo-route-service-rule");
    expect(body.memories.map((memory) => memory.id)).toContain("memory_conclusion:conclusion-route-service");
    expect(body.memories.find((memory) => memory.id === "memory_conclusion:conclusion-route-service")?.level).toBe(
      "explicit",
    );
    expect(body.block).toContain(
      '<memory id="memory_conclusion:conclusion-route-service" kind="derived_conclusion" confidence="high" enforcement="warn" level="explicit">',
    );
    expect(body.block).toContain('<source kind="memory_conclusion" id="conclusion-route-service">');
    expect(body.retrievalTrace.laneCounts.repo_fts).toBeGreaterThan(0);
    expect(body.retrievalTrace.laneCounts.conclusion_fts).toBeGreaterThan(0);
    expect(sqlite.prepare("SELECT selected_ids_json AS selectedIdsJson FROM memory_context_queries").get()).toEqual({
      selectedIdsJson: expect.stringContaining("repo-route-service-rule"),
    });
  });

  it("skips batched company lanes when no memory scopes resolve", async () => {
    const batchStatementCounts: number[] = [];
    const originalBatch = d1.batch.bind(d1);
    d1.batch = async (statements) => {
      batchStatementCounts.push(statements.length);
      return originalBatch(statements);
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Recall company memory for a new repo before any memory scopes exist",
          maxMemories: 5,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-no-scopes",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting([]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: { laneCounts: Record<string, number> };
    };

    expect(response.status).toBe(200);
    expect(batchStatementCounts).toEqual([]);
    expect(body.memories).toEqual([]);
    expect(body.retrievalTrace.laneCounts.recent).toBeUndefined();
    expect(body.retrievalTrace.laneCounts.reinforced).toBeUndefined();
    expect(body.retrievalTrace.laneCounts.conclusion_fts).toBeUndefined();
    expect(body.retrievalTrace.laneCounts.message_fts).toBeUndefined();
  });

  it("keeps recent and reinforced candidates when the FTS batch fails", async () => {
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_sessions
         (id, business_id, scope_id, source_kind, source_id, source_uri, title, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "memory-session-1",
        "biz-1",
        "scope-repo",
        "arcanist_session",
        "session-source-1",
        "session://source-1",
        "Recent context",
        "{}",
        1000,
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_messages
         (id, business_id, session_id, seq_in_session, role, content_text, source_uri, occurred_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "message-recent-1",
        "biz-1",
        "memory-session-1",
        1,
        "external",
        "Recent session found Slack OAuth callbacks require stable HTTPS.",
        "session://source-1#message-1",
        1900,
        1900,
      );

    const originalBatch = d1.batch.bind(d1);
    let batchCalls = 0;
    d1.batch = async (statements) => {
      batchCalls += 1;
      if (batchCalls === 2) {
        throw new Error("simulated FTS failure");
      }
      return originalBatch(statements);
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Verify Slack OAuth locally for the install callback.",
          maxMemories: 5,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["message-recent-1"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string; lanes: string[] }> };
    };

    expect(response.status).toBe(200);
    expect(body.memories.map((memory) => memory.id)).toEqual(["message-recent-1"]);
    expect(body.retrievalTrace.laneCounts.recent).toBe(1);
    expect(body.retrievalTrace.laneCounts.conclusion_fts).toBe(0);
    expect(body.retrievalTrace.laneCounts.message_fts).toBe(0);
    expect(body.retrievalTrace.candidates.find((candidate) => candidate.id === "message-recent-1")?.lanes).toContain(
      "recent",
    );
    expect(batchCalls).toBe(2);
  });

  it("fills company FTS lanes before repo FTS and caps combined candidates (ARC-1544)", async () => {
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-quota", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-quota-agent", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-quota-repo", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_collections
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("collection-quota", "biz-1", "scope-quota", "peer-quota-agent", "peer-quota-repo", "repo", "{}", 1000, 1000);

    const repoInsert = sqlite.prepare(
      `INSERT INTO repo_memories
       (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
        primitive, confidence, authority, enforcement, context_hint, content,
        applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
        memory_json, created_at_ms, updated_at_ms)
       VALUES (?, 'trycycloid', 'cycloid', ?, 'active', 'action', 'procedure', 'tactical',
        'procedure', 'high', 'reviewed', 'warn', 'quota routing',
        ?, '[]', NULL, NULL, '[]', '{}', ?, ?)`,
    );
    for (let index = 0; index < 35; index += 1) {
      repoInsert.run(
        `row-quota-${index}`,
        `repo-quota-${index}`,
        `Quota routing repo memory ${index} should be bounded before selector.`,
        1000 + index,
        1000 + index,
      );
    }

    const conclusionInsert = sqlite.prepare(
      `INSERT INTO memory_conclusions
       (id, business_id, collection_id, scope_id, kind, content, level, status,
        confidence, authority, enforcement, repo_owner, repo_name, created_at_ms, updated_at_ms, metadata_json)
       VALUES (?, 'biz-1', 'collection-quota', 'scope-quota', 'repo_rule', ?, 'explicit', 'active',
        'high', 'reviewed', 'warn', 'trycycloid', 'cycloid', ?, ?, '{}')`,
    );
    for (let index = 0; index < 10; index += 1) {
      conclusionInsert.run(
        `conclusion-quota-${index}`,
        `Quota routing conclusion memory ${index} should not overflow FTS cap.`,
        2000 + index,
        2000 + index,
      );
    }

    // Seed a session + messages so the message FTS lane also has matches. Before the
    // ARC-1544 reorder, repo FTS filled the shared cap first and both company FTS lanes
    // (conclusion + message) were starved to zero; this fixture guards both.
    sqlite
      .prepare(
        `INSERT INTO memory_sessions
         (id, business_id, scope_id, source_kind, source_id, source_uri, title, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "memory-session-quota",
        "biz-1",
        "scope-quota",
        "arcanist_session",
        "session-source-quota",
        "session://quota",
        "Quota routing context",
        "{}",
        1000,
        1000,
      );
    const messageInsert = sqlite.prepare(
      `INSERT INTO memory_messages
       (id, business_id, session_id, seq_in_session, role, content_text, source_uri, occurred_at_ms, created_at_ms)
       VALUES (?, 'biz-1', 'memory-session-quota', ?, 'external', ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 5; index += 1) {
      messageInsert.run(
        `message-quota-${index}`,
        index + 1,
        `Quota routing message ${index} should reach the message FTS lane.`,
        `session://quota#message-${index}`,
        1900 + index,
        1900 + index,
      );
    }

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "quota routing",
          maxMemories: 5,
        }),
      }),
      // WORKER_ENV production enables company memory for this business, so the
      // conclusion/message FTS lanes actually run (they are gated off otherwise).
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting([]), nowMs: 3000 },
    );

    const body = (await response.json()) as {
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string }> };
    };
    const ftsLaneCount =
      (body.retrievalTrace.laneCounts.repo_fts ?? 0) +
      (body.retrievalTrace.laneCounts.conclusion_fts ?? 0) +
      (body.retrievalTrace.laneCounts.message_fts ?? 0);
    const traceRow = sqlite
      .prepare("SELECT candidate_ids_json AS candidateIdsJson FROM memory_context_queries")
      .get() as {
      candidateIdsJson: string;
    };

    const laneCounts = body.retrievalTrace.laneCounts;
    expect(response.status).toBe(200);
    // ARC-1544: company FTS lanes now claim cap slots before repo FTS, so neither
    // conclusion nor message FTS is starved to zero (both were 0 before the reorder).
    expect(laneCounts.conclusion_fts).toBeGreaterThan(0);
    expect(laneCounts.message_fts).toBeGreaterThan(0);
    // Repo FTS still fills the remaining slots: this fixture seeds fewer than 30 company
    // matches, so repo_fts > 0 here (not asserted as a universal invariant - when company
    // FTS fills all 30 slots, repo_fts of 0 is acceptable under the reorder-only policy).
    expect(laneCounts.repo_fts).toBeGreaterThan(0);
    // Combined FTS candidates are still capped at 30 and map to 30 unique candidates
    // (fixture IDs are disjoint across lanes, so no cross-lane dedup collapses the count).
    expect(ftsLaneCount).toBe(30);
    expect(JSON.parse(traceRow.candidateIdsJson)).toHaveLength(30);
    expect(body.retrievalTrace.candidates).toHaveLength(30);
  });

  it("queries vector index and rehydrates only synced same-business same-scope semantic documents", async () => {
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-other", "biz-1", "repo", "trycycloid/other", "trycycloid", "other", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-agent", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-repo", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_collections
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("collection-vector", "biz-1", "scope-repo", "peer-agent", "peer-repo", "repo", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_conclusions
         (id, business_id, collection_id, scope_id, kind, content, level, status,
          confidence, authority, enforcement, repo_owner, repo_name, created_at_ms, updated_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "conclusion-1",
        "biz-1",
        "collection-vector",
        "scope-repo",
        "repo_rule",
        "Use pull memory context before editing session routing.",
        "deductive",
        "active",
        "high",
        "reviewed",
        "none",
        "trycycloid",
        "cycloid",
        1000,
        1000,
        "{}",
      );
    sqlite
      .prepare(
        `INSERT INTO memory_conclusions
         (id, business_id, collection_id, scope_id, kind, content, level, status,
          confidence, authority, enforcement, repo_owner, repo_name, deleted_at_ms, created_at_ms, updated_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "conclusion-deleted",
        "biz-1",
        "collection-vector",
        "scope-repo",
        "repo_rule",
        "Deleted conclusion should not be returned.",
        "explicit",
        "active",
        "high",
        "reviewed",
        "none",
        "trycycloid",
        "cycloid",
        1500,
        1000,
        1500,
        "{}",
      );
    sqlite
      .prepare(
        `INSERT INTO memory_scope_cards
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, card_json,
          source_conclusion_ids_json, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "card-vector",
        "biz-1",
        "scope-repo",
        "peer-agent",
        "peer-repo",
        JSON.stringify({
          version: 1,
          entries: [
            {
              kind: "constraint",
              content: "Call the memory context tool before editing session routing.",
              conclusionId: "conclusion-1",
              confidence: "high",
              level: "deductive",
            },
          ],
        }),
        JSON.stringify(["conclusion-1"]),
        "active",
        1000,
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_semantic_documents
         (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
          text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
          vector_state, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-1",
        "memory_conclusion",
        "conclusion-1",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        "Use pull memory context before editing session routing.",
        "hash-1",
        "text-embedding-3-small",
        1536,
        "biz-1",
        "vec-1",
        "synced",
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_semantic_documents
         (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
          text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
          vector_state, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-2",
        "memory_conclusion",
        "wrong-business",
        "biz-2",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        "Wrong tenant memory.",
        "hash-2",
        "text-embedding-3-small",
        1536,
        "biz-2",
        "vec-2",
        "synced",
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_semantic_documents
         (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
          text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
          vector_state, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-wrong-scope",
        "repo_memory",
        "repo-wrong-scope",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-other",
        "Wrong scope memory.",
        "hash-wrong-scope",
        "text-embedding-3-small",
        1536,
        "biz-1",
        "vec-wrong-scope",
        "synced",
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_semantic_documents
         (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
          text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
          vector_state, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-pending",
        "repo_memory",
        "repo-pending",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        "Pending memory.",
        "hash-pending",
        "text-embedding-3-small",
        1536,
        "biz-1",
        "vec-pending",
        "pending",
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_semantic_documents
         (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
          text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
          vector_state, deleted_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-deleted",
        "memory_conclusion",
        "conclusion-deleted",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        "Deleted source memory.",
        "hash-deleted",
        "text-embedding-3-small",
        1536,
        "biz-1",
        "vec-deleted",
        "synced",
        1500,
        1500,
      );
    const vectorIndex: MemoryVectorIndex = {
      async query(query) {
        expect(query).toMatchObject({
          businessId: "biz-1",
          repoOwner: "trycycloid",
          repoName: "cycloid",
        });
        expect(query.vector).toEqual([0.1, 0.2]);
        return [
          { vectorId: "vec-1", score: 0.91 },
          { vectorId: "vec-missing", score: 1 },
          { vectorId: "vec-wrong-scope", score: 0.99 },
          { vectorId: "vec-2", score: 0.99 },
          { vectorId: "vec-pending", score: 0.98 },
          { vectorId: "vec-deleted", score: 0.97 },
          { vectorId: "vec-1", score: 0.5 },
        ];
      },
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "session routing memory",
          queryVector: [0.1, 0.2],
          maxMemories: 5,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      {
        selector: selectorSelecting(["memory_conclusion:conclusion-1"]),
        vectorIndex,
        nowMs: 2000,
      },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string; content: string; level: string | null }>;
      retrievalTrace: {
        vectorAvailable: boolean;
        laneCounts: Record<string, number>;
        fusionMode: string;
        rrfCandidateIds: string[];
        vectorMatches: unknown[];
        candidates: Array<{
          id: string;
          lanes: string[];
          laneRanks: Record<string, number>;
          scores: Record<string, number>;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.retrievalTrace.vectorAvailable).toBe(true);
    expect(body.retrievalTrace.laneCounts.vector).toBe(1);
    expect(body.retrievalTrace.vectorMatches).toHaveLength(7);
    expect(body.retrievalTrace.fusionMode).toBe("rrf");
    expect(body.retrievalTrace.rrfCandidateIds).toEqual(["memory_conclusion:conclusion-1"]);
    const vectorCandidate = body.retrievalTrace.candidates.find(
      (candidate) => candidate.id === "memory_conclusion:conclusion-1",
    );
    expect(vectorCandidate?.lanes).toEqual(expect.arrayContaining(["conclusion_fts", "vector"]));
    expect(vectorCandidate?.laneRanks.vector).toBe(1);
    expect(vectorCandidate?.scores.vector).toBe(0.91);
    expect(body.retrievalTrace.candidates.map((candidate) => candidate.id)).not.toEqual(
      expect.arrayContaining([
        "repo_memory:repo-wrong-scope",
        "repo_memory:repo-pending",
        "memory_conclusion:conclusion-deleted",
        "memory_conclusion:wrong-business",
      ]),
    );
    expect(
      body.retrievalTrace.candidates.find((candidate) => candidate.id === "scope_card:card-vector")?.lanes,
    ).toEqual(["scope_card"]);
    expect(body.memories).toMatchObject([
      {
        id: "memory_conclusion:conclusion-1",
        content: "Use pull memory context before editing session routing.",
        level: "deductive",
      },
    ]);
  });

  it("degrades to lexical candidates when vector query fails or times out", async () => {
    const timeout = new Error("vector timeout");
    timeout.name = "TimeoutError";
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        throw timeout;
      },
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall repo-rule-1 before updating session route handlers",
          queryVector: [0.1, 0.2],
          maxMemories: 2,
          memories: [
            {
              id: "repo-rule-1",
              type: "action",
              content: "Route handlers must call services instead of D1 directly.",
              context_hint: "routes services",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
          ],
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
        }),
      }),
      {} as Env,
      d1,
      "session-vector-timeout",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["repo-rule-1"]), vectorIndex, nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: {
        vectorAvailable: boolean;
        vectorUnavailableReason: string;
        fusionMode: string;
        laneCounts: Record<string, number>;
      };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toMatchObject([{ id: "repo-rule-1" }]);
    expect(body.retrievalTrace.vectorAvailable).toBe(false);
    expect(body.retrievalTrace.vectorUnavailableReason).toBe("vector_query_failed:TimeoutError");
    expect(body.retrievalTrace.fusionMode).toBe("deterministic");
    expect(body.retrievalTrace.laneCounts.vector).toBeUndefined();
  });

  it("embeds the denoised task when no query vector is supplied", async () => {
    let queriedVector: number[] | null = null;
    const vectorIndex: MemoryVectorIndex = {
      async query(query) {
        queriedVector = query.vector;
        return [];
      },
    };
    const embeddedTexts: string[] = [];

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent:
            '@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] <cycloid_memory_context trace_id="old"><memory id="old" kind="repo_rule" confidence="high" enforcement="warn">Old memory</memory></cycloid_memory_context>\nFix session routing',
          maxMemories: 2,
        }),
      }),
      {} as Env,
      d1,
      "session-embedded-vector",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      {
        selector: selectorSelecting([]),
        vectorIndex,
        embeddingProvider: {
          async embed(text) {
            embeddedTexts.push(text);
            return [0.3, 0.4];
          },
        },
        nowMs: 2000,
      },
    );

    const body = (await response.json()) as {
      retrievalTrace: {
        vectorAvailable: boolean;
        vectorUnavailableReason: string | null;
        denoisedTaskExcerpt: string;
        removedSections: string[];
      };
    };
    expect(response.status).toBe(200);
    expect(embeddedTexts).toEqual(["Fix session routing"]);
    expect(queriedVector).toEqual([0.3, 0.4]);
    expect(body.retrievalTrace.vectorAvailable).toBe(true);
    expect(body.retrievalTrace.vectorUnavailableReason).toBeNull();
    expect(body.retrievalTrace.denoisedTaskExcerpt).toBe("Fix session routing");
    expect(body.retrievalTrace.removedSections).toEqual(
      expect.arrayContaining(["cycloid_launch_prefix", "memory_context"]),
    );
  });

  it("falls back to lexical recall and emits embedding_timeout when query embedding times out", async () => {
    const events: unknown[] = [];
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall route handler conventions",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 1,
          memories: [
            {
              id: "repo-rule-1",
              type: "action",
              content: "Routes call services.",
              context_hint: "route handler conventions",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/**"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-embedding-timeout",
      { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
      {
        selector: selectorSelecting(["repo-rule-1"]),
        vectorIndex: {
          async query() {
            return [];
          },
        },
        embeddingProvider: {
          async embed() {
            const error = new Error("embedding timed out");
            error.name = "TimeoutError";
            throw error;
          },
        },
        metrics: { emit: async (_env, event) => void events.push(event) },
      },
    );

    const body = (await response.json()) as { retrievalTrace: { vectorUnavailableReason: string } };
    expect(response.status).toBe(200);
    expect(body.retrievalTrace.vectorUnavailableReason).toBe("embedding_timeout");
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "memory_context.vector_unavailable",
          vectorUnavailableReason: "embedding_timeout",
        }),
      ),
    );
  });

  it("treats an empty vector index as available without fabricating candidates", async () => {
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "semantic-only missing memory",
          queryVector: [0.1, 0.2],
          maxMemories: 2,
        }),
      }),
      {} as Env,
      d1,
      "session-empty-vector",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting([]), vectorIndex, nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: {
        vectorAvailable: boolean;
        vectorUnavailableReason: string | null;
        vectorMatches: unknown[];
        laneCounts: Record<string, number>;
      };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toEqual([]);
    expect(body.retrievalTrace.vectorAvailable).toBe(true);
    expect(body.retrievalTrace.vectorUnavailableReason).toBeNull();
    expect(body.retrievalTrace.vectorMatches).toEqual([]);
    expect(body.retrievalTrace.laneCounts.vector).toBe(0);
  });

  it("surfaces active scope cards as selector-gated memory candidates", async () => {
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-agent", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-repo", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_scope_cards
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, card_json,
          source_conclusion_ids_json, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "card-1",
        "biz-1",
        "scope-repo",
        "peer-agent",
        "peer-repo",
        JSON.stringify({
          version: 1,
          entries: [
            {
              kind: "constraint",
              content: "Routes call services before DAO functions.",
              conclusionId: "conclusion-1",
              confidence: "high",
              level: "explicit",
            },
          ],
        }),
        JSON.stringify(["conclusion-1"]),
        "active",
        1000,
        1000,
      );

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Update session route handlers.",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 3,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-scope-card",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["scope_card:card-1"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string; kind: string; content: string }>;
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string; lanes: string[] }> };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toMatchObject([
      {
        id: "scope_card:card-1",
        kind: "scope_card",
        content: "constraint: Routes call services before DAO functions.",
      },
    ]);
    expect(body.retrievalTrace.laneCounts.scope_card).toBe(1);
    expect(body.retrievalTrace.candidates.find((candidate) => candidate.id === "scope_card:card-1")?.lanes).toContain(
      "scope_card",
    );
  });

  it("surfaces recent messages and reinforced conclusions as selector-gated candidates", async () => {
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-agent", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers
         (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-repo", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_sessions
         (id, business_id, scope_id, source_kind, source_id, source_uri, title, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "memory-session-1",
        "biz-1",
        "scope-repo",
        "arcanist_session",
        "session-source-1",
        "session://source-1",
        "Recent context",
        "{}",
        1000,
        1000,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_messages
         (id, business_id, session_id, seq_in_session, role, content_text, source_uri, occurred_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "message-recent-1",
        "biz-1",
        "memory-session-1",
        1,
        "external",
        "Recent session found Slack OAuth callbacks require stable HTTPS.",
        "session://source-1#message-1",
        1900,
        1900,
      );
    sqlite
      .prepare(
        `INSERT INTO memory_collections
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("collection-1", "biz-1", "scope-repo", "peer-agent", "peer-repo", "repo", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_conclusions
         (id, business_id, collection_id, scope_id, kind, content, level, status,
          confidence, authority, enforcement, source_kind, source_id, repo_owner, repo_name,
          reinforcement_count, times_derived, created_at_ms, updated_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "conclusion-reinforced-1",
        "biz-1",
        "collection-1",
        "scope-repo",
        "dead_end",
        "Localhost Slack OAuth callback verification repeatedly failed; use ngrok.",
        "explicit",
        "active",
        "high",
        "inferred",
        "none",
        "memory_message",
        "message-old",
        "trycycloid",
        "cycloid",
        3,
        1,
        1000,
        1800,
        "{}",
      );

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Verify Slack OAuth locally for the install callback.",
          maxMemories: 5,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: selectorSelecting(["message-recent-1", "memory_conclusion:conclusion-reinforced-1"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string; whyReturned: string }>;
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string; lanes: string[] }> };
    };

    expect(response.status).toBe(200);
    expect(body.memories.map((memory) => memory.id)).toEqual(
      expect.arrayContaining(["message-recent-1", "memory_conclusion:conclusion-reinforced-1"]),
    );
    expect(body.retrievalTrace.laneCounts.recent).toBe(1);
    expect(body.retrievalTrace.laneCounts.reinforced).toBe(1);
    expect(body.retrievalTrace.candidates.find((candidate) => candidate.id === "message-recent-1")?.lanes).toContain(
      "recent",
    );
    expect(
      body.retrievalTrace.candidates.find((candidate) => candidate.id === "memory_conclusion:conclusion-reinforced-1")
        ?.lanes,
    ).toContain("reinforced");
  });

  it("returns no memories when the selector fails instead of falling back to top candidates", async () => {
    const events: Array<Record<string, unknown>> = [];
    sqlite
      .prepare(
        `INSERT INTO repo_memories
         (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
          primitive, confidence, authority, enforcement, context_hint, content,
          applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
          memory_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "row-1",
        "trycycloid",
        "cycloid",
        "repo-route-service-rule",
        "active",
        "action",
        "procedure",
        "tactical",
        "procedure",
        "high",
        "reviewed",
        "warn",
        "routes services",
        "Route handlers must call services before DAO functions.",
        '["apps/control-plane-worker/src/routes/**"]',
        null,
        null,
        "[]",
        "{}",
        1000,
        1000,
      );
    const failingSelector: MemoryContextSelector = {
      async select() {
        return {
          status: "failed",
          selected: [],
          rejected: [],
          emptyReason: "selector_failed",
          selectorConfidence: 0,
          failureReason: "test_failure",
        };
      },
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Update sessions routes while preserving service boundaries",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 5,
        }),
      }),
      {} as Env,
      d1,
      "session-1",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      {
        selector: failingSelector,
        nowMs: 2000,
        metrics: { emit: async (_env, event) => void events.push(event) },
      },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      block: string;
      retrievalTrace: { selectorStatus: string; selector: { failureReason: string } };
    };

    expect(response.status).toBe(200);
    expect(body.memories).toEqual([]);
    expect(body.block).toContain("<empty>No memory was selected for this request.</empty>");
    expect(body.retrievalTrace.selectorStatus).toBe("failed");
    expect(body.retrievalTrace.selector.failureReason).toBe("test_failure");
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ event: "memory_context.selector_returned_empty", failureCode: "other" }),
      ),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ failureReason: "test_failure" }));
  });

  function insertRepoMemory(memoryId: string, content: string, contextHint: string): void {
    sqlite
      .prepare(
        `INSERT INTO repo_memories
         (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
          primitive, confidence, authority, enforcement, context_hint, content,
          applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
          memory_json, created_at_ms, updated_at_ms)
         VALUES (?, 'trycycloid', 'cycloid', ?, 'active', 'action', 'procedure', 'tactical',
          'procedure', 'high', 'reviewed', 'warn', ?, ?,
          '["apps/control-plane-worker/src/routes/**"]', NULL, NULL, '[]', '{}', 1000, 1000)`,
      )
      .run(`row-${memoryId}`, memoryId, contextHint, content);
  }

  function insertSemanticDoc(params: {
    id: string;
    sourceKind: string;
    sourceId: string;
    vectorId: string;
    text: string;
  }): void {
    sqlite
      .prepare(
        `INSERT INTO memory_semantic_documents
         (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
          text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
          vector_state, updated_at_ms)
         VALUES (?, ?, ?, 'biz-1', 'trycycloid', 'cycloid', 'repo', 'scope-repo', ?, ?,
          'text-embedding-3-small', 1536, 'biz-1', ?, 'synced', 1000)`,
      )
      .run(params.id, params.sourceKind, params.sourceId, params.text, `hash-${params.id}`, params.vectorId);
  }

  function insertRepoScope(): void {
    sqlite
      .prepare(
        `INSERT INTO memory_scopes
         (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1000, 1000);
  }

  it("scores stronger lexical matches above weaker ones (bm25 sign)", async () => {
    insertRepoMemory(
      "strong-match",
      "alpha beta gamma delta epsilon zeta routing services boundary check.",
      "alpha beta gamma delta epsilon",
    );
    insertRepoMemory("weak-match", "alpha unrelated content about something else entirely different.", "alpha");

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "alpha beta gamma delta epsilon zeta routing services boundary",
          maxMemories: 5,
        }),
      }),
      {} as Env,
      d1,
      "session-bm25-sign",
      { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
      { selector: selectorSelecting([]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      retrievalTrace: { candidates: Array<{ id: string; scores: Record<string, number> }> };
    };
    expect(response.status).toBe(200);
    const candidates = body.retrievalTrace.candidates;
    const strong = candidates.find((candidate) => candidate.id === "strong-match");
    const weak = candidates.find((candidate) => candidate.id === "weak-match");
    // More-negative bm25 (stronger match) must yield a higher score than a weak hit.
    expect(strong?.scores.repo_fts).toBeGreaterThan(weak?.scores.repo_fts ?? 0);
    // ...and therefore sort ahead of it in deterministic fusion.
    const strongIndex = candidates.findIndex((candidate) => candidate.id === "strong-match");
    const weakIndex = candidates.findIndex((candidate) => candidate.id === "weak-match");
    expect(strongIndex).toBeLessThan(weakIndex);
  });

  it("keeps repo ranking scores attached after a dropped middle candidate", async () => {
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Update apps/control-plane-worker/src/routes/sessions.ts services auth boundary sessions routing",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          maxMemories: 5,
          memories: [
            {
              id: "mem-a",
              type: "action",
              content: "Routes must call services instead of D1 directly for sessions auth boundary.",
              context_hint: "routes services sessions auth",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
            {
              id: "mem-b",
              type: "action",
              content: "   ",
              context_hint: "routes services sessions auth boundary",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
            {
              id: "mem-c",
              type: "action",
              content: "Sessions routing must keep auth boundary services checks near routes services layer.",
              context_hint: "sessions routing auth boundary services",
              confidence: "medium",
              enforcement: "suggest",
              applies_to: ["apps/control-plane-worker/src/routes/*.ts"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-drop-middle",
      { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
      { selector: selectorSelecting(["mem-a", "mem-c"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      repoRankings: Array<{ id: string; score: number }>;
      retrievalTrace: { candidates: Array<{ id: string; lanes: string[]; scores: Record<string, number> }> };
    };
    expect(response.status).toBe(200);
    // mem-b (empty content) is ranked but dropped from the returned memories.
    expect(body.repoRankings.map((ranking) => ranking.id)).toEqual(["mem-a", "mem-b", "mem-c"]);
    const scoreById = new Map(body.repoRankings.map((ranking) => [ranking.id, ranking.score]));
    expect(scoreById.get("mem-b")).toBe(1);
    expect(scoreById.get("mem-c")).toBeLessThan(1);
    const candidateA = body.retrievalTrace.candidates.find((candidate) => candidate.id === "mem-a");
    const candidateC = body.retrievalTrace.candidates.find((candidate) => candidate.id === "mem-c");
    // The dropped candidate must not surface, and the survivors keep their own scores
    // rather than inheriting the dropped middle ranking's score (which would be 1).
    expect(body.retrievalTrace.candidates.some((candidate) => candidate.id === "mem-b")).toBe(false);
    expect(candidateA?.scores.repo_ranked).toBe(scoreById.get("mem-a"));
    expect(candidateC?.scores.repo_ranked).toBe(scoreById.get("mem-c"));
    expect(candidateC?.scores.repo_ranked).toBeLessThan(1);
  });

  it("injects no company-derived content when company memory is disabled for the business", async () => {
    insertRepoScope();
    sqlite
      .prepare(
        `INSERT INTO memory_peers (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-agent", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-repo", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_collections
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("collection-1", "biz-1", "scope-repo", "peer-agent", "peer-repo", "repo", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_conclusions
         (id, business_id, collection_id, scope_id, kind, content, level, status,
          confidence, authority, enforcement, repo_owner, repo_name, created_at_ms, updated_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "conclusion-disabled",
        "biz-1",
        "collection-1",
        "scope-repo",
        "repo_rule",
        "Sessions routes should preserve service-layer boundaries when disabled.",
        "explicit",
        "active",
        "high",
        "reviewed",
        "warn",
        "trycycloid",
        "cycloid",
        1000,
        1000,
        "{}",
      );
    sqlite
      .prepare(
        `INSERT INTO memory_scope_cards
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, card_json,
          source_conclusion_ids_json, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "card-disabled",
        "biz-1",
        "scope-repo",
        "peer-agent",
        "peer-repo",
        JSON.stringify({
          version: 1,
          entries: [
            {
              kind: "constraint",
              content: "Do not inject this when company memory is disabled.",
              conclusionId: "conclusion-disabled",
              confidence: "high",
              level: "explicit",
            },
          ],
        }),
        JSON.stringify(["conclusion-disabled"]),
        "active",
        1000,
        1000,
      );
    insertSemanticDoc({
      id: "doc-company-disabled",
      sourceKind: "company_fact",
      sourceId: "fact-disabled",
      vectorId: "vec-company-disabled",
      text: "Company fact that must not leak when disabled.",
    });
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [{ vectorId: "vec-company-disabled", score: 0.95 }];
      },
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Update sessions routes while preserving service boundaries",
          files: ["apps/control-plane-worker/src/routes/sessions.ts"],
          queryVector: [0.1, 0.2],
          maxMemories: 5,
        }),
      }),
      {} as Env,
      d1,
      "session-company-disabled",
      { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
      { selector: selectorSelecting([]), vectorIndex, nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ kind: string }>;
      retrievalTrace: {
        laneCounts: Record<string, number>;
        candidates: Array<{ id: string; kind: string }>;
      };
    };
    expect(response.status).toBe(200);
    const companyLanes = ["scope_card", "recent", "reinforced", "conclusion_fts", "message_fts", "vector"];
    for (const lane of companyLanes) {
      expect(body.retrievalTrace.laneCounts[lane] ?? 0).toBe(0);
    }
    const companyKinds = new Set(["scope_card", "company_fact", "company_take", "derived_conclusion"]);
    expect(body.retrievalTrace.candidates.some((candidate) => companyKinds.has(candidate.kind))).toBe(false);
    expect(body.memories.some((memory) => companyKinds.has(memory.kind))).toBe(false);
  });

  it("excludes company vector docs in repo mode and repo vector docs in company mode", async () => {
    insertRepoScope();
    insertSemanticDoc({
      id: "doc-repo",
      sourceKind: "repo_memory",
      sourceId: "repo-vector-doc",
      vectorId: "vec-repo",
      text: "Repo semantic doc about sessions routing.",
    });
    insertSemanticDoc({
      id: "doc-company",
      sourceKind: "company_fact",
      sourceId: "company-vector-doc",
      vectorId: "vec-company",
      text: "Company fact about sessions routing.",
    });
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [
          { vectorId: "vec-repo", score: 0.9 },
          { vectorId: "vec-company", score: 0.88 },
        ];
      },
    };
    const call = (mode: "repo" | "company") =>
      handleMemoryContextQueryForSession(
        new Request("https://internal/session/memory/context", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode, intent: "sessions routing memory", queryVector: [0.1, 0.2], maxMemories: 5 }),
        }),
        { WORKER_ENV: "production" } as Env,
        d1,
        `session-vector-mode-${mode}`,
        { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
        { selector: selectorSelecting([]), vectorIndex, nowMs: 2000 },
      );

    const repoBody = (await (await call("repo")).json()) as {
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string }> };
    };
    const repoIds = repoBody.retrievalTrace.candidates.map((candidate) => candidate.id);
    expect(repoIds).toContain("repo_memory:repo-vector-doc");
    expect(repoIds).not.toContain("company_fact:company-vector-doc");
    expect(repoBody.retrievalTrace.laneCounts.vector).toBe(1);

    const companyBody = (await (await call("company")).json()) as {
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string }> };
    };
    const companyIds = companyBody.retrievalTrace.candidates.map((candidate) => candidate.id);
    expect(companyIds).toContain("company_fact:company-vector-doc");
    expect(companyIds).not.toContain("repo_memory:repo-vector-doc");
    expect(companyBody.retrievalTrace.laneCounts.vector).toBe(1);
  });

  it("ignores reasoningLevel and omits it from the persisted request", async () => {
    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Recall repo-rule-1 before updating session route handlers",
          reasoningLevel: "deep",
          maxMemories: 2,
          memories: [
            {
              id: "repo-rule-1",
              type: "action",
              content: "Route handlers must call services instead of D1 directly.",
              context_hint: "routes services",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/routes/sessions.ts"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-reasoning-level",
      { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
      { selector: selectorSelecting(["repo-rule-1"]) },
    );
    expect(response.status).toBe(200);
    const traceRow = sqlite
      .prepare("SELECT request_json AS requestJson, trace_json AS traceJson FROM memory_context_queries")
      .get() as { requestJson: string; traceJson: string };
    expect(traceRow.requestJson).not.toContain("reasoningLevel");
    expect(traceRow.traceJson).not.toContain("reasoningLevel");
  });

  it("rejects scope cards whose version is not 1", async () => {
    insertRepoScope();
    sqlite
      .prepare(
        `INSERT INTO memory_peers (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-agent", "biz-1", "agent", "cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_peers (id, business_id, peer_type, peer_key, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("peer-repo", "biz-1", "repo", "trycycloid/cycloid", "{}", 1000, 1000);
    sqlite
      .prepare(
        `INSERT INTO memory_scope_cards
         (id, business_id, scope_id, observer_peer_id, observed_peer_id, card_json,
          source_conclusion_ids_json, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "card-v2",
        "biz-1",
        "scope-repo",
        "peer-agent",
        "peer-repo",
        JSON.stringify({
          version: 2,
          entries: [
            {
              kind: "constraint",
              content: "Stale v2 card should be rejected by the canonical validator.",
              conclusionId: "conclusion-x",
              confidence: "high",
              level: "explicit",
            },
          ],
        }),
        JSON.stringify(["conclusion-x"]),
        "active",
        1000,
        1000,
      );

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "all", intent: "Update session route handlers.", maxMemories: 3 }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "session-scope-card-version",
      { businessId: "biz-1", repoOwner: "trycycloid", repoName: "cycloid", callbackContext: null },
      { selector: selectorSelecting(["scope_card:card-v2"]), nowMs: 2000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: { laneCounts: Record<string, number>; candidates: Array<{ id: string }> };
    };
    expect(response.status).toBe(200);
    // The row is scanned (laneCounts reflects rows), but the v2 card is rejected by the
    // canonical validator, so it never becomes a candidate or a returned memory.
    expect(body.retrievalTrace.candidates.some((candidate) => candidate.id === "scope_card:card-v2")).toBe(false);
    expect(body.memories.some((memory) => memory.id === "scope_card:card-v2")).toBe(false);
  });
});
