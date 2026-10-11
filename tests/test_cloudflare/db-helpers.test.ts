import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { getEncryptedRow, upsertRow } from "../../apps/control-plane-worker/src/db-helpers";
import { encrypt } from "../../apps/control-plane-worker/src/settings/encryption";
import { SqliteD1 } from "./sqlite-d1-helper";

function createDb(): { sqlite: Database.Database; d1: D1Database } {
  const sqlite = new Database(":memory:");
  const d1 = new SqliteD1(sqlite) as unknown as D1Database;
  return { sqlite, d1 };
}

describe("db-helpers", () => {
  describe("upsertRow", () => {
    it("inserts a new row and updates non-conflict columns on conflict", async () => {
      const { sqlite, d1 } = createDb();
      sqlite.exec(`
        CREATE TABLE provider_tokens (
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, account_id)
        );
      `);

      await upsertRow(d1, {
        table: "provider_tokens",
        columns: ["provider", "account_id", "access_token", "refresh_token", "created_at", "updated_at"],
        values: ["github", "acct-1", "token-1", "refresh-1", 100, 100],
        conflictKeys: ["provider", "account_id"],
        excludeFromUpdate: ["created_at"],
      });
      await upsertRow(d1, {
        table: "provider_tokens",
        columns: ["provider", "account_id", "access_token", "refresh_token", "created_at", "updated_at"],
        values: ["github", "acct-1", "token-2", "refresh-2", 999, 200],
        conflictKeys: ["provider", "account_id"],
        excludeFromUpdate: ["created_at"],
      });

      expect(sqlite.prepare("SELECT * FROM provider_tokens").get()).toMatchObject({
        provider: "github",
        account_id: "acct-1",
        access_token: "token-2",
        refresh_token: "refresh-2",
        created_at: 100,
        updated_at: 200,
      });
    });

    it("supports update overrides and rejects upserts with no updateable columns", async () => {
      const { sqlite, d1 } = createDb();
      sqlite.exec(`
        CREATE TABLE counters (
          id TEXT PRIMARY KEY,
          count INTEGER NOT NULL
        );
      `);

      await upsertRow(d1, {
        table: "counters",
        columns: ["id", "count"],
        values: ["a", 1],
        conflictKeys: ["id"],
      });
      await upsertRow(d1, {
        table: "counters",
        columns: ["id", "count"],
        values: ["a", 4],
        conflictKeys: ["id"],
        updateOverrides: { count: "counters.count + excluded.count" },
      });

      expect(sqlite.prepare("SELECT count FROM counters WHERE id = ?").get("a")).toEqual({ count: 5 });
      await expect(
        upsertRow(d1, {
          table: "counters",
          columns: ["id"],
          values: ["b"],
          conflictKeys: ["id"],
        }),
      ).rejects.toThrow('upsertRow: no SET clauses generated for table "counters"');
    });
  });

  describe("getEncryptedRow", () => {
    it("decrypts encrypted fields and returns the row", async () => {
      const { sqlite, d1 } = createDb();
      const encryptionKey = "test-encryption-key";
      const encryptedToken = await encrypt("secret-token", encryptionKey);
      sqlite.exec("CREATE TABLE credentials (id TEXT PRIMARY KEY, token TEXT, label TEXT)");
      sqlite
        .prepare("INSERT INTO credentials (id, token, label) VALUES (?, ?, ?)")
        .run("cred-1", encryptedToken, "prod");

      const row = await getEncryptedRow<{ id: string; token: string; label: string }>(d1, {
        sql: "SELECT id, token, label FROM credentials WHERE id = ? LIMIT 1",
        binds: ["cred-1"],
        encryptedFields: ["token"],
        encryptionKey,
        context: "db-helper-test",
      });

      expect(row).toEqual({ id: "cred-1", token: "secret-token", label: "prod" });
    });

    it("returns null for missing rows, null encrypted fields, and decrypt failures", async () => {
      const { sqlite, d1 } = createDb();
      sqlite.exec("CREATE TABLE credentials (id TEXT PRIMARY KEY, token TEXT)");
      sqlite.prepare("INSERT INTO credentials (id, token) VALUES (?, ?)").run("null-token", null);
      sqlite.prepare("INSERT INTO credentials (id, token) VALUES (?, ?)").run("bad-token", "enc:not-valid");

      await expect(
        getEncryptedRow<{ id: string; token: string }>(d1, {
          sql: "SELECT id, token FROM credentials WHERE id = ? LIMIT 1",
          binds: ["missing"],
          encryptedFields: ["token"],
          encryptionKey: "key",
        }),
      ).resolves.toBeNull();
      await expect(
        getEncryptedRow<{ id: string; token: string }>(d1, {
          sql: "SELECT id, token FROM credentials WHERE id = ? LIMIT 1",
          binds: ["null-token"],
          encryptedFields: ["token"],
          encryptionKey: "key",
        }),
      ).resolves.toBeNull();
      await expect(
        getEncryptedRow<{ id: string; token: string }>(d1, {
          sql: "SELECT id, token FROM credentials WHERE id = ? LIMIT 1",
          binds: ["bad-token"],
          encryptedFields: ["token"],
          encryptionKey: "key",
          context: "db-helper-test",
        }),
      ).resolves.toBeNull();
      await expect(
        getEncryptedRow<{ id: string; token: string }>(d1, {
          sql: "SELECT id, token FROM credentials WHERE id = ? LIMIT 1",
          binds: ["bad-token"],
          encryptedFields: ["token"],
          encryptionKey: undefined,
          context: "db-helper-test",
        }),
      ).resolves.toBeNull();
    });
  });
});
