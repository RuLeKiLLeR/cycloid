import { describe, expect, it } from "vitest";

import {
  evaluateSlackChannelAutomationTrigger,
  type SlackChannelAutomationEvent,
  type SlackChannelAutomationTriggerConfig,
} from "../../apps/control-plane-worker/src/automation/slack-channel-trigger";

const config: SlackChannelAutomationTriggerConfig = {
  teamId: "T_ALERTS",
  channelId: "C_DATADOG",
  botUserId: "U_CYCLOID",
  botId: "B_CYCLOID",
  allowedAppIds: ["A_DATADOG", "A_SENTRY"],
  allowedBotIds: ["B_DATADOG", "B_SENTRY"],
};

function rootEvent(overrides: Partial<SlackChannelAutomationEvent> = {}): SlackChannelAutomationEvent {
  return {
    type: "message",
    team: "T_ALERTS",
    channel: "C_DATADOG",
    ts: "1712345678.000100",
    user: "U_DATADOG",
    app_id: "A_DATADOG",
    bot_id: "B_DATADOG",
    text: "Monitor triggered",
    ...overrides,
  };
}

describe("evaluateSlackChannelAutomationTrigger", () => {
  it("triggers for an allowed alert app root message in a configured Slack channel", () => {
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ subtype: "bot_message" }), config)).toEqual({
      shouldTrigger: true,
      senderType: "allowed_app",
    });
  });

  it("does not trigger on thread replies", () => {
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ thread_ts: "1712345000.000000" }), config)).toMatchObject({
      shouldTrigger: false,
      reason: "thread_reply",
    });
  });

  it("does not trigger on message edits, deletes, joins, pins, or unrecognized subtypes", () => {
    for (const subtype of ["message_changed", "message_deleted", "channel_join", "pinned_item", "file_share"]) {
      expect(evaluateSlackChannelAutomationTrigger(rootEvent({ subtype }), config)).toMatchObject({
        shouldTrigger: false,
        reason: "ignored_subtype",
      });
    }
  });

  it("does not trigger on bot messages from unrecognized senders", () => {
    expect(
      evaluateSlackChannelAutomationTrigger(
        rootEvent({ subtype: "bot_message", app_id: "A_UNKNOWN", bot_id: "B_UNKNOWN" }),
        config,
      ),
    ).toMatchObject({
      shouldTrigger: false,
      reason: "ignored_subtype",
    });
  });

  it("does not trigger on messages from Cycloid itself", () => {
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ user: "U_CYCLOID" }), config)).toMatchObject({
      shouldTrigger: false,
      reason: "self_bot_event",
    });
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ bot_id: "B_CYCLOID" }), config)).toMatchObject({
      shouldTrigger: false,
      reason: "self_bot_event",
    });
  });

  it("does not trigger on human root chatter", () => {
    expect(
      evaluateSlackChannelAutomationTrigger(
        rootEvent({ user: "U_HUMAN", app_id: undefined, bot_id: undefined, text: "is this deploy healthy?" }),
        config,
      ),
    ).toMatchObject({
      shouldTrigger: false,
      reason: "unsupported_sender",
    });
  });

  it("allows human root messages that explicitly mention Cycloid", () => {
    expect(
      evaluateSlackChannelAutomationTrigger(
        rootEvent({
          type: "app_mention",
          user: "U_HUMAN",
          app_id: undefined,
          bot_id: undefined,
          text: "<@U_CYCLOID> triage this alert",
        }),
        config,
      ),
    ).toEqual({ shouldTrigger: true, senderType: "human_mention" });

    expect(
      evaluateSlackChannelAutomationTrigger(
        rootEvent({
          type: "message",
          user: "U_HUMAN",
          app_id: undefined,
          bot_id: undefined,
          text: "<@U_CYCLOID> triage this alert",
        }),
        config,
      ),
    ).toEqual({ shouldTrigger: true, senderType: "human_mention" });
  });

  it("does not trigger in unconfigured Slack channels", () => {
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ channel: "C_RANDOM" }), config)).toMatchObject({
      shouldTrigger: false,
      reason: "unconfigured_channel",
    });
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ team: undefined }), config)).toMatchObject({
      shouldTrigger: false,
      reason: "unconfigured_channel",
    });
  });

  it("accepts Slack envelope team_id when the inner event team is absent", () => {
    expect(evaluateSlackChannelAutomationTrigger(rootEvent({ team: undefined, team_id: "T_ALERTS" }), config)).toEqual({
      shouldTrigger: true,
      senderType: "allowed_app",
    });
  });
});
