// Tests for the ARC-1330 DEADLINE producer (PR 44): the per-session DO alarm → `deadline_exceeded`
// spine event, run OBSERVE-ONLY ("would-fire", F39) in shadow. Pure `deadline_class` map / due-check /
// builder + the shadow dual-emit driving a real migrated SQLite (the Wave-1 DAO idiom:
// createMigratedSqlite/asD1). Covers: the spec tests (would-fire logging + no side-effect in shadow),
// the §10 deadline destinations, the real-backstop resolver, the not-due / off-mode no-ops, and the
// `deadline_class` totality over every FsmState.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MERGE_READY_RECONCILE_DEADLINE_MS,
  REVIEW_STUCK_DEADLINE_MS,
  VERIFYING_BACKSTOP_DEADLINE_MS,
} from "../../../apps/control-plane-worker/src/constants/review-loop";
import {
  buildDeadlineEmission,
  DEADLINE_CLASS_MS,
  deadlineClassMs,
  deadlineWouldFire,
  shadowFireDueDeadline,
} from "../../../apps/control-plane-worker/src/session/fsm/deadline-producer";
import { FSM_STATES } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

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

const SID = "sess-deadline";
const ENTERED = 1_700_000_000_000;

function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SID,
    version: 0,
    state: "REVIEW",
    prUrl: "https://github.com/o/r/pull/1",
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
    stateEnteredAt: ENTERED,
    ...overrides,
  };
}

function envFor(db: D1Database, mode: string | undefined = "shadow"): Env {
  return { DB: db, FSM_MODE: mode, DD_API_KEY: undefined, WORKER_ENV: "test" } as unknown as Env;
}

describe("deadline-producer pure layer", () => {
  it("deadline_class is total over every FsmState (every active/wait state has a window; terminals are null)", () => {
    for (const state of FSM_STATES) {
      expect(state in DEADLINE_CLASS_MS).toBe(true);
    }
    // Active/wait states carry a positive window; resting terminals carry null (§10 inv 12).
    for (const state of [
      "CREATED",
      "PROVISIONING",
      "GENERATING",
      "FINALIZING",
      "PUBLISHING",
      "AWAITING_INPUT",
      "REVIEW",
      "VERIFYING",
      "MERGE_READY",
    ] as const) {
      expect(deadlineClassMs(state)).toBeGreaterThan(0);
    }
    for (const state of [
      "ANSWERED_NO_PR",
      "NEEDS_YOU",
      "FAILED",
      "STOPPED",
      "MERGED",
      "CLOSED",
      "SUPERSEDED",
      "ARCHIVED",
    ] as const) {
      expect(deadlineClassMs(state)).toBeNull();
    }
  });

  it("deadlineWouldFire gates on state_entered_at + class, never fires a terminal", () => {
    // Not yet elapsed.
    expect(
      deadlineWouldFire({ state: "REVIEW", stateEnteredAt: ENTERED }, ENTERED + REVIEW_STUCK_DEADLINE_MS - 1),
    ).toBe(false);
    // Exactly at the window → fires (≥).
    expect(deadlineWouldFire({ state: "REVIEW", stateEnteredAt: ENTERED }, ENTERED + REVIEW_STUCK_DEADLINE_MS)).toBe(
      true,
    );
    // A resting terminal has no class → never fires, even far past.
    expect(
      deadlineWouldFire({ state: "MERGED", stateEnteredAt: ENTERED }, ENTERED + 10 * REVIEW_STUCK_DEADLINE_MS),
    ).toBe(false);
  });

  it("the builder mints a `deadline_exceeded` event attributed to the internal (timer) actor", () => {
    const e = buildDeadlineEmission();
    expect(e.event).toEqual({ type: "deadline_exceeded" });
    expect(e.metadata).toEqual({ type: "deadline_exceeded" });
    expect(e.actor).toBe("internal");
  });
});

describe("shadowFireDueDeadline — would-fire + no side-effect (the spec tests)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("logs a would-fire line and emits deadline_exceeded when REVIEW dwells past review_stuck", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    const info = vi.fn();
    const now = ENTERED + REVIEW_STUCK_DEADLINE_MS;
    const result = await shadowFireDueDeadline(envFor(db), SID, now, { info });

    expect(result.wouldFire).toBe(true);
    // Fire log (F39) — the per-class tuning signal.
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatchObject({ sessionId: SID, state: "REVIEW", dwellMs: REVIEW_STUCK_DEADLINE_MS });
    expect(info.mock.calls[0][1]).toContain("fired");
    // The DO alarm fired deadline_exceeded into applyEvent → §10 REVIEW → NEEDS_YOU(review_stuck).
    const rec = await getPrCoordination(db, SID);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("review_stuck");
    const eventLog = await listPrCoordinationEvents(db, SID);
    expect(eventLog.map((e) => e.event)).toEqual(["deadline_exceeded"]);
    expect(eventLog[0]).toMatchObject({ fromState: "REVIEW", toState: "NEEDS_YOU", actor: "internal" });
  });

  it("dispatches the §10 VERIFYING teardown bag (kill_verification + loud + drain) on a due fire", async () => {
    await insertPrCoordination(db, buildRecord({ state: "VERIFYING", verificationChildId: "child-1" }));
    const dispatches: import("../../../apps/control-plane-worker/src/session/fsm/apply-event").SideEffectDispatch[] =
      [];
    const spySink = {
      dispatch: (d: import("../../../apps/control-plane-worker/src/session/fsm/apply-event").SideEffectDispatch) =>
        void dispatches.push(d),
    };
    const now = ENTERED + VERIFYING_BACKSTOP_DEADLINE_MS;

    const result = await shadowFireDueDeadline(envFor(db), SID, now, undefined, spySink);

    expect(result.wouldFire).toBe(true);
    expect((await getPrCoordination(db, SID))?.state).toBe("NEEDS_YOU");
    // Exactly one committed transition's side-effects were dispatched, carrying the real teardown bag.
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].sideEffects.length).toBeGreaterThan(0);
  });

  it("threads waitUntil into applyEvent deps so the transition DD POST rides OFF the commit path (ARC-1428)", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    // A passthrough sideEffects seam so the real live sink (which ALSO defers via waitUntil) is not
    // built — the centralized transition telemetry emit is then the SOLE `deps.waitUntil` caller.
    const spySink = { dispatch: () => {} };
    const waitUntil = vi.fn();
    const now = ENTERED + REVIEW_STUCK_DEADLINE_MS;

    await shadowFireDueDeadline(envFor(db), SID, now, undefined, spySink, waitUntil);

    // Before the ARC-1428 fix `deps.waitUntil` was undefined (passed only to the sink), so apply-event
    // took the blocking `await transitionEmit` branch and the DD POST stalled the DO alarm cascade.
    // With the fix the emit defers through waitUntil as a fire-and-forget Promise. Assert >=1 (not an
    // exact count) so a future extra emit / caught_up re-entry on this path can't false-fail the guard.
    expect(waitUntil).toHaveBeenCalled();
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("is a clean no-op when the state has not dwelt past its window", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    const info = vi.fn();
    const result = await shadowFireDueDeadline(envFor(db), SID, ENTERED + REVIEW_STUCK_DEADLINE_MS - 1, { info });
    expect(result.wouldFire).toBe(false);
    expect(info).not.toHaveBeenCalled();
    expect((await getPrCoordination(db, SID))?.state).toBe("REVIEW");
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });

  it("fails closed without firing a destructive deadline while plan approval is pending", async () => {
    await insertPrCoordination(db, buildRecord({ state: "REVIEW" }));
    const now = ENTERED + REVIEW_STUCK_DEADLINE_MS;

    const result = await shadowFireDueDeadline(envFor(db), SID, now, undefined, undefined, undefined, true);

    expect(result.wouldFire).toBe(false);
    expect((await getPrCoordination(db, SID))?.state).toBe("REVIEW");
    expect(await listPrCoordinationEvents(db, SID)).toHaveLength(0);
  });

  it("re-arms the MERGE_READY reconcile self-loop (D17) instead of terminating", async () => {
    await insertPrCoordination(db, buildRecord({ state: "MERGE_READY" }));
    const now = ENTERED + MERGE_READY_RECONCILE_DEADLINE_MS;
    const result = await shadowFireDueDeadline(envFor(db), SID, now);
    expect(result.wouldFire).toBe(true);
    const rec = await getPrCoordination(db, SID);
    // Handled self-loop: stays MERGE_READY and re-arms the long window (deadline_at = now + class).
    expect(rec?.state).toBe("MERGE_READY");
    expect(rec?.deadlineAt).toBe(now + MERGE_READY_RECONCILE_DEADLINE_MS);
  });

  it("no-ops when there is no spine record yet", async () => {
    const result = await shadowFireDueDeadline(envFor(db), "missing", ENTERED + REVIEW_STUCK_DEADLINE_MS);
    expect(result.wouldFire).toBe(false);
  });
});
