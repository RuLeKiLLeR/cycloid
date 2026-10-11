import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteBusinessCascade,
  type OffboardingJob,
  quoteSqlIdentifier,
} from "../../apps/control-plane-worker/src/business/db";
import { SqliteD1 } from "./sqlite-d1-helper";

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE business_members (business_id TEXT, user_id INTEGER, role TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY, business_id TEXT, login TEXT);
    CREATE TABLE session_index (session_id TEXT PRIMARY KEY, owner_user_id TEXT, business_id TEXT);
    CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, user_id INTEGER);
    CREATE TABLE cli_tokens (id TEXT PRIMARY KEY, user_id INTEGER);
    CREATE TABLE session_webhook_refs (source TEXT, external_ref TEXT, session_id TEXT);
    CREATE TABLE durable_event_replay_metadata (session_id TEXT PRIMARY KEY);
    CREATE TABLE usage_records (id TEXT PRIMARY KEY, session_id TEXT, owner_user_id INTEGER, business_id TEXT);
    CREATE TABLE automation_rules (id TEXT PRIMARY KEY, business_id TEXT);
    CREATE TABLE "select" (id TEXT PRIMARY KEY, business_id TEXT);
    CREATE TABLE offboarding_jobs (job_id TEXT PRIMARY KEY, business_id TEXT);
  `);
  // Minimal schema needed for deleteBusinessCascade personal-secret cleanup.
  sqlite.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0069_env_blobs.sql"), "utf8"));
  sqlite.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0252_env_blob_entry_meta.sql"), "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("business offboarding cascade", () => {
  it("deletes captured business rows without touching another business", async () => {
    seedBusiness("biz-a", 1, "s-a");
    seedBusiness("biz-b", 2, "s-b");
    sqlite.prepare("INSERT INTO automation_rules (id, business_id) VALUES (?, ?)").run("rule-a", "biz-a");
    sqlite.prepare("INSERT INTO automation_rules (id, business_id) VALUES (?, ?)").run("rule-b", "biz-b");
    sqlite.prepare('INSERT INTO "select" (id, business_id) VALUES (?, ?)').run("quoted-a", "biz-a");
    sqlite.prepare("INSERT INTO offboarding_jobs (job_id, business_id) VALUES (?, ?)").run("job-a", "biz-a");

    const result = await deleteBusinessCascade(db, job("biz-a", [1], ["s-a"]));

    expect(count("businesses", "id = 'biz-a'")).toBe(0);
    expect(count("users", "id = 1")).toBe(0);
    expect(count("session_index", "session_id = 's-a'")).toBe(0);
    expect(count("auth_sessions", "user_id = 1")).toBe(0);
    expect(count("session_webhook_refs", "session_id = 's-a'")).toBe(0);
    expect(count("automation_rules", "business_id = 'biz-a'")).toBe(0);
    expect(count('"select"', "business_id = 'biz-a'")).toBe(0);
    expect(count("usage_records", "business_id = 'biz-a'")).toBe(0);
    expect(count("offboarding_jobs", "business_id = 'biz-a'")).toBe(1);

    expect(count("businesses", "id = 'biz-b'")).toBe(1);
    expect(count("users", "id = 2")).toBe(1);
    expect(count("session_index", "session_id = 's-b'")).toBe(1);
    expect(count("usage_records", "business_id = 'biz-b'")).toBe(1);
    expect(result.directBusinessTables).toContain("automation_rules");
    expect(result.directBusinessTables).not.toContain("session_index");
    expect(result.directBusinessTables).not.toContain("offboarding_jobs");
  });

  it("uses captured ids on rerun after roots are gone", async () => {
    seedBusiness("biz-a", 1, "s-a");
    sqlite.prepare("DELETE FROM businesses WHERE id = 'biz-a'").run();
    sqlite.prepare("DELETE FROM users WHERE id = 1").run();
    sqlite.prepare("DELETE FROM session_index WHERE session_id = 's-a'").run();

    await deleteBusinessCascade(db, job("biz-a", [1], ["s-a"]));

    expect(count("auth_sessions", "user_id = 1")).toBe(0);
    expect(count("session_webhook_refs", "session_id = 's-a'")).toBe(0);
  });

  it("quotes safe identifiers and rejects system or unsafe identifiers", () => {
    expect(quoteSqlIdentifier("select")).toBe('"select"');
    expect(() => quoteSqlIdentifier("bad-name")).toThrow("Unsafe SQL identifier");
    expect(() => quoteSqlIdentifier("sqlite_schema")).toThrow("System SQL identifier");
    expect(() => quoteSqlIdentifier("_cf_METADATA")).toThrow("System SQL identifier");
  });
});

function seedBusiness(businessId: string, userId: number, sessionId: string): void {
  sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(businessId, businessId, 1, 1);
  sqlite
    .prepare("INSERT INTO business_members (business_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(businessId, userId, "admin", 1, 1);
  sqlite
    .prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)")
    .run(userId, businessId, `user-${userId}`);
  sqlite
    .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
    .run(sessionId, String(userId), businessId);
  sqlite.prepare("INSERT INTO auth_sessions (token, user_id) VALUES (?, ?)").run(`auth-${userId}`, userId);
  sqlite.prepare("INSERT INTO cli_tokens (id, user_id) VALUES (?, ?)").run(`cli-${userId}`, userId);
  sqlite
    .prepare("INSERT INTO session_webhook_refs (source, external_ref, session_id) VALUES (?, ?, ?)")
    .run("linear", `issue-${userId}`, sessionId);
  sqlite.prepare("INSERT INTO durable_event_replay_metadata (session_id) VALUES (?)").run(sessionId);
  sqlite
    .prepare("INSERT INTO usage_records (id, session_id, owner_user_id, business_id) VALUES (?, ?, ?, ?)")
    .run(`usage-${userId}`, sessionId, userId, businessId);
}

function job(businessId: string, userIds: number[], sessionIds: string[]): OffboardingJob {
  return {
    jobId: `job-${businessId}`,
    businessId,
    archiveKey: `offboard-archive/${businessId}/job-${businessId}`,
    capturedUserIds: userIds,
    capturedSessionIds: sessionIds,
    phase: "captured",
    stepMarkers: {},
    tableCounts: {},
    externalResults: {},
    error: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
}

function count(table: string, where: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}
