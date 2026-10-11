import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGithubCheckRunPayload,
  buildGithubCommitStatusPayload,
  buildGithubPullRequestReviewPayload,
  buildWebhookIdempotencyKeyImpl,
  makeSignedGithubRequest,
} from "./github-webhook-fixtures";

const {
  mockCaptureException,
  mockIngestReviewLoopCheckRunWebhook,
  mockIngestReviewLoopCiFailureWebhook,
  mockIngestReviewLoopCommitStatusWebhook,
  mockIngestReviewLoopPrIssueCommentWebhook,
  mockIngestReviewLoopPullRequestReviewCommentWebhook,
  mockIngestReviewLoopPullRequestReviewWebhook,
  mockReengageSessionForReview,
  mockReleaseWebhookIdempotencyClaim,
  mockSelectReviewLoopReplyGithubIds,
  mockSelectReviewLoopIssueCommentReplyGithubIds,
} = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockIngestReviewLoopCheckRunWebhook: vi.fn(),
  mockIngestReviewLoopCiFailureWebhook: vi.fn(),
  mockIngestReviewLoopCommitStatusWebhook: vi.fn(),
  mockIngestReviewLoopPrIssueCommentWebhook: vi.fn(),
  mockIngestReviewLoopPullRequestReviewCommentWebhook: vi.fn(),
  mockIngestReviewLoopPullRequestReviewWebhook: vi.fn(),
  mockReengageSessionForReview: vi.fn(),
  mockReleaseWebhookIdempotencyClaim: vi.fn(),
  mockSelectReviewLoopReplyGithubIds: vi.fn(),
  mockSelectReviewLoopIssueCommentReplyGithubIds: vi.fn(),
}));

const loggerState = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockScheduleReviewAckReaction = vi.hoisted(() => vi.fn());
vi.mock("../../apps/control-plane-worker/src/webhooks/review-ack-reaction", () => ({
  scheduleReviewAckReaction: (...a: unknown[]) => mockScheduleReviewAckReaction(...a),
}));

// This suite mocks the DAO layer and stubs `DB: {}`; the router's PR-activity
// capture tap makes a real pr_coordination read, so stub it to a no-op here (it
// has its own dedicated tests).
vi.mock("../../apps/control-plane-worker/src/webhooks/pr-activity-capture", () => ({
  capturePrActivityEvent: async () => {},
  isCapturedPrActivityEventType: (eventType: string | null | undefined) =>
    typeof eventType === "string" &&
    ["issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request"].includes(eventType),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockGetAppSlug = vi.fn();
const mockGetUserByGithubId = vi.fn();
const mockVerifyUserRepoAccess = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockGetPrReviewComments = vi.fn();
const mockGetPullRequestsForCommit = vi.fn();
const mockGetSessionState = vi.fn();
const mockEnqueueSessionPrompt = vi.fn();
const mockSyncSessionProjection = vi.fn();
const mockCreateMemoryAnalysisJob = vi.fn();
const mockGetUserSettingsIfExists = vi.fn();
const mockGetUserPrReviewBotSettings = vi.fn();
const mockEmitReviewLoopCiSignalFromWebhook = vi.fn();
const mockDispatchReviewLoopEpoch = vi.fn();
// ARC-1514 review-comment @cycloid mention path.
const mockBootstrapMentionEpoch = vi.fn();
const mockGetTrackingSessionIdForPrUrl = vi.fn();
const mockEnsureSessionLiveForPr = vi.fn();
const mockGetPrHeadSha = vi.fn();
const mockGetPrState = vi.fn();
// ARC-1515 gated @cycloid adoption bootstrap (non-owned PRs).
const mockPostIssueComment = vi.fn();
const mockResolveInternalFeatureGateUser = vi.fn();
const mockBootstrapMentionSession = vi.fn();
const mockIsCycloidMember = vi.fn();

type SessionRecord = {
  sessionId: string;
  ownerUserId: string;
  status: "active" | "archived";
};

let sessionRecords: Map<string, SessionRecord>;
let deliveryClaims: Set<string>;
let prSessionRefs: Map<string, string[]>;

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getUserByGithubId: (...args: unknown[]) => mockGetUserByGithubId(...args),
  getValidGithubToken: async () => "ghp_user_token",
  resolveInternalFeatureGateUser: (...args: unknown[]) => mockResolveInternalFeatureGateUser(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/logger")>();
  return {
    ...actual,
    createLogger: () => loggerState,
  };
});

vi.mock("../../apps/control-plane-worker/src/github/issues", () => ({
  GITHUB_QA_STARTED_REACTION: "eyes",
  postIssueComment: (...args: unknown[]) => mockPostIssueComment(...args),
  postIssueCommentReaction: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/github-mention-bootstrap", () => ({
  bootstrapMentionSession: (...args: unknown[]) => mockBootstrapMentionSession(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  isCycloidMember: (...args: unknown[]) => mockIsCycloidMember(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  getAppSlug: (...args: unknown[]) => mockGetAppSlug(...args),
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getPrReviewComments: (...args: unknown[]) => mockGetPrReviewComments(...args),
  getPullRequestsForCommit: (...args: unknown[]) => mockGetPullRequestsForCommit(...args),
  getPrHeadSha: (...args: unknown[]) => mockGetPrHeadSha(...args),
  getPrState: (...args: unknown[]) => mockGetPrState(...args),
  GITHUB_API: "https://api.github.com",
  githubHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  FAILING_CHECK_RUN_CONCLUSIONS: new Set(["failure", "timed_out", "action_required", "startup_failure"]),
}));

const mockEnrichMemoryAnalysisJobParams = vi.fn();

vi.mock("../../apps/control-plane-worker/src/memory/db", () => ({
  createMemoryAnalysisJob: (...args: unknown[]) => mockCreateMemoryAnalysisJob(...args),
  enrichMemoryAnalysisJobParams: (...args: unknown[]) => mockEnrichMemoryAnalysisJobParams(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  ingestReviewLoopCheckRunWebhook: (...args: unknown[]) => mockIngestReviewLoopCheckRunWebhook(...args),
  ingestReviewLoopCiFailureWebhook: (...args: unknown[]) => mockIngestReviewLoopCiFailureWebhook(...args),
  ingestReviewLoopCommitStatusWebhook: (...args: unknown[]) => mockIngestReviewLoopCommitStatusWebhook(...args),
  ingestReviewLoopPrIssueCommentWebhook: (...args: unknown[]) => mockIngestReviewLoopPrIssueCommentWebhook(...args),
  ingestReviewLoopPullRequestReviewCommentWebhook: (...args: unknown[]) =>
    mockIngestReviewLoopPullRequestReviewCommentWebhook(...args),
  ingestReviewLoopPullRequestReviewWebhook: (...args: unknown[]) =>
    mockIngestReviewLoopPullRequestReviewWebhook(...args),
  bootstrapMentionEpoch: (...args: unknown[]) => mockBootstrapMentionEpoch(...args),
}));

vi.mock("../../apps/control-plane-worker/src/automation/github-check-db", () => ({
  listMatchingGithubCheckRules: vi.fn().mockResolvedValue([]),
  claimGithubCheckJob: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", () => ({
  getTrackingSessionIdForPrUrl: (...args: unknown[]) => mockGetTrackingSessionIdForPrUrl(...args),
}));

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettingsIfExists: (...args: unknown[]) => mockGetUserSettingsIfExists(...args),
  getUserPrReviewBotSettings: (...args: unknown[]) => mockGetUserPrReviewBotSettings(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-operations", () => ({
  selectReviewLoopReplyGithubIds: (...args: unknown[]) => mockSelectReviewLoopReplyGithubIds(...args),
  selectReviewLoopIssueCommentReplyGithubIds: (...args: unknown[]) =>
    mockSelectReviewLoopIssueCommentReplyGithubIds(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-reengage", () => ({
  reengageSessionForReview: (...args: unknown[]) => mockReengageSessionForReview(...args),
  ensureSessionLiveForPr: (...args: unknown[]) => mockEnsureSessionLiveForPr(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-ci-signal", () => ({
  emitReviewLoopCiSignalFromWebhook: (...args: unknown[]) => mockEmitReviewLoopCiSignalFromWebhook(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-sweep", () => ({
  dispatchReviewLoopEpoch: (...args: unknown[]) => mockDispatchReviewLoopEpoch(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  closeSessionForWebhook: vi.fn(),
  createSessionState: vi.fn(),
  enqueueSessionPrompt: (...args: unknown[]) => mockEnqueueSessionPrompt(...args),
  getSessionExportData: vi.fn(),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getSessionStub: vi.fn(),
  notifySessionPrMerged: vi.fn().mockResolvedValue({ status: 200, ok: true, payload: { ok: true, notified: true } }),
  // Real emitReviewListeningEntered (publish-service) delegates to this DO route; stub it green so the
  // ARC-1514 mention path's re-arm step succeeds.
  enterSessionReviewListening: vi.fn().mockResolvedValue({ status: 200, ok: true, payload: { updated: true } }),
  notifySessionReviewLoopSummaryCommentPosted: vi.fn(),
  updateSessionReviewListeningHead: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_ISSUE: "github_issue",
  buildWebhookIdempotencyKey: buildWebhookIdempotencyKeyImpl,
  claimWebhookIdempotency: async (_db: unknown, _source: string, idempotencyKey: string) => {
    if (deliveryClaims.has(idempotencyKey)) return false;
    deliveryClaims.add(idempotencyKey);
    return true;
  },
  releaseWebhookIdempotencyClaim: async (_db: unknown, _source: string, idempotencyKey: string) => {
    deliveryClaims.delete(idempotencyKey);
    mockReleaseWebhookIdempotencyClaim(_db, _source, idempotencyKey);
  },
  listSessionIdsByWebhookRef: async (_db: unknown, source: string, externalRef: string) =>
    prSessionRefs.get(`${source}:${externalRef}`) ?? [],
  claimSessionWebhookRef: vi.fn(),
}));

type GithubWebhookModule = {
  handleGithubWebhook: (request: Request, env: unknown, ctx?: unknown) => Promise<Response>;
};

const WEBHOOK_SECRET = "test-gh-review-secret";

async function makeSignedRequest(body: string, deliveryId?: string): Promise<Request> {
  return makeSignedGithubRequest(body, { eventType: "pull_request_review", secret: WEBHOOK_SECRET, deliveryId });
}

async function makeSignedCheckRunRequest(body: string, deliveryId?: string): Promise<Request> {
  return makeSignedGithubRequest(body, {
    eventType: "check_run",
    secret: WEBHOOK_SECRET,
    deliveryId,
  });
}

async function makeSignedStatusRequest(body: string, deliveryId?: string): Promise<Request> {
  return makeSignedGithubRequest(body, {
    eventType: "status",
    secret: WEBHOOK_SECRET,
    deliveryId,
  });
}

async function makeSignedReviewCommentRequest(body: string, deliveryId?: string): Promise<Request> {
  return makeSignedGithubRequest(body, {
    eventType: "pull_request_review_comment",
    secret: WEBHOOK_SECRET,
    deliveryId,
  });
}

describe("GitHub PR review webhook", () => {
  let githubMod: GithubWebhookModule;

  function buildSuccessfulEnqueue(sessionId: string, prompt: string) {
    return {
      ok: true,
      status: 200,
      payload: {
        prompt: { promptId: "p-1", prompt },
        dispatch: null,
        queue: { queuedCount: 0, processingPromptId: "p-1" },
        replay: { sessionId, lastEventSequence: 1 },
        session: sessionRecords.get(sessionId) ?? {
          sessionId,
          ownerUserId: "100",
          status: "active" as const,
        },
      },
    };
  }

  function seedPrSessions(...sessions: SessionRecord[]) {
    prSessionRefs.set(
      "github_pr_url:https://github.com/acme/repo/pull/42",
      sessions.map((session) => session.sessionId),
    );
    for (const session of sessions) {
      sessionRecords.set(session.sessionId, session);
    }
  }

  function mockTriggeringReviewComment(body = "Handle the null case here.") {
    mockGetPrReviewComments.mockResolvedValueOnce([
      {
        id: 1,
        reviewId: 7001,
        path: "src/foo.ts",
        line: 15,
        body,
        author: "reviewer",
        inReplyToId: null,
      },
    ]);
  }

  beforeEach(async () => {
    vi.resetModules();
    sessionRecords = new Map();
    deliveryClaims = new Set();
    prSessionRefs = new Map();

    mockCaptureException.mockReset();
    mockScheduleReviewAckReaction.mockReset();
    loggerState.info.mockReset();
    loggerState.warn.mockReset();
    loggerState.error.mockReset();
    mockGetAppSlug.mockReset().mockResolvedValue("cycloid-dev");
    mockGetUserByGithubId.mockReset().mockResolvedValue({ id: 77, login: "reviewer" });
    mockVerifyUserRepoAccess.mockReset().mockResolvedValue(true);
    mockCreateInstallationToken.mockReset().mockResolvedValue("ghs_install_token");
    mockCreateMemoryAnalysisJob.mockReset().mockResolvedValue("mock-job-id");
    mockGetUserSettingsIfExists.mockReset().mockResolvedValue({ pr_review_auto_response_enabled: 1 });
    mockGetUserPrReviewBotSettings.mockReset().mockResolvedValue({ expectedBots: [], expectedBotsHash: "empty" });
    mockIngestReviewLoopPrIssueCommentWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockIngestReviewLoopPullRequestReviewCommentWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockIngestReviewLoopPullRequestReviewWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockReengageSessionForReview
      .mockReset()
      .mockResolvedValue({ status: "reengaged", sessionId: "sess-open", epochId: "epoch-reengage-1" });
    mockIngestReviewLoopCheckRunWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockIngestReviewLoopCiFailureWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockIngestReviewLoopCommitStatusWebhook
      .mockReset()
      .mockResolvedValue({ status: "ignored", reason: "no_review_listening_session" });
    mockGetPrReviewComments.mockReset().mockResolvedValue([]);
    mockSelectReviewLoopReplyGithubIds.mockReset().mockResolvedValue(new Set());
    mockSelectReviewLoopIssueCommentReplyGithubIds.mockReset().mockResolvedValue(new Set());
    // ARC-1514 review-comment mention path defaults.
    vi.unstubAllGlobals();
    mockBootstrapMentionEpoch.mockReset().mockResolvedValue({ id: "ep_mention_1", status: "ready" });
    mockGetTrackingSessionIdForPrUrl.mockReset().mockResolvedValue(null);
    mockEnsureSessionLiveForPr
      .mockReset()
      .mockResolvedValue({ status: "live", session: { sessionId: "sess-open", ownerUserId: "100", status: "active" } });
    mockGetPrHeadSha.mockReset().mockResolvedValue("pr-head-sha");
    // PR-open gate default: the reply-mention branch calls getPrState BEFORE reviving, so default it
    // to "open" so the existing bootstrap-path tests proceed; the pr_not_open / transient tests override.
    mockGetPrState.mockReset().mockResolvedValue("open");
    mockGetPullRequestsForCommit.mockReset().mockResolvedValue([]);
    // ARC-1515 gated adoption defaults: a resolvable internal user but NOT a member, so the existing
    // no-bound-session skips stay unchanged (bootstrap NOT called) unless a test opts the actor in.
    mockPostIssueComment.mockReset().mockResolvedValue(1234);
    mockResolveInternalFeatureGateUser.mockReset().mockResolvedValue({ businessId: "business-internal" });
    mockIsCycloidMember.mockReset().mockReturnValue(false);
    mockBootstrapMentionSession.mockReset();
    mockSyncSessionProjection.mockReset().mockResolvedValue(undefined);
    mockEmitReviewLoopCiSignalFromWebhook.mockReset().mockResolvedValue(undefined);
    mockDispatchReviewLoopEpoch.mockReset().mockResolvedValue("dispatched");
    mockReleaseWebhookIdempotencyClaim.mockReset();
    mockGetSessionState
      .mockReset()
      .mockImplementation(async (_env: unknown, sessionId: string) => sessionRecords.get(sessionId) ?? null);
    mockEnqueueSessionPrompt
      .mockReset()
      .mockImplementation(async (_env: unknown, sessionId: string, prompt: string) =>
        buildSuccessfulEnqueue(sessionId, prompt),
      );

    const path = "../../apps/control-plane-worker/src/webhooks/github";
    githubMod = (await import(path)) as unknown as GithubWebhookModule;
  });

  function buildEnv(overrides: Record<string, unknown> = {}) {
    return {
      DB: {},
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MEMORY_ANALYSIS_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    };
  }

  it("skips empty approvals that do not include new inline comments", async () => {
    seedPrSessions({ sessionId: "sess-open", ownerUserId: "101", status: "active" });
    mockGetPrReviewComments.mockResolvedValueOnce([
      {
        id: 99,
        reviewId: 6999,
        path: "src/foo.ts",
        line: 15,
        body: "Earlier unresolved thread.",
        author: "reviewer",
        inReplyToId: null,
      },
    ]);

    const request = await makeSignedRequest(
      JSON.stringify(
        buildGithubPullRequestReviewPayload({
          review: {
            id: 7001,
            state: "approved",
            body: "   ",
            user: {
              login: "reviewer",
              type: "User",
            },
          },
        }),
      ),
    );
    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("empty_approval");
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("routes inline review-comment webhooks into review-loop ingestion", async () => {
    mockIngestReviewLoopPullRequestReviewCommentWebhook.mockResolvedValueOnce({
      status: "handled",
      epoch: { id: "epoch-inline-1", status: "collecting" },
    });

    const request = await makeSignedReviewCommentRequest(
      JSON.stringify({
        action: "created",
        installation: { id: 2222 },
        repository: {
          name: "repo",
          html_url: "https://github.com/acme/repo",
          owner: { login: "acme" },
        },
        pull_request: {
          number: 42,
          html_url: "https://github.com/acme/repo/pull/42",
          head: { sha: "head-sha" },
        },
        comment: {
          id: 9301,
          body: "This branch can still throw.",
          commit_id: "head-sha",
          user: { login: "cursor[bot]", type: "Bot" },
        },
      }),
      "delivery-inline-1",
    );

    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, reviewLoop: true, epochId: "epoch-inline-1", status: "collecting" });
    expect(mockIngestReviewLoopPullRequestReviewCommentWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-inline-1",
        sourceId: "review-comment:9301",
        commentId: 9301,
        commentBody: "This branch can still throw.",
        commentCommitId: "head-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      }),
    );
  });

  it("drops cycloid[bot] implicit review webhooks as non-configured bot activity", async () => {
    mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
      status: "ignored",
      reason: "actor_not_configured_bot",
    });

    const request = await makeSignedRequest(
      JSON.stringify(
        buildGithubPullRequestReviewPayload({
          review: {
            id: 7002,
            state: "commented",
            body: "",
            user: {
              id: 41898282,
              login: "cycloid[bot]",
              type: "Bot",
            },
          },
        }),
      ),
      "delivery-cycloid-bot-review",
    );

    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, skipped: true, reason: "actor_not_configured_bot" });
    expect(mockIngestReviewLoopPullRequestReviewWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-cycloid-bot-review",
        sourceId: "human:7002",
        reviewId: 7002,
        reviewBody: "",
        actorLogin: "cycloid[bot]",
        actorType: "Bot",
      }),
    );
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("drops cycloid[bot] inline review-comment webhooks as non-configured bot activity", async () => {
    mockIngestReviewLoopPullRequestReviewCommentWebhook.mockResolvedValueOnce({
      status: "ignored",
      reason: "actor_not_configured_bot",
    });

    const request = await makeSignedReviewCommentRequest(
      JSON.stringify({
        action: "created",
        installation: { id: 2222 },
        repository: {
          name: "repo",
          html_url: "https://github.com/acme/repo",
          owner: { login: "acme" },
        },
        pull_request: {
          number: 42,
          html_url: "https://github.com/acme/repo/pull/42",
          head: { sha: "head-sha" },
        },
        comment: {
          id: 9302,
          body: "Fixed in the latest push.",
          commit_id: "head-sha",
          pull_request_review_id: 7002,
          user: { login: "cycloid[bot]", type: "Bot" },
        },
      }),
      "delivery-cycloid-bot-review-comment",
    );

    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, skipped: true, reason: "actor_not_configured_bot" });
    expect(mockIngestReviewLoopPullRequestReviewCommentWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-cycloid-bot-review-comment",
        sourceId: "review-comment:9302",
        commentId: 9302,
        commentBody: "Fixed in the latest push.",
        actorLogin: "cycloid[bot]",
        actorType: "Bot",
      }),
    );
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  describe("review ack 👀 wiring", () => {
    it("schedules a 👀 ack when a bot review is ingested (handled)", async () => {
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValue({
        status: "handled",
        epoch: { id: "ep_1", status: "collecting" },
      });
      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: {
              id: 900,
              state: "commented",
              body: "Found a bug",
              user: { login: "greptile-apps[bot]", type: "Bot", id: 99 },
            },
          }),
        ),
        "delivery-ack-bot-handled",
      );
      await githubMod.handleGithubWebhook(request, buildEnv());

      expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
      const arg = mockScheduleReviewAckReaction.mock.calls[0]?.[2];
      expect(arg).toMatchObject({ surface: { kind: "review_submission", reviewId: 900, prNumber: 42 } });
    });

    it("does NOT schedule a 👀 ack when the bot review is ignored (stale_head)", async () => {
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValue({ status: "ignored", reason: "stale_head" });
      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: {
              id: 901,
              state: "commented",
              body: "Found a bug",
              user: { login: "greptile-apps[bot]", type: "Bot", id: 99 },
            },
          }),
        ),
        "delivery-ack-bot-ignored",
      );
      await githubMod.handleGithubWebhook(request, buildEnv());

      expect(mockScheduleReviewAckReaction).not.toHaveBeenCalled();
    });

    it("schedules a 👀 ack on the inline review-comment surface when handled", async () => {
      mockIngestReviewLoopPullRequestReviewCommentWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-inline-ack", status: "collecting" },
      });
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify({
          action: "created",
          installation: { id: 2222 },
          repository: { name: "repo", html_url: "https://github.com/acme/repo", owner: { login: "acme" } },
          pull_request: {
            number: 42,
            html_url: "https://github.com/acme/repo/pull/42",
            head: { sha: "head-sha" },
          },
          comment: {
            id: 9301,
            body: "This branch can still throw.",
            commit_id: "head-sha",
            user: { login: "cursor[bot]", type: "Bot" },
          },
        }),
        "delivery-ack-inline",
      );
      await githubMod.handleGithubWebhook(request, buildEnv());

      expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
      const arg = mockScheduleReviewAckReaction.mock.calls[0]?.[2];
      expect(arg).toMatchObject({ surface: { kind: "review_comment", commentId: 9301 } });
    });

    it("schedules a single 👀 ack for a human review once a session ingests it (with inline comments)", async () => {
      prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", ["sess-ack-listening"]);
      sessionRecords.set("sess-ack-listening", {
        sessionId: "sess-ack-listening",
        ownerUserId: "101",
        status: "active",
        reviewListeningActive: true,
        reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      } as unknown as SessionRecord);
      mockTriggeringReviewComment();
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValue({
        status: "handled",
        epoch: { id: "epoch-human-ack", status: "collecting" },
      });
      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-ack-human",
      );
      await githubMod.handleGithubWebhook(request, buildEnv());

      expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
      const arg = mockScheduleReviewAckReaction.mock.calls[0]?.[2] as {
        surface: { kind: string; reviewId: number; inlineComments: unknown[] };
      };
      expect(arg.surface).toMatchObject({ kind: "review_submission", reviewId: 7001 });
      expect(arg.surface.inlineComments).toHaveLength(1);
    });

    it("schedules the 👀 ack ONCE when a review is ingested by TWO listening sessions", async () => {
      // Locks the "once per review, not per session" invariant: two listening sessions both fold the
      // same review (both ingest_handled), but the human path acks the review a single time.
      prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", ["sess-ack-a", "sess-ack-b"]);
      for (const sessionId of ["sess-ack-a", "sess-ack-b"]) {
        sessionRecords.set(sessionId, {
          sessionId,
          ownerUserId: "101",
          status: "active",
          reviewListeningActive: true,
          reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
        } as unknown as SessionRecord);
      }
      mockTriggeringReviewComment();
      // mockResolvedValue (not Once): BOTH per-session ingest calls return handled.
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValue({
        status: "handled",
        epoch: { id: "epoch-human-ack-multi", status: "collecting" },
      });
      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-ack-human-multi",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      // Both sessions ingested the review, proving the two-session scenario is genuine…
      expect(json).toMatchObject({ ok: true, ingest_handled: 2 });
      expect(mockIngestReviewLoopPullRequestReviewWebhook).toHaveBeenCalledTimes(2);
      // …yet the ack fires exactly once for the review.
      expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
      const arg = mockScheduleReviewAckReaction.mock.calls[0]?.[2];
      expect(arg).toMatchObject({ surface: { kind: "review_submission", reviewId: 7001, prNumber: 42 } });
    });
  });

  it("returns the ignored bot-review reason from review-loop ingest", async () => {
    const request = await makeSignedRequest(
      JSON.stringify(
        buildGithubPullRequestReviewPayload({
          review: {
            id: 7001,
            state: "commented",
            body: "Automated review",
            user: {
              login: "cycloid-dev[bot]",
              type: "Bot",
            },
          },
        }),
      ),
    );
    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("no_review_listening_session");
    expect(loggerState.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewAuthor: "cycloid-dev[bot]",
        reviewUserType: "Bot",
        reason: "no_review_listening_session",
      }),
      "Skipping GitHub bot PR review after review-loop ingest ignored it",
    );
    expect(mockGetAppSlug).not.toHaveBeenCalled();
  });

  it("skips self-triggered reviews from the app", async () => {
    const request = await makeSignedRequest(
      JSON.stringify(
        buildGithubPullRequestReviewPayload({
          review: {
            id: 7001,
            state: "commented",
            body: "Loop back into the session",
            user: {
              login: "cycloid-dev",
              type: "User",
            },
          },
        }),
      ),
    );
    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("self_trigger");
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("skips unsupported review actions", async () => {
    const request = await makeSignedRequest(JSON.stringify(buildGithubPullRequestReviewPayload({ action: "edited" })));
    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("unsupported_action");
  });

  describe("status webhook routing", () => {
    it("routes terminal CodeRabbit commit status into review-loop ingestion", async () => {
      mockGetPullRequestsForCommit.mockResolvedValueOnce([
        { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "head-sha" },
      ]);
      mockIngestReviewLoopCommitStatusWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-status-1", status: "ready" },
      });

      const request = await makeSignedStatusRequest(
        JSON.stringify(buildGithubCommitStatusPayload()),
        "delivery-status-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, total: 1, handled: 1, ignored: 0, mismatched: 0 });
      expect(mockCreateInstallationToken).toHaveBeenCalledWith(expect.anything(), 2222);
      expect(mockGetPullRequestsForCommit).toHaveBeenCalledWith("ghs_install_token", "acme", "repo", "head-sha");
      expect(mockIngestReviewLoopCommitStatusWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "delivery-status-1",
          sourceId: "commit-status:9600:42",
          statusId: 9600,
          context: "CodeRabbit",
          state: "success",
          description: "Review completed",
          targetUrl: "https://coderabbit.ai/gh/acme/repo/pulls/42",
          actorLogin: "coderabbitai",
          actorType: "Bot",
          repoOwner: "acme",
          repoName: "repo",
          prNumber: 42,
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "head-sha",
        }),
      );
    });

    it("deduplicates terminal commit statuses before external PR lookup", async () => {
      const body = JSON.stringify(buildGithubCommitStatusPayload());
      mockGetPullRequestsForCommit.mockResolvedValue([
        { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "head-sha" },
      ]);
      mockIngestReviewLoopCommitStatusWebhook.mockResolvedValue({
        status: "handled",
        epoch: { id: "epoch-status-duplicate", status: "ready" },
      });

      const first = await githubMod.handleGithubWebhook(
        await makeSignedStatusRequest(body, "delivery-status-duplicate"),
        buildEnv(),
      );
      const second = await githubMod.handleGithubWebhook(
        await makeSignedStatusRequest(body, "delivery-status-duplicate"),
        buildEnv(),
      );

      await expect(first.json()).resolves.toMatchObject({ ok: true, reviewLoop: true, handled: 1 });
      await expect(second.json()).resolves.toMatchObject({ ok: true, skipped: true, reason: "duplicate" });
      expect(mockCreateInstallationToken).toHaveBeenCalledTimes(1);
      expect(mockGetPullRequestsForCommit).toHaveBeenCalledTimes(1);
      expect(mockIngestReviewLoopCommitStatusWebhook).toHaveBeenCalledTimes(1);
    });

    it("skips pending commit statuses before looking up associated PRs", async () => {
      const request = await makeSignedStatusRequest(
        JSON.stringify(buildGithubCommitStatusPayload({ state: "pending" })),
        "delivery-status-pending",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "status_pending" });
      expect(mockGetPullRequestsForCommit).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopCommitStatusWebhook).not.toHaveBeenCalled();
    });

    it("skips associated PRs whose head SHA does not match the status commit", async () => {
      mockGetPullRequestsForCommit.mockResolvedValueOnce([
        { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "old-sha" },
      ]);

      const request = await makeSignedStatusRequest(
        JSON.stringify(buildGithubCommitStatusPayload()),
        "delivery-status-2",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, total: 1, handled: 0, ignored: 0, mismatched: 1 });
      expect(mockIngestReviewLoopCommitStatusWebhook).not.toHaveBeenCalled();
    });

    it("drives the inline done-state reconcile from a terminal-success commit status", async () => {
      mockGetPullRequestsForCommit.mockResolvedValueOnce([
        { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "head-sha" },
      ]);

      const request = await makeSignedStatusRequest(
        JSON.stringify(buildGithubCommitStatusPayload()),
        "delivery-status-reconcile-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(200);
      expect(mockEmitReviewLoopCiSignalFromWebhook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prUrl: "https://github.com/acme/repo/pull/42",
          repoOwner: "acme",
          repoName: "repo",
          headSha: "head-sha",
          token: "ghs_install_token",
        }),
      );
    });

    it("does not drive the reconcile for a failing commit status", async () => {
      mockGetPullRequestsForCommit.mockResolvedValueOnce([
        { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "head-sha" },
      ]);

      const request = await makeSignedStatusRequest(
        JSON.stringify(buildGithubCommitStatusPayload({ state: "failure" })),
        "delivery-status-reconcile-fail-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(200);
      expect(mockEmitReviewLoopCiSignalFromWebhook).not.toHaveBeenCalled();
    });

    it("keeps the status webhook a 200 when the reconcile throws", async () => {
      mockGetPullRequestsForCommit.mockResolvedValueOnce([
        { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "head-sha" },
      ]);
      mockIngestReviewLoopCommitStatusWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-status-reconcile-throw", status: "ready" },
      });
      mockEmitReviewLoopCiSignalFromWebhook.mockRejectedValueOnce(new Error("boom"));

      const request = await makeSignedStatusRequest(
        JSON.stringify(buildGithubCommitStatusPayload()),
        "delivery-status-reconcile-throw-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, handled: 1 });
    });
  });

  describe("check_run webhook routing", () => {
    it("routes a completed check_run from a bot into review-loop ingestion", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-check-1", status: "ready" },
      });

      const request = await makeSignedCheckRunRequest(JSON.stringify(buildGithubCheckRunPayload()), "delivery-check-1");
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, total: 1, handled: 1, ignored: 0, mismatched: 0 });
      expect(mockIngestReviewLoopCheckRunWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "delivery-check-1",
          sourceId: "check-run:9500:42",
          checkRunId: 9500,
          checkRunName: "cursor bugbot",
          checkRunStatus: "completed",
          checkRunConclusion: "success",
          actorLogin: "cursor[bot]",
          actorType: "Bot",
          repoOwner: "acme",
          repoName: "repo",
          prNumber: 42,
          prUrl: "https://github.com/acme/repo/pull/42",
          headSha: "head-sha",
        }),
      );
    });

    it("skips check_run with unsupported actions", async () => {
      const request = await makeSignedCheckRunRequest(
        JSON.stringify(buildGithubCheckRunPayload({ action: "created" })),
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("unsupported_action");
      expect(mockIngestReviewLoopCheckRunWebhook).not.toHaveBeenCalled();
    });

    it("skips check_run with an empty pull_requests array", async () => {
      const request = await makeSignedCheckRunRequest(
        JSON.stringify(buildGithubCheckRunPayload({ check_run: { pull_requests: [] } })),
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("no_pull_requests");
      expect(mockIngestReviewLoopCheckRunWebhook).not.toHaveBeenCalled();
    });

    it("skips check_run produced by a cycloid-owned app", async () => {
      const request = await makeSignedCheckRunRequest(
        JSON.stringify(
          buildGithubCheckRunPayload({
            check_run: { app: { slug: "cycloid-dev" } },
          }),
        ),
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("cycloid_owned_sender");
      expect(mockIngestReviewLoopCheckRunWebhook).not.toHaveBeenCalled();
    });

    it("uses check_run.app.slug as the producing-bot identity even when sender is a human", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-check-app", status: "ready" },
      });

      const request = await makeSignedCheckRunRequest(
        JSON.stringify(
          buildGithubCheckRunPayload({
            sender: { login: "alice", type: "User" },
            check_run: { app: { slug: "cursor" } },
          }),
        ),
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, total: 1, handled: 1 });
      expect(mockIngestReviewLoopCheckRunWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLogin: "cursor[bot]",
          actorType: "Bot",
        }),
      );
    });

    it("skips check_run pull_requests whose head SHA does not match the check run", async () => {
      const request = await makeSignedCheckRunRequest(
        JSON.stringify(
          buildGithubCheckRunPayload({
            check_run: {
              head_sha: "new-sha",
              pull_requests: [{ number: 42, head: { sha: "stale-sha" } }],
            },
          }),
        ),
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, total: 1, handled: 0, ignored: 0, mismatched: 1 });
      expect(mockIngestReviewLoopCheckRunWebhook).not.toHaveBeenCalled();
    });

    it("routes a failing check_run from a non-configured app into CI-failure ingestion", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "ignored",
        reason: "actor_not_configured_bot",
      });
      mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-ci-1", status: "ready" },
      });

      const payload = buildGithubCheckRunPayload({
        check_run: {
          id: 7100,
          name: "unit tests",
          status: "completed",
          conclusion: "failure",
          head_sha: "head-sha",
          app: { slug: "github-actions", name: "GitHub Actions" },
          pull_requests: [{ number: 42, head: { sha: "head-sha" } }],
        },
        sender: { id: 1, login: "github-actions[bot]", type: "Bot" },
      });
      const request = await makeSignedCheckRunRequest(JSON.stringify(payload), "delivery-ci-1");
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(mockIngestReviewLoopCiFailureWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          checkRunId: 7100,
          checkRunConclusion: "failure",
          prNumber: 42,
          headSha: "head-sha",
          // FIX 5: the CI ingestion sourceId is namespaced distinctly from the bot path's
          // `check-run:` id so it never pollutes listKnownReviewLoopSourceIds.
          sourceId: "ci-check:7100:42",
        }),
      );
      // The bot path for the SAME check run uses the un-namespaced `check-run:` id.
      expect(mockIngestReviewLoopCheckRunWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "check-run:7100:42" }),
      );
      // The bot path ignored this entry and the CI path handled it. The primary counters keep the
      // invariant handled + ignored + mismatched === total; CI outcomes are tracked separately.
      expect(json).toMatchObject({ total: 1, handled: 0, ignored: 1, mismatched: 0, ciHandled: 1, ciIgnored: 0 });
      expect(mockDispatchReviewLoopEpoch).toHaveBeenCalledWith(
        expect.anything(),
        { id: "epoch-ci-1", status: "ready" },
        expect.objectContaining({
          logger: expect.anything(),
          trigger: "webhook_arrival",
        }),
      );
    });

    it("counts both paths for one PR entry without inflating the primary handled total", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-bot-1", status: "ready" },
      });
      mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-ci-1", status: "ready" },
      });

      const payload = buildGithubCheckRunPayload({
        check_run: {
          id: 7101,
          name: "unit tests",
          status: "completed",
          conclusion: "failure",
          head_sha: "head-sha",
          app: { slug: "github-actions", name: "GitHub Actions" },
          pull_requests: [{ number: 42, head: { sha: "head-sha" } }],
        },
        sender: { id: 1, login: "github-actions[bot]", type: "Bot" },
      });
      const request = await makeSignedCheckRunRequest(JSON.stringify(payload), "delivery-ci-both-1");
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      // Single PR entry: primary handled must be 1 (not 2); CI handled is tracked separately.
      expect(json).toMatchObject({ total: 1, handled: 1, ignored: 0, mismatched: 0, ciHandled: 1, ciIgnored: 0 });
      expect(mockDispatchReviewLoopEpoch).toHaveBeenCalledWith(
        expect.anything(),
        { id: "epoch-ci-1", status: "ready" },
        expect.objectContaining({
          logger: expect.anything(),
          trigger: "webhook_arrival",
        }),
      );
    });

    it("does not immediately dispatch a handled CI epoch that is not ready", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "ignored",
        reason: "actor_not_configured_bot",
      });
      mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-ci-waiting", status: "waiting_for_owner" },
      });

      const payload = buildGithubCheckRunPayload({
        check_run: {
          id: 7102,
          name: "unit tests",
          status: "completed",
          conclusion: "failure",
          head_sha: "head-sha",
          app: { slug: "github-actions", name: "GitHub Actions" },
          pull_requests: [{ number: 42, head: { sha: "head-sha" } }],
        },
        sender: { id: 1, login: "github-actions[bot]", type: "Bot" },
      });
      const request = await makeSignedCheckRunRequest(JSON.stringify(payload), "delivery-ci-not-ready-1");
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ total: 1, handled: 0, ignored: 1, mismatched: 0, ciHandled: 1, ciIgnored: 0 });
      expect(mockDispatchReviewLoopEpoch).not.toHaveBeenCalled();
      expect(loggerState.info).toHaveBeenCalledWith(
        expect.objectContaining({
          checkRunId: 7102,
          epochId: "epoch-ci-waiting",
          epochStatus: "waiting_for_owner",
        }),
        "Review-loop webhook ci epoch handled but not ready; sweep will dispatch when ready",
      );
    });

    it("does NOT call CI-failure ingestion for a successful check_run", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "ignored",
        reason: "actor_not_configured_bot",
      });
      const request = await makeSignedCheckRunRequest(JSON.stringify(buildGithubCheckRunPayload()), "delivery-ok-1"); // default conclusion: success
      await githubMod.handleGithubWebhook(request, buildEnv());
      expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
      expect(mockDispatchReviewLoopEpoch).not.toHaveBeenCalled();
    });

    it("drives the inline done-state reconcile from a terminal-success check_run", async () => {
      const request = await makeSignedCheckRunRequest(
        JSON.stringify(buildGithubCheckRunPayload()), // default conclusion: success
        "delivery-check-reconcile-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(200);
      expect(mockEmitReviewLoopCiSignalFromWebhook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prUrl: "https://github.com/acme/repo/pull/42",
          repoOwner: "acme",
          repoName: "repo",
          headSha: "head-sha",
          token: "ghs_install_token",
        }),
      );
    });

    it("does not mint a token or drive the reconcile for a failing check_run", async () => {
      const payload = buildGithubCheckRunPayload({
        check_run: { conclusion: "failure", app: { slug: "github-actions", name: "GitHub Actions" } },
        sender: { login: "github-actions[bot]", type: "Bot" },
      });
      const request = await makeSignedCheckRunRequest(JSON.stringify(payload), "delivery-check-reconcile-fail-1");
      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(200);
      expect(mockEmitReviewLoopCiSignalFromWebhook).not.toHaveBeenCalled();
      expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    });

    it("keeps the check_run webhook a 200 when the reconcile throws", async () => {
      mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-check-reconcile-throw", status: "ready" },
      });
      mockEmitReviewLoopCiSignalFromWebhook.mockRejectedValueOnce(new Error("boom"));

      const request = await makeSignedCheckRunRequest(
        JSON.stringify(buildGithubCheckRunPayload()),
        "delivery-check-reconcile-throw-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, handled: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // Human review-loop router tests
  // ---------------------------------------------------------------------------

  function seedListeningSession(sessionId: string, ownerUserId = "101") {
    prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", [sessionId]);
    sessionRecords.set(sessionId, {
      sessionId,
      ownerUserId,
      status: "active",
      // @ts-expect-error — test record extends minimal SessionRecord shape
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    });
  }

  function seedIdleSession(sessionId: string, ownerUserId = "101") {
    prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", [sessionId]);
    sessionRecords.set(sessionId, {
      sessionId,
      ownerUserId,
      status: "active",
      // @ts-expect-error — test record extends minimal SessionRecord shape
      reviewListeningActive: false,
    });
  }

  describe("human review-loop router", () => {
    it("routes bot review through ingest with no humanSource", async () => {
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-bot-1", status: "collecting" },
      });

      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: {
              id: 7001,
              state: "commented",
              body: "Bot review",
              user: { login: "coderabbitai[bot]", type: "Bot", id: 99 },
            },
          }),
        ),
        "delivery-bot-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, epochId: "epoch-bot-1" });
      expect(mockIngestReviewLoopPullRequestReviewWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "human:7001",
          actorLogin: "coderabbitai[bot]",
          actorType: "Bot",
        }),
      );
      // No humanSource on bot path
      const callArg = mockIngestReviewLoopPullRequestReviewWebhook.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.humanSource).toBeUndefined();
      expect(mockReengageSessionForReview).not.toHaveBeenCalled();
    });

    it("routes human review on listening session through ingest WITH humanSource", async () => {
      seedListeningSession("sess-listening");
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-human-listening-1", status: "collecting" },
      });

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-human-listening-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true });
      expect(mockIngestReviewLoopPullRequestReviewWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "human:7001",
          actorLogin: "reviewer",
          actorType: "User",
          humanSource: { userId: 555, login: "reviewer" },
        }),
      );
      expect(mockReengageSessionForReview).not.toHaveBeenCalled();
    });

    it("routes human review on idle session through reengageSessionForReview", async () => {
      seedIdleSession("sess-idle");

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-human-idle-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true });
      expect(mockReengageSessionForReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-idle",
          ev: expect.objectContaining({
            reviewId: 7001,
            reviewAuthor: "reviewer",
            reviewUserId: 555,
            installationId: 2222,
          }),
        }),
      );
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
    });

    it("releases the delivery claim and returns 500 when reengage hits a retryable epoch bootstrap failure", async () => {
      seedIdleSession("sess-idle-retryable-bootstrap");
      mockReengageSessionForReview.mockResolvedValueOnce({
        status: "epoch_bootstrap_failed",
        sessionId: "sess-idle-retryable-bootstrap",
        error: "D1_ERROR: internal error",
        retryable: true,
      });

      const body = JSON.stringify(buildGithubPullRequestReviewPayload());
      const first = await githubMod.handleGithubWebhook(
        await makeSignedRequest(body, "delivery-human-epoch-retry-1"),
        buildEnv(),
      );
      const firstJson = (await first.json()) as Record<string, unknown>;

      expect(first.status).toBe(500);
      expect(firstJson).toMatchObject({ ok: false });
      expect(String(firstJson.error)).toContain("epoch_bootstrap=1");
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledTimes(1);

      mockReengageSessionForReview.mockResolvedValueOnce({
        status: "reengaged",
        sessionId: "sess-idle-retryable-bootstrap",
        epochId: "epoch-after-retry",
      });

      const retry = await githubMod.handleGithubWebhook(
        await makeSignedRequest(body, "delivery-human-epoch-retry-1"),
        buildEnv(),
      );
      const retryJson = (await retry.json()) as Record<string, unknown>;

      expect(retry.status).toBe(200);
      expect(retryJson).toMatchObject({ ok: true, reengaged: 1 });
      expect(mockReengageSessionForReview).toHaveBeenCalledTimes(2);
    });

    it("releases the delivery claim and returns 500 when reengage cannot enter review-listening", async () => {
      seedIdleSession("sess-idle-enter-failed");
      mockReengageSessionForReview.mockResolvedValueOnce({
        status: "enter_review_listening_failed",
        sessionId: "sess-idle-enter-failed",
        error: "http_500",
      });

      const body = JSON.stringify(buildGithubPullRequestReviewPayload());
      const first = await githubMod.handleGithubWebhook(
        await makeSignedRequest(body, "delivery-human-enter-retry-1"),
        buildEnv(),
      );
      const firstJson = (await first.json()) as Record<string, unknown>;

      expect(first.status).toBe(500);
      expect(firstJson).toMatchObject({ ok: false });
      expect(String(firstJson.error)).toContain("enter_review_listening=1");
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledTimes(1);

      mockReengageSessionForReview.mockResolvedValueOnce({
        status: "already_reengaged",
        sessionId: "sess-idle-enter-failed",
        epochId: "epoch-after-enter-retry",
      });

      const retry = await githubMod.handleGithubWebhook(
        await makeSignedRequest(body, "delivery-human-enter-retry-1"),
        buildEnv(),
      );
      const retryJson = (await retry.json()) as Record<string, unknown>;

      expect(retry.status).toBe(200);
      expect(retryJson).toMatchObject({ ok: true, already_reengaged: 1 });
      expect(mockReengageSessionForReview).toHaveBeenCalledTimes(2);
    });

    it("reengages each distinct idle/archived session and folds the listening one", async () => {
      prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", [
        "sess-idle-a",
        "sess-idle-b",
        "sess-idle-c",
        "sess-listening",
      ]);
      sessionRecords.set("sess-idle-a", {
        sessionId: "sess-idle-a",
        ownerUserId: "101",
        status: "active",
        // @ts-expect-error — test record extends minimal SessionRecord shape
        reviewListeningActive: false,
      });
      sessionRecords.set("sess-idle-b", {
        sessionId: "sess-idle-b",
        ownerUserId: "101",
        status: "active",
        // @ts-expect-error — test record extends minimal SessionRecord shape
        reviewListeningActive: false,
      });
      sessionRecords.set("sess-idle-c", {
        sessionId: "sess-idle-c",
        ownerUserId: "102",
        status: "archived",
        // @ts-expect-error — test record extends minimal SessionRecord shape
        reviewListeningActive: false,
      });
      sessionRecords.set("sess-listening", {
        sessionId: "sess-listening",
        ownerUserId: "103",
        status: "active",
        // @ts-expect-error — test record extends minimal SessionRecord shape
        reviewListeningActive: true,
      });
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-human-listening-1", status: "collecting" },
      });

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-human-preload-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, ingest_handled: 1, reengaged: 3 });
      expect(mockReengageSessionForReview).toHaveBeenCalledTimes(3);
    });

    it("reengages a candidate with no initial session state", async () => {
      prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", ["sess-racy"]);

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-human-racy-session-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reengaged: 1 });
      expect(mockReengageSessionForReview).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-racy" }));
    });

    it("skips self-trigger before any routing", async () => {
      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: {
              id: 7001,
              state: "commented",
              body: "loop",
              user: { login: "cycloid-dev", type: "User", id: 1 },
            },
          }),
        ),
        "delivery-self-trigger",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("self_trigger");
      expect(mockReengageSessionForReview).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
    });

    it("skips empty approval before any routing", async () => {
      seedListeningSession("sess-listening-empty");
      prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", ["sess-listening-empty"]);

      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: { id: 7001, state: "approved", body: "   ", user: { login: "reviewer", type: "User", id: 555 } },
          }),
        ),
        "delivery-empty-approval",
      );
      // mock getPrReviewComments to return no triggering comments
      mockGetPrReviewComments.mockResolvedValueOnce([]);
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("empty_approval");
      expect(mockReengageSessionForReview).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
    });

    it("skips implicit reviews wrapping self-posted review-loop replies", async () => {
      seedListeningSession("sess-listening-self");
      mockGetPrReviewComments.mockResolvedValueOnce([
        {
          id: 9301,
          reviewId: 7001,
          path: "src/foo.ts",
          line: 15,
          body: "Fixed in abc123.\n\nSource: https://github.com/acme/repo/pull/42#discussion_r8001",
          author: "reviewer",
          inReplyToId: 8001,
        },
      ]);
      mockSelectReviewLoopReplyGithubIds.mockResolvedValueOnce(new Set(["9301"]));

      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: { id: 7001, state: "commented", body: "", user: { login: "reviewer", type: "User", id: 555 } },
          }),
        ),
        "delivery-self-reply-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("review_loop_reply_self_trigger");
      expect(mockSelectReviewLoopReplyGithubIds).toHaveBeenCalledWith(expect.anything(), ["9301"]);
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
      expect(mockReengageSessionForReview).not.toHaveBeenCalled();
    });

    it("processes empty-body reviews when any comment is not a self-posted reply", async () => {
      seedIdleSession("sess-idle-mixed");
      mockGetPrReviewComments.mockResolvedValueOnce([
        {
          id: 9301,
          reviewId: 7001,
          path: "src/foo.ts",
          line: 15,
          body: "Fixed in abc123.",
          author: "reviewer",
          inReplyToId: 8001,
        },
        {
          id: 9302,
          reviewId: 7001,
          path: "src/foo.ts",
          line: 15,
          body: "Actually, please also rename this helper.",
          author: "reviewer",
          inReplyToId: 8001,
        },
      ]);
      mockSelectReviewLoopReplyGithubIds.mockResolvedValueOnce(new Set(["9301"]));

      const request = await makeSignedRequest(
        JSON.stringify(
          buildGithubPullRequestReviewPayload({
            review: { id: 7001, state: "commented", body: "", user: { login: "reviewer", type: "User", id: 555 } },
          }),
        ),
        "delivery-self-reply-mixed-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reengaged: 1 });
      expect(mockReengageSessionForReview).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-idle-mixed" }),
      );
    });

    it("does not run the self-reply lookup for reviews with a body", async () => {
      seedIdleSession("sess-idle-body");
      mockGetPrReviewComments.mockResolvedValueOnce([
        {
          id: 9301,
          reviewId: 7001,
          path: "src/foo.ts",
          line: 15,
          body: "Fixed in abc123.",
          author: "reviewer",
          inReplyToId: 8001,
        },
      ]);

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-self-reply-body-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reengaged: 1 });
      expect(mockSelectReviewLoopReplyGithubIds).not.toHaveBeenCalled();
    });

    it("propagates reengaged status to the response summary", async () => {
      seedIdleSession("sess-idle-reengage");
      mockReengageSessionForReview.mockResolvedValueOnce({
        status: "reengaged",
        sessionId: "sess-idle-reengage",
        epochId: "epoch-re-1",
      });

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-reengage-1",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.reengaged).toBe(1);
    });

    it("propagates pr_not_open status in the response summary", async () => {
      seedIdleSession("sess-pr-closed");
      mockReengageSessionForReview.mockResolvedValueOnce({
        status: "pr_not_open",
        sessionId: "sess-pr-closed",
      });

      const request = await makeSignedRequest(
        JSON.stringify(buildGithubPullRequestReviewPayload()),
        "delivery-pr-closed",
      );
      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.pr_not_open).toBe(1);
    });
  });

  it("routes bot review through ingest path", async () => {
    mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
      status: "handled",
      epoch: { id: "epoch-bot-flag-off", status: "collecting" },
    });

    const request = await makeSignedRequest(
      JSON.stringify(
        buildGithubPullRequestReviewPayload({
          review: {
            id: 7002,
            state: "commented",
            body: "Bot note",
            user: { login: "coderabbitai[bot]", type: "Bot", id: 99 },
          },
        }),
      ),
      "delivery-bot-flag-off",
    );
    const response = await githubMod.handleGithubWebhook(request, buildEnv());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, reviewLoop: true, epochId: "epoch-bot-flag-off" });
    expect(mockReengageSessionForReview).not.toHaveBeenCalled();
  });

  describe("reply-to-review-comment @cycloid mention (ARC-1514)", () => {
    const PR_URL = "https://github.com/acme/repo/pull/42";
    const DIFF_HUNK = "@@ -1,3 +1,4 @@\n-old\n+new";

    // A reply on a review comment thread that mentions @cycloid (appSlug = "cycloid-dev").
    function mentionPayload(overrides: { comment?: Record<string, unknown>; omitInstallation?: boolean } = {}) {
      const payload: Record<string, unknown> = {
        action: "created",
        repository: { name: "repo", html_url: "https://github.com/acme/repo", owner: { login: "acme" } },
        pull_request: {
          id: 9001,
          number: 42,
          title: "Fix the retry path",
          body: "PR body",
          html_url: PR_URL,
          head: { sha: "head-sha" },
        },
        comment: {
          id: 555,
          body: "@cycloid-dev please address this",
          commit_id: "head-sha",
          in_reply_to_id: 111,
          diff_hunk: DIFF_HUNK,
          path: "src/foo.ts",
          side: "RIGHT",
          user: { id: 42, login: "reviewer", type: "User" },
          ...(overrides.comment ?? {}),
        },
      };
      if (!overrides.omitInstallation) payload.installation = { id: 2222 };
      return payload;
    }

    // The replied-to parent body is fetched via GET /repos/{o}/{r}/pulls/comments/{id} (real
    // tracedFetch -> global fetch); getPrHeadSha is mocked, so this is the only fetch.
    function stubParentFetch(parentId: number, body: string, author = "reviewer2") {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === `https://api.github.com/repos/acme/repo/pulls/comments/${parentId}`) {
            return new Response(JSON.stringify({ body, user: { login: author } }), { status: 200 });
          }
          throw new Error(`Unexpected fetch in review-comment mention test: ${url}`);
        }),
      );
    }

    it("bootstraps a TARGETED mention epoch scoped to the comment + parent (parses dropped fields)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      stubParentFetch(111, "Parent thread: fix the null case");
      const request = await makeSignedReviewCommentRequest(JSON.stringify(mentionPayload()), "delivery-mention-1");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, mention: true, epochId: "ep_mention_1", sessionId: "sess-open" });
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args).toMatchObject({
        sessionId: "sess-open",
        ownerUserId: 100,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: PR_URL,
        headSha: "pr-head-sha",
        mode: "targeted",
        // in_reply_to_id / diff_hunk / path are parsed off the reply payload and carried on the epoch.
        targetSourceIds: ["review-comment:555"],
        parentSourceIds: ["review-comment:111"],
        mentionText: "please address this",
        comment: {
          author: "reviewer",
          body: "@cycloid-dev please address this",
          path: "src/foo.ts",
          diffHunk: DIFF_HUNK,
        },
      });
      // Single writer = the sweep; the webhook never enqueues the prompt or runs the bot ingest.
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopPullRequestReviewCommentWebhook).not.toHaveBeenCalled();
      // 👀 acknowledge the mention on the reply comment itself.
      expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
      const ackArg = mockScheduleReviewAckReaction.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(ackArg).toMatchObject({
        owner: "acme",
        repo: "repo",
        actorLogin: "reviewer",
        surface: { kind: "review_comment", commentId: 555 },
      });
    });

    it("forwards the replied-to parent id to bootstrapMentionEpoch so the parent thread is marked handled (ARC-1514 regression)", async () => {
      // Integration guard for the now-fixed bootstrapMentionEpoch: the reply mention must forward the
      // replied-to parent comment id as `review-comment:<inReplyToId>` in parentSourceIds. The lower
      // branch (review-loop-epochs.test.ts) unit-tests that this id marks the parent thread handled; here
      // we only prove the id flows through the webhook so the replied-to comment isn't left dangling.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      stubParentFetch(111, "Parent thread: fix the null case");
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-parent-id",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      expect(response.status).toBe(200);
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      // in_reply_to_id (111) => the parent id the sweep uses to mark that thread handled.
      expect(args.parentSourceIds).toContain("review-comment:111");
    });

    it("fetches the replied-to parent comment and prepends its body + diff hunk", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      stubParentFetch(111, "Please guard the null case here.", "seniordev");
      const request = await makeSignedReviewCommentRequest(JSON.stringify(mentionPayload()), "delivery-mention-parent");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      expect(response.status).toBe(200);
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args.parentComment).toEqual({ author: "seniordev", body: "Please guard the null case here." });
      expect((args.comment as Record<string, unknown>).diffHunk).toBe(DIFF_HUNK);
    });

    it("tolerates a parent-comment fetch failure (parentComment: null) without blocking the mention", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not found", { status: 404 })),
      );
      const request = await makeSignedReviewCommentRequest(JSON.stringify(mentionPayload()), "delivery-mention-404");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      expect(response.status).toBe(200);
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args.parentComment).toBeNull();
    });

    it("does NOT fetch a parent when the comment is not a reply (no in_reply_to_id)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const fetchSpy = vi.fn(async () => {
        throw new Error("fetch should not be called for a non-reply mention");
      });
      vi.stubGlobal("fetch", fetchSpy);
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ comment: { in_reply_to_id: undefined } })),
        "delivery-mention-noreply",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args.parentSourceIds).toEqual([]);
      expect(args.parentComment).toBeNull();
    });

    it("fires even when automatic reviews are disabled (no toggle consult)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      stubParentFetch(111, "parent");
      const request = await makeSignedReviewCommentRequest(JSON.stringify(mentionPayload()), "delivery-mention-manual");

      const response = await githubMod.handleGithubWebhook(request, buildEnv({ AUTOMATIC_REVIEWS_ENABLED: "0" }));
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, mention: true });
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
    });

    it("keeps the bot review-loop ingest path for a reply WITHOUT @cycloid", async () => {
      mockIngestReviewLoopPullRequestReviewCommentWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-inline-1", status: "collecting" },
      });
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ comment: { body: "This branch can still throw." } })),
        "delivery-no-mention",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, epochId: "epoch-inline-1" });
      expect(mockIngestReviewLoopPullRequestReviewCommentWebhook).toHaveBeenCalledOnce();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("auth fails closed: rejects a commenter without repo access (WARN, no bootstrap)", async () => {
      mockVerifyUserRepoAccess.mockResolvedValueOnce(false);
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-noaccess",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "repo_not_authorized" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      // Fail-closed happens before the idempotency claim is committed.
      expect(deliveryClaims.size).toBe(0);
    });

    it("auth fails closed: skips a mention whose sender has no GitHub id", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ comment: { user: { login: "reviewer", type: "User" } } })),
        "delivery-mention-noid",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "github_user_not_connected" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("auth fails closed: rejects a mention with no installation id (400)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ omitInstallation: true })),
        "delivery-mention-noinstall",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(400);
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(0);
    });

    it("skips a Bot sender (loop safety)", async () => {
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ comment: { user: { id: 88, login: "cursor[bot]", type: "Bot" } } })),
        "delivery-mention-bot",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "non_user_sender" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips the app's own self-triggered comment (appSlug, loop safety)", async () => {
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ comment: { user: { id: 5, login: "cycloid-dev", type: "User" } } })),
        "delivery-mention-self",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "self_trigger" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips a Cycloid-owned bot login posted as a User (loop safety)", async () => {
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload({ comment: { user: { id: 9, login: "cycloid-staging[bot]", type: "User" } } })),
        "delivery-mention-ownedbot",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "owned_bot_sender" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips Cycloid's own review-loop reply attributed to a user (own-reply, loop safety)", async () => {
      mockSelectReviewLoopReplyGithubIds.mockResolvedValue(new Set(["555"]));
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-ownreply",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "self_reply" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips with no_bound_session when a non-member replies on a PR with no bound session (ARC-1515 gated)", async () => {
      // Default gate: resolvable internal user but NOT a Cycloid member => the no-bound-session skip is
      // unchanged and the adoption bootstrap is never attempted.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-nobound",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "no_bound_session" });
      expect(mockResolveInternalFeatureGateUser).toHaveBeenCalledWith({}, 77);
      expect(mockIsCycloidMember).toHaveBeenCalledWith({ businessId: "business-internal" });
      expect(mockBootstrapMentionSession).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
    });

    it.each(["created", "handed_off"] as const)(
      "converges a gated %s adoption bootstrap into the targeted mention epoch flow (ARC-1515)",
      async (kind) => {
        mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
        mockIsCycloidMember.mockReturnValue(true);
        mockBootstrapMentionSession.mockResolvedValue({ kind, sessionId: "adopted-session" });
        mockEnsureSessionLiveForPr.mockResolvedValue({
          status: "live",
          session: { sessionId: "adopted-session", ownerUserId: "100", status: "active" },
        });
        stubParentFetch(111, "Parent thread: fix the null case");
        const request = await makeSignedReviewCommentRequest(
          JSON.stringify(mentionPayload()),
          `delivery-mention-adopt-${kind}`,
        );

        const response = await githubMod.handleGithubWebhook(request, buildEnv());
        const json = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(json).toMatchObject({ ok: true, mention: true, epochId: "ep_mention_1", sessionId: "adopted-session" });
        expect(mockBootstrapMentionSession).toHaveBeenCalledOnce();
        const [, bootstrapArgs] = mockBootstrapMentionSession.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(bootstrapArgs).toMatchObject({
          actorLogin: "reviewer",
          actorBusinessId: "business-internal",
          installationId: 2222,
          repoOwner: "acme",
          repoName: "repo",
          prUrl: PR_URL,
          directiveText: "please address this",
        });
        expect(bootstrapArgs.waitUntil).toEqual(expect.any(Function));
        // Falls through to the SAME targeted-epoch flow keyed to the bootstrapped session.
        expect(mockEnsureSessionLiveForPr).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "adopted-session", prUrl: PR_URL }),
        );
        expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
        expect(mockBootstrapMentionEpoch.mock.calls[0][1]).toMatchObject({
          sessionId: "adopted-session",
          mode: "targeted",
          targetSourceIds: ["review-comment:555"],
        });
        expect(mockScheduleReviewAckReaction).toHaveBeenCalledOnce();
      },
    );

    it("maps a gated ambiguous adoption skip without entering the targeted mention epoch flow (ARC-1515)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      mockIsCycloidMember.mockReturnValue(true);
      mockBootstrapMentionSession.mockResolvedValue({ kind: "skip", reason: "ambiguous" });
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-adopt-skip",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
      expect(mockBootstrapMentionSession).toHaveBeenCalledOnce();
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockScheduleReviewAckReaction).not.toHaveBeenCalled();
      expect(mockPostIssueComment).not.toHaveBeenCalled();
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(1);
    });

    it("posts the gated rejection message and retains the delivery claim (ARC-1515)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      mockIsCycloidMember.mockReturnValue(true);
      mockBootstrapMentionSession.mockResolvedValue({
        kind: "rejected",
        reason: "no_write_permission",
        publicMessage: "You need write access to this repository.",
      });
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-adopt-rejected",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "no_write_permission" });
      expect(mockPostIssueComment).toHaveBeenCalledWith(
        expect.anything(),
        2222,
        "acme",
        "repo",
        42,
        "You need write access to this repository.",
      );
      // Benign skip consumes the already-committed claim (never released).
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(1);
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("returns 500 and releases the delivery claim for a gated retry (ARC-1515)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      mockIsCycloidMember.mockReturnValue(true);
      mockBootstrapMentionSession.mockResolvedValue({ kind: "retry", reason: "github_fetch_failed" });
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-adopt-retry",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(500);
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledOnce();
      expect(deliveryClaims.size).toBe(0);
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("reply @cycloid mention fails closed on ambiguous bound session (multiple refs, no tracking winner)", async () => {
      // No tracking winner + MORE THAN ONE webhook-ref session => fail closed with a benign 200 skip.
      // The whole-delivery claim has already committed, so this is a permanent skip (GitHub's redelivery
      // dedup drops the duplicate); we never revive a session or bootstrap an epoch off an ambiguous bind.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      seedPrSessions(
        { sessionId: "sess-a", ownerUserId: "100", status: "active" },
        { sessionId: "sess-b", ownerUserId: "100", status: "active" },
      );
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-ambiguous",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
      // Resolution fails closed before the revive + bootstrap steps.
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      // The claim commits before resolution and the benign skip consumes it (never released).
      expect(deliveryClaims.size).toBe(1);
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
    });

    it("releases the webhook claim and returns 500 when epoch bootstrap throws (retryable)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      stubParentFetch(111, "parent");
      mockBootstrapMentionEpoch.mockRejectedValueOnce(new Error("transient D1 failure"));
      const request = await makeSignedReviewCommentRequest(JSON.stringify(mentionPayload()), "delivery-mention-throw");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(500);
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledOnce();
      expect(deliveryClaims.size).toBe(0);
    });

    it("reply @cycloid on a closed/merged PR skips pr_not_open (no revive/bootstrap)", async () => {
      // The PR-open gate runs BEFORE ensureSessionLiveForPr, so an @cycloid reply on a terminal
      // (merged/closed) PR must never revive the sandbox nor dispatch a mention epoch. getPrState
      // returning a non-"open" state → a benign 200 skip that consumes the already-committed claim
      // (no redelivery, no release).
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      mockGetPrState.mockResolvedValue("merged");
      const request = await makeSignedReviewCommentRequest(JSON.stringify(mentionPayload()), "delivery-mention-merged");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "pr_not_open" });
      // Gate short-circuits before the revive + bootstrap steps.
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      // The claim commits before the gate and the benign skip consumes it (never released).
      expect(deliveryClaims.size).toBe(1);
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
    });

    it("reply @cycloid transient PR-state failure releases the claim (500)", async () => {
      // An indeterminate PR state (getPrState null on a transient GitHub failure) → the gate throws so
      // the catch releases the claim and GitHub redelivers, rather than reviving on an unknown state.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      mockGetPrState.mockResolvedValue(null);
      const request = await makeSignedReviewCommentRequest(
        JSON.stringify(mentionPayload()),
        "delivery-mention-prstate-transient",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(500);
      // Never revives or bootstraps on an unknown state; the claim is released for redelivery.
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledOnce();
      expect(deliveryClaims.size).toBe(0);
    });
  });

  describe("review-body @cycloid mention (ARC-1514, PR8)", () => {
    const PR_URL = "https://github.com/acme/repo/pull/42";

    // A submitted pull_request_review whose BODY mentions @cycloid (appSlug = "cycloid-dev"). The
    // fixture omits pull_request.id, so add it (issueId is required by the fail-closed auth helpers).
    function reviewMentionPayload(
      overrides: {
        review?: Record<string, unknown>;
        pullRequest?: Record<string, unknown>;
        omitInstallation?: boolean;
      } = {},
    ) {
      const payload = buildGithubPullRequestReviewPayload({
        pull_request: {
          id: 9001,
          title: "Fix the retry path",
          body: "PR body",
          head: { sha: "head-sha" },
          ...(overrides.pullRequest ?? {}),
        },
        review: {
          id: 7001,
          state: "changes_requested",
          body: "@cycloid-dev please rework the retry backoff",
          user: { id: 555, login: "reviewer", type: "User" },
          ...(overrides.review ?? {}),
        },
      }) as Record<string, unknown>;
      if (overrides.omitInstallation) delete payload.installation;
      return payload;
    }

    it("bootstraps a DIRECTIVE mention epoch keyed review-body:<reviewId> (bypasses the human loop)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-1");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, mention: true, epochId: "ep_mention_1", sessionId: "sess-open" });
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args).toMatchObject({
        sessionId: "sess-open",
        ownerUserId: 100,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: PR_URL,
        headSha: "pr-head-sha",
        mode: "directive",
        targetSourceIds: ["review-body:7001"],
        mentionText: "please rework the retry backoff",
      });
      // Single writer = the sweep; the webhook never enqueues the prompt and never runs the human-review
      // ingest (the review body is routed to the mention epoch INSTEAD OF the human loop).
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
      expect(mockReengageSessionForReview).not.toHaveBeenCalled();
      // 👀 acknowledge the mention on the review's inline comments (review_submission surface).
      expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
      const ackArg = mockScheduleReviewAckReaction.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(ackArg).toMatchObject({
        owner: "acme",
        repo: "repo",
        surface: { kind: "review_submission", reviewId: 7001 },
      });
    });

    it("fires even when automatic reviews are disabled (no toggle consult, no human-loop ingest)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-manual");

      const response = await githubMod.handleGithubWebhook(request, buildEnv({ AUTOMATIC_REVIEWS_ENABLED: "0" }));
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, mention: true });
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
    });

    it("keeps the existing human-review loop for a review body WITHOUT @cycloid", async () => {
      seedListeningSession("sess-listening-nomention");
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-human-nomention", status: "collecting" },
      });
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload({ review: { body: "Please address the null handling." } })),
        "delivery-review-body-nomention",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true });
      // Non-mention review body flows to the existing human-review loop (ingest WITH humanSource).
      expect(mockIngestReviewLoopPullRequestReviewWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "human:7001", humanSource: { userId: 555, login: "reviewer" } }),
      );
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips a bare @cycloid review body with no directive (empty_mention)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload({ review: { body: "@cycloid-dev" } })),
        "delivery-review-body-empty",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "empty_mention" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
    });

    it("auth fails closed: rejects a reviewer without repo access (WARN, no bootstrap, claim uncommitted)", async () => {
      mockVerifyUserRepoAccess.mockResolvedValueOnce(false);
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-noaccess");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "repo_not_authorized" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      // Fail-closed happens before the idempotency claim is committed.
      expect(deliveryClaims.size).toBe(0);
    });

    it("auth fails closed: skips a mention whose reviewer has no GitHub id", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload({ review: { user: { id: null } } })),
        "delivery-review-body-noid",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "github_user_not_connected" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(0);
    });

    it("auth fails closed: rejects a mention with no installation id (400)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload({ omitInstallation: true })),
        "delivery-review-body-noinstall",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(400);
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(0);
    });

    it("skips a Bot review body mention (routed to bot ingest, not the mention branch)", async () => {
      mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValueOnce({
        status: "handled",
        epoch: { id: "epoch-bot-mention", status: "collecting" },
      });
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload({ review: { user: { id: 99, login: "coderabbitai[bot]", type: "Bot" } } })),
        "delivery-review-body-bot",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, reviewLoop: true, epochId: "epoch-bot-mention" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips the app's own self-triggered review (appSlug, loop safety)", async () => {
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload({ review: { user: { id: 5, login: "cycloid-dev", type: "User" } } })),
        "delivery-review-body-self",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "self_trigger" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips a Cycloid-owned bot login posted as a User (loop safety)", async () => {
      const request = await makeSignedRequest(
        JSON.stringify(
          reviewMentionPayload({ review: { user: { id: 9, login: "cycloid-staging[bot]", type: "User" } } }),
        ),
        "delivery-review-body-ownedbot",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "owned_bot_sender" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips Cycloid's own review-loop output attributed to a user (own-review, loop safety)", async () => {
      mockSelectReviewLoopIssueCommentReplyGithubIds.mockResolvedValue(new Set(["7001"]));
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-ownreview");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ ok: true, skipped: true, reason: "self_reply" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("skips with no_bound_session when a non-member review body mentions on a PR with no bound session (ARC-1515 gated)", async () => {
      // Default gate: resolvable internal user but NOT a Cycloid member => the no-bound-session skip is
      // unchanged and the adoption bootstrap is never attempted.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-nobound");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "no_bound_session" });
      expect(mockResolveInternalFeatureGateUser).toHaveBeenCalledWith({}, 77);
      expect(mockIsCycloidMember).toHaveBeenCalledWith({ businessId: "business-internal" });
      expect(mockBootstrapMentionSession).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      // The claim is committed BEFORE the bound-session resolve (a legit @cycloid mention with no bound
      // session is a real skip, not a retry). deliveryClaims.size === 1 distinguishes this correct
      // post-claim skip from a broken PRE-claim return that would leave redelivery dedup unarmed.
      expect(deliveryClaims.size).toBe(1);
    });

    it.each(["created", "handed_off"] as const)(
      "converges a gated %s adoption bootstrap into the directive mention epoch flow (ARC-1515)",
      async (kind) => {
        mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
        mockIsCycloidMember.mockReturnValue(true);
        mockBootstrapMentionSession.mockResolvedValue({ kind, sessionId: "adopted-session" });
        mockEnsureSessionLiveForPr.mockResolvedValue({
          status: "live",
          session: { sessionId: "adopted-session", ownerUserId: "100", status: "active" },
        });
        const request = await makeSignedRequest(
          JSON.stringify(reviewMentionPayload()),
          `delivery-review-body-adopt-${kind}`,
        );

        const response = await githubMod.handleGithubWebhook(request, buildEnv());
        const json = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(json).toMatchObject({ ok: true, mention: true, epochId: "ep_mention_1", sessionId: "adopted-session" });
        expect(mockBootstrapMentionSession).toHaveBeenCalledOnce();
        const [, bootstrapArgs] = mockBootstrapMentionSession.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(bootstrapArgs).toMatchObject({
          actorLogin: "reviewer",
          actorBusinessId: "business-internal",
          installationId: 2222,
          repoOwner: "acme",
          repoName: "repo",
          prUrl: PR_URL,
          directiveText: "please rework the retry backoff",
        });
        expect(bootstrapArgs.waitUntil).toEqual(expect.any(Function));
        // Falls through to the SAME directive-epoch flow keyed to the bootstrapped session.
        expect(mockEnsureSessionLiveForPr).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "adopted-session", prUrl: PR_URL }),
        );
        expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
        expect(mockBootstrapMentionEpoch.mock.calls[0][1]).toMatchObject({
          sessionId: "adopted-session",
          mode: "directive",
          targetSourceIds: ["review-body:7001"],
        });
        expect(mockScheduleReviewAckReaction).toHaveBeenCalledOnce();
      },
    );

    it("maps a gated ambiguous adoption skip without entering the directive mention epoch flow (ARC-1515)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      mockIsCycloidMember.mockReturnValue(true);
      mockBootstrapMentionSession.mockResolvedValue({ kind: "skip", reason: "ambiguous" });
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload()),
        "delivery-review-body-adopt-skip",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
      expect(mockBootstrapMentionSession).toHaveBeenCalledOnce();
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockScheduleReviewAckReaction).not.toHaveBeenCalled();
      expect(mockPostIssueComment).not.toHaveBeenCalled();
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(1);
    });

    it("posts the gated rejection message and retains the delivery claim (ARC-1515)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      mockIsCycloidMember.mockReturnValue(true);
      mockBootstrapMentionSession.mockResolvedValue({
        kind: "rejected",
        reason: "fork",
        publicMessage: "Cycloid can't adopt a PR from a fork.",
      });
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload()),
        "delivery-review-body-adopt-rejected",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "fork" });
      expect(mockPostIssueComment).toHaveBeenCalledWith(
        expect.anything(),
        2222,
        "acme",
        "repo",
        42,
        "Cycloid can't adopt a PR from a fork.",
      );
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
      expect(deliveryClaims.size).toBe(1);
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("returns 500 and releases the delivery claim for a gated retry (ARC-1515)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      mockIsCycloidMember.mockReturnValue(true);
      mockBootstrapMentionSession.mockResolvedValue({ kind: "retry", reason: "claim_contended" });
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload()),
        "delivery-review-body-adopt-retry",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(500);
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledOnce();
      expect(deliveryClaims.size).toBe(0);
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
    });

    it("folds the review's inline comments into the mention (not dropped)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      // Two inline comments on THIS review (7001) plus one from a DIFFERENT review (6000) that must be
      // filtered out — the review-body mention path routes INSTEAD OF the human loop (the only path that
      // folds a review's inline comments), so these would be dropped without the fold.
      mockGetPrReviewComments.mockResolvedValueOnce([
        {
          id: 11,
          reviewId: 7001,
          path: "src/a.ts",
          line: 10,
          body: "Guard the null here.",
          author: "reviewer",
          inReplyToId: null,
        },
        {
          id: 12,
          reviewId: 7001,
          path: "src/b.ts",
          line: 20,
          body: "Rename this variable.",
          author: "reviewer",
          inReplyToId: null,
        },
        {
          id: 99,
          reviewId: 6000,
          path: "src/c.ts",
          line: 5,
          body: "Thread from another review.",
          author: "reviewer",
          inReplyToId: null,
        },
      ]);
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-inline");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, mention: true });
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      // Each folded inline comment's source id is added so bootstrapMentionEpoch marks it handled and the
      // normal loop / cross-epoch dedup won't re-dispatch it. The other review's comment is excluded.
      expect(args.targetSourceIds).toEqual(["review-body:7001", "review-comment:11", "review-comment:12"]);
      // The rendered directive carries the body directive AND both inline comment bodies/ids in one turn.
      const mentionText = args.mentionText as string;
      expect(mentionText).toContain("please rework the retry backoff");
      expect(mentionText).toContain("Guard the null here.");
      expect(mentionText).toContain("Rename this variable.");
      expect(mentionText).toContain("review-comment:11");
      expect(mentionText).toContain("review-comment:12");
      expect(mentionText).not.toContain("Thread from another review.");
      // The inline comments are folded into the mention epoch, NOT re-run through the human-loop ingest.
      expect(mockIngestReviewLoopPullRequestReviewWebhook).not.toHaveBeenCalled();
    });

    it("proceeds with the body directive alone when the inline comment fetch fails (best-effort)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      mockGetPrReviewComments.mockRejectedValueOnce(new Error("transient GitHub 502"));
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload()),
        "delivery-review-body-inline-fail",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, mention: true });
      expect(mockBootstrapMentionEpoch).toHaveBeenCalledOnce();
      const [, args] = mockBootstrapMentionEpoch.mock.calls[0] as [unknown, Record<string, unknown>];
      // Fetch failure never loses the mention: only the body directive + its source id are bootstrapped.
      expect(args.targetSourceIds).toEqual(["review-body:7001"]);
      expect(args.mentionText).toBe("please rework the retry backoff");
    });

    it("fails closed on an ambiguous bound session (no tracking winner, multiple refs)", async () => {
      // No tracking winner, and the PR ref resolves to TWO sessions — the writer cannot be proven, so the
      // mention must fail closed rather than guess which session to drive.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
      prSessionRefs.set("github_pr_url:https://github.com/acme/repo/pull/42", ["sess-a", "sess-b"]);
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-ambiguous");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      // The claim is committed before the ambiguity check; this is a terminal skip, not a retry.
      expect(deliveryClaims.size).toBe(1);
    });

    it("releases the webhook claim and returns 500 when epoch bootstrap throws (retryable)", async () => {
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      mockBootstrapMentionEpoch.mockRejectedValueOnce(new Error("transient D1 failure"));
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-throw");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(500);
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledOnce();
      expect(deliveryClaims.size).toBe(0);
    });

    it("review-body @cycloid on a closed/merged PR skips pr_not_open (no revive/bootstrap)", async () => {
      // The PR-open gate runs BEFORE ensureSessionLiveForPr, so an @cycloid review body on a terminal
      // (merged/closed) PR must never revive the sandbox nor dispatch a mention epoch. getPrState
      // returning a non-"open" state → a benign 200 skip that consumes the already-committed claim
      // (no redelivery, no release).
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      mockGetPrState.mockResolvedValue("merged");
      const request = await makeSignedRequest(JSON.stringify(reviewMentionPayload()), "delivery-review-body-merged");

      const response = await githubMod.handleGithubWebhook(request, buildEnv());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json).toMatchObject({ ok: true, skipped: true, reason: "pr_not_open" });
      // Gate short-circuits before the revive + bootstrap steps.
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      // The claim commits before the gate and the benign skip consumes it (never released).
      expect(deliveryClaims.size).toBe(1);
      expect(mockReleaseWebhookIdempotencyClaim).not.toHaveBeenCalled();
    });

    it("review-body @cycloid transient PR-state failure releases the claim (500)", async () => {
      // An indeterminate PR state (getPrState null on a transient GitHub failure) → the gate throws so
      // the catch releases the claim and GitHub redelivers, rather than reviving on an unknown state.
      mockGetTrackingSessionIdForPrUrl.mockResolvedValue("sess-open");
      mockGetPrState.mockResolvedValue(null);
      const request = await makeSignedRequest(
        JSON.stringify(reviewMentionPayload()),
        "delivery-review-body-prstate-transient",
      );

      const response = await githubMod.handleGithubWebhook(request, buildEnv());

      expect(response.status).toBe(500);
      // Never revives or bootstraps on an unknown state; the claim is released for redelivery.
      expect(mockEnsureSessionLiveForPr).not.toHaveBeenCalled();
      expect(mockBootstrapMentionEpoch).not.toHaveBeenCalled();
      expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledOnce();
      expect(deliveryClaims.size).toBe(0);
    });
  });
});
