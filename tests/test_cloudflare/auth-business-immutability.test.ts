import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { getUserBusinessId, getUserBusinessIdOrNull } from "../../apps/control-plane-worker/src/auth/db";
import {
  BusinessMismatchError,
  persistAuthenticatedGitHubUser,
} from "../../apps/control-plane-worker/src/auth/service";
import { decrypt } from "../../apps/control-plane-worker/src/settings/encryption";
import type { GitHubUser } from "../../apps/control-plane-worker/src/types";

const TEST_ENCRYPTION_KEY = "test-encryption-key";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class SqliteD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  private runStatement<T>(fn: (stmt: Database.Statement, values: unknown[]) => T): T {
    const stmt = this.db.prepare(this.query);
    return fn(stmt, this.boundValues);
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }> {
    const result = this.runStatement((stmt, values) => stmt.run(...values));
    return {
      success: true,
      meta: {
        last_row_id: Number(result.lastInsertRowid ?? 0),
        changes: result.changes,
      },
    };
  }

  async first<T>(): Promise<T | null> {
    const row = this.runStatement((stmt, values) => stmt.get(...values) as T | undefined);
    return row ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.runStatement((stmt, values) => stmt.all(...values) as T[]);
    return { results: rows };
  }

  async executeBatch(): Promise<{
    results: Record<string, unknown>[];
    meta?: { last_row_id?: number; changes?: number };
  }> {
    const normalized = this.query.trimStart().toUpperCase();
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      return this.all<Record<string, unknown>>();
    }

    const result = await this.run();
    return { results: [], meta: result.meta };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");

  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }

  async batch(
    statements: SqliteD1Statement[],
  ): Promise<Array<{ results: Record<string, unknown>[]; meta?: { last_row_id?: number; changes?: number } }>> {
    const run = this.sqlite.transaction((prepared: SqliteD1Statement[]) => {
      return prepared.map((statement) => {
        const normalized = (statement as unknown as { query: string }).query.trimStart().toUpperCase();
        if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
          const stmt = this.sqlite.prepare((statement as unknown as { query: string }).query);
          const values = (statement as unknown as { boundValues: unknown[] }).boundValues;
          return { results: stmt.all(...values) as Record<string, unknown>[] };
        }

        const stmt = this.sqlite.prepare((statement as unknown as { query: string }).query);
        const values = (statement as unknown as { boundValues: unknown[] }).boundValues;
        const result = stmt.run(...values);
        return {
          results: [],
          meta: {
            last_row_id: Number(result.lastInsertRowid ?? 0),
            changes: result.changes,
          },
        };
      });
    });

    return run(statements);
  }
}

function createDb(): SqliteD1 {
  return new SqliteD1();
}

function insertBusiness(db: SqliteD1, businessId: string): void {
  db.sqlite
    .prepare("INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES (?, ?, 0, ?, ?)")
    .run(businessId, businessId, Date.now(), Date.now());
}

function seedUser(db: SqliteD1, businessId: string, githubUser: GitHubUser): number {
  insertBusiness(db, businessId);
  const now = Date.now();
  const result = db.sqlite
    .prepare(
      `INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      githubUser.id,
      githubUser.login,
      githubUser.name ?? null,
      githubUser.email ?? null,
      githubUser.avatar_url ?? null,
      businessId,
      now,
      now,
    );
  const userId = Number(result.lastInsertRowid);
  db.sqlite
    .prepare(
      `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?)`,
    )
    .run(businessId, userId, now, now);
  return userId;
}

function getUserRow(db: SqliteD1, githubUserId: number) {
  return db.sqlite
    .prepare("SELECT id, login, name, email, avatar_url, business_id FROM users WHERE github_id = ?")
    .get(githubUserId) as
    | {
        id: number;
        login: string;
        name: string | null;
        email: string | null;
        avatar_url: string | null;
        business_id: string;
      }
    | undefined;
}

function getMembershipRow(db: SqliteD1, userId: number) {
  return db.sqlite.prepare("SELECT business_id, updated_at FROM business_members WHERE user_id = ?").get(userId) as
    { business_id: string; updated_at: number } | undefined;
}

function getGithubIntegrationToken(db: SqliteD1, userId: number): string | null {
  const row = db.sqlite
    .prepare("SELECT oauth_access_token FROM user_integrations WHERE user_id = ? AND integration_id = 'github'")
    .get(userId) as { oauth_access_token: string | null } | undefined;
  return row?.oauth_access_token ?? null;
}

function getVirtualKeyCount(db: SqliteD1, userId: number): number {
  const row = db.sqlite
    .prepare("SELECT COUNT(*) AS count FROM openai_virtual_keys WHERE owner_user_id = ?")
    .get(String(userId)) as { count: number };
  return row.count;
}

describe("auth business immutability DAO coverage", () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = createDb();
  });

  it("getUserBusinessId returns the immutable business id", async () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "octocat" });

    await expect(getUserBusinessId(db as unknown as D1Database, userId)).resolves.toBe("biz-a");
  });

  it("getUserBusinessIdOrNull returns null for a missing user", async () => {
    await expect(getUserBusinessIdOrNull(db as unknown as D1Database, 999)).resolves.toBeNull();
  });

  it("getUserBusinessId throws for a missing user", async () => {
    await expect(getUserBusinessId(db as unknown as D1Database, 999)).rejects.toThrow("missing business ownership");
  });
});

describe("persistAuthenticatedGitHubUser", () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = createDb();
  });

  it("creates a new GitHub user, membership, and integration token without a virtual key", async () => {
    insertBusiness(db, "biz-a");

    const userId = await persistAuthenticatedGitHubUser(
      db as unknown as D1Database,
      { id: 1001, login: "octocat", name: "Octo Cat" },
      { accessToken: "gho_token_1", refreshToken: null, expiresAt: null },
      "biz-a",
      TEST_ENCRYPTION_KEY,
    );

    expect(getUserRow(db, 1001)?.id).toBe(userId);
    expect(getUserRow(db, 1001)?.business_id).toBe("biz-a");
    expect(getMembershipRow(db, userId)?.business_id).toBe("biz-a");
    await expect(decrypt(getGithubIntegrationToken(db, userId)!, TEST_ENCRYPTION_KEY)).resolves.toBe("gho_token_1");
    expect(getVirtualKeyCount(db, userId)).toBe(0);
  });

  it("updates profile and token data when the same user logs in for the same business", async () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "old-login", email: "old@example.com" });
    db.sqlite
      .prepare(
        `INSERT INTO user_integrations (
          user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at, api_key,
          external_user_id, service_url, encrypted, connected_at, updated_at
        ) VALUES (?, 'github', ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(userId, "gho_old", 1, 1);

    const resolvedUserId = await persistAuthenticatedGitHubUser(
      db as unknown as D1Database,
      { id: 1001, login: "new-login", email: "new@example.com" },
      { accessToken: "gho_new", refreshToken: null, expiresAt: null },
      "biz-a",
      TEST_ENCRYPTION_KEY,
    );

    expect(resolvedUserId).toBe(userId);
    expect(getUserRow(db, 1001)).toMatchObject({
      login: "new-login",
      email: "new@example.com",
      business_id: "biz-a",
    });
    expect(getMembershipRow(db, userId)?.business_id).toBe("biz-a");
    await expect(decrypt(getGithubIntegrationToken(db, userId)!, TEST_ENCRYPTION_KEY)).resolves.toBe("gho_new");
  });

  it("throws BusinessMismatchError when the same GitHub user is mapped to a different business", async () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "octocat" });
    insertBusiness(db, "biz-b");

    await expect(
      persistAuthenticatedGitHubUser(
        db as unknown as D1Database,
        { id: 1001, login: "octocat" },
        { accessToken: "gho_new", refreshToken: null, expiresAt: null },
        "biz-b",
        TEST_ENCRYPTION_KEY,
      ),
    ).rejects.toMatchObject<Partial<BusinessMismatchError>>({
      storedBusinessId: "biz-a",
      requestedBusinessId: "biz-b",
    });

    expect(getUserRow(db, 1001)?.business_id).toBe("biz-a");
    expect(getMembershipRow(db, userId)?.business_id).toBe("biz-a");
  });

  it("rolls back the full login write when membership persistence fails", async () => {
    insertBusiness(db, "biz-a");
    db.sqlite.exec(`
      CREATE TRIGGER fail_business_members_insert
      BEFORE INSERT ON business_members
      FOR EACH ROW
      BEGIN
        SELECT RAISE(FAIL, 'membership insert failed');
      END;
    `);

    await expect(
      persistAuthenticatedGitHubUser(
        db as unknown as D1Database,
        { id: 1001, login: "octocat" },
        { accessToken: "gho_token_1", refreshToken: null, expiresAt: null },
        "biz-a",
        TEST_ENCRYPTION_KEY,
      ),
    ).rejects.toThrow("membership insert failed");

    expect(getUserRow(db, 1001)).toBeUndefined();
    expect(
      db.sqlite.prepare("SELECT COUNT(*) as count FROM user_integrations WHERE integration_id = 'github'").get() as {
        count: number;
      },
    ).toMatchObject({ count: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM openai_virtual_keys").get()).toMatchObject({ count: 0 });
  });
});

describe("auth business immutability triggers", () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = createDb();
  });

  it("rejects changing users.business_id", () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "octocat" });
    insertBusiness(db, "biz-b");

    expect(() => {
      db.sqlite.prepare("UPDATE users SET business_id = ? WHERE id = ?").run("biz-b", userId);
    }).toThrow("users.business_id is immutable");
  });

  it("rejects changing business_members.business_id", () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "octocat" });
    insertBusiness(db, "biz-b");

    expect(() => {
      db.sqlite.prepare("UPDATE business_members SET business_id = ? WHERE user_id = ?").run("biz-b", userId);
    }).toThrow("business_members.business_id is immutable");
  });

  it("rejects inserting a membership row with a mismatched business id", () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "octocat" });
    insertBusiness(db, "biz-b");
    db.sqlite.prepare("DELETE FROM business_members WHERE user_id = ?").run(userId);

    expect(() => {
      db.sqlite
        .prepare(
          `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
           VALUES (?, ?, 'member', ?, ?)`,
        )
        .run("biz-b", userId, Date.now(), Date.now());
    }).toThrow("business_members.business_id must match users.business_id");
  });

  it("allows same-value business_id updates", () => {
    const userId = seedUser(db, "biz-a", { id: 1001, login: "octocat" });

    expect(() => {
      db.sqlite.prepare("UPDATE users SET business_id = ? WHERE id = ?").run("biz-a", userId);
      db.sqlite.prepare("UPDATE business_members SET business_id = ? WHERE user_id = ?").run("biz-a", userId);
    }).not.toThrow();
  });
});
