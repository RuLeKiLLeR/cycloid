import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { canResolveProviderKeyForSpawn } from "../../apps/control-plane-worker/src/integrations/runtime";
import { CREDENTIAL_VALIDATION_STATUS } from "../../shared/constants/onboarding";
import { SqliteD1 } from "./sqlite-d1-helper";

const BUSINESS_ID = "business-1";
const ENV = { WORKER_ENV: "production" } as never;
const ENV_WITH_ENCRYPTION_KEY = { WORKER_ENV: "production", TOKEN_ENCRYPTION_KEY: "test-key" } as never;

function createDb(): SqliteD1 {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE user_integrations (
      user_id INTEGER NOT NULL, integration_id TEXT NOT NULL, oauth_access_token TEXT,
      oauth_refresh_token TEXT, oauth_expires_at INTEGER, api_key TEXT, service_url TEXT,
      encrypted INTEGER, last_validation_status TEXT,
      PRIMARY KEY (user_id, integration_id)
    );
    CREATE TABLE user_settings (user_id INTEGER PRIMARY KEY, use_codex_subscription INTEGER);
    CREATE TABLE business_integrations (
      business_id TEXT NOT NULL, integration_id TEXT NOT NULL, scope TEXT NOT NULL,
      PRIMARY KEY (business_id, integration_id)
    );
    CREATE TABLE business_integration_credentials (
      business_id TEXT NOT NULL, integration_id TEXT NOT NULL, api_key TEXT,
      oauth_access_token TEXT, oauth_refresh_token TEXT, oauth_expires_at INTEGER,
      service_url TEXT, encrypted INTEGER, last_validation_status TEXT,
      PRIMARY KEY (business_id, integration_id)
    );
    CREATE TABLE businesses (id TEXT PRIMARY KEY, codex_byos_enabled INTEGER);
  `);
  return new SqliteD1(db);
}

describe("canResolveProviderKeyForSpawn", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    d1 = createDb();
    d1.db.prepare("INSERT INTO businesses (id, codex_byos_enabled) VALUES (?, 0)").run(BUSINESS_ID);
  });

  it("accepts a validated user credential", async () => {
    d1.db
      .prepare(
        "INSERT INTO user_integrations (user_id, integration_id, api_key, last_validation_status) VALUES (?, ?, ?, ?)",
      )
      .run(42, "anthropic", "secret", CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    await expect(
      canResolveProviderKeyForSpawn(d1 as never, {
        env: ENV,
        ownerUserId: "42",
        businessId: BUSINESS_ID,
        provider: "anthropic",
      }),
    ).resolves.toBe(true);
  });

  it("rejects invalid or missing credentials", async () => {
    d1.db
      .prepare(
        "INSERT INTO user_integrations (user_id, integration_id, api_key, last_validation_status) VALUES (?, ?, ?, ?)",
      )
      .run(42, "anthropic", "secret", CREDENTIAL_VALIDATION_STATUS.INVALID);

    await expect(
      canResolveProviderKeyForSpawn(d1 as never, {
        env: ENV,
        ownerUserId: "42",
        businessId: BUSINESS_ID,
        provider: "anthropic",
      }),
    ).resolves.toBe(false);
    await expect(
      canResolveProviderKeyForSpawn(d1 as never, {
        env: ENV,
        ownerUserId: "43",
        businessId: BUSINESS_ID,
        provider: "anthropic",
      }),
    ).resolves.toBe(false);
  });

  it("rejects encrypted credentials when the worker cannot decrypt them", async () => {
    d1.db
      .prepare(
        "INSERT INTO user_integrations (user_id, integration_id, api_key, encrypted, last_validation_status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(42, "anthropic", "ciphertext", 1, CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    await expect(
      canResolveProviderKeyForSpawn(d1 as never, {
        env: ENV,
        ownerUserId: "42",
        businessId: BUSINESS_ID,
        provider: "anthropic",
      }),
    ).resolves.toBe(false);
    await expect(
      canResolveProviderKeyForSpawn(d1 as never, {
        env: ENV_WITH_ENCRYPTION_KEY,
        ownerUserId: "42",
        businessId: BUSINESS_ID,
        provider: "anthropic",
      }),
    ).resolves.toBe(true);
  });

  it("uses a validated business credential when the business owns the scope", async () => {
    d1.db
      .prepare("INSERT INTO business_integrations (business_id, integration_id, scope) VALUES (?, ?, 'business')")
      .run(BUSINESS_ID, "anthropic");
    d1.db
      .prepare(
        "INSERT INTO user_integrations (user_id, integration_id, api_key, last_validation_status) VALUES (?, ?, ?, ?)",
      )
      .run(42, "anthropic", "user-secret", CREDENTIAL_VALIDATION_STATUS.INVALID);
    d1.db
      .prepare(
        "INSERT INTO business_integration_credentials (business_id, integration_id, api_key, last_validation_status) VALUES (?, ?, ?, ?)",
      )
      .run(BUSINESS_ID, "anthropic", "business-secret", CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    await expect(
      canResolveProviderKeyForSpawn(d1 as never, {
        env: ENV,
        ownerUserId: "42",
        businessId: BUSINESS_ID,
        provider: "anthropic",
      }),
    ).resolves.toBe(true);
  });
});
