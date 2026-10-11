import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../apps/control-plane-worker/src/logger";
import type {
  MentionEpochEvidence,
  ReviewLoopActivityInput,
  ReviewLoopMentionBootstrapArgs,
  ReviewLoopMergeConflictBootstrapArgs,
  ReviewLoopSourceKind,
  ReviewSourceKind,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import {
  accumulatePromptedSources,
  blockStuckReviewLoopEpoch,
  bootstrapMentionEpoch,
  bootstrapReviewLoopEpochForHuman,
  bootstrapReviewLoopEpochForMergeConflict,
  bootstrapReviewLoopEpochForVerification,
  carryForwardMentionEpochsToNewHead,
  ciFailingCheckFingerprint,
  claimReviewLoopEpochForPrompt,
  completeReviewLoopEpochFromVerifiedPush,
  countReviewLoopEpochsForPr,
  createFsmDispatchedReviewLoopEpoch,
  EMPTY_EXPECTED_BOTS_HASH,
  extendReviewLoopEpochLease,
  getLatestReviewLoopEpochForPr,
  getReviewLoopEpochById,
  hasActiveMergeConflictReviewLoopEpochForHead,
  hasCiReviewLoopEpochForHead,
  hasMergeConflictReviewLoopEpochForHead,
  hasReviewLoopEpochForHead,
  isCiEpoch,
  isMentionEpoch,
  isMergeConflictEpoch,
  isReviewEpoch,
  isVerificationEpoch,
  listDueReviewLoopEpochs,
  listKnownReviewLoopSourceIds,
  listKnownReviewLoopSources,
  listLiveEpochCoveredSourceIds,
  listPromptedReviewLoopSources,
  listStuckReviewLoopEpochs,
  markReviewLoopEpochBlocked,
  markReviewLoopEpochCompleted,
  markReviewLoopEpochContentionDeferred,
  markReviewLoopEpochEnqueued,
  markReviewLoopEpochOwnerApprovalResolved,
  markReviewLoopEpochProcessing,
  markReviewLoopEpochPublishing,
  markReviewLoopEpochTransientFailure,
  markReviewLoopEpochWaitingForOwner,
  reclaimStuckReviewLoopEpoch,
  recordReviewLoopSelfPushForSession,
  repointReviewLoopEpochPrompt,
  resolveReviewLoopEpochForTerminalPrompt,
  REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP,
  REVIEW_LOOP_CI_EPOCH_HASH,
  REVIEW_LOOP_EPOCH_SENTINELS,
  REVIEW_LOOP_NO_PROGRESS_UNRESOLVED_REASON,
  type ReviewLoopVerificationBootstrapArgs,
  reviewSourceKind,
  reviewWorklistHash,
  selectHumanEpochCarryingSource,
  upsertReviewLoopEpochActivity,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import { reconcileReviewLoopEpochsForHeadChange } from "../../apps/control-plane-worker/src/services/review-loop-head-change";
import {
  countSucceededReviewLoopOperations,
  hasSucceededReviewLoopPushToHead,
  selectLatestSucceededReviewLoopPushHead,
} from "../../apps/control-plane-worker/src/services/review-loop-operations";
import type { PrReviewExpectedBot } from "../../shared/constants/pr-review-bots.js";

// Capture Datadog structured emits so we can assert dispatch telemetry fires exactly once per dispatch.
const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

class SqliteD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
    private readonly beforeRun?: (query: string) => Promise<void> | void,
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
    await this.beforeRun?.(this.query);
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(
    readonly db: Database.Database,
    private readonly beforeRun?: (query: string) => Promise<void> | void,
  ) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query, this.beforeRun);
  }
}

let sqlite: Database.Database;
let db: D1Database;

const expectedBots: PrReviewExpectedBot[] = [
  { type: "known", id: "cursor-bugbot" },
  { type: "custom", login: "review-pal" },
];

beforeEach(() => {
  mockPostStructuredEventToDd.mockClear();
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
});

function baseActivityInput(overrides: Partial<ReviewLoopActivityInput> = {}): ReviewLoopActivityInput {
  return {
    sessionId: "s-base-race",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 99,
    prUrl: "https://github.com/acme/repo/pull/99",
    headSha: "base-race-sha",
    expectedBots,
    expectedBotsHash: "hash-base-race",
    sourceId: "review:cursor",
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId: "review:cursor" },
    nowMs: 6_500,
    ...overrides,
  };
}

async function createReadyEpoch(sessionId: string, nowMs: number) {
  return upsertReviewLoopEpochActivity(db, {
    sessionId,
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 44,
    prUrl: `https://github.com/acme/repo/pull/${sessionId}`,
    headSha: "ghi789",
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "hash-lease",
    sourceId: `review:${sessionId}`,
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId: `review:${sessionId}` },
    nowMs,
  });
}

// Direct-SQL state resets used to set up CAS-staleness preconditions: requeue an epoch to `ready`
// (clearing prompt/lease/reservation state) or force it `completed`, then re-claim with a new worker
// to prove the surviving mark* CAS guards reject stale tokens/prompts from the prior claim.
function requeueEpoch(epochId: string) {
  sqlite
    .prepare(
      `UPDATE pr_review_response_epochs
         SET status = 'ready', last_prompt_id = NULL, blocked_reason = NULL, lease_owner = NULL,
             lease_expires_at = NULL, reservation_token = NULL, last_error = NULL
       WHERE id = ?`,
    )
    .run(epochId);
}

function forceCompleteEpoch(epochId: string) {
  sqlite
    .prepare(
      `UPDATE pr_review_response_epochs
         SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, reservation_token = NULL
       WHERE id = ?`,
    )
    .run(epochId);
}

function insertSucceededReplyOperation(
  epochId: string,
  promptId: string,
  targetSourceId: string,
  nowMs: number,
  verdict: "fixed" | "replied" | "declined" | null = "fixed",
) {
  sqlite
    .prepare(
      `INSERT INTO pr_review_response_operations (
         operation_id, epoch_id, session_id, prompt_id, kind, target_source_id, head_sha,
         status, attempts, github_id, verdict, verdict_basis, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'reply', ?, 'ghi789', 'succeeded', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      `op-${epochId}-${targetSourceId}`,
      epochId,
      `session-${epochId}`,
      promptId,
      targetSourceId,
      `github-${targetSourceId}`,
      verdict,
      verdict === "declined" ? "Declined in test." : null,
      nowMs,
      nowMs,
    );
}

// ARC-1407 helpers: a succeeded push operation (the self-authenticating evidence anchor), a
// direct-SQL block precondition, and an in-flight carried-forward tail precondition.
function insertSucceededPushOperation(epochId: string, promptId: string, headSha: string, nowMs: number) {
  sqlite
    .prepare(
      `INSERT INTO pr_review_response_operations (
         operation_id, epoch_id, session_id, prompt_id, kind, target_source_id, head_sha,
         status, attempts, github_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'push', NULL, ?, 'succeeded', 1, ?, ?, ?)`,
    )
    .run(`op-push-${epochId}-${promptId}`, epochId, `session-${epochId}`, promptId, headSha, headSha, nowMs, nowMs);
}

function forceBlockEpoch(epochId: string, reason: string) {
  sqlite
    .prepare(
      `UPDATE pr_review_response_epochs
         SET status = 'blocked', blocked_reason = ?, last_error = ?, lease_owner = NULL,
             lease_expires_at = NULL, reservation_token = NULL
       WHERE id = ?`,
    )
    .run(reason, reason, epochId);
}

function setEpochInFlightWithCarriedTail(epochId: string, carried: string[], leaseExpiresAt: number) {
  sqlite
    .prepare(
      `UPDATE pr_review_response_epochs
         SET status = 'processing', last_prompt_id = 'p-carry', carried_forward_source_ids_json = ?,
             lease_owner = 'in-flight', lease_expires_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(carried), leaseExpiresAt, epochId);
}

describe("review-loop epoch DAO/service", () => {
  it("does not swallow findings: a completed in-progress-placeholder epoch still opens a NEW wave for Strix's terminal check_run (PR #7118 / Codex P1)", async () => {
    // Wave 1: Strix posts its mutable placeholder comment (activity-tier, non-terminal for Strix, whose
    // terminal signals are check_run/review_submission). The worklist noise gate empties the worklist so
    // the epoch settles 'completed' with issue-comment:<id> in handledSourceIds — the exact state Codex
    // flagged as swallowing a later same-comment findings edit.
    const placeholder = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-strix-mutable",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 7118,
      prUrl: "https://github.com/acme/repo/pull/7118",
      headSha: "head-9c9371f",
      expectedBots: [{ type: "known", id: "strix" }],
      expectedBotsHash: "hash-strix",
      sourceId: "issue-comment:4909514271",
      botKey: "known:strix",
      botActorLogin: "strix-security[bot]",
      terminal: false,
      evidence: { type: "issue_comment_activity", sourceId: "issue-comment:4909514271" },
      nowMs: 1_000,
    });
    expect(placeholder.wave).toBe(1);
    forceCompleteEpoch(placeholder.id);

    // Wave 2 trigger: Strix finishes — it edits the SAME comment to findings (that edited issue_comment
    // webhook is DROPPED at the router, action !== "created", so it never re-ingests via issue-comment) and
    // its check_run COMPLETES. The completed check_run is a DISTINCT sourceId not accounted for by the
    // completed placeholder epoch, so shouldStartNewWave fires and a fresh wave opens — whose worklist
    // re-fetch then surfaces the edited-in findings (proven at the worklist layer in
    // review-loop-worklist.test.ts). The findings are therefore NOT swallowed.
    const terminal = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-strix-mutable",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 7118,
      prUrl: "https://github.com/acme/repo/pull/7118",
      headSha: "head-9c9371f",
      expectedBots: [{ type: "known", id: "strix" }],
      expectedBotsHash: "hash-strix",
      sourceId: "check-run:9001",
      botKey: "known:strix",
      botActorLogin: "strix-security[bot]",
      terminal: true,
      evidence: { type: "check_run", sourceId: "check-run:9001" },
      nowMs: 2_000,
    });

    expect(terminal.id).not.toBe(placeholder.id);
    expect(terminal.wave).toBe(2);
    expect(terminal.status).not.toBe("completed");
  });

  it("unions triggering and handled source IDs across a session's epochs for the same PR", async () => {
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-known",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-a",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review-comment:111",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:111" },
      nowMs: 1_000,
    });
    // A second epoch on a later head for the same PR.
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-known",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-b",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review-comment:222",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:222" },
      nowMs: 2_000,
    });
    // A different PR must not leak into the result.
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-known",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 99,
      prUrl: "https://github.com/acme/repo/pull/99",
      headSha: "head-c",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review-comment:999",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:999" },
      nowMs: 3_000,
    });
    // A different session on the SAME PR URL must not leak in (the query filters on session_id).
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-other",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-d",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review-comment:777",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:777" },
      nowMs: 4_000,
    });

    const known = await listKnownReviewLoopSourceIds(db, {
      sessionId: "s-known",
      prUrl: "https://github.com/acme/repo/pull/42",
    });

    expect(known.has("review-comment:111")).toBe(true);
    expect(known.has("review-comment:222")).toBe(true);
    expect(known.has("review-comment:999")).toBe(false);
    expect(known.has("review-comment:777")).toBe(false);
  });

  it("counts epochs for a session+PR across heads, excluding other PRs and sessions", async () => {
    const activity = (overrides: Partial<ReviewLoopActivityInput>) =>
      upsertReviewLoopEpochActivity(db, {
        sessionId: "s-count",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 55,
        prUrl: "https://github.com/acme/repo/pull/55",
        headSha: "head-a",
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "hash-count",
        sourceId: "review:count",
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal: true,
        evidence: { type: "review_submission", sourceId: "review:count" },
        nowMs: 1_000,
        ...overrides,
      });

    // Two epochs for s-count + pull/55 (distinct heads each create their own epoch row).
    await activity({
      headSha: "head-a",
      sourceId: "review:a",
      evidence: { type: "review_submission", sourceId: "review:a" },
    });
    await activity({
      headSha: "head-b",
      sourceId: "review:b",
      evidence: { type: "review_submission", sourceId: "review:b" },
    });
    // A different PR for the same session must not be counted.
    await activity({ prNumber: 56, prUrl: "https://github.com/acme/repo/pull/56", headSha: "head-c" });
    // A different session on the same PR URL must not be counted.
    await activity({ sessionId: "s-count-other", headSha: "head-d" });

    expect(
      await countReviewLoopEpochsForPr(db, { sessionId: "s-count", prUrl: "https://github.com/acme/repo/pull/55" }),
    ).toBe(2);
    expect(
      await countReviewLoopEpochsForPr(db, { sessionId: "s-count", prUrl: "https://github.com/acme/repo/pull/404" }),
    ).toBe(0);
  });

  it("merges duplicate activity into one epoch and marks ready only when every configured bot is terminal", async () => {
    const first = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-1",
      ownerUserId: 101,
      repoOwner: "Acme",
      repoName: "Repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "abc123",
      expectedBots,
      expectedBotsHash: "hash-1",
      sourceId: "review:9001",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:9001" },
      nowMs: 1_000,
    });

    const duplicate = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-1",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "abc123",
      expectedBots,
      expectedBotsHash: "hash-1",
      sourceId: "review:9001",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:9001" },
      nowMs: 1_100,
    });

    expect(duplicate.id).toBe(first.id);
    // Walltime removal: a partially-observed epoch is `ready` (immediately due), not `collecting`.
    expect(duplicate.status).toBe("ready");
    expect(duplicate.observedTerminalBotKeys).toEqual(["known:cursor-bugbot"]);
    expect(duplicate.observedTerminalBots).toEqual(["cursor"]);
    expect(duplicate.handledSourceIds).toEqual(["review:9001"]);
    expect(duplicate.observedTerminalBotCount).toBe(1);

    const ready = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-1",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "abc123",
      expectedBots,
      expectedBotsHash: "hash-1",
      sourceId: "comment:77",
      botKey: "custom:review-pal",
      botActorLogin: "review-pal[bot]",
      terminal: true,
      evidence: { type: "issue_comment_final", sourceId: "comment:77" },
      nowMs: 1_200,
    });

    expect(ready.status).toBe("ready");
    expect(ready.observedTerminalBotKeys).toEqual(["custom:review-pal", "known:cursor-bugbot"]);
    expect(ready.observedTerminalBots).toEqual(["cursor", "review-pal"]);
    expect(ready.handledSourceIds).toEqual(["comment:77", "review:9001"]);
    expect(ready.terminalEvidence).toHaveLength(2);
  });

  it("retries terminal-bot merges when a concurrent delivery updates the same epoch first", async () => {
    const threeExpectedBots: PrReviewExpectedBot[] = [
      { type: "known", id: "cursor-bugbot" },
      { type: "custom", login: "review-pal" },
      { type: "known", id: "strix" },
    ];
    let raceDb: D1Database;
    let injectedConcurrentUpdate = false;
    raceDb = new SqliteD1(sqlite, async (query) => {
      if (injectedConcurrentUpdate || !query.includes("SET observed_terminal_bots_json = ?")) return;
      injectedConcurrentUpdate = true;
      await upsertReviewLoopEpochActivity(raceDb, {
        sessionId: "s-race",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 45,
        prUrl: "https://github.com/acme/repo/pull/45",
        headSha: "race-sha",
        expectedBots: threeExpectedBots,
        expectedBotsHash: "hash-race",
        sourceId: "review:strix",
        botKey: "known:strix",
        botActorLogin: "strix[bot]",
        terminal: true,
        evidence: { type: "review_submission", sourceId: "review:strix" },
        nowMs: 5_050,
      });
    }) as unknown as D1Database;

    await upsertReviewLoopEpochActivity(raceDb, {
      sessionId: "s-race",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 45,
      prUrl: "https://github.com/acme/repo/pull/45",
      headSha: "race-sha",
      expectedBots: threeExpectedBots,
      expectedBotsHash: "hash-race",
      sourceId: "review:cursor",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:cursor" },
      nowMs: 5_000,
    });

    const raced = await upsertReviewLoopEpochActivity(raceDb, {
      sessionId: "s-race",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 45,
      prUrl: "https://github.com/acme/repo/pull/45",
      headSha: "race-sha",
      expectedBots: threeExpectedBots,
      expectedBotsHash: "hash-race",
      sourceId: "comment:review-pal",
      botKey: "custom:review-pal",
      botActorLogin: "review-pal[bot]",
      terminal: true,
      evidence: { type: "issue_comment_final", sourceId: "comment:review-pal" },
      nowMs: 5_100,
    });

    expect(injectedConcurrentUpdate).toBe(true);
    expect(raced.status).toBe("ready");
    expect(raced.observedTerminalBotKeys).toEqual(["custom:review-pal", "known:cursor-bugbot", "known:strix"]);
    expect(raced.handledSourceIds).toEqual(["comment:review-pal", "review:cursor", "review:strix"]);
    expect(raced.terminalEvidence).toHaveLength(3);
  });

  it("retries first-wave inserts when a concurrent delivery wins the insert race", async () => {
    const twoExpectedBots: PrReviewExpectedBot[] = [
      { type: "known", id: "cursor-bugbot" },
      { type: "custom", login: "review-pal" },
    ];
    let raceDb: D1Database;
    let injectedConcurrentInsert = false;
    raceDb = new SqliteD1(sqlite, async (query) => {
      if (injectedConcurrentInsert || !query.includes("INSERT OR IGNORE INTO pr_review_response_epochs")) return;
      injectedConcurrentInsert = true;
      await upsertReviewLoopEpochActivity(raceDb, {
        sessionId: "s-insert-race",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 46,
        prUrl: "https://github.com/acme/repo/pull/46",
        headSha: "insert-race-sha",
        expectedBots: twoExpectedBots,
        expectedBotsHash: "hash-insert-race",
        sourceId: "review:cursor",
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal: true,
        evidence: { type: "review_submission", sourceId: "review:cursor" },
        nowMs: 6_000,
      });
    }) as unknown as D1Database;

    const raced = await upsertReviewLoopEpochActivity(raceDb, {
      sessionId: "s-insert-race",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 46,
      prUrl: "https://github.com/acme/repo/pull/46",
      headSha: "insert-race-sha",
      expectedBots: twoExpectedBots,
      expectedBotsHash: "hash-insert-race",
      sourceId: "comment:review-pal",
      botKey: "custom:review-pal",
      botActorLogin: "review-pal[bot]",
      terminal: true,
      evidence: { type: "issue_comment_final", sourceId: "comment:review-pal" },
      nowMs: 6_100,
    });

    expect(injectedConcurrentInsert).toBe(true);
    expect(raced.wave).toBe(1);
    expect(raced.status).toBe("ready");
    expect(raced.observedTerminalBotKeys).toEqual(["custom:review-pal", "known:cursor-bugbot"]);
    expect(raced.handledSourceIds).toEqual(["comment:review-pal", "review:cursor"]);
    expect(raced.terminalEvidence).toHaveLength(2);
  });

  it("resolves a lost insert race without any exception crossing the D1 layer", async () => {
    let injectedConcurrentInsert = false;
    const thrownByD1: unknown[] = [];
    let raceDb: D1Database;
    const inject = async (query: string) => {
      if (injectedConcurrentInsert || !query.includes("INSERT OR IGNORE INTO pr_review_response_epochs")) return;
      injectedConcurrentInsert = true;
      await upsertReviewLoopEpochActivity(raceDb, baseActivityInput({ sourceId: "review:cursor" }));
    };
    raceDb = new (class extends SqliteD1 {
      prepare(query: string) {
        const stmt = super.prepare(query);
        const run = stmt.run.bind(stmt);
        stmt.run = async () => {
          try {
            return await run();
          } catch (error) {
            thrownByD1.push(error);
            throw error;
          }
        };
        return stmt;
      }
    })(sqlite, inject) as unknown as D1Database;

    const raced = await upsertReviewLoopEpochActivity(
      raceDb,
      baseActivityInput({ sourceId: "comment:review-pal", botKey: "custom:review-pal" }),
    );

    expect(injectedConcurrentInsert).toBe(true);
    expect(raced.wave).toBe(1);
    // The losing insert resolves via INSERT OR IGNORE + re-select, not via a
    // caught UNIQUE-constraint exception, so no error span is ever emitted.
    expect(thrownByD1).toEqual([]);
  });

  it("resolves a lost insert race on a wave > 1 insert", async () => {
    // Wave 1 exists and is terminal, so the next activity opens wave 2.
    const first = await upsertReviewLoopEpochActivity(db, baseActivityInput({ sourceId: "review:cursor" }));
    sqlite.prepare("UPDATE pr_review_response_epochs SET status = 'completed' WHERE id = ?").run(first.id);

    let injectedConcurrentInsert = false;
    let raceDb: D1Database;
    raceDb = new SqliteD1(sqlite, async (query) => {
      if (injectedConcurrentInsert || !query.includes("INSERT OR IGNORE INTO pr_review_response_epochs")) return;
      injectedConcurrentInsert = true;
      await upsertReviewLoopEpochActivity(raceDb, baseActivityInput({ sourceId: "review:strix", nowMs: 7_000 }));
    }) as unknown as D1Database;

    const raced = await upsertReviewLoopEpochActivity(
      raceDb,
      baseActivityInput({ sourceId: "comment:review-pal", botKey: "custom:review-pal", nowMs: 7_100 }),
    );

    expect(injectedConcurrentInsert).toBe(true);
    // Both racers land on wave 2: the loser folds into the winner's row.
    expect(raced.wave).toBe(2);
    expect(raced.handledSourceIds).toEqual(expect.arrayContaining(["comment:review-pal", "review:strix"]));
  });

  it("throws when an ignored insert has no matching unique-key row (masked constraint)", async () => {
    // Simulate OR IGNORE suppressing a non-unique-key constraint: the insert
    // reports changes = 0 but no winner row exists under the unique key.
    const maskingDb = {
      prepare(query: string) {
        const stmt = (db as unknown as SqliteD1).prepare(query);
        if (query.includes("INSERT OR IGNORE INTO pr_review_response_epochs")) {
          stmt.run = async () => ({ success: true as const, meta: { changes: 0 } });
        }
        return stmt;
      },
    } as unknown as D1Database;

    await expect(upsertReviewLoopEpochActivity(maskingDb, baseActivityInput({}))).rejects.toThrow(
      /ignored without a matching unique-key row/,
    );
  });

  it("orders due epochs by updated time, then expired lease", async () => {
    // Walltime removal: every epoch is immediately `ready`; there is no `collecting` fallback-ordering
    // arm. Ready epochs sort by updated_at, expired-lease reservations by lease_expires_at.
    const readyNewest = await createReadyEpoch("s-ready-newest", 5_000);
    const readyOlder = await createReadyEpoch("s-ready-older", 4_000);
    const expiringLate = await createReadyEpoch("s-expiring-late", 6_000);
    const expiringEarly = await createReadyEpoch("s-expiring-early", 7_000);

    await claimReviewLoopEpochForPrompt(db, expiringLate.id, { leaseOwner: "worker-late", nowMs: 6_000 });
    await claimReviewLoopEpochForPrompt(db, expiringEarly.id, { leaseOwner: "worker-early", nowMs: 5_500 });

    const due = await listDueReviewLoopEpochs(db, { nowMs: 700_000, limit: 10 });

    expect(due.map((epoch) => epoch.id)).toEqual([readyOlder.id, readyNewest.id, expiringEarly.id, expiringLate.id]);
  });

  it("does not select or claim a legacy collecting row via the fallback window", async () => {
    // Walltime removal: `collecting` is no longer a due-selection state. A legacy row left in
    // `collecting` (even with fallback_after_at in the past) is neither listed nor claimable.
    const epoch = await createReadyEpoch("s-legacy-collecting", 1_000);
    sqlite
      .prepare(`UPDATE pr_review_response_epochs SET status = 'collecting', fallback_after_at = ? WHERE id = ?`)
      .run(1, epoch.id);

    const due = await listDueReviewLoopEpochs(db, { nowMs: 1_000_000, limit: 50 });
    expect(due.find((e) => e.id === epoch.id)).toBeUndefined();

    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "t", nowMs: 1_000_000 });
    expect(claimed).toBeNull();
  });

  it("creates a new wave for late bot activity after the prior wave is completed", async () => {
    const firstWave = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-wave",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 48,
      prUrl: "https://github.com/acme/repo/pull/48",
      headSha: "same-head",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-wave",
      sourceId: "review:first-wave",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:first-wave" },
      nowMs: 8_000,
    });
    const claimed = await claimReviewLoopEpochForPrompt(db, firstWave.id, { leaseOwner: "worker", nowMs: 8_100 });
    await markReviewLoopEpochCompleted(db, firstWave.id, {
      nowMs: 8_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
      worklistHash: "first-worklist",
    });

    const secondWave = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-wave",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 48,
      prUrl: "https://github.com/acme/repo/pull/48",
      headSha: "same-head",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-wave",
      sourceId: "review:second-wave",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:second-wave" },
      nowMs: 9_000,
    });

    expect(secondWave.id).not.toBe(firstWave.id);
    expect(secondWave.wave).toBe(2);
    expect(secondWave.status).toBe("ready");
    expect(secondWave.handledSourceIds).toEqual(["review:second-wave"]);
    expect((await getReviewLoopEpochById(db, firstWave.id))?.status).toBe("completed");
  });

  it("claims ready epochs with CAS and records enqueue", async () => {
    const epoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-2",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 43,
      prUrl: "https://github.com/acme/repo/pull/43",
      headSha: "def456",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-2",
      sourceId: "review:9002",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:9002" },
      nowMs: 2_000,
    });

    const due = await listDueReviewLoopEpochs(db, { nowMs: 2_000, limit: 10 });
    expect(due.map((row) => row.id)).toEqual([epoch.id]);

    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 2_100 });
    expect(claimed?.status).toBe("reserving");
    expect(claimed?.leaseOwner).toBe("worker-a");
    expect(await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 2_100 })).toBeNull();

    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-3",
      worklistHash: "worklist-hash",
      nowMs: 2_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    expect(enqueued?.status).toBe("enqueued");
    expect(enqueued?.lastPromptId).toBe("p-3");
    expect(enqueued?.worklistHash).toBe("worklist-hash");

    const waiting = await markReviewLoopEpochWaitingForOwner(db, epoch.id, {
      nowMs: 2_250,
      reason: "sensitive_paths",
      expectedPromptId: "p-3",
    });
    expect(waiting?.status).toBe("waiting_for_owner");
    expect(waiting?.blockedReason).toBe("sensitive_paths");
  });

  it("claims a fresh bot epoch immediately (walltime removal, no batching window)", async () => {
    // Walltime removal: a non-terminal bot signal lands `ready` (immediately due), not `collecting`,
    // and is claimable at once — there is no reviewTimeoutMinutes batching window.
    const epoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-collect-window",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 44,
      prUrl: "https://github.com/acme/repo/pull/s-collect-window",
      headSha: "ghi789",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-collect",
      sourceId: "review:collect",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: false,
      evidence: { type: "review_submission", sourceId: "review:collect" },
      nowMs: 1_000,
    });
    expect(epoch.status).toBe("ready");

    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "webhook", nowMs: 2_000 });
    expect(claimed?.status).toBe("reserving");
    expect(claimed?.leaseOwner).toBe("webhook");
  });

  it("records the prompted source ids when an epoch is enqueued", async () => {
    const epoch = await createReadyEpoch("s-prompted", 5_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 5_100 });
    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-prompted",
      worklistHash: "wh",
      nowMs: 5_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:2", "review-comment:1", "review-comment:2"],
    });
    // Deduped and sorted, mirroring the other source-id arrays.
    expect(enqueued?.promptedSourceIds).toEqual(["review-comment:1", "review-comment:2"]);
  });

  it("retains prompted source ids when a reclaimed epoch is re-enqueued with a smaller worklist", async () => {
    const epoch = await createReadyEpoch("s-prompted-reclaim", 5_500);
    const firstClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 5_600 });
    const firstEnqueue = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-prompted-reclaim-1",
      worklistHash: "wh-1",
      nowMs: 5_700,
      expectedReservationToken: firstClaim?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:first", "review-comment:shared"],
    });
    expect(firstEnqueue?.promptedSourceIds).toEqual(["review-comment:first", "review-comment:shared"]);

    const reclaimed = await reclaimStuckReviewLoopEpoch(db, epoch.id, {
      nowMs: (firstEnqueue?.leaseExpiresAt ?? 0) + 1,
      expectedLeaseExpiresAt: firstEnqueue?.leaseExpiresAt ?? null,
    });
    expect(reclaimed?.status).toBe("ready");

    const secondClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, {
      leaseOwner: "worker-b",
      nowMs: (firstEnqueue?.leaseExpiresAt ?? 0) + 2,
    });
    const secondEnqueueNowMs = (firstEnqueue?.leaseExpiresAt ?? 0) + 3;
    const secondEnqueue = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-prompted-reclaim-2",
      worklistHash: "wh-2",
      nowMs: secondEnqueueNowMs,
      expectedReservationToken: secondClaim?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:shared"],
      existingPromptedSourceRecords: secondClaim?.promptedSourceRecords,
    });

    expect(secondEnqueue?.promptedSourceIds).toEqual(["review-comment:first", "review-comment:shared"]);
    // The carried-forward id keeps its first-attempt promptedAtMs; the re-prompted id is re-stamped
    // with the current dispatch time so edited-feedback dedup measures edits against the latest prompt.
    expect(secondEnqueue?.promptedSourceRecords).toEqual([
      { sourceId: "review-comment:first", promptedAtMs: 5_700 },
      { sourceId: "review-comment:shared", promptedAtMs: secondEnqueueNowMs },
    ]);
  });

  it("persists review-body bodyHashes and preserves them across a reclaim re-enqueue (PR-1)", async () => {
    const epoch = await createReadyEpoch("s-bodyhash", 6_000);
    const prUrl = "https://github.com/acme/repo/pull/s-bodyhash";
    const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w-a", nowMs: 6_100 });
    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-bh-1",
      worklistHash: "wh",
      nowMs: 6_200,
      expectedReservationToken: claim?.reservationToken ?? null,
      promptedSourceIds: ["review-body:9100", "review-comment:1"],
      promptedSourceBodyHashes: new Map([["review-body:9100", "hash-original"]]),
    });
    // The hash is recorded for the review-body id only; the review-comment id gets no hash.
    expect(enqueued?.promptedSourceRecords).toEqual([
      { sourceId: "review-body:9100", promptedAtMs: 6_200, bodyHash: "hash-original" },
      { sourceId: "review-comment:1", promptedAtMs: 6_200 },
    ]);

    // It round-trips through the JSON column into the known/prompted source readers.
    const known = await listKnownReviewLoopSources(db, { sessionId: "s-bodyhash", prUrl });
    expect(known.bodyHashBySourceId?.get("review-body:9100")).toBe("hash-original");

    // Reclaim and re-enqueue WITHOUT supplying a new hash for the carried id: the original hash must
    // survive (a regression here would silently re-open the edited-review-body bug after one reclaim).
    const reclaimed = await reclaimStuckReviewLoopEpoch(db, epoch.id, {
      nowMs: (enqueued?.leaseExpiresAt ?? 0) + 1,
      expectedLeaseExpiresAt: enqueued?.leaseExpiresAt ?? null,
    });
    expect(reclaimed?.status).toBe("ready");
    const claim2 = await claimReviewLoopEpochForPrompt(db, epoch.id, {
      leaseOwner: "w-b",
      nowMs: (enqueued?.leaseExpiresAt ?? 0) + 2,
    });
    const reEnqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-bh-2",
      worklistHash: "wh-2",
      nowMs: (enqueued?.leaseExpiresAt ?? 0) + 3,
      expectedReservationToken: claim2?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1"],
      existingPromptedSourceRecords: claim2?.promptedSourceRecords,
    });
    const carried = reEnqueued?.promptedSourceRecords?.find((r) => r.sourceId === "review-body:9100");
    expect(carried?.bodyHash).toBe("hash-original");
  });

  it("carries dropped source ids forward and re-drives instead of completing until the tail drains (ARC-1226)", async () => {
    const epoch = await createReadyEpoch("s-carry-forward", 7_000);

    // Wave 1: the dispatch shows two items but the body budget dropped two more.
    const claim1 = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w1", nowMs: 7_100 });
    const enq1 = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-cf-1",
      worklistHash: "wh-1",
      nowMs: 7_200,
      expectedReservationToken: claim1?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1", "review-comment:2"],
      carriedForwardSourceIds: ["review-comment:3", "review-comment:4"],
    });
    expect(enq1?.carriedForwardSourceIds).toEqual(["review-comment:3", "review-comment:4"]);

    // The agent finishes (publish path). Carried-forward remains, so the epoch must RE-DRIVE (ready),
    // not settle terminal `completed` (which would let the rollup reach review-loop:done with the
    // dropped feedback never shown).
    insertSucceededReplyOperation(epoch.id, "p-cf-1", "review-comment:1", 7_250);
    insertSucceededReplyOperation(epoch.id, "p-cf-1", "review-comment:2", 7_260);
    const settled1 = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs: 7_300, expectedPromptId: "p-cf-1" });
    expect(settled1?.status).toBe("ready");
    expect(settled1?.lastPromptId).toBeNull();
    expect(settled1?.carriedForwardSourceIds).toEqual(["review-comment:3", "review-comment:4"]);

    // Wave 2: the carried tail now fits once the already-prompted items are excluded; nothing dropped.
    const claim2 = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w2", nowMs: 7_400 });
    expect(claim2?.status).toBe("reserving");
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-cf-2",
      worklistHash: "wh-2",
      nowMs: 7_500,
      expectedReservationToken: claim2?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:3", "review-comment:4"],
      existingPromptedSourceRecords: claim2?.promptedSourceRecords,
      carriedForwardSourceIds: [],
    });

    // No carried-forward left: this completion settles terminal `completed`.
    insertSucceededReplyOperation(epoch.id, "p-cf-2", "review-comment:3", 7_550);
    insertSucceededReplyOperation(epoch.id, "p-cf-2", "review-comment:4", 7_560);
    const settled2 = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs: 7_600, expectedPromptId: "p-cf-2" });
    expect(settled2?.status).toBe("completed");
    expect((await getReviewLoopEpochById(db, epoch.id))?.carriedForwardSourceIds).toEqual([]);
  });

  it("defaults carry_forward_no_progress_count to 0 for a freshly created epoch (ARC-1242)", async () => {
    const epoch = await createReadyEpoch("s-np-default", 2_000);
    const reread = await getReviewLoopEpochById(db, epoch.id);
    expect(reread?.carryForwardNoProgressCount).toBe(0);
  });

  it("re-drives via the reply-only / no-op terminal path while carried-forward remains (ARC-1226)", async () => {
    const epoch = await createReadyEpoch("s-carry-replyonly", 9_000);
    const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w", nowMs: 9_100 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-ro-1",
      worklistHash: "wh",
      nowMs: 9_200,
      expectedReservationToken: claim?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:a"],
      carriedForwardSourceIds: ["review-comment:b"],
    });
    // Reply-only / no-op terminal completion (no publish) must also re-drive, not settle `completed`.
    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, { promptId: "p-ro-1", nowMs: 9_300 });
    expect(resolved?.status).toBe("ready");
    expect(resolved?.lastPromptId).toBeNull();
    expect(resolved?.carriedForwardSourceIds).toEqual(["review-comment:b"]);
  });

  it("stops re-driving a never-draining truncated epoch with an honest non-exhausted blocked reason (ARC-1226 backstop)", async () => {
    const epoch = await createReadyEpoch("s-carry-backstop", 1_000);
    let nowMs = 1_000;
    let status: string | undefined = "ready";
    let reason: string | null = null;
    // Pathological: every wave still drops the SAME un-fittable tail (never shrinks). The backstop must
    // cap the re-drives via carry_forward_no_progress_count (consecutive no-progress) and park with the
    // honest non-exhausted reason instead of spinning forever (ARC-1242).
    for (let i = 0; i < 50 && status === "ready"; i += 1) {
      nowMs += 10;
      const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: `w${i}`, nowMs });
      if (!claim) break;
      nowMs += 10;
      await markReviewLoopEpochEnqueued(db, epoch.id, {
        promptId: `p-${i}`,
        worklistHash: `wh-${i}`,
        nowMs,
        expectedReservationToken: claim.reservationToken,
        promptedSourceIds: [`review-comment:shown-${i}`],
        existingPromptedSourceRecords: claim.promptedSourceRecords,
        carriedForwardSourceIds: ["review-comment:never-fits"],
      });
      nowMs += 10;
      insertSucceededReplyOperation(epoch.id, `p-${i}`, `review-comment:shown-${i}`, nowMs - 1);
      const settled = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs, expectedPromptId: `p-${i}` });
      status = settled?.status;
      reason = settled?.blockedReason ?? null;
    }
    expect(status).toBe("blocked");
    // Honest "not caught up" reason, deliberately NOT an exhausted/disabled reason, so the rollup
    // keeps the head "working" rather than falsely claiming done with feedback unshown.
    expect(reason).toBe("worklist_truncation_unresolved");
  });

  it("completed_noop (clearCarryForward) completes and clears a stale carried tail from the reserving arm (ARC-1226)", async () => {
    // A re-driven epoch keeps its carried tail through the next claim into `reserving`. If that wave's
    // worklist comes back empty (the carried comments were resolved/deleted on GitHub), the sweep's
    // completed_noop path must COMPLETE and CLEAR the stale column — not re-drive off the stale value.
    const epoch = await createReadyEpoch("s-noop-clear", 3_000);
    const c1 = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w1", nowMs: 3_100 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p1",
      worklistHash: "h1",
      nowMs: 3_200,
      expectedReservationToken: c1?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:shown"],
      carriedForwardSourceIds: ["review-comment:tail"],
    });
    const redriven = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs: 3_300, expectedPromptId: "p1" });
    expect(redriven?.status).toBe("ready");
    expect(redriven?.carriedForwardSourceIds).toEqual(["review-comment:tail"]);

    const c2 = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w2", nowMs: 3_400 });
    expect(c2?.status).toBe("reserving");
    // Carried tail is still on the row (claim does not clear it).
    expect(c2?.carriedForwardSourceIds).toEqual(["review-comment:tail"]);

    const done = await markReviewLoopEpochCompleted(db, epoch.id, {
      nowMs: 3_500,
      worklistHash: "h-empty",
      expectedReservationToken: c2?.reservationToken ?? null,
      clearCarryForward: true,
    });
    expect(done?.status).toBe("completed");
    expect(done?.carriedForwardSourceIds).toEqual([]);
  });

  it("gives a human review its own ready wave when the matched epoch already dispatched its prompt", async () => {
    const base = {
      sessionId: "s-frozen-human",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 44,
      prUrl: "https://github.com/acme/repo/pull/frozen-human",
      headSha: "ghi789",
      expectedBots: [] as PrReviewExpectedBot[],
      expectedBotsHash: "empty-hash",
      botKey: "human",
      botActorLogin: "octocat",
      terminal: false,
      humanSource: true,
    };
    const first = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:1",
      evidence: { type: "review_submission", sourceId: "human:1" },
      nowMs: 3_000,
    });
    expect(first.status).toBe("ready");

    const claimed = await claimReviewLoopEpochForPrompt(db, first.id, { leaseOwner: "w", nowMs: 3_100 });
    await markReviewLoopEpochEnqueued(db, first.id, {
      promptId: "p-h1",
      worklistHash: "wh",
      nowMs: 3_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["human:1"],
    });

    // A second human review arrives while the first human epoch's prompt is in flight (frozen).
    const second = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:2",
      evidence: { type: "review_submission", sourceId: "human:2" },
      nowMs: 3_300,
    });
    // It opens its own wave instead of folding into the frozen worklist, and is immediately due.
    expect(second.id).not.toBe(first.id);
    expect(second.wave).toBe(first.wave + 1);
    expect(second.status).toBe("ready");
    expect(second.triggeringSourceIds).toContain("human:2");
    // The in-flight epoch is untouched — the late review was NOT recorded as unprompted triggering.
    const frozen = await getReviewLoopEpochById(db, first.id);
    expect(frozen?.triggeringSourceIds).not.toContain("human:2");
  });

  describe("scopes distinct human reviews to their own wave", () => {
    const countEpochsForHead = (headSha: string) =>
      (
        sqlite.prepare("SELECT COUNT(*) AS c FROM pr_review_response_epochs WHERE head_sha = ?").get(headSha) as {
          c: number;
        }
      ).c;

    const humanInput = (overrides: Partial<ReviewLoopActivityInput>): ReviewLoopActivityInput => ({
      sessionId: "s-split",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl: "https://github.com/acme/repo/pull/split",
      headSha: "split-sha",
      expectedBots: [],
      expectedBotsHash: EMPTY_EXPECTED_BOTS_HASH,
      sourceId: "human:0",
      botKey: "human",
      botActorLogin: "octocat",
      terminal: false,
      evidence: { type: "review_submission", sourceId: "human:0" },
      nowMs: 1_000,
      humanSource: { userId: 101, login: "octocat" },
      ...overrides,
    });

    const human = (headSha: string, reviewId: number, nowMs: number, extra: Partial<ReviewLoopActivityInput> = {}) =>
      humanInput({
        headSha,
        sourceId: `human:${reviewId}`,
        evidence: { type: "review_submission", sourceId: `human:${reviewId}` },
        nowMs,
        ...extra,
      });

    it("gives two reviews on the same head their own waves, each scoped to only its own review", async () => {
      const headSha = "split-two";
      const first = await upsertReviewLoopEpochActivity(db, human(headSha, 4647984291, 1_000));
      expect(first.status).toBe("ready");
      const second = await upsertReviewLoopEpochActivity(db, human(headSha, 4647986792, 1_100));

      expect(second.id).not.toBe(first.id);
      expect(first.wave).toBe(1);
      expect(second.wave).toBe(2);
      expect(first.triggeringSourceIds).toEqual(["human:4647984291"]);
      expect(second.triggeringSourceIds).toEqual(["human:4647986792"]);
      expect(countEpochsForHead(headSha)).toBe(2);
    });

    it("re-ingesting the first review after a second wave exists folds into its own wave (no duplicate)", async () => {
      const headSha = "split-idem";
      const first = await upsertReviewLoopEpochActivity(db, human(headSha, 100, 1_000));
      const second = await upsertReviewLoopEpochActivity(db, human(headSha, 200, 1_100));
      expect(second.wave).toBe(2);
      expect(countEpochsForHead(headSha)).toBe(2);

      // A redelivery of review 100 must return its OWN wave, not open a third off the latest (200).
      const redeliver = await upsertReviewLoopEpochActivity(db, human(headSha, 100, 1_200));
      expect(redeliver.id).toBe(first.id);
      expect(redeliver.wave).toBe(1);
      expect(countEpochsForHead(headSha)).toBe(2);
    });

    it("keeps a human review idempotent when it first folded into a bot (mixed) epoch", async () => {
      const headSha = "split-mixed";
      const bot = await upsertReviewLoopEpochActivity(
        db,
        baseActivityInput({
          sessionId: "s-split",
          prUrl: "https://github.com/acme/repo/pull/split",
          headSha,
          expectedBots: [{ type: "known", id: "cursor-bugbot" }],
          expectedBotsHash: "single-bot-hash",
          sourceId: "review-comment:900",
          botKey: "known:cursor-bugbot",
          nowMs: 2_000,
        }),
      );
      // Human A folds into the bot epoch (mixed) — mirrors ingest passing the bot's expected-bots hash.
      const mixed = await upsertReviewLoopEpochActivity(
        db,
        human(headSha, 100, 2_100, { expectedBots: bot.expectedBots, expectedBotsHash: bot.expectedBotsHash }),
      );
      expect(mixed.id).toBe(bot.id);
      expect(mixed.sourceKind).toBe("mixed");

      // Human B splits into its own human-only wave (forced empty expected-bots hash).
      const second = await upsertReviewLoopEpochActivity(
        db,
        human(headSha, 200, 2_200, { expectedBots: bot.expectedBots, expectedBotsHash: bot.expectedBotsHash }),
      );
      expect(second.id).not.toBe(bot.id);
      expect(second.expectedBotsHash).toBe(EMPTY_EXPECTED_BOTS_HASH);
      expect(countEpochsForHead(headSha)).toBe(2);

      // Re-ingesting A returns the mixed epoch it already lives in — no duplicate wave.
      const redeliver = await upsertReviewLoopEpochActivity(db, human(headSha, 100, 2_300));
      expect(redeliver.id).toBe(bot.id);
      expect(countEpochsForHead(headSha)).toBe(2);
    });

    it("widens a bot REVIEW epoch (human:<botReviewId> trigger) to mixed instead of splitting the human off", async () => {
      // A bot PR *review* is ingested with sourceId `human:<reviewId>` and NO humanSource, so its epoch's
      // triggering set is `human:<botReviewId>` even though the author is a bot (see
      // handlePullRequestReviewEvent's bot path). The split predicate must gate on sourceKind, not the
      // `human:` prefix, or it mistakes the bot review for a human sibling and refuses to widen to mixed.
      const headSha = "split-botreview";
      const bot = await upsertReviewLoopEpochActivity(
        db,
        baseActivityInput({
          sessionId: "s-split",
          prUrl: "https://github.com/acme/repo/pull/split",
          headSha,
          expectedBots: [{ type: "known", id: "cursor-bugbot" }],
          expectedBotsHash: "botreview-hash",
          sourceId: "human:900", // bot review id in the human:<reviewId> submission namespace
          botKey: "known:cursor-bugbot",
          nowMs: 3_000,
        }),
      );
      expect(bot.sourceKind).toBe("bot");
      expect(bot.triggeringSourceIds).toEqual(["human:900"]);

      // A real human review on the same head must WIDEN the bot epoch to mixed, not open its own wave.
      const mixed = await upsertReviewLoopEpochActivity(
        db,
        human(headSha, 555, 3_100, { expectedBots: bot.expectedBots, expectedBotsHash: bot.expectedBotsHash }),
      );
      expect(mixed.id).toBe(bot.id);
      expect(mixed.sourceKind).toBe("mixed");
      expect(countEpochsForHead(headSha)).toBe(1);
    });

    it("redelivery of a review whose wave already terminated is an idempotent no-op (returns that wave)", async () => {
      // Answers the reviewer concern that the all-wave shortcut could reuse a non-dispatchable epoch:
      // a redelivery of an already-carried review is intentionally a no-op regardless of the wave's
      // status (it was already ingested), matching the pre-existing terminal/frozen fold semantics. A
      // genuinely NEW review is never carried by any wave, so it still flows through to a fresh wave.
      const headSha = "split-terminal";
      const first = await upsertReviewLoopEpochActivity(db, human(headSha, 700, 1_000));
      sqlite.prepare("UPDATE pr_review_response_epochs SET status = 'completed' WHERE id = ?").run(first.id);

      const redeliver = await upsertReviewLoopEpochActivity(db, human(headSha, 700, 1_100));
      expect(redeliver.id).toBe(first.id);
      expect(redeliver.status).toBe("completed");
      expect(countEpochsForHead(headSha)).toBe(1);
    });

    it("folds a same-review redelivery while the wave is still ready (single wave)", async () => {
      const headSha = "split-fold";
      const first = await upsertReviewLoopEpochActivity(db, human(headSha, 500, 1_000));
      const again = await upsertReviewLoopEpochActivity(db, human(headSha, 500, 1_100));
      expect(again.id).toBe(first.id);
      expect(again.wave).toBe(1);
      expect(countEpochsForHead(headSha)).toBe(1);
    });

    it("assigns each of three distinct reviews a monotonic wave scoped to itself", async () => {
      const headSha = "split-three";
      const ids = [11, 22, 33];
      const epochs: Awaited<ReturnType<typeof upsertReviewLoopEpochActivity>>[] = [];
      let t = 1_000;
      for (const reviewId of ids) {
        epochs.push(await upsertReviewLoopEpochActivity(db, human(headSha, reviewId, (t += 100))));
      }
      expect(epochs.map((e) => e.wave)).toEqual([1, 2, 3]);
      epochs.forEach((e, i) => expect(e.triggeringSourceIds).toEqual([`human:${ids[i]}`]));
      expect(countEpochsForHead(headSha)).toBe(3);
    });

    it("dispatches both human waves on one head, each worklist carrying only its own review", async () => {
      const headSha = "split-dispatch";
      const first = await upsertReviewLoopEpochActivity(db, human(headSha, 111, 1_000));
      const second = await upsertReviewLoopEpochActivity(db, human(headSha, 222, 1_100));

      const due = await listDueReviewLoopEpochs(db, { nowMs: 5_000, limit: 50 });
      const dueForHead = due.filter((e) => e.id === first.id || e.id === second.id);
      expect(dueForHead).toHaveLength(2);
      const byId = new Map(dueForHead.map((e) => [e.id, e]));
      expect(byId.get(first.id)?.triggeringSourceIds).toEqual(["human:111"]);
      expect(byId.get(second.id)?.triggeringSourceIds).toEqual(["human:222"]);
    });
  });

  it("gives a human review its own wave during the reserving window, before the prompt is enqueued", async () => {
    const base = {
      sessionId: "s-reserving-human",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 44,
      prUrl: "https://github.com/acme/repo/pull/reserving-human",
      headSha: "ghi789",
      expectedBots: [] as PrReviewExpectedBot[],
      expectedBotsHash: "empty-hash",
      botKey: "human",
      botActorLogin: "octocat",
      terminal: false,
      humanSource: true,
    };
    const first = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:1",
      evidence: { type: "review_submission", sourceId: "human:1" },
      nowMs: 4_000,
    });
    // Claim it for prompting (→ reserving) but do NOT enqueue yet: lastPromptId is still null, but the
    // sweep has already snapshotted the worklist, so a fold-in here would never reach the prompt.
    const claimed = await claimReviewLoopEpochForPrompt(db, first.id, { leaseOwner: "w", nowMs: 4_100 });
    expect(claimed?.status).toBe("reserving");

    const second = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:2",
      evidence: { type: "review_submission", sourceId: "human:2" },
      nowMs: 4_200,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.wave).toBe(first.wave + 1);
    expect(second.status).toBe("ready");
    // The reserving epoch was not mutated — the review did not silently fold into its frozen worklist.
    const reserving = await getReviewLoopEpochById(db, first.id);
    expect(reserving?.status).toBe("reserving");
    expect(reserving?.triggeringSourceIds).not.toContain("human:2");
  });

  it("gives a human review its own wave when the epoch is claimed (collecting→reserving) mid-merge CAS", async () => {
    // Race variant of the test above (ARC-1230): the epoch is still fold-accepting when selected, but a
    // concurrent sweep claims it (→ reserving, worklist frozen) DURING updateEpochMerge's CAS loop. The
    // merge must re-decide against the fresh row rather than blindly re-folding into the now-frozen
    // epoch; the review gets its own new wave instead of being silently stranded.
    // A human review folding into a bot epoch is the fold path that still reaches updateEpochMerge:
    // distinct human reviews now split at decision time, so only a human-into-bot(/mixed) fold can be
    // frozen mid-merge. The redecide must still give the review its own wave instead of stranding it.
    const botBase = {
      sessionId: "s-reserving-human-race",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 46,
      prUrl: "https://github.com/acme/repo/pull/reserving-human-race",
      headSha: "race789",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }] as PrReviewExpectedBot[],
      expectedBotsHash: "race-bot-hash",
    };
    const first = await upsertReviewLoopEpochActivity(db, {
      ...botBase,
      sourceId: "review:cursor",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:cursor" },
      nowMs: 4_000,
    });
    expect(first.status).toBe("ready");

    // raceDb claims the epoch (→ reserving) the first time the merge UPDATE runs — i.e. after we decided
    // to fold in but before the CAS UPDATE commits — simulating the sweep grabbing it mid-merge.
    let injectedClaim = false;
    const raceDb = new SqliteD1(sqlite, async (query) => {
      if (injectedClaim || !query.includes("SET observed_terminal_bots_json = ?")) return;
      injectedClaim = true;
      await claimReviewLoopEpochForPrompt(db, first.id, { leaseOwner: "w", nowMs: 4_100 });
    }) as unknown as D1Database;

    const second = await upsertReviewLoopEpochActivity(raceDb, {
      ...botBase,
      expectedBots: [] as PrReviewExpectedBot[],
      sourceId: "human:1",
      botKey: "human",
      botActorLogin: "octocat",
      terminal: false,
      evidence: { type: "review_submission", sourceId: "human:1" },
      nowMs: 4_200,
      humanSource: { userId: 101, login: "octocat" },
    });

    expect(injectedClaim).toBe(true);
    // The review did NOT fold into the frozen epoch — it got its own new immediately-due wave.
    expect(second.id).not.toBe(first.id);
    expect(second.wave).toBe(first.wave + 1);
    expect(second.status).toBe("ready");
    // The reserving epoch was not mutated — human:1 was not stranded in its frozen worklist.
    const reserving = await getReviewLoopEpochById(db, first.id);
    expect(reserving?.status).toBe("reserving");
    expect(reserving?.triggeringSourceIds).not.toContain("human:1");
    expect(reserving?.handledSourceIds).not.toContain("human:1");
  });

  it("re-keys a human new wave away from a frozen bot epoch so later bot webhooks do not fold into it", async () => {
    const base = {
      sessionId: "s-human-rekey-from-bot",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 147,
      prUrl: "https://github.com/acme/repo/pull/human-rekey-from-bot",
      headSha: "human-rekey-head",
      expectedBots,
      expectedBotsHash: "hash-human-rekey-bot",
    };
    const botEpoch = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "review:bot-seed",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: false,
      evidence: { type: "review_comment_activity", sourceId: "review:bot-seed" },
      nowMs: 17_000,
    });
    const claimed = await claimReviewLoopEpochForPrompt(db, botEpoch.id, { leaseOwner: "w", nowMs: 17_100 });
    expect(claimed?.status).toBe("reserving");

    // This simulates the ingest race: human pre-selection copied the foldable bot epoch's hash, but
    // the epoch is frozen by the time upsert reaches the new-wave arm.
    const humanWave = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:late",
      botKey: "human",
      botActorLogin: null,
      terminal: false,
      evidence: { type: "review_submission", sourceId: "human:late" },
      nowMs: 17_200,
      humanSource: { userId: 101, login: "octocat" },
    });

    expect(humanWave.id).not.toBe(botEpoch.id);
    expect(humanWave.wave).toBe(botEpoch.wave + 1);
    expect(humanWave.sourceKind).toBe("human");
    expect(humanWave.expectedBots).toEqual([]);
    expect(humanWave.expectedBotsHash).toBe(EMPTY_EXPECTED_BOTS_HASH);

    const latestForHead = await getLatestReviewLoopEpochForPr(db, {
      sessionId: base.sessionId,
      prUrl: base.prUrl,
    });
    expect(latestForHead?.id).toBe(humanWave.id);

    const laterBot = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "review:bot-later",
      botKey: "custom:review-pal",
      botActorLogin: "review-pal[bot]",
      terminal: true,
      evidence: { type: "issue_comment_final", sourceId: "review:bot-later" },
      nowMs: 17_300,
    });

    expect(laterBot.id).toBe(botEpoch.id);
    expect(laterBot.id).not.toBe(humanWave.id);
    expect(laterBot.handledSourceIds).toContain("review:bot-later");
    const storedHumanWave = await getReviewLoopEpochById(db, humanWave.id);
    expect(storedHumanWave?.handledSourceIds).toEqual(["human:late"]);
    expect(storedHumanWave?.triggeringSourceIds).toEqual(["human:late"]);
    expect(storedHumanWave?.sourceKind).toBe("human");
  });

  it("backfills prompted ids for pre-existing blocked-and-prompted rows when migration 0126 applies", () => {
    // Build the epochs table at its pre-0126 shape, insert historical rows, THEN apply 0126.
    const legacy = new Database(":memory:");
    legacy.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    legacy.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
    legacy.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
    legacy.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
    legacy.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));

    const insert = (id: string, status: string, lastPromptId: string | null, triggering: string[]) =>
      legacy
        .prepare(
          `INSERT INTO pr_review_response_epochs
             (id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
              expected_bots_hash, expected_bots_json, expected_bot_keys_json,
              handled_source_ids_json, triggering_source_ids_json,
              first_activity_at, fallback_after_at, status, last_prompt_id, created_at, updated_at)
           VALUES (?, 's', 1, 'acme', 'repo', 1, 'pr', ?, 1, 'eh', '[]', '[]', ?, ?, 0, 0, ?, ?, 0, 0)`,
        )
        .run(id, id, JSON.stringify(triggering), JSON.stringify(triggering), status, lastPromptId);

    insert("blocked-prompted", "blocked", "p-1", ["review-comment:addressed"]);
    insert("blocked-unprompted", "blocked", null, ["review-comment:stranded"]);
    insert("completed", "completed", "p-2", ["review-comment:done"]);

    legacy.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));

    const promptedOf = (id: string) =>
      (
        legacy.prepare("SELECT prompted_source_ids_json AS j FROM pr_review_response_epochs WHERE id = ?").get(id) as {
          j: string;
        }
      ).j;

    // Blocked + previously prompted → backfilled to its triggering set (stays "known").
    expect(JSON.parse(promptedOf("blocked-prompted"))).toEqual(["review-comment:addressed"]);
    // Blocked + never prompted → left empty so it carries forward.
    expect(JSON.parse(promptedOf("blocked-unprompted"))).toEqual([]);
    // Non-blocked rows are untouched by the backfill (their triggering already counts as known).
    expect(JSON.parse(promptedOf("completed"))).toEqual([]);
    legacy.close();
  });

  it("treats a blocked epoch's unprompted ids as carry-forward, but keeps prompted and live ids known", async () => {
    const prUrl = "https://github.com/acme/repo/pull/77";
    const seed = (sessionId: string, headSha: string, sourceId: string, nowMs: number) =>
      upsertReviewLoopEpochActivity(db, {
        sessionId,
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 77,
        prUrl,
        headSha,
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "hash-cf",
        sourceId,
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal: true,
        evidence: { type: "review_submission", sourceId },
        nowMs,
      });

    // Epoch on head-old: prompts one comment, then a late bot signal folds into triggering (bots
    // still fold after dispatch so terminal accumulation completes), then a head change blocks it
    // before that late signal is ever prompted.
    const blocked = await seed("s-cf", "head-old", "review-comment:prompted", 1_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, blocked.id, { leaseOwner: "w", nowMs: 1_050 });
    await markReviewLoopEpochEnqueued(db, blocked.id, {
      promptId: "p-cf",
      worklistHash: "wh",
      nowMs: 1_100,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:prompted"],
    });
    // Late bot signal folds into the still-live (enqueued) epoch's triggering — never prompted.
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-cf",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl,
      headSha: "head-old",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-cf",
      sourceId: "review-comment:late",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: false,
      evidence: { type: "review_comment_activity", sourceId: "review-comment:late" },
      nowMs: 1_150,
    });
    await markReviewLoopEpochBlocked(db, blocked.id, {
      nowMs: 1_200,
      reason: "head_changed",
      expectedPromptId: "p-cf",
    });
    expect((await getReviewLoopEpochById(db, blocked.id))?.status).toBe("blocked");

    // A separate, still-live epoch on the new head.
    await seed("s-cf", "head-new", "review-comment:live", 2_000);

    const known = await listKnownReviewLoopSourceIds(db, { sessionId: "s-cf", prUrl });
    // Prompted id on the blocked epoch is done.
    expect(known.has("review-comment:prompted")).toBe(true);
    // Triggering id folded into the blocked epoch but never prompted carries forward (NOT known).
    expect(known.has("review-comment:late")).toBe(false);
    // The live epoch's triggering id stays known so a clean re-review does not re-trigger.
    expect(known.has("review-comment:live")).toBe(true);
  });

  it("listLiveEpochCoveredSourceIds: a TERMINAL epoch's prompted ids are NOT covered (re-dispatchable); only a live epoch covers (ARC-1445)", async () => {
    const prUrl = "https://github.com/acme/repo/pull/78";
    const upsert = (headSha: string, sourceId: string, terminal: boolean, nowMs: number) =>
      upsertReviewLoopEpochActivity(db, {
        sessionId: "s-lc",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 78,
        prUrl,
        headSha,
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "hash-lc",
        sourceId,
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal,
        evidence: terminal ? { type: "review_submission", sourceId } : { type: "review_comment_activity", sourceId },
        nowMs,
      });

    // A blocked (terminal) epoch on head-old that PROMPTED one comment, folded a late (never-prompted)
    // signal into its triggering set, then was blocked (head_changed) with the prompt undispositioned.
    const blocked = await upsert("head-old", "review-comment:prompted", true, 1_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, blocked.id, { leaseOwner: "w", nowMs: 1_050 });
    await markReviewLoopEpochEnqueued(db, blocked.id, {
      promptId: "p-lc",
      worklistHash: "wh",
      nowMs: 1_100,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:prompted"],
    });
    await upsert("head-old", "review-comment:late", false, 1_150);
    await markReviewLoopEpochBlocked(db, blocked.id, {
      nowMs: 1_200,
      reason: "head_changed",
      expectedPromptId: "p-lc",
    });
    expect((await getReviewLoopEpochById(db, blocked.id))?.status).toBe("blocked");

    // A separate, still-live (collecting) epoch on the new head.
    const live = await upsert("head-new", "review-comment:live", false, 2_000);
    expect((await getReviewLoopEpochById(db, live.id))?.status).not.toBe("blocked");
    expect((await getReviewLoopEpochById(db, live.id))?.status).not.toBe("completed");

    const covered = await listLiveEpochCoveredSourceIds(db, { sessionId: "s-lc", prUrl });
    // The blocked/terminal epoch's PROMPTED id must NOT count as covered — it needs re-dispatch (the wedge fix).
    expect(covered.has("review-comment:prompted")).toBe(false);
    // Its triggering-only id is likewise not covered.
    expect(covered.has("review-comment:late")).toBe(false);
    // Only the LIVE epoch's triggering id counts as covered.
    expect(covered.has("review-comment:live")).toBe(true);
  });

  // Seed a bot epoch, claim it, enqueue with a duplicate-group member recorded as prompted but never
  // ingested (so it lands in promptedSourceIds and NOT handledSourceIds/triggeringSourceIds), and
  // drive it to a terminal status. Returns the epoch id so a late upsert can target the prompted id.
  const seedPromptedNotHandledTerminal = async (
    sessionId: string,
    prNumber: number,
    prUrl: string,
    seedSourceId: string,
    promptedNotHandledId: string,
    terminal: "completed" | "blocked",
    baseNowMs: number,
  ) => {
    const epoch = await upsertReviewLoopEpochActivity(db, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber,
      prUrl,
      headSha: "head-pnh",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-pnh",
      sourceId: seedSourceId,
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: seedSourceId },
      nowMs: baseNowMs,
    });
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w", nowMs: baseNowMs + 10 });
    // The prompted-not-handled id rides along as a duplicate-group member of the worklist item.
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: `p-${epoch.id}`,
      worklistHash: "wh",
      nowMs: baseNowMs + 20,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: [seedSourceId, promptedNotHandledId],
    });
    insertSucceededReplyOperation(epoch.id, `p-${epoch.id}`, seedSourceId, baseNowMs + 25);
    insertSucceededReplyOperation(epoch.id, `p-${epoch.id}`, promptedNotHandledId, baseNowMs + 26);
    if (terminal === "completed") {
      // From "enqueued" the completed guard matches on last_prompt_id, not the reservation token.
      await markReviewLoopEpochCompleted(db, epoch.id, {
        nowMs: baseNowMs + 30,
        expectedPromptId: `p-${epoch.id}`,
        worklistHash: "wh",
      });
    } else {
      await markReviewLoopEpochBlocked(db, epoch.id, {
        nowMs: baseNowMs + 30,
        reason: "head_changed",
        expectedPromptId: `p-${epoch.id}`,
      });
    }
    const terminalEpoch = (await getReviewLoopEpochById(db, epoch.id))!;
    expect(terminalEpoch.status).toBe(terminal);
    // Discrimination precondition: the late id is prompted-only — absent under the old handled-only
    // check, so a passing "no new wave" assertion can only come from the promptedSourceIds branch.
    expect(terminalEpoch.promptedSourceIds).toContain(promptedNotHandledId);
    expect(terminalEpoch.handledSourceIds).not.toContain(promptedNotHandledId);
    expect(terminalEpoch.triggeringSourceIds).not.toContain(promptedNotHandledId);
    return epoch;
  };

  it("folds a late webhook for a prompted-not-handled source into a completed epoch instead of a new wave", async () => {
    const prUrl = "https://github.com/acme/repo/pull/135";
    const epoch = await seedPromptedNotHandledTerminal(
      "s-arc1135-completed",
      135,
      prUrl,
      "review:seed-completed",
      "review:dup-completed",
      "completed",
      10_000,
    );

    const late = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-arc1135-completed",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 135,
      prUrl,
      headSha: "head-pnh",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-pnh",
      sourceId: "review:dup-completed",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:dup-completed" },
      nowMs: 11_000,
    });

    // Folds into the terminal epoch (same id/wave) and does NOT resurrect it past "completed".
    expect(late.id).toBe(epoch.id);
    expect(late.wave).toBe(epoch.wave);
    expect(late.status).toBe("completed");
  });

  it("still opens a new wave for a genuinely-unseen source after the prior wave completed", async () => {
    const prUrl = "https://github.com/acme/repo/pull/136";
    const epoch = await seedPromptedNotHandledTerminal(
      "s-arc1135-completed-unseen",
      136,
      prUrl,
      "review:seed-unseen",
      "review:dup-unseen",
      "completed",
      12_000,
    );

    // A source in neither handledSourceIds nor promptedSourceIds is genuinely new → new wave.
    const fresh = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-arc1135-completed-unseen",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 136,
      prUrl,
      headSha: "head-pnh",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-pnh",
      sourceId: "review:genuinely-new",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:genuinely-new" },
      nowMs: 13_000,
    });

    expect(fresh.id).not.toBe(epoch.id);
    expect(fresh.wave).toBe(epoch.wave + 1);
    expect(fresh.status).toBe("ready");
  });

  it("folds a late webhook for a prompted-not-handled source into a blocked epoch instead of a new wave", async () => {
    const prUrl = "https://github.com/acme/repo/pull/137";
    const epoch = await seedPromptedNotHandledTerminal(
      "s-arc1135-blocked",
      137,
      prUrl,
      "review:seed-blocked",
      "review:dup-blocked",
      "blocked",
      14_000,
    );

    const late = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-arc1135-blocked",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 137,
      prUrl,
      headSha: "head-pnh",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-pnh",
      sourceId: "review:dup-blocked",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:dup-blocked" },
      nowMs: 15_000,
    });

    // Folds into the blocked epoch (same id/wave) and stays blocked — not resurrected.
    expect(late.id).toBe(epoch.id);
    expect(late.wave).toBe(epoch.wave);
    expect(late.status).toBe("blocked");
  });

  it("folds a late human review for a prompted-not-handled source into an enqueued epoch instead of a new wave", async () => {
    const base = {
      sessionId: "s-arc1135-human-frozen",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 138,
      prUrl: "https://github.com/acme/repo/pull/138",
      headSha: "head-human-pnh",
      expectedBots: [] as PrReviewExpectedBot[],
      expectedBotsHash: "empty-hash",
      botKey: "human",
      botActorLogin: "octocat",
      terminal: false,
      humanSource: { userId: 101, login: "octocat" },
    };
    const first = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:seed",
      evidence: { type: "review_submission", sourceId: "human:seed" },
      nowMs: 16_000,
    });
    expect(first.status).toBe("ready");

    const claimed = await claimReviewLoopEpochForPrompt(db, first.id, { leaseOwner: "w", nowMs: 16_100 });
    // The late human id is recorded as prompted (duplicate-group member) without ever being handled.
    await markReviewLoopEpochEnqueued(db, first.id, {
      promptId: "p-human-frozen",
      worklistHash: "wh",
      nowMs: 16_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["human:seed", "human:dup"],
    });
    const frozen = (await getReviewLoopEpochById(db, first.id))!;
    expect(frozen.status).toBe("enqueued");
    // Discrimination precondition for the line-851 path.
    expect(frozen.promptedSourceIds).toContain("human:dup");
    expect(frozen.handledSourceIds).not.toContain("human:dup");
    expect(frozen.triggeringSourceIds).not.toContain("human:dup");

    // A late human webhook for the prompted-not-handled id arrives while the worklist is frozen.
    const late = await upsertReviewLoopEpochActivity(db, {
      ...base,
      sourceId: "human:dup",
      evidence: { type: "review_submission", sourceId: "human:dup" },
      nowMs: 16_300,
    });

    // It folds into the frozen epoch (same id/wave) rather than spawning its own wave.
    expect(late.id).toBe(first.id);
    expect(late.wave).toBe(first.wave);
  });

  it("lists prompted source ids across a session's PR epochs, excluding the dispatched epoch", async () => {
    const prUrl = "https://github.com/acme/repo/pull/55";
    const seedPrompted = async (
      sessionId: string,
      prNumber: number,
      url: string,
      headSha: string,
      sourceId: string,
      promptedSourceIds: string[],
      nowMs: number,
    ) => {
      const epoch = await upsertReviewLoopEpochActivity(db, {
        sessionId,
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber,
        prUrl: url,
        headSha,
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "hash-pd",
        sourceId,
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal: true,
        evidence: { type: "review_submission", sourceId },
        nowMs,
      });
      const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w", nowMs: nowMs + 10 });
      await markReviewLoopEpochEnqueued(db, epoch.id, {
        promptId: `p-${epoch.id}`,
        worklistHash: "wh",
        nowMs: nowMs + 20,
        expectedReservationToken: claimed?.reservationToken ?? null,
        promptedSourceIds,
      });
      return epoch;
    };

    // Two epochs on the same session+PR (different heads); a third on another PR; a fourth on another
    // session sharing the PR URL.
    await seedPrompted("s-pd", 55, prUrl, "head-a", "review:a", ["review-comment:1", "issue-comment:2"], 1_000);
    const dispatched = await seedPrompted("s-pd", 55, prUrl, "head-b", "review:b", ["review-body:3"], 2_000);
    await seedPrompted(
      "s-pd",
      99,
      "https://github.com/acme/repo/pull/99",
      "head-c",
      "review:c",
      ["review-comment:other-pr"],
      3_000,
    );
    await seedPrompted("s-pd-other", 55, prUrl, "head-d", "review:d", ["review-comment:other-session"], 4_000);

    const promptedSources = await listPromptedReviewLoopSources(db, {
      sessionId: "s-pd",
      prUrl,
      excludeEpochId: dispatched.id,
    });
    const knownSources = await listKnownReviewLoopSources(db, { sessionId: "s-pd", prUrl });

    // Prompted by a DIFFERENT epoch on this session+PR → included (will be deduped at dispatch).
    expect(promptedSources.promptedAtBySourceId.get("review-comment:1")).toBe(1_020);
    expect(promptedSources.promptedAtBySourceId.get("issue-comment:2")).toBe(1_020);
    expect(knownSources.promptedAtBySourceId.get("review-comment:1")).toBe(1_020);
    expect(knownSources.promptedAtBySourceId.get("review-body:3")).toBe(2_020);
    expect(knownSources.triggeringSourceIds.has("review:a")).toBe(true);
    // The excluded epoch's own prompted ids → NOT included (a redriven epoch re-prompts its worklist).
    expect(promptedSources.promptedAtBySourceId.has("review-body:3")).toBe(false);
    expect(promptedSources.legacySourceIds.size).toBe(0);
  });

  it("accumulates prompted source metadata with latest-record body hashes and legacy fallback", () => {
    const accumulated = accumulatePromptedSources([
      {
        prompted_source_ids_json: JSON.stringify([
          { sourceId: "review-body:1", promptedAtMs: 100, bodyHash: "old-hash" },
          { sourceId: "review-comment:2", promptedAtMs: 200 },
          "legacy:1",
        ]),
      },
      {
        prompted_source_ids_json: JSON.stringify([
          { sourceId: "review-body:1", promptedAtMs: 300 },
          { sourceId: "review-comment:2", promptedAtMs: 150, bodyHash: "stale-hash" },
          { sourceId: "review-body:3", promptedAtMs: 250, bodyHash: "body-3" },
          "review-body:3",
        ]),
      },
    ]);

    expect(accumulated.promptedAtBySourceId.get("review-body:1")).toBe(300);
    expect(accumulated.bodyHashBySourceId.has("review-body:1")).toBe(false);
    expect(accumulated.promptedAtBySourceId.get("review-comment:2")).toBe(200);
    expect(accumulated.bodyHashBySourceId.has("review-comment:2")).toBe(false);
    expect(accumulated.bodyHashBySourceId.get("review-body:3")).toBe("body-3");
    expect(accumulated.legacySourceIds.has("legacy:1")).toBe(true);
    expect(accumulated.legacySourceIds.has("review-body:3")).toBe(false);
  });

  it("tracks prompt processing and publishing transitions with prompt CAS", async () => {
    const epoch = await createReadyEpoch("s-processing-publishing", 12_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 12_100 });
    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-review-loop",
      worklistHash: "worklist-hash",
      nowMs: 12_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    expect(enqueued?.status).toBe("enqueued");

    const staleProcessing = await markReviewLoopEpochProcessing(db, epoch.id, {
      promptId: "p-stale",
      nowMs: 12_250,
    });
    expect(staleProcessing).toBeNull();

    const processing = await markReviewLoopEpochProcessing(db, epoch.id, {
      promptId: "p-review-loop",
      nowMs: 12_300,
    });
    expect(processing?.status).toBe("processing");
    expect(processing?.lastPromptId).toBe("p-review-loop");

    const stalePublishing = await markReviewLoopEpochPublishing(db, epoch.id, {
      promptId: "p-stale",
      nowMs: 12_350,
    });
    expect(stalePublishing).toBeNull();

    const publishing = await markReviewLoopEpochPublishing(db, epoch.id, {
      promptId: "p-review-loop",
      nowMs: 12_400,
    });
    expect(publishing?.status).toBe("publishing");

    const stored = await getReviewLoopEpochById(db, epoch.id);
    expect(stored?.status).toBe("publishing");
    expect(stored?.lastPromptId).toBe("p-review-loop");
  });

  it("reclaims expired reserving leases", async () => {
    const epoch = await createReadyEpoch("s-expired", 10_000);

    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 10_100 });
    expect(claimed?.status).toBe("reserving");
    expect(claimed?.leaseOwner).toBe("worker-a");
    expect(claimed?.leaseExpiresAt).toBe(310_100);

    const beforeExpiry = await listDueReviewLoopEpochs(db, { nowMs: 310_099, limit: 10 });
    expect(beforeExpiry.map((row) => row.id)).toEqual([]);

    const due = await listDueReviewLoopEpochs(db, { nowMs: 310_100, limit: 10 });
    expect(due.map((row) => row.id)).toEqual([epoch.id]);

    const reclaimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 310_100 });
    expect(reclaimed?.status).toBe("reserving");
    expect(reclaimed?.leaseOwner).toBe("worker-b");
    expect(reclaimed?.attemptCount).toBe(2);
  });

  it("resumes waiting-for-owner epochs after a concrete owner approval answer", async () => {
    const epoch = await createReadyEpoch("s-owner-approval", 65_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 65_100 });
    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-review-loop",
      worklistHash: "worklist-hash",
      nowMs: 65_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-review-loop", nowMs: 65_300 });
    const waiting = await markReviewLoopEpochWaitingForOwner(db, epoch.id, {
      nowMs: 65_400,
      reason: "needs_owner",
      expectedPromptId: enqueued?.lastPromptId ?? null,
    });
    expect(waiting?.status).toBe("waiting_for_owner");

    const stale = await markReviewLoopEpochOwnerApprovalResolved(db, epoch.id, {
      promptId: "p-stale",
      nowMs: 65_500,
    });
    expect(stale).toBeNull();

    const resumed = await markReviewLoopEpochOwnerApprovalResolved(db, epoch.id, {
      promptId: "p-review-loop",
      nowMs: 65_600,
    });
    expect(resumed?.status).toBe("processing");
    expect(resumed?.blockedReason).toBeNull();
    expect(resumed?.lastPromptId).toBe("p-review-loop");
  });

  it("tracks contention deferrals separately from real attempts", async () => {
    const epoch = await createReadyEpoch("s-contention", 50_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 50_100 });
    expect(claimed?.status).toBe("reserving");
    expect(claimed?.attemptCount).toBe(1);

    const deferred = await markReviewLoopEpochContentionDeferred(db, epoch.id, {
      nowMs: 50_200,
      reason: "active_prompt",
      error: "Session already has an active prompt",
      expectedReservationToken: claimed?.reservationToken ?? null,
    });

    expect(deferred?.status).toBe("ready");
    expect(deferred?.contentionDeferralCount).toBe(1);
    expect(deferred?.attemptCount).toBe(0);
    expect(deferred?.lastError).toBe("Session already has an active prompt");
  });

  it("tracks transient GitHub poll failures separately and blocks only at the cap", async () => {
    const epoch = await createReadyEpoch("s-transient", 60_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 60_100 });
    const retryable = await markReviewLoopEpochTransientFailure(db, epoch.id, {
      nowMs: 60_200,
      reason: "github_poll_failed",
      error: "GitHub PR review-thread fetch failed (502)",
      expectedReservationToken: claimed?.reservationToken ?? null,
      transientFailureLimit: 5,
    });

    expect(retryable?.status).toBe("ready");
    expect(retryable?.transientFailureCount).toBe(1);
    expect(retryable?.attemptCount).toBe(0);

    sqlite
      .prepare(
        "UPDATE pr_review_response_epochs SET status = 'reserving', reservation_token = 'tok-cap', attempt_count = 1, transient_failure_count = 4 WHERE id = ?",
      )
      .run(epoch.id);

    const blocked = await markReviewLoopEpochTransientFailure(db, epoch.id, {
      nowMs: 60_300,
      reason: "github_poll_failed",
      error: "GitHub PR review-thread fetch failed (502)",
      expectedReservationToken: "tok-cap",
      transientFailureLimit: 5,
    });

    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("github_poll_failed");
    expect(blocked?.transientFailureCount).toBe(5);
    expect(blocked?.attemptCount).toBe(0);
  });

  it("increments transient_failure_count in SQL so a concurrent failure is not clobbered (PR-3)", async () => {
    const epoch = await createReadyEpoch("s-transient-race", 70_000);
    await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 70_100 });
    const claimToken = (await getReviewLoopEpochById(db, epoch.id))?.reservationToken ?? null;

    // Between our read and write, a concurrent transient-failure bumps the counter. A JS
    // read-modify-write would clobber it back to 1; the in-SQL `col + 1` must yield 2.
    let injected = false;
    const raceDb = new SqliteD1(sqlite, (query: string) => {
      if (injected || !query.includes("transient_failure_count = transient_failure_count + 1")) return;
      injected = true;
      sqlite
        .prepare(
          "UPDATE pr_review_response_epochs SET transient_failure_count = transient_failure_count + 1 WHERE id = ?",
        )
        .run(epoch.id);
    }) as unknown as D1Database;

    const result = await markReviewLoopEpochTransientFailure(raceDb, epoch.id, {
      nowMs: 70_200,
      reason: "github_poll_failed",
      error: "GitHub PR review-thread fetch failed (502)",
      expectedReservationToken: claimToken,
      transientFailureLimit: 10,
    });

    expect(injected).toBe(true);
    expect(result?.transientFailureCount).toBe(2);
    expect(result?.status).toBe("ready");
  });

  it("clears a stale blocked_reason on a below-cap transient retry (PR-3)", async () => {
    const epoch = await createReadyEpoch("s-transient-clear", 80_000);
    await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 80_100 });
    const claimToken = (await getReviewLoopEpochById(db, epoch.id))?.reservationToken ?? null;
    // Seed a stale blocked_reason that a below-cap retry must NULL out.
    sqlite.prepare("UPDATE pr_review_response_epochs SET blocked_reason = 'stale_reason' WHERE id = ?").run(epoch.id);

    const result = await markReviewLoopEpochTransientFailure(db, epoch.id, {
      nowMs: 80_200,
      reason: "github_poll_failed",
      error: "GitHub PR review-thread fetch failed (502)",
      expectedReservationToken: claimToken,
      transientFailureLimit: 5,
    });

    expect(result?.status).toBe("ready");
    expect(result?.blockedReason).toBeNull();
    expect(result?.transientFailureCount).toBe(1);
    // last_error stays set even below the cap.
    expect(result?.lastError).toBe("GitHub PR review-thread fetch failed (502)");
  });

  it("does not let stale noop completion kill a re-readied claim", async () => {
    const epoch = await createReadyEpoch("s-stale-noop-complete", 25_000);
    const firstClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 25_100 });
    expect(firstClaim?.status).toBe("reserving");

    requeueEpoch(epoch.id);

    const secondClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 25_300 });
    expect(secondClaim?.status).toBe("reserving");

    const staleComplete = await markReviewLoopEpochCompleted(db, epoch.id, {
      nowMs: 25_400,
      worklistHash: "stale-worklist-hash",
    });
    expect(staleComplete).toBeNull();

    const storedAfterStale = await getReviewLoopEpochById(db, epoch.id);
    expect(storedAfterStale?.status).toBe("reserving");
    expect(storedAfterStale?.leaseOwner).toBe("worker-b");
    expect(storedAfterStale?.worklistHash).toBeNull();

    const completed = await markReviewLoopEpochCompleted(db, epoch.id, {
      nowMs: 25_500,
      worklistHash: "current-worklist-hash",
      expectedReservationToken: secondClaim?.reservationToken ?? null,
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.worklistHash).toBe("current-worklist-hash");
  });

  it("does not let stale prompt completion kill a re-readied claim", async () => {
    const epoch = await createReadyEpoch("s-stale-prompt-complete", 26_000);
    const firstClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 26_100 });
    expect(firstClaim?.status).toBe("reserving");

    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-old",
      worklistHash: "worklist-hash",
      nowMs: 26_200,
      expectedReservationToken: firstClaim?.reservationToken ?? null,
    });
    expect(enqueued?.status).toBe("enqueued");

    requeueEpoch(epoch.id);

    const secondClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 26_400 });
    expect(secondClaim?.status).toBe("reserving");

    const staleComplete = await markReviewLoopEpochCompleted(db, epoch.id, {
      nowMs: 26_500,
      expectedPromptId: "p-old",
    });
    expect(staleComplete).toBeNull();

    const stored = await getReviewLoopEpochById(db, epoch.id);
    expect(stored?.status).toBe("reserving");
    expect(stored?.leaseOwner).toBe("worker-b");
    expect(stored?.worklistHash).toBe("worklist-hash");
  });

  it("does not let stale enqueue updates kill a re-readied claim", async () => {
    const epoch = await createReadyEpoch("s-stale-enqueue-retry", 27_000);
    const firstClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 27_100 });
    expect(firstClaim?.status).toBe("reserving");

    requeueEpoch(epoch.id);

    const secondClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 27_300 });
    expect(secondClaim?.status).toBe("reserving");

    const staleEnqueue = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-old",
      worklistHash: "old-worklist-hash",
      nowMs: 27_400,
      expectedReservationToken: firstClaim?.reservationToken ?? null,
    });
    expect(staleEnqueue).toBeNull();

    const storedAfterStale = await getReviewLoopEpochById(db, epoch.id);
    expect(storedAfterStale?.status).toBe("reserving");
    expect(storedAfterStale?.leaseOwner).toBe("worker-b");
    expect(storedAfterStale?.lastPromptId).toBeNull();
    expect(storedAfterStale?.worklistHash).toBeNull();

    const currentEnqueue = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-new",
      worklistHash: "new-worklist-hash",
      nowMs: 27_500,
      expectedReservationToken: secondClaim?.reservationToken ?? null,
    });
    expect(currentEnqueue?.status).toBe("enqueued");
    expect(currentEnqueue?.lastPromptId).toBe("p-new");
    expect(currentEnqueue?.worklistHash).toBe("new-worklist-hash");
  });

  it("does not block epochs after they complete", async () => {
    const epoch = await createReadyEpoch("s-stale-block-complete", 30_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 30_100 });
    expect(claimed?.status).toBe("reserving");

    forceCompleteEpoch(epoch.id);
    expect((await getReviewLoopEpochById(db, epoch.id))?.status).toBe("completed");

    const staleBlock = await markReviewLoopEpochBlocked(db, epoch.id, {
      nowMs: 30_300,
      reason: "sweep_error",
      error: "late failure",
      expectedReservationToken: claimed?.reservationToken,
    });
    expect(staleBlock).toBeNull();

    const stored = await getReviewLoopEpochById(db, epoch.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.blockedReason).toBeNull();
    expect(stored?.lastError).toBeNull();
  });

  it("does not let stale prompt block or owner-wait updates kill a newer prompt", async () => {
    const epoch = await createReadyEpoch("s-stale-prompt-block", 35_000);
    const firstClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 35_100 });
    expect(firstClaim?.status).toBe("reserving");

    const firstEnqueue = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-old",
      worklistHash: "old-worklist-hash",
      nowMs: 35_200,
      expectedReservationToken: firstClaim?.reservationToken ?? null,
    });
    expect(firstEnqueue?.status).toBe("enqueued");

    requeueEpoch(epoch.id);

    const secondClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 35_400 });
    expect(secondClaim?.status).toBe("reserving");

    const secondEnqueue = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-new",
      worklistHash: "new-worklist-hash",
      nowMs: 35_500,
      expectedReservationToken: secondClaim?.reservationToken ?? null,
    });
    expect(secondEnqueue?.status).toBe("enqueued");

    const staleBlock = await markReviewLoopEpochBlocked(db, epoch.id, {
      nowMs: 35_600,
      reason: "old_prompt_failed",
      expectedPromptId: "p-old",
    });
    expect(staleBlock).toBeNull();

    const staleWait = await markReviewLoopEpochWaitingForOwner(db, epoch.id, {
      nowMs: 35_700,
      reason: "old_prompt_sensitive_paths",
      expectedPromptId: "p-old",
    });
    expect(staleWait).toBeNull();

    const storedAfterStale = await getReviewLoopEpochById(db, epoch.id);
    expect(storedAfterStale?.status).toBe("enqueued");
    expect(storedAfterStale?.lastPromptId).toBe("p-new");
    expect(storedAfterStale?.blockedReason).toBeNull();

    const currentBlock = await markReviewLoopEpochBlocked(db, epoch.id, {
      nowMs: 35_800,
      reason: "new_prompt_failed",
      expectedPromptId: "p-new",
    });
    expect(currentBlock?.status).toBe("blocked");
    expect(currentBlock?.blockedReason).toBe("new_prompt_failed");
  });

  it("blocks an unrecoverable prompt once and excludes the epoch from stuck reclaim", async () => {
    const epoch = await createReadyEpoch("s-runtime-unrecoverable", 36_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 36_100 });
    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-unrecoverable",
      worklistHash: "runtime-unrecoverable-worklist",
      nowMs: 36_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    expect(enqueued?.attemptCount).toBe(1);

    const blocked = await markReviewLoopEpochBlocked(db, epoch.id, {
      nowMs: 36_300,
      reason: "runtime_unrecoverable",
      expectedPromptId: "p-unrecoverable",
    });
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("runtime_unrecoverable");
    expect(blocked?.attemptCount).toBe(1);

    const duplicate = await markReviewLoopEpochBlocked(db, epoch.id, {
      nowMs: 36_400,
      reason: "runtime_unrecoverable",
      expectedPromptId: "p-unrecoverable",
    });
    expect(duplicate).toBeNull();
    expect(await listStuckReviewLoopEpochs(db, { nowMs: 36_200 + 60 * 60 * 1000, limit: 10 })).toEqual([]);
    expect((await getReviewLoopEpochById(db, epoch.id))?.attemptCount).toBe(1);
  });

  it("source_kind round-trip: defaults to 'bot', round-trips 'human'", async () => {
    const botEpoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-sk-bot",
      ownerUserId: 201,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 99,
      prUrl: "https://github.com/acme/repo/pull/99",
      headSha: "sk-sha-bot",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-sk-bot",
      sourceId: "review:sk-bot",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:sk-bot" },
      nowMs: 1_000,
    });
    expect(botEpoch.sourceKind as ReviewLoopSourceKind).toBe("bot");

    const humanEpoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-sk-human",
      ownerUserId: 202,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 100,
      prUrl: "https://github.com/acme/repo/pull/100",
      headSha: "sk-sha-human",
      expectedBots: [],
      expectedBotsHash: "hash-empty-bots",
      sourceId: "human:2001",
      botKey: "human",
      botActorLogin: null,
      terminal: false,
      evidence: null,
      nowMs: 2_000,
      sourceKind: "human",
    });
    const fetched = await getReviewLoopEpochById(db, humanEpoch.id);
    expect(fetched?.sourceKind).toBe("human");
  });

  it("bot → mixed transition on human fold-in, and mixed does not regress to bot", async () => {
    // Step 1: bot activity creates epoch with sourceKind 'bot'
    const botEpoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-mixed-1",
      ownerUserId: 301,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 201,
      prUrl: "https://github.com/acme/repo/pull/201",
      headSha: "mixed-sha",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-mixed-1",
      sourceId: "review:bot-301",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:bot-301" },
      nowMs: 10_000,
    });
    expect(botEpoch.sourceKind).toBe("bot");

    // Step 2: human fold-in flips to mixed, appends triggeringSourceIds, does NOT touch observedTerminalBotCount
    const mixedEpoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-mixed-1",
      ownerUserId: 301,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 201,
      prUrl: "https://github.com/acme/repo/pull/201",
      headSha: "mixed-sha",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-mixed-1",
      sourceId: "human:1001",
      botKey: "human",
      botActorLogin: null,
      terminal: false,
      evidence: null,
      nowMs: 10_100,
      humanSource: { userId: 1001, login: "alice" },
    });
    expect(mixedEpoch.id).toBe(botEpoch.id);
    expect(mixedEpoch.sourceKind).toBe("mixed");
    expect(mixedEpoch.triggeringSourceIds).toContain("human:1001");
    // bot terminal count must not change due to human fold-in
    expect(mixedEpoch.observedTerminalBotCount).toBe(botEpoch.observedTerminalBotCount);

    // Step 3: a second bot signal on mixed epoch does NOT regress to 'bot'
    const stillMixed = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-mixed-1",
      ownerUserId: 301,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 201,
      prUrl: "https://github.com/acme/repo/pull/201",
      headSha: "mixed-sha",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-mixed-1",
      sourceId: "review:bot-302",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: false,
      evidence: { type: "review_comment_activity", sourceId: "review:bot-302" },
      nowMs: 10_200,
    });
    expect(stillMixed.id).toBe(botEpoch.id);
    expect(stillMixed.sourceKind).toBe("mixed");
  });

  it("human-source epoch with empty expected_bots is ready immediately (no 10-min wait)", async () => {
    const nowMs = 50_000;
    const epoch = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-human-ready",
      ownerUserId: 401,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 301,
      prUrl: "https://github.com/acme/repo/pull/301",
      headSha: "human-ready-sha",
      expectedBots: [],
      expectedBotsHash: "hash-empty",
      sourceId: "human:3001",
      botKey: "human",
      botActorLogin: null,
      terminal: false,
      evidence: null,
      nowMs,
      humanSource: { userId: 3001, login: "bob" },
    });
    expect(epoch.status).toBe("ready");
    expect(epoch.sourceKind).toBe("human");
    expect(epoch.firstActivityAt).toBe(nowMs);
    expect(epoch.fallbackAfterAt).toBe(nowMs);
    expect(epoch.expectedBots).toEqual([]);
  });

  it("inserts a bot epoch as ready with fallback_after_at == nowMs (walltime removal)", async () => {
    // A non-terminal bot signal used to land in `collecting` with fallback_after_at = nowMs + window.
    // Walltime removal makes every epoch immediately due: status `ready`, fallback_after_at = nowMs.
    const nowMs = 1_000_000;
    const epoch = await upsertReviewLoopEpochActivity(
      db,
      baseActivityInput({
        sessionId: "s-due-immediately",
        headSha: "due-immediately-sha",
        sourceKind: "bot",
        terminal: false,
        nowMs,
      }),
    );
    expect(epoch.status).toBe("ready");
    expect(epoch.fallbackAfterAt).toBe(nowMs);
  });

  it("bootstrapReviewLoopEpochForHuman is idempotent per review and splits a distinct review into its own wave", async () => {
    const nowMs = 70_000;
    const args = {
      sessionId: "s-bootstrap-human",
      ownerUserId: 501,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 401,
      prUrl: "https://github.com/acme/repo/pull/401",
      headSha: "bootstrap-sha",
      triggeringSourceId: "human:3003",
      nowMs,
    };

    const first = await bootstrapReviewLoopEpochForHuman(db, args);
    expect(first.sourceKind).toBe("human");
    expect(first.status).toBe("ready");
    expect(first.wave).toBe(1);
    expect(first.triggeringSourceIds).toEqual(["human:3003"]);

    // second call same triggeringSourceId → idempotent, same epoch id (folds into its own wave)
    const second = await bootstrapReviewLoopEpochForHuman(db, args);
    expect(second.id).toBe(first.id);
    expect(second.triggeringSourceIds).toEqual(["human:3003"]);

    // third call DIFFERENT review → its own wave, scoped to only that review (no longer folded in)
    const third = await bootstrapReviewLoopEpochForHuman(db, { ...args, triggeringSourceId: "human:3004" });
    expect(third.id).not.toBe(first.id);
    expect(third.wave).toBe(2);
    expect(third.triggeringSourceIds).toEqual(["human:3004"]);
    // The first review's wave is untouched — it did not accumulate the sibling review.
    const firstAfter = await getReviewLoopEpochById(db, first.id);
    expect(firstAfter?.triggeringSourceIds).toEqual(["human:3003"]);
    // A human-only wave stays human (mixed means bot + human).
    expect(third.sourceKind).toBe("human");
  });

  it("bootstraps a fresh human epoch after an unrecoverable runtime blocked the prior wave", async () => {
    const args = {
      sessionId: "s-bootstrap-after-runtime-block",
      ownerUserId: 502,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 402,
      prUrl: "https://github.com/acme/repo/pull/402",
      headSha: "bootstrap-blocked-sha",
      triggeringSourceId: "human:4001",
      nowMs: 80_000,
    };
    const first = await bootstrapReviewLoopEpochForHuman(db, args);
    const claimed = await claimReviewLoopEpochForPrompt(db, first.id, { leaseOwner: "worker-a", nowMs: 80_100 });
    await markReviewLoopEpochEnqueued(db, first.id, {
      promptId: "p-first",
      worklistHash: "first-worklist",
      nowMs: 80_200,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    await markReviewLoopEpochBlocked(db, first.id, {
      nowMs: 80_300,
      reason: "runtime_unrecoverable",
      expectedPromptId: "p-first",
    });

    expect(
      await selectHumanEpochCarryingSource(
        db,
        {
          ownerUserId: args.ownerUserId,
          sessionId: args.sessionId,
          prUrl: args.prUrl,
          headSha: args.headSha,
        },
        "human:4002",
      ),
    ).toBeNull();

    const next = await bootstrapReviewLoopEpochForHuman(db, {
      ...args,
      triggeringSourceId: "human:4002",
      nowMs: 80_400,
    });

    expect(next.id).not.toBe(first.id);
    expect(next.wave).toBe(2);
    expect(next.status).toBe("ready");
    expect(next.triggeringSourceIds).toEqual(["human:4002"]);
    expect((await getReviewLoopEpochById(db, first.id))?.blockedReason).toBe("runtime_unrecoverable");
  });

  it("does not let stale block or owner-wait updates kill a re-readied claim", async () => {
    const epoch = await createReadyEpoch("s-stale-block-retry", 40_000);
    const firstClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: 40_100 });
    expect(firstClaim?.status).toBe("reserving");

    requeueEpoch(epoch.id);

    const secondClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-b", nowMs: 40_300 });
    expect(secondClaim?.status).toBe("reserving");
    expect(secondClaim?.leaseOwner).toBe("worker-b");

    const staleBlock = await markReviewLoopEpochBlocked(db, epoch.id, {
      nowMs: 40_400,
      reason: "old_worker_failed",
      expectedReservationToken: firstClaim?.reservationToken,
    });
    expect(staleBlock).toBeNull();

    const staleWait = await markReviewLoopEpochWaitingForOwner(db, epoch.id, {
      nowMs: 40_500,
      reason: "old_worker_sensitive_paths",
      expectedReservationToken: firstClaim?.reservationToken,
    });
    expect(staleWait).toBeNull();

    const stored = await getReviewLoopEpochById(db, epoch.id);
    expect(stored?.status).toBe("reserving");
    expect(stored?.leaseOwner).toBe("worker-b");
    expect(stored?.blockedReason).toBeNull();
  });

  it("returns the highest-wave epoch for a PR via getLatestReviewLoopEpochForPr", async () => {
    const prUrl = "https://github.com/acme/repo/pull/77";
    const first = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-latest",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl,
      headSha: "sha-1",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:1" },
      nowMs: 1000,
    });
    const firstClaimed = await claimReviewLoopEpochForPrompt(db, first.id, { leaseOwner: "worker", nowMs: 1100 });
    await markReviewLoopEpochCompleted(db, first.id, {
      nowMs: 1500,
      worklistHash: null,
      expectedReservationToken: firstClaimed?.reservationToken ?? null,
    });

    const second = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-latest",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl,
      headSha: "sha-1",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review:2",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:2" },
      nowMs: 2000,
    });

    const latest = await getLatestReviewLoopEpochForPr(db, { sessionId: "s-latest", prUrl });
    expect(latest?.id).toBe(second.id);
    expect(latest?.wave).toBe(2);

    const none = await getLatestReviewLoopEpochForPr(db, { sessionId: "s-latest", prUrl: "https://x/pull/0" });
    expect(none).toBeNull();

    // Regression: a new commit creates a fresh wave-1 epoch at a later created_at.
    // The old ORDER BY wave DESC would return the wave-2 epoch (sha-1) instead.
    const third = await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-latest",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl,
      headSha: "sha-2",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review:3",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:3" },
      nowMs: 3000,
    });
    const newest = await getLatestReviewLoopEpochForPr(db, { sessionId: "s-latest", prUrl });
    expect(newest?.id).toBe(third.id);
    expect(newest?.headSha).toBe("sha-2");
    expect(newest?.wave).toBe(1);
  });

  // IN_FLIGHT_LEASE_MS = 30 * 60 * 1000 = 1_800_000 (see review-loop-epochs.ts).
  const IN_FLIGHT_LEASE_MS = 1_800_000;

  async function enqueueInFlightEpoch(sessionId: string, nowMs: number, promptId: string) {
    const epoch = await createReadyEpoch(sessionId, nowMs);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: nowMs + 10 });
    const enqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId,
      worklistHash: "worklist-hash",
      nowMs: nowMs + 20,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    return { epoch, claimed, enqueued };
  }

  it("stamps an in-flight reclaim lease on enqueued/processing/publishing transitions", async () => {
    const { epoch, claimed, enqueued } = await enqueueInFlightEpoch("s-inflight-lease", 100_000, "p-rl");
    expect(enqueued?.status).toBe("enqueued");
    expect(enqueued?.leaseExpiresAt).toBe(100_020 + IN_FLIGHT_LEASE_MS);
    expect(enqueued?.leaseOwner).toBe("in-flight");

    const processing = await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 100_030 });
    expect(processing?.status).toBe("processing");
    expect(processing?.leaseExpiresAt).toBe(100_030 + IN_FLIGHT_LEASE_MS);

    const publishing = await markReviewLoopEpochPublishing(db, epoch.id, { promptId: "p-rl", nowMs: 100_040 });
    expect(publishing?.leaseExpiresAt).toBe(100_040 + IN_FLIGHT_LEASE_MS);
    expect(claimed?.reservationToken).toBeTruthy();
  });

  it("reclaims an in-flight epoch whose lease expired and resets it to ready", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-reclaim", 200_000, "p-rl");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 200_030 });

    const leaseExpiresAt = 200_030 + IN_FLIGHT_LEASE_MS;
    // Not yet expired.
    expect(await listStuckReviewLoopEpochs(db, { nowMs: leaseExpiresAt - 1, limit: 10 })).toEqual([]);

    const stuck = await listStuckReviewLoopEpochs(db, { nowMs: leaseExpiresAt, limit: 10 });
    expect(stuck.map((row) => row.id)).toEqual([epoch.id]);

    const reclaimed = await reclaimStuckReviewLoopEpoch(db, epoch.id, {
      nowMs: leaseExpiresAt + 5,
      expectedLeaseExpiresAt: leaseExpiresAt,
    });
    expect(reclaimed?.status).toBe("ready");
    expect(reclaimed?.leaseOwner).toBeNull();
    expect(reclaimed?.lastPromptId).toBeNull();
    // Reset to ready makes it due again for the sweep.
    const due = await listDueReviewLoopEpochs(db, { nowMs: leaseExpiresAt + 10, limit: 10 });
    expect(due.map((row) => row.id)).toContain(epoch.id);
  });

  it("reclaim CAS no-ops when the lease was renewed by a concurrent transition", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-reclaim-cas", 300_000, "p-rl");
    const enqueuedLease = 300_020 + IN_FLIGHT_LEASE_MS;
    // A concurrent processing transition renews the lease; reclaim with the STALE expected lease loses.
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 300_030 });
    const reclaimed = await reclaimStuckReviewLoopEpoch(db, epoch.id, {
      nowMs: enqueuedLease + 5,
      expectedLeaseExpiresAt: enqueuedLease,
    });
    expect(reclaimed).toBeNull();
    expect((await getReviewLoopEpochById(db, epoch.id))?.status).toBe("processing");
  });

  it("does not reclaim a waiting_for_owner epoch (intentional human pause)", async () => {
    const { epoch, enqueued } = await enqueueInFlightEpoch("s-waiting", 400_000, "p-rl");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 400_030 });
    const waiting = await markReviewLoopEpochWaitingForOwner(db, epoch.id, {
      nowMs: 400_040,
      reason: "owner_approval_required",
      expectedPromptId: "p-rl",
    });
    expect(waiting?.status).toBe("waiting_for_owner");
    expect(waiting?.leaseExpiresAt).toBeNull();
    expect(enqueued?.status).toBe("enqueued");
    // Far past any lease window — waiting_for_owner is never listed as stuck.
    const stuck = await listStuckReviewLoopEpochs(db, { nowMs: 400_040 + IN_FLIGHT_LEASE_MS * 10, limit: 10 });
    expect(stuck.map((row) => row.id)).not.toContain(epoch.id);
  });

  it("completes an in-flight epoch when its owning prompt ends without publishing (reply-only/no-op)", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-reply-only", 500_000, "p-rl");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 500_030 });

    // A stale prompt id must not complete the epoch.
    expect(
      await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, { promptId: "p-other", nowMs: 500_040 }),
    ).toBeNull();

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, { promptId: "p-rl", nowMs: 500_050 });
    expect(resolved?.status).toBe("completed");
    expect(resolved?.leaseExpiresAt).toBeNull();
    // No longer stuck.
    expect(await listStuckReviewLoopEpochs(db, { nowMs: 500_050 + IN_FLIGHT_LEASE_MS, limit: 10 })).toEqual([]);
  });

  it("re-drives a no-diff terminal prompt that left prompted work unresolved", async () => {
    const epoch = await createReadyEpoch("s-no-progress-redrive", 510_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 510_010 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 510_020,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 510_030 });

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 510_040,
    });

    expect(resolved?.status).toBe("ready");
    expect(resolved?.lastPromptId).toBeNull();
    expect(resolved?.blockedReason).toBeNull();
    expect(await listDueReviewLoopEpochs(db, { nowMs: 510_050, limit: 10 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: epoch.id })]),
    );
  });

  it("completes no-diff terminal prompted work when every prompted item has a successful reply operation", async () => {
    const epoch = await createReadyEpoch("s-no-progress-replied", 511_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 511_010 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 511_020,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1", "issue-comment:2"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 511_030 });
    insertSucceededReplyOperation(epoch.id, "p-rl", "review-comment:1", 511_035);
    insertSucceededReplyOperation(epoch.id, "p-rl", "issue-comment:2", 511_036);

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 511_040,
    });

    expect(resolved?.status).toBe("completed");
    expect(resolved?.leaseExpiresAt).toBeNull();
  });

  it("re-drives a partial reply (1-of-N) instead of completing on the per-source check", async () => {
    // A no-diff turn that replied to only one of two prompted sources must NOT settle: the unreplied
    // source has to resurface. `review_loop_reply` evidence is never passed as a source-less side
    // effect, so it falls through to the per-source query rather than short-circuiting completion.
    const epoch = await createReadyEpoch("s-no-progress-partial", 514_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 514_010 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 514_020,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1", "issue-comment:2"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 514_030 });
    insertSucceededReplyOperation(epoch.id, "p-rl", "review-comment:1", 514_035);

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 514_040,
    });

    expect(resolved?.status).toBe("ready");
    expect(resolved?.lastPromptId).toBeNull();
    expect(resolved?.blockedReason).toBeNull();
  });

  it("re-drives a no-diff terminal prompt when a legacy succeeded reply has no verdict", async () => {
    const epoch = await createReadyEpoch("s-no-progress-legacy-reply", 515_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 515_010 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 515_020,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 515_030 });
    insertSucceededReplyOperation(epoch.id, "p-rl", "review-comment:1", 515_035, null);

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 515_040,
    });

    expect(resolved?.status).toBe("ready");
    expect(resolved?.lastPromptId).toBeNull();
    expect(resolved?.blockedReason).toBeNull();
  });

  it("completes no-diff terminal CI work without source-less side-effect evidence", async () => {
    const epoch = await createReadyEpoch("s-no-progress-ci", 512_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 512_010 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 512_020,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["check-run-failure:42"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 512_030 });

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 512_040,
    });

    expect(resolved?.status).toBe("completed");
  });

  it("blocks repeated no-diff terminal prompts at the retry cap instead of completing unresolved work", async () => {
    const epoch = await createReadyEpoch("s-no-progress-cap", 513_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 513_010 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 513_020,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 513_030 });
    sqlite.prepare(`UPDATE pr_review_response_epochs SET attempt_count = 5 WHERE id = ?`).run(epoch.id);

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 513_040,
    });

    expect(resolved?.status).toBe("blocked");
    expect(resolved?.blockedReason).toBe(REVIEW_LOOP_NO_PROGRESS_UNRESOLVED_REASON);
    expect(resolved?.lastPromptId).toBeNull();
  });

  it("keeps a carry-forward drain ready when attempt_count is high but no-progress count is still below the drain cap", async () => {
    const epoch = await createReadyEpoch("s-no-progress-carry-forward", 513_100);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 513_110 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 513_120,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1"],
      carriedForwardSourceIds: ["review-comment:tail"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 513_130 });
    sqlite
      .prepare(
        `UPDATE pr_review_response_epochs
         SET attempt_count = ?, carry_forward_no_progress_count = ?
         WHERE id = ?`,
      )
      .run(99, REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP - 1, epoch.id);

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 513_140,
    });

    expect(resolved?.status).toBe("ready");
    expect(resolved?.blockedReason).toBeNull();
    expect(resolved?.lastPromptId).toBeNull();
  });

  it("still blocks a non-carry-forward no-diff terminal prompt when attempt_count reaches the cap", async () => {
    const epoch = await createReadyEpoch("s-no-progress-non-drain-cap", 513_200);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "sweep", nowMs: 513_210 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl",
      worklistHash: "worklist-hash",
      nowMs: 513_220,
      expectedReservationToken: claimed?.reservationToken ?? null,
      promptedSourceIds: ["review-comment:1"],
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 513_230 });
    sqlite.prepare(`UPDATE pr_review_response_epochs SET attempt_count = 5 WHERE id = ?`).run(epoch.id);

    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl",
      nowMs: 513_240,
    });

    expect(resolved?.status).toBe("blocked");
    expect(resolved?.blockedReason).toBe(REVIEW_LOOP_NO_PROGRESS_UNRESOLVED_REASON);
    expect(resolved?.lastPromptId).toBeNull();
  });

  it("clears a stale reclaim last_error when the terminal-prompt resolver completes the epoch", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-reclaim-then-resolve", 520_000, "p-rl");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 520_030 });

    // A reclaim cycle stamps last_error and re-drives the epoch back to in-flight under a new prompt.
    const leaseExpiresAt = 520_030 + IN_FLIGHT_LEASE_MS;
    const reclaimed = await reclaimStuckReviewLoopEpoch(db, epoch.id, {
      nowMs: leaseExpiresAt + 5,
      expectedLeaseExpiresAt: leaseExpiresAt,
    });
    expect(reclaimed?.lastError).toBe("reclaimed: in-flight lease expired");

    const reclaimedAt = leaseExpiresAt + 5;
    const reclaimedClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, {
      leaseOwner: "sweep",
      nowMs: reclaimedAt + 10,
    });
    const reEnqueued = await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-rl-2",
      worklistHash: "worklist-hash",
      nowMs: reclaimedAt + 20,
      expectedReservationToken: reclaimedClaim?.reservationToken ?? null,
    });
    expect(reEnqueued?.status).toBe("enqueued");

    // A reply-only / no-op terminal turn completes the epoch — and the stale reclaim error must clear,
    // so a clean completion does not look like a failure in observability.
    const resolved = await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, {
      promptId: "p-rl-2",
      nowMs: reclaimedAt + 30,
    });
    expect(resolved?.status).toBe("completed");
    expect(resolved?.lastError).toBeNull();
  });

  it("does not complete a publishing or waiting_for_owner epoch via the terminal-prompt resolver", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-terminal-guard", 600_000, "p-rl");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 600_030 });
    await markReviewLoopEpochPublishing(db, epoch.id, { promptId: "p-rl", nowMs: 600_040 });
    // publishing is mid-publish: the terminal-prompt resolver must not complete it.
    expect(
      await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, { promptId: "p-rl", nowMs: 600_050 }),
    ).toBeNull();
    expect((await getReviewLoopEpochById(db, epoch.id))?.status).toBe("publishing");
  });

  it("re-points last_prompt_id for a spawn-retried review-loop prompt so its publish is accepted", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-spawn-retry", 700_000, "p-orig");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-orig", nowMs: 700_030 });

    // Before re-point: a publish completion for the retry prompt would be rejected (different prompt).
    expect(
      await markReviewLoopEpochCompleted(db, epoch.id, { nowMs: 700_040, expectedPromptId: "p-retry" }),
    ).toBeNull();

    const repointed = await repointReviewLoopEpochPrompt(db, epoch.id, {
      previousPromptId: "p-orig",
      nextPromptId: "p-retry",
      nowMs: 700_050,
    });
    expect(repointed?.lastPromptId).toBe("p-retry");
    expect(repointed?.status).toBe("processing");

    // Now the retry prompt's publish completion succeeds.
    const completed = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs: 700_060, expectedPromptId: "p-retry" });
    expect(completed?.status).toBe("completed");
  });

  it("refreshes the in-flight lease on re-point so a retry past the original window is not reclaimed", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-spawn-retry-lease", 710_000, "p-orig");
    const processing = await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-orig", nowMs: 710_030 });
    const originalLease = processing?.leaseExpiresAt ?? 0;
    expect(originalLease).toBe(710_030 + IN_FLIGHT_LEASE_MS);

    // Re-point happens late in the original lease window (the retry is a fresh attempt).
    const repointAt = 710_030 + IN_FLIGHT_LEASE_MS - 5;
    const repointed = await repointReviewLoopEpochPrompt(db, epoch.id, {
      previousPromptId: "p-orig",
      nextPromptId: "p-retry",
      nowMs: repointAt,
    });
    expect(repointed?.lastPromptId).toBe("p-retry");
    expect(repointed?.leaseOwner).toBe("in-flight");
    expect(repointed?.leaseExpiresAt).toBe(repointAt + IN_FLIGHT_LEASE_MS);

    // At the ORIGINAL lease expiry the retry is NOT yet stuck — the refreshed lease still covers it.
    const stuckAtOriginal = await listStuckReviewLoopEpochs(db, { nowMs: originalLease, limit: 10 });
    expect(stuckAtOriginal.map((row) => row.id)).not.toContain(epoch.id);
    // Only after the refreshed window elapses does the sweep see it.
    const stuckAfterRefresh = await listStuckReviewLoopEpochs(db, { nowMs: repointAt + IN_FLIGHT_LEASE_MS, limit: 10 });
    expect(stuckAfterRefresh.map((row) => row.id)).toContain(epoch.id);
  });

  it("re-point is authoritative: a terminal-resolve for the original prompt no-ops after re-point (spawn-retry race)", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-spawn-retry-race", 720_000, "p-orig");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-orig", nowMs: 720_030 });

    // handleSpawnTimeout re-points authoritatively (awaited) to the retry prompt.
    const repointed = await repointReviewLoopEpochPrompt(db, epoch.id, {
      previousPromptId: "p-orig",
      nextPromptId: "p-retry",
      nowMs: 720_040,
    });
    expect(repointed?.lastPromptId).toBe("p-retry");

    // A later-serialized terminal callback for the FAILED original prompt must NOT complete the epoch
    // out from under the retry — the CAS binds the original prompt id, which no longer matches.
    expect(
      await resolveReviewLoopEpochForTerminalPrompt(db, epoch.id, { promptId: "p-orig", nowMs: 720_050 }),
    ).toBeNull();
    expect((await getReviewLoopEpochById(db, epoch.id))?.status).toBe("processing");

    // The retry prompt can still drive the epoch to completion via the publish path.
    const completed = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs: 720_060, expectedPromptId: "p-retry" });
    expect(completed?.status).toBe("completed");
  });

  it("re-point CAS no-ops when last_prompt_id does not match the previous prompt", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-spawn-retry-cas", 800_000, "p-orig");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-orig", nowMs: 800_030 });
    const repointed = await repointReviewLoopEpochPrompt(db, epoch.id, {
      previousPromptId: "p-wrong",
      nextPromptId: "p-retry",
      nowMs: 800_040,
    });
    expect(repointed).toBeNull();
    expect((await getReviewLoopEpochById(db, epoch.id))?.lastPromptId).toBe("p-orig");
  });

  it("blocks a stuck in-flight epoch via blockStuckReviewLoopEpoch with attempt_cap_reached", async () => {
    const { epoch } = await enqueueInFlightEpoch("s-block-stuck", 900_000, "p-rl");
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-rl", nowMs: 900_030 });
    const leaseExpiresAt = 900_030 + IN_FLIGHT_LEASE_MS;
    const blocked = await blockStuckReviewLoopEpoch(db, epoch.id, {
      nowMs: leaseExpiresAt + 5,
      reason: "attempt_cap_reached",
      error: "exhausted",
      expectedLeaseExpiresAt: leaseExpiresAt,
    });
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("attempt_cap_reached");
    expect(blocked?.leaseExpiresAt).toBeNull();
  });
});

describe("CI-epoch classification predicates and worklist_hash accessors", () => {
  const makeEpochView = (sourceKind: ReviewLoopSourceKind, worklistHash: string | null) => ({
    sourceKind,
    worklistHash,
  });

  it("isCiEpoch / isReviewEpoch classify ci, merge-conflict, and review epochs", () => {
    expect(isCiEpoch(makeEpochView("ci", null))).toBe(true);
    expect(isReviewEpoch(makeEpochView("ci", null))).toBe(false);
    expect(isMergeConflictEpoch(makeEpochView("merge_conflict", null))).toBe(true);
    expect(isCiEpoch(makeEpochView("merge_conflict", null))).toBe(false);
    expect(isReviewEpoch(makeEpochView("merge_conflict", null))).toBe(false);
    // A mention epoch is its OWN independent class (like ci/merge_conflict): mention-only, never ci,
    // never merge-conflict, and NOT a review epoch (so it never folds into a bot/human worklist).
    expect(isMentionEpoch(makeEpochView("mention", null))).toBe(true);
    expect(isCiEpoch(makeEpochView("mention", null))).toBe(false);
    expect(isMergeConflictEpoch(makeEpochView("mention", null))).toBe(false);
    expect(isReviewEpoch(makeEpochView("mention", null))).toBe(false);
    for (const kind of ["bot", "human", "mixed", "verification"] as const) {
      expect(isMentionEpoch(makeEpochView(kind, null))).toBe(false);
      expect(isCiEpoch(makeEpochView(kind, null))).toBe(false);
      expect(isMergeConflictEpoch(makeEpochView(kind, null))).toBe(false);
      expect(isReviewEpoch(makeEpochView(kind, null))).toBe(true);
    }

    // Compile-time guarantee (the point of comment 2): these are real type predicates, not bare
    // `boolean`. isReviewEpoch's positive branch narrows sourceKind away from "ci", so assigning it to
    // a ReviewSourceKind-typed slot must typecheck WITHOUT a cast. If either predicate regressed to
    // `boolean`, the next line would be a TS error and `npm run typecheck` would fail.
    const epoch = makeEpochView("bot", null);
    if (isReviewEpoch(epoch)) {
      const narrowed: ReviewSourceKind = epoch.sourceKind;
      expect(narrowed).toBe("bot");
    }
    if (isCiEpoch(epoch)) {
      const ciKind: "ci" = epoch.sourceKind;
      expect(ciKind).toBe("ci");
    }
  });

  it("the CI sentinels have a single typed home and the back-compat alias matches", () => {
    expect(REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash).toBe("ci-fixes");
    expect(REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind).toBe("ci");
    expect(REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictExpectedBotsHash).toBe("merge-conflict");
    expect(REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind).toBe("merge_conflict");
    expect(REVIEW_LOOP_CI_EPOCH_HASH).toBe(REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash);
  });

  it("ciFailingCheckFingerprint reads worklist_hash as a fingerprint only for CI epochs", () => {
    // CI epoch with a recorded fingerprint → returns it.
    expect(ciFailingCheckFingerprint(makeEpochView("ci", "lint+typecheck"))).toBe("lint+typecheck");
    // CI epoch with no recorded fingerprint (completed-noop / head-changed) → null.
    expect(ciFailingCheckFingerprint(makeEpochView("ci", null))).toBeNull();
    expect(ciFailingCheckFingerprint(makeEpochView("ci", ""))).toBeNull();
    // Review epochs never expose a fingerprint, even though worklist_hash is populated.
    expect(ciFailingCheckFingerprint(makeEpochView("bot", "worklist-abc"))).toBeNull();
    expect(ciFailingCheckFingerprint(makeEpochView("human", "worklist-abc"))).toBeNull();
    expect(ciFailingCheckFingerprint(makeEpochView("merge_conflict", "merge-conflict:abc"))).toBeNull();
  });

  it("reviewWorklistHash reads worklist_hash as the worklist hash only for review epochs", () => {
    // Review epoch with a hash → returns it; with none → "" (matches historical op-id input).
    expect(reviewWorklistHash(makeEpochView("bot", "worklist-abc"))).toBe("worklist-abc");
    expect(reviewWorklistHash(makeEpochView("mixed", null))).toBe("");
    // CI epochs do not expose a worklist hash (their worklist_hash is a fingerprint).
    expect(reviewWorklistHash(makeEpochView("ci", "lint+typecheck"))).toBeNull();
    expect(reviewWorklistHash(makeEpochView("merge_conflict", "merge-conflict:abc"))).toBeNull();
  });

  it("reviewSourceKind narrows a review epoch and refuses CI or merge-conflict epochs", () => {
    expect(reviewSourceKind(makeEpochView("bot", null))).toBe("bot");
    expect(reviewSourceKind(makeEpochView("human", null))).toBe("human");
    expect(reviewSourceKind(makeEpochView("mixed", null))).toBe("mixed");
    expect(reviewSourceKind(makeEpochView("verification", null))).toBe("verification");
    expect(() => reviewSourceKind(makeEpochView("ci", null))).toThrow(/CI epoch/);
    expect(() => reviewSourceKind(makeEpochView("merge_conflict", null))).toThrow(/merge-conflict epoch/);
    expect(() => reviewSourceKind(makeEpochView("mention", null))).toThrow(/mention epoch/);
  });
});

describe("getLatestReviewLoopEpochForPr kind filter (structural CI exclusion)", () => {
  let ciSqlite: Database.Database;
  let ciDb: D1Database;

  beforeEach(() => {
    ciSqlite = new Database(":memory:");
    ciSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
    // 0122 widens the source_kind CHECK to allow 'ci'.
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
    ciSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"),
    );
    ciDb = new SqliteD1(ciSqlite) as unknown as D1Database;
  });

  it("defaults to review epochs (excludes ci) but kind:'any' includes a newer ci epoch", async () => {
    const sessionId = "sess-ci-filter";
    const prUrl = "https://github.com/acme/repo/pull/77";
    // 1. A bot review epoch lands first.
    const reviewEpoch = await upsertReviewLoopEpochActivity(ciDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl,
      headSha: "head-1",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "review-hash",
      sourceId: "review-comment:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:1" },
      nowMs: 1_000,
    });
    // 2. A NEWER ci epoch lands on the same PR (distinct sentinel hash → distinct row).
    const ciEpoch = await upsertReviewLoopEpochActivity(ciDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 77,
      prUrl,
      headSha: "head-1",
      expectedBots: [],
      expectedBotsHash: REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash,
      sourceKind: REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind,
      sourceId: "check-run-failure:9",
      botKey: "ci",
      botActorLogin: null,
      terminal: true,
      evidence: { type: "ci_failure", sourceId: "check-run-failure:9" },
      nowMs: 2_000,
    });
    expect(isCiEpoch(ciEpoch)).toBe(true);

    // Default (kind: "review") must skip the newer ci epoch and return the review one.
    const latestReview = await getLatestReviewLoopEpochForPr(ciDb, { sessionId, prUrl });
    expect(latestReview?.id).toBe(reviewEpoch.id);
    expect(isReviewEpoch(latestReview!)).toBe(true);

    // kind: "any" opts into seeing the newer ci epoch.
    const latestAny = await getLatestReviewLoopEpochForPr(ciDb, { sessionId, prUrl, kind: "any" });
    expect(latestAny?.id).toBe(ciEpoch.id);
  });
});

describe("hasCiReviewLoopEpochForHead (CI sentinel predicate)", () => {
  let ciSqlite: Database.Database;
  let ciDb: D1Database;

  beforeEach(() => {
    ciSqlite = new Database(":memory:");
    ciSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
    ciSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
    ciSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"),
    );
    ciDb = new SqliteD1(ciSqlite) as unknown as D1Database;
  });

  it("matches only a ci-fix epoch on the head, never a bot/human review epoch", async () => {
    const sessionId = "sess-ci-head";
    const prUrl = "https://github.com/acme/repo/pull/88";
    const headSha = "head-1";

    // A bot review epoch alone must NOT count as a ci epoch.
    await upsertReviewLoopEpochActivity(ciDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 88,
      prUrl,
      headSha,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "review-hash",
      sourceId: "review-comment:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:1" },
      nowMs: 1_000,
    });
    expect(await hasCiReviewLoopEpochForHead(ciDb, { sessionId, prUrl, headSha })).toBe(false);

    // After a ci-fix epoch lands on the head, the predicate is true.
    await upsertReviewLoopEpochActivity(ciDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 88,
      prUrl,
      headSha,
      expectedBots: [],
      expectedBotsHash: REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash,
      sourceKind: REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind,
      sourceId: "ci-check:9:88",
      botKey: "ci",
      botActorLogin: null,
      terminal: true,
      evidence: { type: "ci_failure", sourceId: "ci-check:9:88" },
      nowMs: 2_000,
    });
    expect(await hasCiReviewLoopEpochForHead(ciDb, { sessionId, prUrl, headSha })).toBe(true);
    // A different head has no ci epoch.
    expect(await hasCiReviewLoopEpochForHead(ciDb, { sessionId, prUrl, headSha: "head-2" })).toBe(false);
  });
});

describe("verification-intake epochs (RLA v2)", () => {
  let vSqlite: Database.Database;
  let vDb: D1Database;

  beforeEach(() => {
    vSqlite = new Database(":memory:");
    vSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    vSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
    vSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
    vSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
    vSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
    vSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));
    vSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0156_review_loop_verification_source_kind.sql", "utf8"),
    );
    vSqlite.exec(readFileSync("apps/control-plane-worker/migrations/0166_review_loop_carried_forward.sql", "utf8"));
    vSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0202_review_loop_carry_forward_no_progress_count.sql", "utf8"),
    );
    vSqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0225_pr_review_merge_conflict_resolution.sql", "utf8"),
    );
    vDb = new SqliteD1(vSqlite) as unknown as D1Database;
  });

  const bootstrapArgs = (overrides: Partial<ReviewLoopVerificationBootstrapArgs> = {}) => ({
    sessionId: "sess-va",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 90,
    prUrl: "https://github.com/acme/repo/pull/90",
    headSha: "head-va",
    triggeringSourceId: "verification:head-va:1",
    nowMs: 10_000,
    ...overrides,
  });

  const mergeConflictBootstrapArgs = (overrides: Partial<ReviewLoopMergeConflictBootstrapArgs> = {}) => ({
    sessionId: "sess-va",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 90,
    prUrl: "https://github.com/acme/repo/pull/90",
    headSha: "head-va",
    nowMs: 10_000,
    ...overrides,
  });

  it("bootstraps an immediately-due verification epoch on the sentinel hash", async () => {
    const epoch = await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs());

    expect(epoch.sourceKind).toBe("verification");
    expect(epoch.expectedBotsHash).toBe(REVIEW_LOOP_EPOCH_SENTINELS.verificationExpectedBotsHash);
    expect(epoch.status).toBe("ready");
    expect(epoch.fallbackAfterAt).toBe(10_000);
    expect(epoch.triggeringSourceIds).toEqual(["verification:head-va:1"]);

    const due = await listDueReviewLoopEpochs(vDb, { nowMs: 10_000, limit: 10 });
    expect(due.map((d) => d.id)).toContain(epoch.id);
  });

  it("re-ingesting the same verdict source id merges instead of opening a new wave", async () => {
    const first = await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs());
    const second = await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs({ nowMs: 11_000 }));

    expect(second.id).toBe(first.id);
    expect(second.wave).toBe(1);
  });

  it("a later verdict (new source id) on a terminal epoch opens a new wave", async () => {
    const first = await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs());
    await vSqlite.prepare("UPDATE pr_review_response_epochs SET status = 'completed' WHERE id = ?").run(first.id);

    const second = await bootstrapReviewLoopEpochForVerification(
      vDb,
      bootstrapArgs({ triggeringSourceId: "verification:head-va:2", nowMs: 20_000 }),
    );

    expect(second.id).not.toBe(first.id);
    expect(second.wave).toBe(2);
    expect(second.status).toBe("ready");
  });

  it("keeps verification distinct from bot/human epochs on the same head", async () => {
    const sessionId = "sess-va";
    const prUrl = "https://github.com/acme/repo/pull/90";
    await upsertReviewLoopEpochActivity(vDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 90,
      prUrl,
      headSha: "head-va",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "review-hash",
      sourceId: "review-comment:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:1" },
      nowMs: 1_000,
    });
    const verification = await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs());

    // The verification epoch never folds into the bot epoch (distinct sentinel hash)...
    const rows = vSqlite
      .prepare("SELECT id, source_kind FROM pr_review_response_epochs WHERE session_id = ? ORDER BY created_at")
      .all(sessionId) as Array<{ id: string; source_kind: string }>;
    expect(rows).toHaveLength(2);
    // ...and counts as a review epoch (predicates) but never as CI.
    expect(isVerificationEpoch(verification)).toBe(true);
    expect(isCiEpoch(verification)).toBe(false);
    expect(isReviewEpoch(verification)).toBe(true);
  });

  it("a verification-intake epoch does not satisfy hasReviewLoopEpochForHead (bot bootstrap stays unsuppressed)", async () => {
    const sessionId = "sess-va";
    const prUrl = "https://github.com/acme/repo/pull/90";
    const headSha = "head-va";

    // Only a verification-intake epoch exists on the head. It IS a review epoch for rollups/reply,
    // but must NOT stand in for a bot/human epoch here: bootstrap suppression keys on real bot/human
    // epochs, so a verification intake (expectedBots: [], managed QTA comment only) must not hide
    // pending bot feedback that still needs recovering.
    await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs());
    expect(await hasReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(false);

    // A real bot epoch on the same head does satisfy the predicate.
    await upsertReviewLoopEpochActivity(vDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 90,
      prUrl,
      headSha,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "review-hash",
      sourceId: "review-comment:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:1" },
      nowMs: 1_000,
    });
    expect(await hasReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(true);
  });

  it("getLatestReviewLoopEpochForPr (kind=review) excludes a verification epoch but kind=any returns it", async () => {
    const sessionId = "sess-va";
    const prUrl = "https://github.com/acme/repo/pull/90";

    // Settled bot epoch, then a newer verification-intake epoch on the same head.
    await upsertReviewLoopEpochActivity(vDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 90,
      prUrl,
      headSha: "head-va",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "review-hash",
      sourceId: "review-comment:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review-comment:1" },
      nowMs: 1_000,
    });
    const verification = await bootstrapReviewLoopEpochForVerification(vDb, bootstrapArgs({ nowMs: 5_000 }));

    // The status-comment lookup (default kind="review") must return the bot epoch, not the newer
    // verification epoch — otherwise it renders the verification epoch's empty zero-bot state and
    // clobbers the real "waiting for <bot>" comment.
    const review = await getLatestReviewLoopEpochForPr(vDb, { sessionId, prUrl });
    expect(review?.sourceKind).toBe("bot");

    // kind="any" still sees the verification epoch (most recent overall).
    const any = await getLatestReviewLoopEpochForPr(vDb, { sessionId, prUrl, kind: "any" });
    expect(any?.id).toBe(verification.id);
  });

  it("bootstraps an immediately-due merge-conflict epoch on the sentinel hash", async () => {
    const epoch = await bootstrapReviewLoopEpochForMergeConflict(vDb, mergeConflictBootstrapArgs());

    expect(epoch.sourceKind).toBe("merge_conflict");
    expect(epoch.expectedBotsHash).toBe(REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictExpectedBotsHash);
    expect(epoch.status).toBe("ready");
    expect(epoch.fallbackAfterAt).toBe(10_000);
    expect(epoch.triggeringSourceIds).toEqual(["merge-conflict:head-va"]);
    expect(isMergeConflictEpoch(epoch)).toBe(true);
    expect(isReviewEpoch(epoch)).toBe(false);
  });

  it("a merge-conflict epoch is tracked by its dedicated head predicate only", async () => {
    const sessionId = "sess-va";
    const prUrl = "https://github.com/acme/repo/pull/90";
    const headSha = "head-va";

    await bootstrapReviewLoopEpochForMergeConflict(vDb, mergeConflictBootstrapArgs());

    expect(await hasMergeConflictReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(true);
    expect(await hasReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(false);
    expect(await hasCiReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(false);
  });

  it("active merge-conflict predicate ignores terminal historical epochs", async () => {
    const sessionId = "sess-va";
    const prUrl = "https://github.com/acme/repo/pull/90";
    const headSha = "head-va";
    const epoch = await bootstrapReviewLoopEpochForMergeConflict(vDb, mergeConflictBootstrapArgs());

    expect(await hasActiveMergeConflictReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(true);

    vSqlite
      .prepare("UPDATE pr_review_response_epochs SET status = 'completed', worklist_hash = ? WHERE id = ?")
      .run("merge-conflict:head-va", epoch.id);

    expect(await hasMergeConflictReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(true);
    expect(await hasActiveMergeConflictReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(false);
  });

  it("historical merge-conflict predicate ignores terminal rows that never attempted a prompt", async () => {
    const sessionId = "sess-va";
    const prUrl = "https://github.com/acme/repo/pull/90";
    const headSha = "head-va";
    const epoch = await bootstrapReviewLoopEpochForMergeConflict(vDb, mergeConflictBootstrapArgs());

    vSqlite
      .prepare("UPDATE pr_review_response_epochs SET status = 'completed', worklist_hash = '' WHERE id = ?")
      .run(epoch.id);

    expect(await hasMergeConflictReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(false);
    expect(await hasActiveMergeConflictReviewLoopEpochForHead(vDb, { sessionId, prUrl, headSha })).toBe(false);

    const retry = await bootstrapReviewLoopEpochForMergeConflict(vDb, mergeConflictBootstrapArgs({ nowMs: 20_000 }));
    expect(retry.id).not.toBe(epoch.id);
    expect(retry.wave).toBe(2);
    expect(retry.status).toBe("ready");
  });

  it("keeps draining a carry-forward tail across interleaved reclaim cycles instead of parking early (ARC-1242)", async () => {
    const epoch = await createReadyEpoch("s-cf-flaky", 1_000);
    let nowMs = 1_000;
    // Tail shrinks by one each productive wave: 4 → 3 → 2 → 1 → 0 (last wave drains it).
    const tails = [["c1", "c2", "c3", "c4"], ["c2", "c3", "c4"], ["c3", "c4"], ["c4"], [] as string[]];
    let waveStatus: string | undefined;
    for (let w = 0; w < tails.length; w += 1) {
      const carried = tails[w];
      // Two crash/reclaim cycles before each productive wave: each re-dispatches the CURRENT tail and
      // is reclaimed WITHOUT settling — exactly what inflates attempt_count while making no progress.
      if (carried.length > 0) {
        for (let c = 0; c < 2; c += 1) {
          nowMs += 10;
          const crashClaim = await claimReviewLoopEpochForPrompt(db, epoch.id, {
            leaseOwner: `crash-${w}-${c}`,
            nowMs,
          });
          nowMs += 10;
          const crashEnq = await markReviewLoopEpochEnqueued(db, epoch.id, {
            promptId: `p-crash-${w}-${c}`,
            worklistHash: `wh-crash-${w}-${c}`,
            nowMs,
            expectedReservationToken: crashClaim?.reservationToken ?? null,
            promptedSourceIds: [],
            existingPromptedSourceRecords: crashClaim?.promptedSourceRecords,
            carriedForwardSourceIds: carried, // same tail — no shrink
          });
          nowMs += 10;
          await reclaimStuckReviewLoopEpoch(db, epoch.id, {
            nowMs,
            expectedLeaseExpiresAt: crashEnq?.leaseExpiresAt ?? null,
          });
        }
      }
      // Productive wave: dispatch the (shrunk) tail and settle.
      nowMs += 10;
      const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: `w-${w}`, nowMs });
      nowMs += 10;
      await markReviewLoopEpochEnqueued(db, epoch.id, {
        promptId: `p-${w}`,
        worklistHash: `wh-${w}`,
        nowMs,
        expectedReservationToken: claim?.reservationToken ?? null,
        promptedSourceIds: [`prompted-${w}`],
        existingPromptedSourceRecords: claim?.promptedSourceRecords,
        carriedForwardSourceIds: carried,
      });
      nowMs += 10;
      insertSucceededReplyOperation(epoch.id, `p-${w}`, `prompted-${w}`, nowMs - 1);
      const settled = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs, expectedPromptId: `p-${w}` });
      waveStatus = settled?.status;
      expect(settled?.blockedReason).not.toBe("worklist_truncation_unresolved");
      if (carried.length > 0) expect(waveStatus).toBe("ready");
    }
    // ~13 claims total (would have tripped the retired attempt_count>=12 cap mid-drain), yet it drains.
    expect(waveStatus).toBe("completed");
    expect((await getReviewLoopEpochById(db, epoch.id))?.carriedForwardSourceIds).toEqual([]);
  });

  it("drains a large healthy worklist past the retired 12-wave cap without parking (ARC-1242 regression)", async () => {
    const epoch = await createReadyEpoch("s-cf-large", 1_000);
    let nowMs = 1_000;
    let status: string | undefined;
    // 15 productive waves, each shrinking the tail by one (15 → 0): exceeds the old flat-12 cap.
    for (let remaining = 15; remaining >= 0; remaining -= 1) {
      const carried = Array.from({ length: remaining }, (_, i) => `c${i}`);
      nowMs += 10;
      const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: `w-${remaining}`, nowMs });
      nowMs += 10;
      await markReviewLoopEpochEnqueued(db, epoch.id, {
        promptId: `p-${remaining}`,
        worklistHash: `wh-${remaining}`,
        nowMs,
        expectedReservationToken: claim?.reservationToken ?? null,
        promptedSourceIds: [`prompted-${remaining}`],
        existingPromptedSourceRecords: claim?.promptedSourceRecords,
        carriedForwardSourceIds: carried,
      });
      nowMs += 10;
      insertSucceededReplyOperation(epoch.id, `p-${remaining}`, `prompted-${remaining}`, nowMs - 1);
      const settled = await markReviewLoopEpochCompleted(db, epoch.id, { nowMs, expectedPromptId: `p-${remaining}` });
      status = settled?.status;
      expect(settled?.blockedReason).not.toBe("worklist_truncation_unresolved");
    }
    expect(status).toBe("completed");
  });
});

describe("mention epochs (@cycloid) — independent, sweep-dispatched class", () => {
  let mSqlite: Database.Database;
  let mDb: D1Database;

  beforeEach(() => {
    mSqlite = new Database(":memory:");
    for (const file of [
      "0114_pr_review_bot_settings_and_epochs.sql",
      "0117_pr_review_response_operations.sql",
      "0119_review_loop_human_source.sql",
      "0226_review_loop_reply_verdict.sql",
      "0122_review_loop_ci_source_kind.sql",
      "0126_review_loop_prompted_source_ids.sql",
      "0156_review_loop_verification_source_kind.sql",
      "0166_review_loop_carried_forward.sql",
      "0202_review_loop_carry_forward_no_progress_count.sql",
      "0225_pr_review_merge_conflict_resolution.sql",
      // Widens the source_kind CHECK to admit 'mention' (PR4).
      "0254_review_loop_mention_source_kind.sql",
    ]) {
      mSqlite.exec(readFileSync(`apps/control-plane-worker/migrations/${file}`, "utf8"));
    }
    mDb = new SqliteD1(mSqlite) as unknown as D1Database;
  });

  const mentionArgs = (overrides: Partial<ReviewLoopMentionBootstrapArgs> = {}): ReviewLoopMentionBootstrapArgs => ({
    sessionId: "sess-m",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 90,
    prUrl: "https://github.com/acme/repo/pull/90",
    headSha: "head-m",
    mode: "directive",
    targetSourceIds: ["issue-comment:5001"],
    mentionText: "@cycloid please add a null guard",
    nowMs: 10_000,
    ...overrides,
  });

  it("bootstraps a ready, immediately-due mention epoch on the sentinel hash with the payload stored", async () => {
    const epoch = await bootstrapMentionEpoch(mDb, mentionArgs());
    expect(epoch).not.toBeNull();
    expect(epoch!.sourceKind).toBe("mention");
    expect(epoch!.expectedBotsHash).toBe(REVIEW_LOOP_EPOCH_SENTINELS.mentionExpectedBotsHash);
    expect(epoch!.expectedBotsHash).not.toBe(EMPTY_EXPECTED_BOTS_HASH);
    expect(epoch!.status).toBe("ready");
    expect(epoch!.fallbackAfterAt).toBe(10_000);
    // Seeds triggering + handled source ids (settlement + prompted dedup treat them as handled).
    expect(epoch!.triggeringSourceIds).toEqual(["issue-comment:5001"]);
    expect(epoch!.handledSourceIds).toEqual(["issue-comment:5001"]);
    // The mention payload rides in terminal_evidence so the sweep can rebuild the prompt.
    const evidence = epoch!.terminalEvidence[0] as MentionEpochEvidence;
    expect(evidence.type).toBe("mention");
    expect(evidence.mode).toBe("directive");
    expect(evidence.mentionText).toBe("@cycloid please add a null guard");

    expect(isMentionEpoch(epoch!)).toBe(true);
    expect(isReviewEpoch(epoch!)).toBe(false);
    expect(isCiEpoch(epoch!)).toBe(false);

    const due = await listDueReviewLoopEpochs(mDb, { nowMs: 10_000, limit: 10 });
    expect(due.map((d) => d.id)).toContain(epoch!.id);
  });

  it("stores the targeted comment + parent context payload verbatim for the dispatch prompt", async () => {
    const epoch = await bootstrapMentionEpoch(
      mDb,
      mentionArgs({
        mode: "targeted",
        targetSourceIds: ["review-comment:6001"],
        parentSourceIds: ["review-comment:6000"],
        comment: { author: "octocat", body: "This can NPE.", path: "src/a.ts", diffHunk: "@@ -1 +1 @@" },
        parentComment: { author: "alice", body: "original note" },
      }),
    );
    const evidence = epoch!.terminalEvidence[0] as MentionEpochEvidence;
    expect(evidence.mode).toBe("targeted");
    expect(evidence.comment).toEqual({
      author: "octocat",
      body: "This can NPE.",
      path: "src/a.ts",
      diffHunk: "@@ -1 +1 @@",
    });
    expect(evidence.parentComment).toEqual({ author: "alice", body: "original note" });
    // The payload carries the TARGET ids only (parents are context, not reply targets) so the sweep
    // prints them as the dispatch prompt's `Source:` line.
    expect(evidence.sourceIds).toEqual(["review-comment:6001"]);
  });

  it("folds parentSourceIds into the handled/triggering set so cross-epoch dedup treats them as addressed", async () => {
    const epoch = await bootstrapMentionEpoch(
      mDb,
      mentionArgs({
        mode: "targeted",
        targetSourceIds: ["review-comment:6001"],
        parentSourceIds: ["review-comment:6000"],
        comment: { author: "octocat", body: "This can NPE.", path: "src/a.ts", diffHunk: "@@ -1 +1 @@" },
        parentComment: { author: "alice", body: "original note" },
      }),
    );
    // The replied-to parent id is marked addressed by this epoch (handled + triggering), so
    // listKnownReviewLoopSourceIds / epochAccountsForSource no longer leave it undispositioned in a
    // sibling human epoch to be re-dispatched as new unresolved feedback.
    expect(epoch!.triggeringSourceIds).toEqual(["review-comment:6000", "review-comment:6001"]);
    expect(epoch!.handledSourceIds).toEqual(["review-comment:6000", "review-comment:6001"]);
    // The parent stays OUT of the prompt's reply targets.
    const evidence = epoch!.terminalEvidence[0] as MentionEpochEvidence;
    expect(evidence.sourceIds).toEqual(["review-comment:6001"]);
  });

  it("coexists on ONE head with a human epoch WITHOUT collision (distinct sentinel hash, never folded)", async () => {
    const sessionId = "sess-m";
    const prUrl = "https://github.com/acme/repo/pull/90";
    const headSha = "head-m";

    // A human review epoch lands first (empty-human hash).
    const human = await bootstrapReviewLoopEpochForHuman(mDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 90,
      prUrl,
      headSha,
      triggeringSourceId: "human:7001",
      nowMs: 1_000,
    });
    // A mention lands on the SAME head (mention sentinel hash).
    const mention = await bootstrapMentionEpoch(mDb, mentionArgs({ headSha }));

    // Two DISTINCT rows — the sentinel hash keeps the mention from colliding on the unique key.
    expect(mention!.id).not.toBe(human.id);
    const rows = mSqlite
      .prepare(
        "SELECT id, source_kind, expected_bots_hash FROM pr_review_response_epochs WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionId) as Array<{ id: string; source_kind: string; expected_bots_hash: string }>;
    expect(rows).toHaveLength(2);
    // The mention row keeps its real 'mention' kind (never widened/merged by the human fold path)...
    expect(mention!.sourceKind).toBe("mention");
    expect(human.sourceKind).toBe("human");

    // ...and a later human review on the same head folds into the HUMAN epoch, never the mention.
    const humanAgain = await bootstrapReviewLoopEpochForHuman(mDb, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 90,
      prUrl,
      headSha,
      triggeringSourceId: "human:7001",
      nowMs: 2_000,
    });
    expect(humanAgain.id).toBe(human.id);
    const finalRows = mSqlite
      .prepare("SELECT source_kind FROM pr_review_response_epochs WHERE session_id = ?")
      .all(sessionId) as Array<{ source_kind: string }>;
    expect(finalRows.filter((r) => r.source_kind === "mention")).toHaveLength(1);
  });

  it("gives each distinct mention on a head its own wave (independent, id-matched)", async () => {
    const first = await bootstrapMentionEpoch(mDb, mentionArgs({ targetSourceIds: ["issue-comment:5001"] }));
    const second = await bootstrapMentionEpoch(
      mDb,
      mentionArgs({ targetSourceIds: ["issue-comment:5002"], nowMs: 20_000 }),
    );
    expect(second!.id).not.toBe(first!.id);
    expect(second!.wave).toBe(first!.wave + 1);
    expect(second!.sourceKind).toBe("mention");
  });

  it("a mention epoch does not suppress bot bootstrap (hasReviewLoopEpochForHead stays false)", async () => {
    const sessionId = "sess-m";
    const prUrl = "https://github.com/acme/repo/pull/90";
    const headSha = "head-m";
    await bootstrapMentionEpoch(mDb, mentionArgs({ headSha }));
    // Only a mention epoch exists; a real bot/human epoch must still be allowed to bootstrap.
    expect(await hasReviewLoopEpochForHead(mDb, { sessionId, prUrl, headSha })).toBe(false);
  });

  it("rejects a bootstrap with no target source ids", async () => {
    await expect(bootstrapMentionEpoch(mDb, mentionArgs({ targetSourceIds: [] }))).rejects.toThrow(/targetSourceId/);
  });

  const mentionRowIds = () =>
    mSqlite
      .prepare("SELECT id FROM pr_review_response_epochs WHERE session_id = ? AND source_kind = 'mention'")
      .all("sess-m") as Array<{ id: string }>;

  it("bootstrapMentionEpoch is idempotent on redelivery — same targetSourceIds returns the existing non-terminal epoch (no second wave)", async () => {
    const first = await bootstrapMentionEpoch(mDb, mentionArgs({ targetSourceIds: ["issue-comment:5001"] }));
    expect(first).not.toBeNull();
    // The caller's post-bootstrap emit threw and released the claim; GitHub redelivers the SAME comment
    // (identical target ids). Bootstrap must bind to the still-live epoch, not mint a second ready wave.
    const second = await bootstrapMentionEpoch(
      mDb,
      mentionArgs({ targetSourceIds: ["issue-comment:5001"], nowMs: 20_000 }),
    );
    expect(second!.id).toBe(first!.id);
    expect(second!.wave).toBe(first!.wave);
    // Only ONE mention row exists — the sweep dispatches one agent turn for the one @cycloid comment.
    expect(mentionRowIds()).toHaveLength(1);
  });

  it("bootstrapMentionEpoch mints a distinct epoch for different targetSourceIds on the same head", async () => {
    const first = await bootstrapMentionEpoch(mDb, mentionArgs({ targetSourceIds: ["issue-comment:5001"] }));
    // A DIFFERENT @cycloid comment carries a distinct GitHub id → no overlap → its own new wave.
    const second = await bootstrapMentionEpoch(
      mDb,
      mentionArgs({ targetSourceIds: ["issue-comment:5002"], nowMs: 20_000 }),
    );
    expect(second!.id).not.toBe(first!.id);
    expect(second!.wave).toBe(first!.wave + 1);
    expect(mentionRowIds()).toHaveLength(2);
  });

  it("a SETTLED first mention epoch does not block a new mint for the same targetSourceIds (new work)", async () => {
    const first = await bootstrapMentionEpoch(mDb, mentionArgs({ targetSourceIds: ["issue-comment:5001"] }));
    // The first mention ran to terminal (completed). A later @cycloid repeating the id is NEW work, not
    // a redelivery, so it must mint a fresh wave rather than bind to the settled epoch.
    mSqlite.prepare("UPDATE pr_review_response_epochs SET status = 'completed' WHERE id = ?").run(first!.id);
    const second = await bootstrapMentionEpoch(
      mDb,
      mentionArgs({ targetSourceIds: ["issue-comment:5001"], nowMs: 30_000 }),
    );
    expect(second!.id).not.toBe(first!.id);
    expect(second!.wave).toBe(first!.wave + 1);
    expect(mentionRowIds()).toHaveLength(2);
  });

  // ── A foreign/user head change must NOT drop a pending @cycloid mention ──
  // A mention is a head-AGNOSTIC user instruction; the sweep dispatch and the reply handler both require
  // the epoch's head to match the live PR head, so a mention stale-blocked on the old head is silently
  // lost (the ARC-1514 "only worked on 1" bug: the agent pushing a fix for one mention advanced the head
  // and stale-blocked a sibling mention before it dispatched). On a head change a mention must be carried
  // forward to the new head instead — while bot/human epochs, whose feedback IS tied to a head, are still
  // stale-blocked.
  async function seedBotEpochOnHead(headSha: string) {
    return upsertReviewLoopEpochActivity(mDb, {
      sessionId: "sess-m",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 90,
      prUrl: "https://github.com/acme/repo/pull/90",
      headSha,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-bot",
      sourceId: "review:cursor",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:cursor" },
      nowMs: 1_000,
    });
  }

  it("carryForwardMentionEpochsToNewHead re-keys a non-terminal mention to the new head, leaving non-mention epochs put", async () => {
    const mention = await bootstrapMentionEpoch(mDb, mentionArgs({ headSha: "head-old" }));
    const bot = await seedBotEpochOnHead("head-old");

    const rekeyed = await carryForwardMentionEpochsToNewHead(mDb, {
      sessionId: "sess-m",
      prUrl: "https://github.com/acme/repo/pull/90",
      previousHeadSha: "head-old",
      currentHeadSha: "head-new",
      nowMs: 50_000,
    });

    expect(rekeyed).toBe(1);
    const movedMention = await getReviewLoopEpochById(mDb, mention!.id);
    expect(movedMention?.headSha).toBe("head-new");
    // Status preserved so a pending mention stays dispatchable (not requeued/blocked).
    expect(movedMention?.status).toBe(mention!.status);
    // A bot epoch's feedback IS head-specific — it must stay on the old head for the stale-block.
    const stillBot = await getReviewLoopEpochById(mDb, bot.id);
    expect(stillBot?.headSha).toBe("head-old");
  });

  it("does NOT re-key an already-dispatched (in-flight) mention — that prompt's output is against the old head", async () => {
    const mention = await bootstrapMentionEpoch(mDb, mentionArgs({ headSha: "head-old" }));
    // The sweep has claimed + dispatched this mention: its prompt is in flight against head-old.
    mSqlite.prepare("UPDATE pr_review_response_epochs SET status = 'processing' WHERE id = ?").run(mention!.id);

    const rekeyed = await carryForwardMentionEpochsToNewHead(mDb, {
      sessionId: "sess-m",
      prUrl: "https://github.com/acme/repo/pull/90",
      previousHeadSha: "head-old",
      currentHeadSha: "head-new",
      nowMs: 50_000,
    });

    // Re-keying an in-flight prompt's head to the new head would make output generated against the OLD
    // head look current and bypass the `head_changed` supersession. Only UNDISPATCHED pending mentions
    // (ready/collecting) carry forward; this one is left on the old head for the stale-block.
    expect(rekeyed).toBe(0);
    const stillOld = await getReviewLoopEpochById(mDb, mention!.id);
    expect(stillOld?.headSha).toBe("head-old");
  });

  it("reconcileReviewLoopEpochsForHeadChange carries a pending mention forward while stale-blocking a bot epoch (foreign push)", async () => {
    const mention = await bootstrapMentionEpoch(mDb, mentionArgs({ headSha: "head-old" }));
    const bot = await seedBotEpochOnHead("head-old");

    // No pr_coordination row exists (its table isn't migrated in this suite), so getPrCoordination reads
    // as "no queued base-merge marker" and reconcile takes the foreign-push stale-block path.
    const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const result = await reconcileReviewLoopEpochsForHeadChange(mDb, {
      sessionId: "sess-m",
      prUrl: "https://github.com/acme/repo/pull/90",
      previousHeadSha: "head-old",
      currentHeadSha: "head-new",
      nowMs: 60_000,
      logger: noopLogger,
    });

    expect(result.mentionRekeyed).toBe(1);
    expect(result.staleBlocked).toBe(1);

    const survivedMention = await getReviewLoopEpochById(mDb, mention!.id);
    expect(survivedMention?.headSha).toBe("head-new");
    expect(survivedMention?.status).not.toBe("blocked");

    const blockedBot = await getReviewLoopEpochById(mDb, bot.id);
    expect(blockedBot?.status).toBe("blocked");
    expect(blockedBot?.blockedReason).toBe("head_changed");
    expect(blockedBot?.headSha).toBe("head-old");
  });
});

describe("completeReviewLoopEpochFromVerifiedPush (ARC-1407)", () => {
  it("completes a blocked epoch when a succeeded push op exists at the verified head", async () => {
    const epoch = await createReadyEpoch("s-arc1407-blocked", 20_000);
    forceBlockEpoch(epoch.id, "publish_failed");
    insertSucceededPushOperation(epoch.id, "p-2", "verified-head", 20_100);

    const settled = await completeReviewLoopEpochFromVerifiedPush(db, epoch.id, {
      nowMs: 20_200,
      verifiedHeadSha: "verified-head",
    });

    expect(settled?.status).toBe("completed");
    expect(settled?.blockedReason).toBeNull();
    const stored = await getReviewLoopEpochById(db, epoch.id);
    expect(stored?.status).toBe("completed");
  });

  it("does NOT settle without a succeeded push op at the verified head (fail-closed)", async () => {
    const epoch = await createReadyEpoch("s-arc1407-noop", 21_000);
    forceBlockEpoch(epoch.id, "publish_failed");

    const settled = await completeReviewLoopEpochFromVerifiedPush(db, epoch.id, {
      nowMs: 21_100,
      verifiedHeadSha: "verified-head",
    });

    expect(settled).toBeNull();
    const stored = await getReviewLoopEpochById(db, epoch.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.blockedReason).toBe("publish_failed");
  });

  it("does NOT settle when the only succeeded push op is at a different head", async () => {
    const epoch = await createReadyEpoch("s-arc1407-wronghead", 22_000);
    forceBlockEpoch(epoch.id, "publish_failed");
    insertSucceededPushOperation(epoch.id, "p-2", "other-head", 22_100);

    const settled = await completeReviewLoopEpochFromVerifiedPush(db, epoch.id, {
      nowMs: 22_200,
      verifiedHeadSha: "verified-head",
    });

    expect(settled).toBeNull();
    expect((await getReviewLoopEpochById(db, epoch.id))?.status).toBe("blocked");
  });

  it("is an idempotent no-op on an already-completed epoch", async () => {
    const epoch = await createReadyEpoch("s-arc1407-done", 23_000);
    insertSucceededPushOperation(epoch.id, "p-2", "verified-head", 23_050);
    forceCompleteEpoch(epoch.id);

    const settled = await completeReviewLoopEpochFromVerifiedPush(db, epoch.id, {
      nowMs: 23_200,
      verifiedHeadSha: "verified-head",
    });

    expect(settled).toBeNull();
  });

  it("re-drives to ready (not completed) when a carried-forward tail remains, preserving the tail", async () => {
    const epoch = await createReadyEpoch("s-arc1407-carry", 24_000);
    setEpochInFlightWithCarriedTail(epoch.id, ["src-tail"], 24_050 + 1_000);
    insertSucceededPushOperation(epoch.id, "p-carry", "verified-head", 24_100);

    const settled = await completeReviewLoopEpochFromVerifiedPush(db, epoch.id, {
      nowMs: 24_200,
      verifiedHeadSha: "verified-head",
    });

    expect(settled?.status).toBe("ready");
    expect(settled?.carriedForwardSourceIds).toEqual(["src-tail"]);
    expect(settled?.lastPromptId).toBeNull();
  });
});

describe("extendReviewLoopEpochLease (ARC-1407)", () => {
  it("pushes the in-flight lease out when the expected lease matches, leaving status/prompt intact", async () => {
    const epoch = await createReadyEpoch("s-arc1407-extend", 30_000);
    const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w", nowMs: 30_100 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-1",
      worklistHash: "wh-1",
      nowMs: 30_200,
      expectedReservationToken: claim?.reservationToken ?? null,
    });
    const processing = await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-1", nowMs: 30_300 });
    const priorLease = processing?.leaseExpiresAt ?? null;

    const extended = await extendReviewLoopEpochLease(db, epoch.id, {
      nowMs: 40_000,
      expectedLeaseExpiresAt: priorLease,
    });

    expect(extended?.leaseExpiresAt).toBe(40_000 + 30 * 60 * 1000);
    expect(extended?.status).toBe("processing");
    expect(extended?.lastPromptId).toBe("p-1");
  });

  it("no-ops when the expected lease does not match (a concurrent transition moved it)", async () => {
    const epoch = await createReadyEpoch("s-arc1407-extend-stale", 31_000);
    const claim = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "w", nowMs: 31_100 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: "p-1",
      worklistHash: "wh-1",
      nowMs: 31_200,
      expectedReservationToken: claim?.reservationToken ?? null,
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: "p-1", nowMs: 31_300 });

    const extended = await extendReviewLoopEpochLease(db, epoch.id, {
      nowMs: 41_000,
      expectedLeaseExpiresAt: 999,
    });

    expect(extended).toBeNull();
  });
});

describe("createFsmDispatchedReviewLoopEpoch (W11-V5 — FSM epoch-creation authority, §17-B)", () => {
  const baseArgs = (overrides = {}) => ({
    id: "epoch-sess-1-2",
    sessionId: "sess-1",
    ownerUserId: 7,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 99,
    prUrl: "https://github.com/acme/repo/pull/99",
    headSha: "h1",
    kind: "review" as const,
    sourceIds: ["review-1", "review-2"],
    nowMs: 1_700_000_000_000,
    ...overrides,
  });

  it("creates a ready, immediately-due epoch keyed on the committed id, worklist = traced sources", async () => {
    const epoch = await createFsmDispatchedReviewLoopEpoch(db, baseArgs());
    expect(epoch).not.toBeNull();
    expect(epoch?.id).toBe("epoch-sess-1-2"); // the committed in_flight_epoch_id IS the PK
    expect(epoch?.status).toBe("ready");
    expect(epoch?.triggeringSourceIds.sort()).toEqual(["review-1", "review-2"]);
    // Immediately claimable by the existing legacy sweep.
    const claimed = await claimReviewLoopEpochForPrompt(db, "epoch-sess-1-2", {
      leaseOwner: "sweep",
      nowMs: 1_700_000_001_000,
    });
    expect(claimed?.id).toBe("epoch-sess-1-2");
  });

  it("a second create for the SAME committed id BINDS to the existing row — never double-creates (§17-B anchor)", async () => {
    const first = await createFsmDispatchedReviewLoopEpoch(db, baseArgs());
    expect(first).not.toBeNull();
    const second = await createFsmDispatchedReviewLoopEpoch(db, baseArgs());
    // PK collision → OR IGNORE → the DAO binds to the committed id's existing row (idempotent), not a second row.
    expect(second?.id).toBe("epoch-sess-1-2");
    expect(second?.wave).toBe(first?.wave);
    const rows = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM pr_review_response_epochs WHERE id = ?`)
      .get("epoch-sess-1-2") as {
      n: number;
    };
    expect(rows.n).toBe(1); // exactly one row under that id
  });

  it("MAJOR-2: after epoch #1 at head H, a new dispatch at H opens wave=2 carrying the net-new source (no OR-IGNORE swallow)", async () => {
    // Epoch #1 (any creator) occupies wave 1 at this unique key, then completes.
    const first = await createFsmDispatchedReviewLoopEpoch(
      db,
      baseArgs({ id: "epoch-sess-1-1", sourceIds: ["review-1"] }),
    );
    expect(first?.wave).toBe(1);
    sqlite.prepare(`UPDATE pr_review_response_epochs SET status = 'completed' WHERE id = ?`).run("epoch-sess-1-1");

    // A later reviewer verdict at the SAME head → a fresh dispatch with a NEW committed id + net-new source.
    const second = await createFsmDispatchedReviewLoopEpoch(
      db,
      baseArgs({ id: "epoch-sess-1-2", sourceIds: ["review-2"] }),
    );
    expect(second).not.toBeNull(); // NOT dropped by an OR-IGNORE wave-1 collision
    expect(second?.id).toBe("epoch-sess-1-2");
    expect(second?.wave).toBe(2); // MAX(wave)+1 — the net-new source gets its own wave
    expect(second?.triggeringSourceIds).toEqual(["review-2"]);
  });

  it("computes wave=2 even against a legacy human epoch already at wave 1 (same unique key) — no collision drop", async () => {
    await bootstrapReviewLoopEpochForHuman(db, {
      sessionId: "sess-1",
      ownerUserId: 7,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 99,
      prUrl: "https://github.com/acme/repo/pull/99",
      headSha: "h1",
      triggeringSourceId: "human-review-1",
      nowMs: 1_700_000_000_000,
    });
    const fsm = await createFsmDispatchedReviewLoopEpoch(db, baseArgs());
    expect(fsm).not.toBeNull();
    expect(fsm?.wave).toBe(2); // opens the next wave rather than colliding + being dropped
  });
});

describe("dispatch telemetry (arrival_to_dispatch_ms) — single emit per dispatch", () => {
  const telemetry = { DD_API_KEY: "dd-key", WORKER_ENV: "test" };

  function arrivalEmitCount(): number {
    return mockPostStructuredEventToDd.mock.calls.filter(
      ([, payload]) => (payload as { event?: string } | undefined)?.event === "review_loop.arrival_to_dispatch_ms",
    ).length;
  }

  it("emits arrival_to_dispatch exactly once for a full claim→enqueue dispatch (at enqueue, not also at claim)", async () => {
    // The real dispatch threads telemetry into BOTH claim and enqueue (the sweep call site). The emit
    // belongs only at enqueue — the actual dispatch — so a claimed-but-blocked epoch does not pollute
    // the rollout-gate metric and a successful dispatch is not double-counted.
    const epoch = await createReadyEpoch("s-emit-once", 1_000);
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch!.id, { leaseOwner: "w", nowMs: 5_000 });
    expect(claimed).not.toBeNull();
    await markReviewLoopEpochEnqueued(db, epoch!.id, {
      promptId: "p1",
      worklistHash: "wh",
      expectedReservationToken: claimed!.reservationToken,
      nowMs: 5_000,
      telemetry,
    });

    expect(arrivalEmitCount()).toBe(1);
  });
});

// PR #7656: a sandbox `cycloid.git_sync` force-push previously left NO push-operation record, so the
// reply gate's #4987 own-pushed-SHA carve-out and the head-change reconciler's own-push carry-forward
// were both blind to the agent's own fix push. recordReviewLoopSelfPushForSession records the pushed
// head as a succeeded push op on every live epoch; hasSucceededReviewLoopPushToHead is the
// reconciler's proof read.
describe("recordReviewLoopSelfPushForSession (git_sync own-push record)", () => {
  const PUSHED = "74f4d380bbfa9a1962e6005d2fb7cde7b28b522a";

  it("records a succeeded push op on the session's live epoch; proof + reply carve-out both see it", async () => {
    const epoch = await createReadyEpoch("s-selfpush-1", 7_000);
    const recorded = await recordReviewLoopSelfPushForSession(db, {
      sessionId: "s-selfpush-1",
      pushedHead: PUSHED,
      nowMs: 8_000,
    });
    expect(recorded).toBe(1);
    await expect(selectLatestSucceededReviewLoopPushHead(db, epoch.id)).resolves.toBe(PUSHED);
    await expect(
      hasSucceededReviewLoopPushToHead(db, {
        sessionId: "s-selfpush-1",
        prUrl: epoch.prUrl,
        headSha: PUSHED,
        recordedAfterMs: 0,
      }),
    ).resolves.toBe(true);
    // Fail-closed: a different head / different session never matches.
    await expect(
      hasSucceededReviewLoopPushToHead(db, {
        sessionId: "s-selfpush-1",
        prUrl: epoch.prUrl,
        headSha: "0000000000000000000000000000000000000000",
        recordedAfterMs: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      hasSucceededReviewLoopPushToHead(db, {
        sessionId: "s-other",
        prUrl: epoch.prUrl,
        headSha: PUSHED,
        recordedAfterMs: 0,
      }),
    ).resolves.toBe(false);
    // Recency bound: a record older than the window is NOT own-push proof — a foreign force-push
    // back to a former own tip must stale-block, not carry forward.
    await expect(
      hasSucceededReviewLoopPushToHead(db, {
        sessionId: "s-selfpush-1",
        prUrl: epoch.prUrl,
        headSha: PUSHED,
        recordedAfterMs: 9_000,
      }),
    ).resolves.toBe(false);
  });

  it("is idempotent per (epoch, pushed head): a repeat record adds no second operation", async () => {
    const epoch = await createReadyEpoch("s-selfpush-2", 7_000);
    await recordReviewLoopSelfPushForSession(db, { sessionId: "s-selfpush-2", pushedHead: PUSHED, nowMs: 8_000 });
    const again = await recordReviewLoopSelfPushForSession(db, {
      sessionId: "s-selfpush-2",
      pushedHead: PUSHED,
      nowMs: 9_000,
    });
    expect(again).toBe(1);
    await expect(countSucceededReviewLoopOperations(db, epoch.id)).resolves.toBe(1);
    // The repeat record REFRESHES the operation timestamp: a push retried after the recency window
    // must still prove the advance as the session's own (ChatGPT P2 on #7826).
    await expect(
      hasSucceededReviewLoopPushToHead(db, {
        sessionId: "s-selfpush-2",
        prUrl: epoch.prUrl,
        headSha: PUSHED,
        recordedAfterMs: 8_500,
      }),
    ).resolves.toBe(true);
  });

  it("records nothing when the session has no live (non-terminal) epoch", async () => {
    const epoch = await createReadyEpoch("s-selfpush-3", 7_000);
    forceCompleteEpoch(epoch.id);
    const recorded = await recordReviewLoopSelfPushForSession(db, {
      sessionId: "s-selfpush-3",
      pushedHead: PUSHED,
      nowMs: 8_000,
    });
    expect(recorded).toBe(0);
    await expect(
      hasSucceededReviewLoopPushToHead(db, {
        sessionId: "s-selfpush-3",
        prUrl: epoch.prUrl,
        headSha: PUSHED,
        recordedAfterMs: 0,
      }),
    ).resolves.toBe(false);
  });
});
