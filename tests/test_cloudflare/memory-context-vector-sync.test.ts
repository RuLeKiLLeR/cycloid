import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEMORY_EMBEDDING_DIM } from "../../apps/control-plane-worker/src/company-memory/context-db";
import {
  createOpenAIMemoryEmbeddingProvider,
  syncPendingMemorySemanticDocuments,
} from "../../apps/control-plane-worker/src/company-memory/context-vector-sync";
import type {
  MemoryVectorIndex,
  MemoryVectorUpsert,
} from "../../apps/control-plane-worker/src/company-memory/vector-index";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { createMemoryContextD1 } from "./helpers/memory-context-db";

function insertPendingDoc(db: Database.Database, params: { id?: string; text?: string; vectorId?: string } = {}): void {
  const id = params.id ?? "doc-1";
  db.prepare(
    `INSERT INTO memory_semantic_documents
     (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
      text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
      vector_state, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "repo_memory",
    `repo-rule-${id}`,
    "biz-1",
    "trycycloid",
    "cycloid",
    "repo",
    "scope-repo",
    params.text ?? "Route handlers should call services.",
    `hash-${id}`,
    "text-embedding-3-small",
    MEMORY_EMBEDDING_DIM,
    "biz-1",
    params.vectorId ?? "vec-1",
    "pending",
    1000,
  );
}

describe("memory context vector sync", () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite, d1 } = createMemoryContextD1());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("embeds pending semantic documents, upserts them to Vectorize, and marks them synced", async () => {
    insertPendingDoc(sqlite);
    const upsertCalls: MemoryVectorUpsert[][] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upsertCalls.push(vectors);
      },
      async deleteByIds() {},
    };

    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed(text, signal) {
          expect(signal?.aborted).toBe(false);
          expect(text).toBe("Route handlers should call services.");
          return Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, index) => index / MEMORY_EMBEDDING_DIM);
        },
        async embedBatch(texts) {
          expect(texts).toEqual(["Route handlers should call services."]);
          return [Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, index) => index / MEMORY_EMBEDDING_DIM)];
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(result).toEqual({ scanned: 1, synced: 1, failed: 0, skipped: 0 });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0][0]).toMatchObject({
      vectorId: "vec-1",
      namespace: "biz-1",
      metadata: {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        scopeId: "scope-repo",
        sourceKind: "repo_memory",
      },
    });
    expect(
      sqlite
        .prepare("SELECT vector_state AS vectorState, last_sync_at_ms AS lastSyncAtMs FROM memory_semantic_documents")
        .get(),
    ).toEqual({
      vectorState: "synced",
      lastSyncAtMs: 2000,
    });
  });

  it("marks pending documents failed when Vectorize is unavailable", async () => {
    insertPendingDoc(sqlite);

    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed() {
          throw new Error("should_not_embed_without_vector_index");
        },
      },
      vectorIndex: null,
      now: () => 2000,
    });

    expect(result).toEqual({ scanned: 1, synced: 0, failed: 1, skipped: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT vector_state AS vectorState, sync_attempts AS syncAttempts, last_error AS lastError FROM memory_semantic_documents",
        )
        .get(),
    ).toEqual({
      vectorState: "failed",
      syncAttempts: 1,
      lastError: "missing_vectorize_binding",
    });
  });

  it("includes bounded OpenAI embedding error details without leaking keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "model_not_allowed",
              type: "invalid_request_error",
              message: "Project cannot use this model with key sk-secret123",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      createOpenAIMemoryEmbeddingProvider({ ARCANIST_OPENAI_API_KEY: "sk-live-key" }).embed("hello"),
    ).rejects.toThrow(
      "openai_embedding_failed:403:model_not_allowed:invalid_request_error:Project_cannot_use_this_model_with_key_sk-[redacted]",
    );
  });

  it("forwards an embedding timeout signal to OpenAI", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ data: [{ embedding: Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1) }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createOpenAIMemoryEmbeddingProvider({ ARCANIST_OPENAI_API_KEY: "sk-live-key" }).embed(
      "hello",
      AbortSignal.timeout(1_000),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("embeds multiple pending documents in a single batch call", async () => {
    const doc1Text = "Route handlers should call services.";
    const doc2Text = "Services call DAOs.";
    const doc3Text = "DAOs access the database.";

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
        "repo_memory",
        "repo-rule-1",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        doc1Text,
        "hash-1",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-1",
        "pending",
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
        "repo_memory",
        "repo-rule-2",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        doc2Text,
        "hash-2",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-2",
        "pending",
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
        "doc-3",
        "repo_memory",
        "repo-rule-3",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        doc3Text,
        "hash-3",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-3",
        "pending",
        1000,
      );

    const upsertCalls: MemoryVectorUpsert[][] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upsertCalls.push(vectors);
      },
      async deleteByIds() {},
    };

    let batchCallCount = 0;
    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed(text) {
          throw new Error("should_not_call_single_embed");
        },
        async embedBatch(texts) {
          batchCallCount++;
          expect(texts).toEqual([doc1Text, doc2Text, doc3Text]);
          return texts.map((_, index) =>
            Array.from(
              { length: MEMORY_EMBEDDING_DIM },
              (_, i) => (index * MEMORY_EMBEDDING_DIM + i) / MEMORY_EMBEDDING_DIM,
            ),
          );
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(batchCallCount).toBe(1);
    expect(result).toEqual({ scanned: 3, synced: 3, failed: 0, skipped: 0 });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toHaveLength(3);
    expect(upsertCalls[0][0]).toMatchObject({
      vectorId: "vec-1",
      namespace: "biz-1",
      metadata: {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        scopeId: "scope-repo",
        sourceKind: "repo_memory",
      },
    });
    expect(upsertCalls[0][1]).toMatchObject({
      vectorId: "vec-2",
      namespace: "biz-1",
    });
    expect(upsertCalls[0][2]).toMatchObject({
      vectorId: "vec-3",
      namespace: "biz-1",
    });

    const docs = sqlite
      .prepare("SELECT id, vector_state AS vectorState FROM memory_semantic_documents ORDER BY id")
      .all() as Array<{ id: string; vectorState: string }>;
    expect(docs).toEqual([
      { id: "doc-1", vectorState: "synced" },
      { id: "doc-2", vectorState: "synced" },
      { id: "doc-3", vectorState: "synced" },
    ]);
  });

  it("handles partial failures in batch embedding", async () => {
    const doc1Text = "Valid document 1";
    const doc2Text = "Valid document 2";
    const doc3Text = "Valid document 3";

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
        "repo_memory",
        "repo-rule-1",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        doc1Text,
        "hash-1",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-1",
        "pending",
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
        "repo_memory",
        "repo-rule-2",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        doc2Text,
        "hash-2",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-2",
        "pending",
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
        "doc-3",
        "repo_memory",
        "repo-rule-3",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        doc3Text,
        "hash-3",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-3",
        "pending",
        1000,
      );

    const upsertCalls: MemoryVectorUpsert[][] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upsertCalls.push(vectors);
      },
      async deleteByIds() {},
    };

    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed(text, signal) {
          expect(signal?.aborted).toBe(false);
          if (text === doc2Text) {
            throw new Error("embedding_failed_for_doc_2");
          }
          return Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, i) => i / MEMORY_EMBEDDING_DIM);
        },
        async embedBatch(texts) {
          throw new Error("batch_embedding_failed");
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(result).toEqual({ scanned: 3, synced: 2, failed: 1, skipped: 0 });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].map(({ vectorId }) => vectorId)).toEqual(["vec-1", "vec-3"]);

    const docs = sqlite
      .prepare(
        "SELECT id, vector_state AS vectorState, last_error AS lastError FROM memory_semantic_documents ORDER BY id",
      )
      .all() as Array<{ id: string; vectorState: string; lastError: string }>;
    expect(docs).toEqual([
      { id: "doc-1", vectorState: "synced", lastError: null },
      { id: "doc-2", vectorState: "failed", lastError: "embedding_failed_for_doc_2" },
      { id: "doc-3", vectorState: "synced", lastError: null },
    ]);
  });

  it("falls back to isolated upserts when a batched upsert fails", async () => {
    insertPendingDoc(sqlite);
    insertPendingDoc(sqlite, { id: "doc-2", text: "Services call DAOs.", vectorId: "vec-2" });

    const upsertCalls: string[][] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upsertCalls.push(vectors.map(({ vectorId }) => vectorId));
        if (vectors.length > 1) throw new Error("batch_upsert_failed");
        if (vectors[0]?.vectorId === "vec-2") throw new Error("doc_2_upsert_failed");
      },
      async deleteByIds() {},
    };

    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed() {
          throw new Error("should_not_call_single_embed");
        },
        async embedBatch(texts) {
          return texts.map(() => Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, index) => index));
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(upsertCalls).toEqual([["vec-1", "vec-2"], ["vec-1"], ["vec-2"]]);
    expect(result).toEqual({ scanned: 2, synced: 1, failed: 1, skipped: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT id, vector_state AS vectorState, sync_attempts AS syncAttempts, last_error AS lastError FROM memory_semantic_documents ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "doc-1", vectorState: "synced", syncAttempts: 0, lastError: null },
      { id: "doc-2", vectorState: "failed", syncAttempts: 1, lastError: "doc_2_upsert_failed" },
    ]);
  });

  it("excludes invalid embeddings from the batched upsert", async () => {
    insertPendingDoc(sqlite);
    insertPendingDoc(sqlite, { id: "doc-2", text: "Services call DAOs.", vectorId: "vec-2" });
    const upsertCalls: string[][] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upsertCalls.push(vectors.map(({ vectorId }) => vectorId));
      },
      async deleteByIds() {},
    };

    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed() {
          throw new Error("should_not_call_single_embed");
        },
        async embedBatch() {
          return [Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, index) => index), [1, 2, 3]];
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(upsertCalls).toEqual([["vec-1"]]);
    expect(result).toEqual({ scanned: 2, synced: 1, failed: 1, skipped: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT vector_state AS vectorState, last_error AS lastError FROM memory_semantic_documents WHERE id = ?",
        )
        .get("doc-2"),
    ).toEqual({ vectorState: "failed", lastError: "embedding_wrong_dim:3" });
  });

  it("keeps counters accurate when one post-upsert synced write fails", async () => {
    insertPendingDoc(sqlite);
    insertPendingDoc(sqlite, { id: "doc-2", text: "Services call DAOs.", vectorId: "vec-2" });
    sqlite.exec(`CREATE TRIGGER fail_doc_2_synced
      BEFORE UPDATE OF vector_state ON memory_semantic_documents
      WHEN OLD.id = 'doc-2' AND NEW.vector_state = 'synced'
      BEGIN
        SELECT RAISE(FAIL, 'mark_synced_failed');
      END`);
    const upsertCalls: string[][] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upsertCalls.push(vectors.map(({ vectorId }) => vectorId));
      },
      async deleteByIds() {},
    };

    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed() {
          throw new Error("should_not_call_single_embed");
        },
        async embedBatch(texts) {
          return texts.map(() => Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, index) => index));
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(upsertCalls).toEqual([["vec-1", "vec-2"]]);
    expect(result).toEqual({ scanned: 2, synced: 1, failed: 1, skipped: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT vector_state AS vectorState, sync_attempts AS syncAttempts FROM memory_semantic_documents WHERE id = ?",
        )
        .get("doc-2"),
    ).toEqual({ vectorState: "failed", syncAttempts: 1 });
  });

  it("handles empty batch when no syncable documents", async () => {
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
        "repo_memory",
        "repo-rule-1",
        "biz-1",
        "trycycloid",
        "cycloid",
        "repo",
        "scope-repo",
        "",
        "hash-1",
        "text-embedding-3-small",
        MEMORY_EMBEDDING_DIM,
        "biz-1",
        "vec-1",
        "pending",
        1000,
      );

    const upserts: MemoryVectorUpsert[] = [];
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [];
      },
      async upsert(vectors) {
        upserts.push(...vectors);
      },
      async deleteByIds() {},
    };

    let batchCallCount = 0;
    const result = await syncPendingMemorySemanticDocuments({} as Env, d1, {
      embeddingProvider: {
        async embed(text) {
          throw new Error("should_not_call_single_embed");
        },
        async embedBatch(texts) {
          batchCallCount++;
          return texts.map(() => Array.from({ length: MEMORY_EMBEDDING_DIM }, (_, i) => i / MEMORY_EMBEDDING_DIM));
        },
      },
      vectorIndex,
      now: () => 2000,
    });

    expect(batchCallCount).toBe(0);
    expect(result).toEqual({ scanned: 1, synced: 0, failed: 0, skipped: 1 });
    expect(upserts).toHaveLength(0);

    const doc = sqlite
      .prepare("SELECT vector_state AS vectorState, last_error AS lastError FROM memory_semantic_documents")
      .get() as { vectorState: string; lastError: string };
    expect(doc).toEqual({
      vectorState: "failed",
      lastError: "semantic_document_missing_required_metadata",
    });
  });
});
