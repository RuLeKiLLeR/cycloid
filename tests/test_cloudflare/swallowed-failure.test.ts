import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSwallowedFailureEvent,
  reportSlackPostFailure,
  reportSwallowedFailure,
} from "../../apps/control-plane-worker/src/observability/swallowed-failure";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("swallowed failure reporting", () => {
  it("pins a low-cardinality snake_case payload without raw Slack message content", () => {
    const event = buildSwallowedFailureEvent({
      surface: "slack",
      operation: "postUnconnectedSlackReply",
      sessionId: "sess-123",
      errorClass: "SlackApiError",
      errorMessage: "channel_not_found",
      slackErrorCode: "channel_not_found",
    });

    expect(event).toEqual({
      event: "integration.failure",
      surface: "slack",
      operation: "postUnconnectedSlackReply",
      session_id: "sess-123",
      error_class: "SlackApiError",
      error_message_truncated: "channel_not_found",
      slack_error_code: "channel_not_found",
    });
    expect(JSON.stringify(event)).not.toContain("text");
    expect(JSON.stringify(event)).not.toContain("blocks");
  });

  it("direct-posts the event to Datadog without tagging session_id", async () => {
    await expect(
      reportSwallowedFailure(
        { DD_API_KEY: "dd-key", WORKER_ENV: "production" },
        {
          surface: "slack",
          operation: "notifySlackThread.status",
          sessionId: "sess-123",
          errorClass: "SlackApiError",
          errorMessage: "ratelimited",
          slackErrorCode: "ratelimited",
        },
      ),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    expect((init as RequestInit).headers).toMatchObject({ "DD-API-KEY": "dd-key" });
    const payload = JSON.parse(String((init as RequestInit).body)) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      event: "integration.failure",
      surface: "slack",
      operation: "notifySlackThread.status",
      session_id: "sess-123",
      slack_error_code: "ratelimited",
    });
    expect(String(payload[0].ddtags)).not.toContain("session_id");
    expect(String(payload[0].message)).toContain('"event":"integration.failure"');
  });

  it("uses a stable unknown class instead of the literal string undefined", () => {
    expect(
      buildSwallowedFailureEvent({
        surface: "session_projection",
        operation: "updateSessionRuntimeState",
      }),
    ).toMatchObject({
      error_class: "UnknownError",
      error_message_truncated: "unknown",
    });
  });

  it("preserves real Slack Error details when an error object and Slack code are both present", async () => {
    await reportSlackPostFailure(
      { DD_API_KEY: "dd-key", WORKER_ENV: "production" },
      {
        operation: "notifySlackThread.status",
        error: new TypeError("Connection reset"),
        slackErrorCode: "ratelimited",
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String((init as RequestInit).body)) as Array<Record<string, unknown>>;
    expect(payload[0]).toMatchObject({
      error_class: "TypeError",
      error_message_truncated: "Connection reset",
      slack_error_code: "ratelimited",
    });
  });
});
