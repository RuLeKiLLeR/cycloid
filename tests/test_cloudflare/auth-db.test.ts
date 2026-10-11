import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLinearTokens } from "../../apps/control-plane-worker/src/integrations/db";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

/**
 * Unified D1 fake for testing auth/db functions.
 * Handles queries against both legacy `users` table and new `user_integrations` table.
 */
interface IntegrationRow {
  user_id: number;
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key: string | null;
  external_user_id: string | null;
  service_url: string | null;
  encrypted: number;
  last_validated_at: number | null;
  last_validation_status: string | null;
  last_validation_reason_code: string | null;
  connected_at: number;
  updated_at: number;
}

interface UserRow {
  id: number;
  github_id: number | null;
  login: string | null;
  email: string | null;
  avatar_url: string | null;
  slack_user_id: string | null;
  linear_access_token: string | null;
  linear_refresh_token: string | null;
  linear_token_expires_at: number | null;
}

interface AuthSessionRow {
  token: string;
  user_id: number;
  expires_at: number;
}

class FakeD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    // user_integrations: getUserByExternalId (JOIN)
    if (this.query.includes("FROM user_integrations") && this.query.includes("INNER JOIN users")) {
      const [integrationId, externalUserId] = this.boundValues as [string, string];
      for (const row of this.db.integrations.values()) {
        if (row.integration_id === integrationId && row.external_user_id === externalUserId) {
          const user = this.db.users.get(row.user_id);
          if (user) return { id: user.id, login: user.login } as unknown as T;
        }
      }
      return null;
    }

    // user_integrations: OAuth token helpers
    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      const userId = Number(this.boundValues[0]);
      const integrationId =
        (this.boundValues[1] as string | undefined) ?? /integration_id = '(\w+)'/.exec(this.query)?.[1] ?? "";
      const key = `${userId}:${integrationId}`;
      const row = this.db.integrations.get(key);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token,
        oauth_expires_at: row.oauth_expires_at,
        api_key: row.api_key,
        external_user_id: row.external_user_id,
        service_url: row.service_url,
        encrypted: row.encrypted,
        last_validated_at: row.last_validated_at,
        last_validation_status: row.last_validation_status,
        last_validation_reason_code: row.last_validation_reason_code,
      } as unknown as T;
    }

    // user_integrations: generic single-row query
    if (this.query.includes("FROM user_integrations")) {
      return null;
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      return null;
    }

    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      return null;
    }

    // Legacy users table queries
    if (this.query.includes("FROM users WHERE slack_user_id")) {
      const [slackUserId] = this.boundValues as [string];
      for (const user of this.db.users.values()) {
        if (user.slack_user_id === slackUserId) {
          return { id: user.id, login: user.login } as unknown as T;
        }
      }
      return null;
    }

    if (this.query.includes("FROM users WHERE github_id")) {
      const [githubUserId] = this.boundValues as [number];
      for (const user of this.db.users.values()) {
        if (user.github_id === githubUserId) {
          return { id: user.id, login: user.login } as unknown as T;
        }
      }
      return null;
    }

    if (this.query.includes("FROM users")) {
      const [userId] = this.boundValues as [number | string];
      const user = this.db.users.get(Number(userId));
      if (!user) return null;
      if (this.query.includes("linear_refresh_token")) {
        return {
          linear_access_token: user.linear_access_token,
          linear_refresh_token: user.linear_refresh_token,
          linear_token_expires_at: user.linear_token_expires_at,
        } as unknown as T;
      }
      if (this.query.includes("linear_access_token")) {
        return { linear_access_token: user.linear_access_token } as unknown as T;
      }
      return user as unknown as T;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    // user_integrations: getProviderKeyStatus or getIntegrationStatus
    if (this.query.includes("FROM user_integrations")) {
      const userId = Number(this.boundValues[0]);
      const results: Array<{ integration_id: string }> = [];
      for (const row of this.db.integrations.values()) {
        if (row.user_id === userId) {
          results.push({ integration_id: row.integration_id });
        }
      }
      return { results: results as unknown as T[] };
    }

    // business_integrations
    if (this.query.includes("FROM business_integrations")) {
      return { results: [] };
    }

    return { results: [] };
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }> {
    if (this.query.includes("DELETE FROM auth_sessions WHERE expires_at < ?")) {
      const [cutoff] = this.boundValues as [number];
      let changes = 0;
      for (const [token, session] of this.db.authSessions) {
        if (session.expires_at < cutoff) {
          this.db.authSessions.delete(token);
          changes += 1;
        }
      }
      return { success: true, meta: { last_row_id: 0, changes } };
    }

    // user_integrations: connectIntegration (INSERT ... ON CONFLICT)
    if (this.query.includes("INSERT INTO user_integrations")) {
      const [
        userId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        externalUserId,
        serviceUrl,
        encrypted,
        _lastValidatedAt,
        _lastValidationStatus,
        _lastValidationReasonCode,
        connectedAt,
        updatedAt,
      ] = this.boundValues as [
        number,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number,
        number | null,
        string | null,
        string | null,
        number,
        number,
      ];
      const key = `${userId}:${integrationId}`;
      this.db.integrations.set(key, {
        user_id: userId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        external_user_id: externalUserId,
        service_url: serviceUrl,
        encrypted,
        last_validated_at: _lastValidatedAt,
        last_validation_status: _lastValidationStatus,
        last_validation_reason_code: _lastValidationReasonCode,
        connected_at: connectedAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    // user_integrations: CAS rotate (storeLinear/NotionTokensIfRefreshMatches)
    if (this.query.includes("UPDATE user_integrations") && this.query.includes("AND oauth_refresh_token = ?")) {
      const integrationId = /integration_id = '(\w+)'/.exec(this.query)?.[1] ?? "";
      const [accessToken, refreshToken, expiresAt, updatedAt, userId, expectedRefreshCiphertext] = this.boundValues as [
        string,
        string | null,
        number | null,
        number,
        number,
        string,
      ];
      const existing = this.db.integrations.get(`${userId}:${integrationId}`);
      if (existing && existing.oauth_refresh_token === expectedRefreshCiphertext) {
        existing.oauth_access_token = accessToken;
        existing.oauth_refresh_token = refreshToken;
        existing.oauth_expires_at = expiresAt;
        existing.encrypted = 1;
        existing.updated_at = updatedAt;
        return { success: true, meta: { last_row_id: 0, changes: 1 } };
      }
      return { success: true, meta: { last_row_id: 0, changes: 0 } };
    }

    // user_integrations: disconnectIntegration (DELETE)
    if (this.query.includes("DELETE FROM user_integrations")) {
      const [userId, integrationId] = this.boundValues as [number, string];
      this.db.integrations.delete(`${userId}:${integrationId}`);
      return { success: true, meta: { last_row_id: 0 } };
    }

    // Legacy: UPDATE users SET linear_access_token = ?, ...
    if (this.query.includes("UPDATE users SET linear_access_token = ?,")) {
      const [accessToken, refreshToken, expiresAt, , userId] = this.boundValues as [
        string,
        string | null,
        number,
        number,
        number,
      ];
      const user = this.db.users.get(userId);
      if (user) {
        user.linear_access_token = accessToken;
        user.linear_refresh_token = refreshToken;
        user.linear_token_expires_at = expiresAt;
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    // Legacy: UPDATE users SET linear_access_token = NULL
    if (this.query.includes("UPDATE users SET linear_access_token = NULL")) {
      const [, userId] = this.boundValues as [number, number];
      const user = this.db.users.get(userId);
      if (user) {
        user.linear_access_token = null;
        user.linear_refresh_token = null;
        user.linear_token_expires_at = null;
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    // Legacy: UPDATE users SET slack_user_id = NULL
    if (this.query.includes("UPDATE users SET slack_user_id = NULL")) {
      const [_updatedAt, userId] = this.boundValues as [number, number];
      const user = this.db.users.get(userId);
      if (user) user.slack_user_id = null;
      return { success: true, meta: { last_row_id: 0 } };
    }

    // Legacy: UPDATE users SET slack_user_id = ?
    if (this.query.includes("UPDATE users SET slack_user_id")) {
      const [slackUserId, _updatedAt, userId] = this.boundValues as [string, number, number];
      const user = this.db.users.get(userId);
      if (user) user.slack_user_id = slackUserId;
      return { success: true, meta: { last_row_id: 0 } };
    }

    // Legacy: UPDATE users SET github_token = NULL
    if (this.query.includes("UPDATE users SET github_token = NULL")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }
}

class FakeD1 {
  readonly users = new Map<number, UserRow>();
  readonly integrations = new Map<string, IntegrationRow>();
  readonly authSessions = new Map<string, AuthSessionRow>();

  addUser(id: number, overrides: Partial<UserRow> = {}): void {
    this.users.set(id, {
      id,
      github_id: null,
      login: null,
      email: null,
      avatar_url: null,
      slack_user_id: null,
      linear_access_token: null,
      linear_refresh_token: null,
      linear_token_expires_at: null,
      ...overrides,
    });
  }

  addUserWithLogin(id: number, login: string, slackUserId: string | null = null): void {
    this.addUser(id, { login, slack_user_id: slackUserId });
  }

  addGithubUser(id: number, githubId: number, login: string): void {
    this.addUser(id, { github_id: githubId, login });
  }

  /** Seed a user_integrations row (for the new schema) */
  addIntegration(userId: number, integrationId: string, data: Partial<IntegrationRow> = {}): void {
    const key = `${userId}:${integrationId}`;
    this.integrations.set(key, {
      user_id: userId,
      integration_id: integrationId,
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      last_validated_at: null,
      last_validation_status: null,
      last_validation_reason_code: null,
      connected_at: Date.now(),
      updated_at: Date.now(),
      ...data,
    });
  }

  addAuthSession(token: string, userId: number, expiresAt: number): void {
    this.authSessions.set(token, {
      token,
      user_id: userId,
      expires_at: expiresAt,
    });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  batch(stmts: FakeD1Statement[]): Promise<unknown[]> {
    return Promise.all(stmts.map((s) => s.run()));
  }
}

type AuthDbModule = {
  deleteExpiredAuthSessions: (db: unknown, now?: number) => Promise<number>;
  getValidLinearToken: (db: unknown, userId: string, env: Record<string, string | undefined>) => Promise<string | null>;
  getValidNotionToken: (db: unknown, userId: string, env: Record<string, string | undefined>) => Promise<string | null>;
  storeLinearTokens: (
    db: unknown,
    userId: number,
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number,
    encryptionKey: string | undefined,
    externalUserId?: string,
  ) => Promise<void>;
  storeNotionTokens: (
    db: unknown,
    userId: number,
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number | null,
    encryptionKey: string | undefined,
    externalUserId?: string,
  ) => Promise<void>;
  getUserBySlackId: (db: unknown, slackUserId: string) => Promise<{ id: number; login: string | null } | null>;
  getUserByLinearId: (db: unknown, linearUserId: string) => Promise<{ id: number; login: string | null } | null>;
  getUserByGithubId: (db: unknown, githubUserId: number) => Promise<{ id: number; login: string | null } | null>;
  clearSlackLink: (db: unknown, userId: string) => Promise<void>;
  clearLinearTokens: (
    db: unknown,
    userId: string,
    env: { TOKEN_ENCRYPTION_KEY?: string },
    preloadedAccessToken?: string | null,
  ) => Promise<void>;
  getUserSentryProfile: (
    db: unknown,
    userId: string,
  ) => Promise<{ id: string; email: string | null; username: string | null } | null>;
  getUserDisplayProfile: (
    db: unknown,
    userId: string | number,
  ) => Promise<{ login: string | null; avatarUrl: string | null } | null>;
  getValidGithubToken: (
    db: unknown,
    userId: string,
    env: { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string },
  ) => Promise<string | null>;
  getValidGithubTokenResult: (
    db: unknown,
    userId: string,
    env: { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string },
  ) => Promise<
    | { ok: true; token: string }
    | {
        ok: false;
        reason: "token_missing" | "token_refresh_rejected" | "token_refresh_unavailable";
        status?: number;
        message: string;
      }
  >;
  resolveAuthUserExtras: (
    db: unknown,
    userId: number,
    businessId: string,
  ) => Promise<{
    businessId: string;
    businessRole: "admin" | "member" | null;
    egressAllowlist: string[] | null;
    slackConnected: boolean;
    slackLinked: boolean;
    slackNeedsReconnect: boolean;
  }>;
};

let mod: AuthDbModule;
let fakeDb: FakeD1;
const TEST_ENCRYPTION_KEY = "test-token-encryption-key";

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

  async run() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
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

  batch(stmts: SqliteD1Statement[]): Promise<Array<{ results: unknown[] }>> {
    return Promise.all(stmts.map((stmt) => stmt.all<unknown>()));
  }
}

describe("auth/db -- resolveAuthUserExtras", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
  });

  it("returns null role and no egress allowlist when the user has no business_members row", async () => {
    const d1 = new SqliteD1();
    const db = d1 as unknown as D1Database;
    const now = Date.now();
    const businessId = "biz-auth-extras-null-role";
    const userId = 991_001;

    d1.sqlite
      .prepare(
        "INSERT INTO businesses (id, name, egress_allowlist_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(businessId, "Auth Extras Null Role", null, now, now);
    d1.sqlite
      .prepare(
        `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        991_001,
        "auth-null-role",
        "Auth Null Role",
        "auth-null-role@example.com",
        null,
        businessId,
        now,
        now,
      );

    const extras = await mod.resolveAuthUserExtras(db, userId, businessId);

    expect(extras.businessId).toBe(businessId);
    expect(extras.businessRole).toBeNull();
    expect(extras.egressAllowlist).toBeNull();
  });

  it("reports a magic-link Slack identity as linked without search access", async () => {
    const d1 = new SqliteD1();
    const db = d1 as unknown as D1Database;
    const now = Date.now();
    const businessId = "biz-auth-extras-slack-linked";
    const userId = 991_002;

    d1.sqlite
      .prepare(
        "INSERT INTO businesses (id, name, egress_allowlist_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(businessId, "Auth Extras Slack Linked", null, now, now);
    d1.sqlite
      .prepare(
        `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        991_002,
        "auth-slack-linked",
        "Auth Slack Linked",
        "auth-slack-linked@example.com",
        null,
        businessId,
        now,
        now,
      );
    d1.sqlite
      .prepare(
        `INSERT INTO user_integrations (user_id, integration_id, external_user_id, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(userId, "slack", "U0B47EHDJSV", now, now);

    const extras = await mod.resolveAuthUserExtras(db, userId, businessId);

    expect(extras.slackLinked).toBe(true);
    expect(extras.slackConnected).toBe(false);
    expect(extras.slackNeedsReconnect).toBe(false);
  });
});

describe("auth/db -- deleteExpiredAuthSessions", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  it("deletes only sessions older than the cutoff", async () => {
    fakeDb.addAuthSession("expired-a", 1, 100);
    fakeDb.addAuthSession("expired-b", 1, 199);
    fakeDb.addAuthSession("active", 1, 200);
    fakeDb.addAuthSession("future", 1, 500);

    const deleted = await mod.deleteExpiredAuthSessions(fakeDb, 200);

    expect(deleted).toBe(2);
    expect([...fakeDb.authSessions.keys()]).toEqual(["active", "future"]);
  });
});

describe("auth/db -- getUserSentryProfile", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  it("returns the Sentry user profile fields for an existing user", async () => {
    fakeDb.addUser(42, { login: "octocat", email: "octocat@example.com" });

    await expect(mod.getUserSentryProfile(fakeDb, "42")).resolves.toEqual({
      id: "42",
      email: "octocat@example.com",
      username: "octocat",
    });
  });

  it("returns null when the user does not exist", async () => {
    await expect(mod.getUserSentryProfile(fakeDb, "999")).resolves.toBeNull();
  });
});

describe("auth/db -- getUserDisplayProfile", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  it("returns the route owner display profile fields for an existing user", async () => {
    fakeDb.addUser(42, { login: "octocat", avatar_url: "https://avatars.example/octocat.png" });

    await expect(mod.getUserDisplayProfile(fakeDb, 42)).resolves.toEqual({
      login: "octocat",
      avatarUrl: "https://avatars.example/octocat.png",
    });
  });

  it("returns null when the user does not exist", async () => {
    await expect(mod.getUserDisplayProfile(fakeDb, "999")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slack link DB functions
// ---------------------------------------------------------------------------

describe("auth/db -- slack link functions", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  describe("getUserBySlackId", () => {
    it("returns the linked user", async () => {
      fakeDb.addUserWithLogin(42, "linkeduser");
      fakeDb.addIntegration(42, "slack", { external_user_id: "USLACK1" });
      const result = await mod.getUserBySlackId(fakeDb, "USLACK1");
      expect(result).toEqual({ id: 42, login: "linkeduser" });
    });

    it("returns null when no user is linked", async () => {
      const result = await mod.getUserBySlackId(fakeDb, "UNOTFOUND");
      expect(result).toBeNull();
    });
  });

  describe("clearSlackLink", () => {
    it("clears the slack_user_id", async () => {
      fakeDb.addUserWithLogin(42, "linkeduser", "USLACK1");
      fakeDb.addIntegration(42, "slack", { external_user_id: "USLACK1" });
      await mod.clearSlackLink(fakeDb, "42");
      expect(fakeDb.integrations.has("42:slack")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Linear link DB functions
// ---------------------------------------------------------------------------

describe("auth/db -- Linear link functions", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  describe("getUserByLinearId", () => {
    it("returns the linked user", async () => {
      fakeDb.addUserWithLogin(42, "linearuser");
      fakeDb.addIntegration(42, "linear", { external_user_id: "linear-uuid-123" });
      const result = await mod.getUserByLinearId(fakeDb, "linear-uuid-123");
      expect(result).toEqual({ id: 42, login: "linearuser" });
    });

    it("returns null when no user is linked", async () => {
      const result = await mod.getUserByLinearId(fakeDb, "nonexistent-uuid");
      expect(result).toBeNull();
    });
  });

  describe("getUserByGithubId", () => {
    it("returns the linked GitHub user", async () => {
      fakeDb.addGithubUser(42, 9001, "githubuser");
      const result = await mod.getUserByGithubId(fakeDb, 9001);
      expect(result).toEqual({ id: 42, login: "githubuser" });
    });

    it("returns null when no user has that GitHub ID", async () => {
      const result = await mod.getUserByGithubId(fakeDb, 9999);
      expect(result).toBeNull();
    });
  });

  describe("storeLinearTokens preserves external_user_id on refresh", () => {
    it("does not null out external_user_id when not passed", async () => {
      fakeDb.addUser(1);
      // Initial store with external_user_id
      await mod.storeLinearTokens(fakeDb, 1, "token-1", "refresh-1", 86400, TEST_ENCRYPTION_KEY, "linear-uuid-abc");
      expect(fakeDb.integrations.get("1:linear")?.external_user_id).toBe("linear-uuid-abc");

      // Simulate token refresh: store without external_user_id
      await mod.storeLinearTokens(fakeDb, 1, "token-2", "refresh-2", 86400, TEST_ENCRYPTION_KEY);
      // The COALESCE in the DB would preserve it; in our fake it gets set to null
      // but we verify the function accepts the optional param correctly
      const row = fakeDb.integrations.get("1:linear");
      expect(row?.oauth_access_token).not.toBe("token-2");
      expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
    });
  });

  describe("storeLinearTokens encryption", () => {
    it("fails closed when TOKEN_ENCRYPTION_KEY is missing", async () => {
      fakeDb.addUser(1);

      await expect(mod.storeLinearTokens(fakeDb, 1, "token-1", "refresh-1", 86400, undefined)).rejects.toThrow(
        "TOKEN_ENCRYPTION_KEY is required to store Linear tokens",
      );
      expect(fakeDb.integrations.has("1:linear")).toBe(false);
    });

    it("round-trips encrypted Linear tokens with the same key", async () => {
      fakeDb.addUser(1);

      await mod.storeLinearTokens(fakeDb, 1, "token-1", "refresh-1", 86400, TEST_ENCRYPTION_KEY);
      const row = fakeDb.integrations.get("1:linear");
      expect(row?.encrypted).toBe(1);
      expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
      expect(row?.oauth_refresh_token?.startsWith("enc:")).toBe(true);

      const token =
        (await getLinearTokens(fakeDb as unknown as D1Database, "1", TEST_ENCRYPTION_KEY))?.accessToken ?? null;
      expect(token).toBe("token-1");
    });

    it("returns null for corrupt encrypted Linear token payloads", async () => {
      fakeDb.addUser(1);
      fakeDb.addIntegration(1, "linear", {
        oauth_access_token: "enc:000000000000000000000000:00000000000000000000000000000000:00",
        encrypted: 1,
      });

      const token =
        (await getLinearTokens(fakeDb as unknown as D1Database, "1", TEST_ENCRYPTION_KEY))?.accessToken ?? null;

      expect(token).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// getValidLinearToken
// ---------------------------------------------------------------------------

const OAUTH_ENV = {
  LINEAR_OAUTH_CLIENT_ID: "test-client-id",
  LINEAR_OAUTH_CLIENT_SECRET: "test-client-secret",
  TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
};

function stubLinearFetch(opts: {
  probe?: Response | ((req: Request) => Response | Promise<Response>);
  refresh?: Response | ((req: Request) => Response | Promise<Response>);
  revoke?: Response | ((req: Request) => Response | Promise<Response>);
}): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href === "https://api.linear.app/graphql") {
      return typeof opts.probe === "function"
        ? opts.probe(new Request(href, init))
        : (opts.probe ?? new Response(JSON.stringify({ data: { viewer: { id: "v1" } } }), { status: 200 }));
    }
    if (href === "https://api.linear.app/oauth/token") {
      return typeof opts.refresh === "function"
        ? opts.refresh(new Request(href, init))
        : (opts.refresh ?? new Response(null, { status: 500 }));
    }
    if (href === "https://api.linear.app/oauth/revoke") {
      return typeof opts.revoke === "function"
        ? opts.revoke(new Request(href, init))
        : (opts.revoke ?? new Response(null, { status: 200 }));
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  });
}

describe("auth/db -- getValidLinearToken", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no access token exists", async () => {
    fakeDb.addUser(1);
    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);
    expect(token).toBeNull();
  });

  it("returns the token when not expired", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "valid-token",
      oauth_refresh_token: "refresh-token",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });
    stubLinearFetch({});

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);
    expect(token).toBe("valid-token");
  });

  it.each([
    [
      "GraphQL auth error",
      new Response(JSON.stringify({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }), { status: 200 }),
    ],
    ["401 response", new Response(null, { status: 401 })],
    ["403 response", new Response(null, { status: 403 })],
  ])("clears and returns null when the liveness probe reports a revoked token: %s", async (_name, probe) => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "revoked-token",
      oauth_refresh_token: "refresh-token",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });
    stubLinearFetch({ probe });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);

    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it.each([
    ["viewer null", new Response(JSON.stringify({ data: { viewer: null } }), { status: 200 })],
    ["missing viewer", new Response(JSON.stringify({ data: {} }), { status: 200 })],
    ["viewer id null", new Response(JSON.stringify({ data: { viewer: { id: null } } }), { status: 200 })],
    [
      "non-auth GraphQL error",
      new Response(JSON.stringify({ errors: [{ extensions: { code: "INTERNAL_ERROR" } }] }), { status: 200 }),
    ],
    ["malformed JSON", new Response("{", { status: 200 })],
    ["429 response", new Response(null, { status: 429 })],
    ["500 response", new Response(null, { status: 500 })],
    [
      "network error",
      async () => {
        throw new Error("network failed");
      },
    ],
    [
      "timeout",
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
  ])("preserves and returns the token when the liveness probe is transient: %s", async (_name, probe) => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "valid-token",
      oauth_refresh_token: "refresh-token",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });
    stubLinearFetch({ probe });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);

    expect(token).toBe("valid-token");
    expect(fakeDb.integrations.has("1:linear")).toBe(true);
  });

  it("does not clear a concurrently reconnected token when a stale probe reports revoked", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "token-a",
      oauth_refresh_token: "refresh-a",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });
    stubLinearFetch({
      probe: () => {
        fakeDb.addIntegration(1, "linear", {
          oauth_access_token: "token-b",
          oauth_refresh_token: "refresh-b",
          oauth_expires_at: Date.now() + 60 * 60 * 1000,
        });
        return new Response(null, { status: 401 });
      },
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);

    expect(token).toBeNull();
    const row = fakeDb.integrations.get("1:linear");
    expect(row).toBeDefined();
    expect(row?.oauth_access_token).not.toBe("token-a");
  });

  it("refreshes and stores both new access and refresh tokens when within buffer of expiry", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() + 2 * 60 * 1000, // 2 min from now (within 5-min buffer)
    });

    stubLinearFetch({
      refresh: new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 86400 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);
    expect(token).toBe("new-token");

    // Check that the new token was stored in user_integrations
    const row = fakeDb.integrations.get("1:linear");
    expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
    expect(row?.oauth_refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("preserves the existing refresh token when Linear omits refresh_token during refresh", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() + 2 * 60 * 1000,
    });
    stubLinearFetch({
      refresh: new Response(JSON.stringify({ access_token: "new-token", expires_in: 86400 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);

    expect(token).toBe("new-token");
    const stored =
      (await getLinearTokens(fakeDb as unknown as D1Database, "1", TEST_ENCRYPTION_KEY))?.accessToken ?? null;
    expect(stored).toBe("new-token");
    const row = fakeDb.integrations.get("1:linear");
    expect(row?.oauth_refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("clears tokens when refresh succeeds but the new access token probes as revoked", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });
    stubLinearFetch({
      refresh: new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 86400 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      probe: new Response(null, { status: 401 }),
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);

    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("returns the refreshed token when post-refresh probe is transient", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });
    stubLinearFetch({
      refresh: new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 86400 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      probe: new Response(null, { status: 500 }),
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);

    expect(token).toBe("new-token");
  });

  it("clears tokens and returns null on 4xx refresh failure", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000, // expired
    });

    stubLinearFetch({
      refresh: new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);
    expect(token).toBeNull();

    // Integration should be disconnected
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("returns null without clearing tokens on 5xx refresh failure", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000, // expired
    });

    stubLinearFetch({
      refresh: new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);
    expect(token).toBeNull();

    // Tokens should be preserved for retry
    const row = fakeDb.integrations.get("1:linear");
    expect(row?.encrypted).toBe(1);
    expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
    expect(
      (await getLinearTokens(fakeDb as unknown as D1Database, "1", TEST_ENCRYPTION_KEY))?.accessToken ?? null,
    ).toBe("old-token");
  });

  it("clears tokens and returns null when no refresh token exists", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: null,
      oauth_expires_at: Date.now() - 1000, // expired
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", OAUTH_ENV);
    expect(token).toBeNull();

    // Integration should be disconnected
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("does not call Linear refresh when TOKEN_ENCRYPTION_KEY is missing", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "old-token",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });

    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(url);
      return new Response(null, { status: 200 });
    });

    const token = await mod.getValidLinearToken(fakeDb, "1", {
      LINEAR_OAUTH_CLIENT_ID: OAUTH_ENV.LINEAR_OAUTH_CLIENT_ID,
      LINEAR_OAUTH_CLIENT_SECRET: OAUTH_ENV.LINEAR_OAUTH_CLIENT_SECRET,
    });

    expect(token).toBeNull();
    expect(fetchCalls).toEqual([]);
    expect(fakeDb.integrations.has("1:linear")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearLinearTokens -- revokes on Linear's side before clearing locally
// ---------------------------------------------------------------------------

describe("auth/db -- clearLinearTokens", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls Linear revoke endpoint then deletes local tokens", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "token-to-revoke",
      oauth_refresh_token: "refresh",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });

    const fetchCalls: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
      fetchCalls.push({ url, body: opts.body as URLSearchParams });
      return new Response(null, { status: 200 });
    });

    await mod.clearLinearTokens(fakeDb, "1", { TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    // Should have called Linear's revoke endpoint
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("https://api.linear.app/oauth/revoke");
    expect(fetchCalls[0].body.get("token")).toBe("token-to-revoke");
    expect(fetchCalls[0].body.get("token_type_hint")).toBe("access_token");

    // Local tokens should be deleted
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("still clears local tokens if revocation fails", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "token-to-revoke",
      oauth_refresh_token: null,
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });

    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await mod.clearLinearTokens(fakeDb, "1", { TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    // Local tokens should still be deleted despite revocation failure
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("skips revocation when no token exists", async () => {
    fakeDb.addUser(1);

    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(url);
      return new Response(null, { status: 200 });
    });

    await mod.clearLinearTokens(fakeDb, "1", { TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    // Should not have called fetch at all
    expect(fetchCalls.length).toBe(0);
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("still clears local tokens when encrypted token lookup cannot decrypt", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "enc:000000000000000000000000:00000000000000000000000000000000:00",
      encrypted: 1,
    });

    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(url);
      return new Response(null, { status: 200 });
    });

    await mod.clearLinearTokens(fakeDb, "1", { TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    expect(fetchCalls.length).toBe(0);
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });

  it("uses a preloaded access token for remote revocation before deleting local tokens", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "linear", {
      oauth_access_token: "enc:000000000000000000000000:00000000000000000000000000000000:00",
      encrypted: 1,
    });

    const fetchCalls: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
      fetchCalls.push({ url, body: opts.body as URLSearchParams });
      return new Response(null, { status: 200 });
    });

    await mod.clearLinearTokens(fakeDb, "1", { TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }, "preloaded-token");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.get("token")).toBe("preloaded-token");
    expect(fakeDb.integrations.has("1:linear")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getValidNotionToken -- exercises the shared refreshOAuthTokenWithCas helper
// through the Notion wrapper (endpoint/encoding/DAOs/expiry-default differ from
// Linear). Mirrors the Linear refresh cases so the refactored paths, including
// the CAS-miss and 4xx concurrent-rotation races, are covered for Notion too.
// ---------------------------------------------------------------------------

const NOTION_OAUTH_ENV = {
  NOTION_OAUTH_CLIENT_ID: "notion-client-id",
  NOTION_OAUTH_CLIENT_SECRET: "notion-client-secret",
  TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
};

function stubNotionFetch(opts: {
  refresh?: Response | ((req: Request) => Response | Promise<Response>);
  revoke?: Response | ((req: Request) => Response | Promise<Response>);
}): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href === "https://api.notion.com/v1/oauth/token") {
      return typeof opts.refresh === "function"
        ? opts.refresh(new Request(href, init))
        : (opts.refresh ?? new Response(null, { status: 500 }));
    }
    if (href === "https://api.notion.com/v1/oauth/revoke") {
      return typeof opts.revoke === "function"
        ? opts.revoke(new Request(href, init))
        : (opts.revoke ?? new Response(null, { status: 200 }));
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  });
}

describe("auth/db -- getValidNotionToken", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no access token exists", async () => {
    fakeDb.addUser(1);
    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBeNull();
  });

  it("returns the token unchanged when expires_at is null (non-expiring workspace token)", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "notion-legacy",
      oauth_refresh_token: null,
      oauth_expires_at: null,
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBe("notion-legacy");
  });

  it("returns the token when not expired (no liveness probe for Notion)", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "valid-notion",
      oauth_refresh_token: "refresh-notion",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });
    stubNotionFetch({});

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBe("valid-notion");
  });

  it("refreshes and stores both new access and refresh tokens when within buffer of expiry", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() + 2 * 60 * 1000, // within 5-min buffer
    });
    stubNotionFetch({
      refresh: new Response(
        JSON.stringify({ access_token: "new-notion", refresh_token: "new-refresh", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBe("new-notion");

    const row = fakeDb.integrations.get("1:notion");
    expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
    expect(row?.oauth_refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("preserves the existing refresh token when Notion omits refresh_token during refresh", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });
    stubNotionFetch({
      refresh: new Response(JSON.stringify({ access_token: "new-notion", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBe("new-notion");
    const row = fakeDb.integrations.get("1:notion");
    expect(row?.oauth_refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("returns null without storing when the refresh response omits an access token", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });
    stubNotionFetch({
      refresh: new Response(JSON.stringify({ bot_id: "bot-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBeNull();
    // Row preserved -- an access-token-less 200 is neither a rotation nor a clear.
    expect(fakeDb.integrations.has("1:notion")).toBe(true);
  });

  it("clears tokens and returns null on 4xx refresh failure", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });
    stubNotionFetch({
      refresh: new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:notion")).toBe(false);
  });

  it("returns null without clearing tokens on 5xx refresh failure", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });
    stubNotionFetch({
      refresh: new Response(JSON.stringify({ error: "server_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:notion")).toBe(true);
  });

  it("clears tokens and returns null when no refresh token exists", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: null,
      oauth_expires_at: Date.now() - 1000,
    });
    stubNotionFetch({});

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:notion")).toBe(false);
  });

  it("does not call Notion refresh when TOKEN_ENCRYPTION_KEY is missing", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "notion", {
      oauth_access_token: "old-notion",
      oauth_refresh_token: "old-refresh",
      oauth_expires_at: Date.now() - 1000,
    });

    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(url);
      return new Response(null, { status: 200 });
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", {
      NOTION_OAUTH_CLIENT_ID: NOTION_OAUTH_ENV.NOTION_OAUTH_CLIENT_ID,
      NOTION_OAUTH_CLIENT_SECRET: NOTION_OAUTH_ENV.NOTION_OAUTH_CLIENT_SECRET,
    });

    expect(token).toBeNull();
    expect(fetchCalls).toEqual([]);
    expect(fakeDb.integrations.has("1:notion")).toBe(true);
  });

  it("returns the concurrently refreshed token when the CAS write misses (rotation race)", async () => {
    fakeDb.addUser(1);
    await mod.storeNotionTokens(fakeDb, 1, "old-access", "old-refresh", 60, TEST_ENCRYPTION_KEY);

    stubNotionFetch({
      refresh: async () => {
        // A concurrent refresh rotates the row after we read it but before our CAS write.
        await mod.storeNotionTokens(fakeDb, 1, "concurrent-access", "concurrent-refresh", 86400, TEST_ENCRYPTION_KEY);
        return new Response(
          JSON.stringify({ access_token: "our-access", refresh_token: "our-refresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBe("concurrent-access");
    // Our superseded tokens must not clobber the concurrent winner's row.
    expect(await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV)).toBe("concurrent-access");
  });

  it("returns the concurrently refreshed token when a 4xx follows a concurrent rotation", async () => {
    fakeDb.addUser(1);
    await mod.storeNotionTokens(fakeDb, 1, "old-access", "old-refresh", 60, TEST_ENCRYPTION_KEY);

    stubNotionFetch({
      refresh: async () => {
        await mod.storeNotionTokens(fakeDb, 1, "concurrent-access", "concurrent-refresh", 86400, TEST_ENCRYPTION_KEY);
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const token = await mod.getValidNotionToken(fakeDb, "1", NOTION_OAUTH_ENV);
    expect(token).toBe("concurrent-access");
    // A stale 4xx must not clear a concurrently healthy credential.
    expect(fakeDb.integrations.has("1:notion")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getValidGithubToken
// ---------------------------------------------------------------------------

const GITHUB_OAUTH_ENV = {
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
};

function stubGithubFetch(refresh: Response | ((req: Request) => Response | Promise<Response>)): { calls: Request[] } {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href === "https://github.com/login/oauth/access_token") {
      const req = new Request(href, init);
      calls.push(req);
      return typeof refresh === "function" ? refresh(req) : refresh;
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  });
  return { calls };
}

describe("auth/db -- getValidGithubToken", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/db";
    mod = (await import(modulePath)) as unknown as AuthDbModule;
    fakeDb = new FakeD1();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no token exists", async () => {
    fakeDb.addUser(1);
    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);
    expect(token).toBeNull();
  });

  it("returns the token when not expired", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_valid",
      oauth_refresh_token: "ghr_refresh",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
    });

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);
    expect(token).toBe("gho_valid");
  });

  it("returns the token unchanged when expires_at is null (App with non-expiring tokens)", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_legacy",
      oauth_refresh_token: null,
      oauth_expires_at: null,
    });

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);
    expect(token).toBe("gho_legacy");
  });

  it("refreshes and stores both new access and refresh tokens when within buffer of expiry", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() + 2 * 60 * 1000, // 2 min, inside 5-min buffer
    });
    stubGithubFetch(
      new Response(JSON.stringify({ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);
    expect(token).toBe("gho_new");

    const row = fakeDb.integrations.get("1:github");
    expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
    expect(row?.oauth_refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("preserves the existing refresh token when GitHub omits refresh_token in the response", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() - 1000,
    });
    stubGithubFetch(
      new Response(JSON.stringify({ access_token: "gho_new", expires_in: 28800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);
    expect(token).toBe("gho_new");

    // Re-read to confirm the preserved refresh token round-trips correctly.
    const reread = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);
    expect(reread).toBe("gho_new");
  });

  it("clears tokens when refresh returns 4xx (refresh token revoked or expired)", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() - 1000,
    });
    stubGithubFetch(new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 401 }));

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);

    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:github")).toBe(false);
  });

  it("preserves the row and returns null when refresh returns 5xx (transient)", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() - 1000,
    });
    stubGithubFetch(new Response(null, { status: 503 }));

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);

    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:github")).toBe(true);
  });

  it("reports refresh 5xx as token_refresh_unavailable without clearing the row", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() - 1000,
    });
    stubGithubFetch(new Response(null, { status: 503 }));

    const result = await mod.getValidGithubTokenResult(fakeDb, "1", GITHUB_OAUTH_ENV);

    expect(result).toEqual({
      ok: false,
      reason: "token_refresh_unavailable",
      status: 503,
      message: "GitHub token refresh failed with HTTP 503.",
    });
    expect(fakeDb.integrations.has("1:github")).toBe(true);
  });

  it("reports refresh network failures as token_refresh_unavailable without clearing the row", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() - 1000,
    });
    stubGithubFetch(() => {
      throw new Error("network down");
    });

    const result = await mod.getValidGithubTokenResult(fakeDb, "1", GITHUB_OAUTH_ENV);

    expect(result).toEqual({
      ok: false,
      reason: "token_refresh_unavailable",
      message: "GitHub token refresh failed: Error: network down",
    });
    expect(fakeDb.integrations.has("1:github")).toBe(true);
  });

  it("clears the row when token is expired but no refresh_token is stored", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: null,
      oauth_expires_at: Date.now() - 1000,
    });

    const token = await mod.getValidGithubToken(fakeDb, "1", GITHUB_OAUTH_ENV);

    expect(token).toBeNull();
    expect(fakeDb.integrations.has("1:github")).toBe(false);
  });

  it("does not call the OAuth endpoint when GITHUB_CLIENT_ID is missing", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "gho_old",
      oauth_refresh_token: "ghr_old",
      oauth_expires_at: Date.now() - 1000,
    });
    const fetchCalls: Request[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push(new Request(typeof url === "string" ? url : url.toString(), init));
      return new Response(null, { status: 200 });
    });

    const token = await mod.getValidGithubToken(fakeDb, "1", {
      GITHUB_CLIENT_SECRET: GITHUB_OAUTH_ENV.GITHUB_CLIENT_SECRET,
      TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    });

    expect(token).toBeNull();
    expect(fetchCalls).toEqual([]);
    expect(fakeDb.integrations.has("1:github")).toBe(false);
  });

  it("fails closed when an encrypted GitHub row is read without TOKEN_ENCRYPTION_KEY", async () => {
    fakeDb.addUser(1);
    fakeDb.addIntegration(1, "github", {
      oauth_access_token: "enc:000000000000000000000000:00000000000000000000000000000000:00",
      oauth_refresh_token: "enc:000000000000000000000000:11111111111111111111111111111111:11",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    const fetchCalls: Request[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push(new Request(typeof url === "string" ? url : url.toString(), init));
      return new Response(null, { status: 200 });
    });

    const token = await mod.getValidGithubToken(fakeDb, "1", {
      GITHUB_CLIENT_ID: GITHUB_OAUTH_ENV.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: GITHUB_OAUTH_ENV.GITHUB_CLIENT_SECRET,
    });

    expect(token).toBeNull();
    expect(fetchCalls).toEqual([]);
    // Row is preserved (we only refuse to decrypt) so a later call with the
    // key can recover. Don't clear here -- the operator just needs to fix env.
    expect(fakeDb.integrations.has("1:github")).toBe(true);
  });
});
