import { beforeEach, describe, expect, it, vi } from "vitest";

// CI-failure sweep branch: debounce on pending checks, build a fix prompt from failing checks,
// enforce the 3-attempt streak cap. Mirrors the harness in review-loop-sweep.test.ts.

const mockListDueReviewLoopEpochs = vi.fn();
const mockClaimReviewLoopEpochForPrompt = vi.fn();
const mockGetReviewLoopEpochById = vi.fn();
const mockMarkReviewLoopEpochContentionDeferred = vi.fn();
const mockMarkReviewLoopEpochBlocked = vi.fn();
const mockMarkReviewLoopEpochCompleted = vi.fn();
const mockMarkReviewLoopEpochEnqueued = vi.fn();
const mockMarkReviewLoopEpochProcessing = vi.fn();
const mockCountConsecutiveCiFixEpochsForPr = vi.fn();
const mockGetLatestPriorMatchingCiFixAttempt = vi.fn();
const mockMarkReviewLoopEpochTransientFailure = vi.fn();

const mockCreateInstallationToken = vi.fn();
const mockGetCommitCheckRuns = vi.fn();
const mockGetPrHeadSha = vi.fn();
const mockCreatePrIssueComment = vi.fn();
const mockFailingCheckRunWorklistItems = vi.fn();
const mockFailingCheckFingerprint = vi.fn();
const mockHasPendingCheckRuns = vi.fn();
const mockBuildGithubPrReviewLoopPrompt = vi.fn();
const mockBuildGithubPrCiFixPrompt = vi.fn();
const mockHasCiAttemptCapEscalationForHead = vi.fn();
const mockHasCiPendingCapEscalationForHead = vi.fn();

const mockEnqueueSessionPrompt = vi.fn();
const mockGetSessionState = vi.fn();
const mockWarmSession = vi.fn();
const mockListSessionPrompts = vi.fn();
const mockListReviewListeningGithubPrRefs = vi.fn();
const mockRecordReviewLoopOutcomeMemoryIngestion = vi.fn();
const mockIsSessionRuntimeLive = vi.fn();

vi.mock("../../apps/control-plane-worker/src/company-memory/service", () => ({
  recordReviewLoopOutcomeMemoryIngestion: (...a: unknown[]) => mockRecordReviewLoopOutcomeMemoryIngestion(...a),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  listDueReviewLoopEpochs: (...a: unknown[]) => mockListDueReviewLoopEpochs(...a),
  claimReviewLoopEpochForPrompt: (...a: unknown[]) => mockClaimReviewLoopEpochForPrompt(...a),
  getReviewLoopEpochById: (...a: unknown[]) => mockGetReviewLoopEpochById(...a),
  markReviewLoopEpochContentionDeferred: (...a: unknown[]) => mockMarkReviewLoopEpochContentionDeferred(...a),
  markReviewLoopEpochBlocked: (...a: unknown[]) => mockMarkReviewLoopEpochBlocked(...a),
  markReviewLoopEpochCompleted: (...a: unknown[]) => mockMarkReviewLoopEpochCompleted(...a),
  markReviewLoopEpochEnqueued: (...a: unknown[]) => mockMarkReviewLoopEpochEnqueued(...a),
  markReviewLoopEpochProcessing: (...a: unknown[]) => mockMarkReviewLoopEpochProcessing(...a),
  countConsecutiveCiFixEpochsForPr: (...a: unknown[]) => mockCountConsecutiveCiFixEpochsForPr(...a),
  getLatestPriorMatchingCiFixAttempt: (...a: unknown[]) => mockGetLatestPriorMatchingCiFixAttempt(...a),
  hasCiAttemptCapEscalationForHead: (...a: unknown[]) => mockHasCiAttemptCapEscalationForHead(...a),
  hasCiPendingCapEscalationForHead: (...a: unknown[]) => mockHasCiPendingCapEscalationForHead(...a),
  // ARC-1330: the completed_noop + block paths emit a spine terminal; stub it (asserted elsewhere).
  shadowEmitReviewLoopEpochTerminal: vi.fn().mockResolvedValue(undefined),
  // unused-by-this-suite functions still referenced by the module's import block:
  getLatestReviewLoopEpochForPr: vi.fn().mockResolvedValue(null),
  listKnownReviewLoopSourceIds: vi.fn().mockResolvedValue(new Set<string>()),
  listPromptedReviewLoopSources: vi.fn().mockResolvedValue({
    promptedAtBySourceId: new Map(),
    legacySourceIds: new Set<string>(),
  }),
  markReviewLoopEpochsStaleForHeadChange: vi.fn().mockResolvedValue(0),
  carryForwardTruncatedTailEpochsToNewHead: vi.fn().mockResolvedValue(0),
  markReviewLoopEpochTransientFailure: (...a: unknown[]) => mockMarkReviewLoopEpochTransientFailure(...a),
  upsertReviewLoopEpochActivity: vi.fn().mockResolvedValue(null),
  bootstrapReviewLoopEpochFromHeadSignals: vi.fn().mockResolvedValue({ bootstrapped: 0, ignored: [], epoch: null }),
  hasReviewLoopEpochForHead: vi.fn().mockResolvedValue(false),
  listStuckReviewLoopEpochs: vi.fn().mockResolvedValue([]),
  reclaimStuckReviewLoopEpoch: vi.fn().mockResolvedValue(null),
  blockStuckReviewLoopEpoch: vi.fn().mockResolvedValue(null),
  REVIEW_LOOP_ATTEMPT_CAP: 5,
  isObservedTerminalCheckConclusion: (status: string | null | undefined, conclusion: string | null | undefined) =>
    (status ?? "").trim().toLowerCase() === "completed" && (conclusion ?? "").trim().length > 0,
  isObservedTerminalCommitStatusState: (state: string | null | undefined) => {
    const normalized = (state ?? "").trim().toLowerCase();
    return normalized.length > 0 && normalized !== "pending";
  },
  isCiEpoch: (epoch: { sourceKind: string }) => epoch.sourceKind === "ci",
  isReviewEpoch: (epoch: { sourceKind: string }) =>
    epoch.sourceKind !== "ci" && epoch.sourceKind !== "merge_conflict" && epoch.sourceKind !== "mention",
  isVerificationEpoch: (epoch: { sourceKind: string }) => epoch.sourceKind === "verification",
  isMergeConflictEpoch: (epoch: { sourceKind: string }) => epoch.sourceKind === "merge_conflict",
  isMentionEpoch: (epoch: { sourceKind: string }) => epoch.sourceKind === "mention",
  reviewSourceKind: (epoch: { sourceKind: string }) => {
    if (epoch.sourceKind === "ci") throw new Error("reviewSourceKind called on a CI epoch");
    if (epoch.sourceKind === "mention") throw new Error("reviewSourceKind called on a mention epoch");
    return epoch.sourceKind;
  },
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...a: unknown[]) => mockCreateInstallationToken(...a),
  createScopedInstallationToken: (...a: unknown[]) => mockCreateInstallationToken(...a),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getCommitCheckRuns: (...a: unknown[]) => mockGetCommitCheckRuns(...a),
  getCommitStatusContexts: vi.fn().mockResolvedValue([]),
  getPrHeadSha: (...a: unknown[]) => mockGetPrHeadSha(...a),
  getPrReviewLoopWorklist: vi.fn().mockResolvedValue({ items: [], duplicateGroups: [], worklistHash: "" }),
  getPrState: vi.fn().mockResolvedValue("open"),
  createPrIssueComment: (...a: unknown[]) => mockCreatePrIssueComment(...a),
  failingCheckRunWorklistItems: (...a: unknown[]) => mockFailingCheckRunWorklistItems(...a),
  failingCheckRunWorklistItemsWithLogEvidence: (...a: unknown[]) => mockFailingCheckRunWorklistItems(...a),
  failingCheckFingerprint: (...a: unknown[]) => mockFailingCheckFingerprint(...a),
  hasPendingCheckRuns: (...a: unknown[]) => mockHasPendingCheckRuns(...a),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  enqueueSessionPrompt: (...a: unknown[]) => mockEnqueueSessionPrompt(...a),
  getSessionState: (...a: unknown[]) => mockGetSessionState(...a),
  warmSession: (...a: unknown[]) => mockWarmSession(...a),
  notifySessionPrMerged: vi.fn().mockResolvedValue({ ok: true, payload: { notified: true }, status: 200 }),
  closeSessionForWebhook: vi.fn(),
  updateSessionReviewListeningHead: vi.fn(),
  listSessionPrompts: (...a: unknown[]) => mockListSessionPrompts(...a),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-reengage", () => ({
  isSessionRuntimeLive: (...a: unknown[]) => mockIsSessionRuntimeLive(...a),
}));

vi.mock("../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: (...a: unknown[]) => mockNotifyUserBlocked(...a),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  listReviewListeningGithubPrRefs: (...a: unknown[]) => mockListReviewListeningGithubPrRefs(...a),
  markReviewListeningGithubPrRefsSwept: vi.fn().mockResolvedValue(undefined),
  deleteSessionWebhookRef: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/prompts", async () => ({
  // Spread the real module so the pure buildReviewLoopHumanSummary (called by the CI enqueue path)
  // runs for real; keep the agent-prompt builders stubbed as overrides.
  ...(await vi.importActual<Record<string, unknown>>("../../apps/control-plane-worker/src/webhooks/prompts")),
  buildGithubPrReviewLoopPrompt: (...a: unknown[]) => mockBuildGithubPrReviewLoopPrompt(...a),
  buildGithubPrCiFixPrompt: (...a: unknown[]) => mockBuildGithubPrCiFixPrompt(...a),
  buildGithubPrReviewLoopHumanPrompt: vi.fn().mockReturnValue("human prompt"),
  buildGithubPrReviewLoopVerificationPrompt: vi.fn().mockReturnValue("verification prompt"),
  buildGithubPrReviewLoopTriagedPrompt: (...a: unknown[]) => mockBuildGithubPrReviewLoopTriagedPrompt(...a),
}));

const mockTriageReviewLoopWorklist = vi.fn();
const mockBuildGithubPrReviewLoopTriagedPrompt = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-triage", () => ({
  triageReviewLoopWorklist: (...a: unknown[]) => mockTriageReviewLoopWorklist(...a),
  reviewLoopTriageCandidatesFromWorklistItems: (
    items: Array<{
      sourceId: string;
      authorLogin: string;
      authorType: string;
      path: string | null;
      line: number | null;
      body: string;
    }>,
    kind: string,
  ) =>
    items.map((item) => ({
      sourceId: item.sourceId,
      kind,
      authorLogin: item.authorLogin,
      authorType: item.authorType,
      location: item.path ? `${item.path}${item.line == null ? "" : `:${item.line}`}` : null,
      body: item.body,
    })),
}));

// Real behavior: resolveReviewLoopChecklist compares the supplied expectedBotsHash against the
// user's configured bot hash, so for a ci epoch (sentinel hash "ci-fixes") it returns a blocking
// result. ci epochs must therefore bypass the checklist and gate on eligibility instead.
const mockResolveReviewLoopChecklist = vi.fn();
const mockResolveReviewLoopHumanEligibility = vi.fn();
const mockResolveReviewLoopCiEligibility = vi.fn();
const mockNotifyUserBlocked = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/review-loop-settings", () => ({
  resolveReviewLoopChecklist: (...a: unknown[]) => mockResolveReviewLoopChecklist(...a),
  resolveReviewLoopCiEligibility: (...a: unknown[]) => mockResolveReviewLoopCiEligibility(...a),
  resolveReviewLoopHumanEligibility: (...a: unknown[]) => mockResolveReviewLoopHumanEligibility(...a),
}));

const logger = { info: vi.fn(), warn: vi.fn() };
const env = { DB: {} } as never;

function ciEpoch(overrides: Record<string, unknown> = {}) {
  return {
    id: "epoch-ci-1",
    sessionId: "sess-1",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "head-sha",
    expectedBotsHash: "ci-fixes",
    expectedBots: [],
    expectedBotKeys: [],
    observedTerminalBotKeys: [],
    timedOutBotKeys: [],
    triggeringSourceIds: [],
    reservationToken: "reservation-1",
    sourceKind: "ci",
    contentionDeferralCount: 0,
    firstActivityAt: 0,
    ...overrides,
  };
}

function reviewListeningSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    status: "active",
    ownerUserId: "101",
    businessId: "biz-1",
    installationId: 9001,
    reviewListeningActive: true,
    reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    reviewListeningHeadSha: "head-sha",
    ...overrides,
  };
}

const failingRun = {
  id: 9,
  name: "unit tests",
  status: "completed",
  conclusion: "failure",
  appSlug: "github-actions",
  appName: "GitHub Actions",
  detailsUrl: "https://ci/9",
};
const failingItem = {
  sourceId: "check-run-failure:9",
  sourceUrl: "https://ci/9",
  authorLogin: "github-actions",
  authorType: "ci",
  body: 'Failing CI check "unit tests" (conclusion: failure). Investigate and fix so the check passes.',
  path: null,
  line: null,
  updatedAtMs: 0,
  isResolved: false,
  isOutdated: false,
};

describe("review-loop CI sweep branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDueReviewLoopEpochs.mockResolvedValue([]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValue(null);
    mockGetReviewLoopEpochById.mockResolvedValue(ciEpoch({ status: "processing" }));
    mockMarkReviewLoopEpochContentionDeferred.mockResolvedValue(ciEpoch({ status: "ready" }));
    mockMarkReviewLoopEpochBlocked.mockResolvedValue(ciEpoch({ status: "blocked" }));
    mockMarkReviewLoopEpochCompleted.mockResolvedValue(ciEpoch({ status: "completed" }));
    mockMarkReviewLoopEpochEnqueued.mockResolvedValue(ciEpoch({ status: "enqueued" }));
    mockMarkReviewLoopEpochProcessing.mockResolvedValue(ciEpoch({ status: "processing" }));
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValue({ sameFingerprintStreak: 0, totalConsecutiveStreak: 0 });
    mockGetLatestPriorMatchingCiFixAttempt.mockResolvedValue(null);
    mockCreateInstallationToken.mockResolvedValue("token-1");
    mockGetCommitCheckRuns.mockResolvedValue([]);
    mockGetPrHeadSha.mockResolvedValue("head-sha");
    mockCreatePrIssueComment.mockResolvedValue({ id: 1, htmlUrl: "https://x" });
    mockFailingCheckRunWorklistItems.mockReturnValue([]);
    mockFailingCheckFingerprint.mockReturnValue("ci-fail:unit tests");
    mockHasPendingCheckRuns.mockReturnValue(false);
    mockBuildGithubPrReviewLoopPrompt.mockReturnValue("ci fix prompt");
    mockBuildGithubPrCiFixPrompt.mockReturnValue("ci fix prompt");
    mockBuildGithubPrReviewLoopTriagedPrompt.mockReturnValue("ci triaged prompt");
    mockTriageReviewLoopWorklist.mockResolvedValue({ ok: false, reason: "llm_unavailable" });
    mockHasCiAttemptCapEscalationForHead.mockResolvedValue(false);
    mockHasCiPendingCapEscalationForHead.mockResolvedValue(false);
    mockMarkReviewLoopEpochTransientFailure.mockResolvedValue(null);
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-ci-1", status: "queued" } },
    });
    mockGetSessionState.mockResolvedValue(reviewListeningSession());
    mockWarmSession.mockResolvedValue({ ok: true, status: "already_ready" });
    mockIsSessionRuntimeLive.mockResolvedValue(true);
    mockListSessionPrompts.mockResolvedValue({
      ok: true,
      payload: { queue: { processingPromptId: null } },
      status: 200,
    });
    mockListReviewListeningGithubPrRefs.mockResolvedValue({ data: [], nextCursor: null });
    mockRecordReviewLoopOutcomeMemoryIngestion.mockResolvedValue({ created: true, id: "ingestion-1" });
    // The checklist blocks ci epochs (sentinel hash mismatch); ci epochs must not call it.
    mockResolveReviewLoopChecklist.mockResolvedValue({ ok: false, reason: "expected_bots_changed" });
    mockResolveReviewLoopHumanEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 9001 });
    mockResolveReviewLoopCiEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 9001 });
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  it("defers a ci epoch while checks are still pending (debounce)", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([{ ...failingRun, status: "in_progress", conclusion: null }]);
    mockHasPendingCheckRuns.mockReturnValueOnce(true);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(mockWarmSession).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_checks_pending" }),
    );
    expect(result.contentionDeferred).toBe(1);
  });

  it("completes (noop) when all checks are green now", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([{ ...failingRun, conclusion: "success" }]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([]);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(mockWarmSession).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochCompleted).toHaveBeenCalled();
    expect(result.completedNoop).toBe(1);
  });

  it("dispatches the triaged prompt when LLM triage succeeds on the failing checks", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    mockTriageReviewLoopWorklist.mockResolvedValueOnce({
      ok: true,
      actionItems: [{ instruction: "Fix the failing unit tests.", sourceIds: [failingItem.sourceId] }],
      droppedItems: [],
      conflicts: [],
      discardedActionItemCount: 0,
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockTriageReviewLoopWorklist).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        epochId: "epoch-ci-1",
        candidates: [expect.objectContaining({ sourceId: failingItem.sourceId, kind: "ci_failure" })],
      }),
    );
    // CI epochs route to the triaged builder with ciContext:true — which suppresses conflicts at the
    // builder layer (no reply primitive for check-run-failure ids); that suppression is asserted in
    // webhook-prompts.test.ts, so here we only pin the routing flag.
    expect(mockBuildGithubPrReviewLoopTriagedPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        epochId: "epoch-ci-1",
        actionItems: [{ instruction: "Fix the failing unit tests.", sourceIds: [failingItem.sourceId] }],
        worklistItems: [failingItem],
        ciContext: true,
      }),
    );
    expect(mockBuildGithubPrCiFixPrompt).not.toHaveBeenCalled();
    // The enqueue carries the clean CI summary (one failing check) in replyToText, not the raw prompt.
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
      env,
      "sess-1",
      "ci triaged prompt",
      "101",
      expect.objectContaining({
        reviewLoopEpochId: "epoch-ci-1",
        reviewLoopSourceKind: "mixed",
        replyToText: "Investigating 1 failing CI check on this PR.",
      }),
    );
    expect(result.enqueued).toBe(1);
  });

  it("enqueues a fix prompt listing the failing checks", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    mockFailingCheckFingerprint.mockReturnValueOnce("ci-fail:unit tests");
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({ sameFingerprintStreak: 0, totalConsecutiveStreak: 0 });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // Prompt built from the failing-check worklist items via the dedicated CI builder (FIX 9).
    expect(mockBuildGithubPrCiFixPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: "epoch-ci-1", worklistItems: [failingItem], duplicateGroups: [] }),
    );
    // The bot review builder must NOT be used for a ci epoch.
    expect(mockBuildGithubPrReviewLoopPrompt).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
      env,
      "sess-1",
      "ci fix prompt",
      "101",
      expect.objectContaining({
        reviewLoopEpochId: "epoch-ci-1",
        reviewLoopSourceKind: "mixed",
        replyToText: "Investigating 1 failing CI check on this PR.",
      }),
    );
    // The failing-check fingerprint is recorded as the ci epoch's worklistHash.
    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ worklistHash: "ci-fail:unit tests" }),
    );
    expect(result.enqueued).toBe(1);
  });

  it("bypasses the bot checklist: a ci epoch with empty expected bots reaches CI handling", async () => {
    const epoch = ciEpoch({ expectedBots: [], expectedBotsHash: "ci-fixes" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce(0);
    // Even though the checklist would block (sentinel hash never matches the configured bot hash),
    // the ci epoch must not be gated by it.
    mockResolveReviewLoopChecklist.mockResolvedValue({ ok: false, reason: "expected_bots_changed" });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // The bot checklist must never be consulted for a ci epoch...
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    expect(mockResolveReviewLoopCiEligibility).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ ownerUserId: 101, repoOwner: "acme", repoName: "repo" }),
    );
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    // ...and the epoch must not be blocked before reaching CI handling.
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    // It reaches the CI branch and enqueues a fix prompt.
    expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalled();
    expect(result.enqueued).toBe(1);
  });

  it("blocks a ci epoch when repo CI response is disabled", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockResolveReviewLoopCiEligibility.mockResolvedValueOnce({ ok: false, reason: "ci_response_disabled" });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_response_disabled" }),
    );
    expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
  });

  it("same failing checks 3× → same-failure cap fires (one escalation comment)", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    // 3 prior attempts against this exact failing-set; total also 3.
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({ sameFingerprintStreak: 3, totalConsecutiveStreak: 3 });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    // Exactly one escalation comment with the same-failure message.
    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
    expect(mockCreatePrIssueComment).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      expect.stringContaining("the same CI checks have failed after 3 automated fix attempts"),
    );
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_attempt_cap_reached" }),
    );
    // DMs the owner that automated CI fixing gave up, keyed on the failing-check
    // fingerprint so a different failing set re-notifies.
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "ci_red_exhausted",
        dedupKey: "ci-fail:unit tests",
        prUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(mockRecordReviewLoopOutcomeMemoryIngestion).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        businessId: "biz-1",
        sessionId: "sess-1",
        epochId: "epoch-ci-1",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        outcome: "ci_attempt_cap_reached",
        contentText: expect.stringContaining("unit tests"),
      }),
    );
    expect(result.blocked).toBe(1);
  });

  it("4th attempt with a DIFFERENT failing-check set → NOT capped (fresh budget, enqueues)", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([{ ...failingRun, name: "typecheck" }]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    mockFailingCheckFingerprint.mockReturnValueOnce("ci-fail:typecheck");
    // The failing-set changed: the same-fingerprint streak resets to 0 even though 3 ci attempts
    // (with a different fingerprint) preceded it. Total stays under the backstop.
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({ sameFingerprintStreak: 0, totalConsecutiveStreak: 3 });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // Not capped: enqueues a fresh fix attempt and records the new fingerprint.
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ worklistHash: "ci-fail:typecheck" }),
    );
    expect(result.enqueued).toBe(1);
  });

  it("oscillating fingerprints that never converge → backstop fires at 6", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    // Each prior attempt failed a DIFFERENT check set, so same-fingerprint stays low (1), but the
    // total reached the backstop of 6.
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({ sameFingerprintStreak: 1, totalConsecutiveStreak: 6 });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    // The backstop message (not the same-failure message) is posted.
    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
    expect(mockCreatePrIssueComment).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      expect.stringContaining("after 6 automated fix attempts on this PR without converging"),
    );
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_attempt_cap_reached" }),
    );
    // The backstop block path also DMs the owner.
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "ci_red_exhausted",
        dedupKey: "ci-fail:unit tests",
        prUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(result.blocked).toBe(1);
  });

  it("does NOT re-post the cap comment when this head was already escalated (one per head)", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({ sameFingerprintStreak: 3, totalConsecutiveStreak: 3 });
    // A prior ci epoch on this head already escalated.
    mockHasCiAttemptCapEscalationForHead.mockResolvedValueOnce(true);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // No duplicate escalation comment...
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    // ...but the epoch is still blocked so it stops enqueuing.
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_attempt_cap_reached" }),
    );
    // The DM still fires (KV dedups by fingerprint, not the per-head comment guard).
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "ci_red_exhausted",
        dedupKey: "ci-fail:unit tests",
        prUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(result.blocked).toBe(1);
  });

  it("FIX 7: a transient GitHub error while polling checks defers instead of blocking", async () => {
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    // getCommitCheckRuns throws a transient 502.
    mockGetCommitCheckRuns.mockRejectedValueOnce(new Error("GitHub API request failed (502): bad gateway"));
    // Transient defer returns a still-ready epoch (not blocked).
    mockMarkReviewLoopEpochTransientFailure.mockResolvedValueOnce(ciEpoch({ status: "ready" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "github_poll_failed" }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.transientDeferred).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("debounce escalates and stops once checks have been pending past the timeout", async () => {
    // Checks pending and the epoch started waiting > 30 min ago. A high contentionDeferralCount
    // must NOT influence this — the cap is time-based, not count-based.
    const epoch = ciEpoch({ firstActivityAt: 0, contentionDeferralCount: 0 });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([{ ...failingRun, status: "in_progress", conclusion: null }]);
    mockHasPendingCheckRuns.mockReturnValueOnce(true);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    // 31 minutes after firstActivityAt=0 → past the 30-min timeout.
    const result = await runReviewLoopSweep(env, { nowMs: 31 * 60 * 1000, logger: logger as never });

    // No further deferral — escalate + block instead.
    expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
    expect(mockCreatePrIssueComment).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      expect.stringContaining("pending"),
    );
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_checks_pending_cap_reached" }),
    );
    // DMs the owner that CI never settled, keyed on the head.
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "ci_pending_timeout",
        dedupKey: "head-sha",
        prUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(result.blocked).toBe(1);
  });

  it("does not re-post the pending escalation when this head already escalated, but still blocks", async () => {
    const epoch = ciEpoch({ firstActivityAt: 0, contentionDeferralCount: 0 });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([{ ...failingRun, status: "in_progress", conclusion: null }]);
    mockHasPendingCheckRuns.mockReturnValueOnce(true);
    // A prior CI epoch on this head already posted the pending escalation.
    mockHasCiPendingCapEscalationForHead.mockResolvedValueOnce(true);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 31 * 60 * 1000, logger: logger as never });

    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_checks_pending_cap_reached" }),
    );
    // The DM still fires (KV dedups by head, not the per-head comment guard).
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "ci_pending_timeout",
        dedupKey: "head-sha",
        prUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(result.blocked).toBe(1);
  });

  it("still defers (not blocks) while pending under the timeout, regardless of contention count", async () => {
    // High contention count but only just started waiting → must defer, not escalate.
    const epoch = ciEpoch({ firstActivityAt: 0, contentionDeferralCount: 50 });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([{ ...failingRun, status: "in_progress", conclusion: null }]);
    mockHasPendingCheckRuns.mockReturnValueOnce(true);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    // 5 minutes after firstActivityAt=0 → well under the 30-min timeout.
    const result = await runReviewLoopSweep(env, { nowMs: 5 * 60 * 1000, logger: logger as never });

    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "ci_checks_pending" }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(result.contentionDeferred).toBe(1);
  });

  it("defers session_not_sendable as a bounded transient retry on the CI enqueue path", async () => {
    // Mirrors "enqueues a fix prompt listing the failing checks" setup so execution reaches the
    // CI enqueue site (ciEnqueueResult), then injects a 409/session_not_sendable response.
    const epoch = ciEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitCheckRuns.mockResolvedValueOnce([failingRun]);
    mockFailingCheckRunWorklistItems.mockReturnValueOnce([failingItem]);
    mockFailingCheckFingerprint.mockReturnValueOnce("ci-fail:unit tests");
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({ sameFingerprintStreak: 0, totalConsecutiveStreak: 0 });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "session_not_sendable",
      reason: "stopped",
      payload: null,
    });
    // DAO defers; default mock returns a ready (not blocked) epoch.
    mockMarkReviewLoopEpochTransientFailure.mockResolvedValueOnce(ciEpoch({ status: "ready" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      {},
      "epoch-ci-1",
      expect.objectContaining({ reason: "prompt_send_not_ready" }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(result.transientDeferred).toBe(1);
    expect(result.blocked).toBe(0);
  });
});

// A mention epoch reuses the CI-sweep harness (same session/head/eligibility mocks) because it is,
// like CI, an independent class gated on install capabilities only.
function mentionEpoch(overrides: Record<string, unknown> = {}) {
  return {
    id: "epoch-mention-1",
    sessionId: "sess-1",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "head-sha",
    expectedBotsHash: "mention",
    expectedBots: [],
    expectedBotKeys: [],
    observedTerminalBotKeys: [],
    timedOutBotKeys: [],
    triggeringSourceIds: ["review-comment:5001"],
    promptedSourceRecords: [],
    carriedForwardSourceIds: [],
    reservationToken: "reservation-mention-1",
    sourceKind: "mention",
    attemptCount: 1,
    contentionDeferralCount: 0,
    firstActivityAt: 0,
    terminalEvidence: [{ type: "mention", mode: "directive", mentionText: "@cycloid please add a null guard" }],
    ...overrides,
  };
}

describe("review-loop mention sweep branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDueReviewLoopEpochs.mockResolvedValue([]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValue(null);
    mockMarkReviewLoopEpochBlocked.mockResolvedValue(mentionEpoch({ status: "blocked" }));
    mockMarkReviewLoopEpochEnqueued.mockResolvedValue(mentionEpoch({ status: "enqueued" }));
    mockMarkReviewLoopEpochProcessing.mockResolvedValue(mentionEpoch({ status: "processing" }));
    mockMarkReviewLoopEpochContentionDeferred.mockResolvedValue(mentionEpoch({ status: "ready" }));
    mockCreateInstallationToken.mockResolvedValue("token-1");
    mockGetPrHeadSha.mockResolvedValue("head-sha");
    mockGetSessionState.mockResolvedValue(reviewListeningSession());
    mockListSessionPrompts.mockResolvedValue({
      ok: true,
      payload: { queue: { processingPromptId: null } },
      status: 200,
    });
    mockListReviewListeningGithubPrRefs.mockResolvedValue({ data: [], nextCursor: null });
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-mention-1", status: "queued" } },
    });
    // Manual review mode: the review checklist + human gate would BOTH block. A mention must ignore
    // them and gate on install capabilities only.
    mockResolveReviewLoopChecklist.mockResolvedValue({ ok: false, reason: "review_handling_disabled" });
    mockResolveReviewLoopHumanEligibility.mockResolvedValue({ ok: false, reason: "review_handling_disabled" });
    mockResolveReviewLoopCiEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 9001 });
  });

  it("dispatches a mention epoch capabilities-only, eligible even when automatic reviews are OFF (manual)", async () => {
    const epoch = mentionEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // Caps-only gate resolved it; the manual-mode checklist + human gate were NEVER consulted.
    expect(mockResolveReviewLoopCiEligibility).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ ownerUserId: 101, repoOwner: "acme", repoName: "repo" }),
    );
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    // Enqueued as "human" (bridge tool-gating) carrying the epoch marker + a clean mention summary.
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
      env,
      "sess-1",
      expect.stringContaining("[cycloid:review-loop epoch=epoch-mention-1]"),
      "101",
      expect.objectContaining({
        reviewLoopEpochId: "epoch-mention-1",
        reviewLoopSourceKind: "human",
        replyToText: expect.stringContaining("Responding to an @cycloid mention"),
      }),
    );
    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalledWith(
      {},
      "epoch-mention-1",
      expect.objectContaining({ promptedSourceIds: ["review-comment:5001"] }),
    );
    expect(result.enqueued).toBe(1);
  });
});
