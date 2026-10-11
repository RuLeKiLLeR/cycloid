import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale,
  deletePersonalEnvBlobByIdIfVersion,
  deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale,
  deleteRepoEnvBlobByIdIfVersion,
  deleteStaleRepoEnvBlobsForRepoIfCurrentWinner,
  getPersonalEnvBlobForUser,
  getRepoEnvBlobForRepo,
  insertPersonalEnvBlob,
  insertRepoEnvBlobForRepo,
  updateRepoEnvBlobByIdIfUnchangedAndCleanupStale,
} from "../../apps/control-plane-worker/src/env-blobs/db";
import { REPO_LOGIN_ENV_BLOB_NAME } from "../../apps/control-plane-worker/src/env-blobs/login-env";
import { PERSONAL_SECRETS_BLOB_NAME } from "../../apps/control-plane-worker/src/env-blobs/personal-secrets";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.db.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid ?? 0) } };
  }

  async first<T>() {
    return (this.db.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.values) as T[] };
  }

  async executeBatch() {
    const normalized = this.query.trimStart().toUpperCase();
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      return this.all<Record<string, unknown>>();
    }
    const result = await this.run();
    return { results: [], meta: result.meta };
  }
}

class SqliteD1 {
  readonly db = new Database(":memory:");
  readonly batchCallSizes: number[] = [];

  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0004_auth_tables.sql"), "utf8"));
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0018_businesses.sql"), "utf8"));
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0069_env_blobs.sql"), "utf8"));
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0252_env_blob_entry_meta.sql"), "utf8"));

    this.db
      .prepare("INSERT INTO businesses (id, name, created_at, shared_sessions) VALUES (?, ?, ?, 0)")
      .run("biz-1", "Test", 1);
    this.db
      .prepare(
        "INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(1, 1001, "tester", "Tester", null, null, "biz-1", 1, 1);
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.batchCallSizes.push(statements.length);
    const results = [];
    for (const statement of statements) {
      results.push(await statement.executeBatch());
    }
    return results;
  }
}

let sqlite: SqliteD1;
let db: D1Database;

beforeEach(() => {
  sqlite = new SqliteD1();
  db = sqlite as unknown as D1Database;
});

// NOTE: SqliteD1.batch() runs statements in a plain loop with no transaction and no rollback.
// These tests therefore prove the WHERE-clause winner guards, not the batch atomicity/rollback
// the production fix relies on (that rests on real Cloudflare D1 batch semantics). The
// cross-request interleaving race is not unit-reproducible here.

function seedBlob(id: string, envText: string, keyNames: string[], updatedAt: number, repoName = "web") {
  return insertRepoEnvBlobForRepo(db, {
    id,
    ownerUserId: 1,
    businessId: "biz-1",
    name: REPO_LOGIN_ENV_BLOB_NAME,
    envText,
    encrypted: false,
    keyNamesJson: JSON.stringify(keyNames),
    entryMetaJson: "{}",
    repoOwner: "acme",
    repoName,
    now: updatedAt,
  });
}

function blobIds(): string[] {
  return (sqlite.db.prepare("SELECT id FROM env_blobs ORDER BY id").all() as { id: string }[]).map((r) => r.id);
}

function repoBindingIds(): string[] {
  return (
    sqlite.db.prepare("SELECT env_blob_id FROM env_blob_repos ORDER BY env_blob_id").all() as {
      env_blob_id: string;
    }[]
  ).map((r) => r.env_blob_id);
}

describe("repo runtime env DAO atomic update + cleanup", () => {
  it("updates the current row and cleans older duplicate blobs in both tables", async () => {
    await seedBlob("blob-old", "A=1", ["A"], 100);
    await seedBlob("blob-cur", "A=1", ["A"], 200);

    await expect(
      updateRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-cur",
        expectedUpdatedAt: 200,
        ownerUserId: 1,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        envText: "A=1\nB=2",
        encrypted: false,
        keyNamesJson: JSON.stringify(["A", "B"]),
        entryMetaJson: "{}",
        repoOwner: "acme",
        repoName: "web",
        now: 300,
      }),
    ).resolves.toBe(true);

    // Only the updated winner survives, and the cascade removed the stale repo binding too.
    expect(blobIds()).toEqual(["blob-cur"]);
    expect(repoBindingIds()).toEqual(["blob-cur"]);
    await expect(getRepoEnvBlobForRepo(db, "biz-1", REPO_LOGIN_ENV_BLOB_NAME, "acme", "web")).resolves.toMatchObject({
      id: "blob-cur",
      env_text: "A=1\nB=2",
      updated_at: 300,
    });
  });

  it("does not update or clean when expectedUpdatedAt is stale", async () => {
    await seedBlob("blob-cur", "A=1", ["A"], 200);

    await expect(
      updateRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-cur",
        expectedUpdatedAt: 199,
        ownerUserId: 1,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        envText: "A=1\nB=2",
        encrypted: false,
        keyNamesJson: JSON.stringify(["A", "B"]),
        entryMetaJson: "{}",
        repoOwner: "acme",
        repoName: "web",
        now: 300,
      }),
    ).resolves.toBe(false);

    await expect(getRepoEnvBlobForRepo(db, "biz-1", REPO_LOGIN_ENV_BLOB_NAME, "acme", "web")).resolves.toMatchObject({
      id: "blob-cur",
      env_text: "A=1",
      updated_at: 200,
    });
  });

  it("refuses the update and cleans nothing when a newer blob already won the repo", async () => {
    await seedBlob("blob-cur", "A=1", ["A"], 200);
    await seedBlob("blob-newer", "X=9", ["X"], 300);

    await expect(
      updateRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-cur",
        expectedUpdatedAt: 200,
        ownerUserId: 1,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        envText: "A=1\nB=2",
        encrypted: false,
        keyNamesJson: JSON.stringify(["A", "B"]),
        entryMetaJson: "{}",
        repoOwner: "acme",
        repoName: "web",
        now: 400,
      }),
    ).resolves.toBe(false);

    // The newer concurrent blob and the stale one both survive untouched.
    expect(blobIds()).toEqual(["blob-cur", "blob-newer"]);
  });

  it("treats a same-updated_at duplicate with a higher id as newer and refuses the update", async () => {
    await seedBlob("blob-aaa", "A=1", ["A"], 200);
    await seedBlob("blob-zzz", "X=9", ["X"], 200); // same updated_at, higher id => read winner

    await expect(
      updateRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-aaa",
        expectedUpdatedAt: 200,
        ownerUserId: 1,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        envText: "A=1\nB=2",
        encrypted: false,
        keyNamesJson: JSON.stringify(["A", "B"]),
        entryMetaJson: "{}",
        repoOwner: "acme",
        repoName: "web",
        now: 300,
      }),
    ).resolves.toBe(false);

    expect(blobIds()).toEqual(["blob-aaa", "blob-zzz"]);
  });
});

describe("repo runtime env DAO atomic delete + cleanup", () => {
  it("deletes the expected current blob plus stale duplicates across both tables", async () => {
    await seedBlob("blob-old", "A=1", ["A"], 100);
    await seedBlob("blob-cur", "A=1\nB=2", ["A", "B"], 200);

    await expect(
      deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-cur",
        expectedUpdatedAt: 200,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: "acme",
        repoName: "web",
      }),
    ).resolves.toBe(true);

    expect(blobIds()).toEqual([]);
    expect(repoBindingIds()).toEqual([]);
    await expect(getRepoEnvBlobForRepo(db, "biz-1", REPO_LOGIN_ENV_BLOB_NAME, "acme", "web")).resolves.toBeNull();
  });

  it("returns false and preserves a concurrently inserted newer blob (the ARC-969 race)", async () => {
    await seedBlob("blob-cur", "A=1", ["A"], 200);
    await seedBlob("blob-newer", "C=3", ["C"], 300); // concurrent writer's fresh blob

    await expect(
      deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-cur",
        expectedUpdatedAt: 200,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: "acme",
        repoName: "web",
      }),
    ).resolves.toBe(false);

    // The newer blob must survive; nothing is deleted.
    expect(blobIds()).toEqual(["blob-cur", "blob-newer"]);
    await expect(getRepoEnvBlobForRepo(db, "biz-1", REPO_LOGIN_ENV_BLOB_NAME, "acme", "web")).resolves.toMatchObject({
      id: "blob-newer",
    });
  });

  it("returns false when expectedUpdatedAt is stale", async () => {
    await seedBlob("blob-cur", "A=1", ["A"], 200);

    await expect(
      deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "blob-cur",
        expectedUpdatedAt: 199,
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: "acme",
        repoName: "web",
      }),
    ).resolves.toBe(false);

    expect(blobIds()).toEqual(["blob-cur"]);
  });
});

describe("repo runtime env DAO version-guarded create-loser delete", () => {
  it("deletes the just-inserted blob and cascades its repo binding while leaving a newer blob", async () => {
    await seedBlob("blob-loser", "A=1", ["A"], 100);
    await seedBlob("blob-newer", "B=2", ["B"], 200);

    await expect(
      deleteRepoEnvBlobByIdIfVersion(db, {
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        id: "blob-loser",
        expectedUpdatedAt: 100,
      }),
    ).resolves.toBe(true);

    // Only the loser is removed; its env_blob_repos binding cascades; the newer blob survives.
    expect(blobIds()).toEqual(["blob-newer"]);
    expect(repoBindingIds()).toEqual(["blob-newer"]);
  });

  it("no-ops and preserves the blob when it was adopted (updated_at changed) since insert", async () => {
    // The blob we inserted at 100 has since been adopted/updated in place to 200 by another writer.
    await seedBlob("blob-loser", "A=1", ["A"], 200);

    await expect(
      deleteRepoEnvBlobByIdIfVersion(db, {
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        id: "blob-loser",
        expectedUpdatedAt: 100,
      }),
    ).resolves.toBe(false);

    expect(blobIds()).toEqual(["blob-loser"]);
    expect(repoBindingIds()).toEqual(["blob-loser"]);
  });
});

function seedPersonalBlob(id: string, envText: string, keyNames: string[], updatedAt: number) {
  return insertPersonalEnvBlob(db, {
    id,
    ownerUserId: 1,
    name: PERSONAL_SECRETS_BLOB_NAME,
    envText,
    encrypted: false,
    keyNamesJson: JSON.stringify(keyNames),
    entryMetaJson: "{}",
    now: updatedAt,
  });
}

describe("personal secrets DAO version-guarded create-loser delete", () => {
  it("deletes the just-inserted personal blob while leaving a newer blob", async () => {
    await seedPersonalBlob("p-loser", "A=1", ["A"], 100);
    await seedPersonalBlob("p-newer", "B=2", ["B"], 200);

    await expect(
      deletePersonalEnvBlobByIdIfVersion(db, {
        ownerUserId: 1,
        name: PERSONAL_SECRETS_BLOB_NAME,
        id: "p-loser",
        expectedUpdatedAt: 100,
      }),
    ).resolves.toBe(true);

    expect(blobIds()).toEqual(["p-newer"]);
  });

  it("no-ops and preserves the personal blob when it was adopted since insert", async () => {
    await seedPersonalBlob("p-loser", "A=1", ["A"], 200);

    await expect(
      deletePersonalEnvBlobByIdIfVersion(db, {
        ownerUserId: 1,
        name: PERSONAL_SECRETS_BLOB_NAME,
        id: "p-loser",
        expectedUpdatedAt: 100,
      }),
    ).resolves.toBe(false);

    expect(blobIds()).toEqual(["p-loser"]);
  });
});

describe("personal secrets DAO atomic delete + cleanup", () => {
  it("deletes the winning personal blob plus stale duplicates so nothing can resurrect", async () => {
    await seedPersonalBlob("p-old", "ONLY=1", ["ONLY"], 100);
    await seedPersonalBlob("p-cur", "ONLY=1", ["ONLY"], 200);

    await expect(
      deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: "p-cur",
        expectedUpdatedAt: 200,
        ownerUserId: 1,
        name: PERSONAL_SECRETS_BLOB_NAME,
      }),
    ).resolves.toBe(true);

    expect(blobIds()).toEqual([]);
    await expect(getPersonalEnvBlobForUser(db, 1, PERSONAL_SECRETS_BLOB_NAME)).resolves.toBeNull();
  });
});

describe("repo runtime env DAO winner-guarded standalone cleanup", () => {
  it("deletes other duplicates only while keepId is still the current winner", async () => {
    await seedBlob("blob-old", "A=1", ["A"], 100);
    await seedBlob("blob-cur", "A=1", ["A"], 200);

    await expect(
      deleteStaleRepoEnvBlobsForRepoIfCurrentWinner(db, {
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: "acme",
        repoName: "web",
        keepId: "blob-cur",
        expectedUpdatedAt: 200,
      }),
    ).resolves.toEqual({
      staleDeletedCount: 1,
      keptBlobStillCurrentWinner: true,
    });

    expect(blobIds()).toEqual(["blob-cur"]);
    expect(repoBindingIds()).toEqual(["blob-cur"]);
    expect(sqlite.batchCallSizes[sqlite.batchCallSizes.length - 1]).toBe(2);
  });

  it("distinguishes a current winner with no stale duplicates from a lost winner race", async () => {
    await seedBlob("blob-cur", "A=1", ["A"], 200);

    await expect(
      deleteStaleRepoEnvBlobsForRepoIfCurrentWinner(db, {
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: "acme",
        repoName: "web",
        keepId: "blob-cur",
        expectedUpdatedAt: 200,
      }),
    ).resolves.toEqual({
      staleDeletedCount: 0,
      keptBlobStillCurrentWinner: true,
    });

    expect(blobIds()).toEqual(["blob-cur"]);
    expect(repoBindingIds()).toEqual(["blob-cur"]);
  });

  it("deletes nothing and preserves a newer concurrent blob when keepId is no longer the winner", async () => {
    // Simulates the idempotent-upsert / missing-key-delete / create no-op race: we resolved
    // blob-old as the winner, then a concurrent writer inserted blob-newer before cleanup.
    await seedBlob("blob-old", "A=1", ["A"], 100);
    await seedBlob("blob-newer", "B=2", ["B"], 200);

    await expect(
      deleteStaleRepoEnvBlobsForRepoIfCurrentWinner(db, {
        businessId: "biz-1",
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: "acme",
        repoName: "web",
        keepId: "blob-old",
        expectedUpdatedAt: 100,
      }),
    ).resolves.toEqual({
      staleDeletedCount: 0,
      keptBlobStillCurrentWinner: false,
    });

    // The concurrent newer blob is NOT deleted by the stale-cleanup.
    expect(blobIds()).toEqual(["blob-newer", "blob-old"]);
  });
});
