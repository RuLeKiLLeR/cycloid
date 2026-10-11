import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { getQaIntegrationHealth, seedQaEnvironment } from "../../apps/control-plane-worker/src/qa/seed";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { CREDENTIAL_VALIDATION_STATUS } from "../../shared/constants/onboarding";
import { SqliteD1 } from "./sqlite-d1-helper";

const QA_BUSINESS_ID = "b004178c-58e4-421b-a6b9-43b410fc64ec";

function createSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      shared_sessions INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER UNIQUE NOT NULL,
      login TEXT NOT NULL,
      name TEXT,
      email TEXT,
      avatar_url TEXT,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE business_members (
      business_id TEXT NOT NULL REFERENCES businesses(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (business_id, user_id),
      UNIQUE (user_id)
    );

    CREATE TABLE github_installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER NOT NULL UNIQUE,
      owner_login TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      owner_type TEXT NOT NULL,
      repository_selection TEXT,
      permissions_json TEXT,
      events_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      suspended_at INTEGER
    );

    CREATE UNIQUE INDEX idx_github_installations_owner_nocase_unique
      ON github_installations(owner_login COLLATE NOCASE);

    CREATE TABLE business_integrations (
      business_id TEXT NOT NULL REFERENCES businesses(id),
      integration_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'user' CHECK(scope IN ('disabled', 'user', 'business')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (business_id, integration_id)
    );

    CREATE TABLE business_integration_credentials (
      business_id TEXT NOT NULL REFERENCES businesses(id),
      integration_id TEXT NOT NULL,
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at INTEGER,
      api_key TEXT,
      service_url TEXT,
      encrypted INTEGER NOT NULL DEFAULT 0,
      connected_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_validated_at INTEGER,
      last_validation_status TEXT,
      last_validation_reason_code TEXT,
      PRIMARY KEY (business_id, integration_id)
    );

    CREATE TABLE env_blobs (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      business_id TEXT REFERENCES businesses(id),
      name TEXT NOT NULL,
      env_text TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 1 CHECK(encrypted IN (0, 1)),
      key_names_json TEXT NOT NULL,
      entry_meta_json TEXT NOT NULL DEFAULT '{}',
      is_global INTEGER NOT NULL DEFAULT 0 CHECK(is_global IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE env_blob_repos (
      env_blob_id TEXT NOT NULL REFERENCES env_blobs(id) ON DELETE CASCADE,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (env_blob_id, repo_owner, repo_name)
    );
  `);
}

function createEnv(sqlite: Database.Database, overrides: Partial<Env> = {}): Env {
  return {
    WORKER_ENV: "qa",
    DB: new SqliteD1(sqlite) as unknown as D1Database,
    TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    ARCANIST_OPENAI_API_KEY: "sk-openai-qa",
    QA_OWNER_GITHUB_ID: "12345",
    QA_OWNER_LOGIN: "qa-owner",
    QA_OWNER_EMAIL: "qa-owner@example.com",
    QA_INSTALLATION_ID: "67890",
    ARCANIST_LOGIN_USERNAME: "qa-user",
    ARCANIST_LOGIN_PASSWORD: "qa-pass",
    ARCANIST_LOGIN_PAGE: "/login",
    ARCANIST_AUTHENTICATED_PAGE: "/dashboard",
    ...overrides,
  } as Env;
}

describe("seedQaEnvironment", () => {
  let sqlite: Database.Database | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function setup(): Database.Database {
    sqlite = new Database(":memory:");
    createSchema(sqlite);
    return sqlite;
  }

  it("rejects non-QA environments before mutating", async () => {
    const db = setup();
    await expect(seedQaEnvironment(createEnv(db, { WORKER_ENV: "production" }))).rejects.toMatchObject({
      message: "QA seed is only allowed when WORKER_ENV=qa",
      status: 403,
    });

    const count = db.prepare("SELECT COUNT(*) AS count FROM businesses").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("seeds QA owner, installation, validated OpenAI business credential, and repo login env", async () => {
    const db = setup();
    const result = await seedQaEnvironment(createEnv(db));

    expect(result).toMatchObject({
      ok: true,
      businessId: QA_BUSINESS_ID,
      installationId: 67890,
      repo: "trycycloid/dummy-docker-app",
      providerCredentials: ["openai"],
      businessManagedFixtures: [
        {
          integrationId: "cloudflare",
          status: "missing",
          reason: "QA Cloudflare D1 fixture env is not set",
        },
        {
          integrationId: "datadog",
          status: "missing",
          reason: "QA Datadog fixture env is not set",
        },
        {
          integrationId: "braintrust",
          status: "missing",
          reason: "QA Braintrust fixture env is not set",
        },
      ],
      repoLoginEnvKeys: [
        "ARCANIST_LOGIN_USERNAME",
        "ARCANIST_LOGIN_PASSWORD",
        "ARCANIST_LOGIN_PAGE",
        "ARCANIST_AUTHENTICATED_PAGE",
      ],
    });

    const member = db.prepare("SELECT role FROM business_members WHERE user_id = ?").get(result.ownerUserId) as {
      role: string;
    };
    expect(member.role).toBe("admin");

    const credential = db
      .prepare(
        "SELECT encrypted, last_validation_status FROM business_integration_credentials WHERE business_id = ? AND integration_id = 'openai'",
      )
      .get(QA_BUSINESS_ID) as { encrypted: number; last_validation_status: string };
    expect(credential.encrypted).toBe(1);
    expect(credential.last_validation_status).toBe(CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    const scope = db
      .prepare("SELECT scope FROM business_integrations WHERE business_id = ? AND integration_id = 'openai'")
      .get(QA_BUSINESS_ID) as { scope: string };
    expect(scope.scope).toBe("business");

    const loginEnv = db
      .prepare("SELECT key_names_json FROM env_blobs WHERE business_id = ? AND name = 'app_login'")
      .get(QA_BUSINESS_ID) as { key_names_json: string };
    expect(JSON.parse(loginEnv.key_names_json)).toEqual([
      "ARCANIST_AUTHENTICATED_PAGE",
      "ARCANIST_LOGIN_PAGE",
      "ARCANIST_LOGIN_PASSWORD",
      "ARCANIST_LOGIN_USERNAME",
    ]);
  });

  it("is idempotent", async () => {
    const db = setup();
    const env = createEnv(db);

    const first = await seedQaEnvironment(env);
    const second = await seedQaEnvironment(env);

    expect(second.ownerUserId).toBe(first.ownerUserId);
    expect((db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM business_integration_credentials").get() as { count: number }).count,
    ).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM github_installations").get() as { count: number }).count).toBe(1);
  });

  it("seeds optional business-managed fixture credentials when QA env is complete", async () => {
    const db = setup();
    const env = createEnv(db, {
      QA_CLOUDFLARE_D1_API_TOKEN: "cf-token",
      QA_CLOUDFLARE_D1_ACCOUNT_ID: "1234567890abcdef1234567890abcdef",
      QA_CLOUDFLARE_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
      QA_DATADOG_API_KEY: "dd-api-key",
      QA_DATADOG_APP_KEY: "dd-app-key",
      QA_DATADOG_SITE: "us5.datadoghq.com",
      QA_BRAINTRUST_API_KEY: "bt-api-key",
      QA_BRAINTRUST_API_URL: "https://api.braintrust.dev",
    });

    const result = await seedQaEnvironment(env);

    expect(result.businessManagedFixtures).toEqual([
      { integrationId: "cloudflare", status: "configured", reason: "QA Cloudflare D1 fixture seeded" },
      { integrationId: "datadog", status: "configured", reason: "QA Datadog fixture seeded" },
      { integrationId: "braintrust", status: "configured", reason: "QA Braintrust fixture seeded" },
    ]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM business_integration_credentials WHERE business_id = ?")
        .get(QA_BUSINESS_ID) as { count: number },
    ).toMatchObject({ count: 4 });

    const scopes = db
      .prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ? ORDER BY integration_id")
      .all(QA_BUSINESS_ID) as Array<{ integration_id: string; scope: string }>;
    expect(scopes).toEqual([
      { integration_id: "braintrust", scope: "business" },
      { integration_id: "cloudflare", scope: "business" },
      { integration_id: "datadog", scope: "business" },
      { integration_id: "openai", scope: "business" },
    ]);

    const health = await getQaIntegrationHealth(env);
    expect(health.fixtures.map((fixture) => [fixture.integrationId, fixture.status])).toEqual([
      ["cloudflare", "configured"],
      ["datadog", "configured"],
      ["braintrust", "configured"],
    ]);
    expect(JSON.stringify(health)).not.toContain("cf-token");
    expect(JSON.stringify(health)).not.toContain("dd-api-key");
    expect(JSON.stringify(health)).not.toContain("bt-api-key");
  });

  it("seeds Datadog and Braintrust fixtures from existing QA secret names when QA fixture aliases are absent", async () => {
    const db = setup();
    const env = createEnv(db, {
      DD_API_KEY: "dd-api-key",
      DD_APP_KEY: "dd-app-key",
      BRAINTRUST_API_KEY: "bt-api-key",
    });

    const result = await seedQaEnvironment(env);

    expect(result.businessManagedFixtures).toEqual([
      { integrationId: "cloudflare", status: "missing", reason: "QA Cloudflare D1 fixture env is not set" },
      { integrationId: "datadog", status: "configured", reason: "QA Datadog fixture seeded" },
      { integrationId: "braintrust", status: "configured", reason: "QA Braintrust fixture seeded" },
    ]);

    const credentials = db
      .prepare(
        "SELECT integration_id, service_url FROM business_integration_credentials WHERE business_id = ? ORDER BY integration_id",
      )
      .all(QA_BUSINESS_ID) as Array<{ integration_id: string; service_url: string | null }>;
    expect(credentials).toEqual([
      { integration_id: "braintrust", service_url: "https://api.braintrust.dev" },
      { integration_id: "datadog", service_url: "us5.datadoghq.com" },
      { integration_id: "openai", service_url: null },
    ]);

    const health = await getQaIntegrationHealth(env);
    expect(health.fixtures.map((fixture) => [fixture.integrationId, fixture.status])).toEqual([
      ["cloudflare", "missing"],
      ["datadog", "configured"],
      ["braintrust", "configured"],
    ]);
    expect(health.fixtures.find((fixture) => fixture.integrationId === "datadog")?.env).toMatchObject({
      present: ["DD_API_KEY", "DD_APP_KEY"],
      missing: ["QA_DATADOG_SITE"],
      sources: {
        QA_DATADOG_API_KEY: "DD_API_KEY",
        QA_DATADOG_APP_KEY: "DD_APP_KEY",
        QA_DATADOG_SITE: "default:us5.datadoghq.com",
      },
    });
    expect(health.fixtures.find((fixture) => fixture.integrationId === "braintrust")?.env).toMatchObject({
      present: ["BRAINTRUST_API_KEY"],
      missing: [],
      sources: {
        QA_BRAINTRUST_API_KEY: "BRAINTRUST_API_KEY",
      },
    });
  });

  it("requires encrypted optional fixture credential rows to be decryptable for health", async () => {
    const db = setup();
    const env = createEnv(db, {
      QA_CLOUDFLARE_D1_API_TOKEN: "cf-token",
      QA_CLOUDFLARE_D1_ACCOUNT_ID: "1234567890abcdef1234567890abcdef",
      QA_CLOUDFLARE_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
      QA_DATADOG_API_KEY: "dd-api-key",
      QA_DATADOG_APP_KEY: "dd-app-key",
      QA_DATADOG_SITE: "us5.datadoghq.com",
      QA_BRAINTRUST_API_KEY: "bt-api-key",
    });

    await seedQaEnvironment(env);

    const healthWithoutEncryptionKey = await getQaIntegrationHealth({
      ...env,
      TOKEN_ENCRYPTION_KEY: undefined,
    });

    expect(healthWithoutEncryptionKey.fixtures.map((fixture) => [fixture.integrationId, fixture.status])).toEqual([
      ["cloudflare", "invalid_config"],
      ["datadog", "invalid_config"],
      ["braintrust", "invalid_config"],
    ]);
  });

  it("reports invalid optional fixture config without writing bad credential rows", async () => {
    const db = setup();
    const env = createEnv(db, {
      QA_DATADOG_API_KEY: "dd-api-key",
      QA_DATADOG_APP_KEY: "dd-app-key",
      QA_DATADOG_SITE: "invalid.example.com",
    });

    const result = await seedQaEnvironment(env);

    expect(result.businessManagedFixtures).toContainEqual({
      integrationId: "datadog",
      status: "invalid_config",
      reason: "QA_DATADOG_SITE is invalid",
    });
    const datadogCredentialCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM business_integration_credentials WHERE business_id = ? AND integration_id = 'datadog'",
      )
      .get(QA_BUSINESS_ID) as { count: number };
    expect(datadogCredentialCount.count).toBe(0);

    const health = await getQaIntegrationHealth(env);
    expect(health.fixtures.find((fixture) => fixture.integrationId === "datadog")).toMatchObject({
      status: "invalid_config",
      credentialRow: "missing",
    });
  });

  it("rejects an owner GitHub ID already attached to another business", async () => {
    const db = setup();
    db.exec(`
      INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at)
      VALUES ('other-business', 'Other', 1, 1, 1);
      INSERT INTO users (github_id, login, business_id, created_at, updated_at)
      VALUES (12345, 'qa-owner', 'other-business', 1, 1);
    `);

    await expect(seedQaEnvironment(createEnv(db))).rejects.toMatchObject({
      message: "QA owner github_id is already attached to business other-business",
      status: 409,
    });
  });
});
