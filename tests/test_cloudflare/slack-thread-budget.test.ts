import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  postSessionThreadMessage,
  type SessionThreadAnchors,
} from "../../apps/control-plane-worker/src/slack/thread-budget";

const fetchMock = vi.fn();

function mockSlackResponse(body: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(body) });
}

function slackCall(index: number): { method: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[index];
  return {
    method: String(url).replace("https://slack.com/api/", ""),
    body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
  };
}

function makeParams(
  kind: "ask" | "result" | "expansion",
  anchors: SessionThreadAnchors,
  persisted: SessionThreadAnchors[],
  promptId?: string,
) {
  return {
    token: "xoxb-token",
    channel: "C123",
    threadTs: "1700000000.000100",
    kind,
    text: "hello",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }],
    sessionId: "sess-1",
    promptId,
    anchors,
    persistAnchors: (patch: SessionThreadAnchors) => {
      persisted.push(patch);
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postSessionThreadMessage — ask", () => {
  it("posts a new message and persists the anchor when none exists", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000200" });

    const result = await postSessionThreadMessage(makeParams("ask", {}, persisted));

    expect(result).toMatchObject({ ok: true, posted: true, updatedInPlace: false, ts: "1700000000.000200" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(slackCall(0).method).toBe("chat.postMessage");
    // First post is not a repair: no repost-count increment.
    expect(persisted).toEqual([{ askMessageTs: "1700000000.000200" }]);
  });

  it("posts a new ask and collapses the previous ask when an anchor exists", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000300" });
    mockSlackResponse({ ok: true });

    const result = await postSessionThreadMessage(makeParams("ask", { askMessageTs: "1700000000.000200" }, persisted));

    expect(result).toMatchObject({ ok: true, posted: true, updatedInPlace: false, ts: "1700000000.000300" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slackCall(0).method).toBe("chat.postMessage");
    const collapseCall = slackCall(1);
    expect(collapseCall.method).toBe("chat.update");
    expect(collapseCall.body.ts).toBe("1700000000.000200");
    expect(collapseCall.body.text).toBe("Superseded by the ask below ↓");
    expect(collapseCall.body.blocks).toEqual([]);
    expect(persisted).toEqual([{ askMessageTs: "1700000000.000300" }]);
  });

  it("still delivers the new ask when collapsing the previous anchor fails", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000300" });
    mockSlackResponse({ ok: false, error: "message_not_found" });

    const result = await postSessionThreadMessage(
      makeParams("ask", { askMessageTs: "1700000000.000200", askRepostCount: 1 }, persisted),
    );

    expect(result).toMatchObject({ ok: true, posted: true, updatedInPlace: false, ts: "1700000000.000300" });
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(slackCall(1).method).toBe("chat.update");
    expect(persisted).toEqual([{ askMessageTs: "1700000000.000300" }]);
  });

  it("still delivers the new ask when collapsing the previous anchor throws", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000300" });
    fetchMock.mockRejectedValueOnce(new Error("collapse boom"));

    const result = await postSessionThreadMessage(
      makeParams("ask", { askMessageTs: "1700000000.000200", askRepostCount: 1 }, persisted),
    );

    expect(result).toMatchObject({ ok: true, posted: true, updatedInPlace: false, ts: "1700000000.000300" });
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(persisted).toEqual([{ askMessageTs: "1700000000.000300" }]);
  });

  it("posts a new ask even when the old repair budget was exhausted", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000300" });
    mockSlackResponse({ ok: false, error: "message_not_found" });

    const result = await postSessionThreadMessage(
      makeParams("ask", { askMessageTs: "1700000000.000200", askRepostCount: 99 }, persisted),
    );

    expect(result).toMatchObject({ ok: true, posted: true, ts: "1700000000.000300" });
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(slackCall(1).method).toBe("chat.update");
    expect(persisted).toEqual([{ askMessageTs: "1700000000.000300" }]);
  });

  it("fails without mutating anchors when posting the new ask fails", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: false, error: "ratelimited" });

    const result = await postSessionThreadMessage(makeParams("ask", { askMessageTs: "1700000000.000200" }, persisted));

    expect(result).toMatchObject({ ok: false, posted: false, updatedInPlace: false, error: "ratelimited" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(persisted).toEqual([]);
  });
});

describe("postSessionThreadMessage — result", () => {
  it("posts the first result and persists the result anchor", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000400" });

    const result = await postSessionThreadMessage(makeParams("result", {}, persisted, "prompt-1"));

    expect(result).toMatchObject({ ok: true, posted: true, ts: "1700000000.000400" });
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(persisted).toEqual([{ resultMessageTs: "1700000000.000400", resultPromptId: "prompt-1" }]);
  });

  it("updates in place when the same prompt result is delivered again", async () => {
    const persisted: SessionThreadAnchors[] = [];
    // Call 1: no anchor → chat.postMessage.
    mockSlackResponse({ ok: true, ts: "1700000000.000400" });
    const first = await postSessionThreadMessage(makeParams("result", {}, persisted, "prompt-1"));
    expect(first.posted).toBe(true);

    // Call 2 (duplicate trigger sees the persisted anchor) → chat.update, no growth.
    mockSlackResponse({ ok: true });
    const second = await postSessionThreadMessage(
      makeParams("result", { resultMessageTs: "1700000000.000400", resultPromptId: "prompt-1" }, persisted, "prompt-1"),
    );

    expect(second).toMatchObject({ ok: true, posted: false, updatedInPlace: true, ts: "1700000000.000400" });
    const postMessageCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"));
    expect(postMessageCalls).toHaveLength(1);
  });

  it("forwards attachments when updating a result in place", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true });

    const result = await postSessionThreadMessage({
      ...makeParams(
        "result",
        { resultMessageTs: "1700000000.000400", resultPromptId: "prompt-1" },
        persisted,
        "prompt-1",
      ),
      attachments: [{ color: "#d4a72c", text: "details" }],
    });

    expect(result).toMatchObject({ ok: true, posted: false, updatedInPlace: true, ts: "1700000000.000400" });
    const updateCall = slackCall(0);
    expect(updateCall.method).toBe("chat.update");
    expect(updateCall.body.attachments).toEqual([{ color: "#d4a72c", text: "details" }]);
  });

  it("posts a new result when the prompt id changes", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000500" });

    const result = await postSessionThreadMessage(
      makeParams("result", { resultMessageTs: "1700000000.000400", resultPromptId: "prompt-1" }, persisted, "prompt-2"),
    );

    expect(result).toMatchObject({ ok: true, posted: true, updatedInPlace: false, ts: "1700000000.000500" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(persisted).toEqual([{ resultMessageTs: "1700000000.000500", resultPromptId: "prompt-2" }]);
  });

  it("repairs a lost result anchor without touching the ask repost budget", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: false, error: "channel_not_found" });
    mockSlackResponse({ ok: true, ts: "1700000000.000500" });

    const result = await postSessionThreadMessage(
      makeParams(
        "result",
        { resultMessageTs: "1700000000.000400", resultPromptId: "prompt-1", askRepostCount: 3 },
        persisted,
        "prompt-1",
      ),
    );

    expect(result).toMatchObject({ ok: true, posted: true, ts: "1700000000.000500" });
    expect(persisted).toEqual([{ resultMessageTs: "1700000000.000500", resultPromptId: "prompt-1" }]);
  });
});

describe("postSessionThreadMessage — expansion", () => {
  it("is an exempt passthrough: always posts new, never persists anchors", async () => {
    const persisted: SessionThreadAnchors[] = [];
    mockSlackResponse({ ok: true, ts: "1700000000.000600" });

    const result = await postSessionThreadMessage(
      makeParams("expansion", { askMessageTs: "x", resultMessageTs: "y" }, persisted),
    );

    expect(result).toMatchObject({ ok: true, posted: true, updatedInPlace: false });
    expect(slackCall(0).method).toBe("chat.postMessage");
    expect(persisted).toEqual([]);
  });
});

describe("postSessionThreadMessage — persist resilience", () => {
  it("swallows persist failures (anchors are advisory)", async () => {
    mockSlackResponse({ ok: true, ts: "1700000000.000700" });

    const result = await postSessionThreadMessage({
      token: "xoxb-token",
      channel: "C123",
      threadTs: "1700000000.000100",
      kind: "ask",
      text: "hello",
      sessionId: "sess-1",
      anchors: {},
      persistAnchors: () => {
        throw new Error("persist boom");
      },
    });

    expect(result).toMatchObject({ ok: true, posted: true, ts: "1700000000.000700" });
  });
});
