import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  insertToolRollupRows,
  type PromptToolRollupRow,
} from "../../apps/control-plane-worker/src/session/tool-rollup-db";

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

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number } } {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  batchSizes: number[] = [];

  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    this.batchSizes.push(statements.length);
    const run = this.db.transaction((items: SqliteD1Statement[]) => items.map((statement) => statement.runSync()));
    return run(statements);
  }

  all<T>(query: string): T[] {
    return this.db.prepare(query).all() as T[];
  }
}

function createDb(): SqliteD1 {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0190_prompt_tool_rollup.sql", "utf8"));
  return new SqliteD1(sqlite);
}

function row(overrides: Partial<PromptToolRollupRow> = {}): PromptToolRollupRow {
  return {
    sessionId: "s-1",
    promptId: "p-1",
    businessId: "biz-1",
    ownerUserId: 123,
    agent: "codex",
    toolName: "read",
    mcpServer: null,
    okCount: 1,
    errorCount: 0,
    totalDurationMs: 10,
    durationSampleCount: 1,
    createdAt: 1000,
    ...overrides,
  };
}

describe("insertToolRollupRows", () => {
  it("is a no-op for empty rows", async () => {
    const db = createDb();

    await expect(insertToolRollupRows(db as unknown as D1Database, [])).resolves.toEqual([]);

    expect(db.batchSizes).toEqual([]);
    expect(db.all("SELECT * FROM prompt_tool_rollup")).toEqual([]);
  });

  it("inserts rows and returns only rows inserted by ON CONFLICT", async () => {
    const db = createDb();
    const first = row();
    const second = row({ toolName: "bash", okCount: 0, errorCount: 1, totalDurationMs: 0, durationSampleCount: 0 });

    expect(await insertToolRollupRows(db as unknown as D1Database, [first, second])).toEqual([first, second]);
    expect(await insertToolRollupRows(db as unknown as D1Database, [first, second])).toEqual([]);

    expect(
      db.all<{ tool_name: string; ok_count: number; error_count: number }>(
        "SELECT tool_name, ok_count, error_count FROM prompt_tool_rollup ORDER BY tool_name",
      ),
    ).toEqual([
      { tool_name: "bash", ok_count: 0, error_count: 1 },
      { tool_name: "read", ok_count: 1, error_count: 0 },
    ]);
  });

  it("chunks large writes into bounded D1 batches", async () => {
    const db = createDb();
    const rows = Array.from({ length: 105 }, (_, index) => row({ toolName: `tool_${index}` }));

    const inserted = await insertToolRollupRows(db as unknown as D1Database, rows);

    expect(inserted).toHaveLength(105);
    expect(db.batchSizes).toEqual([50, 50, 5]);
    expect(db.all<{ count: number }>("SELECT count(*) AS count FROM prompt_tool_rollup")).toEqual([{ count: 105 }]);
  });
});
