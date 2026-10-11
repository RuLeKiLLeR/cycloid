// ARC-1330 (W11-P2) — the canonical PR-label IO writer (services/fsm-label-sync.ts).
//
// Proves the GitHub reconcile applies `labelsOf(record)` exactly, DIFF-BASED (targeted add/remove,
// never a full-set `setLabels` PUT): strips stale managed labels (the legacy drift), never touches a
// non-managed label (so a concurrently-added user label structurally cannot be clobbered), ensures
// net-new labels before each add, and no-ops when the managed axis already matches. Also proves the
// env-level wrapper skips cleanly when there is no spine row or the state is unknown (the sweep
// self-heals either way), and that a TERMINAL spine row (MERGED/CLOSED) strips the full managed axis.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureRepoLabel = vi.hoisted(() => vi.fn());
const mockListLabels = vi.hoisted(() => vi.fn());
const mockSetLabels = vi.hoisted(() => vi.fn());
const mockAddLabels = vi.hoisted(() => vi.fn());
const mockRemoveLabel = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());
const mockGetInstallationByOwner = vi.hoisted(() => vi.fn());
const mockGetPrCoordination = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/github/pr", () => ({
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  listLabels: (...args: unknown[]) => mockListLabels(...args),
  setLabels: (...args: unknown[]) => mockSetLabels(...args),
  addLabels: (...args: unknown[]) => mockAddLabels(...args),
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/session/pr-coordination-db", () => ({
  getPrCoordination: (...args: unknown[]) => mockGetPrCoordination(...args),
}));

import { CI_FIX_EXHAUSTED_LABEL } from "../../../apps/control-plane-worker/src/constants/pr-labels";
import { syncFsmLabels, syncFsmLabelsForPr } from "../../../apps/control-plane-worker/src/services/fsm-label-sync";

// PR-E1: the review-loop:* / verification-* label constants are SCRAPPED. `labelsOf` never emits them,
// but they remain in the managed (strip) set as inline literals — these tests exercise the generic diff
// reconcile / teardown over those legacy strings, so keep them as inline literals here.
const REVIEW_LOOP_DONE_LABEL = "review-loop:done";
const REVIEW_LOOP_CI_RED_LABEL = "review-loop:ci-red";
const VERIFICATION_DONE_LABEL = "verification-done";
const VERIFICATION_EXHAUSTED_LABEL = "verification-exhausted";
const VERIFICATION_IN_PROGRESS_LABEL = "verification-in-progress";
const VERIFICATION_NEEDS_WORK_LABEL = "verification-needs-work";
import { FSM_MANAGED_LABELS } from "../../../apps/control-plane-worker/src/session/fsm/label-projection";
import type { PrCoordinationRecord } from "../../../apps/control-plane-worker/src/session/pr-coordination-db";

const logger = { info: vi.fn(), warn: vi.fn() } as never;
const PR_URL = "https://github.com/acme/repo/pull/42";

function persisted(over: Partial<PrCoordinationRecord>): PrCoordinationRecord {
  return {
    sessionId: "s",
    version: 1,
    state: "REVIEW",
    prUrl: PR_URL,
    headSha: "h",
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
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureRepoLabel.mockResolvedValue({ ok: true, created: false });
  mockAddLabels.mockResolvedValue(undefined);
  mockRemoveLabel.mockResolvedValue(undefined);
  mockSetLabels.mockResolvedValue(undefined);
  mockCreateInstallationToken.mockResolvedValue("tok");
  mockGetInstallationByOwner.mockResolvedValue({ installation_id: 99, suspended_at: null });
});

describe("syncFsmLabels (token-level, diff-based reconcile)", () => {
  it("strips stale managed labels and adds the desired label via TARGETED calls — never a full-set PUT", async () => {
    const current = ["cycloid", VERIFICATION_EXHAUSTED_LABEL, REVIEW_LOOP_CI_RED_LABEL];
    const r = await syncFsmLabels("tok", "acme", "repo", 42, [VERIFICATION_IN_PROGRESS_LABEL], {
      currentLabels: current,
      logger,
    });
    // Targeted removes for exactly the stale managed labels.
    expect(mockRemoveLabel).toHaveBeenCalledTimes(2);
    expect(mockRemoveLabel).toHaveBeenCalledWith("tok", "acme", "repo", 42, VERIFICATION_EXHAUSTED_LABEL);
    expect(mockRemoveLabel).toHaveBeenCalledWith("tok", "acme", "repo", 42, REVIEW_LOOP_CI_RED_LABEL);
    // Targeted add for exactly the new managed label.
    expect(mockAddLabels).toHaveBeenCalledTimes(1);
    expect(mockAddLabels).toHaveBeenCalledWith("tok", "acme", "repo", 42, [VERIFICATION_IN_PROGRESS_LABEL]);
    // NEVER a full-set PUT — the anti-clobber guarantee.
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(r.added).toEqual([VERIFICATION_IN_PROGRESS_LABEL]);
    expect(r.removed.sort()).toEqual([REVIEW_LOOP_CI_RED_LABEL, VERIFICATION_EXHAUSTED_LABEL].sort());
  });

  it("a non-managed label added concurrently (between read and write) survives — no write ever names it", async () => {
    // The PR snapshot we read does NOT contain the concurrently-added "hotfix" label; with a full-set
    // PUT the write would overwrite the live set and drop it permanently. Diff-based targeted ops only
    // ever name MANAGED labels from the computed diff, so "hotfix" is structurally untouchable.
    const snapshotAtRead = ["cycloid", VERIFICATION_EXHAUSTED_LABEL];
    await syncFsmLabels("tok", "acme", "repo", 42, [VERIFICATION_DONE_LABEL], {
      currentLabels: snapshotAtRead,
      logger,
    });
    expect(mockSetLabels).not.toHaveBeenCalled();
    // Every label named in ANY write call is managed — a concurrent user label can never be targeted.
    expect(mockRemoveLabel.mock.calls.length + mockAddLabels.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockRemoveLabel.mock.calls) {
      expect(FSM_MANAGED_LABELS.has(call[4] as string)).toBe(true);
      expect(call[4]).not.toBe("hotfix");
    }
    for (const call of mockAddLabels.mock.calls) {
      for (const label of call[4] as string[]) {
        expect(FSM_MANAGED_LABELS.has(label)).toBe(true);
      }
    }
  });

  it("ensures a net-new label before adding it", async () => {
    await syncFsmLabels("tok", "acme", "repo", 42, [CI_FIX_EXHAUSTED_LABEL], { currentLabels: ["cycloid"], logger });
    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "tok",
      "acme",
      "repo",
      CI_FIX_EXHAUSTED_LABEL,
      expect.any(String),
      expect.any(String),
    );
    expect(mockAddLabels).toHaveBeenCalledWith("tok", "acme", "repo", 42, [CI_FIX_EXHAUSTED_LABEL]);
  });

  it("skips a label whose ensure fails, still applying the rest of the diff", async () => {
    mockEnsureRepoLabel.mockImplementation(async (_t, _o, _r, name: string) =>
      name === VERIFICATION_NEEDS_WORK_LABEL
        ? { ok: false, reason: "permission_denied", status: 403, detail: "x" }
        : { ok: true, created: false },
    );
    // Stale managed label present + un-ensurable desired label: the remove still runs, the add is skipped.
    const r = await syncFsmLabels("tok", "acme", "repo", 42, [VERIFICATION_NEEDS_WORK_LABEL], {
      currentLabels: ["cycloid", VERIFICATION_EXHAUSTED_LABEL],
      logger,
    });
    expect(mockRemoveLabel).toHaveBeenCalledWith("tok", "acme", "repo", 42, VERIFICATION_EXHAUSTED_LABEL);
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([VERIFICATION_EXHAUSTED_LABEL]);
  });

  it("does NOT write when the managed axis already matches (no-op dedup)", async () => {
    await syncFsmLabels("tok", "acme", "repo", 42, [REVIEW_LOOP_DONE_LABEL, VERIFICATION_DONE_LABEL], {
      currentLabels: ["cycloid", REVIEW_LOOP_DONE_LABEL, VERIFICATION_DONE_LABEL],
      logger,
    });
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it("a single failed remove does not abandon the other writes (allSettled)", async () => {
    mockRemoveLabel.mockImplementation(async (_t, _o, _r, _n, label: string) => {
      if (label === VERIFICATION_EXHAUSTED_LABEL) throw new Error("GitHub 503");
    });
    const r = await syncFsmLabels("tok", "acme", "repo", 42, [VERIFICATION_IN_PROGRESS_LABEL], {
      currentLabels: [VERIFICATION_EXHAUSTED_LABEL, REVIEW_LOOP_CI_RED_LABEL],
      logger,
    });
    // The sibling remove and the add still land; the failure is logged, not thrown.
    expect(r.removed).toEqual([REVIEW_LOOP_CI_RED_LABEL]);
    expect(r.added).toEqual([VERIFICATION_IN_PROGRESS_LABEL]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("503") }),
      "FSM label reconcile write failed",
    );
  });

  it("fetches current labels when the caller does not supply them", async () => {
    mockListLabels.mockResolvedValue(["cycloid", VERIFICATION_EXHAUSTED_LABEL]);
    await syncFsmLabels("tok", "acme", "repo", 42, [], { logger });
    expect(mockListLabels).toHaveBeenCalledWith("tok", "acme", "repo", 42);
    // Strips the stale exhausted label via a targeted remove; "cycloid" is never touched.
    expect(mockRemoveLabel).toHaveBeenCalledWith("tok", "acme", "repo", 42, VERIFICATION_EXHAUSTED_LABEL);
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });
});

describe("syncFsmLabelsForPr (env-level, spine-row driven)", () => {
  const env = { DB: {} } as never;

  it("applies labelsOf(record) for the session's spine row (PR-E1: NEEDS_YOU is the label-producing state)", async () => {
    // MERGE_READY/VERIFYING/REVIEW now project no managed label; NEEDS_YOU is the surviving label source.
    mockGetPrCoordination.mockResolvedValue(persisted({ state: "NEEDS_YOU", blockedReason: "ci_fix_exhausted" }));
    mockListLabels.mockResolvedValue(["cycloid"]);
    await syncFsmLabelsForPr(env, {
      prUrl: PR_URL,
      sessionId: "s",
      installationId: 99,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });
    const addedLabels = mockAddLabels.mock.calls.flatMap((call) => call[4] as string[]);
    expect(addedLabels).toEqual([CI_FIX_EXHAUSTED_LABEL]);
    expect(mockRemoveLabel).not.toHaveBeenCalled();
  });

  it("TERMINAL strip: a MERGED spine row projects the empty managed set and strips every managed label", async () => {
    // The W11-P2 close-out cutover: labelsOf on a terminal record is [], so the reconcile removes ALL
    // managed labels — including the verification-* axis the legacy clearReviewLoopLabels never touched.
    mockGetPrCoordination.mockResolvedValue(persisted({ state: "MERGED" }));
    mockListLabels.mockResolvedValue(["cycloid", VERIFICATION_DONE_LABEL, REVIEW_LOOP_DONE_LABEL]);
    await syncFsmLabelsForPr(env, { prUrl: PR_URL, sessionId: "s", tokenHint: "tok", logger });
    expect(mockRemoveLabel).toHaveBeenCalledTimes(2);
    expect(mockRemoveLabel).toHaveBeenCalledWith("tok", "acme", "repo", 42, VERIFICATION_DONE_LABEL);
    expect(mockRemoveLabel).toHaveBeenCalledWith("tok", "acme", "repo", 42, REVIEW_LOOP_DONE_LABEL);
    expect(mockAddLabels).not.toHaveBeenCalled();
    // The non-managed provenance label survives (never targeted).
    expect(mockRemoveLabel).not.toHaveBeenCalledWith("tok", "acme", "repo", 42, "cycloid");
  });

  it("reuses a caller-supplied token hint (no installation resolution / token mint)", async () => {
    mockGetPrCoordination.mockResolvedValue(persisted({ state: "VERIFYING" }));
    mockListLabels.mockResolvedValue([]);
    await syncFsmLabelsForPr(env, { prUrl: PR_URL, sessionId: "s", tokenHint: "hint-tok", logger });
    expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    expect(mockListLabels).toHaveBeenCalledWith("hint-tok", "acme", "repo", 42);
  });

  it("no-ops when the session has no spine row", async () => {
    mockGetPrCoordination.mockResolvedValue(null);
    await syncFsmLabelsForPr(env, { prUrl: PR_URL, sessionId: "s", logger });
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    expect(mockListLabels).not.toHaveBeenCalled();
  });

  it("no-ops (logged) when the spine row carries an unknown state", async () => {
    mockGetPrCoordination.mockResolvedValue(persisted({ state: "NONSENSE" }));
    await syncFsmLabelsForPr(env, { prUrl: PR_URL, sessionId: "s", logger });
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabel).not.toHaveBeenCalled();
  });
});
