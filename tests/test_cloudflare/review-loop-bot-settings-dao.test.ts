import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getUserPrReviewBotSettings,
  listUserPrReviewBotSettings,
  setUserPrReviewBotSettings,
} from "../../apps/control-plane-worker/src/settings/db";

class Stmt {
  private values: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly q: string,
  ) {}
  bind(...v: unknown[]): this {
    this.values = v;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.q).get(...this.values) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.q).all(...this.values) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.q).run(...this.values);
    return { success: true, meta: { changes: info.changes } };
  }
}

class D1 {
  constructor(readonly db: Database.Database) {}
  prepare(q: string) {
    return new Stmt(this.db, q);
  }
}

function makeDb(): D1 {
  const db = new Database(":memory:");
  for (const file of [
    "apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql",
    "apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql",
    "apps/control-plane-worker/migrations/0119_review_loop_human_source.sql",
    "apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql",
    "apps/control-plane-worker/migrations/0124_review_loop_ci_optout_and_timeout.sql",
    "apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql",
    "apps/control-plane-worker/migrations/0156_review_loop_verification_source_kind.sql",
    "apps/control-plane-worker/migrations/0166_review_loop_carried_forward.sql",
    "apps/control-plane-worker/migrations/0202_review_loop_carry_forward_no_progress_count.sql",
    "apps/control-plane-worker/migrations/0225_pr_review_merge_conflict_resolution.sql",
    "apps/control-plane-worker/migrations/0230_enable_merge_conflict_resolution_by_default.sql",
  ]) {
    db.exec(readFileSync(file, "utf8"));
  }
  return new D1(db);
}

describe("pr review bot settings DAO — defaults/list", () => {
  let d1: D1;
  beforeEach(() => {
    d1 = makeDb();
  });

  it("defaults to merge-conflict resolution enabled when no row exists", async () => {
    const settings = await getUserPrReviewBotSettings(d1 as never, 1, "acme", "web");
    expect(settings.expectedBots).toEqual([]);
    expect(settings.mergeConflictResolutionEnabled).toBe(true);
  });

  it("lists a no-bots repo when merge-conflict resolution is disabled", async () => {
    await setUserPrReviewBotSettings(d1 as never, 1, "acme", "web", {
      expectedBots: [],
      mergeConflictResolutionEnabled: false,
    });
    const listed = await listUserPrReviewBotSettings(d1 as never, 1, {});
    expect(listed.rows.map((r) => `${r.repoOwner}/${r.repoName}`)).toContain("acme/web");
  });

  it("omits a no-bots repo that is entirely default", async () => {
    // ci_response_enabled and review_timeout_minutes are orphaned columns: they are never written
    // and cannot flag a repo as customized, so an otherwise-default repo stays unlisted.
    await setUserPrReviewBotSettings(d1 as never, 1, "acme", "web", {
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    const listed = await listUserPrReviewBotSettings(d1 as never, 1, {});
    expect(listed.rows.map((r) => `${r.repoOwner}/${r.repoName}`)).not.toContain("acme/web");
  });
});
