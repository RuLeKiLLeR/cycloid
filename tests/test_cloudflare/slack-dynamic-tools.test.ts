import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  tracedFetchMock,
  loggerInfo,
  loggerWarn,
  createLoggerMock,
  resolveInstalledSlackBotTokenMock,
  getSlackUserTokensMock,
} = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    tracedFetchMock: vi.fn(),
    loggerInfo: logger.info,
    loggerWarn: logger.warn,
    createLoggerMock: vi.fn(() => logger),
    resolveInstalledSlackBotTokenMock: vi.fn(),
    getSlackUserTokensMock: vi.fn(),
  };
});

vi.mock("../../apps/control-plane-worker/src/logger.js", () => ({
  createLogger: createLoggerMock,
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: tracedFetchMock,
}));

vi.mock("../../apps/control-plane-worker/src/slack/tokens", () => ({
  resolveInstalledSlackBotToken: resolveInstalledSlackBotTokenMock,
}));

vi.mock("../../apps/control-plane-worker/src/integrations/db", () => ({
  getSlackUserTokens: getSlackUserTokensMock,
}));

describe("slack dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveInstalledSlackBotTokenMock.mockResolvedValue("xoxb-workspace-bot");
    getSlackUserTokensMock.mockResolvedValue({
      accessToken: "xoxp-user-token",
      refreshToken: null,
      expiresAt: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logs a redacted audit event for send_message", async () => {
    tracedFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1710000002.000300", channel: "C123" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, permalink: "https://workspace.slack.com/archives/C123/p1710000002000300" }),
        ),
      );

    const { runSlackSendMessageTool } = await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const result = await runSlackSendMessageTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      sessionId: "sess-1",
      slackTeamId: "T123",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1710000000.000100",
        slackTeamId: "T123",
      },
      args: {
        channel: "C123",
        threadTs: "1710000000.000100",
        text: "secret text body",
      },
    });

    expect(result).toEqual({
      ts: "1710000002.000300",
      channel: "C123",
      permalink: "https://workspace.slack.com/archives/C123/p1710000002000300",
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      {
        event: "dynamic_tool_write",
        tool: "slack.send_message",
        userId: "1001",
        sessionId: "sess-1",
        targetChannel: "C123",
        targetThreadTs: "1710000000.000100",
        textLength: 16,
        outcome: "ok",
      },
      "Slack dynamic tool write",
    );
    expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain("secret text body");
  });

  it("maps missing_scope to scope_missing", async () => {
    tracedFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "missing_scope" })));

    const { runSlackGetThreadTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackGetThreadTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      slackTeamId: "T123",
      args: { channel: "C123", ts: "1710000000.000100" },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "scope_missing",
      status: 403,
    });
  });

  it("returns rendered block and attachment text from get_thread", async () => {
    tracedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              user: "UDATADOG",
              ts: "1710000000.000100",
              text: "",
              attachments: [
                {
                  fallback: "Datadog monitor alert: Prompts maximum duration exceeded",
                  text: "Search logs for <https://app.datadoghq.com/logs|logs>",
                  fields: [
                    {
                      title: "Query",
                      value: "service:cycloid-control-plane @event:prompt.max_duration_exceeded",
                    },
                  ],
                },
              ],
            },
            {
              user: "USENTRY",
              ts: "1710000001.000200",
              text: "",
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "*Sentry alert*: TypeError on /sessions",
                  },
                },
              ],
            },
            {
              user: "UINCIDENT",
              ts: "1710000002.000300",
              text: "",
              blocks: [
                {
                  type: "rich_text",
                  elements: [
                    {
                      type: "rich_text_list",
                      style: "bullet",
                      elements: [
                        {
                          type: "rich_text_section",
                          elements: [{ type: "text", text: "Check deploy health" }],
                        },
                        {
                          type: "rich_text_section",
                          elements: [{ type: "text", text: "Rollback if errors continue" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const { runSlackGetThreadTool } = await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const result = await runSlackGetThreadTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      slackTeamId: "T123",
      args: { channel: "C123", ts: "1710000000.000100" },
    });

    expect(result.messages).toEqual([
      {
        user: "UDATADOG",
        ts: "1710000000.000100",
        text: [
          "Search logs for logs (https://app.datadoghq.com/logs)",
          "Query: service:cycloid-control-plane @event:prompt.max_duration_exceeded",
          "Datadog monitor alert: Prompts maximum duration exceeded",
        ].join("\n"),
        threadTs: null,
      },
      {
        user: "USENTRY",
        ts: "1710000001.000200",
        text: "*Sentry alert*: TypeError on /sessions",
        threadTs: null,
      },
      {
        user: "UINCIDENT",
        ts: "1710000002.000300",
        text: "- Check deploy health\n- Rollback if errors continue",
        threadTs: null,
      },
    ]);
  });

  it("deduplicates rich-text blocks and text with equivalent mention markup", async () => {
    tracedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              user: "UINCIDENT",
              ts: "1710000003.000400",
              text: "Please check <@U456>",
              blocks: [
                {
                  type: "rich_text",
                  elements: [
                    {
                      type: "rich_text_section",
                      elements: [
                        { type: "text", text: "Please check " },
                        { type: "user", user_id: "U456" },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              user: "UINCIDENT",
              ts: "1710000004.000500",
              text: "Watch <#C456> and <!here>",
              blocks: [
                {
                  type: "rich_text",
                  elements: [
                    {
                      type: "rich_text_section",
                      elements: [
                        { type: "text", text: "Watch " },
                        { type: "channel", channel_id: "C456" },
                        { type: "text", text: " and " },
                        { type: "broadcast", range: "here" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const { runSlackGetThreadTool } = await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const result = await runSlackGetThreadTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      slackTeamId: "T123",
      args: { channel: "C123", ts: "1710000000.000100" },
    });

    expect(result.messages).toEqual([
      {
        user: "UINCIDENT",
        ts: "1710000003.000400",
        text: "Please check <@U456>",
        threadTs: null,
      },
      {
        user: "UINCIDENT",
        ts: "1710000004.000500",
        text: "Watch <#C456> and <!here>",
        threadTs: null,
      },
    ]);
  });

  it.each([
    "is_archived",
    "restricted_action",
    "restricted_action_read_only_channel",
    "restricted_action_thread_locked",
    "restricted_action_thread_only_channel",
  ])("maps Slack access restriction error %s to forbidden", async (slackErrorCode) => {
    tracedFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: slackErrorCode })));

    const { runSlackGetThreadTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackGetThreadTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      slackTeamId: "T123",
      args: { channel: "C123", ts: "1710000000.000100" },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "forbidden",
      status: 403,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        event: "slack_dynamic_tool_api_error",
        method: "conversations.replies",
        tokenKind: "workspace_bot",
        slackErrorCode,
        errorCode: "forbidden",
        status: 403,
      },
      "Slack dynamic tool API error",
    );
  });

  it("maps non-JSON rate limits to upstream_rate_limited", async () => {
    tracedFetchMock.mockResolvedValueOnce(new Response("<html>rate limited</html>", { status: 429 }));

    const { runSlackGetThreadTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackGetThreadTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      slackTeamId: "T123",
      args: { channel: "C123", ts: "1710000000.000100" },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "upstream_rate_limited",
      status: 429,
    });
  });

  it("maps search_messages without a connected Slack user token to not_connected", async () => {
    getSlackUserTokensMock.mockResolvedValueOnce(null);

    const { runSlackSearchMessagesTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackSearchMessagesTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      args: { query: "deploy" },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "not_connected",
      status: 409,
    });
  });

  it("rejects search_messages channel IDs instead of silently running unscoped", async () => {
    const { runSlackSearchMessagesTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackSearchMessagesTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      args: { query: "deploy", channel: "C12345678" },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "invalid_input",
      status: 400,
    });
    expect(tracedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects send_message outside the bound Slack thread", async () => {
    const { runSlackSendMessageTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackSendMessageTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      sessionId: "sess-1",
      slackTeamId: "T123",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1710000000.000100",
        slackTeamId: "T123",
      },
      args: {
        channel: "C999",
        threadTs: "1710000000.000999",
        text: "secret text body",
      },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "invalid_input",
      status: 400,
    });
    expect(tracedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects send_message for a channel-only context with no bound thread (scheduled automation)", async () => {
    const { runSlackSendMessageTool, toSlackDynamicToolFailureResponse } =
      await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const error = await runSlackSendMessageTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      sessionId: "sess-1",
      slackTeamId: "T123",
      // Scheduled automations bind a channel-only Slack context (no threadTs) and
      // deliver a single plain top-level digest at completion. A direct send would
      // emit an extra top-level message and break the single-message contract, so
      // the write tool must fail closed — even when the channel matches.
      callbackContext: {
        source: "slack",
        channel: "C123",
        slackTeamId: "T123",
      },
      args: {
        channel: "C123",
        text: "an extra message the agent should not be able to send",
      },
    }).catch((caught) => caught);

    expect(toSlackDynamicToolFailureResponse(error)).toMatchObject({
      ok: false,
      errorCode: "invalid_input",
      status: 400,
    });
    expect(tracedFetchMock).not.toHaveBeenCalled();
  });

  it("returns send_message success even when permalink lookup fails", async () => {
    tracedFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1710000002.000300", channel: "C123" })))
      .mockResolvedValueOnce(new Response("service unavailable", { status: 503 }));

    const { runSlackSendMessageTool } = await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const result = await runSlackSendMessageTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      sessionId: "sess-1",
      slackTeamId: "T123",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1710000000.000100",
        slackTeamId: "T123",
      },
      args: {
        channel: "C123",
        threadTs: "1710000000.000100",
        text: "secret text body",
      },
    });

    expect(result).toEqual({
      ts: "1710000002.000300",
      channel: "C123",
      permalink: null,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        event: "dynamic_tool_write_permalink_lookup_failed",
        tool: "slack.send_message",
        sessionId: "sess-1",
      },
      expect.stringContaining("Slack chat.getPermalink failed after postMessage"),
    );
  });

  it("does not emit a second structured warn log when permalink lookup returns a Slack body error", async () => {
    tracedFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1710000002.000300", channel: "C123" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "channel_not_found" })));

    const { runSlackSendMessageTool } = await import("../../apps/control-plane-worker/src/slack/dynamic-tools.js");

    const result = await runSlackSendMessageTool({
      env: { DB: {} as D1Database, TOKEN_ENCRYPTION_KEY: "enc-key" } as never,
      ownerUserId: "1001",
      sessionId: "sess-1",
      slackTeamId: "T123",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "1710000000.000100",
        slackTeamId: "T123",
      },
      args: {
        channel: "C123",
        threadTs: "1710000000.000100",
        text: "secret text body",
      },
    });

    expect(result).toEqual({
      ts: "1710000002.000300",
      channel: "C123",
      permalink: null,
    });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        event: "dynamic_tool_write_permalink_lookup_failed",
        tool: "slack.send_message",
        sessionId: "sess-1",
      },
      expect.stringContaining("Slack chat.getPermalink failed after postMessage"),
    );
  });
});
