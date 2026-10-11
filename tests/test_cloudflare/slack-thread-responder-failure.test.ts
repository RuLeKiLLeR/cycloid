import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPostThreadReply = vi.fn();
const mockPostStructuredEventToDd = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  postThreadReply: (...args: unknown[]) => mockPostThreadReply(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

describe("SlackThreadResponder swallowed failure reporting", () => {
  beforeEach(() => {
    mockPostThreadReply.mockReset().mockResolvedValue({ ok: false, error: "ratelimited" });
    mockPostStructuredEventToDd.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports repo clarification post failures from the env-owning wrapper", async () => {
    const { SlackThreadResponder } =
      await import("../../apps/control-plane-worker/src/webhooks/slack-thread-responder");
    const waitUntilPromises: Promise<unknown>[] = [];
    const responder = new SlackThreadResponder({
      slackBotToken: "xoxb-token",
      channelId: "C123",
      threadTs: "1.2",
      ctx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      } as ExecutionContext,
    });

    responder.postRepoClarification({
      DD_API_KEY: "dd-key",
      WORKER_ENV: "production",
      FRONTEND_URL: "https://app",
    } as never);
    await Promise.all(waitUntilPromises);

    expect(mockPostThreadReply).toHaveBeenCalledOnce();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(expect.anything(), {
      event: "integration.failure",
      surface: "slack",
      operation: "postRepoClarificationReply",
      error_class: "SlackApiError",
      error_message_truncated: "ratelimited",
      slack_error_code: "ratelimited",
    });
  });
});
