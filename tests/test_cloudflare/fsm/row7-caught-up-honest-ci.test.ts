// ARC-1330 (W11-T1) — row-7 completion: honest CI at the NON-verdict §6 caught_up triggers.
//
// #6381 threaded an honest CI read only at the verdict-return seam. This proves the SAME honest read now
// runs for the other §6 recompute triggers that complete the merge-ready conjunction with a pre-existing
// fresh verdict — the exact rows that parked at cascade row-5 `ci_pending` forever (legacy stops feeding
// `ci.signal` once IT finishes the loop). Covered end-to-end through the REAL producers + `applyEvent`
// over a migrated D1 (the createMigratedSqlite/SqliteD1 idiom):
//   • an EPOCH-TERMINAL (§6.1) recompute → `buildLiveGuardResolver.caughtUpInputs` sources the read →
//     green settles MERGE_READY in the SAME apply; pending/unreadable stays REVIEW (row-5 WAIT).
//   • the reviewer NO-SHOW settle (§6.3), whose `caught_up` is the OUTER event (so the resolver's own
//     snapshot read never runs), sources the honest read in the producer → same green/pending behavior.
// NEVER fabricates green: a pending/faulted read keeps REVIEW; a later green `ci.signal` still carries to
// MERGE_READY (prior behavior, unbroken). SHADOW performs no read.
// The CI-read boundary (`getCommitCheckRuns`/`getCommitStatusContexts`) + token glue are mocked;
// `reduceCiState`/`classifyCi`/`buildLiveGuardResolver`/the cascade/`applyEvent` run REAL.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitCheckRun } from "../../../apps/control-plane-worker/src/github/pr";
import { shadowEmitCiSignal } from "../../../apps/control-plane-worker/src/session/fsm/ci-producer";
import { shadowEmitEpochTerminal } from "../../../apps/control-plane-worker/src/session/fsm/epoch-producer";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { appendPrCoordinationEvent } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import type { Env, SessionState } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

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
// W11-V3 (#6425) moved the scheduler orchestration to session/verification-spawn (the old module is a
// re-export shim) and live-side-effects imports it from there — mock the REAL module or the executor
// runs the actual spawn path and trips the network guard.
vi.mock("../../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: mocks.scheduleAutoVerification,
}));
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), postStructuredEventToDd: mocks.postDd };
});
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

const SID = "sess-row7";
const PR_URL = "https://github.com/x/y/pull/9";
const NOW = 1_700_000_050_000;

// A clean REVIEW row whose ONLY gate to MERGE_READY is the cascade's `ci_green`: fresh pass on unchanged
// code h1, no undispositioned worklist, no reviewer rows (vacuously settled), one epoch in flight so an
// epoch-terminal recompute clears it and completes the conjunction.
function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "REVIEW",
    prUrl: PR_URL,
    headSha: "h1",
    verdict: "pass",
    verdictHeadSha: "h1",
    verificationRunHead: null,
    verificationRunId: 1,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: "epoch-1",
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: NOW - 10_000,
    ...overrides,
  };
}

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
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "key",
  } as unknown as Env;
}

function ddEvents(name: string): Record<string, unknown>[] {
  return mocks.postDd.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((e) => e.event === name);
}

const emitEpochReplied = (e: Env) =>
  shadowEmitEpochTerminal(e, SID, PR_URL, {
    kind: "replied",
    epochId: "epoch-1",
    epochTrigger: "review",
    sourceIds: [],
    headSha: "h1",
  });

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

describe("W11-T1 — epoch-terminal recompute sources honest CI (caughtUpInputs)", () => {
  it("LIVE + green CI → MERGE_READY in the SAME apply (no separate ci.signal)", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "success" })]);
    const live = env(db, "live");

    await emitEpochReplied(live);

    const rec = await getPrCoordination(db, SID);
    // v1 = the epoch.replied REVIEW→REVIEW commit; v2 = the §6.1 recompute's row-7 REVIEW→MERGE_READY commit.
    expect(rec!.state).toBe("MERGE_READY");
    expect(rec!.version).toBe(2);
    expect(ddEvents("fsm.settle")).toHaveLength(1);
    // The honest one-head read hit the record's current head via the resolved token — exactly once.
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledWith("tok", "x", "y", "h1");
  });

  it("LIVE + PENDING CI → stays REVIEW (row-5 WAIT); a later green ci.signal still carries to MERGE_READY", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "in_progress", conclusion: null })]);
    const live = env(db, "live");

    await emitEpochReplied(live);
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW"); // honest ci_pending → WAIT, never fabricated green
    expect(ddEvents("fsm.settle")).toHaveLength(0);
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);

    await shadowEmitCiSignal(live, SID, "green");
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  it("LIVE + UNREADABLE CI (octokit throws) → stays REVIEW (conservative ci_pending fallback)", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockRejectedValue(new Error("boom (404)"));
    const live = env(db, "live");

    await emitEpochReplied(live);
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
    expect(ddEvents("fsm.settle")).toHaveLength(0);
  });

  it("FIX 1: a SINGLE absent read (no journaled ci.signal(absent)) does NOT settle — stays REVIEW", async () => {
    await insertPrCoordination(db, buildRecord());
    // beforeEach default: zero check runs + zero status contexts → reduceCiState = absent. Pre-fix this
    // classified ci_green and minted MERGE_READY off ONE observation; the settleable read now degrades an
    // uncorroborated absent to pending (row-5 WAIT).
    const live = env(db, "live");

    await emitEpochReplied(live);

    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
    expect(ddEvents("fsm.settle")).toHaveLength(0);
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1); // the read ran; the trap held it at WAIT
  });

  it("FIX 1: a CORROBORATED absent (prior journaled ci.signal(absent)) settles MERGE_READY (no-CI repo)", async () => {
    await insertPrCoordination(db, buildRecord());
    // The #6403 debounced producer / the sweep's absent-CI re-poll already journaled an absent signal.
    await appendPrCoordinationEvent(db, {
      sessionId: SID,
      version: 0,
      fromState: "REVIEW",
      toState: "REVIEW",
      event: "ci.signal",
      at: NOW - 60_000,
      actor: "webhook",
      metadata: { type: "ci.signal", ciState: "absent" },
    });
    const live = env(db, "live");

    await emitEpochReplied(live);

    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(ddEvents("fsm.settle")).toHaveLength(1);
  });

  // The collapsed CI-poll door (state===REVIEW ∧ noInflightEpoch ∧ 0 undispositioned) no longer gates the
  // honest one-head read on verdict pass/freshness or ¬code_changed — verification is record-only now, CI is
  // the settle gate. So a record shape that legacy would have SKIPPED (code changed, no verdict, stale verdict)
  // now polls, and a genuine green CI settles MERGE_READY through the same cascade. (See PR-E2 for the row-7
  // verification-bookkeeping semantics; the poll gate itself is verdict-independent.)
  it("LIVE + code_changed → the collapsed door still polls; green CI settles MERGE_READY (CI gates, not the verdict)", async () => {
    await insertPrCoordination(db, buildRecord({ codeChangedSinceVerification: true }));
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "success" })]);
    const live = env(db, "live");

    await emitEpochReplied(live);

    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
  });

  it("LIVE + no verdict (auto-verify-on, never verified) → the door polls; green CI settles MERGE_READY (no starvation)", async () => {
    await insertPrCoordination(db, buildRecord({ verdict: null, verdictHeadSha: null }));
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "success" })]);
    const live = env(db, "live");

    await emitEpochReplied(live);

    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
  });

  it("LIVE + stale verdict → the door polls (verdict freshness no longer gates); green CI settles MERGE_READY", async () => {
    await insertPrCoordination(db, buildRecord({ verdictHeadSha: "h0" }));
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ status: "completed", conclusion: "success" })]);
    const live = env(db, "live");

    await emitEpochReplied(live);

    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
  });

  it("STARVATION FIX: auto-verify ON + no verdict + no-CI (corroborated absent) head → the door polls and the absent reads green → MERGE_READY", async () => {
    // The exact cohort the old verification-gated poll starved: auto-verify ON (getSessionState default),
    // no verdict ever recorded, and a no-CI repo (absent head). Pre-re-key the poll never fired (verdict
    // not fresh/pass), so the row parked at row-5 ci_pending until the 4h review_stuck backstop. The
    // collapsed door polls regardless of verdict, and a CORROBORATED absent (prior journaled ci.signal
    // (absent) — the no-CI repo's #6403 debounce) reads green → MERGE_READY.
    await insertPrCoordination(db, buildRecord({ verdict: null, verdictHeadSha: null }));
    await appendPrCoordinationEvent(db, {
      sessionId: SID,
      version: 0,
      fromState: "REVIEW",
      toState: "REVIEW",
      event: "ci.signal",
      at: NOW - 60_000,
      actor: "webhook",
      metadata: { type: "ci.signal", ciState: "absent" },
    });
    // beforeEach default: zero check runs + zero status contexts → the head reads `absent`.
    const live = env(db, "live");

    await emitEpochReplied(live);

    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(ddEvents("fsm.settle")).toHaveLength(1);
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(1);
  });
});
