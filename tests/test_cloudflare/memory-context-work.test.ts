import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  insertMemoryConclusion,
  insertMemoryMessage,
  insertMemoryWorkItem,
  MEMORY_EMBEDDING_DIM,
  MEMORY_EMBEDDING_MODEL,
  upsertMemoryScope,
  upsertMemorySemanticDocument,
  upsertMemorySession,
} from "../../apps/control-plane-worker/src/company-memory/context-db";
import { enqueueMemoryContextDeriveForIngestion } from "../../apps/control-plane-worker/src/company-memory/context-producers";
import { processPendingMemoryWorkItems } from "../../apps/control-plane-worker/src/company-memory/context-work";
import { safeEnqueueMemoryContextDeriveForIngestion } from "../../apps/control-plane-worker/src/company-memory/service";
import { COMPANY_MEMORY_SOURCE_TYPE } from "../../apps/control-plane-worker/src/constants/company-memory";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { createMemoryContextD1, seedRepoMemoryGraph } from "./helpers/memory-context-db";

describe("memory context work processor", () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite, d1 } = createMemoryContextD1());
  });

  it("swallows memory-context enqueue failures so ingestion is never blocked", async () => {
    const throwingDb = {
      prepare() {
        throw new Error("d1_unavailable");
      },
    } as unknown as D1Database;

    await expect(
      safeEnqueueMemoryContextDeriveForIngestion(throwingDb, {
        created: true,
        ingestionEventId: "ingestion-1",
        businessId: "biz-1",
        sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
        sourceEventId: "evt-1",
        sourceUri: "slack://T1/C1/1.1",
        sourceTimeMs: 1000,
        contentText: "A concrete decision worth remembering.",
        scopeType: null,
        scopeId: null,
        actorRef: null,
        teamId: "T1",
        channelId: "C1",
        threadTs: "1.1",
        nowMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("enqueues graph derivation work from a company-memory ingestion event", async () => {
    await expect(
      enqueueMemoryContextDeriveForIngestion(d1, {
        created: true,
        ingestionEventId: "ingestion-1",
        businessId: "biz-1",
        sourceType: COMPANY_MEMORY_SOURCE_TYPE.GITHUB_PR_EVENT,
        sourceEventId: "github.pr:trycycloid/cycloid#123",
        sourceUri: "https://github.com/trycycloid/cycloid/pull/123",
        sourceTimeMs: 1000,
        contentText: "Merged PR established that prompt queue terminal side effects must be idempotent.",
        scopeType: "repo",
        scopeId: "trycycloid/cycloid",
        actorRef: "github_user:octocat",
        teamId: null,
        channelId: null,
        threadTs: null,
        nowMs: 1000,
      }),
    ).resolves.toEqual({ enqueued: true, reason: "ok" });

    expect(
      sqlite
        .prepare(
          "SELECT scope_type AS scopeType, scope_key AS scopeKey, repo_owner AS repoOwner, repo_name AS repoName FROM memory_scopes",
        )
        .get(),
    ).toEqual({
      scopeType: "repo",
      scopeKey: "trycycloid/cycloid",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    expect(
      sqlite.prepare("SELECT source_kind AS sourceKind, source_id AS sourceId FROM memory_sessions").get(),
    ).toEqual({
      sourceKind: "github_pr",
      sourceId: "github.pr:trycycloid/cycloid#123",
    });
    expect(sqlite.prepare("SELECT role, content_text AS contentText FROM memory_messages").get()).toEqual({
      role: "external",
      contentText: "Merged PR established that prompt queue terminal side effects must be idempotent.",
    });
    expect(
      sqlite.prepare("SELECT work_type AS workType, target_kind AS targetKind, status FROM memory_work_items").get(),
    ).toEqual({
      workType: "derive",
      targetKind: "memory_message",
      status: "pending",
    });

    const emitted: Array<Record<string, unknown>> = [];
    const waited: Array<Promise<unknown>> = [];
    const result = await processPendingMemoryWorkItems({} as Env, d1, {
      batchSize: 1,
      now: () => 2000,
      metrics: {
        waitUntil: (promise) => waited.push(promise),
        emit: async (_env, event) => {
          emitted.push(event);
        },
      },
    });
    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    await Promise.all(waited);
    expect(emitted).toEqual([
      {
        event: "memory_context.work_processed",
        claimed: 1,
        completed: 1,
        failed: 0,
        retried: 0,
      },
    ]);
    expect(sqlite.prepare("SELECT source_kind AS sourceKind FROM memory_conclusions").get()).toEqual({
      sourceKind: "memory_message",
    });
    expect(
      sqlite
        .prepare(
          "SELECT work_type AS workType, target_kind AS targetKind, status, available_at_ms AS availableAtMs FROM memory_work_items WHERE status = 'pending' ORDER BY priority DESC, work_type",
        )
        .all(),
    ).toEqual([
      { workType: "vector_sync", targetKind: "semantic_document", status: "pending", availableAtMs: 2000 },
      { workType: "consolidate", targetKind: "memory_scope", status: "pending", availableAtMs: 302000 },
    ]);
  });

  it("claims derive work and writes an attributed explicit conclusion from a memory message", async () => {
    await upsertMemoryScope(d1, {
      id: "scope-1",
      businessId: "biz-1",
      scopeType: "session",
      scopeKey: "session-1",
      repoOwner: null,
      repoName: null,
      customerSlug: null,
      slackTeamId: null,
      slackChannelId: null,
      slackThreadTs: null,
      sessionId: "session-1",
      incidentId: null,
      personId: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await upsertMemorySession(d1, {
      id: "memory-session-1",
      businessId: "biz-1",
      scopeId: "scope-1",
      sourceKind: "arcanist_session",
      sourceId: "session-1",
      sourceUri: "https://app.trycycloid.com/sessions/session-1",
      title: "Prompt queue retry handling",
      startedAtMs: 1000,
      endedAtMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryMessage(d1, {
      id: "message-1",
      businessId: "biz-1",
      sessionId: "memory-session-1",
      seqInSession: 1,
      peerId: null,
      role: "user",
      contentText: "Prompt queue terminal side effects must remain idempotent across duplicate terminal events.",
      contentJson: null,
      sourceUri: "session://session-1#message-1",
      occurredAtMs: 1000,
      nowMs: 1000,
    });
    await insertMemoryWorkItem(d1, {
      id: "work-derive-1",
      businessId: "biz-1",
      workType: "derive",
      targetKind: "memory_message",
      targetId: "message-1",
      status: "pending",
      priority: 10,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });

    const result = await processPendingMemoryWorkItems({} as Env, d1, { batchSize: 1, now: () => 2000 });

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, retried: 0 });
    expect(
      sqlite
        .prepare("SELECT status, completed_at_ms AS completedAtMs FROM memory_work_items WHERE id = 'work-derive-1'")
        .get(),
    ).toEqual({
      status: "completed",
      completedAtMs: 2000,
    });
    const conclusion = sqlite
      .prepare(
        "SELECT content, level, status, source_kind AS sourceKind, source_id AS sourceId FROM memory_conclusions",
      )
      .get();
    expect(conclusion).toEqual({
      content: "Prompt queue terminal side effects must remain idempotent across duplicate terminal events.",
      level: "explicit",
      status: "active",
      sourceKind: "memory_message",
      sourceId: "message-1",
    });
    expect(
      sqlite.prepare("SELECT source_kind AS sourceKind, source_id AS sourceId FROM memory_conclusion_sources").get(),
    ).toEqual({
      sourceKind: "memory_message",
      sourceId: "message-1",
    });
    expect(
      sqlite
        .prepare("SELECT source_kind AS sourceKind, vector_state AS vectorState FROM memory_semantic_documents")
        .get(),
    ).toEqual({
      sourceKind: "memory_conclusion",
      vectorState: "pending",
    });
    expect(
      sqlite
        .prepare(
          "SELECT work_type AS workType, status, available_at_ms AS availableAtMs FROM memory_work_items WHERE id != 'work-derive-1' ORDER BY work_type",
        )
        .all(),
    ).toEqual([
      { workType: "consolidate", status: "pending", availableAtMs: 302000 },
      { workType: "vector_sync", status: "pending", availableAtMs: 2000 },
    ]);
  });

  it("does not process derived consolidation work until the idle delay expires", async () => {
    await upsertMemoryScope(d1, {
      id: "scope-1",
      businessId: "biz-1",
      scopeType: "session",
      scopeKey: "session-1",
      repoOwner: null,
      repoName: null,
      customerSlug: null,
      slackTeamId: null,
      slackChannelId: null,
      slackThreadTs: null,
      sessionId: "session-1",
      incidentId: null,
      personId: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await upsertMemorySession(d1, {
      id: "memory-session-1",
      businessId: "biz-1",
      scopeId: "scope-1",
      sourceKind: "arcanist_session",
      sourceId: "session-1",
      sourceUri: "session://session-1",
      title: "Session memory",
      startedAtMs: 1000,
      endedAtMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryMessage(d1, {
      id: "message-1",
      businessId: "biz-1",
      sessionId: "memory-session-1",
      seqInSession: 1,
      peerId: null,
      role: "external",
      contentText: "Use ngrok for Slack OAuth callback verification.",
      contentJson: null,
      sourceUri: "session://session-1#message-1",
      occurredAtMs: 1000,
      nowMs: 1000,
    });
    await insertMemoryWorkItem(d1, {
      id: "work-derive-1",
      businessId: "biz-1",
      workType: "derive",
      targetKind: "memory_message",
      targetId: "message-1",
      status: "pending",
      priority: 10,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });

    await processPendingMemoryWorkItems({} as Env, d1, { batchSize: 1, now: () => 2000 });
    await processPendingMemoryWorkItems({} as Env, d1, {
      batchSize: 1,
      now: () => 2500,
      vectorSyncDeps: {
        embeddingProvider: {
          async embed() {
            return Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1);
          },
          async embedBatch(texts) {
            return texts.map(() => Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1));
          },
        },
        vectorIndex: {
          async query() {
            return [];
          },
          async upsert() {},
        },
      },
    });

    const early = await processPendingMemoryWorkItems({} as Env, d1, { batchSize: 5, now: () => 301999 });
    expect(early).toMatchObject({ claimed: 0, completed: 0 });

    const due = await processPendingMemoryWorkItems({} as Env, d1, { batchSize: 5, now: () => 400000 });
    expect(due).toMatchObject({ claimed: 1, completed: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_scope_cards").get()).toEqual({ count: 1 });
  });

  it("defers consolidation work (not completes it) while the scope is still active", async () => {
    await seedRepoMemoryGraph(d1);
    // Conclusion updated at 2000 (== now), so the scope is inside its idle window.
    await insertMemoryConclusion(d1, {
      id: "conclusion-1",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "constraint",
      content: "Routes call services before DAO functions.",
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
      nowMs: 2000,
    });
    await insertMemoryWorkItem(d1, {
      id: "work-consolidate-active",
      businessId: "biz-1",
      workType: "consolidate",
      targetKind: "memory_scope",
      targetId: "scope-1",
      status: "pending",
      priority: 5,
      availableAtMs: 1000,
      payloadJson: JSON.stringify({
        observerPeerId: "peer-agent",
        observedPeerId: "peer-repo",
        idleMs: 5000,
        limit: 10,
      }),
      nowMs: 1000,
    });

    const result = await processPendingMemoryWorkItems({} as Env, d1, {
      batchSize: 1,
      now: () => 2000,
    });

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 0, retried: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_scope_cards").get()).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT status, attempts, available_at_ms AS availableAtMs, locked_until_ms AS lockedUntilMs, last_error AS lastError FROM memory_work_items WHERE id = 'work-consolidate-active'",
        )
        .get(),
    ).toEqual({
      status: "pending",
      attempts: 0,
      availableAtMs: 7000,
      lockedUntilMs: null,
      lastError: "consolidate:not_idle",
    });
  });

  it("processes consolidation work into a scope card", async () => {
    await seedRepoMemoryGraph(d1);
    await insertMemoryConclusion(d1, {
      id: "conclusion-1",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "constraint",
      content: "Routes call services before DAO functions.",
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
    await insertMemoryWorkItem(d1, {
      id: "work-consolidate-1",
      businessId: "biz-1",
      workType: "consolidate",
      targetKind: "memory_scope",
      targetId: "scope-1",
      status: "pending",
      priority: 5,
      availableAtMs: 1000,
      payloadJson: JSON.stringify({
        observerPeerId: "peer-agent",
        observedPeerId: "peer-repo",
        idleMs: 500,
        limit: 10,
      }),
      nowMs: 1000,
    });

    const result = await processPendingMemoryWorkItems({} as Env, d1, { now: () => 2000 });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    const card = sqlite.prepare("SELECT card_json AS cardJson FROM memory_scope_cards").get() as { cardJson: string };
    expect(JSON.parse(card.cardJson)).toEqual({
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
    });
  });

  it("processes vector sync work with injected embedding and vector providers", async () => {
    await upsertMemorySemanticDocument(d1, {
      id: "semantic-1",
      sourceKind: "memory_conclusion",
      sourceId: "conclusion-1",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      scopeType: "repo",
      scopeId: "scope-1",
      text: "Routes call services before DAO functions.",
      contentHash: "hash-1",
      embeddingModel: MEMORY_EMBEDDING_MODEL,
      embeddingDim: MEMORY_EMBEDDING_DIM,
      vectorNamespace: "biz-1",
      vectorId: "vec-1",
      vectorState: "pending",
      lastError: null,
      nowMs: 1000,
    });
    await insertMemoryWorkItem(d1, {
      id: "work-vector-1",
      businessId: "biz-1",
      workType: "vector_sync",
      targetKind: "semantic_document",
      targetId: "semantic-1",
      status: "pending",
      priority: 1,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });
    const upserts: Array<{ vectorId: string; namespace: string }> = [];

    const result = await processPendingMemoryWorkItems({} as Env, d1, {
      now: () => 2000,
      vectorSyncDeps: {
        embeddingProvider: {
          async embed() {
            return Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1);
          },
          async embedBatch(texts) {
            return texts.map(() => Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1));
          },
        },
        vectorIndex: {
          async query() {
            return [];
          },
          async upsert(vectors) {
            upserts.push(...vectors.map((vector) => ({ vectorId: vector.vectorId, namespace: vector.namespace })));
          },
        },
      },
    });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(upserts).toEqual([{ vectorId: "vec-1", namespace: "biz-1" }]);
    expect(
      sqlite
        .prepare("SELECT vector_state AS vectorState, last_sync_at_ms AS lastSyncAtMs FROM memory_semantic_documents")
        .get(),
    ).toEqual({
      vectorState: "synced",
      lastSyncAtMs: 2000,
    });
  });

  it("defers vector_sync work (not completes it) when documents fail with retry budget left", async () => {
    await upsertMemorySemanticDocument(d1, {
      id: "semantic-retry",
      sourceKind: "memory_conclusion",
      sourceId: "conclusion-retry",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      scopeType: "repo",
      scopeId: "scope-1",
      text: "Routes call services before DAO functions.",
      contentHash: "hash-retry",
      embeddingModel: MEMORY_EMBEDDING_MODEL,
      embeddingDim: MEMORY_EMBEDDING_DIM,
      vectorNamespace: "biz-1",
      vectorId: "vec-retry",
      vectorState: "pending",
      lastError: null,
      nowMs: 1000,
    });
    await insertMemoryWorkItem(d1, {
      id: "work-vector-retry",
      businessId: "biz-1",
      workType: "vector_sync",
      targetKind: "semantic_document",
      targetId: "semantic-retry",
      status: "pending",
      priority: 1,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });

    const result = await processPendingMemoryWorkItems({} as Env, d1, {
      now: () => 2000,
      vectorSyncDeps: {
        embeddingProvider: {
          async embed() {
            throw new Error("embedding provider down");
          },
        },
        vectorIndex: {
          async query() {
            return [];
          },
          async upsert() {},
        },
      },
    });

    // A transiently failed document still has sync_attempts budget; completing
    // the work item would strand it until an unrelated sync is enqueued.
    expect(result).toMatchObject({ claimed: 1, completed: 0, retried: 1 });
    expect(result.outcomes[0]).toMatchObject({ id: "work-vector-retry", status: "retried" });
    const work = sqlite
      .prepare("SELECT status, available_at_ms AS availableAtMs, last_error AS lastError FROM memory_work_items")
      .get() as { status: string; availableAtMs: number; lastError: string };
    expect(work.status).toBe("pending");
    expect(work.availableAtMs).toBeGreaterThan(2000);
    expect(work.lastError).toBe("vector_sync:retry_failed");
  });

  it("re-enqueues a completed vector_sync work item back to pending on a fresh enqueue", async () => {
    await insertMemoryWorkItem(d1, {
      id: "work-vector-rerun",
      businessId: "biz-1",
      workType: "vector_sync",
      targetKind: "semantic_document",
      targetId: "semantic-1",
      status: "pending",
      priority: 1,
      availableAtMs: 1000,
      payloadJson: "{}",
      nowMs: 1000,
    });
    // Mark it completed as if a prior run finished.
    sqlite
      .prepare("UPDATE memory_work_items SET status = 'completed', attempts = 3 WHERE id = 'work-vector-rerun'")
      .run();

    // A later enqueue with the same deterministic id must revive it, not be a no-op.
    await insertMemoryWorkItem(d1, {
      id: "work-vector-rerun",
      businessId: "biz-1",
      workType: "vector_sync",
      targetKind: "semantic_document",
      targetId: "semantic-1",
      status: "pending",
      priority: 4,
      availableAtMs: 5000,
      payloadJson: "{}",
      nowMs: 5000,
    });

    expect(
      sqlite
        .prepare(
          "SELECT status, attempts, priority, available_at_ms AS availableAtMs FROM memory_work_items WHERE id = 'work-vector-rerun'",
        )
        .get(),
    ).toEqual({ status: "pending", attempts: 0, priority: 4, availableAtMs: 5000 });
  });
});
