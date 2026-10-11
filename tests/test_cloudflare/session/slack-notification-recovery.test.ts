import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { createFakeState, createTestEnv, mockCloudflareWorkers, mockSentryCloudflare, seedPrompt } from "./helpers.ts";

const mockHasDeliveredSlackPost = vi.hoisted(() => vi.fn());
const mockDeleteSlackPostMarker = vi.hoisted(() => vi.fn(async () => undefined));
const mockListDueSlackPostRetries = vi.hoisted(() => vi.fn());
const mockClaimSlackPostForDelivery = vi.hoisted(() => vi.fn(async () => true));
const mockMarkSlackPostDelivered = vi.hoisted(() => vi.fn(async () => undefined));
const mockMarkSlackPostPendingRetry = vi.hoisted(() => vi.fn(async () => "pending"));
const mockResolveSlackBotTokenForCallback = vi.hoisted(() => vi.fn(async () => "xoxb-test-token"));
const mockPostThreadReply = vi.hoisted(() => vi.fn(async () => ({ ok: true, ts: "1712345678.000200" })));
const mockDeliverThreadStatus = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, updatedInPlace: false, fallbackTs: "1712345678.000200" })),
);

vi.mock("../../../apps/control-plane-worker/src/session/slack-posts-db.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../apps/control-plane-worker/src/session/slack-posts-db.ts")>();
  return {
    ...actual,
    hasDeliveredSlackPost: (...args: unknown[]) => mockHasDeliveredSlackPost(...args),
    deleteSlackPostMarker: (...args: unknown[]) => mockDeleteSlackPostMarker(...args),
    listDueSlackPostRetries: (...args: unknown[]) => mockListDueSlackPostRetries(...args),
    claimSlackPostForDelivery: (...args: unknown[]) => mockClaimSlackPostForDelivery(...args),
    markSlackPostDelivered: (...args: unknown[]) => mockMarkSlackPostDelivered(...args),
    markSlackPostPendingRetry: (...args: unknown[]) => mockMarkSlackPostPendingRetry(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/tokens.ts")>();
  return {
    ...actual,
    resolveSlackBotTokenForCallback: (...args: unknown[]) => mockResolveSlackBotTokenForCallback(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/notify.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/notify.ts")>();
  return {
    ...actual,
    deliverThreadStatus: (...args: unknown[]) => mockDeliverThreadStatus(...args),
    postThreadReply: (...args: unknown[]) => mockPostThreadReply(...args),
  };
});

mockCloudflareWorkers();
mockSentryCloudflare();

type RecoverMissingSlackNotifications = {
  recoverMissingSlackNotifications(sessionId: string): Promise<void>;
  rescheduleSessionAlarm(): Promise<void>;
};

describe("recoverMissingSlackNotifications", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv>;
  let agent: InstanceType<typeof SessionDO>;

  const sessionId = "session-1";

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockListDueSlackPostRetries.mockReset();
    mockHasDeliveredSlackPost.mockReset();
    mockClaimSlackPostForDelivery.mockReset().mockResolvedValue(true);
    mockMarkSlackPostDelivered.mockReset().mockResolvedValue(undefined);
    mockMarkSlackPostPendingRetry.mockReset().mockResolvedValue("pending");
    mockResolveSlackBotTokenForCallback.mockReset().mockResolvedValue("xoxb-test-token");
    mockPostThreadReply.mockReset().mockResolvedValue({ ok: true, ts: "1712345678.000200" });
    mockDeliverThreadStatus
      .mockReset()
      .mockResolvedValue({ ok: true, updatedInPlace: false, fallbackTs: "1712345678.000200" });
    state = createFakeState();
    env = createTestEnv();
    agent = new SessionDO(state as never, env as never);

    doDb.createSession(state.storage.sql, {
      sessionId,
      ownerUserId: "1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
      },
    });
  });

  // Use a fixed timestamp so all prompts share the same completedAt. The stale-failed
  // check only clears a failed row when a later completion (strictly greater timestamp)
  // exists; equal timestamps keep this test deterministic instead of depending on whether
  // Date.now() ticks between seed calls.
  const TERMINAL_PROMPT_COMPLETED_AT = 1_000;

  function seedTerminalPrompt(promptId: string, status: "completed" | "failed"): void {
    seedPrompt(state.storage, {
      sessionId,
      promptId,
      promptText: `Prompt ${promptId}`,
      status,
      completedAt: TERMINAL_PROMPT_COMPLETED_AT,
      updatedAt: TERMINAL_PROMPT_COMPLETED_AT,
    });
  }

  it("retries due Slack post rows without touching other prompt retry intent", async () => {
    seedTerminalPrompt("prompt-delivered", "completed");
    seedTerminalPrompt("prompt-pending", "failed");
    seedTerminalPrompt("prompt-raced", "completed");

    mockListDueSlackPostRetries
      .mockResolvedValueOnce([
        { sessionId, promptId: "prompt-pending", stage: "failed", attemptCount: 1 },
        { sessionId, promptId: "prompt-raced", stage: "completed", attemptCount: 1 },
      ])
      .mockResolvedValueOnce([{ sessionId, promptId: "prompt-raced", stage: "completed", attemptCount: 1 }])
      .mockResolvedValueOnce([{ sessionId, promptId: "prompt-raced", stage: "completed", attemptCount: 1 }]);
    mockHasDeliveredSlackPost.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await (agent as unknown as RecoverMissingSlackNotifications).recoverMissingSlackNotifications(sessionId);

    expect(mockListDueSlackPostRetries).toHaveBeenCalledWith(env.DB, sessionId, expect.any(Number));
    expect(mockHasDeliveredSlackPost).toHaveBeenCalledTimes(2);
    expect(mockDeleteSlackPostMarker).not.toHaveBeenCalled();
    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledTimes(2);
    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId: "prompt-pending",
      stage: "failed",
      channel: "C123",
    });
    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId: "prompt-raced",
      stage: "completed",
      channel: "C123",
    });
  });

  it("clears a stale failed retry once a later prompt has completed", async () => {
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-failed",
      promptText: "Prompt prompt-failed",
      status: "failed",
      completedAt: 1_000,
      updatedAt: 1_000,
    });
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-success",
      promptText: "Prompt prompt-success",
      status: "completed",
      completedAt: 2_000,
      updatedAt: 2_000,
    });

    mockListDueSlackPostRetries.mockResolvedValueOnce([
      { sessionId, promptId: "prompt-failed", stage: "failed", attemptCount: 1 },
    ]);
    await (agent as unknown as RecoverMissingSlackNotifications).recoverMissingSlackNotifications(sessionId);

    expect(mockClaimSlackPostForDelivery).not.toHaveBeenCalled();
    expect(mockDeleteSlackPostMarker).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId: "prompt-failed",
      stage: "failed",
    });
    expect(mockHasDeliveredSlackPost).not.toHaveBeenCalled();
  });

  it("does not clear a failed retry when the later completion belongs to a review-loop prompt", async () => {
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-failed",
      promptText: "Prompt prompt-failed",
      status: "failed",
      completedAt: 1_000,
      updatedAt: 1_000,
    });
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-review-loop",
      promptText: "Prompt prompt-review-loop",
      status: "completed",
      completedAt: 2_000,
      updatedAt: 2_000,
      reviewLoopEpochId: "epoch-1",
    });

    mockListDueSlackPostRetries.mockResolvedValueOnce([
      { sessionId, promptId: "prompt-failed", stage: "failed", attemptCount: 1 },
    ]);
    mockHasDeliveredSlackPost.mockResolvedValueOnce(false);

    await (agent as unknown as RecoverMissingSlackNotifications).recoverMissingSlackNotifications(sessionId);

    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId: "prompt-failed",
      stage: "failed",
      channel: "C123",
    });
    expect(mockDeleteSlackPostMarker).not.toHaveBeenCalled();
  });

  it("still reschedules when a stale clear and an undelivered row occur in the same pass", async () => {
    // prompt-stale-failed is superseded by prompt-success -> cleared.
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-stale-failed",
      promptText: "Prompt prompt-stale-failed",
      status: "failed",
      completedAt: 1_000,
      updatedAt: 1_000,
    });
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-success",
      promptText: "Prompt prompt-success",
      status: "completed",
      completedAt: 2_000,
      updatedAt: 2_000,
    });
    // prompt-undelivered is the newest completion, so it is not stale and must be delivered.
    seedPrompt(state.storage, {
      sessionId,
      promptId: "prompt-undelivered",
      promptText: "Prompt prompt-undelivered",
      status: "failed",
      completedAt: 3_000,
      updatedAt: 3_000,
    });

    mockListDueSlackPostRetries.mockResolvedValueOnce([
      { sessionId, promptId: "prompt-stale-failed", stage: "failed", attemptCount: 1 },
      { sessionId, promptId: "prompt-undelivered", stage: "failed", attemptCount: 1 },
    ]);
    // The genuine delivery has not landed yet.
    mockHasDeliveredSlackPost.mockResolvedValue(false);
    const rescheduleSpy = vi
      .spyOn(agent as unknown as RecoverMissingSlackNotifications, "rescheduleSessionAlarm")
      .mockResolvedValue(undefined);

    await (agent as unknown as RecoverMissingSlackNotifications).recoverMissingSlackNotifications(sessionId);

    expect(mockDeleteSlackPostMarker).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId: "prompt-stale-failed",
      stage: "failed",
    });
    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId: "prompt-undelivered",
      stage: "failed",
      channel: "C123",
    });
    // The undelivered row must not be masked by the stale clear: the alarm has to be rescheduled.
    expect(rescheduleSpy).toHaveBeenCalledTimes(1);
  });

  it("recovers due verification-blocked Slack rows from the session retry queue", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    const promptId = `verification:verification-exhausted:head-sha-1:${prUrl}`;

    mockListDueSlackPostRetries.mockResolvedValueOnce([
      { sessionId, promptId, stage: "verification_blocked", attemptCount: 1 },
    ]);
    mockHasDeliveredSlackPost.mockResolvedValueOnce(true);

    await (agent as unknown as RecoverMissingSlackNotifications).recoverMissingSlackNotifications(sessionId);

    expect(mockListDueSlackPostRetries).toHaveBeenCalledWith(env.DB, sessionId, expect.any(Number));
    expect(mockResolveSlackBotTokenForCallback).toHaveBeenCalled();
    // Routed through the thread-budget path (no ask anchor → new post, no blocks).
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test-token",
      "C123",
      "100.000",
      expect.stringContaining("Session:"),
      undefined,
    );
    expect(mockHasDeliveredSlackPost).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId,
      stage: "verification_blocked",
    });
  });

  it("advances verification-blocked retries when Slack thread routing is missing", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    const promptId = `verification:verification-exhausted:head-sha-1:${prUrl}`;
    doDb.updateSessionFields(state.storage.sql, sessionId, {
      callbackContext: {
        source: "slack",
        threadTs: "100.000",
        slackTeamId: "T1",
      },
    });

    await (agent as unknown as RecoverMissingSlackNotifications).notifySlackVerificationBlocker(sessionId, promptId);

    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId,
      stage: "verification_blocked",
      channel: null,
    });
    expect(mockMarkSlackPostPendingRetry).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId,
      stage: "verification_blocked",
      nextAttemptAt: expect.any(Number),
      error: "missing_thread_routing",
    });
    expect(mockResolveSlackBotTokenForCallback).not.toHaveBeenCalled();
    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("advances verification-blocked retries when the queued prompt id is invalid", async () => {
    const promptId = "verification:not-valid";

    await (agent as unknown as RecoverMissingSlackNotifications).notifySlackVerificationBlocker(sessionId, promptId);

    expect(mockMarkSlackPostPendingRetry).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId,
      stage: "verification_blocked",
      nextAttemptAt: expect.any(Number),
      error: "invalid_prompt_id",
    });
    expect(mockClaimSlackPostForDelivery).not.toHaveBeenCalled();
    expect(mockResolveSlackBotTokenForCallback).not.toHaveBeenCalled();
    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("explicitly retries verification-blocked rows when Slack bot token resolution fails", async () => {
    const prUrl = "https://github.com/acme/repo/pull/42";
    const promptId = `verification:verification-exhausted:head-sha-1:${prUrl}`;
    mockResolveSlackBotTokenForCallback.mockResolvedValueOnce(null);

    await (agent as unknown as RecoverMissingSlackNotifications).notifySlackVerificationBlocker(sessionId, promptId);

    expect(mockClaimSlackPostForDelivery).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId,
      stage: "verification_blocked",
      channel: "C123",
    });
    expect(mockMarkSlackPostPendingRetry).toHaveBeenCalledWith(env.DB, {
      sessionId,
      promptId,
      stage: "verification_blocked",
      nextAttemptAt: expect.any(Number),
      error: "no_bot_token",
    });
    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });
});
