/**
 * Integration test for the Slack completion notification wiring in the
 * session Durable Object.
 *
 * Regression: once a session had a PR, the session-level `prUrl` back-fill in
 * `notifySlackThread` routed every follow-up reply through the compact
 * first-paragraph renderer, so a long analytical answer rendered in Slack as
 * a single sentence. The reply path must post the full multi-paragraph reply
 * regardless of session PR state; block-level unit tests alone cannot prove
 * the wiring because the back-fill happens in the DO, not in the renderer.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InitiationMode } from "../../../apps/control-plane-worker/src/enums/initiation-mode.ts";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import * as slackPostsDb from "../../../apps/control-plane-worker/src/session/slack-posts-db.ts";
import { createFakeState, createTestEnv, mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

const mockPostThreadReply = vi.hoisted(() => vi.fn(async () => ({ ok: true, ts: "200.100" })));
const mockDeliverThreadStatus = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, updatedInPlace: true, fallbackTs: undefined })),
);
const mockRemoveReaction = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../../apps/control-plane-worker/src/slack/notify.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/notify.ts")>();
  return {
    ...actual,
    postThreadReply: mockPostThreadReply,
    deliverThreadStatus: mockDeliverThreadStatus,
    removeReaction: mockRemoveReaction,
  };
});

const mockResolveToken = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "xoxb-test-token"));
vi.mock("../../../apps/control-plane-worker/src/slack/tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/tokens.ts")>();
  return {
    ...actual,
    resolveSlackBotTokenForCallback: mockResolveToken,
  };
});

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter.ts", () => ({
  postStructuredEventToDd: mockPostStructuredEventToDd,
}));

const mockRecordDelivery = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../apps/control-plane-worker/src/automation/db.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/automation/db.ts")>();
  return { ...actual, recordScheduledRuleDelivery: mockRecordDelivery };
});

const mockEmitDeliveryMetric = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../apps/control-plane-worker/src/observability/automation-metrics.ts", () => ({
  emitAutomationSlackDeliveryMetric: mockEmitDeliveryMetric,
}));

vi.mock("../../../apps/control-plane-worker/src/session/slack-posts-db.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../apps/control-plane-worker/src/session/slack-posts-db.ts")>();
  return {
    ...actual,
    insertSlackPostIfAbsent: vi.fn(async () => true),
    claimSlackPostForDelivery: vi.fn(async () => true),
    hasDeliveredSlackPost: vi.fn(async () => false),
    markSlackPostDelivered: vi.fn(async () => undefined),
    deleteSlackPostMarker: vi.fn(async () => undefined),
    markSlackPostPendingRetry: vi.fn(async () => undefined),
  };
});

mockCloudflareWorkers();
mockSentryCloudflare();

type NotifySlackThread = {
  notifySlackThread(sessionId: string, promptId: string, success: boolean): Promise<void>;
};

describe("notifySlackThread full-reply wiring", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv>;
  let agent: InstanceType<typeof SessionDO>;

  const sessionId = "s-1";
  const promptId = "prompt-1";
  const summary = "First paragraph of the answer.\n\nSecond paragraph with detail.\n\nThird paragraph wrapping up.";

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  function sql(): SqlStorage {
    return state.storage.sql as unknown as SqlStorage;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    state = createFakeState();
    env = createTestEnv();
    agent = new SessionDO(state as never, env as never);
    doDb.createSession(sql(), { sessionId, ownerUserId: "1" });
    doDb.updateSessionFields(sql(), sessionId, {
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
        statusMessageTs: "100.001",
      },
    });
  });

  it("posts the full multi-paragraph reply even when the session has a PR", async () => {
    doDb.updateSessionFields(sql(), sessionId, {
      prUrl: "https://github.com/acme/widgets/pull/7",
      prNumber: 7,
    });
    await state.storage.put(`slack_summary:${promptId}`, { text: summary });

    await (agent as unknown as NotifySlackThread).notifySlackThread(sessionId, promptId, true);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    const [token, channel, threadTs, fallback, blocks] = mockPostThreadReply.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
      Array<{ type: string; text?: { text: string } }>,
    ];
    expect(token).toBe("xoxb-test-token");
    expect(channel).toBe("C123");
    expect(threadTs).toBe("100.000");

    const sectionTexts = blocks.filter((block) => block.type === "section").map((block) => block.text!.text);
    expect(sectionTexts).toEqual([
      "First paragraph of the answer.",
      "Second paragraph with detail.",
      "Third paragraph wrapping up.",
    ]);
    expect(fallback).toBe(summary);
    expect(doDb.getSessionExtended(sql(), sessionId)?.callbackContext).toMatchObject({
      resultMessageTs: "200.100",
      resultPromptId: promptId,
    });
  });

  it("posts the same full reply for a session with no PR", async () => {
    await state.storage.put(`slack_summary:${promptId}`, { text: summary });

    await (agent as unknown as NotifySlackThread).notifySlackThread(sessionId, promptId, true);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    const blocks = (mockPostThreadReply.mock.calls[0] as unknown as unknown[])[4] as Array<{
      type: string;
      text?: { text: string };
    }>;
    const sectionTexts = blocks.filter((block) => block.type === "section").map((block) => block.text!.text);
    expect(sectionTexts).toEqual([
      "First paragraph of the answer.",
      "Second paragraph with detail.",
      "Third paragraph wrapping up.",
    ]);
  });

  it("keeps Slack alert automation completions in the status card instead of posting a second reply", async () => {
    const automationSessionId = "s-automation";
    doDb.createSession(sql(), {
      sessionId: automationSessionId,
      ownerUserId: "1",
      initiationMode: InitiationMode.AUTOMATION,
    });
    doDb.updateSessionFields(sql(), automationSessionId, {
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
        statusMessageTs: "100.001",
      },
    });
    await state.storage.put(`slack_summary:${promptId}`, { text: summary });

    await (agent as unknown as NotifySlackThread).notifySlackThread(automationSessionId, promptId, true);

    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(mockDeliverThreadStatus).toHaveBeenCalledTimes(1);
    const statusPayload = mockDeliverThreadStatus.mock.calls[0]?.[0] as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(statusPayload.text).toContain("First paragraph of the answer.");
    const statusSections = statusPayload.blocks
      .filter((block) => block.type === "section")
      .map((block) => block.text?.text);
    expect(statusSections).toEqual(expect.arrayContaining(["First paragraph of the answer."]));
  });

  it("reports the failure and schedules a retry when status delivery fails for an automation session", async () => {
    const automationSessionId = "s-automation-fail";
    doDb.createSession(sql(), {
      sessionId: automationSessionId,
      ownerUserId: "1",
      initiationMode: InitiationMode.AUTOMATION,
    });
    doDb.updateSessionFields(sql(), automationSessionId, {
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
        statusMessageTs: "100.001",
      },
    });
    await state.storage.put(`slack_summary:${promptId}`, { text: summary });

    // Automation sessions never post a prompt reply, so a failed status
    // delivery is the only delivery attempt and must schedule a retry.
    mockDeliverThreadStatus.mockResolvedValueOnce({
      ok: false,
      updatedInPlace: false,
      fallbackTs: undefined,
      error: "channel_not_found",
    });

    await (agent as unknown as NotifySlackThread).notifySlackThread(automationSessionId, promptId, true);

    // No second reply for automation sessions, on the failure path either.
    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(mockDeliverThreadStatus).toHaveBeenCalledTimes(1);

    // Failure is reported to Datadog as a swallowed integration failure.
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "integration.failure",
        surface: "slack",
        operation: "notifySlackThread.status",
        session_id: automationSessionId,
        error_class: "SlackApiError",
        slack_error_code: "channel_not_found",
        stage: "completed",
      }),
    );

    // A retry is scheduled with the status_delivery_failed reason...
    expect(slackPostsDb.markSlackPostPendingRetry).toHaveBeenCalledTimes(1);
    expect(slackPostsDb.markSlackPostPendingRetry).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        sessionId: automationSessionId,
        promptId,
        stage: "completed",
        error: "status_delivery_failed",
        nextAttemptAt: expect.any(Number),
      }),
    );

    // ...and the post is not marked delivered when a retry is pending.
    expect(slackPostsDb.markSlackPostDelivered).not.toHaveBeenCalled();
  });

  describe("scheduled-rule delivery recording (ARC-1195)", () => {
    const ruleSessionId = "s-scheduled";
    function seedScheduledAutomationSession(): void {
      doDb.createSession(sql(), {
        sessionId: ruleSessionId,
        ownerUserId: "1",
        initiationMode: InitiationMode.AUTOMATION,
        scheduledRuleId: "rule-1",
      });
      doDb.updateSessionFields(sql(), ruleSessionId, {
        // Scheduled automations deliver a plain top-level digest: no starting
        // message, so no threadTs/statusMessageTs anchor on the context.
        callbackContext: {
          source: "slack",
          channel: "C123",
          slackTeamId: "T1",
        },
      });
    }

    it("delivers the digest plain + top-level, records delivered, and emits the metric on success", async () => {
      seedScheduledAutomationSession();
      await state.storage.put(`slack_summary:${promptId}`, { text: summary });
      // A top-level post returns a new message ts (deliverThreadStatus -> postThreadReply).
      mockDeliverThreadStatus.mockResolvedValueOnce({ ok: true, updatedInPlace: false, fallbackTs: "200.000" });

      await (agent as unknown as NotifySlackThread).notifySlackThread(ruleSessionId, promptId, true);

      // No thread anchor and no status-card edit target: it posts to the channel.
      const payload = mockDeliverThreadStatus.mock.calls[0]?.[0] as { threadTs?: string; statusMessageTs?: string };
      expect(payload.threadTs).toBeUndefined();
      expect(payload.statusMessageTs).toBeUndefined();
      expect(mockRecordDelivery).toHaveBeenCalledWith(expect.anything(), "rule-1", expect.any(Number), {
        deliveredAt: expect.any(Number),
        error: null,
      });
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "delivered");
    });

    it("records an empty outcome (still delivered via placeholder) when the session produced no text", async () => {
      seedScheduledAutomationSession();
      await state.storage.put(`slack_summary:${promptId}`, { text: "" });
      mockDeliverThreadStatus.mockResolvedValueOnce({ ok: true, updatedInPlace: false, fallbackTs: "200.000" });

      await (agent as unknown as NotifySlackThread).notifySlackThread(ruleSessionId, promptId, true);

      expect(mockRecordDelivery).toHaveBeenCalledWith(expect.anything(), "rule-1", expect.any(Number), {
        deliveredAt: expect.any(Number),
        error: null,
      });
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "empty");
    });

    it("records post_failed with the Slack error when delivery fails", async () => {
      seedScheduledAutomationSession();
      await state.storage.put(`slack_summary:${promptId}`, { text: summary });
      mockDeliverThreadStatus.mockResolvedValueOnce({
        ok: false,
        updatedInPlace: false,
        fallbackTs: undefined,
        error: "channel_not_found",
      });

      await (agent as unknown as NotifySlackThread).notifySlackThread(ruleSessionId, promptId, true);

      expect(mockRecordDelivery).toHaveBeenCalledWith(expect.anything(), "rule-1", expect.any(Number), {
        deliveredAt: null,
        error: "channel_not_found",
      });
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "post_failed");
    });

    it("does not record delivery for an automation session without a scheduled rule", async () => {
      const noRuleSession = "s-no-rule";
      doDb.createSession(sql(), {
        sessionId: noRuleSession,
        ownerUserId: "1",
        initiationMode: InitiationMode.AUTOMATION,
      });
      doDb.updateSessionFields(sql(), noRuleSession, {
        callbackContext: {
          source: "slack",
          channel: "C123",
          threadTs: "100.000",
          slackTeamId: "T1",
          statusMessageTs: "100.001",
        },
      });
      await state.storage.put(`slack_summary:${promptId}`, { text: summary });

      await (agent as unknown as NotifySlackThread).notifySlackThread(noRuleSession, promptId, true);

      expect(mockRecordDelivery).not.toHaveBeenCalled();
      expect(mockEmitDeliveryMetric).not.toHaveBeenCalled();
    });

    it("records workspace_not_connected when the bot token is gone at completion (early exit)", async () => {
      seedScheduledAutomationSession();
      await state.storage.put(`slack_summary:${promptId}`, { text: summary });
      // Workspace disconnected after the scheduler posted the starting message.
      mockResolveToken.mockResolvedValueOnce(null);

      await (agent as unknown as NotifySlackThread).notifySlackThread(ruleSessionId, promptId, true);

      expect(mockRecordDelivery).toHaveBeenCalledWith(expect.anything(), "rule-1", expect.any(Number), {
        deliveredAt: null,
        error: "workspace_not_connected",
      });
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "workspace_not_connected");
    });

    it("records post_failed when the Slack delivery throws (outer catch)", async () => {
      seedScheduledAutomationSession();
      await state.storage.put(`slack_summary:${promptId}`, { text: summary });
      mockDeliverThreadStatus.mockRejectedValueOnce(new Error("socket hang up"));

      await (agent as unknown as NotifySlackThread).notifySlackThread(ruleSessionId, promptId, true);

      expect(mockRecordDelivery).toHaveBeenCalledWith(expect.anything(), "rule-1", expect.any(Number), {
        deliveredAt: null,
        error: "socket hang up",
      });
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "post_failed");
    });
  });

  it("renders done status PR action and label from the session row when the stored summary is stale", async () => {
    doDb.updateSessionFields(sql(), sessionId, {
      repoOwner: "acme",
      repoName: "widgets",
      prUrl: "https://github.com/acme/widgets/pull/7",
      prNumber: 7,
    });
    await state.storage.put(`slack_summary:${promptId}`, {
      text: summary,
      branchName: "fix-widget",
    });

    await (agent as unknown as NotifySlackThread).notifySlackThread(sessionId, promptId, true);

    expect(mockDeliverThreadStatus).toHaveBeenCalledTimes(1);
    const statusPayload = mockDeliverThreadStatus.mock.calls[0]?.[0] as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ action_id: string; url: string }> }>;
    };
    expect(statusPayload.text).toContain("PR: #7 https://github.com/acme/widgets/pull/7");

    const headline = statusPayload.blocks[0]?.text?.text;
    expect(headline).toContain("PR #7");
    const actions = statusPayload.blocks.find((block) => block.type === "actions")?.elements ?? [];
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_id: "view_pr",
          url: "https://github.com/acme/widgets/pull/7",
        }),
        expect.objectContaining({ action_id: "view_session" }),
      ]),
    );
  });

  it("reports successful status fallback posts after an in-place update fails", async () => {
    mockDeliverThreadStatus.mockResolvedValueOnce({
      ok: true,
      updatedInPlace: false,
      fallbackTs: "100.002",
      error: "message_not_found",
    });
    await state.storage.put(`slack_summary:${promptId}`, { text: summary });

    await (agent as unknown as NotifySlackThread).notifySlackThread(sessionId, promptId, true);

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "integration.failure",
        surface: "slack",
        operation: "notifySlackThread.status",
        session_id: sessionId,
        error_class: "SlackApiError",
        error_message_truncated: "message_not_found",
        slack_error_code: "message_not_found",
        reason: "status_update_fallback",
        stage: "completed",
      }),
    );
  });
});
