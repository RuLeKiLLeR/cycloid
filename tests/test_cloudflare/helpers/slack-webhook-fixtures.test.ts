import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  buildFakeExecutionContext,
  buildSlackEventRequest,
  buildSlackEventsBareRequest,
  buildSlackFakeEnv,
  buildSlackInteractionsRequest,
  FakeWebhookD1,
  installGithubReposFetchStub,
  resetSlackWebhookMocks,
  type SlackWebhookMocks,
  waitForAssertion,
} from "./slack-webhook-fixtures";

function makeMocks(): SlackWebhookMocks {
  return {
    postThreadReply: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    getConversationInfo: vi.fn(),
    getSlackBotUserId: vi.fn(),
    getThreadReplies: vi.fn(),
    hasSlackFileAttachments: vi.fn(),
    processSlackAttachments: vi.fn(),
    processSlackAttachmentsFromMessages: vi.fn(),
    fetchRepoSkills: vi.fn(),
    listAccessibleReposForUser: vi.fn(),
    postStructuredEventToDd: vi.fn(),
    queryOpenAIStructuredOutput: vi.fn(),
    verifySlackWebhookSignature: vi.fn(),
    getUserBySlackId: vi.fn(),
    getUserBySlackIdForTeam: vi.fn(),
    getUserBusinessIdOrNull: vi.fn(),
    isIntegrationAvailable: vi.fn(),
    getUserSettings: vi.fn(),
    getUserSettingsIfExists: vi.fn(),
    syncSessionProjection: vi.fn(),
    createSessionState: vi.fn(),
    enqueueSessionPrompt: vi.fn(),
    resolveInstalledSlackBotToken: vi.fn(),
  };
}

describe("buildSlackEventRequest", () => {
  it("wraps the text in an app_mention event addressed to UBOT123 by default", async () => {
    const req = buildSlackEventRequest("look here");
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://test/api/webhooks/slack/events");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("x-slack-request-timestamp")).toMatch(/^\d+$/);
    expect(req.headers.get("x-slack-signature")).toBe("v0=test");

    const body = (await req.json()) as { type: string; event_id: string; event: Record<string, unknown> };
    expect(body.type).toBe("event_callback");
    expect(body.event_id).toMatch(/^evt_\d+/);
    expect(body.event).toMatchObject({
      type: "app_mention",
      text: "<@UBOT123> look here",
      channel: "C_TEST",
      user: "U_SENDER",
    });
  });

  it("merges event overrides over the defaults and uses the provided event_id", async () => {
    const req = buildSlackEventRequest("ignored", {
      eventId: "Ev-stable",
      event: { type: "message", subtype: "bot_message", text: "explicit", files: [{ id: "F1" }] },
    });
    const body = (await req.json()) as { event_id: string; event: Record<string, unknown> };
    expect(body.event_id).toBe("Ev-stable");
    // Overrides win for `type`/`subtype`/`text`, defaults remain for channel/user/ts.
    expect(body.event).toMatchObject({
      type: "message",
      subtype: "bot_message",
      text: "explicit",
      files: [{ id: "F1" }],
      channel: "C_TEST",
      user: "U_SENDER",
    });
  });
});

describe("buildSlackEventsBareRequest", () => {
  it("returns the default signature headers and JSON content-type", () => {
    const req = buildSlackEventsBareRequest();
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("x-slack-request-timestamp")).toMatch(/^\d+$/);
    expect(req.headers.get("x-slack-signature")).toBe("v0=test-sig");
  });

  it("removes a header when overridden with null", () => {
    const req = buildSlackEventsBareRequest({ "x-slack-signature": null });
    expect(req.headers.get("x-slack-signature")).toBeNull();
    expect(req.headers.get("x-slack-request-timestamp")).not.toBeNull();
  });

  it("replaces a header when overridden with a string", () => {
    const req = buildSlackEventsBareRequest({ "x-slack-request-timestamp": "999" });
    expect(req.headers.get("x-slack-request-timestamp")).toBe("999");
  });

  it("uses the provided body", async () => {
    const req = buildSlackEventsBareRequest({}, JSON.stringify({ type: "url_verification", challenge: "abc" }));
    expect(await req.text()).toBe('{"type":"url_verification","challenge":"abc"}');
  });
});

describe("buildSlackInteractionsRequest", () => {
  it("returns a form-encoded interaction payload with default headers", async () => {
    const req = buildSlackInteractionsRequest();
    expect(req.url).toBe("https://test/api/webhooks/slack/interactions");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req.headers.get("x-slack-signature")).toBe("v0=test-sig");

    const body = await req.text();
    const parsed = new URLSearchParams(body);
    expect(parsed.get("payload")).toBe('{"trigger_id":"t1","actions":[]}');
  });

  it("removes a header when overridden with null", () => {
    const req = buildSlackInteractionsRequest({ "x-slack-request-timestamp": null });
    expect(req.headers.get("x-slack-request-timestamp")).toBeNull();
  });
});

describe("buildSlackFakeEnv", () => {
  it("returns the canonical Slack secrets and a stubbed SESSION namespace", () => {
    const db = new FakeWebhookD1();
    const env = buildSlackFakeEnv(db) as Record<string, unknown>;
    expect(env.DB).toBe(db);
    expect(env.SLACK_SIGNING_SECRET).toBe("test-secret");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
    const session = env.SESSION as { get: () => unknown; idFromName: (name: string) => string };
    expect(typeof session.get).toBe("function");
    expect(session.idFromName("abc")).toBe("abc");
  });

  it("merges overrides over the defaults and lets callers delete defaults with undefined", () => {
    const db = new FakeWebhookD1();
    const env = buildSlackFakeEnv(db, {
      SLACK_BOT_TOKEN: undefined,
      EXTRA: "value",
    }) as Record<string, unknown>;
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.EXTRA).toBe("value");
    // Defaults that were not overridden remain.
    expect(env.SLACK_SIGNING_SECRET).toBe("test-secret");
  });
});

describe("buildFakeExecutionContext", () => {
  it("collects waitUntil promises and resolves them when flushed", async () => {
    const { ctx, waitUntilPromises, flush } = buildFakeExecutionContext();
    let resolved = false;
    ctx.waitUntil(
      (async () => {
        await Promise.resolve();
        resolved = true;
      })(),
    );
    expect(waitUntilPromises).toHaveLength(1);
    expect(resolved).toBe(false);
    await flush();
    expect(resolved).toBe(true);
  });
});

describe("waitForAssertion", () => {
  it("returns once the assertion stops throwing", async () => {
    let counter = 0;
    await waitForAssertion(() => {
      counter += 1;
      if (counter < 3) {
        throw new Error("not yet");
      }
    });
    expect(counter).toBeGreaterThanOrEqual(3);
  });

  it("rethrows the last assertion error after the timeout elapses", async () => {
    await expect(
      waitForAssertion(() => {
        throw new Error("never satisfied");
      }, 20),
    ).rejects.toThrow("never satisfied");
  });
});

describe("installGithubReposFetchStub", () => {
  let restore: (() => void) | null = null;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    restore?.();
    restore = null;
    // Belt-and-suspenders: tests must not leak fetch state.
    globalThis.fetch = originalFetch;
  });

  it("returns a synthetic 200 for api.github.com/repos requests", async () => {
    restore = installGithubReposFetchStub();
    const res = await globalThis.fetch("https://api.github.com/repos/acme/widgets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1 });
  });

  it("falls through for other URLs", async () => {
    const fallthrough = vi.fn().mockResolvedValue(new Response("fallthrough"));
    globalThis.fetch = fallthrough as unknown as typeof globalThis.fetch;
    restore = installGithubReposFetchStub();

    const res = await globalThis.fetch("https://example.test/other");
    expect(await res.text()).toBe("fallthrough");
    expect(fallthrough).toHaveBeenCalledOnce();
  });

  it("restores the original fetch on cleanup", async () => {
    const sentinel = vi.fn().mockResolvedValue(new Response("sentinel"));
    globalThis.fetch = sentinel as unknown as typeof globalThis.fetch;

    const cleanup = installGithubReposFetchStub();
    expect(globalThis.fetch).not.toBe(sentinel);
    cleanup();
    expect(globalThis.fetch).toBe(sentinel);
  });

  it("cleanup is idempotent and does not clobber a later fetch replacement", async () => {
    const original = vi.fn().mockResolvedValue(new Response("original"));
    globalThis.fetch = original as unknown as typeof globalThis.fetch;

    const cleanup = installGithubReposFetchStub();
    cleanup();
    expect(globalThis.fetch).toBe(original);

    // A later test setup installs its own fetch. A defensive second cleanup
    // call must not overwrite it with the captured original.
    const later = vi.fn().mockResolvedValue(new Response("later"));
    globalThis.fetch = later as unknown as typeof globalThis.fetch;
    cleanup();
    expect(globalThis.fetch).toBe(later);
  });
});

describe("resetSlackWebhookMocks", () => {
  it("installs the canonical defaults on every mock", async () => {
    const mocks = makeMocks();
    resetSlackWebhookMocks(mocks);

    await expect((mocks.postThreadReply as Mock)()).resolves.toEqual({ ok: true });
    await expect((mocks.addReaction as Mock)()).resolves.toEqual({ ok: true });
    await expect((mocks.getConversationInfo as Mock)()).resolves.toBeNull();
    await expect((mocks.getSlackBotUserId as Mock)()).resolves.toBe("UBOT123");
    await expect((mocks.getThreadReplies as Mock)()).resolves.toEqual([]);
    await expect((mocks.processSlackAttachments as Mock)()).resolves.toEqual({
      uploadedFiles: [],
      uploadedImages: [],
      skipped: [],
    });
    await expect((mocks.fetchRepoSkills as Mock)()).resolves.toEqual([]);
    await expect((mocks.listAccessibleReposForUser as Mock)()).resolves.toEqual({
      ok: true,
      repos: [],
      cacheStatus: "hit",
    });
    await expect((mocks.verifySlackWebhookSignature as Mock)()).resolves.toBe(true);
    await expect((mocks.getUserBySlackId as Mock)()).resolves.toEqual({ id: 1, login: "test-user" });
    await expect((mocks.getUserBySlackIdForTeam as Mock)()).resolves.toEqual({ id: 1, login: "test-user" });
    await expect((mocks.getUserBusinessIdOrNull as Mock)()).resolves.toBeNull();
    await expect((mocks.getUserSettings as Mock)()).resolves.toEqual({
      default_repo: null,
    });
    await expect((mocks.getUserSettingsIfExists as Mock)()).resolves.toEqual({});
    await expect((mocks.syncSessionProjection as Mock)()).resolves.toBeUndefined();
    await expect((mocks.resolveInstalledSlackBotToken as Mock)()).resolves.toBe("xoxb-team-token");
    await expect((mocks.createSessionState as Mock)(null, "session-from-claim")).resolves.toEqual({
      session: { sessionId: "session-from-claim" },
      replay: {},
    });
    await expect((mocks.enqueueSessionPrompt as Mock)(null, "session-from-claim")).resolves.toMatchObject({
      ok: true,
      status: 200,
      payload: { session: { sessionId: "session-from-claim" } },
    });
  });

  it("hasSlackFileAttachments default returns true only when files or attachments are non-empty", () => {
    const mocks = makeMocks();
    resetSlackWebhookMocks(mocks);

    expect(mocks.hasSlackFileAttachments(undefined)).toBe(false);
    expect(mocks.hasSlackFileAttachments({})).toBe(false);
    expect(mocks.hasSlackFileAttachments({ files: [] })).toBe(false);
    expect(mocks.hasSlackFileAttachments({ files: [{ id: "F1" }] })).toBe(true);
    expect(mocks.hasSlackFileAttachments({ attachments: [{ id: "A1" }] })).toBe(true);
  });

  it("clears prior call history and overrides on every reset", async () => {
    const mocks = makeMocks();
    resetSlackWebhookMocks(mocks);

    mocks.postThreadReply.mockResolvedValueOnce({ ok: false, error: "rate_limited" });
    await mocks.postThreadReply("first");
    expect(mocks.postThreadReply).toHaveBeenCalledOnce();

    resetSlackWebhookMocks(mocks);
    expect(mocks.postThreadReply).not.toHaveBeenCalled();
    await expect((mocks.postThreadReply as Mock)("second")).resolves.toEqual({ ok: true });
  });
});

describe("FakeWebhookD1", () => {
  it("inserts and looks up Slack thread session refs", async () => {
    const db = new FakeWebhookD1();
    await db
      .prepare("INSERT INTO slack_thread_session_refs (channel_id, thread_ts, session_id) VALUES (?, ?, ?)")
      .bind("C_TEST", "1.0", "session-1")
      .run();
    const duplicate = await db
      .prepare("INSERT INTO slack_thread_session_refs (channel_id, thread_ts, session_id) VALUES (?, ?, ?)")
      .bind("C_TEST", "1.0", "session-2")
      .run();

    const found = await db
      .prepare("SELECT session_id FROM slack_thread_session_refs WHERE channel_id = ? AND thread_ts = ?")
      .bind("C_TEST", "1.0")
      .first();
    expect(found).toEqual({ session_id: "session-1" });
    expect(duplicate.meta?.changes).toBe(0);

    const missing = await db
      .prepare("SELECT session_id FROM slack_thread_session_refs WHERE channel_id = ? AND thread_ts = ?")
      .bind("C_OTHER", "2.0")
      .first();
    expect(missing).toBeNull();
  });

  it("distinguishes conditional Slack thread deletes from session cleanup deletes", async () => {
    const db = new FakeWebhookD1();
    db.slackThreadSessionRefs.set("C_TEST:1.0", "session-1");
    db.slackThreadSessionRefs.set("C_TEST:2.0", "session-2");
    db.slackThreadSessionRefs.set("C_TEST:3.0", "session-2");

    const mismatched = await db
      .prepare("DELETE FROM slack_thread_session_refs WHERE channel_id = ? AND thread_ts = ? AND session_id = ?")
      .bind("C_TEST", "1.0", "session-2")
      .run();
    expect(mismatched.meta?.changes).toBe(0);
    expect(db.slackThreadSessionRefs.get("C_TEST:1.0")).toBe("session-1");

    const scoped = await db
      .prepare("DELETE FROM slack_thread_session_refs WHERE channel_id = ? AND thread_ts = ? AND session_id = ?")
      .bind("C_TEST", "1.0", "session-1")
      .run();
    expect(scoped.meta?.changes).toBe(1);
    expect(db.slackThreadSessionRefs.has("C_TEST:1.0")).toBe(false);

    const cleanup = await db
      .prepare("DELETE FROM slack_thread_session_refs WHERE session_id = ?")
      .bind("session-2")
      .run();
    expect(cleanup.meta?.changes).toBe(2);
    expect(db.slackThreadSessionRefs.size).toBe(0);
  });

  it("looks up session projection rows by session id", async () => {
    const db = new FakeWebhookD1();
    db.sessionIndex.add("session-1");

    await expect(
      db.prepare("SELECT session_id FROM session_index WHERE session_id = ? LIMIT 1").bind("session-1").first(),
    ).resolves.toEqual({ session_id: "session-1" });
    await expect(
      db.prepare("SELECT session_id FROM session_index WHERE session_id = ? LIMIT 1").bind("missing").first(),
    ).resolves.toBeNull();
  });

  it("dedupes webhook idempotency inserts on (source, idempotency_key) so different sources can reuse keys", async () => {
    const db = new FakeWebhookD1();
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO webhook_idempotency (idempotency_key, source, payload_hash) VALUES (?, ?, ?)",
    );

    const first = await stmt.bind("evt-1", "slack", "hash-a").run();
    expect(first.meta?.changes).toBe(1);

    // Re-inserting the same (key, source) is a no-op.
    const second = await stmt.bind("evt-1", "slack", "hash-a").run();
    expect(second.meta?.changes).toBe(0);

    // Same key under a different source must not collide with the slack row.
    const otherSource = await stmt.bind("evt-1", "github", "hash-a").run();
    expect(otherSource.meta?.changes).toBe(1);
  });

  it("throws on unhandled queries to surface fake/real drift", async () => {
    const db = new FakeWebhookD1();
    await expect(db.prepare("SELECT * FROM unknown_table").first()).rejects.toThrow(/Unhandled first query/);
    await expect(db.prepare("UPDATE unknown_table SET x = 1").run()).rejects.toThrow(/Unhandled run query/);
    await expect(db.prepare("SELECT * FROM unknown_table").all()).rejects.toThrow(/Unhandled all query/);
  });
});
