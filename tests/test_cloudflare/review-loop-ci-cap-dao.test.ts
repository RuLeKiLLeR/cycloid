import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  countConsecutiveCiFixEpochsForPr,
  getReviewLoopEpochById,
  hasCiAttemptCapEscalationForHead,
  hasCiPendingCapEscalationForHead,
  markReviewLoopEpochBlocked,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";

// Minimal D1-over-better-sqlite3 shim (mirrors review-loop-epochs.test.ts).
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
  // 0122 rebuilds the table widening source_kind to include 'ci'.
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

const SESSION = "sess-ci";
const PR_URL = "https://github.com/acme/repo/pull/7";
const CI_HASH = "ci-fixes";
let seq = 0;

/** Inserts a raw epoch row with full control over source_kind / worklist_hash / status / order. */
function insertEpoch(opts: {
  id: string;
  sourceKind: "bot" | "human" | "mixed" | "ci";
  worklistHash: string | null;
  status?: string;
  createdAt: number;
  headSha?: string;
  reservationToken?: string;
}): void {
  seq += 1;
  sqlite
    .prepare(
      `INSERT INTO pr_review_response_epochs (
        id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
        expected_bots_hash, expected_bots_json, expected_bot_keys_json,
        observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
        handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
        timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
        status, source_kind, worklist_hash, reservation_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      SESSION,
      101,
      "acme",
      "repo",
      7,
      PR_URL,
      opts.headSha ?? "head-sha",
      seq,
      opts.sourceKind === "ci" ? CI_HASH : "bots-hash",
      "[]",
      "[]",
      "[]",
      "[]",
      0,
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
      opts.createdAt,
      opts.createdAt,
      opts.status ?? "completed",
      opts.sourceKind,
      opts.worklistHash,
      opts.reservationToken ?? null,
      opts.createdAt,
      opts.createdAt,
    );
}

describe("countConsecutiveCiFixEpochsForPr (DB-backed)", () => {
  it("counts only ci epochs with a stored fingerprint and stops at the first review epoch", async () => {
    // Newest-first the walk should see: ci(fpA), ci(fpA) then a bot epoch (break).
    insertEpoch({ id: "bot-old", sourceKind: "bot", worklistHash: "wl", createdAt: 1000 });
    insertEpoch({ id: "ci-1", sourceKind: "ci", worklistHash: "fpA", createdAt: 2000 });
    insertEpoch({ id: "ci-2", sourceKind: "ci", worklistHash: "fpA", createdAt: 3000 });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "none",
      fingerprint: "fpA",
    });
    expect(streaks).toEqual({ sameFingerprintStreak: 2, totalConsecutiveStreak: 2 });
  });

  it("does NOT count completed-noop (worklist_hash='') ci epochs and does not reset same-fingerprint contiguity", async () => {
    // Identical failure fpA twice, with a flaky-green noop ('') interleaved between them.
    insertEpoch({ id: "ci-attempt-1", sourceKind: "ci", worklistHash: "fpA", createdAt: 1000 });
    insertEpoch({ id: "ci-noop", sourceKind: "ci", worklistHash: "", status: "completed", createdAt: 2000 });
    insertEpoch({ id: "ci-attempt-2", sourceKind: "ci", worklistHash: "fpA", createdAt: 3000 });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "none",
      fingerprint: "fpA",
    });
    // The '' noop is skipped: 2 real attempts, both fpA → contiguity preserved across the noop.
    expect(streaks).toEqual({ sameFingerprintStreak: 2, totalConsecutiveStreak: 2 });
  });

  it("does NOT count head_changed-blocked ci epochs with NULL worklist_hash toward the backstop", async () => {
    insertEpoch({ id: "ci-real", sourceKind: "ci", worklistHash: "fpA", createdAt: 1000 });
    insertEpoch({
      id: "ci-head-changed",
      sourceKind: "ci",
      worklistHash: null,
      status: "blocked",
      createdAt: 2000,
    });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "none",
      fingerprint: "fpA",
    });
    expect(streaks).toEqual({ sameFingerprintStreak: 1, totalConsecutiveStreak: 1 });
  });

  it("backstop counts 6 oscillating-fingerprint attempts; same-fingerprint stops at the first different fp", async () => {
    // Newest-first: fpZ, fpZ, ... 6 attempts with the newest two matching the current fp.
    insertEpoch({ id: "ci-a", sourceKind: "ci", worklistHash: "fp1", createdAt: 1000 });
    insertEpoch({ id: "ci-b", sourceKind: "ci", worklistHash: "fp2", createdAt: 2000 });
    insertEpoch({ id: "ci-c", sourceKind: "ci", worklistHash: "fp3", createdAt: 3000 });
    insertEpoch({ id: "ci-d", sourceKind: "ci", worklistHash: "fp4", createdAt: 4000 });
    insertEpoch({ id: "ci-e", sourceKind: "ci", worklistHash: "fpZ", createdAt: 5000 });
    insertEpoch({ id: "ci-f", sourceKind: "ci", worklistHash: "fpZ", createdAt: 6000 });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "none",
      fingerprint: "fpZ",
    });
    expect(streaks.totalConsecutiveStreak).toBe(6);
    expect(streaks.sameFingerprintStreak).toBe(2);
  });

  it("excludes the current epoch from the streak", async () => {
    insertEpoch({ id: "ci-prior", sourceKind: "ci", worklistHash: "fpA", createdAt: 1000 });
    insertEpoch({ id: "ci-current", sourceKind: "ci", worklistHash: "fpA", createdAt: 2000 });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "ci-current",
      fingerprint: "fpA",
    });
    expect(streaks).toEqual({ sameFingerprintStreak: 1, totalConsecutiveStreak: 1 });
  });

  it("keeps a persistent check's streak across failing-set growth (per-name union, not exact fingerprint)", async () => {
    // typecheck fails every round; lint appears only in the middle round. Exact-fingerprint matching
    // resets on the middle round and erodes the same-failure cap down to the 6-attempt backstop.
    // Per-check-name union preserves typecheck's 3-round streak so the cap still fires.
    insertEpoch({ id: "ci-1", sourceKind: "ci", worklistHash: 'ci-fail:["typecheck"]', createdAt: 1000 });
    insertEpoch({ id: "ci-2", sourceKind: "ci", worklistHash: 'ci-fail:["lint","typecheck"]', createdAt: 2000 });
    insertEpoch({ id: "ci-3", sourceKind: "ci", worklistHash: 'ci-fail:["typecheck"]', createdAt: 3000 });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "none",
      fingerprint: 'ci-fail:["typecheck"]',
    });
    expect(streaks.sameFingerprintStreak).toBe(3);
    expect(streaks.totalConsecutiveStreak).toBe(3);
  });

  it("a renamed check starts a fresh streak (its name is absent from priors)", async () => {
    insertEpoch({ id: "ci-1", sourceKind: "ci", worklistHash: 'ci-fail:["old-name"]', createdAt: 1000 });
    insertEpoch({ id: "ci-2", sourceKind: "ci", worklistHash: 'ci-fail:["old-name"]', createdAt: 2000 });

    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "none",
      fingerprint: 'ci-fail:["new-name"]',
    });
    // new-name is absent from both priors → fresh streak 0; the old-name run does not count for it.
    expect(streaks.sameFingerprintStreak).toBe(0);
    expect(streaks.totalConsecutiveStreak).toBe(2);
  });
});

describe("markReviewLoopEpochBlocked stores the cap fingerprint (re-arm fix)", () => {
  it("records worklist_hash on a cap-blocked reserving ci epoch via the optional fingerprint", async () => {
    insertEpoch({
      id: "ci-capped",
      sourceKind: "ci",
      worklistHash: null,
      status: "reserving",
      reservationToken: "tok-1",
      createdAt: 1000,
    });

    const blocked = await markReviewLoopEpochBlocked(db, "ci-capped", {
      nowMs: 5000,
      reason: "ci_attempt_cap_reached",
      error: "capped",
      expectedReservationToken: "tok-1",
      worklistHash: "ci-fail:tests",
    });
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.worklistHash).toBe("ci-fail:tests");

    // A subsequent streak walk now counts the cap-blocked epoch as a real same-fingerprint attempt,
    // so a rerun of the SAME failing set re-caps instead of re-enqueuing.
    const streaks = await countConsecutiveCiFixEpochsForPr(db, {
      sessionId: SESSION,
      prUrl: PR_URL,
      excludeEpochId: "rerun",
      fingerprint: "ci-fail:tests",
    });
    expect(streaks.sameFingerprintStreak).toBe(1);
  });

  it("does NOT overwrite an existing worklist_hash when no fingerprint is passed (COALESCE)", async () => {
    insertEpoch({
      id: "ci-keep",
      sourceKind: "ci",
      worklistHash: "ci-fail:keep-me",
      status: "reserving",
      reservationToken: "tok-2",
      createdAt: 1000,
    });

    await markReviewLoopEpochBlocked(db, "ci-keep", {
      nowMs: 5000,
      reason: "some_other_block",
      expectedReservationToken: "tok-2",
    });
    const after = await getReviewLoopEpochById(db, "ci-keep");
    expect(after?.worklistHash).toBe("ci-fail:keep-me");
  });
});

describe("hasCiPendingCapEscalationForHead (pending-timeout dedupe)", () => {
  async function blockPending(id: string, headSha: string): Promise<void> {
    insertEpoch({
      id,
      sourceKind: "ci",
      worklistHash: null,
      status: "reserving",
      reservationToken: id,
      headSha,
      createdAt: 1000,
    });
    await markReviewLoopEpochBlocked(db, id, {
      nowMs: 5000,
      reason: "ci_checks_pending_cap_reached",
      expectedReservationToken: id,
    });
  }

  it("matches a prior ci_checks_pending_cap_reached block on the same head", async () => {
    await blockPending("ci-pending-1", "head-a");
    expect(
      await hasCiPendingCapEscalationForHead(db, {
        sessionId: SESSION,
        prUrl: PR_URL,
        headSha: "head-a",
        excludeEpochId: "ci-current",
      }),
    ).toBe(true);
  });

  it("does not match a different head", async () => {
    await blockPending("ci-pending-1", "head-a");
    expect(
      await hasCiPendingCapEscalationForHead(db, {
        sessionId: SESSION,
        prUrl: PR_URL,
        headSha: "head-b",
        excludeEpochId: "ci-current",
      }),
    ).toBe(false);
  });

  it("excludes the current epoch and does not cross-match the attempt-cap reason", async () => {
    await blockPending("ci-self", "head-a");
    // The pending guard ignores the epoch being evaluated...
    expect(
      await hasCiPendingCapEscalationForHead(db, {
        sessionId: SESSION,
        prUrl: PR_URL,
        headSha: "head-a",
        excludeEpochId: "ci-self",
      }),
    ).toBe(false);

    // ...and the two escalation reasons are independent: an attempt-cap block does
    // not satisfy the pending guard, and vice versa.
    insertEpoch({
      id: "ci-attempt",
      sourceKind: "ci",
      worklistHash: null,
      status: "reserving",
      reservationToken: "tok-attempt",
      headSha: "head-c",
      createdAt: 1000,
    });
    await markReviewLoopEpochBlocked(db, "ci-attempt", {
      nowMs: 5000,
      reason: "ci_attempt_cap_reached",
      expectedReservationToken: "tok-attempt",
    });
    expect(
      await hasCiPendingCapEscalationForHead(db, {
        sessionId: SESSION,
        prUrl: PR_URL,
        headSha: "head-c",
        excludeEpochId: "other",
      }),
    ).toBe(false);
    expect(
      await hasCiAttemptCapEscalationForHead(db, {
        sessionId: SESSION,
        prUrl: PR_URL,
        headSha: "head-a",
        excludeEpochId: "other",
      }),
    ).toBe(false);
  });
});
