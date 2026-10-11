import { beforeEach, describe, expect, it, vi } from "vitest";

const tracedFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: tracedFetchMock,
}));

import { sendSlackLinkDm } from "../../apps/control-plane-worker/src/slack/link-service.js";
import { verifySlackLinkToken } from "../../apps/control-plane-worker/src/slack/link-token.js";
import { openDirectMessage, postDirectMessage } from "../../apps/control-plane-worker/src/slack/notify.js";
import type { Env } from "../../apps/control-plane-worker/src/types.js";

function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Minimal in-memory KVNamespace stub for rate-limit assertions. */
function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const SIGNING_KEY = "test-slack-link-signing-key";

beforeEach(() => {
  tracedFetchMock.mockReset();
});

describe("slack/notify direct messages", () => {
  it("opens the IM and posts with link/media unfurling disabled", async () => {
    tracedFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("conversations.open")) return slackResponse({ ok: true, channel: { id: "D123" } });
      if (url.includes("chat.postMessage")) return slackResponse({ ok: true, ts: "1.1", channel: "D123" });
      throw new Error(`unexpected ${url}`);
    });

    const result = await postDirectMessage("xoxb-token", "U_ABC", "hello");
    expect(result.ok).toBe(true);

    const postCall = tracedFetchMock.mock.calls.find((c) => String(c[0]).includes("chat.postMessage"));
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.channel).toBe("D123");
    expect(body.unfurl_links).toBe(false);
    expect(body.unfurl_media).toBe(false);
  });

  it("posts Block Kit blocks while retaining plain-text fallback", async () => {
    tracedFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("conversations.open")) return slackResponse({ ok: true, channel: { id: "D123" } });
      if (url.includes("chat.postMessage")) return slackResponse({ ok: true, ts: "1.1", channel: "D123" });
      throw new Error(`unexpected ${url}`);
    });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Plan ready" } }];

    const result = await postDirectMessage("xoxb-token", "U_ABC", "Plan ready fallback", blocks);

    expect(result.ok).toBe(true);
    const postCall = tracedFetchMock.mock.calls.find((c) => String(c[0]).includes("chat.postMessage"));
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      channel: "D123",
      text: "Plan ready fallback",
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("returns ok:false without posting when the IM cannot be opened", async () => {
    tracedFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("conversations.open")) return slackResponse({ ok: false, error: "cannot_dm_bot" });
      throw new Error(`unexpected ${url}`);
    });
    const result = await postDirectMessage("xoxb-token", "U_ABC", "hello");
    expect(result.ok).toBe(false);
    expect(tracedFetchMock.mock.calls.some((c) => String(c[0]).includes("chat.postMessage"))).toBe(false);
  });

  it("openDirectMessage returns null on failure", async () => {
    tracedFetchMock.mockResolvedValue(slackResponse({ ok: false, error: "user_not_found" }));
    await expect(openDirectMessage("xoxb-token", "U_ABC")).resolves.toBeNull();
  });
});

describe("slack/link-service sendSlackLinkDm", () => {
  function envWith(kv: KVNamespace | undefined): Env {
    return {
      SLACK_LINK_SIGNING_KEY: SIGNING_KEY,
      FRONTEND_URL: "https://app.test",
      RATE_LIMITS: kv,
    } as unknown as Env;
  }

  it("DMs a valid magic link and records the rate-limit key", async () => {
    tracedFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("conversations.open")) return slackResponse({ ok: true, channel: { id: "D1" } });
      if (url.includes("chat.postMessage")) return slackResponse({ ok: true, ts: "1.1" });
      throw new Error(`unexpected ${url}`);
    });
    const kv = fakeKv();

    const result = await sendSlackLinkDm(envWith(kv), {
      slackUserId: "U_ABC",
      slackTeamId: "T_BIZ",
      botToken: "xoxb",
      now: 1_700_000_000_000,
    });
    expect(result).toBe("sent");

    // The DM body carries a working, verifiable link token.
    const postCall = tracedFetchMock.mock.calls.find((c) => String(c[0]).includes("chat.postMessage"));
    const text = JSON.parse((postCall![1] as RequestInit).body as string).text as string;
    const tokenMatch = text.match(/token=([^\s]+)/);
    expect(tokenMatch).not.toBeNull();
    const payload = await verifySlackLinkToken(decodeURIComponent(tokenMatch![1]), SIGNING_KEY, 1_700_000_000_000);
    expect(payload?.slackUserId).toBe("U_ABC");
    expect(payload?.slackTeamId).toBe("T_BIZ");

    expect([...kv.store.keys()][0]).toContain("slack-link-dm:T_BIZ:U_ABC");
  });

  it("does not re-send within the rate-limit window", async () => {
    tracedFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("conversations.open")) return slackResponse({ ok: true, channel: { id: "D1" } });
      if (url.includes("chat.postMessage")) return slackResponse({ ok: true, ts: "1.1" });
      throw new Error(`unexpected ${url}`);
    });
    const kv = fakeKv();
    const now = 1_700_000_000_000;

    await sendSlackLinkDm(envWith(kv), { slackUserId: "U_ABC", slackTeamId: "T_BIZ", botToken: "xoxb", now });
    tracedFetchMock.mockClear();
    const second = await sendSlackLinkDm(envWith(kv), {
      slackUserId: "U_ABC",
      slackTeamId: "T_BIZ",
      botToken: "xoxb",
      now,
    });

    expect(second).toBe("rate_limited");
    expect(tracedFetchMock).not.toHaveBeenCalled();
  });

  it("reports not_configured when the signing key is absent", async () => {
    const env = { FRONTEND_URL: "https://app.test", RATE_LIMITS: fakeKv() } as unknown as Env;
    const result = await sendSlackLinkDm(env, {
      slackUserId: "U_ABC",
      slackTeamId: "T_BIZ",
      botToken: "xoxb",
    });
    expect(result).toBe("not_configured");
  });

  it("reports failed and does not record the rate-limit key when the DM fails", async () => {
    tracedFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("conversations.open")) return slackResponse({ ok: false, error: "cannot_dm_bot" });
      throw new Error(`unexpected ${url}`);
    });
    const kv = fakeKv();
    const result = await sendSlackLinkDm(envWith(kv), { slackUserId: "U_ABC", slackTeamId: "T_BIZ", botToken: "xoxb" });
    expect(result).toBe("failed");
    expect(kv.store.size).toBe(0);
  });
});
