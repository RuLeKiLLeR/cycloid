import { beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fake D1 for cli_tokens DAO tests
// ---------------------------------------------------------------------------

interface CliTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  token_prefix: string;
  scope: "read" | "write";
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

interface UserRow {
  id: number;
  github_id: number | null;
  login: string | null;
  name: string | null;
  email: string | null;
  business_id: string;
}

interface BusinessRow {
  id: string;
  shared_sessions: number | null;
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
    if (this.query.includes("COUNT(*) AS active_count") && this.query.includes("FROM cli_tokens")) {
      const [userId, nowMs] = this.boundValues as [number, number];
      let activeCount = 0;
      for (const token of this.db.cliTokens.values()) {
        if (token.user_id !== userId) continue;
        if (token.revoked_at !== null) continue;
        if (token.expires_at !== null && token.expires_at <= nowMs) continue;
        activeCount++;
      }
      return { active_count: activeCount } as unknown as T;
    }

    if (this.query.includes("SELECT id, scope FROM cli_tokens WHERE id = ? AND user_id = ?")) {
      const [tokenId, userId] = this.boundValues as [number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (!token || token.user_id !== userId || token.revoked_at !== null) return null;
      return { id: token.id, scope: token.scope } as unknown as T;
    }

    // findCliTokenByHash: JOIN cli_tokens + users + businesses
    if (this.query.includes("FROM cli_tokens ct") && this.query.includes("INNER JOIN users")) {
      const [tokenHash, nowMs] = this.boundValues as [string, number];
      for (const token of this.db.cliTokens.values()) {
        if (token.token_hash !== tokenHash) continue;
        if (token.revoked_at !== null) continue;
        if (token.expires_at !== null && token.expires_at <= nowMs) continue;

        const user = this.db.users.get(token.user_id);
        if (!user) continue;
        const business = this.db.businesses.get(user.business_id);
        if (!business) continue;

        return {
          token_id: token.id,
          scope: token.scope,
          last_used_at: token.last_used_at,
          id: user.id,
          github_id: user.github_id,
          login: user.login,
          name: user.name,
          email: user.email,
          business_id: user.business_id,
          business_role: "member",
          shared_sessions: business.shared_sessions,
        } as unknown as T;
      }
      return null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    // listCliTokensByUser
    if (this.query.includes("FROM cli_tokens") && this.query.includes("WHERE user_id")) {
      const hasCursor = this.query.includes("AND id < ?");
      let userId: number;
      let cursorId: number | null = null;
      let limit: number;

      if (hasCursor) {
        [userId, cursorId, limit] = this.boundValues as [number, number, number];
      } else {
        [userId, limit] = this.boundValues as [number, number];
      }

      let rows = [...this.db.cliTokens.values()].filter((r) => r.user_id === userId).sort((a, b) => b.id - a.id);

      if (cursorId !== null) {
        rows = rows.filter((r) => r.id < cursorId);
      }

      rows = rows.slice(0, limit);

      return {
        results: rows.map((r) => ({
          id: r.id,
          token_prefix: r.token_prefix,
          scope: r.scope,
          created_at: r.created_at,
          expires_at: r.expires_at,
          revoked_at: r.revoked_at,
          last_used_at: r.last_used_at,
        })) as unknown as T[],
      };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }> {
    // insertCliToken
    if (this.query.includes("INSERT INTO cli_tokens")) {
      const [userId, tokenHash, tokenPrefix, scope, createdAt, expiresAt] = this.boundValues as [
        number,
        string,
        string,
        "read" | "write",
        number,
        number | null,
      ];
      const id = this.db.nextTokenId++;
      this.db.cliTokens.set(id, {
        id,
        user_id: userId,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        scope,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
        last_used_at: null,
      });
      return { success: true, meta: { last_row_id: id, changes: 1 } };
    }

    // updateLastUsedAt (conditional: id + not revoked + not expired + stale)
    if (this.query.includes("UPDATE cli_tokens SET last_used_at")) {
      const [lastUsedAt, tokenId, nowMs, staleBeforeMs] = this.boundValues as [number, number, number, number];
      const token = this.db.cliTokens.get(tokenId);
      const eligible =
        !!token &&
        token.revoked_at === null &&
        (token.expires_at === null || token.expires_at > nowMs) &&
        (token.last_used_at === null || token.last_used_at < staleBeforeMs);
      if (eligible) token!.last_used_at = lastUsedAt;
      return { success: true, meta: { last_row_id: 0, changes: eligible ? 1 : 0 } };
    }

    // setRevokedAt
    if (this.query.includes("UPDATE cli_tokens SET revoked_at")) {
      const [revokedAt, tokenId, userId] = this.boundValues as [number, number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (token && token.user_id === userId) {
        token.revoked_at = revokedAt;
      }
      return { success: true, meta: { last_row_id: 0, changes: token?.user_id === userId ? 1 : 0 } };
    }

    // deleteCliTokenRow
    if (this.query.includes("DELETE FROM cli_tokens")) {
      if (this.query.includes("expires_at IS NOT NULL")) {
        const [userId, nowMs] = this.boundValues as [number, number];
        for (const [id, token] of this.db.cliTokens.entries()) {
          if (token.user_id !== userId) continue;
          if (token.revoked_at !== null) continue;
          if (token.expires_at === null || token.expires_at > nowMs) continue;
          this.db.cliTokens.delete(id);
        }
        return { success: true, meta: { last_row_id: 0, changes: 0 } };
      }
      const [tokenId, userId] = this.boundValues as [number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (token && token.user_id === userId) {
        this.db.cliTokens.delete(tokenId);
      }
      return { success: true, meta: { last_row_id: 0, changes: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }
}

class FakeD1 {
  readonly cliTokens = new Map<number, CliTokenRow>();
  readonly users = new Map<number, UserRow>();
  readonly businesses = new Map<string, BusinessRow>();
  nextTokenId = 1;

  addUser(id: number, businessId: string, overrides: Partial<UserRow> = {}): void {
    this.users.set(id, {
      id,
      github_id: null,
      login: null,
      name: null,
      email: null,
      business_id: businessId,
      ...overrides,
    });
  }

  addBusiness(id: string, sharedSessions: number | null = null): void {
    this.businesses.set(id, { id, shared_sessions: sharedSessions });
  }

  addCliToken(overrides: Partial<CliTokenRow> & { user_id: number; token_hash: string }): number {
    const id = this.nextTokenId++;
    this.cliTokens.set(id, {
      id,
      token_prefix: "arc_abcd",
      scope: "read",
      created_at: Date.now(),
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      ...overrides,
    });
    return id;
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

// ---------------------------------------------------------------------------

type CliTokensDbModule = {
  insertCliTokenIfBelowLimit: (
    db: unknown,
    userId: number,
    tokenHash: string,
    tokenPrefix: string,
    scope: "read" | "write",
    maxActive: number,
    expiresAt?: number,
    now?: number,
  ) => Promise<number | null>;
  findCliTokenByHash: (
    db: unknown,
    tokenHash: string,
  ) => Promise<{
    tokenId: number;
    scope: "read" | "write";
    lastUsedAt: number | null;
    user: {
      id: number;
      login: string | null;
      name: string | null;
      email: string | null;
      githubUserId: number | null;
      businessId: string;
      sharedSessions: boolean;
    };
  } | null>;
  updateLastUsedAt: (db: unknown, tokenId: number, staleBeforeMs: number) => Promise<void>;
  listCliTokensByUser: (
    db: unknown,
    userId: number,
    limit?: number,
    cursor?: string,
  ) => Promise<{
    data: Array<{
      id: number;
      tokenPrefix: string;
      scope: "read" | "write";
      createdAt: number;
      expiresAt: number | null;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>;
    nextCursor: string | null;
  }>;
  findCliTokenByUserAndId: (
    db: unknown,
    userId: number,
    tokenId: number,
  ) => Promise<{ id: number; scope: "read" | "write" } | null>;
  setRevokedAt: (db: unknown, userId: number, tokenId: number) => Promise<void>;
  deleteCliTokenRow: (db: unknown, userId: number, tokenId: number) => Promise<void>;
  deleteExpiredCliTokens: (db: unknown, userId: number, now?: number) => Promise<void>;
};

let mod: CliTokensDbModule;
let fakeDb: FakeD1;

// Setup helper: insert a token unconditionally via the capped sibling with an
// effectively unlimited cap (the only insert path now that the unconditional
// DAO was removed).
async function insertCliToken(
  db: D1Database,
  userId: number,
  tokenHash: string,
  tokenPrefix: string,
  scope: "read" | "write",
  expiresAt?: number,
): Promise<number> {
  const id = await mod.insertCliTokenIfBelowLimit(
    db,
    userId,
    tokenHash,
    tokenPrefix,
    scope,
    Number.MAX_SAFE_INTEGER,
    expiresAt,
  );
  if (id === null) throw new Error("insertCliTokenIfBelowLimit unexpectedly hit the cap in test setup");
  return id;
}

describe("auth/cli-tokens DAO", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/auth/cli-tokens";
    mod = (await import(modulePath)) as unknown as CliTokensDbModule;
    fakeDb = new FakeD1();
    fakeDb.addBusiness("biz-1");
    fakeDb.addUser(1, "biz-1", { login: "testuser", email: "test@example.com", github_id: 42162445 });
  });

  describe("insertCliTokenIfBelowLimit + findCliTokenByHash", () => {
    it("inserts a token and retrieves it by hash", async () => {
      const id = await insertCliToken(fakeDb as unknown as D1Database, 1, "hash123", "arc_abcd", "read");

      expect(id).toBeGreaterThan(0);
      expect(fakeDb.cliTokens.size).toBe(1);

      const found = await mod.findCliTokenByHash(fakeDb as unknown as D1Database, "hash123");
      expect(found).not.toBeNull();
      expect(found!.tokenId).toBe(id);
      expect(found!.scope).toBe("read");
      expect(found!.user.id).toBe(1);
      expect(found!.user.login).toBe("testuser");
      expect(found!.user.githubUserId).toBe(42162445);
      expect(found!.user.businessId).toBe("biz-1");
      expect(found!.user.sharedSessions).toBe(false);
      expect(found!.lastUsedAt).toBeNull();
    });

    it("returns sharedSessions true when business has it enabled", async () => {
      fakeDb.businesses.set("biz-1", { id: "biz-1", shared_sessions: 1 });
      await insertCliToken(fakeDb as unknown as D1Database, 1, "hash-shared", "arc_1234", "write");

      const found = await mod.findCliTokenByHash(fakeDb as unknown as D1Database, "hash-shared");
      expect(found).not.toBeNull();
      expect(found!.scope).toBe("write");
      expect(found!.user.sharedSessions).toBe(true);
    });
  });

  describe("findCliTokenByHash returns null for expired token", () => {
    it("returns null when expires_at is in the past", async () => {
      fakeDb.addCliToken({
        user_id: 1,
        token_hash: "expired-hash",
        expires_at: Date.now() - 1000,
      });

      const found = await mod.findCliTokenByHash(fakeDb as unknown as D1Database, "expired-hash");
      expect(found).toBeNull();
    });
  });

  describe("findCliTokenByHash returns null for revoked token", () => {
    it("returns null when revoked_at is set", async () => {
      fakeDb.addCliToken({
        user_id: 1,
        token_hash: "revoked-hash",
        revoked_at: Date.now() - 500,
      });

      const found = await mod.findCliTokenByHash(fakeDb as unknown as D1Database, "revoked-hash");
      expect(found).toBeNull();
    });
  });

  describe("listCliTokensByUser with pagination", () => {
    it("returns tokens in descending id order", async () => {
      for (let i = 0; i < 5; i++) {
        fakeDb.addCliToken({ user_id: 1, token_hash: `hash-${i}` });
      }

      const result = await mod.listCliTokensByUser(fakeDb as unknown as D1Database, 1, 3);
      expect(result.data).toHaveLength(3);
      expect(result.data.every((row) => row.scope === "read")).toBe(true);
      // IDs should be descending
      expect(result.data[0].id).toBeGreaterThan(result.data[1].id);
      expect(result.data[1].id).toBeGreaterThan(result.data[2].id);
      expect(result.nextCursor).not.toBeNull();
    });

    it("returns next page using cursor", async () => {
      for (let i = 0; i < 5; i++) {
        fakeDb.addCliToken({ user_id: 1, token_hash: `hash-${i}` });
      }

      const page1 = await mod.listCliTokensByUser(fakeDb as unknown as D1Database, 1, 3);
      expect(page1.data).toHaveLength(3);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await mod.listCliTokensByUser(fakeDb as unknown as D1Database, 1, 3, page1.nextCursor!);
      expect(page2.data).toHaveLength(2);
      expect(page2.nextCursor).toBeNull();

      // No overlap between pages
      const page1Ids = new Set(page1.data.map((d) => d.id));
      for (const row of page2.data) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });

    it("does not return tokens belonging to other users", async () => {
      fakeDb.addUser(2, "biz-1", { login: "otheruser" });
      fakeDb.addCliToken({ user_id: 1, token_hash: "hash-u1" });
      fakeDb.addCliToken({ user_id: 2, token_hash: "hash-u2" });

      const result = await mod.listCliTokensByUser(fakeDb as unknown as D1Database, 1, 50);
      expect(result.data).toHaveLength(1);
    });
  });

  describe("setRevokedAt", () => {
    it("sets revoked_at on the token", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-revoke" });
      expect(fakeDb.cliTokens.get(tokenId)!.revoked_at).toBeNull();

      await mod.setRevokedAt(fakeDb as unknown as D1Database, 1, tokenId);
      expect(fakeDb.cliTokens.get(tokenId)!.revoked_at).not.toBeNull();
    });

    it("does not revoke a token belonging to a different user", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-wrong-user" });

      await mod.setRevokedAt(fakeDb as unknown as D1Database, 999, tokenId);
      expect(fakeDb.cliTokens.get(tokenId)!.revoked_at).toBeNull();
    });
  });

  describe("findCliTokenByUserAndId", () => {
    it("returns the token scope for a token owned by the user", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-owned", scope: "write" });

      const result = await mod.findCliTokenByUserAndId(fakeDb as unknown as D1Database, 1, tokenId);

      expect(result).toEqual({ id: tokenId, scope: "write" });
    });

    it("returns null for a token owned by a different user", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-other-user", scope: "write" });

      const result = await mod.findCliTokenByUserAndId(fakeDb as unknown as D1Database, 999, tokenId);

      expect(result).toBeNull();
    });

    it("returns null for a revoked token", async () => {
      const tokenId = fakeDb.addCliToken({
        user_id: 1,
        token_hash: "hash-revoked-user-lookup",
        scope: "write",
        revoked_at: Date.now() - 1000,
      });

      const result = await mod.findCliTokenByUserAndId(fakeDb as unknown as D1Database, 1, tokenId);

      expect(result).toBeNull();
    });
  });

  describe("deleteCliTokenRow", () => {
    it("deletes the token row", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-delete" });
      expect(fakeDb.cliTokens.has(tokenId)).toBe(true);

      await mod.deleteCliTokenRow(fakeDb as unknown as D1Database, 1, tokenId);
      expect(fakeDb.cliTokens.has(tokenId)).toBe(false);
    });

    it("does not delete a token belonging to a different user", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-nodelete" });

      await mod.deleteCliTokenRow(fakeDb as unknown as D1Database, 999, tokenId);
      expect(fakeDb.cliTokens.has(tokenId)).toBe(true);
    });
  });

  describe("deleteExpiredCliTokens", () => {
    it("deletes expired, non-revoked tokens for the user", async () => {
      const expiredId = fakeDb.addCliToken({
        user_id: 1,
        token_hash: "hash-expired-delete",
        expires_at: Date.now() - 1000,
      });
      fakeDb.addCliToken({ user_id: 1, token_hash: "hash-live", expires_at: Date.now() + 1000 });
      fakeDb.addCliToken({
        user_id: 1,
        token_hash: "hash-revoked-expired",
        expires_at: Date.now() - 1000,
        revoked_at: Date.now() - 500,
      });

      await mod.deleteExpiredCliTokens(fakeDb as unknown as D1Database, 1);

      expect(fakeDb.cliTokens.has(expiredId)).toBe(false);
      expect(fakeDb.cliTokens.size).toBe(2);
    });
  });

  describe("updateLastUsedAt (conditional touch)", () => {
    const HOUR = 60 * 60 * 1000;

    it("writes last_used_at when it was null (first use)", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-used" });
      expect(fakeDb.cliTokens.get(tokenId)!.last_used_at).toBeNull();

      await mod.updateLastUsedAt(fakeDb as unknown as D1Database, tokenId, Date.now());
      expect(fakeDb.cliTokens.get(tokenId)!.last_used_at).not.toBeNull();
    });

    it("writes when the stored last_used_at is older than staleBefore", async () => {
      const stale = Date.now() - HOUR;
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-stale", last_used_at: stale });

      await mod.updateLastUsedAt(fakeDb as unknown as D1Database, tokenId, Date.now() - 5 * 60 * 1000);
      expect(fakeDb.cliTokens.get(tokenId)!.last_used_at).toBeGreaterThan(stale);
    });

    it("does NOT overwrite a last_used_at newer than staleBefore", async () => {
      const fresh = Date.now() - 1000;
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-fresh", last_used_at: fresh });

      await mod.updateLastUsedAt(fakeDb as unknown as D1Database, tokenId, Date.now() - 5 * 60 * 1000);
      expect(fakeDb.cliTokens.get(tokenId)!.last_used_at).toBe(fresh);
    });

    it("does NOT touch a revoked token", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-revoked", revoked_at: Date.now() - 1000 });

      await mod.updateLastUsedAt(fakeDb as unknown as D1Database, tokenId, Date.now());
      expect(fakeDb.cliTokens.get(tokenId)!.last_used_at).toBeNull();
    });

    it("does NOT touch an expired token", async () => {
      const tokenId = fakeDb.addCliToken({ user_id: 1, token_hash: "hash-expired", expires_at: Date.now() - 1000 });

      await mod.updateLastUsedAt(fakeDb as unknown as D1Database, tokenId, Date.now());
      expect(fakeDb.cliTokens.get(tokenId)!.last_used_at).toBeNull();
    });
  });
});
