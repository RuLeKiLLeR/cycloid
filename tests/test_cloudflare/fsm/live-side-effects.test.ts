// ARC-1330 (PR 46, the 4a writer flip) — the LIVE side-effect sink + real worklist sink.
//
// Proves the flip-slice contracts: the mode-check kill-switch (live executes exactly once; off/shadow
// are byte-identical to the noop sink; flipping back mid-stream reverts cleanly), exactly-once under a
// CAS race (only the winner's bag dispatches), the per-kind idempotency anchors (dispatch_epoch keyed
// on the committed in_flight_epoch_id; spawn_verification_child on the per-head request claim), failure
// isolation (one throwing executor never blocks the others, never rolls back the CAS), the fail-loud
// write path (a worklist/append failure surfaces while the CAS row stays committed), the structured
// skip events for the intentionally-inert kinds, the waitUntil hot-path seam, and the three flip-time
// backfill bug classes driven end-to-end through applyEvent.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SMOKE_TEST_REPO_NAME,
  SMOKE_TEST_REPO_OWNER,
} from "../../../apps/control-plane-worker/src/constants/smoke-test";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../../../apps/control-plane-worker/src/constants/verification";
import {
  applyEvent,
  type ApplyEventDeps,
  type FsmGuardResolver,
  type FsmSideEffectSink,
  noopWorklistSink,
  type SideEffectDispatch,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { buildBackfillRecord } from "../../../apps/control-plane-worker/src/session/fsm/backfill";
import { buildLiveGuardResolver } from "../../../apps/control-plane-worker/src/session/fsm/live-resolver";
import {
  buildLiveSideEffectSink,
  buildLiveWorklistSink,
  classifyLoudSlackSuppression,
  combineSideEffectSinks,
  D17_TERMINAL_REDELIVERY_WINDOW_MS,
  liveFsmSinks,
  type LiveSideEffectExecutor,
  repairStateDerivedSideEffects,
} from "../../../apps/control-plane-worker/src/session/fsm/live-side-effects";
import type { Guards } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent, FsmRecord, SideEffectKind } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import {
  listForPr,
  upsertDisposition,
} from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import type { Env, SessionState } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

// The live sink's real executors reach the session DO + the verification scheduler; both are mocked
// module-wide (the repo's vi.hoisted pattern) so the default executors are drivable without a DO
// harness. Each mock is re-armed per test.
const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  closeSessionState: vi.fn(),
  syncSessionProjection: vi.fn(async () => {}),
  syncFsmLabelsForPr: vi.fn(async () => ({ added: [], removed: [] })),
  scheduleAutoVerification: vi.fn(),
  findActiveVerificationSession: vi.fn(),
  notifyUserBlocked: vi.fn(),
  postInternalAlert: vi.fn(),
  emitReviewLoopSettledEvent: vi.fn(),
  shadowEmitVerificationOutcome: vi.fn(async () => {}),
  createInstallationToken: vi.fn(async () => "ghs-token"),
  removeLabel: vi.fn(async () => {}),
}));
const mockGetSessionState = mocks.getSessionState;
const mockCloseSessionState = mocks.closeSessionState;
const mockSyncSessionProjection = mocks.syncSessionProjection;
const mockSyncFsmLabelsForPr = mocks.syncFsmLabelsForPr;
const mockScheduleAutoVerification = mocks.scheduleAutoVerification;
const mockFindActiveVerificationSession = mocks.findActiveVerificationSession;
const mockNotifyUserBlocked = mocks.notifyUserBlocked;
const mockPostInternalAlert = mocks.postInternalAlert;
const mockEmitReviewLoopSettledEvent = mocks.emitReviewLoopSettledEvent;
const mockShadowEmitVerificationOutcome = mocks.shadowEmitVerificationOutcome;
const mockCreateInstallationToken = mocks.createInstallationToken;
const mockRemoveLabel = mocks.removeLabel;

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
  closeSessionState: mocks.closeSessionState,
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: mocks.syncSessionProjection,
}));

// The transition-driven canonical label reconcile (W11) reuses the canonical writer; mock it so the
// sink-level tests assert the DISPATCH decision (called/not-called + pr context) without a GitHub write.
vi.mock("../../../apps/control-plane-worker/src/services/fsm-label-sync", () => ({
  syncFsmLabelsForPr: mocks.syncFsmLabelsForPr,
}));

// W11-V3(a): the executor now inlines the spawn via `verification-spawn.ts` (the FSM-owned destination —
// `verification-auto-scheduler.ts` is a dead-under-live compat re-export removed by D-50A). The mock moves
// with the import.
vi.mock("../../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: mocks.scheduleAutoVerification,
}));

// W11-V3(a): schedule_failed now drives a run-scoped `verification.failed` → NEEDS_YOU follow-up
// (committed-before-side-effects) instead of throwing. Spy the producer to assert the terminalization.
vi.mock("../../../apps/control-plane-worker/src/session/fsm/verification-producer", () => ({
  shadowEmitVerificationOutcome: mocks.shadowEmitVerificationOutcome,
}));

vi.mock("../../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: mocks.notifyUserBlocked,
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: mocks.createInstallationToken,
}));

vi.mock("../../../apps/control-plane-worker/src/github/pr", () => ({
  removeLabel: mocks.removeLabel,
}));

vi.mock("../../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: mocks.postInternalAlert,
}));

vi.mock("../../../apps/control-plane-worker/src/observability/review-loop-events", () => ({
  emitReviewLoopSettledEvent: mocks.emitReviewLoopSettledEvent,
}));

// The live-verifier advisory gate the duplicate-claim disambiguation consults (the scheduler-db DAO
// stays REAL against the migrated sqlite so the stale-claim release is proven on the actual store).
vi.mock("../../../apps/control-plane-worker/src/session/verification-gate", () => ({
  findActiveVerificationSession: mocks.findActiveVerificationSession,
}));

// B4 (ARC-1330 Phase B): the dispatch_epoch executor drives the extracted orchestration on arrival.
// Mock it so the executor's create + dispatch decision is provable without a GitHub/DO harness;
// createFsmDispatchedReviewLoopEpoch / getReviewLoopEpochById stay REAL against the migrated sqlite.
const mockDispatchReviewLoopEpoch = vi.hoisted(() => vi.fn(async () => "enqueued"));
vi.mock("../../../apps/control-plane-worker/src/services/review-loop-sweep", () => ({
  dispatchReviewLoopEpoch: (...args: unknown[]) => mockDispatchReviewLoopEpoch(...args),
}));

// R4: the terminate_runtime executor reads the session's runtime projection then drives the DO
// cleanup-run. Mock the projection read + the DO call so the executor's dispatch decision is provable
// without a session_index seed or a DO harness. `importOriginal` keeps every OTHER db/cleanup export real
// (feed-delta uses `../db`; the audit uses cleanup's exported grace constant).
const mockGetSessionIndexRuntimeProjection = vi.hoisted(() => vi.fn());
const mockRunE2BRuntimeCleanupViaSessionDO = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, outcome: "cleared", reasonCode: "terminated" })),
);
vi.mock("../../../apps/control-plane-worker/src/session/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../apps/control-plane-worker/src/session/db")>()),
  getSessionIndexRuntimeProjection: (...args: unknown[]) => mockGetSessionIndexRuntimeProjection(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/session/cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../apps/control-plane-worker/src/session/cleanup")>()),
  runE2BRuntimeCleanupViaSessionDO: (...args: unknown[]) => mockRunE2BRuntimeCleanupViaSessionDO(...args),
}));

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

const SID = "sess-live-1";
const PR_URL = "https://github.com/x/y/pull/1";
const NOW = 1_700_000_020_000;

function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "CREATED",
    prUrl: null,
    headSha: null,
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: true,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: NOW - 5_000,
    ...overrides,
  };
}

/** A committed dispatch fixture the sink-level tests drive directly (no applyEvent needed). */
function buildDispatch(overrides: Partial<SideEffectDispatch> = {}): SideEffectDispatch {
  return {
    mode: "live",
    sessionId: SID,
    version: 1,
    from: "REVIEW",
    to: "REVIEW",
    event: { type: "ci.signal", ciState: "green" },
    sideEffects: [],
    resultingRecord: buildRecord({ state: "REVIEW", version: 1, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
    ...overrides,
  };
}

function makeResolver(guards: (rec: FsmRecord, event: FsmEvent) => Guards): FsmGuardResolver {
  return {
    guards,
    resetContext: () => ({ ciGreen: false, noInflightEpoch: true }),
    caughtUpInputs: () => ({
      noInflightEpoch: true,
      store: { countUndispositionedActionable: () => 1 },
    }),
    deadlineMs: () => null,
  };
}

// WORKER_ENV is "production" so the loud executor's Slack fanout (gated by
// `classifyLoudSlackSuppression` — non-prod sends nothing) still exercises the posting path these
// sink-level tests assert; the suppression tests override it per-case.
const ENV = { DD_API_KEY: undefined, WORKER_ENV: "production" } as unknown as Env;

function envWithDb(db: D1Database): Env {
  return { ...ENV, DB: db } as Env;
}

/** Spy executors for every kind — nothing real runs; each records `${kind}@v${version}`. */
function spyExecutors(calls: string[]): Record<SideEffectKind, LiveSideEffectExecutor> {
  const kinds: SideEffectKind[] = [
    "spawn_sandbox",
    "dispatch_prompt",
    "open_pr",
    "kill_verification",
    "terminate_runtime",
    "spawn_verification_child",
    "dispatch_epoch",
    "disposition",
    "resolve_owned_threads",
    "release_queued_reviews",
    "emit_settle",
    "notify_user",
    "loud",
    "emit_cap_trip",
    "project",
    "log_noop",
  ];
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      async (ctx: { dispatch: SideEffectDispatch }) => {
        calls.push(`${kind}@v${ctx.dispatch.version}`);
      },
    ]),
  ) as Record<SideEffectKind, LiveSideEffectExecutor>;
}

beforeEach(() => {
  mockGetSessionState.mockReset();
  mockCloseSessionState.mockReset();
  mockSyncSessionProjection.mockReset().mockResolvedValue(undefined);
  mockSyncFsmLabelsForPr.mockReset().mockResolvedValue({ added: [], removed: [] });
  mockScheduleAutoVerification.mockReset();
  mockFindActiveVerificationSession.mockReset().mockResolvedValue(null);
  mockNotifyUserBlocked.mockReset().mockResolvedValue("sent");
  mockPostInternalAlert.mockReset().mockResolvedValue({ ok: true, ts: "1.2", channel: "C_REVIEW" });
  mockEmitReviewLoopSettledEvent.mockReset().mockResolvedValue(undefined);
  mockShadowEmitVerificationOutcome.mockReset().mockResolvedValue(undefined);
  mockCreateInstallationToken.mockReset().mockResolvedValue("ghs-token");
  mockRemoveLabel.mockReset().mockResolvedValue(undefined);
  mockGetSessionIndexRuntimeProjection.mockReset();
  mockRunE2BRuntimeCleanupViaSessionDO
    .mockReset()
    .mockResolvedValue({ ok: true, outcome: "cleared", reasonCode: "terminated" });
});

// ── 1. Executes each effect exactly once ───────────────────────────────────────

describe("PR 46 — the live sink executes each effect exactly once", () => {
  it("runs each effect in the bag exactly once", async () => {
    const calls: string[] = [];
    const sink = buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) });
    const bag = buildDispatch({ sideEffects: [{ kind: "emit_settle" }, { kind: "project" }] });

    await sink.dispatch(bag);
    expect(calls).toEqual(["emit_settle@v1", "project@v1"]);
  });
});

// ── 2. Exactly-once under a CAS race ──────────────────────────────────────────

describe("PR 46 — exactly-once under the CAS race (only the winner's bag dispatches)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("a lost CAS attempt dispatches nothing; the re-evaluated winner dispatches once at its version", async () => {
    await insertPrCoordination(db, buildRecord());
    const calls: string[] = [];
    let bumped = false;
    const resolver = makeResolver(() => {
      if (!bumped) {
        bumped = true;
        // A concurrent writer wins the race between the read and the CAS (the loser re-reads, §8).
        sqlite.prepare("UPDATE pr_coordination SET version = version + 1 WHERE session_id = ?").run(SID);
      }
      return { sandboxAlive: true };
    });
    const deps: ApplyEventDeps = {
      db,
      env: ENV,
      mode: "live",
      now: () => NOW,
      resolver,
      emit: vi.fn(async () => true),
      sideEffects: buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) }),
      worklist: noopWorklistSink,
    };

    const result = await applyEvent(deps, {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    // Interloper bumped 0→1; the winner committed 1→2 — and ONLY its bag dispatched, keyed to v2.
    expect(result).toEqual({ outcome: "handled", from: "CREATED", to: "PROVISIONING", version: 2 });
    expect(calls.filter((c) => c.startsWith("spawn_sandbox"))).toEqual(["spawn_sandbox@v2"]);
  });
});

// ── 3. Idempotency anchors ────────────────────────────────────────────────────

describe("W11-V5 — dispatch_epoch creation authority (keyed on the committed in_flight_epoch_id)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      businessId: "biz-1",
      status: "active",
      repoOwner: "x",
      repoName: "y",
      installationId: 42,
    } as SessionState);
    mockDispatchReviewLoopEpoch.mockReset().mockResolvedValue("enqueued");
  });

  function insertEpochRow(id: string, sourceIds: string[] = []): void {
    sqlite
      .prepare(
        `INSERT INTO pr_review_response_epochs (
           id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha,
           expected_bots_hash, expected_bots_json, expected_bot_keys_json,
           handled_source_ids_json, triggering_source_ids_json,
           first_activity_at, fallback_after_at, status, source_kind, created_at, updated_at
         ) VALUES (?, ?, 1, 'x', 'y', 1, ?, 'h1', 'hash', '[]', '[]', ?, ?, ?, ?, 'ready', 'mixed', ?, ?)`,
      )
      .run(id, SID, PR_URL, JSON.stringify(sourceIds), JSON.stringify(sourceIds), NOW, NOW, NOW, NOW);
  }

  function insertCiEpochRow(
    id: string,
    sourceIds: string[] = [],
    options: { wave?: number; status?: "completed" | "processing" } = {},
  ): void {
    const { wave = 1, status = "completed" } = options;
    sqlite
      .prepare(
        `INSERT INTO pr_review_response_epochs (
           id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
           expected_bots_hash, expected_bots_json, expected_bot_keys_json,
           handled_source_ids_json, triggering_source_ids_json, prompted_source_ids_json,
           first_activity_at, fallback_after_at, status, source_kind, last_prompt_id, created_at, updated_at
         ) VALUES (?, ?, 7, 'x', 'y', 1, ?, 'h1', ?, 'ci-fixes', '[]', '[]', ?, ?, ?, ?, ?, ?, 'ci', 'p-2', ?, ?)`,
      )
      .run(
        id,
        SID,
        PR_URL,
        wave,
        JSON.stringify(sourceIds),
        JSON.stringify(sourceIds),
        JSON.stringify(sourceIds),
        NOW - 1_000,
        NOW - 1_000,
        status,
        NOW - 1_000,
        NOW - 1_000,
      );
  }

  function registerActionable(sourceId: string): void {
    sqlite
      .prepare(
        `INSERT INTO pr_review_item_dispositions (session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at)
         VALUES (?, ?, ?, 'none', NULL, NULL, ?, ?)`,
      )
      .run(SID, PR_URL, sourceId, NOW, NOW);
  }

  function countEpochsWithId(id: string): number {
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM pr_review_response_epochs WHERE id = ?`).get(id) as {
      n: number;
    };
    return row.n;
  }

  function reviewDispatch(inFlightEpochId: string, version = 1): SideEffectDispatch {
    return buildDispatch({
      version,
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "review" } }],
      resultingRecord: buildRecord({
        state: "REVIEW",
        version,
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId,
      }) as FsmRecord,
    });
  }

  it("dispatches the existing epoch on arrival (webhook_arrival) — the §17-B anchor binds by-id, no new row", async () => {
    // Wave-11 authority + B4 teeth: an already-materialized id (legacy-threaded / prior FSM pass /
    // redelivery) is DRIVEN on the arrival turn instead of no-op'd. The by-id exists-check still
    // prevents a second row; the claim-CAS inside the (mocked) orchestration is the real dedupe.
    insertEpochRow("epoch-committed-1");
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(reviewDispatch("epoch-committed-1"));

    expect(countEpochsWithId("epoch-committed-1")).toBe(1);
    expect(mockDispatchReviewLoopEpoch).toHaveBeenCalledTimes(1);
    const [, epochArg, optsArg] = mockDispatchReviewLoopEpoch.mock.calls[0] as [
      unknown,
      { id: string },
      { trigger: string },
    ];
    expect(epochArg.id).toBe("epoch-committed-1");
    // Collect window left intact (no bypass): a `ready` epoch claims immediately inside the orchestration.
    expect(optsArg).toMatchObject({ trigger: "webhook_arrival" });
    expect(emit.mock.calls.map((c) => c[1])).toContainEqual(
      expect.objectContaining({ event: "fsm.sideeffect.epoch_dispatched", result: "enqueued" }),
    );
  });

  it("CREATES the epoch keyed on the committed id (worklist traced to the disposition store) and dispatches it on arrival", async () => {
    registerActionable("review-1");
    registerActionable("review-2");
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(reviewDispatch("epoch-sess-live-1-2"));

    // A row now exists under the COMMITTED id, carrying exactly the traced sources.
    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(1);
    const row = sqlite
      .prepare(`SELECT triggering_source_ids_json, status, source_kind FROM pr_review_response_epochs WHERE id = ?`)
      .get("epoch-sess-live-1-2") as { triggering_source_ids_json: string; status: string; source_kind: string };
    expect(JSON.parse(row.triggering_source_ids_json).sort()).toEqual(["review-1", "review-2"]);
    expect(row.status).toBe("ready");
    expect(row.source_kind).toBe("mixed");
    // B4 teeth: the freshly-created row is dispatched in-turn (not left for the 1-min cron).
    const [, createdArg, optsArg] = mockDispatchReviewLoopEpoch.mock.calls.at(-1) as [
      unknown,
      { id: string },
      { trigger: string },
    ];
    expect(createdArg.id).toBe("epoch-sess-live-1-2");
    expect(optsArg).toMatchObject({ trigger: "webhook_arrival" });
    expect(emit.mock.calls.map((c) => c[1])).toContainEqual(
      expect.objectContaining({ event: "fsm.sideeffect.epoch_dispatched", result: "enqueued" }),
    );
  });

  it("a retried/redelivered dispatch NEVER double-creates (§17-B anchor)", async () => {
    registerActionable("review-1");
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    // Two identical dispatches for the SAME committed id (the D17 redelivery scenario).
    await sink.dispatch(reviewDispatch("epoch-sess-live-1-2"));
    await sink.dispatch(reviewDispatch("epoch-sess-live-1-2"));

    // Exactly ONE row: the first pass creates, the second binds via the by-id exists-check.
    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(1);
    // Both passes reach dispatch (create-path then existing-path); the claim-CAS inside the mocked
    // orchestration is the real double-drive guard (proven in the sweep tests).
    expect(mockDispatchReviewLoopEpoch).toHaveBeenCalledTimes(2);
  });

  it("flag OFF (REVIEW_LOOP_IMMEDIATE_DISPATCH=off): an existing row → no dispatch (reverts to the cron)", async () => {
    insertEpochRow("epoch-committed-1");
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink({ ...envWithDb(db), REVIEW_LOOP_IMMEDIATE_DISPATCH: "off" } as Env, { emit });

    await sink.dispatch(reviewDispatch("epoch-committed-1"));

    expect(mockDispatchReviewLoopEpoch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(countEpochsWithId("epoch-committed-1")).toBe(1);
  });

  it("flag OFF: a review trigger still CREATES the row but does NOT dispatch it (Wave-11 create-only + cron)", async () => {
    registerActionable("review-1");
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink({ ...envWithDb(db), REVIEW_LOOP_IMMEDIATE_DISPATCH: "off" } as Env, { emit });

    await sink.dispatch(reviewDispatch("epoch-sess-live-1-2"));

    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(1); // created
    expect(mockDispatchReviewLoopEpoch).not.toHaveBeenCalled(); // but not dispatched — the cron picks it up
  });

  it("REFUSES to create when the PR number is unparseable — skip, never a pr_number=0 row (Greptile P2 #6422)", async () => {
    registerActionable("review-1");
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1", inFlightEpochId: "epoch-sess-live-1-2" }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    const dispatch = reviewDispatch("epoch-sess-live-1-2");
    (dispatch.resultingRecord as { prUrl: string }).prUrl = "https://github.com/x/y/pulls?q=is%3Aopen";
    await sink.dispatch(dispatch);

    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "dispatch_epoch",
      reason: "unparseable_pr_number",
    });
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBe("epoch-sess-live-1-2");
  });

  it("settles a bare trigger — no disposition items → no fabricated evidence and marker clears", async () => {
    // No disposition items registered: creating would fabricate review evidence (the PR 46 objection).
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1", inFlightEpochId: "epoch-sess-live-1-2" }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(reviewDispatch("epoch-sess-live-1-2"));

    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(0);
    expect(emit.mock.calls.map((c) => c[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "no_disposition_items_bare_trigger",
      }),
    );
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBeNull();
  });

  it("preserves the marker when zero disposition items came from a failed worklist registration", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1", inFlightEpochId: "epoch-sess-live-1-2" }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch({ ...reviewDispatch("epoch-sess-live-1-2"), worklistFailed: true });

    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(0);
    expect(emit.mock.calls.map((c) => c[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "worklist_registration_failed_marker_preserved",
      }),
    );
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBe("epoch-sess-live-1-2");
  });

  it("does not let a stale settlement clear a newer in-flight marker", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1", inFlightEpochId: "epoch-new" }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(reviewDispatch("epoch-old"));

    expect(countEpochsWithId("epoch-old")).toBe(0);
    expect(emit.mock.calls.map((c) => c[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "stale_settle_marker",
      }),
    );
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBe("epoch-new");
  });

  it("settles against a legacy epoch that already covers the sources — no double-drive and marker clears", async () => {
    registerActionable("review-1");
    insertEpochRow("legacy-epoch-uuid", ["review-1"]); // legacy already owns this source (parallel fallback)
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1", inFlightEpochId: "epoch-sess-live-1-2" }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(reviewDispatch("epoch-sess-live-1-2"));

    // No new FSM row — legacy's epoch drives this source; the FSM must not double-create.
    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(0);
    expect(emit.mock.calls.map((c) => c[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "disposition_items_already_epoched",
      }),
    );
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBeNull();
  });

  it("settlement recomputes and redispatches work that becomes uncovered after the initial skip", async () => {
    registerActionable("review-1");
    insertEpochRow("legacy-epoch-uuid", ["review-1"]);
    await insertPrCoordination(
      db,
      buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1", inFlightEpochId: "epoch-settling-old" }),
    );
    const emit = vi.fn(async (_env: Env, event: Record<string, unknown>) => {
      if (event.event === "fsm.sideeffect.skipped" && event.reason === "disposition_items_already_epoched") {
        registerActionable("review-2");
      }
      return true;
    });
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(reviewDispatch("epoch-settling-old"));

    const rec = await getPrCoordination(db, SID);
    expect(rec?.inFlightEpochId).toMatch(/^epoch-sess-live-/);
    expect(rec?.inFlightEpochId).not.toBe("epoch-settling-old");
    expect(countEpochsWithId(rec?.inFlightEpochId ?? "")).toBe(1);
    const row = sqlite
      .prepare(`SELECT triggering_source_ids_json FROM pr_review_response_epochs WHERE id = ?`)
      .get(rec?.inFlightEpochId) as { triggering_source_ids_json: string };
    expect(JSON.parse(row.triggering_source_ids_json)).toEqual(["review-2"]);
  });

  it("materializes an FSM-requested CI retry from the prior real CI epoch", async () => {
    insertCiEpochRow("legacy-ci-epoch", ["check-run-failure:123"]);
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        version: 3,
        sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }],
        resultingRecord: buildRecord({
          state: "REVIEW",
          version: 3,
          prUrl: PR_URL,
          headSha: "h1",
          inFlightEpochId: "epoch-sess-live-1-2",
        }) as FsmRecord,
      }),
    );

    const retry = sqlite
      .prepare(
        `SELECT status, source_kind, wave, triggering_source_ids_json
         FROM pr_review_response_epochs WHERE id = ?`,
      )
      .get("epoch-sess-live-1-2") as {
      status: string;
      source_kind: string;
      wave: number;
      triggering_source_ids_json: string;
    };
    expect(retry).toMatchObject({ status: "ready", source_kind: "ci", wave: 2 });
    expect(JSON.parse(retry.triggering_source_ids_json)).toEqual(["check-run-failure:123"]);
    expect(mockDispatchReviewLoopEpoch).toHaveBeenCalledTimes(1);
    expect(mockDispatchReviewLoopEpoch.mock.calls[0]?.[1]).toMatchObject({ id: "epoch-sess-live-1-2" });
    expect(emit.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({ event: "fsm.sideeffect.epoch_dispatched", result: "enqueued" }),
    );
  });

  it("does not clone retry provenance from a live CI epoch", async () => {
    insertCiEpochRow("completed-ci-epoch", ["check-run-failure:123"]);
    insertCiEpochRow("live-ci-epoch", ["check-run-failure:123"], { wave: 2, status: "processing" });
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 3,
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId: "epoch-sess-live-1-2",
      }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        version: 3,
        sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }],
        resultingRecord: buildRecord({
          state: "REVIEW",
          version: 3,
          prUrl: PR_URL,
          headSha: "h1",
          inFlightEpochId: "epoch-sess-live-1-2",
        }) as FsmRecord,
      }),
    );

    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(0);
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBe("epoch-sess-live-1-2");
    expect(mockDispatchReviewLoopEpoch).not.toHaveBeenCalled();
    expect(emit.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "ci_fix_retry_missing_predecessor",
      }),
    );
  });

  it("preserves a CI retry marker when no prior CI epoch proves the trigger", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        state: "REVIEW",
        version: 3,
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId: "epoch-sess-live-1-2",
      }),
    );
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        version: 3,
        sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }],
        resultingRecord: buildRecord({
          state: "REVIEW",
          version: 3,
          prUrl: PR_URL,
          headSha: "h1",
          inFlightEpochId: "epoch-sess-live-1-2",
        }) as FsmRecord,
      }),
    );

    expect(countEpochsWithId("epoch-sess-live-1-2")).toBe(0);
    expect((await getPrCoordination(db, SID))?.inFlightEpochId).toBe("epoch-sess-live-1-2");
    expect(emit.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "ci_fix_retry_missing_predecessor",
      }),
    );
  });
});

describe("A4 — live app_breaks verdict exit is record-only (retired arm-drain; QA re-intake via comment)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  const HEAD = "h1";
  const RUN_ID = 5;
  const FINDING_ID = `verification:${HEAD}:${RUN_ID}`;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      businessId: "biz-1",
      status: "active",
      repoOwner: "x",
      repoName: "y",
      installationId: 42,
    } as SessionState);
  });

  function countAllEpochs(): number {
    return (sqlite.prepare(`SELECT COUNT(*) AS n FROM pr_review_response_epochs`).get() as { n: number }).n;
  }

  async function applyAppBreaks(): Promise<void> {
    // A quiescent VERIFYING row (entered via the caught_up cascade → no in-flight epoch), fresh active run.
    await insertPrCoordination(
      db,
      buildRecord({
        state: "VERIFYING",
        version: 0,
        prUrl: PR_URL,
        headSha: HEAD,
        verificationRunHead: HEAD,
        verificationRunId: RUN_ID,
        verificationChildId: "child-active",
        verificationRunCount: 1,
        inFlightEpochId: null,
        codeChangedSinceVerification: false,
      }),
    );
    const env = envWithDb(db);
    // The REAL live resolver — A4 threads no finding ids (the arm-drain is retired).
    const resolver = buildLiveGuardResolver(env, SID);
    const deps: ApplyEventDeps = {
      db,
      env,
      mode: "live",
      now: () => NOW,
      resolver,
      emit: vi.fn(async () => true),
      ...liveFsmSinks(env),
    };
    // ONLY the app_breaks verdict is applied — NO external review.received sweeps the finding in.
    await applyEvent(deps, {
      sessionId: SID,
      event: { type: "verification.app_breaks", headSha: HEAD, runId: RUN_ID },
      metadata: { type: "verification.app_breaks", verificationRunId: RUN_ID, verdict: "app_breaks", headSha: HEAD },
      actor: "verification",
    });
  }

  it("app_breaks at live records the verdict → REVIEW with NO injected finding, NO in-flight epoch, and NO epoch created (A4 retired arm-drain)", async () => {
    await applyAppBreaks();

    // (1) A4: NO finding is registered — the disposition store carries no verification:* item. The QA verifier's
    // managed comment (admitted as known:cycloid-qa) is the sole re-intake, not a spine-injected finding.
    const items = await listForPr(db, SID, PR_URL);
    expect(items.find((i) => i.sourceId === FINDING_ID)).toBeUndefined();

    // (2) The record exited VERIFYING → REVIEW, recorded the verdict, and did NOT stamp an in-flight epoch.
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.verdict).toBe("app_breaks");
    expect(rec?.inFlightEpochId).toBeNull();

    // (3) NO epoch is dispatched on the verdict exit (the arm-drain is gone).
    expect(countAllEpochs()).toBe(0);
  });
});

describe("PR 46 — spawn_verification_child rides the per-head idempotency anchor", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const SESSION: SessionState = {
    sessionId: SID,
    ownerUserId: "7",
    businessId: "biz-1",
    status: "active",
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    lastEventId: null,
    title: null,
    repoOwner: "x",
    repoName: "y",
    installationId: 42,
  } as SessionState;

  it("passes the committed head + run-id (the §17-A echo the scheduler now threads, PR 47) on the spawn", async () => {
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "child-1" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    const dispatch = buildDispatch({
      from: "REVIEW",
      to: "VERIFYING",
      event: { type: "caught_up", headSha: "h9" },
      sideEffects: [{ kind: "spawn_verification_child" }],
      resultingRecord: buildRecord({
        state: "VERIFYING",
        version: 4,
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2,
        verificationRunCount: 1,
      }) as FsmRecord,
    });

    await sink.dispatch(dispatch);

    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    const input = mockScheduleAutoVerification.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      parentSessionId: SID,
      ownerUserId: "7",
      prUrl: PR_URL,
      headSha: "h9", // the committed verification_run_head — the per-head anchor key
      // The committed §17-A run token — the scheduler threads it onto the verifier prompt enqueue
      // (see the source-level pin below); the verdict-back echoes it.
      verificationRunId: 2,
    });
    // The sink NEVER touches counts (request_verification already bumped them in the CAS): a scheduled
    // spawn emits no skipped/failed telemetry.
    expect(emit).not.toHaveBeenCalled();
  });

  it("A3: spawns while the committed + live record are in REVIEW (publish-time spawn — the anchor is run-id-keyed, not phase-keyed)", async () => {
    // A1 stamps run 2 + a null child on the publish.pr_opened → REVIEW edge; the record STAYS in REVIEW.
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 4,
        state: "REVIEW",
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2, // child_id NULL = run 2's spawn not yet landed
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-2" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    const dispatch = buildDispatch({
      from: "PUBLISHING",
      to: "REVIEW",
      event: { type: "publish.pr_opened", headSha: "h9" } as never,
      sideEffects: [{ kind: "spawn_verification_child" }],
      resultingRecord: buildRecord({
        sessionId: SID,
        state: "REVIEW",
        version: 4,
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2,
      }) as FsmRecord,
    });

    await sink.dispatch(dispatch);

    // The anchor read run-id 2 == committed run-id 2 with a NULL child → real spawn, then claim-stamp.
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect((await getPrCoordination(db, SID))!.verificationChildId).toBe("verifier-child-2");
    expect(emit).not.toHaveBeenCalled();
  });

  it("A3: a redelivered publish spawn for the SAME run is an idempotent no-op (the run-id fence is the guard)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 4,
        state: "REVIEW",
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2,
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-2" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    const dispatch = buildDispatch({
      from: "PUBLISHING",
      to: "REVIEW",
      event: { type: "publish.pr_opened", headSha: "h9" } as never,
      sideEffects: [{ kind: "spawn_verification_child" }],
      resultingRecord: buildRecord({
        sessionId: SID,
        state: "REVIEW",
        version: 4,
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2,
      }) as FsmRecord,
    });

    // First delivery spawns + stamps run 2's child.
    await sink.dispatch(dispatch);
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);

    // Redelivery of the same publish side effect: the stamped child is still live → already_spawned no-op.
    mockFindActiveVerificationSession.mockResolvedValue({ sessionId: "verifier-child-2" });
    await sink.dispatch(dispatch);
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1); // NOT called a second time
    expect(emit).not.toHaveBeenCalled();
  });

  // ── W11-V4: the FSM-native anchor is the double-spawn boundary (the legacy per-head claim is DROPPED
  // at D-52; the per-PR lock was removed at D-51) ──
  // Each of these inserts a REAL pr_coordination row and mocks the scheduler, with the advisory
  // findActiveVerificationSession blind (null) — proving the committed spine row is the sole dedup.

  /** Build a spawn dispatch owed for `runId` at head `head` against the committed spine. */
  function spawnDispatch(runId: number, head: string, version: number) {
    return buildDispatch({
      from: "REVIEW",
      to: "VERIFYING",
      event: { type: "caught_up", headSha: head },
      sideEffects: [{ kind: "spawn_verification_child" }],
      resultingRecord: buildRecord({
        state: "VERIFYING",
        version,
        prUrl: PR_URL,
        headSha: head,
        verificationRunHead: head,
        verificationRunId: runId,
      }) as FsmRecord,
    });
  }

  it("W11-V4 anchor: a redelivered spawn for an already-stamped run is an idempotent no-op (no legacy claim, no double-spawn)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 4,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2, // child_id NULL = run 2's spawn not yet landed
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-2" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    const dispatch = spawnDispatch(2, "h9", 4);

    // First delivery: anchor reads child NULL → real spawn, claim-stamps the child.
    await sink.dispatch(dispatch);
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect((await getPrCoordination(db, SID))!.verificationChildId).toBe("verifier-child-2");

    // Redelivery of the SAME committed dispatch with the stamped child STILL LIVE: anchor reads
    // child != null + live advisory confirms → idempotent no-op. The scheduler is NOT called again
    // (no second child, no legacy table consulted) and nothing is emitted.
    mockFindActiveVerificationSession.mockResolvedValue({ sessionId: "verifier-child-2" });
    await sink.dispatch(dispatch);
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("W11-V4 anchor: a stamped-but-DEAD verifier does not suppress the D17 re-drive — the redelivery falls through and re-schedules (ChatGPT P1, #6419)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 4,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 2,
        verificationChildId: "verifier-crashed", // stamped, but the child died post-stamp
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockFindActiveVerificationSession.mockResolvedValue(null); // no live verifier anywhere
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-redriven" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(spawnDispatch(2, "h9", 4));

    // The anchor detected the stamp but the advisory says the child is gone → fell through to the
    // scheduler for a genuine re-spawn. The dead child's handle keeps the IS-NULL slot (stamp 0-rows) —
    // kill stays 404-idempotent on it; the re-driven child parks per #6310 if superseded. Same posture
    // as the legacy stopped-verifier rerun.
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect((await getPrCoordination(db, SID))!.verificationChildId).toBe("verifier-crashed");
    expect(emit).not.toHaveBeenCalled();
  });

  it("W11-V4 anchor: a spawn whose run was superseded (version advanced past this head) is skipped, never spawned", async () => {
    // The committed spine advanced to run 3 (a redispatch) before this run-2 spawn is (re)delivered.
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 6,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: 3,
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(spawnDispatch(2, "h9", 4)); // owed for the SUPERSEDED run 2

    expect(mockScheduleAutoVerification).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "spawn_verification_child",
      reason: "verification_run_superseded",
    });
  });

  it("W11-V4 anchor: H→H′→H is disambiguated by run_id — the stale run-2 spawn at head h is skipped; the fresh run-4 spawn at the RETURNED head h really spawns", async () => {
    // Head went h→h′→h; the two visits to head `h` carry DIFFERENT run ids (run 2 then run 4 — each
    // redispatch bumped the monotonic run_id). The legacy `(pr_url, head_sha)` claim was ABA-blind and
    // would conflate them; the run_id anchor cannot.
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 9,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h",
        verificationRunHead: "h",
        verificationRunId: 4, // the RETURN visit's run; child_id NULL
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-return" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    // The stale spawn owed for the FIRST visit to head h (run 2): same head, older run → skipped.
    await sink.dispatch(spawnDispatch(2, "h", 4));
    expect(mockScheduleAutoVerification).not.toHaveBeenCalled();
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ reason: "verification_run_superseded" });

    // The fresh spawn for the RETURN visit (run 4, same head h, child NULL) → really spawns + stamps.
    await sink.dispatch(spawnDispatch(4, "h", 9));
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect((await getPrCoordination(db, SID))!.verificationChildId).toBe("verifier-return");
  });

  // ── The decline taxonomy (keystone fix 3): duplicate = silent dedup; everything else is visible ──
  async function dispatchSpawnWithDecline(reason: string): Promise<ReturnType<typeof vi.fn>> {
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: false, reason });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        sideEffects: [{ kind: "spawn_verification_child" }],
        resultingRecord: buildRecord({
          state: "VERIFYING",
          version: 2,
          prUrl: PR_URL,
          headSha: "h1",
          verificationRunHead: "h1",
        }) as FsmRecord,
      }),
    );
    return emit;
  }

  it("a policy decline (auto_verify_disabled) emits the structured skip (no silent VERIFYING wedge)", async () => {
    const emit = await dispatchSpawnWithDecline("auto_verify_disabled");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "spawn_verification_child",
      reason: "auto_verify_disabled",
    });
  });

  it("verdict_already_settled is a REAL non-execution: emits the skip, not a silent dedup", async () => {
    const emit = await dispatchSpawnWithDecline("verdict_already_settled");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "spawn_verification_child",
      reason: "verdict_already_settled",
    });
  });

  it("active_verification_session_exists is a REAL non-execution: emits the skip, not a silent dedup", async () => {
    const emit = await dispatchSpawnWithDecline("active_verification_session_exists");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "spawn_verification_child",
      reason: "active_verification_session_exists",
    });
  });

  // ── W11-V3(a): schedule_failed no longer THROWS — it terminalizes to NEEDS_YOU (committed-before-side-
  //    effects, the PR 49 pattern) so a persistent infra failure can never wedge VERIFYING / retry forever. ──
  it("schedule_failed drives a run-scoped verification.failed → NEEDS_YOU instead of throwing", async () => {
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: false, reason: "schedule_failed", error: "boom" });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    // The committed VERIFYING row this spawn is owed for — run 5.
    await expect(
      sink.dispatch(
        buildDispatch({
          from: "REVIEW",
          to: "VERIFYING",
          sideEffects: [{ kind: "spawn_verification_child" }],
          resultingRecord: buildRecord({
            state: "VERIFYING",
            version: 2,
            prUrl: PR_URL,
            headSha: "h1",
            verificationRunHead: "h1",
            verificationRunId: 5,
          }) as FsmRecord,
        }),
      ),
    ).resolves.not.toThrow();

    // The run-scoped follow-up terminal: `verification.failed` for the ACTIVE run (5), no head.
    expect(mockShadowEmitVerificationOutcome).toHaveBeenCalledTimes(1);
    expect(mockShadowEmitVerificationOutcome.mock.calls[0][2]).toEqual({
      outcome: "failed",
      runId: 5,
      headSha: null,
    });
    // Dashboard visibility: the cause is named as a distinct skip class (not a silent drop / silent dedup).
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "spawn_verification_child",
      reason: "schedule_failed_terminalized",
    });
  });

  it("schedule_failed AFTER prompt enqueue does NOT terminalize — the child is running; stamp lands, row stays VERIFYING (ChatGPT P2, #6425)", async () => {
    // Post-enqueue bookkeeping fault (request-row update / label sync failed after enqueueSessionPrompt
    // succeeded): the verifier child exists and will return a valid verdict — terminalizing the parent
    // out of VERIFYING would orphan that verdict (run-scoped freshness only settles a VERIFYING run).
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 2,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h1",
        verificationRunHead: "h1",
        verificationRunId: 5, // child_id NULL — the stamp below claims it
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockScheduleAutoVerification.mockResolvedValue({
      scheduled: false,
      reason: "schedule_failed",
      error: "request-row update failed",
      failureStage: "post_enqueue",
      verificationSessionId: "verifier-enqueued-5",
    });
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "VERIFYING",
        sideEffects: [{ kind: "spawn_verification_child" }],
        resultingRecord: buildRecord({
          state: "VERIFYING",
          version: 2,
          prUrl: PR_URL,
          headSha: "h1",
          verificationRunHead: "h1",
          verificationRunId: 5,
        }) as FsmRecord,
      }),
    );

    // NO verification.failed drive — the parent stays in VERIFYING for the child's verdict (or the
    // deadline backstop if the child dies).
    expect(mockShadowEmitVerificationOutcome).not.toHaveBeenCalled();
    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("VERIFYING");
    // The running child's handle is stamped (IS-NULL claim) so kill_verification keeps its teeth.
    expect(rec!.verificationChildId).toBe("verifier-enqueued-5");
    // The cause is named as its own skip class, distinct from the pre-enqueue terminalization.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.skipped",
      kind: "spawn_verification_child",
      reason: "schedule_failed_post_enqueue_child_running",
    });
  });

  it("SOURCE PIN (§17-A, flipped by PR 47): the scheduler CONSUMES verificationRunId (the echo is wired)", () => {
    // PR 47 flipped this pin consciously: the scheduler threads the committed run token onto the
    // verifier prompt enqueue (per-prompt DO storage), the verdict-back echoes it as
    // `VerifierTerminalResult.verificationRunId`, and under live the producer REJECTS a verdict with
    // no echo (self-sourcing is the shadow-only fallback — verification-producer.ts). If the
    // scheduler ever stops reading the parameter again, this pin fails and the echo chain is broken.
    const source = readFileSync(
      resolve(__dirname, "../../../apps/control-plane-worker/src/session/verification-spawn.ts"),
      "utf8",
    );
    const fnStart = source.indexOf("export async function scheduleVerificationForPr");
    expect(fnStart).toBeGreaterThan(0);
    // Declared on the input interface (above the function)…
    expect(source.slice(0, fnStart)).toContain("verificationRunId?: number");
    // …and READ by the body: threaded onto the verifier prompt enqueue (the §17-A carry).
    expect(source.slice(fnStart)).toContain("verificationRunId: input.verificationRunId");
  });

  // A3: the "D17 (PR 49) + W11-V4: SEQUENTIAL redelivery never double-spawns" test was deleted — the D17
  // VERIFYING spawn-redelivery arm is retired (the spawn rides the publish edge; a dropped publish spawn is
  // non-fatal under non-blocking QA). Sequential/concurrent anchor idempotency is still covered by the
  // pr-coordination-db first-writer-wins test + the executor anchor tests above.

  // ── W11-V1: the spawn side-effect stamps verification_child_id (giving kill_verification teeth) ──

  /** Dispatch a real spawn at (run head h9, run id 2) against a committed VERIFYING row at `dbVersion`. */
  async function dispatchSpawnForRun(
    dbVersion: number,
    runId: number,
    dbOverrides: Partial<PrCoordinationRecord> = {},
  ) {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: dbVersion,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h9",
        verificationRunHead: "h9",
        verificationRunId: runId,
        ...dbOverrides,
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "VERIFYING",
        event: { type: "caught_up", headSha: "h9" },
        sideEffects: [{ kind: "spawn_verification_child" }],
        resultingRecord: buildRecord({
          state: "VERIFYING",
          version: 4,
          prUrl: PR_URL,
          headSha: "h9",
          verificationRunHead: "h9",
          verificationRunId: 2, // the run this spawn is for
        }) as FsmRecord,
      }),
    );
  }

  it("W11-V1: a scheduled spawn stamps the child session id onto the committed VERIFYING run WITHOUT minting a transition", async () => {
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-2" });
    await dispatchSpawnForRun(4, 2);

    const rec = await getPrCoordination(db, SID);
    expect(rec!.verificationChildId).toBe("verifier-child-2");
    // The stamp is NOT an applyEvent CAS: it never bumps `version` nor appends a pr_coordination_events
    // row — so it cannot mint a transition or desync the version↔event-log (contract §4 / §15 inv 1).
    expect(rec!.version).toBe(4);
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });

  it("W11-V1: the stamp is run-scoped — a run superseded before the stamp lands never overwrites the newer run's handle", async () => {
    // The DB row already advanced to run id 3 (a redispatch superseded run 2) by the time the late run-2
    // spawn tries to stamp. The stamp guards on verification_run_id=2 → no match → the run-3 handle stands.
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "verifier-run2-late" });
    await dispatchSpawnForRun(6, 3, { verificationChildId: "child-run3" });

    expect((await getPrCoordination(db, SID))!.verificationChildId).toBe("child-run3");
  });

  // A3: the former "W11-V1: the stamp is phase-scoped — a REVIEW record is not stamped" test was deleted.
  // The stamp is no longer phase-gated (the spawn rides the publish edge, so it MUST land on the REVIEW
  // row) — the inverse is now covered by "A3: spawns while the committed + live record are in REVIEW".

  // ── W11-V4: end-to-end proof that the run-scoped reset + anchor compose (the stale-child hazard) ──

  it("W11-V4 end-to-end: an in-VERIFYING head.changed clears the child + redispatches, so the NEW run's spawn is NOT falsely deduped by the prior run's stale child", async () => {
    // The exact hazard the run-scoped reset closes: run 2 already spawned "old-child". A real code change
    // (head.changed) redispatches to run 3, which MUST clear the child so the per-run anchor reads a NULL
    // slot and really spawns run 3's verifier — rather than reading run 2's stale "old-child" as "already
    // spawned" and wedging the session with no verifier for the new head. Drives applyEvent → CAS →
    // post-commit side-effects through the REAL live sink (kill + spawn executors).
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 1,
        state: "VERIFYING",
        prUrl: PR_URL,
        headSha: "h1",
        verificationRunHead: "h1",
        verificationRunId: 2,
        verificationChildId: "old-child",
        verificationRunCount: 1,
      }),
    );
    mockGetSessionState.mockResolvedValue(SESSION);
    mockCloseSessionState.mockResolvedValue(null); // the kill of old-child (idempotent, 404-safe)
    mockScheduleAutoVerification.mockResolvedValue({ scheduled: true, sessionId: "new-child" });
    const emit = vi.fn(async () => true);
    const resolver = makeResolver((rec) => ({
      sandboxAlive: true,
      verificationRunId: rec.verificationRunId,
      verificationChildId: rec.verificationChildId,
    }));

    const result = await applyEvent(
      {
        db,
        env: envWithDb(db),
        mode: "live",
        now: () => NOW,
        resolver,
        emit: vi.fn(async () => true),
        sideEffects: buildLiveSideEffectSink(envWithDb(db), { emit }),
      },
      { sessionId: SID, event: { type: "head.changed", headSha: "h2" }, actor: "webhook" },
    );

    expect(result).toMatchObject({ outcome: "handled", from: "VERIFYING", to: "VERIFYING" });
    const rec = await getPrCoordination(db, SID);
    // redispatch minted run 3 at the new head and the committed CAS CLEARED the child (W11-V4 reset)…
    expect(rec!.verificationRunId).toBe(3);
    expect(rec!.verificationRunHead).toBe("h2");
    expect(rec!.verificationRunCount).toBe(1); // redispatch never burns a run (B1)
    // …so the post-commit spawn read a NULL slot, really spawned run 3's verifier, and claim-stamped it.
    // (Were the reset missing, the anchor would read "old-child" → skip → the wedge this unit prevents.)
    expect(mockScheduleAutoVerification).toHaveBeenCalledTimes(1);
    expect(rec!.verificationChildId).toBe("new-child");
    // The run-scoped kill tore down the SUPERSEDED run's child (old-child), captured pre-write.
    expect(mockCloseSessionState).toHaveBeenCalledWith(expect.anything(), "old-child", null, expect.anything());
  });
});

describe("PR 46 — kill_verification is idempotent and null-safe", () => {
  it("a null child handle is a logged no-op (a backfilled/never-spawned run, or a stamp that lost the supersession race — W11-V1)", async () => {
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, { emit });
    await sink.dispatch(
      buildDispatch({ sideEffects: [{ kind: "kill_verification", args: { verificationChildId: null } }] }),
    );
    expect(mockCloseSessionState).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled(); // logged no-op, not a skip event
  });

  it("closes a live child through the existing teardown path; an already-gone child (404→null) is a no-op", async () => {
    mockCloseSessionState.mockResolvedValueOnce({ session: {}, replay: null }).mockResolvedValueOnce(null);
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    const bag = buildDispatch({
      sideEffects: [{ kind: "kill_verification", args: { verificationChildId: "child-9" } }],
    });

    await sink.dispatch(bag);
    await sink.dispatch(bag); // redelivery: the child is already closed — idempotent

    expect(mockCloseSessionState).toHaveBeenCalledTimes(2);
    expect(mockCloseSessionState.mock.calls[0][1]).toBe("child-9");
  });
});

// ── 3a. R4 terminate_runtime executor ─────────────────────────────────────────

describe("R4 — terminate_runtime executor drives the DO cleanup-run for a final-terminal session", () => {
  it("reads the runtime projection and dispatches the cleanup-run with reason session_terminal", async () => {
    mockGetSessionIndexRuntimeProjection.mockResolvedValue({ runtimeSandboxId: "vm-1", runtimeBackend: "freestyle" });
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true), now: () => NOW });

    await sink.dispatch(
      buildDispatch({ to: "MERGED", event: { type: "pr.merged" }, sideEffects: [{ kind: "terminate_runtime" }] }),
    );

    expect(mockGetSessionIndexRuntimeProjection).toHaveBeenCalledTimes(1);
    expect(mockRunE2BRuntimeCleanupViaSessionDO).toHaveBeenCalledTimes(1);
    // The executor drives the SAME DO cleanup-run the cron uses, tagged session_terminal, on the
    // session's OWN projected id + backend.
    expect(mockRunE2BRuntimeCleanupViaSessionDO.mock.calls[0][1]).toEqual({
      sessionId: SID,
      projectedRuntimeSandboxId: "vm-1",
      projectedRuntimeBackend: "freestyle",
      reason: "session_terminal",
      nowMs: NOW,
    });
  });

  it("no projected runtime → logged no-op, never calls the cleanup-run (mirrors kill_verification's null path)", async () => {
    mockGetSessionIndexRuntimeProjection.mockResolvedValue(null);
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, { emit });

    await sink.dispatch(buildDispatch({ sideEffects: [{ kind: "terminate_runtime" }] }));

    expect(mockRunE2BRuntimeCleanupViaSessionDO).not.toHaveBeenCalled();
    // A logged no-op, NOT a structured skip event.
    const skipped = emit.mock.calls.filter((c) => (c[1] as { event?: string }).event === "fsm.sideeffect.skipped");
    expect(skipped).toHaveLength(0);
  });

  it("a failing cleanup-run is isolated (emits fsm.sideeffect.failed) and never throws out of the sink", async () => {
    mockGetSessionIndexRuntimeProjection.mockResolvedValue({ runtimeSandboxId: "vm-2", runtimeBackend: "e2b_cloud" });
    mockRunE2BRuntimeCleanupViaSessionDO.mockRejectedValueOnce(new Error("DO 500"));
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, { emit });

    // Must resolve (no throw) even though the DO call rejected.
    await sink.dispatch(buildDispatch({ sideEffects: [{ kind: "terminate_runtime" }] }));

    const failed = emit.mock.calls.filter((c) => (c[1] as { event?: string }).event === "fsm.sideeffect.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ kind: "terminate_runtime" });
  });
});

// ── 3b. Kill-before-spawn bag ordering (keystone fix 4) ───────────────────────

describe("PR 46 — executeBag runs kill_verification to completion BEFORE spawn_verification_child", () => {
  it("orders kill before spawn even when the bag lists spawn first (the VERIFYING head.changed bag)", async () => {
    const order: string[] = [];
    let releaseKill: () => void = () => {};
    const killGate = new Promise<void>((r) => {
      releaseKill = r;
    });
    const sink = buildLiveSideEffectSink(ENV, {
      emit: vi.fn(async () => true),
      executors: {
        kill_verification: async () => {
          order.push("kill:start");
          await killGate;
          order.push("kill:end");
        },
        spawn_verification_child: async () => {
          order.push("spawn:start");
        },
      },
    });

    // The transition builds the bag [kill, spawn] but assert the ordering is the SINK's, not the
    // bag's: list spawn FIRST here and prove kill still completes before spawn starts — a concurrent
    // Promise.all would let the spawn observe the superseded child alive and get declined by the
    // active_verification_session_exists gate (a dropped re-run).
    const done = sink.dispatch(
      buildDispatch({
        from: "VERIFYING",
        to: "VERIFYING",
        event: { type: "head.changed", headSha: "h2" },
        sideEffects: [
          { kind: "spawn_verification_child" },
          { kind: "kill_verification", args: { verificationChildId: "child-1" } },
        ],
      }),
    ) as Promise<void>;

    // Let the microtask queue drain: the spawn must NOT have started while the kill is in flight.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["kill:start"]);

    releaseKill();
    await done;
    expect(order).toEqual(["kill:start", "kill:end", "spawn:start"]);
  });

  it("a FAILED kill is isolated and the spawn still proceeds (the spawn gate then decides)", async () => {
    const order: string[] = [];
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, {
      emit,
      executors: {
        kill_verification: async () => {
          order.push("kill");
          throw new Error("close failed");
        },
        spawn_verification_child: async () => {
          order.push("spawn");
        },
      },
    });

    await sink.dispatch(
      buildDispatch({
        sideEffects: [
          { kind: "kill_verification", args: { verificationChildId: "child-1" } },
          { kind: "spawn_verification_child" },
        ],
      }),
    );

    expect(order).toEqual(["kill", "spawn"]);
    const failed = emit.mock.calls.filter((c) => (c[1] as { event?: string }).event === "fsm.sideeffect.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ kind: "kill_verification" });
  });
});

// ── 4. Failure isolation + the fail-loud write path ───────────────────────────

describe("PR 46 — failure isolation (one throwing executor never blocks the others)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("a throwing executor is isolated, emits fsm.sideeffect.failed, and the CAS commit stands", async () => {
    await insertPrCoordination(db, buildRecord());
    const calls: string[] = [];
    const executors = spyExecutors(calls);
    executors.spawn_sandbox = async () => {
      throw new Error("spawn exploded");
    };
    const emit = vi.fn(async () => true);
    const deps: ApplyEventDeps = {
      db,
      env: ENV,
      mode: "live",
      now: () => NOW,
      resolver: makeResolver(() => ({ sandboxAlive: true })),
      emit: vi.fn(async () => true),
      sideEffects: buildLiveSideEffectSink(ENV, { executors, emit }),
      worklist: noopWorklistSink,
    };

    const result = await applyEvent(deps, {
      sessionId: SID,
      event: { type: "sandbox.spawn_requested" },
      actor: "transport",
    });

    // The spine outcome is unaffected (commit-before-side-effects, never rollback-on-side-effect)…
    expect(result.outcome).toBe("handled");
    expect((await getPrCoordination(db, SID))!.state).toBe("PROVISIONING");
    // …the sibling effect (the universal project post-action) still ran…
    expect(calls).toContain("project@v1");
    // …and the failure surfaced as telemetry.
    const failed = emit.mock.calls.filter((c) => (c[1] as { event?: string }).event === "fsm.sideeffect.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ kind: "spawn_sandbox", session_id: SID, version: 1 });
  });
});

describe("PR 46 — fail-loud write path (worklist/append failures surface; the CAS row stays)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  const reviewGuards = (): Guards => ({
    sandboxAlive: true,
    noInflightEpoch: true,
    newEpochId: "epoch-e1",
    reviewSourceId: "review-src-1",
  });

  it("a worklist sink throw still surfaces — but AFTER the owed side-effects dispatch, with fsm.worklist.failed marked and NO caught_up recompute", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1" }));
    const calls: string[] = [];
    const boom: FsmWorklistSinkLike = {
      commit() {
        throw new Error("disposition store down");
      },
    };
    const transitionEmit = vi.fn(async () => true);
    const caughtUpInputs = vi.fn(() => ({
      noInflightEpoch: true,
      store: { countUndispositionedActionable: () => 0 },
    }));
    const deps: ApplyEventDeps = {
      db,
      env: ENV,
      mode: "live",
      now: () => NOW,
      resolver: { ...makeResolver(reviewGuards), caughtUpInputs },
      emit: transitionEmit,
      worklist: boom,
      sideEffects: buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) }),
    };

    await expect(
      applyEvent(deps, {
        sessionId: SID,
        event: { type: "review.received", reviewerKind: "bot", actionable: true },
        actor: "webhook",
      }),
    ).rejects.toThrow("disposition store down");

    // The CAS row IS committed (state advanced, the epoch id stamped) — fail-loud, not fail-rollback…
    const rec = await getPrCoordination(db, SID);
    expect(rec!.version).toBe(1);
    expect(rec!.inFlightEpochId).toBe("epoch-e1");
    // …and the journal append (which runs BEFORE the worklist, keystone fix 6) IS durable — a
    // worklist failure can no longer leave a committed version with no activity-log row.
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(1);
    // The failure is MARKED: fsm.worklist.failed rides the same best-effort emit seam, alongside
    // the (now still-emitted) fsm.transition event.
    const emitted = transitionEmit.mock.calls.map((c) => (c[1] as { event?: string }).event);
    expect(emitted).toContain("fsm.worklist.failed");
    expect(emitted).toContain("fsm.transition");
    // The committed decision's side-effects are OWED and DISPATCHED (DE-2: the CAS already stamped
    // in_flight_epoch_id — skipping dispatch would wedge the epoch until the D17 cleaner exists).
    expect(calls).toContain("dispatch_epoch@v1");
    // The caught_up recompute — the ONLY consumer endangered by the missing registrations (FG-5) —
    // is SKIPPED for this applyEvent, and the version never advanced past the committed transition.
    expect(caughtUpInputs).not.toHaveBeenCalled();
    expect((await getPrCoordination(db, SID))!.version).toBe(1);
  });

  it("a journal-append failure surfaces BEFORE the worklist commit — row committed, no log row, no registration", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW", prUrl: PR_URL, headSha: "h1" }));
    const calls: string[] = [];
    // Fail exactly the pr_coordination_events INSERT — the step between worklist and side-effects.
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO pr_coordination_events")) {
              throw new Error("event log unavailable");
            }
            return (target as unknown as { prepare: (s: string) => unknown }).prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const deps: ApplyEventDeps = {
      db: failingDb,
      env: ENV,
      mode: "live",
      now: () => NOW,
      resolver: makeResolver(reviewGuards),
      emit: vi.fn(async () => true),
      worklist: buildLiveWorklistSink(envWithDb(db), { now: () => NOW }),
      sideEffects: buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) }),
    };

    await expect(
      applyEvent(deps, {
        sessionId: SID,
        event: { type: "review.received", reviewerKind: "bot", actionable: true },
        actor: "webhook",
      }),
    ).rejects.toThrow("event log unavailable");

    // The CAS row committed (never rolled back)…
    expect((await getPrCoordination(db, SID))!.version).toBe(1);
    // …but the journal-first ordering (keystone fix 6) stops everything downstream: no log row, no
    // worklist registration, no side-effects — the D17 reconciles own repair from committed state.
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
    expect(await listForPr(db, SID, PR_URL)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// A minimal structural alias so the throwing test sink reads clearly (tests are not typechecked).
interface FsmWorklistSinkLike {
  commit(...args: unknown[]): void;
}

// ── 5. The real worklist sink ─────────────────────────────────────────────────

describe("PR 46 — buildLiveWorklistSink (registrations durable, fail-loud)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("persists registrations as undispositioned rows the caught_up store reads", async () => {
    const sink = buildLiveWorklistSink(envWithDb(db), { now: () => NOW });
    await sink.commit(
      SID,
      1,
      [
        { sourceId: "r-1", origin: "review", disposition: "none" },
        { sourceId: "f-1", origin: "findings", disposition: "none" },
      ],
      buildRecord({ state: "REVIEW", prUrl: PR_URL }) as FsmRecord,
    );
    const items = await listForPr(db, SID, PR_URL);
    expect(items.map((i) => [i.sourceId, i.disposition])).toEqual([
      ["f-1", "none"],
      ["r-1", "none"],
    ]);
  });

  it("throws on a registration with no pr_url and writes nothing beyond what already landed", async () => {
    const sink = buildLiveWorklistSink(envWithDb(db), { now: () => NOW });
    await expect(
      sink.commit(
        SID,
        1,
        [{ sourceId: "r-1", origin: "review", disposition: "none" }],
        buildRecord({ state: "REVIEW", prUrl: null }) as FsmRecord,
      ),
    ).rejects.toThrow(/no pr_url/);
  });

  it("re-registration NEVER rewinds a terminal disposition (redelivered review keeps 'fixed')", async () => {
    const sink = buildLiveWorklistSink(envWithDb(db), { now: () => NOW });
    // Register, then the epoch stamps the item fixed (upsertDisposition — the legitimate overwriter)…
    await sink.commit(
      SID,
      1,
      [{ sourceId: "r-1", origin: "review", disposition: "none" }],
      buildRecord({ state: "REVIEW", prUrl: PR_URL }) as FsmRecord,
    );
    await upsertDisposition(
      db,
      { sessionId: SID, prUrl: PR_URL, sourceId: "r-1", disposition: "fixed", epochId: "e1" },
      NOW + 1,
    );
    // …then a webhook redelivery re-registers the SAME source id: the stamp must survive (an
    // unconditional upsert('none') would rewind it and wedge caught_up forever).
    await sink.commit(
      SID,
      2,
      [{ sourceId: "r-1", origin: "review", disposition: "none" }],
      buildRecord({ state: "REVIEW", prUrl: PR_URL }) as FsmRecord,
    );
    const items = await listForPr(db, SID, PR_URL);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceId: "r-1", disposition: "fixed", epochId: "e1" });
  });

  it("throws on a blank sourceId before the batch write — no partial rows land", async () => {
    const sink = buildLiveWorklistSink(envWithDb(db), { now: () => NOW });
    await expect(
      sink.commit(
        SID,
        2,
        [
          { sourceId: "f-1", origin: "findings", disposition: "none" },
          { sourceId: "", origin: "findings", disposition: "none" },
        ],
        buildRecord({ state: "REVIEW", prUrl: PR_URL }) as FsmRecord,
      ),
    ).rejects.toThrow(/blank sourceId/);
    // Validation runs before the single D1 batch, so a bad registration cannot leave a prefix.
    const items = await listForPr(db, SID, PR_URL);
    expect(items).toEqual([]);
  });
});

// ── 6. Inert kinds + telemetry kinds ──────────────────────────────────────────

describe("PR 46 — inert kinds emit fsm.sideeffect.skipped under live (no silent drop)", () => {
  it("every intentionally-inert kind emits exactly one structured skip", async () => {
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, { emit });
    const inertKinds: SideEffectKind[] = [
      "spawn_sandbox",
      "dispatch_prompt",
      "open_pr",
      "disposition",
      "resolve_owned_threads",
      "release_queued_reviews",
      "notify_user",
    ];

    await sink.dispatch(buildDispatch({ sideEffects: inertKinds.map((kind) => ({ kind })) }));

    const skipped = emit.mock.calls
      .map((c) => c[1] as { event?: string; kind?: string })
      .filter((p) => p.event === "fsm.sideeffect.skipped")
      .map((p) => p.kind)
      .sort();
    expect(skipped).toEqual([...inertKinds].sort());
  });

  it("loud fans out to user/internal/DD, emit_settle re-homes review_loop.settled, and cap trips emit DD", async () => {
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      model: "gpt-test",
      callbackContext: { source: "slack", slackTeamId: "T1" },
    } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        event: { type: "caught_up", headSha: "h1" },
        sideEffects: [
          { kind: "loud" },
          { kind: "emit_settle" },
          { kind: "emit_cap_trip", args: { cap: "merge_ready_reopen", limit: 3 } },
        ],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "verification_noconverge",
        }) as FsmRecord,
      }),
    );

    const events = emit.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(events.find((e) => e.event === "fsm.loud")).toMatchObject({
      blocked_reason: "verification_noconverge",
      fsm_event: "caught_up",
      user_notify_result: "sent",
      internal_alert_posted: true,
    });
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: SID,
        ownerUserId: 7,
        kind: "verification_exhausted",
        prUrl: PR_URL,
      }),
    );
    expect(mockPostInternalAlert).toHaveBeenCalledWith(
      expect.anything(),
      "C0BA83SNN1G",
      expect.stringContaining("FSM loud terminal"),
      undefined,
      expect.objectContaining({ sessionId: SID, ownerUserId: "7" }),
    );
    expect(mockEmitReviewLoopSettledEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        finalState: "done",
        scheduleReason: "fsm_merge_ready",
        sessionId: SID,
        prUrl: PR_URL,
      }),
    );
    expect(events.find((e) => e.event === "fsm.settle")).toMatchObject({ session_id: SID });
    expect(events.find((e) => e.event === "fsm.cap_trip")).toMatchObject({ cap: "merge_ready_reopen", limit: 3 });
  });

  it("loud on a pre-PR FAILED terminal (no prUrl) labels the alert with the session repo, not 'unknown repo'", async () => {
    // codegen_error / publish_failed FAILED terminals fire BEFORE a PR is opened, so the committed
    // record has prUrl=null. The header must fall back to the loaded session's repoOwner/repoName
    // rather than the "unknown repo" sentinel — that's the #project-review-loop bug.
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      repoOwner: "acme",
      repoName: "rocket",
    } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "PUBLISHING",
        to: "FAILED",
        event: { type: "prompt.terminal", outcome: "failed" } as unknown as FsmEvent,
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "FAILED",
          version: 1,
          prUrl: null,
          failureReason: "publish_failed",
        }) as FsmRecord,
      }),
    );

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
    const alertText = mockPostInternalAlert.mock.calls[0][2] as string;
    expect(alertText).toContain("acme/rocket");
    expect(alertText).not.toContain("unknown repo");
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "session_failed", ownerUserId: 7 }),
    );
  });

  it("DMs the owner when a manual-review merge is waiting for approval", async () => {
    const db = asD1(createMigratedSqlite());
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7" } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit: vi.fn(async () => true) });

    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        event: { type: "epoch.blocked", epochId: "epoch-1", reason: "owner_approval", trigger: "review" },
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "owner_approval",
        }) as FsmRecord,
      }),
    );

    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "owner_approval", ownerUserId: 7 }),
    );
  });

  it("loud preserves verification-exhausted settle telemetry for verification_run_limit terminals", async () => {
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      model: "gpt-test",
      callbackContext: { source: "slack", slackTeamId: "T1" },
    } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        from: "VERIFYING",
        to: "NEEDS_YOU",
        event: { type: "verification.run_limit", runId: 3 },
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "verification_run_limit",
        }) as FsmRecord,
      }),
    );

    expect(mockEmitReviewLoopSettledEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        finalState: "verification-exhausted",
        scheduleReason: "fsm_verification_exhausted",
        capBlocked: true,
        whichCap: "verification_run",
        sessionId: SID,
        prUrl: PR_URL,
      }),
    );
  });

  it("loud keeps the 'unknown repo' sentinel only when neither the PR URL nor the session knows the repo", async () => {
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7" } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "PUBLISHING",
        to: "FAILED",
        event: { type: "prompt.terminal", outcome: "failed" } as unknown as FsmEvent,
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "FAILED",
          version: 1,
          prUrl: null,
          failureReason: "publish_failed",
        }) as FsmRecord,
      }),
    );

    expect(mockPostInternalAlert.mock.calls[0][2] as string).toContain("unknown repo");
  });

  it("loud on a pre-PR FAILED(spawn_timeout) terminal from deadline_exceeded falls back to session repo", async () => {
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      repoOwner: "acme",
      repoName: "rocket",
    } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "PROVISIONING",
        to: "FAILED",
        event: { type: "deadline_exceeded" } as FsmEvent,
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "FAILED",
          version: 1,
          prUrl: null,
          failureReason: "spawn_timeout",
        }) as FsmRecord,
      }),
    );

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
    const alertText = mockPostInternalAlert.mock.calls[0][2] as string;
    expect(alertText).toContain("acme/rocket");
    expect(alertText).toContain("(spawn_timeout)");
    expect(alertText).not.toContain("unknown repo");
  });

  it("loud on a pre-PR NEEDS_YOU(review_stuck) terminal from deadline_exceeded falls back to session repo", async () => {
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      repoOwner: "acme",
      repoName: "rocket",
    } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        event: { type: "deadline_exceeded" } as FsmEvent,
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: null,
          blockedReason: "review_stuck",
        }) as FsmRecord,
      }),
    );

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
    const alertText = mockPostInternalAlert.mock.calls[0][2] as string;
    expect(alertText).toContain("acme/rocket");
    expect(alertText).toContain("(review_stuck)");
    expect(alertText).not.toContain("unknown repo");
  });

  it("loud on NEEDS_YOU(review_response_failed) DMs the owner with the review_response_failed kind (ARC-1543)", async () => {
    // Regression for ARC-1543: review_response_failed was an unmapped BlockedReason in
    // blockerKindForTerminal, so the epoch.blocked{response_failed} → NEEDS_YOU loud terminal sent
    // no owner DM (unlike its sibling review_stuck). It must now DM like every other mapped blocker.
    const db = asD1(createMigratedSqlite());
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      repoOwner: "acme",
      repoName: "rocket",
    } as SessionState);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });
    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        event: { type: "epoch.blocked", reason: "response_failed" } as FsmEvent,
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "review_response_failed",
        }) as FsmRecord,
      }),
    );

    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: SID,
        ownerUserId: 7,
        kind: "review_response_failed",
        prUrl: PR_URL,
      }),
    );
  });

  it("loud Slack fanout (DM + ops channel) is fully suppressed on a non-production control plane; DD emit survives", async () => {
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7" } as SessionState);
    const sink = buildLiveSideEffectSink({ ...ENV, WORKER_ENV: "local" } as Env, { emit });
    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        event: { type: "caught_up", headSha: "h1" },
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "review_stuck",
        }) as FsmRecord,
      }),
    );
    expect(mockNotifyUserBlocked).not.toHaveBeenCalled();
    expect(mockPostInternalAlert).not.toHaveBeenCalled();
    expect(
      emit.mock.calls.map((c) => c[1] as Record<string, unknown>).find((e) => e.event === "fsm.loud"),
    ).toMatchObject({ slack_suppressed: "non_production" });
  });

  it("loud on a smoke-repo session skips the ops channel but keeps the owner DM", async () => {
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      repoOwner: SMOKE_TEST_REPO_OWNER,
      repoName: SMOKE_TEST_REPO_NAME,
    } as SessionState);
    const sink = buildLiveSideEffectSink(ENV, { emit });
    await sink.dispatch(
      buildDispatch({
        from: "VERIFYING",
        to: "NEEDS_YOU",
        event: { type: "deadline_exceeded" },
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "verification_stopped",
        }) as FsmRecord,
      }),
    );
    expect(mockPostInternalAlert).not.toHaveBeenCalled();
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SID, kind: "verification_exhausted" }),
    );
    expect(
      emit.mock.calls.map((c) => c[1] as Record<string, unknown>).find((e) => e.event === "fsm.loud"),
    ).toMatchObject({ slack_suppressed: "smoke_repo" });
  });

  it("loud fails OPEN for the ops channel when the session cannot be loaded (prod)", async () => {
    const emit = vi.fn(async () => true);
    mockGetSessionState.mockRejectedValue(new Error("DO unavailable"));
    const sink = buildLiveSideEffectSink(ENV, { emit });
    await sink.dispatch(
      buildDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        event: { type: "caught_up", headSha: "h1" },
        sideEffects: [{ kind: "loud" }],
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          blockedReason: "review_stuck",
        }) as FsmRecord,
      }),
    );
    // A spurious page beats a silently missing one — the channel post still goes out.
    expect(mockPostInternalAlert).toHaveBeenCalledWith(
      expect.anything(),
      "C0BA83SNN1G",
      expect.stringContaining("FSM loud terminal"),
      undefined,
      expect.anything(),
    );
  });

  it("classifyLoudSlackSuppression: env gate first, then QA/reviewer role, then smoke repo, else deliver", () => {
    const prod = { WORKER_ENV: "production" } as Env;
    const customer = { agentRole: null, repoOwner: "acme", repoName: "app" } as SessionState;
    expect(classifyLoudSlackSuppression({ WORKER_ENV: "local" } as Env, customer)).toBe("non_production");
    expect(classifyLoudSlackSuppression({ WORKER_ENV: "qa" } as Env, customer)).toBe("non_production");
    expect(classifyLoudSlackSuppression(prod, { ...customer, agentRole: "verification" } as SessionState)).toBe(
      "qa_agent_role",
    );
    expect(classifyLoudSlackSuppression(prod, { ...customer, agentRole: "review" } as SessionState)).toBe(
      "review_agent_role",
    );
    expect(
      classifyLoudSlackSuppression(prod, {
        agentRole: null,
        repoOwner: SMOKE_TEST_REPO_OWNER,
        repoName: SMOKE_TEST_REPO_NAME,
      } as SessionState),
    ).toBe("smoke_repo");
    expect(classifyLoudSlackSuppression(prod, customer)).toBeNull();
    // Session load failure fails OPEN (deliver) — the executor may only prove "internal" positively.
    expect(classifyLoudSlackSuppression(prod, null)).toBeNull();
  });

  it("log_noop executes nothing and emits nothing", async () => {
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, { emit });
    await sink.dispatch(buildDispatch({ sideEffects: [{ kind: "log_noop" }] }));
    expect(emit).not.toHaveBeenCalled();
  });

  it("D17 repair derives committed-but-undelivered effects from state, not an outbox", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-epoch",
        version: 3,
        state: "REVIEW",
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId: "epoch-missing",
        stateEnteredAt: Date.now() - 5_000,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-loud",
        version: 2,
        state: "NEEDS_YOU",
        prUrl: PR_URL,
        headSha: "h1",
        blockedReason: "ci_fix_exhausted",
        // Terminal loud/settle redelivery is recency-bounded (keystone blocker 1/2): only a JUST-entered
        // terminal is eligible; shadow-era history is never re-actioned.
        stateEnteredAt: Date.now() - 5 * 60 * 1000,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-ready",
        version: 5,
        state: "MERGE_READY",
        prUrl: PR_URL,
        headSha: "h1",
        stateEnteredAt: Date.now() - 5 * 60 * 1000,
      }),
    );
    const dispatched: SideEffectDispatch[] = [];
    const emit = vi.fn(async () => true);
    const repair = await repairStateDerivedSideEffects({ ...envWithDb(db), FSM_MODE: "live" } as Env, {
      sideEffects: {
        dispatch(dispatch) {
          dispatched.push(dispatch);
        },
      },
      emit,
    });

    expect(repair).toMatchObject({
      scanned: 3,
      epochDispatchRedelivered: 1,
      loudRedelivered: 1,
      settleRedelivered: 1,
    });
    expect(dispatched).toHaveLength(3);
    expect(
      dispatched.map((dispatch) => [dispatch.sessionId, dispatch.version, dispatch.sideEffects.map((e) => e.kind)]),
    ).toEqual(
      expect.arrayContaining([
        ["sess-loud", 2, ["loud"]],
        ["sess-epoch", 3, ["dispatch_epoch"]],
        ["sess-ready", 5, ["emit_settle"]],
      ]),
    );
    // Each re-driven kind gets ONE `fsm.sideeffect.redelivered` DD event (the flip dashboard's view of
    // what the reconciler re-drove — distinct from the executor's own act/skip event).
    const redelivered = emit.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((event) => event.event === "fsm.sideeffect.redelivered");
    expect(redelivered.map((event) => [event.kind, event.session_id, event.version])).toEqual(
      expect.arrayContaining([
        ["dispatch_epoch", "sess-epoch", 3],
        ["loud", "sess-loud", 2],
        ["emit_settle", "sess-ready", 5],
      ]),
    );
  });

  it("MINOR-4: the D17 epoch repair skips a STALE candidate (fresh re-read mismatch) with repair_candidate_stale", async () => {
    const sqlite = createMigratedSqlite();
    await insertPrCoordination(
      asD1(sqlite),
      buildRecord({
        sessionId: "sess-stale-epoch",
        version: 3,
        state: "REVIEW",
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId: "epoch-A",
        stateEnteredAt: Date.now() - 5_000,
      }),
    );
    // A DB whose committed row MOVES ON (head advances) the instant the repair re-reads it — the
    // candidate-scan snapshot is now stale. Only the getPrCoordination re-read carries `session_id = ?`.
    let mutated = false;
    const db = new (class extends SqliteD1 {
      prepare(query: string) {
        if (!mutated && query.includes("FROM pr_coordination WHERE session_id = ?")) {
          mutated = true;
          sqlite.prepare(`UPDATE pr_coordination SET head_sha = 'h2' WHERE session_id = ?`).run("sess-stale-epoch");
        }
        return super.prepare(query);
      }
    })(sqlite) as unknown as D1Database;

    const dispatched: SideEffectDispatch[] = [];
    const emit = vi.fn(async () => true);
    const repair = await repairStateDerivedSideEffects({ ...envWithDb(db), FSM_MODE: "live" } as Env, {
      sideEffects: {
        dispatch(dispatch) {
          dispatched.push(dispatch);
        },
      },
      emit,
    });

    // The stale gap was NOT re-dispatched — a superseded head would fabricate against the wrong SHA.
    expect(repair.epochDispatchRedelivered).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(emit.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "repair_candidate_stale",
        session_id: "sess-stale-epoch",
      }),
    );
  });

  it("Greptile P1 (#6422): the D17 epoch repair skips a candidate whose fresh state is no longer REVIEW (review_stuck keeps in_flight_epoch_id)", async () => {
    const sqlite = createMigratedSqlite();
    await insertPrCoordination(
      asD1(sqlite),
      buildRecord({
        sessionId: "sess-needsyou-epoch",
        version: 4,
        state: "REVIEW",
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId: "epoch-B",
        stateEnteredAt: Date.now() - 5_000,
      }),
    );
    // The session races REVIEW→NEEDS_YOU(review_stuck) between the candidate scan and the re-read:
    // blocked_reason is written but in_flight_epoch_id and head are UNCHANGED — only the state check
    // catches it. Without it the repair would create+ready an epoch the sweep then prompts against a
    // blocked session.
    let mutated = false;
    const db = new (class extends SqliteD1 {
      prepare(query: string) {
        if (!mutated && query.includes("FROM pr_coordination WHERE session_id = ?")) {
          mutated = true;
          sqlite
            .prepare(
              `UPDATE pr_coordination SET state = 'NEEDS_YOU', blocked_reason = 'review_stuck' WHERE session_id = ?`,
            )
            .run("sess-needsyou-epoch");
        }
        return super.prepare(query);
      }
    })(sqlite) as unknown as D1Database;

    const dispatched: SideEffectDispatch[] = [];
    const emit = vi.fn(async () => true);
    const repair = await repairStateDerivedSideEffects({ ...envWithDb(db), FSM_MODE: "live" } as Env, {
      sideEffects: {
        dispatch(dispatch) {
          dispatched.push(dispatch);
        },
      },
      emit,
    });

    expect(repair.epochDispatchRedelivered).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(emit.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "repair_candidate_stale",
        session_id: "sess-needsyou-epoch",
      }),
    );
  });

  it("skips D17 repair when residual CI rounds make the missing marker's trigger ambiguous", async () => {
    const sqlite = createMigratedSqlite();
    await insertPrCoordination(
      asD1(sqlite),
      buildRecord({
        sessionId: "sess-cifix-epoch",
        version: 5,
        state: "REVIEW",
        prUrl: PR_URL,
        headSha: "h1",
        inFlightEpochId: "epoch-C",
        ciFixRounds: 2, // a ciFix dispatch stamps the marker + increments rounds in the SAME CAS
        stateEnteredAt: Date.now() - 5_000,
      }),
    );
    const dispatched: SideEffectDispatch[] = [];
    const emit = vi.fn(async () => true);
    const repair = await repairStateDerivedSideEffects({ ...envWithDb(asD1(sqlite)), FSM_MODE: "live" } as Env, {
      sideEffects: {
        dispatch(dispatch) {
          dispatched.push(dispatch);
        },
      },
      emit,
    });

    expect(repair.epochDispatchRedelivered).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(emit.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({
        event: "fsm.sideeffect.skipped",
        kind: "dispatch_epoch",
        reason: "repair_gap_possibly_ci_owned",
        session_id: "sess-cifix-epoch",
      }),
    );
  });

  it("project routes through the canonical projection sync helper (never a direct table write)", async () => {
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7", status: "active" } as SessionState);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit: vi.fn(async () => true) });

    await sink.dispatch(buildDispatch({ sideEffects: [{ kind: "project" }] }));

    expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
    expect(mockSyncSessionProjection.mock.calls[0][0]).toMatchObject({
      sessionId: SID,
      source: "fsm-live-side-effects",
    });
  });

  // ── W11-P1 → D-59c: the mirror SOLE-WRITE (project() is the sole mirror writer) ──
  it("projection writes the mirror cols from the committed spine record (post-publish sole write)", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      status: "active",
      businessId: "biz-1",
    } as SessionState);
    const emit = vi.fn(async () => true);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        from: "VERIFYING",
        to: "MERGE_READY",
        version: 3,
        resultingRecord: buildRecord({
          state: "MERGE_READY",
          version: 3,
          prUrl: PR_URL,
          headSha: "h1",
          verdict: "pass",
        }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    // The fsmMirror payload is threaded through the canonical projection sync helper (never a direct write).
    expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
    expect(mockSyncSessionProjection.mock.calls[0][0].fsmMirror).toMatchObject({
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      cycloidDone: { state: "done", outcome: "success", reasons: [] },
      verificationMaxAttempts: MAX_VERIFICATION_RUNS_PER_PR,
    });
    // D-59c retired the P1 divergence detector (no independent legacy side to compare against).
    expect(emit.mock.calls.some((c) => (c[1] as { event?: string })?.event === "fsm.mirror_divergence")).toBe(false);
  });

  it("a PRE-PUBLISH record projects no mirror (existing behavior preserved)", async () => {
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7", status: "active" } as SessionState);
    const emit = vi.fn(async () => true);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        from: "GENERATING",
        to: "FINALIZING",
        resultingRecord: buildRecord({ state: "FINALIZING", version: 2, prUrl: null }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    // No PR yet → no fsmMirror payload, and the rich_status projection still runs.
    expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
    expect(mockSyncSessionProjection.mock.calls[0][0].fsmMirror).toBeFalsy();
  });

  // ── D-59c fix (ChatGPT P2, #6526): a POST-PUBLISH terminal transition CLEARS the stranded mirror/display.
  //    project() is the sole mirror/display writer, so a SKIPPED write leaves the pre-terminal
  //    VERIFYING/MERGE_READY-era values stranded forever — the executor must PASS the cleared terminal
  //    projection so syncSessionProjection overwrites the columns. ──
  const CLEARED_MIRROR = {
    reviewLoopDoneState: null,
    verificationState: null,
    cycloidDone: { state: "working", outcome: null, reasons: [] },
    verificationMaxAttempts: MAX_VERIFICATION_RUNS_PER_PR,
  } as const;
  const TERMINAL_CASES: ReadonlyArray<{ from: FsmRecord["state"]; to: FsmRecord["state"]; pill: string }> = [
    { from: "MERGE_READY", to: "MERGED", pill: "completed" },
    { from: "REVIEW", to: "CLOSED", pill: "completed" },
    { from: "VERIFYING", to: "SUPERSEDED", pill: "superseded" },
    { from: "REVIEW", to: "FAILED", pill: "failed" },
    { from: "VERIFYING", to: "STOPPED", pill: "stopped" },
    { from: "MERGE_READY", to: "ARCHIVED", pill: "archived" },
  ];
  for (const { from, to, pill } of TERMINAL_CASES) {
    it(`a POST-PUBLISH terminal (${from} → ${to}) clears the mirror + writes the '${pill}' pill (no stale strand)`, async () => {
      mockGetSessionState.mockResolvedValue({
        sessionId: SID,
        ownerUserId: "7",
        status: "active",
        businessId: "biz-1",
      } as SessionState);
      const db = asD1(createMigratedSqlite());
      const sink = buildLiveSideEffectSink(envWithDb(db), { emit: vi.fn(async () => true) });

      await sink.dispatch(
        buildDispatch({
          from,
          to,
          version: 9,
          // A record whose ACTIVE-era mirror/pill would otherwise strand (verdict pass, verification run 2).
          resultingRecord: buildRecord({
            state: to,
            version: 9,
            prUrl: PR_URL,
            headSha: "h1",
            verdict: "pass",
            verificationRunCount: 2,
          }) as FsmRecord,
          sideEffects: [{ kind: "project" }],
        }),
      );

      // The executor now COMPUTES + PASSES the cleared terminal projection (not null) so the columns are
      // authoritatively overwritten. (The real-D1 clear is proven by mirror-confirm-statements.test.ts.)
      expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
      expect(mockSyncSessionProjection.mock.calls[0][0].fsmMirror).toMatchObject(CLEARED_MIRROR);
      expect(mockSyncSessionProjection.mock.calls[0][0].fsmDisplay).toMatchObject({ richStatus: pill });
    });
  }

  it("a POST-PUBLISH terminal reaps a legacy intent observer child and clears its stale mismatch label", async () => {
    mockGetSessionState.mockImplementation(async (_env: Env, sessionId: string) => {
      if (sessionId === "legacy-intent-child") {
        return { sessionId, ownerUserId: "7", status: "active" } as SessionState;
      }
      return {
        sessionId: SID,
        ownerUserId: "7",
        status: "active",
        businessId: "biz-1",
        installationId: 123,
      } as SessionState;
    });
    const sqlite = createMigratedSqlite();
    const db = asD1(sqlite);
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: SID,
        version: 8,
        state: "MERGE_READY",
        prUrl: PR_URL,
        headSha: "h1",
      }),
    );
    sqlite
      .prepare("UPDATE pr_coordination SET intent_child_id = ? WHERE session_id = ?")
      .run("legacy-intent-child", SID);
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit: vi.fn(async () => true) });

    await sink.dispatch(
      buildDispatch({
        from: "MERGE_READY",
        to: "MERGED",
        version: 9,
        resultingRecord: buildRecord({
          state: "MERGED",
          version: 9,
          prUrl: PR_URL,
          headSha: "h1",
        }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    expect(mockCreateInstallationToken).toHaveBeenCalledWith(expect.anything(), 123);
    expect(mockRemoveLabel).toHaveBeenCalledWith("ghs-token", "x", "y", 1, "intent-mismatch:⚠");
    expect(mockCloseSessionState).toHaveBeenCalledWith(expect.anything(), "legacy-intent-child", null, {
      reason: "legacy_intent_observer_cleanup",
    });
  });

  it("a PRE-PUBLISH terminal (no PR) still projects NO mirror/display — nothing was ever written to clear", async () => {
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7", status: "active" } as SessionState);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit: vi.fn(async () => true) });

    await sink.dispatch(
      buildDispatch({
        from: "GENERATING",
        to: "FAILED",
        resultingRecord: buildRecord({ state: "FAILED", version: 4, prUrl: null }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    // No PR → the FSM projection never wrote these columns; leave them untouched (legacy owns pre-publish).
    expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
    expect(mockSyncSessionProjection.mock.calls[0][0].fsmMirror).toBeFalsy();
    expect(mockSyncSessionProjection.mock.calls[0][0].fsmDisplay).toBeFalsy();
  });

  // ── W11-P3 → D-59c: the DISPLAY SOLE-WRITE (project() is the sole rich_status writer) ──
  it("post-publish: threads fsmDisplay through the projection sync (the sole rich_status write)", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      status: "active",
      businessId: "biz-1",
    } as SessionState);
    const emit = vi.fn(async () => true);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        resultingRecord: buildRecord({
          state: "REVIEW",
          version: 3,
          prUrl: PR_URL,
          headSha: "h1",
          verdict: "none",
        }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    // The display payload is threaded through the canonical projection sync (never a direct write).
    expect(mockSyncSessionProjection.mock.calls[0][0].fsmDisplay).toMatchObject({
      richStatus: "review_listening",
      feChip: "review_listening",
    });
    // D-59c retired the P3 display divergence detector (project() is now the sole rich_status writer).
    expect(emit.mock.calls.some((c) => (c[1] as { event?: string })?.event === "fsm.display_divergence")).toBe(false);
  });

  it("post-publish: the projected pill flips with the spine state (MERGE_READY → completed)", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: SID,
      ownerUserId: "7",
      status: "active",
      businessId: "biz-1",
    } as SessionState);
    const emit = vi.fn(async () => true);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        from: "VERIFYING",
        to: "MERGE_READY",
        version: 4,
        resultingRecord: buildRecord({
          state: "MERGE_READY",
          version: 4,
          prUrl: PR_URL,
          headSha: "h1",
          verdict: "pass",
        }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    // The projection authoritatively writes the completed pill (the sole writer).
    expect(mockSyncSessionProjection.mock.calls[0][0].fsmDisplay).toMatchObject({ richStatus: "completed" });
  });

  it("a PRE-PUBLISH record carries no fsmDisplay (existing behavior preserved)", async () => {
    mockGetSessionState.mockResolvedValue({ sessionId: SID, ownerUserId: "7", status: "active" } as SessionState);
    const emit = vi.fn(async () => true);
    const db = asD1(createMigratedSqlite());
    const sink = buildLiveSideEffectSink(envWithDb(db), { emit });

    await sink.dispatch(
      buildDispatch({
        from: "GENERATING",
        to: "FINALIZING",
        resultingRecord: buildRecord({ state: "FINALIZING", version: 2, prUrl: null }) as FsmRecord,
        sideEffects: [{ kind: "project" }],
      }),
    );

    expect(mockSyncSessionProjection.mock.calls[0][0].fsmDisplay).toBeFalsy();
  });
});

// ── 6b. Transition-driven canonical label sync (W11 cohort-exit immediacy) ─────

describe("W11 — transition-driven canonical label sync (labels reach the PR at the mint)", () => {
  function labelDispatch(overrides: Partial<SideEffectDispatch>): SideEffectDispatch {
    return buildDispatch({
      // Default before/after project IDENTICAL labels (REVIEW [] → REVIEW []); each test overrides.
      priorRecord: buildRecord({ state: "REVIEW", version: 0, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
      resultingRecord: buildRecord({ state: "REVIEW", version: 1, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
      ...overrides,
    });
  }

  it("MERGE_READY (row-7) mint no longer dispatches a label sync (review-loop:done / verification-done scrapped)", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    await sink.dispatch(
      labelDispatch({
        from: "REVIEW",
        to: "MERGE_READY",
        event: { type: "caught_up", headSha: "h1" },
        resultingRecord: buildRecord({
          state: "MERGE_READY",
          version: 1,
          prUrl: PR_URL,
          headSha: "h1",
          verdict: "pass",
        }) as FsmRecord,
      }),
    );

    // PR-E1: MERGE_READY projects no managed label; REVIEW → MERGE_READY is a []→[] no-op for the label
    // axis, so the diff-gated sync stays quiet.
    expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalled();
  });

  it("NEEDS_YOU mint dispatches the canonical label sync (the blocked-reason label reaches the PR)", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    await sink.dispatch(
      labelDispatch({
        from: "REVIEW",
        to: "NEEDS_YOU",
        resultingRecord: buildRecord({
          state: "NEEDS_YOU",
          version: 1,
          prUrl: PR_URL,
          headSha: "h1",
          blockedReason: "review_stuck",
        }) as FsmRecord,
      }),
    );

    expect(mockSyncFsmLabelsForPr).toHaveBeenCalledTimes(1);
    expect(mockSyncFsmLabelsForPr.mock.calls[0][1]).toEqual(expect.objectContaining({ prUrl: PR_URL, sessionId: SID }));
  });

  it("a ci.signal REVIEW self-loop with an identical projected label set dispatches NOTHING", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    // `labelsOf(REVIEW)` reads only `verdict`; a `ci_fix_rounds`-only step keeps the set identical.
    await sink.dispatch(
      labelDispatch({
        from: "REVIEW",
        to: "REVIEW",
        priorRecord: buildRecord({
          state: "REVIEW",
          version: 0,
          prUrl: PR_URL,
          headSha: "h1",
          ciFixRounds: 0,
        }) as FsmRecord,
        resultingRecord: buildRecord({
          state: "REVIEW",
          version: 1,
          prUrl: PR_URL,
          headSha: "h1",
          ciFixRounds: 2,
        }) as FsmRecord,
      }),
    );

    expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalled();
  });

  it("a label-sync fault is isolated — the committed bag still runs and the dispatch resolves", async () => {
    mockSyncFsmLabelsForPr.mockRejectedValueOnce(new Error("github down"));
    const ran: string[] = [];
    const sink = buildLiveSideEffectSink(ENV, {
      emit: vi.fn(async () => true),
      executors: {
        emit_settle: async () => {
          ran.push("emit_settle");
        },
      },
    });

    // The dispatch must not reject even though the label sync threw. REVIEW → NEEDS_YOU flips the label
    // set ([] → [review-stuck]), so the diff-gated sync actually fires (and faults) here.
    await expect(
      sink.dispatch(
        labelDispatch({
          from: "REVIEW",
          to: "NEEDS_YOU",
          sideEffects: [{ kind: "emit_settle" }],
          resultingRecord: buildRecord({
            state: "NEEDS_YOU",
            version: 1,
            prUrl: PR_URL,
            headSha: "h1",
            blockedReason: "review_stuck",
          }) as FsmRecord,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(mockSyncFsmLabelsForPr).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(["emit_settle"]); // the committed bag ran despite the label-sync fault
  });

  it("a state-derived redelivery (no priorRecord) dispatches UNCONDITIONALLY — repair covers the cohort-exit crash window (P2 #6528)", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    // A D17 repairDispatch synthesizes a self-loop with no prior image — nothing to diff, and a
    // commit-before-dispatch crash at a MERGE_READY/NEEDS_YOU mint is exactly the cohort the sweep
    // cannot self-heal. The diff-based writer makes the unconditional dispatch idempotent.
    await sink.dispatch(
      buildDispatch({
        from: "MERGE_READY",
        to: "MERGE_READY",
        priorRecord: undefined,
        resultingRecord: buildRecord({ state: "MERGE_READY", version: 5, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
      }),
    );

    expect(mockSyncFsmLabelsForPr).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prUrl: PR_URL }));
  });

  it("a pre-publish transition (no pr_url) never dispatches a label sync", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    // Label sets would differ, but there is no PR to label — the pr_url gate keeps it quiet.
    await sink.dispatch(
      labelDispatch({
        from: "REVIEW",
        to: "MERGE_READY",
        priorRecord: buildRecord({ state: "REVIEW", version: 0, prUrl: null, headSha: null }) as FsmRecord,
        resultingRecord: buildRecord({ state: "MERGE_READY", version: 1, prUrl: null, headSha: null }) as FsmRecord,
      }),
    );

    expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalled();
  });

  // ── the label-set comparator over the projection matrix corners ──
  it("corner: a REVIEW verdict change (null → app_breaks) no longer flips labels → not dispatched (QA parallel)", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    await sink.dispatch(
      labelDispatch({
        from: "REVIEW",
        to: "REVIEW",
        priorRecord: buildRecord({
          state: "REVIEW",
          version: 0,
          prUrl: PR_URL,
          headSha: "h1",
          verdict: null,
        }) as FsmRecord,
        resultingRecord: buildRecord({
          state: "REVIEW",
          version: 1,
          prUrl: PR_URL,
          headSha: "h1",
          verdict: "app_breaks",
        }) as FsmRecord,
      }),
    );

    // PR-E1: REVIEW ∧ app_breaks no longer projects verification-needs-work — a []→[] no-op for labels.
    expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalled();
  });

  it("corner: a VERIFYING self-loop projects an identical set → not dispatched", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    await sink.dispatch(
      labelDispatch({
        from: "VERIFYING",
        to: "VERIFYING",
        priorRecord: buildRecord({ state: "VERIFYING", version: 0, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
        resultingRecord: buildRecord({ state: "VERIFYING", version: 1, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
      }),
    );

    expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalled();
  });

  it("corner: REVIEW → VERIFYING no longer flips labels → not dispatched (drain-only, no label)", async () => {
    const sink = buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) });
    await sink.dispatch(
      labelDispatch({
        from: "REVIEW",
        to: "VERIFYING",
        priorRecord: buildRecord({ state: "REVIEW", version: 0, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
        resultingRecord: buildRecord({ state: "VERIFYING", version: 1, prUrl: PR_URL, headSha: "h1" }) as FsmRecord,
      }),
    );

    // PR-E1: VERIFYING is drain-only and projects no label — a []→[] no-op.
    expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalled();
  });
});

// ── 7. The waitUntil hot-path seam ────────────────────────────────────────────

describe("PR 46 — waitUntil seam (webhook/DO paths never await side-effect work)", () => {
  it("defers execution through waitUntil and returns synchronously", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    const started: string[] = [];
    const finished: string[] = [];
    const executors = spyExecutors(started);
    executors.emit_settle = async () => {
      started.push("emit_settle");
      await gate;
      finished.push("emit_settle");
    };
    const captured: Promise<unknown>[] = [];
    const sink = buildLiveSideEffectSink(ENV, {
      executors,
      emit: vi.fn(async () => true),
      waitUntil: (p) => captured.push(p),
    });

    // dispatch() returns void immediately — the caller (applyEvent → the webhook/DO response) never
    // awaits the still-pending executor.
    const returned = sink.dispatch(buildDispatch({ sideEffects: [{ kind: "emit_settle" }] }));
    expect(returned).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(finished).toEqual([]);

    resolveGate();
    await captured[0];
    expect(finished).toEqual(["emit_settle"]);
  });

  it("without waitUntil (tests/cron) the dispatch promise awaits the executors inline", async () => {
    const calls: string[] = [];
    const sink = buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) });
    await sink.dispatch(buildDispatch({ sideEffects: [{ kind: "emit_settle" }] }));
    expect(calls).toEqual(["emit_settle@v1"]);
  });
});

// ── 8. combineSideEffectSinks ─────────────────────────────────────────────────

describe("PR 46 — combineSideEffectSinks fans one dispatch out in order", () => {
  it("both sinks receive the dispatch (the epoch producer's disposition sink + the live sink compose)", async () => {
    const seen: string[] = [];
    const a: FsmSideEffectSink = {
      dispatch() {
        seen.push("a");
      },
    };
    const b: FsmSideEffectSink = {
      dispatch() {
        seen.push("b");
      },
    };
    await combineSideEffectSinks(ENV, [
      { name: "a", sink: a },
      { name: "b", sink: b },
    ]).dispatch(buildDispatch());
    expect(seen).toEqual(["a", "b"]);
  });

  it("isolates a failing sink, emits the sink failure, and still runs siblings", async () => {
    const seen: string[] = [];
    const emit = vi.fn(async () => true);
    const a: FsmSideEffectSink = {
      dispatch() {
        seen.push("a");
        throw new Error("disposition store down");
      },
    };
    const b: FsmSideEffectSink = {
      dispatch() {
        seen.push("b");
      },
    };

    await combineSideEffectSinks(
      ENV,
      [
        { name: "epochDispositionSink", sink: a },
        { name: "liveSideEffectSink", sink: b },
      ],
      { emit },
    ).dispatch(buildDispatch({ sideEffects: [{ kind: "disposition" }, { kind: "emit_settle" }] }));

    expect(seen).toEqual(["a", "b"]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.sideeffect.sink_failed",
      sink: "epochDispositionSink",
      session_id: SID,
      version: 1,
      side_effect_kinds: ["disposition", "emit_settle"],
    });
  });
});

// ── 9. Flip-time backfill bug classes, driven end-to-end through applyEvent ───

describe("PR 46 — backfill bug classes at the flip (applyEvent over backfilled rows, live sinks)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const backfillBase = {
    sessionId: SID,
    verificationState: null,
    verificationResult: null,
    verificationVerdictHeadSha: null,
    reviewLoopDoneState: null,
    cycloidDone: { state: "working", outcome: null, reasons: [] },
    verificationRunCount: 0,
    ciFixRounds: 0,
  } as const;

  it("bug 1: a backfilled healthy REVIEW session with an UNPROVEN pass settles MERGE_READY on green — off-gate, never re-verifies, never NEEDS_YOU", async () => {
    // A long-lived passed session whose settle anchor is NULL/stale (backfillBase carries no
    // verificationVerdictHeadSha): pre-cut the UNPROVEN pass forced a re-verify (cascade row 1 → VERIFYING)
    // or, at cap, a NEEDS_YOU. Post-cut (ARC-1330 CI-ladder cut) verification is OFF-GATE: the cascade reads
    // ONLY the CI bucket + no_inflight_epoch, so a green-CI backfilled row settles MERGE_READY directly —
    // no re-verify spawn, no NEEDS_YOU, regardless of whether the stored verdict was proven at this head.
    const record = buildBackfillRecord(
      {
        ...backfillBase,
        phase: "review_listening",
        prUrl: PR_URL,
        headSha: "h1",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationRunCount: 3,
      },
      NOW,
    );
    await insertPrCoordination(db, record as PrCoordinationRecord);

    const calls: string[] = [];
    const resolver = makeResolver((rec) => ({
      sandboxAlive: true,
      noInflightEpoch: true,
      ciBucket: "ci_green",
      codeChangedSinceVerification: rec.codeChangedSinceVerification,
      underVerificationCap: rec.verificationRunCount < 3,
      verificationRunCount: rec.verificationRunCount,
      verificationRunId: rec.verificationRunId,
    }));
    const result = await applyEvent(
      {
        db,
        env: ENV,
        mode: "live",
        now: () => NOW,
        resolver,
        emit: vi.fn(async () => true),
        sideEffects: buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) }),
      },
      { sessionId: SID, event: { type: "caught_up", headSha: "h1" }, actor: "internal" },
    );

    expect(result).toMatchObject({ outcome: "handled", from: "REVIEW", to: "MERGE_READY" });
    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("MERGE_READY");
    expect(rec!.blockedReason).toBeNull();
    expect(calls).not.toContain("spawn_verification_child@v1"); // verification is off-gate — no re-verify
  });

  it("settled-verdict cohort (keystone fix 2): a provably-verified backfilled session goes MERGE_READY with NO spawn", async () => {
    // Approving verdict + legacy settle anchor matching the current head → the seed keeps it settled
    // (¬changed ∧ pass ∧ fresh). A post-flip caught_up must walk cascade row 7 — never row 1 (which
    // would commit VERIFYING and then be declined by the scheduler's verdict_already_settled gate,
    // wedging the session until the deadline).
    const record = buildBackfillRecord(
      {
        ...backfillBase,
        phase: "review_listening",
        prUrl: PR_URL,
        headSha: "h1",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationVerdictHeadSha: "h1",
        verificationRunCount: 3,
      },
      NOW,
    );
    expect(record.codeChangedSinceVerification).toBe(false);
    expect(record.verdictHeadSha).toBeNull(); // no settled-fresh stamping — adapter default
    await insertPrCoordination(db, record as PrCoordinationRecord);

    const calls: string[] = [];
    const resolver = makeResolver((rec) => ({
      sandboxAlive: true,
      // W11-T1: row 7 now requires no_inflight_epoch (the stale-green race conjunct) — record-sourced,
      // exactly as the shared live resolver supplies it.
      noInflightEpoch: rec.inFlightEpochId == null,
      codeChangedSinceVerification: rec.codeChangedSinceVerification,
      ciBucket: "ci_green",
      verificationPass: rec.verdict === "pass" || rec.verdict === "skipped",
      verificationFresh: rec.verdictHeadSha !== null && rec.verdictHeadSha === rec.headSha,
      underVerificationCap: rec.verificationRunCount < 3,
      verificationRunCount: rec.verificationRunCount,
      verificationRunId: rec.verificationRunId,
    }));
    const result = await applyEvent(
      {
        db,
        env: ENV,
        mode: "live",
        now: () => NOW,
        resolver,
        emit: vi.fn(async () => true),
        sideEffects: buildLiveSideEffectSink(ENV, { executors: spyExecutors(calls), emit: vi.fn(async () => true) }),
      },
      { sessionId: SID, event: { type: "caught_up", headSha: "h1" }, actor: "internal" },
    );

    expect(result).toMatchObject({ outcome: "handled", from: "REVIEW", to: "MERGE_READY" });
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    // Row 7 carries emit_settle + notify_user — and crucially NO verification spawn.
    expect(calls).toContain("emit_settle@v1");
    expect(calls.some((c) => c.startsWith("spawn_verification_child"))).toBe(false);
  });

  it("bug 2: a backfilled STOPPED session resumes on user.input (the [resumable] edge matches)", async () => {
    const record = buildBackfillRecord({ ...backfillBase, phase: "stopped", prUrl: PR_URL, headSha: "h1" }, NOW);
    await insertPrCoordination(db, record as PrCoordinationRecord);

    const resolver = makeResolver((rec) => ({
      sandboxAlive: false,
      stopMode: rec.stopMode ?? undefined,
      preStopState: rec.preStopState ?? undefined,
    }));
    const result = await applyEvent(
      {
        db,
        env: ENV,
        mode: "live",
        now: () => NOW,
        resolver,
        emit: vi.fn(async () => true),
        sideEffects: buildLiveSideEffectSink(ENV, { emit: vi.fn(async () => true) }),
      },
      { sessionId: SID, event: { type: "user.input" }, actor: "user" },
    );

    expect(result).toMatchObject({ outcome: "handled", from: "STOPPED", to: "REVIEW" });
    const rec = await getPrCoordination(db, SID);
    expect(rec!.stopMode).toBeNull(); // clear_stop rode the resume (N6)
    expect(rec!.preStopState).toBeNull();
  });

  it("bug 3 (documented): head.changed during a backfilled VERIFYING run redispatches sanely on null run handles", async () => {
    const record = buildBackfillRecord(
      {
        ...backfillBase,
        phase: "review_listening",
        prUrl: PR_URL,
        headSha: "h1",
        verificationState: "verification-in-progress",
        verificationRunCount: 1,
      },
      NOW,
    );
    expect(record.state).toBe("VERIFYING");
    await insertPrCoordination(db, record as PrCoordinationRecord);

    const emit = vi.fn(async () => true);
    const calls: string[] = [];
    const executors = spyExecutors(calls);
    const resolver = makeResolver((rec) => ({
      sandboxAlive: true,
      verificationRunId: rec.verificationRunId,
      verificationChildId: rec.verificationChildId,
    }));
    const result = await applyEvent(
      {
        db,
        env: ENV,
        mode: "live",
        now: () => NOW,
        resolver,
        emit: vi.fn(async () => true),
        sideEffects: buildLiveSideEffectSink(ENV, { executors, emit }),
      },
      { sessionId: SID, event: { type: "head.changed", headSha: "h2" }, actor: "webhook" },
    );

    // No crash: the kill targets the (null) backfilled child handle, the run redispatches 0→1 at the
    // new head, and the spawn side-effect fires for the new run.
    expect(result).toMatchObject({ outcome: "handled", from: "VERIFYING", to: "VERIFYING" });
    const rec = await getPrCoordination(db, SID);
    expect(rec!.verificationRunId).toBe(1);
    expect(rec!.verificationRunHead).toBe("h2");
    expect(rec!.headSha).toBe("h2");
    expect(rec!.verificationRunCount).toBe(1); // redispatch does NOT burn a run (B1)
    expect(calls).toContain("kill_verification@v1");
    expect(calls).toContain("spawn_verification_child@v1");
  });

  it("bug 3 (default executor): the null child handle from a backfilled row is a logged no-op, not a crash", async () => {
    const emit = vi.fn(async () => true);
    const sink = buildLiveSideEffectSink(ENV, { emit });
    await sink.dispatch(
      buildDispatch({
        from: "VERIFYING",
        to: "VERIFYING",
        event: { type: "head.changed", headSha: "h2" },
        sideEffects: [{ kind: "kill_verification", args: { verificationChildId: null } }],
        resultingRecord: buildRecord({
          state: "VERIFYING",
          version: 1,
          prUrl: PR_URL,
          headSha: "h2",
          verificationRunHead: "h2",
          verificationRunId: 1,
          verificationChildId: null,
        }) as FsmRecord,
      }),
    );
    expect(mockCloseSessionState).not.toHaveBeenCalled();
    const failed = emit.mock.calls.filter((c) => (c[1] as { event?: string }).event === "fsm.sideeffect.failed");
    expect(failed).toHaveLength(0);
  });
});

// ── 10. liveFsmSinks injection helper ─────────────────────────────────────────

describe("PR 46 — liveFsmSinks (the one-line call-site injection)", () => {
  it("returns both sinks wired to the same env", async () => {
    const db = asD1(createMigratedSqlite());
    const sinks = liveFsmSinks(envWithDb(db), { now: () => NOW });
    expect(sinks.sideEffects).toBeDefined();
    expect(sinks.worklist).toBeDefined();
    // The worklist sink persists registrations durably.
    await sinks.worklist!.commit(
      SID,
      1,
      [{ sourceId: "r-1", origin: "review", disposition: "none" }],
      buildRecord({ state: "REVIEW", prUrl: PR_URL }) as FsmRecord,
    );
    const items = await listForPr(db, SID, PR_URL);
    expect(items.map((i) => i.sourceId)).toEqual(["r-1"]);
  });

  it("threads the host waitUntil seam onto ApplyEventDeps (ChatGPT P2 #6414 — the off-path DD emits read deps.waitUntil)", () => {
    const db = asD1(createMigratedSqlite());
    const seam = (_: Promise<unknown>) => {};
    const sinks = liveFsmSinks(envWithDb(db), { waitUntil: seam });
    // The same seam that defers side-effect execution must reach apply-event's transition/triage
    // emits via the producers' `{ ...liveFsmSinks(env, { waitUntil }) }` spread — else the DD POSTs
    // stay on the commit path despite the deferral.
    expect(sinks.waitUntil).toBe(seam);
    // Callers without a seam keep the awaited best-effort behavior (undefined, not a throw).
    expect(liveFsmSinks(envWithDb(db)).waitUntil).toBeUndefined();
  });
});

describe("D17 scan split + recency bound + expired-row spawn gate (PR 49 keystone review)", () => {
  const PR_URL = "https://github.com/x/y/pull/9";

  // A3: the "30 old terminal rows cannot starve a freshly-stranded VERIFYING row" test was deleted — the
  // D17 VERIFYING spawn-redelivery arm is retired, so there is no owed spawn to re-drive from a dwelt
  // VERIFYING row. The transient-scan terminal-exclusion/recency bound stays proven by the epoch/loud rows.

  it("terminal loud redelivery is recency-bounded: a just-entered terminal fires once, an aged one never", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-fresh-terminal",
        version: 2,
        state: "NEEDS_YOU",
        prUrl: PR_URL,
        headSha: "h1",
        blockedReason: "verification_run_limit",
        stateEnteredAt: Date.now() - 5 * 60 * 1000,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-aged-terminal",
        version: 2,
        state: "NEEDS_YOU",
        prUrl: PR_URL,
        headSha: "h1",
        blockedReason: "verification_run_limit",
        // Past the window (and far past any KV TTL rollover) — the shadow-era/first-live-sweep class.
        stateEnteredAt: Date.now() - D17_TERMINAL_REDELIVERY_WINDOW_MS - 60_000,
      }),
    );
    const dispatched: SideEffectDispatch[] = [];
    const repair = await repairStateDerivedSideEffects({ ...envWithDb(db), FSM_MODE: "live" } as Env, {
      sideEffects: {
        dispatch(dispatch) {
          dispatched.push(dispatch);
        },
      },
      emit: vi.fn(async () => true),
    });
    expect(repair.loudRedelivered).toBe(1);
    expect(dispatched.map((d) => d.sessionId)).toEqual(["sess-fresh-terminal"]);
  });

  // A3: the "an EXPIRED stranded VERIFYING row is not respawned" test was deleted — the D17 VERIFYING
  // spawn-redelivery arm (and its `expired_deadline_owns_teardown` skip) is retired; the run-scoped
  // fireStuckVerificationBackstops now owns a stuck verification run's teardown.

  it("a terminal row with a lingering in_flight_epoch_id cannot re-enter the transient scan (Greptile)", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-terminal-epoch",
        version: 2,
        state: "NEEDS_YOU",
        prUrl: PR_URL,
        headSha: "h1",
        blockedReason: "ci_fix_exhausted",
        inFlightEpochId: "epoch-lingering",
        // Ancient — outside the terminal recency window too.
        stateEnteredAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
      }),
    );
    const dispatched: SideEffectDispatch[] = [];
    const repair = await repairStateDerivedSideEffects({ ...envWithDb(db), FSM_MODE: "live" } as Env, {
      sideEffects: {
        dispatch(dispatch) {
          dispatched.push(dispatch);
        },
      },
      emit: vi.fn(async () => true),
    });
    expect(repair.epochDispatchRedelivered).toBe(0);
    expect(repair.loudRedelivered).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("redelivered emits carry the honest redelivery marker (N4)", async () => {
    const db = asD1(createMigratedSqlite());
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-mark",
        version: 2,
        state: "NEEDS_YOU",
        prUrl: PR_URL,
        headSha: "h1",
        blockedReason: "ci_fix_exhausted",
        stateEnteredAt: Date.now() - 60_000,
      }),
    );
    const emit = vi.fn(async () => true);
    await repairStateDerivedSideEffects({ ...envWithDb(db), FSM_MODE: "live" } as Env, {
      sideEffects: { dispatch() {} },
      emit,
    });
    const redelivered = emit.mock.calls.find(
      (c) => (c[1] as Record<string, unknown>).event === "fsm.sideeffect.redelivered",
    )?.[1] as Record<string, unknown>;
    expect(redelivered?.redelivery).toBe(true);
  });
});
