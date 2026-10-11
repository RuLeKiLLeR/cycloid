/**
 * Migration 0254 CHECK-widening table-rebuild test.
 *
 * 0254 widens pr_review_response_epochs.source_kind CHECK to add 'mention'
 * (@cycloid mention epochs). SQLite cannot alter a CHECK in place, so the
 * migration rebuilds the table -- a high-risk operation because the rebuilt
 * table must reproduce the pre-0254 schema EXACTLY. This asserts:
 *   (a) an INSERT with source_kind='mention' now SUCCEEDS,
 *   (b) an INSERT with an unknown source_kind still fails the CHECK,
 *   (c) every prior source_kind ('bot','human','mixed','ci','verification',
 *       'merge_conflict') is still accepted,
 *   (d) the rebuild loses no columns (PRAGMA table_info names identical
 *       before vs after 0254),
 *   (e) an existing row is copied through the rebuild verbatim.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const REBUILD_MIGRATION = "0254_review_loop_mention_source_kind.sql";

const PRIOR_SOURCE_KINDS = ["bot", "human", "mixed", "ci", "verification", "merge_conflict"] as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function buildDbBeforeMigration(): Database.Database {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    if (file >= REBUILD_MIGRATION) break;
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function applyMigration(db: Database.Database): void {
  db.exec(readFileSync(resolve(MIGRATIONS_DIR, REBUILD_MIGRATION), "utf-8"));
}

function tableColumnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(pr_review_response_epochs)").all() as { name: string }[]).map((c) => c.name);
}

// Inserts one epoch row supplying every NOT NULL column that lacks a default.
// `id` keeps rows unique; it also seeds expected_bots_hash so rows never collide
// on idx_pr_review_response_epochs_unique. `sourceKind` is the value under test.
function insertEpoch(db: Database.Database, id: string, sourceKind: string): void {
  db.prepare(
    `INSERT INTO pr_review_response_epochs
       (id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha,
        expected_bots_hash, expected_bots_json, expected_bot_keys_json,
        first_activity_at, fallback_after_at, status, created_at, updated_at, source_kind)
     VALUES
       (@id, 'sess-1', 1, 'owner', 'repo', 7, 'https://github.com/owner/repo/pull/7', 'deadbeef',
        @id, '[]', '[]', 100, 200, 'ready', 100, 100, @sourceKind)`,
  ).run({ id, sourceKind });
}

describe("migration 0254: widen pr_review_response_epochs.source_kind CHECK to add 'mention'", () => {
  it("accepts source_kind='mention' after the rebuild and rejects unknown values", () => {
    const db = buildDbBeforeMigration();

    // Before 0254, 'mention' is not a valid source_kind.
    expect(() => insertEpoch(db, "before-mention", "mention")).toThrow(/CHECK/i);

    applyMigration(db);

    // (a) 'mention' now succeeds.
    expect(() => insertEpoch(db, "after-mention", "mention")).not.toThrow();
    const stored = db.prepare("SELECT source_kind FROM pr_review_response_epochs WHERE id = 'after-mention'").get() as {
      source_kind: string;
    };
    expect(stored.source_kind).toBe("mention");

    // (b) An unknown source_kind still fails the CHECK.
    expect(() => insertEpoch(db, "bogus", "definitely_not_a_kind")).toThrow(/CHECK/i);
  });

  it("still accepts every prior source_kind value after the rebuild", () => {
    const db = buildDbBeforeMigration();
    applyMigration(db);

    for (const kind of PRIOR_SOURCE_KINDS) {
      expect(() => insertEpoch(db, `prior-${kind}`, kind)).not.toThrow();
    }

    const count = db.prepare("SELECT COUNT(*) AS n FROM pr_review_response_epochs").get() as { n: number };
    expect(count.n).toBe(PRIOR_SOURCE_KINDS.length);
  });

  it("preserves every column through the table rebuild (no columns lost)", () => {
    const db = buildDbBeforeMigration();
    const before = tableColumnNames(db);

    applyMigration(db);

    const after = tableColumnNames(db);
    // Identical column set AND order -- the rebuild must reproduce the schema exactly.
    expect(after).toEqual(before);
  });

  it("copies existing rows through the rebuild verbatim", () => {
    const db = buildDbBeforeMigration();
    insertEpoch(db, "carried-row", "human");
    const before = db.prepare("SELECT * FROM pr_review_response_epochs WHERE id = 'carried-row'").get();

    applyMigration(db);

    const after = db.prepare("SELECT * FROM pr_review_response_epochs WHERE id = 'carried-row'").get();
    expect(after).toEqual(before);
  });
});
