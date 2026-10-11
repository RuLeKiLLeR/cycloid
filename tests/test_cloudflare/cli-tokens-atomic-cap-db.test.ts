import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { insertCliTokenIfBelowLimit } from "../../apps/control-plane-worker/src/auth/cli-tokens";

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
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
  async run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  // cli_tokens.user_id REFERENCES users(id); create a minimal users table first.
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY);");
  sqlite.exec("INSERT INTO users (id) VALUES (1), (2);");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0043_cli_tokens.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0045_drop_cli_tokens_name.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0056_cli_token_scopes.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0092_allow_multiple_cli_tokens.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

function activeCount(userId: number): number {
  // Mirror the cap predicate in insertCliTokenIfBelowLimit exactly: non-revoked
  // AND not expired. Counting all non-revoked rows would over-count once a test
  // adds an expiring token, diverging from what the production statement caps on.
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) AS c FROM cli_tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    )
    .get(userId, Date.now()) as { c: number };
  return row.c;
}

describe("insertCliTokenIfBelowLimit (atomic cap)", () => {
  it("inserts up to the cap and refuses the one that would exceed it", async () => {
    const cap = 3;
    for (let i = 0; i < cap; i += 1) {
      const id = await insertCliTokenIfBelowLimit(db, 1, `hash-${i}`, "arc_abcd", "read", cap);
      expect(id).not.toBeNull();
    }
    expect(activeCount(1)).toBe(cap);

    // The (cap+1)th insert is refused in-statement: no row written, null returned.
    const over = await insertCliTokenIfBelowLimit(db, 1, "hash-over", "arc_abcd", "read", cap);
    expect(over).toBeNull();
    expect(activeCount(1)).toBe(cap);
  });

  it("counts only the user's own active tokens", async () => {
    const cap = 1;
    expect(await insertCliTokenIfBelowLimit(db, 1, "u1", "arc_abcd", "read", cap)).not.toBeNull();
    // A different user is unaffected by user 1 hitting the cap.
    expect(await insertCliTokenIfBelowLimit(db, 2, "u2", "arc_abcd", "read", cap)).not.toBeNull();
    expect(await insertCliTokenIfBelowLimit(db, 1, "u1-again", "arc_abcd", "read", cap)).toBeNull();
  });

  it("excludes revoked and expired tokens from the cap", async () => {
    const cap = 1;
    const id = await insertCliTokenIfBelowLimit(db, 1, "live", "arc_abcd", "read", cap);
    expect(id).not.toBeNull();
    // Capped now.
    expect(await insertCliTokenIfBelowLimit(db, 1, "blocked", "arc_abcd", "read", cap)).toBeNull();

    // Revoke the live token: a new one is allowed again.
    sqlite.prepare("UPDATE cli_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
    expect(await insertCliTokenIfBelowLimit(db, 1, "after-revoke", "arc_abcd", "read", cap)).not.toBeNull();
  });

  it("an already-expired token neither counts toward the cap nor in activeCount", async () => {
    const cap = 1;
    // expiresAt in the past: the cap predicate excludes it, so the insert lands
    // and a later live token still fits under cap=1.
    const expiredId = await insertCliTokenIfBelowLimit(db, 1, "expired", "arc_abcd", "read", cap, Date.now() - 1);
    expect(expiredId).not.toBeNull();
    expect(activeCount(1)).toBe(0);
    expect(await insertCliTokenIfBelowLimit(db, 1, "live", "arc_abcd", "read", cap)).not.toBeNull();
    expect(activeCount(1)).toBe(1);
  });
});
