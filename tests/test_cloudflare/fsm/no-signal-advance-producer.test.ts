// ARC-1330 no-signal advance: empty expected-bot set + no CI signal gets a bounded FSM-native
// `ci.signal` producer instead of relying on the legacy review-loop sweep.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NO_SIGNAL_ADVANCE_WINDOW_MS } from "../../../apps/control-plane-worker/src/constants/review-loop";
import type { CommitCheckRun } from "../../../apps/control-plane-worker/src/github/pr";
import {
  armNoSignalAdvanceOnPrOpened,
  FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY,
  FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY,
  shadowFireDueNoSignalAdvance,
  shouldSelfArmNoSignalAdvance,
} from "../../../apps/control-plane-worker/src/session/fsm/no-signal-advance-producer";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
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

// W11-V3(a) D-50A: the executor now inlines the spawn via `verification-spawn.ts` (the FSM-owned
// destination — `verification-auto-scheduler.ts` is a dead-under-live compat re-export). The mock
// moves to `verification-spawn` so the live-side-effects direct import is intercepted.
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
const SID = "sess-no-signal";
const PR_URL = "https://github.com/x/y/pull/9";
const NOW = 1_700_000_050_000;

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
    codeChangedSinceVerification: true,
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

const checkRun = (overrides: Partial<CommitCheckRun> = {}): CommitCheckRun => ({
  id: overrides.id ?? 1,
  name: overrides.name ?? "ci",
  status: overrides.status ?? "completed",
  conclusion: overrides.conclusion ?? "success",
  appSlug: overrides.appSlug ?? null,
  appName: overrides.appName ?? null,
  detailsUrl: overrides.detailsUrl ?? null,
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

function envFor(database: D1Database, mode: "shadow" | "live" | "off" = "live"): Env {
  return {
    DD_API_KEY: undefined,
    WORKER_ENV: "test",
    DB: database,
    FSM_MODE: mode,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "key",
  } as unknown as Env;
}

function createMemoryStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
        return true;
      }),
    } as unknown as Pick<DurableObjectStorage, "delete" | "get" | "put">,
  };
}

function pendingCheck(): CommitCheckRun {
  return checkRun({ status: "in_progress", conclusion: null });
}

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

describe("armNoSignalAdvanceOnPrOpened", () => {
  function armInput(overrides: Partial<Parameters<typeof armNoSignalAdvanceOnPrOpened>[1]> = {}) {
    return {
      sessionId: SID,
      prUrl: PR_URL,
      ownerUserId: 101,
      repoOwner: "x",
      repoName: "y",
      now: NOW,
      ...overrides,
    };
  }

  it("arms for EVERY published PR — including a repo with configured review bots", async () => {
    // The wedge: a repo with configured expected bots but no CI (or bots that never review) previously did
    // NOT arm, so nothing ever carried it to MERGE_READY. The arm is now unconditional (no checklist gate).
    const armNoSignalAdvanceAlarm = vi.fn(async () => {});

    const result = await armNoSignalAdvanceOnPrOpened(envFor(db), armInput({ armNoSignalAdvanceAlarm }));

    expect(result).toEqual({ armed: true, deadlineMs: NOW + NO_SIGNAL_ADVANCE_WINDOW_MS });
    expect(armNoSignalAdvanceAlarm).toHaveBeenCalledWith(NOW + NO_SIGNAL_ADVANCE_WINDOW_MS);
  });

  it("no-ops (never arms) only when D1 is unbound or the repo context is unresolvable", async () => {
    const armNoSignalAdvanceAlarm = vi.fn(async () => {});
    const unbound = { WORKER_ENV: "test", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as unknown as Env;
    await expect(armNoSignalAdvanceOnPrOpened(unbound, armInput({ armNoSignalAdvanceAlarm }))).resolves.toEqual({
      armed: false,
      deadlineMs: null,
    });

    await expect(
      armNoSignalAdvanceOnPrOpened(envFor(db), armInput({ armNoSignalAdvanceAlarm, repoOwner: "" })),
    ).resolves.toEqual({ armed: false, deadlineMs: null });

    await expect(
      armNoSignalAdvanceOnPrOpened(envFor(db), armInput({ armNoSignalAdvanceAlarm, prUrl: "" })),
    ).resolves.toEqual({ armed: false, deadlineMs: null });
    expect(armNoSignalAdvanceAlarm).not.toHaveBeenCalled();
  });
});

describe("shouldSelfArmNoSignalAdvance (standing-stock self-heal predicate)", () => {
  it("arms a review-listening row that has no deadline armed, and never otherwise", () => {
    expect(shouldSelfArmNoSignalAdvance(true, false)).toBe(true); // wedged standing stock → arm
    expect(shouldSelfArmNoSignalAdvance(true, true)).toBe(false); // already armed → idempotent no-op
    expect(shouldSelfArmNoSignalAdvance(false, false)).toBe(false); // not review-listening → skip
    expect(shouldSelfArmNoSignalAdvance(false, true)).toBe(false);
  });
});

describe("no-CI promotion wedge regression (configured-bots + no-CI repo)", () => {
  // The E2E-verified regression (dogfood trycycloid/demo-env PR #168 / #166): a repo with configured
  // review bots but no CI checks published, wedged at "Addressing CI & Reviews", and never promoted to
  // MERGE_READY. Root cause: the no-signal advance was armed ONLY for zero-bot repos, so a configured-bot
  // + no-CI repo got no `ci.signal(absent)` carrier. This proves the universal arm → 90s recompute path
  // now settles MERGE_READY end to end for both the review-round-done shape (#168) and the
  // verification-skipped shape (#166).
  it("configured-bots + no-CI publish arms the advance, which settles MERGE_READY on the 90s recompute", async () => {
    // A repo WITH configured expected bots still arms now (the arm is unconditional).
    const armNoSignalAdvanceAlarm = vi.fn(async () => {});
    const armed = await armNoSignalAdvanceOnPrOpened(envFor(db), {
      sessionId: SID,
      prUrl: PR_URL,
      ownerUserId: 101,
      repoOwner: "x",
      repoName: "y",
      now: NOW,
      armNoSignalAdvanceAlarm,
    });
    expect(armed).toEqual({ armed: true, deadlineMs: NOW + NO_SIGNAL_ADVANCE_WINDOW_MS });

    // #168 shape: review round done — no undispositioned items, no in-flight epoch, code unchanged.
    await insertPrCoordination(db, buildRecord({ codeChangedSinceVerification: false }));
    const { storage } = createMemoryStorage();
    const live = envFor(db, "live");

    // No CI on the repo → absent. First fire debounces (count → 1); the 90s recompute emits ci.signal(absent).
    await shadowFireDueNoSignalAdvance(live, SID, NOW, { storage });
    const settled = await shadowFireDueNoSignalAdvance(live, SID, NOW + NO_SIGNAL_ADVANCE_WINDOW_MS, { storage });

    expect(settled).toEqual({ ok: true, reArm: true, emitted: true, ciState: "absent" });
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect((await listPrCoordinationEvents(db, SID)).map((event) => event.event)).toEqual(["ci.signal", "caught_up"]);
  });

  it("verification-skipped shape (no verdict, code changed) also settles MERGE_READY", async () => {
    // #166 shape: verification.skipped, never a review round; verification is off-gate for MERGE_READY.
    await insertPrCoordination(db, buildRecord({ verdict: null }));
    const { storage } = createMemoryStorage();
    const live = envFor(db, "live");

    await shadowFireDueNoSignalAdvance(live, SID, NOW, { storage });
    const settled = await shadowFireDueNoSignalAdvance(live, SID, NOW + NO_SIGNAL_ADVANCE_WINDOW_MS, { storage });

    expect(settled.emitted).toBe(true);
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect((await getPrCoordination(db, SID))!.verificationRunCount).toBe(0);
  });
});

describe("shadowFireDueNoSignalAdvance", () => {
  it("uses a 90 second no-signal poll window", () => {
    expect(NO_SIGNAL_ADVANCE_WINDOW_MS).toBe(90_000);
  });

  it("debounces absent once, then emits ci.signal(absent) and settles MERGE_READY (verification off-gate)", async () => {
    await insertPrCoordination(db, buildRecord());
    const { storage, values } = createMemoryStorage();
    const live = envFor(db, "live");

    const first = await shadowFireDueNoSignalAdvance(live, SID, NOW, { storage });
    expect(first).toEqual({ ok: true, reArm: true, emitted: false, ciState: "absent" });
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY)).toEqual({ headSha: "h1", count: 1 });

    const second = await shadowFireDueNoSignalAdvance(live, SID, NOW + NO_SIGNAL_ADVANCE_WINDOW_MS, { storage });
    expect(second).toEqual({ ok: true, reArm: true, emitted: true, ciState: "absent" });
    const rec = (await getPrCoordination(db, SID))!;
    // ARC-1330 CI-ladder cut: absent CI is bucketed ci_green, so caught_up settles MERGE_READY directly —
    // no VERIFYING, no run burned (verification is decoupled from the merge-ready gate).
    expect(rec.state).toBe("MERGE_READY");
    expect(rec.verificationRunCount).toBe(0);
    expect((await listPrCoordinationEvents(db, SID)).map((event) => event.event)).toEqual(["ci.signal", "caught_up"]);
  });

  it("keeps VERIFYING alive without polling", async () => {
    await insertPrCoordination(db, buildRecord({ state: "VERIFYING", verificationRunId: 1 }));
    const { storage } = createMemoryStorage();

    await expect(shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage })).resolves.toEqual({
      ok: true,
      reArm: true,
      emitted: false,
      ciState: null,
    });
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(0);
  });

  it("pending poll emits nothing and stays in REVIEW", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockResolvedValue([pendingCheck()]);
    const { storage, values } = createMemoryStorage();

    await expect(shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage })).resolves.toEqual({
      ok: true,
      reArm: true,
      emitted: false,
      ciState: "pending",
    });
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY)).toBeUndefined();
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });

  it("keeps re-arming and polling pending CI on the shortened cadence", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockResolvedValue([pendingCheck()]);
    const { storage, values } = createMemoryStorage();
    const live = envFor(db, "live");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        shadowFireDueNoSignalAdvance(live, SID, NOW + attempt * NO_SIGNAL_ADVANCE_WINDOW_MS, { storage }),
      ).resolves.toEqual({
        ok: true,
        reArm: true,
        emitted: false,
        ciState: "pending",
      });
    }

    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(4);
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY)).toBeUndefined();
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });

  it("failing CI emits immediately into the ciFix path, never MERGE_READY", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        codeChangedSinceVerification: false,
        verdict: "pass",
        verdictHeadSha: "h1",
        verificationRunId: 1,
      }),
    );
    mocks.getCommitCheckRuns.mockResolvedValue([checkRun({ conclusion: "failure" })]);
    const { storage } = createMemoryStorage();

    const result = await shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage });

    expect(result).toEqual({ ok: true, reArm: true, emitted: true, ciState: "failing" });
    const rec = (await getPrCoordination(db, SID))!;
    expect(rec.state).toBe("REVIEW");
    expect(rec.inFlightEpochId).toBeTruthy();
    expect(rec.ciFixRounds).toBe(1);
  });

  it("skips a stale-head CI read without emitting", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockImplementation(async () => {
      await db.prepare(`UPDATE pr_coordination SET head_sha = ? WHERE session_id = ?`).bind("h2", SID).run();
      return [];
    });
    const { storage } = createMemoryStorage();

    const result = await shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage });

    expect(result).toEqual({ ok: true, reArm: true, emitted: false, ciState: "absent" });
    expect((await getPrCoordination(db, SID))!.headSha).toBe("h2");
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });

  it("keeps re-openable states armed without polling and clears auxiliary state", async () => {
    await insertPrCoordination(db, buildRecord({ state: "MERGE_READY", codeChangedSinceVerification: false }));
    const { storage, values } = createMemoryStorage();
    values.set(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY, { headSha: "h1", count: 2 });
    values.set(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY, { ciState: "absent", contextKey: "x" });

    await expect(shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage })).resolves.toEqual({
      ok: true,
      reArm: true,
      emitted: false,
      ciState: null,
    });
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY)).toBeUndefined();
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY)).toBeUndefined();
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(0);
  });

  it("cleans auxiliary state and stops re-arming outside keepalive states", async () => {
    await insertPrCoordination(db, buildRecord({ state: "SUPERSEDED", codeChangedSinceVerification: false }));
    const { storage, values } = createMemoryStorage();
    values.set(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY, { headSha: "h1", count: 2 });
    values.set(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY, { ciState: "absent", contextKey: "x" });

    await expect(shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage })).resolves.toEqual({
      ok: true,
      reArm: false,
      emitted: false,
      ciState: null,
    });
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY)).toBeUndefined();
    expect(values.get(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY)).toBeUndefined();
    expect(mocks.getCommitCheckRuns).toHaveBeenCalledTimes(0);
  });

  it("an absent-advance that settles caught_up reaches MERGE_READY and emits fsm.settle", async () => {
    await insertPrCoordination(db, buildRecord());
    const { storage } = createMemoryStorage();
    const live = envFor(db, "live");

    // ARC-1330 CI-ladder cut: absent CI (bucketed ci_green) settles MERGE_READY on the debounced emit —
    // no VERIFYING/verdict-return round-trip is needed (verification is off-gate).
    await shadowFireDueNoSignalAdvance(live, SID, NOW, { storage }); // debounce (count → 1)
    const result = await shadowFireDueNoSignalAdvance(live, SID, NOW + NO_SIGNAL_ADVANCE_WINDOW_MS, { storage });

    expect(result).toEqual({ ok: true, reArm: true, emitted: true, ciState: "absent" });
    expect((await getPrCoordination(db, SID))!.state).toBe("MERGE_READY");
    expect(mocks.postDd.mock.calls.map((call) => (call[1] as Record<string, unknown>).event)).toContain("fsm.settle");
  });

  it("poll faults are isolated and request a future re-arm", async () => {
    await insertPrCoordination(db, buildRecord());
    mocks.getCommitCheckRuns.mockRejectedValue(new Error("github timeout"));
    const { storage } = createMemoryStorage();

    await expect(shadowFireDueNoSignalAdvance(envFor(db), SID, NOW, { storage })).resolves.toEqual({
      ok: false,
      reArm: true,
      emitted: false,
      ciState: null,
    });
    expect((await getPrCoordination(db, SID))!.state).toBe("REVIEW");
  });
});
