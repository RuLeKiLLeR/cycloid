// Review-submission namespace alias stamping at epoch terminals.
//
// A PR review SUBMISSION is registered in the disposition store under the webhook namespace
// `human:<reviewId>` (for human AND bot reviews — the webhook mints `human:` for both), but a
// prompted epoch's worklist and reply operations key the canonical form `review-body:<reviewId>`.
// The terminal stamper must therefore stamp BOTH forms: stamping only the canonical id leaves the
// FSM-registered `human:` row `none` forever, which gates `caught_up` and fuels the epoch.settled
// drain re-arm into an unbounded synthetic-epoch dispatch loop (observed in prod as one noop epoch
// wave every ~9s on session dcccf3c0, PR trycycloid/cycloid#7656).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewLoopEpoch } from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import { shadowEmitReviewLoopEpochTerminal } from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import {
  beginReviewLoopOperationAttempt,
  buildReviewLoopReplyOperationId,
  fillSucceededReviewLoopReplyVerdict,
  markReviewLoopOperationSucceeded,
} from "../../apps/control-plane-worker/src/services/review-loop-operations";
import { buildGenesisRecord } from "../../apps/control-plane-worker/src/session/fsm/genesis";
import { insertPrCoordination } from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import {
  listForPr,
  listUndispositionedActionable,
} from "../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  syncSessionProjection: vi.fn(async () => {}),
  postDd: vi.fn(async () => true),
  postInternalAlert: vi.fn(async () => null),
  resolveInternalAlertOwnerLabel: vi.fn(async () => "owner"),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
}));

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: mocks.syncSessionProjection,
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), postStructuredEventToDd: mocks.postDd };
});

vi.mock("../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: mocks.postInternalAlert,
}));

vi.mock("../../apps/control-plane-worker/src/slack/internal-alert-session-context", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    resolveInternalAlertOwnerLabel: mocks.resolveInternalAlertOwnerLabel,
  };
});

const NOW = 1_700_000_000_000;
const PR = "https://github.com/o/r/pull/1";

const SESSION = {
  sessionId: "sess-alias",
  ownerUserId: "7",
  businessId: "biz-1",
  status: "active",
  createdAt: "",
  updatedAt: "",
  closedAt: null,
  lastEventId: null,
  title: null,
  repoOwner: "o",
  repoName: "r",
  installationId: 42,
};

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return sqlite;
}

let db: D1Database;

beforeEach(() => {
  db = new SqliteD1(createMigratedSqlite()) as unknown as D1Database;
  mocks.getSessionState.mockReset().mockResolvedValue(SESSION);
  mocks.syncSessionProjection.mockReset().mockResolvedValue(undefined);
  mocks.postDd.mockReset().mockResolvedValue(true);
  mocks.postInternalAlert.mockReset().mockResolvedValue(null);
  mocks.resolveInternalAlertOwnerLabel.mockReset().mockResolvedValue("owner");
});

const liveEnv = () => ({ DB: db, FSM_MODE: "live", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

function makeEpoch(overrides: Partial<ReviewLoopEpoch>): ReviewLoopEpoch {
  return {
    id: "ep-alias-1",
    sessionId: SESSION.sessionId,
    ownerUserId: 7,
    repoOwner: "o",
    repoName: "r",
    prNumber: 1,
    prUrl: PR,
    headSha: "h1",
    wave: 1,
    expectedBotsHash: "hash",
    expectedBots: [],
    expectedBotKeys: [],
    observedTerminalBots: [],
    observedTerminalBotKeys: [],
    observedTerminalBotCount: 0,
    handledSourceIds: [],
    triggeringSourceIds: [],
    promptedSourceIds: [],
    promptedSourceRecords: [],
    carriedForwardSourceIds: [],
    carryForwardNoProgressCount: 0,
    terminalEvidence: [],
    timedOutBotKeys: [],
    uncertainSourceIds: [],
    firstActivityAt: NOW,
    fallbackAfterAt: NOW,
    status: "prompted",
    sourceKind: "bot",
    worklistHash: null,
    lastPromptId: "p-1",
    blockedReason: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    reservationToken: null,
    attemptCount: 1,
    transientFailureCount: 0,
    contentionDeferralCount: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies ReviewLoopEpoch;
}

const seedReview = async (inFlight: string) =>
  insertPrCoordination(db, {
    ...buildGenesisRecord(SESSION.sessionId, NOW),
    state: "REVIEW",
    prUrl: PR,
    headSha: "h1",
    verdict: "pass",
    verdictHeadSha: "h1",
    codeChangedSinceVerification: false,
    inFlightEpochId: inFlight,
  });

const seedRegisteredNone = async (sourceId: string) => {
  await db
    .prepare(
      `INSERT INTO pr_review_item_dispositions (session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at)
       VALUES (?, ?, ?, 'none', NULL, NULL, ?, ?)`,
    )
    .bind(SESSION.sessionId, PR, sourceId, NOW, NOW)
    .run();
};

const dispositionsBySourceId = async () => {
  const rows = await listForPr(db, SESSION.sessionId, PR);
  return new Map(rows.map((row) => [row.sourceId, row]));
};

describe("review-submission namespace alias stamping at epoch terminals", () => {
  it("a replied terminal for a prompted review-body:<id> also stamps the FSM-registered human:<id> row", async () => {
    // The incident shape: the FSM registered the bot review submission under `human:123` on
    // review.received; the epoch prompted the canonical `review-body:123`. Without the alias stamp the
    // human: row stays `none` and the settled drain re-arms forever.
    await seedReview("ep-alias-1");
    await seedRegisteredNone("human:123");
    const epoch = makeEpoch({ triggeringSourceIds: ["human:123"], promptedSourceIds: ["review-body:123"] });

    await shadowEmitReviewLoopEpochTerminal(liveEnv(), epoch, "replied");

    const rows = await dispositionsBySourceId();
    expect(rows.get("review-body:123")?.disposition).toBe("replied");
    expect(rows.get("human:123")?.disposition).toBe("replied");
    // The drain fuel is gone: nothing is left undispositioned.
    expect(await listUndispositionedActionable(db, SESSION.sessionId, PR)).toEqual([]);
  });

  it("a never-prompted epoch falling back to its triggering human:<id> stamps both namespace forms", async () => {
    await seedReview("ep-alias-1");
    await seedRegisteredNone("human:456");
    const epoch = makeEpoch({ triggeringSourceIds: ["human:456"], promptedSourceIds: [], lastPromptId: null });

    await shadowEmitReviewLoopEpochTerminal(liveEnv(), epoch, "replied");

    const rows = await dispositionsBySourceId();
    expect(rows.get("review-body:456")?.disposition).toBe("replied");
    expect(rows.get("human:456")?.disposition).toBe("replied");
  });

  it("a declined reply operation's verdict + basis propagate to both namespace rows", async () => {
    await seedReview("ep-alias-1");
    await seedRegisteredNone("human:123");
    const epoch = makeEpoch({ triggeringSourceIds: ["human:123"], promptedSourceIds: ["review-body:123"] });

    const operationId = await buildReviewLoopReplyOperationId({
      epochId: epoch.id,
      headSha: epoch.headSha,
      targetSourceId: "review-body:123",
      opKind: "issue_comment_reply",
    });
    const attempt = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: epoch.id,
      sessionId: SESSION.sessionId,
      promptId: "p-1",
      kind: "reply",
      targetSourceId: "review-body:123",
      headSha: epoch.headSha,
      verdict: "declined",
      verdictBasis: "Not actionable: review body is a summary banner.",
      maxAttempts: 3,
      nowMs: NOW,
    });
    expect(attempt.status).toBe("started");
    await markReviewLoopOperationSucceeded(db, operationId, { githubId: "900", nowMs: NOW, expectedAttempts: 1 });
    await fillSucceededReviewLoopReplyVerdict(db, operationId, {
      verdict: "declined",
      verdictBasis: "Not actionable: review body is a summary banner.",
      nowMs: NOW,
    });

    await shadowEmitReviewLoopEpochTerminal(liveEnv(), epoch, "replied");

    const rows = await dispositionsBySourceId();
    expect(rows.get("review-body:123")?.disposition).toBe("declined");
    expect(rows.get("review-body:123")?.basis).toBe("Not actionable: review body is a summary banner.");
    expect(rows.get("human:123")?.disposition).toBe("declined");
    expect(rows.get("human:123")?.basis).toBe("Not actionable: review body is a summary banner.");
  });

  it("non-submission source ids stamp exactly one row (no alias)", async () => {
    await seedReview("ep-alias-1");
    const epoch = makeEpoch({ triggeringSourceIds: ["review-comment:9"], promptedSourceIds: ["review-comment:9"] });

    await shadowEmitReviewLoopEpochTerminal(liveEnv(), epoch, "replied");

    const rows = await listForPr(db, SESSION.sessionId, PR);
    expect(rows.map((row) => [row.sourceId, row.disposition])).toEqual([["review-comment:9", "replied"]]);
  });
});
