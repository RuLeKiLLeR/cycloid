import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CRON_SWEEP_CURSOR_MIGRATION = readFileSync(
  resolve(__dirname, "../../apps/control-plane-worker/migrations/0200_cron_sweep_cursors.sql"),
  "utf-8",
);

const mockPostCountMetricSeries = vi.fn();

vi.mock("../../apps/control-plane-worker/src/observability/pr-metrics", () => ({
  postCountMetricSeries: (...args: unknown[]) => mockPostCountMetricSeries(...args),
}));

import { runCronSweep } from "../../apps/control-plane-worker/src/cron/sweep-runner";
import type { Logger } from "../../apps/control-plane-worker/src/logger";

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

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function newSqlite(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(CRON_SWEEP_CURSOR_MIGRATION);
  return sqlite;
}

function envFor(sqlite: Database.Database, ddApiKey?: string) {
  return {
    DB: new SqliteD1(sqlite) as unknown as D1Database,
    DD_API_KEY: ddApiKey,
    WORKER_ENV: "test",
  };
}

describe("runCronSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advances and resumes the persisted cursor", async () => {
    const sqlite = newSqlite();
    const processed: number[] = [];
    const fetchPage = vi.fn(async (_db: D1Database, cursor: string | null, limit: number) => {
      const allItems = [1, 2, 3, 4, 5];
      const start = cursor === null ? 0 : allItems.findIndex((item) => String(item) === cursor) + 1;
      const items = allItems.slice(start, start + limit);
      return {
        items,
        nextCursor: start + items.length < allItems.length ? String(items[items.length - 1]) : null,
      };
    });

    await expect(
      runCronSweep(envFor(sqlite), logger, {
        name: "numbers",
        tickLimit: 2,
        fetchPage,
        processItem: async (item) => {
          processed.push(item);
        },
      }),
    ).resolves.toMatchObject({ fetched: 2, processed: 2, failed: 0, cursor: "2" });

    await expect(
      runCronSweep(envFor(sqlite), logger, {
        name: "numbers",
        tickLimit: 2,
        fetchPage,
        processItem: async (item) => {
          processed.push(item);
        },
      }),
    ).resolves.toMatchObject({ fetched: 2, processed: 2, failed: 0, cursor: "4" });

    expect(processed).toEqual([1, 2, 3, 4]);
    expect(fetchPage.mock.calls[1][1]).toBe("2");
    expect(sqlite.prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = 'numbers'").get()).toEqual({
      cursor: "4",
    });
  });

  it("continues processing when an item fails", async () => {
    const sqlite = newSqlite();
    const processed: number[] = [];

    await expect(
      runCronSweep(envFor(sqlite), logger, {
        name: "failure-test",
        tickLimit: 3,
        fetchPage: async () => ({ items: [1, 2, 3], nextCursor: null }),
        processItem: async (item) => {
          if (item === 2) throw new Error("boom");
          processed.push(item);
        },
      }),
    ).resolves.toMatchObject({ fetched: 3, processed: 2, failed: 1, cursor: null });

    expect(processed).toEqual([1, 3]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ job: "failure-test", error: "Error: boom" }),
      "Cron sweep item failed",
    );
  });

  it("does not advance the persisted cursor when a page item fails", async () => {
    const sqlite = newSqlite();
    sqlite
      .prepare(
        `INSERT INTO cron_sweep_cursors (job_name, cursor, last_updated_at, last_processed_at)
         VALUES ('failure-cursor-test', '2', 1, 1)`,
      )
      .run();

    await expect(
      runCronSweep(envFor(sqlite), logger, {
        name: "failure-cursor-test",
        tickLimit: 3,
        fetchPage: async (_db, cursor) => ({
          items: cursor === "2" ? [3, 4, 5] : [1, 2],
          nextCursor: "5",
        }),
        processItem: async (item) => {
          if (item === 4) throw new Error("boom");
        },
      }),
    ).resolves.toMatchObject({ fetched: 3, processed: 2, failed: 1, cursor: "2" });

    expect(
      sqlite.prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = 'failure-cursor-test'").get(),
    ).toEqual({
      cursor: "2",
    });
  });

  it("returns null cursor after clearing an exhausted persisted cursor", async () => {
    const sqlite = newSqlite();
    sqlite
      .prepare(
        `INSERT INTO cron_sweep_cursors (job_name, cursor, last_updated_at, last_processed_at)
         VALUES ('empty-page-test', 'stale', 1, 1)`,
      )
      .run();

    await expect(
      runCronSweep(envFor(sqlite), logger, {
        name: "empty-page-test",
        tickLimit: 3,
        fetchPage: async () => ({ items: [], nextCursor: null }),
        processItem: async () => {},
      }),
    ).resolves.toMatchObject({ fetched: 0, processed: 0, failed: 0, cursor: null });

    expect(sqlite.prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = 'empty-page-test'").get()).toEqual({
      cursor: null,
    });
  });

  it("honors the concurrency cap", async () => {
    const sqlite = newSqlite();
    let active = 0;
    let maxActive = 0;

    await runCronSweep(envFor(sqlite), logger, {
      name: "concurrency-test",
      tickLimit: 6,
      concurrency: 2,
      fetchPage: async () => ({ items: [1, 2, 3, 4, 5, 6], nextCursor: null }),
      processItem: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
      },
    });

    expect(maxActive).toBe(2);
  });

  it("emits low-cardinality count metrics when Datadog is configured", async () => {
    const sqlite = newSqlite();
    mockPostCountMetricSeries.mockResolvedValue(undefined);

    await runCronSweep(envFor(sqlite, "dd-key"), logger, {
      name: "metrics-test",
      tickLimit: 1,
      fetchPage: async () => ({ items: [1], nextCursor: null }),
      processItem: async () => {},
    });

    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      expect.arrayContaining([
        expect.objectContaining({
          metric: "arcanist.cron_sweep.fetched",
          tags: expect.arrayContaining(["job:metrics-test", "worker:control-plane"]),
          value: 1,
        }),
        expect.objectContaining({ metric: "arcanist.cron_sweep.processed", value: 1 }),
        expect.objectContaining({ metric: "arcanist.cron_sweep.failed", value: 0 }),
      ]),
      "cron-sweep",
    );
  });
});
