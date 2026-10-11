import { MEMORY_EMBEDDING_SYNC_TIMEOUT_MS } from "../constants/memory-context";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import {
  listPendingMemorySemanticDocuments,
  markMemorySemanticDocumentFailed,
  markMemorySemanticDocumentSynced,
  MEMORY_EMBEDDING_DIM,
  MEMORY_EMBEDDING_MODEL,
  type PendingMemorySemanticDocumentRow,
} from "./context-db";
import { getMemoryVectorIndex, type MemoryVectorIndex, type MemoryVectorUpsert } from "./vector-index";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export interface MemoryEmbeddingProvider {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface MemoryVectorSyncDeps {
  embeddingProvider?: MemoryEmbeddingProvider;
  vectorIndex?: MemoryVectorIndex | null;
  now?: () => number;
}

export interface MemoryVectorSyncResult {
  scanned: number;
  synced: number;
  failed: number;
  skipped: number;
}

export function createOpenAIMemoryEmbeddingProvider(
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY">,
): MemoryEmbeddingProvider {
  return {
    async embed(text, signal) {
      const response = await tracedFetch(
        OPENAI_EMBEDDINGS_URL,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.ARCANIST_OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: text,
            model: MEMORY_EMBEDDING_MODEL,
            dimensions: MEMORY_EMBEDDING_DIM,
            encoding_format: "float",
          }),
          signal,
        },
        "openai.embeddings",
      );
      if (!response.ok) {
        const detail = await readOpenAIEmbeddingErrorDetail(response);
        throw new Error(`openai_embedding_failed:${response.status}${detail ? `:${detail}` : ""}`);
      }
      const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) throw new Error("openai_embedding_missing_vector");
      const vector = embedding.flatMap((value) => (typeof value === "number" && Number.isFinite(value) ? [value] : []));
      if (vector.length !== MEMORY_EMBEDDING_DIM) throw new Error(`openai_embedding_wrong_dim:${vector.length}`);
      return vector;
    },

    async embedBatch(texts, signal) {
      if (texts.length === 0) return [];
      const response = await tracedFetch(
        OPENAI_EMBEDDINGS_URL,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.ARCANIST_OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: texts,
            model: MEMORY_EMBEDDING_MODEL,
            dimensions: MEMORY_EMBEDDING_DIM,
            encoding_format: "float",
          }),
          signal,
        },
        "openai.embeddings",
      );
      if (!response.ok) {
        const detail = await readOpenAIEmbeddingErrorDetail(response);
        throw new Error(`openai_embedding_failed:${response.status}${detail ? `:${detail}` : ""}`);
      }
      const body = (await response.json()) as { data?: Array<{ embedding?: unknown; index?: number }> };
      if (!Array.isArray(body.data)) throw new Error("openai_embedding_missing_data");
      if (body.data.length !== texts.length) throw new Error("openai_embedding_count_mismatch");
      const embeddings = new Array<number[]>(texts.length);
      for (const item of body.data) {
        const index = item.index;
        if (typeof index !== "number" || !Number.isInteger(index)) throw new Error("openai_embedding_missing_index");
        if (index < 0 || index >= texts.length) throw new Error(`openai_embedding_index_out_of_range:${index}`);
        if (embeddings[index]) throw new Error(`openai_embedding_duplicate_index:${index}`);
        const embedding = item.embedding;
        if (!Array.isArray(embedding)) throw new Error("openai_embedding_missing_vector");
        const vector = embedding.flatMap((value) =>
          typeof value === "number" && Number.isFinite(value) ? [value] : [],
        );
        if (vector.length !== MEMORY_EMBEDDING_DIM) throw new Error(`openai_embedding_wrong_dim:${vector.length}`);
        embeddings[index] = vector;
      }
      if (embeddings.some((vector) => !vector)) throw new Error("openai_embedding_missing_vector");
      return embeddings;
    },
  };
}

async function readOpenAIEmbeddingErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (body && typeof body === "object") {
      const error = (body as { error?: unknown }).error;
      if (error && typeof error === "object") {
        const record = error as { code?: unknown; type?: unknown; message?: unknown };
        return sanitizeErrorDetail(
          [record.code, record.type, record.message]
            .filter((value): value is string => typeof value === "string")
            .join(":"),
        );
      }
    }
  } catch {
    // Best effort only; callers still get the HTTP status.
  }
  return "";
}

export function sanitizeErrorDetail(value: string): string {
  return value
    .replaceAll(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replaceAll(/\s+/g, "_")
    .slice(0, 240);
}

// Sync is insert/update only: nothing deletes memory sources yet, so there is
// no Vectorize purge path. If source deletion is ever added, deleted documents
// must also have their vectors removed here — until then stale vectors are
// harmless (query results are joined back against D1 rows, which filters them)
// but they accumulate in the index.
export async function syncPendingMemorySemanticDocuments(
  env: Env,
  db: D1Database,
  deps: MemoryVectorSyncDeps = {},
): Promise<MemoryVectorSyncResult> {
  const now = deps.now ?? Date.now;
  const embeddingProvider = deps.embeddingProvider ?? createOpenAIMemoryEmbeddingProvider(env);
  const vectorIndex = deps.vectorIndex === undefined ? getMemoryVectorIndex(env) : deps.vectorIndex;
  const pending = await listPendingMemorySemanticDocuments(db, { limit: 10 });
  const result: MemoryVectorSyncResult = {
    scanned: pending.length,
    synced: 0,
    failed: 0,
    skipped: 0,
  };

  if (!vectorIndex) {
    for (const doc of pending) {
      await markMemorySemanticDocumentFailed(db, {
        id: doc.id,
        error: "missing_vectorize_binding",
        nowMs: now(),
      });
      result.failed += 1;
    }
    return result;
  }

  // Single pass: partition syncable documents and fail the rest, so
  // isSyncableDocument is evaluated once per document.
  const syncableDocs: PendingMemorySemanticDocumentRow[] = [];
  for (const doc of pending) {
    if (isSyncableDocument(doc)) {
      syncableDocs.push(doc);
      continue;
    }
    result.skipped += 1;
    await markMemorySemanticDocumentFailed(db, {
      id: doc.id,
      error: "semantic_document_missing_required_metadata",
      nowMs: now(),
    });
  }

  if (syncableDocs.length === 0) {
    return result;
  }

  const texts = syncableDocs.map((doc) => doc.text);
  let embeddings: number[][] | null = null;

  const embeddingSignal = AbortSignal.timeout(MEMORY_EMBEDDING_SYNC_TIMEOUT_MS);
  try {
    embeddings = await embeddingProvider.embedBatch(texts, embeddingSignal);
  } catch {
    // Batch embedding failed as a unit; fall back to per-document embedding
    // below so one poison document can't exhaust the whole batch's retry budget.
  }

  if (embeddings !== null) {
    const vectors: Array<{ doc: PendingMemorySemanticDocumentRow; upsert: MemoryVectorUpsert }> = [];
    for (let i = 0; i < syncableDocs.length; i++) {
      const doc = syncableDocs[i];
      // A short/misaligned batch response leaves this undefined; the guard below
      // fails that one document (preserving its retry budget) rather than throwing.
      const vector = embeddings[i];
      try {
        if (!vector || vector.length !== MEMORY_EMBEDDING_DIM)
          throw new Error(`embedding_wrong_dim:${vector?.length ?? 0}`);
        vectors.push({ doc, upsert: memoryVectorUpsert(doc, vector) });
      } catch (error) {
        await markMemorySemanticDocumentFailed(db, {
          id: doc.id,
          error: error instanceof Error ? error.message : "vector_sync_failed",
          nowMs: now(),
        });
        result.failed += 1;
      }
    }
    await upsertMemoryVectors(vectorIndex, db, vectors, now, result);
  } else {
    const vectors: Array<{ doc: PendingMemorySemanticDocumentRow; upsert: MemoryVectorUpsert }> = [];
    for (const doc of syncableDocs) {
      try {
        const vector = await embeddingProvider.embed(doc.text, AbortSignal.timeout(MEMORY_EMBEDDING_SYNC_TIMEOUT_MS));
        if (vector.length !== MEMORY_EMBEDDING_DIM) throw new Error(`embedding_wrong_dim:${vector.length}`);
        vectors.push({ doc, upsert: memoryVectorUpsert(doc, vector) });
      } catch (error) {
        await markMemorySemanticDocumentFailed(db, {
          id: doc.id,
          error: error instanceof Error ? error.message : "vector_sync_failed",
          nowMs: now(),
        });
        result.failed += 1;
      }
    }
    await upsertMemoryVectors(vectorIndex, db, vectors, now, result);
  }

  return result;
}

function memoryVectorUpsert(doc: PendingMemorySemanticDocumentRow, vector: number[]): MemoryVectorUpsert {
  return {
    vectorId: doc.vectorId,
    vector,
    namespace: doc.vectorNamespace,
    metadata: {
      businessId: doc.businessId,
      repoOwner: doc.repoOwner,
      repoName: doc.repoName,
      scopeId: doc.scopeId,
      sourceKind: doc.sourceKind,
    },
  };
}

async function upsertMemoryVectors(
  vectorIndex: MemoryVectorIndex,
  db: D1Database,
  vectors: Array<{ doc: PendingMemorySemanticDocumentRow; upsert: MemoryVectorUpsert }>,
  now: () => number,
  result: MemoryVectorSyncResult,
): Promise<void> {
  if (vectors.length === 0) return;

  try {
    await vectorIndex.upsert(vectors.map(({ upsert }) => upsert));
  } catch {
    for (const vector of vectors) {
      await upsertMemoryVector(vectorIndex, db, vector, now, result);
    }
    return;
  }

  for (const vector of vectors) {
    await markMemoryVectorSynced(db, vector.doc, now, result);
  }
}

async function upsertMemoryVector(
  vectorIndex: MemoryVectorIndex,
  db: D1Database,
  vector: { doc: PendingMemorySemanticDocumentRow; upsert: MemoryVectorUpsert },
  now: () => number,
  result: MemoryVectorSyncResult,
): Promise<void> {
  try {
    await vectorIndex.upsert([vector.upsert]);
    await markMemorySemanticDocumentSynced(db, { id: vector.doc.id, nowMs: now() });
    result.synced += 1;
  } catch (error) {
    await markMemorySemanticDocumentFailed(db, {
      id: vector.doc.id,
      error: error instanceof Error ? error.message : "vector_sync_failed",
      nowMs: now(),
    });
    result.failed += 1;
  }
}

async function markMemoryVectorSynced(
  db: D1Database,
  doc: PendingMemorySemanticDocumentRow,
  now: () => number,
  result: MemoryVectorSyncResult,
): Promise<void> {
  try {
    await markMemorySemanticDocumentSynced(db, { id: doc.id, nowMs: now() });
    result.synced += 1;
  } catch (error) {
    await markMemorySemanticDocumentFailed(db, {
      id: doc.id,
      error: error instanceof Error ? error.message : "vector_sync_failed",
      nowMs: now(),
    });
    result.failed += 1;
  }
}

function isSyncableDocument(doc: PendingMemorySemanticDocumentRow): boolean {
  return Boolean(doc.businessId && doc.scopeId && doc.vectorNamespace && doc.vectorId && doc.text.trim());
}
