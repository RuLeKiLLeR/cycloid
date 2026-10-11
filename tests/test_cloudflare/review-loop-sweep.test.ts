import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGenesisRecord } from "../../apps/control-plane-worker/src/session/fsm/genesis";
import { insertPrCoordination } from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const mockMarkPrCoordinationUpdateBranchQueued = vi.hoisted(() => vi.fn());
// getPrCoordination is spied so the review-loop sweep's behind-base queued-marker read (and the
// head-change carry-forward gate it drives) can be scripted with a spine row for the `env.DB = {}`
// stub. It DEFAULTS to delegating to the real DAO (set in beforeEach) so the `fireStuckVerificationBackstops`
// suite below — which reads a real migrated sqlite db — keeps working; behind/head-change cases override
// it with a per-call `mockResolvedValueOnce`.
const mockGetPrCoordination = vi.hoisted(() => vi.fn());
const realCoordinationDb = vi.hoisted(() => ({}) as { getPrCoordination?: (...args: unknown[]) => unknown });

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/session/pr-coordination-db")>();
  realCoordinationDb.getPrCoordination = actual.getPrCoordination as unknown as (...args: unknown[]) => unknown;
  return {
    ...actual,
    markPrCoordinationUpdateBranchQueued: (...args: unknown[]) => mockMarkPrCoordinationUpdateBranchQueued(...args),
    getPrCoordination: (...args: unknown[]) => mockGetPrCoordination(...args),
  };
});

const mockListDueReviewLoopEpochs = vi.fn();
const mockClaimReviewLoopEpochForPrompt = vi.fn();
const mockGetReviewLoopEpochById = vi.fn();
const mockListKnownReviewLoopSourceIds = vi.fn();
const mockListKnownReviewLoopSources = vi.fn();
const mockListPromptedReviewLoopSources = vi.fn();
const mockMarkReviewLoopEpochsStaleForHeadChange = vi.fn();
const mockMarkReviewLoopEpochContentionDeferred = vi.fn();
const mockMarkReviewLoopEpochTransientFailure = vi.fn();
const mockMarkReviewLoopEpochBlocked = vi.fn();
const mockMarkReviewLoopEpochCompleted = vi.fn();
const mockShadowEmitReviewLoopEpochTerminal = vi.fn();
const mockMarkReviewLoopEpochEnqueued = vi.fn();
const mockMarkReviewLoopEpochProcessing = vi.fn();
const mockUpsertReviewLoopEpochActivity = vi.fn();
const mockBootstrapReviewLoopEpochFromHeadSignals = vi.fn();
const mockBootstrapReviewLoopEpochForVerification = vi.fn();
const mockBootstrapReviewLoopEpochForMergeConflict = vi.fn();
const mockIngestReviewLoopCiFailureWebhook = vi.fn();
const mockHasReviewLoopEpochForHead = vi.fn();
const mockHasExpectedBotReviewLoopEpochForHead = vi.fn();
const mockHasCiReviewLoopEpochForHead = vi.fn();
const mockHasMergeConflictReviewLoopEpochForHead = vi.fn();
const mockHasActiveMergeConflictReviewLoopEpochForHead = vi.fn();
const mockListStuckReviewLoopEpochs = vi.fn();
const mockReclaimStuckReviewLoopEpoch = vi.fn();
const mockBlockStuckReviewLoopEpoch = vi.fn();
const mockExtendReviewLoopEpochLease = vi.fn();
const mockListReviewListeningGithubPrRefs = vi.fn();
const mockMarkReviewListeningGithubPrRefsSwept = vi.fn();
const mockDeleteSessionWebhookRef = vi.fn();
const mockBuildGithubPrReviewLoopPrompt = vi.fn();
const mockBuildGithubPrReviewLoopHumanPrompt = vi.fn();
const mockBuildGithubPrReviewLoopVerificationPrompt = vi.fn();
const mockBuildGithubPrMergeConflictPrompt = vi.fn();
const mockResolveReviewLoopChecklist = vi.fn();
const mockHasPendingReviewLoopWork = vi.fn();
const mockBlockPendingReviewLoopEpochsForHead = vi.fn();
const mockCarryForwardReviewLoopEpochsToNewHead = vi.fn();
const mockCarryForwardTruncatedTailEpochsToNewHead = vi.fn();
const mockHasCiPendingCapEscalationForHead = vi.fn();
const mockHasCiAttemptCapEscalationForHead = vi.fn();
const mockCountConsecutiveCiFixEpochsForPr = vi.fn();
const mockGetLatestPriorMatchingCiFixAttempt = vi.fn();

const mockCreateInstallationToken = vi.fn();
const mockGetCommitCheckRuns = vi.fn();
const mockGetCommitStatusContexts = vi.fn();
const mockGetPrHeadSha = vi.fn();
const mockGetPrMergeStatus = vi.fn();
const mockIsNoOpHeadTreeChange = vi.fn();
const mockGetPrReviewLoopWorklist = vi.fn();
const mockGetPrState = vi.fn();
const mockCreatePrIssueComment = vi.fn();
const mockUpdatePullRequestBranch = vi.fn();

const mockEnqueueSessionPrompt = vi.fn();
const mockGetSessionState = vi.fn();
const mockWarmSession = vi.fn();
const mockNotifySessionPrMerged = vi.fn();
const mockCloseSessionForWebhook = vi.fn();
const mockUpdateSessionReviewListeningHead = vi.fn();
const mockListSessionPrompts = vi.fn();
const mockIsSessionRuntimeLive = vi.fn();

const mockAddLabels = vi.fn();
const mockEnsureRepoLabel = vi.fn();
const mockRemoveLabel = vi.fn();
const mockPostInternalAlert = vi.fn();
const mockNotifyUserBlocked = vi.fn();
const mockGetReviewLoopEpochSummariesForHead = vi.fn();
const mockComputeReviewLoopRollup = vi.fn();
const mockCiRedExhaustedForCurrentRed = vi.fn();
const mockReduceCiState = vi.fn();
const mockSetSessionReviewLoopDoneState = vi.fn();
const mockGetLatestReviewLoopEpochForPr = vi.fn();
const mockSyncVerificationResultForPr = vi.fn();
const mockSyncVerificationStateForPr = vi.fn();
const mockClearVerificationVerdictForHeadChange = vi.fn();
const mockStampVerificationVerdictHeadForHeadChange = vi.fn();
const mockStampInformationalDispositions = vi.fn();
const mockListUndispositionedActionable = vi.fn();
const mockListRecentReviewLoopEpochDrainSummaries = vi.fn();
const mockListForPr = vi.fn();
const mockHasSucceededReviewLoopReplyToTarget = vi.fn();
const mockEmitReviewLoopNoiseGatedEvent = vi.fn();
const mockEmitReviewLoopNoiseNearMissEvent = vi.fn();
const mockEmitReviewLoopReadyToClaimEvent = vi.fn();
const mockListReviewLoopReplyGithubIdsForSession = vi.fn(async () => new Set<string>());
const mockBeginReviewLoopOperationAttempt = vi.fn();
const mockMarkReviewLoopOperationSucceeded = vi.fn();
const mockMarkReviewLoopOperationFailed = vi.fn();
const mockCreatePrReviewCommentReply = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-operations", async (importActual) => {
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/services/review-loop-operations")>();
  return {
    ...actual,
    listReviewLoopReplyGithubIdsForSession: (...args: unknown[]) => mockListReviewLoopReplyGithubIdsForSession(...args),
    beginReviewLoopOperationAttempt: (...args: unknown[]) => mockBeginReviewLoopOperationAttempt(...args),
    hasSucceededReviewLoopReplyToTarget: (...args: unknown[]) => mockHasSucceededReviewLoopReplyToTarget(...args),
    markReviewLoopOperationSucceeded: (...args: unknown[]) => mockMarkReviewLoopOperationSucceeded(...args),
    markReviewLoopOperationFailed: (...args: unknown[]) => mockMarkReviewLoopOperationFailed(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/services/review-loop-epochs")>();
  return {
    accumulatePromptedSourceRecords: actual.accumulatePromptedSourceRecords,
    accumulatePromptedSources: actual.accumulatePromptedSources,
    listDueReviewLoopEpochs: (...args: unknown[]) => mockListDueReviewLoopEpochs(...args),
    claimReviewLoopEpochForPrompt: (...args: unknown[]) => mockClaimReviewLoopEpochForPrompt(...args),
    getReviewLoopEpochById: (...args: unknown[]) => mockGetReviewLoopEpochById(...args),
    listKnownReviewLoopSourceIds: (...args: unknown[]) => mockListKnownReviewLoopSourceIds(...args),
    listKnownReviewLoopSources: (...args: unknown[]) => mockListKnownReviewLoopSources(...args),
    listPromptedReviewLoopSources: (...args: unknown[]) => mockListPromptedReviewLoopSources(...args),
    markReviewLoopEpochsStaleForHeadChange: (...args: unknown[]) => mockMarkReviewLoopEpochsStaleForHeadChange(...args),
    markReviewLoopEpochContentionDeferred: (...args: unknown[]) => mockMarkReviewLoopEpochContentionDeferred(...args),
    markReviewLoopEpochTransientFailure: (...args: unknown[]) => mockMarkReviewLoopEpochTransientFailure(...args),
    markReviewLoopEpochBlocked: (...args: unknown[]) => mockMarkReviewLoopEpochBlocked(...args),
    markReviewLoopEpochCompleted: (...args: unknown[]) => mockMarkReviewLoopEpochCompleted(...args),
    shadowEmitReviewLoopEpochTerminal: (...args: unknown[]) => mockShadowEmitReviewLoopEpochTerminal(...args),
    markReviewLoopEpochEnqueued: (...args: unknown[]) => mockMarkReviewLoopEpochEnqueued(...args),
    markReviewLoopEpochProcessing: (...args: unknown[]) => mockMarkReviewLoopEpochProcessing(...args),
    upsertReviewLoopEpochActivity: (...args: unknown[]) => mockUpsertReviewLoopEpochActivity(...args),
    bootstrapReviewLoopEpochFromHeadSignals: (...args: unknown[]) =>
      mockBootstrapReviewLoopEpochFromHeadSignals(...args),
    bootstrapReviewLoopEpochForVerification: (...args: unknown[]) =>
      mockBootstrapReviewLoopEpochForVerification(...args),
    bootstrapReviewLoopEpochForMergeConflict: (...args: unknown[]) =>
      mockBootstrapReviewLoopEpochForMergeConflict(...args),
    ingestReviewLoopCiFailureWebhook: (...args: unknown[]) => mockIngestReviewLoopCiFailureWebhook(...args),
    hasReviewLoopEpochForHead: (...args: unknown[]) => mockHasReviewLoopEpochForHead(...args),
    hasExpectedBotReviewLoopEpochForHead: (...args: unknown[]) => mockHasExpectedBotReviewLoopEpochForHead(...args),
    hasCiReviewLoopEpochForHead: (...args: unknown[]) => mockHasCiReviewLoopEpochForHead(...args),
    hasMergeConflictReviewLoopEpochForHead: (...args: unknown[]) => mockHasMergeConflictReviewLoopEpochForHead(...args),
    hasActiveMergeConflictReviewLoopEpochForHead: (...args: unknown[]) =>
      mockHasActiveMergeConflictReviewLoopEpochForHead(...args),
    hasPendingReviewLoopWork: (...args: unknown[]) => mockHasPendingReviewLoopWork(...args),
    blockPendingReviewLoopEpochsForHead: (...args: unknown[]) => mockBlockPendingReviewLoopEpochsForHead(...args),
    carryForwardReviewLoopEpochsToNewHead: (...args: unknown[]) => mockCarryForwardReviewLoopEpochsToNewHead(...args),
    carryForwardTruncatedTailEpochsToNewHead: (...args: unknown[]) =>
      mockCarryForwardTruncatedTailEpochsToNewHead(...args),
    hasCiPendingCapEscalationForHead: (...args: unknown[]) => mockHasCiPendingCapEscalationForHead(...args),
    hasCiAttemptCapEscalationForHead: (...args: unknown[]) => mockHasCiAttemptCapEscalationForHead(...args),
    countConsecutiveCiFixEpochsForPr: (...args: unknown[]) => mockCountConsecutiveCiFixEpochsForPr(...args),
    getLatestPriorMatchingCiFixAttempt: (...args: unknown[]) => mockGetLatestPriorMatchingCiFixAttempt(...args),
    getReviewLoopEpochSummariesForHead: (...args: unknown[]) => mockGetReviewLoopEpochSummariesForHead(...args),
    getLatestReviewLoopEpochForPr: (...args: unknown[]) => mockGetLatestReviewLoopEpochForPr(...args),
    listRecentReviewLoopEpochDrainSummaries: (...args: unknown[]) =>
      mockListRecentReviewLoopEpochDrainSummaries(...args),
    listStuckReviewLoopEpochs: (...args: unknown[]) => mockListStuckReviewLoopEpochs(...args),
    reclaimStuckReviewLoopEpoch: (...args: unknown[]) => mockReclaimStuckReviewLoopEpoch(...args),
    blockStuckReviewLoopEpoch: (...args: unknown[]) => mockBlockStuckReviewLoopEpoch(...args),
    extendReviewLoopEpochLease: (...args: unknown[]) => mockExtendReviewLoopEpochLease(...args),
    REVIEW_LOOP_ATTEMPT_CAP: 5,
    REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP: 5,
    REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON: "worklist_truncation_unresolved",
    REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_ATTEMPTS: 3,
    REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_REASON: "no_new_evidence_reprompt_cap",
    REVIEW_LOOP_DRAIN_NO_PROGRESS_BASIS: "drain_no_progress",
    REVIEW_LOOP_DRAIN_NO_PROGRESS_CAP: 3,
    // Pure predicates — use the real "any completed/non-pending conclusion is terminal" semantics.
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
      if (epoch.sourceKind === "merge_conflict") {
        throw new Error("reviewSourceKind called on a merge-conflict epoch");
      }
      if (epoch.sourceKind === "mention") {
        throw new Error("reviewSourceKind called on a mention epoch");
      }
      return epoch.sourceKind;
    },
  };
});

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getCommitCheckRuns: (...args: unknown[]) => mockGetCommitCheckRuns(...args),
  getCommitStatusContexts: (...args: unknown[]) => mockGetCommitStatusContexts(...args),
  getPrHeadSha: (...args: unknown[]) => mockGetPrHeadSha(...args),
  getPrMergeStatus: (...args: unknown[]) => mockGetPrMergeStatus(...args),
  isNoOpHeadTreeChange: (...args: unknown[]) => mockIsNoOpHeadTreeChange(...args),
  getPrReviewLoopWorklist: (...args: unknown[]) => mockGetPrReviewLoopWorklist(...args),
  getPrState: (...args: unknown[]) => mockGetPrState(...args),
  createPrIssueComment: (...args: unknown[]) => mockCreatePrIssueComment(...args),
  createPrReviewCommentReply: (...args: unknown[]) => mockCreatePrReviewCommentReply(...args),
  updatePullRequestBranch: (...args: unknown[]) => mockUpdatePullRequestBranch(...args),
  // Real semantics: a completed check with a failing conclusion is the actionable failing set.
  isFailingCheckRun: (run: { status?: string | null; conclusion?: string | null }) =>
    run.status === "completed" &&
    run.conclusion != null &&
    new Set(["failure", "timed_out", "action_required", "startup_failure"]).has(run.conclusion),
  addLabels: (...args: unknown[]) => mockAddLabels(...args),
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
  failingCheckFingerprint: (runs: { name?: string | null }[]) =>
    runs
      .map((run) => run.name ?? "unknown")
      .sort()
      .join("|"),
  hasPendingCheckRuns: (runs: { status?: string | null; conclusion?: string | null }[]) =>
    runs.some((r) => r.status !== "completed"),
  // Real semantics: one worklist item per failing check-run (drives ciFailingCheckRunsPresent).
  failingCheckRunWorklistItems: (runs: { status?: string | null; conclusion?: string | null }[]) =>
    (runs ?? [])
      .filter(
        (r) =>
          r.status === "completed" &&
          r.conclusion != null &&
          new Set(["failure", "timed_out", "action_required", "startup_failure"]).has(r.conclusion),
      )
      .map((_r, i) => ({ sourceId: `check-run-failure:${i}` })),
  failingCheckRunWorklistItemsWithLogEvidence: (runs: { status?: string | null; conclusion?: string | null }[]) =>
    (runs ?? [])
      .filter(
        (r) =>
          r.status === "completed" &&
          r.conclusion != null &&
          new Set(["failure", "timed_out", "action_required", "startup_failure"]).has(r.conclusion),
      )
      .map((_r, i) => ({ sourceId: `check-run-failure:${i}` })),
  FAILING_CHECK_RUN_CONCLUSIONS: new Set(["failure", "timed_out", "action_required", "startup_failure"]),
}));

vi.mock("../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: (...args: unknown[]) => mockPostInternalAlert(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: (...args: unknown[]) => mockNotifyUserBlocked(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  enqueueSessionPrompt: (...args: unknown[]) => mockEnqueueSessionPrompt(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  warmSession: (...args: unknown[]) => mockWarmSession(...args),
  notifySessionPrMerged: (...args: unknown[]) => mockNotifySessionPrMerged(...args),
  closeSessionForWebhook: (...args: unknown[]) => mockCloseSessionForWebhook(...args),
  updateSessionReviewListeningHead: (...args: unknown[]) => mockUpdateSessionReviewListeningHead(...args),
  listSessionPrompts: (...args: unknown[]) => mockListSessionPrompts(...args),
  setSessionReviewLoopDoneState: (...args: unknown[]) => mockSetSessionReviewLoopDoneState(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-review-item-disposition-db", async (importActual) => {
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/session/pr-review-item-disposition-db")>();
  return {
    ...actual,
    listForPr: (...args: unknown[]) => mockListForPr(...args),
    listUndispositionedActionable: (...args: unknown[]) => mockListUndispositionedActionable(...args),
    stampInformationalDispositions: (...args: unknown[]) => mockStampInformationalDispositions(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/observability/review-loop-events", async (importActual) => {
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/observability/review-loop-events")>();
  return {
    ...actual,
    emitReviewLoopNoiseGatedEvent: (...args: unknown[]) => mockEmitReviewLoopNoiseGatedEvent(...args),
    emitReviewLoopNoiseNearMissEvent: (...args: unknown[]) => mockEmitReviewLoopNoiseNearMissEvent(...args),
    emitReviewLoopReadyToClaimEvent: (...args: unknown[]) => mockEmitReviewLoopReadyToClaimEvent(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/review-loop-reengage", () => ({
  isSessionRuntimeLive: (...args: unknown[]) => mockIsSessionRuntimeLive(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  listReviewListeningGithubPrRefs: (...args: unknown[]) => mockListReviewListeningGithubPrRefs(...args),
  markReviewListeningGithubPrRefsSwept: (...args: unknown[]) => mockMarkReviewListeningGithubPrRefsSwept(...args),
  deleteSessionWebhookRef: (...args: unknown[]) => mockDeleteSessionWebhookRef(...args),
}));

const mockBuildGithubPrReviewLoopTriagedPrompt = vi.fn();

vi.mock("../../apps/control-plane-worker/src/webhooks/prompts", async (importActual) => {
  // Keep the agent-prompt builders stubbed (tests assert on their scripted return strings), but use
  // the REAL buildReviewLoopHumanSummary so the enqueue's replyToText carries a genuine clean summary.
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/webhooks/prompts")>();
  return {
    ...actual,
    buildGithubPrReviewLoopPrompt: (...args: unknown[]) => mockBuildGithubPrReviewLoopPrompt(...args),
    buildGithubPrReviewLoopHumanPrompt: (...args: unknown[]) => mockBuildGithubPrReviewLoopHumanPrompt(...args),
    buildGithubPrReviewLoopVerificationPrompt: (...args: unknown[]) =>
      mockBuildGithubPrReviewLoopVerificationPrompt(...args),
    buildGithubPrMergeConflictPrompt: (...args: unknown[]) => mockBuildGithubPrMergeConflictPrompt(...args),
    buildGithubPrReviewLoopTriagedPrompt: (...args: unknown[]) => mockBuildGithubPrReviewLoopTriagedPrompt(...args),
  };
});

const mockResolveReviewLoopHumanEligibility = vi.fn();
const mockResolveReviewLoopCiEligibility = vi.fn();
const mockResolveReviewLoopMergeConflictEligibility = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-settings", async (importActual) => {
  // The resolvers are mocked, but isCodeReviewArmOnlyChecklistFailure is a pure predicate that gates
  // the zero-bot fall-through — use the REAL one so the sweep tests exercise the real classification
  // (a stubbed copy could drift from the production reason union).
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/services/review-loop-settings")>();
  return {
    resolveReviewLoopChecklist: (...args: unknown[]) => mockResolveReviewLoopChecklist(...args),
    resolveReviewLoopCiEligibility: (...args: unknown[]) => mockResolveReviewLoopCiEligibility(...args),
    resolveReviewLoopHumanEligibility: (...args: unknown[]) => mockResolveReviewLoopHumanEligibility(...args),
    resolveReviewLoopMergeConflictEligibility: (...args: unknown[]) =>
      mockResolveReviewLoopMergeConflictEligibility(...args),
    isCodeReviewArmOnlyChecklistFailure: actual.isCodeReviewArmOnlyChecklistFailure,
  };
});

vi.mock("../../apps/control-plane-worker/src/services/review-loop-rollup", () => ({
  // ARC-1330 D-59b: `computeReviewLoopRollup` is deleted; after the status-comment deletion and the
  // `reviewLoopBotNoShowExpired` removal the sweep only imports `reduceCiState` and
  // `ciRedExhaustedForCurrentRed` from this module.
  reduceCiState: (...args: unknown[]) => mockReduceCiState(...args),
  // Used only by the ci-red gate telemetry log in reconcileReviewLoopDoneState; default false so the
  // log stays inert unless a test opts in.
  ciRedExhaustedForCurrentRed: (...args: unknown[]) => mockCiRedExhaustedForCurrentRed(...args),
}));

const mockTriageReviewLoopWorklist = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-triage", () => ({
  triageReviewLoopWorklist: (...args: unknown[]) => mockTriageReviewLoopWorklist(...args),
  // Real adapter semantics: a pure mapping the dispatch tests rely on for candidate shapes.
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

vi.mock("../../apps/control-plane-worker/src/constants/pr-labels", async (importActual) => {
  // Spread the real module so the FSM-spine transitive import (ARC-1330 PR 43 wired the cron producers
  // into this sweep → apply-event → project → BLOCKED_REASON_DISPLAY, which reads the full pr-labels
  // surface) resolves every export; keep the two labels the sweep itself asserts on explicit.
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/constants/pr-labels")>();
  return {
    ...actual,
    REVIEW_LOOP_DONE_LABEL: "review-loop:done",
    REVIEW_LOOP_CI_RED_LABEL: "review-loop:ci-red",
  };
});

vi.mock("../../apps/control-plane-worker/src/session/verification-state", () => ({
  syncVerificationResultForPr: (...args: unknown[]) => mockSyncVerificationResultForPr(...args),
  syncVerificationStateForPr: (...args: unknown[]) => mockSyncVerificationStateForPr(...args),
  clearVerificationVerdictForHeadChange: (...args: unknown[]) => mockClearVerificationVerdictForHeadChange(...args),
  stampVerificationVerdictHeadForHeadChange: (...args: unknown[]) =>
    mockStampVerificationVerdictHeadForHeadChange(...args),
}));

// ARC-1330 (W11-P2): the canonical FSM label writer the sweep delegates to under FSM_MODE=live.
const mockSyncFsmLabelsForPr = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/fsm-label-sync", () => ({
  syncFsmLabelsForPr: (...args: unknown[]) => mockSyncFsmLabelsForPr(...args),
}));

// ARC-1330 (W11): the head-change spine producer the sweep dual-emits to on a sweep-observed head advance,
// BEFORE any label teardown, so the canonical reconcile runs off a fresh spine row. `classifyHeadChange`
// stays REAL (the pure real-vs-noop discrimination the test asserts flows through); only the CAS-writing
// emit is stubbed so the wiring/ordering can be asserted without a live D1.
const mockShadowEmitHeadChange = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/fsm/head-producer", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/session/fsm/head-producer")>();
  return {
    ...actual,
    shadowEmitHeadChange: (...args: unknown[]) => mockShadowEmitHeadChange(...args),
  };
});

// ARC-1330 (W11-V10): the dual-run parity sample fired when the legacy needs-work intake stands down at live.
const mockEmitVerificationIntakeStanddownParity = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/fsm/verification-intake-projection", () => ({
  emitVerificationIntakeStanddownParity: (...args: unknown[]) => mockEmitVerificationIntakeStanddownParity(...args),
}));

// A3: the run-scoped verification backstop emits `verification.stopped` through this producer.
const mockShadowEmitVerificationOutcome = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/fsm/verification-producer", async (importActual) => {
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/session/fsm/verification-producer")>();
  return {
    ...actual,
    shadowEmitVerificationOutcome: (...args: unknown[]) => mockShadowEmitVerificationOutcome(...args),
  };
});

// A3: the cross-DO dormant-REVIEW give-up backstop fires the §10 `deadline_exceeded` through this
// producer. `deadlineWouldFire` (the pure sweep pre-check) stays REAL via `...actual`.
const mockShadowFireDueDeadline = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/fsm/deadline-producer", async (importActual) => {
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/session/fsm/deadline-producer")>();
  return {
    ...actual,
    shadowFireDueDeadline: (...args: unknown[]) => mockShadowFireDueDeadline(...args),
  };
});

const logger = { info: vi.fn(), warn: vi.fn() };
const env = { DB: {} } as never;

function createPrefetchEnv() {
  const batches: string[][] = [];
  const db = {
    prepare(query: string) {
      return {
        query,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          return { ...this, values };
        },
      };
    },
    async batch(statements: Array<{ query: string; values: unknown[] }>) {
      batches.push(statements.map((statement) => statement.query));
      return statements.map((statement) => {
        if (statement.query.includes("FROM github_installations")) {
          return {
            results: [
              {
                installation_id: 9001,
                owner_login: "acme",
                owner_id: 1,
                owner_type: "Organization",
                repository_selection: "all",
                permissions_json: JSON.stringify({ contents: "write", pull_requests: "write", issues: "write" }),
                events_json: JSON.stringify(["pull_request", "pull_request_review", "pull_request_review_comment"]),
                suspended_at: null,
              },
            ],
          };
        }
        if (statement.query.includes("FROM user_pr_review_bot_settings")) {
          return {
            results: [
              {
                user_id: 101,
                repo_owner: "acme",
                repo_name: "repo",
                expected_bots_json: JSON.stringify([{ type: "known", id: "cursor-bugbot" }]),
                ci_response_enabled: 1,
                review_timeout_minutes: 5,
                merge_conflict_resolution_enabled: 0,
                created_at: 1,
                updated_at: 1,
              },
            ],
          };
        }
        return { results: [] };
      });
    },
  };
  return { env: { DB: db } as never, batches };
}

function createNoBatchPrefetchEnv() {
  return {
    env: {
      DB: {
        prepare: vi.fn(),
      },
    } as never,
  };
}

function createThrowingPrefetchEnv() {
  const batches: string[][] = [];
  return {
    env: {
      DB: {
        prepare(query: string) {
          return {
            query,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
          };
        },
        async batch(statements: Array<{ query: string; values: unknown[] }>) {
          batches.push(statements.map((statement) => statement.query));
          throw new Error("d1 unavailable");
        },
      },
    } as never,
    batches,
  };
}

function expectPrefetchedReviewLoopInputs(input: Record<string, unknown>): void {
  const installationByOwnerLogin = input.installationByOwnerLogin as Map<string, { installation_id: number }>;
  const botSettingsByOwnerRepo = input.botSettingsByOwnerRepo as Map<
    string,
    { expectedBots: Array<{ type: string; id: string }> }
  >;
  expect(installationByOwnerLogin.get("acme")?.installation_id).toBe(9001);
  expect(botSettingsByOwnerRepo.get("101:acme/repo")?.expectedBots).toEqual([{ type: "known", id: "cursor-bugbot" }]);
}

function claimedEpoch(overrides: Record<string, unknown> = {}) {
  return {
    id: "epoch-1",
    sessionId: "sess-1",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "old-head",
    expectedBotsHash: "hash-1",
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotKeys: ["known:cursor-bugbot"],
    observedTerminalBotKeys: [],
    timedOutBotKeys: [],
    reservationToken: "reservation-1",
    firstActivityAt: 0,
    fallbackAfterAt: 600_000,
    status: "ready",
    sourceKind: "bot",
    leaseExpiresAt: null,
    updatedAt: 123_000,
    attemptCount: 0,
    carryForwardNoProgressCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function reviewListeningSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    status: "active",
    ownerUserId: "101",
    installationId: 9001,
    reviewListeningActive: true,
    reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    reviewListeningHeadSha: "old-head",
    // Post-verdict baseline; pre-verdict comment dispatch is exercised by explicit overrides below.
    verificationState: "verification-done",
    verificationResult: "merge-ready",
    ...overrides,
  };
}

function setupDueReviewEpochForPrompt(overrides: Record<string, unknown> = {}) {
  const epoch = claimedEpoch({ status: "ready", attemptCount: 1, ...overrides });
  mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
  mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(
    claimedEpoch({ status: "reserving", attemptCount: 1, ...overrides }),
  );
  return epoch;
}

describe("review-loop sweep", () => {
  beforeEach(() => {
    mockListDueReviewLoopEpochs.mockReset().mockResolvedValue([]);
    mockClaimReviewLoopEpochForPrompt.mockReset().mockResolvedValue(null);
    mockGetReviewLoopEpochById.mockReset().mockResolvedValue(claimedEpoch({ status: "processing" }));
    mockListKnownReviewLoopSourceIds.mockReset().mockResolvedValue(new Set<string>());
    mockListKnownReviewLoopSources.mockReset().mockResolvedValue({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
      triggeringSourceIds: new Set<string>(),
    });
    mockListPromptedReviewLoopSources.mockReset().mockResolvedValue({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockMarkReviewLoopEpochsStaleForHeadChange.mockReset().mockResolvedValue(0);
    mockMarkReviewLoopEpochContentionDeferred.mockReset().mockResolvedValue(claimedEpoch({ status: "ready" }));
    mockMarkReviewLoopEpochTransientFailure.mockReset().mockResolvedValue(claimedEpoch({ status: "ready" }));
    mockMarkReviewLoopEpochBlocked.mockReset().mockResolvedValue(claimedEpoch({ status: "blocked" }));
    mockMarkReviewLoopEpochCompleted.mockReset().mockResolvedValue(claimedEpoch({ status: "completed" }));
    mockShadowEmitReviewLoopEpochTerminal.mockReset().mockResolvedValue(undefined);
    mockMarkReviewLoopEpochEnqueued.mockReset().mockResolvedValue(claimedEpoch({ status: "enqueued" }));
    mockMarkReviewLoopEpochProcessing.mockReset().mockResolvedValue(claimedEpoch({ status: "processing" }));
    mockUpsertReviewLoopEpochActivity.mockReset().mockResolvedValue(claimedEpoch({ status: "reserving" }));
    mockListStuckReviewLoopEpochs.mockReset().mockResolvedValue([]);
    mockReclaimStuckReviewLoopEpoch.mockReset().mockResolvedValue(claimedEpoch({ status: "ready" }));
    mockBlockStuckReviewLoopEpoch.mockReset().mockResolvedValue(claimedEpoch({ status: "blocked" }));
    mockExtendReviewLoopEpochLease.mockReset().mockResolvedValue(claimedEpoch({ status: "processing" }));
    // ARC-1407: default the liveness fallback to "runtime gone" so existing reclaim tests still reclaim;
    // the liveness-skip tests opt into "alive" explicitly.
    mockIsSessionRuntimeLive.mockReset().mockResolvedValue(false);
    mockListReviewListeningGithubPrRefs.mockReset().mockResolvedValue({ data: [], nextCursor: null });
    mockMarkReviewListeningGithubPrRefsSwept.mockReset().mockResolvedValue(undefined);
    mockDeleteSessionWebhookRef.mockReset().mockResolvedValue(true);
    mockCreateInstallationToken.mockReset().mockResolvedValue("token-1");
    mockGetCommitCheckRuns.mockReset().mockResolvedValue([]);
    mockGetCommitStatusContexts.mockReset().mockResolvedValue([]);
    mockGetPrHeadSha.mockReset().mockResolvedValue("old-head");
    mockGetPrReviewLoopWorklist.mockReset().mockResolvedValue({
      items: [
        {
          sourceId: "review-comment:1",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Fix this",
          path: "src/app.ts",
          line: 10,
          updatedAtMs: 1,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    mockStampInformationalDispositions.mockReset().mockResolvedValue(undefined);
    mockListUndispositionedActionable.mockReset().mockResolvedValue([]);
    mockListRecentReviewLoopEpochDrainSummaries.mockReset().mockResolvedValue([]);
    mockListForPr.mockReset().mockResolvedValue([]);
    mockHasSucceededReviewLoopReplyToTarget.mockReset().mockResolvedValue(false);
    mockEmitReviewLoopNoiseGatedEvent.mockReset().mockResolvedValue(undefined);
    mockEmitReviewLoopNoiseNearMissEvent.mockReset().mockResolvedValue(undefined);
    mockEmitReviewLoopReadyToClaimEvent.mockReset().mockResolvedValue(undefined);
    mockGetPrState.mockReset().mockResolvedValue("open");
    // Default merge-status bridges to the existing getPrState/getPrHeadSha mocks so the reconcile
    // tests that set those keep working; mergeableState defaults to "clean" (no merge handling).
    mockGetPrMergeStatus.mockReset().mockImplementation(async (...args: unknown[]) => ({
      state: await mockGetPrState(...args),
      headSha: await mockGetPrHeadSha(...args),
      mergeable: true,
      mergeableState: "clean",
      rawMergeableState: "clean",
      labels: [],
    }));
    mockCreatePrIssueComment.mockReset().mockResolvedValue({ id: 1, htmlUrl: "https://github.com/c/1" });
    mockCreatePrReviewCommentReply.mockReset().mockResolvedValue({ id: 2, htmlUrl: "https://github.com/c/2" });
    mockBeginReviewLoopOperationAttempt
      .mockReset()
      .mockImplementation(async (_db: unknown, input: { operationId: string }) => ({
        status: "started",
        operation: { operationId: input.operationId, attempts: 1, githubId: null, verdict: null },
      }));
    mockMarkReviewLoopOperationSucceeded.mockReset().mockResolvedValue(null);
    mockMarkReviewLoopOperationFailed.mockReset().mockResolvedValue(null);
    mockHasPendingReviewLoopWork.mockReset().mockResolvedValue(false);
    mockMarkPrCoordinationUpdateBranchQueued.mockReset().mockResolvedValue(1);
    // Default: delegate to the real DAO. For the `runReviewLoopSweep` cases the sweep passes the
    // `env.DB = {}` stub, so the real read throws and is caught → treated as "no spine queued marker"
    // (issue update-branch / stale-block). The `fireStuckVerificationBackstops` suite passes a real
    // migrated sqlite db, so it reads back real rows. Behind/head-change cases override with a per-call
    // `mockResolvedValueOnce` to script the queued marker.
    mockGetPrCoordination
      .mockReset()
      .mockImplementation((...args: unknown[]) => realCoordinationDb.getPrCoordination?.(...args));
    mockBlockPendingReviewLoopEpochsForHead.mockReset().mockResolvedValue(1);
    mockCarryForwardReviewLoopEpochsToNewHead.mockReset().mockResolvedValue(1);
    mockCarryForwardTruncatedTailEpochsToNewHead.mockReset().mockResolvedValue(0);
    mockHasCiPendingCapEscalationForHead.mockReset().mockResolvedValue(false);
    mockHasCiAttemptCapEscalationForHead.mockReset().mockResolvedValue(false);
    mockCountConsecutiveCiFixEpochsForPr
      .mockReset()
      .mockResolvedValue({ sameFingerprintStreak: 0, totalConsecutiveStreak: 0 });
    mockGetLatestPriorMatchingCiFixAttempt.mockReset().mockResolvedValue(null);
    mockUpdatePullRequestBranch.mockReset().mockResolvedValue({ ok: true });
    mockEnqueueSessionPrompt.mockReset();
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession());
    mockWarmSession.mockReset().mockResolvedValue({ ok: true, status: "spawning" });
    mockNotifySessionPrMerged.mockReset().mockResolvedValue({ ok: true, payload: { notified: true }, status: 200 });
    mockCloseSessionForWebhook.mockReset().mockResolvedValue({ closed: true, session: reviewListeningSession() });
    mockUpdateSessionReviewListeningHead
      .mockReset()
      .mockResolvedValue({ ok: true, payload: { updated: true }, status: 200 });
    mockListSessionPrompts
      .mockReset()
      .mockResolvedValue({ ok: true, payload: { queue: { processingPromptId: null } }, status: 200 });
    mockBuildGithubPrReviewLoopPrompt.mockReset().mockReturnValue("review-loop prompt");
    mockBuildGithubPrReviewLoopHumanPrompt.mockReset().mockReturnValue("review-loop human prompt");
    mockBuildGithubPrReviewLoopVerificationPrompt.mockReset().mockReturnValue("review-loop verification prompt");
    mockBuildGithubPrMergeConflictPrompt.mockReset().mockReturnValue("merge-conflict prompt");
    mockBuildGithubPrReviewLoopTriagedPrompt.mockReset().mockReturnValue("review-loop triaged prompt");
    mockTriageReviewLoopWorklist.mockReset().mockResolvedValue({ ok: false, reason: "llm_unavailable" });
    mockResolveReviewLoopChecklist.mockReset().mockResolvedValue({
      ok: true,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "settings-hash",
    });
    mockResolveReviewLoopHumanEligibility.mockReset().mockResolvedValue({
      ok: true,
      ownerUserId: 101,
      installationId: 9001,
    });
    mockResolveReviewLoopCiEligibility.mockReset().mockResolvedValue({
      ok: true,
      ownerUserId: 101,
      installationId: 9001,
    });
    mockResolveReviewLoopMergeConflictEligibility
      .mockReset()
      .mockResolvedValue({ ok: false, reason: "merge_conflict_resolution_disabled" });
    mockBootstrapReviewLoopEpochFromHeadSignals
      .mockReset()
      .mockResolvedValue({ bootstrapped: 0, ignored: [], epoch: null });
    mockBootstrapReviewLoopEpochForVerification
      .mockReset()
      .mockResolvedValue(claimedEpoch({ status: "ready", sourceKind: "verification" }));
    mockBootstrapReviewLoopEpochForMergeConflict
      .mockReset()
      .mockResolvedValue(claimedEpoch({ status: "ready", sourceKind: "merge_conflict" }));
    mockIngestReviewLoopCiFailureWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockHasReviewLoopEpochForHead.mockReset().mockResolvedValue(false);
    mockHasExpectedBotReviewLoopEpochForHead.mockReset().mockResolvedValue(false);
    mockHasCiReviewLoopEpochForHead.mockReset().mockResolvedValue(false);
    mockHasMergeConflictReviewLoopEpochForHead.mockReset().mockResolvedValue(false);
    mockHasActiveMergeConflictReviewLoopEpochForHead.mockReset().mockResolvedValue(false);
    mockAddLabels.mockReset().mockResolvedValue(undefined);
    mockEnsureRepoLabel.mockReset().mockResolvedValue({ ok: true, created: false });
    mockRemoveLabel.mockReset().mockResolvedValue(undefined);
    mockPostInternalAlert.mockReset().mockResolvedValue(null);
    mockNotifyUserBlocked.mockReset().mockResolvedValue("sent");
    mockGetReviewLoopEpochSummariesForHead.mockReset().mockResolvedValue([]);
    mockReduceCiState.mockReset().mockReturnValue("green");
    mockComputeReviewLoopRollup.mockReset().mockReturnValue(null);
    mockSetSessionReviewLoopDoneState.mockReset().mockResolvedValue({ ok: true, updated: true });
    mockGetLatestReviewLoopEpochForPr.mockReset().mockResolvedValue(null);
    mockSyncVerificationResultForPr.mockReset().mockResolvedValue(undefined);
    mockSyncVerificationStateForPr.mockReset().mockResolvedValue(undefined);
    mockClearVerificationVerdictForHeadChange.mockReset().mockResolvedValue(undefined);
    mockStampVerificationVerdictHeadForHeadChange.mockReset().mockResolvedValue(undefined);
    // Default: a head change is a real content change (clears the verdict as before). No-op-tree tests
    // override this to true.
    mockIsNoOpHeadTreeChange.mockReset().mockResolvedValue(false);
    mockSyncFsmLabelsForPr.mockReset().mockResolvedValue({ added: [], removed: [] });
    // Default: the spine head emit COMMITS (applyEvent outcome "handled") — the happy path.
    mockShadowEmitHeadChange.mockReset().mockResolvedValue(true);
    mockShadowEmitVerificationOutcome.mockReset().mockResolvedValue(undefined);
    mockShadowFireDueDeadline.mockReset().mockResolvedValue({ wouldFire: false, from: null, to: null });
    logger.info.mockReset();
    logger.warn.mockReset();
    mockCiRedExhaustedForCurrentRed.mockReset().mockReturnValue(false);
  });

  it("dispatch-only sweep processes due epochs without running reconcile tasks", async () => {
    const setup = createPrefetchEnv();
    const epoch = claimedEpoch({ updatedAt: 780_000 });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1" } },
    });

    const { runReviewLoopEpochDispatchSweep } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopEpochDispatchSweep(setup.env, { nowMs: 789_000, logger: logger as never });

    expect(result.attempted).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(mockListStuckReviewLoopEpochs).not.toHaveBeenCalled();
    expect(mockListReviewListeningGithubPrRefs).not.toHaveBeenCalled();
    expect(mockEmitReviewLoopReadyToClaimEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        epochId: "epoch-1",
        readyToClaimMs: 9_000,
        sourceKind: "bot",
      }),
    );
  });

  it("dispatch-only sweep fans out epochs for distinct sessions", async () => {
    const setup = createPrefetchEnv();
    const epoch1 = claimedEpoch({ id: "epoch-1", sessionId: "sess-1" });
    const epoch2 = claimedEpoch({ id: "epoch-2", sessionId: "sess-2" });
    const releaseFirstClaim = deferred<ReturnType<typeof claimedEpoch>>();
    const secondClaimStarted = deferred<void>();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch1, epoch2]);
    mockClaimReviewLoopEpochForPrompt.mockImplementation(async (_db, epochId: string) => {
      if (epochId === "epoch-1") return releaseFirstClaim.promise;
      secondClaimStarted.resolve();
      return epoch2;
    });
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1" } },
    });

    const { runReviewLoopEpochDispatchSweep } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const sweep = runReviewLoopEpochDispatchSweep(setup.env, { nowMs: 789_000, logger: logger as never });

    await secondClaimStarted.promise;
    expect(mockClaimReviewLoopEpochForPrompt).toHaveBeenCalledWith(expect.anything(), "epoch-2", expect.anything());

    releaseFirstClaim.resolve(epoch1);
    const result = await sweep;
    expect(result.enqueued).toBe(2);
  });

  it("dispatch-only sweep keeps epochs for the same session sequential", async () => {
    const setup = createPrefetchEnv();
    const epoch1 = claimedEpoch({ id: "epoch-1", sessionId: "sess-1" });
    const epoch2 = claimedEpoch({ id: "epoch-2", sessionId: "sess-1" });
    const releaseFirstClaim = deferred<ReturnType<typeof claimedEpoch>>();
    const firstClaimStarted = deferred<void>();
    const claimOrder: string[] = [];
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch1, epoch2]);
    mockClaimReviewLoopEpochForPrompt.mockImplementation(async (_db, epochId: string) => {
      claimOrder.push(epochId);
      if (epochId === "epoch-1") {
        firstClaimStarted.resolve();
        return releaseFirstClaim.promise;
      }
      return epoch2;
    });
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1" } },
    });

    const { runReviewLoopEpochDispatchSweep } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const sweep = runReviewLoopEpochDispatchSweep(setup.env, { nowMs: 789_000, logger: logger as never });

    await firstClaimStarted.promise;
    expect(claimOrder).toEqual(["epoch-1"]);

    releaseFirstClaim.resolve(epoch1);
    const result = await sweep;
    expect(claimOrder).toEqual(["epoch-1", "epoch-2"]);
    expect(result.enqueued).toBe(2);
  });

  it("dispatch-only sweep preserves status tallies under fan-out", async () => {
    const setup = createPrefetchEnv();
    const humanEpoch = claimedEpoch({ id: "epoch-human", sessionId: "sess-human", sourceKind: "human" });
    const mixedEpoch = claimedEpoch({ id: "epoch-mixed", sessionId: "sess-mixed", sourceKind: "mixed" });
    const contentionEpoch = claimedEpoch({ id: "epoch-contention", sessionId: "sess-contention" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([humanEpoch, mixedEpoch, contentionEpoch]);
    mockClaimReviewLoopEpochForPrompt.mockImplementation(async (_db, epochId: string) => {
      if (epochId === "epoch-human") return humanEpoch;
      if (epochId === "epoch-mixed") return mixedEpoch;
      return contentionEpoch;
    });
    mockEnqueueSessionPrompt.mockImplementation(async (_env, sessionId: string) =>
      sessionId === "sess-contention"
        ? {
            ok: false,
            status: 429,
            error: "Resume is being retried too quickly. Please wait a moment and try again.",
            payload: null,
          }
        : {
            ok: true,
            status: 200,
            payload: { prompt: { promptId: `prompt-${sessionId}` } },
          },
    );

    const { runReviewLoopEpochDispatchSweep } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopEpochDispatchSweep(setup.env, { nowMs: 789_000, logger: logger as never });

    expect(result.attempted).toBe(3);
    expect(result.enqueued).toBe(2);
    expect(result.humanEpochsCreated).toBe(1);
    expect(result.mixedEpochsCreated).toBe(1);
    expect(result.contentionDeferred).toBe(1);
    expect(result.dispatchErrors).toBe(0);
  });

  it("dispatch-only sweep isolates one epoch exception without aborting the batch", async () => {
    const setup = createPrefetchEnv();
    const failingEpoch = claimedEpoch({ id: "epoch-failing", sessionId: "sess-failing" });
    const enqueuedEpoch = claimedEpoch({ id: "epoch-enqueued", sessionId: "sess-enqueued" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([failingEpoch, enqueuedEpoch]);
    mockClaimReviewLoopEpochForPrompt.mockImplementation(async (_db, epochId: string) => {
      if (epochId === "epoch-failing") throw new Error("claim exploded");
      return enqueuedEpoch;
    });
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1" } },
    });

    const { runReviewLoopEpochDispatchSweep } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopEpochDispatchSweep(setup.env, { nowMs: 789_000, logger: logger as never });

    expect(result.enqueued).toBe(1);
    expect(result.dispatchErrors).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Error: claim exploded",
        epochId: "epoch-failing",
        sessionId: "sess-failing",
      }),
      "Review-loop epoch dispatch failed",
    );
  });

  it("dispatch-only sweep stops a same-session group after an epoch exception", async () => {
    const setup = createPrefetchEnv();
    const failingEpoch = claimedEpoch({ id: "epoch-failing", sessionId: "sess-1" });
    const laterSameSessionEpoch = claimedEpoch({ id: "epoch-later", sessionId: "sess-1" });
    const otherSessionEpoch = claimedEpoch({ id: "epoch-other", sessionId: "sess-2" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([failingEpoch, laterSameSessionEpoch, otherSessionEpoch]);
    mockClaimReviewLoopEpochForPrompt.mockImplementation(async (_db, epochId: string) => {
      if (epochId === "epoch-failing") throw new Error("claim exploded");
      if (epochId === "epoch-later") return laterSameSessionEpoch;
      return otherSessionEpoch;
    });
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1" } },
    });

    const { runReviewLoopEpochDispatchSweep } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopEpochDispatchSweep(setup.env, { nowMs: 789_000, logger: logger as never });

    expect(mockClaimReviewLoopEpochForPrompt).not.toHaveBeenCalledWith(
      expect.anything(),
      "epoch-later",
      expect.anything(),
    );
    expect(result.enqueued).toBe(1);
    expect(result.dispatchErrors).toBe(1);
  });

  // B3 (ARC-1330 Phase B): dispatchReviewLoopEpoch is the extracted, exported dispatch orchestration
  // the FSM `dispatch_epoch` sink (B4) and the stuck-epoch reclaim (B6) call directly on webhook
  // arrival / on reclaim — not just the cron poll. These prove the direct-call surface: the claim-CAS
  // stays the single mutex (loser dispatches nothing), and the caller's `trigger` tags the dispatch.
  describe("dispatchReviewLoopEpoch (extracted direct dispatch surface)", () => {
    it("dispatches a claimed epoch directly and tags the arrival telemetry with the caller trigger", async () => {
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { dispatchReviewLoopEpoch } =
        await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const status = await dispatchReviewLoopEpoch(env, epoch as never, {
        nowMs: 789_000,
        logger: logger as never,
        syncState: { sessionOverride: null },
        trigger: "webhook_arrival",
      });

      expect(status).toBe("enqueued");
      const enqueueCall = mockMarkReviewLoopEpochEnqueued.mock.calls.at(-1);
      expect(enqueueCall?.[2]).toMatchObject({ trigger: "webhook_arrival" });
    });

    it("returns skipped without dispatching when the claim-CAS is lost (mutex-first for the non-poll callers)", async () => {
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(null);

      const { dispatchReviewLoopEpoch } =
        await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const status = await dispatchReviewLoopEpoch(env, epoch as never, {
        nowMs: 789_000,
        logger: logger as never,
        syncState: { sessionOverride: null },
        trigger: "webhook_arrival",
      });

      expect(status).toBe("skipped");
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    });

    it("kicks an idempotent warm immediately before enqueue when the session runtime is not already live", async () => {
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockIsSessionRuntimeLive.mockResolvedValueOnce(false);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { dispatchReviewLoopEpoch } =
        await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const status = await dispatchReviewLoopEpoch(env, epoch as never, {
        nowMs: 789_000,
        logger: logger as never,
        trigger: "webhook_arrival",
      });

      expect(status).toBe("enqueued");
      expect(mockIsSessionRuntimeLive).toHaveBeenCalledWith(env.DB, "sess-1", 789_000);
      expect(mockWarmSession).toHaveBeenCalledWith(env, "sess-1", "review-loop-dispatch-epoch-1");
      expect(mockGetPrReviewLoopWorklist.mock.invocationCallOrder[0]).toBeLessThan(
        mockWarmSession.mock.invocationCallOrder[0],
      );
      expect(mockWarmSession.mock.invocationCallOrder[0]).toBeLessThan(
        mockEnqueueSessionPrompt.mock.invocationCallOrder[0],
      );
    });

    it("skips the prewarm when the review-loop session runtime is already live", async () => {
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockIsSessionRuntimeLive.mockResolvedValueOnce(true);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { dispatchReviewLoopEpoch } =
        await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const status = await dispatchReviewLoopEpoch(env, epoch as never, {
        nowMs: 789_000,
        logger: logger as never,
        trigger: "webhook_arrival",
      });

      expect(status).toBe("enqueued");
      expect(mockWarmSession).not.toHaveBeenCalled();
    });
  });

  describe("prefetched review-loop resolver inputs on reconcile", () => {
    it("passes prefetched checklist inputs into due epoch resolver calls", async () => {
      const setup = createPrefetchEnv();
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(setup.env, { nowMs: 789_000, logger: logger as never });

      expect(setup.batches).toHaveLength(1);
      expectPrefetchedReviewLoopInputs(mockResolveReviewLoopChecklist.mock.calls[0][1]);
    });

    it("falls back to resolver DB reads when DB.batch is unavailable", async () => {
      const setup = createNoBatchPrefetchEnv();
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(setup.env, { nowMs: 789_000, logger: logger as never });

      expect(mockResolveReviewLoopChecklist.mock.calls[0][1]).toEqual(
        expect.not.objectContaining({
          installationByOwnerLogin: expect.any(Map),
          botSettingsByOwnerRepo: expect.any(Map),
        }),
      );
    });

    it("falls back to resolver DB reads when checklist prefetch throws", async () => {
      const setup = createThrowingPrefetchEnv();
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(setup.env, { nowMs: 789_000, logger: logger as never });

      expect(setup.batches).toHaveLength(1);
      expect(mockResolveReviewLoopChecklist).toHaveBeenCalled();
      expect(mockResolveReviewLoopChecklist.mock.calls[0][1]).toEqual(
        expect.not.objectContaining({
          installationByOwnerLogin: expect.any(Map),
          botSettingsByOwnerRepo: expect.any(Map),
        }),
      );
    });

    it("passes page-prefetched inputs into review-listening reconciliation resolver calls", async () => {
      const setup = createPrefetchEnv();
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            ownerUserId: 101,
            prUrl: "https://github.com/acme/repo/pull/42",
            sweptAt: 0,
          },
        ],
        nextCursor: null,
      });
      // expected_bots_changed is the remaining code-review-arm-only failure that routes through the
      // CI-eligibility resolver (zero-bot repos now resolve ok:true and skip that branch).
      mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "expected_bots_changed" });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(setup.env, { nowMs: 789_000, logger: logger as never });

      expect(setup.batches).toHaveLength(1);
      expectPrefetchedReviewLoopInputs(mockResolveReviewLoopChecklist.mock.calls[0][1]);
      expect(mockResolveReviewLoopCiEligibility).toHaveBeenCalledWith(
        setup.env,
        expect.objectContaining({
          ownerUserId: 101,
          repoOwner: "acme",
          repoName: "repo",
          installationByOwnerLogin: expect.any(Map),
        }),
      );
    });
  });

  it("claims up to 50 due epochs by default", async () => {
    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    await runReviewLoopSweep(env, {
      nowMs: 123_000,
      logger: logger as never,
    });

    expect(mockListDueReviewLoopEpochs).toHaveBeenCalledWith({}, { nowMs: 123_000, limit: 50 });
  });

  it("passes prior-prompted source metadata to the dispatch worklist for a review epoch", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    const promptedAtBySourceId = new Map([["review-comment:already", 700_000]]);
    const legacySourceIds = new Set(["issue-comment:42"]);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({ promptedAtBySourceId, legacySourceIds });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockListPromptedReviewLoopSources).toHaveBeenCalledWith(env.DB, {
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      excludeEpochId: "epoch-1",
    });
    expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      expect.objectContaining({
        excludePromptedSourceRecords: promptedAtBySourceId,
        excludeSourceIds: legacySourceIds,
      }),
    );
  });

  it("threads review-body bodyHashes into the worklist and persists them at enqueue (PR-1)", async () => {
    const epoch = claimedEpoch({ sourceKind: "human" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    const promptedAtBySourceId = new Map([["review-body:9100", 700_000]]);
    const bodyHashBySourceId = new Map([["review-body:9100", "hash-prior"]]);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId,
      bodyHashBySourceId,
      legacySourceIds: new Set<string>(),
    });
    // The dispatched worklist surfaces a (newly edited) review body carrying its raw-body hash.
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-body:9100",
          sourceUrl: "https://github.com/acme/repo/pull/42#pullrequestreview-9100",
          authorLogin: "alice",
          authorType: "User",
          body: "Edited review body",
          path: null,
          line: null,
          updatedAtMs: 1,
          isResolved: false,
          isOutdated: false,
          rawBodyHash: "hash-edited",
        },
      ],
      duplicateGroups: [],
      worklistHash: "wh",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // The prior epoch's body hash feeds the dispatch worklist's edit detection...
    expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      expect.objectContaining({ excludePromptedSourceBodyHashes: bodyHashBySourceId }),
    );
    // ...and the just-prompted body's hash is persisted for the NEXT wave.
    const enqueueCall = mockMarkReviewLoopEpochEnqueued.mock.calls.at(-1);
    const persistedHashes = enqueueCall?.[2]?.promptedSourceBodyHashes as Map<string, string>;
    expect(persistedHashes.get("review-body:9100")).toBe("hash-edited");
  });

  it("persists a bodyHash for a review body collapsed as a DUPLICATE so a later edit re-admits it (PR-1)", async () => {
    const epoch = claimedEpoch({ sourceKind: "human" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      bodyHashBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    // Two human review bodies that normalize-equal but differ in raw bytes: the second collapses
    // into the first as a duplicate and carries its OWN raw-body hash on reviewBodyDuplicateHashes.
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-body:9100",
          sourceUrl: "https://github.com/acme/repo/pull/42#pullrequestreview-9100",
          authorLogin: "alice",
          authorType: "User",
          body: "Please address the null guard.",
          path: null,
          line: null,
          updatedAtMs: 1,
          isResolved: false,
          isOutdated: false,
          rawBodyHash: "hash-9100",
        },
      ],
      duplicateGroups: [{ canonicalSourceId: "review-body:9100", duplicateSourceIds: ["review-body:9200"] }],
      reviewBodyDuplicateHashes: new Map([["review-body:9200", "hash-9200-own"]]),
      worklistHash: "wh",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // The canonical gets its hash; the collapsed-duplicate gets ITS OWN raw-body hash (not the
    // canonical's), so a later edit to the duplicate is detected by hash and an unchanged duplicate
    // that merely raw-differs from the canonical is NOT spuriously re-admitted.
    const enqueueCall = mockMarkReviewLoopEpochEnqueued.mock.calls.at(-1);
    const persistedHashes = enqueueCall?.[2]?.promptedSourceBodyHashes as Map<string, string>;
    expect(persistedHashes.get("review-body:9100")).toBe("hash-9100");
    expect(persistedHashes.get("review-body:9200")).toBe("hash-9200-own");
  });

  it("completes as a no-op without prompting when dedup empties the dispatch worklist", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map([["review-comment:1", 700_000]]),
      legacySourceIds: new Set<string>(),
    });
    // Every actionable item was already prompted by a prior epoch, so the real worklist builder
    // returns an empty set once excludeSourceIds is applied.
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({ items: [], duplicateGroups: [], worklistHash: "h-empty" });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // The point of the feature: a re-bootstrapped epoch whose feedback was all handled does NOT
    // re-prompt — it completes as a no-op.
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochCompleted).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ worklistHash: "h-empty" }),
    );
    expect(result.completedNoop).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("dispatches without dedup (fail-open) when the prompted-source-ids lookup throws", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockRejectedValueOnce(new Error("D1 unavailable"));
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // A transient D1 read failure degrades to the pre-dedup behavior: the epoch still dispatches with
    // no excludeSourceIds, never blocked or skipped.
    expect(mockGetPrReviewLoopWorklist).toHaveBeenCalled();
    const worklistCall = mockGetPrReviewLoopWorklist.mock.calls.at(-1);
    expect(worklistCall).toBeDefined();
    expect(worklistCall![4].excludePromptedSourceRecords).toBeUndefined();
    expect(worklistCall![4].excludeSourceIds).toBeUndefined();
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
    expect(result.enqueued).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: "epoch-1" }),
      "Review-loop dispatch dedup lookup failed; proceeding without it",
    );
  });

  it("stores a clean human summary in replyToText at the non-CI enqueue", async () => {
    // The enqueue must carry a human-readable summary (not the agent-machinery prompt) so downstream
    // human/LLM-input surfaces render it in place of the [cycloid:review-loop …] footer.
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
    const options = mockEnqueueSessionPrompt.mock.calls[0]?.[4] as { replyToText?: string };
    expect(options.replyToText).toMatch(/^Addressing /);
    expect(options.replyToText).not.toContain("[cycloid:review-loop");
    // The default worklist item (cursor[bot] @ src/app.ts:10) is summarized with author + location.
    expect(options.replyToText).toContain("@cursor[bot]");
    expect(options.replyToText).toContain("src/app.ts:10");
  });

  it("carries budget-dropped source ids forward as un-prompted work on dispatch (ARC-1226)", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-comment:1",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Fix this",
          path: "src/app.ts",
          line: 10,
          updatedAtMs: 1,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "wh-truncated",
      droppedItemCount: 2,
      droppedBodyBytes: 70_000,
      droppedSourceIds: ["review-comment:2", "review-comment:3"],
    });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // The dropped tail is recorded as carried-forward (un-prompted) so the settle path re-drives the
    // epoch and the next sweep dispatches it once budget frees up.
    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ carriedForwardSourceIds: ["review-comment:2", "review-comment:3"] }),
    );
  });

  it("excludes the epoch's own prompted items from dedup when re-driving a carried-forward epoch (ARC-1226)", async () => {
    // A re-driven (previously truncated) epoch still owes a tail; its OWN earlier-prompted items must
    // be excluded from the dispatch worklist so the carried tail fits in the freed 64KB budget.
    // Otherwise the same head-of-list items re-consume the budget and the tail drops forever.
    const epoch = claimedEpoch({
      sourceKind: "bot",
      carriedForwardSourceIds: ["review-comment:tail"],
      promptedSourceRecords: [{ sourceId: "review-comment:shown", promptedAtMs: 700_000 }],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map([["review-comment:other-epoch", 600_000]]),
      legacySourceIds: new Set<string>(),
    });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    const worklistCall = mockGetPrReviewLoopWorklist.mock.calls.at(-1);
    expect(worklistCall).toBeDefined();
    const excludeRecords = worklistCall![4].excludePromptedSourceRecords as Map<string, number>;
    // Other epochs' prompted ids AND this epoch's own prompted ids are both excluded while draining.
    expect(excludeRecords.get("review-comment:other-epoch")).toBe(600_000);
    expect(excludeRecords.get("review-comment:shown")).toBe(700_000);
  });

  it("does not reuse the processEpoch session when the epoch head is stale vs the live PR head", async () => {
    // Genuinely stale: the session AND the live PR head have advanced to "new-head", but the claimed
    // epoch is still on "old-head". The live-PR-head check (not the local session head) is the
    // authoritative head-divergence gate (ARC-1339), so it blocks head_changed here.
    const epoch = claimedEpoch({ sourceKind: "bot", headSha: "old-head" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningHeadSha: "new-head" }));
    mockGetPrHeadSha.mockReset().mockResolvedValue("new-head");

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "head_changed" }),
    );
  });

  it("defers (never blocks) a re-keyed epoch when the session head lags the live PR head (ARC-1339)", async () => {
    // ARC-1339 race: the head-change reconcile re-keyed this epoch onto the new head, but the session's
    // reviewListeningHeadSha advance AND the prior-head verdict clear have not landed yet (a fallible
    // post-reconcile await threw, or a concurrent sweep claimed mid-window). The epoch head == the LIVE
    // PR head, so it must NOT be mis-blocked head_changed (a head_changed block would count toward
    // hasReviewLoopEpochForHead and strand the recovered tail). But the loaded session is stale (old
    // verdict), so it must also NOT dispatch yet — it defers for contention until the bookkeeping lands.
    const epoch = claimedEpoch({ sourceKind: "bot", headSha: "new-head" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningHeadSha: "old-head" }));
    mockGetPrHeadSha.mockReset().mockResolvedValue("new-head");

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "head_changed" }),
    );
    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "session_head_lagging" }),
    );
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("dispatches a re-keyed epoch once the session head has caught up to the live PR head (ARC-1339)", async () => {
    // After the head-change bookkeeping lands, session head == live head == epoch head. The epoch
    // dispatches with fresh state, and the loaded session is a valid status-comment override (its head
    // matches the epoch's head — never a diverged/lagging session).
    const epoch = claimedEpoch({ sourceKind: "bot", headSha: "new-head" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningHeadSha: "new-head" }));
    mockGetPrHeadSha.mockReset().mockResolvedValue("new-head");
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "head_changed" }),
    );
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not block a carry-forward drain re-drive past the general attempt cap (ARC-1226)", async () => {
    // A carry-forward drain is a bounded productive loop (bounded by the wave cap), so it must be
    // EXEMPT from the general attempt cap — otherwise the drain blocks at wave 6 with the EXHAUSTED
    // reason attempt_cap_reached and the rollup falsely settles review-loop:done with the tail unshown.
    const epoch = claimedEpoch({
      sourceKind: "bot",
      attemptCount: 8, // well past REVIEW_LOOP_ATTEMPT_CAP (5)
      carriedForwardSourceIds: ["review-comment:tail"],
      promptedSourceRecords: [{ sourceId: "review-comment:shown", promptedAtMs: 1 }],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-comment:tail",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r9",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "carried tail item",
          path: "src/app.ts",
          line: 9,
          updatedAtMs: 2,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "wh-drain",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // Drain dispatches instead of blocking on the general cap.
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
    expect(result.enqueued).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("still blocks a NON-drain epoch past the attempt cap (ARC-1226 exemption is drain-only)", async () => {
    // Guard: the carry-forward exemption must not weaken the general cap for ordinary (carried-empty)
    // epochs — a stuck non-drain epoch past the cap still blocks attempt_cap_reached.
    const epoch = claimedEpoch({ sourceKind: "bot", attemptCount: 8 });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "attempt_cap_reached" }),
    );
    // DMs the owner that the review-iteration cap was hit, keyed per epoch+head.
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "review_attempt_cap",
        dedupKey: "epoch-1:old-head",
        prUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
  });

  it("completed_noop clears carried-forward and completes instead of re-driving a stale tail (ARC-1226)", async () => {
    // The carried tail was resolved/deleted on GitHub, so the rebuilt worklist is empty. The noop
    // completion must clear the stale carried column and settle `completed`, not re-drive forever.
    const epoch = claimedEpoch({ sourceKind: "bot", carriedForwardSourceIds: ["review-comment:stale"] });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-empty",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochCompleted).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ clearCarryForward: true }),
    );
    expect(result.completedNoop).toBe(1);
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("drain no-progress cap: a 3rd consecutive never-prompted empty settle over the same triggering set stamps the unservable items informational", async () => {
    // The prod exhibit (PR #7656): the FSM epoch.settled drain re-armed a fresh synthetic epoch every
    // ~9s over the registered-but-unservable `human:<reviewId>` row — dispatch, empty worklist, noop
    // settle, re-arm, forever. The 3rd identical noop settle must stamp the item so the drain stops.
    const epoch = claimedEpoch({
      id: "epoch-drain-3",
      lastPromptId: null,
      triggeringSourceIds: ["human:900"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-empty",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    mockListRecentReviewLoopEpochDrainSummaries.mockResolvedValueOnce([
      { status: "completed", lastPromptId: null, triggeringSourceIds: ["human:900"] },
      { status: "completed", lastPromptId: null, triggeringSourceIds: ["human:900"] },
    ]);
    mockListUndispositionedActionable.mockResolvedValue(["human:900"]);
    // The canonical form carries a REAL disposition — this human: row is a pure alias orphan.
    mockListForPr.mockResolvedValue([
      { sourceId: "human:900", disposition: "none" },
      { sourceId: "review-body:900", disposition: "replied" },
    ]);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockListRecentReviewLoopEpochDrainSummaries).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ sessionId: "sess-1", excludeEpochId: "epoch-drain-3", limit: 2 }),
    );
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          sourceId: "human:900",
          basis: "drain_no_progress",
        },
      ],
      789_000,
    );
    // The epoch still settles normally after the stamp.
    expect(mockMarkReviewLoopEpochCompleted).toHaveBeenCalled();
    expect(result.completedNoop).toBe(1);
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("posts an outdated-thread note before silently stamping a PREVIOUSLY-PROMPTED comment thread_outdated (PR #7656)", async () => {
    // The founder-reported shape: the agent was prompted with the inline comment, fixed the code and
    // pushed; the successor sweep sees the thread isOutdated and would silently dispose it. The
    // backstop must post a terse in-thread note first, so the reviewer never sees unexplained silence.
    const epoch = claimedEpoch({ sourceKind: "bot", lastPromptId: "p-3" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map([["review-comment:3564601759", 1_000]]),
      bodyHashBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValue(["review-comment:3564601759"]);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-outdated",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      unpromptableItems: [{ sourceId: "review-comment:3564601759", reason: "thread_outdated" }],
      liveSourceIds: ["review-comment:3564601759"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      3564601759,
      expect.stringContaining("thread outdated as of `old-hea`"),
    );
    expect(mockMarkReviewLoopOperationSucceeded).toHaveBeenCalled();
    // The load-bearing informational stamp still lands after the note.
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          sourceId: "review-comment:3564601759",
          basis: "thread_outdated",
        },
      ],
      789_000,
    );
  });

  it("does NOT post an outdated-thread note for a never-prompted outdated thread; the stamp still lands", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot", lastPromptId: null });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      bodyHashBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValue(["review-comment:555"]);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-outdated-2",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      unpromptableItems: [{ sourceId: "review-comment:555", reason: "thread_outdated" }],
      liveSourceIds: ["review-comment:555"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [expect.objectContaining({ sourceId: "review-comment:555", basis: "thread_outdated" })],
      789_000,
    );
  });

  it("posts ONE note per outdated THREAD even when the thread stamps one entry per comment", async () => {
    // An outdated thread contributes an unpromptable entry per comment; a reply to any comment id
    // lands in the same GitHub thread, so per-comment notes would duplicate (ChatGPT P2 on #7827).
    const epoch = claimedEpoch({ sourceKind: "bot", lastPromptId: "p-3" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map([
        ["review-comment:600", 1_000],
        ["review-comment:601", 1_000],
      ]),
      bodyHashBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValue(["review-comment:600", "review-comment:601"]);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-thread-dup",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      unpromptableItems: [
        { sourceId: "review-comment:600", reason: "thread_outdated", threadRootSourceId: "review-comment:600" },
        { sourceId: "review-comment:601", reason: "thread_outdated", threadRootSourceId: "review-comment:600" },
      ],
      liveSourceIds: ["review-comment:600", "review-comment:601"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      600,
      expect.stringContaining("thread outdated"),
    );
    // Both comment rows still stamp.
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "review-comment:600", basis: "thread_outdated" }),
        expect.objectContaining({ sourceId: "review-comment:601", basis: "thread_outdated" }),
      ]),
      789_000,
    );
  });

  it("defers thread_outdated stamps (and posts no note) when the prompted-source lookup fails", async () => {
    // Greptile P1 on #7827: with the lookup down, wasPrompted cannot be trusted — stamping would
    // silently dispose a previously-prompted thread without its note. The stamp waits for a healthy wave.
    const epoch = claimedEpoch({ sourceKind: "bot", lastPromptId: "p-3" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockRejectedValueOnce(new Error("d1 read failed"));
    mockListUndispositionedActionable.mockResolvedValue(["review-comment:700"]);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-lookup-down",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      unpromptableItems: [
        { sourceId: "review-comment:700", reason: "thread_outdated", threadRootSourceId: "review-comment:700" },
      ],
      liveSourceIds: ["review-comment:700"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockStampInformationalDispositions).not.toHaveBeenCalled();
    expect(result.completedNoop).toBe(1);
  });

  it("still stamps thread_outdated when the backstop note POST fails (best-effort, never blocks the stamp)", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot", lastPromptId: "p-3" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map([["review-comment:777", 1_000]]),
      bodyHashBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValue(["review-comment:777"]);
    mockCreatePrReviewCommentReply.mockRejectedValueOnce(new Error("github 502"));
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-outdated-3",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      unpromptableItems: [{ sourceId: "review-comment:777", reason: "thread_outdated" }],
      liveSourceIds: ["review-comment:777"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopOperationFailed).toHaveBeenCalled();
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [expect.objectContaining({ sourceId: "review-comment:777", basis: "thread_outdated" })],
      789_000,
    );
    expect(result.completedNoop).toBe(1);
  });

  it("drain no-progress cap NEVER silently stamps a genuinely-unserviced submission (canonical form also none)", async () => {
    // If the review-body: canonical row is ALSO undispositioned, the reviewer's submission was never
    // actually handled — stamping it informational would re-create the silent-disposal class. Leave it
    // to the loud review_stuck deadline instead.
    const epoch = claimedEpoch({
      id: "epoch-drain-unserviced",
      lastPromptId: null,
      triggeringSourceIds: ["human:901"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-empty",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    mockListRecentReviewLoopEpochDrainSummaries.mockResolvedValueOnce([
      { status: "completed", lastPromptId: null, triggeringSourceIds: ["human:901"] },
      { status: "completed", lastPromptId: null, triggeringSourceIds: ["human:901"] },
    ]);
    mockListUndispositionedActionable.mockResolvedValue(["human:901"]);
    mockListForPr.mockResolvedValue([
      { sourceId: "human:901", disposition: "none" },
      { sourceId: "review-body:901", disposition: "none" },
    ]);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockStampInformationalDispositions).not.toHaveBeenCalled();
    expect(result.completedNoop).toBe(1);
  });

  it("outdated-thread backstop skips the note when a succeeded reply already targets the thread (cross-epoch dedup)", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot", lastPromptId: "p-3" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map([["review-comment:888", 1_000]]),
      bodyHashBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValue(["review-comment:888"]);
    mockHasSucceededReviewLoopReplyToTarget.mockResolvedValue(true);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-outdated-4",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      unpromptableItems: [{ sourceId: "review-comment:888", reason: "thread_outdated" }],
      liveSourceIds: ["review-comment:888"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    // The stamp still lands — the durable guard only suppresses the duplicate note.
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [expect.objectContaining({ sourceId: "review-comment:888", basis: "thread_outdated" })],
      789_000,
    );
  });

  it("drain no-progress cap does NOT fire before the cap or when the prior settles differ", async () => {
    // 1st/2nd drain wave: only one identical prior settle — below the cap, no stamp.
    const epoch = claimedEpoch({
      id: "epoch-drain-1",
      lastPromptId: null,
      triggeringSourceIds: ["human:900"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-empty",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });
    // A prompted prior epoch breaks the "consecutive never-prompted" chain even at the count.
    mockListRecentReviewLoopEpochDrainSummaries.mockResolvedValueOnce([
      { status: "completed", lastPromptId: null, triggeringSourceIds: ["human:900"] },
      { status: "completed", lastPromptId: "p-3", triggeringSourceIds: ["human:900"] },
    ]);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockStampInformationalDispositions).not.toHaveBeenCalled();
    expect(result.completedNoop).toBe(1);
  });

  it("noise gate (D4): records a no_action_needed_informational disposition, emits the DD event, and never prompts", async () => {
    // The prod exhibit: a Strix "no security issues found" issue comment. The worklist builder gated it
    // out (items empty, reported on noiseGatedItems). The sweep must disposition it + emit, then noop.
    const epoch = claimedEpoch({ sourceKind: "bot", expectedBots: [{ type: "known", id: "strix" }] });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-noise",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      noiseGatedItems: [{ sourceId: "issue-comment:4862622839", bot: "known:strix", reason: "no_findings" }],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    // Disposition recorded (insert-or-convert-from-'none') with the gate reason as basis.
    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          sourceId: "issue-comment:4862622839",
          basis: "no_findings",
        },
      ],
      789_000,
    );
    // DD event emitted with the clean bot id + reason tags.
    expect(mockEmitReviewLoopNoiseGatedEvent).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        bot: "strix",
        reason: "no_findings",
        sourceId: "issue-comment:4862622839",
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        repo: "acme/repo",
      }),
    );
    // Empty worklist ⇒ completed noop, and the noise item is NEVER put in front of the agent.
    expect(result.completedNoop).toBe(1);
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("noise gate (D4): emits review_loop.noise_near_miss for a phrase-matched-but-forwarded item (no disposition)", async () => {
    // A known bot's no-findings phrase we could NOT strip to empty: the item is FORWARDED (stays in the
    // worklist), so we only emit the near-miss sizing signal — never a disposition, never a gated event.
    const epoch = claimedEpoch({ sourceKind: "bot", expectedBots: [{ type: "known", id: "strix" }] });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-nearmiss",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      noiseGatedItems: [],
      noiseNearMissItems: [{ sourceId: "issue-comment:4866823063", bot: "known:strix", residualLength: 42 }],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockEmitReviewLoopNoiseNearMissEvent).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        bot: "strix",
        residualLength: 42,
        sourceId: "issue-comment:4866823063",
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        repo: "acme/repo",
      }),
    );
    // Near-miss is telemetry-only: no informational disposition and no gated event.
    expect(mockStampInformationalDispositions).not.toHaveBeenCalled();
    expect(mockEmitReviewLoopNoiseGatedEvent).not.toHaveBeenCalled();
  });

  it("noise gate (D4): defers the epoch for retry when informational stamping fails (never completes noop)", async () => {
    // A stamp failure must NOT complete the epoch: a producer-registered `none` row would wedge
    // caught_up forever. Defer for a bounded retry instead.
    const epoch = claimedEpoch({ sourceKind: "bot", expectedBots: [{ type: "known", id: "strix" }] });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-noise",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      noiseGatedItems: [{ sourceId: "issue-comment:1", bot: "known:strix", reason: "no_findings" }],
    });
    mockStampInformationalDispositions.mockRejectedValueOnce(new Error("d1 write failed"));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "noise_disposition_stamp_failed" }),
    );
    expect(result.transientDeferred).toBe(1);
    expect(result.completedNoop).toBe(0);
    expect(mockMarkReviewLoopEpochCompleted).not.toHaveBeenCalled();
    // No DD event when the stamp failed (we returned before emitting).
    expect(mockEmitReviewLoopNoiseGatedEvent).not.toHaveBeenCalled();
  });

  it("stamps registered resolved/outdated/deleted sources informational before completing a noop epoch", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValueOnce([
      "review-comment:1",
      "review-comment:2",
      "issue-comment:3",
      "review-body:4",
    ]);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-unpromptable",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      noiseGatedItems: [],
      noiseNearMissItems: [],
      unpromptableItems: [
        { sourceId: "review-comment:1", reason: "thread_resolved" },
        { sourceId: "review-comment:2", reason: "thread_outdated" },
      ],
      liveSourceIds: ["review-comment:1", "review-comment:2"],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockStampInformationalDispositions).toHaveBeenCalledWith(
      env.DB,
      [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          sourceId: "review-comment:1",
          basis: "thread_resolved",
        },
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          sourceId: "review-comment:2",
          basis: "thread_outdated",
        },
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          sourceId: "issue-comment:3",
          basis: "comment_deleted",
        },
      ],
      789_000,
    );
    expect(result.completedNoop).toBe(1);
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("defers the epoch when unpromptable informational stamping fails", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockListPromptedReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId: new Map(),
      legacySourceIds: new Set<string>(),
    });
    mockListUndispositionedActionable.mockResolvedValueOnce(["review-comment:1"]);
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "h-unpromptable",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
      noiseGatedItems: [],
      noiseNearMissItems: [],
      unpromptableItems: [{ sourceId: "review-comment:1", reason: "thread_resolved" }],
      liveSourceIds: ["review-comment:1"],
    });
    mockStampInformationalDispositions.mockRejectedValueOnce(new Error("d1 write failed"));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "noise_disposition_stamp_failed" }),
    );
    expect(result.transientDeferred).toBe(1);
    expect(result.completedNoop).toBe(0);
    expect(mockMarkReviewLoopEpochCompleted).not.toHaveBeenCalled();
  });

  it("defers contention without blocking or counting it as a real attempt", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: "Resume is being retried too quickly. Please wait a moment and try again.",
      payload: null,
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    const result = await runReviewLoopSweep(env, {
      nowMs: 789_000,
      logger: logger as never,
    });

    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith({}, "epoch-1", {
      nowMs: 789_000,
      reason: "prompt_contention",
      error: "Resume is being retried too quickly. Please wait a moment and try again.",
      expectedReservationToken: "reservation-1",
    });
    expect(result.contentionDeferred).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("defers session_not_sendable as a bounded transient retry instead of blocking", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "session_not_sendable",
      reason: "stopped",
      payload: null,
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "prompt_send_not_ready", error: "session_not_sendable" }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "prompt_enqueue_failed" }),
    );
    expect(result.transientDeferred).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("blocks session_not_sendable once the transient retry limit is exhausted", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "session_not_sendable",
      reason: "stopped",
      payload: null,
    });
    // DAO converts the deferral to a terminal block when transient_failure_count hits the limit.
    mockMarkReviewLoopEpochTransientFailure.mockResolvedValueOnce(claimedEpoch({ status: "blocked" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(result.blocked).toBe(1);
    expect(result.transientDeferred).toBe(0);
  });

  it("defers a dispatch that throws a transient D1 internal error without error-keyed warning", async () => {
    setupDueReviewEpochForPrompt();
    const error = new Error("D1_ERROR: internal error; reference = abc123");
    mockBuildGithubPrReviewLoopPrompt.mockImplementationOnce(() => {
      throw error;
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({
        reason: "transient_d1_error",
        error: String(error),
        expectedReservationToken: "reservation-1",
        transientFailureLimit: 5,
      }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed" }),
    );
    expect(result.transientDeferred).toBe(1);
    expect(result.blocked).toBe(0);

    const transientWarn = logger.warn.mock.calls.find(
      ([, message]) => message === "Review-loop epoch dispatch deferred on transient D1 error",
    );
    expect(transientWarn?.[0]).toMatchObject({ epochId: "epoch-1", transientError: String(error) });
    expect(transientWarn?.[0]).not.toHaveProperty("error");
  });

  it("blocks a repeated transient D1 dispatch failure once the retry limit is exhausted", async () => {
    setupDueReviewEpochForPrompt();
    const error = new Error("D1_ERROR: internal error; reference = abc123");
    mockBuildGithubPrReviewLoopPrompt.mockImplementationOnce(() => {
      throw error;
    });
    mockMarkReviewLoopEpochTransientFailure.mockResolvedValueOnce(claimedEpoch({ status: "blocked" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "transient_d1_error", transientFailureLimit: 5 }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed" }),
    );
    expect(result.blocked).toBe(1);
    expect(result.transientDeferred).toBe(0);
  });

  it("defers a dispatch that throws a bare Cloudflare DO internal-reference fault without error-keyed warning", async () => {
    setupDueReviewEpochForPrompt();
    // No `d1_error` prefix, so isTransientD1StorageError ignores it; it is a Durable Object / subrequest
    // platform blip that must defer-and-retry (bounded) rather than permanently block the epoch.
    const error = new Error("internal error; reference = 36kk4umk6cp46i8a6hsdu41g");
    mockBuildGithubPrReviewLoopPrompt.mockImplementationOnce(() => {
      throw error;
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({
        reason: "transient_do_internal_error",
        error: String(error),
        expectedReservationToken: "reservation-1",
        transientFailureLimit: 5,
      }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed" }),
    );
    expect(result.transientDeferred).toBe(1);
    expect(result.blocked).toBe(0);

    const transientWarn = logger.warn.mock.calls.find(
      ([, message]) => message === "Review-loop epoch dispatch deferred on transient Cloudflare DO fault",
    );
    expect(transientWarn?.[0]).toMatchObject({ epochId: "epoch-1", transientError: String(error) });
    expect(transientWarn?.[0]).not.toHaveProperty("error");
  });

  it("blocks a repeated Cloudflare DO internal-reference fault once the retry limit is exhausted", async () => {
    setupDueReviewEpochForPrompt();
    const error = new Error("internal error; reference = 36kk4umk6cp46i8a6hsdu41g");
    mockBuildGithubPrReviewLoopPrompt.mockImplementationOnce(() => {
      throw error;
    });
    mockMarkReviewLoopEpochTransientFailure.mockResolvedValueOnce(claimedEpoch({ status: "blocked" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "transient_do_internal_error", transientFailureLimit: 5 }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed" }),
    );
    expect(result.blocked).toBe(1);
    expect(result.transientDeferred).toBe(0);
  });

  it("still blocks a dispatch that throws an unknown error as sweep_failed", async () => {
    setupDueReviewEpochForPrompt();
    const error = new Error("boom");
    mockBuildGithubPrReviewLoopPrompt.mockImplementationOnce(() => {
      throw error;
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed", error: String(error) }),
    );
    expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "transient_d1_error" }),
    );
    expect(result.blocked).toBe(1);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: "epoch-1", error: String(error) }),
      "Review-loop epoch sweep failed",
    );
  });

  it("does not treat D1 load-shed as transient", async () => {
    setupDueReviewEpochForPrompt();
    const error = new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
    mockBuildGithubPrReviewLoopPrompt.mockImplementationOnce(() => {
      throw error;
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed", error: String(error) }),
    );
    expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: "epoch-1", error: String(error) }),
      "Review-loop epoch sweep failed",
    );
  });

  it("defers a post-enqueue transient D1 failure and re-drive defers on the orphaned active prompt", async () => {
    setupDueReviewEpochForPrompt();
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-orphan", status: "processing" } },
    });
    const error = new Error("D1_ERROR: internal error; reference = abc123");
    mockMarkReviewLoopEpochEnqueued.mockRejectedValueOnce(error);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const firstResult = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(firstResult.transientDeferred).toBe(1);
    expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "transient_d1_error", error: String(error) }),
    );
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed" }),
    );

    setupDueReviewEpochForPrompt();
    mockListSessionPrompts.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { queue: { processingPromptId: "prompt-orphan" } },
    });

    const secondResult = await runReviewLoopSweep(env, { nowMs: 790_000, logger: logger as never });

    expect(secondResult.contentionDeferred).toBe(1);
    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "active_prompt", error: "Active prompt prompt-orphan" }),
    );
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not transient-defer a CI pending cap after posting the escalation comment", async () => {
    setupDueReviewEpochForPrompt({
      sourceKind: "ci",
      expectedBots: [],
      expectedBotsHash: "ci-fixes",
      firstActivityAt: 0,
    });
    mockGetCommitCheckRuns.mockResolvedValueOnce([
      {
        id: 1,
        name: "build",
        status: "in_progress",
        conclusion: null,
        appSlug: "github-actions",
        appName: "GitHub Actions",
        detailsUrl: "https://github.com/acme/repo/runs/1",
      },
    ]);
    const error = new Error("D1_ERROR: internal error; reference = abc123");
    mockMarkReviewLoopEpochBlocked.mockRejectedValueOnce(error);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 1_900_001, logger: logger as never });

    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "ci_checks_pending_cap_reached" }),
    );
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed", error: String(error) }),
    );
    expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "transient_d1_error" }),
    );
    expect(result.blocked).toBe(1);
    expect(result.transientDeferred).toBe(0);
  });

  it("does not transient-defer a CI attempt cap after posting the escalation comment", async () => {
    setupDueReviewEpochForPrompt({
      sourceKind: "ci",
      expectedBots: [],
      expectedBotsHash: "ci-fixes",
    });
    mockGetCommitCheckRuns.mockResolvedValueOnce([
      {
        id: 1,
        name: "test",
        status: "completed",
        conclusion: "failure",
        appSlug: "github-actions",
        appName: "GitHub Actions",
        detailsUrl: "https://github.com/acme/repo/runs/1",
      },
    ]);
    mockCountConsecutiveCiFixEpochsForPr.mockResolvedValueOnce({
      sameFingerprintStreak: 3,
      totalConsecutiveStreak: 3,
    });
    const error = new Error("D1_ERROR: internal error; reference = abc123");
    mockMarkReviewLoopEpochBlocked.mockRejectedValueOnce(error);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "ci_attempt_cap_reached", worklistHash: "test" }),
    );
    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "sweep_failed", error: String(error) }),
    );
    expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "transient_d1_error" }),
    );
    expect(result.blocked).toBe(1);
    expect(result.transientDeferred).toBe(0);
  });

  it("still fails fast on a terminal enqueue reason", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "session_not_sendable",
      reason: "archived",
      payload: null,
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "prompt_enqueue_failed" }),
    );
    expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
  });

  it.each([
    ["verification", "verification_session"],
    ["review", "review_session"],
  ] as const)("blocks a claimed epoch bound to a %s session instead of dispatching", async (agentRole, reason) => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ agentRole }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(env.DB, "epoch-1", expect.objectContaining({ reason }));
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
  });

  describe("verification pause", () => {
    it("defers a claimed epoch while verification is in progress without consuming an attempt", async () => {
      const epoch = claimedEpoch();
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockGetSessionState
        .mockReset()
        .mockResolvedValue(reviewListeningSession({ verificationState: "verification-in-progress" }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(env.DB, "epoch-1", {
        nowMs: 789_000,
        reason: "verification_in_progress",
        error: undefined,
        expectedReservationToken: "reservation-1",
      });
      expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      // The pause must defer BEFORE eligibility gates and GitHub polls — a paused PR spends no
      // token or poll budget.
      expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
      expect(mockCreateInstallationToken).not.toHaveBeenCalled();
      expect(result.contentionDeferred).toBe(1);
      expect(result.blocked).toBe(0);
    });

    it("defers a claimed ci epoch while verification is in progress", async () => {
      const epoch = claimedEpoch({ sourceKind: "ci", expectedBots: [], expectedBotsHash: "ci-fixes" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockGetSessionState
        .mockReset()
        .mockResolvedValue(reviewListeningSession({ verificationState: "verification-in-progress" }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "verification_in_progress" }),
      );
      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(result.contentionDeferred).toBe(1);
    });

    it("dispatches normally once verification is done with a merge-ready verdict", async () => {
      const epoch = claimedEpoch();
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockGetSessionState
        .mockReset()
        .mockResolvedValue(
          reviewListeningSession({ verificationState: "verification-done", verificationResult: "merge-ready" }),
        );
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
      expect(result.enqueued).toBe(1);
    });

    it("dispatches reconcile-created epochs in the same tick", async () => {
      const epoch = claimedEpoch({ updatedAt: 124_000 });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([]).mockResolvedValueOnce([epoch]);
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            sweptAt: 0,
          },
        ],
        nextCursor: null,
      });
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch,
      });
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledTimes(1);
      expect(mockListDueReviewLoopEpochs).toHaveBeenCalledTimes(2);
      expect(mockClaimReviewLoopEpochForPrompt).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ nowMs: 789_000 }),
      );
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
      expect(result.attempted).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(mockClaimReviewLoopEpochForPrompt.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockBootstrapReviewLoopEpochFromHeadSignals.mock.invocationCallOrder[0],
      );
    });

    it("does not process anything when the post-reconcile due pass is empty", async () => {
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockListDueReviewLoopEpochs).toHaveBeenCalledTimes(2);
      expect(mockClaimReviewLoopEpochForPrompt).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(result.attempted).toBe(0);
      expect(result.enqueued).toBe(0);
    });

    it("skips head tracking, CI recovery, done rollup, and bootstrap on reconcile while verification is in progress", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            sweptAt: 0,
          },
        ],
        nextCursor: null,
      });
      mockGetSessionState.mockReset().mockResolvedValue(
        reviewListeningSession({
          verificationState: "verification-in-progress",
          // A diverged head would normally trigger head tracking — the pause must skip it.
          reviewListeningHeadSha: "stale-head",
        }),
      );
      mockGetPrHeadSha.mockResolvedValue("new-head");

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      // Merged/closed lifecycle still polls the PR; everything after is deferred.
      expect(mockGetPrState).toHaveBeenCalledTimes(1);
      expect(mockUpdateSessionReviewListeningHead).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
      expect(mockSetSessionReviewLoopDoneState).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(result.reviewListeningAttempted).toBe(1);
      expect(result.reviewListeningErrors).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1" }),
        "Review-loop reconciliation deferred: verification in progress",
      );
    });

    it("still closes a merged PR's session on reconcile while verification is in progress", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            sweptAt: 0,
          },
        ],
        nextCursor: null,
      });
      mockGetSessionState
        .mockReset()
        .mockResolvedValue(reviewListeningSession({ verificationState: "verification-in-progress" }));
      mockGetPrState.mockResolvedValueOnce("merged");

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockCloseSessionForWebhook).toHaveBeenCalledWith(
        env,
        {},
        "sess-1",
        expect.objectContaining({ reason: "pr_merged" }),
      );
      expect(result.reviewListeningClosed).toBe(1);
    });
  });

  describe("verification needs-work intake", () => {
    const REF = {
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      sweptAt: 0,
    };

    function needsWorkSession(overrides: Record<string, unknown> = {}) {
      return reviewListeningSession({
        verificationState: "verification-done",
        verificationResult: "needs-work",
        verificationNeedsWorkLabel: "verification-gap",
        verificationAttemptCount: 2,
        reviewLoopDoneState: "done",
        ...overrides,
      });
    }

    it("stands down (no legacy bootstrap — the FSM owns re-intake) and samples dual-run parity (W11-V10)", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF], nextCursor: null });
      mockGetSessionState.mockReset().mockResolvedValue(needsWorkSession());
      mockEmitVerificationIntakeStanddownParity.mockReset();

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep({ DB: {}, FSM_MODE: "live" } as never, {
        nowMs: 123_000,
        logger: logger as never,
      });

      // NO SECOND EPOCH: the legacy needs-work intake stands down — the FSM's inject_findings + W11-V5
      // dispatch_epoch own re-intake, so bootstrapping here would double-drive the customer PR.
      expect(mockBootstrapReviewLoopEpochForVerification).not.toHaveBeenCalled();
      expect(result.reviewListeningVerificationIntakes).toBe(0);
      // But the stand-down is OBSERVED — the dual-run parity sample fires with the verdict's PR + head.
      expect(mockEmitVerificationIntakeStanddownParity).toHaveBeenCalledWith(
        expect.objectContaining({ FSM_MODE: "live" }),
        { sessionId: "sess-1", prUrl: "https://github.com/acme/repo/pull/42", headSha: "old-head" },
      );
    });

    it("does NOT sample parity or stand down when there is no needs-work verdict at live", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF], nextCursor: null });
      mockGetSessionState.mockReset().mockResolvedValue(needsWorkSession({ verificationResult: "merge-ready" }));
      mockEmitVerificationIntakeStanddownParity.mockReset();

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep({ DB: {}, FSM_MODE: "live" } as never, { nowMs: 123_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochForVerification).not.toHaveBeenCalled();
      expect(mockEmitVerificationIntakeStanddownParity).not.toHaveBeenCalled();
    });

    it("dispatches a claimed verification epoch via the human gate with the verification prompt", async () => {
      const epoch = claimedEpoch({
        sourceKind: "verification",
        expectedBots: [],
        expectedBotsHash: "verification-intake",
        triggeringSourceIds: ["verification:old-head:2"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      // Verification epochs share the human gate (no bot checklist) — the bot checklist would
      // always fail their sentinel hash.
      expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalled();
      expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
      // Worklist fetched with the verification source kind so the QTA comment is admitted.
      expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith(
        "token-1",
        "acme",
        "repo",
        42,
        expect.objectContaining({ sourceKind: "verification" }),
      );
      expect(mockBuildGithubPrReviewLoopVerificationPrompt).toHaveBeenCalled();
      expect(mockBuildGithubPrReviewLoopHumanPrompt).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
        env,
        "sess-1",
        "review-loop verification prompt",
        "101",
        // Prompt metadata dispatches as a mixed review turn; the epoch row stays 'verification'.
        expect.objectContaining({ reviewLoopEpochId: "epoch-1", reviewLoopSourceKind: "mixed" }),
      );
      expect(result.enqueued).toBe(1);
    });

    it("dispatches a claimed merge-conflict epoch through the merge-conflict prompt", async () => {
      const epoch = claimedEpoch({
        sourceKind: "merge_conflict",
        expectedBots: [],
        expectedBotsHash: "merge-conflict",
        expectedBotKeys: [],
        triggeringSourceIds: ["merge-conflict:old-head"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockResolveReviewLoopMergeConflictEligibility.mockResolvedValueOnce({
        ok: true,
        ownerUserId: 101,
        installationId: 9001,
      });
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        baseRef: "develop",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
        labels: [],
      });
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockResolveReviewLoopMergeConflictEligibility).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          ownerUserId: 101,
          repoOwner: "acme",
          repoName: "repo",
        }),
      );
      expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
      expect(mockGetPrReviewLoopWorklist).not.toHaveBeenCalled();
      expect(mockBuildGithubPrMergeConflictPrompt).toHaveBeenCalledWith({
        epochId: "epoch-1",
        repoUrl: "https://github.com/acme/repo",
        prUrl: "https://github.com/acme/repo/pull/42",
        prNumber: 42,
        headSha: "old-head",
        baseRef: "develop",
      });
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
        env,
        "sess-1",
        "merge-conflict prompt",
        "101",
        expect.objectContaining({ reviewLoopEpochId: "epoch-1", reviewLoopSourceKind: "merge_conflict" }),
      );
      expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({
          worklistHash: "merge-conflict:old-head",
          promptedSourceIds: ["merge-conflict:old-head"],
        }),
      );
      expect(result.enqueued).toBe(1);
    });

    it("completes a merge-conflict epoch without prompting when the PR is no longer dirty", async () => {
      const epoch = claimedEpoch({
        sourceKind: "merge_conflict",
        expectedBots: [],
        expectedBotsHash: "merge-conflict",
        expectedBotKeys: [],
        triggeringSourceIds: ["merge-conflict:old-head"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockResolveReviewLoopMergeConflictEligibility.mockResolvedValueOnce({
        ok: true,
        ownerUserId: 101,
        installationId: 9001,
      });
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: true,
        mergeableState: "clean",
        rawMergeableState: "clean",
        labels: [],
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockBuildGithubPrMergeConflictPrompt).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(mockWarmSession).not.toHaveBeenCalled();
      expect(mockMarkReviewLoopEpochCompleted).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({
          worklistHash: "",
          expectedReservationToken: epoch.reservationToken,
          clearCarryForward: true,
        }),
      );
      // ARC-1330: a no-op completion MUST emit the spine `epoch.settled` terminal so the transition
      // clears `in_flight_epoch_id` — without it the marker stranded and wedged REVIEW.
      expect(mockShadowEmitReviewLoopEpochTerminal).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ status: "completed" }),
        "settled",
        expect.anything(),
      );
      expect(result.completedNoop).toBe(1);
    });

    it("never dedups a verification epoch's worklist (its item is synthesized from the stored verdict)", async () => {
      mockGetSessionState.mockReset().mockResolvedValue(needsWorkSession());
      const epoch = claimedEpoch({
        sourceKind: "verification",
        expectedBots: [],
        expectedBotsHash: "verification-intake",
        triggeringSourceIds: ["verification:old-head:2"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      // The prompted-dedup lookup is skipped entirely (NO excludeSourceIds); the synthetic verdict item
      // must never be deduped against a prior epoch or a genuinely new needs-work verdict would never reach
      // the agent.
      const worklistCall = mockGetPrReviewLoopWorklist.mock.calls.at(-1);
      expect(worklistCall?.[4].excludeSourceIds).toBeUndefined();
    });

    // ARC-1330 D-50A follow-up — REQUIRED TEST (1): a needs-work verdict at live sources the worklist from
    // the STORED verdict and dispatches (no `verification_comment_missing` wedge).
    it("sources the verification worklist from the stored needs-work verdict and dispatches", async () => {
      mockGetSessionState
        .mockReset()
        .mockResolvedValue(needsWorkSession({ verificationNeedsWorkLabel: "verification-gap" }));
      const epoch = claimedEpoch({
        sourceKind: "verification",
        expectedBots: [],
        expectedBotsHash: "verification-intake",
        triggeringSourceIds: ["verification:old-head:2"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      // getPrReviewLoopWorklist (real impl) synthesizes the item from the passed verdict; the sweep mock
      // returns a representative non-empty worklist so we exercise the dispatch decision.
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
        items: [
          {
            sourceId: "verification-verdict:old-head",
            sourceUrl: "",
            authorLogin: "cycloid-qa",
            authorType: "Bot",
            body: "## Cycloid QA\n\nneeds-work (verification-gap)",
            verificationResult: { needsWorkLabel: "verification-gap", blockers: [] },
            path: null,
            line: null,
            updatedAtMs: 0,
            isResolved: false,
            isOutdated: false,
          },
        ],
        duplicateGroups: [],
        worklistHash: "h-verdict",
      });
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      // A4 single-intake: no synthetic verdict item is threaded into getPrReviewLoopWorklist anymore — the
      // verdict rides the restored managed QA comment (admitted as known:cycloid-qa). The worklist call
      // carries no verificationResult/verificationHeadSha option.
      const worklistCall = mockGetPrReviewLoopWorklist.mock.calls.at(-1);
      expect(worklistCall?.[4].verificationResult).toBeUndefined();
      expect(worklistCall?.[4].verificationHeadSha).toBeUndefined();
      // Dispatch proceeds; nothing is blocked as verification_comment_missing / verification_result_missing.
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(1);
      expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
      expect(result.blocked).toBe(0);
    });

    // ARC-1330 D-50A follow-up — REQUIRED TEST (2): no stored verdict → loud block with the honest reason,
    // never a silent empty prompt.
    it("loud-blocks (result-missing) when a verification epoch has no stored verdict", async () => {
      mockGetSessionState.mockReset().mockResolvedValue(
        reviewListeningSession({
          verificationState: "verification-done",
          verificationResult: null,
          verificationNeedsWorkLabel: null,
        }),
      );
      const epoch = claimedEpoch({
        sourceKind: "verification",
        expectedBots: [],
        expectedBotsHash: "verification-intake",
        triggeringSourceIds: ["verification:old-head:2"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      // No stored verdict → getPrReviewLoopWorklist synthesizes nothing → empty worklist.
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({ items: [], duplicateGroups: [], worklistHash: "h-empty" });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(mockMarkReviewLoopEpochCompleted).not.toHaveBeenCalled();
      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({
          reason: "verification_result_missing",
          error: "Verification-intake epoch found no stored QA verdict to dispatch",
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          epochId: "epoch-1",
          triggeringSourceIds: ["verification:old-head:2"],
          worklistHash: "h-empty",
          verificationResult: null,
        }),
        "Verification review-loop epoch found no stored QA verdict to dispatch",
      );
      expect(result.blocked).toBe(1);
      expect(result.completedNoop).toBe(0);
    });
  });

  describe("pre-verdict review-loop dispatch", () => {
    function preVerdictSession(overrides: Record<string, unknown> = {}) {
      return reviewListeningSession({ verificationState: null, verificationResult: null, ...overrides });
    }

    it("dispatches a bot epoch before the PR's first verification verdict", async () => {
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockGetSessionState.mockReset().mockResolvedValue(preVerdictSession());
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
      expect(result.enqueued).toBe(1);
      expect(result.contentionDeferred).toBe(0);
      expect(result.blocked).toBe(0);
    });

    it("dispatches a human epoch during a needs-work cycle before rerunning QTA", async () => {
      const epoch = claimedEpoch({ sourceKind: "human", expectedBots: [], expectedBotsHash: "empty" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockGetSessionState.mockReset().mockResolvedValue(
        preVerdictSession({
          verificationState: "verification-done",
          verificationResult: "needs-work",
          verificationNeedsWorkLabel: "verification-gap",
        }),
      );
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
      expect(result.enqueued).toBe(1);
      expect(result.contentionDeferred).toBe(0);
    });

    it("does not gate a verification-intake epoch during the needs-work cycle", async () => {
      const epoch = claimedEpoch({
        sourceKind: "verification",
        expectedBots: [],
        expectedBotsHash: "verification-intake",
        triggeringSourceIds: ["verification:old-head:1"],
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockGetSessionState.mockReset().mockResolvedValue(
        preVerdictSession({
          verificationState: "verification-done",
          verificationResult: "needs-work",
          verificationNeedsWorkLabel: "verification-gap",
        }),
      );
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
      expect(result.enqueued).toBe(1);
    });

    it("dispatches comment epochs on terminal verification states and on a legacy result-less verdict", async () => {
      for (const sessionOverrides of [
        { verificationState: "verification-exhausted", verificationResult: null },
        { verificationState: "verification-stopped", verificationResult: null },
        { verificationState: "verification-skipped", verificationResult: null },
        { verificationState: "verification-done", verificationResult: null },
      ]) {
        vi.clearAllMocks();
        const epoch = claimedEpoch({ sourceKind: "bot" });
        mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
        mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
        mockGetSessionState.mockResolvedValue(reviewListeningSession(sessionOverrides));
        mockListSessionPrompts.mockResolvedValue({
          ok: true,
          payload: { queue: { processingPromptId: null } },
          status: 200,
        });
        mockGetPrHeadSha.mockResolvedValue("old-head");
        mockCreateInstallationToken.mockResolvedValue("token-1");
        mockResolveReviewLoopChecklist.mockResolvedValue({
          ok: true,
          expectedBots: [{ type: "known", id: "cursor-bugbot" }],
          expectedBotsHash: "settings-hash",
        });
        mockGetCommitCheckRuns.mockResolvedValue([]);
        mockGetCommitStatusContexts.mockResolvedValue([]);
        mockGetPrReviewLoopWorklist.mockResolvedValue({
          items: [
            {
              sourceId: "review-comment:1",
              sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
              authorLogin: "cursor[bot]",
              authorType: "Bot",
              body: "Fix this",
              path: "src/app.ts",
              line: 10,
              updatedAtMs: 1,
              isResolved: false,
              isOutdated: false,
            },
          ],
          duplicateGroups: [],
          worklistHash: "worklist-hash",
        });
        mockTriageReviewLoopWorklist.mockResolvedValue({ ok: false, reason: "llm_unavailable" });
        mockBuildGithubPrReviewLoopPrompt.mockReturnValue("review-loop prompt");
        mockMarkReviewLoopEpochEnqueued.mockResolvedValue(claimedEpoch({ status: "enqueued" }));
        mockListReviewListeningGithubPrRefs.mockResolvedValue({ data: [], nextCursor: null });
        mockListStuckReviewLoopEpochs.mockResolvedValue([]);
        mockEnqueueSessionPrompt.mockResolvedValueOnce({
          ok: true,
          status: 200,
          payload: { prompt: { promptId: "prompt-1", status: "queued" } },
        });

        const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
        const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

        expect(result.enqueued).toBe(1);
        expect(result.contentionDeferred).toBe(0);
      }
    });

    it("does not gate when verification is not in play (manual policy / per-session opt-out)", async () => {
      for (const setup of [
        { env: { DB: {}, VERIFICATION_POLICY: "manual" } as never, session: preVerdictSession() },
        { env, session: preVerdictSession({ autoVerifyDisabled: true }) },
      ]) {
        vi.clearAllMocks();
        const epoch = claimedEpoch({ sourceKind: "bot" });
        mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
        mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
        mockGetSessionState.mockResolvedValue(setup.session);
        mockListSessionPrompts.mockResolvedValue({
          ok: true,
          payload: { queue: { processingPromptId: null } },
          status: 200,
        });
        mockGetPrHeadSha.mockResolvedValue("old-head");
        mockCreateInstallationToken.mockResolvedValue("token-1");
        mockResolveReviewLoopChecklist.mockResolvedValue({
          ok: true,
          expectedBots: [{ type: "known", id: "cursor-bugbot" }],
          expectedBotsHash: "settings-hash",
        });
        mockGetCommitCheckRuns.mockResolvedValue([]);
        mockGetCommitStatusContexts.mockResolvedValue([]);
        mockGetPrReviewLoopWorklist.mockResolvedValue({
          items: [
            {
              sourceId: "review-comment:1",
              sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
              authorLogin: "cursor[bot]",
              authorType: "Bot",
              body: "Fix this",
              path: "src/app.ts",
              line: 10,
              updatedAtMs: 1,
              isResolved: false,
              isOutdated: false,
            },
          ],
          duplicateGroups: [],
          worklistHash: "worklist-hash",
        });
        mockTriageReviewLoopWorklist.mockResolvedValue({ ok: false, reason: "llm_unavailable" });
        mockBuildGithubPrReviewLoopPrompt.mockReturnValue("review-loop prompt");
        mockMarkReviewLoopEpochEnqueued.mockResolvedValue(claimedEpoch({ status: "enqueued" }));
        mockListReviewListeningGithubPrRefs.mockResolvedValue({ data: [], nextCursor: null });
        mockListStuckReviewLoopEpochs.mockResolvedValue([]);
        mockEnqueueSessionPrompt.mockResolvedValueOnce({
          ok: true,
          status: 200,
          payload: { prompt: { promptId: "prompt-1", status: "queued" } },
        });

        const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
        const result = await runReviewLoopSweep(setup.env, { nowMs: 789_000, logger: logger as never });

        expect(result.enqueued).toBe(1);
        expect(result.contentionDeferred).toBe(0);
      }
    });
  });

  describe("LLM triage dispatch", () => {
    it("dispatches the triaged prompt when triage succeeds on a review epoch", async () => {
      const epoch = claimedEpoch();
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockTriageReviewLoopWorklist.mockResolvedValueOnce({
        ok: true,
        actionItems: [{ instruction: "Fix the null check.", sourceIds: ["review-comment:1"] }],
        droppedItems: [],
        conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:2"], summary: "guard vs revert" }],
        discardedActionItemCount: 0,
      });
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockTriageReviewLoopWorklist).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          sessionId: "sess-1",
          epochId: "epoch-1",
          candidates: [
            expect.objectContaining({ sourceId: "review-comment:1", kind: "comment", location: "src/app.ts:10" }),
          ],
        }),
      );
      // PR3: the sweep forwards triage's detected conflicts into the triaged builder so the prompt can
      // render them and instruct the agent.
      expect(mockBuildGithubPrReviewLoopTriagedPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          epochId: "epoch-1",
          actionItems: [{ instruction: "Fix the null check.", sourceIds: ["review-comment:1"] }],
          conflicts: [{ sourceIds: ["review-comment:1", "issue-comment:2"], summary: "guard vs revert" }],
        }),
      );
      expect(mockBuildGithubPrReviewLoopPrompt).not.toHaveBeenCalled();
      expect(mockBuildGithubPrReviewLoopHumanPrompt).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
        env,
        "sess-1",
        "review-loop triaged prompt",
        "101",
        expect.anything(),
      );
      expect(result.enqueued).toBe(1);
    });

    it("falls back to the deterministic builder when triage fails", async () => {
      const epoch = claimedEpoch({ sourceKind: "bot" });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockTriageReviewLoopWorklist.mockResolvedValueOnce({ ok: false, reason: "llm_failed" });
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockBuildGithubPrReviewLoopTriagedPrompt).not.toHaveBeenCalled();
      expect(mockBuildGithubPrReviewLoopPrompt).toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
        env,
        "sess-1",
        "review-loop prompt",
        "101",
        expect.anything(),
      );
      expect(result.enqueued).toBe(1);
    });
  });

  it("defers a claimed human epoch while review-listening enter is still pending", async () => {
    const epoch = claimedEpoch({
      sourceKind: "human",
      expectedBots: [],
      expectedBotKeys: [],
      expectedBotsHash: "empty",
      triggeringSourceIds: ["human:1001"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningActive: false }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(env.DB, "epoch-1", {
      nowMs: 789_000,
      reason: "review_listening_enter_pending",
      error: undefined,
      expectedReservationToken: "reservation-1",
    });
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.contentionDeferred).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("defers a claimed mention epoch (not blocks) while review-listening enter is still pending", async () => {
    // ARC-1514: the mention webhook bootstraps the `ready` epoch before it arms review-listening, so a
    // sweep in that gap must DEFER (retry) like a human re-engage, not terminally block the mention.
    const epoch = claimedEpoch({
      sourceKind: "mention",
      expectedBots: [],
      expectedBotKeys: [],
      expectedBotsHash: "mention-epoch",
      triggeringSourceIds: ["issue-comment:77"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningActive: false }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochContentionDeferred).toHaveBeenCalledWith(env.DB, "epoch-1", {
      nowMs: 789_000,
      reason: "review_listening_enter_pending",
      error: undefined,
      expectedReservationToken: "reservation-1",
    });
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(result.contentionDeferred).toBe(1);
    expect(result.blocked).toBe(0);
  });

  it("blocks a claimed human epoch when review-listening enter stays pending past the timeout", async () => {
    const epoch = claimedEpoch({
      sourceKind: "human",
      expectedBots: [],
      expectedBotKeys: [],
      expectedBotsHash: "empty",
      triggeringSourceIds: ["human:1001"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningActive: false }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 31 * 60 * 1000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({
        reason: "review_listening_enter_timeout",
        error: "Review-listening enter still pending after 1860000ms",
        expectedReservationToken: "reservation-1",
      }),
    );
    expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
    expect(result.contentionDeferred).toBe(0);
  });

  it("still blocks a non-human claimed epoch when review-listening is inactive", async () => {
    const epoch = claimedEpoch({ sourceKind: "bot" });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ reviewListeningActive: false }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "session_not_review_listening" }),
    );
    expect(mockMarkReviewLoopEpochContentionDeferred).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
  });

  it("fails fast on a reason-less session_not_sendable 409 (does not infer transient from the error umbrella)", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    // session_not_sendable is the umbrella error for every blocked send; without a recoverable
    // `reason`, the sweep must treat it as terminal rather than burn the transient-retry budget.
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "session_not_sendable",
      reason: null,
      payload: null,
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
      env.DB,
      "epoch-1",
      expect.objectContaining({ reason: "prompt_enqueue_failed" }),
    );
    expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
  });

  it("backfills terminal commit status and check run signals before prompting", async () => {
    const epoch = claimedEpoch({
      expectedBots: [
        { type: "known", id: "coderabbit" },
        { type: "known", id: "strix" },
      ],
      expectedBotKeys: ["known:coderabbit", "known:strix"],
    });
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockGetCommitStatusContexts.mockResolvedValueOnce([
      {
        id: 101,
        context: "CodeRabbit",
        state: "success",
        description: "Review completed",
        targetUrl: "https://coderabbit.ai/review/101",
        creatorLogin: "coderabbitai[bot]",
        creatorType: "Bot",
      },
    ]);
    mockGetCommitCheckRuns.mockResolvedValueOnce([
      {
        id: 202,
        name: "Strix Security Review",
        status: "completed",
        conclusion: "success",
        appSlug: "strix-security",
        appName: "Strix Security",
        detailsUrl: "https://app.strix.ai/pr-reviews/202",
      },
    ]);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    await runReviewLoopSweep(env, {
      nowMs: 789_000,
      logger: logger as never,
    });

    expect(mockGetCommitStatusContexts).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
    expect(mockGetCommitCheckRuns).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
    expect(mockUpsertReviewLoopEpochActivity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: "sess-1",
        sourceId: "commit-status:101:42",
        botKey: "known:coderabbit",
        botActorLogin: "coderabbitai[bot]",
        terminal: true,
        evidence: expect.objectContaining({ type: "commit_status", statusId: 101, state: "success" }),
      }),
    );
    expect(mockUpsertReviewLoopEpochActivity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: "sess-1",
        sourceId: "check-run:202:42",
        botKey: "known:strix",
        botActorLogin: "strix-security[bot]",
        terminal: true,
        evidence: expect.objectContaining({ type: "check_run", checkRunId: 202, status: "completed" }),
      }),
    );
    expect(Math.max(...mockUpsertReviewLoopEpochActivity.mock.invocationCallOrder)).toBeLessThan(
      mockGetPrReviewLoopWorklist.mock.invocationCallOrder[0],
    );
  });

  it("drives the epoch to processing when an idle session dispatches the prompt immediately", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    // An idle review-listening session promotes the enqueued prompt straight to "processing"
    // inside the enqueue RPC, before the sweep marks the epoch "enqueued". The DO's own
    // processing transition no-ops against the still-"reserving" epoch, so the sweep must
    // drive it forward or review_loop_reply stays blocked ("epoch is not active ... (enqueued)").
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "processing" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalledWith(
      {},
      "epoch-1",
      // The worklist's source ids are recorded as prompted so they are not re-surfaced as new work.
      expect.objectContaining({ promptId: "prompt-1", promptedSourceIds: ["review-comment:1"] }),
    );
    expect(mockMarkReviewLoopEpochProcessing).toHaveBeenCalledWith(
      {},
      "epoch-1",
      expect.objectContaining({ promptId: "prompt-1", nowMs: 789_000 }),
    );
  });

  it("warns when the epoch is still stuck in enqueued after the processing transition", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "processing" } },
    });
    // Transition matched 0 rows and the epoch genuinely did not advance.
    mockMarkReviewLoopEpochProcessing.mockResolvedValueOnce(null);
    mockGetReviewLoopEpochById.mockResolvedValueOnce(claimedEpoch({ status: "enqueued" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: "epoch-1", promptId: "prompt-1" }),
      "Review-loop epoch stuck in enqueued after processing transition",
    );
  });

  it("does not warn when the processing transition no-ops because the DO already advanced the epoch", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "processing" } },
    });
    // 0-row update, but the epoch already advanced to processing (benign DO race).
    mockMarkReviewLoopEpochProcessing.mockResolvedValueOnce(null);
    mockGetReviewLoopEpochById.mockResolvedValueOnce(claimedEpoch({ status: "processing" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Review-loop epoch stuck in enqueued after processing transition",
    );
  });

  it("does not drive processing when the enqueued prompt is still queued behind active work", async () => {
    const epoch = claimedEpoch();
    mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
    mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { prompt: { promptId: "prompt-1", status: "queued" } },
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

    expect(mockMarkReviewLoopEpochEnqueued).toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochProcessing).not.toHaveBeenCalled();
  });

  it("reconciles review-listening sessions whose PR merged without a webhook", async () => {
    mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
      data: [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          updatedAt: "2026-05-26T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    mockGetPrState.mockResolvedValueOnce("merged");

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    const result = await runReviewLoopSweep(env, {
      nowMs: 123_000,
      logger: logger as never,
    });

    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 9001);
    expect(mockGetPrState).toHaveBeenCalledWith("token-1", "acme", "repo", 42);
    expect(mockNotifySessionPrMerged).toHaveBeenCalledWith(env, "sess-1", "https://github.com/acme/repo/pull/42");
    expect(mockCloseSessionForWebhook).toHaveBeenCalledWith(env, {}, "sess-1", {
      reason: "pr_merged",
      metadata: {
        closeSource: "review_loop_reconciliation",
        prState: "merged",
        prUrl: "https://github.com/acme/repo/pull/42",
        prNumber: 42,
      },
    });
    expect(result.reviewListeningClosed).toBe(1);
  });

  it("paginates review-listening reconciliation without exceeding the per-sweep limit", async () => {
    mockListReviewListeningGithubPrRefs
      .mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-2",
            prUrl: "https://github.com/acme/repo/pull/43",
            updatedAt: "2026-05-26T12:01:00.000Z",
          },
        ],
        nextCursor: "cursor-3",
      })
      .mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-3",
            prUrl: "https://github.com/acme/repo/pull/44",
            updatedAt: "2026-05-26T12:02:00.000Z",
          },
        ],
        nextCursor: null,
      });
    mockGetSessionState.mockImplementation(async (_env, sessionId: string) =>
      reviewListeningSession({
        sessionId,
        reviewListeningPrUrl: `https://github.com/acme/repo/pull/${
          sessionId === "sess-1" ? "42" : sessionId === "sess-2" ? "43" : "44"
        }`,
      }),
    );

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    const result = await runReviewLoopSweep(env, {
      nowMs: 456_000,
      reconciliationLimit: 2,
      logger: logger as never,
    });

    expect(mockListReviewListeningGithubPrRefs).toHaveBeenCalledTimes(2);
    expect(mockListReviewListeningGithubPrRefs).toHaveBeenNthCalledWith(
      1,
      {},
      { limit: 2, cursor: null, sweptBefore: 456_000 },
    );
    expect(mockListReviewListeningGithubPrRefs).toHaveBeenNthCalledWith(
      2,
      {},
      { limit: 1, cursor: "cursor-2", sweptBefore: 456_000 },
    );
    expect(mockGetPrState).toHaveBeenCalledTimes(2);
    expect(result.reviewListeningAttempted).toBe(2);
    expect(result.reviewListeningErrors).toBe(0);
  });

  describe("review-listening rotation watermark + ref self-heal", () => {
    const REF_42 = {
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      sweptAt: 0,
    };

    it("bumps the swept-at watermark for every fetched ref, including ones that skip", async () => {
      const refGone = { sessionId: "sess-gone", prUrl: "https://github.com/acme/repo/pull/43", sweptAt: 0 };
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [REF_42, refGone],
        nextCursor: null,
      });
      mockGetSessionState.mockImplementation(async (_env, sessionId: string) =>
        sessionId === "sess-gone" ? null : reviewListeningSession(),
      );

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockMarkReviewListeningGithubPrRefsSwept).toHaveBeenCalledTimes(1);
      expect(mockMarkReviewListeningGithubPrRefsSwept).toHaveBeenCalledWith(env.DB, [REF_42, refGone], 123_000);
    });

    it("self-heals the ref when the session is gone (DO 404)", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF_42], nextCursor: null });
      mockGetSessionState.mockResolvedValueOnce(null);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockDeleteSessionWebhookRef).toHaveBeenCalledWith(env.DB, "github_pr_url", REF_42.prUrl, "sess-1");
      expect(mockCreateInstallationToken).not.toHaveBeenCalled();
      expect(result.reviewListeningRefsHealed).toBe(1);
    });

    it("self-heals the ref when the session is archived", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF_42], nextCursor: null });
      mockGetSessionState.mockResolvedValueOnce(reviewListeningSession({ status: "archived" }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockDeleteSessionWebhookRef).toHaveBeenCalledWith(env.DB, "github_pr_url", REF_42.prUrl, "sess-1");
      expect(result.reviewListeningRefsHealed).toBe(1);
    });

    it("self-heals the ref when review listening is no longer active", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF_42], nextCursor: null });
      mockGetSessionState.mockResolvedValueOnce(reviewListeningSession({ reviewListeningActive: false }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockDeleteSessionWebhookRef).toHaveBeenCalledWith(env.DB, "github_pr_url", REF_42.prUrl, "sess-1");
      expect(result.reviewListeningRefsHealed).toBe(1);
    });

    it("self-heals a stale ref whose PR differs from the session's current listening PR", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF_42], nextCursor: null });
      mockGetSessionState.mockResolvedValueOnce(
        reviewListeningSession({ reviewListeningPrUrl: "https://github.com/acme/repo/pull/99" }),
      );

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockDeleteSessionWebhookRef).toHaveBeenCalledWith(env.DB, "github_pr_url", REF_42.prUrl, "sess-1");
      expect(mockGetPrMergeStatus).not.toHaveBeenCalled();
      expect(result.reviewListeningRefsHealed).toBe(1);
    });

    it("does not self-heal a healthy listening ref", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({ data: [REF_42], nextCursor: null });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      expect(mockDeleteSessionWebhookRef).not.toHaveBeenCalled();
      expect(result.reviewListeningRefsHealed).toBe(0);
    });

    it("survives a throwing ref delete and keeps sweeping", async () => {
      const refGone = { sessionId: "sess-gone", prUrl: "https://github.com/acme/repo/pull/43", sweptAt: 0 };
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [refGone, REF_42],
        nextCursor: null,
      });
      mockGetSessionState.mockImplementation(async (_env, sessionId: string) =>
        sessionId === "sess-gone" ? null : reviewListeningSession(),
      );
      mockDeleteSessionWebhookRef.mockRejectedValueOnce(new Error("D1 unavailable"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

      // The healthy ref after the failed heal is still reconciled this tick.
      expect(mockGetPrMergeStatus).toHaveBeenCalledTimes(1);
      expect(result.reviewListeningRefsHealed).toBe(0);
    });
  });

  it("reconciles review-listening head changes and blocks stale epochs", async () => {
    mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
      data: [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          updatedAt: "2026-05-26T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    mockGetPrState.mockResolvedValueOnce("open");
    mockGetPrHeadSha.mockResolvedValueOnce("new-head");
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(2);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    const result = await runReviewLoopSweep(env, {
      nowMs: 456_000,
      logger: logger as never,
    });

    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledWith(
      {},
      {
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        previousHeadSha: "old-head",
        currentHeadSha: "new-head",
        nowMs: 456_000,
      },
    );
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledWith(env, "sess-1", {
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "new-head",
    });
    expect(result.reviewListeningHeadChanged).toBe(1);
    expect(result.reviewListeningStaleEpochsBlocked).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ARC-1330 (W11) — the sweep-observed head advance reaches the spine BEFORE the label reprojection.
  // The sweep observes a head advance but (unlike the synchronize webhook) had no head producer, so the
  // spine row still carried the OLD head at the label-teardown site; reprojecting labels off it would strip
  // from a STALE record (the D-59b deferral, PR #6523 blocker 4). The fix classifies + emits head.changed /
  // head.noop_changed FIRST (awaited → CAS committed), then the canonical reconcile reads the FRESH row.
  // ─────────────────────────────────────────────────────────────────────────
  describe("W11 — sweep head-change reaches the spine before label reprojection", () => {
    const HEAD_CHANGE_PR = "https://github.com/acme/repo/pull/42";

    function seedHeadChangeRef() {
      // One listening ref whose recorded head ("old-head", the session default) trails the live PR head.
      mockListReviewListeningGithubPrRefs.mockResolvedValue({
        data: [{ sessionId: "sess-1", prUrl: HEAD_CHANGE_PR, ownerUserId: 101, updatedAt: "2026-07-01T00:00:00.000Z" }],
        nextCursor: null,
      });
      mockGetPrHeadSha.mockResolvedValue("new-head");
    }

    it("live: emits head.changed onto the spine, THEN reprojects labels off the committed row (stale-head reproject impossible)", async () => {
      seedHeadChangeRef();
      // Default session carries a settled verdict; a real content change (isNoOp=false default) → head.changed.
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep({ DB: {}, FSM_MODE: "live" } as never, { nowMs: 456_000, logger: logger as never });

      // 1. The spine head advance is classified real and dual-emitted for this session.
      const emitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
      expect(emitCall?.[2]).toEqual({ kind: "head.changed", headSha: "new-head", prevHeadSha: "old-head" });

      // 2. The canonical reconcile fires (live) for this ref — it reads the row the emit just committed.
      expect(mockSyncFsmLabelsForPr).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prUrl: HEAD_CHANGE_PR, sessionId: "sess-1" }),
      );

      // 3. ORDERING — the emit (spine head advance) is invoked BEFORE the reproject, so a stale-head
      //    reproject is structurally impossible. `shadowEmitHeadChange` awaits the CAS commit in source.
      expect(mockShadowEmitHeadChange.mock.invocationCallOrder[0]).toBeLessThan(
        mockSyncFsmLabelsForPr.mock.invocationCallOrder[0],
      );

      // 4. The blunt legacy strip stands down at live — no review-loop:* removeLabel teardown for this PR.
      const teardownRemovals = mockRemoveLabel.mock.calls.filter(
        (c) => c[3] === 42 && String(c[4]).startsWith("review-loop:"),
      );
      expect(teardownRemovals).toEqual([]);
    });

    it("live: a NON-COMMITTING spine emit no longer blunt-strips (PR-E1: review-loop labels scrapped, sweep self-heals)", async () => {
      seedHeadChangeRef();
      // The producer swallowed a fault / applyEvent did not commit: the spine row still carries the OLD
      // head and this branch will not reproject off the stale row. PR-E1 deleted the blunt legacy strip
      // (`clearReviewLoopLabels`) that used to run here — REVIEW now projects no managed label, so a stale
      // row can no longer strand a done/verification label; the next sweep's `syncFsmLabelsForPr` reconcile
      // tears down any legacy leftover from `FSM_MANAGED_LABELS`.
      mockShadowEmitHeadChange.mockReset().mockResolvedValue(false);
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep({ DB: {}, FSM_MODE: "live" } as never, { nowMs: 456_000, logger: logger as never });

      expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prUrl: HEAD_CHANGE_PR, sessionId: "sess-1" }),
      );
      const strips = mockRemoveLabel.mock.calls.filter((c) => c[3] === 42 && String(c[4]).startsWith("review-loop:"));
      expect(strips.length).toBe(0);
    });

    it("live: a lost head-update race (updated:false — webhook won) emits NOTHING and skips the reproject", async () => {
      seedHeadChangeRef();
      // The synchronize webhook advanced the stored head first: the sweep's update is rejected as
      // unchanged. Without the gate, the sweep would double-emit head.changed for the already-advanced
      // head, re-clearing a verdict recorded in between (adversarial-review finding on #6525).
      mockUpdateSessionReviewListeningHead.mockReset().mockResolvedValue({
        ok: true,
        payload: { updated: false },
        status: 200,
      });
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep({ DB: {}, FSM_MODE: "live" } as never, { nowMs: 456_000, logger: logger as never });

      const emitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
      expect(emitCall).toBeUndefined();
      expect(mockSyncFsmLabelsForPr).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prUrl: HEAD_CHANGE_PR, sessionId: "sess-1" }),
      );
    });

    it("live: a content-noop head advance emits head.noop_changed, preserving the verdict (and its label)", async () => {
      seedHeadChangeRef();
      // Same tree SHA (rebase/reword/no-op force-push) with a settled verdict present → head.noop_changed.
      mockIsNoOpHeadTreeChange.mockReset().mockResolvedValue(true);
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep({ DB: {}, FSM_MODE: "live" } as never, { nowMs: 456_000, logger: logger as never });

      const emitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
      expect(emitCall?.[2]).toEqual({ kind: "head.noop_changed", headSha: "new-head", prevHeadSha: "old-head" });

      // ARC-1330 D-59 residue fold: the standalone verdict writers are DELETED from the sweep. The restamp
      // that PRESERVES the verdict onto the new head now happens inside the head producer
      // (`syncLegacyVerificationStoreForHeadChange`, run by the mocked-out shadowEmitHeadChange) via the
      // head.noop_changed classification asserted above — so neither standalone writer is called here.
      expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
      expect(mockStampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
      // The reproject still runs off the restamped row (label preservation is a labelsOf concern).
      expect(mockSyncFsmLabelsForPr).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prUrl: HEAD_CHANGE_PR, sessionId: "sess-1" }),
      );
    });
  });

  it("threads a truncated-tail re-key on a foreign head change into reviewListeningTruncatedTailRekeyed (ARC-1244)", async () => {
    // On the stale-block (foreign-push) path the shared helper re-keys the budget-truncated subset
    // onto the new head as a re-driveable `ready` epoch instead of burying it; the sweep surfaces the
    // count so a non-zero rate is observable. (Real DAO behavior is covered by the mergeability DAO
    // suite; here we only assert the sweep accounting wiring through the real helper.)
    mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
      data: [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          updatedAt: "2026-05-26T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    mockGetPrState.mockResolvedValueOnce("open");
    mockGetPrHeadSha.mockResolvedValueOnce("new-head");
    // Foreign push (no spine queued marker → stale-block path), but one epoch owed a truncated tail.
    // getPrCoordination defaults to null in beforeEach.
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(1);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

    const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockCarryForwardTruncatedTailEpochsToNewHead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head", nowMs: 456_000 }),
    );
    expect(result.reviewListeningTruncatedTailRekeyed).toBe(1);
    expect(result.reviewListeningHeadChanged).toBe(1);
    expect(result.reviewListeningStaleEpochsBlocked).toBe(1);
  });

  it("bootstrap gate excludes already-prompted items so a budget-stranded tail re-surfaces on a new head (ARC-1226)", async () => {
    // After a head change strands a truncated epoch's carried tail, the new-head bootstrap gate must
    // NOT re-truncate the tail away. Excluding already-prompted items frees the 64KB budget so the
    // un-prompted tail surfaces as new actionable feedback — this asserts the gate-level fix: the tail
    // is seen (hasNewActionableFeedback) and re-engagement is triggered, so the no-show branch is NOT
    // taken and the rollup cannot falsely settle review-loop:done over the unshown tail. (End-to-end
    // drain then follows the standard bot-re-review path that creates the new-head epoch.)
    mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
      data: [{ sessionId: "sess-1", prUrl: "https://github.com/acme/repo/pull/42", sweptAt: 0 }],
      nextCursor: null,
    });
    mockHasReviewLoopEpochForHead.mockResolvedValue(false);
    const promptedAtBySourceId = new Map([["review-comment:shown", 700_000]]);
    const legacySourceIds = new Set<string>(["issue-comment:legacy"]);
    mockListKnownReviewLoopSources.mockResolvedValueOnce({
      promptedAtBySourceId,
      legacySourceIds,
      triggeringSourceIds: new Set<string>(),
    });
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-comment:tail",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r9",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "stranded tail item",
          path: "src/app.ts",
          line: 9,
          updatedAtMs: 9,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "wh-bootstrap",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
      droppedSourceIds: [],
    });

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 123_000, logger: logger as never });

    // The gate's worklist fetch excludes already-prompted records (the dispatch-dedup semantics), so a
    // beyond-budget stranded tail is not re-dropped here.
    expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      42,
      expect.objectContaining({
        excludePromptedSourceRecords: promptedAtBySourceId,
        excludeSourceIds: legacySourceIds,
      }),
    );
    // The surfaced un-prompted tail counts as new actionable feedback → re-engagement is attempted
    // (NOT the no-show branch), so the rollup cannot falsely settle review-loop:done over the tail.
    expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalled();
  });

  describe("merge-conflict (dirty) handling on reconcile", () => {
    function singleRef() {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    it("on dirty with pending work: comments once, blocks epochs rebase_needed, skips bootstrap", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // No epoch is blocked rebase_needed for this head yet → the notice has not been sent (default
      // mockGetReviewLoopEpochSummariesForHead returns []).
      mockBlockPendingReviewLoopEpochsForHead.mockResolvedValueOnce(2);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 700_000, logger: logger as never });

      expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
      // Pending check is scoped to the current head so it matches what the per-head block blocks.
      expect(mockHasPendingReviewLoopWork).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ sessionId: "sess-1", headSha: "old-head" }),
      );
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
          reason: "rebase_needed",
        }),
      );
      expect(result.reviewListeningRebaseBlocked).toBe(2);
      // The dirty path must NEVER stamp the spine queued marker, or a future merge-conflict notice
      // would wrongly carry stale review work onto the user's rebase commit (ARC-1302). The
      // behind-success path is the only stamper.
      expect(mockMarkPrCoordinationUpdateBranchQueued).not.toHaveBeenCalled();
      // Skips the bootstrap path entirely.
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("on dirty with merge-conflict resolution enabled: bootstraps a merge-conflict epoch instead of blocking", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockResolveReviewLoopMergeConflictEligibility.mockResolvedValueOnce({
        ok: true,
        ownerUserId: 101,
        installationId: 9001,
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 700_000, logger: logger as never });

      expect(mockHasActiveMergeConflictReviewLoopEpochForHead).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
        }),
      );
      expect(mockHasMergeConflictReviewLoopEpochForHead).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
        }),
      );
      expect(mockBootstrapReviewLoopEpochForMergeConflict).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({
          sessionId: "sess-1",
          ownerUserId: 101,
          repoOwner: "acme",
          repoName: "repo",
          prNumber: 42,
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
          nowMs: 700_000,
        }),
      );
      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      expect(mockHasPendingReviewLoopWork).not.toHaveBeenCalled();
      expect(result.reviewListeningMergeConflictIntakes).toBe(1);
      expect(result.reviewListeningRebaseBlocked).toBe(0);
    });

    it("on dirty with an active merge-conflict epoch: does not bootstrap or fall back to rebase blocking", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockResolveReviewLoopMergeConflictEligibility.mockResolvedValueOnce({
        ok: true,
        ownerUserId: 101,
        installationId: 9001,
      });
      mockHasActiveMergeConflictReviewLoopEpochForHead.mockResolvedValueOnce(true);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 700_000, logger: logger as never });

      expect(mockHasMergeConflictReviewLoopEpochForHead).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochForMergeConflict).not.toHaveBeenCalled();
      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      expect(mockHasPendingReviewLoopWork).not.toHaveBeenCalled();
      expect(result.reviewListeningMergeConflictIntakes).toBe(0);
      expect(result.reviewListeningRebaseBlocked).toBe(0);
    });

    it("on dirty after a terminal merge-conflict epoch: falls back to conservative rebase blocking", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockResolveReviewLoopMergeConflictEligibility.mockResolvedValueOnce({
        ok: true,
        ownerUserId: 101,
        installationId: 9001,
      });
      mockHasActiveMergeConflictReviewLoopEpochForHead.mockResolvedValueOnce(false);
      mockHasMergeConflictReviewLoopEpochForHead.mockResolvedValueOnce(true);
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      mockBlockPendingReviewLoopEpochsForHead.mockResolvedValueOnce(1);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 700_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochForMergeConflict).not.toHaveBeenCalled();
      expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
          reason: "rebase_needed",
        }),
      );
      expect(result.reviewListeningMergeConflictIntakes).toBe(0);
      expect(result.reviewListeningRebaseBlocked).toBe(1);
    });

    it("on dirty with pending work: DMs the owner once, keyed on the current head", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            ownerUserId: 101,
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      mockBlockPendingReviewLoopEpochsForHead.mockResolvedValueOnce(2);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 700_000, logger: logger as never });

      expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(1);
      expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          sessionId: "sess-1",
          ownerUserId: 101,
          kind: "merge_conflict",
          dedupKey: "old-head",
          prUrl: "https://github.com/acme/repo/pull/42",
        }),
      );
    });

    it("on dirty: skips the owner DM when the ref has no owner", async () => {
      singleRef(); // ref omits ownerUserId
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      mockBlockPendingReviewLoopEpochsForHead.mockResolvedValueOnce(2);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 700_000, logger: logger as never });

      expect(mockNotifyUserBlocked).not.toHaveBeenCalled();
    });

    it("on dirty: does NOT re-post the comment after the notice was already sent for a head", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // A prior tick already blocked an epoch `rebase_needed` for this head → the notice was sent.
      mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([
        { status: "blocked", blockedReason: "rebase_needed" },
      ]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 701_000, logger: logger as never });

      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      // Block is still re-applied (idempotent) to catch any new epochs on this head.
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledTimes(1);
    });

    it("on dirty: a failed comment leaves epochs unblocked so the notice retries next tick", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      mockCreatePrIssueComment.mockRejectedValueOnce(new Error("rate limited"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 702_000, logger: logger as never });

      expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
      // Epochs NOT blocked (no rebase_needed epoch persists), so the next tick re-posts and re-blocks.
      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      expect(result.reviewListeningRebaseBlocked).toBe(0);
      // Loop is still paused for the dirty head regardless of the comment failure.
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("on dirty with NO pending work: does not comment or block, but still pauses (skips bootstrap)", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: false,
        mergeableState: "dirty",
        rawMergeableState: "dirty",
      });
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(false);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 702_000, logger: logger as never });

      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      expect(result.reviewListeningRebaseBlocked).toBe(0);
      // A conflicted head never runs CI recovery / bootstrap, even with nothing to block.
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("on clean/unstable: no merge-conflict action (no comment, no block)", async () => {
      for (const mergeableState of ["clean", "unstable"]) {
        mockCreatePrIssueComment.mockClear();
        mockBlockPendingReviewLoopEpochsForHead.mockClear();
        singleRef();
        mockGetPrMergeStatus.mockResolvedValueOnce({
          state: "open",
          headSha: "old-head",
          mergeable: mergeableState === "behind" ? true : null,
          mergeableState,
          rawMergeableState: mergeableState,
        });
        mockHasPendingReviewLoopWork.mockResolvedValue(true);

        const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
        await runReviewLoopSweep(env, { nowMs: 703_000, logger: logger as never });

        expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
        expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      }
    });
  });

  describe("behind-base auto-update + carry-forward on reconcile", () => {
    function singleRef() {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    function behindStatus() {
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "old-head",
        mergeable: true,
        mergeableState: "behind",
        rawMergeableState: "behind",
      });
    }

    it("on behind with pending work: issues update-branch with expected_head_sha and skips bootstrap", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // No spine queued marker for this head (getPrCoordination defaults to null) → issue update-branch.

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 800_000, logger: logger as never });

      expect(mockUpdatePullRequestBranch).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "old-head");
      expect(result.reviewListeningBranchUpdated).toBe(1);
      // The spine queued marker is stamped ONLY on a successful queue, keyed to the head we updated —
      // this is the positive proof the head-change carry-forward gate keys on (ARC-1302).
      expect(mockMarkPrCoordinationUpdateBranchQueued).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
          nowMs: 800_000,
        }),
      );
      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("on behind ok: a spine queued-marker write failure is contained — update still counts", async () => {
      // update-branch already queued at GitHub (ok). A transient D1 throw on the spine queued-marker
      // stamp must not abort this PR's tick or miscount it as an error; the conservative residual (the
      // head advance may stale-block this base-merge) is tracked in ARC-1311, not introduced here.
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      mockMarkPrCoordinationUpdateBranchQueued.mockRejectedValueOnce(new Error("d1 unavailable"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 800_000, logger: logger as never });

      expect(mockMarkPrCoordinationUpdateBranchQueued).toHaveBeenCalledTimes(1);
      expect(result.reviewListeningBranchUpdated).toBe(1);
      expect(result.reviewListeningErrors).toBe(0);
    });

    it("on behind while our update-branch is already queued for this head: does NOT re-issue", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // We already queued update-branch for old-head 1 minute ago — well inside the give-up window, so
      // the merge is still in flight and we must not re-issue (single-issue-per-head, D-54).
      mockGetPrCoordination.mockResolvedValue({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
        updateBranchQueuedAt: 800_000 - 60_000,
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 800_000, logger: logger as never });

      expect(mockUpdatePullRequestBranch).not.toHaveBeenCalled();
      // Within the give-up window → not surfaced either.
      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
    });

    it("on behind past the give-up window (head never advanced): blocks branch_update_failed + comments", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // We queued update-branch for old-head over the give-up window ago and the head still has not
      // advanced → the base-merge is stuck; surface to the owner instead of retrying forever (replaces
      // the folded attempt cap, D-54). 20 minutes > the 15-minute give-up window.
      mockGetPrCoordination.mockResolvedValue({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
        updateBranchQueuedAt: 900_000 - 20 * 60 * 1000,
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 900_000, logger: logger as never });

      expect(mockUpdatePullRequestBranch).not.toHaveBeenCalled();
      expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ reason: "branch_update_failed", headSha: "old-head" }),
      );
      expect(result.reviewListeningRebaseBlocked).toBe(1);
    });

    it("on behind past the give-up window: DMs the owner branch_update_failed, keyed on head", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            ownerUserId: 101,
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      mockGetPrCoordination.mockResolvedValue({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
        updateBranchQueuedAt: 900_000 - 20 * 60 * 1000,
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 900_000, logger: logger as never });

      expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(1);
      expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          sessionId: "sess-1",
          ownerUserId: 101,
          kind: "branch_update_failed",
          dedupKey: "old-head",
          prUrl: "https://github.com/acme/repo/pull/42",
        }),
      );
    });

    it("on behind with permission denied: blocks branch_update_failed (no retry)", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // No spine queued marker → issue update-branch, which is denied.
      mockUpdatePullRequestBranch.mockResolvedValueOnce({
        ok: false,
        reason: "permission_denied",
        status: 403,
        detail: "no write",
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 950_000, logger: logger as never });

      expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ reason: "branch_update_failed" }),
      );
      // A non-queuing failure leaves the spine queued marker unset.
      expect(mockMarkPrCoordinationUpdateBranchQueued).not.toHaveBeenCalled();
    });

    it("on behind with permission denied: DMs the owner branch_update_failed, keyed on head", async () => {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            ownerUserId: 101,
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // No spine queued marker → issue update-branch, which is denied.
      mockUpdatePullRequestBranch.mockResolvedValueOnce({
        ok: false,
        reason: "permission_denied",
        status: 403,
        detail: "no write",
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 950_000, logger: logger as never });

      expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(1);
      expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          sessionId: "sess-1",
          ownerUserId: 101,
          kind: "branch_update_failed",
          dedupKey: "old-head",
          prUrl: "https://github.com/acme/repo/pull/42",
        }),
      );
    });

    it("on behind past the give-up window on a re-entry: blocks but does NOT re-comment", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // Stuck base-merge past the give-up window, AND a prior tick already surfaced it (an epoch is
      // blocked branch_update_failed for this head) → re-block without re-posting the comment.
      mockGetPrCoordination.mockResolvedValue({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
        updateBranchQueuedAt: 955_000 - 20 * 60 * 1000,
      });
      mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([
        { status: "blocked", blockedReason: "branch_update_failed" },
      ]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 955_000, logger: logger as never });

      expect(mockUpdatePullRequestBranch).not.toHaveBeenCalled();
      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ reason: "branch_update_failed" }),
      );
    });

    it("on behind with permission denied on a re-entry: blocks but does NOT re-comment", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // No spine marker → issue update-branch (denied); a prior tick already surfaced this head.
      mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([
        { status: "blocked", blockedReason: "branch_update_failed" },
      ]);
      mockUpdatePullRequestBranch.mockResolvedValueOnce({
        ok: false,
        reason: "permission_denied",
        status: 403,
        detail: "no write",
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 951_000, logger: logger as never });

      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(mockBlockPendingReviewLoopEpochsForHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ reason: "branch_update_failed" }),
      );
    });

    it("on behind with a transient/race update failure: defers without blocking", async () => {
      singleRef();
      behindStatus();
      mockHasPendingReviewLoopWork.mockResolvedValueOnce(true);
      // No spine marker → issue update-branch, which fails transiently.
      mockUpdatePullRequestBranch.mockResolvedValueOnce({
        ok: false,
        reason: "expected_head_mismatch",
        status: 422,
        detail: "head moved",
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 960_000, logger: logger as never });

      expect(mockBlockPendingReviewLoopEpochsForHead).not.toHaveBeenCalled();
      expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
      expect(result.reviewListeningBranchUpdated).toBe(0);
      // A transient/race failure must NOT stamp the spine queued marker — otherwise a foreign push that
      // caused the race would later be misread as our base-merge and carry stale work forward (ARC-1302).
      expect(mockMarkPrCoordinationUpdateBranchQueued).not.toHaveBeenCalled();
    });

    it("carries pending epochs forward (not stale-block) when our update-branch advanced the head", async () => {
      singleRef();
      // Head advanced to a new commit (our merge commit), and the PR is now clean.
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "new-head",
        mergeable: true,
        mergeableState: "clean",
        rawMergeableState: "clean",
      });
      // The spine row still names the previous head with a QUEUED update-branch marker → the change is
      // ours (the head-change carry-forward gate reads this).
      mockGetPrCoordination.mockResolvedValue({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
        updateBranchQueuedAt: 900,
      });
      mockCarryForwardReviewLoopEpochsToNewHead.mockResolvedValueOnce(2);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 1_000_000, logger: logger as never });

      expect(mockCarryForwardReviewLoopEpochsToNewHead).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head" }),
      );
      expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
      expect(result.reviewListeningCarriedForward).toBe(2);
      expect(result.reviewListeningHeadChanged).toBe(1);
    });

    it("falls back to stale-block when no prior queued marker recorded (foreign head change)", async () => {
      singleRef();
      mockGetPrMergeStatus.mockResolvedValueOnce({
        state: "open",
        headSha: "new-head",
        mergeable: true,
        mergeableState: "clean",
        rawMergeableState: "clean",
      });
      // No spine queued marker (getPrCoordination defaults to null) → not our change.
      mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 1_010_000, logger: logger as never });

      expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
      expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalled();
    });
  });

  describe("scheduled epoch bootstrap from head signals", () => {
    function singleSessionRefs() {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    it("skips bootstrap and head work for verification-session refs after the PR-state read", async () => {
      singleSessionRefs();
      mockGetSessionState.mockReset().mockResolvedValue(reviewListeningSession({ agentRole: "verification" }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // The merged/closed lifecycle reconciliation still runs (PR state was read) …
      expect(mockGetPrMergeStatus).toHaveBeenCalled();
      // … but no review-loop work happens for the verifier's ref.
      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(mockGetCommitStatusContexts).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      expect(result.reviewListeningEpochsBootstrapped).toBe(0);
      expect(result.reviewListeningErrors).toBe(0);
    });

    it("polls current head check runs and commit statuses and calls bootstrap when checklist resolves", async () => {
      singleSessionRefs();
      const checkRuns = [
        {
          id: 1,
          name: "Strix",
          status: "completed",
          conclusion: "success",
          appSlug: "strix-security",
          appName: "Strix",
          detailsUrl: null,
        },
      ];
      const commitStatuses = [
        {
          id: 9600,
          state: "success",
          context: "CodeRabbit",
          description: null,
          targetUrl: null,
          creatorLogin: "coderabbitai",
          creatorType: "Bot",
        },
      ];
      mockGetCommitCheckRuns.mockResolvedValueOnce(checkRuns);
      mockGetCommitStatusContexts.mockResolvedValueOnce(commitStatuses);
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch: { id: "epoch-new", status: "ready" },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockGetCommitCheckRuns).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
      expect(mockGetCommitStatusContexts).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledWith({
        env,
        sessionId: "sess-1",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "settings-hash",
        checkRuns,
        commitStatuses,
        nowMs: 456_000,
      });
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
    });

    it("polls current head after a head change and bootstraps against the new head", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(2);
      mockGetCommitCheckRuns.mockResolvedValueOnce([
        {
          id: 7,
          name: "Strix",
          status: "completed",
          conclusion: "success",
          appSlug: "strix-security",
          appName: "Strix",
          detailsUrl: null,
        },
      ]);
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch: { id: "epoch-new", status: "ready" },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockGetCommitCheckRuns).toHaveBeenCalledWith("token-1", "acme", "repo", "new-head");
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: "new-head" }),
      );
      expect(result.reviewListeningHeadChanged).toBe(1);
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
    });

    it("does not bootstrap a new epoch when the new head has no new actionable feedback", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      // The only worklist item is one a prior epoch already handled (e.g. a thread left
      // unresolved after Cycloid's own review-response push). A clean bot re-review of the
      // new commit must not re-trigger the loop.
      mockListKnownReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map([["review-comment:1", 2]]),
        legacySourceIds: new Set<string>(),
        triggeringSourceIds: new Set<string>(),
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith("token-1", "acme", "repo", 42, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        // ARC-1226: the gate excludes already-prompted records so a beyond-budget tail can surface;
        // here the only item IS already prompted, so it is excluded and nothing new re-triggers.
        excludePromptedSourceRecords: new Map([["review-comment:1", 2]]),
        excludeSourceIds: new Set<string>(),
      });
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      // The shared head-CI poll fetches check-runs + commit-statuses once per checklist-ok ref (the
      // default mocks return [] → no-op for done-eval/recovery). The bot bootstrap is still skipped
      // when there is no new actionable feedback, but it no longer owns the commit-status fetch.
      expect(mockGetCommitStatusContexts).toHaveBeenCalledWith("token-1", "acme", "repo", "new-head");
      expect(result.reviewListeningEpochsBootstrapped).toBe(0);
    });

    it("bootstraps when already-prompted GitHub feedback was edited after its prompt", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockListKnownReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map([
          ["review-comment:1", 10],
          ["issue-comment:2", 10],
        ]),
        legacySourceIds: new Set<string>(),
        triggeringSourceIds: new Set<string>(),
      });
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
        items: [
          {
            sourceId: "review-comment:1",
            sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            body: "Unchanged replay",
            path: "src/app.ts",
            line: 10,
            updatedAtMs: 10,
            isResolved: false,
            isOutdated: false,
          },
          {
            sourceId: "issue-comment:2",
            sourceUrl: "https://github.com/acme/repo/pull/42#issuecomment-2",
            authorLogin: "coderabbitai[bot]",
            authorType: "Bot",
            body: "Edited feedback body",
            path: null,
            line: null,
            updatedAtMs: 11,
            isResolved: false,
            isOutdated: false,
          },
        ],
        duplicateGroups: [],
        worklistHash: "edited-feedback",
      });
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch: { id: "epoch-new", status: "ready" },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: "new-head" }),
      );
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
    });

    it("does not bootstrap when an already-prompted review body hash is unchanged", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockListKnownReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map([["review-body:9100", 10]]),
        bodyHashBySourceId: new Map([["review-body:9100", "hash-same"]]),
        legacySourceIds: new Set<string>(),
        triggeringSourceIds: new Set<string>(),
      });
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
        items: [
          {
            sourceId: "review-body:9100",
            sourceUrl: "https://github.com/acme/repo/pull/42#pullrequestreview-9100",
            authorLogin: "alice",
            authorType: "User",
            body: "Unchanged review body",
            path: null,
            line: null,
            updatedAtMs: 11,
            isResolved: false,
            isOutdated: false,
            rawBodyHash: "hash-same",
          },
        ],
        duplicateGroups: [],
        worklistHash: "unchanged-review-body",
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      expect(result.reviewListeningEpochsBootstrapped).toBe(0);
    });

    it("does not bootstrap a new epoch when the new head's worklist is empty", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({ items: [], duplicateGroups: [], worklistHash: "h" });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      expect(result.reviewListeningEpochsBootstrapped).toBe(0);
    });

    it("bootstraps when the new head carries a worklist item no prior epoch has seen", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockListKnownReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map([["review-comment:old", 2]]),
        legacySourceIds: new Set<string>(),
        triggeringSourceIds: new Set<string>(),
      });
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
        items: [
          {
            sourceId: "review-comment:new",
            sourceUrl: "https://github.com/acme/repo/pull/42#discussion_rnew",
            authorLogin: "greptile-apps[bot]",
            authorType: "Bot",
            body: "New finding on the new head",
            path: "src/app.ts",
            line: 12,
            updatedAtMs: 2,
            isResolved: false,
            isOutdated: false,
          },
        ],
        duplicateGroups: [],
        worklistHash: "h2",
      });
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch: { id: "epoch-new", status: "ready" },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: "new-head" }),
      );
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
    });

    it("bootstraps when a new source is collapsed into a duplicate group behind a known canonical item", async () => {
      singleSessionRefs();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      // The canonical item is an old/known source, but the bot re-posted the same finding on
      // the new head; that genuinely new source is collapsed into duplicateGroups. It must
      // still count as new actionable feedback.
      mockListKnownReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map([["review-comment:canonical-old", 2]]),
        legacySourceIds: new Set<string>(),
        triggeringSourceIds: new Set<string>(),
      });
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
        items: [
          {
            sourceId: "review-comment:canonical-old",
            sourceUrl: "https://github.com/acme/repo/pull/42#discussion_rold",
            authorLogin: "greptile-apps[bot]",
            authorType: "Bot",
            body: "Same finding",
            path: "src/app.ts",
            line: 10,
            updatedAtMs: 1,
            isResolved: false,
            isOutdated: false,
          },
        ],
        duplicateGroups: [
          { canonicalSourceId: "review-comment:canonical-old", duplicateSourceIds: ["review-comment:fresh-dup"] },
        ],
        worklistHash: "h3",
      });
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch: { id: "epoch-new", status: "ready" },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: "new-head" }),
      );
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
    });

    it("skips polling and bootstrap when the checklist resolution fails", async () => {
      singleSessionRefs();
      mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "auto_response_disabled" });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(mockGetCommitStatusContexts).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("does not poll or bootstrap for archived or non-review_listening sessions", async () => {
      singleSessionRefs();
      mockGetSessionState.mockResolvedValueOnce(reviewListeningSession({ status: "archived" }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("does not poll or bootstrap when the PR has been merged or closed", async () => {
      singleSessionRefs();
      mockGetPrState.mockResolvedValueOnce("merged");

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("counts a sweep error and continues when polling check runs throws", async () => {
      singleSessionRefs();
      mockGetCommitCheckRuns.mockRejectedValueOnce(new Error("github 503"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      const result = await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      expect(result.reviewListeningErrors).toBe(1);
    });

    it("skips bot bootstrap when a review epoch already exists for the current head, but still runs CI recovery", async () => {
      singleSessionRefs();
      mockHasExpectedBotReviewLoopEpochForHead.mockResolvedValueOnce(true);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");

      await runReviewLoopSweep(env, {
        nowMs: 456_000,
        logger: logger as never,
      });

      expect(mockHasExpectedBotReviewLoopEpochForHead).toHaveBeenCalledWith(
        {},
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "old-head",
        },
      );
      // CI recovery runs independent of the bot-epoch-exists gate (the default mock returns [] -> no
      // CI epoch created). The shared head-CI poll fetches both check-runs and commit-statuses once,
      // but the bot bootstrap call itself is skipped because a review epoch already exists.
      expect(mockGetCommitCheckRuns).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
      expect(mockGetCommitStatusContexts).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });
  });

  describe("review-loop done-state rollup", () => {
    function settledSessionRefs() {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    // Both epoch kinds present on the head: both catch-up paths (bootstrap + CI recovery) are
    // exhausted. The done-state rollup runs regardless of epoch kinds (it is unconditional for every
    // checklist-ok ref); this helper just pins the "both early-continues taken" steady-state shape.
    function fullySettled() {
      mockHasReviewLoopEpochForHead.mockResolvedValue(true);
      mockHasExpectedBotReviewLoopEpochForHead.mockResolvedValue(true);
      mockHasCiReviewLoopEpochForHead.mockResolvedValue(true);
    }

    it("keeps the prior done-state when the shared CI poll fails (does not flip green to working)", async () => {
      settledSessionRefs();
      fullySettled();
      mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: "done" }));
      // The shared head-CI poll throws a transient 503 → the caller skips done-eval/recovery/bootstrap
      // for this tick and keeps the prior value (no state write, no labels). The next sweep retries.
      mockGetCommitCheckRuns.mockRejectedValueOnce(new Error("GitHub check runs failed (503): upstream"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockComputeReviewLoopRollup).not.toHaveBeenCalled();
      expect(mockGetReviewLoopEpochSummariesForHead).not.toHaveBeenCalled();
      expect(mockSetSessionReviewLoopDoneState).not.toHaveBeenCalled();
      expect(mockAddLabels).not.toHaveBeenCalled();
      // A failed head-CI poll is a reconciliation error for the tick (the caller counts it and retries).
      expect(result.reviewListeningErrors).toBe(1);
    });

    it("forces working, clears all review-loop labels, and resets the stale verdict on a head change", async () => {
      settledSessionRefs();
      fullySettled();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);
      mockGetSessionState.mockResolvedValue(
        reviewListeningSession({ reviewListeningHeadSha: "old-head", reviewLoopDoneState: "done" }),
      );

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // ARC-1330 D-59a: the legacy done-state reset (setSessionReviewLoopDoneState → "working") is deleted;
      // the FSM owns the head-change reset via `head.changed` (advance_head). The canonical label reconcile
      // (`syncFsmLabelsForPr`) reprojects off the committed spine row — head.changed cleared the verdict →
      // REVIEW → labelsOf strips the stale managed labels.
      expect(mockSyncFsmLabelsForPr).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prUrl: "https://github.com/acme/repo/pull/42", sessionId: "sess-1" }),
      );
      // ARC-1330 D-59 residue fold: the standalone sweep verdict clear is DELETED. Head-freshness is now
      // enforced by the head producer — a real change emits `head.changed`, whose
      // `syncLegacyVerificationStoreForHeadChange` clears the stale prior-head verdict at live (the producer
      // is mocked here). This asserts the delegation; the standalone writer is never called.
      expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
      const clearEmitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
      expect(clearEmitCall?.[2]).toMatchObject({ kind: "head.changed" });
      // Head-change resets and skips done-eval: the rollup is never computed this tick.
      expect(mockComputeReviewLoopRollup).not.toHaveBeenCalled();
      expect(result.reviewListeningHeadChanged).toBe(1);
    });

    it("preserves the verdict on a content no-op head change (identical tree) so it is not re-verified", async () => {
      settledSessionRefs();
      fullySettled();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      // Same tree SHA on both heads → a no-op rebase/reword/force-push: nothing new to verify.
      mockIsNoOpHeadTreeChange.mockResolvedValueOnce(true);
      mockGetSessionState.mockResolvedValue(
        reviewListeningSession({
          reviewListeningHeadSha: "old-head",
          reviewLoopDoneState: "done",
          verificationState: "verification-done",
          verificationResult: "merge-ready",
        }),
      );

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // The verdict + per-head run baseline are PRESERVED (not cleared) — the scheduler's verdict guard
      // then suppresses re-verification even if done-state churns while CI re-runs on the new SHA.
      expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
      // ARC-1330 D-59 residue fold: the standalone restamp is DELETED. A content no-op emits
      // `head.noop_changed`, whose producer helper restamps the preserved verdict onto the new head at live
      // (the producer is mocked here) — so the standalone writer is never called.
      expect(mockStampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
      const noopEmitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
      expect(noopEmitCall?.[2]).toMatchObject({ kind: "head.noop_changed" });
      // The watermark still advances (so the no-op head is not re-detected every tick).
      expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledWith(
        env,
        "sess-1",
        expect.objectContaining({ currentHeadSha: "new-head" }),
      );
      expect(result.reviewListeningHeadChanged).toBe(1);
    });

    it("resets an outdated verification-skipped verdict on head change (head-freshness for null-result skips)", async () => {
      settledSessionRefs();
      fullySettled();
      mockGetPrHeadSha.mockResolvedValueOnce("new-head");
      mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);
      // verification-skipped carries a NULL result — the reset must still fire (regression: a guard on
      // verificationResult != null would skip it, leaving the skip approval to leak onto the new head).
      // The guard is `verificationState != null || verificationResult != null`, so a non-null state with
      // a null result still triggers the clear.
      mockGetSessionState.mockResolvedValue(
        reviewListeningSession({
          reviewListeningHeadSha: "old-head",
          reviewLoopDoneState: "done",
          verificationState: "verification-skipped",
          verificationResult: null,
        }),
      );

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // ARC-1330 D-59 residue fold: delegated to the head producer via `head.changed` (a non-null state with
      // a null result still classifies as a real change → the producer clears the stale skip at live). The
      // standalone sweep clear is deleted, so it is never called directly.
      expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
      const skipEmitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
      expect(skipEmitCall?.[2]).toMatchObject({ kind: "head.changed" });
    });

    it("reconciles canonical labels before closing a merged PR", async () => {
      settledSessionRefs();
      mockGetPrState.mockResolvedValueOnce("merged");
      mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: "done" }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // The canonical label reconcile (`syncFsmLabelsForPr`) — labelsOf(terminal record) strips the full
      // managed namespace — must run before close (best-effort), and never block it.
      const reconcileOrder = Math.max(...mockSyncFsmLabelsForPr.mock.invocationCallOrder);
      const closeOrder = mockCloseSessionForWebhook.mock.invocationCallOrder[0];
      expect(mockSyncFsmLabelsForPr).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prUrl: "https://github.com/acme/repo/pull/42", sessionId: "sess-1" }),
      );
      expect(reconcileOrder).toBeLessThan(closeOrder);
      expect(result.reviewListeningClosed).toBe(1);
    });

    it("does not touch done-state or labels when the checklist is not ready and there is no prior claim", async () => {
      settledSessionRefs();
      mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "auto_response_disabled" });
      mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: null }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockSetSessionReviewLoopDoneState).not.toHaveBeenCalled();
      expect(mockRemoveLabel).not.toHaveBeenCalled();
      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
    });
  });

  describe("failing CI check recovery on reconcile (pre-listen / dropped webhook recovery)", () => {
    function singleSessionRefs() {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    it("bootstraps a CI-fix epoch for a failing completed check already on the head", async () => {
      singleSessionRefs();
      // A check that FAILED and completed before listening armed (its live check_run webhook was
      // dropped with no_review_listening_session). Recovery must turn it into a ci-fix epoch.
      mockGetCommitCheckRuns.mockResolvedValueOnce([
        {
          id: 9100,
          name: "build",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          appName: "GitHub Actions",
          detailsUrl: "https://github.com/acme/repo/runs/9100",
        },
      ]);
      mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({ status: "handled", epoch: { id: "ci-epoch-1" } });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // Input must match the live check_run webhook exactly so a later live webhook dedupes against
      // the same sentinel row: same `ci-check:<id>:<pr>` sourceId, app-derived actor, head/pr fields.
      expect(mockIngestReviewLoopCiFailureWebhook).toHaveBeenCalledWith({
        env,
        deliveryId: null,
        sourceId: "ci-check:9100:42",
        checkRunId: 9100,
        checkRunName: "build",
        checkRunConclusion: "failure",
        actorLogin: "github-actions[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-head",
      });
      expect(result.reviewListeningCiChecksRecovered).toBe(1);
    });

    it("does not create a CI-fix epoch for passing or still-pending checks", async () => {
      singleSessionRefs();
      mockGetCommitCheckRuns.mockResolvedValueOnce([
        {
          id: 1,
          name: "ok",
          status: "completed",
          conclusion: "success",
          appSlug: "ci",
          appName: "CI",
          detailsUrl: null,
        },
        {
          id: 2,
          name: "running",
          status: "in_progress",
          conclusion: null,
          appSlug: "ci",
          appName: "CI",
          detailsUrl: null,
        },
        { id: 3, name: "queued", status: "queued", conclusion: null, appSlug: "ci", appName: "CI", detailsUrl: null },
      ]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
      expect(result.reviewListeningCiChecksRecovered).toBe(0);
    });

    it("skips CI recovery (no re-ingest, no metric increment) once a ci-fix epoch already exists for the head", async () => {
      singleSessionRefs();
      // A prior recovery (or live webhook) already created the ci-fix epoch on this head. A bot epoch
      // also exists, so neither catch-up path has work left. (The shared head-CI poll still runs once
      // per checklist-ok ref to feed the done-state rollup, so we no longer assert zero
      // getCommitCheckRuns calls; the guard here is specifically that the CI-RECOVERY path does not
      // re-ingest or re-increment.)
      mockHasCiReviewLoopEpochForHead.mockResolvedValueOnce(true);
      mockHasReviewLoopEpochForHead.mockResolvedValueOnce(true);
      mockHasExpectedBotReviewLoopEpochForHead.mockResolvedValueOnce(true);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // Settled head: the CI-recovery catch-up path is not taken — no recovery ingest, no metric churn,
      // and no new ci-fix epoch is bootstrapped (the existing ci-fix epoch already owns this head).
      expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
      expect(result.reviewListeningCiChecksRecovered).toBe(0);
    });

    it("still polls check runs when only the ci-fix epoch exists (bot bootstrap may still have work) but skips CI recovery", async () => {
      singleSessionRefs();
      mockHasCiReviewLoopEpochForHead.mockResolvedValueOnce(true);
      // No bot epoch yet, and a failing check is present — recovery must NOT re-ingest it (ci epoch
      // already exists), so the recovered metric stays at 0 even with a failing check on the head.
      mockGetCommitCheckRuns.mockResolvedValueOnce([
        {
          id: 9100,
          name: "build",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          appName: "GitHub Actions",
          detailsUrl: null,
        },
      ]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockGetCommitCheckRuns).toHaveBeenCalledTimes(1);
      expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
      expect(result.reviewListeningCiChecksRecovered).toBe(0);
    });

    it("does not recover a failing check produced by a Cycloid-owned app", async () => {
      singleSessionRefs();
      // The Cycloid `[ARC]` PR-title check fails: it is our own check, not third-party CI the
      // code-editing loop can fix, so it must NOT be turned into a ci-fix epoch.
      mockGetCommitCheckRuns.mockResolvedValueOnce([
        {
          id: 9200,
          name: "[ARC] PR title",
          status: "completed",
          conclusion: "failure",
          appSlug: "cycloid",
          appName: "Cycloid",
          detailsUrl: null,
        },
      ]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
      expect(result.reviewListeningCiChecksRecovered).toBe(0);
    });

    it("leaves the existing bot bootstrap unchanged while recovering CI", async () => {
      singleSessionRefs();
      // One failing CI check AND genuinely new bot feedback (default worklist item is unknown).
      const checkRuns = [
        {
          id: 9100,
          name: "build",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          appName: "GitHub Actions",
          detailsUrl: null,
        },
      ];
      mockGetCommitCheckRuns.mockResolvedValueOnce(checkRuns);
      mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({ status: "handled", epoch: { id: "ci-epoch-1" } });
      mockBootstrapReviewLoopEpochFromHeadSignals.mockResolvedValueOnce({
        bootstrapped: 1,
        ignored: [],
        epoch: { id: "epoch-new", status: "ready" },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      // Bot bootstrap still fires with the SAME check runs (reused, no second poll).
      expect(mockGetCommitCheckRuns).toHaveBeenCalledTimes(1);
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: "old-head", checkRuns }),
      );
      expect(result.reviewListeningEpochsBootstrapped).toBe(1);
      expect(result.reviewListeningCiChecksRecovered).toBe(1);
    });
  });

  describe("zero-bot repos: CI-fix + verification arm decoupled from the bot checklist", () => {
    // A brand-new repo with no configured review bots resolves the checklist to
    // { ok:true, expectedBots: [] } (walltime removal). The bot checklist scopes ONLY the code-review
    // arm; the always-on CI-fix + verification (done-rollup) arm must still run, and the bot bootstrap
    // stays gated off (nothing to bootstrap). Without this, zero-bot/no-CI repos strand at
    // verification-pending forever because the periodic sweep is their only path to `done`.
    const zeroBotChecklist = { ok: true as const, expectedBots: [], expectedBotsHash: "empty-bots-hash" };
    function singleSessionRefs() {
      mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
        data: [
          {
            sessionId: "sess-1",
            prUrl: "https://github.com/acme/repo/pull/42",
            updatedAt: "2026-05-26T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    it("recovers a pre-listening failing CI check even when no bots are configured", async () => {
      singleSessionRefs();
      mockResolveReviewLoopChecklist.mockResolvedValueOnce(zeroBotChecklist);
      mockGetCommitCheckRuns.mockResolvedValueOnce([
        {
          id: 9100,
          name: "build",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          appName: "GitHub Actions",
          detailsUrl: "https://github.com/acme/repo/runs/9100",
        },
      ]);
      mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({ status: "handled", epoch: { id: "ci-epoch-1" } });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockIngestReviewLoopCiFailureWebhook).toHaveBeenCalledTimes(1);
      expect(result.reviewListeningCiChecksRecovered).toBe(1);
      // The bot-comment bootstrap stays gated off for a zero-bot repo (code-review arm only).
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });

    it("still fails closed for a zero-bot repo whose installation capabilities are missing", async () => {
      singleSessionRefs();
      // Walltime removal: the per-repo CI opt-out is gone and a zero-bot repo resolves ok:true, so the
      // only remaining whole-loop fail-closed reason is missing installation capabilities. That path
      // fails closed before any CI poll, recovery, or rollup.
      mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "installation_capabilities_missing" });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

      expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
      expect(mockComputeReviewLoopRollup).not.toHaveBeenCalled();
      expect(result.reviewListeningCiChecksRecovered).toBe(0);
      expect(mockBootstrapReviewLoopEpochFromHeadSignals).not.toHaveBeenCalled();
    });
  });

  describe("prompt builder branching by sourceKind", () => {
    function setupEpochForPrompt(sourceKind: "bot" | "human" | "mixed") {
      const epoch = claimedEpoch({ sourceKind, triggeringSourceIds: ["human:9001"] });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1" } },
      });
      return epoch;
    }

    it("calls buildGithubPrReviewLoopPrompt for bot-source epoch", async () => {
      setupEpochForPrompt("bot");
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });
      expect(mockBuildGithubPrReviewLoopPrompt).toHaveBeenCalledTimes(1);
      expect(mockBuildGithubPrReviewLoopHumanPrompt).not.toHaveBeenCalled();
      expect(result.humanEpochsCreated).toBe(0);
      expect(result.mixedEpochsCreated).toBe(0);
    });

    it("calls buildGithubPrReviewLoopHumanPrompt for human-source epoch", async () => {
      setupEpochForPrompt("human");
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });
      expect(mockBuildGithubPrReviewLoopHumanPrompt).toHaveBeenCalledTimes(1);
      expect(mockBuildGithubPrReviewLoopPrompt).not.toHaveBeenCalled();
      expect(result.humanEpochsCreated).toBe(1);
      expect(result.mixedEpochsCreated).toBe(0);
    });

    it("calls buildGithubPrReviewLoopHumanPrompt for mixed-source epoch", async () => {
      setupEpochForPrompt("mixed");
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });
      expect(mockBuildGithubPrReviewLoopHumanPrompt).toHaveBeenCalledTimes(1);
      expect(mockBuildGithubPrReviewLoopPrompt).not.toHaveBeenCalled();
      expect(result.humanEpochsCreated).toBe(0);
      expect(result.mixedEpochsCreated).toBe(1);
    });

    it("passes reviewLoopSourceKind from epoch to enqueueSessionPrompt", async () => {
      setupEpochForPrompt("human");
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });
      expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
        env,
        "sess-1",
        expect.any(String),
        "101",
        expect.objectContaining({
          reviewLoopEpochId: "epoch-1",
          reviewLoopSourceKind: "human",
        }),
      );
    });
  });

  describe("Bug B fix — mixed epoch survives bot-settings drift", () => {
    /**
     * A claimed mixed epoch whose stored expectedBotsHash no longer matches the
     * current bot settings must NOT be blocked.  It must proceed through
     * resolveReviewLoopHumanEligibility (not the checklist) and be enqueued.
     */
    it("does not block a mixed epoch when the bot-settings hash has drifted", async () => {
      const epoch = claimedEpoch({
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9001"],
        // The hash stored on the epoch differs from what resolveReviewLoopChecklist
        // would return — simulating the owner editing bot settings after fold-in.
        expectedBotsHash: "old-hash",
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);

      // Simulate bot-settings drift: checklist would fail with expected_bots_changed.
      mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "expected_bots_changed" });
      // Human eligibility succeeds (settings + installation are fine).
      mockResolveReviewLoopHumanEligibility.mockResolvedValueOnce({ ok: true, ownerUserId: 101, installationId: 9001 });

      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-mixed" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      // Must NOT be blocked.
      expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
      expect(result.blocked).toBe(0);

      // resolveReviewLoopChecklist must NOT have been consulted for the mixed epoch.
      expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();

      // resolveReviewLoopHumanEligibility must have been used instead.
      expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ ownerUserId: 101, repoOwner: "acme", repoName: "repo" }),
      );

      // Epoch proceeds — prompt was enqueued.
      expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
      expect(result.enqueued).toBe(1);
    });

    /**
     * A pure bot epoch still goes through the full checklist.  Bot-settings drift
     * on a bot epoch should still block it (existing behaviour preserved).
     */
    it("still blocks a pure bot epoch when the bot-settings hash has drifted", async () => {
      const epoch = claimedEpoch({
        sourceKind: "bot",
        expectedBotsHash: "old-hash",
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);

      mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "expected_bots_changed" });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        {},
        "epoch-1",
        expect.objectContaining({ reason: "expected_bots_changed" }),
      );
      expect(result.blocked).toBe(1);
      // Human eligibility must NOT have been consulted for a pure bot epoch.
      expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    });
  });

  describe("stuck in-flight epoch reclaim + attempt cap", () => {
    it("reclaims a stuck in-flight epoch (expired lease) and re-drives it the same tick", async () => {
      const stuck = claimedEpoch({ status: "processing", attemptCount: 1, leaseExpiresAt: 1_000 });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);
      // After reclaim the epoch is ready and becomes due in the same sweep tick.
      mockReclaimStuckReviewLoopEpoch.mockResolvedValueOnce(claimedEpoch({ status: "ready", attemptCount: 1 }));
      const readyForRedrive = claimedEpoch({ status: "ready", attemptCount: 1 });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([readyForRedrive]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(claimedEpoch({ status: "reserving", attemptCount: 2 }));
      mockGetSessionState.mockResolvedValue(reviewListeningSession());
      mockResolveReviewLoopChecklist.mockResolvedValue({ ok: true, expectedBots: [], expectedBotsHash: "hash-1" });
      mockListSessionPrompts.mockResolvedValue({ ok: true, payload: { queue: {} } });
      mockGetPrReviewLoopWorklist.mockResolvedValueOnce({ items: [], worklistHash: "wh", duplicateGroups: [] });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockReclaimStuckReviewLoopEpoch).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ expectedLeaseExpiresAt: 1_000 }),
      );
      expect(result.stuckReclaimed).toBe(1);
      expect(mockBlockStuckReviewLoopEpoch).not.toHaveBeenCalled();
    });

    it("blocks a stuck in-flight epoch that hit the attempt cap instead of reclaiming it", async () => {
      const stuck = claimedEpoch({ status: "processing", attemptCount: 5, leaseExpiresAt: 1_000 });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockBlockStuckReviewLoopEpoch).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "attempt_cap_reached", expectedLeaseExpiresAt: 1_000 }),
      );
      expect(mockReclaimStuckReviewLoopEpoch).not.toHaveBeenCalled();
      // The reclaim-path cap-block also DMs the owner, mirroring the processEpoch path.
      expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          sessionId: "sess-1",
          ownerUserId: 101,
          kind: "review_attempt_cap",
          dedupKey: "epoch-1:old-head",
          prUrl: "https://github.com/acme/repo/pull/42",
        }),
      );
      expect(result.stuckBlocked).toBe(1);
    });

    it("reclaims a flaky carry-forward drain whose attempt_count is inflated but is still progressing (ARC-1242)", async () => {
      // attempt_count past the general cap from reclaim/crash cycles, but the no-progress budget is not
      // exhausted (the tail is still shrinking), so it must RECLAIM and keep draining — not park early.
      const stuck = claimedEpoch({
        status: "processing",
        attemptCount: 12,
        carryForwardNoProgressCount: 2,
        leaseExpiresAt: 1_000,
        carriedForwardSourceIds: ["review-comment:tail"],
      });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockBlockStuckReviewLoopEpoch).not.toHaveBeenCalled();
      expect(mockReclaimStuckReviewLoopEpoch).toHaveBeenCalled();
      expect(result.stuckReclaimed).toBe(1);
    });

    it("blocks a stuck carry-forward drain at the no-progress cap with the non-exhausted truncation reason (ARC-1242)", async () => {
      // No-progress budget exhausted (tail never shrank) → park with the honest non-exhausted reason,
      // regardless of attempt_count (here below the old wave cap, proving the no-progress count drives it).
      const stuck = claimedEpoch({
        status: "processing",
        attemptCount: 6,
        carryForwardNoProgressCount: 5, // REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP
        leaseExpiresAt: 1_000,
        carriedForwardSourceIds: ["review-comment:tail"],
      });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      // Honest non-exhausted reason → rollup stays "working" (no false review-loop:done).
      expect(mockBlockStuckReviewLoopEpoch).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "worklist_truncation_unresolved", expectedLeaseExpiresAt: 1_000 }),
      );
      expect(mockReclaimStuckReviewLoopEpoch).not.toHaveBeenCalled();
      // The drain reason is not in EPOCH_BLOCK_DM_KIND (rollup stays "working"), so no DM.
      expect(mockNotifyUserBlocked).not.toHaveBeenCalled();
      expect(result.stuckBlocked).toBe(1);
    });

    it("blocks a due epoch whose claim attempt_count exceeds the cap", async () => {
      const due = claimedEpoch({ status: "ready", attemptCount: 5 });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([due]);
      // claim bumps attempt_count to 6 (> cap of 5).
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(claimedEpoch({ status: "reserving", attemptCount: 6 }));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 60_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "attempt_cap_reached" }),
      );
      expect(result.blocked).toBe(1);
      // Did not proceed to enqueue.
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    });
  });

  describe("head-poll failure classification (getPrHeadSha now throws with status)", () => {
    function dueEpochReadyForHeadPoll() {
      const due = claimedEpoch({ status: "ready", attemptCount: 1 });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([due]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(claimedEpoch({ status: "reserving", attemptCount: 1 }));
      mockGetSessionState.mockResolvedValue(reviewListeningSession());
      mockResolveReviewLoopChecklist.mockResolvedValue({ ok: true, expectedBots: [], expectedBotsHash: "hash-1" });
      mockListSessionPrompts.mockResolvedValue({ ok: true, payload: { queue: { processingPromptId: null } } });
    }

    it("maps a thrown 404 to repo_gone (blocked, not transient)", async () => {
      dueEpochReadyForHeadPoll();
      mockGetPrHeadSha.mockReset().mockRejectedValueOnce(new Error("GitHub PR head lookup failed (404): Not Found"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 70_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "repo_gone" }),
      );
      expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalled();
      expect(result.blocked).toBe(1);
    });

    it("maps a thrown 401 to github_auth_lost (blocked, not transient)", async () => {
      dueEpochReadyForHeadPoll();
      mockGetPrHeadSha
        .mockReset()
        .mockRejectedValueOnce(new Error("GitHub PR head lookup failed (401): Bad credentials"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 71_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "github_auth_lost" }),
      );
      expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalled();
    });

    it("maps a thrown 403 to github_auth_lost", async () => {
      dueEpochReadyForHeadPoll();
      mockGetPrHeadSha.mockReset().mockRejectedValueOnce(new Error("GitHub PR head lookup failed (403): Forbidden"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 72_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "github_auth_lost" }),
      );
    });

    it("still treats a thrown 502 as transient (deferred, not blocked)", async () => {
      dueEpochReadyForHeadPoll();
      mockGetPrHeadSha.mockReset().mockRejectedValueOnce(new Error("GitHub PR head lookup failed (502): Bad Gateway"));

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 73_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "github_poll_failed" }),
      );
      expect(result.transientDeferred).toBe(1);
    });
  });

  describe("ARC-1407: re-prompt discipline", () => {
    it("does not reclaim a stuck epoch whose prior prompt is still processing on the DO; extends the lease", async () => {
      const stuck = claimedEpoch({ status: "processing", attemptCount: 1, leaseExpiresAt: 1_000, lastPromptId: "p-2" });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);
      mockListSessionPrompts.mockResolvedValueOnce({
        ok: true,
        payload: { queue: { processingPromptId: "p-2" }, prompts: [{ promptId: "p-2", status: "processing" }] },
        status: 200,
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockReclaimStuckReviewLoopEpoch).not.toHaveBeenCalled();
      expect(mockExtendReviewLoopEpochLease).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ expectedLeaseExpiresAt: 1_000 }),
      );
      expect(result.stuckReclaimed).toBe(0);
    });

    it("does not reclaim a stuck epoch when the DO shows no active prompt but the session runtime is still live", async () => {
      const stuck = claimedEpoch({ status: "processing", attemptCount: 1, leaseExpiresAt: 1_000, lastPromptId: "p-2" });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);
      mockListSessionPrompts.mockResolvedValueOnce({
        ok: true,
        payload: { queue: { processingPromptId: null }, prompts: [] },
        status: 200,
      });
      mockIsSessionRuntimeLive.mockResolvedValueOnce(true); // runtime lease still live → agent alive

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockReclaimStuckReviewLoopEpoch).not.toHaveBeenCalled();
      expect(mockExtendReviewLoopEpochLease).toHaveBeenCalled();
    });

    it("reclaims a stuck epoch when the prior prompt is terminal and the runtime is gone", async () => {
      const stuck = claimedEpoch({ status: "processing", attemptCount: 1, leaseExpiresAt: 1_000, lastPromptId: "p-2" });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);
      mockListSessionPrompts.mockResolvedValueOnce({
        ok: true,
        payload: { queue: { processingPromptId: null }, prompts: [{ promptId: "p-2", status: "completed" }] },
        status: 200,
      });
      mockIsSessionRuntimeLive.mockResolvedValueOnce(false); // runtime idle/paused → safe to reclaim

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockReclaimStuckReviewLoopEpoch).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ expectedLeaseExpiresAt: 1_000 }),
      );
      expect(mockExtendReviewLoopEpochLease).not.toHaveBeenCalled();
      expect(result.stuckReclaimed).toBe(1);
    });

    it("falls back to the runtime live-lease with a warning when the DO prompt probe is unavailable", async () => {
      const stuck = claimedEpoch({ status: "processing", attemptCount: 1, leaseExpiresAt: 1_000, lastPromptId: "p-2" });
      mockListStuckReviewLoopEpochs.mockResolvedValueOnce([stuck]);
      mockListSessionPrompts.mockResolvedValueOnce({ ok: false, status: 503, payload: null });
      mockIsSessionRuntimeLive.mockResolvedValueOnce(true); // lease still fresh → treat as alive

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 50_000, logger: logger as never });

      expect(mockReclaimStuckReviewLoopEpoch).not.toHaveBeenCalled();
      expect(mockExtendReviewLoopEpochLease).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "review_loop_reclaim_liveness_probe_degraded" }),
        expect.any(String),
      );
    });

    it("blocks a re-prompt with no new evidence past the one-retry budget", async () => {
      const claimed = claimedEpoch({
        sourceKind: "bot",
        status: "reserving",
        worklistHash: "worklist-hash",
        attemptCount: 3,
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([claimed]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(claimed);
      mockListPromptedReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map(),
        legacySourceIds: new Set<string>(),
      });
      // default worklist mock → non-empty, worklistHash "worklist-hash" (unchanged from claimed)

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "no_new_evidence_reprompt_cap" }),
      );
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(result.blocked).toBe(1);
    });

    it("allows one no-new-evidence re-prompt before the cap fires", async () => {
      const claimed = claimedEpoch({
        sourceKind: "bot",
        status: "reserving",
        worklistHash: "worklist-hash",
        attemptCount: 2,
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([claimed]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(claimed);
      mockListPromptedReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map(),
        legacySourceIds: new Set<string>(),
      });
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "no_new_evidence_reprompt_cap" }),
      );
      expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    });

    it("does not cap when the worklist evidence changed since the last prompt", async () => {
      const claimed = claimedEpoch({
        sourceKind: "bot",
        status: "reserving",
        worklistHash: "stale-hash",
        attemptCount: 4,
      });
      mockListDueReviewLoopEpochs.mockResolvedValueOnce([claimed]);
      mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(claimed);
      mockListPromptedReviewLoopSources.mockResolvedValueOnce({
        promptedAtBySourceId: new Map(),
        legacySourceIds: new Set<string>(),
      });
      // default worklist mock → worklistHash "worklist-hash", which differs from claimed "stale-hash"
      mockEnqueueSessionPrompt.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { prompt: { promptId: "prompt-1", status: "queued" } },
      });

      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

      expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
        env.DB,
        "epoch-1",
        expect.objectContaining({ reason: "no_new_evidence_reprompt_cap" }),
      );
      expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    });
  });
});

// A3 — the run-scoped 1h verification backstop. Under spawn-at-publish a verifier runs while the spine
// row stays in REVIEW; a child that dies WITHOUT emitting a verdict is caught here and terminalized via a
// run-scoped `verification.stopped` (non-blocking — CORE routes it to a record write + NOTIFY_QA_ISSUE, no
// NEEDS_YOU). Real migrated sqlite (the DAO + closeQaLoopBinding are unmocked); the producer is spied.
describe("A3 — fireStuckVerificationBackstops emits a run-scoped stopped verdict for a stuck verification run", () => {
  const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
  const NOW = 3 * 60 * 60 * 1000; // 3h — comfortably past the 1h backstop window
  function migratedDb(): D1Database {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
    return new SqliteD1(sqlite) as unknown as D1Database;
  }

  async function insertActiveQaBinding(
    db: D1Database,
    input: { prUrl: string; lifecycleId: string; qaSessionId: string; headSha: string; updatedAt: number },
  ): Promise<void> {
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

  it("emits verification.stopped (runId-scoped) + closes the binding for a REVIEW row spawned > 1h with no fresh verdict", async () => {
    const { fireStuckVerificationBackstops } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const db = migratedDb();
    // A REVIEW spine row, run 2, stamped child, null verdict (the verifier never reported back).
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-stuck", NOW),
      state: "REVIEW",
      prUrl: "https://github.com/acme/repo/pull/9",
      headSha: "h1",
      verificationRunHead: "h1",
      verificationRunId: 2,
      verificationChildId: "verifier-stuck",
      verdictHeadSha: null,
    });
    // An ACTIVE qa binding whose updated_at (the run-scoped spawn clock) is 2h before nowMs.
    await insertActiveQaBinding(db, {
      prUrl: "https://github.com/acme/repo/pull/9",
      lifecycleId: "sess-stuck",
      qaSessionId: "verifier-stuck",
      headSha: "h1",
      updatedAt: NOW - 2 * 60 * 60 * 1000,
    });
    const waitUntil = vi.fn();

    const result = await fireStuckVerificationBackstops(
      { DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" } as never,
      { nowMs: NOW, limit: 50, waitUntil, logger: logger as never },
    );

    expect(result).toMatchObject({ scanned: 1, fired: 1 });
    expect(mockShadowEmitVerificationOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "sess-stuck",
      expect.objectContaining({ outcome: "stopped", runId: 2, headSha: null }),
      expect.anything(),
      expect.anything(),
    );
    // Idempotency: the binding is closed so the JOIN drops the row on the next sweep.
    const rescan = await fireStuckVerificationBackstops(
      { DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" } as never,
      { nowMs: NOW, limit: 50, waitUntil, logger: logger as never },
    );
    expect(rescan).toMatchObject({ scanned: 0, fired: 0 });
  });

  it("no-ops on an unbound DB", async () => {
    const { fireStuckVerificationBackstops } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    mockShadowEmitVerificationOutcome.mockClear();
    const result = await fireStuckVerificationBackstops({ DB: {} } as never, {
      nowMs: NOW,
      limit: 10,
      logger: logger as never,
    });
    expect(result).toEqual({ scanned: 0, fired: 0 });
    expect(mockShadowEmitVerificationOutcome).not.toHaveBeenCalled();
  });
});

// A3 — the cross-DO dormant-REVIEW `review_stuck` give-up backstop. A REVIEW spine row whose DO went
// dormant (never re-ticks its state-deadline alarm) must still reach NEEDS_YOU(review_stuck) once it
// has dwelt past `REVIEW_STUCK_DEADLINE_MS` (4h). This sweep re-derives the due fire from committed
// state; the §10 `deadline_exceeded` producer (`shadowFireDueDeadline`) is spied, `deadlineWouldFire`
// (the pure pre-check) is real, and the candidate DAO runs against real migrated sqlite.
describe("A3 — fireDwellDueReviewStuckDeadlines fires the review_stuck give-up for a dormant REVIEW row", () => {
  const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
  const NOW = 24 * 60 * 60 * 1000; // 24h — comfortably past the 4h REVIEW-stuck window
  function migratedDb(): D1Database {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
    return new SqliteD1(sqlite) as unknown as D1Database;
  }

  it("fires the deadline for a REVIEW row entered > 4h ago, and skips a fresh REVIEW row", async () => {
    const { fireDwellDueReviewStuckDeadlines } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    mockShadowFireDueDeadline.mockReset().mockResolvedValue({ wouldFire: true, from: "REVIEW", to: "NEEDS_YOU" });
    const db = migratedDb();
    // A dormant REVIEW row: entered REVIEW 5h before now (> the 4h give-up window).
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-review-stuck", NOW - 5 * 60 * 60 * 1000),
      state: "REVIEW",
      prUrl: "https://github.com/acme/repo/pull/11",
      headSha: "h1",
    });
    // A fresh REVIEW row: entered REVIEW only 1h before now (well inside the window).
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-review-fresh", NOW - 60 * 60 * 1000),
      state: "REVIEW",
      prUrl: "https://github.com/acme/repo/pull/12",
      headSha: "h2",
    });
    const waitUntil = vi.fn();

    const result = await fireDwellDueReviewStuckDeadlines(
      { DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" } as never,
      { nowMs: NOW, limit: 50, waitUntil, logger: logger as never },
    );

    // Only the dwelt-past-4h row is a candidate (the DAO bounds on `state_entered_at`), and only it fires.
    expect(result).toMatchObject({ scanned: 1, fired: 1 });
    expect(mockShadowFireDueDeadline).toHaveBeenCalledTimes(1);
    expect(mockShadowFireDueDeadline).toHaveBeenCalledWith(
      expect.anything(),
      "sess-review-stuck",
      NOW,
      expect.anything(),
      undefined,
      waitUntil,
    );
  });

  it("scans but does not fire a REVIEW row with no dwell anchor (pure pre-check guard)", async () => {
    const { fireDwellDueReviewStuckDeadlines } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    mockShadowFireDueDeadline.mockReset().mockResolvedValue({ wouldFire: true, from: "REVIEW", to: "NEEDS_YOU" });
    const db = migratedDb();
    // A legacy/partial REVIEW row with NULL `state_entered_at`: the DAO admits it (COALESCE(anchor,0) is
    // <= the cutoff), but the pure `deadlineWouldFire` pre-check conservatively never fires on a null
    // anchor — so the fire producer is never invoked.
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-review-noanchor", NOW),
      state: "REVIEW",
      stateEnteredAt: null,
      prUrl: "https://github.com/acme/repo/pull/13",
      headSha: "h3",
    });

    const result = await fireDwellDueReviewStuckDeadlines(
      { DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" } as never,
      { nowMs: NOW, limit: 50, logger: logger as never },
    );

    expect(result).toMatchObject({ scanned: 1, fired: 0 });
    expect(mockShadowFireDueDeadline).not.toHaveBeenCalled();
  });

  it("no-ops on an unbound DB", async () => {
    const { fireDwellDueReviewStuckDeadlines } =
      await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    mockShadowFireDueDeadline.mockReset();
    const result = await fireDwellDueReviewStuckDeadlines({ DB: {} } as never, {
      nowMs: NOW,
      limit: 10,
      logger: logger as never,
    });
    expect(result).toEqual({ scanned: 0, fired: 0 });
    expect(mockShadowFireDueDeadline).not.toHaveBeenCalled();
  });
});
