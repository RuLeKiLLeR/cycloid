import { describe, expect, it, vi } from "vitest";

import { getAppliedMigrationNames } from "../../apps/control-plane-worker/src/db/migrations-db";

/**
 * Builds a minimal D1Database fake whose `.all()` returns the given rows, or
 * rejects when `error` is set. Records the SQL passed to `.prepare()` so we can
 * assert which tracking table is queried.
 */
function createDb(options: { rows?: Array<{ name: string }>; error?: Error }) {
  const calls: string[] = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      calls.push(sql);
      return {
        all: vi.fn().mockImplementation(() => {
          if (options.error) return Promise.reject(options.error);
          return Promise.resolve({ results: options.rows ?? [] });
        }),
      };
    }),
  };
  return { db: db as unknown as D1Database, calls };
}

describe("getAppliedMigrationNames", () => {
  it("returns applied migration names from d1_migrations", async () => {
    const { db, calls } = createDb({
      rows: [{ name: "0001_init.sql" }, { name: "0002_sessions.sql" }],
    });

    await expect(getAppliedMigrationNames(db)).resolves.toEqual(["0001_init.sql", "0002_sessions.sql"]);
    // wrangler's native table, not the retired hand-rolled _schema_migrations.
    expect(calls[0]).toContain("FROM d1_migrations");
    expect(calls[0]).not.toContain("_schema_migrations");
  });

  it("returns an empty list when no migrations are recorded", async () => {
    const { db } = createDb({ rows: [] });

    await expect(getAppliedMigrationNames(db)).resolves.toEqual([]);
  });

  it("fails closed (throws) when the table is missing or unreadable", async () => {
    const { db } = createDb({ error: new Error("no such table: d1_migrations") });

    await expect(getAppliedMigrationNames(db)).rejects.toThrow("no such table: d1_migrations");
  });
});
