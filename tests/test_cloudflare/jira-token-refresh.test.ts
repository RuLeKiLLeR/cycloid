import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearJiraTokens, getValidJiraToken } from "../../apps/control-plane-worker/src/auth/db";
import {
  deleteJiraUserDataByAccountIds,
  deleteUnreferencedJiraPersonalDataReportAccounts,
  getJiraTokens,
  getJiraUserSite,
  listJiraPersonalDataReportAccountIdsForUser,
  storeJiraTokens,
  upsertJiraPersonalDataReportAccount,
  upsertJiraUserSite,
} from "../../apps/control-plane-worker/src/integrations/db";

const ENCRYPTION_KEY = "test-token-encryption-key";
const ENV = {
  JIRA_OAUTH_CLIENT_ID: "client-id",
  JIRA_OAUTH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

class SqliteD1 {
  readonly db = new Database(":memory:");
  readonly queries: string[] = [];
  readonly boundValueCounts: number[] = [];

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
      CREATE TABLE jira_user_sites (
        user_id INTEGER PRIMARY KEY,
        jira_cloud_id TEXT NOT NULL,
        site_url TEXT NOT NULL,
        site_name TEXT,
        jira_account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE jira_personal_data_reports (
        jira_account_id TEXT PRIMARY KEY,
        personal_data_updated_at INTEGER NOT NULL,
        last_reported_at INTEGER,
        next_report_after INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_jira_personal_data_reports_due
        ON jira_personal_data_reports(next_report_after);
    `);
  }

  prepare(query: string) {
    this.queries.push(query);
    const d1 = this;
    const db = this.db;
    let values: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        values = bound;
        d1.boundValueCounts.push(bound.length);
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

  async batch<T>(statements: Array<{ run(): Promise<T> }>): Promise<T[]> {
    const results: T[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

function makeDb(): D1Database {
  return new SqliteD1() as unknown as D1Database;
}

function mockRefreshResponse(handler: () => Response): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("auth.atlassian.com/oauth/token")) {
      return handler();
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe("getValidJiraToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the stored token when it is not near expiry", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-fresh", "refresh-1", 3600, ENCRYPTION_KEY);

    const token = await getValidJiraToken(db, "1", ENV);
    expect(token).toBe("access-fresh");
  });

  it("returns null when no credential exists", async () => {
    const db = makeDb();
    expect(await getValidJiraToken(db, "1", ENV)).toBeNull();
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY); // inside 5-min buffer
    mockRefreshResponse(
      () =>
        new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }), {
          status: 200,
        }),
    );

    const token = await getValidJiraToken(db, "1", ENV);
    expect(token).toBe("access-new");

    const stored = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.accessToken).toBe("access-new");
    expect(stored?.refreshToken).toBe("refresh-new");
    expect((stored?.expiresAt ?? 0) > Date.now() + 30 * 60 * 1000).toBe(true);
  });

  it("does not clobber a concurrently rotated refresh token (CAS race)", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    // Capture the record as a concurrent caller would have seen it...
    const staleRecord = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    // ...then another refresh wins and rotates the stored pair.
    await storeJiraTokens(db, 1, "access-winner", "refresh-winner", 3600, ENCRYPTION_KEY);

    mockRefreshResponse(
      () =>
        new Response(
          JSON.stringify({ access_token: "access-loser", refresh_token: "refresh-loser", expires_in: 3600 }),
          { status: 200 },
        ),
    );

    const token = await getValidJiraToken(db, "1", ENV, staleRecord);
    // The loser's CAS write must not land; the winner's tokens are returned.
    expect(token).toBe("access-winner");
    const stored = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.accessToken).toBe("access-winner");
    expect(stored?.refreshToken).toBe("refresh-winner");
  });

  it("keeps the prior refresh token when the response omits one", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", "refresh-keep", 60, ENCRYPTION_KEY);
    mockRefreshResponse(
      () => new Response(JSON.stringify({ access_token: "access-new", expires_in: 3600 }), { status: 200 }),
    );

    const token = await getValidJiraToken(db, "1", ENV);
    expect(token).toBe("access-new");

    const stored = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.refreshToken).toBe("refresh-keep");
  });

  it("does not mark the credential invalid when a 4xx is caused by a lost refresh race", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", "refresh-old", 60, ENCRYPTION_KEY);
    const staleRecord = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    // A concurrent refresh wins and rotates the stored pair; Atlassian then
    // rejects our stale rotated token with a 4xx.
    await storeJiraTokens(db, 1, "access-winner", "refresh-winner", 3600, ENCRYPTION_KEY);
    mockRefreshResponse(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 403 }));

    const token = await getValidJiraToken(db, "1", ENV, staleRecord);
    expect(token).toBe("access-winner");

    const sqlite = (db as unknown as SqliteD1).db;
    const row = sqlite.prepare("SELECT last_validation_status FROM user_integrations WHERE user_id = 1").get() as {
      last_validation_status: string | null;
    };
    expect(row.last_validation_status).toBeNull();
  });

  it("marks the credential invalid on a 4xx refresh rejection", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", "refresh-revoked", 60, ENCRYPTION_KEY);
    mockRefreshResponse(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 403 }));

    const token = await getValidJiraToken(db, "1", ENV);
    expect(token).toBeNull();

    const sqlite = (db as unknown as SqliteD1).db;
    const row = sqlite
      .prepare("SELECT last_validation_status, oauth_refresh_token FROM user_integrations WHERE user_id = 1")
      .get() as { last_validation_status: string | null; oauth_refresh_token: string | null };
    expect(row.last_validation_status).toBe("invalid");
    // The row is kept for diagnostics, not cleared.
    expect(row.oauth_refresh_token).not.toBeNull();
  });

  it("preserves the refresh token on a transient 5xx failure", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", "refresh-keep", 60, ENCRYPTION_KEY);
    mockRefreshResponse(() => new Response("upstream broke", { status: 503 }));

    const token = await getValidJiraToken(db, "1", ENV);
    expect(token).toBeNull();

    const stored = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    expect(stored?.refreshToken).toBe("refresh-keep");
    const sqlite = (db as unknown as SqliteD1).db;
    const row = sqlite.prepare("SELECT last_validation_status FROM user_integrations WHERE user_id = 1").get() as {
      last_validation_status: string | null;
    };
    expect(row.last_validation_status).toBeNull();
  });

  it("marks the credential invalid when expired with no refresh token", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-old", null, 60, ENCRYPTION_KEY);

    const token = await getValidJiraToken(db, "1", ENV);
    expect(token).toBeNull();

    const sqlite = (db as unknown as SqliteD1).db;
    const row = sqlite.prepare("SELECT last_validation_status FROM user_integrations WHERE user_id = 1").get() as {
      last_validation_status: string | null;
    };
    expect(row.last_validation_status).toBe("invalid");
  });
});

describe("clearJiraTokens", () => {
  it("deletes the credential and the selected-site mapping together", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access", "refresh", 3600, ENCRYPTION_KEY, "acct-1");
    await upsertJiraUserSite(db, {
      userId: 1,
      jiraCloudId: "cloud-1",
      siteUrl: "https://acme.atlassian.net",
      jiraAccountId: "acct-1",
    });
    const sqlite = (db as unknown as SqliteD1).db;
    sqlite
      .prepare(
        `INSERT INTO jira_personal_data_reports (
          jira_account_id,
          personal_data_updated_at,
          next_report_after,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("acct-1", 1000, 0, 1000, 1000);

    await clearJiraTokens(db, "1");

    expect(await getJiraTokens(db, "1", ENCRYPTION_KEY)).toBeNull();
    expect(await getJiraUserSite(db, 1)).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jira_personal_data_reports").get()).toEqual({ count: 0 });
  });

  it("deletes Jira user data for multiple closed accounts with IN-clause batches", async () => {
    const db = makeDb();
    const sqliteD1 = db as unknown as SqliteD1;
    const sqlite = sqliteD1.db;
    await storeJiraTokens(db, 1, "access-1", "refresh-1", 3600, ENCRYPTION_KEY, "acct-1");
    await storeJiraTokens(db, 2, "access-2", "refresh-2", 3600, ENCRYPTION_KEY, "acct-2");
    await upsertJiraUserSite(db, {
      userId: 1,
      jiraCloudId: "cloud-1",
      siteUrl: "https://one.atlassian.net",
      jiraAccountId: "acct-1",
    });
    await upsertJiraUserSite(db, {
      userId: 2,
      jiraCloudId: "cloud-2",
      siteUrl: "https://two.atlassian.net",
      jiraAccountId: "acct-2",
    });
    await upsertJiraPersonalDataReportAccount(db, {
      jiraAccountId: "acct-1",
      personalDataUpdatedAt: 1000,
      now: 1000,
    });
    await upsertJiraPersonalDataReportAccount(db, {
      jiraAccountId: "acct-2",
      personalDataUpdatedAt: 2000,
      now: 2000,
    });
    sqliteD1.queries.length = 0;

    await deleteJiraUserDataByAccountIds(db, ["acct-1", "acct-2"]);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM user_integrations").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jira_user_sites").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jira_personal_data_reports").get()).toEqual({ count: 0 });
    expect(sqliteD1.queries.filter((query) => query.includes(" IN "))).toHaveLength(3);
    expect(sqliteD1.queries.filter((query) => query.includes("jira_account_id = ?"))).toHaveLength(0);
  });

  it("chunks Jira user data deletes at the D1 bound-parameter limit", async () => {
    const db = makeDb();
    const sqliteD1 = db as unknown as SqliteD1;
    const sqlite = sqliteD1.db;
    const accountIds = Array.from({ length: 101 }, (_, index) => `acct-${index + 1}`);

    for (const [index, accountId] of accountIds.entries()) {
      const userId = index + 1;
      await storeJiraTokens(db, userId, `access-${userId}`, `refresh-${userId}`, 3600, ENCRYPTION_KEY, accountId);
      await upsertJiraUserSite(db, {
        userId,
        jiraCloudId: `cloud-${userId}`,
        siteUrl: `https://site-${userId}.atlassian.net`,
        jiraAccountId: accountId,
      });
      await upsertJiraPersonalDataReportAccount(db, {
        jiraAccountId: accountId,
        personalDataUpdatedAt: 1000 + userId,
        now: 1000 + userId,
      });
    }
    sqliteD1.queries.length = 0;
    sqliteD1.boundValueCounts.length = 0;

    await deleteJiraUserDataByAccountIds(db, accountIds);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM user_integrations").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jira_user_sites").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jira_personal_data_reports").get()).toEqual({ count: 0 });
    expect(sqliteD1.queries.filter((query) => query.includes(" IN "))).toHaveLength(6);
    expect(Math.max(...sqliteD1.boundValueCounts)).toBeLessThanOrEqual(100);
    // Setup encrypts 101 token pairs sequentially; under loaded CI workers this
    // can exceed the 5s default and flake. Give the heavy fixture headroom.
  }, 30_000);

  it("preserves a reporting row when another user still references the account", async () => {
    const db = makeDb();
    const sqlite = (db as unknown as SqliteD1).db;
    await storeJiraTokens(db, 1, "access", "refresh", 3600, ENCRYPTION_KEY, "acct-1");
    await upsertJiraUserSite(db, {
      userId: 1,
      jiraCloudId: "cloud-1",
      siteUrl: "https://acme.atlassian.net",
      jiraAccountId: "acct-1",
    });
    await upsertJiraUserSite(db, {
      userId: 2,
      jiraCloudId: "cloud-1",
      siteUrl: "https://acme.atlassian.net",
      jiraAccountId: "acct-1",
    });
    sqlite
      .prepare(
        `INSERT INTO jira_personal_data_reports (
          jira_account_id,
          personal_data_updated_at,
          next_report_after,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("acct-1", 1000, 0, 1000, 1000);

    await clearJiraTokens(db, "1");

    expect(await getJiraTokens(db, "1", ENCRYPTION_KEY)).toBeNull();
    expect(await getJiraUserSite(db, 1)).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jira_personal_data_reports").get()).toEqual({ count: 1 });
  });

  it("enforces account dedup through the external_user_id unique index", async () => {
    const db = makeDb();
    await storeJiraTokens(db, 1, "access-a", "refresh-a", 3600, ENCRYPTION_KEY, "acct-shared");
    await expect(storeJiraTokens(db, 2, "access-b", "refresh-b", 3600, ENCRYPTION_KEY, "acct-shared")).rejects.toThrow(
      /UNIQUE/i,
    );
  });

  it("deletes stale reporting rows when a reconnect switches accounts", async () => {
    const db = makeDb();
    const sqlite = (db as unknown as SqliteD1).db;
    await storeJiraTokens(db, 1, "access-old", "refresh-old", 3600, ENCRYPTION_KEY, "acct-old");
    await upsertJiraUserSite(db, {
      userId: 1,
      jiraCloudId: "cloud-old",
      siteUrl: "https://old.atlassian.net",
      jiraAccountId: "acct-old",
    });
    await upsertJiraPersonalDataReportAccount(db, {
      jiraAccountId: "acct-old",
      personalDataUpdatedAt: 1000,
      now: 1000,
    });

    const previousAccountIds = await listJiraPersonalDataReportAccountIdsForUser(db, 1);
    await storeJiraTokens(db, 1, "access-new", "refresh-new", 3600, ENCRYPTION_KEY, "acct-new");
    await upsertJiraUserSite(db, {
      userId: 1,
      jiraCloudId: "cloud-new",
      siteUrl: "https://new.atlassian.net",
      jiraAccountId: "acct-new",
    });
    await upsertJiraPersonalDataReportAccount(db, {
      jiraAccountId: "acct-new",
      personalDataUpdatedAt: 2000,
      now: 2000,
    });
    await deleteUnreferencedJiraPersonalDataReportAccounts(
      db,
      previousAccountIds.filter((accountId) => accountId !== "acct-new"),
    );

    expect(
      sqlite.prepare("SELECT jira_account_id FROM jira_personal_data_reports ORDER BY jira_account_id").all(),
    ).toEqual([{ jira_account_id: "acct-new" }]);
  });
});
