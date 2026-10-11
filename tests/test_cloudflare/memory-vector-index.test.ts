import { describe, expect, it, vi } from "vitest";

import {
  getMemoryVectorIndex,
  memoryVectorMetadataKey,
} from "../../apps/control-plane-worker/src/company-memory/vector-index";
import type { Env } from "../../apps/control-plane-worker/src/types";

describe("memory Vectorize adapter", () => {
  it("upserts hashed metadata keys and queries through metadata filters", async () => {
    const upsert = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ matches: [{ id: "vec-1", score: 0.92 }] }));
    const index = getMemoryVectorIndex({ MEMORY_VECTOR_INDEX: { upsert, query } as unknown as Vectorize } as Env);
    expect(index).not.toBeNull();
    if (!index) return;

    await index.upsert([
      {
        vectorId: "vec-1",
        vector: [0.1, 0.2, 0.3],
        namespace: "biz-1",
        metadata: {
          businessId: "biz-1",
          repoOwner: "TryCycloid",
          repoName: "Cycloid",
          scopeId: "scope-repo",
          sourceKind: "repo_memory",
        },
      },
    ]);
    await expect(
      index.query({
        vector: [0.1, 0.2, 0.3],
        topK: 100,
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    ).resolves.toEqual([{ vectorId: "vec-1", score: 0.92 }]);

    const tenantKey = await memoryVectorMetadataKey("biz-1");
    const repoKey = await memoryVectorMetadataKey("trycycloid/cycloid");
    const businessWideRepoKey = await memoryVectorMetadataKey("");
    const scopeKey = await memoryVectorMetadataKey("scope-repo");

    expect(upsert).toHaveBeenCalledWith([
      {
        id: "vec-1",
        values: [0.1, 0.2, 0.3],
        namespace: "biz-1",
        metadata: {
          tenant_key: tenantKey,
          repo_key: repoKey,
          scope_key: scopeKey,
          source_kind: "repo_memory",
          active: true,
        },
      },
    ]);
    expect(query).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
      topK: 30,
      namespace: "biz-1",
      returnValues: false,
      returnMetadata: "indexed",
      filter: {
        tenant_key: tenantKey,
        repo_key: { $in: [repoKey, businessWideRepoKey] },
        active: true,
      },
    });
  });
});
