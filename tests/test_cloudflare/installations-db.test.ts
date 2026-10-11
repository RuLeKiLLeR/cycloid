import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal D1 fake that tracks github_installations rows in memory
class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeInstallationsD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true }> {
    if (this.query.includes("INSERT INTO github_installations")) {
      const [installationId, ownerLogin, ownerId, ownerType, repositorySelection, permissionsJson, eventsJson] = this
        .boundValues as [number, string, number, string, string | null, string | null, string | null];
      const existing = this.db.rows.get(installationId);
      if (existing) {
        existing.owner_login = ownerLogin;
        existing.owner_id = ownerId;
        existing.owner_type = ownerType;
        existing.repository_selection = repositorySelection;
        existing.permissions_json = permissionsJson;
        existing.events_json = eventsJson;
        if (this.query.includes("suspended_at = NULL")) {
          existing.suspended_at = null;
        }
      } else {
        this.db.rows.set(installationId, {
          installation_id: installationId,
          owner_login: ownerLogin,
          owner_id: ownerId,
          owner_type: ownerType,
          repository_selection: repositorySelection,
          permissions_json: permissionsJson,
          events_json: eventsJson,
          created_at: Date.now(),
          suspended_at: null,
        });
      }
      return { success: true };
    }

    if (this.query.includes("DELETE FROM github_installations")) {
      const [installationId] = this.boundValues as [number];
      this.db.rows.delete(installationId);
      return { success: true };
    }

    if (this.query.includes("UPDATE github_installations") && this.query.includes("permissions_json = ?")) {
      const [ownerLogin, ownerId, ownerType, repositorySelection, permissionsJson, eventsJson, installationId] = this
        .boundValues as [string, number, string, string | null, string | null, string | null, number];
      const row = this.db.rows.get(installationId);
      if (row) {
        row.owner_login = ownerLogin;
        row.owner_id = ownerId;
        row.owner_type = ownerType;
        row.repository_selection = repositorySelection;
        row.permissions_json = permissionsJson;
        row.events_json = eventsJson;
      }
      return { success: true };
    }

    if (this.query.includes("INSERT INTO github_installation_repositories_cache")) {
      const [userId, installationId, repositoriesJson, fetchedAt, expiresAt] = this.boundValues as [
        string,
        number,
        string,
        number,
        number,
      ];
      this.db.repoCache.set(`${userId}:${installationId}`, {
        user_id: userId,
        installation_id: installationId,
        repositories_json: repositoriesJson,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
      });
      return { success: true };
    }

    if (this.query.includes("DELETE FROM github_installation_repositories_cache")) {
      if (this.query.includes("WHERE user_id = ?")) {
        const [userId] = this.boundValues as [string];
        for (const [cacheKey, row] of this.db.repoCache.entries()) {
          if (row.user_id === userId) this.db.repoCache.delete(cacheKey);
        }
        return { success: true };
      }
      const [installationId] = this.boundValues as [number];
      for (const [cacheKey, row] of this.db.repoCache.entries()) {
        if (row.installation_id === installationId) {
          this.db.repoCache.delete(cacheKey);
        }
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE github_installations SET suspended_at = NULL")) {
      const [installationId] = this.boundValues as [number];
      const row = this.db.rows.get(installationId);
      if (row) row.suspended_at = null;
      return { success: true };
    }

    if (this.query.includes("UPDATE github_installations SET suspended_at = ?")) {
      const [suspendedAt, installationId] = this.boundValues as [number, number];
      const row = this.db.rows.get(installationId);
      if (row) row.suspended_at = suspendedAt;
      return { success: true };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("WHERE owner_login = ?") && this.query.includes("installation_id != ?")) {
      const [ownerLogin, installationId] = this.boundValues as [string, number];
      for (const row of this.db.rows.values()) {
        if (row.owner_login.toLowerCase() === ownerLogin.toLowerCase() && row.installation_id !== installationId) {
          return row as T;
        }
      }
      return null;
    }

    if (this.query.includes("WHERE owner_login = ?")) {
      const [ownerLogin] = this.boundValues as [string];
      for (const row of this.db.rows.values()) {
        if (row.owner_login.toLowerCase() === ownerLogin.toLowerCase()) return row as T;
      }
      return null;
    }

    if (this.query.includes("WHERE installation_id = ?")) {
      const [installationId] = this.boundValues as [number];
      return (this.db.rows.get(installationId) as T) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (
      this.query.includes("FROM github_installations") &&
      this.query.includes("WHERE owner_login = ?") &&
      this.query.includes("LIMIT 2")
    ) {
      const [ownerLogin] = this.boundValues as [string];
      const results = Array.from(this.db.rows.values())
        .filter((row) => row.owner_login.toLowerCase() === ownerLogin.toLowerCase())
        .slice(0, 2);
      return { results: results as T[] };
    }

    if (this.query.includes("FROM github_installations") && this.query.includes("owner_id IN")) {
      const ownerIds = this.boundValues as number[];
      const idSet = new Set(ownerIds);
      const results = Array.from(this.db.rows.values()).filter(
        (row) => row.suspended_at === null && idSet.has(row.owner_id),
      );
      return { results: results as T[] };
    }

    if (this.query.includes("FROM github_installations") && this.query.includes("suspended_at IS NULL")) {
      const logins = this.boundValues as string[];
      const results = Array.from(this.db.rows.values()).filter(
        (row) => row.suspended_at === null && logins.some((l) => l.toLowerCase() === row.owner_login.toLowerCase()),
      );
      return { results: results as T[] };
    }

    if (this.query.includes("FROM github_installations") && this.query.includes("owner_login COLLATE NOCASE IN")) {
      const logins = this.boundValues as string[];
      const results = Array.from(this.db.rows.values()).filter((row) =>
        logins.some((l) => l.toLowerCase() === row.owner_login.toLowerCase()),
      );
      return { results: results as T[] };
    }

    if (this.query.includes("FROM github_installation_repositories_cache")) {
      const [userId, nowMs, ...installationIds] = this.boundValues as [string, number, ...number[]];
      const idSet = new Set(installationIds);
      const results = Array.from(this.db.repoCache.values()).filter(
        (row) => row.user_id === userId && row.expires_at > nowMs && idSet.has(row.installation_id),
      );
      return { results: results as T[] };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }
}

class FakeInstallationsD1 {
  readonly rows = new Map<
    number,
    {
      installation_id: number;
      owner_login: string;
      owner_id: number;
      owner_type: string;
      repository_selection: string | null;
      permissions_json: string | null;
      events_json: string | null;
      created_at: number;
      suspended_at: number | null;
    }
  >();
  readonly repoCache = new Map<
    string,
    { user_id: string; installation_id: number; repositories_json: string; fetched_at: number; expires_at: number }
  >();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]): Promise<Array<{ success: true }>> {
    const results: Array<{ success: true }> = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

type InstallationsDbModule = {
  isInstallationOwnerUniqueConstraintError: (error: unknown) => boolean;
  upsertInstallation: (
    db: unknown,
    params: {
      installationId: number;
      ownerLogin: string;
      ownerId: number;
      ownerType: string;
      repositorySelection?: string | null;
      permissions?: Record<string, string> | null;
      events?: string[] | null;
    },
  ) => Promise<void>;
  replaceConflictingInstallation: (
    db: unknown,
    conflictingInstallationId: number,
    params: {
      installationId: number;
      ownerLogin: string;
      ownerId: number;
      ownerType: string;
      repositorySelection?: string | null;
      permissions?: Record<string, string> | null;
      events?: string[] | null;
    },
  ) => Promise<void>;
  updateInstallationPermissions: (
    db: unknown,
    params: {
      installationId: number;
      ownerLogin: string;
      ownerId: number;
      ownerType: string;
      repositorySelection?: string | null;
      permissions?: Record<string, string> | null;
      events?: string[] | null;
    },
  ) => Promise<void>;
  getConflictingInstallationByOwner: (
    db: unknown,
    ownerLogin: string,
    installationId: number,
  ) => Promise<{
    installation_id: number;
    owner_login: string;
    owner_id: number;
    owner_type: string;
    repository_selection: string | null;
    permissions_json: string | null;
    events_json: string | null;
    created_at: number;
    suspended_at: number | null;
  } | null>;
  deleteInstallation: (db: unknown, installationId: number) => Promise<void>;
  suspendInstallation: (db: unknown, installationId: number, suspendedAt: number) => Promise<void>;
  unsuspendInstallation: (db: unknown, installationId: number) => Promise<void>;
  getInstallationByOwner: (
    db: unknown,
    ownerLogin: string,
  ) => Promise<{
    installation_id: number;
    owner_login: string;
    owner_id: number;
    owner_type: string;
    repository_selection: string | null;
    permissions_json: string | null;
    events_json: string | null;
    created_at: number;
    suspended_at: number | null;
  } | null>;
  getInstallationsByOwners: (
    db: unknown,
    ownerLogins: string[],
  ) => Promise<
    Map<
      string,
      {
        installation_id: number;
        owner_login: string;
        owner_id: number;
        owner_type: string;
        repository_selection: string | null;
        permissions_json: string | null;
        events_json: string | null;
        created_at: number;
        suspended_at: number | null;
      }
    >
  >;
  getActiveInstallationsForOwners: (
    db: unknown,
    ownerLogins: string[],
  ) => Promise<
    {
      installation_id: number;
      owner_login: string;
      owner_id: number;
      owner_type: string;
      repository_selection: string | null;
      permissions_json: string | null;
      events_json: string | null;
      created_at: number;
      suspended_at: number | null;
    }[]
  >;
  getCachedInstallationReposForInstallations: (
    db: unknown,
    userId: string,
    installationIds: number[],
    nowMs: number,
  ) => Promise<Map<number, Set<string>>>;
  cacheInstallationRepos: (
    db: unknown,
    userId: string,
    entries: Array<{ installationId: number; repos: Iterable<string> }>,
    nowMs: number,
    ttlMs: number,
  ) => Promise<void>;
  deleteCachedInstallationRepos: (db: unknown, installationId: number) => Promise<void>;
  deleteCachedInstallationReposForUser: (db: unknown, userId: string) => Promise<void>;
  resetInstallationByOwnerCacheForTests: () => void;
  getInstallationsByOwnerIds: (
    db: unknown,
    ownerIds: number[],
  ) => Promise<
    {
      installation_id: number;
      owner_login: string;
      owner_id: number;
      owner_type: string;
      repository_selection: string | null;
      permissions_json: string | null;
      events_json: string | null;
      created_at: number;
      suspended_at: number | null;
    }[]
  >;
};

let mod: InstallationsDbModule;

describe("installations-db", () => {
  let fakeDb: FakeInstallationsD1;

  beforeEach(async () => {
    fakeDb = new FakeInstallationsD1();
    const path: string = "../../apps/control-plane-worker/src/github/installations-db";
    mod = (await import(path)) as unknown as InstallationsDbModule;
    // The read-through cache is module-level state; isolate tests from each other.
    mod.resetInstallationByOwnerCacheForTests();
  });

  describe("upsertInstallation", () => {
    it("inserts a new installation", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).not.toBeNull();
      expect(row!.owner_login).toBe("acme-corp");
      expect(row!.owner_id).toBe(100);
      expect(row!.owner_type).toBe("Organization");
      expect(row!.repository_selection).toBe("all");
    });

    it("upserts an existing installation", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
      });

      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp-renamed",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "selected",
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp-renamed");
      expect(row!.owner_login).toBe("acme-corp-renamed");
      expect(row!.repository_selection).toBe("selected");
    });

    it("stores installation permissions and subscribed events", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
        permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        events: ["pull_request", "pull_request_review"],
      });

      const row = (await mod.getInstallationByOwner(fakeDb, "acme-corp")) as unknown as {
        permissions_json: string | null;
        events_json: string | null;
      };
      expect(JSON.parse(row.permissions_json ?? "{}")).toEqual({
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      });
      expect(JSON.parse(row.events_json ?? "[]")).toEqual(["pull_request", "pull_request_review"]);
    });

    it("clears suspended_at on upsert", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });
      await mod.suspendInstallation(fakeDb, 12345, Date.now());

      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row!.suspended_at).toBeNull();
    });
  });

  describe("updateInstallationPermissions", () => {
    it("updates permissions and events without clearing suspended_at", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
        permissions: { contents: "read", metadata: "read", pull_requests: "read" },
        events: ["pull_request"],
      });
      await mod.suspendInstallation(fakeDb, 12345, 123456789);

      await mod.updateInstallationPermissions(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
        permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        events: ["pull_request", "pull_request_review"],
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row!.suspended_at).toBe(123456789);
      expect(JSON.parse(row!.permissions_json ?? "{}")).toEqual({
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      });
      expect(JSON.parse(row!.events_json ?? "[]")).toEqual(["pull_request", "pull_request_review"]);
    });

    it("does not recreate a missing installation", async () => {
      await mod.updateInstallationPermissions(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
        permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        events: ["pull_request", "pull_request_review"],
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).toBeNull();
    });
  });

  describe("isInstallationOwnerUniqueConstraintError", () => {
    it("matches owner_login unique constraint failures", () => {
      expect(
        mod.isInstallationOwnerUniqueConstraintError(
          new Error("D1_ERROR: UNIQUE constraint failed: github_installations.owner_login"),
        ),
      ).toBe(true);
    });

    it("ignores unrelated unique constraint failures", () => {
      expect(
        mod.isInstallationOwnerUniqueConstraintError(
          new Error("D1_ERROR: UNIQUE constraint failed: github_installations.installation_id"),
        ),
      ).toBe(false);
    });
  });

  describe("deleteInstallation", () => {
    it("deletes an existing installation", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      await mod.deleteInstallation(fakeDb, 12345);

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).toBeNull();
    });

    it("is a no-op for non-existent installation", async () => {
      await mod.deleteInstallation(fakeDb, 99999);
      expect(fakeDb.rows.size).toBe(0);
    });
  });

  describe("replaceConflictingInstallation", () => {
    it("replaces a stale owner row in one batched write", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
      });

      await mod.replaceConflictingInstallation(fakeDb, 12345, {
        installationId: 67890,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "write", metadata: "read" },
        events: ["push"],
      });

      expect(await mod.getConflictingInstallationByOwner(fakeDb, "acme-corp", 67890)).toBeNull();
      const oldRow = await fakeDb
        .prepare("SELECT * FROM github_installations WHERE installation_id = ?")
        .bind(12345)
        .first();
      expect(oldRow).toBeNull();
      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).toMatchObject({
        installation_id: 67890,
        owner_login: "acme-corp",
        repository_selection: "selected",
      });
      expect(JSON.parse(row!.permissions_json ?? "{}")).toEqual({ contents: "write", metadata: "read" });
      expect(JSON.parse(row!.events_json ?? "[]")).toEqual(["push"]);
    });
  });

  describe("suspendInstallation / unsuspendInstallation", () => {
    it("sets suspended_at", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const now = Date.now();
      await mod.suspendInstallation(fakeDb, 12345, now);

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row!.suspended_at).toBe(now);
    });

    it("clears suspended_at", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });
      await mod.suspendInstallation(fakeDb, 12345, Date.now());
      await mod.unsuspendInstallation(fakeDb, 12345);

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row!.suspended_at).toBeNull();
    });
  });

  describe("getInstallationByOwner", () => {
    it("returns installation for known owner", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).not.toBeNull();
      expect(row!.installation_id).toBe(12345);
    });

    it("returns null for unknown owner", async () => {
      const row = await mod.getInstallationByOwner(fakeDb, "unknown-org");
      expect(row).toBeNull();
    });

    it("returns suspended installation (still exists, just suspended)", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });
      await mod.suspendInstallation(fakeDb, 12345, Date.now());

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).not.toBeNull();
      expect(row!.suspended_at).not.toBeNull();
    });

    it("matches owner login case-insensitively", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "Acme-Corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(row).not.toBeNull();
      expect(row!.installation_id).toBe(12345);
    });
  });

  describe("getInstallationByOwner in-memory cache", () => {
    beforeEach(async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });
    });

    it("serves repeat reads from cache without hitting D1", async () => {
      await mod.getInstallationByOwner(fakeDb, "acme-corp");
      const prepareSpy = vi.spyOn(fakeDb, "prepare");
      const row = await mod.getInstallationByOwner(fakeDb, "Acme-Corp"); // case-folded key
      expect(row!.installation_id).toBe(12345);
      expect(prepareSpy).not.toHaveBeenCalled();
      prepareSpy.mockRestore();
    });

    it("caches null for unknown owners", async () => {
      await mod.getInstallationByOwner(fakeDb, "unknown-org");
      const prepareSpy = vi.spyOn(fakeDb, "prepare");
      expect(await mod.getInstallationByOwner(fakeDb, "unknown-org")).toBeNull();
      expect(prepareSpy).not.toHaveBeenCalled();
      prepareSpy.mockRestore();
    });

    it("expires entries after the TTL", async () => {
      vi.useFakeTimers();
      try {
        await mod.getInstallationByOwner(fakeDb, "acme-corp");
        vi.advanceTimersByTime(60 * 60 * 1000 + 1);
        const prepareSpy = vi.spyOn(fakeDb, "prepare");
        await mod.getInstallationByOwner(fakeDb, "acme-corp");
        expect(prepareSpy).toHaveBeenCalled();
        prepareSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cannot preserve access after a suspend webhook mutation", async () => {
      const before = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(before!.suspended_at).toBeNull();

      await mod.suspendInstallation(fakeDb, 12345, 999);
      const after = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(after!.suspended_at).toBe(999);
    });

    it("cannot preserve access after an uninstall webhook mutation", async () => {
      expect(await mod.getInstallationByOwner(fakeDb, "acme-corp")).not.toBeNull();
      await mod.deleteInstallation(fakeDb, 12345);
      expect(await mod.getInstallationByOwner(fakeDb, "acme-corp")).toBeNull();
    });

    it("invalidates on unsuspend and permission updates", async () => {
      await mod.suspendInstallation(fakeDb, 12345, 999);
      expect((await mod.getInstallationByOwner(fakeDb, "acme-corp"))!.suspended_at).toBe(999);

      await mod.unsuspendInstallation(fakeDb, 12345);
      expect((await mod.getInstallationByOwner(fakeDb, "acme-corp"))!.suspended_at).toBeNull();

      await mod.updateInstallationPermissions(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
        permissions: { contents: "write" },
      });
      const row = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(JSON.parse(row!.permissions_json ?? "{}")).toEqual({ contents: "write" });
    });

    it("expires cached misses after the short miss TTL", async () => {
      vi.useFakeTimers();
      try {
        await mod.getInstallationByOwner(fakeDb, "unknown-org");
        vi.advanceTimersByTime(60 * 1000 + 1);
        const prepareSpy = vi.spyOn(fakeDb, "prepare");
        await mod.getInstallationByOwner(fakeDb, "unknown-org");
        expect(prepareSpy).toHaveBeenCalled();
        prepareSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not strip whitespace in the cache key (matches COLLATE NOCASE exactly)", async () => {
      await mod.getInstallationByOwner(fakeDb, "acme-corp");
      const prepareSpy = vi.spyOn(fakeDb, "prepare");
      await mod.getInstallationByOwner(fakeDb, " acme-corp ");
      expect(prepareSpy).toHaveBeenCalled();
      prepareSpy.mockRestore();
    });

    it("does not repopulate the cache from a read that was in flight during a mutation", async () => {
      // Seed the row, then start a read that resolves only after a mutation
      // has invalidated the cache.
      let resolveFirst!: (value: unknown) => void;
      const slowDb = {
        prepare() {
          return {
            bind() {
              return this;
            },
            first: () =>
              new Promise((resolve) => {
                resolveFirst = resolve;
              }),
          };
        },
      } as unknown as D1Database;

      const staleRow = { installation_id: 12345, owner_login: "acme-corp", suspended_at: null };
      const pending = mod.getInstallationByOwner(slowDb, "acme-corp");
      await mod.suspendInstallation(fakeDb, 12345, 999); // invalidates mid-read
      resolveFirst(staleRow);
      await pending;

      // The stale in-flight result must not have been cached: the next read
      // hits D1 and sees the suspended row.
      const after = await mod.getInstallationByOwner(fakeDb, "acme-corp");
      expect(after!.suspended_at).toBe(999);
    });

    it("negative-caches on DB errors to prevent retry storms", async () => {
      const brokenDb = {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              throw new Error("D1 unavailable");
            },
          };
        },
      };
      await expect(mod.getInstallationByOwner(brokenDb, "error-org")).rejects.toThrow("D1 unavailable");

      // Within the short error TTL, reads return null without retrying D1.
      const prepareSpy = vi.spyOn(brokenDb as { prepare: () => unknown }, "prepare");
      expect(await mod.getInstallationByOwner(brokenDb, "error-org")).toBeNull();
      expect(prepareSpy).not.toHaveBeenCalled();
      prepareSpy.mockRestore();
    });
  });

  describe("getConflictingInstallationByOwner", () => {
    it("returns an existing owner row with a different installation id", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const row = await mod.getConflictingInstallationByOwner(fakeDb, "acme-corp", 67890);
      expect(row).not.toBeNull();
      expect(row!.installation_id).toBe(12345);
    });

    it("returns null when the owner row matches the expected installation id", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const row = await mod.getConflictingInstallationByOwner(fakeDb, "acme-corp", 12345);
      expect(row).toBeNull();
    });

    it("matches conflicting owners case-insensitively", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "Acme-Corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const row = await mod.getConflictingInstallationByOwner(fakeDb, "acme-corp", 67890);
      expect(row).not.toBeNull();
      expect(row!.installation_id).toBe(12345);
    });
  });

  describe("getInstallationsByOwners", () => {
    it("returns installations keyed by normalized owner login including suspended rows", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 12345,
        ownerLogin: "Acme-Corp",
        ownerId: 100,
        ownerType: "Organization",
      });
      await mod.upsertInstallation(fakeDb, {
        installationId: 67890,
        ownerLogin: "Suspended-Corp",
        ownerId: 200,
        ownerType: "Organization",
      });
      await mod.suspendInstallation(fakeDb, 67890, 123);

      const rows = await mod.getInstallationsByOwners(fakeDb, ["acme-corp", "suspended-corp", "missing"]);

      expect(rows.get("acme-corp")?.installation_id).toBe(12345);
      expect(rows.get("suspended-corp")?.suspended_at).toBe(123);
      expect(rows.has("missing")).toBe(false);
    });

    it("chunks owner batches to stay under D1 bind limits", async () => {
      const prepareSpy = vi.spyOn(fakeDb, "prepare");

      const rows = await mod.getInstallationsByOwners(
        fakeDb,
        Array.from({ length: 101 }, (_, i) => `owner-${i}`),
      );

      expect(rows.size).toBe(0);
      expect(prepareSpy).toHaveBeenCalledTimes(2);
      expect(prepareSpy.mock.calls[0][0]).toContain(`${"?, ".repeat(99)}?`);
      expect(prepareSpy.mock.calls[1][0]).toContain("owner_login COLLATE NOCASE IN (?)");
      prepareSpy.mockRestore();
    });
  });

  describe("getActiveInstallationsForOwners", () => {
    it("returns active installations matching owner logins", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 1,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });
      await mod.upsertInstallation(fakeDb, {
        installationId: 2,
        ownerLogin: "other-org",
        ownerId: 200,
        ownerType: "Organization",
      });

      const results = await mod.getActiveInstallationsForOwners(fakeDb, ["acme-corp"]);
      expect(results).toHaveLength(1);
      expect(results[0].installation_id).toBe(1);
    });

    it("returns empty array for empty input", async () => {
      const results = await mod.getActiveInstallationsForOwners(fakeDb, []);
      expect(results).toHaveLength(0);
    });

    it("excludes suspended installations", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 1,
        ownerLogin: "acme-corp",
        ownerId: 100,
        ownerType: "Organization",
      });
      await mod.suspendInstallation(fakeDb, 1, Date.now());

      const results = await mod.getActiveInstallationsForOwners(fakeDb, ["acme-corp"]);
      expect(results).toHaveLength(0);
    });

    it("matches case-insensitively", async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 1,
        ownerLogin: "Acme-Corp",
        ownerId: 100,
        ownerType: "Organization",
      });

      const results = await mod.getActiveInstallationsForOwners(fakeDb, ["acme-corp"]);
      expect(results).toHaveLength(1);
      expect(results[0].owner_login).toBe("Acme-Corp");
    });

    it("chunks owner batches to stay under D1 bind limits", async () => {
      for (let i = 0; i < 101; i++) {
        await mod.upsertInstallation(fakeDb, {
          installationId: i + 1,
          ownerLogin: `owner-${i}`,
          ownerId: i,
          ownerType: "Organization",
        });
      }
      const prepareSpy = vi.spyOn(fakeDb, "prepare");

      const results = await mod.getActiveInstallationsForOwners(
        fakeDb,
        Array.from({ length: 101 }, (_, i) => `OWNER-${i}`),
      );

      expect(results).toHaveLength(101);
      expect(new Set(results.map((row) => row.installation_id)).size).toBe(101);
      expect(prepareSpy).toHaveBeenCalledTimes(2);
      expect(prepareSpy.mock.calls[0][0]).toContain(`${"?, ".repeat(99)}?`);
      expect(prepareSpy.mock.calls[1][0]).toContain("owner_login COLLATE NOCASE IN (?)");
      prepareSpy.mockRestore();
    });
  });

  describe("installation repository cache", () => {
    it("returns fresh cached repositories by installation id", async () => {
      await mod.cacheInstallationRepos(
        fakeDb,
        "42",
        [{ installationId: 12345, repos: ["Acme-Corp/Repo-A", "acme-corp/repo-a", "acme-corp/repo-b"] }],
        1_000,
        900_000,
      );

      const cached = await mod.getCachedInstallationReposForInstallations(fakeDb, "42", [12345], 2_000);

      expect(cached.get(12345)).toEqual(new Set(["acme-corp/repo-a", "acme-corp/repo-b"]));
    });

    it("ignores expired cached repositories", async () => {
      await mod.cacheInstallationRepos(
        fakeDb,
        "42",
        [{ installationId: 12345, repos: ["acme-corp/repo-a"] }],
        1_000,
        500,
      );

      const cached = await mod.getCachedInstallationReposForInstallations(fakeDb, "42", [12345], 2_000);

      expect(cached.has(12345)).toBe(false);
    });

    it("does not share cached repositories across users", async () => {
      await mod.cacheInstallationRepos(
        fakeDb,
        "42",
        [{ installationId: 12345, repos: ["acme-corp/repo-a"] }],
        1_000,
        900_000,
      );

      const cached = await mod.getCachedInstallationReposForInstallations(fakeDb, "99", [12345], 2_000);

      expect(cached.has(12345)).toBe(false);
    });

    it("skips malformed cached repository payloads", async () => {
      fakeDb.repoCache.set("42:12345", {
        user_id: "42",
        installation_id: 12345,
        repositories_json: JSON.stringify({ full_name: "acme-corp/repo-a" }),
        fetched_at: 1_000,
        expires_at: 10_000,
      });

      const cached = await mod.getCachedInstallationReposForInstallations(fakeDb, "42", [12345], 2_000);

      expect(cached.has(12345)).toBe(false);
    });

    it("deletes cached repositories for an installation", async () => {
      await mod.cacheInstallationRepos(
        fakeDb,
        "42",
        [{ installationId: 12345, repos: ["acme-corp/repo-a"] }],
        1_000,
        500,
      );

      await mod.deleteCachedInstallationRepos(fakeDb, 12345);

      expect(fakeDb.repoCache.has("42:12345")).toBe(false);
    });
  });

  describe("github_installations migration", () => {
    it("enforces case-insensitive uniqueness for logical owners", () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0010_github_installations.sql"), "utf8"));
      sqlite.exec(
        readFileSync(
          resolve("apps/control-plane-worker/migrations/0107_github_installations_owner_unique.sql"),
          "utf8",
        ),
      );

      sqlite
        .prepare(
          `INSERT INTO github_installations (installation_id, owner_login, owner_id, owner_type, repository_selection)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(1, "TryCycloid", 1, "Organization", "selected");

      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO github_installations (installation_id, owner_login, owner_id, owner_type, repository_selection)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(2, "trycycloid", 2, "Organization", "selected"),
      ).toThrow(/UNIQUE constraint failed: github_installations.owner_login/);
    });

    it("dedupes existing owner rows before adding the unique index", () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0010_github_installations.sql"), "utf8"));
      sqlite
        .prepare(
          `INSERT INTO github_installations
             (installation_id, owner_login, owner_id, owner_type, repository_selection, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(1, "TryCycloid", 1, "Organization", "selected", 100);
      sqlite
        .prepare(
          `INSERT INTO github_installations
             (installation_id, owner_login, owner_id, owner_type, repository_selection, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(2, "trycycloid", 2, "Organization", "selected", 200);

      sqlite.exec(
        readFileSync(
          resolve("apps/control-plane-worker/migrations/0107_github_installations_owner_unique.sql"),
          "utf8",
        ),
      );

      const rows = sqlite
        .prepare(
          `SELECT installation_id, owner_login
           FROM github_installations
           WHERE owner_login = ? COLLATE NOCASE`,
        )
        .all("trycycloid") as Array<{ installation_id: number; owner_login: string }>;
      expect(rows).toEqual([{ installation_id: 2, owner_login: "trycycloid" }]);
    });

    it("creates the installation repository cache table", () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(
        readFileSync(
          resolve("apps/control-plane-worker/migrations/0121_github_installation_repositories_cache.sql"),
          "utf8",
        ),
      );

      sqlite
        .prepare(
          `INSERT INTO github_installation_repositories_cache (
             user_id, installation_id, repositories_json, fetched_at, expires_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("42", 12345, JSON.stringify(["acme-corp/repo-a"]), 1_000, 901_000);

      const row = sqlite
        .prepare("SELECT repositories_json FROM github_installation_repositories_cache WHERE installation_id = ?")
        .get(12345) as { repositories_json: string };
      expect(JSON.parse(row.repositories_json)).toEqual(["acme-corp/repo-a"]);
    });
  });

  describe("getInstallationsByOwnerIds", () => {
    beforeEach(async () => {
      await mod.upsertInstallation(fakeDb, {
        installationId: 1,
        ownerLogin: "mialabs",
        ownerId: 144570272,
        ownerType: "Organization",
        repositorySelection: "all",
      });
      await mod.upsertInstallation(fakeDb, {
        installationId: 2,
        ownerLogin: "acme",
        ownerId: 100,
        ownerType: "Organization",
        repositorySelection: "all",
      });
    });

    it("returns the matching active installation by owner id", async () => {
      const rows = await mod.getInstallationsByOwnerIds(fakeDb, [144570272]);
      expect(rows).toHaveLength(1);
      expect(rows[0].owner_login).toBe("mialabs");
    });

    it("returns empty for no input ids", async () => {
      expect(await mod.getInstallationsByOwnerIds(fakeDb, [])).toEqual([]);
    });

    it("excludes suspended installations", async () => {
      await mod.suspendInstallation(fakeDb, 1, Date.now());
      expect(await mod.getInstallationsByOwnerIds(fakeDb, [144570272])).toEqual([]);
    });

    it("ignores unknown owner ids", async () => {
      expect(await mod.getInstallationsByOwnerIds(fakeDb, [999999])).toEqual([]);
    });

    it("chunks owner ids past the bind limit and combines results", async () => {
      const prepareSpy = vi.spyOn(fakeDb, "prepare");
      // 250 ids (100-bind limit -> 3 chunks); the two seeded installations land
      // in different chunks (id 100 in chunk 1, 144570272 appended last).
      const ownerIds = [...Array.from({ length: 249 }, (_, i) => i + 100), 144570272];

      const rows = await mod.getInstallationsByOwnerIds(fakeDb, ownerIds);

      const ownerIdQueries = prepareSpy.mock.calls.filter(([query]) => (query as string).includes("owner_id IN"));
      expect(ownerIdQueries).toHaveLength(3);
      expect(rows.map((row) => row.owner_login).sort()).toEqual(["acme", "mialabs"]);
    });
  });

  describe("deleteCachedInstallationReposForUser", () => {
    it("removes only the target user's cached rows", async () => {
      const now = Date.now();
      await mod.cacheInstallationRepos(fakeDb, "user-a", [{ installationId: 1, repos: ["acme/x"] }], now, 900_000);
      await mod.cacheInstallationRepos(fakeDb, "user-b", [{ installationId: 1, repos: ["acme/y"] }], now, 900_000);

      await mod.deleteCachedInstallationReposForUser(fakeDb, "user-a");

      const a = await mod.getCachedInstallationReposForInstallations(fakeDb, "user-a", [1], now);
      const b = await mod.getCachedInstallationReposForInstallations(fakeDb, "user-b", [1], now);
      expect(a.size).toBe(0);
      expect(b.get(1)).toEqual(new Set(["acme/y"]));
    });
  });
});
