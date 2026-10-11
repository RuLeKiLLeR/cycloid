import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubRequestError } from "../../apps/control-plane-worker/src/github/errors";

const mockGetInstallationByOwner = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCreateInstallationToken = vi.fn<(...args: unknown[]) => Promise<string>>();
const mockGetDefaultBranch = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getDefaultBranch: (...args: unknown[]) => mockGetDefaultBranch(...args),
}));

import { runMemoryReconciliation } from "../../apps/control-plane-worker/src/company-memory/reconcile";
import type { Env } from "../../apps/control-plane-worker/src/types";

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

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }

  runSync(): { success: true; meta: { changes: number } } {
    const info = this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const runBatch = this.db.transaction((items: SqliteD1Statement[]) => items.map((statement) => statement.runSync()));
    return runBatch(statements);
  }
}

let sqlite: Database.Database;
let db: D1Database;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();

  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0132_ingestion_events.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0134_company_memory_core.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0138_memory_review_candidates.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = {
    DB: db,
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: "private-key",
  } as Env;

  mockGetInstallationByOwner.mockResolvedValue({ installation_id: 77, suspended_at: null });
  mockCreateInstallationToken.mockResolvedValue("ghs_test_token");
  mockGetDefaultBranch.mockResolvedValue("main");
});

describe("company-memory reconcile GitHub 404 handling", () => {
  it("skips repo targets when default branch lookup returns 404", async () => {
    mockGetDefaultBranch.mockRejectedValueOnce(new GitHubRequestError("GitHub repo lookup", 404));

    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 1_000,
      repoTargets: [{ owner: "acme", name: "stale-repo" }],
      adjudicate: async () => null,
    });

    expect(result).toMatchObject({
      businesses: 1,
      candidates: 0,
      skipped: 1,
      adjudicationProviderFailures: 0,
    });
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 77);
    expect(mockGetDefaultBranch).toHaveBeenCalledWith("ghs_test_token", "acme", "stale-repo");
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM memory_reconciliation_cursors WHERE cursor_type = 'cross_store'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("skips repo targets when repo-memory directory listing returns 404", async () => {
    const result = await runMemoryReconciliation(env, {
      businessId: "biz-1",
      nowMs: 1_000,
      repoTargets: [{ owner: "acme", name: "stale-repo", token: "ghs_test_token", ref: "main" }],
      repoMemoryLoader: async () => {
        throw new GitHubRequestError("GitHub list directory", 404, "Not Found");
      },
      adjudicate: async () => null,
    });

    expect(result).toMatchObject({
      businesses: 1,
      candidates: 0,
      skipped: 1,
      adjudicationProviderFailures: 0,
    });
    expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM memory_reconciliation_cursors WHERE cursor_type = 'cross_store'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("does not silently skip repo targets when an individual file read returns 404", async () => {
    await expect(
      runMemoryReconciliation(env, {
        businessId: "biz-1",
        nowMs: 1_000,
        repoTargets: [{ owner: "acme", name: "stale-repo", token: "ghs_test_token", ref: "main" }],
        repoMemoryLoader: async () => {
          throw new GitHubRequestError("GitHub get file", 404, "Not Found");
        },
        adjudicate: async () => null,
      }),
    ).rejects.toThrow("GitHub get file failed (404): Not Found");
  });
});
