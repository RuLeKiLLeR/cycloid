import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERSONAL_SECRETS_BLOB_NAME } from "../../apps/control-plane-worker/src/env-blobs/personal-secrets";

const dbMocks = vi.hoisted(() => ({
  deletePersonalEnvBlobByIdIfVersion: vi.fn(),
  deletePersonalEnvBlobByIdIfUnchanged: vi.fn(),
  deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale: vi.fn(),
  deleteStalePersonalEnvBlobsIfCurrentWinner: vi.fn(),
  getPersonalEnvBlobForUser: vi.fn(),
  insertPersonalEnvBlob: vi.fn(),
  updatePersonalEnvBlobByIdIfUnchanged: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/env-blobs/db", () => dbMocks);

function makePersonalRow(id: string, envText: string, updatedAt: number, entryMetaJson = "{}") {
  return {
    id,
    owner_user_id: 7,
    business_id: null,
    name: PERSONAL_SECRETS_BLOB_NAME,
    env_text: envText,
    encrypted: 0,
    key_names_json: JSON.stringify(
      envText
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(0, line.indexOf("=")))
        .sort(),
    ),
    entry_meta_json: entryMetaJson,
    is_global: 1,
    created_at: 100,
    updated_at: updatedAt,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  dbMocks.deletePersonalEnvBlobByIdIfVersion.mockResolvedValue(true);
  dbMocks.deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale.mockResolvedValue(true);
  dbMocks.deleteStalePersonalEnvBlobsIfCurrentWinner.mockResolvedValue({
    staleDeletedCount: 0,
    keptBlobStillCurrentWinner: true,
  });
  dbMocks.insertPersonalEnvBlob.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("personal secrets service", () => {
  it("creates a personal secrets blob on first upsert", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/personal-secrets");
    dbMocks.getPersonalEnvBlobForUser.mockResolvedValueOnce(null).mockImplementation(async (_db, _uid, _name) => {
      // After insert, service re-reads the winning row.
      return makePersonalRow(
        "personal-1",
        "MY_TOKEN=abc",
        Date.now(),
        JSON.stringify({ MY_TOKEN: { usageNote: "cli", sensitive: true } }),
      );
    });
    dbMocks.insertPersonalEnvBlob.mockImplementation(async (_db, params) => {
      dbMocks.getPersonalEnvBlobForUser.mockResolvedValue(
        makePersonalRow(params.id, "MY_TOKEN=abc", params.now, params.entryMetaJson),
      );
    });

    const result = await service.upsertPersonalSecret({} as D1Database, {
      ownerUserId: 7,
      key: "MY_TOKEN",
      value: "abc",
      usageNote: "cli",
      sensitive: true,
      encryptionKey: "test-encryption-key",
    });

    expect(result.keyNames).toEqual(["MY_TOKEN"]);
    expect(result.entries[0]).toMatchObject({ key: "MY_TOKEN", usageNote: "cli", sensitive: true });
    expect(dbMocks.insertPersonalEnvBlob).toHaveBeenCalledOnce();
  });

  it("bulk imports personal secrets", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/personal-secrets");
    dbMocks.getPersonalEnvBlobForUser.mockResolvedValue(null);
    dbMocks.insertPersonalEnvBlob.mockImplementation(async (_db, params) => {
      dbMocks.getPersonalEnvBlobForUser.mockResolvedValue(
        makePersonalRow(params.id, "A=1\nB=2", params.now, params.entryMetaJson),
      );
    });

    const result = await service.bulkUpsertPersonalSecrets({} as D1Database, {
      ownerUserId: 7,
      entries: [
        { key: "A", value: "1", usageNote: "one" },
        { key: "B", value: "2", usageNote: null },
      ],
      sensitive: false,
      encryptionKey: "test-encryption-key",
    });

    expect(result.keyNames).toEqual(["A", "B"]);
    expect(result.entries).toEqual([
      { key: "A", usageNote: "one", sensitive: false },
      { key: "B", usageNote: null, sensitive: false },
    ]);
  });

  it("retries a create when another writer wins the initial insert race", async () => {
    // Post-insert not-winner path (`!current || current.id !== id`): the blob we just inserted is
    // not the current winner, so it must be deleted (version-guarded) and the create retried.
    const service = await import("../../apps/control-plane-worker/src/env-blobs/personal-secrets");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "personal-created" as `${string}-${string}-${string}-${string}-${string}`,
    );
    const winnerRow = makePersonalRow("personal-other", "B=2", 200);
    let readCount = 0;

    dbMocks.getPersonalEnvBlobForUser.mockImplementation(async () => {
      readCount += 1;
      if (readCount === 1) return null; // initial resolve: no existing blob -> create path
      return winnerRow; // post-insert read (a different writer won) and the retry resolve
    });
    dbMocks.updatePersonalEnvBlobByIdIfUnchanged.mockResolvedValue(true);

    const result = await service.upsertPersonalSecret({} as D1Database, {
      ownerUserId: 7,
      key: "A",
      value: "1",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toMatchObject({ id: "personal-other", keyNames: ["A", "B"] });
    expect(dbMocks.insertPersonalEnvBlob).toHaveBeenCalledTimes(1);
    // The just-inserted loser is deleted version-guarded on its own insert stamp; the stale-cleanup
    // is never reached because we never became the winner.
    expect(dbMocks.deleteStalePersonalEnvBlobsIfCurrentWinner).not.toHaveBeenCalled();
    expect(dbMocks.deletePersonalEnvBlobByIdIfVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "personal-created", expectedUpdatedAt: expect.any(Number) }),
    );
  });

  it("deletes the create-loser blob and retries when cleanup finds it lost the winner race", async () => {
    // Regression (ARC-1548): on keptBlobStillCurrentWinner=false the just-inserted blob must be
    // deleted (version-guarded) instead of leaking as a permanent orphan; the create then retries.
    const service = await import("../../apps/control-plane-worker/src/env-blobs/personal-secrets");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "personal-created" as `${string}-${string}-${string}-${string}-${string}`,
    );
    const insertedRow = makePersonalRow("personal-created", "A=1", 100);
    const winnerRow = makePersonalRow("personal-winner", "B=2", 200);
    let readCount = 0;

    dbMocks.getPersonalEnvBlobForUser.mockImplementation(async () => {
      readCount += 1;
      if (readCount === 1) return null; // initial resolve: no existing blob -> create path
      return readCount === 2 ? insertedRow : winnerRow; // post-insert read, then the retry winner
    });
    dbMocks.deleteStalePersonalEnvBlobsIfCurrentWinner.mockResolvedValueOnce({
      staleDeletedCount: 0,
      keptBlobStillCurrentWinner: false,
    });
    dbMocks.updatePersonalEnvBlobByIdIfUnchanged.mockResolvedValue(true);

    const result = await service.upsertPersonalSecret({} as D1Database, {
      ownerUserId: 7,
      key: "A",
      value: "1",
      encryptionKey: "test-encryption-key",
    });

    expect(result).toMatchObject({ id: "personal-winner", keyNames: ["A", "B"] });
    expect(dbMocks.insertPersonalEnvBlob).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteStalePersonalEnvBlobsIfCurrentWinner).toHaveBeenCalledTimes(1);
    expect(dbMocks.updatePersonalEnvBlobByIdIfUnchanged).toHaveBeenCalledTimes(1);
    expect(dbMocks.deletePersonalEnvBlobByIdIfVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "personal-created", expectedUpdatedAt: expect.any(Number) }),
    );
  });

  it("rejects empty values", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/personal-secrets");
    await expect(
      service.upsertPersonalSecret({} as D1Database, {
        ownerUserId: 7,
        key: "A",
        value: " ",
        encryptionKey: undefined,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbMocks.getPersonalEnvBlobForUser).not.toHaveBeenCalled();
  });

  it("deletes the last secret via the cleanup-capable personal delete path", async () => {
    const service = await import("../../apps/control-plane-worker/src/env-blobs/personal-secrets");
    dbMocks.getPersonalEnvBlobForUser.mockResolvedValue(makePersonalRow("personal-1", "ONLY=1", 200));

    await expect(
      service.deletePersonalSecret({} as D1Database, {
        ownerUserId: 7,
        key: "ONLY",
        encryptionKey: undefined,
      }),
    ).resolves.toEqual({ secrets: null, changed: true });

    expect(dbMocks.deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "personal-1",
        expectedUpdatedAt: 200,
        ownerUserId: 7,
        name: PERSONAL_SECRETS_BLOB_NAME,
      }),
    );
    expect(dbMocks.deletePersonalEnvBlobByIdIfUnchanged).not.toHaveBeenCalled();
  });
});
