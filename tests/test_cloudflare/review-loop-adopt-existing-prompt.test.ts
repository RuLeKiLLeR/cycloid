import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimReviewLoopEpochForPrompt,
  getReviewLoopEpochById,
  upsertReviewLoopEpochActivity,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import {
  adoptExistingReviewLoopEpochPrompt,
  readExistingEpochPromptFromReject,
} from "../../apps/control-plane-worker/src/services/review-loop-sweep";
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
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
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
let env: Env;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0166_review_loop_carried_forward.sql", "utf8"));
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0202_review_loop_carry_forward_no_progress_count.sql", "utf8"),
  );
  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = { DB: db } as unknown as Env;
});

async function reservingEpoch() {
  await upsertReviewLoopEpochActivity(db, {
    sessionId: "s1",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    headSha: "head-a",
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "hash",
    sourceId: "review:cursor",
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId: "review:cursor" },
    nowMs: 1_000,
  });
  const latest = await db
    .prepare("SELECT id FROM pr_review_response_epochs ORDER BY created_at DESC LIMIT 1")
    .bind()
    .first<{ id: string }>();
  // Move to `reserving` (simulates the re-sweep's claim after a crashed prior sweep
  // left the epoch reserving). nowMs far in the future clears any fallback gate.
  const claimed = await claimReviewLoopEpochForPrompt(db, latest!.id, { leaseOwner: "sweep-b", nowMs: 10_000_000 });
  if (!claimed) throw new Error("expected epoch to be claimable");
  return claimed;
}

describe("adoptExistingReviewLoopEpochPrompt (mid-dispatch crash heal)", () => {
  it("binds the epoch to the surviving processing prompt and drives it to processing", async () => {
    const claimed = await reservingEpoch();
    expect(claimed.status).toBe("reserving");

    const result = await adoptExistingReviewLoopEpochPrompt(env, {
      epochId: claimed.id,
      reservationToken: claimed.reservationToken,
      existingPromptId: "p-3",
      existingPromptStatus: "processing",
      worklistHash: "wh-1",
      promptedSourceIds: ["review:cursor"],
      nowMs: 10_000_100,
      logger: { info() {}, warn() {}, error() {} } as never,
    });

    expect(result).toBe("enqueued");
    const epoch = await getReviewLoopEpochById(db, claimed.id);
    expect(epoch?.status).toBe("processing");
    expect(epoch?.lastPromptId).toBe("p-3");
  });

  it("binds a queued surviving prompt to enqueued without forcing processing", async () => {
    const claimed = await reservingEpoch();
    const result = await adoptExistingReviewLoopEpochPrompt(env, {
      epochId: claimed.id,
      reservationToken: claimed.reservationToken,
      existingPromptId: "p-2",
      existingPromptStatus: "queued",
      worklistHash: "wh-1",
      promptedSourceIds: ["review:cursor"],
      nowMs: 10_000_100,
      logger: { info() {}, warn() {}, error() {} } as never,
    });

    expect(result).toBe("enqueued");
    const epoch = await getReviewLoopEpochById(db, claimed.id);
    expect(epoch?.status).toBe("enqueued");
    expect(epoch?.lastPromptId).toBe("p-2");
  });

  it("skips when the reservation token no longer matches (a concurrent sweep won)", async () => {
    const claimed = await reservingEpoch();
    const result = await adoptExistingReviewLoopEpochPrompt(env, {
      epochId: claimed.id,
      reservationToken: "stale-token",
      existingPromptId: "p-2",
      existingPromptStatus: "queued",
      worklistHash: "wh-1",
      promptedSourceIds: [],
      nowMs: 10_000_100,
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    expect(result).toBe("skipped");
    // Epoch unchanged (still reserving), so the winning sweep keeps its binding.
    const epoch = await getReviewLoopEpochById(db, claimed.id);
    expect(epoch?.status).toBe("reserving");
  });
});

describe("readExistingEpochPromptFromReject", () => {
  it("extracts id and status from a duplicate-epoch reject", () => {
    expect(readExistingEpochPromptFromReject({ existingPromptId: "p-9", existingPromptStatus: "processing" })).toEqual({
      existingPromptId: "p-9",
      existingPromptStatus: "processing",
    });
  });
  it("defaults status to queued when absent", () => {
    expect(readExistingEpochPromptFromReject({ existingPromptId: "p-9" })).toEqual({
      existingPromptId: "p-9",
      existingPromptStatus: "queued",
    });
  });
  it("returns null without a prompt id", () => {
    expect(readExistingEpochPromptFromReject({})).toBeNull();
    expect(readExistingEpochPromptFromReject(null)).toBeNull();
  });
});
