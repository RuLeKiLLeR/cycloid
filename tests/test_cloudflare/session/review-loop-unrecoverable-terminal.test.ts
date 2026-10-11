import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  bootstrapReviewLoopEpochForHuman,
  claimReviewLoopEpochForPrompt,
  getReviewLoopEpochById,
  markReviewLoopEpochEnqueued,
  markReviewLoopEpochProcessing,
} from "../../../apps/control-plane-worker/src/services/review-loop-epochs.ts";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis.ts";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db.ts";
import { SqliteD1 } from "../sqlite-d1-helper.ts";
import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const sideEffects = vi.hoisted(() => ({
  syncFsmLabelsForPr: vi.fn(async () => ({ added: [], removed: [] })),
  notifyUserBlocked: vi.fn(async () => undefined),
  postInternalAlert: vi.fn(async () => undefined),
}));

vi.mock("../../../apps/control-plane-worker/src/services/fsm-label-sync.ts", () => ({
  syncFsmLabelsForPr: sideEffects.syncFsmLabelsForPr,
}));
vi.mock("../../../apps/control-plane-worker/src/session/notify-user-blocked.ts", () => ({
  notifyUserBlocked: sideEffects.notifyUserBlocked,
}));
vi.mock("../../../apps/control-plane-worker/src/slack/internal-alerts.ts", () => ({
  postInternalAlert: sideEffects.postInternalAlert,
}));

mockCloudflareWorkers();
mockSentryCloudflare();

const NOW = 1_700_000_000_000;
const SESSION_ID = "session-runtime-unrecoverable";
const PROMPT_ID = "prompt-runtime-unrecoverable";
const PR_URL = "https://github.com/acme/repo/pull/402";
const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

interface SessionDoTestHandle {
  completeActivePrompt(
    sessionId: string,
    completion: { success: false; error: string; errorCode: "codex_unrecoverable" },
    expectedPromptId: string,
    completionSource: "execution_complete",
  ): Promise<void>;
}

function migratedD1(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return { db: new SqliteD1(sqlite) as unknown as D1Database, sqlite };
}

describe("SessionDO unrecoverable review-loop terminal wiring", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  it("blocks the prompt-owned epoch and clears the lifecycle in-flight marker", async () => {
    const { db, sqlite } = migratedD1();
    sqlite.prepare("INSERT INTO businesses (id, name, created_at) VALUES (?, ?, ?)").run("biz-1", "Test", NOW);
    sqlite
      .prepare(
        "INSERT INTO users (id, github_id, login, business_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(1, 1001, "test-user", "biz-1", NOW, NOW);
    sqlite
      .prepare(
        "INSERT INTO session_index (session_id, owner_user_id, status, created_at, updated_at, business_id, rich_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(SESSION_ID, 1, "active", NOW, NOW, "biz-1", "running");

    const epoch = await bootstrapReviewLoopEpochForHuman(db, {
      sessionId: SESSION_ID,
      ownerUserId: 1,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 402,
      prUrl: PR_URL,
      headSha: "head-1",
      triggeringSourceId: "human:4001",
      nowMs: NOW,
    });
    const claimed = await claimReviewLoopEpochForPrompt(db, epoch.id, { leaseOwner: "worker-a", nowMs: NOW + 1 });
    await markReviewLoopEpochEnqueued(db, epoch.id, {
      promptId: PROMPT_ID,
      worklistHash: "worklist-1",
      nowMs: NOW + 2,
      expectedReservationToken: claimed?.reservationToken ?? null,
    });
    await markReviewLoopEpochProcessing(db, epoch.id, { promptId: PROMPT_ID, nowMs: NOW + 3 });
    await insertPrCoordination(db, {
      ...buildGenesisRecord(SESSION_ID, NOW),
      state: "REVIEW",
      prUrl: PR_URL,
      headSha: "head-1",
      inFlightEpochId: epoch.id,
    });

    const state = createFakeState();
    const sessionState = {
      sessionId: SESSION_ID,
      ownerUserId: "1",
      businessId: "biz-1",
      status: "active",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      closedAt: null,
      lastEventId: null,
      title: null,
      repoOwner: "acme",
      repoName: "repo",
    };
    const env = {
      DB: db,
      WORKER_ENV: "test",
      SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
      LOG_LEVEL: "error",
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () =>
            new Response(JSON.stringify({ session: sessionState }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      },
    };
    const agent = new SessionDO(state as never, env as never) as unknown as SessionDoTestHandle;
    seedSession(state.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1",
      businessId: "biz-1",
      status: "active",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: PR_URL,
      prNumber: 402,
    });
    seedSandboxState(state.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(state.storage, {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      promptText: "Address review feedback",
      status: "processing",
      startedAt: NOW,
      reviewLoopEpochId: epoch.id,
      reviewLoopSourceKind: "human",
    });
    await state.storage.put("events", []);
    await state.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    await agent.completeActivePrompt(
      SESSION_ID,
      { success: false, error: "rollout cannot be resumed", errorCode: "codex_unrecoverable" },
      PROMPT_ID,
      "execution_complete",
    );
    await state.flushWaitUntil();

    const storedEpoch = await getReviewLoopEpochById(db, epoch.id);
    expect(storedEpoch?.status).toBe("blocked");
    expect(storedEpoch?.blockedReason).toBe("runtime_unrecoverable");

    const coordination = await getPrCoordination(db, SESSION_ID);
    expect(coordination?.state).toBe("NEEDS_YOU");
    expect(coordination?.blockedReason).toBe("review_response_failed");
    expect(coordination?.inFlightEpochId).toBeNull();

    sqlite.close();
  });
});
