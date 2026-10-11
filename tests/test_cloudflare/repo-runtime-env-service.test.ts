import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPO_LOGIN_ENV_BLOB_NAME } from "../../apps/control-plane-worker/src/env-blobs/login-env";

const dbMocks = vi.hoisted(() => ({
  deleteRepoEnvBlobByIdIfVersion: vi.fn(),
  deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale: vi.fn(),
  deleteStaleRepoEnvBlobsForRepoIfCurrentWinner: vi.fn(),
  getRepoEnvBlobForRepo: vi.fn(),
  insertRepoEnvBlobForRepo: vi.fn(),
  updateRepoEnvBlobByIdIfUnchangedAndCleanupStale: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/env-blobs/db", () => dbMocks);

function makeRow(id: string, envText: string, updatedAt: number) {
  return {
    id,
    owner_user_id: 1,
    business_id: "biz-1",
    name: REPO_LOGIN_ENV_BLOB_NAME,
    env_text: envText,
    encrypted: 0,
    key_names_json: JSON.stringify(
      envText
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(0, line.indexOf("=")))
        .sort(),
    ),
    entry_meta_json: "{}",
    is_global: 0,
    created_at: 100,
    updated_at: updatedAt,
    repo_owner: "acme",
    repo_name: "web",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  dbMocks.deleteRepoEnvBlobByIdIfVersion.mockResolvedValue(true);
  dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner.mockResolvedValue({
    staleDeletedCount: 0,
    keptBlobStillCurrentWinner: true,
  });
  dbMocks.insertRepoEnvBlobForRepo.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("repo runtime env service concurrency handling", () => {
  it("rejects empty and whitespace-only values at upsert", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    for (const value of ["", "   ", "\n"]) {
      await expect(
        service.upsertRepoLoginEnvVariable({} as D1Database, {
          businessId: "biz-1",
          actorUserId: 1,
          repoOwner: "acme",
          repoName: "web",
          key: "MIA_ANTHROPIC_API_KEY",
          value,
          encryptionKey: "test-encryption-key",
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(dbMocks.getRepoEnvBlobForRepo).not.toHaveBeenCalled();
  });

  it("retries an upsert after a stale version miss and merges the latest live keys", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    let liveRow = makeRow("blob-1", "A=1", 100);

    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => liveRow);
    dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockImplementation(async () => {
      if (liveRow.updated_at === 100) {
        liveRow = makeRow("blob-1", "A=1\nB=2", 200);
        return false;
      }
      liveRow = makeRow("blob-1", "A=1\nB=2\nC=3", 300);
      return true;
    });

    const result = await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "C",
      value: "3",
      encryptionKey: "test-encryption-key",
    });

    expect(result.keyNames).toEqual(["A", "B", "C"]);
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).toHaveBeenCalledTimes(2);
    // Cleanup is folded into the combined update DAO; the service must not run a separate
    // unguarded cleanup after a successful update.
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).not.toHaveBeenCalled();
  });

  it("uses a monotonic updated_at so the just-updated row always wins the repo", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    // Existing row carries a future-looking updated_at (same-ms write / clock skew). The new
    // stamp must strictly exceed it, never reuse Date.now() verbatim.
    const liveRow = makeRow("blob-1", "A=1", 8_000_000_000_000);
    dbMocks.getRepoEnvBlobForRepo.mockResolvedValue(liveRow);
    dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockResolvedValue(true);

    await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "B",
      value: "2",
      encryptionKey: "test-encryption-key",
    });

    const callArgs = dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mock.calls[0][1] as {
      expectedUpdatedAt: number;
      now: number;
    };
    expect(callArgs.expectedUpdatedAt).toBe(8_000_000_000_000);
    expect(callArgs.now).toBeGreaterThan(callArgs.expectedUpdatedAt);
  });

  it("throws 409 after exhausting upsert CAS retries", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const liveRow = makeRow("blob-1", "A=1", 100);
    dbMocks.getRepoEnvBlobForRepo.mockResolvedValue(liveRow);
    // Every attempt loses the race.
    dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockResolvedValue(false);

    await expect(
      service.upsertRepoLoginEnvVariable({} as D1Database, {
        businessId: "biz-1",
        actorUserId: 1,
        repoOwner: "acme",
        repoName: "web",
        key: "B",
        value: "2",
        encryptionKey: "test-encryption-key",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mock.calls.length).toBeGreaterThan(1);
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).not.toHaveBeenCalled();
  });

  it("retries a create when another writer wins the initial insert race", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const uuidSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("blob-created")
      .mockReturnValueOnce("blob-unused");
    let liveRow: ReturnType<typeof makeRow> | null = null;
    let readCount = 0;

    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => {
      readCount += 1;
      if (readCount === 2) {
        liveRow = makeRow("blob-other", "B=2", 200);
      }
      return liveRow;
    });
    dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockImplementation(async () => {
      liveRow = makeRow("blob-other", "A=1\nB=2", 300);
      return true;
    });

    const result = await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "A",
      value: "1",
      encryptionKey: "test-encryption-key",
    });

    expect(uuidSpy).toHaveBeenCalled();
    expect(dbMocks.insertRepoEnvBlobForRepo).toHaveBeenCalledTimes(1);
    // The just-inserted loser is deleted with a version guard on its own insert stamp so a
    // concurrent writer that has since adopted the row is never clobbered.
    expect(dbMocks.deleteRepoEnvBlobByIdIfVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        id: "blob-created",
        expectedUpdatedAt: expect.any(Number),
      }),
    );
    expect(result.id).toBe("blob-other");
    expect([...result.keyNames].sort()).toEqual(["A", "B"]);
  });

  it("guards stale cleanup on the inserted row when a create wins", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "blob-created" as `${string}-${string}-${string}-${string}-${string}`,
    );
    let liveRow: ReturnType<typeof makeRow> | null = null;
    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => liveRow);
    dbMocks.insertRepoEnvBlobForRepo.mockImplementation(async () => {
      liveRow = makeRow("blob-created", "A=1", 500);
    });

    const result = await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "A",
      value: "1",
      encryptionKey: "test-encryption-key",
    });

    expect(result.id).toBe("blob-created");
    // Cleanup must be winner-guarded on the inserted row (keepId + a version stamp), never an
    // unconditional delete-others. The create path stamps expectedUpdatedAt with its own now.
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keepId: "blob-created", expectedUpdatedAt: expect.any(Number) }),
    );
  });

  it("retries a create when cleanup finds the inserted blob lost the winner race", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "blob-created" as `${string}-${string}-${string}-${string}-${string}`,
    );
    const insertedRow = makeRow("blob-created", "A=1", 100);
    const winnerRow = makeRow("blob-winner", "B=2", 200);
    let readCount = 0;

    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => {
      readCount += 1;
      if (readCount === 1) return null;
      return readCount === 2 ? insertedRow : winnerRow;
    });
    dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner.mockResolvedValueOnce({
      staleDeletedCount: 0,
      keptBlobStillCurrentWinner: false,
    });
    dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockResolvedValue(true);

    const result = await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "A",
      value: "1",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toMatchObject({
      id: "blob-winner",
      keyNames: ["A", "B"],
    });
    expect(dbMocks.insertRepoEnvBlobForRepo).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).toHaveBeenCalledTimes(1);
    // Regression (ARC-1548): the create-loser blob must be deleted, not left as a permanent
    // orphan, when cleanup reports it lost the winner race. Version-guarded on its insert stamp.
    expect(dbMocks.deleteRepoEnvBlobByIdIfVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "blob-created", expectedUpdatedAt: expect.any(Number) }),
    );
  });

  it("winner-guards stale cleanup before returning from an idempotent upsert", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const liveRow = makeRow("blob-1", "A=1\nB=2", 200);

    dbMocks.getRepoEnvBlobForRepo.mockResolvedValue(liveRow);

    const result = await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "B",
      value: "2",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toMatchObject({
      id: "blob-1",
      keyNames: ["A", "B"],
    });
    // Cleanup carries the resolved row's version so a concurrent newer insert cannot be deleted.
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repoOwner: "acme", repoName: "web", keepId: "blob-1", expectedUpdatedAt: 200 }),
    );
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).not.toHaveBeenCalled();
  });

  it("retries an idempotent upsert when cleanup finds the read blob lost the winner race", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const oldRow = makeRow("blob-old", "A=1\nB=2", 100);
    const newerRow = makeRow("blob-newer", "A=1\nB=2\nC=3", 200);
    let readCount = 0;

    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => {
      readCount += 1;
      return readCount === 1 ? oldRow : newerRow;
    });
    dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner
      .mockResolvedValueOnce({
        staleDeletedCount: 0,
        keptBlobStillCurrentWinner: false,
      })
      .mockResolvedValue({
        staleDeletedCount: 0,
        keptBlobStillCurrentWinner: true,
      });

    const result = await service.upsertRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "B",
      value: "2",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toMatchObject({
      id: "blob-newer",
      keyNames: ["A", "B", "C"],
      updatedAt: 200,
    });
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).toHaveBeenCalledTimes(2);
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).not.toHaveBeenCalled();
  });

  it("retries delete-after-read when another writer updates the blob first", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    let liveRow = makeRow("blob-1", "ONLY=1", 100);

    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => liveRow);
    dbMocks.deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockImplementation(async () => {
      liveRow = makeRow("blob-1", "B=2\nONLY=1", 200);
      return false;
    });
    dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockImplementation(async () => {
      liveRow = makeRow("blob-1", "B=2", 300);
      return true;
    });

    const result = await service.deleteRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "ONLY",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toEqual({
      changed: true,
      loginEnv: expect.objectContaining({
        id: "blob-1",
        keyNames: ["B"],
      }),
    });
    expect(dbMocks.deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).toHaveBeenCalledTimes(1);
  });

  it("throws 409 after exhausting empty-env delete CAS retries", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const liveRow = makeRow("blob-1", "ONLY=1", 100);
    dbMocks.getRepoEnvBlobForRepo.mockResolvedValue(liveRow);
    // The last key is removed every attempt, but the combined delete keeps losing the race.
    dbMocks.deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale.mockResolvedValue(false);

    await expect(
      service.deleteRepoLoginEnvVariable({} as D1Database, {
        businessId: "biz-1",
        actorUserId: 1,
        repoOwner: "acme",
        repoName: "web",
        key: "ONLY",
        encryptionKey: "test-encryption-key",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMocks.deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale.mock.calls.length).toBeGreaterThan(1);
  });

  it("winner-guards stale cleanup before returning unchanged when delete targets a missing key", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const liveRow = makeRow("blob-1", "A=1\nB=2", 200);

    dbMocks.getRepoEnvBlobForRepo.mockResolvedValue(liveRow);

    const result = await service.deleteRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "MISSING",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toEqual({
      changed: false,
      loginEnv: expect.objectContaining({
        id: "blob-1",
        keyNames: ["A", "B"],
      }),
    });
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repoOwner: "acme", repoName: "web", keepId: "blob-1", expectedUpdatedAt: 200 }),
    );
    expect(dbMocks.deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale).not.toHaveBeenCalled();
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).not.toHaveBeenCalled();
  });

  it("retries a missing-key delete when cleanup finds the read blob lost the winner race", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    const oldRow = makeRow("blob-old", "A=1", 100);
    const newerRow = makeRow("blob-newer", "A=1\nB=2", 200);
    let readCount = 0;

    dbMocks.getRepoEnvBlobForRepo.mockImplementation(async () => {
      readCount += 1;
      return readCount === 1 ? oldRow : newerRow;
    });
    dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner
      .mockResolvedValueOnce({
        staleDeletedCount: 0,
        keptBlobStillCurrentWinner: false,
      })
      .mockResolvedValue({
        staleDeletedCount: 0,
        keptBlobStillCurrentWinner: true,
      });

    const result = await service.deleteRepoLoginEnvVariable({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      key: "MISSING",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toEqual({
      changed: false,
      loginEnv: expect.objectContaining({
        id: "blob-newer",
        keyNames: ["A", "B"],
        updatedAt: 200,
      }),
    });
    expect(dbMocks.deleteStaleRepoEnvBlobsForRepoIfCurrentWinner).toHaveBeenCalledTimes(2);
    expect(dbMocks.deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale).not.toHaveBeenCalled();
    expect(dbMocks.updateRepoEnvBlobByIdIfUnchangedAndCleanupStale).not.toHaveBeenCalled();
  });

  it("bulk upserts multiple keys with usage notes and sensitive flag", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/service");
    dbMocks.getRepoEnvBlobForRepo.mockResolvedValue(null);
    dbMocks.insertRepoEnvBlobForRepo.mockImplementation(async (_db, params) => {
      dbMocks.getRepoEnvBlobForRepo.mockResolvedValue({
        ...makeRow(params.id, "API_KEY=sk\nDB_URL=pg", params.now),
        entry_meta_json: params.entryMetaJson,
      });
    });

    const result = await service.bulkUpsertRepoLoginEnvVariables({} as D1Database, {
      businessId: "biz-1",
      actorUserId: 1,
      repoOwner: "acme",
      repoName: "web",
      entries: [
        { key: "API_KEY", value: "sk", usageNote: "GitHub" },
        { key: "DB_URL", value: "pg", usageNote: null },
      ],
      sensitive: true,
      encryptionKey: "test-encryption-key",
    });

    expect(result.keyNames).toEqual(["API_KEY", "DB_URL"]);
    expect(result.entries).toEqual([
      { key: "API_KEY", usageNote: "GitHub", sensitive: true },
      { key: "DB_URL", usageNote: null, sensitive: true },
    ]);
    expect(dbMocks.insertRepoEnvBlobForRepo).toHaveBeenCalledOnce();
  });
});
