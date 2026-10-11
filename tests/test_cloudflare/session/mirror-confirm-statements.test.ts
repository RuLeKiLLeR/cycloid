// ARC-1330 (W11-P1/P3 → D-59c, KEYSTONE) — the mirror/display PROJECTION writes against real D1.
//
// D-59c made `project()` the SOLE writer of the legacy session_index mirror columns
// (`review_loop_done_state` / `qa_testing_state` / `cycloid_done_*`) + the display `rich_status`: the
// blind `mirror*ToIndex` fns + the DO persist/recompute setters were deleted and the P1/P3 `WHERE col IS F`
// confirm guard dropped. This test drives the real statements (via `syncSessionProjection`'s `fsmMirror` /
// `fsmDisplay` path) against a migrated sqlite and proves the projection now AUTHORITATIVELY overwrites the
// columns from the spine — the structural fix for the disagreeing-writers class.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { syncSessionProjection } from "../../../apps/control-plane-worker/src/services/session-projection";
import { buildUpsertSessionIndexStatement } from "../../../apps/control-plane-worker/src/session/db";
import type {
  DisplayColumnProjection,
  MirrorColumnProjection,
} from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { SessionState } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");
const SID = "sess-mirror-1";

function migratedD1(): D1Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return new SqliteD1(db) as unknown as D1Database;
}

const SESSION: SessionState = {
  sessionId: SID,
  ownerUserId: "7",
  businessId: "biz-1",
  status: "active",
  createdAt: "2026-07-02T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  closedAt: null,
  lastEventId: null,
  title: "t",
  repoOwner: "x",
  repoName: "y",
  installationId: 42,
} as SessionState;

// A prior mirror value already in the row (as a previous projection would have written it). D-59c's
// unconditional projection write must overwrite this, not preserve it.
const PRIOR = {
  reviewLoopDoneState: "done",
  cycloidDoneState: "done",
  cycloidDoneOutcome: "success",
  cycloidDoneReasonsJson: "[]",
  qaTestingState: "qa-done",
  qaTestingAttemptCount: 1,
  qaTestingMaxAttempts: 3,
};

interface MirrorRow {
  review_loop_done_state: string | null;
  arcanist_done_state: string | null;
  arcanist_done_outcome: string | null;
  arcanist_done_reasons_json: string | null;
  qa_testing_state: string | null;
}

async function readMirror(db: D1Database): Promise<MirrorRow> {
  const row = await db
    .prepare(
      `SELECT review_loop_done_state, arcanist_done_state, arcanist_done_outcome, arcanist_done_reasons_json, qa_testing_state
       FROM session_index WHERE session_id = ?`,
    )
    .bind(SID)
    .first<MirrorRow>();
  if (!row) throw new Error("row missing");
  return row;
}

let db: D1Database;

beforeEach(async () => {
  db = migratedD1();
  // Insert the session row (rich_status = "review_listening"), then stamp a prior mirror value directly so
  // the projection has something to overwrite.
  const upsert = await buildUpsertSessionIndexStatement(db, SESSION, "review_listening", null);
  await upsert.statement.run();
  await db
    .prepare(
      `UPDATE session_index
       SET review_loop_done_state = ?, arcanist_done_state = ?, arcanist_done_outcome = ?,
           arcanist_done_reasons_json = ?, qa_testing_state = ?, qa_testing_attempt_count = ?,
           qa_testing_max_attempts = ?
       WHERE session_id = ?`,
    )
    .bind(
      PRIOR.reviewLoopDoneState,
      PRIOR.cycloidDoneState,
      PRIOR.cycloidDoneOutcome,
      PRIOR.cycloidDoneReasonsJson,
      PRIOR.qaTestingState,
      PRIOR.qaTestingAttemptCount,
      PRIOR.qaTestingMaxAttempts,
      SID,
    )
    .run();
});

describe("D-59c — mirror projection writes (project() is the sole writer)", () => {
  it("an AGREEING fsmMirror re-writes the same value (idempotent)", async () => {
    const agreeing: MirrorColumnProjection = {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationAttemptCount: 99, // counts are NOT written (W11-V7)
      verificationMaxAttempts: 99,
      cycloidDone: { state: "done", outcome: "success", reasons: [] },
    };
    await syncSessionProjection({ db, sessionId: SID, fsmMirror: agreeing, source: "test" });

    const row = await readMirror(db);
    expect(row.review_loop_done_state).toBe("done");
    expect(row.arcanist_done_state).toBe("done");
    expect(row.arcanist_done_outcome).toBe("success");
    expect(row.arcanist_done_reasons_json).toBe("[]");
    expect(row.qa_testing_state).toBe("qa-done");
  });

  it("a DIVERGENT fsmMirror AUTHORITATIVELY overwrites every mirror column (sole writer)", async () => {
    // The spine advanced to a working/exhausted state; the projection is now the authority and must win.
    const divergent: MirrorColumnProjection = {
      reviewLoopDoneState: "working",
      verificationState: "verification-exhausted",
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
      cycloidDone: { state: "working", outcome: null, reasons: ["ci_red"] },
    };
    await syncSessionProjection({ db, sessionId: SID, fsmMirror: divergent, source: "test" });

    const row = await readMirror(db);
    expect(row.review_loop_done_state).toBe("working");
    expect(row.arcanist_done_state).toBe("working");
    expect(row.arcanist_done_outcome).toBeNull();
    expect(row.arcanist_done_reasons_json).toBe('["ci_red"]');
    expect(row.qa_testing_state).toBe("qa-exhausted");
  });

  it("a null-projected mirror clears the columns (the pre-publish / terminal clear-on-terminal oracle)", async () => {
    const cleared: MirrorColumnProjection = {
      reviewLoopDoneState: null,
      verificationState: null,
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
      cycloidDone: { state: "working", outcome: null, reasons: [] },
    };
    await syncSessionProjection({ db, sessionId: SID, fsmMirror: cleared, source: "test" });

    const row = await readMirror(db);
    expect(row.review_loop_done_state).toBeNull();
    expect(row.qa_testing_state).toBeNull();
    expect(row.arcanist_done_state).toBe("working");
  });

  it("the numeric verification counts are never written by the projection (W11-V7 owns cap authority)", async () => {
    const divergentCounts: MirrorColumnProjection = {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationAttemptCount: 7,
      verificationMaxAttempts: 7,
      cycloidDone: { state: "done", outcome: "success", reasons: [] },
    };
    await syncSessionProjection({ db, sessionId: SID, fsmMirror: divergentCounts, source: "test" });

    const counts = await db
      .prepare("SELECT qa_testing_attempt_count, qa_testing_max_attempts FROM session_index WHERE session_id = ?")
      .bind(SID)
      .first<{ qa_testing_attempt_count: number | null; qa_testing_max_attempts: number | null }>();
    // Unchanged from the seeded prior values — the projection touches only the categorical state.
    expect(counts?.qa_testing_attempt_count).toBe(1);
    expect(counts?.qa_testing_max_attempts).toBe(3);
  });

  // ARC-1330 D-59d SF11 (D1 half): D-59d drops ONLY the dead DO-SQLite `verification_*` copies. The D1
  // `session_index` mirror columns (`review_loop_done_state` 0142, `cycloid_done_*` 0199, `verification_state`
  // 0150) are RETAINED — `project()` is their sole writer and they are the live read path until the UI cutover,
  // so there is NO D1 migration (the reserved 0235 slot is freed). This runs against the fully-migrated D1: a
  // phantom drop would make the SELECT throw "no such column", and the projection write proves the columns are
  // still project()'s live targets.
  it("D-59d SF11 — the retained session_index mirror columns still carry project() values (no D1 drop)", async () => {
    const retained = await db
      .prepare(
        `SELECT review_loop_done_state, arcanist_done_state, arcanist_done_outcome, arcanist_done_reasons_json, verification_state
         FROM session_index WHERE session_id = ?`,
      )
      .bind(SID)
      .first<Record<string, unknown>>();
    expect(retained).toBeTruthy();

    const mirror: MirrorColumnProjection = {
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
      cycloidDone: { state: "done", outcome: "success", reasons: [] },
    };
    await syncSessionProjection({ db, sessionId: SID, fsmMirror: mirror, source: "test" });

    const row = await readMirror(db);
    expect(row.review_loop_done_state).toBe("done");
    expect(row.arcanist_done_state).toBe("done");
    expect(row.arcanist_done_outcome).toBe("success");
    expect(row.qa_testing_state).toBe("qa-done");
  });
});

// ── D-59c: the DISPLAY projection write (`rich_status`) — sole writer, no archived side-effect ──
async function readRichStatus(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT rich_status FROM session_index WHERE session_id = ?")
    .bind(SID)
    .first<{ rich_status: string | null }>();
  if (!row) throw new Error("row missing");
  return row.rich_status;
}

describe("D-59c — rich_status projection write (project() is the sole display writer)", () => {
  // beforeEach seeds rich_status = "review_listening" (the upsert above).
  it("an AGREEING fsmDisplay re-writes the same value (idempotent)", async () => {
    const agreeing: DisplayColumnProjection = { richStatus: "review_listening", feChip: "review_listening" };
    await syncSessionProjection({ db, sessionId: SID, fsmDisplay: agreeing, source: "test" });
    expect(await readRichStatus(db)).toBe("review_listening");
  });

  it("a DIVERGENT fsmDisplay AUTHORITATIVELY overwrites rich_status (sole writer)", async () => {
    // The spine reached MERGE_READY (completed); the projection is the authority and must flip the pill.
    const divergent: DisplayColumnProjection = { richStatus: "completed", feChip: "completed" };
    await syncSessionProjection({ db, sessionId: SID, fsmDisplay: divergent, source: "test" });
    expect(await readRichStatus(db)).toBe("completed");
  });

  it("the projection rich_status write never toggles session_index.status (no archived side-effect)", async () => {
    const archivedPill: DisplayColumnProjection = { richStatus: "archived", feChip: "archived" };
    await syncSessionProjection({ db, sessionId: SID, fsmDisplay: archivedPill, source: "test" });
    const row = await db
      .prepare("SELECT status, rich_status FROM session_index WHERE session_id = ?")
      .bind(SID)
      .first<{ status: string; rich_status: string | null }>();
    // rich_status written, but status stays 'active' — unlike buildSyncRichStatusStatement, the isolated
    // display statement carries no `status = 'archived'` side-effect (this call passes no `session`, so no
    // upsert runs; in the live executor the ARCHIVED `status` flip rides the session upsert, not this write).
    expect(row?.rich_status).toBe("archived");
    expect(row?.status).toBe("active");
  });
});
