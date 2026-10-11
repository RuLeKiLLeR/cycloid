import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPullRequestBodyAndState, updatePullRequest } from "../../apps/control-plane-worker/src/github/pr";
import {
  composeManagedPrBody,
  reconcileManagedPrBody,
  storePrBodyBaseAndReconcile,
  storePrBodyRegionAndReconcile,
} from "../../apps/control-plane-worker/src/services/pr-body-reconciler";
import {
  type PrBodyIdentity,
  releasePrBodyLease,
  tryAcquirePrBodyLease,
} from "../../apps/control-plane-worker/src/services/pr-body-regions-db";

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getPullRequestBodyAndState: vi.fn(),
  updatePullRequest: vi.fn(),
}));

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
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: result.changes } };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

const identity: PrBodyIdentity = {
  repoOwner: "o",
  repoName: "r",
  installationId: 42,
  prNumber: 1,
  prUrl: "https://github.com/o/r/pull/1",
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

let env: { DB: D1Database };
let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0209_pr_body_regions.sql", "utf8"));
  env = { DB: new SqliteD1(sqlite) as unknown as D1Database };
  vi.mocked(getPullRequestBodyAndState).mockReset();
  vi.mocked(updatePullRequest).mockReset();
  vi.mocked(updatePullRequest).mockResolvedValue(undefined);
  vi.mocked(getPullRequestBodyAndState).mockResolvedValue({ body: "## Summary\n\nBase", state: "open" });
});

describe("composeManagedPrBody", () => {
  it("applies the visual evidence region while preserving the base body", () => {
    const visualSection = [
      "## Screenshots or Recordings",
      "",
      "<!-- cycloid:managed:start visualEvidence -->",
      "- [Screenshot](https://example.com/s.png)",
      "<!-- cycloid:managed:end visualEvidence -->",
    ].join("\n");

    const out = composeManagedPrBody("## Summary\n\nBase", [
      { region: "visualEvidence", body: visualSection, updatedAt: 1 },
    ]);
    expect(out).toContain("## Summary");
    expect(out).toContain("Screenshot");
    expect(out).toContain("<!-- cycloid:managed:start visualEvidence -->");
  });
});

describe("pr body lease", () => {
  it("allows only one owner to hold a non-expired PR body lease", async () => {
    await expect(tryAcquirePrBodyLease(env.DB, identity, "owner-1", 1_000)).resolves.toBe(true);
    await expect(tryAcquirePrBodyLease(env.DB, identity, "owner-2", 2_000)).resolves.toBe(false);

    await releasePrBodyLease(env.DB, identity, "owner-1", 3_000);

    await expect(tryAcquirePrBodyLease(env.DB, identity, "owner-2", 4_000)).resolves.toBe(true);
  });

  it("uses the injected timestamp when releasing the reconcile lease", async () => {
    await storePrBodyBaseAndReconcile(env as never, {
      identity,
      baseBody: "## Summary\n\nBase",
      tokenHint: "tok",
      logger,
      nowMs: 1_234,
    });

    const row = sqlite
      .prepare(
        "SELECT lease_owner, lease_expires_at, updated_at FROM pr_body_locks WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ?",
      )
      .get(identity.repoOwner, identity.repoName, identity.installationId, identity.prNumber) as {
      lease_owner: string | null;
      lease_expires_at: number;
      updated_at: number;
    };

    expect(row).toEqual({ lease_owner: null, lease_expires_at: 0, updated_at: 1_234 });
  });

  it("defers an overlapping reconciler invocation while the lease is held", async () => {
    await storePrBodyBaseAndReconcile(env as never, {
      identity,
      baseBody: "## Summary\n\nBase",
      tokenHint: "tok",
      logger,
      nowMs: 1_000,
    });
    vi.mocked(updatePullRequest).mockClear();
    vi.mocked(getPullRequestBodyAndState).mockClear();

    await tryAcquirePrBodyLease(env.DB, identity, "owner-1", 2_000);
    const deferred = await storePrBodyRegionAndReconcile(env as never, {
      identity,
      region: "visualEvidence",
      body: [
        "<!-- cycloid:managed:start visualEvidence -->",
        "evidence body",
        "<!-- cycloid:managed:end visualEvidence -->",
      ].join("\n"),
      tokenHint: "tok",
      logger,
      nowMs: 3_000,
    });

    expect(deferred).toBeNull();
    expect(getPullRequestBodyAndState).not.toHaveBeenCalled();
    expect(updatePullRequest).not.toHaveBeenCalled();

    await releasePrBodyLease(env.DB, identity, "owner-1", 4_000);
    await reconcileManagedPrBody(env as never, { identity, tokenHint: "tok", logger, nowMs: 5_000 });

    expect(updatePullRequest).toHaveBeenCalledOnce();
    const patch = vi.mocked(updatePullRequest).mock.calls[0]?.[4] as { body: string };
    expect(patch.body).toContain("<!-- cycloid:managed:start visualEvidence -->");
  });
});
