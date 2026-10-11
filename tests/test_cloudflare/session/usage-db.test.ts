import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { insertUsageRecord } from "../../../apps/control-plane-worker/src/session/usage-db";
import { SqliteD1 } from "../sqlite-d1-helper";

type BoundStatement = {
  query: string;
  values: unknown[];
};

function createMockD1(options?: {
  sessionBusinessIds?: Record<string, string>;
  userBusinessIds?: Record<string, string>;
}) {
  const statements: BoundStatement[] = [];
  const sessionBusinessIds = new Map(Object.entries(options?.sessionBusinessIds ?? {}));
  const userBusinessIds = new Map(Object.entries(options?.userBusinessIds ?? {}));

  const db = {
    prepare(query: string) {
      const stmt: BoundStatement = { query, values: [] };
      return {
        bind(...values: unknown[]) {
          stmt.values = values;
          statements.push(stmt);
          return this;
        },
        async first<T>() {
          if (query.includes("FROM session_index")) {
            const [sessionId] = stmt.values as [string];
            const businessId = sessionBusinessIds.get(String(sessionId));
            return businessId ? ({ business_id: businessId } as T) : null;
          }
          if (query.includes("FROM users")) {
            const [ownerUserId] = stmt.values as [string];
            const businessId = userBusinessIds.get(String(ownerUserId));
            return businessId ? ({ business_id: businessId } as T) : null;
          }
          throw new Error(`Unhandled first query: ${query}`);
        },
        async run() {
          return { success: true };
        },
      };
    },
    _statements: statements,
  };

  return db as unknown as D1Database & { _statements: BoundStatement[] };
}

describe("usage-db", () => {
  it("uses the explicit business id when present", async () => {
    const db = createMockD1();

    await insertUsageRecord(db, {
      sessionId: "s-1",
      promptId: "p-1",
      ownerUserId: "u-1",
      businessId: "biz-explicit",
      source: "sandbox",
      usage: {
        model: "gpt-5.4",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalCostUsd: 0.000005,
      },
    });

    expect(db._statements).toHaveLength(1);
    expect(db._statements[0].query).toContain("ON CONFLICT(id)");
    expect(db._statements[0].values[0]).toBe("usage:s-1:p-1:sandbox");
    expect(db._statements[0].values[4]).toBe("biz-explicit");
  });

  it("upserts replayed prompt usage by the deterministic natural key", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt_id TEXT,
        owner_user_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'sandbox' CHECK(source IN ('sandbox', 'evaluation')),
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd_micros INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
    const db = new SqliteD1(sqlite) as unknown as D1Database;

    await insertUsageRecord(db, {
      sessionId: "s-1",
      promptId: "p-1",
      ownerUserId: "u-1",
      businessId: "biz-1",
      source: "sandbox",
      usage: {
        model: "gpt-5.4",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalCostUsd: 0.000005,
      },
    });

    await insertUsageRecord(db, {
      sessionId: "s-1",
      promptId: "p-1",
      ownerUserId: "u-1",
      businessId: "biz-1",
      source: "sandbox",
      usage: {
        model: "gpt-5.5",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        totalCostUsd: 0.00005,
      },
    });

    const rows = sqlite
      .prepare(
        `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros
         FROM usage_records`,
      )
      .all() as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        id: "usage:s-1:p-1:sandbox",
        model: "gpt-5.5",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 40,
        cost_usd_micros: 50,
      },
    ]);
  });

  it("falls back to the indexed session business id when the payload omits it", async () => {
    const db = createMockD1({ sessionBusinessIds: { "s-1": "biz-indexed" } });

    await insertUsageRecord(db, {
      sessionId: "s-1",
      promptId: "p-1",
      ownerUserId: "u-1",
      businessId: null,
      source: "sandbox",
      usage: {
        model: "gpt-5.4",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalCostUsd: 0.000005,
      },
    });

    const insertStatement = db._statements.find((statement) => statement.query.includes("INSERT INTO usage_records"));
    expect(insertStatement?.values[4]).toBe("biz-indexed");
  });

  it("falls back to the owner user business id when the session index has no business id", async () => {
    const db = createMockD1({ userBusinessIds: { "u-1": "biz-user" } });

    await insertUsageRecord(db, {
      sessionId: "s-1",
      promptId: "p-1",
      ownerUserId: "u-1",
      businessId: null,
      source: "sandbox",
      usage: {
        model: "gpt-5.4",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalCostUsd: 0.000005,
      },
    });

    const insertStatement = db._statements.find((statement) => statement.query.includes("INSERT INTO usage_records"));
    expect(insertStatement?.values[4]).toBe("biz-user");
  });

  it("throws a named error when no usage business id can be resolved", async () => {
    const db = createMockD1();

    await expect(
      insertUsageRecord(db, {
        sessionId: "s-1",
        promptId: "p-1",
        ownerUserId: "u-1",
        businessId: null,
        source: "sandbox",
        usage: {
          model: "gpt-5.4",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          totalCostUsd: 0.000005,
        },
      }),
    ).rejects.toMatchObject({
      name: "MissingBusinessIdError",
      message: expect.stringContaining("usage_records insert"),
    });
  });
});
