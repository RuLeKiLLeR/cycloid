import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureRepoLabel = vi.hoisted(() => vi.fn());
const mockListLabels = vi.hoisted(() => vi.fn());
const mockSetLabels = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());
const mockCountVerificationSessionsByGithubPrRef = vi.hoisted(() => vi.fn());
const mockGetSessionState = vi.hoisted(() => vi.fn());
const mockListSessionIdsByWebhookRef = vi.hoisted(() => vi.fn());
const mockSetSessionVerificationResult = vi.hoisted(() => vi.fn());
const mockSetSessionVerificationState = vi.hoisted(() => vi.fn());
const mockUpdateSessionCallbackContext = vi.hoisted(() => vi.fn());
const mockResolveSlackBotTokenForCallback = vi.hoisted(() => vi.fn());
const mockPostThreadReply = vi.hoisted(() => vi.fn());
const mockClaimSlackPostForDelivery = vi.hoisted(() => vi.fn());
const mockMarkSlackPostDelivered = vi.hoisted(() => vi.fn());
const mockMarkSlackPostPendingRetry = vi.hoisted(() => vi.fn());
const mockDeleteSlackPostMarker = vi.hoisted(() => vi.fn());
const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true));
const mockWakeSessionSlackRetry = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/pr", () => ({
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  listLabels: (...args: unknown[]) => mockListLabels(...args),
  setLabels: (...args: unknown[]) => mockSetLabels(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  countVerificationSessionsByGithubPrRef: (...args: unknown[]) => mockCountVerificationSessionsByGithubPrRef(...args),
  listSessionIdsByWebhookRef: (...args: unknown[]) => mockListSessionIdsByWebhookRef(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  setSessionVerificationResult: (...args: unknown[]) => mockSetSessionVerificationResult(...args),
  setSessionVerificationState: (...args: unknown[]) => mockSetSessionVerificationState(...args),
  updateSessionCallbackContext: (...args: unknown[]) => mockUpdateSessionCallbackContext(...args),
  wakeSessionSlackRetry: (...args: unknown[]) => mockWakeSessionSlackRetry(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/slack/tokens", () => ({
  resolveSlackBotTokenForCallback: (...args: unknown[]) => mockResolveSlackBotTokenForCallback(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/slack/notify", () => ({
  postThreadReply: (...args: unknown[]) => mockPostThreadReply(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/slack-posts-db", () => ({
  claimSlackPostForDelivery: (...args: unknown[]) => mockClaimSlackPostForDelivery(...args),
  markSlackPostDelivered: (...args: unknown[]) => mockMarkSlackPostDelivered(...args),
  markSlackPostPendingRetry: (...args: unknown[]) => mockMarkSlackPostPendingRetry(...args),
  deleteSlackPostMarker: (...args: unknown[]) => mockDeleteSlackPostMarker(...args),
}));

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import {
  clearVerificationVerdictForHeadChange,
  syncVerificationResultForPr,
  syncVerificationStateForPr,
} from "../../../apps/control-plane-worker/src/session/verification-state";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

describe("verification state label reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureRepoLabel.mockResolvedValue({ ok: true, created: false });
    mockListLabels.mockResolvedValue([]);
    mockSetLabels.mockResolvedValue(undefined);
    mockCreateInstallationToken.mockResolvedValue("ghs_token");
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValue(0);
    mockGetSessionState.mockResolvedValue(null);
    mockListSessionIdsByWebhookRef.mockResolvedValue([]);
    mockSetSessionVerificationState.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { ok: true, updated: true },
    });
    mockSetSessionVerificationResult.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { ok: true, updated: true },
    });
    mockResolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    mockPostThreadReply.mockResolvedValue({ ok: true, ts: "1712345678.000200" });
    mockUpdateSessionCallbackContext.mockResolvedValue({ ok: true, status: 200, payload: { ok: true } });
    mockClaimSlackPostForDelivery.mockResolvedValue(true);
    mockMarkSlackPostDelivered.mockResolvedValue(undefined);
    mockMarkSlackPostPendingRetry.mockResolvedValue("pending");
    mockDeleteSlackPostMarker.mockResolvedValue(undefined);
    mockWakeSessionSlackRetry.mockResolvedValue({ ok: true, status: 200, payload: { ok: true } });
  });

  it("keeps exhausted terminal when shared sync receives a later non-exhausted state", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      verificationState: "verification-exhausted",
      verificationAttemptCount: 3,
      verificationMaxAttempts: 3,
    });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-pending",
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockSetSessionVerificationState).toHaveBeenCalledWith(
      expect.anything(),
      "impl-session",
      {
        state: "verification-exhausted",
        attemptCount: 3,
        maxAttempts: 3,
      },
      null,
    );
    // ARC-1330 D-59b: the legacy verification-* label reconcile inside `syncVerificationStateForPr` is
    // deleted (labelsOf is the sole writer at live), so this path no longer touches PR labels directly.
    expect(mockEnsureRepoLabel).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it("ARC-1330 D-59b: `syncVerificationStateForPr` no longer writes verification-* labels (labelsOf is sole writer)", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      verificationState: "verification-in-progress",
    });

    await syncVerificationStateForPr({ DB: {}, FSM_MODE: "live" } as never, {
      prUrl,
      state: "verification-in-progress",
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    // The session-state fan-out still runs (the FSM does not own that store here); only the LEGACY label
    // reconcile stands down — the canonical `labelsOf` writer owns labels at live (DO + sweep drive it).
    expect(mockSetSessionVerificationState).toHaveBeenCalled();
    expect(mockListLabels).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it("writes verification result to linked implementation sessions", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
    });

    await syncVerificationResultForPr({ DB: {} } as never, {
      prUrl,
      result: "merge-ready",
      needsWorkLabel: null,
      logger,
    });

    expect(mockSetSessionVerificationResult).toHaveBeenCalledWith(
      expect.anything(),
      "impl-session",
      { result: "merge-ready", needsWorkLabel: null },
      null,
    );
  });

  it("skips linked sessions whose DO read fails but keeps the rest", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-broken", "impl-good"]);
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => {
      if (sessionId === "impl-broken") throw new Error("DO lookup failed");
      return {
        sessionId,
        status: "active",
        agentRole: "implementation",
        reviewListeningActive: true,
        reviewListeningPrUrl: prUrl,
      };
    });

    await syncVerificationResultForPr({ DB: {} } as never, {
      prUrl,
      result: "merge-ready",
      needsWorkLabel: null,
      logger,
    });

    expect(mockSetSessionVerificationResult).toHaveBeenCalledTimes(1);
    expect(mockSetSessionVerificationResult).toHaveBeenCalledWith(
      expect.anything(),
      "impl-good",
      { result: "merge-ready", needsWorkLabel: null },
      null,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "impl-broken" }),
      expect.stringContaining("Verification state linked-session fetch failed"),
    );
  });

  it("still detects an exhausted session when an earlier DO read fails", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => {
      if (sessionId === "s-broken") throw new Error("DO lookup failed");
      return {
        sessionId,
        status: "active",
        agentRole: "verification",
        verificationState: "verification-exhausted",
        verificationAttemptCount: 3,
        verificationMaxAttempts: 3,
      };
    });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-pending",
      sessionIds: ["s-broken", "s-exhausted"],
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
      updateLinkedImplementationSessions: false,
    });

    expect(mockSetSessionVerificationState).toHaveBeenCalledWith(
      expect.anything(),
      "s-exhausted",
      { state: "verification-exhausted", attemptCount: 3, maxAttempts: 3 },
      null,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-broken" }),
      expect.stringContaining("Verification state terminal lookup failed"),
    );
  });

  it("continues writing state to other sessions when one DO write fails", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockSetSessionVerificationState.mockImplementation(async (_env: unknown, sessionId: string) => {
      if (sessionId === "s-write-fail") throw new Error("DO write failed");
      return { ok: true, status: 200, payload: { ok: true, updated: true } };
    });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-in-progress",
      sessionIds: ["s-write-fail", "s-write-ok"],
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
      updateLinkedImplementationSessions: false,
    });

    expect(mockSetSessionVerificationState).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-write-fail" }),
      expect.stringContaining("Verification state session update failed"),
    );
  });

  it.each([
    ["verification-exhausted", "QA testing exhausted after 3/3 attempts."],
    ["verification-stopped", "QA testing stopped before it could produce a verdict."],
  ] as const)("posts %s to the parent Slack thread once", async (state, expectedHeadline) => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      ownerUserId: "1",
      businessId: "biz-1",
      status: "active",
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: null,
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });

    await syncVerificationStateForPr({ DB: {}, FRONTEND_URL: "https://app.trycycloid.com" } as never, {
      prUrl,
      state,
      attemptCount: 3,
      maxAttempts: 3,
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "impl-session",
      promptId: `verification:${state}:head-sha-1:${prUrl}`,
      stage: "verification_blocked",
      channel: "C123",
    });
    expect(mockResolveSlackBotTokenForCallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "slack", slackTeamId: "T123" }),
      { sessionId: "impl-session", operation: "notifySlackVerificationBlocker" },
    );
    // Routed through the thread-budget path: no ask anchor yet, so a new post
    // (blocks arg is undefined for the plain-text blocker).
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-token",
      "C123",
      "1712345678.000100",
      expect.stringContaining(expectedHeadline),
      undefined,
    );
    expect(mockPostThreadReply.mock.calls.at(-1)?.[3]).toContain(prUrl);
    expect(mockPostThreadReply.mock.calls.at(-1)?.[3]).toContain("https://app.trycycloid.com/sessions/impl-session");
    // The ask anchor is persisted so the next blocker supersedes in place.
    expect(mockUpdateSessionCallbackContext).toHaveBeenCalledWith(
      expect.anything(),
      "impl-session",
      expect.objectContaining({ askMessageTs: "1712345678.000200" }),
    );
    expect(mockMarkSlackPostDelivered).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "impl-session",
      promptId: `verification:${state}:head-sha-1:${prUrl}`,
      stage: "verification_blocked",
      messageTs: "1712345678.000200",
    });
  });

  it("does not post Slack replies for non-terminal verification states", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-skipped",
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(mockClaimSlackPostForDelivery).not.toHaveBeenCalled();
  });

  it("marks terminal verification Slack posting failures for retry", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });
    mockPostThreadReply.mockResolvedValueOnce({ ok: false, error: "ratelimited" });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-exhausted",
      attemptCount: 3,
      maxAttempts: 3,
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockMarkSlackPostPendingRetry).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "impl-session",
      promptId: `verification:verification-exhausted:head-sha-1:${prUrl}`,
      stage: "verification_blocked",
      nextAttemptAt: expect.any(Number),
      error: "verification_blocked_api_error",
    });
    expect(mockWakeSessionSlackRetry).toHaveBeenCalledWith(expect.anything(), "impl-session", null);
    expect(mockDeleteSlackPostMarker).not.toHaveBeenCalled();
    expect(mockMarkSlackPostDelivered).not.toHaveBeenCalled();
  });

  it("marks terminal verification Slack no-token skips for retry", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });
    mockResolveSlackBotTokenForCallback.mockResolvedValueOnce(null);

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-exhausted",
      attemptCount: 3,
      maxAttempts: 3,
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockMarkSlackPostPendingRetry).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "impl-session",
      promptId: `verification:verification-exhausted:head-sha-1:${prUrl}`,
      stage: "verification_blocked",
      nextAttemptAt: expect.any(Number),
      error: "no_bot_token",
    });
    expect(mockWakeSessionSlackRetry).toHaveBeenCalledWith(expect.anything(), "impl-session", null);
    expect(mockDeleteSlackPostMarker).not.toHaveBeenCalled();
    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(mockMarkSlackPostDelivered).not.toHaveBeenCalled();
  });

  it("marks accepted Slack replies without a message timestamp for retry", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });
    mockPostThreadReply.mockResolvedValueOnce({ ok: true });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-exhausted",
      attemptCount: 3,
      maxAttempts: 3,
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockMarkSlackPostPendingRetry).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "impl-session",
      promptId: `verification:verification-exhausted:head-sha-1:${prUrl}`,
      stage: "verification_blocked",
      nextAttemptAt: expect.any(Number),
      error: "verification_blocked_missing_ts",
    });
    expect(mockWakeSessionSlackRetry).toHaveBeenCalledWith(expect.anything(), "impl-session", null);
    expect(mockDeleteSlackPostMarker).not.toHaveBeenCalled();
    expect(mockMarkSlackPostDelivered).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ state: "verification-exhausted" }),
      expect.stringContaining("missing message timestamp"),
    );
  });

  it("reports exhausted terminal verification Slack retries without waking the DO again", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });
    mockPostThreadReply.mockResolvedValueOnce({ ok: false, error: "ratelimited" });
    mockMarkSlackPostPendingRetry.mockResolvedValueOnce("exhausted");

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: "verification-exhausted",
      attemptCount: 3,
      maxAttempts: 3,
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "integration.failure",
        operation: "notifySlackVerificationBlocker",
        stage: "verification_blocked",
        reason: "exhausted",
      }),
    );
    expect(mockWakeSessionSlackRetry).not.toHaveBeenCalled();
  });

  it("keeps terminal state sync successful when the Slack marker claim fails", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "head-sha-1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1712345678.000100",
        slackTeamId: "T123",
      },
    });
    mockClaimSlackPostForDelivery.mockRejectedValueOnce(new Error("D1 unavailable"));

    await expect(
      syncVerificationStateForPr({ DB: {} } as never, {
        prUrl,
        state: "verification-exhausted",
        attemptCount: 3,
        maxAttempts: 3,
        installationId: 2222,
        repoOwner: "acme",
        repoName: "repo",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(mockSetSessionVerificationState).toHaveBeenCalledWith(
      expect.anything(),
      "impl-session",
      expect.objectContaining({ state: "verification-exhausted" }),
      null,
    );
    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Error: D1 unavailable" }),
      expect.stringContaining("Slack verification blocker notification error"),
    );
  });

  it("clearVerificationVerdictForHeadChange resets BOTH the result and state to null for the session", async () => {
    // The shared head-change clear (called by the sweep and the synchronize webhook) must null the
    // result AND the state — a `verification-skipped` carries a null result yet reads as a terminal
    // approval, so the bare state must be cleared too (head-freshness, ARC-1227 / ARC-1231).
    const prUrl = "https://github.com/acme/repo/pull/42";

    await clearVerificationVerdictForHeadChange({ DB: {} } as never, { prUrl, sessionId: "sess-1", logger });

    expect(mockSetSessionVerificationResult).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      { result: null, needsWorkLabel: null, qaRun: null },
      null,
    );
    expect(mockSetSessionVerificationState).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      expect.objectContaining({ state: null }),
      null,
    );
  });

  it("skips exhausted re-promotion when allowExhaustedClear is set, so a head change clears it (ARC-1243)", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    mockListSessionIdsByWebhookRef.mockResolvedValue(["impl-session"]);
    mockListLabels.mockResolvedValue(["verification-exhausted", "bug"]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      status: "active",
      agentRole: "implementation",
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      verificationState: "verification-exhausted",
      verificationAttemptCount: 3,
      verificationMaxAttempts: 3,
    });

    await syncVerificationStateForPr({ DB: {} } as never, {
      prUrl,
      state: null,
      allowExhaustedClear: true,
      installationId: 2222,
      repoOwner: "acme",
      repoName: "repo",
      logger,
    });

    // Without the flag this would re-promote to verification-exhausted; with it, the null clear lands.
    expect(mockSetSessionVerificationState).toHaveBeenCalledWith(
      expect.anything(),
      "impl-session",
      expect.objectContaining({ state: null, allowExhaustedClear: true }),
      null,
    );
    // ARC-1330 D-59b: the legacy label reconcile is deleted; the null clear no longer strips labels here.
    // labelsOf (driven by the DO transition + sweep) tears down the verification-* label at live.
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it("clearVerificationVerdictForHeadChange bypasses the exhausted lock without resetting the PR run cap", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";

    await clearVerificationVerdictForHeadChange({ DB: {} } as never, { prUrl, sessionId: "sess-1", logger });

    expect(mockSetSessionVerificationState).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      expect.objectContaining({ state: null, allowExhaustedClear: true }),
      null,
    );
    expect(mockSetSessionVerificationState.mock.calls[0]?.[2]).not.toHaveProperty("runBaseline");
  });

  it("clearVerificationVerdictForHeadChange does not emit when both clears resolve", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";

    await clearVerificationVerdictForHeadChange({ DB: {} } as never, { prUrl, sessionId: "sess-1", logger });

    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });
});
