// ARC-1330 (PR 27A) — the `getSessionTimeline` read query / lossless-contract proof (design §18.5).
//
// The headline test is the RECONSTRUCTION test the spec names: a recorded multi-cycle session log
// (publish → Greptile review → epoch → head.changed → 2nd review → epoch → caught_up → verification.pass
// → MERGE_READY) replayed into the exact ordered timeline + per-stage `dwell_ms` totals. It proves the
// `EventMetadata` contract carries enough to reproduce the per-stage dwell axis from the log alone — the
// build-to-verify harness behind the future fleet-dwell dashboard.
//
// The remaining cases pin the metadata fold for the `REVIEW` sub-stages ("Fixing CI" via the `epoch.*`
// `ci_fix` trigger + the `ci.signal` green reset; "Fixing verification findings" via the `verification.*`
// verdict), the `ANSWERED_NO_PR` `prompt_intends_change` split on `currentStage`, the DB round-trip via
// `getSessionTimeline`, and the empty-log edge.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { buildTimeline, getSessionTimeline } from "../../../apps/control-plane-worker/src/session/fsm/timeline";
import {
  appendPrCoordinationEvent,
  type PrCoordinationEvent,
  type PrCoordinationEventInput,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
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

// In-memory event shape (metadata already JSON-parsed), as `listPrCoordinationEvents` returns it.
function ev(over: Partial<PrCoordinationEvent>): PrCoordinationEvent {
  return {
    sessionId: "sess-1",
    version: 1,
    fromState: "REVIEW",
    toState: "REVIEW",
    event: "review.received",
    at: 0,
    actor: "webhook",
    metadata: null,
    dwellMs: null,
    settleDedupKey: null,
    ...over,
  };
}

// The canonical multi-cycle log the spec names. Two review→epoch cycles with a head change between,
// then verification passes into MERGE_READY. Every REVIEW dwell here is plain "Cycloid is working on the review"
// (no ciFix epoch, no app_breaks verdict); VERIFYING is "Testing the app"; the publish dwell is the
// FINALIZING/PUBLISHING copy. `dwell_ms` values are distinct so a mis-bucketed sum is caught.
function canonicalLog(): PrCoordinationEvent[] {
  return [
    ev({
      version: 1,
      fromState: "PUBLISHING",
      toState: "REVIEW",
      event: "publish.pr_opened",
      at: 100,
      actor: "internal",
      dwellMs: 100,
      metadata: { type: "publish.pr_opened" },
    }),
    ev({
      version: 2,
      event: "review.received",
      at: 300,
      dwellMs: 200,
      metadata: {
        type: "review.received",
        reviewerKind: "bot",
        reviewerId: "greptile",
        reviewSourceId: "r1",
        actionable: true,
      },
    }),
    ev({
      version: 3,
      event: "epoch.committed",
      at: 600,
      actor: "internal",
      dwellMs: 300,
      metadata: {
        type: "epoch.committed",
        epochId: "e1",
        epochTrigger: "review",
        sourceIds: ["r1"],
        headBefore: "h0",
        headAfter: "h1",
        disposition: "fixed",
      },
    }),
    ev({
      version: 4,
      event: "head.changed",
      at: 1000,
      dwellMs: 400,
      metadata: { type: "head.changed", headSha: "h1", prevHeadSha: "h0" },
    }),
    ev({
      version: 5,
      event: "review.received",
      at: 1500,
      dwellMs: 500,
      metadata: {
        type: "review.received",
        reviewerKind: "bot",
        reviewerId: "greptile",
        reviewSourceId: "r2",
        actionable: true,
      },
    }),
    ev({
      version: 6,
      event: "epoch.committed",
      at: 2100,
      actor: "internal",
      dwellMs: 600,
      metadata: {
        type: "epoch.committed",
        epochId: "e2",
        epochTrigger: "review",
        sourceIds: ["r2"],
        headBefore: "h1",
        headAfter: "h2",
        disposition: "fixed",
      },
    }),
    ev({
      version: 7,
      toState: "VERIFYING",
      event: "caught_up",
      at: 2800,
      actor: "internal",
      dwellMs: 700,
      metadata: { type: "caught_up" },
    }),
    ev({
      version: 8,
      fromState: "VERIFYING",
      toState: "MERGE_READY",
      event: "verification.pass",
      at: 3600,
      actor: "verification",
      dwellMs: 800,
      metadata: { type: "verification.pass", verificationRunId: 1, verdict: "pass", headSha: "h2" },
    }),
  ];
}

describe("getSessionTimeline reconstruction (PR 27A, §18.5)", () => {
  it("replays the canonical multi-cycle log into the exact ordered timeline + per-stage dwell totals", () => {
    const timeline = buildTimeline(canonicalLog());

    // Ordered, lossless event list with the right per-event stage attribution.
    expect(timeline.events.map((e) => e.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(timeline.events.map((e) => e.event)).toEqual([
      "publish.pr_opened",
      "review.received",
      "epoch.committed",
      "head.changed",
      "review.received",
      "epoch.committed",
      "caught_up",
      "verification.pass",
    ]);
    expect(timeline.events.map((e) => e.stage)).toEqual([
      "Finalizing / Opening PR", // dwelt in PUBLISHING
      "Cycloid is working on the review", // REVIEW
      "Cycloid is working on the review",
      "Cycloid is working on the review",
      "Cycloid is working on the review",
      "Cycloid is working on the review",
      "Cycloid is working on the review",
      "Testing the app", // dwelt in VERIFYING
    ]);

    // Σ dwell_ms grouped by stage — the dashboard's per-stage time-in-stage.
    expect(timeline.stageDurations).toEqual({
      "Finalizing / Opening PR": 100,
      "Cycloid is working on the review": 200 + 300 + 400 + 500 + 600 + 700, // = 2700
      "Testing the app": 800,
    });

    // The session's present stage = stageOf the last event's to_state (MERGE_READY).
    expect(timeline.currentStage).toBe("Ready to merge — watching for reviews");
  });

  it('attributes a REVIEW dwell after a ci_fix epoch to "Fixing CI" and resets on green CI', () => {
    const timeline = buildTimeline([
      // Dwell in REVIEW BEFORE the ciFix epoch's effect lands → still "Cycloid is working on the review".
      ev({
        version: 1,
        event: "epoch.committed",
        dwellMs: 50,
        metadata: {
          type: "epoch.committed",
          epochId: "e1",
          epochTrigger: "ci_fix",
          sourceIds: [],
          headBefore: null,
          headAfter: null,
          disposition: null,
        },
      }),
      // ciFix now active → this REVIEW dwell is "Fixing CI"; green CI then settles it.
      ev({ version: 2, event: "ci.signal", dwellMs: 60, metadata: { type: "ci.signal", ciState: "green" } }),
      // ciFix reset by the green signal → back to "Cycloid is working on the review".
      ev({ version: 3, toState: "VERIFYING", event: "caught_up", dwellMs: 70, metadata: { type: "caught_up" } }),
    ]);

    expect(timeline.events.map((e) => e.stage)).toEqual([
      "Cycloid is working on the review",
      "Fixing CI",
      "Cycloid is working on the review",
    ]);
    expect(timeline.stageDurations).toEqual({ "Cycloid is working on the review": 50 + 70, "Fixing CI": 60 });
  });

  it("renders an epoch.blocked{response_failed} → NEEDS_YOU stage without throwing (maps the EpochBlockReason)", () => {
    // The metadata carries the EpochBlockReason "response_failed", not the record's "review_response_failed"
    // blocked_reason. Before the map, stageOf indexed BLOCKED_REASON_DISPLAY["response_failed"] (undefined)
    // and threw when reconstructing any timeline containing this terminal (ARC-1330).
    const timeline = buildTimeline([
      ev({
        version: 1,
        fromState: "REVIEW",
        toState: "NEEDS_YOU",
        event: "epoch.blocked",
        dwellMs: 40,
        metadata: {
          type: "epoch.blocked",
          epochId: "e1",
          reason: "response_failed",
          epochTrigger: "review",
          sourceIds: [],
          headBefore: null,
          headAfter: null,
          disposition: null,
        },
      }),
    ]);
    expect(timeline.currentStage).toContain("Couldn't post review response");
  });

  it('attributes a REVIEW dwell under an app_breaks verdict to "Fixing verification findings"', () => {
    const timeline = buildTimeline([
      ev({
        version: 1,
        fromState: "VERIFYING",
        toState: "REVIEW",
        event: "verification.app_breaks",
        actor: "verification",
        dwellMs: 10,
        metadata: { type: "verification.app_breaks", verificationRunId: 1, verdict: "app_breaks", headSha: "h1" },
      }),
      ev({
        version: 2,
        event: "review.received",
        dwellMs: 20,
        metadata: {
          type: "review.received",
          reviewerKind: "human",
          reviewerId: "u1",
          reviewSourceId: "r1",
          actionable: true,
        },
      }),
    ]);

    expect(timeline.events.map((e) => e.stage)).toEqual(["Testing the app", "Fixing verification findings"]);
  });

  it("folds prompt_intends_change into the ANSWERED_NO_PR currentStage copy", () => {
    const intended = buildTimeline([
      ev({
        version: 1,
        fromState: "FINALIZING",
        toState: "ANSWERED_NO_PR",
        event: "postexec.done",
        actor: "internal",
        dwellMs: 5,
        metadata: { type: "postexec.done", hasChanges: false, promptIntendsChange: true },
      }),
    ]);
    expect(intended.currentStage).toBe("No change produced");

    const qaTurn = buildTimeline([
      ev({
        version: 1,
        fromState: "FINALIZING",
        toState: "ANSWERED_NO_PR",
        event: "postexec.done",
        actor: "internal",
        dwellMs: 5,
        metadata: { type: "postexec.done", hasChanges: false, promptIntendsChange: false },
      }),
    ]);
    expect(qaTurn.currentStage).toBe("Answered");
  });

  it("returns an empty timeline for a session with no log", () => {
    expect(buildTimeline([])).toEqual({ currentStage: null, events: [], stageDurations: {} });
  });

  it("ignores null dwell_ms in the per-stage sums", () => {
    const timeline = buildTimeline([
      ev({ version: 1, fromState: "REVIEW", event: "review.received", dwellMs: null }),
      ev({ version: 2, fromState: "REVIEW", event: "review.received", dwellMs: 40 }),
    ]);
    expect(timeline.stageDurations).toEqual({ "Cycloid is working on the review": 40 });
  });
});

describe("getSessionTimeline DB round-trip (PR 27A)", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("reconstructs the timeline from the persisted log regardless of insertion order", async () => {
    // Append the canonical log OUT of version order to prove the read orders by version.
    const log = canonicalLog();
    for (const e of [log[2], log[0], log[7], log[5], log[1], log[4], log[3], log[6]]) {
      const input: PrCoordinationEventInput = {
        sessionId: e.sessionId,
        version: e.version,
        fromState: e.fromState,
        toState: e.toState,
        event: e.event,
        at: e.at,
        actor: e.actor,
        metadata: e.metadata,
        dwellMs: e.dwellMs,
      };
      await appendPrCoordinationEvent(db, input);
    }

    const timeline = await getSessionTimeline(db, "sess-1");

    expect(timeline.events.map((x) => x.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(timeline.stageDurations).toEqual({
      "Finalizing / Opening PR": 100,
      "Cycloid is working on the review": 2700,
      "Testing the app": 800,
    });
    expect(timeline.currentStage).toBe("Ready to merge — watching for reviews");
  });

  it("returns an empty timeline for an unknown session", async () => {
    await expect(getSessionTimeline(db, "nope")).resolves.toEqual({
      currentStage: null,
      events: [],
      stageDurations: {},
    });
  });
});
