import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostMessage = vi.fn();
const warn = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({ warn }),
}));

async function load() {
  return import("../../apps/control-plane-worker/src/slack/internal-alerts");
}

describe("postInternalAlert", () => {
  beforeEach(() => {
    mockPostMessage.mockReset().mockResolvedValue({ ok: true, ts: "111.222", channel: "C_RESOLVED" });
    warn.mockReset();
  });

  it("no-ops and returns null when the token is missing", async () => {
    const { postInternalAlert } = await load();
    const result = await postInternalAlert({}, "C_CHAN", "hello");
    expect(result).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("no-ops and returns null when the token is whitespace-only / placeholder", async () => {
    const { postInternalAlert } = await load();
    expect(await postInternalAlert({ SLACK_BOT_TOKEN: "   " }, "C_CHAN", "hi")).toBeNull();
    expect(await postInternalAlert({ SLACK_BOT_TOKEN: "CHANGE_ME" }, "C_CHAN", "hi")).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("no-ops and returns null when the channel is missing / empty / whitespace-only", async () => {
    const { postInternalAlert } = await load();
    expect(await postInternalAlert({ SLACK_BOT_TOKEN: "tok" }, undefined, "hi")).toBeNull();
    expect(await postInternalAlert({ SLACK_BOT_TOKEN: "tok" }, "", "hi")).toBeNull();
    expect(await postInternalAlert({ SLACK_BOT_TOKEN: "tok" }, "   ", "hi")).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("calls postMessage with channel/text/blocks and returns the response when configured", async () => {
    const { postInternalAlert } = await load();
    const blocks = [{ type: "section" }];
    const result = await postInternalAlert({ SLACK_BOT_TOKEN: " tok " }, " C_CHAN ", "the message", blocks);
    expect(mockPostMessage).toHaveBeenCalledWith("tok", "C_CHAN", "the message", blocks);
    expect(result).toEqual({ ok: true, ts: "111.222", channel: "C_RESOLVED" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the ok:false response without double-logging (slackApi already logged it)", async () => {
    mockPostMessage.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const { postInternalAlert } = await load();
    const result = await postInternalAlert({ SLACK_BOT_TOKEN: "tok" }, "C_CHAN", "secret text", undefined, {
      sessionId: "sess-1",
    });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    // The underlying slackApi layer owns the failure log; the helper must not add a second one.
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null and swallows when postMessage throws", async () => {
    mockPostMessage.mockRejectedValue(new Error("network down"));
    const { postInternalAlert } = await load();
    await expect(postInternalAlert({ SLACK_BOT_TOKEN: "tok" }, "C_CHAN", "hi")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("classifies a user-id channel as a DM in the throw-path metadata", async () => {
    mockPostMessage.mockRejectedValue(new Error("boom"));
    const { postInternalAlert } = await load();
    await postInternalAlert({ SLACK_BOT_TOKEN: "tok" }, "U_REVIEWER", "hi", undefined, { sessionId: "s" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ channelType: "user", sessionId: "s" });
  });

  it("never logs the message text, blocks, or token on any path", async () => {
    mockPostMessage.mockRejectedValue(new Error("boom"));
    const { postInternalAlert } = await load();
    await postInternalAlert({ SLACK_BOT_TOKEN: "xoxb-super-secret" }, "C_CHAN", "PII: jane@example.com", [
      { secret: "blocks" },
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("jane@example.com");
    expect(logged).not.toContain("xoxb-super-secret");
    expect(logged).not.toContain("blocks");
  });
});
