import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { upsertSessionPrMetadata } from "../../apps/control-plane-worker/src/session/pr-metadata-db";

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
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(
    "CREATE TABLE session_completions (session_id TEXT, pr_url TEXT, pr_draft INTEGER, completed_at INTEGER)",
  );
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0210_session_pr_metadata.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("upsertSessionPrMetadata", () => {
  it("updates fixed columns while preserving created_at and non-null source_prompt_id", async () => {
    await upsertSessionPrMetadata(db, {
      sessionId: "s1",
      prUrl: "https://github.com/acme/repo/pull/1",
      prNumber: 1,
      prDraft: true,
      publishedBranch: "feature-a",
      sourcePromptId: "prompt-1",
      now: 100,
    });

    await upsertSessionPrMetadata(db, {
      sessionId: "s1",
      prUrl: "https://github.com/acme/repo/pull/1",
      prNumber: 2,
      prDraft: false,
      publishedBranch: "feature-b",
      sourcePromptId: null,
      now: 200,
    });

    const row = sqlite.prepare("SELECT * FROM session_pr_metadata").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      session_id: "s1",
      pr_url: "https://github.com/acme/repo/pull/1",
      pr_number: 2,
      pr_draft: 0,
      published_branch: "feature-b",
      source_prompt_id: "prompt-1",
      created_at: 100,
      updated_at: 200,
    });
  });
});
