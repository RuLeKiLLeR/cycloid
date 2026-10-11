import { describe, expect, it } from "vitest";

import { initSchema, MIGRATIONS } from "../../apps/control-plane-worker/src/session/schema.js";
import { FakeSqlStorage } from "./helpers/worker-harness";

describe("session schema migrations", () => {
  it("backfills last_push_succeeded for existing durable object session tables", () => {
    expect(MIGRATIONS).toContainEqual({
      id: 42,
      sql: "ALTER TABLE session ADD COLUMN last_push_succeeded INTEGER NOT NULL DEFAULT 0;",
      ignoreDuplicateColumn: true,
    });
  });

  it("registers the disconnect_retry_count prompts migration", () => {
    expect(MIGRATIONS).toContainEqual({
      id: 90,
      sql: "ALTER TABLE prompts ADD COLUMN disconnect_retry_count INTEGER NOT NULL DEFAULT 0;",
      ignoreDuplicateColumn: true,
    });
  });

  it("registers the verification runtime mode session migration", () => {
    expect(MIGRATIONS).toContainEqual({
      id: 91,
      sql: "ALTER TABLE session ADD COLUMN verification_runtime_mode TEXT;",
      ignoreDuplicateColumn: true,
    });
  });

  it("registers the plan Auto reason session migration", () => {
    expect(MIGRATIONS).toContainEqual({
      id: 145,
      sql: "ALTER TABLE session ADD COLUMN plan_auto_reason TEXT;",
      ignoreDuplicateColumn: true,
    });
  });

  it("registers the qa testing persisted contract migrations", () => {
    expect(MIGRATIONS).toEqual(
      expect.arrayContaining([
        {
          id: 103,
          sql: "ALTER TABLE session ADD COLUMN qa_testing_state TEXT;",
          ignoreDuplicateColumn: true,
        },
        {
          id: 106,
          sql: "ALTER TABLE session ADD COLUMN qa_testing_attempt_count INTEGER NOT NULL DEFAULT 0;",
          ignoreDuplicateColumn: true,
        },
        {
          id: 110,
          sql: "UPDATE session SET qa_testing_state = CASE verification_state WHEN 'verification-pending' THEN 'qa-pending' WHEN 'verification-in-progress' THEN 'qa-in-progress' WHEN 'verification-done' THEN 'qa-done' WHEN 'verification-skipped' THEN 'qa-skipped' WHEN 'verification-stopped' THEN 'qa-stopped' WHEN 'verification-exhausted' THEN 'qa-exhausted' ELSE qa_testing_state END WHERE qa_testing_state IS NULL AND verification_state IS NOT NULL;",
        },
      ]),
    );
  });

  it("adds qa testing columns on a fresh durable object", () => {
    const { sql } = new FakeSqlStorage();
    initSchema(sql as unknown as Parameters<typeof initSchema>[0]);

    const columns = sql.exec("SELECT name FROM pragma_table_info('session')").toArray();
    expect(columns.map((row) => row.name)).toEqual(
      expect.arrayContaining(["qa_testing_state", "qa_testing_attempt_count", "qa_testing_max_attempts"]),
    );
  });

  it("adds plan Auto reason on a fresh durable object", () => {
    const { sql } = new FakeSqlStorage();
    initSchema(sql as unknown as Parameters<typeof initSchema>[0]);

    const columns = sql.exec("SELECT name FROM pragma_table_info('session')").toArray();
    expect(columns.map((row) => row.name)).toContain("plan_auto_reason");
  });

  it("drops writer-less done-state DO mirror columns with idempotent migrations", () => {
    expect(MIGRATIONS).toEqual(
      expect.arrayContaining([
        { id: 131, sql: "ALTER TABLE session DROP COLUMN review_loop_done_state;", ignoreMissingColumn: true },
        { id: 132, sql: "ALTER TABLE session DROP COLUMN arcanist_done_state;", ignoreMissingColumn: true },
        { id: 133, sql: "ALTER TABLE session DROP COLUMN arcanist_done_outcome;", ignoreMissingColumn: true },
        { id: 134, sql: "ALTER TABLE session DROP COLUMN arcanist_done_reasons_json;", ignoreMissingColumn: true },
      ]),
    );
  });

  it("adds disconnect_retry_count defaulting to 0 on a fresh durable object", () => {
    const { sql } = new FakeSqlStorage();
    initSchema(sql as unknown as Parameters<typeof initSchema>[0]);

    sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, updated_at)
       VALUES ('p-1', 'session-1', 'hello', 'queued', 1, 1)`,
    );
    const rows = sql.exec("SELECT disconnect_retry_count FROM prompts WHERE prompt_id = 'p-1'").toArray() as Array<{
      disconnect_retry_count: number;
    }>;
    expect(rows[0]?.disconnect_retry_count).toBe(0);
  });

  it("backfills disconnect_retry_count to 0 for rows on an existing prompts table", () => {
    const { sql } = new FakeSqlStorage();
    // Simulate a pre-migration durable object: prompts table without the column.
    sql.exec(
      `CREATE TABLE prompts (
        prompt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, updated_at)
       VALUES ('legacy-1', 'session-1', 'old', 'completed', 1, 1)`,
    );

    sql.exec("ALTER TABLE prompts ADD COLUMN disconnect_retry_count INTEGER NOT NULL DEFAULT 0;");

    const rows = sql
      .exec("SELECT disconnect_retry_count FROM prompts WHERE prompt_id = 'legacy-1'")
      .toArray() as Array<{ disconnect_retry_count: number }>;
    expect(rows[0]?.disconnect_retry_count).toBe(0);
  });
});
