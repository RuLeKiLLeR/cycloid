import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import { UPSERT_SESSION_INDEX_SQL } from "../../../apps/control-plane-worker/src/session/db";
import { SqliteD1 } from "../sqlite-d1-helper";

export const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

const FACTORY_OWNED_TABLES = ["business_members", "users", "businesses", "automation_rules"] as const;
const DEFAULT_SEED_TIMESTAMP = 1_700_000_000_000;

export interface SeedBusinessOptions {
  id?: string;
  name?: string;
  sharedSessions?: boolean;
  egressAllowlistJson?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface SeedUserOptions {
  id?: number;
  businessId?: string;
  login?: string;
  githubId?: number;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  member?: boolean;
  role?: string;
}

export interface SeedSessionIndexOptions {
  sessionId: string;
  businessId?: string;
  ownerUserId?: number;
  status?: string;
  richStatus?: string | null;
  createdAt?: number | string;
  updatedAt?: number | string;
  closedAt?: number | string | null;
  lastEventId?: string | null;
  title?: string | null;
  titleTags?: string[] | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentRuntimeBackend?: string | null;
  agentRole?: string | null;
  targetPrUrl?: string | null;
  installationId?: number | null;
  repoOwner?: string | null;
  repoName?: string | null;
  callbackContextJson?: string | null;
  parentSessionId?: string | null;
  parentPromptId?: string | null;
  spawnedByUserId?: number | null;
  spawnDepth?: number;
  initiationMode?: string;
  entrypoint?: string | null;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
}

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function clearSeedRows(db: Database.Database): void {
  // Data-seed migrations may create rows in tables outside this helper's
  // factory-owned set. Disable enforcement only while removing those known
  // seed parents, then restore the production setting before returning.
  db.pragma("foreign_keys = OFF");
  // Data-seed migrations can insert dependent rows for their seeded users;
  // remove those before deleting the parent rows.
  db.prepare("DELETE FROM user_settings").run();
  for (const table of FACTORY_OWNED_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare(
    "DELETE FROM sqlite_sequence WHERE name IN ('users', 'businesses', 'business_members', 'automation_rules')",
  ).run();
  db.pragma("foreign_keys = ON");
}

function createMigrationBookkeeping(db: Database.Database, files: string[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const insert = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  const insertAll = db.transaction(() => {
    for (const file of files) insert.run(file);
  });
  insertAll();
}

/** Apply the complete production D1 schema with foreign-key enforcement enabled. */
export function applyMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const files = getMigrationFiles();
  for (const file of files) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  clearSeedRows(db);
  createMigrationBookkeeping(db, files);
}

let serializedSchema: Buffer | undefined;

/** Create a fresh D1-shaped database from a cached, fully migrated schema template. */
export function createControlPlaneD1(): { sqlite: Database.Database; d1: D1Database } {
  if (!serializedSchema) {
    const template = new Database(":memory:");
    applyMigrations(template);
    serializedSchema = template.serialize();
    template.close();
  }

  const sqlite = new Database(serializedSchema);
  sqlite.pragma("foreign_keys = ON");
  const d1 = new SqliteD1(sqlite) as unknown as D1Database;
  return { sqlite, d1 };
}

export function seedBusiness(db: Database.Database, options: SeedBusinessOptions = {}): { id: string } {
  const id = options.id ?? "biz-1";
  const createdAt = options.createdAt ?? DEFAULT_SEED_TIMESTAMP;
  const updatedAt = options.updatedAt ?? createdAt;
  db.prepare(
    `INSERT INTO businesses (id, name, shared_sessions, egress_allowlist_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    id,
    options.name ?? `Test Business ${id}`,
    options.sharedSessions ? 1 : 0,
    options.egressAllowlistJson ?? null,
    createdAt,
    updatedAt,
  );
  return { id };
}

export function seedUser(db: Database.Database, options: SeedUserOptions = {}): { id: number; businessId: string } {
  const businessId = options.businessId ?? "biz-1";
  seedBusiness(db, { id: businessId });
  const id = options.id;
  const githubId =
    options.githubId ??
    id ??
    (db.prepare("SELECT COALESCE(MAX(github_id), 1_000_000) + 1 AS github_id FROM users").pluck().get() as number);
  const login = options.login ?? `test-user-${githubId}`;
  const timestamp = DEFAULT_SEED_TIMESTAMP;
  let row = db.prepare("SELECT id, business_id FROM users WHERE github_id = ? LIMIT 1").get(githubId) as
    { id: number; business_id: string } | undefined;
  if (row && ((id !== undefined && row.id !== id) || row.business_id !== businessId)) {
    throw new Error(`User github_id ${githubId} is already seeded with different identity or business`);
  }
  if (!row) {
    const values = [
      ...(id === undefined ? [] : [id]),
      githubId,
      login,
      options.name ?? null,
      options.email ?? null,
      options.avatarUrl ?? null,
      businessId,
      timestamp,
      timestamp,
    ];
    const columns = id === undefined ? "github_id" : "id, github_id";
    const placeholders = id === undefined ? "?" : "?, ?";
    db.prepare(
      `INSERT INTO users (${columns}, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (${placeholders}, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO NOTHING`,
    ).run(...values);
    row = db.prepare("SELECT id, business_id FROM users WHERE github_id = ? LIMIT 1").get(githubId) as
      { id: number; business_id: string } | undefined;
  }
  if (!row) throw new Error(`Failed to seed user ${login}`);

  if (options.member ?? true) {
    db.prepare(
      `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET business_id = excluded.business_id,
         role = excluded.role, updated_at = excluded.updated_at`,
    ).run(businessId, row.id, options.role ?? "member", timestamp, timestamp);
  } else {
    db.prepare("DELETE FROM business_members WHERE user_id = ?").run(row.id);
  }

  return { id: row.id, businessId };
}

function toUnixMs(value: number | string | null | undefined, fallback: number | null): number | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid session index timestamp: ${value}`);
  return parsed;
}

export function seedSessionIndex(
  db: Database.Database,
  options: SeedSessionIndexOptions,
): { sessionId: string; businessId: string; ownerUserId: number } {
  const businessId = options.businessId ?? "biz-1";
  const ownerUserId = options.ownerUserId ?? 1;
  seedBusiness(db, { id: businessId });
  seedUser(db, { id: ownerUserId, businessId, githubId: ownerUserId });
  const createdAt = toUnixMs(options.createdAt, DEFAULT_SEED_TIMESTAMP) as number;
  const updatedAt = toUnixMs(options.updatedAt, createdAt) as number;
  const closedAt = toUnixMs(options.closedAt, null);

  db.prepare(UPSERT_SESSION_INDEX_SQL).run(
    options.sessionId,
    ownerUserId,
    businessId,
    options.status ?? "active",
    createdAt,
    updatedAt,
    closedAt,
    options.lastEventId ?? null,
    options.title ?? null,
    options.titleTags ? JSON.stringify(options.titleTags) : null,
    options.richStatus ?? null,
    options.model ?? null,
    options.reasoningEffort ?? null,
    options.agentRuntimeBackend ?? null,
    options.agentRole ?? null,
    options.targetPrUrl ?? null,
    options.installationId ?? null,
    options.repoOwner ?? null,
    options.repoName ?? null,
    options.callbackContextJson ?? null,
    options.parentSessionId ?? null,
    options.parentPromptId ?? null,
    options.spawnedByUserId ?? null,
    options.spawnDepth ?? 0,
    options.initiationMode ?? "user",
    options.entrypoint ?? null,
    options.scheduledRuleId ?? null,
    options.ruleNameSnapshot ?? null,
    options.cronSnapshot ?? null,
  );
  return { sessionId: options.sessionId, businessId, ownerUserId };
}
