/**
 * Migration 0234 rebuild test (ARC-1330 W11 D-56).
 *
 * 0234 rebuilds user_settings to drop `auto_create_pr_enabled`. A table rebuild
 * (create → copy → drop → rename) can silently lose rows or corrupt values, so
 * this asserts SF11: post-rebuild ROW-COUNT PARITY and VALUE SURVIVAL for every
 * kept column, plus that the dropped column is actually gone.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const DROP_MIGRATION = "0234_drop_auto_create_pr_user_setting.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply every migration strictly before 0234 — the schema still has auto_create_pr_enabled. */
function buildDbBeforeDrop(): Database.Database {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    if (file >= DROP_MIGRATION) break;
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

const KEPT_COLUMNS = [
  "user_id",
  "theme",
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

describe("migration 0234: drop user_settings.auto_create_pr_enabled", () => {
  it("preserves row count and every kept column value while dropping the column", () => {
    const db = buildDbBeforeDrop();

    // Pre-drop the column exists.
    const preCols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(preCols).toContain("auto_create_pr_enabled");

    db.exec(`INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES ('b1', 'B', 1, 1, 1)`);
    db.exec(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at) VALUES
         (1001, 9001, 'alice', 'Alice', 'a@x.dev', NULL, 'b1', 10, 11),
         (1002, 9002, 'bob', NULL, NULL, NULL, 'b1', 20, 21),
         (1003, 9003, 'carol', 'Carol', 'c@x.dev', 'http://a/av', 'b1', 30, 31)`,
    );
    // Varied values across every kept column, and BOTH auto_create_pr_enabled states (0 and 1).
    db.exec(
      `INSERT INTO user_settings
         (user_id, theme, default_model, custom_instructions, created_at, updated_at, default_repo,
          pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in, auto_create_pr_enabled,
          use_codex_subscription, default_pr_draft, auto_verify_enabled)
       VALUES
         (1001, 'dark',   'gpt-5.4', 'be terse', 100, 101, 'owner/repo', 1, 0, 0, 1, 1, 0),
         (1002, 'light',  NULL,       NULL,       200, 201, NULL,         0, 1, 1, 0, 0, 1),
         (1003, 'system', 'claude',   'x',        300, 301, 'p/q',        1, 1, 0, 1, 1, 1)`,
    );

    const before = db.prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM user_settings ORDER BY user_id`).all() as Record<
      string,
      unknown
    >[];

    db.exec(readFileSync(resolve(MIGRATIONS_DIR, DROP_MIGRATION), "utf-8"));

    // Column is gone.
    const postCols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(postCols).not.toContain("auto_create_pr_enabled");
    expect(postCols).toEqual([...KEPT_COLUMNS]);

    // Primary key survives the rebuild (user_id stays the PK, so upserts still key on it).
    const pk = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string; pk: number }[]).find(
      (c) => c.pk === 1,
    );
    expect(pk?.name).toBe("user_id");

    const after = db.prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM user_settings ORDER BY user_id`).all() as Record<
      string,
      unknown
    >[];

    // Row-count parity (SF11).
    expect(after.length).toBe(before.length);
    // Value survival for every kept column of every row.
    expect(after).toEqual(before);
  });

  it("is a no-op-safe rebuild on an empty table (zero rows in, zero rows out)", () => {
    const db = buildDbBeforeDrop();
    db.exec("DELETE FROM user_settings");
    expect((db.prepare("SELECT COUNT(*) AS n FROM user_settings").get() as { n: number }).n).toBe(0);

    db.exec(readFileSync(resolve(MIGRATIONS_DIR, DROP_MIGRATION), "utf-8"));

    const cols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("auto_create_pr_enabled");
    expect((db.prepare("SELECT COUNT(*) AS n FROM user_settings").get() as { n: number }).n).toBe(0);
  });
});
