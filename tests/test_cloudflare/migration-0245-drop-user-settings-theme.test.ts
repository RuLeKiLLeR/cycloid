/**
 * Migration 0245 rebuild test.
 *
 * 0245 rebuilds user_settings to drop the dead theme column. A table rebuild can
 * silently drop or rewrite data, so this asserts the remaining columns survive
 * verbatim and the user_id primary key is preserved.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const REBUILD_MIGRATION = "0245_drop_user_settings_theme.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function buildDbBeforeRebuild(): Database.Database {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    if (file >= REBUILD_MIGRATION) break;
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

const KEPT_COLUMNS = [
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

describe("migration 0245: drop user_settings.theme", () => {
  it("drops theme while preserving remaining user_settings data and primary key", () => {
    const db = buildDbBeforeRebuild();

    const preCols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(preCols).toContain("theme");

    db.exec(`INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES ('b1', 'B', 1, 1, 1)`);
    db.exec(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at) VALUES
         (1001, 9001, 'alice', 'Alice', 'a@x.dev', NULL, 'b1', 10, 11),
         (1002, 9002, 'bob', NULL, NULL, NULL, 'b1', 20, 21)`,
    );
    db.exec(
      `INSERT INTO user_settings
         (user_id, theme, default_model, custom_instructions, created_at, updated_at, default_repo,
          pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
          use_codex_subscription, default_pr_draft, auto_verify_enabled)
       VALUES
         (1001, 'dark',  'gpt-5.4', 'be terse', 100, 101, 'owner/repo', 1, 0, 1, 1, 1),
         (1002, 'light', NULL,       NULL,       200, 201, NULL,         0, 1, 0, 0, 0)`,
    );

    const before = db.prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM user_settings ORDER BY user_id`).all();

    db.exec(readFileSync(resolve(MIGRATIONS_DIR, REBUILD_MIGRATION), "utf-8"));

    const postCols = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(postCols).toEqual([...KEPT_COLUMNS]);
    expect(postCols).not.toContain("theme");

    const pk = (db.prepare("PRAGMA table_info(user_settings)").all() as { name: string; pk: number }[]).find(
      (c) => c.pk === 1,
    );
    expect(pk?.name).toBe("user_id");

    const after = db.prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM user_settings ORDER BY user_id`).all();
    expect(after).toEqual(before);
  });
});
