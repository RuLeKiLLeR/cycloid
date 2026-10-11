import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env, SessionState } from "../../apps/control-plane-worker/src/types";

// ARC-1330 D-59a: `emitReviewLoopCiSignalFromWebhook` is the surviving CI-webhook → spine ci.signal
// producer. It replaces the deleted `reconcileReviewLoopDoneFromCiSignal`: same cohort/head guards and the
// once-per-head CI poll, but instead of driving the deleted `reconcileReviewLoopDoneState` done-state
// DECISION it emits the reduced rollup via `shadowEmitCiSignal`. These cases are the "still-live CI-signal"
// coverage moved off the deleted `review-loop-done-reconcile.test.ts`.

const mockListSessionIdsByWebhookRef = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetCommitCheckRuns = vi.fn();
const mockGetCommitStatusContexts = vi.fn();
const mockReduceCiState = vi.fn();
const mockShadowEmitCiSignal = vi.fn();
const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);

// emitVerificationScheduleFailedEvent forwards to postStructuredEventToDd; mock the exporter and assert
// the underlying event so the real classify/field-mapping in review-loop-events stays exercised.
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  listSessionIdsByWebhookRef: (...args: unknown[]) => mockListSessionIdsByWebhookRef(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getCommitCheckRuns: (...args: unknown[]) => mockGetCommitCheckRuns(...args),
  getCommitStatusContexts: (...args: unknown[]) => mockGetCommitStatusContexts(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-rollup", () => ({
  reduceCiState: (...args: unknown[]) => mockReduceCiState(...args),
}));

// The spine emission is covered by the ci-producer suite; here we spy it to assert the producer forwards
// the reduced rollup for each eligible session.
vi.mock("../../apps/control-plane-worker/src/session/fsm/ci-producer", () => ({
  shadowEmitCiSignal: (...args: unknown[]) => mockShadowEmitCiSignal(...args),
}));

import { emitReviewLoopCiSignalFromWebhook } from "../../apps/control-plane-worker/src/services/review-loop-ci-signal";

const PR_URL = "https://github.com/acme/repo/pull/42";
const HEAD_SHA = "head-sha-abc";
const REPO_OWNER = "acme";
const REPO_NAME = "repo";
const TOKEN = "ghs_token";

const env = { DB: {} } as unknown as Env;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof emitReviewLoopCiSignalFromWebhook
>[1]["logger"];

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "s-1",
    ownerUserId: "1001",
    status: "active",
    agentRole: "implementation",
    reviewListeningActive: true,
    reviewListeningPrUrl: PR_URL,
    reviewListeningHeadSha: HEAD_SHA,
    verificationState: "verification-pending",
    reviewLoopDoneState: "working",
    ...overrides,
  } as unknown as SessionState;
}

function callOptions() {
  return {
    prUrl: PR_URL,
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME,
    headSha: HEAD_SHA,
    token: TOKEN,
    logger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListSessionIdsByWebhookRef.mockResolvedValue(["s-1"]);
  mockGetSessionState.mockResolvedValue(makeSession());
  mockGetCommitCheckRuns.mockResolvedValue([]);
  mockGetCommitStatusContexts.mockResolvedValue([]);
  mockReduceCiState.mockReturnValue("green");
  mockShadowEmitCiSignal.mockResolvedValue(undefined);
});

describe("emitReviewLoopCiSignalFromWebhook", () => {
  it("green CI + head match polls once and emits ci.signal(green) onto the spine", async () => {
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());

    expect(mockGetCommitCheckRuns).toHaveBeenCalledWith(TOKEN, REPO_OWNER, REPO_NAME, HEAD_SHA);
    expect(mockGetCommitStatusContexts).toHaveBeenCalledWith(TOKEN, REPO_OWNER, REPO_NAME, HEAD_SHA);
    expect(mockShadowEmitCiSignal).toHaveBeenCalledTimes(1);
    expect(mockShadowEmitCiSignal).toHaveBeenCalledWith(env, "s-1", "green", logger, undefined);
  });

  it("emits ci.signal(failing) — the spine ciFix guard reads a settled red", async () => {
    mockReduceCiState.mockReturnValue("failing");
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockShadowEmitCiSignal).toHaveBeenCalledWith(env, "s-1", "failing", logger, undefined);
  });

  it("emits ci.signal(absent) after a genuine no-CI poll (the producer, not the reconcile, decides)", async () => {
    mockReduceCiState.mockReturnValue("absent");
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).toHaveBeenCalledWith(env, "s-1", "absent", logger, undefined);
  });

  it("still forwards pending to the producer (which drops it — pending is a live-read guard, not an event)", async () => {
    mockReduceCiState.mockReturnValue("pending");
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).toHaveBeenCalledWith(env, "s-1", "pending", logger, undefined);
  });

  it("threads the caller's waitUntil into the spine emission", async () => {
    const waitUntil = vi.fn();
    await emitReviewLoopCiSignalFromWebhook(env, { ...callOptions(), waitUntil });
    expect(mockShadowEmitCiSignal).toHaveBeenCalledWith(env, "s-1", "green", logger, waitUntil);
  });

  it("polls CI once and reuses it across multiple sessions on the same PR head", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-1", "s-2"]);
    mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) =>
      Promise.resolve(makeSession({ sessionId })),
    );
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).toHaveBeenCalledTimes(1);
    expect(mockGetCommitStatusContexts).toHaveBeenCalledTimes(1);
    expect(mockShadowEmitCiSignal).toHaveBeenCalledTimes(2);
  });

  it("no-ops without a CI poll when the signal head differs from the tracked head", async () => {
    mockGetSessionState.mockResolvedValue(makeSession({ reviewListeningHeadSha: "other-head" }));
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
    expect(mockGetCommitStatusContexts).not.toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  it("no-ops without a CI poll while a verification run is already in progress", async () => {
    mockGetSessionState.mockResolvedValue(makeSession({ verificationState: "verification-in-progress" }));
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  it("still emits when QA is already done because CI is the merge-ready unblock signal", async () => {
    mockGetSessionState.mockResolvedValue(
      makeSession({ verificationState: "verification-done", verificationResult: "merge-ready" }),
    );
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).toHaveBeenCalledWith(env, "s-1", "green", logger, undefined);
  });

  it("skips a verification-role session for the PR", async () => {
    mockGetSessionState.mockResolvedValue(makeSession({ agentRole: "verification" }));
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  it("skips a session that is not actively review-listening", async () => {
    mockGetSessionState.mockResolvedValue(makeSession({ reviewListeningActive: false }));
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  it("skips an archived session", async () => {
    mockGetSessionState.mockResolvedValue(makeSession({ status: "archived" }));
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  it("no-ops when no session is linked to the PR", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue([]);
    await emitReviewLoopCiSignalFromWebhook(env, callOptions());
    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  // PR3 Part D: per-session DO reads fan out with bounded concurrency. A read that throws for one session
  // must be isolated (logged + skipped) so the other sessions still emit, and the CI poll stays once.
  it("isolates a per-session read failure and still emits for the other sessions", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-1", "s-2", "s-3"]);
    mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) => {
      if (sessionId === "s-2") return Promise.reject(new Error("DO read failed (503)"));
      return Promise.resolve(makeSession({ sessionId }));
    });

    await emitReviewLoopCiSignalFromWebhook(env, callOptions());

    // s-1 and s-3 emitted despite s-2's read throwing; s-2 contributed no emission.
    expect(mockShadowEmitCiSignal).toHaveBeenCalledTimes(2);
    const emittedSessionIds = mockShadowEmitCiSignal.mock.calls.map((call) => call[1]).sort();
    expect(emittedSessionIds).toEqual(["s-1", "s-3"]);
    // CI was still polled only once and reused across the surviving sessions.
    expect(mockGetCommitCheckRuns).toHaveBeenCalledTimes(1);
    // The failed read was surfaced, not swallowed.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-2", error: expect.stringContaining("DO read failed") }),
      expect.stringContaining("session read failed"),
    );
  });

  it("does not abort when a per-session read fails but no surviving session is eligible", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-1", "s-2"]);
    mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) => {
      if (sessionId === "s-1") return Promise.reject(new Error("DO read failed (503)"));
      // Surviving session already has an active verifier, so it is skipped before any GitHub poll.
      return Promise.resolve(makeSession({ sessionId, verificationState: "verification-in-progress" }));
    });

    await expect(emitReviewLoopCiSignalFromWebhook(env, callOptions())).resolves.toBeUndefined();
    expect(mockGetCommitCheckRuns).not.toHaveBeenCalled();
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  // V1: a transient CI poll failure used to die with no Datadog event (call sites only wrap in
  // Sentry/pino), silently deferring settlement to the ~5min sweep. The poll throw must emit
  // qa_tester.schedule.failed with reason infra_error, and still re-throw (best-effort contract).
  it("emits qa_tester.schedule.failed (infra_error) when the CI poll throws, and re-throws", async () => {
    mockGetCommitCheckRuns.mockRejectedValue(new Error("GitHub API 503 timeout"));

    await expect(emitReviewLoopCiSignalFromWebhook(env, callOptions())).rejects.toThrow("GitHub API 503 timeout");

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "qa_tester.schedule.failed",
        reason_code: "infra_error",
        session_id: "s-1",
        pr_url: PR_URL,
        head_sha: HEAD_SHA,
        error: expect.stringContaining("GitHub API 503 timeout"),
      }),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledTimes(1);
    // The throw preserves best-effort control flow: no spine emission ran.
    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });

  it("propagates the original CI-poll error even if the telemetry emit itself throws", async () => {
    mockGetCommitCheckRuns.mockRejectedValue(new Error("GitHub API 503 timeout"));
    // postStructuredEventToDd is documented never-throw, but guard the contract: an unexpected emit
    // throw must never replace the original error callers expect to see.
    mockPostStructuredEventToDd.mockRejectedValueOnce(new Error("DD emit boom"));

    await expect(emitReviewLoopCiSignalFromWebhook(env, callOptions())).rejects.toThrow("GitHub API 503 timeout");

    expect(mockShadowEmitCiSignal).not.toHaveBeenCalled();
  });
});
