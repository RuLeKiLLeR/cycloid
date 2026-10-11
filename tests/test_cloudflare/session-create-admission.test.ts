import { beforeEach, describe, expect, it, vi } from "vitest";

import { lastDdEvent } from "./helpers/dd-events";

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
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const mockGateGithubSessionStart = vi.fn();
const mockVerifyRepoAccessAndInstallation = vi.fn();
const mockCreateSessionState = vi.fn();
const mockSyncSessionProjection = vi.fn();
const mockAdmitSessionCreate = vi.fn();
const mockReadIdempotencyKeyHeader = vi.fn();
const mockBeginIdempotentRequest = vi.fn();
const mockReleaseIdempotentRequest = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockGetBranchHeadSha = vi.fn();
const mockFindActiveVerificationSession = vi.fn();
const mockCheckVerificationRunLimit = vi.fn();
const mockFetchVerificationPrContext = vi.fn();
const mockRequestCoordinatedVerification = vi.fn();
const mockUpsertSessionPrMetadata = vi.fn();
const mockUpsertSessionWebhookRef = vi.fn();
const mockQueryPlatformStructuredOutput = vi.fn();
const mockGetTrackingSessionIdForPrUrl = vi.fn();
const mockGetSessionIndexIdentity = vi.fn();
const mockClaimPrTakeoverAdmission = vi.fn();
const mockReleasePrTakeoverAdmission = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => mockGateGithubSessionStart(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/db", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/db")>(
    "../../apps/control-plane-worker/src/session/db",
  );
  return { ...actual, getSessionIndexIdentity: (...args: unknown[]) => mockGetSessionIndexIdentity(...args) };
});

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...args: unknown[]) => mockVerifyRepoAccessAndInstallation(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/github/octokit")>(
    "../../apps/control-plane-worker/src/github/octokit",
  );
  return { ...actual, createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args) };
});

vi.mock("../../apps/control-plane-worker/src/github/pr", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/github/pr")>(
    "../../apps/control-plane-worker/src/github/pr",
  );
  return { ...actual, getBranchHeadSha: (...args: unknown[]) => mockGetBranchHeadSha(...args) };
});

vi.mock("../../apps/control-plane-worker/src/github/verification-pr-context", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/github/verification-pr-context")
  >("../../apps/control-plane-worker/src/github/verification-pr-context");
  return {
    ...actual,
    fetchVerificationPrContext: (...args: unknown[]) => mockFetchVerificationPrContext(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return { ...actual, createSessionState: (...args: unknown[]) => mockCreateSessionState(...args) };
});

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/platform-structured-output", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/services/platform-structured-output")
  >("../../apps/control-plane-worker/src/services/platform-structured-output");
  return {
    ...actual,
    queryPlatformStructuredOutput: (...args: unknown[]) => mockQueryPlatformStructuredOutput(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/session-admission", () => ({
  admitSessionCreate: (...args: unknown[]) => mockAdmitSessionCreate(...args),
}));

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

const lastRejectionEvent = (eventName: string) => lastDdEvent(mockPostStructuredEventToDd, eventName);

vi.mock("../../apps/control-plane-worker/src/services/idempotency", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/services/idempotency")>(
    "../../apps/control-plane-worker/src/services/idempotency",
  );
  return {
    ...actual,
    readIdempotencyKeyHeader: (...args: unknown[]) => mockReadIdempotencyKeyHeader(...args),
    beginIdempotentRequest: (...args: unknown[]) => mockBeginIdempotentRequest(...args),
    releaseIdempotentRequest: (...args: unknown[]) => mockReleaseIdempotentRequest(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/verification-gate", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/verification-gate")>(
    "../../apps/control-plane-worker/src/session/verification-gate",
  );
  return {
    ...actual,
    findActiveVerificationSession: (...args: unknown[]) => mockFindActiveVerificationSession(...args),
    checkVerificationRunLimit: (...args: unknown[]) => mockCheckVerificationRunLimit(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/verification-coordinator-service", () => ({
  requestCoordinatedVerification: (...args: unknown[]) => mockRequestCoordinatedVerification(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-metadata-db", () => ({
  upsertSessionPrMetadata: (...args: unknown[]) => mockUpsertSessionPrMetadata(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/pr-coordination-db")>(
    "../../apps/control-plane-worker/src/session/pr-coordination-db",
  );
  return {
    ...actual,
    getTrackingSessionIdForPrUrl: (...args: unknown[]) => mockGetTrackingSessionIdForPrUrl(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/pr-takeover-admission-claims-db", () => ({
  claimPrTakeoverAdmission: (...args: unknown[]) => mockClaimPrTakeoverAdmission(...args),
  releasePrTakeoverAdmission: (...args: unknown[]) => mockReleasePrTakeoverAdmission(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/webhooks/db")>(
    "../../apps/control-plane-worker/src/webhooks/db",
  );
  return {
    ...actual,
    upsertSessionWebhookRef: (...args: unknown[]) => mockUpsertSessionWebhookRef(...args),
  };
});

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import { ProviderCredentialNotValidatedError } from "../../apps/control-plane-worker/src/services/provider-credential-gate";
import { InvalidSessionIdError } from "../../apps/control-plane-worker/src/session/state";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";
import { SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS } from "../../shared/constants/session";

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session_token",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 42,
      login: "user-42",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "member",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    },
    ...overrides,
  };
}

function makeEnv(): Env {
  return { DB: {} as D1Database, REPOS_CACHE: {} as KVNamespace } as Env;
}

function getCreateSessionRoute() {
  const route = sessionRoutes.find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test("/api/sessions"),
  );
  if (!route) throw new Error("Create session route not found");
  return route;
}

function getSessionPrerequisitesRoute() {
  const route = sessionRoutes.find(
    (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/sessions/prerequisites"),
  );
  if (!route) throw new Error("Session prerequisites route not found");
  return route;
}

async function callCreate(
  body: string | object,
  headers?: Record<string, string>,
  auth: AuthInfo = makeAuth(),
): Promise<Response> {
  const route = getCreateSessionRoute();
  return route.handler(
    new Request("https://worker.test/api/sessions", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    }),
    makeEnv(),
    route.pattern.exec("/api/sessions")!,
    auth,
  );
}

async function callPrerequisites(model: string, auth: AuthInfo = makeAuth()): Promise<Response> {
  const route = getSessionPrerequisitesRoute();
  return route.handler(
    new Request(`https://worker.test/api/sessions/prerequisites?model=${encodeURIComponent(model)}`),
    makeEnv(),
    route.pattern.exec("/api/sessions/prerequisites")!,
    auth,
  );
}

describe("session create admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateGithubSessionStart.mockResolvedValue({ ok: true, installationId: 99 });
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 99 });
    mockCreateSessionState.mockResolvedValue({ session: { sessionId: "sess-1", ownerUserId: "42" }, replay: [] });
    mockSyncSessionProjection.mockResolvedValue(undefined);
    mockAdmitSessionCreate.mockResolvedValue({ ok: true });
    mockReadIdempotencyKeyHeader.mockReturnValue(null);
    mockBeginIdempotentRequest.mockResolvedValue({
      kind: "proceed",
      token: { key: "idem-key-1", ownerUserId: "42", route: "session" },
    });
    mockReleaseIdempotentRequest.mockResolvedValue(undefined);
    mockCreateInstallationToken.mockResolvedValue("ghs_token");
    mockGetBranchHeadSha.mockResolvedValue("abc123");
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockCheckVerificationRunLimit.mockResolvedValue({ allowed: true, currentRuns: 0, maxRuns: 5 });
    mockRequestCoordinatedVerification.mockResolvedValue({
      ok: true,
      sessionId: "qa-session-1",
      coordinatorSessionId: "pr-coord:https%3A%2F%2Fgithub.com%2Ftrycycloid%2Fcycloid%2Fpull%2F123",
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      headSha: "abc123",
      duplicate: false,
    });
    mockUpsertSessionPrMetadata.mockResolvedValue(undefined);
    mockUpsertSessionWebhookRef.mockResolvedValue(undefined);
    mockGetTrackingSessionIdForPrUrl.mockResolvedValue(null);
    mockGetSessionIndexIdentity.mockResolvedValue(null);
    mockClaimPrTakeoverAdmission.mockImplementation(async (_db: D1Database, args: { sessionId: string }) => ({
      won: true,
      sessionId: args.sessionId,
    }));
    mockReleasePrTakeoverAdmission.mockResolvedValue(undefined);
    mockQueryPlatformStructuredOutput.mockResolvedValue({ shouldContinue: false, selectedPrUrl: null });
    mockFetchVerificationPrContext.mockResolvedValue({
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      owner: "trycycloid",
      repo: "cycloid",
      number: 123,
      title: "Finish continuation",
      body: null,
      state: "open",
      draft: false,
      mergeable: null,
      mergeStateStatus: null,
      labels: [],
      headRef: "feature/continue-pr",
      headSha: "abc123",
      headRepoOwner: "trycycloid",
      headRepoName: "cycloid",
      baseRef: "main",
      authorLogin: "maya",
      files: [],
      commits: [],
      checksSummary: "",
      vercelDeployPreview: null,
      recentDiscussion: [],
      fetchWarnings: [],
    });
  });

  it("returns 429 and does not create when admission rejects (cap reached)", async () => {
    mockAdmitSessionCreate.mockResolvedValue({
      ok: false,
      status: 429,
      code: "active_session_limit_exceeded",
      message: "Active session limit reached (100). Close an existing session and try again.",
      activeCount: 100,
    });

    const response = await callCreate({ repoOwner: "trycycloid", repoName: "cycloid" });

    expect(response.status).toBe(429);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Active session limit") });

    const audit = lastRejectionEvent("session_admission_rejected");
    expect(audit).toMatchObject({
      event: "session_admission_rejected",
      code: "active_session_limit_exceeded",
      ownerUserId: "42",
      businessId: "biz-1",
      activeCount: 100,
    });
  });

  it("attaches an explicit same-repo continuation PR to the created session", async () => {
    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(mockGetBranchHeadSha).toHaveBeenCalledWith("ghs_token", "trycycloid", "cycloid", "feature/continue-pr");
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        repoContext: expect.objectContaining({
          repoOwner: "trycycloid",
          repoName: "cycloid",
          baseBranch: "main",
          startBranch: "feature/continue-pr",
        }),
        targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prNumber: 123,
      }),
    );
    expect(mockUpsertSessionPrMetadata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "sess-1",
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prNumber: 123,
        publishedBranch: "feature/continue-pr",
      }),
    );
    expect(mockUpsertSessionWebhookRef).toHaveBeenCalledWith(
      expect.anything(),
      "github_pr_url",
      "https://github.com/trycycloid/cycloid/pull/123",
      "sess-1",
    );
  });

  it("rejects explicit PR continuation from non-web non-CLI session auth", async () => {
    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        prompt: "finish this PR",
        continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      },
      undefined,
      makeAuth({ tokenSource: "bearer" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "PR continuation is only supported from the web app, Slack, and CLI",
    });
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects takeover when the PR already has an active coordinating session", async () => {
    mockGetTrackingSessionIdForPrUrl.mockResolvedValue("live-session-1");
    mockGetSessionIndexIdentity.mockResolvedValue({ ownerUserId: "42", businessId: "biz-1" });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "update-pr",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "pr_takeover_conflict",
      sessionId: "live-session-1",
      error: "This pull request already has an active Cycloid session",
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects a concurrent takeover admission before it initializes a second session", async () => {
    const firstSessionId = "11111111-1111-4111-8111-111111111111";
    const secondSessionId = "22222222-2222-4222-8222-222222222222";
    mockClaimPrTakeoverAdmission.mockImplementation(async (_db: D1Database, args: { sessionId: string }) => ({
      won: args.sessionId === firstSessionId,
      sessionId: firstSessionId,
    }));
    mockGetSessionIndexIdentity.mockResolvedValue({ ownerUserId: "42", businessId: "biz-1" });

    const [first, second] = await Promise.all(
      [firstSessionId, secondSessionId].map((sessionId) =>
        callCreate({
          sessionId,
          repoOwner: "trycycloid",
          repoName: "cycloid",
          prompt: "finish this PR",
          continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
          continueMode: "update-pr",
        }),
      ),
    );

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    expect(await second.json()).toMatchObject({ code: "pr_takeover_conflict", sessionId: firstSessionId });
  });

  it("releases the takeover claim when session initialization fails", async () => {
    mockCreateSessionState.mockRejectedValueOnce(new Error("DO initialize failed"));

    const response = await callCreate({
      sessionId: "33333333-3333-4333-8333-333333333333",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "update-pr",
    });

    expect(response.status).toBe(500);
    expect(mockReleasePrTakeoverAdmission).toHaveBeenCalledWith(expect.anything(), {
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("releases the takeover claim when QA verification creates a different session", async () => {
    const response = await callCreate({
      qa: true,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "verify this PR",
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "update-pr",
    });

    expect(response.status).toBe(201);
    expect(mockRequestCoordinatedVerification).toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockReleasePrTakeoverAdmission).toHaveBeenCalledWith(expect.anything(), {
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      sessionId: expect.any(String),
    });
  });

  it("does not disclose an inaccessible coordinating session in a takeover conflict", async () => {
    mockGetTrackingSessionIdForPrUrl.mockResolvedValue("live-session-1");
    mockGetSessionIndexIdentity.mockResolvedValue({ ownerUserId: "other-user", businessId: "other-biz" });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "update-pr",
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "pr_takeover_conflict" });
    expect(body).not.toHaveProperty("sessionId");
  });

  it("returns the continuation reason code for invalid takeover targets", async () => {
    mockFetchVerificationPrContext.mockResolvedValueOnce({ state: "closed" });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "update-pr",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "closed_pr" });
  });

  it("infers continuation from a finish-this-PR prompt with exactly one PR URL", async () => {
    mockQueryPlatformStructuredOutput.mockResolvedValueOnce({
      shouldContinue: true,
      selectedPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "please finish this PR https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(mockFetchVerificationPrContext).toHaveBeenCalledWith(
      expect.anything(),
      "https://github.com/trycycloid/cycloid/pull/123",
      expect.objectContaining({ requireRepoMatch: true }),
    );
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prNumber: 123,
      }),
    );
  });

  it("uses the LLM-selected PR when a continuation prompt mentions multiple PR URLs", async () => {
    mockQueryPlatformStructuredOutput.mockResolvedValueOnce({
      shouldContinue: true,
      selectedPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt:
        "finish this PR https://github.com/trycycloid/cycloid/pull/123 and https://github.com/trycycloid/cycloid/pull/124",
    });

    expect(response.status).toBe(201);
    expect(mockFetchVerificationPrContext).toHaveBeenCalledWith(
      expect.anything(),
      "https://github.com/trycycloid/cycloid/pull/123",
      expect.anything(),
    );
  });

  it("does not infer continuation when the LLM classifies the PR URL as reference-only", async () => {
    mockQueryPlatformStructuredOutput.mockResolvedValueOnce({ shouldContinue: false, selectedPrUrl: null });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "look at https://github.com/trycycloid/cycloid/pull/123 for context and fix the bug",
    });

    expect(response.status).toBe(201);
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        targetPrUrl: null,
        prUrl: null,
        prNumber: null,
      }),
    );
  });

  it("creates a normal session when prompt-inferred continuation intent classification fails", async () => {
    mockQueryPlatformStructuredOutput.mockRejectedValueOnce(new Error("provider timeout"));

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "please finish this PR https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        targetPrUrl: null,
        prUrl: null,
        prNumber: null,
      }),
    );
  });

  it("lets an explicit continuation PR disambiguate prompts that mention other PRs", async () => {
    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt:
        "finish this PR https://github.com/trycycloid/cycloid/pull/123 using context from https://github.com/trycycloid/cycloid/pull/124",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(mockFetchVerificationPrContext).toHaveBeenCalledWith(
      expect.anything(),
      "https://github.com/trycycloid/cycloid/pull/123",
      expect.anything(),
    );
  });

  it("starts from the PR head but leaves the publish target unset for new-pr mode", async () => {
    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "new-pr",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        repoContext: expect.objectContaining({ startBranch: "feature/continue-pr" }),
        targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prUrl: null,
        prNumber: null,
      }),
    );
    expect(mockUpsertSessionPrMetadata).not.toHaveBeenCalled();
  });

  it("rejects continuation mode without a continuation PR", async () => {
    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "fix the bug",
      continueMode: "update-pr",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "continueMode requires continuePrUrl or a prompt-inferred continuation PR",
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects startBranch and baseBranch mismatches for continuation PRs", async () => {
    const startBranchMismatch = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      startBranch: "feature/other",
    });
    expect(startBranchMismatch.status).toBe(400);
    expect(await startBranchMismatch.json()).toMatchObject({
      error: "startBranch must match the continued pull request head branch",
    });

    const baseBranchMismatch = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      baseBranch: "release/2026-06",
    });
    expect(baseBranchMismatch.status).toBe(400);
    expect(await baseBranchMismatch.json()).toMatchObject({
      error: "baseBranch must match the continued pull request base branch",
    });
  });

  it("does not persist adopted PR metadata when a duplicate session id belongs to another user", async () => {
    mockCreateSessionState.mockResolvedValueOnce({
      session: { sessionId: "victim-session", ownerUserId: "other-user" },
      replay: [],
    });

    const response = await callCreate({
      sessionId: "victim-session",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(409);
    expect(mockUpsertSessionPrMetadata).not.toHaveBeenCalled();
    expect(mockUpsertSessionWebhookRef).not.toHaveBeenCalled();
  });

  it("fails closed when adopted PR metadata cannot be persisted", async () => {
    mockUpsertSessionPrMetadata.mockRejectedValueOnce(new Error("d1 unavailable"));

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Session creation failed during persist"),
    });
    expect(mockSyncSessionProjection).toHaveBeenCalled();
  });

  it("rejects fork continuation PRs", async () => {
    mockFetchVerificationPrContext.mockResolvedValueOnce({
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      owner: "trycycloid",
      repo: "cycloid",
      number: 123,
      title: "Fork PR",
      body: null,
      state: "open",
      draft: false,
      mergeable: null,
      mergeStateStatus: null,
      labels: [],
      headRef: "feature/fork",
      headSha: "abc123",
      headRepoOwner: "maya",
      headRepoName: "cycloid",
      baseRef: "main",
      authorLogin: "maya",
      files: [],
      commits: [],
      checksSummary: "",
      vercelDeployPreview: null,
      recentDiscussion: [],
      fetchWarnings: [],
    });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Fork pull requests cannot be continued yet" });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("returns Retry-After when admission rejects for the create rate limit", async () => {
    mockAdmitSessionCreate.mockResolvedValue({
      ok: false,
      status: 429,
      code: "session_create_rate_limited",
      message: "Too many sessions created recently. Retry shortly.",
    });

    const response = await callCreate({ repoOwner: "trycycloid", repoName: "cycloid" });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS));
    expect(mockCreateSessionState).not.toHaveBeenCalled();

    // Reuses the existing event+code so the Terraform monitor selectors finally match.
    const audit = lastRejectionEvent("session_admission_rejected");
    expect(audit).toMatchObject({
      event: "session_admission_rejected",
      code: "session_create_rate_limited",
      ownerUserId: "42",
      businessId: "biz-1",
    });
  });

  it("does not mint a GitHub token or validate startBranch when admission rejects", async () => {
    mockAdmitSessionCreate.mockResolvedValue({
      ok: false,
      status: 429,
      code: "session_create_rate_limited",
      message: "Too many sessions created recently. Retry shortly.",
    });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      startBranch: "resume/branch",
    });

    expect(response.status).toBe(429);
    expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    expect(mockGetBranchHeadSha).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim when startBranch validation is transiently unavailable", async () => {
    mockReadIdempotencyKeyHeader.mockReturnValue("idem-key-1");
    mockGetBranchHeadSha.mockRejectedValue(new Error("GitHub unavailable"));

    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        startBranch: "resume/branch",
      },
      { "Idempotency-Key": "idem-key-1" },
    );

    expect(response.status).toBe(503);
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), {
      key: "idem-key-1",
      ownerUserId: "42",
      route: "session",
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim when startBranch is missing", async () => {
    mockReadIdempotencyKeyHeader.mockReturnValue("idem-key-1");
    mockGetBranchHeadSha.mockResolvedValue(null);

    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        startBranch: "missing/branch",
      },
      { "Idempotency-Key": "idem-key-1" },
    );

    expect(response.status).toBe(404);
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), {
      key: "idem-key-1",
      ownerUserId: "42",
      route: "session",
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("proceeds to create the session when admission passes", async () => {
    const response = await callCreate({ repoOwner: "trycycloid", repoName: "cycloid" });

    expect(mockAdmitSessionCreate).toHaveBeenCalledTimes(1);
    expect(mockAdmitSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", env: expect.anything(), db: expect.anything() }),
    );
    expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(201);
  });

  it("rejects opencode sessions for non-internal callers", async () => {
    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "opencode",
      model: "kimi-k2.7-code",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "opencode is only available to Cycloid team members" });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("reports non-internal opencode sessions as not startable in prerequisites", async () => {
    const response = await callPrerequisites("kimi-k2.7-code");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      canStartSession: false,
      blocking: { provider: null, reasonCode: "opencode_access_denied" },
    });
  });

  it("allows Cycloid QA business members through the opencode route UX gate", async () => {
    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        agentRuntimeBackend: "opencode",
        model: "kimi-k2.7-code",
      },
      undefined,
      makeAuth({ user: { ...makeAuth().user!, businessId: SEEDED_BUSINESS_IDS.cycloidQa } }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({ agentRuntimeBackend: "opencode", model: "kimi-k2.7-code" }),
    );
  });

  it("fails closed for internal opencode sessions when no Baseten key resolves", async () => {
    mockCreateSessionState.mockRejectedValueOnce(
      new ProviderCredentialNotValidatedError("baseten", "kimi-k2.7-code", "credentials_missing"),
    );

    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        agentRuntimeBackend: "opencode",
        model: "kimi-k2.7-code",
      },
      undefined,
      makeAuth({ user: { ...makeAuth().user!, businessId: SEEDED_BUSINESS_IDS.cycloidQa } }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "provider_key_not_validated",
      provider: "baseten",
      modelId: "kimi-k2.7-code",
      reasonCode: "credentials_missing",
      message: "No validated Baseten key. Validate your key in Settings to use kimi-k2.7-code.",
    });
  });

  it("rejects the removed public verify alias before opencode probe admission", async () => {
    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        agentRuntimeBackend: "opencode",
        model: "kimi-k2.7-code",
        verify: true,
      },
      undefined,
      makeAuth({ canAccessAllSessions: true }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "verify is no longer supported; use qa instead" });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("honors autoVerify for internal opencode sessions (Phase 8: no probe-session exemption)", async () => {
    const response = await callCreate(
      {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        agentRuntimeBackend: "opencode",
        model: "kimi-k2.7-code",
        autoVerify: true,
      },
      undefined,
      makeAuth({
        canAccessAllSessions: true,
        user: { ...makeAuth().user!, businessId: SEEDED_BUSINESS_IDS.cycloidQa },
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({ autoVerify: true }),
    );
  });

  it("runs idempotency replay BEFORE admission: a replay returns 201 without consulting the cap", async () => {
    mockReadIdempotencyKeyHeader.mockReturnValue("idem-key-1");
    mockBeginIdempotentRequest.mockResolvedValue({ kind: "replay", resolvedId: "sess-existing" });

    const response = await callCreate({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "finish this PR https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sessionId: "sess-existing", idempotentReplay: true });
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
    expect(mockAdmitSessionCreate).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body (declared content-length) before parsing or admission", async () => {
    const response = await callCreate("{}", { "content-length": String(300 * 1024) });

    expect(response.status).toBe(413);
    expect(mockAdmitSessionCreate).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();

    const audit = lastRejectionEvent("session_create_body_too_large");
    expect(audit).toMatchObject({
      event: "session_create_body_too_large",
      ownerUserId: "42",
      declaredBodyLength: 300 * 1024,
    });
  });

  it("returns 413 for an oversized body even when content-length is absent", async () => {
    const response = await callCreate(JSON.stringify({ prompt: "x".repeat(300 * 1024) }));

    expect(response.status).toBe(413);
    expect(mockAdmitSessionCreate).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();

    const audit = lastRejectionEvent("session_create_body_too_large");
    expect(audit).toMatchObject({ event: "session_create_body_too_large", ownerUserId: "42" });
  });

  it("returns 400 for a present-but-malformed JSON body", async () => {
    const response = await callCreate("{ not valid json", { "content-length": "16" });

    expect(response.status).toBe(400);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON when content-length is absent", async () => {
    const response = await callCreate("{ not valid json");

    expect(response.status).toBe(400);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("returns 400 for valid JSON bodies that are not objects", async () => {
    const response = await callCreate("null");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Request body must be a JSON object" });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects malformed caller-supplied session ids before session creation", async () => {
    for (const sessionId of ["bad/slash", "bad\nnewline", "x".repeat(129), 123]) {
      const response = await callCreate({
        sessionId,
        repoOwner: "trycycloid",
        repoName: "cycloid",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "sessionId must be 1-128 characters of letters, numbers, underscores, or hyphens",
      });
    }

    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("returns 400 when the session-state chokepoint rejects the session id", async () => {
    mockCreateSessionState.mockRejectedValueOnce(new InvalidSessionIdError("bad/slash"));

    const response = await callCreate({
      sessionId: "session-123",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "sessionId must be 1-128 characters of letters, numbers, underscores, or hyphens",
    });
  });
});
