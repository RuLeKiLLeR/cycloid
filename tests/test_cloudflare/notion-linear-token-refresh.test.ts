import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getValidLinearToken, getValidNotionToken } from "../../apps/control-plane-worker/src/auth/db";
import {
  getLinearTokens,
  getNotionTokens,
  storeLinearTokens,
  storeNotionTokens,
} from "../../apps/control-plane-worker/src/integrations/db";

const ENCRYPTION_KEY = "test-token-encryption-key";
const LINEAR_ENV = {
  LINEAR_OAUTH_CLIENT_ID: "client-id",
  LINEAR_OAUTH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
};
const NOTION_ENV = {
  NOTION_OAUTH_CLIENT_ID: "client-id",
  NOTION_OAUTH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

class SqliteD1 {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.exec(`
      CREATE TABLE user_integrations (
        user_id INTEGER NOT NULL,
        integration_id TEXT NOT NULL,
        oauth_access_token TEXT,
        oauth_refresh_token TEXT,
        oauth_expires_at INTEGER,
        api_key TEXT,
        external_user_id TEXT,
        service_url TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        last_validated_at INTEGER,
        last_validation_status TEXT,
        last_validation_reason_code TEXT,
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, integration_id)
      );
      CREATE UNIQUE INDEX idx_user_integrations_external_user
        ON user_integrations(integration_id, external_user_id)
        WHERE external_user_id IS NOT NULL;
    `);
  }

  prepare(query: string) {
    const db = this.db;
    let values: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        values = bound;
        return this;
      },
      async run() {
        const info = db.prepare(query).run(...values);
        return { success: true as const, meta: { changes: info.changes } };
      },
      async first<T>() {
        return (db.prepare(query).get(...values) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: db.prepare(query).all(...values) as T[] };
      },
    };
  }
}

function makeDb(): D1Database {
  return new SqliteD1() as unknown as D1Database;
}

function rowFor(db: D1Database, userId: number, integrationId: string) {
  return (db as unknown as SqliteD1).db
    .prepare(
      "SELECT oauth_access_token, oauth_refresh_token FROM user_integrations WHERE user_id = ? AND integration_id = ?",
    )
    .get(userId, integrationId) as
    { oauth_access_token: string | null; oauth_refresh_token: string | null } | undefined;
}

/**
 * Routes the OAuth token endpoint to the supplied handler, answers Linear's
 * post-refresh viewer probe with a healthy response, and returns a benign 200
 * for any other call (e.g. remote token revocation during clear).
 */
function mockTokenEndpoint(tokenUrlFragment: string, handler: () => Response): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes(tokenUrlFragment)) {
      return handler();
    }
    if (url.includes("api.linear.app/graphql")) {
      return new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

describe("getValidLinearToken refresh CAS", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    const db = makeDb();
    await storeLinearTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY); // within 5-min buffer
    mockTokenEndpoint(
      "api.linear.app/oauth/token",
      () =>
        new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 86400 }), {
          status: 200,
        }),
    );

    const token = await getValidLinearToken(db, "1", LINEAR_ENV);
    expect(token).toBe("access-new");

    const stored = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.accessToken).toBe("access-new");
    expect(stored?.refreshToken).toBe("refresh-new");
  });

  it("does not clobber a concurrently rotated refresh token (CAS race)", async () => {
    const db = makeDb();
    await storeLinearTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const staleRecord = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    // A concurrent refresh wins and rotates the stored pair before we persist.
    await storeLinearTokens(db, 1, "access-winner", "refresh-winner", 86400, ENCRYPTION_KEY);

    mockTokenEndpoint(
      "api.linear.app/oauth/token",
      () =>
        new Response(
          JSON.stringify({ access_token: "access-loser", refresh_token: "refresh-loser", expires_in: 86400 }),
          { status: 200 },
        ),
    );

    const token = await getValidLinearToken(db, "1", LINEAR_ENV, staleRecord);
    expect(token).toBe("access-winner");
    const stored = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.accessToken).toBe("access-winner");
    expect(stored?.refreshToken).toBe("refresh-winner");
  });

  it("does not clear tokens when a 4xx is caused by a lost refresh race", async () => {
    const db = makeDb();
    await storeLinearTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const staleRecord = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    await storeLinearTokens(db, 1, "access-winner", "refresh-winner", 86400, ENCRYPTION_KEY);
    mockTokenEndpoint(
      "api.linear.app/oauth/token",
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const token = await getValidLinearToken(db, "1", LINEAR_ENV, staleRecord);
    expect(token).toBe("access-winner");
    // The winner's row must survive: a lost race is not a dead grant.
    expect(rowFor(db, 1, "linear")).toBeDefined();
  });

  it("clears tokens on a genuine 4xx refresh rejection", async () => {
    const db = makeDb();
    await storeLinearTokens(db, 1, "access-old", "refresh-revoked", 60, ENCRYPTION_KEY);
    mockTokenEndpoint(
      "api.linear.app/oauth/token",
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const token = await getValidLinearToken(db, "1", LINEAR_ENV);
    expect(token).toBeNull();
    expect(rowFor(db, 1, "linear")).toBeUndefined();
  });

  it("CAS-refreshes from snapshot-style preloaded tokens carrying refreshTokenCiphertext", async () => {
    // Mirrors the production spawn path, where preloadedTokens come from
    // the spawn snapshot token reader and carry the stored ciphertext as the CAS key.
    const db = makeDb();
    await storeLinearTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const preloaded = {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: 1, // expired -> forces the refresh path
      refreshTokenCiphertext: rowFor(db, 1, "linear")!.oauth_refresh_token,
    };
    mockTokenEndpoint(
      "api.linear.app/oauth/token",
      () =>
        new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 86400 }), {
          status: 200,
        }),
    );

    const token = await getValidLinearToken(db, "1", LINEAR_ENV, preloaded);
    expect(token).toBe("access-new");
    const after = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    expect(after?.refreshToken).toBe("refresh-new");
  });
});

describe("getValidNotionToken refresh CAS", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    const db = makeDb();
    await storeNotionTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    mockTokenEndpoint(
      "api.notion.com/v1/oauth/token",
      () =>
        new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }), {
          status: 200,
        }),
    );

    const token = await getValidNotionToken(db, "1", NOTION_ENV);
    expect(token).toBe("access-new");

    const stored = await getNotionTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.accessToken).toBe("access-new");
    expect(stored?.refreshToken).toBe("refresh-new");
  });

  it("does not clobber a concurrently rotated refresh token (CAS race)", async () => {
    const db = makeDb();
    await storeNotionTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const staleRecord = await getNotionTokens(db, "1", ENCRYPTION_KEY);
    await storeNotionTokens(db, 1, "access-winner", "refresh-winner", 3600, ENCRYPTION_KEY);

    mockTokenEndpoint(
      "api.notion.com/v1/oauth/token",
      () =>
        new Response(
          JSON.stringify({ access_token: "access-loser", refresh_token: "refresh-loser", expires_in: 3600 }),
          { status: 200 },
        ),
    );

    const token = await getValidNotionToken(db, "1", NOTION_ENV, staleRecord);
    expect(token).toBe("access-winner");
    const stored = await getNotionTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.accessToken).toBe("access-winner");
    expect(stored?.refreshToken).toBe("refresh-winner");
  });

  it("does not clear tokens when a 4xx is caused by a lost refresh race", async () => {
    const db = makeDb();
    await storeNotionTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const staleRecord = await getNotionTokens(db, "1", ENCRYPTION_KEY);
    await storeNotionTokens(db, 1, "access-winner", "refresh-winner", 3600, ENCRYPTION_KEY);
    mockTokenEndpoint(
      "api.notion.com/v1/oauth/token",
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const token = await getValidNotionToken(db, "1", NOTION_ENV, staleRecord);
    expect(token).toBe("access-winner");
    expect(rowFor(db, 1, "notion")).toBeDefined();
  });

  it("clears tokens on a genuine 4xx refresh rejection", async () => {
    const db = makeDb();
    await storeNotionTokens(db, 1, "access-old", "refresh-revoked", 60, ENCRYPTION_KEY);
    mockTokenEndpoint(
      "api.notion.com/v1/oauth/token",
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const token = await getValidNotionToken(db, "1", NOTION_ENV);
    expect(token).toBeNull();
    expect(rowFor(db, 1, "notion")).toBeUndefined();
  });

  it("CAS-refreshes from snapshot-style preloaded tokens carrying refreshTokenCiphertext", async () => {
    const db = makeDb();
    await storeNotionTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const preloaded = {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: 1, // expired -> forces the refresh path
      refreshTokenCiphertext: rowFor(db, 1, "notion")!.oauth_refresh_token,
    };
    mockTokenEndpoint(
      "api.notion.com/v1/oauth/token",
      () =>
        new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }), {
          status: 200,
        }),
    );

    const token = await getValidNotionToken(db, "1", NOTION_ENV, preloaded);
    expect(token).toBe("access-new");
    const after = await getNotionTokens(db, "1", ENCRYPTION_KEY);
    expect(after?.refreshToken).toBe("refresh-new");
  });
});
