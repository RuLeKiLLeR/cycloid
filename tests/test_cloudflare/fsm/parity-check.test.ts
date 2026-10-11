// ARC-1330 W11-G1 — post-flip parity checker (the non-tautological soak instrument).
//
// Covers the pure classifier's three arms (agree / diverge / no_ground_truth) over the PR-state mapping,
// the secondary verifier-child downgrade, the URL parser, the default GitHub reader's failure isolation,
// the per-session check over a real migrated spine row, and the batch runner's per-session isolation +
// tallies. The classifier is PURE (no GitHub) so the fixture arms are exhaustive without a network.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGithubGroundTruthReader,
  checkSessionParity,
  classifyParity,
  DEFAULT_PARITY_LIMIT,
  emitParityMetric,
  type ExternalGroundTruth,
  type ParityRow,
  parseGithubPrUrl,
  runParityBatch,
  runTerminalCohortParity,
  verdictAgreesWithChild,
} from "../../../apps/control-plane-worker/src/session/fsm/parity-check";
import {
  insertPrCoordination,
  listPrCoordinationTerminalCohortForParity,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
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
const env = { DD_API_KEY: "k", WORKER_ENV: "test" } as const;

function spineRow(overrides: Partial<PrCoordinationRecord>): PrCoordinationRecord {
  return {
    sessionId: "sess-1",
    version: 5,
    state: "MERGED",
    prUrl: "https://github.com/acme/app/pull/7",
    headSha: "h1",
    verdict: "pass",
    verdictHeadSha: "h1",
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
    stateEnteredAt: NOW,
    ...overrides,
  };
}

function gt(overrides: Partial<ExternalGroundTruth> = {}): ExternalGroundTruth {
  return { hasPrUrl: true, prState: "merged", ...overrides };
}

describe("classifyParity — primary GitHub PR arm", () => {
  it("AGREES when the observed PR state is consistent with the terminal spine state", () => {
    expect(classifyParity("MERGED", "pass", gt({ prState: "merged" }))).toMatchObject({
      result: "agree",
      source: "github_pr",
      reason: "pr_state_consistent",
      observedPrState: "merged",
    });
    expect(classifyParity("CLOSED", "none", gt({ prState: "closed" }))).toMatchObject({ result: "agree" });
    expect(classifyParity("MERGE_READY", "pass", gt({ prState: "open" }))).toMatchObject({ result: "agree" });
  });

  it("DIVERGES when the observed PR state contradicts the spine claim (the projection-lag class)", () => {
    // spine says MERGED, GitHub says the PR is still open → a real regression.
    expect(classifyParity("MERGED", "pass", gt({ prState: "open" }))).toMatchObject({
      result: "diverge",
      source: "github_pr",
      reason: "spine_MERGED_pr_open",
      observedPrState: "open",
    });
    // spine parks at MERGE_READY but a human already merged → merge-ready lag (safety-critical).
    expect(classifyParity("MERGE_READY", "pass", gt({ prState: "merged" }))).toMatchObject({
      result: "diverge",
      reason: "spine_MERGE_READY_pr_merged",
    });
    expect(classifyParity("CLOSED", "none", gt({ prState: "merged" }))).toMatchObject({ result: "diverge" });
  });

  it("SUPERSEDED is permissive — any resolved PR state agrees (never false divergence, ARC-1389)", () => {
    for (const prState of ["merged", "closed", "open"] as const) {
      expect(classifyParity("SUPERSEDED", "none", gt({ prState }))).toMatchObject({ result: "agree" });
    }
  });

  it("returns NO_GROUND_TRUTH — distinct from agree — for every un-checkable shape", () => {
    // pre-publish / no-PR terminal: the spine makes no PR claim.
    expect(classifyParity("GENERATING", "none", gt({ hasPrUrl: false, prState: null }))).toMatchObject({
      result: "no_ground_truth",
      source: "none",
      reason: "no_pr_claim",
    });
    // checkable state but the session never published a PR.
    expect(classifyParity("MERGED", "pass", gt({ hasPrUrl: false, prState: null }))).toMatchObject({
      result: "no_ground_truth",
      reason: "no_pr_url",
    });
    // checkable state, had a URL, but the read came back null (deleted / auth lost) — NOT agreement.
    expect(classifyParity("MERGED", "pass", gt({ hasPrUrl: true, prState: null }))).toMatchObject({
      result: "no_ground_truth",
      reason: "pr_unreadable",
      observedPrState: "absent",
    });
  });

  it("surfaces an unknown spine state instead of crashing", () => {
    expect(classifyParity("WAT", "none", gt())).toMatchObject({
      result: "no_ground_truth",
      reason: "unknown_spine_state",
      expectedPrStates: null,
    });
  });
});

describe("classifyParity — secondary verifier-child arm", () => {
  it("downgrades a PR-agreement to divergence when the spine verdict contradicts the child outcome", () => {
    // GitHub PR is open (consistent with REVIEW) but the independent verifier child FAILED while the spine
    // recorded a pass — the unrecorded/mis-recorded verification class.
    expect(classifyParity("REVIEW", "pass", gt({ prState: "open", verifierChildOutcome: "fail" }))).toMatchObject({
      result: "diverge",
      source: "verifier_child",
      reason: "spine_verdict_pass_child_fail",
    });
  });

  it("stays agree when the child outcome corroborates the verdict, or makes no claim", () => {
    expect(classifyParity("REVIEW", "pass", gt({ prState: "open", verifierChildOutcome: "pass" }))).toMatchObject({
      result: "agree",
      source: "github_pr",
    });
    // inconclusive / null child, and skipped/none verdicts, make no checkable claim.
    expect(
      classifyParity("REVIEW", "pass", gt({ prState: "open", verifierChildOutcome: "inconclusive" })),
    ).toMatchObject({ result: "agree" });
    expect(classifyParity("REVIEW", "skipped", gt({ prState: "open", verifierChildOutcome: "fail" }))).toMatchObject({
      result: "agree",
    });
  });

  it("a PR divergence is NOT masked by an agreeing child (primary wins)", () => {
    expect(classifyParity("MERGED", "pass", gt({ prState: "open", verifierChildOutcome: "pass" }))).toMatchObject({
      result: "diverge",
      source: "github_pr",
    });
  });

  it("MERGE_READY never downgrades to a verifier-child divergence (QA is a parallel comment, not a gate)", () => {
    // Post the ARC-1330 CI-ladder cut, MERGE_READY is reached from the pure-CI door while carrying a
    // stale/absent verdict (QA runs off-gate). Even a recorded `pass` that an independent child later
    // contradicts must NOT manufacture divergence on a MERGE_READY row — the PR-state agreement stands.
    expect(classifyParity("MERGE_READY", "pass", gt({ prState: "open", verifierChildOutcome: "fail" }))).toMatchObject({
      result: "agree",
      source: "github_pr",
      reason: "pr_state_consistent",
    });
    // The secondary downgrade still fires for the non-terminal in-loop states (REVIEW).
    expect(classifyParity("REVIEW", "pass", gt({ prState: "open", verifierChildOutcome: "fail" }))).toMatchObject({
      result: "diverge",
      source: "verifier_child",
    });
  });
});

describe("verdictAgreesWithChild", () => {
  it("maps pass↔pass, app_breaks↔fail; skipped/none/inconclusive make no claim", () => {
    expect(verdictAgreesWithChild("pass", "pass")).toBe(true);
    expect(verdictAgreesWithChild("pass", "fail")).toBe(false);
    expect(verdictAgreesWithChild("app_breaks", "fail")).toBe(true);
    expect(verdictAgreesWithChild("app_breaks", "pass")).toBe(false);
    expect(verdictAgreesWithChild("skipped", "fail")).toBe(true);
    expect(verdictAgreesWithChild("none", "fail")).toBe(true);
    expect(verdictAgreesWithChild("pass", null)).toBe(true);
    expect(verdictAgreesWithChild("pass", "inconclusive")).toBe(true);
  });
});

describe("parseGithubPrUrl", () => {
  it("parses a canonical PR url and rejects everything else", () => {
    expect(parseGithubPrUrl("https://github.com/acme/app/pull/7")).toEqual({
      owner: "acme",
      repo: "app",
      prNumber: 7,
    });
    expect(parseGithubPrUrl("https://github.com/acme/app/issues/7")).toBeNull();
    expect(parseGithubPrUrl("https://gitlab.com/acme/app/pull/7")).toBeNull();
    expect(parseGithubPrUrl("not a url")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/acme/app/pull/0")).toBeNull();
  });
});

describe("buildGithubGroundTruthReader", () => {
  it("no url → hasPrUrl:false; unparseable url → hasPrUrl:false", async () => {
    const reader = buildGithubGroundTruthReader({ resolveToken: async () => "tok" });
    expect(await reader({ sessionId: "s", businessId: null, prUrl: null })).toEqual({
      hasPrUrl: false,
      prState: null,
    });
    expect(await reader({ sessionId: "s", businessId: null, prUrl: "https://github.com/acme/app/issues/7" })).toEqual({
      hasPrUrl: false,
      prState: null,
    });
  });

  it("null token → unreadable (hasPrUrl:true, prState:null) — never agreement", async () => {
    const reader = buildGithubGroundTruthReader({ resolveToken: async () => null });
    expect(await reader({ sessionId: "s", businessId: null, prUrl: "https://github.com/acme/app/pull/7" })).toEqual({
      hasPrUrl: true,
      prState: null,
    });
  });

  it("isolates a thrown token/read (401/403) as unreadable so the batch continues", async () => {
    const reader = buildGithubGroundTruthReader({
      resolveToken: async () => {
        throw new Error("GitHub PR merge-status lookup failed (403): nope");
      },
    });
    expect(await reader({ sessionId: "s", businessId: null, prUrl: "https://github.com/acme/app/pull/7" })).toEqual({
      hasPrUrl: true,
      prState: null,
    });
  });
});

describe("emitParityMetric", () => {
  it("emits ONE bounded-tag fsm.parity event and swallows a thrown emit", async () => {
    const row: ParityRow = {
      sessionId: "sess-1",
      businessId: "biz-1",
      spineState: "MERGED",
      spineVersion: 5,
      result: "agree",
      source: "github_pr",
      reason: "pr_state_consistent",
      expectedPrStates: ["merged"],
      observedPrState: "merged",
    };
    const emit = vi.fn(async () => true);
    await emitParityMetric({ env, emit }, row);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({
      event: "fsm.parity",
      result: "agree",
      spine_state: "MERGED",
      observed_pr_state: "merged",
      source: "github_pr",
      reason: "pr_state_consistent",
    });

    const throwing = vi.fn(async () => {
      throw new Error("dd down");
    });
    await expect(emitParityMetric({ env, emit: throwing }, row)).resolves.toBeUndefined();
  });
});

describe("checkSessionParity", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("compares a real spine row against injected ground truth and emits the row", async () => {
    await insertPrCoordination(db, spineRow({ state: "MERGED" }));
    const emit = vi.fn(async () => true);
    const row = await checkSessionParity(
      { db, env, emit, readGroundTruth: async () => ({ hasPrUrl: true, prState: "merged" }) },
      { sessionId: "sess-1" },
    );
    expect(row).toMatchObject({ result: "agree", spineState: "MERGED", spineVersion: 5, source: "github_pr" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("returns null (no emit) when the session has no spine row yet", async () => {
    const emit = vi.fn(async () => true);
    const row = await checkSessionParity(
      { db, env, emit, readGroundTruth: async () => ({ hasPrUrl: true, prState: "merged" }) },
      { sessionId: "ghost" },
    );
    expect(row).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("passes the spine verdict into the secondary child comparison", async () => {
    await insertPrCoordination(db, spineRow({ state: "REVIEW", verdict: "pass" }));
    const row = await checkSessionParity(
      {
        db,
        env,
        emit: vi.fn(async () => true),
        readGroundTruth: async () => ({ hasPrUrl: true, prState: "open", verifierChildOutcome: "fail" }),
      },
      { sessionId: "sess-1" },
    );
    expect(row).toMatchObject({ result: "diverge", source: "verifier_child" });
  });
});

describe("runParityBatch", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("tallies agree / diverge / no_ground_truth / no_spine_row and isolates a per-session throw", async () => {
    await insertPrCoordination(db, spineRow({ sessionId: "agree-1", state: "MERGED" }));
    await insertPrCoordination(db, spineRow({ sessionId: "diverge-1", state: "MERGED" }));
    await insertPrCoordination(db, spineRow({ sessionId: "nogt-1", state: "GENERATING", prUrl: null }));
    await insertPrCoordination(db, spineRow({ sessionId: "boom-1", state: "MERGED" }));

    const readGroundTruth = vi.fn(async (input: { sessionId: string }) => {
      if (input.sessionId === "boom-1") throw new Error("load blew up");
      if (input.sessionId === "diverge-1") return { hasPrUrl: true, prState: "open" as const };
      if (input.sessionId === "nogt-1") return { hasPrUrl: false, prState: null };
      return { hasPrUrl: true, prState: "merged" as const };
    });

    const { report, rows } = await runParityBatch({ db, env, emit: vi.fn(async () => true), readGroundTruth }, [
      { sessionId: "agree-1" },
      { sessionId: "diverge-1" },
      { sessionId: "nogt-1" },
      { sessionId: "missing-1" }, // no spine row
      { sessionId: "boom-1" }, // throws → failed, batch continues
    ]);

    expect(report).toEqual({
      checked: 3,
      agree: 1,
      diverge: 1,
      noGroundTruth: 1,
      noSpineRow: 1,
      failed: 1,
    });
    expect(rows.map((r) => r.result).sort()).toEqual(["agree", "diverge", "no_ground_truth"]);
  });
});

describe("listPrCoordinationTerminalCohortForParity", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("enumerates ONLY the terminal cohort (MERGED/CLOSED/MERGE_READY/NEEDS_YOU); excludes in-progress + pre-publish", async () => {
    await insertPrCoordination(db, spineRow({ sessionId: "merged-1", state: "MERGED" }));
    await insertPrCoordination(db, spineRow({ sessionId: "closed-1", state: "CLOSED" }));
    await insertPrCoordination(db, spineRow({ sessionId: "mready-1", state: "MERGE_READY" }));
    await insertPrCoordination(db, spineRow({ sessionId: "needsyou-1", state: "NEEDS_YOU" }));
    // Excluded: the samplers already observe REVIEW/VERIFYING; CREATED makes no PR claim.
    await insertPrCoordination(db, spineRow({ sessionId: "review-1", state: "REVIEW" }));
    await insertPrCoordination(db, spineRow({ sessionId: "verifying-1", state: "VERIFYING" }));
    await insertPrCoordination(db, spineRow({ sessionId: "created-1", state: "CREATED" }));

    const cohort = await listPrCoordinationTerminalCohortForParity(db, { limit: 100 });
    expect(cohort.map((r) => r.sessionId).sort()).toEqual(["closed-1", "merged-1", "mready-1", "needsyou-1"]);
  });

  it("bounds by limit, most-recently-entered first", async () => {
    await insertPrCoordination(db, spineRow({ sessionId: "old", state: "MERGED", stateEnteredAt: 1_000 }));
    await insertPrCoordination(db, spineRow({ sessionId: "mid", state: "CLOSED", stateEnteredAt: 2_000 }));
    await insertPrCoordination(db, spineRow({ sessionId: "new", state: "MERGED", stateEnteredAt: 3_000 }));
    const cohort = await listPrCoordinationTerminalCohortForParity(db, { limit: 2 });
    expect(cohort.map((r) => r.sessionId)).toEqual(["new", "mid"]);
  });
});

describe("runTerminalCohortParity", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("checks ONLY the terminal cohort and tallies agree/diverge/no_ground_truth over injected ground truth", async () => {
    await insertPrCoordination(
      db,
      spineRow({ sessionId: "agree-merged", state: "MERGED", prUrl: "https://github.com/a/b/pull/1" }),
    );
    await insertPrCoordination(
      db,
      spineRow({ sessionId: "diverge-mready", state: "MERGE_READY", prUrl: "https://github.com/a/b/pull/2" }),
    );
    await insertPrCoordination(db, spineRow({ sessionId: "nogt-needsyou", state: "NEEDS_YOU", prUrl: null }));
    // Outside the cohort: must never be checked, read, or emitted for.
    await insertPrCoordination(
      db,
      spineRow({ sessionId: "review-skip", state: "REVIEW", prUrl: "https://github.com/a/b/pull/9" }),
    );

    const readGroundTruth = vi.fn(async (input: { sessionId: string }) => {
      // MERGE_READY expects an OPEN PR; a closed PR under it is a projection lag → diverge.
      if (input.sessionId === "diverge-mready") return { hasPrUrl: true, prState: "closed" as const };
      if (input.sessionId === "nogt-needsyou") return { hasPrUrl: false, prState: null };
      return { hasPrUrl: true, prState: "merged" as const };
    });
    const emit = vi.fn(async () => true);

    const { report, rows } = await runTerminalCohortParity({ db, env, emit, readGroundTruth }, { limit: 100 });

    expect(report).toMatchObject({ checked: 3, agree: 1, diverge: 1, noGroundTruth: 1, noSpineRow: 0, failed: 0 });
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["agree-merged", "diverge-mready", "nogt-needsyou"]);
    expect(readGroundTruth.mock.calls.some((c) => c[0].sessionId === "review-skip")).toBe(false);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("defaults to DEFAULT_PARITY_LIMIT and no-ops cleanly over an empty cohort (no reads)", async () => {
    const readGroundTruth = vi.fn(async () => ({ hasPrUrl: true, prState: "merged" as const }));
    const { report, rows } = await runTerminalCohortParity({ db, env, emit: vi.fn(async () => true), readGroundTruth });
    expect(report).toMatchObject({ checked: 0, agree: 0, diverge: 0, noGroundTruth: 0, noSpineRow: 0, failed: 0 });
    expect(rows).toEqual([]);
    expect(readGroundTruth).not.toHaveBeenCalled();
    expect(DEFAULT_PARITY_LIMIT).toBeGreaterThan(0);
  });
});
