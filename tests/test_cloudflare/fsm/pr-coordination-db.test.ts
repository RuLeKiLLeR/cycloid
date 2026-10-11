// DAO tests for the `pr_coordination` table (ARC-1330 lifecycle FSM, PR 2):
// insert/get round-trip, the single-writer CAS primitive rejecting a stale
// expected version, and the concurrent-writer loser re-reading the bumped
// version before retrying. Pure persistence — no transition logic here.
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  casUpdatePrCoordination,
  deletePrCoordinationVersion0,
  getPrCoordination,
  getSyntheticPrCoordinationByPrUrl,
  getVerificationRunCountForPrCoordination,
  insertPrCoordination,
  listPrCoordinationByStateForRepair,
  listPrCoordinationOpenPrReconcilePage,
  listPrCoordinationTerminalCohortForParity,
  listPrCoordinationTerminalRedeliveryCandidates,
  listPrCoordinationTransientRepairCandidates,
  listReviewRowsWithUndispositionedNoInflight,
  listReviewStuckPrCoordinationCandidates,
  listVerificationBackstopCandidates,
  markPrCoordinationUpdateBranchQueued,
  type PrCoordinationRecord,
  readActiveStateDwell,
  rebaselinePrCoordinationVersion0,
  stampVerificationChildId,
  syntheticPrCoordinatorSessionId,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { createControlPlaneD1, seedSessionIndex } from "../helpers/seed-db";

// A fully-populated record (every nullable field exercised both ways) so the
// round-trip assertion proves no column is dropped or mistyped.
function buildRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: "sess-1",
    version: 0,
    state: "REVIEW",
    prUrl: "https://github.com/acme/web/pull/7",
    headSha: "abc123",
    verdict: "pass",
    verdictHeadSha: "abc123",
    verificationRunHead: "abc123",
    verificationRunId: 2,
    verificationChildId: "child-9",
    verificationRunCount: 1,
    ciFixRounds: 0,
    inFlightEpochId: "epoch-3",
    codeChangedSinceVerification: false,
    promptIntendsChange: true,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: 1_700_000_000_000,
    deadlineAt: 1_700_000_900_000,
    stateEnteredAt: 1_700_000_000_500,
    ...overrides,
  };
}

async function insertSessionIndex(db: D1Database, sessionId: string, status = "active"): Promise<void> {
  const sqlite = (db as unknown as { db: Database.Database }).db;
  seedSessionIndex(sqlite, { sessionId, businessId: "biz", status, createdAt: 1000, updatedAt: 1000 });
}

describe("pr_coordination DAO", () => {
  let db: D1Database;
  beforeEach(() => {
    db = createControlPlaneD1().d1;
  });

  it("round-trips an inserted record through get", async () => {
    const record = buildRecord();
    await insertPrCoordination(db, record);
    const got = await getPrCoordination(db, "sess-1");
    expect(got).toEqual(record);
  });

  it("round-trips a genesis-shaped record with all nullables null and counters zero", async () => {
    const record = buildRecord({
      state: "CREATED",
      prUrl: null,
      headSha: null,
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
      stateEnteredAt: null,
    });
    await insertPrCoordination(db, record);
    expect(await getPrCoordination(db, "sess-1")).toEqual(record);
  });

  it("returns null for an unknown session", async () => {
    expect(await getPrCoordination(db, "nope")).toBeNull();
  });

  it("reads verification_run_count for the provided parent session before using PR fallback", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "parent-old",
        prUrl: "https://github.com/acme/web/pull/7",
        verificationRunCount: 3,
        stateEnteredAt: 1_700_000_000_000,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "parent-new",
        prUrl: "https://github.com/acme/web/pull/7",
        verificationRunCount: 1,
        stateEnteredAt: 1_700_000_100_000,
      }),
    );

    await expect(
      getVerificationRunCountForPrCoordination(db, {
        prUrl: "https://github.com/acme/web/pull/7",
        parentSessionId: "parent-old",
      }),
    ).resolves.toBe(3);
  });

  it("falls back to the latest pr_coordination row for PR-only entry points", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "parent-old",
        prUrl: "https://github.com/acme/web/pull/7",
        verificationRunCount: 3,
        stateEnteredAt: 1_700_000_000_000,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "parent-new",
        prUrl: "https://github.com/acme/web/pull/7",
        verificationRunCount: 1,
        stateEnteredAt: 1_700_000_100_000,
      }),
    );

    await expect(
      getVerificationRunCountForPrCoordination(db, {
        prUrl: "https://github.com/acme/web/pull/7",
        parentSessionId: "missing-parent",
      }),
    ).resolves.toBe(1);
  });

  it("looks up synthetic PR coordinator rows by normalized session id", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "pr-coord:https%3A%2F%2Fgithub.com%2Facme%2Fweb%2Fpull%2F7",
        prUrl: " HTTPS://GitHub.com/acme/web/pull/7/ ",
        verificationRunCount: 4,
      }),
    );

    await expect(getSyntheticPrCoordinationByPrUrl(db, "https://github.com/acme/web/pull/7")).resolves.toMatchObject({
      sessionId: "pr-coord:https%3A%2F%2Fgithub.com%2Facme%2Fweb%2Fpull%2F7",
      verificationRunCount: 4,
    });
  });

  it("uses the synthetic coordinator before legacy PR rows when the parent row is absent", async () => {
    const prUrl = "https://github.com/acme/web/pull/7";
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "legacy-latest",
        prUrl,
        verificationRunCount: 1,
        stateEnteredAt: 1_700_000_100_000,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "pr-coord:https%3A%2F%2Fgithub.com%2Facme%2Fweb%2Fpull%2F7",
        prUrl,
        verificationRunCount: 4,
        stateEnteredAt: 1_700_000_000_000,
      }),
    );

    await expect(
      getVerificationRunCountForPrCoordination(db, {
        prUrl,
        parentSessionId: "missing-parent",
      }),
    ).resolves.toBe(4);
  });

  it("returns null when no parent or PR row has a coordination record", async () => {
    await expect(
      getVerificationRunCountForPrCoordination(db, {
        prUrl: "https://github.com/acme/web/pull/404",
        parentSessionId: "missing-parent",
      }),
    ).resolves.toBeNull();
  });

  it("CAS bumps version and applies the field write on a matching expected version", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0, state: "CREATED" }));
    const changed = await casUpdatePrCoordination(db, "sess-1", 0, { state: "PROVISIONING" });
    expect(changed).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.state).toBe("PROVISIONING");
    expect(got!.version).toBe(1);
  });

  it("CAS rejects a stale expected version (0 rows changed, record untouched)", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0, state: "CREATED" }));
    const changed = await casUpdatePrCoordination(db, "sess-1", 999, { state: "PROVISIONING" });
    expect(changed).toBe(0);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.state).toBe("CREATED");
    expect(got!.version).toBe(0);
  });

  it("concurrent-writer loser sees 0 rows changed and must re-read the bumped version", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0, state: "CREATED" }));

    // Two writers both read version 0 and race a CAS at version 0.
    const winner = await casUpdatePrCoordination(db, "sess-1", 0, { state: "PROVISIONING" });
    const loser = await casUpdatePrCoordination(db, "sess-1", 0, { state: "GENERATING" });
    expect(winner).toBe(1);
    expect(loser).toBe(0);

    // The loser re-reads, observes the winner's write + bumped version, and
    // retries against the fresh version — which now succeeds.
    const fresh = await getPrCoordination(db, "sess-1");
    expect(fresh!.state).toBe("PROVISIONING");
    expect(fresh!.version).toBe(1);
    const retry = await casUpdatePrCoordination(db, "sess-1", fresh!.version, { state: "GENERATING" });
    expect(retry).toBe(1);
    expect((await getPrCoordination(db, "sess-1"))!.version).toBe(2);
  });

  it("CAS with no field writes still bumps the version (handled no-op self-loop)", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0 }));
    const changed = await casUpdatePrCoordination(db, "sess-1", 0, {});
    expect(changed).toBe(1);
    expect((await getPrCoordination(db, "sess-1"))!.version).toBe(1);
  });

  it("CAS encodes booleans and persists multi-field writes", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0, codeChangedSinceVerification: false }));
    const changed = await casUpdatePrCoordination(db, "sess-1", 0, {
      codeChangedSinceVerification: true,
      verificationRunCount: 3,
      blockedReason: "ci_fix_exhausted",
    });
    expect(changed).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.codeChangedSinceVerification).toBe(true);
    expect(got!.verificationRunCount).toBe(3);
    expect(got!.blockedReason).toBe("ci_fix_exhausted");
  });

  // ── rebaselinePrCoordinationVersion0 (PR 46 — the version-0 re-baseline) ──────────
  it("rebaseline rewrites a version-0 row in place and KEEPS version = 0", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ version: 0, codeChangedSinceVerification: false, verdictHeadSha: null, stopMode: null }),
    );
    const changed = await rebaselinePrCoordinationVersion0(
      db,
      buildRecord({
        version: 0,
        codeChangedSinceVerification: true,
        verdictHeadSha: "abc123",
        verificationRunCount: 0,
        stateEnteredAt: 1_700_000_111_000,
      }),
    );
    expect(changed).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.version).toBe(0); // NOT bumped — a later producer CAS still starts from 0
    expect(got!.codeChangedSinceVerification).toBe(true);
    expect(got!.verdictHeadSha).toBe("abc123");
    expect(got!.verificationRunCount).toBe(0);
    expect(got!.stateEnteredAt).toBe(1_700_000_111_000);
  });

  it("rebaseline refuses a producer-advanced row (version >= 1 untouched, 0 rows changed)", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0 }));
    await casUpdatePrCoordination(db, "sess-1", 0, { state: "VERIFYING" }); // a producer advanced it
    const changed = await rebaselinePrCoordinationVersion0(db, buildRecord({ version: 0, state: "REVIEW" }));
    expect(changed).toBe(0);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.version).toBe(1);
    expect(got!.state).toBe("VERIFYING"); // real spine history is never rewound
  });

  it("rebaseline of a missing row changes nothing (0 rows)", async () => {
    expect(await rebaselinePrCoordinationVersion0(db, buildRecord())).toBe(0);
  });

  // ── deletePrCoordinationVersion0 (PR 46 — the stale-session fence prune) ──────────
  it("delete removes a version-0 seed row (frozen no-record posture restored)", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0 }));
    expect(await deletePrCoordinationVersion0(db, "sess-1")).toBe(1);
    expect(await getPrCoordination(db, "sess-1")).toBeNull();
  });

  it("delete refuses a producer-advanced row: the version-0 predicate rides the DELETE, so a racing producer wins", async () => {
    await insertPrCoordination(db, buildRecord({ version: 0 }));
    // A producer CASes between the caller's read (which saw version 0) and the delete.
    await casUpdatePrCoordination(db, "sess-1", 0, { state: "VERIFYING" });
    expect(await deletePrCoordinationVersion0(db, "sess-1")).toBe(0);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.version).toBe(1);
    expect(got!.state).toBe("VERIFYING"); // real spine history survives
  });

  it("delete of a missing row changes nothing (0 rows)", async () => {
    expect(await deletePrCoordinationVersion0(db, "nope")).toBe(0);
  });

  // ── stampVerificationChildId (W11-V1 — the spawn side-effect's child-handle write) ──────────
  it("stamps the child handle on the active VERIFYING run WITHOUT bumping the version (never mints a transition)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ version: 4, state: "VERIFYING", verificationRunId: 2, verificationChildId: null }),
    );
    const stamped = await stampVerificationChildId(db, "sess-1", 2, "verifier-child-2");
    expect(stamped).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.verificationChildId).toBe("verifier-child-2");
    expect(got!.version).toBe(4); // NOT bumped — the stamp is not an applyEvent CAS
  });

  it("run-scoped: no-op (0 rows) when the run advanced past the stamp — never overwrites a newer run's handle", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ version: 6, state: "VERIFYING", verificationRunId: 3, verificationChildId: "child-run3" }),
    );
    // A late run-2 spawn tries to stamp, but the row is on run 3 now.
    const stamped = await stampVerificationChildId(db, "sess-1", 2, "child-run2-late");
    expect(stamped).toBe(0);
    expect((await getPrCoordination(db, "sess-1"))!.verificationChildId).toBe("child-run3");
  });

  it("A3: stamps the child on a REVIEW run (the spawn now rides the publish edge, not VERIFYING entry)", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ version: 5, state: "REVIEW", verificationRunId: 2, verificationChildId: null }),
    );
    const stamped = await stampVerificationChildId(db, "sess-1", 2, "child-review");
    expect(stamped).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.verificationChildId).toBe("child-review");
    expect(got!.version).toBe(5); // still not an applyEvent CAS — version unchanged
  });

  it("no-op (0 rows) for a missing session", async () => {
    expect(await stampVerificationChildId(db, "nope", 1, "child-x")).toBe(0);
  });

  // ── markPrCoordinationUpdateBranchQueued (W11-V9 — ARC-1302 carry-forward marker) ──────────
  it("stamps update_branch_queued_at on the matching current PR/head WITHOUT bumping the version", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        version: 8,
        prUrl: "https://github.com/acme/web/pull/7",
        headSha: "head-before-base-merge",
        updateBranchQueuedAt: null,
      }),
    );

    const changed = await markPrCoordinationUpdateBranchQueued(db, {
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/web/pull/7",
      headSha: "head-before-base-merge",
      nowMs: 1_700_001_000_000,
    });

    expect(changed).toBe(1);
    const got = await getPrCoordination(db, "sess-1");
    expect(got!.updateBranchQueuedAt).toBe(1_700_001_000_000);
    expect(got!.version).toBe(8);
  });

  it("does not stamp a stale marker when the row is already on a different head", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        version: 8,
        prUrl: "https://github.com/acme/web/pull/7",
        headSha: "new-head",
        updateBranchQueuedAt: null,
      }),
    );

    const changed = await markPrCoordinationUpdateBranchQueued(db, {
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/web/pull/7",
      headSha: "old-head",
      nowMs: 1_700_001_000_000,
    });

    expect(changed).toBe(0);
    expect((await getPrCoordination(db, "sess-1"))!.updateBranchQueuedAt).toBeNull();
  });

  // ── W11-V4: first-writer-wins claim (the `verification_child_id IS NULL` guard) ──────────────
  it("first-writer-wins: a second stamp for the SAME run no-ops (0 rows) and never clobbers the winner's handle", async () => {
    await insertPrCoordination(
      db,
      buildRecord({ version: 4, state: "VERIFYING", verificationRunId: 2, verificationChildId: null }),
    );
    // The winner claims the run's spawn slot.
    expect(await stampVerificationChildId(db, "sess-1", 2, "winner-child")).toBe(1);
    // A concurrent loser for the SAME run finds the slot already claimed → 0 rows, handle unchanged.
    expect(await stampVerificationChildId(db, "sess-1", 2, "loser-child")).toBe(0);
    expect((await getPrCoordination(db, "sess-1"))!.verificationChildId).toBe("winner-child");
  });

  async function insertUndispositionedItem(sessionId: string, prUrl: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO pr_review_item_dispositions
           (session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at)
         VALUES (?, ?, ?, 'none', 'review_comment', NULL, 1, 1)`,
      )
      .bind(sessionId, prUrl, `item-${sessionId}`)
      .run();
  }

  it("excludes synthetic coordinator rows from real-session sweeps while keeping synthetic VERIFYING rows in the verification backstop", async () => {
    const syntheticReviewId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/101");
    const syntheticVerifyId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/102");
    const syntheticTerminalId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/103");
    const syntheticDwellId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/104");
    const syntheticRepairId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/105");
    const syntheticMergedId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/106");
    const syntheticOpenId = syntheticPrCoordinatorSessionId("https://github.com/acme/web/pull/107");

    await insertPrCoordination(
      db,
      buildRecord({ sessionId: "real-verify", state: "VERIFYING", prUrl: "https://github.com/acme/web/pull/200" }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: syntheticVerifyId,
        state: "VERIFYING",
        prUrl: "https://github.com/acme/web/pull/102",
        verificationChildId: "synthetic-verifier",
        verdictHeadSha: null,
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "real-review",
        state: "REVIEW",
        inFlightEpochId: null,
        prUrl: "https://github.com/acme/web/pull/201",
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: syntheticReviewId,
        state: "REVIEW",
        inFlightEpochId: null,
        prUrl: "https://github.com/acme/web/pull/101",
      }),
    );
    await insertUndispositionedItem("real-review", "https://github.com/acme/web/pull/201");
    await insertUndispositionedItem(syntheticReviewId, "https://github.com/acme/web/pull/101");
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "real-terminal",
        state: "NEEDS_YOU",
        prUrl: "https://github.com/acme/web/pull/202",
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: syntheticTerminalId,
        state: "NEEDS_YOU",
        prUrl: "https://github.com/acme/web/pull/103",
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({ sessionId: "real-dwell", state: "FINALIZING", prUrl: "https://github.com/acme/web/pull/203" }),
    );
    await insertSessionIndex(db, "real-dwell");
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: syntheticDwellId,
        state: "FINALIZING",
        prUrl: "https://github.com/acme/web/pull/104",
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "real-repair",
        state: "NEEDS_YOU",
        prUrl: "https://github.com/acme/web/pull/204",
        blockedReason: "review_stuck",
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: syntheticRepairId,
        state: "NEEDS_YOU",
        prUrl: "https://github.com/acme/web/pull/105",
        blockedReason: "review_stuck",
      }),
    );
    await insertPrCoordination(
      db,
      buildRecord({ sessionId: "real-merged", state: "MERGED", prUrl: "https://github.com/acme/web/pull/205" }),
    );
    await insertPrCoordination(
      db,
      buildRecord({ sessionId: syntheticMergedId, state: "MERGED", prUrl: "https://github.com/acme/web/pull/106" }),
    );
    await insertPrCoordination(
      db,
      buildRecord({ sessionId: "real-open", state: "STOPPED", prUrl: "https://github.com/acme/web/pull/206" }),
    );
    await insertPrCoordination(
      db,
      buildRecord({ sessionId: syntheticOpenId, state: "STOPPED", prUrl: "https://github.com/acme/web/pull/107" }),
    );

    await expect(listPrCoordinationTransientRepairCandidates(db, { limit: 50 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: "real-verify" })]),
    );
    expect(
      (await listPrCoordinationTransientRepairCandidates(db, { limit: 50 })).map((row) => row.sessionId),
    ).not.toContain(syntheticVerifyId);
    await expect(listReviewRowsWithUndispositionedNoInflight(db, { limit: 50 })).resolves.toEqual([
      expect.objectContaining({ sessionId: "real-review" }),
    ]);
    expect(
      (await listPrCoordinationTerminalRedeliveryCandidates(db, { limit: 50, enteredSinceMs: 0 })).map(
        (row) => row.sessionId,
      ),
    ).toContain("real-terminal");
    expect(
      (await listPrCoordinationTerminalRedeliveryCandidates(db, { limit: 50, enteredSinceMs: 0 })).map(
        (row) => row.sessionId,
      ),
    ).not.toContain(syntheticTerminalId);
    await expect(
      listReviewStuckPrCoordinationCandidates(db, { limit: 50, reviewEnteredBeforeMs: 2_000_000_000_000 }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "real-review" })]));
    expect((await readActiveStateDwell(db, ["FINALIZING"], 2_000_000_000_000, 2_000_000_000_000))[0]).toMatchObject({
      state: "FINALIZING",
      count: 1,
    });
    await expect(
      listPrCoordinationByStateForRepair(db, { state: "NEEDS_YOU", blockedReason: "review_stuck", limit: 50 }),
    ).resolves.toEqual([expect.objectContaining({ sessionId: "real-repair" })]);
    await expect(listPrCoordinationTerminalCohortForParity(db, { limit: 50 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: "real-merged" })]),
    );
    expect(
      (await listPrCoordinationTerminalCohortForParity(db, { limit: 50 })).map((row) => row.sessionId),
    ).not.toContain(syntheticMergedId);
    await expect(listPrCoordinationOpenPrReconcilePage(db, { cursor: null, limit: 50 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: "real-open" })]),
    );
    expect(
      (await listPrCoordinationOpenPrReconcilePage(db, { cursor: null, limit: 50 })).map((row) => row.sessionId),
    ).not.toContain(syntheticOpenId);

    await insertQaBinding({
      prUrl: "https://github.com/acme/web/pull/102",
      lifecycleId: syntheticVerifyId,
      qaSessionId: "synthetic-verifier",
      headSha: "abc123",
      updatedAt: 1_000,
    });
    await insertQaBinding({
      prUrl: "https://github.com/acme/web/pull/200",
      lifecycleId: "real-verify",
      qaSessionId: "real-verifier",
      headSha: "real-head",
      updatedAt: 1_000,
    });
    expect(
      (await listVerificationBackstopCandidates(db, { limit: 50, spawnedBeforeMs: 2_000 })).map((r) => r.sessionId),
    ).toContain(syntheticVerifyId);
    expect(
      (await listVerificationBackstopCandidates(db, { limit: 50, spawnedBeforeMs: 2_000 })).map((r) => r.sessionId),
    ).not.toContain("real-verify");
  });

  // ── listVerificationBackstopCandidates (A3 — run-scoped 1h backstop candidate set) ──────────
  async function insertQaBinding(input: {
    prUrl: string;
    lifecycleId: string;
    qaSessionId: string;
    headSha: string;
    updatedAt: number;
  }): Promise<void> {
    await db
      .prepare(
        `INSERT INTO qa_loop_session_bindings
           (pr_url, automated_lifecycle_id, qa_session_id, parent_session_id, status,
            last_scheduled_head_sha, active_prompt_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, 'p1', ?, ?)`,
      )
      .bind(
        input.prUrl,
        input.lifecycleId,
        input.qaSessionId,
        input.lifecycleId,
        input.headSha,
        input.updatedAt,
        input.updatedAt,
      )
      .run();
  }

  it("A3: returns a REVIEW row with a stamped child + stale verdict whose binding spawned before the cutoff", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "sess-1",
        version: 3,
        state: "REVIEW",
        prUrl: "https://github.com/x/y/pull/1",
        headSha: "h1",
        verificationRunHead: "h1",
        verificationRunId: 2,
        verificationChildId: "verifier-1",
        verdict: null,
        verdictHeadSha: null,
      }),
    );
    // Active binding whose updated_at (spawn time) is 2h old.
    await insertQaBinding({
      prUrl: "https://github.com/x/y/pull/1",
      lifecycleId: "sess-1",
      qaSessionId: "verifier-1",
      headSha: "h1",
      updatedAt: 1_000,
    });

    const rows = await listVerificationBackstopCandidates(db, { limit: 50, spawnedBeforeMs: 2_000 });
    expect(rows.map((r) => r.sessionId)).toEqual(["sess-1"]);
  });

  it("A3: excludes a row whose verdict is already fresh for the current run head, and a not-yet-1h binding", async () => {
    // Fresh verdict (verdict_head_sha == verification_run_head) → excluded.
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "fresh",
        state: "REVIEW",
        prUrl: "https://github.com/x/y/pull/2",
        verificationRunHead: "h2",
        verificationRunId: 1,
        verificationChildId: "v2",
        verdictHeadSha: "h2",
      }),
    );
    await insertQaBinding({
      prUrl: "https://github.com/x/y/pull/2",
      lifecycleId: "fresh",
      qaSessionId: "v2",
      headSha: "h2",
      updatedAt: 1_000,
    });

    // Stale verdict but binding updated_at is AFTER the cutoff → not yet due, excluded.
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "recent",
        state: "REVIEW",
        prUrl: "https://github.com/x/y/pull/3",
        verificationRunHead: "h3",
        verificationRunId: 1,
        verificationChildId: "v3",
        verdictHeadSha: null,
      }),
    );
    await insertQaBinding({
      prUrl: "https://github.com/x/y/pull/3",
      lifecycleId: "recent",
      qaSessionId: "v3",
      headSha: "h3",
      updatedAt: 5_000,
    });

    const rows = await listVerificationBackstopCandidates(db, { limit: 50, spawnedBeforeMs: 2_000 });
    expect(rows).toEqual([]);
  });

  it("A3: excludes non-REVIEW rows even when they still have an active verifier binding", async () => {
    await insertPrCoordination(
      db,
      buildRecord({
        sessionId: "needs-you",
        state: "NEEDS_YOU",
        prUrl: "https://github.com/x/y/pull/4",
        verificationRunHead: "h4",
        verificationRunId: 1,
        verificationChildId: "v4",
        verdictHeadSha: null,
      }),
    );
    await insertQaBinding({
      prUrl: "https://github.com/x/y/pull/4",
      lifecycleId: "needs-you",
      qaSessionId: "v4",
      headSha: "h4",
      updatedAt: 1_000,
    });

    const rows = await listVerificationBackstopCandidates(db, { limit: 50, spawnedBeforeMs: 2_000 });
    expect(rows).toEqual([]);
  });
});
