// ARC-1330 (PR 39) — review-webhook producer: GitHub review signal → `review.received` mapping.
//
// The PR-39 contract test: the PURE classifier (`actionable` over the three webhook shapes + the
// bot|human reviewer kind) — the spec-named "actionable classification" — plus the builder
// (event/metadata/actor) and the record-derived resolver, then a small integration leg driving
// `applyEvent` over a real migrated D1 (the Wave-1 createMigratedSqlite/asD1 idiom) to prove an
// actionable review dispatches an epoch (REVIEW self-loop + the MERGE_READY re-open) while noise is a
// no-op that never re-opens a Ready PR.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyEvent,
  noopSideEffectSink,
  noopWorklistSink,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import { buildLiveGuardResolver } from "../../../apps/control-plane-worker/src/session/fsm/live-resolver";
import {
  buildReviewReceivedEmission,
  classifyReviewActionable,
  classifyReviewerKind,
  classifyReviewReceived,
  type ReviewEmission,
  shadowEmitReviewReceived,
} from "../../../apps/control-plane-worker/src/session/fsm/review-producer";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

const NOW = 1_700_000_000_000;

describe("review producer — actionable classification (PR 39)", () => {
  it("classifyReviewerKind: GitHub type User → human, every non-User → bot (the handler's isBot rule)", () => {
    expect(classifyReviewerKind("User")).toBe("human");
    expect(classifyReviewerKind("Bot")).toBe("bot");
    expect(classifyReviewerKind("Organization")).toBe("bot");
    // A missing/blank type is the safer shadow default (an unattributed automated signal never gates a human).
    expect(classifyReviewerKind("")).toBe("bot");
  });

  it("review_submission: approved → noise, changes_requested → actionable, commented body-gated", () => {
    const base = {
      webhookKind: "review_submission" as const,
      actorType: "User",
      actorLogin: "alice",
      sourceId: "review:1",
    };
    // Approval carries no work — must not re-open a Ready PR.
    expect(classifyReviewActionable({ ...base, reviewState: "approved", body: "lgtm" })).toBe(false);
    // Changes requested is always actionable, even with an empty body.
    expect(classifyReviewActionable({ ...base, reviewState: "changes_requested", body: null })).toBe(true);
    // A "commented" review is actionable only when it carries a non-blank body.
    expect(classifyReviewActionable({ ...base, reviewState: "commented", body: "please fix X" })).toBe(true);
    expect(classifyReviewActionable({ ...base, reviewState: "commented", body: "   " })).toBe(false);
    expect(classifyReviewActionable({ ...base, reviewState: "commented", body: null })).toBe(false);
    // Case-insensitive state matching (GitHub sends upper/lower variants).
    expect(classifyReviewActionable({ ...base, reviewState: "APPROVED", body: "x" })).toBe(false);
    expect(classifyReviewActionable({ ...base, reviewState: "CHANGES_REQUESTED", body: null })).toBe(true);
    // An unknown/dismissed state falls back to the body gate.
    expect(classifyReviewActionable({ ...base, reviewState: "dismissed", body: "note" })).toBe(true);
    expect(classifyReviewActionable({ ...base, reviewState: "dismissed", body: "" })).toBe(false);
  });

  it("review_comment + issue_comment: actionable iff a non-blank body", () => {
    expect(
      classifyReviewActionable({
        webhookKind: "review_comment",
        actorType: "Bot",
        actorLogin: "greptile",
        sourceId: "comment:9",
        body: "nit: rename",
      }),
    ).toBe(true);
    expect(
      classifyReviewActionable({
        webhookKind: "review_comment",
        actorType: "Bot",
        actorLogin: "greptile",
        sourceId: "comment:9",
        body: "  ",
      }),
    ).toBe(false);
    expect(
      classifyReviewActionable({
        webhookKind: "issue_comment",
        actorType: "User",
        actorLogin: "bob",
        sourceId: "issue_comment:3",
        body: "can you handle the edge case?",
      }),
    ).toBe(true);
    expect(
      classifyReviewActionable({
        webhookKind: "issue_comment",
        actorType: "User",
        actorLogin: "bob",
        sourceId: "issue_comment:3",
        body: null,
      }),
    ).toBe(false);
  });

  it("classifyReviewReceived assembles the full §18.6 slice (kind, reviewer_id, source_id, actionable)", () => {
    expect(
      classifyReviewReceived({
        webhookKind: "review_submission",
        actorType: "Bot",
        actorLogin: "greptile-apps[bot]",
        sourceId: "review:42",
        reviewState: "changes_requested",
        body: null,
      }),
    ).toEqual({ reviewerKind: "bot", reviewerId: "greptile-apps[bot]", reviewSourceId: "review:42", actionable: true });
    // A missing login degrades to "unknown" (never throws; the slice stays well-formed).
    expect(
      classifyReviewReceived({
        webhookKind: "issue_comment",
        actorType: "User",
        actorLogin: null,
        sourceId: "issue_comment:7",
        body: "",
      }),
    ).toEqual({ reviewerKind: "human", reviewerId: "unknown", reviewSourceId: "issue_comment:7", actionable: false });
  });

  it("buildReviewReceivedEmission carries kind/actionable on the event + full slice on metadata + webhook actor", () => {
    const emission = buildReviewReceivedEmission({
      reviewerKind: "bot",
      reviewerId: "strix",
      reviewSourceId: "review:5",
      actionable: true,
    });
    expect(emission).toEqual({
      event: { type: "review.received", reviewerKind: "bot", actionable: true },
      metadata: {
        type: "review.received",
        reviewerKind: "bot",
        reviewerId: "strix",
        reviewSourceId: "review:5",
        actionable: true,
      },
      actor: "webhook",
    });
  });
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

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

describe("review producer — applyEvent integration over the spine row (PR 39)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const depsFor = (sid: string, sourceId: string) => {
    const env = { DB: db, DD_API_KEY: undefined, WORKER_ENV: "test" } as unknown as Env;
    return {
      db,
      env,
      now: () => NOW,
      resolver: buildLiveGuardResolver(env, sid, { reviewSourceId: sourceId }),
      emit: vi.fn(async () => true),
      sideEffects: noopSideEffectSink,
      worklist: noopWorklistSink,
    };
  };

  const apply = (sid: string, emission: ReviewEmission, sourceId: string) =>
    applyEvent(depsFor(sid, sourceId), {
      sessionId: sid,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });

  const actionableBot = buildReviewReceivedEmission({
    reviewerKind: "bot",
    reviewerId: "greptile",
    reviewSourceId: "review:1",
    actionable: true,
  });
  const noiseApproval = buildReviewReceivedEmission({
    reviewerKind: "human",
    reviewerId: "alice",
    reviewSourceId: "review:2",
    actionable: false,
  });

  it("REVIEW + actionable review.received [no inflight] dispatches a review epoch (stays REVIEW, stamps in-flight)", async () => {
    const sid = "sess-rev-disp";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "REVIEW", headSha: "h1" });
    const r = await apply(sid, actionableBot, "review:1");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.inFlightEpochId).not.toBeNull();
  });

  it("REVIEW + actionable review.received with an epoch in flight registers only (no double-dispatch)", async () => {
    const sid = "sess-rev-inflight";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      headSha: "h1",
      inFlightEpochId: "epoch-existing",
    });
    const r = await apply(sid, actionableBot, "review:1");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    // The existing in-flight epoch id is preserved — the arriving review accumulates, it does not re-stamp.
    expect((await getPrCoordination(db, sid))?.inFlightEpochId).toBe("epoch-existing");
  });

  it("REVIEW + non-actionable review.received is a log_noop (registers nothing, no in-flight epoch)", async () => {
    const sid = "sess-rev-noise";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "REVIEW", headSha: "h1" });
    const r = await apply(sid, noiseApproval, "review:2");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    expect((await getPrCoordination(db, sid))?.inFlightEpochId).toBeNull();
  });

  it("MERGE_READY + actionable review.received re-opens to REVIEW (Defect 3 — never drops the review)", async () => {
    const sid = "sess-rev-reopen";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "MERGE_READY", headSha: "h1" });
    const r = await apply(sid, actionableBot, "review:1");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.inFlightEpochId).not.toBeNull();
  });

  it("MERGE_READY + non-actionable review.received stays MERGE_READY (an approval never re-opens a Ready PR)", async () => {
    const sid = "sess-rev-ready-noise";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "MERGE_READY", headSha: "h1" });
    const r = await apply(sid, noiseApproval, "review:2");
    expect(r).toMatchObject({ outcome: "handled", to: "MERGE_READY" });
    expect((await getPrCoordination(db, sid))?.state).toBe("MERGE_READY");
  });

  it("shadowEmitReviewReceived drives the spine end-to-end (dispatches a review epoch)", async () => {
    const sid = "sess-rev-emit";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "REVIEW", headSha: "h1" });
    const env = { DB: db, DD_API_KEY: undefined, WORKER_ENV: "test" } as never;
    await shadowEmitReviewReceived(
      env,
      sid,
      classifyReviewReceived({
        webhookKind: "review_submission",
        actorType: "Bot",
        actorLogin: "greptile",
        sourceId: "review:1",
        reviewState: "changes_requested",
        body: null,
      }),
    );
    expect((await getPrCoordination(db, sid))?.inFlightEpochId).not.toBeNull(); // dispatched
  });
});
