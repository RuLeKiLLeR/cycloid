import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimNextMemoryWorkItem,
  insertMemoryConclusion,
  insertMemoryConclusionSource,
  insertMemoryContextQuery,
  insertMemoryMessage,
  insertMemoryWorkItem,
  listActiveMemoryConclusionsForScope,
  listPendingMemorySemanticDocuments,
  MEMORY_EMBEDDING_DIM,
  MEMORY_EMBEDDING_MODEL,
  searchMemoryConclusionsFts,
  searchMemoryMessagesFts,
  upsertMemorySemanticDocument,
  upsertMemorySession,
} from "../../apps/control-plane-worker/src/company-memory/context-db";
import { createMemoryContextD1, seedRepoMemoryGraph } from "./helpers/memory-context-db";

describe("company memory context DB", () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite, d1 } = createMemoryContextD1());
  });

  it("writes scoped directional graph rows and lists active conclusions by scope", async () => {
    await seedRepoMemoryGraph(d1);
    await upsertMemorySession(d1, {
      id: "memory-session-1",
      businessId: "biz-1",
      scopeId: "scope-1",
      sourceKind: "arcanist_session",
      sourceId: "session-1",
      sourceUri: "https://app.trycycloid.com/sessions/session-1",
      title: "Fix routing",
      startedAtMs: 900,
      endedAtMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryMessage(d1, {
      id: "message-1",
      businessId: "biz-1",
      sessionId: "memory-session-1",
      seqInSession: 1,
      peerId: "peer-agent",
      role: "agent",
      contentText: "Routes must use service-layer DAOs.",
      contentJson: null,
      sourceUri: null,
      occurredAtMs: 1000,
      nowMs: 1000,
    });
    await insertMemoryConclusion(d1, {
      id: "conclusion-1",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "repo_rule",
      content: "Route handlers should not prepare D1 statements directly.",
      level: "explicit",
      status: "active",
      confidence: "high",
      authority: "reviewed",
      enforcement: "warn",
      sourceKind: "repo_memory",
      sourceId: "repo-rule-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      validUntilMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryConclusionSource(d1, {
      id: "source-1",
      businessId: "biz-1",
      conclusionId: "conclusion-1",
      sourceKind: "memory_message",
      sourceId: "message-1",
      sourceUri: "https://app.trycycloid.com/sessions/session-1",
      excerpt: "Routes must use service-layer DAOs.",
      relationship: "supports",
      nowMs: 1000,
    });

    const rows = await listActiveMemoryConclusionsForScope(d1, { businessId: "biz-1", scopeId: "scope-1", limit: 10 });

    expect(rows).toMatchObject([
      {
        id: "conclusion-1",
        businessId: "biz-1",
        scopeId: "scope-1",
        level: "explicit",
        enforcement: "warn",
      },
    ]);
    expect(sqlite.prepare("SELECT source_id AS sourceId FROM memory_conclusion_sources").get()).toEqual({
      sourceId: "message-1",
    });
  });

  it("writes work items, query traces, and semantic document catalog rows", async () => {
    await insertMemoryWorkItem(d1, {
      id: "work-1",
      businessId: "biz-1",
      workType: "vector_sync",
      targetKind: "semantic_document",
      targetId: "doc-1",
      status: "pending",
      priority: 10,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryContextQuery(d1, {
      id: "query-1",
      businessId: "biz-1",
      sessionId: "session-1",
      promptId: "p-1",
      scopeId: null,
      intent: "routing work",
      requestJson: "{}",
      laneCountsJson: '{"repo":1}',
      vectorAvailable: false,
      vectorUnavailableReason: "missing_binding",
      fusionMode: "deterministic",
      candidateIdsJson: '["conclusion-1"]',
      selectedIdsJson: "[]",
      rejectedJson: "[]",
      selectorStatus: "not_run",
      selectorModel: null,
      selectorLatencyMs: null,
      traceJson: "{}",
      nowMs: 1000,
    });
    await upsertMemorySemanticDocument(d1, {
      id: "doc-1",
      sourceKind: "repo_memory",
      sourceId: "repo-rule-1",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      scopeType: "repo",
      scopeId: "scope-1",
      text: "Route handlers should not prepare D1 statements directly.",
      contentHash: "hash-1",
      embeddingModel: MEMORY_EMBEDDING_MODEL,
      embeddingDim: MEMORY_EMBEDDING_DIM,
      vectorNamespace: "biz-1",
      vectorId: "vec-1",
      vectorState: "pending",
      lastError: null,
      nowMs: 1000,
    });
    await upsertMemorySemanticDocument(d1, {
      id: "doc-reused",
      sourceKind: "repo_memory",
      sourceId: "repo-rule-1",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      scopeType: "repo",
      scopeId: "scope-1",
      text: "Updated text.",
      contentHash: "hash-2",
      embeddingModel: MEMORY_EMBEDDING_MODEL,
      embeddingDim: MEMORY_EMBEDDING_DIM,
      vectorNamespace: "biz-1",
      vectorId: "vec-1",
      vectorState: "pending",
      lastError: null,
      nowMs: 2000,
    });

    expect(sqlite.prepare("SELECT status, priority FROM memory_work_items WHERE id = 'work-1'").get()).toEqual({
      status: "pending",
      priority: 10,
    });
    expect(sqlite.prepare("SELECT vector_available AS vectorAvailable FROM memory_context_queries").get()).toEqual({
      vectorAvailable: 0,
    });
    expect(sqlite.prepare("SELECT id, text, content_hash AS contentHash FROM memory_semantic_documents").all()).toEqual(
      [{ id: "doc-1", text: "Updated text.", contentHash: "hash-2" }],
    );
  });

  it("reclaims a processing work item once its lock expires, but not before", async () => {
    await insertMemoryWorkItem(d1, {
      id: "work-stranded",
      businessId: "biz-1",
      workType: "vector_sync",
      targetKind: "semantic_document",
      targetId: "doc-1",
      status: "pending",
      priority: 1,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });
    // Simulate a crashed worker: row stuck in 'processing' with a lock in the past.
    sqlite
      .prepare(
        "UPDATE memory_work_items SET status = 'processing', attempts = 1, locked_until_ms = 5000 WHERE id = 'work-stranded'",
      )
      .run();

    const tooEarly = await claimNextMemoryWorkItem(d1, { nowMs: 4000, lockMs: 1000, maxAttempts: 5 });
    expect(tooEarly).toBeNull();

    const reclaimed = await claimNextMemoryWorkItem(d1, { nowMs: 6000, lockMs: 1000, maxAttempts: 5 });
    expect(reclaimed).toMatchObject({ id: "work-stranded", status: "processing", attempts: 2 });
  });

  it("re-enqueue revives terminal work items but leaves in-flight ones untouched", async () => {
    await insertMemoryWorkItem(d1, {
      id: "work-terminal",
      businessId: "biz-1",
      workType: "consolidate",
      targetKind: "memory_scope",
      targetId: "scope-1",
      status: "pending",
      priority: 1,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });
    sqlite.prepare("UPDATE memory_work_items SET status = 'failed', attempts = 5 WHERE id = 'work-terminal'").run();
    await insertMemoryWorkItem(d1, {
      id: "work-terminal",
      businessId: "biz-1",
      workType: "consolidate",
      targetKind: "memory_scope",
      targetId: "scope-1",
      status: "pending",
      priority: 3,
      availableAtMs: 9000,
      payloadJson: '{"retry":true}',
      nowMs: 9000,
    });
    expect(
      sqlite
        .prepare(
          "SELECT status, attempts, priority, available_at_ms AS availableAtMs FROM memory_work_items WHERE id = 'work-terminal'",
        )
        .get(),
    ).toEqual({ status: "pending", attempts: 5 - 5 + 0, priority: 3, availableAtMs: 9000 });

    // An in-flight (processing) duplicate must NOT be reset, preserving dedupe.
    await insertMemoryWorkItem(d1, {
      id: "work-inflight",
      businessId: "biz-1",
      workType: "consolidate",
      targetKind: "memory_scope",
      targetId: "scope-2",
      status: "pending",
      priority: 1,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });
    sqlite
      .prepare(
        "UPDATE memory_work_items SET status = 'processing', attempts = 1, locked_until_ms = 99999 WHERE id = 'work-inflight'",
      )
      .run();
    await insertMemoryWorkItem(d1, {
      id: "work-inflight",
      businessId: "biz-1",
      workType: "consolidate",
      targetKind: "memory_scope",
      targetId: "scope-2",
      status: "pending",
      priority: 9,
      availableAtMs: 9000,
      payloadJson: "{}",
      nowMs: 9000,
    });
    expect(
      sqlite.prepare("SELECT status, attempts, priority FROM memory_work_items WHERE id = 'work-inflight'").get(),
    ).toEqual({ status: "processing", attempts: 1, priority: 1 });
  });

  it("re-embeds a semantic doc only when its content changes and revives exhausted retries", async () => {
    const base = {
      id: "doc-embed",
      sourceKind: "repo_memory" as const,
      sourceId: "repo-rule-9",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      scopeType: "repo",
      scopeId: "scope-1",
      text: "Original text.",
      contentHash: "hash-orig",
      embeddingModel: MEMORY_EMBEDDING_MODEL,
      embeddingDim: MEMORY_EMBEDDING_DIM,
      vectorNamespace: "biz-1",
      vectorId: "vec-embed",
      vectorState: "pending" as const,
      lastError: null,
      nowMs: 1000,
    };
    await upsertMemorySemanticDocument(d1, base);
    // Simulate a successful sync that then exhausted retries on a later transient error.
    sqlite
      .prepare("UPDATE memory_semantic_documents SET vector_state = 'synced', sync_attempts = 3 WHERE id = 'doc-embed'")
      .run();

    // Same content hash: must stay synced and NOT re-embed (sync_attempts preserved).
    await upsertMemorySemanticDocument(d1, { ...base, nowMs: 2000 });
    expect(
      sqlite
        .prepare(
          "SELECT vector_state AS vectorState, sync_attempts AS syncAttempts FROM memory_semantic_documents WHERE id = 'doc-embed'",
        )
        .get(),
    ).toEqual({ vectorState: "synced", syncAttempts: 3 });
    expect(await listPendingMemorySemanticDocuments(d1, { limit: 10 })).toEqual([]);

    // Changed content hash: back to pending AND sync_attempts reset so it is syncable again.
    await upsertMemorySemanticDocument(d1, { ...base, text: "New text.", contentHash: "hash-new", nowMs: 3000 });
    expect(
      sqlite
        .prepare(
          "SELECT vector_state AS vectorState, sync_attempts AS syncAttempts FROM memory_semantic_documents WHERE id = 'doc-embed'",
        )
        .get(),
    ).toEqual({ vectorState: "pending", syncAttempts: 0 });
    expect((await listPendingMemorySemanticDocuments(d1, { limit: 10 })).map((row) => row.id)).toEqual(["doc-embed"]);
  });

  it("fails closed: FTS lanes return nothing when no scopes are resolved", async () => {
    const conclusions = await searchMemoryConclusionsFts(d1, {
      businessId: "biz-1",
      repoOwner: null,
      repoName: null,
      scopeIds: [],
      query: "routing",
      limit: 10,
    });
    expect(conclusions).toEqual([]);
    const messages = await searchMemoryMessagesFts(d1, {
      businessId: "biz-1",
      scopeIds: [],
      query: "routing",
      limit: 10,
    });
    expect(messages).toEqual([]);
  });
});
