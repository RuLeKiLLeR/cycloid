import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  deleteJiraUserSite,
  getJiraUserSite,
  markJiraPersonalDataReportAccountsFailed,
  upsertJiraUserSite,
} from "../../apps/control-plane-worker/src/integrations/db";
import {
  claimJiraIssueSessionRef,
  claimJiraIssueSkipNotice,
  deleteJiraIssueSessionRefIfSession,
  deleteJiraIssueSkipNotice,
  getJiraWebhookInstallationByBusiness,
  getJiraWebhookInstallationByToken,
  getSessionIdByJiraIssueRef,
  listNonRevokedJiraWebhookInstallations,
  markJiraWebhookInstallationDegraded,
  recordJiraWebhookRegistration,
  revokeJiraWebhookInstallationByBusiness,
  SKIP_NOTICE_DEDUP_TTL_MS,
  updateJiraWebhookInstallationExpiry,
  upsertJiraWebhookInstallation,
} from "../../apps/control-plane-worker/src/webhooks/db";

// Runs the real migration SQL against in-memory SQLite so the DAO statements
// are exercised against the actual schema, including the unique indexes.
class SqliteD1 {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.exec("CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY);");
    this.db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_integrations (
        user_id INTEGER NOT NULL,
        integration_id TEXT NOT NULL,
        external_user_id TEXT,
        connected_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (user_id, integration_id)
      );
    `);
    this.db.exec("INSERT INTO businesses (id) VALUES ('biz-1'), ('biz-2');");
    this.db.exec("INSERT INTO users (id) VALUES (42);");
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0151_jira_integration.sql"), "utf8"));
    this.db.exec(
      readFileSync(resolve("apps/control-plane-worker/migrations/0158_jira_personal_data_reporting.sql"), "utf8"),
    );
    this.db.exec(
      readFileSync(resolve("apps/control-plane-worker/migrations/0201_jira_issue_skip_notices.sql"), "utf8"),
    );
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

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

function makeDb(): D1Database {
  return new SqliteD1() as unknown as D1Database;
}

const INSTALL = {
  businessId: "biz-1",
  jiraCloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  siteName: "Acme",
  installationToken: "tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  connectedByUserId: 42,
};

describe("jira_webhook_installations DAOs", () => {
  it("upserts and resolves by token", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);

    const row = await getJiraWebhookInstallationByToken(db, INSTALL.installationToken);
    expect(row).not.toBeNull();
    expect(row?.businessId).toBe("biz-1");
    expect(row?.jiraCloudId).toBe("cloud-1");
    expect(row?.status).toBe("active");
    expect(row?.siteUrl).toBe(INSTALL.siteUrl);
  });

  it("returns null for unknown or empty token", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    expect(await getJiraWebhookInstallationByToken(db, "tok-other")).toBeNull();
    expect(await getJiraWebhookInstallationByToken(db, "")).toBeNull();
    expect(await getJiraWebhookInstallationByToken(db, null)).toBeNull();
  });

  it("rotates the installation token on re-upsert", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await upsertJiraWebhookInstallation(db, { ...INSTALL, installationToken: "tok-rotated" });

    expect(await getJiraWebhookInstallationByToken(db, INSTALL.installationToken)).toBeNull();
    const row = await getJiraWebhookInstallationByToken(db, "tok-rotated");
    expect(row?.businessId).toBe("biz-1");
  });

  it("does not resolve revoked installations by token", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    expect(await revokeJiraWebhookInstallationByBusiness(db, "biz-1")).toBe(true);
    expect(await getJiraWebhookInstallationByToken(db, INSTALL.installationToken)).toBeNull();
  });

  it("still resolves degraded installations by token (fail closed only on revoked)", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await markJiraWebhookInstallationDegraded(db, "biz-1", "cloud-1");
    const row = await getJiraWebhookInstallationByToken(db, INSTALL.installationToken);
    expect(row?.status).toBe("degraded");
  });

  it("records registration results and reactivates a degraded installation", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await markJiraWebhookInstallationDegraded(db, "biz-1", "cloud-1");

    const webhooksJson = JSON.stringify([{ webhookId: 7, events: ["jira:issue_created"], expiresAt: 1700000000000 }]);
    await recordJiraWebhookRegistration(db, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      webhooksJson,
      triggerLabel: "cycloid",
      webhookExpiresAt: 1700000000000,
    });

    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.status).toBe("active");
    expect(row?.webhooksJson).toBe(webhooksJson);
    expect(row?.triggerLabel).toBe("cycloid");
    expect(row?.webhookExpiresAt).toBe(1700000000000);
    expect(row?.webhookRegisteredAt).not.toBeNull();
  });

  it("updates expiry and reactivates after a successful refresh", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await markJiraWebhookInstallationDegraded(db, "biz-1", "cloud-1");
    await updateJiraWebhookInstallationExpiry(db, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      webhookExpiresAt: 1800000000000,
    });

    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.status).toBe("active");
    expect(row?.webhookExpiresAt).toBe(1800000000000);
  });

  it("never updates revoked installations", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await revokeJiraWebhookInstallationByBusiness(db, "biz-1");
    await recordJiraWebhookRegistration(db, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      webhooksJson: "[]",
      triggerLabel: "cycloid",
      webhookExpiresAt: 1,
    });

    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.status).toBe("revoked");
    expect(row?.webhooksJson).toBeNull();
  });

  it("revokeByBusiness returns false when nothing to revoke", async () => {
    const db = makeDb();
    expect(await revokeJiraWebhookInstallationByBusiness(db, "biz-1")).toBe(false);
  });

  it("enforces one non-revoked binding per Jira site across businesses", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await expect(
      upsertJiraWebhookInstallation(db, { ...INSTALL, businessId: "biz-2", installationToken: "tok-2" }),
    ).rejects.toThrow(/UNIQUE|idx_jira_webhook_installations_cloud_active/i);
  });

  it("allows rebinding a site after the previous binding is revoked", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await revokeJiraWebhookInstallationByBusiness(db, "biz-1");
    await upsertJiraWebhookInstallation(db, { ...INSTALL, businessId: "biz-2", installationToken: "tok-2" });

    const row = await getJiraWebhookInstallationByToken(db, "tok-2");
    expect(row?.businessId).toBe("biz-2");
  });

  it("lists only non-revoked installations", async () => {
    const db = makeDb();
    await upsertJiraWebhookInstallation(db, INSTALL);
    await upsertJiraWebhookInstallation(db, {
      ...INSTALL,
      businessId: "biz-2",
      jiraCloudId: "cloud-2",
      installationToken: "tok-2",
    });
    await revokeJiraWebhookInstallationByBusiness(db, "biz-1");

    const rows = await listNonRevokedJiraWebhookInstallations(db);
    expect(rows.map((r) => r.businessId)).toEqual(["biz-2"]);
  });
});

describe("jira_issue_session_refs DAOs", () => {
  it("first claim wins, duplicate claims lose", async () => {
    const db = makeDb();
    expect(await claimJiraIssueSessionRef(db, "cloud-1:10001", "sess-a")).toBe(true);
    expect(await claimJiraIssueSessionRef(db, "cloud-1:10001", "sess-b")).toBe(false);
    expect(await getSessionIdByJiraIssueRef(db, "cloud-1:10001")).toBe("sess-a");
  });

  it("rejects empty issue or session IDs", async () => {
    const db = makeDb();
    expect(await claimJiraIssueSessionRef(db, "", "sess-a")).toBe(false);
    expect(await claimJiraIssueSessionRef(db, "cloud-1:10001", "")).toBe(false);
  });

  it("deletes only when the session matches (stale-ref displacement guard)", async () => {
    const db = makeDb();
    await claimJiraIssueSessionRef(db, "cloud-1:10001", "sess-a");
    expect(await deleteJiraIssueSessionRefIfSession(db, "cloud-1:10001", "sess-other")).toBe(false);
    expect(await deleteJiraIssueSessionRefIfSession(db, "cloud-1:10001", "sess-a")).toBe(true);
    expect(await getSessionIdByJiraIssueRef(db, "cloud-1:10001")).toBeNull();
    expect(await claimJiraIssueSessionRef(db, "cloud-1:10001", "sess-b")).toBe(true);
  });
});

describe("jira_issue_skip_notices DAOs", () => {
  const ISSUE = "cloud-1:10001";

  it("returns true once per (issue, reason), false thereafter", async () => {
    const db = makeDb();
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown")).toBe(true);
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown")).toBe(false);
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "no_installation")).toBe(true);
  });

  it("rejects empty issue ids or reasons", async () => {
    const db = makeDb();
    expect(await claimJiraIssueSkipNotice(db, "", "repo_inference_unknown")).toBe(false);
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "")).toBe(false);
  });

  it("delete releases a claimed slot", async () => {
    const db = makeDb();
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown")).toBe(true);
    await deleteJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown");
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown")).toBe(true);
  });

  it("expires old dedup rows while preserving recent rows", async () => {
    const db = makeDb();
    const now = 1_800_000_000_000;

    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown", now - SKIP_NOTICE_DEDUP_TTL_MS)).toBe(
      true,
    );
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown", now)).toBe(true);
    expect(await claimJiraIssueSkipNotice(db, ISSUE, "repo_inference_unknown", now + 1)).toBe(false);
  });
});

describe("jira_user_sites DAOs", () => {
  it("upserts, reads, and deletes the selected site", async () => {
    const db = makeDb();
    await upsertJiraUserSite(db, {
      userId: 42,
      jiraCloudId: "cloud-1",
      siteUrl: "https://acme.atlassian.net",
      siteName: "Acme",
      jiraAccountId: "acct-1",
    });

    const site = await getJiraUserSite(db, 42);
    expect(site).toEqual({
      userId: 42,
      jiraCloudId: "cloud-1",
      siteUrl: "https://acme.atlassian.net",
      siteName: "Acme",
      jiraAccountId: "acct-1",
    });

    await deleteJiraUserSite(db, 42);
    expect(await getJiraUserSite(db, 42)).toBeNull();
  });

  it("reconnect switches the selected site (single site per user)", async () => {
    const db = makeDb();
    await upsertJiraUserSite(db, {
      userId: 42,
      jiraCloudId: "cloud-1",
      siteUrl: "https://acme.atlassian.net",
      jiraAccountId: "acct-1",
    });
    await upsertJiraUserSite(db, {
      userId: 42,
      jiraCloudId: "cloud-2",
      siteUrl: "https://other.atlassian.net",
      jiraAccountId: "acct-1",
    });

    const site = await getJiraUserSite(db, 42);
    expect(site?.jiraCloudId).toBe("cloud-2");
    expect(site?.siteName).toBeNull();
  });

  it("returns null for unknown users", async () => {
    const db = makeDb();
    expect(await getJiraUserSite(db, 999)).toBeNull();
  });
});

describe("jira_personal_data_reports DAOs", () => {
  it("writes next_report_after when marking accounts failed", async () => {
    const sqliteD1 = new SqliteD1();
    const db = sqliteD1 as unknown as D1Database;
    sqliteD1.db
      .prepare(
        `INSERT INTO jira_personal_data_reports (
          jira_account_id,
          personal_data_updated_at,
          last_reported_at,
          next_report_after,
          last_status,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("acct-1", 1_000, null, 2_000, "reported", null, 1_000, 1_000);

    await markJiraPersonalDataReportAccountsFailed(db, ["acct-1"], {
      error: "jira_reporting_http_503",
      now: 3_000,
      nextReportAfter: 4_000,
    });

    expect(
      sqliteD1.db
        .prepare(
          `SELECT next_report_after AS nextReportAfter,
                  last_status AS lastStatus,
                  last_error AS lastError,
                  updated_at AS updatedAt
             FROM jira_personal_data_reports
            WHERE jira_account_id = ?`,
        )
        .get("acct-1"),
    ).toEqual({
      nextReportAfter: 4_000,
      lastStatus: "failed",
      lastError: "jira_reporting_http_503",
      updatedAt: 3_000,
    });
  });
});
