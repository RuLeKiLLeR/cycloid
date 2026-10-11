import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimSlackPrMergedPost,
  deleteSlackPrMergedPostMarker,
} from "../../apps/control-plane-worker/src/session/slack-posts-db";

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
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0163_slack_pr_merged_posts.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("slack_pr_merged_posts dedupe DAO", () => {
  const prUrl = "https://github.com/acme/repo/pull/7";

  it("claims once per (session, pr_url); the second claim no-ops", async () => {
    expect(await claimSlackPrMergedPost(db, { sessionId: "s1", prUrl, channel: "C1" })).toBe(true);
    expect(await claimSlackPrMergedPost(db, { sessionId: "s1", prUrl, channel: "C1" })).toBe(false);
  });

  it("claims distinct PRs independently", async () => {
    expect(await claimSlackPrMergedPost(db, { sessionId: "s1", prUrl, channel: "C1" })).toBe(true);
    expect(
      await claimSlackPrMergedPost(db, {
        sessionId: "s1",
        prUrl: "https://github.com/acme/repo/pull/8",
        channel: "C1",
      }),
    ).toBe(true);
  });

  it("claims the same PR independently per session", async () => {
    expect(await claimSlackPrMergedPost(db, { sessionId: "s1", prUrl })).toBe(true);
    expect(await claimSlackPrMergedPost(db, { sessionId: "s2", prUrl })).toBe(true);
  });

  it("release lets a later trigger re-post after a failed Slack post", async () => {
    expect(await claimSlackPrMergedPost(db, { sessionId: "s1", prUrl })).toBe(true);
    await deleteSlackPrMergedPostMarker(db, { sessionId: "s1", prUrl });
    expect(await claimSlackPrMergedPost(db, { sessionId: "s1", prUrl })).toBe(true);
  });
});
