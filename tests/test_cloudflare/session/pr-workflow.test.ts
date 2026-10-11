import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
}));

import * as Sentry from "@sentry/cloudflare";

const mockGetValidGithubToken = vi.fn();
const mockResolveInternalFeatureGateUser = vi.fn();
const mockCreateIssueComment = vi.fn();
const mockCreatePullRequest = vi.fn();
const mockClosePullRequest = vi.fn();
const mockDeleteIssueComment = vi.fn();
const mockEnsureRepoLabel = vi.fn();
const mockGetDefaultBranch = vi.fn();
const mockGetPrHeadSha = vi.fn();
const mockGetPullRequestBodyAndState = vi.fn();
// The review-loop guards now read PR state + head via getPrMergeStatus. Its head derives from the
// same mockGetPrHeadSha the head tests already drive; mockReviewLoopPrState lets a test simulate a
// merged/closed PR (default "open"). Reset in beforeEach.
let mockReviewLoopPrState: "open" | "closed" | "merged" = "open";
const mockGetPrReviewLoopWorklist = vi.fn();
const mockCreatePrReviewCommentReply = vi.fn();
const mockCreatePrIssueComment = vi.fn();
const mockResolvePrReviewThread = vi.fn();
const mockFindOpenPrByHead = vi.fn();
const mockUpdateIssueComment = vi.fn();
const mockUpdatePullRequest = vi.fn();
const mockAddLabels = vi.fn();
const mockListLabels = vi.fn();
const mockRemoveLabel = vi.fn();
const mockSetLabels = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockUpdateCompletionPrUrl = vi.fn();
const mockPostThreadReply = vi.fn();
const mockDeliverThreadStatus = vi.fn();
const mockResolveSlackBotTokenForCallback = vi.fn();
const mockGetReviewLoopEpochById = vi.fn();
const mockMarkReviewLoopEpochBlocked = vi.fn();
const mockMarkReviewLoopEpochCompleted = vi.fn();
const mockCompleteReviewLoopEpochFromVerifiedPush = vi.fn();
const mockMarkReviewLoopEpochPublishing = vi.fn();
const mockMarkReviewLoopEpochWaitingForOwner = vi.fn();
const mockResolveReviewLoopChecklist = vi.fn();
const mockResolveReviewLoopHumanEligibility = vi.fn();
const mockResolveReviewLoopCiEligibility = vi.fn();
const mockResolveReviewLoopMergeConflictEligibility = vi.fn();
const mockBeginReviewLoopOperationAttempt = vi.fn();
const mockGetReviewLoopOperationById = vi.fn();
const mockSelectLatestSucceededReviewLoopPushHead = vi.fn();
const mockCountSucceededReviewLoopOperations = vi.fn();
const mockFillSucceededReviewLoopReplyVerdict = vi.fn();
const mockMarkReviewLoopOperationSucceeded = vi.fn();
const mockMarkReviewLoopOperationFailed = vi.fn();
const mockEmitPrCreatedMetric = vi.fn();
const mockEmitReviewLoopArmedMetric = vi.fn();
const mockGetPrDraftState = vi.fn();
const mockGetPullRequestTitle = vi.fn();
const mockGetPrOverview = vi.fn();
const mockListPrIssueCommentsDetailed = vi.fn();
const mockListPrReviews = vi.fn();
const mockGetPrReviewComments = vi.fn();
const mockMarkPullRequestReadyForReview = vi.fn();
const mockScheduleVerificationForPr = vi.fn();
const mockReconcilePrDraftStateForPr = vi.fn();
const mockClaimSlackPostForDelivery = vi.fn();
const mockDeleteSlackPostMarker = vi.fn();
const mockMarkSlackPostDelivered = vi.fn();
const mockClaimSlackPrMergedPost = vi.fn();
const mockDeleteSlackPrMergedPostMarker = vi.fn();
const mockQueryPlatformStructuredOutput = vi.fn();
const mockPostStructuredEventToDd = vi.fn();
const mockEmitWebhookPrTerminal = vi.fn();

vi.mock("../../../apps/control-plane-worker/src/auth/db", () => ({
  getValidGithubToken: (...args: unknown[]) => mockGetValidGithubToken(...args),
  resolveInternalFeatureGateUser: (...args: unknown[]) => mockResolveInternalFeatureGateUser(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/pr", () => ({
  addLabels: (...args: unknown[]) => mockAddLabels(...args),
  closePullRequest: (...args: unknown[]) => mockClosePullRequest(...args),
  createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
  createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  deleteIssueComment: (...args: unknown[]) => mockDeleteIssueComment(...args),
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  getPrDraftState: (...args: unknown[]) => mockGetPrDraftState(...args),
  getPullRequestTitle: (...args: unknown[]) => mockGetPullRequestTitle(...args),
  getPrOverview: (...args: unknown[]) => mockGetPrOverview(...args),
  listPrIssueCommentsDetailed: (...args: unknown[]) => mockListPrIssueCommentsDetailed(...args),
  listPrReviews: (...args: unknown[]) => mockListPrReviews(...args),
  getPrReviewComments: (...args: unknown[]) => mockGetPrReviewComments(...args),
  markPullRequestReadyForReview: (...args: unknown[]) => mockMarkPullRequestReadyForReview(...args),
  findOpenPrByHead: (...args: unknown[]) => mockFindOpenPrByHead(...args),
  getBranchHeadSha: (...args: unknown[]) => mockGetPrHeadSha(...args),
  getDefaultBranch: (...args: unknown[]) => mockGetDefaultBranch(...args),
  getPrHeadSha: (...args: unknown[]) => mockGetPrHeadSha(...args),
  getPullRequestBodyAndState: (...args: unknown[]) => mockGetPullRequestBodyAndState(...args),
  listLabels: (...args: unknown[]) => mockListLabels(...args),
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
  getPrMergeStatus: async (...args: unknown[]) => ({
    state: mockReviewLoopPrState,
    headSha: await mockGetPrHeadSha(...args),
    mergeable: true,
    mergeableState: "clean",
    rawMergeableState: "clean",
    labels: [],
  }),
  getPrReviewLoopWorklist: (...args: unknown[]) => mockGetPrReviewLoopWorklist(...args),
  createPrReviewCommentReply: (...args: unknown[]) => mockCreatePrReviewCommentReply(...args),
  createPrIssueComment: (...args: unknown[]) => mockCreatePrIssueComment(...args),
  resolvePrReviewThread: (...args: unknown[]) => mockResolvePrReviewThread(...args),
  setLabels: (...args: unknown[]) => mockSetLabels(...args),
  updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
  updatePullRequest: (...args: unknown[]) => mockUpdatePullRequest(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../../apps/control-plane-worker/src/session/fsm/cron-producer", () => ({
  emitWebhookPrTerminal: (...args: unknown[]) => mockEmitWebhookPrTerminal(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/completions-db", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/session/completions-db")>(
    "../../../apps/control-plane-worker/src/session/completions-db",
  );
  return {
    ...actual,
    updateCompletionPrUrlForPrompt: (...args: unknown[]) => mockUpdateCompletionPrUrl(...args),
    updateCompletionPrUrlForSession: (...args: unknown[]) => mockUpdateCompletionPrUrl(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/session/slack-posts-db", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/session/slack-posts-db")>(
    "../../../apps/control-plane-worker/src/session/slack-posts-db",
  );
  return {
    ...actual,
    claimSlackPostForDelivery: (...args: unknown[]) => mockClaimSlackPostForDelivery(...args),
    deleteSlackPostMarker: (...args: unknown[]) => mockDeleteSlackPostMarker(...args),
    markSlackPostDelivered: (...args: unknown[]) => mockMarkSlackPostDelivered(...args),
    claimSlackPrMergedPost: (...args: unknown[]) => mockClaimSlackPrMergedPost(...args),
    deleteSlackPrMergedPostMarker: (...args: unknown[]) => mockDeleteSlackPrMergedPostMarker(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/notify", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/slack/notify")>(
    "../../../apps/control-plane-worker/src/slack/notify",
  );
  return {
    ...actual,
    deliverThreadStatus: (...args: unknown[]) => mockDeliverThreadStatus(...args),
    postThreadReply: (...args: unknown[]) => mockPostThreadReply(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/tokens", () => ({
  resolveSlackBotTokenForCallback: (...args: unknown[]) => mockResolveSlackBotTokenForCallback(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/services/review-loop-epochs", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/services/review-loop-epochs")
  >("../../../apps/control-plane-worker/src/services/review-loop-epochs");
  return {
    ...actual,
    getReviewLoopEpochById: (...args: unknown[]) => mockGetReviewLoopEpochById(...args),
    markReviewLoopEpochBlocked: (...args: unknown[]) => mockMarkReviewLoopEpochBlocked(...args),
    markReviewLoopEpochCompleted: (...args: unknown[]) => mockMarkReviewLoopEpochCompleted(...args),
    completeReviewLoopEpochFromVerifiedPush: (...args: unknown[]) =>
      mockCompleteReviewLoopEpochFromVerifiedPush(...args),
    markReviewLoopEpochPublishing: (...args: unknown[]) => mockMarkReviewLoopEpochPublishing(...args),
    markReviewLoopEpochWaitingForOwner: (...args: unknown[]) => mockMarkReviewLoopEpochWaitingForOwner(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/services/review-loop-settings", () => ({
  resolveReviewLoopChecklist: (...args: unknown[]) => mockResolveReviewLoopChecklist(...args),
  resolveReviewLoopHumanEligibility: (...args: unknown[]) => mockResolveReviewLoopHumanEligibility(...args),
  resolveReviewLoopCiEligibility: (...args: unknown[]) => mockResolveReviewLoopCiEligibility(...args),
  resolveReviewLoopMergeConflictEligibility: (...args: unknown[]) =>
    mockResolveReviewLoopMergeConflictEligibility(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/observability/pr-metrics", () => ({
  emitPrCreatedMetric: (...args: unknown[]) => mockEmitPrCreatedMetric(...args),
  emitReviewLoopArmedMetric: (...args: unknown[]) => mockEmitReviewLoopArmedMetric(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/services/review-loop-operations", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/services/review-loop-operations")
  >("../../../apps/control-plane-worker/src/services/review-loop-operations");
  return {
    ...actual,
    beginReviewLoopOperationAttempt: (...args: unknown[]) => mockBeginReviewLoopOperationAttempt(...args),
    getReviewLoopOperationById: (...args: unknown[]) => mockGetReviewLoopOperationById(...args),
    selectLatestSucceededReviewLoopPushHead: (...args: unknown[]) =>
      mockSelectLatestSucceededReviewLoopPushHead(...args),
    countSucceededReviewLoopOperations: (...args: unknown[]) => mockCountSucceededReviewLoopOperations(...args),
    fillSucceededReviewLoopReplyVerdict: (...args: unknown[]) => mockFillSucceededReviewLoopReplyVerdict(...args),
    markReviewLoopOperationSucceeded: (...args: unknown[]) => mockMarkReviewLoopOperationSucceeded(...args),
    markReviewLoopOperationFailed: (...args: unknown[]) => mockMarkReviewLoopOperationFailed(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: (...args: unknown[]) => mockScheduleVerificationForPr(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/pr-draft-reconciliation", () => ({
  reconcilePrDraftStateForPr: (...args: unknown[]) => mockReconcilePrDraftStateForPr(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/services/platform-structured-output", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/services/platform-structured-output")
  >("../../../apps/control-plane-worker/src/services/platform-structured-output");
  return {
    ...actual,
    queryPlatformStructuredOutput: (...args: unknown[]) => mockQueryPlatformStructuredOutput(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import {
  ARCANIST_SCHEDULED_LABEL,
  CYCLOID_MEMORY_LABEL,
  CYCLOID_PR_LABEL,
} from "../../../apps/control-plane-worker/src/constants/pr-labels";
import {
  PR_READINESS_STORAGE_KEY,
  PUBLISHING_PROMPT_ID_STORAGE_KEY,
} from "../../../apps/control-plane-worker/src/constants/sessions";
import { InitiationMode } from "../../../apps/control-plane-worker/src/enums/initiation-mode";
import { SessionEntrypoint } from "../../../apps/control-plane-worker/src/enums/session-entrypoint";
import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import {
  PUBLISH_PR_TITLE_MODEL,
  PUBLISH_PR_TITLE_SYSTEM_PROMPT,
} from "../../../apps/control-plane-worker/src/services/publish-pr-title";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db";
import { fallbackPrTitle } from "../../../apps/control-plane-worker/src/session/pr-body";
import type { ResolvedPrUpdateContext } from "../../../apps/control-plane-worker/src/session/pr-github-ops";
import { MAX_PR_TITLE_LENGTH } from "../../../apps/control-plane-worker/src/session/pr-title";
import { PrTitleReconciler } from "../../../apps/control-plane-worker/src/session/pr-title-reconciler";
import { createSessionPrWorkflow } from "../../../apps/control-plane-worker/src/session/pr-workflow";
import { SessionPublishService } from "../../../apps/control-plane-worker/src/session/publish-service";
import type { UserSettingsCache } from "../../../apps/control-plane-worker/src/settings/db";
import type { ExecutionVerification, PromptState } from "../../../apps/control-plane-worker/src/types";
import { CYCLOID_CO_AUTHOR_TRAILER } from "../../../shared/constants/git-identity";
import { FakeStorage, seedPrompt, seedSession } from "./helpers.ts";

const SESSION_ID = "session-pr-workflow";

function promptState(prompt: string, overrides: Partial<PromptState> = {}): PromptState {
  const timestamp = new Date().toISOString();
  return {
    promptId: "prompt-1",
    prompt,
    actorUserId: "user-1",
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    result: null,
    error: null,
    ...overrides,
  };
}

function createHost(storage: FakeStorage, envOverrides: Record<string, unknown> = {}) {
  const waitUntil = vi.fn();
  const broadcast = vi.fn();
  const appendAndMirrorEvents = vi.fn(async () => ({
    replay: {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    },
    events: [],
  }));
  const upsertPrWebhookRef = vi.fn().mockResolvedValue(undefined);
  const enterReviewListening = vi.fn().mockResolvedValue(undefined);
  const setVerificationStateForPr = vi.fn().mockResolvedValue(undefined);
  const exitReviewListening = vi.fn().mockResolvedValue(undefined);
  const getDefaultPrDraft = vi.fn(async () => false);
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  return {
    host: {
      state: { storage } as DurableObjectState,
      env: {
        DB: {} as D1Database,
        FRONTEND_URL: "https://app.trycycloid.com",
        SLACK_BOT_TOKEN: "xoxb-test",
        ...envOverrides,
      } as never,
      log: logger,
      waitUntil,
      broadcast,
      appendAndMirrorEvents,
      fetchInternal: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
      upsertPrWebhookRef,
      enterReviewListening,
      setVerificationStateForPr,
      exitReviewListening,
      rescheduleSessionAlarm: vi.fn(async () => {}),
      getDefaultPrDraft,
    },
    waitUntil,
    broadcast,
    appendAndMirrorEvents,
    upsertPrWebhookRef,
    enterReviewListening,
    setVerificationStateForPr,
    exitReviewListening,
    getDefaultPrDraft,
    logger,
  };
}

function makeReviewLoopEpoch(overrides: Record<string, unknown> = {}) {
  return {
    id: "epoch-1",
    sessionId: SESSION_ID,
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "deadbeef",
    expectedBotsHash: "bots-hash",
    status: "processing",
    lastPromptId: "prompt-1",
    ...overrides,
  };
}

function makePrReadiness() {
  return {
    changedFiles: ["apps/sandbox-bridge/src/services/pr.ts"],
    diffStats: { raw: "1 file changed, 5 insertions(+)", filesChanged: 1, insertions: 5, deletions: 0 },
    commandsRun: [
      {
        command: "npm run test -- tests/test_sandbox-bridge/pr.test.ts",
        status: "completed" as const,
        source: "post_execution" as const,
        check: "tests" as const,
        exitCode: 0,
      },
    ],
    checksDetected: { tests: true, lint: false, typecheck: false },
    skippedChecks: [],
    filesMentionedInFinalAnswer: [],
    evidenceBundle: {
      sessionUrl: "https://app.trycycloid.com/sessions/session-pr-workflow",
      issueUrl: "https://linear.app/acme/issue/ARC-999/compact-pr-body",
      originalPrompt: "Tighten the publish pipeline output.",
    },
  };
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(message);
    },
    { timeout: 2000, interval: 10 },
  );
}

// Keep required checks running after a base retarget.
describe("pr-workflow helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetValidGithubToken.mockResolvedValue("ghu_test");
    mockResolveInternalFeatureGateUser.mockResolvedValue(null);
    mockCreateIssueComment.mockResolvedValue(9001);
    mockEnsureRepoLabel.mockResolvedValue({ ok: true, created: false });
    mockCreatePullRequest.mockResolvedValue({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      created: true,
    });
    mockClosePullRequest.mockResolvedValue(undefined);
    mockGetPrOverview.mockResolvedValue({
      number: 42,
      title: "Session PR",
      state: "open",
      draft: false,
      author: "octocat",
      url: "https://github.com/acme/repo/pull/42",
      body: "PR body",
      baseRef: "main",
      headRef: "feature",
      labels: ["cycloid"],
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
    });
    mockListPrIssueCommentsDetailed.mockResolvedValue({ comments: [], truncated: false });
    mockListPrReviews.mockResolvedValue({ reviews: [], truncated: false });
    mockGetPrReviewComments.mockResolvedValue([]);
    mockGetDefaultBranch.mockResolvedValue("main");
    mockGetPrHeadSha.mockResolvedValue("deadbeef");
    mockGetPullRequestBodyAndState.mockResolvedValue({ body: "", state: "open" });
    mockPostStructuredEventToDd.mockResolvedValue(true);
    mockEmitWebhookPrTerminal.mockResolvedValue(undefined);
    mockReviewLoopPrState = "open";
    mockGetPrReviewLoopWorklist.mockReset();
    mockGetPrReviewLoopWorklist.mockResolvedValue({
      items: [
        {
          sourceId: "review-comment:10",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r10",
          reviewThreadId: "PRRT_thread10",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Please fix this.",
          path: "src/foo.ts",
          line: 10,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
        {
          sourceId: "issue-comment:20",
          sourceUrl: "https://github.com/acme/repo/pull/42#issuecomment-20",
          authorLogin: "coderabbitai[bot]",
          authorType: "Bot",
          body: "Top-level finding.",
          path: null,
          line: null,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
    });
    mockFindOpenPrByHead.mockResolvedValue(null);
    mockUpdateIssueComment.mockResolvedValue(undefined);
    mockUpdatePullRequest.mockResolvedValue(undefined);
    mockCreatePrReviewCommentReply.mockResolvedValue({
      id: 987,
      htmlUrl: "https://github.com/acme/repo/pull/42#discussion_r987",
    });
    mockCreatePrIssueComment.mockResolvedValue({
      id: 654,
      htmlUrl: "https://github.com/acme/repo/pull/42#issuecomment-654",
    });
    mockResolvePrReviewThread.mockResolvedValue(undefined);
    mockAddLabels.mockResolvedValue(undefined);
    mockListLabels.mockResolvedValue([]);
    mockRemoveLabel.mockResolvedValue(undefined);
    mockSetLabels.mockResolvedValue(undefined);
    mockCreateInstallationToken.mockResolvedValue("ghs_install");
    mockUpdateCompletionPrUrl.mockResolvedValue(undefined);
    mockClaimSlackPrMergedPost.mockResolvedValue(true);
    mockDeleteSlackPrMergedPostMarker.mockResolvedValue(undefined);
    mockPostThreadReply.mockResolvedValue({ ok: true, ts: "200.100" });
    mockDeliverThreadStatus.mockResolvedValue({ ok: true, updatedInPlace: true });
    mockResolveSlackBotTokenForCallback.mockResolvedValue("xoxb-test");
    mockClaimSlackPostForDelivery.mockResolvedValue(true);
    mockDeleteSlackPostMarker.mockResolvedValue(undefined);
    mockMarkSlackPostDelivered.mockResolvedValue(undefined);
    mockGetReviewLoopEpochById.mockResolvedValue(null);
    mockMarkReviewLoopEpochBlocked.mockResolvedValue(null);
    mockMarkReviewLoopEpochCompleted.mockResolvedValue(null);
    mockCompleteReviewLoopEpochFromVerifiedPush.mockResolvedValue(null);
    mockMarkReviewLoopEpochPublishing.mockResolvedValue(
      makeReviewLoopEpoch({ status: "publishing", worklistHash: "worklist-hash" }),
    );
    mockMarkReviewLoopEpochWaitingForOwner.mockResolvedValue(null);
    mockResolveReviewLoopChecklist.mockResolvedValue({
      ok: true,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "bots-hash",
      installationId: 123,
    });
    mockResolveReviewLoopHumanEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 123 });
    // Default CI gate to eligible (capabilities present). Post-ARC-1288 resolveReviewLoopCiEligibility
    // is capability-only, and the publish gate consults it to verify capabilities when the bot
    // checklist short-circuits on empty/changed bots — a not-ok result there means caps are missing.
    mockResolveReviewLoopCiEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 123 });
    mockResolveReviewLoopMergeConflictEligibility.mockResolvedValue({
      ok: true,
      ownerUserId: 101,
      installationId: 123,
    });
    mockBeginReviewLoopOperationAttempt.mockResolvedValue({
      status: "started",
      operation: { operationId: "op-1", status: "running", attempts: 1, githubId: null },
    });
    mockGetReviewLoopOperationById.mockResolvedValue(null);
    // Default: no prior succeeded push for the epoch, so the reply head guard accepts only
    // epoch.headSha (pre-#4987 reply behavior). Self-head-advance tests override this.
    mockSelectLatestSucceededReviewLoopPushHead.mockResolvedValue(null);
    mockCountSucceededReviewLoopOperations.mockResolvedValue(2);
    mockFillSucceededReviewLoopReplyVerdict.mockImplementation(async (_db, operationId, options) => ({
      operationId,
      status: "succeeded",
      attempts: 1,
      githubId: "987",
      verdict: options.verdict,
      verdictBasis: null,
    }));
    mockMarkReviewLoopOperationSucceeded.mockResolvedValue({ operationId: "op-1", status: "succeeded" });
    mockMarkReviewLoopOperationFailed.mockResolvedValue({ operationId: "op-1", status: "failed" });
    mockEmitPrCreatedMetric.mockResolvedValue(undefined);
    mockEmitReviewLoopArmedMetric.mockResolvedValue(undefined);
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: false });
    mockGetPullRequestTitle.mockResolvedValue("Existing PR title");
    mockMarkPullRequestReadyForReview.mockResolvedValue(undefined);
    mockScheduleVerificationForPr.mockResolvedValue({
      scheduled: true,
      sessionId: "verify-session-1",
    });
    mockReconcilePrDraftStateForPr.mockResolvedValue({ sessionCount: 1, updated: 1, skipped: 0, failed: 0 });
    mockQueryPlatformStructuredOutput.mockResolvedValue({ title: "Tighten publish readiness rendering" });
  });

  // Returns the payload of the most recent updatePullRequest call that wrote a
  // body. A republish now issues a separate title PATCH after the body update,
  // so `mock.calls.at(-1)` is not reliably the body write.
  function lastPrBodyUpdate(): { body: string } {
    const bodyCalls = mockUpdatePullRequest.mock.calls.filter(
      (call) => (call[4] as { body?: string })?.body !== undefined,
    );
    return bodyCalls[bodyCalls.length - 1]?.[4] as { body: string };
  }

  function makeTitleContext(sql: SqlStorage): ResolvedPrUpdateContext {
    return {
      sessionId: SESSION_ID,
      token: "ghu_test",
      tokenSource: "user",
      installationToken: null,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      ext: doDb.getSessionExtended(sql, SESSION_ID),
    };
  }

  async function drainWaitUntil(waitUntil: ReturnType<typeof vi.fn>, callIndex = waitUntil.mock.calls.length - 1) {
    const promise = waitUntil.mock.calls[callIndex]?.[0];
    expect(promise).toBeInstanceOf(Promise);
    await promise;
  }

  async function drainAllWaitUntil(waitUntil: ReturnType<typeof vi.fn>) {
    const promises = waitUntil.mock.calls.map((call) => call[0]);
    for (const promise of promises) {
      expect(promise).toBeInstanceOf(Promise);
      await promise;
    }
  }

  function seedVisualArtifact(storage: FakeStorage): void {
    doDb.insertSessionArtifact(storage.sql as unknown as SqlStorage, {
      artifactId: "artifact-after",
      sessionId: SESSION_ID,
      type: "screenshot",
      url: `https://app.trycycloid.com/api/sessions/${SESSION_ID}/artifacts/artifact-after/after.png`,
      metadata: {
        label: "After",
        filename: "after.png",
        contentType: "image/png",
      },
      createdAt: Date.now(),
    });
  }

  it("applyResolvedTitle records a genuine create baseline without reading or patching GitHub", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    const sql = storage.sql as unknown as SqlStorage;
    const reconciler = new PrTitleReconciler(
      sql,
      createHost(storage).logger,
      {
        getPrTitle: mockGetPullRequestTitle,
        updatePrTitle: mockUpdatePullRequest,
      } as never,
      vi.fn(),
    );

    await reconciler.applyResolvedTitle(SESSION_ID, makeTitleContext(sql), 42, "Brand new PR title", null, {
      created: true,
    });

    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("Brand new PR title");
    expect(mockGetPullRequestTitle).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
  });

  it("applyResolvedTitle reconciles an adopted or existing PR through the live title path", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    const sql = storage.sql as unknown as SqlStorage;
    mockGetPullRequestTitle.mockResolvedValue("Old Cycloid title");
    const reconciler = new PrTitleReconciler(
      sql,
      createHost(storage).logger,
      {
        getPrTitle: mockGetPullRequestTitle,
        updatePrTitle: mockUpdatePullRequest,
      } as never,
      vi.fn(),
    );

    const context = makeTitleContext(sql);

    await reconciler.applyResolvedTitle(SESSION_ID, context, 42, "New republish title", "Old Cycloid title", {
      created: false,
    });

    expect(mockGetPullRequestTitle).toHaveBeenCalled();
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ repoOwner: "acme", repoName: "repo", prNumber: 42 }),
      "New republish title",
    );
    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("New republish title");
  });

  it("applyDeferredGeneratedTitle skips when a human renamed before the background patch", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    const sql = storage.sql as unknown as SqlStorage;
    mockGetPullRequestTitle.mockResolvedValue("Human renamed title");
    const reconciler = new PrTitleReconciler(
      sql,
      createHost(storage).logger,
      {
        getPrTitle: mockGetPullRequestTitle,
        updatePrTitle: mockUpdatePullRequest,
      } as never,
      vi.fn(),
    );

    await reconciler.applyDeferredGeneratedTitle(
      SESSION_ID,
      makeTitleContext(sql),
      42,
      "Original generated title",
      "Tighten publish readiness rendering",
    );

    expect(mockGetPullRequestTitle).toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("Original generated title");
  });

  async function triggerDraftPrCreation(workflow: ReturnType<typeof createSessionPrWorkflow>): Promise<void> {
    // A manual-review publish means verification was skipped/failed, but coding
    // agent PRs are still opened ready for review on GitHub.
    const verification: ExecutionVerification = {
      verified: true,
      status: "manual_review_required",
      publishMode: "draft",
      manualReviewReason: "verification skipped",
      explanation: "verification skipped",
    };
    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/draft-skip",
      "Draft skip review loop",
      undefined,
      undefined,
      verification,
      undefined,
      "prompt-1",
    );
  }

  it("forwards the per-user default-PR-draft setting to GitHub on a new PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Open as draft per user preference",
      actorUserId: "1001",
      status: "completed",
    });

    const { host, getDefaultPrDraft } = createHost(storage);
    getDefaultPrDraft.mockResolvedValue(true);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(getDefaultPrDraft).toHaveBeenCalledWith("1001");
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
  });

  it("persists the ready state returned by a draft-downgrade PR creation", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Open as draft, fallback ready when unsupported",
      actorUserId: "1001",
      status: "completed",
    });
    mockCreatePullRequest.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      branchName: "feature/draft-skip",
      created: true,
      actualDraft: false,
    });

    const { host, getDefaultPrDraft, broadcast } = createHost(storage);
    getDefaultPrDraft.mockResolvedValue(true);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prDraft).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_created", draft: true }));
    expect(mockEmitPrCreatedMetric).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ draft: false }));
  });

  it("does not schedule a verifier after manual-review PR creation by default", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix draft verification policy",
      actorUserId: "1001",
      status: "completed",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
  });

  it("does not schedule a verifier when the session opted out of auto-verification", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      autoVerifyDisabled: 1,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Smoke session with auto-verify opt-out",
      actorUserId: "1001",
      status: "completed",
    });

    const { host, setVerificationStateForPr } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
    expect(setVerificationStateForPr).not.toHaveBeenCalled();
  });

  it("does not schedule a verifier when verification policy is disabled", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix disabled verification policy",
      actorUserId: "1001",
      status: "completed",
    });

    const { host } = createHost(storage, { VERIFICATION_POLICY: "disabled" });
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
  });

  it("does not schedule a verifier after manual-review PR creation when policy is auto", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix auto verification policy",
      actorUserId: "1001",
      status: "completed",
    });

    const { host } = createHost(storage, { VERIFICATION_POLICY: "auto_after_review_loop" });
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
  });

  it("does not schedule a verifier after manual-review PR update when policy is auto", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "1001",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Update auto verifier draft",
      actorUserId: "1001",
      status: "completed",
    });
    const verification: ExecutionVerification = {
      verified: true,
      status: "manual_review_required",
      publishMode: "draft",
      explanation: "verification deferred",
    };

    const { host } = createHost(storage, { VERIFICATION_POLICY: "auto_after_review_loop" });
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/draft-update",
      "Updated draft verification",
      undefined,
      undefined,
      verification,
      undefined,
      "prompt-1",
    );

    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
  });

  it("reconciles the generic cycloid label when creating a session PR", async () => {
    mockListLabels.mockResolvedValueOnce([CYCLOID_MEMORY_LABEL, "verification-done"]);
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-label", "Add a durable PR label");

    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      CYCLOID_PR_LABEL,
      "5319e7",
      "Created by Cycloid",
    );
    expect(mockListLabels).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42);
    expect(mockAddLabels).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
    expect(mockRemoveLabel).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, CYCLOID_MEMORY_LABEL);
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it("includes the session transcript link when creating public-repo PRs", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      repoPrivate: 0,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/public-pr", "Update public repo behavior");

    const body = (mockCreatePullRequest.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("📋 [Session transcript](https://app.trycycloid.com/sessions/session-pr-workflow)");
  });

  it.each([SessionEntrypoint.SCHEDULED, null])(
    "reconciles scheduled automation PRs to only the scheduled provenance label (entrypoint: %s)",
    async (entrypoint) => {
      mockListLabels.mockResolvedValueOnce([
        CYCLOID_PR_LABEL,
        CYCLOID_MEMORY_LABEL,
        "verification-done",
        "review-loop:ci-red",
      ]);
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "user-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        initiationMode: InitiationMode.AUTOMATION,
        entrypoint: entrypoint ?? undefined,
        scheduledRuleId: "rule-1",
      });

      const { host } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      await workflow.triggerPrCreation(SESSION_ID, "feature/scheduled-pr-label", "Add a durable PR label");

      expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
        "ghu_test",
        "acme",
        "repo",
        ARCANIST_SCHEDULED_LABEL,
        "5319e7",
        "Created by a Cycloid scheduled run",
      );
      expect(mockAddLabels).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, [ARCANIST_SCHEDULED_LABEL]);
      expect(mockRemoveLabel).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, CYCLOID_PR_LABEL);
      expect(mockRemoveLabel).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, CYCLOID_MEMORY_LABEL);
      expect(mockSetLabels).not.toHaveBeenCalled();
    },
  );

  it("reconciles the generic cycloid label when updating an existing session PR", async () => {
    mockListLabels.mockResolvedValueOnce([ARCANIST_SCHEDULED_LABEL, CYCLOID_MEMORY_LABEL, "verification-done"]);
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(SESSION_ID, "feature/pr-label", "Update existing PR");

    expect(mockAddLabels).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
    expect(mockRemoveLabel).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, ARCANIST_SCHEDULED_LABEL);
    expect(mockRemoveLabel).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, CYCLOID_MEMORY_LABEL);
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it.each([
    { name: "attached PR update", attached: true },
    { name: "created === false adoption", attached: false },
  ])(
    "preserves external PR metadata and release-evidence body for $name while completing publish",
    async ({ attached }) => {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        ...(attached ? { prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 } : {}),
        adoptedExternalPr: 1,
      });
      seedVisualArtifact(storage);
      mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: true });
      if (!attached) {
        mockCreatePullRequest.mockResolvedValueOnce({
          prUrl: "https://github.com/acme/repo/pull/42",
          prNumber: 42,
          branchName: "feature/adopted-external",
          created: false,
        });
      }

      const { host, waitUntil } = createHost(storage);
      const publishService = new SessionPublishService(host);
      const seams = publishService as unknown as {
        ensurePrReadyForPublish: (...args: unknown[]) => Promise<boolean>;
        scheduleDeferredDiffAwareTitle: (...args: unknown[]) => void;
        scheduleDeferredPrTemplateFill: (...args: unknown[]) => void;
        recordPublishedPr: (...args: unknown[]) => Promise<void>;
        runPublishSideEffects: (...args: unknown[]) => Promise<void>;
        shadowEmitFsmPublishEvent: (...args: unknown[]) => Promise<void>;
        titleReconciler: { applyResolvedTitle: (...args: unknown[]) => Promise<void> };
        github: { applyProvenanceLabel: (...args: unknown[]) => Promise<void> };
      };
      const ensureReadySpy = vi.spyOn(seams, "ensurePrReadyForPublish");
      const titleSpy = vi.spyOn(seams.titleReconciler, "applyResolvedTitle");
      const diffAwareTitleSpy = vi.spyOn(seams, "scheduleDeferredDiffAwareTitle").mockImplementation(() => {});
      const templateFillSpy = vi.spyOn(seams, "scheduleDeferredPrTemplateFill").mockImplementation(() => {});
      const provenanceSpy = vi.spyOn(seams.github, "applyProvenanceLabel");
      const recordSpy = vi.spyOn(seams, "recordPublishedPr");
      const sideEffectsSpy = vi.spyOn(seams, "runPublishSideEffects");
      const fsmPublishSpy = vi.spyOn(seams, "shadowEmitFsmPublishEvent");

      const result = await publishService.publishSessionResult({
        sessionId: SESSION_ID,
        branch: "feature/adopted-external",
        commitSha: "deadbeef",
        prTitle: "Cycloid replacement title",
        prBody: "Cycloid replacement body",
        prReadiness: makePrReadiness(),
        prTemplateFill: {
          template: { source: "repo_local", path: ".github/pull_request_template.md", content: "## Description\n" },
          input: {
            headings: ["Description"],
            narrative: "Cycloid replacement body",
            taskPrompt: "Update the adopted PR.",
            diffSummary: "Updated the adopted PR.",
            commands: [],
            evidenceUrls: [],
          },
          generatedBody: "Cycloid replacement body",
        },
      });

      expect(result).toEqual(expect.objectContaining({ ok: true, status: "published", prNumber: 42 }));
      await drainAllWaitUntil(waitUntil);
      expect(mockGetPrDraftState).toHaveBeenCalledWith(expect.anything(), "acme", "repo", 42);
      expect(ensureReadySpy).not.toHaveBeenCalled();
      expect(mockMarkPullRequestReadyForReview).not.toHaveBeenCalled();
      expect(mockGetPullRequestBodyAndState).not.toHaveBeenCalled();
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
      expect(host.fetchInternal).not.toHaveBeenCalled();
      expect(titleSpy).not.toHaveBeenCalled();
      expect(diffAwareTitleSpy).not.toHaveBeenCalled();
      expect(templateFillSpy).not.toHaveBeenCalled();
      expect(provenanceSpy).not.toHaveBeenCalled();
      expect(recordSpy).toHaveBeenCalledWith(
        SESSION_ID,
        "https://github.com/acme/repo/pull/42",
        42,
        "feature/adopted-external",
        expect.objectContaining({ draft: true }),
        undefined,
      );
      expect(sideEffectsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          prUrl: "https://github.com/acme/repo/pull/42",
          prNumber: 42,
          actualDraft: true,
        }),
      );
      expect(fsmPublishSpy).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ event: expect.objectContaining({ type: "publish.pr_opened" }) }),
        "https://github.com/acme/repo/pull/42",
        expect.any(Object),
      );
      expect(doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID)).toMatchObject({
        publishStatus: "published",
        prDraft: true,
      });
    },
  );

  it("keeps every normal existing-PR metadata reconciliation step enabled", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      adoptedExternalPr: 0,
    });
    seedVisualArtifact(storage);
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: true });

    const { host, waitUntil } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const seams = publishService as unknown as {
      ensurePrReadyForPublish: (...args: unknown[]) => Promise<boolean>;
      scheduleDeferredDiffAwareTitle: (...args: unknown[]) => void;
      scheduleDeferredPrTemplateFill: (...args: unknown[]) => void;
      titleReconciler: { applyResolvedTitle: (...args: unknown[]) => Promise<void> };
      github: { applyProvenanceLabel: (...args: unknown[]) => Promise<void> };
    };
    const ensureReadySpy = vi.spyOn(seams, "ensurePrReadyForPublish");
    const titleSpy = vi.spyOn(seams.titleReconciler, "applyResolvedTitle");
    const diffAwareTitleSpy = vi.spyOn(seams, "scheduleDeferredDiffAwareTitle").mockImplementation(() => {});
    const templateFillSpy = vi.spyOn(seams, "scheduleDeferredPrTemplateFill").mockImplementation(() => {});
    const provenanceSpy = vi.spyOn(seams.github, "applyProvenanceLabel");

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/normal-update",
      commitSha: "deadbeef",
      prTitle: "Normal replacement title",
      prBody: "Normal replacement body",
      prReadiness: makePrReadiness(),
      prTemplateFill: {
        template: { source: "repo_local", path: ".github/pull_request_template.md", content: "## Description\n" },
        input: {
          headings: ["Description"],
          narrative: "Normal replacement body",
          taskPrompt: "Update the normal PR.",
          diffSummary: "Updated the normal PR.",
          commands: [],
          evidenceUrls: [],
        },
        generatedBody: "Normal replacement body",
      },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    await drainAllWaitUntil(waitUntil);
    expect(ensureReadySpy).toHaveBeenCalledOnce();
    expect(mockMarkPullRequestReadyForReview).toHaveBeenCalledWith(expect.anything(), "PR_node_42");
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ body: expect.any(String) }),
    );
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ body: expect.stringContaining("<!-- cycloid:managed:start visualEvidence -->") }),
    );
    expect(host.fetchInternal).toHaveBeenCalled();
    expect(titleSpy).toHaveBeenCalledOnce();
    expect(diffAwareTitleSpy).toHaveBeenCalledOnce();
    expect(templateFillSpy).toHaveBeenCalledOnce();
    expect(provenanceSpy).toHaveBeenCalledOnce();
  });

  it("reconciles the generic cycloid label when adopting an existing branch PR", async () => {
    mockCreatePullRequest.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      branchName: "feature/adopted-pr",
      created: false,
    });
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/adopted-pr", "Adopt branch PR");

    expect(mockAddLabels).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it("retries generic cycloid label reconciliation with the installation token after a user token auth failure", async () => {
    mockAddLabels.mockRejectedValueOnce(new Error("GitHub labels failed (401): Bad credentials"));
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
      repoPrivate: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-label", "Add a durable PR label");

    expect(mockAddLabels).toHaveBeenNthCalledWith(1, "ghu_test", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
    expect(mockAddLabels).toHaveBeenNthCalledWith(2, "ghs_install", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
  });

  it("retries generic cycloid label creation with the installation token after user permission denial", async () => {
    mockEnsureRepoLabel
      .mockResolvedValueOnce({ ok: false, reason: "permission_denied", status: 401, detail: "bad credentials" })
      .mockResolvedValueOnce({ ok: true, created: false });
    mockAddLabels.mockRejectedValueOnce(new Error("GitHub labels failed (401): Bad credentials"));
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
      repoPrivate: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-label", "Add a durable PR label");

    expect(mockEnsureRepoLabel).toHaveBeenNthCalledWith(
      1,
      "ghu_test",
      "acme",
      "repo",
      CYCLOID_PR_LABEL,
      "5319e7",
      "Created by Cycloid",
    );
    expect(mockEnsureRepoLabel).toHaveBeenNthCalledWith(
      2,
      "ghs_install",
      "acme",
      "repo",
      CYCLOID_PR_LABEL,
      "5319e7",
      "Created by Cycloid",
    );
    expect(mockAddLabels).toHaveBeenNthCalledWith(1, "ghu_test", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
    expect(mockAddLabels).toHaveBeenNthCalledWith(2, "ghs_install", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
  });

  it("does not fail PR creation when the generic cycloid label is unavailable", async () => {
    mockEnsureRepoLabel.mockResolvedValueOnce({
      ok: false,
      reason: "permission_denied",
      status: 403,
      detail: "forbidden",
    });
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-label", "Add a durable PR label");

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, [CYCLOID_PR_LABEL]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cycloid_label_unavailable",
        sessionId: SESSION_ID,
        prNumber: 42,
        reason: "permission_denied",
        status: 403,
      }),
      "Could not apply cycloid label",
    );
  });

  it("does not fail PR creation when provenance label listing fails", async () => {
    mockListLabels.mockRejectedValueOnce(new Error("GitHub list labels failed"));
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-label", "Add a durable PR label");

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cycloid_label_unavailable",
        sessionId: SESSION_ID,
        prNumber: 42,
        reason: "exception",
      }),
      "Could not apply cycloid label",
    );
  });

  it("does not fail PR creation when provenance label reconciliation fails", async () => {
    mockAddLabels.mockRejectedValueOnce(new Error("GitHub add labels failed"));
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-label", "Add a durable PR label");

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cycloid_label_unavailable",
        sessionId: SESSION_ID,
        prNumber: 42,
        reason: "exception",
      }),
      "Could not apply cycloid label",
    );
  });

  it("skips webhook metadata lines when falling back to prompt-derived PR titles", () => {
    expect(
      fallbackPrTitle([
        promptState(
          [
            "Repository: trycycloid/cycloid",
            "Linear Issue: ARC-123",
            "Issue URL: https://linear.app/acme/issue/ARC-123/fix-pr-title-generation",
            "Issue title: Repository: trycycloid/cycloid",
            "<user_content>",
            "Fix PR title generation",
            "</user_content>",
          ].join("\n"),
        ),
      ]),
    ).toBe("Fix PR title generation");
  });

  it("uses the latest prompt and strips markdown markers when falling back to prompt-derived PR titles", () => {
    expect(
      fallbackPrTitle([
        promptState("Old request", { promptId: "prompt-1" }),
        promptState("Planning details", { promptId: "prompt-2" }),
        promptState("- [x] Fix PR title generation", { promptId: "prompt-3" }),
      ]),
    ).toBe("Fix PR title generation");
  });

  it("does not title a PR from a review-loop turn's agent-machinery footer", () => {
    // Republish with an empty session title: the latest prompt is a review-loop turn whose raw text
    // is agent machinery (epoch marker, worklist `Source:` lines). `fallbackPrTitle` must derive the
    // clean human summary for it, never leak the footer (e.g. a `Source: review-comment:` line).
    const reviewLoopFooter = [
      "[cycloid:review-loop epoch=ep-1]",
      "Head SHA: abc123",
      "Review-loop worklist:",
      "Source: review-comment:42",
      "Scope discipline:",
      "- Make the minimal change that resolves the worklist.",
    ].join("\n\n");
    const title = fallbackPrTitle([
      promptState("Fix the dashboard setup documentation", { promptId: "prompt-1" }),
      promptState(reviewLoopFooter, {
        promptId: "prompt-2",
        reviewLoopEpochId: "ep-1",
        replyToText: "Addressing review feedback on this PR",
      }),
    ]);
    expect(title).not.toContain("cycloid:review-loop");
    expect(title).not.toContain("Source:");
    expect(title).toBe("Addressing review feedback on this PR");
  });

  it.each([
    {
      name: "uses the generated session title when post-execution PR title is missing",
      sessionTitle: "Fix PR title generation",
      promptText: ["Repository: trycycloid/cycloid", "Linear Issue: ARC-123", "Fix PR title generation"].join("\n"),
      expectedTitle: "Fix PR title generation",
    },
    {
      name: "does not reuse metadata-looking session titles when post-execution PR title is missing",
      sessionTitle: "Repository: trycycloid/cycloid",
      promptText: [
        "Repository: trycycloid/cycloid",
        "Linear Issue: ARC-123",
        "<user_content>",
        "Fix PR title generation",
        "</user_content>",
      ].join("\n"),
      expectedTitle: "Fix PR title generation",
    },
  ])("$name", async ({ sessionTitle, promptText, expectedTitle }) => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      title: sessionTitle,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText,
      actorUserId: "user-1",
      status: "completed",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/pr-title", "Updated PR title generation");

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expectedTitle,
      }),
    );
  });

  it("clears prCreating and skips PR creation when head matches base", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      baseBranch: "main",
      prCreating: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "main", "diff summary");

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prCreating).toBe(false);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
  });

  it("uses the public app URL for reviewer-facing verification links", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      repoPrivate: 1,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Change the UI",
      actorUserId: "user-1",
      status: "completed",
    });

    const { host } = createHost(storage);
    host.env.FRONTEND_URL = "http://localhost:5173";
    const workflow = createSessionPrWorkflow(host);
    const verification: ExecutionVerification = {
      verified: true,
      explanation: "Browser evidence captured at http://127.0.0.1:3000",
      runtimeEvidenceRequired: true,
      runtimeEvidenceSatisfied: true,
      visualAssertion: 'The screenshot shows "Verified Agent Control Room 2318" as the main heading',
      previewContract: {
        cwd: "/workspace/repo",
        port: 3000,
      },
      artifacts: [
        {
          type: "screenshot",
          label: "preview.png",
          url: "https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/artifact/preview.png",
        },
      ],
    };

    await workflow.triggerPrCreation(SESSION_ID, "feature/ui", "Updated the UI", undefined, undefined, verification);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("Replay Preview"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("launchPreview=1"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("localhost:5173"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Verdict"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("Visual Assertion:"),
      }),
    );
  });

  it("publishes readiness evidence without a dedicated visual evidence comment", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const readiness = {
      ...makePrReadiness(),
      evidenceBundle: {
        ...makePrReadiness().evidenceBundle,
        finalSummary: "Earlier progress text.",
        agentFinalMessage: "Implemented the UI change.\n\nValidated with:\n\n- npm test",
      },
    };

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/publish-evidence-comment",
      "Tightened publish output",
      undefined,
      undefined,
      {
        verified: true,
        explanation: "Focused bridge test passed.",
      },
      readiness,
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Summary:\n\nImplemented the UI change."),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("- npm test"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("Earlier progress text."),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("Agent output"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("```text"),
      }),
    );
  });

  it("ignores a cached legacy evidence comment ref for PR updates", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    await storage.put("pr_evidence_comment:latest_id", { prNumber: 7, commentId: 7777 });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/evidence-comment-scope",
      "Updated publish output",
      undefined,
      undefined,
      { verified: true, explanation: "Updated publish." },
      makePrReadiness(),
    );

    expect(mockUpdatePullRequest).toHaveBeenCalled();
  });

  it("updates the PR title on republish when the live title still matches the last applied title", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    const sql = storage.sql as unknown as SqlStorage;
    doDb.updateSessionFields(sql, SESSION_ID, { prTitleLastApplied: "Old Cycloid title" });
    // Nobody renamed the PR: the live GitHub title still equals what Cycloid applied.
    mockGetPullRequestTitle.mockResolvedValue("Old Cycloid title");

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/title-update",
      undefined,
      "New republish title",
      undefined,
      { verified: true, explanation: "Updated publish." },
      makePrReadiness(),
    );

    expect(mockUpdatePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, {
      title: "New republish title",
    });
    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("New republish title");
  });

  it("leaves the PR title alone on republish when it was renamed outside Cycloid", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    const sql = storage.sql as unknown as SqlStorage;
    doDb.updateSessionFields(sql, SESSION_ID, { prTitleLastApplied: "Old Cycloid title" });
    // A human renamed the PR since Cycloid last applied a title.
    mockGetPullRequestTitle.mockResolvedValue("Human renamed this PR");

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/title-skip",
      undefined,
      "New republish title",
      undefined,
      { verified: true, explanation: "Updated publish." },
      makePrReadiness(),
    );

    // The body update still happens, but no title PATCH is issued.
    expect(mockUpdatePullRequest).toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ title: expect.anything() }),
    );
    // Baseline is untouched, so a human rename keeps winning on the next republish.
    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("Old Cycloid title");
  });

  it("records the resolved title as the baseline when it creates a new PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      lastBranch: "feature/create-baseline",
      lastPushSucceeded: 1,
    });
    await storage.put("pr_readiness", makePrReadiness());
    const sql = storage.sql as unknown as SqlStorage;

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/create-baseline",
      undefined,
      "Brand new PR title",
      undefined,
      { verified: true, explanation: "Created." },
      makePrReadiness(),
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    // Genuine create (createPr returns created: true) records the applied title
    // directly, without an extra live-title GET.
    expect(mockGetPullRequestTitle).not.toHaveBeenCalled();
    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("Brand new PR title");
  });

  it("adopts the live title as the baseline when it adopts an existing branch PR (created === false)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      lastBranch: "feature/adopt-baseline",
      lastPushSucceeded: 1,
    });
    await storage.put("pr_readiness", makePrReadiness());
    const sql = storage.sql as unknown as SqlStorage;
    // createPr adopted an already-open branch PR rather than creating one;
    // Cycloid did not set this title, so it must not be assumed as the baseline.
    mockCreatePullRequest.mockResolvedValue({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      created: false,
    });
    mockGetPullRequestTitle.mockResolvedValue("Title the branch PR already had");

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/adopt-baseline",
      undefined,
      "Cycloid resolved title",
      undefined,
      { verified: true, explanation: "Created." },
      makePrReadiness(),
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    // Adopted PR reconciles against the live title and adopts it as the baseline;
    // no title PATCH is issued.
    expect(mockGetPullRequestTitle).toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ title: expect.anything() }),
    );
    expect(doDb.getSessionExtended(sql, SESSION_ID)!.prTitleLastApplied).toBe("Title the branch PR already had");
  });

  it("posts failed verification command output for inconclusive PRs", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/failed-verification-comment",
      "Updated verification output",
      undefined,
      undefined,
      {
        verified: false,
        explanation: "Targeted tests failed.",
        verdict: "INCONCLUSIVE",
        status: "manual_review_required",
        publishMode: "draft",
      },
      {
        ...makePrReadiness(),
        commandsRun: [
          {
            command: "npm run test -- tests/failing.test.ts",
            status: "error" as const,
            source: "post_execution" as const,
            check: "tests" as const,
            exitCode: 1,
            hasOutput: true,
            summary: "FAIL tests/failing.test.ts",
            failureOutput: "FAIL tests/failing.test.ts\nAssertionError: expected true to be false",
          },
        ],
        checksDetected: { tests: true, lint: false, typecheck: false },
      },
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1);
    expect(mockCreateIssueComment).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      42,
      expect.stringContaining("## Failed Command Details"),
    );
    const body = mockCreateIssueComment.mock.calls[0]?.[4] as string;
    expect(body).toContain("<code>npm run test -- tests/failing.test.ts</code> failed");
    expect(body).toContain("- Result: FAIL tests/failing.test.ts");
    expect(body).toContain("Captured stderr/output:");
    expect(body).toContain("AssertionError: expected true to be false");
  });

  it("does not post failed command details for agent exploration failures", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/confirmed-with-exploration-failure",
      "Updated verification output",
      undefined,
      undefined,
      {
        verified: true,
        explanation: "Screenshot proof confirmed the UI change.",
        verdict: "CONFIRMED",
        publishMode: "normal",
      },
      {
        ...makePrReadiness(),
        commandsRun: [
          {
            command: 'rg -n "avatar" app src packages ui',
            status: "error" as const,
            source: "agent" as const,
            exitCode: 2,
            hasOutput: true,
            summary: "src: No such file or directory",
            failureOutput: "src: No such file or directory\npackages: No such file or directory",
          },
        ],
      },
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it("opens a ready PR when final verification is confirmed even if publishMode is outdated draft", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/stale-draft-confirmed",
      "Confirmed with stale publish mode",
      undefined,
      undefined,
      {
        verified: true,
        status: "passed",
        explanation: "Screenshot proof confirmed the UI change.",
        verdict: "CONFIRMED",
        publishMode: "draft",
      },
      makePrReadiness(),
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
  });

  it("keeps an authoritative manual-review publish mode while opening a ready PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/authoritative-draft",
      "Draft after authoritative clamp",
      undefined,
      undefined,
      {
        verified: true,
        status: "passed",
        explanation: "Legacy fields were not rewritten by the authoritative publish clamp.",
        publishMode: "draft",
      },
      makePrReadiness(),
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
  });

  it("posts verbose verification diagnostics outside the main PR body", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const verboseNote = [
      "UI evidence was required, but automatic screenshot capture failed for /organization: browser capture failed (browserType.launch: Target page, context or browser has been closed",
      "Browser logs:",
      "<launching> /usr/bin/chromium --no-sandbox --disable-gpu --user-data-dir=/tmp/profile",
      "Call log:",
      "  - [pid=11766] <process did exit: exitCode=null, signal=SIGSEGV>",
      ").",
    ].join("\n");

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/verbose-diagnostic-comment",
      "Updated verification output",
      undefined,
      undefined,
      {
        verified: true,
        explanation: "Screenshot proof confirmed the UI change.",
        verdict: "CONFIRMED",
        publishMode: "normal",
        notes: [verboseNote],
      },
      makePrReadiness(),
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    const createdPrBody = mockCreatePullRequest.mock.calls[0]?.[0]?.body as string;
    expect(createdPrBody).toContain(
      "Full diagnostic details are posted in the Verification Diagnostic Details PR comment.",
    );
    expect(createdPrBody).not.toContain("Browser logs:");
    expect(createdPrBody).not.toContain("SIGSEGV");
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1);
    const commentBody = mockCreateIssueComment.mock.calls[0]?.[4] as string;
    expect(commentBody).toContain("## Verification Diagnostic Details");
    expect(commentBody).toContain("Detailed runtime diagnostics were withheld");
    expect(commentBody).not.toContain("Browser logs:");
    expect(commentBody).not.toContain("SIGSEGV");
  });

  it("clears prior failed verification comments when verification recovers", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    await storage.put("pr_failed_verification_comment:latest_id", { prNumber: 42, commentId: 7777 });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/failed-verification-recovers",
      "Updated verification output",
      undefined,
      undefined,
      {
        verified: true,
        explanation: "Targeted tests passed.",
        verdict: "CONFIRMED",
      },
      makePrReadiness(),
    );

    expect(mockDeleteIssueComment).toHaveBeenCalledWith("ghu_test", "acme", "repo", 7777);
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
    expect(mockUpdateIssueComment).not.toHaveBeenCalled();
    await expect(storage.get("pr_failed_verification_comment:latest_id")).resolves.toBeUndefined();
  });

  it("allows scoped review-loop PR updates and completes the epoch", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch());

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/review-loop",
      "Updated the implementation",
      undefined,
      undefined,
      { verified: true, explanation: "Updated publish." },
      makePrReadiness(),
      "prompt-1",
    );

    expect(mockResolveReviewLoopChecklist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: 101, expectedBotsHash: "bots-hash" }),
    );
    expect(mockMarkReviewLoopEpochPublishing).toHaveBeenCalledWith(
      expect.anything(),
      "epoch-1",
      expect.objectContaining({ promptId: "prompt-1" }),
    );
    expect(mockUpdatePullRequest).toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochPublishing.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdatePullRequest.mock.invocationCallOrder[0],
    );
    expect(mockMarkReviewLoopEpochCompleted).toHaveBeenCalledWith(
      expect.anything(),
      "epoch-1",
      expect.objectContaining({ expectedPromptId: "prompt-1" }),
    );
  });

  it("keeps the implementation summary when a review-loop run republishes", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch());

    await storage.put(
      "pr_body:latest",
      [
        "## Verdict",
        "- Verdict: CONFIRMED.",
        "- Publish: ready for review.",
        "",
        "Summary:",
        "",
        "Implemented IN-clause chunking for getEvaluationsBySessions.",
        "",
      ].join("\n"),
    );

    const reviewLoopReadiness = {
      ...makePrReadiness(),
      evidenceBundle: {
        ...makePrReadiness().evidenceBundle,
        agentFinalMessage: "Addressed the review-loop item and replied through cycloid.review_loop_reply.",
      },
    };

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/review-loop",
      "Updated the implementation",
      undefined,
      undefined,
      { verified: true, explanation: "Updated publish." },
      reviewLoopReadiness,
      "prompt-1",
    );

    const bodyCalls = mockUpdatePullRequest.mock.calls.filter(
      (call) => (call[4] as { body?: string })?.body !== undefined,
    );
    const finalBody = (bodyCalls.at(-1)?.[4] as { body: string }).body;
    expect(finalBody).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    expect(finalBody).not.toContain("Addressed the review-loop item");
  });

  it("keeps the implementation summary on the bridge-authored (Functional Verification) republish path", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch());

    await storage.put(
      "pr_body:latest",
      [
        "## Verdict",
        "- Verdict: CONFIRMED.",
        "- Publish: ready for review.",
        "",
        "Summary:",
        "",
        "Implemented IN-clause chunking for getEvaluationsBySessions.",
        "",
        "## Functional Verification",
        "**Verdict:** CONFIRMED",
        "",
        "## Changed Files",
        "- apps/control-plane-worker/src/dao/eval-db.ts",
      ].join("\n"),
    );

    // Bridge-authored body (#3642 shape): contains `## Functional Verification`, so buildPrBody
    // passes it through unchanged and the touch-up Summary comes from the body itself.
    const bridgeAuthoredBody = [
      "## Verdict",
      "- Verdict: INCONCLUSIVE.",
      "- Publish: manual review.",
      "",
      "Summary:",
      "",
      "Addressed the review-loop item and replied through cycloid.review_loop_reply.",
      "",
      "## Functional Verification",
      "**Verdict:** INCONCLUSIVE",
      "",
      "## Changed Files",
      "- apps/control-plane-worker/src/dao/eval-db.ts",
    ].join("\n");

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/review-loop",
      bridgeAuthoredBody,
      undefined,
      undefined,
      { verified: false, verdict: "INCONCLUSIVE", explanation: "Updated publish." },
      makePrReadiness(),
      "prompt-1",
    );

    const bodyCalls = mockUpdatePullRequest.mock.calls.filter(
      (call) => (call[4] as { body?: string })?.body !== undefined,
    );
    const finalBody = (bodyCalls.at(-1)?.[4] as { body: string }).body;
    expect(finalBody).toContain("Implemented IN-clause chunking for getEvaluationsBySessions.");
    expect(finalBody).not.toContain("Addressed the review-loop item");
    // the rest of the bridge-authored body is preserved (early-return path, not control-plane verdict)
    expect(finalBody).toContain("## Functional Verification");
  });

  it("blocks review-loop PR updates that touch sensitive paths until owner approval", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch());

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const readiness = {
      ...makePrReadiness(),
      changedFiles: ["db/migrations/0007_add_users_table.sql"],
      diffStats: { raw: "1 file changed, 3 insertions(+)", filesChanged: 1, insertions: 3, deletions: 0 },
    };

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/review-loop",
      "Updated the implementation",
      undefined,
      undefined,
      { verified: true, explanation: "Updated publish." },
      readiness,
      "prompt-1",
    );

    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochWaitingForOwner).toHaveBeenCalledWith(
      expect.anything(),
      "epoch-1",
      expect.objectContaining({
        reason: expect.stringContaining("require owner approval"),
        expectedPromptId: "prompt-1",
      }),
    );
    expect(mockMarkReviewLoopEpochCompleted).not.toHaveBeenCalled();
  });

  it("creates a ready PR and emits manual-review metadata for draft publish mode", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix broad typecheck evidence",
      actorUserId: "user-1",
      status: "completed",
    });

    const { host, appendAndMirrorEvents, broadcast } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const verification: ExecutionVerification = {
      verified: true,
      status: "manual_review_required",
      publishMode: "draft",
      manualReviewReason:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
      explanation:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
    };

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/manual-review",
      "Updated evidence handling",
      undefined,
      undefined,
      verification,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pr_created",
        manualReviewReason: verification.manualReviewReason,
      }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_created", draft: true }));
    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([
        expect.objectContaining({
          type: "pr_created",
          data: expect.objectContaining({
            manualReviewReason: verification.manualReviewReason,
          }),
        }),
        expect.objectContaining({
          type: "agent_timeline",
          data: expect.objectContaining({
            eventType: "pr.open",
            summary: "Opened pull request.",
          }),
        }),
      ]),
      "prompt-1",
    );
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prDraft).toBe(false);
    expect(ext?.prManualReviewReason).toBe(verification.manualReviewReason);
    expect(mockEmitPrCreatedMetric).toHaveBeenCalledTimes(1);
    expect(mockEmitPrCreatedMetric).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ draft: false }));
  });

  it("creates a ready PR for inconclusive verification even without explicit draft publish mode", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Handle aborted publish preparation",
      actorUserId: "user-1",
      status: "completed",
    });

    const { host, broadcast } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const verification: ExecutionVerification = {
      verified: false,
      verdict: "INCONCLUSIVE",
      status: "manual_review_required",
      explanation: "Session was stopped before post-execution publish preparation completed.",
    };

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/inconclusive-verification",
      "Updated publish preparation",
      undefined,
      undefined,
      verification,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_created", draft: true }));
  });

  it("puts the verdict before fallback Changes when PR creation uses the control-plane fallback body", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix fallback ordering",
      actorUserId: "user-1",
      status: "completed",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/fallback-order",
      "Updated fallback ordering",
      undefined,
      undefined,
      {
        verified: true,
        verdict: "CONFIRMED",
        explanation: "Scoped verification passed.",
        evidence: [{ type: "command", label: "tests (agent)", status: "passed", command: "npm test" }],
      },
      "prompt-1",
    );

    const body = (mockCreatePullRequest.mock.calls.at(-1)?.[0] as { body: string }).body;
    expect(body.indexOf("## Verdict")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("## Changes")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("## Verdict")).toBeLessThan(body.indexOf("## Changes"));
  });

  it("dedupes PR-created post events for concurrent same-prompt publishes", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Publish once",
      actorUserId: "101",
      status: "completed",
    });

    const { host, appendAndMirrorEvents } = createHost(storage);
    const publishService = new SessionPublishService(host);
    let releaseFirstEventGroup: () => void = () => {};
    const firstEventGroupCanFinish = new Promise<void>((resolve) => {
      releaseFirstEventGroup = resolve;
    });
    let firstEventGroupBlocked = false;
    appendAndMirrorEvents.mockImplementation(async (_sessionId, entries) => {
      const eventEntries = entries as Array<{ type?: string }>;
      if (eventEntries.some((entry) => entry.type === "publish.pr.created") && !firstEventGroupBlocked) {
        firstEventGroupBlocked = true;
        await firstEventGroupCanFinish;
      }
      return {
        replay: {
          sessionId: SESSION_ID,
          lastEventSequence: 0,
          lastEventTimestamp: null,
          updatedAt: null,
        },
        events: [],
      };
    });

    const request = {
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/concurrent-publish",
      commitSha: "deadbeef",
      prBody: "Body",
      prReadiness: makePrReadiness(),
    };
    const firstPublish = publishService.publishSessionResult(request);
    await waitForCondition(
      () => firstEventGroupBlocked,
      "expected first publish to block inside the PR-created event group",
    );
    const secondPublish = publishService.publishSessionResult(request);

    await Promise.resolve();
    releaseFirstEventGroup();
    await Promise.all([firstPublish, secondPublish]);

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      (entries as Array<{ type?: string }>).map((entry) => entry.type),
    );
    expect(eventTypes.filter((type) => type === "publish.pr.created")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "publish.completed")).toHaveLength(1);
  });

  it("creates a PR with manual-review context when verification requests manual review", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix missing evidence",
      actorUserId: "user-1",
      status: "completed",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const verification: ExecutionVerification = {
      verified: false,
      status: "manual_review_required",
      publishMode: "draft",
      manualReviewReason: "PR body is missing required evidence.",
      explanation: "PR body is missing required evidence.",
    };

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/missing-evidence",
      "Updated evidence handling",
      undefined,
      undefined,
      verification,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Manual review: PR body is missing required evidence."),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
  });

  it("skips publish entirely when verification requests skip_publish", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/skip-publish",
      "Updated docs only",
      undefined,
      undefined,
      {
        verified: true,
        status: "passed",
        publishMode: "skip_publish",
        explanation: "Publish intentionally skipped.",
      } as ExecutionVerification,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_created" }));
    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([expect.objectContaining({ type: "publish.completed" })]),
      "prompt-1",
    );
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("skipped");
  });

  it("refreshes the Slack status card and posts a notifying PR-opened reply", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/slack-pr-created", "Updated Slack notifications");
    await vi.waitFor(() => expect(mockDeliverThreadStatus).toHaveBeenCalled());

    expect(mockDeliverThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "xoxb-test",
        channel: "C123",
        threadTs: "1712345678.000100",
        statusMessageTs: undefined,
      }),
    );
    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(
      host.env.DB,
      expect.objectContaining({
        sessionId: SESSION_ID,
        promptId: "pr:https://github.com/acme/repo/pull/42",
        stage: "pr_opened",
        channel: "C123",
      }),
    );
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "1712345678.000100",
      expect.stringContaining("PR #42 opened"),
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.objectContaining({ text: ":white_check_mark: *PR opened*" }),
        }),
      ]),
    );
    expect(mockMarkSlackPostDelivered).toHaveBeenCalledWith(host.env.DB, {
      sessionId: SESSION_ID,
      promptId: "pr:https://github.com/acme/repo/pull/42",
      stage: "pr_opened",
      messageTs: "200.100",
    });
  });

  it("skips Slack PR-created status for legacy callback contexts without a team id", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    mockResolveSlackBotTokenForCallback.mockResolvedValueOnce(null);

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/legacy-slack-context", "Updated Slack notifications");
    await vi.waitFor(() => expect(mockResolveSlackBotTokenForCallback).toHaveBeenCalled());

    expect(mockResolveSlackBotTokenForCallback).toHaveBeenCalledWith(
      host.env,
      {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
      },
      {
        sessionId: SESSION_ID,
        operation: "notifySlackPrCreated",
      },
    );
    expect(mockDeliverThreadStatus).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        sessionId: SESSION_ID,
        source: "slack",
        slackTeamId: undefined,
      },
      "Slack PR-created notification skipped: no bot token",
    );
  });

  it("passes statusMessageTs so Slack PR-created updates edit in place", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
        statusMessageTs: "1712345678.000500",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/slack-pr-created", "Updated Slack notifications");
    await vi.waitFor(() => expect(mockDeliverThreadStatus).toHaveBeenCalled());

    expect(mockDeliverThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        statusMessageTs: "1712345678.000500",
      }),
    );
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "1712345678.000100",
      expect.stringContaining("PR #42 opened"),
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.objectContaining({ text: ":white_check_mark: *PR opened*" }),
        }),
      ]),
    );
  });

  it("does not double-post the Slack PR-opened reply when the claim is already taken", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
        statusMessageTs: "1712345678.000500",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());
    mockClaimSlackPostForDelivery.mockResolvedValueOnce(false);

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/slack-pr-created", "Updated Slack notifications");
    await vi.waitFor(() => expect(mockDeliverThreadStatus).toHaveBeenCalled());

    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(
      host.env.DB,
      expect.objectContaining({
        sessionId: SESSION_ID,
        promptId: "pr:https://github.com/acme/repo/pull/42",
        stage: "pr_opened",
      }),
    );
    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("releases the Slack PR-opened claim when posting returns a failure", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());
    mockPostThreadReply.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/slack-pr-created", "Updated Slack notifications");
    await vi.waitFor(() => expect(mockDeleteSlackPostMarker).toHaveBeenCalled());

    expect(mockDeleteSlackPostMarker).toHaveBeenCalledWith(host.env.DB, {
      sessionId: SESSION_ID,
      promptId: "pr:https://github.com/acme/repo/pull/42",
      stage: "pr_opened",
    });
    expect(mockMarkSlackPostDelivered).not.toHaveBeenCalled();
  });

  it("releases the Slack PR-opened claim when posting throws", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());
    mockPostThreadReply.mockRejectedValueOnce(new Error("socket hang up"));

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/slack-pr-created", "Updated Slack notifications");
    await vi.waitFor(() => expect(mockDeleteSlackPostMarker).toHaveBeenCalled());

    expect(mockDeleteSlackPostMarker).toHaveBeenCalledWith(host.env.DB, {
      sessionId: SESSION_ID,
      promptId: "pr:https://github.com/acme/repo/pull/42",
      stage: "pr_opened",
    });
    expect(mockMarkSlackPostDelivered).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, error: "Error: socket hang up" }),
      "Slack PR notification error",
    );
  });

  it("persists fallback statusMessageTs and warns when Slack PR-created update falls back", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
        statusMessageTs: "1712345678.000500",
      }),
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Create a PR",
      actorUserId: "user-1",
      status: "completed",
    });
    await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());
    mockDeliverThreadStatus.mockResolvedValueOnce({
      ok: true,
      updatedInPlace: false,
      fallbackTs: "1712345678.000900",
      error: "message_not_found",
    });

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/slack-pr-created", "Updated Slack notifications");
    await vi.waitFor(() =>
      expect(doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID)?.callbackContext).toEqual(
        expect.objectContaining({ statusMessageTs: "1712345678.000900" }),
      ),
    );

    expect(mockDeliverThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        statusMessageTs: "1712345678.000500",
      }),
    );
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.callbackContext).toEqual(
      expect.objectContaining({
        source: "slack",
        statusMessageTs: "1712345678.000900",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        statusMessageTs: "1712345678.000500",
        slackError: "message_not_found",
      }),
      "Slack PR status update failed; delivered as a new thread reply",
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      host.env,
      expect.objectContaining({
        event: "integration.failure",
        surface: "slack",
        operation: "notifySlackPrCreated",
        session_id: SESSION_ID,
        error_class: "SlackApiError",
        error_message_truncated: "message_not_found",
        slack_error_code: "message_not_found",
        reason: "status_update_fallback",
      }),
    );
  });

  it("neutralizes local links in visual assertions before rendering the PR body", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      repoPrivate: 1,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Change the UI",
      actorUserId: "user-1",
      status: "completed",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const verification: ExecutionVerification = {
      verified: true,
      explanation: "Browser evidence captured.",
      runtimeEvidenceRequired: true,
      runtimeEvidenceSatisfied: true,
      visualAssertion: "The screenshot matches http://localhost:3000/launchPreview=1",
      artifacts: [],
    };

    await workflow.triggerPrCreation(SESSION_ID, "feature/ui", "Updated the UI", undefined, undefined, verification);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Verdict"),
      }),
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("launchPreview=1"),
      }),
    );
  });

  it("sanitizes reviewer-inaccessible URLs when verification is absent", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      repoPrivate: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/no-verification",
      undefined,
      undefined,
      "Preview: [open](http://localhost:5173/session/session-pr-workflow).",
    );

    const body = (mockCreatePullRequest.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Preview: open (`local preview URL`).");
    expect(body).not.toContain("](http://localhost:5173");
  });

  it("enters review listening after successful PR publish bookkeeping", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, enterReviewListening, appendAndMirrorEvents } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/review-listening",
      "Updated review listening",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "deadbeef",
    });
    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([
        expect.objectContaining({
          type: "review_listening.entered",
          data: expect.objectContaining({
            sessionId: SESSION_ID,
            prUrl: "https://github.com/acme/repo/pull/42",
            currentHeadSha: "deadbeef",
          }),
        }),
      ]),
      "prompt-1",
    );
    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      Array.isArray(entries) ? entries.map((entry) => entry.type) : [],
    );
    expect(eventTypes.indexOf("publish.completed")).toBeLessThan(eventTypes.indexOf("review_listening.entered"));

    const publishCompletedCallIndex = appendAndMirrorEvents.mock.calls.findIndex(
      ([, entries]) => Array.isArray(entries) && entries.some((entry) => entry.type === "publish.completed"),
    );
    expect(publishCompletedCallIndex).toBeGreaterThanOrEqual(0);
    expect(enterReviewListening.mock.invocationCallOrder[0]).toBeGreaterThan(
      appendAndMirrorEvents.mock.invocationCallOrder[publishCompletedCallIndex],
    );
    expect(mockEmitPrCreatedMetric).toHaveBeenCalledTimes(1);
    expect(mockEmitPrCreatedMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repo: "acme/repo", ownerUserId: 101, draft: false }),
    );
    // ARC-1112: arming the review loop emits the armed counter tagged with the
    // persisted draft state (a ready PR here).
    expect(mockEmitReviewLoopArmedMetric).toHaveBeenCalledTimes(1);
    expect(mockEmitReviewLoopArmedMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repo: "acme/repo", ownerUserId: 101, draft: false }),
    );
  });

  it("opens with the deterministic title and applies the publish-time generated PR title after create", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Pull request verification after review loop",
      lastBranch: "feature/generated-title",
      installationId: 123,
    });
    mockGetPullRequestTitle.mockResolvedValue("Pull request verification after review loop");

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/generated-title",
      diffSummary: "Updated publish readiness rendering to include grouped command evidence.",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Pull request verification after review loop" }),
    );

    await drainAllWaitUntil(waitUntil);

    expect(mockCreatePullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueryPlatformStructuredOutput.mock.invocationCallOrder[0],
    );
    expect(mockQueryPlatformStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: PUBLISH_PR_TITLE_MODEL,
        systemPrompt: PUBLISH_PR_TITLE_SYSTEM_PROMPT,
        userPrompt: expect.stringContaining("Updated publish readiness rendering"),
      }),
      expect.objectContaining({ callType: "publish_pr_title", sessionId: SESSION_ID }),
    );
    expect(PUBLISH_PR_TITLE_SYSTEM_PROMPT).not.toMatch(/sentence case/i);
    expect(PUBLISH_PR_TITLE_SYSTEM_PROMPT).not.toMatch(/conventional commit/i);
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ title: "Tighten publish readiness rendering" }),
    );
    expect(doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID)!.prTitleLastApplied).toBe(
      "Tighten publish readiness rendering",
    );
    expect(doDb.getSession(storage.sql as unknown as SqlStorage, SESSION_ID)!.title).toBe(
      "Tighten publish readiness rendering",
    );
  });

  it("clamps an overlong publish-time generated PR title before patching the PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Original generated title",
      lastBranch: "feature/generated-title-clamp",
      installationId: 123,
    });
    mockQueryPlatformStructuredOutput.mockResolvedValueOnce({ title: "A".repeat(MAX_PR_TITLE_LENGTH + 50) });
    mockGetPullRequestTitle.mockResolvedValue("Original generated title");

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/generated-title-clamp",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: "Original generated title" }));

    await drainAllWaitUntil(waitUntil);

    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ title: "A".repeat(MAX_PR_TITLE_LENGTH) }),
    );
  });

  it("reuses a memoized publish-time generated title when replaying the same publish step", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Original generated title",
      lastBranch: "feature/generated-title-replay",
      installationId: 123,
    });
    mockGetPullRequestTitle.mockResolvedValue("Original generated title");
    await storage.put(`step:publish_pr_title_${SESSION_ID}_prompt-1`, {
      ok: true,
      result: "Memoized publish title",
    });

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/generated-title-replay",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: "Original generated title" }));

    await drainAllWaitUntil(waitUntil);

    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ title: "Memoized publish title" }),
    );
  });

  it("does not regenerate when the publish request provides an explicit title", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Original generated title",
      lastBranch: "feature/explicit-title",
      installationId: 123,
    });
    mockGetPullRequestTitle.mockResolvedValue("Original generated title");

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/explicit-title",
      prTitle: "Human supplied title",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(waitUntil).toHaveBeenCalled();
    await drainAllWaitUntil(waitUntil);
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: "Human supplied title" }));
  });

  it("fails open to the resolved title when publish-time title generation fails", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Original generated title",
      lastBranch: "feature/title-fallback",
      installationId: 123,
    });
    mockQueryPlatformStructuredOutput.mockRejectedValueOnce(new Error("provider timeout"));

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/title-fallback",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: "Original generated title" }));
    await drainWaitUntil(waitUntil);
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "publish_pr_title_generation_failed", sessionId: SESSION_ID }),
      expect.stringContaining("using existing resolved title"),
    );
  });

  it("does not revert the generated title on republish when deferred title generation is skipped by the baseline guard", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Original generated title",
      lastBranch: "feature/title-republish",
      installationId: 123,
    });
    mockGetPullRequestTitle.mockResolvedValue("Original generated title");

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/title-republish",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });
    await drainAllWaitUntil(waitUntil);
    expect(doDb.getSession(storage.sql as unknown as SqlStorage, SESSION_ID)!.title).toBe(
      "Tighten publish readiness rendering",
    );

    mockUpdatePullRequest.mockClear();
    mockQueryPlatformStructuredOutput.mockClear();
    mockGetPullRequestTitle.mockResolvedValue("Tighten publish readiness rendering");

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/title-republish",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    await drainAllWaitUntil(waitUntil);
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ title: "Original generated title" }),
    );
  });

  it("opens with the deterministic template body and applies deferred template fill after publish", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Original generated title",
      lastBranch: "feature/template-fill",
      installationId: 123,
    });
    const deterministicBody = [
      "## Description",
      "",
      "<!-- cycloid:managed:start narrative -->",
      "Deterministic summary",
      "<!-- cycloid:managed:end narrative -->",
      "",
      "## Implementation",
      "",
      "## Testing",
      "",
      "<!-- cycloid:verification-rendered -->",
    ].join("\n");
    mockGetPullRequestBodyAndState.mockResolvedValue({ body: deterministicBody, state: "open" });
    mockQueryPlatformStructuredOutput.mockReset();
    mockQueryPlatformStructuredOutput.mockImplementation(async (_env, _request, metadata) => {
      if ((metadata as { callType?: string }).callType === "pr_template_fill") {
        return {
          sections: [
            {
              index: 0,
              heading: "Description",
              kind: "prose",
              text: "LLM-enriched summary",
              factRefs: null,
              emptyReason: null,
            },
            {
              index: 1,
              heading: "Implementation",
              kind: "empty",
              text: null,
              factRefs: null,
              emptyReason: "No implementation details beyond the summary.",
            },
            {
              index: 2,
              heading: "Testing",
              kind: "facts",
              text: null,
              factRefs: ["verification"],
              emptyReason: null,
            },
          ],
        };
      }
      return { title: "Tighten publish readiness rendering" };
    });

    const { host, waitUntil } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/template-fill",
      prTitle: "Explicit title",
      diffSummary: "Updated template fill.",
      prBody: deterministicBody,
      prReadiness: makePrReadiness(),
      prTemplateFill: {
        template: {
          source: "repo_local",
          path: ".github/pull_request_template.md",
          content: "## Description\n\n## Implementation\n\n## Testing\n",
        },
        input: {
          headings: ["Description", "Implementation", "Testing"],
          narrative: "Deterministic summary",
          taskPrompt: "Update template fill.",
          diffSummary: "Updated template fill.",
          diffSizeBand: "small",
          instructions: null,
          factPlacement: "body",
          commands: [],
        },
        generatedBody: "Deterministic summary",
      },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Deterministic summary") }),
    );

    await drainAllWaitUntil(waitUntil);

    expect(mockQueryPlatformStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userPrompt: expect.stringContaining("Updated template fill.") }),
      expect.objectContaining({ callType: "pr_template_fill", sessionId: SESSION_ID }),
    );
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      42,
      expect.objectContaining({ body: expect.stringContaining("LLM-enriched summary") }),
    );
  });

  it("does not regenerate a tracked title that matches the last applied baseline", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Agent supplied title",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      lastBranch: "feature/tracked-title",
      installationId: 123,
    });
    doDb.updateSessionFields(storage.sql as unknown as SqlStorage, SESSION_ID, {
      prTitleLastApplied: "Agent supplied title",
    });

    const { host } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/tracked-title",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ title: expect.anything() }),
    );
  });

  it("does not regenerate a ticket-prefixed tracked title that matches the last applied baseline", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      title: "Agent supplied title",
      linearContextJson: JSON.stringify({
        identifier: "ENG-9001",
        url: "https://linear.app/acme/issue/ENG-9001/test",
      }),
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      lastBranch: "feature/tracked-ticket-title",
      installationId: 123,
    });
    doDb.updateSessionFields(storage.sql as unknown as SqlStorage, SESSION_ID, {
      prTitleLastApplied: "ENG-9001 Agent supplied title",
    });

    const { host } = createHost(storage, { ARCANIST_OPENAI_API_KEY: "sk-test" });
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/tracked-ticket-title",
      diffSummary: "Updated publish readiness rendering.",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ title: expect.anything() }),
    );
  });

  it("fails initial PR publish before createPr when the remote branch head differs from the reported commit", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      lastBranch: "feature/sha-mismatch",
      installationId: 123,
    });
    mockGetPrHeadSha.mockResolvedValue("third-party-commit");

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      branch: "feature/sha-mismatch",
      commitSha: "agent-commit",
      prBody: "Test PR body",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(mockGetPrHeadSha).toHaveBeenCalledWith("ghu_test", "acme", "repo", "feature/sha-mismatch");
    expect(mockFindOpenPrByHead).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      (entries as Array<{ type: string }>).map((entry) => entry.type),
    );
    expect(eventTypes).toContain("publish.failed");

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prUrl).toBeNull();
    expect(ext?.prNumber).toBeNull();
    expect(ext?.publishStatus).toBe("failed");
    expect(ext?.publishStage).toBe("pushing");
    expect(ext?.publishError).toContain("Remote branch SHA mismatch for feature/sha-mismatch");
  });

  it("emits the review-loop armed metric tagged draft:false when manual-review publish arms the loop", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    // Manual-review publishMode no longer makes GitHub PRs draft. The arming-time
    // metric reads the persisted ready-for-review flag from the session.
    const verification: ExecutionVerification = {
      verified: true,
      status: "manual_review_required",
      publishMode: "draft",
      manualReviewReason: "Verification inconclusive; review before merge.",
      explanation: "Verification inconclusive; review before merge.",
    };

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/draft-review-listening",
      "Draft review listening",
      undefined,
      undefined,
      verification,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).toHaveBeenCalled();
    expect(mockEmitReviewLoopArmedMetric).toHaveBeenCalledTimes(1);
    expect(mockEmitReviewLoopArmedMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repo: "acme/repo", ownerUserId: 101, draft: false }),
    );
  });

  it("logs when the fresh session read is missing before defaulting the armed metric draft tag", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, enterReviewListening, logger } = createHost(storage);
    enterReviewListening.mockImplementationOnce(async () => {
      storage.sql.exec("DELETE FROM session WHERE session_id = ?", SESSION_ID);
    });
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/missing-fresh-ext",
      "Missing fresh ext",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: SESSION_ID },
      "getSessionExtended returned null after enterReviewListening; draft tag will default to false",
    );
    expect(mockEmitReviewLoopArmedMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repo: "acme/repo", ownerUserId: 101, draft: false }),
    );
  });

  it("does not emit the review-loop armed metric when arming is skipped (capabilities missing)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "installation_capabilities_missing" });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/no-arm",
      "No arm",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).not.toHaveBeenCalled();
    expect(mockEmitReviewLoopArmedMetric).not.toHaveBeenCalled();
  });

  // ARC-1472: review-loop arming is DECOUPLED from the QA opt-out. A session with the QA
  // opt-out (autoVerifyDisabled) must STILL arm review listening — the master toggle governs
  // arming, `autoVerifyDisabled` gates only verification spawn. #5485 previously skipped arming
  // here; keying on autoVerifyDisabled would strip CI-fix + bot-response automation from every
  // new user once auto-verify defaults OFF.
  it("enters review listening even when the session opted out of auto-verification (QA off)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      autoVerifyDisabled: 1,
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/no-auto-verify",
      "No auto verify",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "deadbeef",
    });
  });

  // The smoke/verifier suppression keys on the REAL structural signal — the session's agent role —
  // not the QA opt-out. A QA/verifier (agentRole="verification") session never participates in the
  // review loop, so arming stays suppressed via reviewVerificationExemptReason.
  it("does not enter review listening for a QA/verifier session (agentRole verification)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      agentRole: "verification",
      // A verifier session also carries the QA opt-out; the suppression must come from the role,
      // not from autoVerifyDisabled.
      autoVerifyDisabled: 1,
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/verifier-session",
      "Verifier session",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).not.toHaveBeenCalled();
    expect(mockEmitReviewLoopArmedMetric).not.toHaveBeenCalled();
  });

  // Companion isolation case: the verifier role suppresses arming even with the QA opt-out OFF
  // (autoVerifyDisabled omitted → 0). Paired with the two tests above this pins the 2x2 —
  // QA-off + no role arms, verifier role suppresses regardless of QA state — proving the role,
  // not `autoVerifyDisabled`, is the sole driver of the suppression.
  it("does not enter review listening for a QA/verifier session even with QA opt-out OFF (agentRole alone drives suppression)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      agentRole: "verification",
      // QA opt-out left OFF (autoVerifyDisabled defaults to 0): suppression must still come from
      // the role via reviewVerificationExemptReason, never from autoVerifyDisabled.
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/verifier-session-qa-on",
      "Verifier session QA on",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).not.toHaveBeenCalled();
    expect(mockEmitReviewLoopArmedMetric).not.toHaveBeenCalled();
  });

  it("enters review listening for a zero-bot repo (arms on an unconfigured bot checklist)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    // Walltime removal: a zero-bot repo now resolves ok:true with an empty expected-bot set — the
    // session must still arm so the always-on CI-fix + verification arm runs and the CI webhook can
    // later ingest failures.
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({
      ok: true,
      expectedBots: [],
      expectedBotsHash: "empty",
      installationId: 123,
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/zero-bot-ci",
      "Zero-bot CI listening",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "deadbeef",
    });
  });

  it("does not arm a zero-bot repo when capabilities are missing (checklist reports the capability gap)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    // Walltime removal: a zero-bot repo now runs the capability check inside resolveReviewLoopChecklist,
    // so a degraded GitHub App install returns installation_capabilities_missing directly (carrying the
    // re-approve URL). The gate must not silently arm a listener whose webhooks can't be ingested.
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({
      ok: false,
      reason: "installation_capabilities_missing",
      reapproveUrl: "https://github.com/settings/installations/123",
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/zero-bot-caps-missing",
      "Zero-bot, caps missing",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(enterReviewListening).not.toHaveBeenCalled();
  });

  it("does not count arcanist.pr.created when createPr adopts an existing branch PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    // createPr returns created:false when GitHub already had an open PR for the
    // branch (422): it adopts and only updates the body. That is not a new PR, so
    // it must not be counted.
    mockCreatePullRequest.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      created: false,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/adopted",
      "Adopted PR",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(mockEmitPrCreatedMetric).not.toHaveBeenCalled();
  });

  it("enters review listening when the bot checklist changed (arm-only failure)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    // A changed/unconfigured bot checklist is arm-only (ARC-1288): the session still arms so the
    // always-on CI-fix + verification arm runs. Only missing capabilities would skip.
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "expected_bots_changed" });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/review-loop-changed-bots",
      "Updated review loop gating",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(mockResolveReviewLoopChecklist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: 101, repoOwner: "acme", repoName: "repo" }),
    );
    expect(enterReviewListening).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "deadbeef",
    });
  });

  it("arms review listening when the PR is opened as a draft (bot checklist eligible)", async () => {
    // Drafts no longer skip the review loop: they go through the same eligibility
    // path as ready PRs. With the bot checklist eligible (default), a draft arms.
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(enterReviewListening).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "deadbeef",
    });
    // No draft-skip comment is posted anymore.
    const commentBodies = mockCreatePrIssueComment.mock.calls.map((c) => String(c[4]));
    expect(commentBodies.some((b) => b.includes("Skipping Cycloid review-loop"))).toBe(false);
  });

  it("arms review listening on a draft for a zero-bot repo when CI-failure responses are enabled", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    // Walltime removal: a zero-bot repo resolves ok:true with an empty expected-bot set; a draft still arms.
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({
      ok: true,
      expectedBots: [],
      expectedBotsHash: "empty",
      installationId: 123,
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(enterReviewListening).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "deadbeef",
    });
  });

  it("does not arm review listening on a draft when installation capabilities are missing", async () => {
    // Parity with ready PRs: only missing GitHub App capabilities skips arming (draft or not).
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({
      ok: false,
      reason: "installation_capabilities_missing",
      reapproveUrl: "https://github.com/settings/installations/123",
    });
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(enterReviewListening).not.toHaveBeenCalled();
    const commentBodies = mockCreatePrIssueComment.mock.calls.map((c) => String(c[4]));
    expect(commentBodies.some((b) => b.includes("Skipping Cycloid review-loop"))).toBe(false);
  });

  it("re-arms review listening when an already-listening PR is republished as a draft (eligible)", async () => {
    // The old behavior exited review listening on a draft republish. Now an
    // eligible republish-as-draft re-arms via the normal path; it does not exit.
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    storage.sql.exec(
      `UPDATE session
         SET review_listening_active = 1,
             review_listening_pr_url = ?
       WHERE session_id = ?`,
      "https://github.com/acme/repo/pull/42",
      SESSION_ID,
    );
    // Already a draft so the update path does not also call convertToDraft.
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: true });

    const { host, enterReviewListening, exitReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(enterReviewListening).toHaveBeenCalled();
    expect(exitReviewListening).not.toHaveBeenCalled();
    expect(mockEmitReviewLoopArmedMetric).not.toHaveBeenCalled();
  });

  it("ineligible draft republish of an armed PR is a no-op (no exit), matching the non-draft path", async () => {
    // When capabilities are missing, a draft republish of an already-armed PR neither re-arms
    // nor exits — identical to how a non-draft capability-blocked republish behaves. The
    // listener is left untouched.
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "installation_capabilities_missing" });
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    storage.sql.exec(
      `UPDATE session
         SET review_listening_active = 1,
             review_listening_pr_url = ?
       WHERE session_id = ?`,
      "https://github.com/acme/repo/pull/42",
      SESSION_ID,
    );
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: true });

    const { host, enterReviewListening, exitReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(enterReviewListening).not.toHaveBeenCalled();
    expect(exitReviewListening).not.toHaveBeenCalled();
    const commentBodies = mockCreatePrIssueComment.mock.calls.map((c) => String(c[4]));
    expect(commentBodies.some((b) => b.includes("Skipping Cycloid review-loop"))).toBe(false);
  });

  it("keeps a previously-ready PR ready when republished for manual review (update path)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      // An existing ready PR already attached to the session drives the update path.
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: false });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockUpdatePullRequest).toHaveBeenCalled();
    expect(mockGetPrDraftState).toHaveBeenCalledWith(expect.anything(), "acme", "repo", 42);
    expect(mockMarkPullRequestReadyForReview).not.toHaveBeenCalled();
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prDraft).toBe(false);
    // Republishing an existing PR is an update, not a creation: it must not count
    // toward arcanist.pr.created or the drafts-vs-green comparison would be inflated.
    expect(mockEmitPrCreatedMetric).not.toHaveBeenCalled();
  });

  it("persists the live ready state when manual-review republish keeps a PR ready", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: false });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prDraft).toBe(false);
    expect(mockGetPrDraftState).toHaveBeenCalledTimes(1);
    expect(mockMarkPullRequestReadyForReview).not.toHaveBeenCalled();
    expect(mockUpdateCompletionPrUrl).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      "prompt-1",
      "https://github.com/acme/repo/pull/42",
      false,
    );
  });

  it("marks an existing draft PR ready on manual-review republish (update path)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: true });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await triggerDraftPrCreation(workflow);

    expect(mockUpdatePullRequest).toHaveBeenCalled();
    expect(mockGetPrDraftState).toHaveBeenCalledWith(expect.anything(), "acme", "repo", 42);
    expect(mockMarkPullRequestReadyForReview).toHaveBeenCalledWith(expect.anything(), "PR_node_42");
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prDraft).toBe(false);
  });

  it("marks an existing draft PR ready when final verification recovers to confirmed", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    mockGetPrDraftState.mockResolvedValue({ nodeId: "PR_node_42", isDraft: true });

    const { host, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/confirmed-existing-draft",
      "Confirmed update",
      undefined,
      undefined,
      {
        verified: true,
        status: "passed",
        explanation: "Screenshot proof confirmed the UI change.",
        verdict: "CONFIRMED",
        publishMode: "draft",
      },
      makePrReadiness(),
      "prompt-1",
    );

    expect(mockGetPrDraftState).toHaveBeenCalledWith(expect.anything(), "acme", "repo", 42);
    expect(mockMarkPullRequestReadyForReview).toHaveBeenCalledWith(expect.anything(), "PR_node_42");
    expect(enterReviewListening).toHaveBeenCalled();
    const commentBodies = mockCreatePrIssueComment.mock.calls.map((c) => String(c[4]));
    expect(commentBodies.some((b) => b.includes("this PR was opened as a draft"))).toBe(false);
  });

  it("fails ready republish before updating the PR body when draft-state reconciliation fails", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });
    mockGetPrDraftState.mockRejectedValue(new Error("GitHub PR draft-state lookup failed (502): bad gateway"));

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/confirmed-existing-draft",
      "Confirmed update",
      undefined,
      undefined,
      {
        verified: true,
        status: "passed",
        explanation: "Screenshot proof confirmed the UI change.",
        verdict: "CONFIRMED",
        publishMode: "normal",
      },
      makePrReadiness(),
      "prompt-1",
    );

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("failed");
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
  });

  it("attaches PR timeline events to the originating prompt", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, appendAndMirrorEvents } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/prompt-scoped-pr",
      "Updated the implementation",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([
        expect.objectContaining({
          type: "pr_created",
          data: expect.objectContaining({ promptId: "prompt-1" }),
        }),
        expect.objectContaining({
          type: "agent_timeline",
          data: expect.objectContaining({
            eventType: "pr.open",
            status: "completed",
            promptId: "prompt-1",
            metadata: expect.objectContaining({
              prUrl: "https://github.com/acme/repo/pull/42",
              prNumber: 42,
              branchName: "feature/prompt-scoped-pr",
            }),
          }),
        }),
      ]),
      "prompt-1",
    );
  });

  it("emits a PR failure event when post-create PR bookkeeping fails", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      prCreating: 1,
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });

    const { host, appendAndMirrorEvents, upsertPrWebhookRef, waitUntil } = createHost(storage);
    upsertPrWebhookRef.mockRejectedValueOnce(new Error("webhook ref failed"));
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/bookkeeping-fails", "Updated PR bookkeeping");

    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([
        expect.objectContaining({
          type: "pr_failed",
          data: expect.objectContaining({
            error: "PR creation failed: webhook ref failed",
          }),
        }),
        expect.objectContaining({
          type: "agent_timeline",
          data: expect.objectContaining({
            eventType: "pr.open",
            status: "failed",
          }),
        }),
      ]),
    );
    expect(mockDeliverThreadStatus).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("broadcasts pr_updated before persisting the durable pr_updated event", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
      repoPrivate: 1,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix the update flow",
      actorUserId: "user-1",
      status: "completed",
      resultJson: JSON.stringify({ diffSummary: "Updated the implementation" }),
    });

    const { host, broadcast, appendAndMirrorEvents, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(SESSION_ID, "feature/pr-update", "Updated the implementation");

    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      42,
      expect.objectContaining({
        body: expect.stringContaining(
          "📋 [Session transcript](https://app.trycycloid.com/sessions/session-pr-workflow)",
        ),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: "pr_updated",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      branchName: "feature/pr-update",
    });
    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([
        expect.objectContaining({
          type: "pr_updated",
          data: expect.objectContaining({
            sessionId: SESSION_ID,
            prUrl: "https://github.com/acme/repo/pull/42",
            prNumber: 42,
            branchName: "feature/pr-update",
          }),
        }),
        expect.objectContaining({
          type: "publish.pr.updated",
          data: expect.objectContaining({
            sessionId: SESSION_ID,
            prUrl: "https://github.com/acme/repo/pull/42",
            prNumber: 42,
            branchName: "feature/pr-update",
          }),
        }),
      ]),
    );
    const durableUpdateCallIndex = appendAndMirrorEvents.mock.calls.findIndex(
      ([, entries]) => Array.isArray(entries) && entries.some((entry) => entry.type === "pr_updated"),
    );
    expect(durableUpdateCallIndex).toBeGreaterThanOrEqual(0);
    const prUpdatedBroadcastCallIndex = broadcast.mock.calls.findIndex(([event]) => event?.type === "pr_updated");
    expect(prUpdatedBroadcastCallIndex).toBeGreaterThanOrEqual(0);
    expect(broadcast.mock.invocationCallOrder[prUpdatedBroadcastCallIndex]).toBeLessThan(
      appendAndMirrorEvents.mock.invocationCallOrder[durableUpdateCallIndex],
    );
    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      Array.isArray(entries) ? entries.map((entry) => entry.type) : [],
    );
    expect(eventTypes.indexOf("publish.completed")).toBeLessThan(eventTypes.indexOf("review_listening.entered"));

    const publishCompletedCallIndex = appendAndMirrorEvents.mock.calls.findIndex(
      ([, entries]) => Array.isArray(entries) && entries.some((entry) => entry.type === "publish.completed"),
    );
    expect(publishCompletedCallIndex).toBeGreaterThanOrEqual(0);
    expect(enterReviewListening.mock.invocationCallOrder[0]).toBeGreaterThan(
      appendAndMirrorEvents.mock.invocationCallOrder[publishCompletedCallIndex],
    );
  });

  it("does not enter review listening on PR update when installation capabilities are missing", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
      repoPrivate: 1,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix the update flow",
      actorUserId: "user-1",
      status: "completed",
      resultJson: JSON.stringify({ diffSummary: "Updated the implementation" }),
    });
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "installation_capabilities_missing" });

    const { host, appendAndMirrorEvents, enterReviewListening } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(SESSION_ID, "feature/pr-update", "Updated the implementation");

    expect(mockUpdatePullRequest).toHaveBeenCalled();
    expect(enterReviewListening).not.toHaveBeenCalled();

    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      Array.isArray(entries) ? entries.map((entry) => entry.type) : [],
    );
    expect(eventTypes).toContain("publish.completed");
    expect(eventTypes).not.toContain("review_listening.entered");
  });

  it("does not enter review listening when review-loop eligibility lookup fails", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    mockResolveReviewLoopChecklist.mockRejectedValueOnce(new Error("settings unavailable"));

    const { host, enterReviewListening, appendAndMirrorEvents, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/review-loop-lookup-error",
      "Updated review loop gating",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(enterReviewListening).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, ownerUserId: "101", error: "Error: settings unavailable" }),
      "Failed to resolve review-loop eligibility after publish; skipping review listening",
    );

    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      Array.isArray(entries) ? entries.map((entry) => entry.type) : [],
    );
    expect(eventTypes).toContain("publish.completed");
    expect(eventTypes).not.toContain("review_listening.entered");
  });

  it("updates subsequent PR bodies without a dedicated visual evidence comment", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/evidence-comment-update",
      "Initial publish",
      undefined,
      undefined,
      { verified: true, explanation: "Initial publish." },
      makePrReadiness(),
    );
    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/evidence-comment-update",
      "Updated publish output",
      undefined,
      undefined,
      { verified: true, explanation: "Updated publish." },
      makePrReadiness(),
    );

    expect(mockUpdatePullRequest).toHaveBeenCalled();
  });

  it("publishes successfully without creating a visual evidence comment", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/evidence-comment-best-effort",
      "Tightened publish output",
      undefined,
      undefined,
      {
        verified: true,
        explanation: "Focused bridge test passed.",
      },
      makePrReadiness(),
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pr_created",
        prUrl: "https://github.com/acme/repo/pull/42",
        prNumber: 42,
      }),
    );
    expect(appendAndMirrorEvents).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([expect.objectContaining({ type: "pr_failed" })]),
    );
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(ext?.publishStatus).toBe("published");
  });

  it("falls back to the installation token for remote branch verification", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    mockGetPrHeadSha.mockRejectedValueOnce(new Error("(401) bad credentials")).mockResolvedValueOnce("deadbeef");

    await workflow.triggerPrCreation(SESSION_ID, "feature/install-fallback", "Updated branch verification");

    expect(mockGetPrHeadSha).toHaveBeenNthCalledWith(1, "ghu_test", "acme", "repo", "feature/install-fallback");
    expect(mockGetPrHeadSha).toHaveBeenNthCalledWith(2, "ghs_install", "acme", "repo", "feature/install-fallback");
    expect(mockCreatePullRequest).toHaveBeenCalled();
  });

  it("falls back to the installation token when looking up an existing open PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
    });
    mockFindOpenPrByHead
      .mockRejectedValueOnce(new Error("(401) bad credentials"))
      .mockResolvedValueOnce({ prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(SESSION_ID, "feature/open-pr-fallback", "Updated branch verification");

    const expectedMarker = "<!-- cycloid-dedup: session-pr-workflow:no_prompt -->";
    expect(mockFindOpenPrByHead).toHaveBeenNthCalledWith(
      1,
      "ghu_test",
      "acme",
      "repo",
      "feature/open-pr-fallback",
      expectedMarker,
    );
    expect(mockFindOpenPrByHead).toHaveBeenNthCalledWith(
      2,
      "ghs_install",
      "acme",
      "repo",
      "feature/open-pr-fallback",
      expectedMarker,
    );
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).toHaveBeenCalled();
  });

  it("recovers via the dedup marker when a PR exists on GitHub but no D1 row was recorded", async () => {
    // ARC-1014: simulate a crash between createPr and the D1 write. No prUrl in
    // D1, but the open PR on the head branch carries this attempt's marker.
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    mockFindOpenPrByHead.mockResolvedValue({
      prUrl: "https://github.com/acme/repo/pull/77",
      prNumber: 77,
      branchName: "feature/recover",
      matchedMarker: true,
    });

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/recover",
      "diff",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    // The marker query is passed to the GitHub lookup...
    expect(mockFindOpenPrByHead).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      "feature/recover",
      "<!-- cycloid-dedup: session-pr-workflow:prompt-1 -->",
    );
    // ...the existing PR is adopted (update, not a second create)...
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).toHaveBeenCalled();
    // ...and the recovery path is logged for the us5 Datadog panel.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pr_create_recovery_via_marker", prNumber: 77 }),
      "pr_create_recovery_via_marker",
    );
  });

  it("logs the legacy branch-head fallback distinctly when the adopted PR carries no marker", async () => {
    // ARC-1014: an open PR exists on the head branch but has no dedup marker
    // (e.g. created before this change). It is still adopted, but logged as a
    // fallback rather than a confirmed marker recovery.
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    mockFindOpenPrByHead.mockResolvedValue({
      prUrl: "https://github.com/acme/repo/pull/88",
      prNumber: 88,
      branchName: "feature/legacy",
      matchedMarker: false,
    });

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/legacy",
      "diff",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pr_create_adopted_head_pr_without_marker", prNumber: 88 }),
      "pr_create_adopted_head_pr_without_marker",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "pr_create_recovery_via_marker" }),
      "pr_create_recovery_via_marker",
    );
  });

  it("embeds the dedup marker in the PR body on create", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/marker",
      "diff",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalled();
    const createdBody = (mockCreatePullRequest.mock.calls[0][0] as { body: string }).body;
    expect(createdBody).toContain("<!-- cycloid-dedup: session-pr-workflow:prompt-1 -->");
    expect(createdBody).not.toContain(CYCLOID_CO_AUTHOR_TRAILER);
  });

  it("preserves prior artifact evidence sections across PR update and polish writes", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      repoPrivate: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    const bodyWithArtifacts = [
      "## Summary",
      "- Captured the rendered state.",
      "",
      "## Screenshots",
      "![after](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/after.png?artifactToken=token)",
      "",
      "## Videos",
      "- [run](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/run.webm)",
      "",
      "## Verification",
      "- Tests: completed.",
    ].join("\n");

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/pr-update",
      undefined,
      undefined,
      bodyWithArtifacts,
      undefined,
      undefined,
      "prompt-1",
    );

    mockUpdatePullRequest.mockClear();

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/pr-update",
      undefined,
      undefined,
      "## Summary\n- Follow-up wording.\n\n## Verification\n- Tests: completed again.",
      undefined,
      undefined,
      "prompt-2",
    );

    const updatePayload = lastPrBodyUpdate();
    expect(updatePayload.body).toContain("## Summary\n- Follow-up wording.");
    expect(updatePayload.body).toContain("## Screenshots");
    expect(updatePayload.body).toContain("![after](https://app.trycycloid.com");
    expect(updatePayload.body).toContain("## Videos");
    expect(updatePayload.body).toContain("- [run](https://app.trycycloid.com");
  });

  it("keeps preserved screenshots and videos after a new verdict on follow-up update", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      repoPrivate: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/pr-update",
      undefined,
      undefined,
      [
        "## Verification Verdict",
        "- Verdict: INCONCLUSIVE.",
        "",
        "## Screenshots",
        "![before](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/before.png?artifactToken=token)",
        "",
        "## Videos",
        "- [run](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/run.webm)",
      ].join("\n"),
      undefined,
      "prompt-1",
    );

    mockUpdatePullRequest.mockClear();

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/pr-update",
      undefined,
      undefined,
      "## Summary\n- Follow-up wording.",
      {
        verified: true,
        verdict: "CONFIRMED",
        explanation: "Follow-up verification passed.",
        evidence: [{ type: "command", label: "tests (agent)", status: "passed", command: "npm test" }],
      },
      "prompt-2",
    );

    const updatePayload = lastPrBodyUpdate();
    expect(updatePayload.body).toContain("- Verdict: Pass.");
    expect(updatePayload.body).toContain("- Publish: ready for review.");
    expect(updatePayload.body).not.toContain("- Verdict: INCONCLUSIVE.");
    expect(updatePayload.body.indexOf("## Verdict")).toBeGreaterThanOrEqual(0);
    expect(updatePayload.body.indexOf("## Screenshots")).toBeGreaterThanOrEqual(0);
    expect(updatePayload.body.indexOf("## Videos")).toBeGreaterThanOrEqual(0);
    expect(updatePayload.body.indexOf("## Verdict")).toBeLessThan(updatePayload.body.indexOf("## Screenshots"));
    expect(updatePayload.body.indexOf("## Verdict")).toBeLessThan(updatePayload.body.indexOf("## Videos"));
  });

  it("preserves artifact evidence seeded by PR creation across follow-up updates", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      repoPrivate: 1,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/pr-creation",
      undefined,
      undefined,
      [
        "## Summary",
        "- Captured the rendered state.",
        "",
        "## Screenshots",
        "![after](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/after.png?artifactToken=token)",
        "",
        "## Verification",
        "- Tests: completed.",
      ].join("\n"),
      undefined,
      undefined,
      "prompt-1",
    );

    mockUpdatePullRequest.mockClear();

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/pr-creation",
      undefined,
      undefined,
      "## Summary\n- Follow-up wording.\n\n## Verification\n- Tests: completed again.",
      undefined,
      undefined,
      "prompt-2",
    );

    const updatePayload = lastPrBodyUpdate();
    expect(updatePayload.body).toContain("## Summary\n- Follow-up wording.");
    expect(updatePayload.body).toContain("## Screenshots");
    expect(updatePayload.body).toContain("![after](https://app.trycycloid.com");
  });

  it("patches an existing branch PR with rendered artifact evidence during creation", async () => {
    mockCreatePullRequest.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      branchName: "feature/pr-creation",
      created: false,
    });
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      repoPrivate: 0,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/pr-creation",
      undefined,
      "Fix inline screenshots",
      [
        "## Summary",
        "- Captured the rendered state.",
        "",
        "## Screenshots",
        "![after](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/after.png?artifactToken=token)",
        "",
        "## Verification",
        "- Tests: completed.",
      ].join("\n"),
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockUpdatePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, {
      body: expect.stringContaining(
        "![after](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/after.png?artifactToken=token)",
      ),
    });
  });

  it("retries adopted PR body updates without recreating the PR", async () => {
    mockCreatePullRequest.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      branchName: "feature/pr-creation",
      created: false,
    });
    mockUpdatePullRequest
      .mockRejectedValueOnce(new Error("GitHub PR update failed (401): Bad credentials"))
      .mockResolvedValueOnce(undefined);
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
      repoPrivate: 0,
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrCreation(
      SESSION_ID,
      "feature/pr-creation",
      undefined,
      "Fix inline screenshots",
      [
        "## Summary",
        "- Captured the rendered state.",
        "",
        "## Screenshots",
        "![after](https://app.trycycloid.com/api/sessions/session-pr-workflow/artifacts/after.png?artifactToken=token)",
        "",
        "## Verification",
        "- Tests: completed.",
      ].join("\n"),
      undefined,
      undefined,
      "prompt-1",
    );

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdatePullRequest).toHaveBeenNthCalledWith(1, "ghu_test", "acme", "repo", 42, {
      body: expect.stringContaining("## Screenshots"),
    });
    expect(mockUpdatePullRequest).toHaveBeenNthCalledWith(2, "ghs_install", "acme", "repo", 42, {
      body: expect.stringContaining("## Screenshots"),
    });
  });

  it("logs PR event emission for update failures after persisting the session error", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      repoPrivate: 1,
    });
    mockUpdatePullRequest.mockRejectedValueOnce(new Error("boom"));

    const { host, appendAndMirrorEvents, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    await workflow.triggerPrUpdate(
      SESSION_ID,
      "feature/pr-update",
      "Updated the implementation",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
    );

    expect(appendAndMirrorEvents).toHaveBeenCalledWith(
      SESSION_ID,
      [
        expect.objectContaining({
          type: "session_error",
          data: expect.objectContaining({
            code: "pr_update",
            error: "PR update failed: Error: boom",
          }),
        }),
      ],
      "prompt-1",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pr_workflow.github_create_or_update",
      }),
      "PR workflow GitHub create/update completed",
    );
  });

  it("falls back to the stored prUrl in handleNotifyPrMergedRequest", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);
    mockPostThreadReply.mockResolvedValueOnce({ ok: true, ts: "200.100" });

    const response = await workflow.handleNotifyPrMergedRequest(
      new Request("https://internal/session/notify-pr-merged", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, notified: true });
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "1712345678.000100",
      "PR merged: https://github.com/acme/repo/pull/42",
      expect.any(Array),
    );
    expect(mockClaimSlackPrMergedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SESSION_ID, prUrl: "https://github.com/acme/repo/pull/42" }),
    );
    expect(doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID)?.callbackContext).toMatchObject({
      resultMessageTs: "200.100",
      resultPromptId: "https://github.com/acme/repo/pull/42",
    });
  });

  it("does not double-post the PR-merged reply when the dedupe claim is already taken", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });
    // A concurrent / redelivered merge trigger already claimed the post.
    mockClaimSlackPrMergedPost.mockResolvedValue(false);

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    const response = await workflow.handleNotifyPrMergedRequest(
      new Request("https://internal/session/notify-pr-merged", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, notified: false });
    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("releases the PR-merged claim when the Slack post fails so a retry can re-post", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      }),
    });
    mockPostThreadReply.mockResolvedValue({ ok: false, error: "channel_not_found" });

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    const response = await workflow.handleNotifyPrMergedRequest(
      new Request("https://internal/session/notify-pr-merged", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, notified: false });
    expect(mockDeleteSlackPrMergedPostMarker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SESSION_ID, prUrl: "https://github.com/acme/repo/pull/42" }),
    );
  });

  it("skips Slack PR-merged notifications for legacy callback contexts without a team id", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      callbackContextJson: JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
      }),
    });
    mockResolveSlackBotTokenForCallback.mockResolvedValueOnce(null);

    const { host, logger } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    const response = await workflow.handleNotifyPrMergedRequest(
      new Request("https://internal/session/notify-pr-merged", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, notified: false });
    expect(mockResolveSlackBotTokenForCallback).toHaveBeenCalledWith(
      host.env,
      {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
      },
      {
        sessionId: SESSION_ID,
        operation: "notifySlackPrMerged",
      },
    );
    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        sessionId: SESSION_ID,
        source: "slack",
        slackTeamId: undefined,
      },
      "Slack PR-merged notification skipped: no bot token",
    );
  });

  it("runs review-loop pushes through a dedicated idempotent operation API", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published", operationId: expect.any(String) }));
    expect(mockBeginReviewLoopOperationAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "push", epochId: "epoch-1", headSha: "deadbeef" }),
    );
    expect(mockMarkReviewLoopOperationSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      "op-1",
      expect.objectContaining({ githubId: "deadbeef" }),
    );
  });

  it("allows review-loop publish after the prompt push advances the PR head to its commit", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ headSha: "old-head", worklistHash: "worklist-hash" }),
    );
    mockGetPrHeadSha.mockResolvedValue("new-head");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "new-head",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockBeginReviewLoopOperationAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "push", epochId: "epoch-1", headSha: "old-head" }),
    );
    expect(mockMarkReviewLoopOperationSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      "op-1",
      expect.objectContaining({ githubId: "new-head" }),
    );
  });

  it("blocks review-loop publish when the PR head changed to a different commit", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ headSha: "old-head", worklistHash: "worklist-hash" }),
    );
    mockGetPrHeadSha.mockResolvedValue("third-party-commit");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "agent-commit",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Review-loop publish blocked: PR head changed while responding to review.",
    });
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
  });

  it("rejects a review-loop push when the remote branch advanced to a third-party head (PR-7)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ headSha: "old-head", worklistHash: "worklist-hash" }),
    );
    // The guard sees the agent's pushed head (passes); verifyRemoteBranch then reads a third-party
    // branch head that is NOT an accepted head for the epoch, so the push fails closed (retryable)
    // and is never marked succeeded — an unrelated head is never recorded as the agent's push.
    mockGetPrHeadSha.mockResolvedValueOnce("new-head").mockResolvedValueOnce("third-party-commit");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "new-head",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, retryable: true }));
    expect(mockMarkReviewLoopOperationSucceeded).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopOperationFailed).toHaveBeenCalled();
  });

  it("blocks a review-loop push when the PR is merged (PR-7)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockReviewLoopPrState = "merged";

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual({ ok: false, reason: "Review-loop publish blocked: the PR is merged." });
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
  });

  // Task 5: the guard classifies each failure as benign (the PR/session moved on — not a real
  // failure) vs genuine (needs user action). publishReviewLoopPush collapses both arms to
  // { ok: false, reason }, so the new `benign` flag is only observable on the private guard result —
  // reach it directly (production visibility unchanged) and cast in the test.
  type ReviewLoopGuardForTest = {
    validateReviewLoopPublishGuard: (
      request: { sessionId: string; promptId: string; branch: string; commitSha?: string; prReadiness?: unknown },
      session: unknown,
      ext: unknown,
      auth: unknown,
    ) => Promise<{ ok: boolean; reason?: string; benign?: boolean; epochId?: string | null }>;
  };

  const setupReviewLoopGuard = (storage: FakeStorage) => {
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    const sql = storage.sql as unknown as SqlStorage;
    const { host } = createHost(storage);
    const service = new SessionPublishService(host) as unknown as ReviewLoopGuardForTest;
    const session = doDb.getSession(sql, SESSION_ID);
    const ext = doDb.getSessionExtended(sql, SESSION_ID);
    const auth = {
      sessionId: SESSION_ID,
      token: "ghu_test",
      tokenSource: "user" as const,
      installationId: 123,
      installationToken: null,
      repoOwner: "acme",
      repoName: "repo",
      ext,
    };
    return { service, session, ext, auth };
  };

  it("classifies a merged-PR guard block as benign", async () => {
    const storage = new FakeStorage();
    const { service, session, ext, auth } = setupReviewLoopGuard(storage);
    // A review-loop publish whose PR is merged (getPrMergeStatus -> state "merged").
    mockReviewLoopPrState = "merged";
    const request = {
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    };

    const guard = await service.validateReviewLoopPublishGuard(request, session, ext, auth);

    expect(guard.ok).toBe(false);
    expect(guard.reason).toBe("Review-loop publish blocked: the PR is merged.");
    expect((guard as { benign?: boolean }).benign).toBe(true);
  });

  it("classifies a missing-readiness guard block as genuine (not benign)", async () => {
    const storage = new FakeStorage();
    const { service, session, ext, auth } = setupReviewLoopGuard(storage);
    const request = {
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: undefined,
    };

    const guard = await service.validateReviewLoopPublishGuard(request, session, ext, auth);

    expect(guard.ok).toBe(false);
    expect(guard.reason).toBe("Review-loop publish blocked: missing publish readiness evidence.");
    expect((guard as { benign?: boolean }).benign).toBeFalsy();
  });

  // Task 6: benign guard blocks (the PR/session moved on) are a NEUTRAL outcome — the session
  // settles in `superseded` (not a red publish terminal), the `pr.open` timeline event is
  // `completed` + `metadata.superseded`, and there is deliberately NO `pr_failed` broadcast.
  it("routes a benign guard block (merged PR) to superseded and emits no pr_failed", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    // The PR merged while the agent was responding — benign "moved on", not a real failure.
    mockReviewLoopPrState = "merged";

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "agent-commit",
      prBody: "Review-loop response",
      prReadiness: makePrReadiness(),
    });

    const reason = "Review-loop publish blocked: the PR is merged.";
    expect(result).toEqual({ ok: true, status: "superseded", reason });

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("superseded");
    // Benign blocks carry no red error.
    expect(ext?.publishError).toBeNull();

    const entries = appendAndMirrorEvents.mock.calls.flatMap(
      ([, e]) => e as Array<{ type: string; data: Record<string, unknown> }>,
    );
    // The terminal pr.open agent-timeline event is neutral: completed + superseded, not failed.
    // (An earlier "started" pr.open is emitted at publish entry; the block's terminal event is last.)
    const prOpen = entries
      .filter((e) => e.type === "agent_timeline" && (e.data as { eventType?: string }).eventType === "pr.open")
      .at(-1);
    expect(prOpen?.data.status).toBe("completed");
    expect((prOpen?.data.metadata as { superseded?: boolean } | undefined)?.superseded).toBe(true);
    // A neutral publish.superseded durable event is emitted; NO pr_failed entry or broadcast.
    expect(entries.some((e) => e.type === "publish.superseded")).toBe(true);
    expect(entries.some((e) => e.type === "pr_failed")).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
  });

  it("keeps a genuine guard block (missing readiness) red: failed + pr_failed", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    // Head matches the epoch so the (benign) head guard passes; missing readiness is the GENUINE failure.
    mockGetPrHeadSha.mockResolvedValue("deadbeef");

    const { host, broadcast } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prBody: "Review-loop response",
      prReadiness: undefined,
    });

    const reason = "Review-loop publish blocked: missing publish readiness evidence.";
    // ARC-1330 D-57: the pre-publish block status was deleted — a genuine guard block now settles on
    // the ordinary loud `failed` publish terminal (`failPublish` returns `{ ok: false, response }`).
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed publish result");
    expect(result.response.status).toBe(500);

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("failed");
    expect(ext?.publishError).toBe(reason);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
  });

  it("routes a benign head-changed review-loop block to superseded (neutral, reload-visible)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ headSha: "old-head", worklistHash: "worklist-hash" }),
    );
    mockGetPrHeadSha.mockResolvedValue("third-party-commit");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "agent-commit",
      prBody: "Review-loop response",
      prReadiness: makePrReadiness(),
    });

    const reason = "Review-loop publish blocked: PR head changed while responding to review.";
    // A third-party push moved the PR head — benign "moved on", so the session settles neutral.
    expect(result).toEqual({ ok: true, status: "superseded", reason });
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("superseded");
    expect(ext?.publishError).toBeNull();
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
  });

  // PR-2: the reply guard must finish the #4987 self-head-advance fix. After the agent pushes a fix
  // the PR head advances past epoch.headSha; a reply to the addressed comment must still be allowed
  // when the live head is the epoch's OWN pushed SHA, but rejected for any third-party head change.
  const seedReplyFixture = (storage: FakeStorage, epochHeadSha: string) => {
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ headSha: epochHeadSha, worklistHash: "worklist-hash" }),
    );
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-comment:10",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r10",
          reviewThreadId: "PRRT_thread10",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Please fix this.",
          path: "src/foo.ts",
          line: 10,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });
  };

  it("allows a review-loop reply after the prompt push advanced the PR head to the epoch's own pushed SHA", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "old-head");
    mockGetPrHeadSha.mockResolvedValue("new-head");
    // The epoch's own most-recent succeeded push advanced the head to "new-head".
    mockSelectLatestSucceededReviewLoopPushHead.mockResolvedValue("new-head");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied" }));
    expect(mockSelectLatestSucceededReviewLoopPushHead).toHaveBeenCalledWith(expect.anything(), "epoch-1");
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(expect.anything(), 123);
    expect(mockGetPrHeadSha).toHaveBeenCalledWith("ghs_install", "acme", "repo", 42);
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalled();
  });

  it("posts the verdict reply for a PROMPTED comment the live worklist dropped (own fix flipped the thread outdated)", async () => {
    // PR #7656: the agent fixed the commented code and pushed; GitHub flipped the thread isOutdated,
    // the live worklist refetch dropped it (thread_outdated unpromptable), and the contractual "fixed"
    // reply was rejected as "not in the current worklist" — the comment ended silently disposed. An id
    // the epoch PROMPTED must stay reply-targetable via the epoch-owned fallback.
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({
        headSha: "old-head",
        worklistHash: "worklist-hash",
        promptedSourceIds: ["review-comment:10"],
        triggeringSourceIds: ["review-comment:10"],
      }),
    );
    // The epoch's own push advanced the head (the #4987 carve-out admits it) …
    mockGetPrHeadSha.mockResolvedValue("new-head");
    mockSelectLatestSucceededReviewLoopPushHead.mockResolvedValue("new-head");
    // … and the rebuilt worklist no longer surfaces the addressed comment (outdated → dropped).
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [],
      duplicateGroups: [],
      worklistHash: "worklist-hash-after-push",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied" }));
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledWith(
      "ghs_install",
      "acme",
      "repo",
      42,
      10,
      "Fixed in the latest push.",
    );
    // No live worklist item → no known review thread; the auto-resolve step must be skipped, not throw.
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("posts review-loop replies and resolves review threads with the GitHub App installation token", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "deadbeef");
    mockGetValidGithubToken.mockResolvedValueOnce("ghu_user_should_not_post");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied" }));
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(expect.anything(), 123);
    expect(mockGetPrHeadSha).toHaveBeenCalledWith("ghs_install", "acme", "repo", 42);
    expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith("ghs_install", "acme", "repo", 42, expect.anything());
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledWith(
      "ghs_install",
      "acme",
      "repo",
      42,
      10,
      "Fixed in the latest push.",
    );
    expect(mockResolvePrReviewThread).toHaveBeenCalledWith("ghs_install", "PRRT_thread10");
  });

  it("blocks review-loop replies when installation capabilities are unavailable", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "deadbeef");
    mockResolveReviewLoopChecklist.mockResolvedValueOnce({
      ok: false,
      reason: "installation_capabilities_missing",
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop operation blocked: installation_capabilities_missing.",
      }),
    );
    expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("fails closed when the review-loop reply installation token cannot be minted", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "deadbeef");
    mockCreateInstallationToken.mockRejectedValueOnce(new Error("app token unavailable"));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop operation blocked: GitHub App installation token is unavailable.",
      }),
    );
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_installation_token_unavailable",
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        epochId: "epoch-1",
        installationId: 123,
        error: "app token unavailable",
      }),
      "Review-loop reply blocked: installation token mint failed",
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("blocks a review-loop reply when the live head is a third-party commit, not the epoch's pushed SHA", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "old-head");
    mockGetPrHeadSha.mockResolvedValue("third-party-commit");
    mockSelectLatestSucceededReviewLoopPushHead.mockResolvedValue("agent-commit");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop operation blocked: PR head changed while responding to review.",
      }),
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("never accepts an arbitrary advanced head for a reply when the epoch has no succeeded push", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "old-head");
    mockGetPrHeadSha.mockResolvedValue("new-head");
    // No succeeded push recorded for the epoch → only epoch.headSha is acceptable.
    mockSelectLatestSucceededReviewLoopPushHead.mockResolvedValue(null);

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop operation blocked: PR head changed while responding to review.",
      }),
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("blocks a review-loop reply when the PR is closed (PR-7)", async () => {
    const storage = new FakeStorage();
    seedReplyFixture(storage, "deadbeef");
    mockReviewLoopPrState = "closed";

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);
    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "Review-loop operation blocked: the PR is closed." }),
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("publishes a human-source epoch via human eligibility, not the bot checklist", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to the human PR review",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    // Human epoch carries the empty expected-bots hash; the bot checklist would always fail here.
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ sourceKind: "human", expectedBotsHash: "empty-hash", worklistHash: "wl" }),
    );
    mockResolveReviewLoopChecklist.mockResolvedValue({
      ok: true,
      expectedBots: [],
      expectedBotsHash: "empty",
      installationId: 123,
    });
    mockResolveReviewLoopHumanEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 123 });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    // The push must NOT be blocked by the bot checklist — human eligibility gates it instead.
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalled();
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
  });

  it("surfaces review-loop changed-file threshold alerts in the PR body without blocking publish", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ sourceKind: "human", worklistHash: "wl" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 123 });

    const { host, logger } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prBody: "Review-loop response",
      prReadiness: {
        ...makePrReadiness(),
        changedFiles: Array.from({ length: 11 }, (_, index) => `src/file-${index}.ts`),
        diffStats: { raw: "11 files changed, 11 insertions(+)", filesChanged: 11, insertions: 11, deletions: 0 },
      },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    const reason = "Review-loop changes need owner review: 11 changed files exceeds the 10-file threshold.";
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      42,
      expect.objectContaining({
        body: expect.stringContaining(`Manual review: ${reason}`),
      }),
    );
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("published");
    expect(ext?.prManualReviewReason).toBe(reason);
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, promptId: "prompt-1", changedFiles: 11 }),
      "Review-loop publish size alert: changed file count exceeded threshold",
    );
  });

  it("surfaces review-loop changed-line threshold alerts in the PR body without blocking publish", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ sourceKind: "human", worklistHash: "wl" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue({ ok: true, ownerUserId: 101, installationId: 123 });

    const { host, logger } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prBody: "Review-loop response",
      prReadiness: {
        ...makePrReadiness(),
        diffStats: { raw: "1 file changed, 301 insertions(+)", filesChanged: 1, insertions: 301, deletions: 0 },
      },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
    const reason = "Review-loop changes need owner review: 301 changed lines exceeds the 300-line threshold.";
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      "ghu_test",
      "acme",
      "repo",
      42,
      expect.objectContaining({
        body: expect.stringContaining(`Manual review: ${reason}`),
      }),
    );
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("published");
    expect(ext?.prManualReviewReason).toBe(reason);
    expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, promptId: "prompt-1", changedLines: 301 }),
      "Review-loop publish size alert: changed line count exceeded threshold",
    );
  });

  it("blocks a ci-source publish push when repo CI response is disabled", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix failing CI",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ sourceKind: "ci", expectedBotsHash: "ci-fixes", worklistHash: "ci-fail:unit" }),
    );
    mockResolveReviewLoopCiEligibility.mockResolvedValueOnce({ ok: false, reason: "ci_response_disabled" });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "Review-loop publish blocked: ci_response_disabled." }),
    );
    expect(mockResolveReviewLoopCiEligibility).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: 101, repoOwner: "acme", repoName: "repo" }),
    );
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
  });

  it("recovers a late review-loop push when the verified remote head matches the agent's commit (ARC-1407)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    // A concurrent sweep advanced the epoch after the guard read, so the publishing CAS refuses — but the
    // agent's push already landed (remote head == commitSha), so the evidence must not be discarded.
    mockMarkReviewLoopEpochPublishing.mockResolvedValueOnce(null);

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published", commitSha: "deadbeef" }));
    expect(mockMarkReviewLoopOperationSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      "op-1",
      expect.objectContaining({ githubId: "deadbeef" }),
    );
    expect(mockCompleteReviewLoopEpochFromVerifiedPush).toHaveBeenCalledWith(
      expect.anything(),
      "epoch-1",
      expect.objectContaining({ verifiedHeadSha: "deadbeef" }),
    );
    expect(mockMarkReviewLoopOperationFailed).not.toHaveBeenCalled();
  });

  it("does not recover a late push when the remote head diverges from the agent's commit (ARC-1407)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ headSha: "old-head", worklistHash: "worklist-hash" }),
    );
    mockMarkReviewLoopEpochPublishing.mockResolvedValueOnce(null);
    // Guard accepts the agent's self-advance to "new-head"; the recovery's verifyRemoteBranch then reads
    // a divergent third-party head, so the push is NOT self-authenticating and must stay failed.
    mockGetPrHeadSha.mockResolvedValueOnce("new-head").mockResolvedValueOnce("third-party-commit");

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "new-head",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop push blocked: review iteration is not processing this prompt.",
      }),
    );
    expect(mockMarkReviewLoopOperationSucceeded).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopOperationFailed).toHaveBeenCalledWith(
      expect.anything(),
      "op-1",
      expect.objectContaining({ error: "epoch_not_processing" }),
    );
    expect(mockCompleteReviewLoopEpochFromVerifiedPush).not.toHaveBeenCalled();
  });

  it("does not attempt recovery when the agent reported no commit sha (strict fail-closed) (ARC-1407)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockMarkReviewLoopEpochPublishing.mockResolvedValueOnce(null);

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop push blocked: review iteration is not processing this prompt.",
      }),
    );
    expect(mockMarkReviewLoopOperationFailed).toHaveBeenCalledWith(
      expect.anything(),
      "op-1",
      expect.objectContaining({ error: "epoch_not_processing" }),
    );
    expect(mockMarkReviewLoopOperationSucceeded).not.toHaveBeenCalled();
    expect(mockCompleteReviewLoopEpochFromVerifiedPush).not.toHaveBeenCalled();
  });

  it("does not re-enter publishing when a review-loop push operation already landed", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ status: "publishing", worklistHash: "worklist-hash" }),
    );
    mockBeginReviewLoopOperationAttempt.mockResolvedValueOnce({
      status: "already_succeeded",
      operation: { operationId: "op-push", status: "succeeded", attempts: 1, githubId: "deadbeef" },
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "already_published", operationId: "op-push" }));
    expect(mockMarkReviewLoopEpochPublishing).not.toHaveBeenCalled();
  });

  it("does not fail the publish flow when a review-loop push operation is already running", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockBeginReviewLoopOperationAttempt.mockResolvedValueOnce({
      status: "conflict",
      operation: { operationId: "op-push", status: "running", attempts: 2, githubId: null },
    });

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
      prBody: "Review-loop response",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        status: "deferred",
        operationId: "op-push",
        reason: "Review-loop push is already running for this operation.",
      }),
    );
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochPublishing).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopOperationSucceeded).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopOperationFailed).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      (entries as Array<{ type: string }>).map((entry) => entry.type),
    );
    expect(eventTypes).toContain("publish.started");
    expect(eventTypes).not.toContain("publish.failed");
    expect(eventTypes).not.toContain("pr_failed");
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("publishing");
  });

  it("fails closed to publishStatus=failed when a throw occurs before reaching publishing", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Compose a PR body",
      actorUserId: "101",
      status: "completed",
    });

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const publishService = new SessionPublishService(host);

    // ARC-960: composePrBody reads pr_body:latest before publishStatus reaches
    // "publishing". A throw here previously left the session stuck at its
    // pre-publish status with no watchdog armed. Force that read to throw and
    // assert publishSessionResult still lands a durable terminal failure.
    const originalGet = storage.get.bind(storage);
    vi.spyOn(storage, "get").mockImplementation((async (keyOrKeys: string | string[]) => {
      if (keyOrKeys === "pr_body:latest") {
        throw new Error("composePrBody storage failure");
      }
      return originalGet(keyOrKeys as never);
    }) as never);

    const result = await publishService.publishSessionResult({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/compose-throw",
      commitSha: "deadbeef",
      prBody: "Body",
      prReadiness: makePrReadiness(),
    });

    expect(result.ok).toBe(false);
    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("failed");
    expect(ext?.publishStage).toBe("verifying");
    expect(ext?.publishError).toBeTruthy();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      (entries as Array<{ type: string }>).map((entry) => entry.type),
    );
    expect(eventTypes).toContain("publish.failed");
    // The pre-publish path resolves (failPublish) rather than rejecting, so the
    // prompt-queue handoff catch can't report it — publishSessionResult must
    // capture the throw to Sentry itself.
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { sessionId: SESSION_ID, operation: "publishSessionResult", cause: "pre_publish_throw" },
    });
  });

  it("opens a ready PR when post-execution times out after the branch was pushed", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      lastBranch: "feature/post-execution-timeout",
      lastCommitSha: "deadbeef",
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Make the dashboard clearer",
      actorUserId: "101",
      status: "completed",
    });
    doDb.updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
      pushStatus: "succeeded",
      pushError: null,
    });

    const { host, broadcast, appendAndMirrorEvents } = createHost(storage);
    const publishService = new SessionPublishService(host);

    await publishService.failPublishOnTimeout({
      sessionId: SESSION_ID,
      phase: "post_execution",
      stage: "verifying",
      elapsedMs: 300_010,
      promptId: "prompt-1",
    });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_created", draft: true }));
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.publishStatus).toBe("published");
    expect(ext?.publishStage).toBe("done");
    expect(ext?.publishedBranch).toBe("feature/post-execution-timeout");
    expect(ext?.prDraft).toBe(false);

    const eventTypes = appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
      (entries as Array<{ type: string }>).map((entry) => entry.type),
    );
    expect(eventTypes).toContain("publish.pr.created");
    expect(eventTypes).toContain("publish.completed");
    expect(eventTypes).not.toContain("publish.failed");
  });

  it("does not recover a post-execution timeout using a stale prior branch without prompt push success", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      lastBranch: "feature/previous-prompt",
      lastCommitSha: "deadbeef",
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Make a new change",
      actorUserId: "101",
      status: "completed",
    });

    const { host, broadcast } = createHost(storage);
    const publishService = new SessionPublishService(host);

    await publishService.failPublishOnTimeout({
      sessionId: SESSION_ID,
      phase: "post_execution",
      stage: "verifying",
      elapsedMs: 300_010,
      promptId: "prompt-1",
    });

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_created" }));

    const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    expect(ext?.prUrl).toBeFalsy();
    expect(ext?.publishStatus).toBe("failed");
    expect(ext?.publishedBranch).toBeNull();
  });

  it("scopes post-execution timeout settings reads to one publish cache", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      lastBranch: "feature/post-execution-timeout",
      lastCommitSha: "deadbeef",
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Make the dashboard clearer",
      actorUserId: "101",
      status: "completed",
    });
    doDb.updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
      pushStatus: "succeeded",
      pushError: null,
    });

    const { host, getDefaultPrDraft } = createHost(storage);
    let defaultDraftSettingsCache: UserSettingsCache | undefined;
    Object.assign(host, {
      withPublishUserSettingsCache: vi.fn(async <T>(operation: (settingsCache: UserSettingsCache) => Promise<T>) => {
        return operation(new Map());
      }),
    });
    getDefaultPrDraft.mockImplementation(async (_ownerUserId, settingsCache) => {
      defaultDraftSettingsCache = settingsCache;
      return true;
    });
    const publishService = new SessionPublishService(host);

    await publishService.failPublishOnTimeout({
      sessionId: SESSION_ID,
      phase: "post_execution",
      stage: "verifying",
      elapsedMs: 300_010,
      promptId: "prompt-1",
    });

    // The recovery path resolves the draft setting through the shared publish cache.
    expect(defaultDraftSettingsCache).toBeDefined();
    expect(host.withPublishUserSettingsCache).toHaveBeenCalled();
    expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
  });

  it("exports publish_failed with automation provenance", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      initiationMode: InitiationMode.AUTOMATION,
      scheduledRuleId: "rule-1",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Make the dashboard clearer",
      actorUserId: "101",
      status: "completed",
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    await publishService.failPublishOnTimeout({
      sessionId: SESSION_ID,
      phase: "publishing",
      stage: "creating_pr",
      elapsedMs: 300_010,
      promptId: "prompt-1",
    });

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "publish_failed",
        session_id: SESSION_ID,
        prompt_id: "prompt-1",
        stage: "creating_pr",
        cause: "timeout",
        phase: "publishing",
        initiation_mode: "automation",
        scheduled_rule_id: "rule-1",
        reason: expect.stringContaining("Timed out"),
      }),
    );
  });

  it("does not mutate GitHub when a review-loop reply operation already landed", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockBeginReviewLoopOperationAttempt.mockResolvedValueOnce({
      status: "already_succeeded",
      operation: {
        operationId: "op-reply",
        status: "succeeded",
        attempts: 1,
        githubId: "987",
        verdict: null,
        verdictBasis: null,
      },
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "already_replied", operationId: "op-reply" }));
    expect(mockFillSucceededReviewLoopReplyVerdict).toHaveBeenCalledWith(
      expect.anything(),
      "op-reply",
      expect.objectContaining({ verdict: "fixed", verdictBasis: "Fixed in the latest push." }),
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
  });

  it("does not mutate GitHub when a review-loop reply operation start loses a CAS race", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockBeginReviewLoopOperationAttempt.mockResolvedValueOnce({
      status: "conflict",
      operation: { operationId: "op-reply", status: "running", attempts: 2, githubId: null },
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, operationId: "op-reply", retryable: true, reason: expect.any(String) }),
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopOperationSucceeded).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopOperationFailed).not.toHaveBeenCalled();
  });

  it("logs blocked review-loop replies with an empty body", async () => {
    const storage = new FakeStorage();
    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      body: "   ",
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "Review-loop reply blocked: reply body is empty." }),
    );
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_result",
        status: "blocked",
        reason: "Review-loop reply blocked: reply body is empty.",
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        epochId: "epoch-1",
        targetSourceId: "review-comment:10",
      }),
      "Review-loop reply blocked",
    );
  });

  it("rejects review-loop replies when the epoch is no longer active", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ status: "blocked", worklistHash: "worklist-hash" }),
    );

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: expect.stringContaining("not active") }));
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_result",
        status: "blocked",
        reason: expect.stringContaining("not active"),
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        epochId: "epoch-1",
        targetSourceId: "review-comment:10",
      }),
      "Review-loop reply blocked",
    );
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    expect(mockGetPrReviewLoopWorklist).not.toHaveBeenCalled();
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("rejects review-loop replies to source IDs outside the current head worklist", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:999",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: expect.stringContaining("current worklist") }));
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_result",
        status: "blocked",
        reason: "Review-loop reply blocked: target source review-comment:999 is not in the current worklist.",
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        epochId: "epoch-1",
        targetSourceId: "review-comment:999",
      }),
      "Review-loop reply blocked",
    );
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("accepts review-loop replies to duplicate source ids in duplicate groups", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-comment:10",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r10",
          reviewThreadId: "PRRT_thread10",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Please fix this.",
          path: "src/foo.ts",
          line: 10,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [{ canonicalSourceId: "review-comment:10", duplicateSourceIds: ["review-comment:11"] }],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:11",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied", githubId: "987" }));
    expect(mockBeginReviewLoopOperationAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetSourceId: "review-comment:11" }),
    );
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledWith(
      "ghs_install",
      "acme",
      "repo",
      42,
      11,
      "Fixed in the latest push.",
    );
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("replies to a human review body source id as a top-level PR (issue) comment", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ sourceKind: "human", expectedBotsHash: "empty-hash", worklistHash: "worklist-hash" }),
    );
    // The worklist surfaces a human review body item the agent may reply to.
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-body:55",
          sourceUrl: "https://github.com/acme/repo/pull/42#pullrequestreview-55",
          authorLogin: "alice",
          authorType: "User",
          body: "Please address the null guard before merge.",
          path: null,
          line: null,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-body:55",
      verdict: "fixed",
      body: "Done — added the guard.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied", githubId: "654" }));
    // A review body is answered with a top-level issue comment, not a threaded review reply.
    expect(mockCreatePrIssueComment).toHaveBeenCalled();
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("replies from a verification-intake epoch via the human gate, refetching the verification worklist", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Address verification findings",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({
        sourceKind: "verification",
        expectedBotsHash: "verification-intake",
        worklistHash: "worklist-hash",
      }),
    );
    // The refetched worklist surfaces the managed QA Tester comment (admitted by the verification kind).
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "issue-comment:5001",
          sourceUrl: "https://github.com/acme/repo/pull/42#issuecomment-5001",
          authorLogin: "cycloid[bot]",
          authorType: "Bot",
          body: "<!-- cycloid-qa:v1 owner=acme repo=repo pr=42 head=deadbeef -->\n\n## Cycloid QA",
          path: null,
          line: null,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "issue-comment:5001",
      verdict: "fixed",
      body: "Addressed the verification blockers.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied" }));
    // Verification epochs use the human gate, never the bot checklist (sentinel hash would fail it).
    expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalled();
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    // The refetch matches the worklist the agent was prompted with (QA Tester comment admitted).
    expect(mockGetPrReviewLoopWorklist).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo",
      42,
      expect.objectContaining({ sourceKind: "verification" }),
    );
    expect(mockCreatePrIssueComment).toHaveBeenCalled();
    expect(mockCreatePrIssueComment).toHaveBeenCalledWith(
      "ghs_install",
      "acme",
      "repo",
      42,
      expect.stringContaining("Source: https://github.com/acme/repo/pull/42#issuecomment-5001"),
    );
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("rejects review-loop replies to CI check-run-failure source ids with a specific reason", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to CI failures",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ sourceKind: "ci", expectedBotsHash: "ci-fixes", worklistHash: "worklist-hash" }),
    );
    mockResolveReviewLoopCiEligibility.mockResolvedValueOnce({ ok: true, ownerUserId: 101, installationId: 123 });
    // Intentionally do NOT stub the worklist to surface the check-run-failure item: production's
    // getPrReviewLoopWorklist (review threads + issue comments only) never returns a
    // `check-run-failure:` source id, so the rejection must not depend on it being present. The
    // early check-run-failure guard rejects before any worklist refetch (asserted below).

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "check-run-failure:777",
      verdict: "replied",
      body: "Looking into the CI failure.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: expect.stringContaining("CI check-run failures cannot be replied to"),
      }),
    );
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_result",
        status: "blocked",
        reason:
          "Review-loop reply blocked: CI check-run failures cannot be replied to; push a fix or post a summary instead.",
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        epochId: "epoch-1",
        targetSourceId: "check-run-failure:777",
      }),
      "Review-loop reply blocked",
    );
    // The early guard short-circuits before the worklist refetch, so it never runs.
    expect(mockGetPrReviewLoopWorklist).not.toHaveBeenCalled();
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("logs blocked review-loop replies with unsupported source kinds", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "unsupported-source:10",
          sourceUrl: "https://github.com/acme/repo/pull/42#unsupported",
          reviewThreadId: null,
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Please fix this.",
          path: "src/foo.ts",
          line: 10,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "unsupported-source:10",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "Review-loop reply blocked: unsupported target source kind." }),
    );
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_result",
        status: "blocked",
        reason: "Review-loop reply blocked: unsupported target source kind.",
        sessionId: SESSION_ID,
        promptId: "prompt-1",
        epochId: "epoch-1",
        targetSourceId: "unsupported-source:10",
      }),
      "Review-loop reply blocked",
    );
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("blocks guarded reply operations for ci epochs when repo CI response is disabled", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Fix failing CI",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(
      makeReviewLoopEpoch({ sourceKind: "ci", expectedBotsHash: "ci-fixes", worklistHash: "ci-fail:unit" }),
    );
    mockResolveReviewLoopCiEligibility.mockResolvedValueOnce({ ok: false, reason: "ci_response_disabled" });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop operation blocked: ci_response_disabled.",
      }),
    );
    expect(mockResolveReviewLoopCiEligibility).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: 101, repoOwner: "acme", repoName: "repo" }),
    );
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockResolveReviewLoopChecklist).not.toHaveBeenCalled();
    expect(mockBeginReviewLoopOperationAttempt).not.toHaveBeenCalled();
  });

  it("handles sandbox review-loop reply route requests through the guarded reply API", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
      activePromptId: "prompt-1",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));

    const { host } = createHost(storage);
    const workflow = createSessionPrWorkflow(host);

    const response = await workflow.handleReviewLoopReplyRequest(
      new Request("https://internal/session/review-loop/reply", {
        method: "POST",
        body: JSON.stringify({
          // PR2: pr-workflow now derives the prompt id from prompts.status
          // when payload.promptId is absent. Since prompt-1 is seeded as
          // completed (the prompt finished before the reply lands), the
          // derived helper returns null and the route requires the explicit
          // id. Pass it so the test exercises the route correctly.
          promptId: "prompt-1",
          epochId: "epoch-1",
          targetSourceId: "review-comment:10",
          verdict: "fixed",
          body: "Fixed in the latest push.",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true, status: "replied", operationId: "op-1", githubId: "987" }),
    );
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalledWith(
      "ghs_install",
      "acme",
      "repo",
      42,
      10,
      "Fixed in the latest push.",
    );
    expect(mockResolvePrReviewThread).toHaveBeenCalledWith("ghs_install", "PRRT_thread10");
  });

  it("does not resolve a review thread while another source item in the same thread remains unresolved", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockGetPrReviewLoopWorklist.mockResolvedValueOnce({
      items: [
        {
          sourceId: "review-comment:10",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r10",
          reviewThreadId: "PRRT_thread10",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Please fix this.",
          path: "src/foo.ts",
          line: 10,
          updatedAtMs: 1_000,
          isResolved: false,
          isOutdated: false,
        },
        {
          sourceId: "review-comment:11",
          sourceUrl: "https://github.com/acme/repo/pull/42#discussion_r11",
          reviewThreadId: "PRRT_thread10",
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          body: "Please also fix this.",
          path: "src/foo.ts",
          line: 11,
          updatedAtMs: 1_100,
          isResolved: false,
          isOutdated: false,
        },
      ],
      duplicateGroups: [],
      worklistHash: "worklist-hash",
      droppedItemCount: 0,
      droppedBodyBytes: 0,
    });

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied" }));
    expect(mockGetReviewLoopOperationById).toHaveBeenCalledTimes(1);
    expect(mockResolvePrReviewThread).not.toHaveBeenCalled();
  });

  it("returns success and logs a warning when review-thread resolution fails after replying", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      prUrl: "https://github.com/acme/repo/pull/42",
      prNumber: 42,
      installationId: 123,
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));
    mockResolvePrReviewThread.mockRejectedValueOnce(new Error("resolve failed"));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied", githubId: "987" }));
    expect(mockResolvePrReviewThread).toHaveBeenCalledWith("ghs_install", "PRRT_thread10");
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_loop_reply_thread_resolve_failed",
        targetSourceId: "review-comment:10",
        reviewThreadId: "PRRT_thread10",
        error: "resolve failed",
      }),
      "Review-loop reply posted but parent thread resolution failed",
    );
  });

  it("allows guarded replies from a review-listening session that did not publish the PR (verification sessions)", async () => {
    const storage = new FakeStorage();
    // Verification sessions never publish a PR of their own, so ext.prUrl/prNumber stay null;
    // they adopt the target PR via review listening instead.
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
    });
    doDb.updateSessionFields(storage.sql as unknown as SqlStorage, SESSION_ID, {
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "replied", githubId: "987" }));
    expect(mockCreatePrReviewCommentReply).toHaveBeenCalled();
  });

  it("rejects guarded replies when the session neither published nor listens on the iteration's PR", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
    });
    // Listening on a different PR than the epoch's — the reply must stay blocked.
    doDb.updateSessionFields(storage.sql as unknown as SqlStorage, SESSION_ID, {
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/43",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.replyToReviewBotComment({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      epochId: "epoch-1",
      targetSourceId: "review-comment:10",
      verdict: "fixed",
      body: "Fixed in the latest push.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "Review-loop operation blocked: this session is no longer working on the review iteration's PR.",
      }),
    );
    expect(mockCreatePrReviewCommentReply).not.toHaveBeenCalled();
  });

  it("allows guarded pushes from a review-listening session that did not publish the PR (verification sessions)", async () => {
    const storage = new FakeStorage();
    seedSession(storage, {
      sessionId: SESSION_ID,
      ownerUserId: "101",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
    });
    doDb.updateSessionFields(storage.sql as unknown as SqlStorage, SESSION_ID, {
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    });
    seedPrompt(storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "Respond to PR review comments",
      actorUserId: "101",
      status: "completed",
      reviewLoopEpochId: "epoch-1",
    });
    mockGetReviewLoopEpochById.mockResolvedValue(makeReviewLoopEpoch({ worklistHash: "worklist-hash" }));

    const { host } = createHost(storage);
    const publishService = new SessionPublishService(host);

    const result = await publishService.publishReviewLoopPush({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/review-loop",
      commitSha: "deadbeef",
      prReadiness: makePrReadiness(),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "published" }));
  });

  describe("handleUpdatePrTitleRequest (agent-proposed PR title)", () => {
    function seedPrSession(opts: { prNumber?: number | null; prTitleLastApplied?: string | null; title?: string }) {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "user-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        title: opts.title ?? "Original session title",
        prUrl: opts.prNumber === null ? null : "https://github.com/acme/repo/pull/42",
        prNumber: opts.prNumber === undefined ? 42 : opts.prNumber,
      });
      if (opts.prTitleLastApplied !== undefined) {
        doDb.updateSessionFields(storage.sql as unknown as SqlStorage, SESSION_ID, {
          prTitleLastApplied: opts.prTitleLastApplied,
        });
      }
      return storage;
    }

    function requestTitle(title: unknown): Request {
      return new Request("https://internal/session/pr-title", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
    }

    function extOf(storage: FakeStorage) {
      return doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
    }
    function titleOf(storage: FakeStorage) {
      return doDb.getSession(storage.sql as unknown as SqlStorage, SESSION_ID)?.title ?? null;
    }

    it("applies a compliant title on a tracked PR and persists it as the desired title", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockGetPullRequestTitle.mockResolvedValue("Existing PR title");
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-1234 Fix the thing"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, outcome: "applied" });
      expect(mockUpdatePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, {
        title: "ENG-1234 Fix the thing",
      });
      // Republish survival: the canonical desired title (read by resolvePrTitle)
      // AND the reconcile baseline are both updated to the agent's title.
      expect(titleOf(storage)).toBe("ENG-1234 Fix the thing");
      expect(extOf(storage)?.prTitleLastApplied).toBe("ENG-1234 Fix the thing");
    });

    it("applies on a null-baseline (legacy/untracked) PR instead of adopting", async () => {
      const storage = seedPrSession({}); // no prTitleLastApplied → null baseline
      mockGetPullRequestTitle.mockResolvedValue("whatever the legacy title is");
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-1 fix"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, outcome: "applied" });
      expect(mockUpdatePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, { title: "ENG-1 fix" });
      // The live title is not needed to decide a null-baseline apply, so it must
      // not be fetched (avoids a wasted round-trip and a spurious read 502).
      expect(mockGetPullRequestTitle).not.toHaveBeenCalled();
    });

    it("skips and does not PATCH when a human renamed the PR (live diverged from baseline)", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Cycloid set this" });
      mockGetPullRequestTitle.mockResolvedValue("Human renamed it");
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-2 new title"));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "skipped_manual_rename" });
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
      // The human's title is left intact; the desired title is not overwritten.
      expect(titleOf(storage)).toBe("Original session title");
    });

    it("is a no-op (but persists the desired title) when the live title already matches", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "stale baseline" });
      mockGetPullRequestTitle.mockResolvedValue("ENG-3 already compliant");
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-3 already compliant"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, outcome: "noop" });
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
      expect(titleOf(storage)).toBe("ENG-3 already compliant");
    });

    it("queues the title as the desired session title when no PR is open yet", async () => {
      // The agent proposes a title during the first turn, before the
      // post-execution publish opens the PR. Instead of discarding it (the old
      // no_pr error), persist it as the canonical desired title so
      // `resolvePrTitle` applies it at PR creation — the PR is born compliant.
      const storage = seedPrSession({ prNumber: null });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-4 fix"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, outcome: "queued" });
      expect(titleOf(storage)).toBe("ENG-4 fix");
      // No PR exists, so neither a baseline nor a GitHub call is appropriate.
      expect(extOf(storage)?.prTitleLastApplied ?? null).toBeNull();
      expect(mockGetPullRequestTitle).not.toHaveBeenCalled();
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    });

    it("rejects an invalid (empty) title with 400 before any GitHub call", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("   "));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "invalid" });
      expect(mockGetPullRequestTitle).not.toHaveBeenCalled();
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    });

    it("surfaces a GitHub read failure as error (502) without swallowing it", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockGetPullRequestTitle.mockRejectedValue(new Error("GitHub 500"));
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-5 fix"));

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "error" });
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    });

    it("surfaces a GitHub PATCH failure as error (502) and does not persist the desired title", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockGetPullRequestTitle.mockResolvedValue("Existing PR title");
      mockUpdatePullRequest.mockRejectedValue(new Error("GitHub 422"));
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleUpdatePrTitleRequest(requestTitle("ENG-6 fix"));

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "error" });
      expect(titleOf(storage)).toBe("Original session title");
      expect(extOf(storage)?.prTitleLastApplied).toBe("Existing PR title");
    });

    it("closes the tracked PR with the server-side GitHub close operation", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const { host, exitReviewListening } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", { method: "POST", body: "{}" }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        outcome: "closed",
        prUrl: "https://github.com/acme/repo/pull/42",
        prNumber: 42,
      });
      expect(mockClosePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42);
      expect(mockUpdatePullRequest).not.toHaveBeenCalledWith("ghu_test", "acme", "repo", 42, {
        state: "closed",
      });
      expect(exitReviewListening).toHaveBeenCalledWith({ sessionId: SESSION_ID, reason: "closed" });
    });

    it("closes a specified same-repo PR URL", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const { host, exitReviewListening } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", {
          method: "POST",
          body: JSON.stringify({ prUrl: "https://github.com/acme/repo/pull/99" }),
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        outcome: "closed",
        prUrl: "https://github.com/acme/repo/pull/99",
        prNumber: 99,
      });
      expect(mockClosePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 99);
      expect(exitReviewListening).not.toHaveBeenCalled();
    });

    it("rejects invalid close payloads before any GitHub call", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      for (const body of [JSON.stringify({ prUrl: 123 }), JSON.stringify({ prUrl: "" })]) {
        const response = await workflow.handleClosePrRequest(
          new Request("https://internal/session/pr-close", { method: "POST", body }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "invalid" });
      }

      expect(mockClosePullRequest).not.toHaveBeenCalled();
    });

    it("rejects a malformed close body before any GitHub call", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", { method: "POST" }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "invalid" });
      expect(mockClosePullRequest).not.toHaveBeenCalled();
    });

    it("rejects an invalid target PR URL before any GitHub call", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", {
          method: "POST",
          body: JSON.stringify({ prUrl: "https://example.com/not-github" }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "invalid" });
      expect(mockClosePullRequest).not.toHaveBeenCalled();
    });

    it("rejects a cross-repo target PR URL before any GitHub call", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", {
          method: "POST",
          body: JSON.stringify({ prUrl: "https://github.com/other/repo/pull/99" }),
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "forbidden" });
      expect(mockClosePullRequest).not.toHaveBeenCalled();
    });

    it("does not close anything when no PR is attached", async () => {
      const storage = seedPrSession({ prNumber: null });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", { method: "POST", body: "{}" }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "no_pr" });
      expect(mockClosePullRequest).not.toHaveBeenCalled();
      expect(mockUpdatePullRequest).not.toHaveBeenCalled();
    });

    it("surfaces unavailable GitHub auth as error (503)", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockGetValidGithubToken.mockResolvedValue(null);
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", {
          method: "POST",
          body: JSON.stringify({ prUrl: "https://github.com/acme/repo/pull/99" }),
        }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "error" });
      expect(mockClosePullRequest).not.toHaveBeenCalled();
    });

    it("surfaces a GitHub close failure as error (502)", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockClosePullRequest.mockRejectedValue(new Error("GitHub 403"));
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleClosePrRequest(
        new Request("https://internal/session/pr-close", { method: "POST", body: "{}" }),
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "error" });
      expect(mockClosePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42);
    });

    it("archive close closes an open attached PR and emits the PR terminal before archive", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockReviewLoopPrState = "open";
      const { host, exitReviewListening } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      const response = await workflow.handleArchiveClosePrRequest();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        prClose: { attempted: true, closed: true },
      });
      expect(mockClosePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42);
      expect(mockEmitWebhookPrTerminal).toHaveBeenCalledWith(
        expect.anything(),
        SESSION_ID,
        "closed",
        expect.anything(),
        expect.any(Function),
      );
      expect(exitReviewListening).toHaveBeenCalledWith({ sessionId: SESSION_ID, reason: "closed" });
    });

    it("archive close still reports a closed PR when terminal webhook emission fails", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockReviewLoopPrState = "open";
      mockEmitWebhookPrTerminal.mockRejectedValueOnce(new Error("webhook failed"));
      const { host, exitReviewListening } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      const response = await workflow.handleArchiveClosePrRequest();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        prClose: { attempted: true, closed: true },
      });
      expect(mockClosePullRequest).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42);
      expect(exitReviewListening).toHaveBeenCalledWith({ sessionId: SESSION_ID, reason: "closed" });
    });

    it("archive close treats already-closed or merged PRs as archive-only", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      for (const state of ["closed", "merged"] as const) {
        mockReviewLoopPrState = state;
        const response = await workflow.handleArchiveClosePrRequest();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          ok: true,
          prClose: { attempted: false, closed: false },
        });
      }

      expect(mockClosePullRequest).not.toHaveBeenCalled();
      expect(mockEmitWebhookPrTerminal).not.toHaveBeenCalled();
    });

    it("archive close treats sessions without PRs as archive-only", async () => {
      const storage = seedPrSession({ prNumber: null });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleArchiveClosePrRequest();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        prClose: { attempted: false, closed: false },
      });
      expect(mockClosePullRequest).not.toHaveBeenCalled();
      expect(mockEmitWebhookPrTerminal).not.toHaveBeenCalled();
    });

    it("archive close returns a warning when GitHub close fails", async () => {
      const storage = seedPrSession({ prTitleLastApplied: "Existing PR title" });
      mockReviewLoopPrState = "open";
      mockClosePullRequest.mockRejectedValue(new Error("GitHub 403"));
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleArchiveClosePrRequest();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        prClose: { attempted: true, closed: false, warning: expect.stringContaining("GitHub 403") },
      });
      expect(mockEmitWebhookPrTerminal).not.toHaveBeenCalled();
    });

    it("reads the attached PR contents with authored comments and reviews", async () => {
      const storage = seedPrSession({});
      mockListPrIssueCommentsDetailed.mockResolvedValue({
        comments: [
          { id: 1, author: "reviewer", body: "please rename this", createdAt: "2026-07-01T01:00:00Z", url: "" },
        ],
        truncated: false,
      });
      mockGetPrReviewComments.mockResolvedValue([
        { id: 5, reviewId: 9, path: "src/foo.ts", line: 10, body: "inline nit", author: "octo", inReplyToId: null },
      ]);
      mockListPrReviews.mockResolvedValue({
        reviews: [
          { id: 3, author: "approver", state: "APPROVED", body: "lgtm", submittedAt: "2026-07-02T00:00:00Z", url: "" },
        ],
        truncated: false,
      });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleReadPrRequest(
        new Request("https://internal/session/pr-read", { method: "POST", body: "{}" }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        overview: { number: 42, title: "Session PR", author: "octocat", state: "open" },
        issueComments: [{ author: "reviewer", body: "please rename this" }],
        reviewComments: [{ author: "octo", path: "src/foo.ts", body: "inline nit" }],
        reviews: [{ author: "approver", state: "APPROVED", body: "lgtm" }],
        truncated: { issueComments: false, reviewComments: false, reviews: false },
      });
      expect(mockGetPrOverview).toHaveBeenCalledWith("ghu_test", "acme", "repo", 42);
    });

    it("reads a specified same-repo PR URL", async () => {
      const storage = seedPrSession({});
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleReadPrRequest(
        new Request("https://internal/session/pr-read", {
          method: "POST",
          body: JSON.stringify({ prUrl: "https://github.com/acme/repo/pull/99" }),
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
      expect(mockGetPrOverview).toHaveBeenCalledWith("ghu_test", "acme", "repo", 99);
    });

    it("rejects a cross-repo target PR URL before any GitHub call", async () => {
      const storage = seedPrSession({});
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleReadPrRequest(
        new Request("https://internal/session/pr-read", {
          method: "POST",
          body: JSON.stringify({ prUrl: "https://github.com/other/repo/pull/99" }),
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "forbidden" });
      expect(mockGetPrOverview).not.toHaveBeenCalled();
    });

    it("rejects an invalid read payload before any GitHub call", async () => {
      const storage = seedPrSession({});
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleReadPrRequest(
        new Request("https://internal/session/pr-read", { method: "POST", body: JSON.stringify({ prUrl: 123 }) }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "invalid" });
      expect(mockGetPrOverview).not.toHaveBeenCalled();
    });

    it("returns no_pr when no PR is attached", async () => {
      const storage = seedPrSession({ prNumber: null });
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleReadPrRequest(
        new Request("https://internal/session/pr-read", { method: "POST", body: "{}" }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "no_pr" });
      expect(mockGetPrOverview).not.toHaveBeenCalled();
    });

    it("surfaces a GitHub read failure as error (502)", async () => {
      const storage = seedPrSession({});
      mockGetPrOverview.mockRejectedValue(new Error("GitHub 500"));
      const workflow = createSessionPrWorkflow(createHost(storage).host);

      const response = await workflow.handleReadPrRequest(
        new Request("https://internal/session/pr-read", { method: "POST", body: "{}" }),
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ ok: false, outcome: "error" });
    });
  });

  // ARC-1044: each non-idempotent publish side effect is its own durable step,
  // keyed by sessionId + promptId + operation (review_listening also by head sha).
  // A DO replay re-runs publishSessionResult; these tests drive it sequentially
  // so the persisted `step:*` keys (kept in FakeStorage's generic map) gate the
  // second run exactly as they would on a real replay.
  describe("publish side-effect durability (ARC-1044)", () => {
    function seedPublishSession(storage: FakeStorage, overrides: Record<string, unknown> = {}) {
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        installationId: 123,
        ...overrides,
      });
      seedPrompt(storage, {
        promptId: "prompt-1",
        sessionId: SESSION_ID,
        promptText: "Publish",
        actorUserId: "101",
        status: "completed",
      });
    }

    function eventTypes(appendAndMirrorEvents: ReturnType<typeof createHost>["appendAndMirrorEvents"]): string[] {
      return appendAndMirrorEvents.mock.calls.flatMap(([, entries]) =>
        (entries as Array<{ type?: string }>).map((entry) => entry.type ?? ""),
      );
    }
    const countOf = (types: string[], type: string) => types.filter((t) => t === type).length;

    const createRequest = () => ({
      sessionId: SESSION_ID,
      promptId: "prompt-1",
      branch: "feature/durable-publish",
      commitSha: "deadbeef",
      prBody: "Body",
      prReadiness: makePrReadiness(),
    });

    it("suppresses duplicate completion + review-listening when a completed create replays", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage);
      const { host, appendAndMirrorEvents, enterReviewListening } = createHost(storage);
      const publishService = new SessionPublishService(host);

      await publishService.publishSessionResult(createRequest());
      await publishService.publishSessionResult(createRequest());

      const types = eventTypes(appendAndMirrorEvents);
      // createPr ran once (create_pr step cached on replay; the replay sees the
      // persisted prUrl and takes the update path).
      expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
      // publish_completed + review_listening keys are shared across create/update,
      // so the replay does not re-emit either.
      expect(countOf(types, "publish.completed")).toBe(1);
      expect(countOf(types, "review_listening.entered")).toBe(1);
      expect(enterReviewListening).toHaveBeenCalledTimes(1);
      // PR-created metric fires once (cache hit on replay skips the dispatch).
      expect(mockEmitPrCreatedMetric).toHaveBeenCalledTimes(1);
      // Watchdog disarm still lands on the published path.
      const ext = doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID);
      expect(ext?.publishStatus).toBe("published");
      expect(ext?.publishingStartedAt ?? null).toBeNull();
    });

    it("dedupes the PR event when a create then update share a promptId (replay)", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage);
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);

      // First call creates the PR; recordPublishedPr persists prUrl, so the second
      // call takes the update path with the SAME promptId. That only happens on a
      // DO replay of one logical publish, so the operation-agnostic pr_event key
      // dedupes it: the create event stands and no second PR event is emitted.
      await publishService.publishSessionResult(createRequest());
      await publishService.publishSessionResult(createRequest());

      const types = eventTypes(appendAndMirrorEvents);
      expect(countOf(types, "publish.pr.created")).toBe(1);
      expect(countOf(types, "publish.pr.updated")).toBe(0);
      // The whole group dedupes uniformly — no skew where the PR event re-fires
      // but completion does not.
      expect(countOf(types, "publish.completed")).toBe(1);
    });

    it("emits pr.updated for an update on a different prompt (parity preserved)", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage);
      seedPrompt(storage, {
        promptId: "prompt-2",
        sessionId: SESSION_ID,
        promptText: "Follow-up",
        actorUserId: "101",
        status: "completed",
      });
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);

      // prompt-1 creates; prompt-2 (a genuinely distinct publish) updates. Distinct
      // promptIds → distinct keys → the update event fires normally.
      await publishService.publishSessionResult(createRequest());
      await publishService.publishSessionResult({ ...createRequest(), promptId: "prompt-2" });

      const types = eventTypes(appendAndMirrorEvents);
      expect(countOf(types, "publish.pr.created")).toBe(1);
      expect(countOf(types, "publish.pr.updated")).toBe(1);
    });

    it("emits no duplicate updated/completed/review-listening when an update replays", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage, { prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 });
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);

      await publishService.publishSessionResult(createRequest());
      await publishService.publishSessionResult(createRequest());

      const types = eventTypes(appendAndMirrorEvents);
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(countOf(types, "publish.pr.updated")).toBe(1);
      expect(countOf(types, "publish.completed")).toBe(1);
      expect(countOf(types, "review_listening.entered")).toBe(1);
    });

    it("re-enters review listening only when the head sha changes", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage, { prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 });
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);
      // Omit commitSha so verifyRemoteBranch does not assert SHA equality; the
      // head is driven purely by the remote-branch head lookup.
      const requestNoSha = { ...createRequest(), commitSha: undefined };

      mockGetPrHeadSha.mockResolvedValue("deadbeef");
      await publishService.publishSessionResult(requestNoSha); // head deadbeef → enter
      await publishService.publishSessionResult(requestNoSha); // same head → cached
      mockGetPrHeadSha.mockResolvedValue("cafef00d");
      await publishService.publishSessionResult(requestNoSha); // new head → re-enter

      const types = eventTypes(appendAndMirrorEvents);
      expect(countOf(types, "review_listening.entered")).toBe(2);
    });

    it("enters review listening once per head even across different prompts", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage, { prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 });
      seedPrompt(storage, {
        promptId: "prompt-2",
        sessionId: SESSION_ID,
        promptText: "Re-publish same head",
        actorUserId: "101",
        status: "completed",
      });
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);
      // Both prompts publish at the SAME head (no commitSha assertion). The
      // review_listening key is head-scoped (not prompt-scoped), so the second
      // prompt at the same head is a cache hit — "entered exactly once per
      // publish head/wave".
      const headOnly = { ...createRequest(), commitSha: undefined };
      mockGetPrHeadSha.mockResolvedValue("deadbeef");

      await publishService.publishSessionResult(headOnly);
      await publishService.publishSessionResult({ ...headOnly, promptId: "prompt-2" });

      const types = eventTypes(appendAndMirrorEvents);
      expect(countOf(types, "review_listening.entered")).toBe(1);
    });

    it("dedupes a promptless create then update (operation-agnostic keys)", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage);
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);
      // promptId omitted → the `no_prompt` key fallback. Two promptless publishes
      // of the same PR share every operation-agnostic key, so the second is fully
      // deduped (treated as a replay) — the create event stands, no second event.
      const promptless = {
        sessionId: SESSION_ID,
        branch: "feature/durable-publish",
        commitSha: "deadbeef",
        prBody: "Body",
        prReadiness: makePrReadiness(),
      };

      await publishService.publishSessionResult(promptless);
      await publishService.publishSessionResult(promptless);

      const types = eventTypes(appendAndMirrorEvents);
      expect(countOf(types, "publish.pr.created")).toBe(1);
      expect(countOf(types, "publish.pr.updated")).toBe(0);
      expect(countOf(types, "publish.completed")).toBe(1);
    });

    it("re-runs a side effect on replay when its memo write crashed (no silent loss)", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage, { prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 });
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);

      // Simulate the documented durable-step crash window: the effect succeeds
      // (event appended) but storage.put for its step memo fails before landing.
      const realPut = storage.put.bind(storage);
      let crashed = false;
      const target = `step:publish_pr_event_${SESSION_ID}_prompt-1`;
      vi.spyOn(storage, "put").mockImplementation(async (keyOrEntries: unknown, value?: unknown) => {
        if (typeof keyOrEntries === "string" && keyOrEntries === target && !crashed) {
          crashed = true;
          throw new Error("simulated memo crash");
        }
        return realPut(keyOrEntries as never, value as never);
      });

      await publishService.publishSessionResult(createRequest()); // updated emitted, memo crashes
      await publishService.publishSessionResult(createRequest()); // step not cached → re-runs

      const types = eventTypes(appendAndMirrorEvents);
      // At-most-one duplicate (re-run), NOT silent loss: the event appears twice.
      expect(countOf(types, "publish.pr.updated")).toBe(2);
    });

    it("keeps the review-listening memo when a later side effect fails and the publish retries", async () => {
      const storage = new FakeStorage();
      seedPublishSession(storage, { prUrl: "https://github.com/acme/repo/pull/42", prNumber: 42 });
      const { host, appendAndMirrorEvents } = createHost(storage);
      const publishService = new SessionPublishService(host);

      // Fail the release-evidence step (which runs AFTER review_listening) on the
      // first publish. The review_listening append must already be memoized, so the
      // retry does NOT re-append the entry.
      const realPut = storage.put.bind(storage);
      let crashed = false;
      const target = `step:publish_release_evidence_${SESSION_ID}_prompt-1`;
      vi.spyOn(storage, "put").mockImplementation(async (keyOrEntries: unknown, value?: unknown) => {
        if (typeof keyOrEntries === "string" && keyOrEntries === target && !crashed) {
          crashed = true;
          throw new Error("simulated release-evidence memo crash");
        }
        return realPut(keyOrEntries as never, value as never);
      });

      await publishService.publishSessionResult(createRequest()); // review_listening memoized, later step crashes
      await publishService.publishSessionResult(createRequest()); // retry: review_listening cached

      const types = eventTypes(appendAndMirrorEvents);
      expect(countOf(types, "review_listening.entered")).toBe(1);
      expect(countOf(types, "publish.pr.updated")).toBe(1);
    });
  });

  describe("resume stuck publish (ARC-876)", () => {
    const sqlOf = (storage: FakeStorage) => storage.sql as unknown as SqlStorage;

    // Seed a session sitting in `publishing` (the wedge: a deploy evicted the DO
    // mid-publish). Mirrors the durable state a resumed publish reads back:
    // branch/commit from the session row, the publishing prompt anchor, and any
    // verification / pr-readiness from DO storage.
    async function seedStuckPublishing(
      storage: FakeStorage,
      opts: {
        prUrl?: string | null;
        prNumber?: number | null;
        lastBranch?: string | null;
        anchorPromptId?: string | null;
        status?: "active" | "archived";
        verification?: ExecutionVerification;
      } = {},
    ): Promise<void> {
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        lastBranch: opts.lastBranch === undefined ? "feature/stuck" : opts.lastBranch,
        lastCommitSha: "deadbeef",
        installationId: 123,
        prUrl: opts.prUrl ?? null,
        prNumber: opts.prNumber ?? null,
        status: opts.status ?? "active",
      });
      seedPrompt(storage, {
        promptId: "prompt-1",
        sessionId: SESSION_ID,
        promptText: "do the work",
        actorUserId: "101",
        status: "completed",
      });
      const sql = sqlOf(storage);
      doDb.updatePromptPushOutcome(sql, "prompt-1", { pushStatus: "succeeded", pushError: null });
      doDb.updateSessionFields(sql, SESSION_ID, {
        publishStatus: "publishing",
        publishStage: "verifying",
        publishingStartedAt: Date.now(),
        publishAttempt: 2,
      });
      // Durable anchor for the prompt that owned the interrupted publish.
      if (opts.anchorPromptId !== null) {
        await storage.put(PUBLISHING_PROMPT_ID_STORAGE_KEY, opts.anchorPromptId ?? "prompt-1");
      }
      if (opts.verification) {
        await storage.put("verification", opts.verification);
      }
    }

    it("resumes a publish stuck in `publishing` and converges to published using the original promptId", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage);
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "bridge_reconnect" });

      expect(outcome).toEqual({ resumed: true, status: "published" });
      // The marker is keyed on the recovered ORIGINAL promptId (prompt-1), NOT the
      // `no_prompt` fallback — this is the idempotency anchor (B1).
      expect(mockFindOpenPrByHead).toHaveBeenCalledWith(
        "ghu_test",
        "acme",
        "repo",
        "feature/stuck",
        "<!-- cycloid-dedup: session-pr-workflow:prompt-1 -->",
      );
      expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("published");
      // Anchor cleared once the publish reached its terminal.
      expect(await storage.get(PUBLISHING_PROMPT_ID_STORAGE_KEY)).toBeUndefined();
    });

    it("adopts the prior attempt's PR via the dedup marker on resume (no duplicate PR)", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage);
      mockFindOpenPrByHead.mockResolvedValue({
        prUrl: "https://github.com/acme/repo/pull/77",
        prNumber: 77,
        branchName: "feature/stuck",
        matchedMarker: true,
      });
      const { host, logger } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "publishing_watchdog" });

      expect(outcome).toEqual({ resumed: true, status: "published" });
      // Adopted the prior PR: no second create.
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(mockUpdatePullRequest).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "pr_create_recovery_via_marker", prNumber: 77 }),
        "pr_create_recovery_via_marker",
      );
      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("published");
    });

    it("re-runs the verification gate on resume and creates a PR when verification requests manual review", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage, {
        verification: {
          verified: false,
          status: "manual_review_required",
          publishMode: "draft",
          manualReviewReason: "Tests failed; publish as draft.",
          explanation: "manual review",
        } as ExecutionVerification,
      });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "alarm_wake" });

      expect(outcome).toEqual({ resumed: true, status: "published" });
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Manual review: Tests failed; publish as draft."),
        }),
      );
      expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.not.objectContaining({ draft: true }));
      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("published");
    });

    it("keys on `no_prompt` (not a guessed prompt) when the durable anchor is absent (legacy session)", async () => {
      const storage = new FakeStorage();
      // No anchor (session predates it). Even though a prompt is now processing,
      // resume must NOT guess it via getActiveProcessingPromptId — it keys on
      // `no_prompt`, and ARC-1014 head-branch adoption prevents a duplicate.
      await seedStuckPublishing(storage, { anchorPromptId: null });
      sqlOf(storage).exec("UPDATE prompts SET status = 'processing' WHERE prompt_id = ?", "prompt-1");
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "bridge_reconnect" });

      expect(outcome).toEqual({ resumed: true, status: "published" });
      // Dedup marker keys on `no_prompt`, NOT the guessed processing prompt.
      expect(mockFindOpenPrByHead).toHaveBeenCalledWith(
        "ghu_test",
        "acme",
        "repo",
        "feature/stuck",
        "<!-- cycloid-dedup: session-pr-workflow:no_prompt -->",
      );
    });

    it("is a no-op when the session is not in `publishing`", async () => {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        lastBranch: "feature/done",
      });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "bridge_reconnect" });

      expect(outcome).toEqual({ resumed: false, reason: "not_publishing" });
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("does not resume an archived session (archive cleanup owns that)", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage, { status: "archived" });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "alarm_wake" });

      expect(outcome).toEqual({ resumed: false, reason: "archived" });
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("skips resume when there is no branch to publish", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage, { lastBranch: null });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "publishing_watchdog" });

      expect(outcome).toEqual({ resumed: false, reason: "no_branch" });
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("collapses concurrent resume triggers into one publish (per-prompt single-flight)", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage);
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const [a, b] = await Promise.all([
        svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "bridge_reconnect" }),
        svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "publishing_watchdog" }),
      ]);

      expect(a).toEqual({ resumed: true, status: "published" });
      expect(b).toEqual({ resumed: true, status: "published" });
      // Two triggers, ONE create: the single-flight on (sessionId, promptId) held.
      expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    });

    it("terminalizes a dangling publishing row on close as failed when no PR exists", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage);
      const { host, broadcast } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.terminalizeDanglingPublishOnClose(SESSION_ID, "user_close");

      expect(outcome).toEqual({ terminalized: true, status: "failed" });
      // Close cleanup must NOT re-drive a publish.
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("failed");
      expect(ext?.publishingStartedAt).toBeNull();
      expect(await storage.get(PUBLISHING_PROMPT_ID_STORAGE_KEY)).toBeUndefined();
    });

    it("terminalizes a dangling publishing row on close as published when a PR already exists", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage, { prUrl: "https://github.com/acme/repo/pull/55", prNumber: 55 });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.terminalizeDanglingPublishOnClose(SESSION_ID, "user_close");

      expect(outcome).toEqual({ terminalized: true, status: "published" });
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("published");
    });

    it("is a no-op on close when the publish is already terminal", async () => {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        lastBranch: "feature/done",
      });
      doDb.updateSessionFields(sqlOf(storage), SESSION_ID, { publishStatus: "published", publishStage: "done" });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.terminalizeDanglingPublishOnClose(SESSION_ID, "user_close");

      expect(outcome).toEqual({ terminalized: false, reason: "not_publishing" });
    });

    it("does not re-attempt publish on a late post-execution timeout after a forced failure", async () => {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        lastBranch: "feature/already-failed",
        lastCommitSha: "deadbeef",
        installationId: 123,
      });
      seedPrompt(storage, {
        promptId: "prompt-1",
        sessionId: SESSION_ID,
        promptText: "do the work",
        actorUserId: "101",
        status: "completed",
      });
      doDb.updatePromptPushOutcome(sqlOf(storage), "prompt-1", { pushStatus: "succeeded", pushError: null });
      // A prior forced failure already terminalized the publish.
      doDb.updateSessionFields(sqlOf(storage), SESSION_ID, { publishStatus: "failed", publishStage: "verifying" });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      await svc.failPublishOnTimeout({
        sessionId: SESSION_ID,
        phase: "post_execution",
        stage: "verifying",
        elapsedMs: 300_010,
        promptId: "prompt-1",
      });

      // Forced `failed` is immutable here: the late timeout must not open a draft.
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("failed");
    });

    it("clears the publishing prompt anchor after a successful publish", async () => {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        lastBranch: "feature/anchor",
        lastCommitSha: "deadbeef",
        installationId: 123,
      });
      const anchorWrites: string[] = [];
      const realPut = storage.put.bind(storage);
      vi.spyOn(storage, "put").mockImplementation(async (keyOrEntries: never, value?: never) => {
        if (keyOrEntries === PUBLISHING_PROMPT_ID_STORAGE_KEY) anchorWrites.push(String(value));
        return realPut(keyOrEntries as never, value as never);
      });
      const { host } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      await workflow.triggerPrCreation(
        SESSION_ID,
        "feature/anchor",
        "diff",
        undefined,
        undefined,
        undefined,
        undefined,
        "prompt-1",
      );

      // Anchor was written with the publishing prompt while in flight...
      expect(anchorWrites).toContain("prompt-1");
      // ...and cleared once the publish reached its terminal.
      expect(await storage.get(PUBLISHING_PROMPT_ID_STORAGE_KEY)).toBeUndefined();
    });

    it("skips resume when the stuck branch equals the base branch", async () => {
      const storage = new FakeStorage();
      // baseBranch is "main"; a stuck publish whose head == base can never open a
      // PR, so resume must skip (the watchdog backstop forces the terminal).
      await seedStuckPublishing(storage, { lastBranch: "main" });
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "publishing_watchdog" });

      expect(outcome).toEqual({ resumed: false, reason: "no_branch" });
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("keeps a published row published when clearing the publishing anchor fails", async () => {
      const storage = new FakeStorage();
      seedSession(storage, {
        sessionId: SESSION_ID,
        ownerUserId: "101",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
        lastBranch: "feature/anchor-delete-fail",
        lastCommitSha: "deadbeef",
        installationId: 123,
      });
      // The anchor delete (best-effort) throws — it must NOT bubble into the
      // publish try/catch and flip the already-published row to failed.
      const realDelete = storage.delete.bind(storage);
      vi.spyOn(storage, "delete").mockImplementation(async (key: never) => {
        if (key === PUBLISHING_PROMPT_ID_STORAGE_KEY) throw new Error("storage delete boom");
        return realDelete(key as never);
      });
      const { host, broadcast } = createHost(storage);
      const workflow = createSessionPrWorkflow(host);

      await workflow.triggerPrCreation(
        SESSION_ID,
        "feature/anchor-delete-fail",
        "diff",
        undefined,
        undefined,
        undefined,
        undefined,
        "prompt-1",
      );

      const ext = doDb.getSessionExtended(sqlOf(storage), SESSION_ID);
      expect(ext?.publishStatus).toBe("published");
      expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pr_failed" }));
    });

    it("loads pr-readiness from the centralized storage key on resume", async () => {
      const storage = new FakeStorage();
      await seedStuckPublishing(storage);
      await storage.put(PR_READINESS_STORAGE_KEY, makePrReadiness());
      const { host } = createHost(storage);
      const svc = new SessionPublishService(host);
      // Spy on the DO-storage read so the test fails if resume stops loading
      // readiness entirely (passing only `published` would not catch that). The
      // legacy and centralized keys are the same string value, so the meaningful
      // guard is that resume reads `PR_READINESS_STORAGE_KEY` and forwards it.
      const getSpy = vi.spyOn(storage, "get");

      const outcome = await svc.resumeStuckPublish({ sessionId: SESSION_ID, trigger: "bridge_reconnect" });

      expect(outcome).toEqual({ resumed: true, status: "published" });
      expect(getSpy).toHaveBeenCalledWith(PR_READINESS_STORAGE_KEY);
    });
  });
});
