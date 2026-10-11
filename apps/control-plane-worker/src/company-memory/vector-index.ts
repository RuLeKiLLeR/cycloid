import type { Env } from "../types";

export interface MemoryVectorMatch {
  vectorId: string;
  score: number;
}

export interface MemoryVectorQuery {
  vector: number[];
  topK: number;
  businessId: string;
  repoOwner: string | null;
  repoName: string | null;
}

export interface MemoryVectorIndex {
  query(query: MemoryVectorQuery): Promise<MemoryVectorMatch[]>;
  upsert(vectors: MemoryVectorUpsert[]): Promise<void>;
  deleteByIds(vectorIds: string[]): Promise<void>;
}

export interface MemoryVectorUpsert {
  vectorId: string;
  vector: number[];
  namespace: string;
  metadata: {
    businessId: string;
    repoOwner: string | null;
    repoName: string | null;
    scopeId: string;
    sourceKind: string;
  };
}

export function getMemoryVectorIndex(env: Env): MemoryVectorIndex | null {
  return env.MEMORY_VECTOR_INDEX ? new CloudflareMemoryVectorIndex(env.MEMORY_VECTOR_INDEX) : null;
}

class CloudflareMemoryVectorIndex implements MemoryVectorIndex {
  constructor(private readonly index: Vectorize) {}

  async query(query: MemoryVectorQuery): Promise<MemoryVectorMatch[]> {
    const repoKeys = await repoFilterKeys(query.repoOwner, query.repoName);
    const filter: VectorizeVectorMetadataFilter = {
      tenant_key: await memoryVectorMetadataKey(query.businessId),
      active: true,
    };
    if (repoKeys) filter.repo_key = { $in: repoKeys };

    const result = await this.index.query(query.vector, {
      topK: Math.max(1, Math.min(Math.floor(query.topK), 30)),
      namespace: query.businessId,
      returnValues: false,
      returnMetadata: "indexed",
      filter,
    });

    return result.matches.map((match) => ({
      vectorId: match.id,
      score: match.score,
    }));
  }

  async upsert(vectors: MemoryVectorUpsert[]): Promise<void> {
    if (vectors.length === 0) return;
    await this.index.upsert(
      await Promise.all(
        vectors.map(async (vector) => ({
          id: vector.vectorId,
          values: vector.vector,
          namespace: vector.namespace,
          metadata: {
            tenant_key: await memoryVectorMetadataKey(vector.metadata.businessId),
            repo_key: await repoMetadataKey(vector.metadata.repoOwner, vector.metadata.repoName),
            scope_key: await memoryVectorMetadataKey(vector.metadata.scopeId),
            source_kind: vector.metadata.sourceKind,
            active: true,
          },
        })),
      ),
    );
  }

  async deleteByIds(vectorIds: string[]): Promise<void> {
    const ids = vectorIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return;
    await this.index.deleteByIds(ids);
  }
}

async function repoFilterKeys(repoOwner: string | null, repoName: string | null): Promise<string[] | null> {
  if (!repoOwner || !repoName) return null;
  return [await repoMetadataKey(repoOwner, repoName), await repoMetadataKey(null, null)];
}

async function repoMetadataKey(repoOwner: string | null, repoName: string | null): Promise<string> {
  const owner = repoOwner?.trim().toLowerCase() ?? "";
  const name = repoName?.trim().toLowerCase() ?? "";
  return memoryVectorMetadataKey(owner && name ? `${owner}/${name}` : "");
}

export async function memoryVectorMetadataKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
