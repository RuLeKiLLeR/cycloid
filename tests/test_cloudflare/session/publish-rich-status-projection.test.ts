/**
 * Asserts that publish-state writes reproject `session_index.rich_status` to
 * the canonical phase string, not just `publish_status`. Without this, the
 * computePhase precedence fix (publish-terminal beats no-active-prompt
 * sandbox transport states) settles only on live single-session reads —
 * `session_index.rich_status` would keep saying "running" after publish
 * transitions until some other mutation pushed a fresh value through.
 *
 * Covers `computeRichStatusForPublishProjection` end-to-end with a real
 * SQLite-backed `SqlStorage` shim so we exercise the full doDb read chain
 * the publish-service uses at runtime.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.js";
import { computeRichStatusForPublishProjection } from "../../../apps/control-plane-worker/src/session/publish-service.js";
import {
  derivePhaseInfoFromPromptSnapshot,
  derivePhaseInfoFromSql,
  getRichStatusProjectionInputs,
} from "../../../apps/control-plane-worker/src/session/rich-status.js";
import { initSchema } from "../../../apps/control-plane-worker/src/session/schema.js";

function createMockSql(): SqlStorage {
  const db = new Database(":memory:");
  const cursorOf = (rows: unknown[], rowsWritten: number) =>
    ({
      toArray() {
        return rows as Record<string, SqlStorageValue>[];
      },
      rowsRead: rows.length,
      rowsWritten,
      [Symbol.iterator]() {
        return (rows as Iterable<unknown>)[Symbol.iterator]() as Iterator<Record<string, SqlStorageValue>>;
      },
    }) as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
  return {
    exec(query: string, ...params: unknown[]) {
      const isSelect = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
      if (params.length === 0) {
        if (isSelect) {
          return cursorOf(db.prepare(query).all(), 0);
        }
        db.exec(query);
        return cursorOf([], 0);
      }
      const stmt = db.prepare(query);
      if (isSelect) {
        return cursorOf(stmt.all(...(params as unknown[])), 0);
      }
      const result = stmt.run(...(params as unknown[]));
      return cursorOf([], result.changes);
    },
    databaseSize: 0,
  } as unknown as SqlStorage;
}

const SESSION_ID = "test-session";

function seed(opts: {
  sessionKind?: string;
  publishStatus?: string;
  sandboxStatus?: string;
  stopReason?: string | null;
  reviewListeningActive?: boolean;
}): SqlStorage {
  const sql = createMockSql();
  initSchema(sql);
  doDb.createSession(sql, {
    sessionId: SESSION_ID,
    ownerUserId: "u-1",
    sessionKind: (opts.sessionKind ?? "repo") as never,
  });
  doDb.updateSessionFields(sql, SESSION_ID, {
    publishStatus: opts.publishStatus as never,
    ...(opts.reviewListeningActive !== undefined ? { reviewListeningActive: opts.reviewListeningActive } : {}),
  });
  doDb.ensureSandboxState(sql, SESSION_ID);
  doDb.updateSandboxState(sql, SESSION_ID, {
    status: opts.sandboxStatus ?? "ready",
    ...(opts.stopReason !== undefined ? { stopReason: opts.stopReason as never } : {}),
  });
  return sql;
}

describe("computeRichStatusForPublishProjection", () => {
  it("published + reconnecting -> completed (the bug this PR fixes)", () => {
    const sql = seed({ publishStatus: "published", sandboxStatus: "reconnecting" });
    expect(computeRichStatusForPublishProjection(sql, SESSION_ID)).toBe("completed");
  });

  it("publishing + reconnecting -> finalizing", () => {
    const sql = seed({ publishStatus: "publishing", sandboxStatus: "reconnecting" });
    expect(computeRichStatusForPublishProjection(sql, SESSION_ID)).toBe("finalizing");
  });

  it("failed + reconnecting -> failed", () => {
    const sql = seed({ publishStatus: "failed", sandboxStatus: "reconnecting" });
    expect(computeRichStatusForPublishProjection(sql, SESSION_ID)).toBe("failed");
  });

  it("not_started + ready -> idle (no publish state to settle on)", () => {
    const sql = seed({ publishStatus: "not_started", sandboxStatus: "ready" });
    expect(computeRichStatusForPublishProjection(sql, SESSION_ID)).toBe("idle");
  });

  it("returns null when session row is missing", () => {
    const sql = createMockSql();
    initSchema(sql);
    expect(computeRichStatusForPublishProjection(sql, "missing")).toBeNull();
  });
});

describe("plan approval projection inputs", () => {
  for (const [status, expectedPending, expectedPhase] of [
    ["none", false, "idle"],
    ["pending", true, "waiting_for_input"],
    ["approved", false, "idle"],
    ["superseded", false, "idle"],
  ] as const) {
    it(`projects a latest ${status} plan row`, () => {
      const sql = seed({ publishStatus: "not_started", sandboxStatus: "ready" });
      doDb.upsertSessionPlan(sql, {
        sessionId: SESSION_ID,
        planPromptId: `p-plan-${status}`,
        implementationPromptId: null,
        markdown: "# Plan\n\nTest it",
        excerpt: "Test it",
        artifactId: null,
        valid: true,
        missingReason: null,
        missingHeadings: [],
        status,
        revision: 7,
        userEdited: false,
        approvedBy: null,
        approvedAt: null,
        source: "generated",
      });

      expect(getRichStatusProjectionInputs(sql, SESSION_ID, null)).toMatchObject({
        planApprovalPending: expectedPending,
        planRevision: 7,
        planStatus: status,
      });

      const session = doDb.getSession(sql, SESSION_ID);
      if (!session) throw new Error("session not seeded");
      expect(
        derivePhaseInfoFromSql(sql, session, doDb.getSandboxState(sql, SESSION_ID), "not_started", null, false).phase,
      ).toBe(expectedPhase);
    });
  }

  it("uses dormant metadata when no plan row exists", () => {
    const sql = seed({ publishStatus: "not_started", sandboxStatus: "ready" });

    expect(getRichStatusProjectionInputs(sql, SESSION_ID, null)).toMatchObject({
      planApprovalPending: false,
      planRevision: 0,
      planStatus: "none",
    });
  });
});

// The enqueue gate (and retry gate) derive a session's phase via
// `derivePhaseInfoFromSql`. Regression coverage for the review-loop incident
// where a review_listening session whose round-1 publish ended on a red publish
// terminal (e.g. the head-change publish guard) was mis-derived as a
// publish-driven terminal phase here — because this helper dropped the
// `reviewListeningActive` signal that short-circuits to `review_listening`
// everywhere else. That stale phase made the gate reject the next review round's
// enqueue with `session_not_sendable`, permanently pausing the PR. The field
// must drive the phase, not arg position.
describe("derivePhaseInfoFromSql review-listening precedence", () => {
  // Same prod-shaped sandbox state (reaped = resumable-stopped) for both flag
  // values, so reviewListeningActive is the *sole* difference. With the flag on,
  // the review_listening short-circuit wins; with it off, computePhase's
  // stopped-sandbox branch (stopped && !reviewListeningActive) takes over. This
  // is the sharpest proof the field — not arg position — drives the phase.
  it("flips review_listening <-> stopped on the flag alone for a resumable-stopped sandbox", () => {
    for (const [reviewListeningActive, expectedPhase] of [
      [true, "review_listening"],
      [false, "stopped"],
    ] as const) {
      const sql = seed({
        publishStatus: "failed",
        sandboxStatus: "stopped",
        stopReason: "reaped",
        reviewListeningActive,
      });
      const session = doDb.getSession(sql, SESSION_ID);
      if (!session) throw new Error("session not seeded");
      const sandboxState = doDb.getSandboxState(sql, SESSION_ID);
      expect(derivePhaseInfoFromSql(sql, session, sandboxState, "failed", null, reviewListeningActive).phase).toBe(
        expectedPhase,
      );
    }
  });

  // The exact prod failure: a *live* (non-stopped) review_listening session whose
  // round-1 publish ended on a red publish terminal. Listening must win; dropping
  // the flag (false) exposes the publish-driven `failed` that paused the PR.
  it("keeps review_listening over a failed publish state on a live sandbox", () => {
    const sql = seed({
      publishStatus: "failed",
      sandboxStatus: "ready",
      reviewListeningActive: true,
    });
    const session = doDb.getSession(sql, SESSION_ID);
    if (!session) throw new Error("session not seeded");
    const sandboxState = doDb.getSandboxState(sql, SESSION_ID);
    expect(derivePhaseInfoFromSql(sql, session, sandboxState, "failed", null, true).phase).toBe("review_listening");
    expect(derivePhaseInfoFromSql(sql, session, sandboxState, "failed", null, false).phase).toBe("failed");
  });
});

// The retry gate uses the snapshot variant; it must carry reviewListeningActive
// identically so a listening session isn't mis-derived as blocked there either.
describe("derivePhaseInfoFromPromptSnapshot review-listening precedence", () => {
  it("keeps review_listening over a failed publish state", () => {
    const sql = seed({
      publishStatus: "failed",
      sandboxStatus: "ready",
      reviewListeningActive: true,
    });
    const session = doDb.getSession(sql, SESSION_ID);
    if (!session) throw new Error("session not seeded");
    const sandboxState = doDb.getSandboxState(sql, SESSION_ID);
    expect(derivePhaseInfoFromPromptSnapshot(sql, session, sandboxState, "failed", null, [], true).phase).toBe(
      "review_listening",
    );
    expect(derivePhaseInfoFromPromptSnapshot(sql, session, sandboxState, "failed", null, [], false).phase).toBe(
      "failed",
    );
  });
});
