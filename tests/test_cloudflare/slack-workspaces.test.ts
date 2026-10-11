import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tracedFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: tracedFetchMock,
}));

import { encrypt } from "../../apps/control-plane-worker/src/settings/encryption.js";
import { installSlackWorkspaceFromCode } from "../../apps/control-plane-worker/src/slack/workspace-install.js";
import {
  detectWorkspaceAlertSenders,
  getActiveWorkspaceInstallForBusiness,
  getBotTokenForTeam,
  getSoleActiveWorkspaceInstallForBusiness,
  listWorkspaceChannels,
  listWorkspaceInstallMetadataForBusiness,
  storeWorkspaceInstall,
} from "../../apps/control-plane-worker/src/slack/workspaces.js";

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

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: result.changes } };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

interface SlackWorkspaceStoredRow {
  team_id: string;
  bot_token_encrypted: string;
  bot_user_id: string;
  team_name: string | null;
  business_id: string | null;
  team_domain: string | null;
  enterprise_id: string | null;
  installed_by_user_id: number | null;
  installed_at: number;
  updated_at: number;
  uninstalled_at: number | null;
}

const encryptionKey = "test-token-encryption-key";

let sqlite: Database.Database;
let db: D1Database;

function getStoredRow(teamId: string): SlackWorkspaceStoredRow | null {
  return (
    (sqlite.prepare("SELECT * FROM slack_workspaces WHERE team_id = ?").get(teamId) as
      SlackWorkspaceStoredRow | undefined) ?? null
  );
}

function markWorkspaceUninstalledFixture(teamId: string, uninstalledAt: number): void {
  sqlite
    .prepare("UPDATE slack_workspaces SET uninstalled_at = ?, updated_at = ? WHERE team_id = ?")
    .run(uninstalledAt, uninstalledAt, teamId);
}

beforeEach(() => {
  tracedFetchMock.mockReset();
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      business_id TEXT
    );

    CREATE TABLE slack_workspaces (
      team_id TEXT PRIMARY KEY,
      bot_token_encrypted TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      team_name TEXT,
      business_id TEXT,
      team_domain TEXT,
      enterprise_id TEXT,
      installed_by_user_id INTEGER REFERENCES users(id),
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      uninstalled_at INTEGER
    );
  `);
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("slack/workspaces DAO", () => {
  it("stores encrypted workspace bot tokens and returns the decrypted token", async () => {
    sqlite.prepare("INSERT INTO users (id) VALUES (?)").run(42);

    await storeWorkspaceInstall(
      db,
      {
        teamId: " T123 ",
        botToken: " xoxb-customer-token ",
        botUserId: " U_BOT ",
        teamName: " Customer Workspace ",
        installedByUserId: 42,
        installedAt: 1_700_000_000_000,
      },
      encryptionKey,
    );

    const row = getStoredRow("T123");
    expect(row).toMatchObject({
      team_id: "T123",
      bot_user_id: "U_BOT",
      team_name: "Customer Workspace",
      installed_by_user_id: 42,
      installed_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      uninstalled_at: null,
    });
    expect(row?.bot_token_encrypted).not.toBe("xoxb-customer-token");
    expect(row?.bot_token_encrypted.startsWith("enc:")).toBe(true);

    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBe("xoxb-customer-token");
  });

  it("detects Slack alert sender app and bot IDs from recent channel history", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-customer-token",
        botUserId: "U_CYCLOID",
        teamName: "Customer Workspace",
        businessId: "biz-1",
      },
      encryptionKey,
    );
    tracedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              type: "message",
              subtype: "bot_message",
              ts: "1712345679.000100",
              text: "Datadog monitor triggered",
              app_id: "A_DATADOG",
              bot_id: "B_DATADOG",
              bot_profile: { id: "B_DATADOG", app_id: "A_DATADOG", name: "Datadog" },
            },
            {
              type: "message",
              subtype: "bot_message",
              ts: "1712345678.000100",
              thread_ts: "1712345000.000100",
              text: "Thread reply should not be sampled",
              app_id: "A_DATADOG",
              bot_id: "B_DATADOG",
            },
            {
              type: "message",
              ts: "1712345677.000100",
              text: "human message",
              user: "U_HUMAN",
            },
          ],
        }),
      ),
    );

    await expect(
      detectWorkspaceAlertSenders(
        db,
        { businessId: "biz-1", teamId: "T123", channelId: "C_ALERTS", provider: "datadog" },
        encryptionKey,
      ),
    ).resolves.toEqual([
      {
        appId: "A_DATADOG",
        botId: "B_DATADOG",
        botName: "Datadog",
        sampleTs: "1712345679.000100",
        messageCount: 1,
      },
    ]);

    expect(tracedFetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.history?channel=C_ALERTS&limit=100",
      {
        method: "GET",
        headers: { authorization: "Bearer xoxb-customer-token" },
      },
      "slack.conversations.history",
    );
  });

  it("returns null when a workspace install is missing", async () => {
    await expect(getBotTokenForTeam(db, "T_MISSING", encryptionKey)).resolves.toBeNull();
  });

  it("fails closed when an encrypted workspace token is read without an encryption key", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-customer-token",
        botUserId: "U_BOT",
      },
      encryptionKey,
    );

    await expect(getBotTokenForTeam(db, "T123", undefined)).resolves.toBeNull();
  });

  it("fails closed when a workspace token row is not encrypted", async () => {
    sqlite
      .prepare(
        `INSERT INTO slack_workspaces (
          team_id,
          bot_token_encrypted,
          bot_user_id,
          installed_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("T123", "xoxb-plaintext-token", "U_BOT", 1, 1);

    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBeNull();
  });

  it("returns null for corrupt encrypted workspace token payloads", async () => {
    const encryptedToken = await encrypt("xoxb-customer-token", encryptionKey);
    const lastChar = encryptedToken.at(-1)!;
    const flippedLastChar = lastChar === "0" ? "1" : "0";
    const corruptToken = `${encryptedToken.slice(0, -1)}${flippedLastChar}`;
    sqlite
      .prepare(
        `INSERT INTO slack_workspaces (
          team_id,
          bot_token_encrypted,
          bot_user_id,
          installed_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("T123", corruptToken, "U_BOT", 1, 1);

    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBeNull();
  });

  it("returns null when decrypt returns a malformed enc-prefixed payload unchanged", async () => {
    sqlite
      .prepare(
        `INSERT INTO slack_workspaces (
          team_id,
          bot_token_encrypted,
          bot_user_id,
          installed_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("T123", "enc:malformed", "U_BOT", 1, 1);

    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBeNull();
  });

  it("reinstalling a workspace refreshes token metadata and clears uninstalled_at", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-old-token",
        botUserId: "U_OLD_BOT",
        teamName: "Old Name",
        installedAt: 100,
      },
      encryptionKey,
    );
    sqlite
      .prepare("UPDATE slack_workspaces SET uninstalled_at = ?, updated_at = ? WHERE team_id = ?")
      .run(200, 200, "T123");

    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-new-token",
        botUserId: "U_NEW_BOT",
        teamName: "New Name",
        installedAt: 300,
      },
      encryptionKey,
    );

    expect(getStoredRow("T123")).toMatchObject({
      bot_user_id: "U_NEW_BOT",
      team_name: "New Name",
      installed_at: 300,
      updated_at: 300,
      uninstalled_at: null,
    });
    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBe("xoxb-new-token");
  });

  it("atomically rejects changing an active workspace business", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id) VALUES (?, ?), (?, ?)").run(42, "biz-A", 43, "biz-B");
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-old-token",
        botUserId: "U_OLD_BOT",
        teamName: "Old Name",
        businessId: "biz-A",
        installedByUserId: 42,
        installedAt: 100,
      },
      encryptionKey,
    );

    await expect(
      storeWorkspaceInstall(
        db,
        {
          teamId: "T123",
          botToken: "xoxb-new-token",
          botUserId: "U_NEW_BOT",
          teamName: "New Name",
          businessId: "biz-B",
          installedByUserId: 43,
          installedAt: 300,
        },
        encryptionKey,
      ),
    ).rejects.toThrow("Slack workspace is already installed for a different business");

    expect(getStoredRow("T123")).toMatchObject({
      bot_user_id: "U_OLD_BOT",
      team_name: "Old Name",
      business_id: "biz-A",
      installed_by_user_id: 42,
      installed_at: 100,
    });
    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBe("xoxb-old-token");
  });

  it("atomically rejects a second distinct active workspace for the same business at the write", async () => {
    // No application pre-check involved here: the guard must hold inside
    // storeWorkspaceInstall itself so concurrent installs cannot race past it.
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T_FIRST",
        botToken: "xoxb-first",
        botUserId: "U_FIRST",
        businessId: "biz-A",
        installedAt: 100,
      },
      encryptionKey,
    );

    await expect(
      storeWorkspaceInstall(
        db,
        {
          teamId: "T_SECOND",
          botToken: "xoxb-second",
          botUserId: "U_SECOND",
          businessId: "biz-A",
          installedAt: 200,
        },
        encryptionKey,
      ),
    ).rejects.toThrow("This business already has an active Slack workspace install");

    expect(getStoredRow("T_SECOND")).toBeNull();

    // A business with no active install (e.g. after uninstall) can store a
    // different workspace.
    markWorkspaceUninstalledFixture("T_FIRST", 300);
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T_SECOND",
        botToken: "xoxb-second",
        botUserId: "U_SECOND",
        businessId: "biz-A",
        installedAt: 400,
      },
      encryptionKey,
    );
    expect(getStoredRow("T_SECOND")).toMatchObject({ business_id: "biz-A", uninstalled_at: null });
  });

  it("requires TOKEN_ENCRYPTION_KEY when storing workspace bot tokens", async () => {
    await expect(
      storeWorkspaceInstall(
        db,
        {
          teamId: "T123",
          botToken: "xoxb-customer-token",
          botUserId: "U_BOT",
        },
        undefined,
      ),
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY is required to store Slack workspace bot tokens");
  });

  it("lists Slack workspace metadata for one business without bot tokens", async () => {
    // A business holds at most one active install, but historical uninstalled
    // rows remain listed.
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-B",
        botToken: "xoxb-b",
        botUserId: "U_BOT_B",
        teamName: "Beta",
        businessId: "biz-1",
        teamDomain: "beta",
      },
      encryptionKey,
    );
    markWorkspaceUninstalledFixture("T-B", 200);
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-A",
        botToken: "xoxb-a",
        botUserId: "U_BOT_A",
        teamName: "Alpha",
        businessId: "biz-1",
        teamDomain: "alpha",
      },
      encryptionKey,
    );
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-OTHER",
        botToken: "xoxb-other",
        botUserId: "U_BOT_OTHER",
        businessId: "biz-2",
      },
      encryptionKey,
    );

    await expect(listWorkspaceInstallMetadataForBusiness(db, "biz-1")).resolves.toEqual([
      expect.objectContaining({
        teamId: "T-A",
        botUserId: "U_BOT_A",
        teamName: "Alpha",
        teamDomain: "alpha",
        businessId: "biz-1",
        installedAt: expect.any(Number),
        uninstalledAt: null,
      }),
      expect.objectContaining({
        teamId: "T-B",
        botUserId: "U_BOT_B",
        teamName: "Beta",
        teamDomain: "beta",
        businessId: "biz-1",
        installedAt: expect.any(Number),
        uninstalledAt: 200,
      }),
    ]);
  });

  it("returns the active workspace install for a business", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-A",
        botToken: "xoxb-a",
        botUserId: "U_BOT_A",
        teamName: "Alpha",
        businessId: "biz-1",
        installedAt: 1_700_000_000_000,
      },
      encryptionKey,
    );

    await expect(getActiveWorkspaceInstallForBusiness(db, "biz-1")).resolves.toMatchObject({
      teamId: "T-A",
      teamName: "Alpha",
      businessId: "biz-1",
      installedAt: 1_700_000_000_000,
      uninstalledAt: null,
    });
    await expect(getActiveWorkspaceInstallForBusiness(db, "biz-2")).resolves.toBeNull();
  });

  it("treats an uninstalled-only business as having no active workspace install", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-A",
        botToken: "xoxb-a",
        botUserId: "U_BOT_A",
        businessId: "biz-1",
      },
      encryptionKey,
    );
    markWorkspaceUninstalledFixture("T-A", 200);

    await expect(getActiveWorkspaceInstallForBusiness(db, "biz-1")).resolves.toBeNull();
  });

  it("returns the sole active workspace install only when exactly one exists", async () => {
    await storeWorkspaceInstall(
      db,
      { teamId: "T-A", botToken: "xoxb-a", botUserId: "U_BOT_A", businessId: "biz-1" },
      encryptionKey,
    );
    await expect(getSoleActiveWorkspaceInstallForBusiness(db, "biz-1")).resolves.toMatchObject({ teamId: "T-A" });

    await storeWorkspaceInstall(
      db,
      { teamId: "T-B", botToken: "xoxb-b", botUserId: "U_BOT_B", businessId: "biz-2" },
      encryptionKey,
    );
    await expect(getSoleActiveWorkspaceInstallForBusiness(db, "biz-2")).resolves.toMatchObject({ teamId: "T-B" });
    await expect(getSoleActiveWorkspaceInstallForBusiness(db, "missing")).resolves.toBeNull();
  });

  it("fails closed when a business has multiple active workspace installs", async () => {
    await storeWorkspaceInstall(
      db,
      { teamId: "T-A", botToken: "xoxb-a", botUserId: "U_BOT_A", businessId: "biz-1" },
      encryptionKey,
    );
    // Seed directly because storeWorkspaceInstall intentionally prevents this state.
    sqlite
      .prepare(
        "INSERT INTO slack_workspaces (team_id, bot_token_encrypted, bot_user_id, business_id, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("T-B", "enc:token", "U_BOT_B", "biz-1", 1, 1);
    await expect(getSoleActiveWorkspaceInstallForBusiness(db, "biz-1")).resolves.toBeNull();
  });

  it("lists accessible public and private Slack channels for a business workspace", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-A",
        botToken: "xoxb-a",
        botUserId: "U_BOT_A",
        teamName: "Alpha",
        businessId: "biz-1",
      },
      encryptionKey,
    );
    tracedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          channels: [
            { id: "C2", name: "zeta", is_channel: true, is_private: false, is_member: true },
            { id: "G1", name: "private-plans", is_group: true, is_private: true, is_member: true },
            { id: "D1", name: "dm", is_im: true },
            { id: "C3", name: "archived", is_channel: true, is_archived: true },
            { id: "C1", name: "alpha", is_channel: true, is_private: false, is_member: false },
          ],
          response_metadata: { next_cursor: "" },
        }),
      ),
    );

    await expect(listWorkspaceChannels(db, { businessId: "biz-1", teamId: "T-A" }, encryptionKey)).resolves.toEqual([
      { id: "C1", name: "alpha", isPrivate: false, isMember: false },
      { id: "C2", name: "zeta", isPrivate: false, isMember: true },
      { id: "G1", name: "private-plans", isPrivate: true, isMember: true },
    ]);
    expect(tracedFetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.list?types=public_channel%2Cprivate_channel&exclude_archived=true&limit=200",
      { method: "GET", headers: { authorization: "Bearer xoxb-a" } },
      "slack.conversations.list",
    );
  });

  it("does not list channels for a workspace owned by another business", async () => {
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T-A",
        botToken: "xoxb-a",
        botUserId: "U_BOT_A",
        businessId: "biz-2",
      },
      encryptionKey,
    );

    await expect(listWorkspaceChannels(db, { businessId: "biz-1", teamId: "T-A" }, encryptionKey)).resolves.toEqual([]);
    expect(tracedFetchMock).not.toHaveBeenCalled();
  });
});

describe("Slack workspace install OAuth", () => {
  it("stores installer business, team domain, and enterprise id from Slack install metadata", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id) VALUES (?, ?)").run(42, "biz-A");
    tracedFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-customer-token",
            bot_user_id: "U_BOT",
            team: { id: "T123", name: "Customer Workspace" },
            enterprise: { id: "E123" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, team: { domain: "customer-domain" } })));

    await expect(
      installSlackWorkspaceFromCode(
        {
          DB: db,
          TOKEN_ENCRYPTION_KEY: encryptionKey,
          SLACK_CLIENT_ID: "client-id",
          SLACK_CLIENT_SECRET: "client-secret",
        } as never,
        "oauth-code",
        42,
        "https://app.example.test/auth/slack/install/callback",
      ),
    ).resolves.toEqual({
      teamId: "T123",
      teamName: "Customer Workspace",
      botUserId: "U_BOT",
    });

    expect(tracedFetchMock).toHaveBeenNthCalledWith(
      2,
      "https://slack.com/api/team.info",
      { headers: { authorization: "Bearer xoxb-customer-token" } },
      "slack.workspaceInstall.teamInfo",
    );
    expect(getStoredRow("T123")).toMatchObject({
      business_id: "biz-A",
      team_domain: "customer-domain",
      enterprise_id: "E123",
      installed_by_user_id: 42,
    });
  });

  it("rejects reinstalling an existing workspace under a different business", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id) VALUES (?, ?), (?, ?)").run(42, "biz-A", 43, "biz-B");
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-old-token",
        botUserId: "U_OLD_BOT",
        teamName: "Customer Workspace",
        businessId: "biz-A",
        installedByUserId: 42,
        installedAt: 100,
      },
      encryptionKey,
    );
    tracedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-new-token",
          bot_user_id: "U_NEW_BOT",
          team: { id: "T123", name: "Customer Workspace" },
        }),
        { status: 200 },
      ),
    );

    await expect(
      installSlackWorkspaceFromCode(
        {
          DB: db,
          TOKEN_ENCRYPTION_KEY: encryptionKey,
          SLACK_CLIENT_ID: "client-id",
          SLACK_CLIENT_SECRET: "client-secret",
        } as never,
        "oauth-code",
        43,
        "https://app.example.test/auth/slack/install/callback",
      ),
    ).rejects.toThrow("Slack workspace is already installed for a different business");

    expect(tracedFetchMock).toHaveBeenCalledTimes(1);
    expect(getStoredRow("T123")).toMatchObject({
      bot_user_id: "U_OLD_BOT",
      business_id: "biz-A",
      installed_by_user_id: 42,
      installed_at: 100,
    });
    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBe("xoxb-old-token");
  });

  it("rejects installing a second distinct workspace while the business has an active one", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id) VALUES (?, ?)").run(42, "biz-A");
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T_FIRST",
        botToken: "xoxb-first-token",
        botUserId: "U_FIRST_BOT",
        teamName: "First Workspace",
        businessId: "biz-A",
        installedByUserId: 42,
        installedAt: 100,
      },
      encryptionKey,
    );
    tracedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-second-token",
          bot_user_id: "U_SECOND_BOT",
          team: { id: "T_SECOND", name: "Second Workspace" },
        }),
        { status: 200 },
      ),
    );

    await expect(
      installSlackWorkspaceFromCode(
        {
          DB: db,
          TOKEN_ENCRYPTION_KEY: encryptionKey,
          SLACK_CLIENT_ID: "client-id",
          SLACK_CLIENT_SECRET: "client-secret",
        } as never,
        "oauth-code",
        42,
        "https://app.example.test/auth/slack/install/callback",
      ),
    ).rejects.toThrow("This business already has an active Slack workspace install");

    expect(getStoredRow("T_SECOND")).toBeNull();
  });

  it("allows reinstalling the same workspace for the same business (token refresh)", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id) VALUES (?, ?)").run(42, "biz-A");
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-old-token",
        botUserId: "U_OLD_BOT",
        teamName: "Customer Workspace",
        businessId: "biz-A",
        installedByUserId: 42,
        installedAt: 100,
      },
      encryptionKey,
    );
    tracedFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-new-token",
            bot_user_id: "U_NEW_BOT",
            team: { id: "T123", name: "Customer Workspace" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, team: { domain: "customer-domain" } })));

    await expect(
      installSlackWorkspaceFromCode(
        {
          DB: db,
          TOKEN_ENCRYPTION_KEY: encryptionKey,
          SLACK_CLIENT_ID: "client-id",
          SLACK_CLIENT_SECRET: "client-secret",
        } as never,
        "oauth-code",
        42,
        "https://app.example.test/auth/slack/install/callback",
      ),
    ).resolves.toEqual({
      teamId: "T123",
      teamName: "Customer Workspace",
      botUserId: "U_NEW_BOT",
    });

    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBe("xoxb-new-token");
  });

  it("allows reinstalling an uninstalled workspace under a different business", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id) VALUES (?, ?), (?, ?)").run(42, "biz-A", 43, "biz-B");
    await storeWorkspaceInstall(
      db,
      {
        teamId: "T123",
        botToken: "xoxb-old-token",
        botUserId: "U_OLD_BOT",
        teamName: "Customer Workspace",
        businessId: "biz-A",
        installedByUserId: 42,
        installedAt: 100,
      },
      encryptionKey,
    );
    markWorkspaceUninstalledFixture("T123", 200);
    tracedFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-new-token",
            bot_user_id: "U_NEW_BOT",
            team: { id: "T123", name: "Customer Workspace" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, team: { domain: "customer-domain" } })));

    await expect(
      installSlackWorkspaceFromCode(
        {
          DB: db,
          TOKEN_ENCRYPTION_KEY: encryptionKey,
          SLACK_CLIENT_ID: "client-id",
          SLACK_CLIENT_SECRET: "client-secret",
        } as never,
        "oauth-code",
        43,
        "https://app.example.test/auth/slack/install/callback",
      ),
    ).resolves.toEqual({
      teamId: "T123",
      teamName: "Customer Workspace",
      botUserId: "U_NEW_BOT",
    });

    expect(tracedFetchMock).toHaveBeenCalledTimes(2);
    expect(getStoredRow("T123")).toMatchObject({
      bot_user_id: "U_NEW_BOT",
      business_id: "biz-B",
      installed_by_user_id: 43,
      installed_at: expect.any(Number),
      uninstalled_at: null,
    });
    await expect(getBotTokenForTeam(db, "T123", encryptionKey)).resolves.toBe("xoxb-new-token");
  });
});
