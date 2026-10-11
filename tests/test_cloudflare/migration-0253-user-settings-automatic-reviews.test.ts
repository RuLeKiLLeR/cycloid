/**
 * Migration 0253 additive-column test.
 *
 * 0253 adds user_settings.automatic_reviews_enabled (INTEGER NOT NULL DEFAULT 0)
 * so manual review mode is the product default. SQLite ADD COLUMN is not
 * idempotent and cannot rewrite existing data, so this asserts the column
 * appears, existing rows are preserved verbatim (and backfill to the 0 default),
 * and a newly-inserted row omitting the column also defaults to 0.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const ADD_COLUMN_MIGRATION = "0253_user_settings_automatic_reviews_enabled.sql";
const NEW_COLUMN = "automatic_reviews_enabled";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function buildDbBeforeMigration(): Database.Database {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    if (file >= ADD_COLUMN_MIGRATION) break;
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

// Columns present on user_settings immediately before 0253. The new column must
// not disturb any of these.
const PRIOR_COLUMNS = [
  "user_id",
  "default_model",
  "custom_instructions",
  "created_at",
  "updated_at",
  "default_repo",
  "pr_review_auto_response_enabled",
  "self_hosted_sandboxes_opt_in",
  "use_codex_subscription",
  "default_pr_draft",
  "auto_verify_enabled",
] as const;

function applyMigration(db: Database.Database): void {
  db.exec(readFileSync(resolve(MIGRATIONS_DIR, ADD_COLUMN_MIGRATION), "utf-8"));
}

describe("migration 0253: add user_settings.automatic_reviews_enabled", () => {
  it("adds the column, backfills existing rows to 0, and preserves prior columns", () => {
    const db = buildDbBeforeMigration();

    const preCols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(preCols).toEqual([...PRIOR_COLUMNS]);
    expect(preCols).not.toContain(NEW_COLUMN);

    db.exec(`INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES ('b1', 'B', 1, 1, 1)`);
    db.exec(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at) VALUES
         (1001, 9001, 'alice', 'Alice', 'a@x.dev', NULL, 'b1', 10, 11),
         (1002, 9002, 'bob', NULL, NULL, NULL, 'b1', 20, 21)`,
    );
    db.exec(
      `INSERT INTO user_settings
         (user_id, default_model, custom_instructions, created_at, updated_at, default_repo,
          pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
          use_codex_subscription, default_pr_draft, auto_verify_enabled)
       VALUES
         (1001, 'gpt-5.4', 'be terse', 100, 101, 'owner/repo', 1, 0, 1, 1, 1),
         (1002, NULL,      NULL,       200, 201, NULL,         0, 1, 0, 0, 0)`,
    );

    const before = db.prepare(`SELECT ${PRIOR_COLUMNS.join(", ")} FROM user_settings ORDER BY user_id`).all();

    applyMigration(db);

    const postCols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(postCols).toEqual([...PRIOR_COLUMNS, NEW_COLUMN]);

    const newCol = (
      db.prepare("PRAGMA table_info(user_settings)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).find((c) => c.name === NEW_COLUMN);
    expect(newCol?.notnull).toBe(1);
    expect(newCol?.dflt_value).toBe("0");

    // Prior columns survive verbatim on existing rows.
    const after = db.prepare(`SELECT ${PRIOR_COLUMNS.join(", ")} FROM user_settings ORDER BY user_id`).all();
    expect(after).toEqual(before);

    // Existing rows backfill to the 0 (manual) default. Scoped to the rows this
    // test inserted -- an earlier data migration seeds an unrelated user_settings
    // row, which must also backfill to 0 but is not asserted by exact identity.
    const existing = db
      .prepare(`SELECT user_id, ${NEW_COLUMN} AS v FROM user_settings WHERE user_id IN (1001, 1002) ORDER BY user_id`)
      .all() as { user_id: number; v: number }[];
    expect(existing).toEqual([
      { user_id: 1001, v: 0 },
      { user_id: 1002, v: 0 },
    ]);
    // No existing row escaped the 0 backfill.
    const nonZero = db.prepare(`SELECT COUNT(*) AS n FROM user_settings WHERE ${NEW_COLUMN} != 0`).get() as {
      n: number;
    };
    expect(nonZero.n).toBe(0);
  });

  it("defaults a newly-inserted row to 0 when the column is omitted", () => {
    const db = buildDbBeforeMigration();
    applyMigration(db);

    db.exec(`INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES ('b1', 'B', 1, 1, 1)`);
    db.exec(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at) VALUES
         (2001, 8001, 'carol', 'Carol', 'c@x.dev', NULL, 'b1', 30, 31)`,
    );
    // Omit automatic_reviews_enabled -- it must fall back to the NOT NULL DEFAULT 0.
    db.exec(`INSERT INTO user_settings (user_id, created_at, updated_at) VALUES (2001, 300, 301)`);

    const row = db.prepare(`SELECT ${NEW_COLUMN} AS v FROM user_settings WHERE user_id = 2001`).get() as { v: number };
    expect(row.v).toBe(0);
  });
});
