// tests/test_cloudflare/review-loop-summaries.test.ts
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getReviewLoopEpochSummariesForHead,
  upsertReviewLoopEpochActivity,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";

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

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
  // 0122 widens source_kind CHECK to allow 'ci' — required because this DAO must count ci epochs.
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

// Force an epoch into status='blocked' with a chosen reason via a raw UPDATE — the test file
// already drives raw sqlite UPDATEs for setup (see review-loop-epochs.test.ts:1003-1007). This
// avoids the multi-step CAS state machine and lets us assert reason pass-through directly.
function forceBlocked(epochId: string, reason: string | null) {
  sqlite
    .prepare("UPDATE pr_review_response_epochs SET status = 'blocked', blocked_reason = ? WHERE id = ?")
    .run(reason, epochId);
}

const PR_URL = "https://github.com/acme/repo/pull/500";

async function seedReviewEpoch(sessionId: string, headSha: string, sourceId: string, nowMs: number) {
  // Use sourceId as part of the hash to ensure each call inserts a distinct DB row.
  // The unique key is (owner_user_id, session_id, pr_url, head_sha, expected_bots_hash);
  // sharing the hash would cause the upsert to merge epochs into one row.
  const expectedBotsHash = `hash-${sourceId.replace(/[^a-z0-9]/gi, "-")}`;
  return upsertReviewLoopEpochActivity(db, {
    sessionId,
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 500,
    prUrl: PR_URL,
    headSha,
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash,
    sourceId,
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId },
    nowMs,
  });
}

async function seedCiEpoch(sessionId: string, headSha: string, sourceId: string, nowMs: number) {
  return upsertReviewLoopEpochActivity(db, {
    sessionId,
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 500,
    prUrl: PR_URL,
    headSha,
    expectedBots: [],
    expectedBotsHash: "ci-fixes",
    sourceId,
    botKey: "ci",
    botActorLogin: null,
    terminal: false,
    evidence: null,
    nowMs,
    sourceKind: "ci",
  });
}

describe("getReviewLoopEpochSummariesForHead", () => {
  it("returns only current-head rows with {status, blockedReason}, includes ci epochs, ignores other heads/prs/sessions", async () => {
    const sessionId = "s-summary";
    const headCurrent = "head-current";
    const headOld = "head-old";

    // Current head: a review epoch left in-flight (collecting), a review epoch blocked with a reason,
    // and a ci epoch — all three must come back.
    await seedReviewEpoch(sessionId, headCurrent, "review:inflight", 1_000);
    const blockedReview = await seedReviewEpoch(sessionId, headCurrent, "review:blocked", 1_100);
    forceBlocked(blockedReview.id, "attempt_cap_reached");
    await seedCiEpoch(sessionId, headCurrent, "ci:fix-1", 1_200);

    // Old head on the SAME pr+session must NOT come back.
    await seedReviewEpoch(sessionId, headOld, "review:old", 900);

    // Different PR (same session) must NOT leak.
    await upsertReviewLoopEpochActivity(db, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 999,
      prUrl: "https://github.com/acme/repo/pull/999",
      headSha: headCurrent,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-summary",
      sourceId: "review:other-pr",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:other-pr" },
      nowMs: 1_300,
    });

    // Different session (same pr+head) must NOT leak.
    await seedReviewEpoch("s-other", headCurrent, "review:other-session", 1_400);

    const summaries = await getReviewLoopEpochSummariesForHead(db, {
      sessionId,
      prUrl: PR_URL,
      headSha: headCurrent,
    });

    expect(summaries).toHaveLength(3);
    // The blocked review epoch carries its reason through verbatim.
    expect(summaries).toContainEqual({ status: "blocked", blockedReason: "attempt_cap_reached", sourceKind: "bot" });
    // The ci epoch is counted (no source_kind filter). It and the in-flight review epoch have null reason.
    const nullReason = summaries.filter((s) => s.blockedReason === null);
    expect(nullReason).toHaveLength(2);
    expect(nullReason.every((s) => s.status !== "blocked")).toBe(true);
  });

  it("maps a NULL blocked_reason on a blocked row to blockedReason: null", async () => {
    const sessionId = "s-null-reason";
    const head = "head-null";
    const epoch = await seedReviewEpoch(sessionId, head, "review:null", 2_000);
    forceBlocked(epoch.id, null);

    const summaries = await getReviewLoopEpochSummariesForHead(db, {
      sessionId,
      prUrl: PR_URL,
      headSha: head,
    });

    expect(summaries).toEqual([{ status: "blocked", blockedReason: null, sourceKind: "bot" }]);
  });

  it("returns [] when no epochs exist for the head", async () => {
    const summaries = await getReviewLoopEpochSummariesForHead(db, {
      sessionId: "s-empty",
      prUrl: PR_URL,
      headSha: "head-none",
    });
    expect(summaries).toEqual([]);
  });
});
