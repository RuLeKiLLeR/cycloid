// Validates the business_test_credentials DAO end-to-end: encryption round-trip,
// fail-closed semantics for missing creds, decrypt failure with mismatched key,
// cross-tenant isolation, and resolution of declared envVars.
//
// Uses the same SqliteD1 shim as auth-business-immutability.test.ts: an
// in-memory better-sqlite3 instance with all migrations applied.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteBusinessTestCredential,
  listBusinessTestCredentials,
  resolveDeclaredTestCredentials,
  upsertBusinessTestCredential,
} from "../../apps/control-plane-worker/src/integrations/test-credentials-db";

// Thin helper over resolveDeclaredTestCredentials for the plaintext-oriented
// round-trip/null-semantics tests below. Replaces the former
// getBusinessTestCredentialPlaintext DAO, which had no production callers.
async function resolvePlaintext(
  db: D1Database,
  params: { businessId: string; repoOwner: string; repoName: string; name: string; encryptionKey: string | undefined },
): Promise<string | null> {
  const { resolved } = await resolveDeclaredTestCredentials(db, {
    businessId: params.businessId,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    declarations: [{ name: params.name, envVar: "VALUE" }],
    encryptionKey: params.encryptionKey,
  });
  return resolved[0]?.value ?? null;
}

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const ENC_KEY = "test-encryption-key-aaaaaaaaaaaaaaaaaaaaaa";

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
  private runStatement<T>(fn: (stmt: Database.Statement, values: unknown[]) => T): T {
    return fn(this.db.prepare(this.query), this.boundValues);
  }
  async run() {
    const result = this.runStatement((stmt, values) => stmt.run(...values));
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    return this.runStatement((stmt, values) => stmt.get(...values) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.runStatement((stmt, values) => stmt.all(...values) as T[]) };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  readonly preparedQueries: string[] = [];
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string): SqliteD1Statement {
    this.preparedQueries.push(query);
    return new SqliteD1Statement(this.sqlite, query);
  }
  resetPreparedQueries(): void {
    this.preparedQueries.length = 0;
  }
}

function seedBusiness(d1: SqliteD1, id: string): void {
  d1.sqlite.prepare(`INSERT INTO businesses (id, name) VALUES (?, ?)`).run(id, id);
}

// The 0093 migration declares `rotated_by_user_id INTEGER REFERENCES users(id)`,
// so any test passing a non-null rotatedByUserId needs the user row to exist or
// the FK constraint trips. Tests below use ids 1, 2, 7, and 42; pre-seed all
// four so individual tests don't need to remember which to seed.
function seedUser(d1: SqliteD1, id: number, businessId: string): void {
  const now = Date.now();
  d1.sqlite
    .prepare(
      `INSERT INTO users (id, github_id, login, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, id, `user-${id}`, businessId, now, now);
}

describe("business_test_credentials DAO", () => {
  let d1: SqliteD1;
  let db: D1Database;
  beforeEach(() => {
    d1 = new SqliteD1();
    db = d1 as unknown as D1Database;
    seedBusiness(d1, "biz-a");
    seedBusiness(d1, "biz-b");
    for (const userId of [1, 2, 7, 42]) {
      seedUser(d1, userId, "biz-a");
    }
  });

  it("encrypts at rest and decrypts on read", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_user_password",
      plaintextValue: "p@ssw0rd-secret",
      rotatedByUserId: 42,
      encryptionKey: ENC_KEY,
    });

    const row = d1.sqlite
      .prepare(
        `SELECT encrypted_value, encrypted FROM business_test_credentials WHERE business_id=? AND repo_owner=? AND repo_name=? AND name=?`,
      )
      .get("biz-a", "trycycloid", "repo-x", "test_user_password") as
      { encrypted_value: string; encrypted: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.encrypted).toBe(1);
    expect(row!.encrypted_value).toMatch(/^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(row!.encrypted_value).not.toContain("p@ssw0rd-secret");

    const plaintext = await resolvePlaintext(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_user_password",
      encryptionKey: ENC_KEY,
    });
    expect(plaintext).toBe("p@ssw0rd-secret");
  });

  it("returns null on decrypt failure (wrong key) without throwing", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_token",
      plaintextValue: "abc123",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    const plaintext = await resolvePlaintext(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_token",
      encryptionKey: "wrong-encryption-key-bbbbbbbbbbbbbbbb",
    });
    expect(plaintext).toBeNull();
  });

  it("returns null when encryption key is missing for an encrypted row", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_token",
      plaintextValue: "abc123",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    const plaintext = await resolvePlaintext(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_token",
      encryptionKey: undefined,
    });
    expect(plaintext).toBeNull();
  });

  it("isolates rows across business_id (cross-tenant)", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "shared_name",
      plaintextValue: "biz-a-secret",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });
    await upsertBusinessTestCredential(db, {
      businessId: "biz-b",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "shared_name",
      plaintextValue: "biz-b-secret",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    const a = await resolvePlaintext(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "shared_name",
      encryptionKey: ENC_KEY,
    });
    const b = await resolvePlaintext(db, {
      businessId: "biz-b",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "shared_name",
      encryptionKey: ENC_KEY,
    });
    expect(a).toBe("biz-a-secret");
    expect(b).toBe("biz-b-secret");
  });

  it("upsert rotates the value and bumps updated_at while preserving created_at", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "rot",
      plaintextValue: "v1",
      rotatedByUserId: 1,
      encryptionKey: ENC_KEY,
    });
    const initial = d1.sqlite
      .prepare(`SELECT created_at, updated_at FROM business_test_credentials WHERE name='rot'`)
      .get() as { created_at: number; updated_at: number };
    await new Promise((r) => setTimeout(r, 5));
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "rot",
      plaintextValue: "v2",
      rotatedByUserId: 7,
      encryptionKey: ENC_KEY,
    });
    const after = d1.sqlite
      .prepare(`SELECT created_at, updated_at, rotated_by_user_id FROM business_test_credentials WHERE name='rot'`)
      .get() as { created_at: number; updated_at: number; rotated_by_user_id: number };
    expect(after.created_at).toBe(initial.created_at);
    expect(after.updated_at).toBeGreaterThanOrEqual(initial.updated_at);
    expect(after.rotated_by_user_id).toBe(7);

    const plaintext = await resolvePlaintext(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "rot",
      encryptionKey: ENC_KEY,
    });
    expect(plaintext).toBe("v2");
  });

  it("list returns only summary fields (no plaintext, no encrypted_value)", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "a",
      plaintextValue: "secret-a",
      rotatedByUserId: 1,
      encryptionKey: ENC_KEY,
    });
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "b",
      plaintextValue: "secret-b",
      rotatedByUserId: 2,
      encryptionKey: ENC_KEY,
    });

    const summary = await listBusinessTestCredentials(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
    });
    expect(summary).toHaveLength(2);
    expect(summary.map((s) => s.name).sort()).toEqual(["a", "b"]);
    for (const entry of summary) {
      expect(entry).not.toHaveProperty("encrypted_value");
      expect(entry).not.toHaveProperty("encryptedValue");
      expect(JSON.stringify(entry)).not.toContain("secret-");
    }
  });

  it("delete removes only the targeted row", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "k1",
      plaintextValue: "x",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "k2",
      plaintextValue: "y",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });
    await deleteBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "k1",
    });
    const remaining = await listBusinessTestCredentials(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
    });
    expect(remaining.map((s) => s.name)).toEqual(["k2"]);
  });

  it("resolveDeclaredTestCredentials returns resolved + missing for fail-closed callers with one batched read", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_user_email",
      plaintextValue: "user@example.com",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_api_token",
      plaintextValue: "token-123",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    d1.resetPreparedQueries();
    const { resolved, missing } = await resolveDeclaredTestCredentials(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      declarations: [
        { name: "test_user_email", envVar: "E2E_USER_EMAIL" },
        { name: "test_api_token", envVar: "E2E_API_TOKEN" },
        { name: "test_user_password", envVar: "E2E_USER_PASSWORD" },
      ],
      encryptionKey: ENC_KEY,
    });

    expect(resolved).toEqual([
      { name: "test_user_email", envVar: "E2E_USER_EMAIL", value: "user@example.com" },
      { name: "test_api_token", envVar: "E2E_API_TOKEN", value: "token-123" },
    ]);
    expect(missing).toEqual([{ name: "test_user_password", envVar: "E2E_USER_PASSWORD", reason: "not_found" }]);
    const credentialSelects = d1.preparedQueries.filter((query) => query.includes("FROM business_test_credentials"));
    expect(credentialSelects).toHaveLength(1);
    expect(credentialSelects[0]).toContain("name IN (?, ?, ?)");
    expect(credentialSelects[0]).not.toMatch(/AND name = \?\s+LIMIT 1/);
  });

  it("resolveDeclaredTestCredentials reports missing for declared cred in a different business (cross-tenant)", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-b",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "leaked_token",
      plaintextValue: "biz-b-only",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    const { resolved, missing } = await resolveDeclaredTestCredentials(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      declarations: [{ name: "leaked_token", envVar: "LEAK" }],
      encryptionKey: ENC_KEY,
    });
    expect(resolved).toEqual([]);
    expect(missing).toEqual([{ name: "leaked_token", envVar: "LEAK", reason: "not_found" }]);
  });

  it("resolveDeclaredTestCredentials surfaces reason='decrypt_failed' when encryption key is missing", async () => {
    // Row exists, encrypted=1, but caller passes no encryption key. The
    // diagnostic must say `decrypt_failed` (operator needs to fix encryption
    // setup), not `not_found` (which would imply they need to set the value).
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_token",
      plaintextValue: "abc123",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    const { resolved, missing } = await resolveDeclaredTestCredentials(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      declarations: [{ name: "test_token", envVar: "E2E_TOKEN" }],
      encryptionKey: undefined,
    });
    expect(resolved).toEqual([]);
    expect(missing).toEqual([{ name: "test_token", envVar: "E2E_TOKEN", reason: "decrypt_failed" }]);
  });

  it("resolveDeclaredTestCredentials surfaces reason='decrypt_failed' on a wrong-key decrypt error", async () => {
    await upsertBusinessTestCredential(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      name: "test_token",
      plaintextValue: "abc123",
      rotatedByUserId: null,
      encryptionKey: ENC_KEY,
    });

    const { resolved, missing } = await resolveDeclaredTestCredentials(db, {
      businessId: "biz-a",
      repoOwner: "trycycloid",
      repoName: "repo-x",
      declarations: [{ name: "test_token", envVar: "E2E_TOKEN" }],
      encryptionKey: "wrong-key-cccccccccccccccccccccccc",
    });
    expect(resolved).toEqual([]);
    expect(missing).toEqual([{ name: "test_token", envVar: "E2E_TOKEN", reason: "decrypt_failed" }]);
  });
});
