// ARC-1330 latency fix — the verdict-return seam's HONEST CI observation.
//
// Proves, end-to-end through the REAL producer entry point + `applyEvent` over a migrated D1 (the
// Wave-1 createMigratedSqlite/SqliteD1 idiom, mirroring live-resolver.test.ts), that under
// `FSM_MODE=live` a fresh-accept verdict now sources a real one-head `reduceCiState` read and threads
// it into `buildLiveGuardResolver`, so:
//   • genuinely-green CI → cascade row 7 → MERGE_READY in the SAME applyEvent (no separate `ci.signal`),
//   • red / pending / UNREADABLE CI → stays REVIEW (conservative `ci_pending`) and the later green
//     `ci.signal` carry still mints MERGE_READY (the prior sweep/webhook behavior, unbroken),
//   • SHADOW performs NO read and can never mint MERGE_READY (the hard floors hold),
//   • non-REVIEW-reaching outcomes (stopped/run_limit) perform NO read.
// The CI read boundary (`getCommitCheckRuns`/`getCommitStatusContexts`) and the token/installation glue
// (`createInstallationToken`/`getInstallationByOwner`) are mocked; `reduceCiState`, `classifyCi`,
// `buildLiveGuardResolver`, the cascade and the whole `applyEvent`/recompute run REAL.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitCheckRun } from "../../../apps/control-plane-worker/src/github/pr";
import { readHeadCiState } from "../../../apps/control-plane-worker/src/services/review-loop-rollup";
import { shadowEmitCiSignal } from "../../../apps/control-plane-worker/src/session/fsm/ci-producer";
import {
  shadowEmitVerificationOutcome,
  shadowEmitVerifierTerminalVerdict,
} from "../../../apps/control-plane-worker/src/session/fsm/verification-producer";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { Env, SessionState } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

// The live executors reach the session DO + verification scheduler + Datadog — mocked module-wide (the
// repo's vi.hoisted pattern) so the REAL default executors run without a DO harness. The CI-read
// boundary + token/installation glue are mocked; reduceCiState/classifyCi stay real (partial mocks).
const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  closeSessionState: vi.fn(),
  syncSessionProjection: vi.fn(async () => {}),
  scheduleAutoVerification: vi.fn(),
  postDd: vi.fn(async () => true),
  getCommitCheckRuns: vi.fn(),
  getCommitStatusContexts: vi.fn(),
  createInstallationToken: vi.fn(async () => "tok"),
  getInstallationByOwner: vi.fn(),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
  closeSessionState: mocks.closeSessionState,
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: mocks.syncSessionProjection,
}));

// W11: the transition-driven canonical label sync fires on label-changing transitions in the live
// sink; stub it so these CI/verdict-settlement tests do not attempt a GitHub label reconcile.
vi.mock("../../../apps/control-plane-worker/src/services/fsm-label-sync", () => ({
  syncFsmLabelsForPr: vi.fn(async () => ({ added: [], removed: [] })),
}));

vi.mock("../../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: mocks.scheduleAutoVerification,
}));

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), postStructuredEventToDd: mocks.postDd };
});

// Partial-mock github/pr: keep hasPendingCheckRuns/isFailingCheckRun (used by the REAL reduceCiState),
// override only the two network reads the bounded head-poll performs.
vi.mock("../../../apps/control-plane-worker/src/github/pr", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    getCommitCheckRuns: mocks.getCommitCheckRuns,
    getCommitStatusContexts: mocks.getCommitStatusContexts,
  };
});

vi.mock("../../../apps/control-plane-worker/src/github/octokit", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), createInstallationToken: mocks.createInstallationToken };
});

vi.mock("../../../apps/control-plane-worker/src/github/installations-db", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), getInstallationByOwner: mocks.getInstallationByOwner };
});

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

const SID = "sess-verdict-ci-1";
const PR_URL = "https://github.com/x/y/pull/9";
const NOW = 1_700_000_050_000;

function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "REVIEW",
    prUrl: PR_URL,
    headSha: "h1",
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
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

// A VERIFYING row whose ACTIVE run (1) is about to report a fresh pass on unchanged code h1, with an
// empty worklist (no undispositioned items, vacuously-settled reviewers) — so the ONLY gate between the
// verdict-return recompute and MERGE_READY is the cascade's `ci_green`.
const verifyingWorld = (overrides: Partial<PrCoordinationRecord> = {}) =>
  buildRecord({
    state: "VERIFYING",
    headSha: "h1",
    verificationRunId: 1,
    verificationChildId: "child-active",
    codeChangedSinceVerification: false,
    ...overrides,
  });

const checkRun = (o: Partial<CommitCheckRun> = {}): CommitCheckRun => ({
  id: o.id ?? 1,
  name: o.name ?? "ci",
  status: o.status ?? "completed",
  conclusion: o.conclusion ?? "success",
  appSlug: o.appSlug ?? null,
  appName: o.appName ?? null,
  detailsUrl: o.detailsUrl ?? null,
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

function env(database: D1Database, mode: "shadow" | "live"): Env {
  return {
    DD_API_KEY: undefined,
    WORKER_ENV: "test",
    DB: database,
    FSM_MODE: mode,
    // Present so the read's creds-gate passes — the mode gate, not the creds gate, is what suppresses
    // the read in shadow (proven by the shadow test asserting zero octokit calls WITH creds set).
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "key",
  } as unknown as Env;
}

function ddEvents(name: string): Record<string, unknown>[] {
  return mocks.postDd.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((e) => e.event === name);
}

// A fresh CONCLUSIVE verdict echoing the ACTIVE run id (1) → verification.pass{h1, 1} → VERIFYING→REVIEW.
const emitFreshPass = (live: Env) =>
  shadowEmitVerifierTerminalVerdict(
    live,
    SID,
    {
      verdict: "CONCLUSIVE",
      verifiedHeadSha: "h1",
      summary: "",
      evidence: [],
      blockers: [],
      verificationRunId: 1,
    },
    { exhausted: false },
  );

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = createMigratedSqlite();
  db = new SqliteD1(sqlite) as unknown as D1Database;
  mocks.getSessionState.mockReset().mockResolvedValue(SESSION);
  mocks.closeSessionState.mockReset().mockResolvedValue(null);
  mocks.syncSessionProjection.mockReset().mockResolvedValue(undefined);
  mocks.scheduleAutoVerification.mockReset().mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });
  mocks.postDd.mockReset().mockResolvedValue(true);
  mocks.getCommitCheckRuns.mockReset().mockResolvedValue([]);
  mocks.getCommitStatusContexts.mockReset().mockResolvedValue([]);
  mocks.createInstallationToken.mockReset().mockResolvedValue("tok");
  mocks.getInstallationByOwner.mockReset().mockResolvedValue({
    installation_id: 42,
    owner_login: "x",
    owner_id: 1,
    owner_type: "User",
    repository_selection: "all",
    permissions_json: null,
    events_json: null,
    created_at: 0,
    suspended_at: null,
  });
});

describe("ARC-1330 — verdict-return honest CI: green settles MERGE_READY in the SAME apply", () => {
  it("LIVE + genuinely-green CI → MERGE_READY on verdict arrival (no separate ci.signal needed)", async () => {
    await insertPrCoordination(db, verifyingWorld());
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "success" })]);
    const live = env(db, "live");

    await emitFreshPass(live);

    const rec = await getPrCoordination(db, SID);
    // v1 = the verdict VERIFYING→REVIEW commit; v2 = the §6.5 recompute's row-7 REVIEW→MERGE_READY commit.
    expect(rec!.state).toBe("MERGE_READY");
    expect(rec!.version).toBe(2);
    expect(rec!.verdict).toBe("pass");
    expect(rec!.verdictHeadSha).toBe("h1");
    // Row 7's emit_settle fired through the live sink (the flip-visible settle signal).
    expect(ddEvents("fsm.settle")).toHaveLength(1);
    // The bounded one-head read hit the record's current head via the resolved token — exactly once.
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledWith("tok", "x", "y", "h1");
    expect(mocks.getCommitStatusContexts).toHaveBeenCalledWith("tok", "x", "y", "h1");
  });

  it("LIVE + RED CI → stays REVIEW (row 3 ciFix), never MERGE_READY; the read ran", async () => {
    await insertPrCoordination(db, verifyingWorld());
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "failure" })]);
    const live = env(db, "live");

    await emitFreshPass(live);

    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("REVIEW"); // ¬code_changed ∧ ci_red ∧ under_ci_fix_cap → ciFix dispatch, stays REVIEW
    expect(rec!.state).not.toBe("MERGE_READY");
    expect(ddEvents("fsm.settle")).toHaveLength(0);
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
  });

  it("LIVE + PENDING CI → stays REVIEW (row-5 WAIT); a later green ci.signal still carries to MERGE_READY", async () => {
    await insertPrCoordination(db, verifyingWorld());
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "in_progress", conclusion: null })]);
    const live = env(db, "live");

    await emitFreshPass(live);
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW"); // honest ci_pending → WAIT
    expect(ddEvents("fsm.settle")).toHaveLength(0);

    // The green flip (webhook/cron sweep carry) supplies the real bucket → row 7 → MERGE_READY.
    await shadowEmitCiSignal(live, SID, "green");
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  it("LIVE + UNREADABLE CI (octokit throws) → stays REVIEW (conservative fallback); green ci.signal still carries", async () => {
    await insertPrCoordination(db, verifyingWorld());
    mocks.getCommitCheckRuns.mockRejectedValue(new Error("boom (404)"));
    const live = env(db, "live");

    await emitFreshPass(live);
    // The best-effort read swallowed the fault → undefined → ci_pending → row-5 WAIT (prior behavior).
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
    expect(ddEvents("fsm.settle")).toHaveLength(0);

    await shadowEmitCiSignal(live, SID, "green");
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
  });

  it("LIVE + a non-REVIEW-reaching outcome (stopped) → NEEDS_YOU with NO CI read", async () => {
    await insertPrCoordination(db, verifyingWorld());
    const live = env(db, "live");

    await shadowEmitVerificationOutcome(live, SID, { outcome: "stopped", runId: 1, headSha: null });

    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("NEEDS_YOU");
    expect(rec!.blockedReason).toBe("verification_stopped");
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(0);
    expect(mocks.createInstallationToken).toHaveBeenCalledTimes(0);
  });

  it("LIVE + run_limit → NEEDS_YOU with NO CI read", async () => {
    await insertPrCoordination(db, verifyingWorld());
    const live = env(db, "live");

    await shadowEmitVerificationOutcome(live, SID, { outcome: "run_limit", runId: 1, headSha: null });

    const rec = await getPrCoordination(db, SID);
    expect(rec!.state).toBe("NEEDS_YOU");
    expect(rec!.blockedReason).toBe("verification_run_limit");
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(0);
  });
});

describe("ARC-1330 — readHeadCiState: real reduceCiState over the bounded one-head read", () => {
  it("green success check-run → green; failure → failing; in-progress → pending; empty → absent", async () => {
    mocks.getCommitStatusContexts.mockResolvedValue([]);

    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "success" })]);
    await expect(readHeadCiState("tok", "x", "y", "h1")).resolves.toBe("green");

    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "failure" })]);
    await expect(readHeadCiState("tok", "x", "y", "h1")).resolves.toBe("failing");

    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "in_progress", conclusion: null })]);
    await expect(readHeadCiState("tok", "x", "y", "h1")).resolves.toBe("pending");

    mocks.getCommitCheckRuns.mockResolvedValue([]);
    await expect(readHeadCiState("tok", "x", "y", "h1")).resolves.toBe("absent");
  });

  it("propagates read faults to the caller (the verdict seam owns the fallback)", async () => {
    mocks.getCommitCheckRuns.mockRejectedValue(new Error("boom"));
    await expect(readHeadCiState("tok", "x", "y", "h1")).rejects.toThrow("boom");
  });
});
