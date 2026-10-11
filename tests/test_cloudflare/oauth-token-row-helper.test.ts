import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => logger,
}));

import {
  getGithubTokens,
  getJiraTokens,
  getLinearTokens,
  getNotionTokens,
  storeGithubTokens,
  storeJiraTokens,
  storeJiraTokensIfRefreshMatches,
  storeLinearTokens,
  storeLinearTokensIfRefreshMatches,
  storeNotionTokens,
  storeNotionTokensIfRefreshMatches,
} from "../../apps/control-plane-worker/src/integrations/db";

const ENCRYPTION_KEY = "test-token-encryption-key";

type IntegrationId = "github" | "linear" | "jira" | "notion";

class SqliteD1 {
  readonly db = new Database(":memory:");
  throwOnIntegrationUpsert = false;

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
    const d1 = this;
    const db = this.db;
    let values: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        values = bound;
        return this;
      },
      async run() {
        if (d1.throwOnIntegrationUpsert && query.includes("INSERT INTO user_integrations")) {
          throw new Error("upsert failed");
        }
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

function sqlite(db: D1Database): SqliteD1 {
  return db as unknown as SqliteD1;
}

function insertPlaintextTokenRow(
  db: D1Database,
  integrationId: IntegrationId,
  values: {
    accessToken?: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
    linearMetadata?: boolean;
  } = {},
): void {
  sqlite(db)
    .db.prepare(
      `INSERT INTO user_integrations (
        user_id,
        integration_id,
        oauth_access_token,
        oauth_refresh_token,
        oauth_expires_at,
        api_key,
        external_user_id,
        service_url,
        encrypted,
        last_validated_at,
        last_validation_status,
        last_validation_reason_code,
        connected_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, 1)`,
    )
    .run(
      1,
      integrationId,
      values.accessToken ?? "access-plain",
      values.refreshToken === undefined ? "refresh-plain" : values.refreshToken,
      values.expiresAt ?? 123,
      values.linearMetadata ? "api-key" : null,
      values.linearMetadata ? "external-user" : null,
      values.linearMetadata ? "https://linear.example" : null,
      values.linearMetadata ? 456 : null,
      values.linearMetadata ? "validated" : null,
      values.linearMetadata ? "oauth_connected" : null,
    );
}

function tokenRow(db: D1Database, integrationId: IntegrationId) {
  return sqlite(db)
    .db.prepare(
      `SELECT
        oauth_access_token,
        oauth_refresh_token,
        oauth_expires_at,
        api_key,
        external_user_id,
        service_url,
        encrypted,
        last_validated_at,
        last_validation_status,
        last_validation_reason_code
       FROM user_integrations
       WHERE user_id = 1 AND integration_id = ?`,
    )
    .get(integrationId) as
    | {
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
      }
    | undefined;
}

async function storeEncrypted(db: D1Database, integrationId: IntegrationId): Promise<void> {
  if (integrationId === "github") {
    await storeGithubTokens(db, 1, "access-secret", "refresh-secret", 123, ENCRYPTION_KEY);
    return;
  }
  if (integrationId === "linear") {
    await storeLinearTokens(db, 1, "access-secret", "refresh-secret", 3600, ENCRYPTION_KEY);
    return;
  }
  if (integrationId === "jira") {
    await storeJiraTokens(db, 1, "access-secret", "refresh-secret", 3600, ENCRYPTION_KEY);
    return;
  }
  await storeNotionTokens(db, 1, "access-secret", "refresh-secret", 3600, ENCRYPTION_KEY);
}

async function getTokens(db: D1Database, integrationId: IntegrationId, encryptionKey: string | undefined) {
  if (integrationId === "github") return getGithubTokens(db, "1", encryptionKey);
  if (integrationId === "linear") return getLinearTokens(db, "1", encryptionKey);
  if (integrationId === "jira") return getJiraTokens(db, "1", encryptionKey);
  return getNotionTokens(db, "1", encryptionKey);
}

describe("OAuth token row getters", () => {
  beforeEach(() => {
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  it.each(["github", "linear", "jira", "notion"] as const)(
    "fails closed for encrypted %s rows when the encryption key is missing",
    async (integrationId) => {
      const db = makeDb();
      await storeEncrypted(db, integrationId);

      await expect(getTokens(db, integrationId, undefined)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        {
          userId: "1",
          action: `${integrationId}.token.decrypt_failed`,
          reason: "encryption_key_missing",
        },
        expect.stringContaining("TOKEN_ENCRYPTION_KEY missing"),
      );
    },
  );

  it.each(["github", "linear", "jira", "notion"] as const)(
    "decrypts encrypted %s access and refresh tokens",
    async (integrationId) => {
      const db = makeDb();
      await storeEncrypted(db, integrationId);

      await expect(getTokens(db, integrationId, ENCRYPTION_KEY)).resolves.toMatchObject({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
      });
    },
  );

  it.each(["github", "linear", "jira", "notion"] as const)(
    "returns null and logs when %s decryption throws",
    async (integrationId) => {
      const db = makeDb();
      await storeEncrypted(db, integrationId);

      await expect(getTokens(db, integrationId, "wrong-key")).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "1",
          action: `${integrationId}.token.decrypt_failed`,
          reason: "decrypt_threw",
        }),
        expect.stringContaining("Failed to decrypt"),
      );
    },
  );

  it("returns plaintext rows without decrypting or repairing providers that opt out", async () => {
    const db = makeDb();
    insertPlaintextTokenRow(db, "jira");

    await expect(getJiraTokens(db, "1", ENCRYPTION_KEY)).resolves.toEqual({
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiresAt: 123,
      refreshTokenCiphertext: "refresh-plain",
    });
    expect(tokenRow(db, "jira")?.encrypted).toBe(0);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "jira.token.read_repaired" }),
      expect.any(String),
    );
  });

  it("read-repairs Linear plaintext rows and preserves validation metadata", async () => {
    const db = makeDb();
    insertPlaintextTokenRow(db, "linear", { linearMetadata: true });

    const tokens = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    const row = tokenRow(db, "linear");

    expect(tokens).toMatchObject({
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiresAt: 123,
    });
    expect(tokens?.refreshTokenCiphertext).toBe(row?.oauth_refresh_token);
    expect(tokens?.refreshTokenCiphertext).not.toBe("refresh-plain");
    expect(row).toMatchObject({
      api_key: "api-key",
      external_user_id: "external-user",
      service_url: "https://linear.example",
      encrypted: 1,
      last_validated_at: 456,
      last_validation_status: "validated",
      last_validation_reason_code: "oauth_connected",
    });
    expect(logger.info).toHaveBeenCalledWith(
      { userId: "1", action: "linear.token.read_repaired" },
      expect.stringContaining("Encrypted legacy plaintext linear row"),
    );
  });

  it("read-repairs Notion plaintext rows and returns the freshly stored refresh ciphertext", async () => {
    const db = makeDb();
    insertPlaintextTokenRow(db, "notion");

    const tokens = await getNotionTokens(db, "1", ENCRYPTION_KEY);
    const row = tokenRow(db, "notion");

    expect(tokens).toMatchObject({
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiresAt: 123,
    });
    expect(tokens?.refreshTokenCiphertext).toBe(row?.oauth_refresh_token);
    expect(tokens?.refreshTokenCiphertext).not.toBe("refresh-plain");
    expect(row?.encrypted).toBe(1);
  });

  it("keeps read-repair write-back failures non-fatal", async () => {
    const db = makeDb();
    insertPlaintextTokenRow(db, "linear", { linearMetadata: true });
    sqlite(db).throwOnIntegrationUpsert = true;

    await expect(getLinearTokens(db, "1", ENCRYPTION_KEY)).resolves.toEqual({
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiresAt: 123,
      refreshTokenCiphertext: "refresh-plain",
    });
    expect(tokenRow(db, "linear")?.encrypted).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "1", action: "linear.token.read_repair_failed" }),
      "Read-repair write-back failed (non-fatal)",
    );
  });

  it("returns the stored ciphertext used by Linear, Jira, and Notion refresh CAS updates", async () => {
    const db = makeDb();
    await storeLinearTokens(db, 1, "linear-access", "linear-refresh", 3600, ENCRYPTION_KEY);
    await storeJiraTokens(db, 1, "jira-access", "jira-refresh", 3600, ENCRYPTION_KEY);
    await storeNotionTokens(db, 1, "notion-access", "notion-refresh", 3600, ENCRYPTION_KEY);

    const linear = await getLinearTokens(db, "1", ENCRYPTION_KEY);
    const jira = await getJiraTokens(db, "1", ENCRYPTION_KEY);
    const notion = await getNotionTokens(db, "1", ENCRYPTION_KEY);

    expect(
      await storeLinearTokensIfRefreshMatches(
        db,
        1,
        "linear-access-next",
        "linear-refresh-next",
        3600,
        ENCRYPTION_KEY,
        linear!.refreshTokenCiphertext!,
      ),
    ).toBe(true);
    expect(
      await storeJiraTokensIfRefreshMatches(
        db,
        1,
        "jira-access-next",
        "jira-refresh-next",
        3600,
        ENCRYPTION_KEY,
        jira!.refreshTokenCiphertext!,
      ),
    ).toBe(true);
    expect(
      await storeNotionTokensIfRefreshMatches(
        db,
        1,
        "notion-access-next",
        "notion-refresh-next",
        3600,
        ENCRYPTION_KEY,
        notion!.refreshTokenCiphertext!,
      ),
    ).toBe(true);
  });
});
