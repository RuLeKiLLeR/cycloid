import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drainSpans, endSpan, runInSpan, startSpan } from "../../apps/control-plane-worker/src/observability/context";
import {
  addReaction,
  deliverThreadStatus,
  getConversationInfo,
  getSlackBotUserId,
  getThreadReplies,
  parseSlackRetryAfterMs,
  postMessage,
  postThreadReply,
  redactSlackBodyForLog,
  removeReaction,
  updateMessage,
  uploadFile,
} from "../../apps/control-plane-worker/src/slack/notify";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSlackResponse(ok: boolean, error?: string) {
  fetchMock.mockResolvedValueOnce({
    json: () => Promise.resolve({ ok, error }),
  });
}

function mockSlackHttp(status: number, opts: { retryAfter?: string | null; body?: unknown } = {}) {
  fetchMock.mockResolvedValueOnce({
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null) },
    json: () => Promise.resolve(opts.body ?? { ok: status < 400 }),
  });
}

describe("parseSlackRetryAfterMs", () => {
  it("converts integer seconds to ms", () => {
    expect(parseSlackRetryAfterMs("3")).toBe(3_000);
  });

  it("defaults to 1s when the header is missing or non-numeric", () => {
    expect(parseSlackRetryAfterMs(null)).toBe(1_000);
    expect(parseSlackRetryAfterMs("nonsense")).toBe(1_000);
    expect(parseSlackRetryAfterMs("0")).toBe(1_000);
    expect(parseSlackRetryAfterMs("-5")).toBe(1_000);
  });

  it("clamps absurdly long waits to 30s", () => {
    expect(parseSlackRetryAfterMs("99999")).toBe(30_000);
  });
});

describe("slackApi rate-limit handling (429)", () => {
  it("waits the Retry-After interval and retries, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      mockSlackHttp(429, { retryAfter: "2", body: { ok: false, error: "ratelimited" } });
      mockSlackHttp(200, { body: { ok: true, ts: "1.0", channel: "C123" } });

      const promise = postThreadReply("xoxb-token", "C123", "ts", "Hello");
      // No retry yet -- still waiting out Retry-After.
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the retry budget and returns the throttled result", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i++) mockSlackHttp(429, { retryAfter: "1", body: { ok: false, error: "ratelimited" } });

      const promise = postThreadReply("xoxb-token", "C123", "ts", "Hello");
      await vi.advanceTimersByTimeAsync(1_000 * 4);
      const result = await promise;

      expect(result.ok).toBe(false);
      // initial attempt + 3 retries
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // A distinct "budget exhausted" warn is emitted on the final 429.
      const exhausted = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("retry budget exhausted"));
      expect(exhausted).toBeTruthy();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns structured error when 429 has empty body after retry budget exhausted", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "1" } }));
      }

      const promise = postThreadReply("xoxb-token", "C123", "ts", "Hello");
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await promise;

      expect(result).toEqual({ ok: false, error: "ratelimited" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("postThreadReply", () => {
  it("sends correct payload to chat.postMessage", async () => {
    mockSlackResponse(true);
    const result = await postThreadReply(
      "xoxb-token",
      "C123",
      "1234567890.123456",
      "Hello",
      [{ type: "section" }],
      [{ color: "d4a72c" }],
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(options.method).toBe("POST");
    expect(options.headers.authorization).toBe("Bearer xoxb-token");
    const body = JSON.parse(options.body);
    expect(body.channel).toBe("C123");
    expect(body.thread_ts).toBe("1234567890.123456");
    expect(body.text).toBe("Hello");
    expect(body.blocks).toEqual([{ type: "section" }]);
    expect(body.attachments).toEqual([{ color: "d4a72c" }]);
  });

  it("omits blocks when not provided", async () => {
    mockSlackResponse(true);
    await postThreadReply("xoxb-token", "C123", "ts", "Hello");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.blocks).toBeUndefined();
  });

  it("returns error from Slack API", async () => {
    mockSlackResponse(false, "channel_not_found");
    const result = await postThreadReply("xoxb-token", "C123", "ts", "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
  });

  it("logs slack method and response metadata on API failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 500 is a non-retryable failure (429 is handled by the rate-limit retry path).
    fetchMock.mockResolvedValueOnce({
      status: 500,
      json: () =>
        Promise.resolve({
          ok: false,
          error: "internal_error",
          response_metadata: { messages: ["slow down", "retry later"] },
        }),
    });

    await postThreadReply("xoxb-token", "C123", "ts", "Hello");

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      msg: "Slack API call failed",
      component: "slack-api",
      slackMethod: "chat.postMessage",
      error: "internal_error",
      slackMessages: "slow down; retry later",
      httpStatus: 500,
    });
  });
});

describe("updateMessage", () => {
  it("sends correct payload to chat.update", async () => {
    mockSlackResponse(true);
    const result = await updateMessage(
      "xoxb-token",
      "C123",
      "1712345678.000500",
      "Done",
      [{ type: "section" }],
      [{ color: "0e8a16" }],
    );

    expect(result.ok).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(options.method).toBe("POST");
    expect(options.headers.authorization).toBe("Bearer xoxb-token");
    const body = JSON.parse(options.body);
    expect(body.channel).toBe("C123");
    expect(body.ts).toBe("1712345678.000500");
    expect(body.text).toBe("Done");
    expect(body.blocks).toEqual([{ type: "section" }]);
    expect(body.attachments).toEqual([{ color: "0e8a16" }]);
  });

  it("clears attachments when chat.update callers omit them", async () => {
    mockSlackResponse(true);
    await updateMessage("xoxb-token", "C123", "ts", "Done");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.blocks).toBeUndefined();
    expect(body.attachments).toEqual([]);
  });

  it("returns error from Slack API", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      status: 400,
      json: () => Promise.resolve({ ok: false, error: "message_not_found" }),
    });

    const result = await updateMessage("xoxb-token", "C123", "ts", "Done");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("message_not_found");
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});

describe("deliverThreadStatus", () => {
  it("updates the durable status message in place when statusMessageTs is known", async () => {
    mockSlackResponse(true);

    const result = await deliverThreadStatus({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1712345678.000100",
      statusMessageTs: "1712345678.000500",
      text: "Done",
      blocks: [{ type: "section" }],
      attachments: [{ color: "d4a72c" }],
    });

    expect(result).toEqual({ ok: true, updatedInPlace: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).attachments).toEqual([{ color: "d4a72c" }]);
  });

  it("clears stale attachments when a later status update has no replacement attachment", async () => {
    mockSlackResponse(true);

    const result = await deliverThreadStatus({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1712345678.000100",
      statusMessageTs: "1712345678.000500",
      text: "Done",
      blocks: [{ type: "section" }],
    });

    expect(result).toEqual({ ok: true, updatedInPlace: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).attachments).toEqual([]);
  });

  it("falls back to chat.postMessage when chat.update fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      status: 400,
      json: () => Promise.resolve({ ok: false, error: "message_not_found" }),
    });
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, ts: "1712345678.000900" }),
    });

    const result = await deliverThreadStatus({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1712345678.000100",
      statusMessageTs: "1712345678.000500",
      text: "Done",
      blocks: [{ type: "section" }],
      attachments: [{ color: "d73a4a" }],
    });

    expect(result).toEqual({
      ok: true,
      updatedInPlace: false,
      fallbackTs: "1712345678.000900",
      error: "message_not_found",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.update");
    expect(fetchMock.mock.calls[1][0]).toBe("https://slack.com/api/chat.postMessage");
    const replyBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(replyBody.thread_ts).toBe("1712345678.000100");
    expect(replyBody.attachments).toEqual([{ color: "d73a4a" }]);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("falls back to chat.postMessage when chat.update throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, ts: "1712345678.000901" }),
    });

    const result = await deliverThreadStatus({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1712345678.000100",
      statusMessageTs: "1712345678.000500",
      text: "Done",
      blocks: [{ type: "section" }],
    });

    expect(result).toEqual({
      ok: true,
      updatedInPlace: false,
      fallbackTs: "1712345678.000901",
      error: "network unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.update");
    expect(fetchMock.mock.calls[1][0]).toBe("https://slack.com/api/chat.postMessage");
  });

  it("combines update and fallback errors when both Slack calls fail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      status: 400,
      json: () => Promise.resolve({ ok: false, error: "message_not_found" }),
    });
    fetchMock.mockResolvedValueOnce({
      status: 400,
      json: () => Promise.resolve({ ok: false, error: "channel_not_found" }),
    });

    const result = await deliverThreadStatus({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1712345678.000100",
      statusMessageTs: "1712345678.000500",
      text: "Done",
      blocks: [{ type: "section" }],
    });

    expect(result).toEqual({
      ok: false,
      updatedInPlace: false,
      fallbackTs: undefined,
      error: "update: message_not_found; fallback: channel_not_found",
    });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("posts a new thread reply when statusMessageTs is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, ts: "1712345678.000902" }),
    });

    const result = await deliverThreadStatus({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1712345678.000100",
      statusMessageTs: undefined,
      text: "Done",
      blocks: [{ type: "section" }],
    });

    expect(result).toEqual({ ok: true, updatedInPlace: false, fallbackTs: "1712345678.000902", error: undefined });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.postMessage");
  });
});

describe("addReaction", () => {
  it("sends correct payload to reactions.add", async () => {
    mockSlackResponse(true);
    await addReaction("xoxb-token", "C123", "1234567890.123456", "eyes");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/reactions.add");
    const body = JSON.parse(options.body);
    expect(body.channel).toBe("C123");
    expect(body.timestamp).toBe("1234567890.123456");
    expect(body.name).toBe("eyes");
  });
});

describe("removeReaction", () => {
  it("sends correct payload to reactions.remove", async () => {
    mockSlackResponse(true);
    await removeReaction("xoxb-token", "C123", "1234567890.123456", "eyes");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/reactions.remove");
    const body = JSON.parse(options.body);
    expect(body.channel).toBe("C123");
    expect(body.timestamp).toBe("1234567890.123456");
    expect(body.name).toBe("eyes");
  });
});

describe("getThreadReplies", () => {
  it("sends correct query params to conversations.replies", async () => {
    const messages = [
      { ts: "1000.0", text: "parent", user: "U1" },
      { ts: "1001.0", text: "reply", user: "U2" },
    ];
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, messages }),
    });

    const result = await getThreadReplies("xoxb-token", "C123", "1000.0");

    expect(result).toEqual(messages);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("https://slack.com/api/conversations.replies?");
    expect(url).toContain("channel=C123");
    expect(url).toContain("ts=1000.0");
    expect(url).toContain("limit=50");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
  });

  it("returns empty array on API failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      status: 403,
      json: () =>
        Promise.resolve({
          ok: false,
          error: "channel_not_found",
          response_metadata: { messages: ["missing channel access"] },
        }),
    });

    const result = await getThreadReplies("xoxb-token", "C123", "1000.0");
    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      msg: "Slack API call failed",
      component: "slack-api",
      slackMethod: "conversations.replies",
      error: "channel_not_found",
      slackMessages: "missing channel access",
      httpStatus: 403,
      params: { channel: "C123", ts: "1000.0", limit: 50 },
    });
  });

  it("returns empty array when messages field is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true }),
    });

    const result = await getThreadReplies("xoxb-token", "C123", "1000.0");
    expect(result).toEqual([]);
  });

  it("respects custom limit parameter", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, messages: [] }),
    });

    await getThreadReplies("xoxb-token", "C123", "1000.0", 10);

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("limit=10");
  });
});

describe("getConversationInfo", () => {
  it("sends correct query params to conversations.info", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          channel: {
            id: "C123",
            name: "widgets",
            is_channel: true,
            is_private: false,
            is_im: false,
            is_mpim: false,
          },
        }),
    });

    const result = await getConversationInfo("xoxb-token", "C123");

    expect(result).toEqual({
      id: "C123",
      name: "widgets",
      isChannel: true,
      isPrivate: false,
      isIm: false,
      isMpim: false,
      isMember: false,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("https://slack.com/api/conversations.info?");
    expect(url).toContain("channel=C123");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
  });

  it("returns null on API failure", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: false, error: "missing_scope" }),
    });

    const result = await getConversationInfo("xoxb-token", "C123");
    expect(result).toBeNull();
  });
});

describe("getSlackBotUserId", () => {
  it("records the auth.test span with the dot-separated Slack method name", async () => {
    const root = startSpan("worker.fetch", { "request.id": "req-slack-1" });
    let spans = [] as ReturnType<typeof drainSpans>;

    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, user_id: "U123" }),
    });

    await runInSpan(root, async () => {
      const userId = await getSlackBotUserId("xoxb-token");
      expect(userId).toBe("U123");

      endSpan(root, "ok");
      spans = drainSpans();
    });

    const slackSpan = spans.find((span) => span.name === "slack.auth.test");
    expect(slackSpan).toBeDefined();
    expect(slackSpan?.parentSpanId).toBe(root.spanId);
  });

  it("reuses cached bot user IDs for the same token", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, user_id: "U_CACHE" }),
    });

    await expect(getSlackBotUserId("xoxb-cache-token")).resolves.toBe("U_CACHE");
    await expect(getSlackBotUserId("xoxb-cache-token")).resolves.toBe("U_CACHE");

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("postMessage", () => {
  it("returns ts from Slack response", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, ts: "1234567890.123456", channel: "C123" }),
    });

    const result = await postMessage("xoxb-token", "C123", "Hello");

    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1234567890.123456");
    expect(result.channel).toBe("C123");
  });
});

describe("uploadFile", () => {
  // ci-sync
  function mockUploadUrlResponse(ok: boolean, upload_url?: string, file_id?: string) {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok, upload_url, file_id }),
    });
  }

  function mockPutResponse(ok: boolean, status = 200) {
    fetchMock.mockResolvedValueOnce({ ok, status });
  }

  function mockCompleteResponse(ok: boolean) {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok }),
    });
  }

  it("uploads file via 3-step Slack API", async () => {
    mockUploadUrlResponse(true, "https://files.slack.com/upload/v1/abc", "F123");
    mockPutResponse(true);
    mockCompleteResponse(true);

    const result = await uploadFile("xoxb-token", "C123", "1000.0", "transcript.md", "# Hello");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Step 1: getUploadURLExternal (form-encoded per Slack API requirement)
    const [url1, opts1] = fetchMock.mock.calls[0];
    expect(url1).toBe("https://slack.com/api/files.getUploadURLExternal");
    expect(opts1.headers["content-type"]).toBe("application/x-www-form-urlencoded; charset=utf-8");
    const body1 = new URLSearchParams(opts1.body);
    expect(body1.get("filename")).toBe("transcript.md");
    expect(Number(body1.get("length"))).toBe(new TextEncoder().encode("# Hello").byteLength);

    // Step 2: Upload to presigned URL
    const [url2, opts2] = fetchMock.mock.calls[1];
    expect(url2).toBe("https://files.slack.com/upload/v1/abc");
    expect(opts2.method).toBe("POST");
    expect(opts2.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(opts2.body).toBe("# Hello");

    // Step 3: completeUploadExternal
    const [url3, opts3] = fetchMock.mock.calls[2];
    expect(url3).toBe("https://slack.com/api/files.completeUploadExternal");
    const body3 = JSON.parse(opts3.body);
    expect(body3.files).toEqual([{ id: "F123", title: "transcript.md" }]);
    expect(body3.channel_id).toBe("C123");
    expect(body3.thread_ts).toBe("1000.0");
    expect(body3.initial_comment).toBeUndefined();
  });

  it("passes an initial comment when completing a file upload", async () => {
    mockUploadUrlResponse(true, "https://files.slack.com/upload/v1/abc", "F123");
    mockPutResponse(true);
    mockCompleteResponse(true);

    await uploadFile("xoxb-token", "D123", "1000.0", "plan.md", "# Plan", "Here's the full plan.");

    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.initial_comment).toBe("Here's the full plan.");
  });

  it("redacts initial comments from Slack API logs", () => {
    expect(redactSlackBodyForLog({ channel_id: "D123", initial_comment: "session-specific content" })).toEqual({
      channel_id: "D123",
      initial_comment: "[redacted]",
    });
  });

  it("returns early when getUploadURLExternal fails", async () => {
    mockUploadUrlResponse(false);

    const result = await uploadFile("xoxb-token", "C123", "1000.0", "transcript.md", "content");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns error when presigned URL upload fails", async () => {
    mockUploadUrlResponse(true, "https://files.slack.com/upload/v1/abc", "F123");
    mockPutResponse(false, 500);

    const result = await uploadFile("xoxb-token", "C123", "1000.0", "transcript.md", "content");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("upload_failed_500");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
