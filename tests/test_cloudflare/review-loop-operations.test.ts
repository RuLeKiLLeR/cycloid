import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  beginReviewLoopOperationAttempt,
  buildReviewLoopPushOperationId,
  buildReviewLoopReplyOperationId,
  buildReviewLoopSummaryCommentOperationId,
  countSucceededReviewLoopOperations,
  fillSucceededReviewLoopReplyVerdict,
  listReviewLoopReplyGithubIdsForSession,
  listSucceededReviewLoopReplyOperations,
  markReviewLoopOperationFailed,
  markReviewLoopOperationSucceeded,
  REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS,
  selectLatestSucceededReviewLoopPushHead,
  selectReviewLoopIssueCommentReplyGithubIds,
  selectReviewLoopReplyGithubIds,
} from "../../apps/control-plane-worker/src/services/review-loop-operations";

class SqliteD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
    private readonly beforeRun?: (query: string, values: readonly unknown[]) => Promise<void> | void,
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
    await this.beforeRun?.(this.query, this.boundValues);
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(
    readonly db: Database.Database,
    private readonly beforeRun?: (query: string, values: readonly unknown[]) => Promise<void> | void,
  ) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query, this.beforeRun);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0147_pr_review_response_operations_github_id_index.sql", "utf8"),
  );
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("review-loop operation DAO", () => {
  it("builds stable operation IDs from the spec inputs", async () => {
    await expect(
      buildReviewLoopPushOperationId({
        epochId: "epoch-1",
        headSha: "head-1",
        worklistHash: "worklist-1",
        diffHash: "diff-1",
      }),
    ).resolves.toBe(
      await buildReviewLoopPushOperationId({
        epochId: "epoch-1",
        headSha: "head-1",
        worklistHash: "worklist-1",
        diffHash: "diff-1",
      }),
    );

    await expect(
      buildReviewLoopReplyOperationId({
        epochId: "epoch-1",
        headSha: "head-1",
        targetSourceId: "review-comment:10",
        opKind: "review_comment_reply",
      }),
    ).resolves.not.toBe(
      await buildReviewLoopReplyOperationId({
        epochId: "epoch-1",
        headSha: "head-1",
        targetSourceId: "issue-comment:20",
        opKind: "issue_comment_reply",
      }),
    );
  });

  it("selectLatestSucceededReviewLoopPushHead returns the epoch's most-recent succeeded push head only", async () => {
    const beginPush = async (
      operationId: string,
      epochId: string,
      headSha: string,
      nowMs: number,
      kind: "push" | "reply" = "push",
    ) =>
      beginReviewLoopOperationAttempt(db, {
        operationId,
        epochId,
        sessionId: "s",
        promptId: "p",
        kind,
        targetSourceId: kind === "reply" ? "review-comment:1" : null,
        headSha,
        maxAttempts: 3,
        nowMs,
      });

    // Two succeeded pushes for epoch-1; the later one (by updated_at) wins.
    const opA = await buildReviewLoopPushOperationId({
      epochId: "epoch-1",
      headSha: "h1",
      worklistHash: "w",
      diffHash: "d-a",
    });
    await beginPush(opA, "epoch-1", "h1", 1_000);
    await markReviewLoopOperationSucceeded(db, opA, { githubId: "head-A", nowMs: 1_100 });
    const opB = await buildReviewLoopPushOperationId({
      epochId: "epoch-1",
      headSha: "h2",
      worklistHash: "w",
      diffHash: "d-b",
    });
    await beginPush(opB, "epoch-1", "h2", 2_000);
    await markReviewLoopOperationSucceeded(db, opB, { githubId: "head-B", nowMs: 2_100 });

    // A LATER failed push (no github_id) must not shadow head-B.
    const opC = await buildReviewLoopPushOperationId({
      epochId: "epoch-1",
      headSha: "h3",
      worklistHash: "w",
      diffHash: "d-c",
    });
    await beginPush(opC, "epoch-1", "h3", 3_000);
    await markReviewLoopOperationFailed(db, opC, { error: "boom", nowMs: 3_100 });

    // A LATER succeeded REPLY (kind != push) for the same epoch must not be returned.
    const opReply = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "h2",
      targetSourceId: "review-comment:1",
      opKind: "review_comment_reply",
    });
    await beginPush(opReply, "epoch-1", "h2", 5_000, "reply");
    await markReviewLoopOperationSucceeded(db, opReply, { githubId: "reply-987", nowMs: 5_100 });

    // A succeeded push for a DIFFERENT epoch must not leak.
    const opOther = await buildReviewLoopPushOperationId({
      epochId: "epoch-2",
      headSha: "h9",
      worklistHash: "w",
      diffHash: "d-o",
    });
    await beginPush(opOther, "epoch-2", "h9", 4_000);
    await markReviewLoopOperationSucceeded(db, opOther, { githubId: "head-other", nowMs: 4_100 });

    expect(await selectLatestSucceededReviewLoopPushHead(db, "epoch-1")).toBe("head-B");
    expect(await selectLatestSucceededReviewLoopPushHead(db, "epoch-no-push")).toBeNull();
  });

  it("breaks an equal-updated_at tie deterministically by insertion order (most recent push wins)", async () => {
    const begin = async (operationId: string, nowMs: number) =>
      beginReviewLoopOperationAttempt(db, {
        operationId,
        epochId: "epoch-tie",
        sessionId: "s",
        promptId: "p",
        kind: "push",
        targetSourceId: null,
        headSha: "h",
        maxAttempts: 3,
        nowMs,
      });
    // Two pushes that SUCCEED at the same millisecond (updated_at ties). The second one was inserted
    // later (higher rowid), so it must win — otherwise the head guard could reject the live self-head.
    const opEarly = await buildReviewLoopPushOperationId({
      epochId: "epoch-tie",
      headSha: "h1",
      worklistHash: "w",
      diffHash: "tie-a",
    });
    await begin(opEarly, 1_000);
    const opLate = await buildReviewLoopPushOperationId({
      epochId: "epoch-tie",
      headSha: "h2",
      worklistHash: "w",
      diffHash: "tie-b",
    });
    await begin(opLate, 1_000);
    await markReviewLoopOperationSucceeded(db, opEarly, { githubId: "head-early", nowMs: 9_000 });
    await markReviewLoopOperationSucceeded(db, opLate, { githubId: "head-late", nowMs: 9_000 });

    expect(await selectLatestSucceededReviewLoopPushHead(db, "epoch-tie")).toBe("head-late");
  });

  it("does not let a stale attempt's failure clobber a newer running attempt (PR-7)", async () => {
    const operationId = await buildReviewLoopPushOperationId({
      epochId: "e1",
      headSha: "h",
      worklistHash: "w",
      diffHash: "d",
    });
    const begin = (nowMs: number) =>
      beginReviewLoopOperationAttempt(db, {
        operationId,
        epochId: "e1",
        sessionId: "s",
        promptId: "p",
        kind: "push",
        targetSourceId: null,
        headSha: "h",
        maxAttempts: 3,
        nowMs,
      });
    await begin(1_000); // attempt 1 (attempts=1, running)
    const a2 = await begin(1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS + 1); // recovered attempt 2
    expect(a2.operation.attempts).toBe(2);

    // A late attempt-1 failure (expectedAttempts=1) must NOT clobber the in-flight attempt 2.
    const stale = await markReviewLoopOperationFailed(db, operationId, {
      error: "late attempt-1 failure",
      nowMs: 2_000,
      expectedAttempts: 1,
    });
    expect(stale?.status).toBe("running");
    expect(stale?.attempts).toBe(2);

    // Attempt 2's own failure (expectedAttempts=2) lands.
    const current = await markReviewLoopOperationFailed(db, operationId, {
      error: "attempt-2 failure",
      nowMs: 2_100,
      expectedAttempts: 2,
    });
    expect(current?.status).toBe("failed");
    expect(current?.lastError).toBe("attempt-2 failure");
  });

  it("does not let a stale attempt's success clobber a newer running attempt (PR-7)", async () => {
    const operationId = await buildReviewLoopPushOperationId({
      epochId: "e2",
      headSha: "h",
      worklistHash: "w",
      diffHash: "d2",
    });
    const begin = (nowMs: number) =>
      beginReviewLoopOperationAttempt(db, {
        operationId,
        epochId: "e2",
        sessionId: "s",
        promptId: "p",
        kind: "push",
        targetSourceId: null,
        headSha: "h",
        maxAttempts: 3,
        nowMs,
      });
    await begin(1_000);
    const a2 = await begin(1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS + 1);
    expect(a2.operation.attempts).toBe(2);

    // A late attempt-1 success must NOT mark the in-flight attempt 2 succeeded (nor write its head).
    const stale = await markReviewLoopOperationSucceeded(db, operationId, {
      githubId: "stale-head",
      nowMs: 2_000,
      expectedAttempts: 1,
    });
    expect(stale?.status).toBe("running");
    expect(stale?.githubId).toBeNull();

    // Attempt 2's own success lands with its head.
    const current = await markReviewLoopOperationSucceeded(db, operationId, {
      githubId: "real-head",
      nowMs: 2_100,
      expectedAttempts: 2,
    });
    expect(current?.status).toBe("succeeded");
    expect(current?.githubId).toBe("real-head");
  });

  it("returns conflict when a concurrent attempt wins the CAS race", async () => {
    // Uses `push` (idempotent) because only idempotent kinds reach the recovery CAS after the lease
    // expires; non-idempotent kinds short-circuit to conflict before the CAS.
    const operationId = await buildReviewLoopPushOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      worklistHash: "worklist-1",
      diffHash: "diff-1",
    });

    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "push",
      targetSourceId: null,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });

    // The first attempt's lease has expired (so begin proceeds to the recovery CAS), but a
    // concurrent writer bumps `attempts` just before our UPDATE so the CAS finds no matching row.
    const staleNowMs = 1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS + 1;
    let injectedConcurrentAttempt = false;
    const raceDb = new SqliteD1(sqlite, (query) => {
      if (injectedConcurrentAttempt || !query.includes("UPDATE pr_review_response_operations")) return;
      injectedConcurrentAttempt = true;
      sqlite
        .prepare(
          `UPDATE pr_review_response_operations
           SET attempts = attempts + 1, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(staleNowMs, operationId);
    }) as unknown as D1Database;

    const raced = await beginReviewLoopOperationAttempt(raceDb, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-2",
      kind: "push",
      targetSourceId: null,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: staleNowMs,
    });

    expect(injectedConcurrentAttempt).toBe(true);
    expect(raced).toEqual(
      expect.objectContaining({
        status: "conflict",
        operation: expect.objectContaining({ operationId, attempts: 2, status: "running" }),
      }),
    );
  });

  it("returns conflict (not started) for a recent in-flight running attempt", async () => {
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: "review-comment:10",
      opKind: "review_comment_reply",
    });

    const first = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });
    expect(first.status).toBe("started");

    // The first attempt crashed/evicted before mark-succeeded; the row is still `running`.
    // A retry within the lease window must NOT re-run the side effect.
    const retry = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-2",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS - 1,
    });

    expect(retry).toEqual(
      expect.objectContaining({
        status: "conflict",
        // attempts is unchanged: the second begin did not bump the counter or reset the lease.
        operation: expect.objectContaining({ operationId, attempts: 1, status: "running" }),
      }),
    );
  });

  it("never auto-restarts a stale running reply: stays conflict to avoid double-posting", async () => {
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: "review-comment:10",
      opKind: "review_comment_reply",
    });

    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });

    // Advance well past the lease window. The prior attempt may have POSTed to GitHub before
    // crashing (row still `running`, no github_id), so a fresh attempt could double-post. A
    // non-idempotent reply must therefore stay `conflict` and never start a new attempt.
    const retry = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-2",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS * 100,
    });

    expect(retry).toEqual(
      expect.objectContaining({
        status: "conflict",
        // attempts unchanged and prompt_id not rewritten: no fresh attempt / no re-POST.
        operation: expect.objectContaining({ operationId, attempts: 1, status: "running", promptId: "prompt-1" }),
      }),
    );
  });

  it("never auto-restarts a stale running summary_comment: stays conflict to avoid double-posting", async () => {
    const operationId = await buildReviewLoopSummaryCommentOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
    });

    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "summary_comment",
      targetSourceId: null,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });

    const retry = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-2",
      kind: "summary_comment",
      targetSourceId: null,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS * 100,
    });

    expect(retry).toEqual(
      expect.objectContaining({
        status: "conflict",
        operation: expect.objectContaining({ operationId, attempts: 1, status: "running", promptId: "prompt-1" }),
      }),
    );
  });

  it("recovers a stale running push under the cap (idempotent verify, safe to re-run)", async () => {
    const operationId = await buildReviewLoopPushOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      worklistHash: "worklist-1",
      diffHash: "diff-1",
    });

    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "push",
      targetSourceId: null,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });

    // push has no user-visible POST side effect (verifyRemoteBranch is a read), so a stale `running`
    // push past the lease window is presumed crashed and recovered as a fresh attempt.
    const recovered = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-2",
      kind: "push",
      targetSourceId: null,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000 + REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS + 1,
    });

    expect(recovered).toEqual(
      expect.objectContaining({
        status: "started",
        operation: expect.objectContaining({ operationId, attempts: 2, status: "running", promptId: "prompt-2" }),
      }),
    );
  });

  it("retries a failed attempt under the cap and reports attempts_exhausted over it", async () => {
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: "review-comment:10",
      opKind: "review_comment_reply",
    });

    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 2,
      nowMs: 1_000,
    });
    await markReviewLoopOperationFailed(db, operationId, { error: "boom", nowMs: 1_100 });

    // Failed under cap → a retry starts a fresh attempt immediately (no lease wait).
    const retry = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-2",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 2,
      nowMs: 1_200,
    });
    expect(retry).toEqual(
      expect.objectContaining({
        status: "started",
        operation: expect.objectContaining({ operationId, attempts: 2, status: "running" }),
      }),
    );

    await markReviewLoopOperationFailed(db, operationId, { error: "boom-2", nowMs: 1_300 });

    // At the cap → terminal: no further attempt is started.
    const exhausted = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-3",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 2,
      nowMs: 1_400,
    });
    expect(exhausted).toEqual(
      expect.objectContaining({
        status: "attempts_exhausted",
        operation: expect.objectContaining({ operationId, attempts: 2, status: "failed" }),
      }),
    );
  });

  it("makes already-landed operations a no-op on retry", async () => {
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: "review-comment:10",
      opKind: "review_comment_reply",
    });

    const first = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });

    expect(first.status).toBe("started");
    await markReviewLoopOperationSucceeded(db, operationId, {
      githubId: "reply-100",
      nowMs: 1_100,
    });

    const retry = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_200,
    });

    expect(retry).toEqual(
      expect.objectContaining({
        status: "already_succeeded",
        operation: expect.objectContaining({ operationId, githubId: "reply-100", status: "succeeded" }),
      }),
    );
  });

  it("persists reply verdicts and fills legacy succeeded replies once", async () => {
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: "review-comment:10",
      opKind: "review_comment_reply",
    });

    const first = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "review-comment:10",
      headSha: "head-1",
      verdict: "declined",
      verdictBasis: "Not applicable to this PR.",
      maxAttempts: 3,
      nowMs: 1_000,
    });
    expect(first.operation).toEqual(
      expect.objectContaining({
        verdict: "declined",
        verdictBasis: "Not applicable to this PR.",
      }),
    );
    await markReviewLoopOperationSucceeded(db, operationId, { githubId: "reply-100", nowMs: 1_100 });

    const legacyOperationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: "issue-comment:20",
      opKind: "issue_comment_reply",
    });
    await beginReviewLoopOperationAttempt(db, {
      operationId: legacyOperationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: "issue-comment:20",
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_200,
    });
    await markReviewLoopOperationSucceeded(db, legacyOperationId, { githubId: "reply-200", nowMs: 1_300 });

    await expect(countSucceededReviewLoopOperations(db, "epoch-1")).resolves.toBe(2);
    await expect(listSucceededReviewLoopReplyOperations(db, "epoch-1")).resolves.toEqual([
      {
        operationId,
        targetSourceId: "review-comment:10",
        verdict: "declined",
        verdictBasis: "Not applicable to this PR.",
      },
      {
        operationId: legacyOperationId,
        targetSourceId: "issue-comment:20",
        verdict: null,
        verdictBasis: null,
      },
    ]);

    await fillSucceededReviewLoopReplyVerdict(db, legacyOperationId, {
      verdict: "fixed",
      verdictBasis: "ignored for fixed",
      nowMs: 1_400,
    });
    const unchanged = await fillSucceededReviewLoopReplyVerdict(db, operationId, {
      verdict: "fixed",
      nowMs: 1_500,
    });

    expect(unchanged).toEqual(
      expect.objectContaining({
        verdict: "declined",
        verdictBasis: "Not applicable to this PR.",
      }),
    );
    await expect(listSucceededReviewLoopReplyOperations(db, "epoch-1")).resolves.toEqual([
      {
        operationId,
        targetSourceId: "review-comment:10",
        verdict: "declined",
        verdictBasis: "Not applicable to this PR.",
      },
      {
        operationId: legacyOperationId,
        targetSourceId: "issue-comment:20",
        verdict: "fixed",
        verdictBasis: null,
      },
    ]);
  });
});

describe("buildReviewLoopSummaryCommentOperationId", () => {
  it("produces a stable id from (epochId, headSha)", async () => {
    const a = await buildReviewLoopSummaryCommentOperationId({
      epochId: "ep-1",
      headSha: "deadbeef",
    });
    const b = await buildReviewLoopSummaryCommentOperationId({
      epochId: "ep-1",
      headSha: "deadbeef",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^review-loop:summary_comment:[a-f0-9]+$/);
  });

  it("changes when epochId or headSha changes", async () => {
    const base = await buildReviewLoopSummaryCommentOperationId({
      epochId: "ep-1",
      headSha: "deadbeef",
    });
    const otherEpoch = await buildReviewLoopSummaryCommentOperationId({
      epochId: "ep-2",
      headSha: "deadbeef",
    });
    const otherHead = await buildReviewLoopSummaryCommentOperationId({
      epochId: "ep-1",
      headSha: "cafef00d",
    });
    expect(otherEpoch).not.toBe(base);
    expect(otherHead).not.toBe(base);
  });
});

describe("selectReviewLoopReplyGithubIds", () => {
  async function seedSucceededOperation(input: {
    operationId: string;
    kind: "reply" | "summary_comment";
    targetSourceId: string | null;
    githubId: string;
  }) {
    await beginReviewLoopOperationAttempt(db, {
      operationId: input.operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: input.kind,
      targetSourceId: input.targetSourceId,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });
    await markReviewLoopOperationSucceeded(db, input.operationId, { githubId: input.githubId, nowMs: 1_100 });
  }

  it("returns only ids created by review-comment reply operations", async () => {
    await seedSucceededOperation({
      operationId: await buildReviewLoopReplyOperationId({
        epochId: "epoch-1",
        headSha: "head-1",
        targetSourceId: "review-comment:10",
        opKind: "review_comment_reply",
      }),
      kind: "reply",
      targetSourceId: "review-comment:10",
      githubId: "9301",
    });
    await seedSucceededOperation({
      operationId: await buildReviewLoopSummaryCommentOperationId({ epochId: "epoch-1", headSha: "head-1" }),
      kind: "summary_comment",
      targetSourceId: null,
      githubId: "9302",
    });
    // Issue-comment replies store ids from GitHub's issue-comment id namespace; a numerically
    // colliding review-comment id must not match.
    await seedSucceededOperation({
      operationId: await buildReviewLoopReplyOperationId({
        epochId: "epoch-1",
        headSha: "head-1",
        targetSourceId: "issue-comment:20",
        opKind: "issue_comment_reply",
      }),
      kind: "reply",
      targetSourceId: "issue-comment:20",
      githubId: "9304",
    });

    await expect(selectReviewLoopReplyGithubIds(db, ["9301", "9302", "9303", "9304"])).resolves.toEqual(
      new Set(["9301"]),
    );
  });

  it("returns an empty set without querying for an empty id list", async () => {
    await expect(selectReviewLoopReplyGithubIds(db, [])).resolves.toEqual(new Set());
  });
});

describe("listReviewLoopReplyGithubIdsForSession", () => {
  let opSeq = 0;
  async function seedReply(input: {
    sessionId: string;
    kind: "reply" | "summary_comment";
    targetSourceId: string | null;
    githubId?: string | null;
  }) {
    opSeq += 1;
    const operationId = `op-${opSeq}`;
    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: input.sessionId,
      promptId: "prompt-1",
      kind: input.kind,
      targetSourceId: input.targetSourceId,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });
    // Omitting githubId leaves the row `running` with no github_id (a reply POSTed-but-uncommitted, or
    // still in flight) — those must not be fenced.
    if (input.githubId) {
      await markReviewLoopOperationSucceeded(db, operationId, { githubId: input.githubId, nowMs: 1_100 });
    }
  }

  it("returns only this session's succeeded review-comment reply github ids", async () => {
    await seedReply({ sessionId: "session-1", kind: "reply", targetSourceId: "review-comment:10", githubId: "111" });
    await seedReply({ sessionId: "session-1", kind: "reply", targetSourceId: "review-comment:11", githubId: "112" });
    // Excluded: summary comment, issue-comment reply, a running reply with no github_id, and another
    // session's reply.
    await seedReply({ sessionId: "session-1", kind: "summary_comment", targetSourceId: null, githubId: "113" });
    await seedReply({ sessionId: "session-1", kind: "reply", targetSourceId: "issue-comment:12", githubId: "114" });
    await seedReply({ sessionId: "session-1", kind: "reply", targetSourceId: "review-comment:13", githubId: null });
    await seedReply({ sessionId: "session-2", kind: "reply", targetSourceId: "review-comment:14", githubId: "115" });

    await expect(listReviewLoopReplyGithubIdsForSession(db, "session-1")).resolves.toEqual(new Set(["111", "112"]));
  });

  it("returns an empty set for a session with no review-comment replies", async () => {
    await expect(listReviewLoopReplyGithubIdsForSession(db, "session-unknown")).resolves.toEqual(new Set());
  });
});

describe("selectReviewLoopIssueCommentReplyGithubIds", () => {
  async function seedSucceededReply(input: { targetSourceId: string; githubId: string }) {
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: "epoch-1",
      headSha: "head-1",
      targetSourceId: input.targetSourceId,
      opKind: "issue_comment_reply",
    });
    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: "epoch-1",
      sessionId: "session-1",
      promptId: "prompt-1",
      kind: "reply",
      targetSourceId: input.targetSourceId,
      headSha: "head-1",
      maxAttempts: 3,
      nowMs: 1_000,
    });
    await markReviewLoopOperationSucceeded(db, operationId, { githubId: input.githubId, nowMs: 1_100 });
  }

  it("returns issue-comment and review-body reply ids without matching inline review replies", async () => {
    await seedSucceededReply({ targetSourceId: "issue-comment:20", githubId: "9401" });
    await seedSucceededReply({ targetSourceId: "review-body:30", githubId: "9402" });
    await seedSucceededReply({ targetSourceId: "review-comment:40", githubId: "9403" });

    await expect(selectReviewLoopIssueCommentReplyGithubIds(db, ["9401", "9402", "9403"])).resolves.toEqual(
      new Set(["9401", "9402"]),
    );
  });

  it("returns an empty set without querying for an empty id list", async () => {
    await expect(selectReviewLoopIssueCommentReplyGithubIds(db, [])).resolves.toEqual(new Set());
  });
});
