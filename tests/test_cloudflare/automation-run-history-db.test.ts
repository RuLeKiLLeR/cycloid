import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { listAutomationRunHistory } from "../../apps/control-plane-worker/src/automation/run-history-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function createDatabase(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function seedScheduledRun(sqlite: Database.Database, ruleId: string, businessId: string, createdAt: number): void {
  sqlite
    .prepare(
      `INSERT INTO scheduled_rules (
        id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id,
        prompt_template, cron_expression, normalized_cron, name, enabled,
        next_fire_at, created_at, updated_at
      ) VALUES (?, ?, '1', 'acme', ?, 1, ?, '0 * * * *', '0 * * * *', ?, 1, ?, ?, ?)`,
    )
    .run(ruleId, businessId, ruleId, `prompt-${ruleId}`, `Rule ${ruleId}`, createdAt + 1_000, createdAt, createdAt);
  sqlite
    .prepare(
      `INSERT INTO automation_slot_jobs (
        job_key, rule_id, slot_ms, session_id, prompt_template, installation_id,
        phase, terminal_outcome, retry_after_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'prompt_enqueued', 'fired', ?, ?, ?)`,
    )
    .run(`job-${ruleId}`, ruleId, createdAt, `session-${ruleId}`, `prompt-${ruleId}`, createdAt, createdAt, createdAt);
}

describe("listAutomationRunHistory", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    ({ sqlite, db } = createDatabase());
  });

  it("scopes runs to the business and paginates deterministically from the last visible row", async () => {
    seedScheduledRun(sqlite, "a", "biz-1", 3_000);
    seedScheduledRun(sqlite, "b", "biz-1", 2_000);
    seedScheduledRun(sqlite, "other", "biz-2", 4_000);

    const first = await listAutomationRunHistory(db, { businessId: "biz-1", cursor: null, limit: 1 });
    expect(first.map((row) => row.id)).toEqual(["job-a"]);

    const second = await listAutomationRunHistory(db, {
      businessId: "biz-1",
      cursor: { createdAt: first[0]!.created_at, id: first[0]!.id, source: first[0]!.source },
      limit: 2,
    });
    expect(second.map((row) => row.id)).toEqual(["job-b"]);
  });
});
