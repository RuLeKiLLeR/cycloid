// ARC-1330 blocked-epoch class — `shadowEmitReviewLoopEpochBlockedTerminal` un-strands `in_flight_epoch_id`
// for a just-blocked review-loop epoch (the missing terminal that wedged REVIEW). Proves the reason
// routing (settled / response_failed / skip), the in-flight match guard, and the end-to-end clear over a
// real migrated D1.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  classifyBlockedEpochSpineTerminal,
  shadowEmitReviewLoopEpochBlockedTerminal,
} from "../../apps/control-plane-worker/src/services/review-loop-epoch-blocked-terminal";
import type { ReviewLoopEpoch } from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import { buildGenesisRecord } from "../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import {
  countUndispositionedActionable,
  registerDispositionsIfAbsent,
} from "../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const NOW = 1_700_000_000_000;
const PR = "https://github.com/o/r/pull/1";
const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function migratedD1() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return new SqliteD1(sqlite) as unknown as D1Database;
}

describe("classifyBlockedEpochSpineTerminal — reason → spine terminal route (pure)", () => {
  it("response_failed for a failed fix/reply POST", () => {
    expect(classifyBlockedEpochSpineTerminal("publish_failed")).toBe("response_failed");
    expect(classifyBlockedEpochSpineTerminal("reply_failed")).toBe("response_failed");
    expect(classifyBlockedEpochSpineTerminal("runtime_unrecoverable")).toBe("response_failed");
  });
  it("skip for the 'session moved on / not acting' set (DISABLED_BLOCKED_REASONS)", () => {
    for (const reason of [
      "session_not_review_listening",
      "session_mismatch",
      "empty_expected_bots",
      "expected_bots_changed",
      "merge_conflict_resolution_disabled",
      "auto_response_disabled",
      "ci_response_disabled",
    ]) {
      expect(classifyBlockedEpochSpineTerminal(reason)).toBe("skip");
    }
  });
  it("settled for the strand-in-REVIEW class (head_changed, CI-cap, attempt cap, missing_installation, …)", () => {
    for (const reason of [
      "head_changed",
      "ci_attempt_cap_reached",
      "ci_checks_pending_cap_reached",
      "attempt_cap_reached",
      "missing_installation",
      "pr_merged",
      "sweep_failed",
      // ARC-1514: manual review mode — the session stays review-listening (CI arm on), so its marker must
      // clear here (NOT skip) and its items get dispositioned in the settlement branch.
      "review_handling_disabled",
    ]) {
      expect(classifyBlockedEpochSpineTerminal(reason)).toBe("settled");
    }
  });
});

describe("shadowEmitReviewLoopEpochBlockedTerminal — end-to-end over real D1", () => {
  let db: D1Database;
  beforeEach(() => {
    db = migratedD1();
  });

  const env = () => ({ DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;
  const epochRow = (id: string, sid: string): ReviewLoopEpoch =>
    ({
      id,
      sessionId: sid,
      prUrl: PR,
      headSha: "h1",
      promptedSourceIds: [],
      triggeringSourceIds: ["review:1"],
      sourceKind: "bot",
    }) as unknown as ReviewLoopEpoch;
  const seedReview = (sid: string, inFlight: string) =>
    insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      prUrl: PR,
      headSha: "h1",
      verdict: "pass",
      verdictHeadSha: "h1",
      codeChangedSinceVerification: false,
      inFlightEpochId: inFlight,
    });

  it("a benign block (head_changed) → epoch.settled: CLEARS the in-flight marker", async () => {
    const sid = "sess-benign";
    await seedReview(sid, "ep-1");
    await shadowEmitReviewLoopEpochBlockedTerminal(env(), epochRow("ep-1", sid), "head_changed");
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.state).toBe("REVIEW"); // stays REVIEW; the cascade re-derives from here
  });

  it("a response failure (publish_failed) → epoch.blocked{response_failed} → NEEDS_YOU(review_response_failed)", async () => {
    const sid = "sess-respfail";
    await seedReview(sid, "ep-2");
    await shadowEmitReviewLoopEpochBlockedTerminal(env(), epochRow("ep-2", sid), "publish_failed");
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("review_response_failed");
    expect(rec?.inFlightEpochId).toBeNull();
  });

  it("an unrecoverable runtime → epoch.blocked{response_failed} → NEEDS_YOU(review_response_failed)", async () => {
    const sid = "sess-runtime-unrecoverable";
    await seedReview(sid, "ep-runtime-unrecoverable");
    await shadowEmitReviewLoopEpochBlockedTerminal(
      env(),
      epochRow("ep-runtime-unrecoverable", sid),
      "runtime_unrecoverable",
    );
    await shadowEmitReviewLoopEpochBlockedTerminal(
      env(),
      epochRow("ep-runtime-unrecoverable", sid),
      "runtime_unrecoverable",
    );
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("review_response_failed");
    expect(rec?.inFlightEpochId).toBeNull();
    const journal = await db
      .prepare("SELECT COUNT(*) AS count FROM pr_coordination_events WHERE session_id = ?")
      .bind(sid)
      .first<{ count: number }>();
    expect(journal?.count).toBe(1);
  });

  it("a 'session moved on' reason (session_not_review_listening) clears the stranded marker", async () => {
    // Disabled review epochs must clear without starting a replacement epoch.
    const sid = "sess-skip";
    await seedReview(sid, "ep-3");
    await shadowEmitReviewLoopEpochBlockedTerminal(
      env(),
      epochRow("ep-3", sid),
      "session_not_review_listening",
      undefined,
      undefined,
      {
        clearDisabledMarker: true,
      },
    );
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.state).toBe("REVIEW");
  });

  it("MATCH GUARD: a block for an epoch that is NOT the record's in-flight one is a no-op", async () => {
    const sid = "sess-mismatch";
    await seedReview(sid, "ep-other"); // record's in-flight is a DIFFERENT epoch
    await shadowEmitReviewLoopEpochBlockedTerminal(env(), epochRow("ep-4", sid), "head_changed");
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBe("ep-other"); // not cleared — the guard held
  });

  it("a manual-mode block (review_handling_disabled) DISPOSITIONS the PR's registered items so caught_up stays reachable (ARC-1514)", async () => {
    const sid = "sess-manual";
    await seedReview(sid, "ep-manual");
    // A human review already registered an actionable item at `none` before the manual flip.
    await registerDispositionsIfAbsent(db, [{ sessionId: sid, prUrl: PR, sourceId: "review-body:1" }], NOW);
    expect(await countUndispositionedActionable(db, sid, PR)).toBe(1);

    await shadowEmitReviewLoopEpochBlockedTerminal(env(), epochRow("ep-manual", sid), "review_handling_disabled");

    const rec = await getPrCoordination(db, sid);
    // Conjunct 1: the in-flight marker is cleared (settled route — session stays REVIEW).
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.state).toBe("REVIEW");
    // Conjunct 2: the registered item is dispositioned (no longer `none`), so caught_up can go true and
    // the CI-ladder cascade can drive MERGE_READY.
    expect(await countUndispositionedActionable(db, sid, PR)).toBe(0);
  });
});
