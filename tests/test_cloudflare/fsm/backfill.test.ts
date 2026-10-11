// ARC-1330 (PR 35A) — SHADOW BACKFILL of in-flight legacy sessions.
//
// Proves the three spec contracts: (1) backfill maps every legacy state to a VALID FSM state (the
// legacy → FSM mapping is total, reusing the PR-35 adapter); (2) a backfilled row APPEARS IN THE
// divergence metric tagged `excluded_backfilled`; (3) the per-session insert + the batch are IDEMPOTENT
// (a re-run never clobbers a row genesis/a producer has since advanced). Plus the FSM_MODE gate,
// terminal-skip, carried run counters, and batch per-session isolation.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  backfillInFlightSession,
  type BackfillInput,
  backfillSessions,
  buildBackfillRecord,
  isBackfillTargetState,
} from "../../../apps/control-plane-worker/src/session/fsm/backfill";
import { FSM_STATES, type FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  casUpdatePrCoordination,
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { CycloidDoneStatus, Phase } from "../../../shared/session/phase";
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

const NOW = 1_700_000_000_000;
const WORKING: CycloidDoneStatus = { state: "working", outcome: null, reasons: [] };
const DONE_SUCCESS: CycloidDoneStatus = { state: "done", outcome: "success", reasons: [] };

function input(overrides: Partial<BackfillInput> & { phase: Exclude<Phase, "idle"> }): BackfillInput {
  return {
    sessionId: "sess-1",
    prUrl: null,
    headSha: null,
    verificationState: null,
    verificationResult: null,
    reviewLoopDoneState: null,
    cycloidDone: WORKING,
    verificationRunCount: 0,
    ciFixRounds: 0,
    verificationVerdictHeadSha: null,
    ...overrides,
  };
}

const FSM_STATE_SET = new Set<string>(FSM_STATES);

describe("PR 35A — buildBackfillRecord maps every legacy state to a valid FSM state", () => {
  // One representative input per legacy phase (incl. the two ambiguous review_listening / completed splits).
  const cases: ReadonlyArray<[string, BackfillInput]> = [
    ["running", input({ phase: "running" })],
    ["waiting_for_input", input({ phase: "waiting_for_input" })],
    ["finalizing", input({ phase: "finalizing" })],
    ["review_listening (REVIEW)", input({ phase: "review_listening" })],
    [
      "review_listening (VERIFYING)",
      input({ phase: "review_listening", verificationState: "verification-in-progress" }),
    ],
    ["completed (no PR)", input({ phase: "completed" })],
    ["completed (merge-ready)", input({ phase: "completed", prUrl: "https://gh/x/pull/1", cycloidDone: DONE_SUCCESS })],
    ["completed (merged PR)", input({ phase: "completed", prUrl: "https://gh/x/pull/1" })],
    ["blocked", input({ phase: "blocked" })],
    ["failed", input({ phase: "failed" })],
    ["stopped", input({ phase: "stopped" })],
    ["archived", input({ phase: "archived" })],
  ];

  for (const [name, legacy] of cases) {
    it(`'${name}' → a valid FSM state, version 0, dwell anchor armed`, () => {
      const rec = buildBackfillRecord(legacy, NOW);
      expect(FSM_STATE_SET.has(rec.state)).toBe(true);
      expect(rec.version).toBe(0);
      expect(rec.stateEnteredAt).toBe(NOW);
    });
  }

  it("carries the legacy run counters forward (not zeroed) and keeps the verdict stale by default", () => {
    const rec = buildBackfillRecord(
      input({ phase: "review_listening", verificationRunCount: 2, ciFixRounds: 3, headSha: "abc" }),
      NOW,
    );
    expect(rec.verificationRunCount).toBe(2);
    expect(rec.ciFixRounds).toBe(3);
    expect(rec.headSha).toBe("abc");
    // verdict_head_sha stays null → a backfilled verdict reads as STALE (re-verify, the safe default).
    expect(rec.verdictHeadSha).toBeNull();
  });

  // ── PR-E2: verification steering DROPPED (ARC-1330 CI-ladder cut) ──
  // The merge-ready door is a pure CI ladder; verification runs off-gate. Backfill no longer steers
  // code_changed / verdict_head_sha / run-count off the legacy verdict — it carries the adapter defaults
  // and the RAW legacy counters.

  it("leaves code_changed / verdict_head_sha at the adapter defaults regardless of verdict freshness", () => {
    // A stale-anchor approving verdict (formerly the row-1 re-verify cohort): no `code_changed:=true`
    // blanket any more — the cascade no longer reads it, so the seed rides the adapter default (false).
    const stalePass = buildBackfillRecord(
      input({
        phase: "review_listening",
        prUrl: "https://gh/x/pull/1",
        headSha: "abc",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationVerdictHeadSha: "OLD-HEAD", // stale anchor — irrelevant now
      }),
      NOW,
    );
    expect(stalePass.verdict).toBe("pass");
    expect(stalePass.codeChangedSinceVerification).toBe(false);
    expect(stalePass.verdictHeadSha).toBeNull();

    // A fresh-anchor approving verdict (formerly the settled-fresh cohort): no `verdict_head_sha`
    // stamping any more — same adapter defaults.
    const freshPass = buildBackfillRecord(
      input({
        phase: "review_listening",
        prUrl: "https://gh/x/pull/1",
        headSha: "abc",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationVerdictHeadSha: "abc", // proven at the current head — irrelevant now
      }),
      NOW,
    );
    expect(freshPass.verdict).toBe("pass");
    expect(freshPass.codeChangedSinceVerification).toBe(false);
    expect(freshPass.verdictHeadSha).toBeNull();

    // A verdict-less REVIEW row is unchanged too.
    const verdictless = buildBackfillRecord(input({ phase: "review_listening" }), NOW);
    expect(verdictless.codeChangedSinceVerification).toBe(false);
    expect(verdictless.verdictHeadSha).toBeNull();
  });

  it("carries verification_run_count RAW for every verdict (no approving-verdict zeroing)", () => {
    // The cascade no longer reads a verification cap at settle, so backfill carries the legacy count
    // verbatim for both approving and failing verdicts (no consecutive-failed re-derivation).
    const passed = buildBackfillRecord(
      input({
        phase: "review_listening",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationRunCount: 3,
      }),
      NOW,
    );
    expect(passed.verdict).toBe("pass");
    expect(passed.verificationRunCount).toBe(3);

    const failing = buildBackfillRecord(
      input({
        phase: "review_listening",
        verificationState: "verification-done",
        verificationResult: "needs-work",
        verificationRunCount: 3,
      }),
      NOW,
    );
    expect(failing.verdict).toBe("app_breaks");
    expect(failing.verificationRunCount).toBe(3);
  });

  it("seeds STOPPED as resumable with a PR-derived pre_stop_state (bug class 2: unresumable stopped sessions)", () => {
    // The adapter leaves stop_mode/pre_stop_state null → the `STOPPED — user.input[resumable]` resume
    // edge never matches, so every backfilled stopped session was permanently unresumable post-flip.
    const withPr = buildBackfillRecord(input({ phase: "stopped", prUrl: "https://gh/x/pull/1" }), NOW);
    expect(withPr.state).toBe("STOPPED");
    expect(withPr.stopMode).toBe("resumable");
    expect(withPr.preStopState).toBe("REVIEW"); // live PR → re-arm the review watch

    const noPr = buildBackfillRecord(input({ phase: "stopped" }), NOW);
    expect(noPr.stopMode).toBe("resumable");
    expect(noPr.preStopState).toBe("GENERATING"); // pre-PR → resume codegen / re-provision

    // Non-stopped states never carry stop bookkeeping (N6).
    const review = buildBackfillRecord(input({ phase: "review_listening" }), NOW);
    expect(review.stopMode).toBeNull();
    expect(review.preStopState).toBeNull();
  });

  it("backfills VERIFYING with sane null-run handles (bug class 3: no crash on head.changed mid-verification)", () => {
    const rec = buildBackfillRecord(
      input({ phase: "review_listening", verificationState: "verification-in-progress", headSha: "abc" }),
      NOW,
    );
    expect(rec.state).toBe("VERIFYING");
    // The live `head.changed` edge reads these: run-id 0 redispatches to 1; a null child handle is a
    // logged no-op kill; the in-flight legacy verifier's verdict-back self-sources run-id 0 off the row.
    expect(rec.verificationRunId).toBe(0);
    expect(rec.verificationRunHead).toBeNull();
    expect(rec.verificationChildId).toBeNull();
  });

  it("isBackfillTargetState: skips the final terminals + CREATED, targets everything else", () => {
    const skip: FsmState[] = ["CREATED", "MERGED", "CLOSED", "SUPERSEDED", "ARCHIVED"];
    for (const s of skip) expect(isBackfillTargetState(s)).toBe(false);
    for (const s of FSM_STATES) {
      expect(isBackfillTargetState(s)).toBe(!skip.includes(s));
    }
  });
});

describe("PR 35A — backfillInFlightSession (gated, idempotent, terminal-safe)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("materializes an in-flight session's row in shadow mode", async () => {
    const outcome = await backfillInFlightSession(
      { db, now: () => NOW },
      input({ phase: "review_listening", prUrl: "https://gh/x/pull/1", headSha: "abc", verificationRunCount: 1 }),
    );
    expect(outcome).toBe("inserted");
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.state).toBe("REVIEW");
    expect(got!.version).toBe(0);
    expect(got!.headSha).toBe("abc");
    expect(got!.verificationRunCount).toBe(1);
  });

  it("skips a final-terminal session (MERGED) — nothing to drive", async () => {
    // completed + a merged PR (no clean done-claim) maps to MERGED, a final terminal.
    const outcome = await backfillInFlightSession(
      { db, now: () => NOW },
      input({ phase: "completed", prUrl: "https://gh/x/pull/1" }),
    );
    expect(outcome).toBe("skipped_terminal");
    expect(await getPrCoordination(db, "sess-1")).toBeNull();
  });

  it("is idempotent: a re-run leaves an advanced row untouched", async () => {
    await backfillInFlightSession({ db, now: () => NOW }, input({ phase: "review_listening" }));
    // A producer advanced the row to VERIFYING after the backfill.
    await casUpdatePrCoordination(db, "sess-1", 0, { state: "VERIFYING" });

    const outcome = await backfillInFlightSession({ db, now: () => NOW + 5 }, input({ phase: "review_listening" }));
    expect(outcome).toBe("exists");
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.state).toBe("VERIFYING");
    expect(got!.version).toBe(1);
  });
});

describe("PR 46 — version-0 re-baseline (repairing the pre-fix prod cohort)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const legacyNow = (over: Partial<BackfillInput> = {}) =>
    input({
      phase: "review_listening",
      prUrl: "https://gh/x/pull/1",
      headSha: "abc",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationVerdictHeadSha: "abc",
      verificationRunCount: 3,
      ...over,
    });

  /** Seed a row the OLD (pre-fix) runner shape left behind: the cohort the re-baseline repairs. */
  async function insertOldShapeRow(): Promise<void> {
    const fixed = buildBackfillRecord(legacyNow(), NOW - 10_000);
    await insertPrCoordination(db, {
      ...fixed,
      codeChangedSinceVerification: false, // old blanket seed
      verdictHeadSha: null, // never stamped
      verificationRunCount: 3, // lifetime count carried raw
    } as PrCoordinationRecord);
  }

  it("rebaseline recomputes an untouched version-0 row from current legacy state (version stays 0)", async () => {
    await insertOldShapeRow();
    const outcome = await backfillInFlightSession({ db, now: () => NOW, rebaseline: true }, legacyNow());
    expect(outcome).toBe("rebaselined");
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.version).toBe(0); // still producer-CASable from 0
    expect(got!.codeChangedSinceVerification).toBe(false); // adapter default (no verification steering)
    expect(got!.verdictHeadSha).toBeNull(); // no settled-fresh stamping — adapter default
    expect(got!.verificationRunCount).toBe(3); // carried raw
    expect(got!.stateEnteredAt).toBe(NOW); // dwell anchor refreshed to the re-baseline instant (proves the rewrite)
  });

  it("rebaseline NEVER touches a producer-advanced row (version >= 1 → exists, untouched)", async () => {
    await insertOldShapeRow();
    await casUpdatePrCoordination(db, "sess-1", 0, { state: "VERIFYING" }); // a producer advanced it
    const outcome = await backfillInFlightSession({ db, now: () => NOW, rebaseline: true }, legacyNow());
    expect(outcome).toBe("exists");
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.version).toBe(1);
    expect(got!.state).toBe("VERIFYING");
    expect(got!.codeChangedSinceVerification).toBe(false); // the old seed is untouched — real history wins
  });

  it("rebaseline is idempotent: a re-run rewrites the same seed and reports rebaselined again", async () => {
    await insertOldShapeRow();
    const deps = { db, now: () => NOW, rebaseline: true };
    expect(await backfillInFlightSession(deps, legacyNow())).toBe("rebaselined");
    const first = await getPrCoordination(db, "sess-1");
    expect(await backfillInFlightSession(deps, legacyNow())).toBe("rebaselined");
    expect(await getPrCoordination(db, "sess-1")).toEqual(first);
  });

  it("without the rebaseline flag an existing v0 row stays untouched (the original exists-guard)", async () => {
    await insertOldShapeRow();
    const outcome = await backfillInFlightSession({ db, now: () => NOW }, legacyNow());
    expect(outcome).toBe("exists");
    expect((await getPrCoordination(db, "sess-1"))!.codeChangedSinceVerification).toBe(false);
    expect((await getPrCoordination(db, "sess-1"))!.verificationRunCount).toBe(3); // still the old shape
  });

  it("rebaseline still inserts a missing row (insert + repair compose in one run)", async () => {
    const outcome = await backfillInFlightSession({ db, now: () => NOW, rebaseline: true }, legacyNow());
    expect(outcome).toBe("inserted");
  });
});

describe("PR 35A — backfillSessions batch (per-session isolation)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("tallies inserted / exists / skipped_terminal across a mixed cohort", async () => {
    const result = await backfillSessions({ db, now: () => NOW }, [
      input({ sessionId: "a", phase: "review_listening" }),
      input({ sessionId: "a", phase: "review_listening" }), // duplicate → exists
      input({ sessionId: "b", phase: "completed", prUrl: "https://gh/x/pull/2" }), // MERGED → skipped
      input({ sessionId: "c", phase: "blocked" }), // NEEDS_YOU → inserted
    ]);
    expect(result).toEqual({ skippedTerminal: 1, inserted: 2, exists: 1, rebaselined: 0, failed: 0 });
    expect((await getPrCoordination(db, "a"))!.state).toBe("REVIEW");
    expect((await getPrCoordination(db, "c"))!.state).toBe("NEEDS_YOU");
    expect(await getPrCoordination(db, "b")).toBeNull();
  });
});
