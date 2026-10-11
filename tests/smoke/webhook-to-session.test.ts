import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

vi.mock("../../apps/control-plane-worker/src/github/issues", () => ({
  GITHUB_QA_STARTED_REACTION: "eyes",
  postIssueComment: async () => 101,
  postIssueCommentReaction: async () => undefined,
}));

// Default (no implementation) resolves to undefined -> mentions fail open and
// the raw `<@ID>` token is kept, so the existing assertions below stay valid.
// Individual tests set an implementation to exercise the resolution path.
const { getUserInfoMock } = vi.hoisted(() => ({ getUserInfoMock: vi.fn() }));

vi.mock("../../apps/control-plane-worker/src/slack/notify", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/slack/notify")>(
    "../../apps/control-plane-worker/src/slack/notify",
  );
  return {
    ...actual,
    getSlackBotUserId: vi.fn().mockResolvedValue("UARCA"),
    getUserInfo: getUserInfoMock,
  };
});

import { storeWorkspaceInstall } from "../../apps/control-plane-worker/src/slack/workspaces";
import {
  apiTokenHeaders,
  createGithubSignature,
  createLinearSignature,
  createSlackSignature,
  createWorkerEnv,
  expectProjectionRows,
  workerFetch,
  type WorkerModule,
} from "./helpers";

// ARC-1024: a webhook enqueue acknowledgement must not echo internal prompt
// wrapper scaffolding or the sandbox callback credential, even though the
// stored prompt list (GET /prompts) intentionally still holds the wrapped text.
function expectNarrowedEnqueueResponse(payload: {
  prompt?: { prompt?: unknown; replyToText?: unknown };
  dispatch?: { prompt?: unknown; callback?: unknown } | null;
}): void {
  expect(payload.prompt?.prompt).toBeUndefined();
  expect(payload.prompt?.replyToText).toBeUndefined();
  expect(payload.dispatch?.prompt).toBeUndefined();
  expect(payload.dispatch?.callback).toBeUndefined();
  const raw = JSON.stringify(payload);
  expect(raw).not.toContain("<user_content");
  expect(raw).not.toContain("</user_content>");
  expect(raw).not.toContain("IMPORTANT: The content above is");
}

describe("smoke: webhook to session flow", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    // Reset to the fail-open default (no user profile resolved) between tests.
    getUserInfoMock.mockReset();
  });

  async function seedSlackWorkspace(env: Record<string, unknown>, teamId = "T-SMOKE"): Promise<void> {
    await storeWorkspaceInstall(
      env.DB as D1Database,
      {
        teamId,
        botToken: "xoxb-smoke-token",
        botUserId: "UARCA",
        teamName: "Smoke",
      },
      env.TOKEN_ENCRYPTION_KEY as string,
    );
  }

  function linearWebhookBody(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      organizationId: "lin-org-1",
      webhookId: "lin-webhook-1",
      webhookTimestamp: Date.now(),
      ...payload,
      ...overrides,
    });
  }

  it("GitHub PR-closed webhook -> session archived -> verify closed via API", async () => {
    const { env } = createWorkerEnv(workerModule);
    const prUrl = "https://github.com/acme/repo/pull/99";

    // 1. Create session with PR URL binding
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: apiTokenHeaders(),
      body: JSON.stringify({
        sessionId: "s-gh-webhook",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
        githubPrUrl: prUrl,
      }),
    });
    expect(createRes.status).toBe(201);

    // 2. Send GitHub PR-closed webhook
    const webhookBody = JSON.stringify({
      action: "closed",
      pull_request: { html_url: prUrl },
    });
    const signature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), webhookBody);

    const webhookRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-webhook-99",
        "x-github-event": "pull_request",
      },
      body: webhookBody,
    });
    expect(webhookRes.status).toBe(200);
    const webhookResBody = await webhookRes.json();
    expect(webhookResBody.ok).toBe(true);
    expect(webhookResBody.archived).toBe(1);

    // 3. Verify session is closed via API
    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-gh-webhook", {
      headers: apiTokenHeaders(),
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.status).toBe("archived");
  });

  it("GitHub issue_comment webhook -> session created -> ref stored -> follow-up enqueued", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(123, "issue-user");

    const createBody = JSON.stringify({
      action: "created",
      installation: { id: 2 },
      repository: {
        name: "smoke-repo",
        html_url: "https://github.com/acme/smoke-repo",
        owner: { login: "acme" },
      },
      issue: {
        id: 9001,
        number: 73,
        title: "Fix the smoke flow",
        body: "The issue body should be included in the bootstrap prompt.",
        html_url: "https://github.com/acme/smoke-repo/issues/73",
      },
      comment: {
        id: 55,
        body: "@cycloid-dev fix the webhook flow",
      },
      sender: {
        id: 123,
        login: "issue-user",
        type: "User",
      },
    });
    const createSignature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), createBody);

    const createRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": createSignature,
        "x-github-delivery": "delivery-issue-create",
        "x-github-event": "issue_comment",
      },
      body: createBody,
    });
    expect(createRes.status).toBe(200);
    const createPayload = await createRes.json();
    expect(createPayload.ok).toBe(true);
    expect(createPayload.created).toBe(true);
    expect(createPayload.enqueued).toBe(true);
    expectNarrowedEnqueueResponse(createPayload);

    const sessionId = String(createPayload.sessionId);
    expectProjectionRows(db, sessionId, {
      ownerUserId: "1",
      status: "active",
      minReplaySequence: 1,
    });
    const replaySequenceAfterBootstrap = db.replay.get(sessionId)!.last_event_sequence;
    const storedRefs = db.sessionWebhookRefs.get("github_issue:9001");
    expect(storedRefs ? [...storedRefs] : []).toEqual([sessionId]);

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    expect(promptsRes.status).toBe(200);
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts).toHaveLength(1);
    expect(promptsBody.prompts[0].prompt).toContain("GitHub Issue: acme/smoke-repo#73");
    expect(promptsBody.prompts[0].prompt).toContain("The issue body should be included in the bootstrap prompt.");
    expect(promptsBody.prompts[0].prompt).toContain("fix the webhook flow");

    const followUpBody = JSON.stringify({
      action: "created",
      installation: { id: 2 },
      repository: {
        name: "smoke-repo",
        html_url: "https://github.com/acme/smoke-repo",
        owner: { login: "acme" },
      },
      issue: {
        id: 9001,
        number: 73,
        title: "Fix the smoke flow",
        body: "The issue body should be included in the bootstrap prompt.",
        html_url: "https://github.com/acme/smoke-repo/issues/73",
      },
      comment: {
        id: 56,
        body: "@cycloid-dev also add a regression test",
      },
      sender: {
        id: 123,
        login: "issue-user",
        type: "User",
      },
    });
    const followUpSignature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), followUpBody);

    const followUpRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": followUpSignature,
        "x-github-delivery": "delivery-issue-follow",
        "x-github-event": "issue_comment",
      },
      body: followUpBody,
    });
    expect(followUpRes.status).toBe(200);
    const followUpPayload = await followUpRes.json();
    expect(followUpPayload.ok).toBe(true);
    expect(followUpPayload.created).toBe(false);
    expect(followUpPayload.sessionId).toBe(sessionId);
    expectProjectionRows(db, sessionId, {
      ownerUserId: "1",
      status: "active",
      minReplaySequence: replaySequenceAfterBootstrap + 1,
    });

    const promptsRes2 = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    expect(promptsRes2.status).toBe(200);
    const promptsBody2 = await promptsRes2.json();
    expect(promptsBody2.prompts).toHaveLength(2);
    expect(promptsBody2.prompts[1].prompt).toBe("also add a regression test");
  });

  it("Slack app_mention -> session created -> prompt enqueued -> follow-up adds second prompt", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser(9001, "smoke-user", "U-SMOKE");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSecret = String(env.SLACK_SIGNING_SECRET);
    const threadTs = "1712345678.000500";

    // 1. Initial app_mention creates a new session
    const createBody = JSON.stringify({
      type: "event_callback",
      team_id: "T-SMOKE",
      event_id: "Ev-smoke-create",
      event: {
        type: "app_mention",
        text: "<@UARCA> repo=acme/smoke-repo, build the feature",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "user", user_id: "UARCA" }],
              },
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "repo=acme/smoke-repo, build the feature" }],
              },
            ],
          },
        ],
        channel: "C-SMOKE",
        ts: threadTs,
        user: "U-SMOKE",
      },
    });
    const createSignature = createSlackSignature(slackSecret, timestamp, createBody);
    const createRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": createSignature,
      },
      body: createBody,
    });
    expect(createRes.status).toBe(200);
    const createPayload = await createRes.json();
    expect(createPayload.ok).toBe(true);
    expect(createPayload.created).toBe(true);
    expect(createPayload.enqueued).toBe(true);
    expectNarrowedEnqueueResponse(createPayload);
    const sessionId = String(createPayload.sessionId);

    // 2. Verify session thread mapping was stored
    expect(db.slackThreadSessionRefs.get(`C-SMOKE:${threadTs}`)).toBe(sessionId);
    expect(db.sessionWebhookRefs.get(`slack_thread:C-SMOKE:${threadTs}`)).toEqual(new Set([sessionId]));

    // 3. Verify prompt was enqueued
    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    expect(promptsRes.status).toBe(200);
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts).toHaveLength(1);
    expect(promptsBody.prompts[0].prompt).toContain("build the feature");
    expect(promptsBody.prompts[0].replyToText).toBe("<@UARCA>\nrepo=acme/smoke-repo, build the feature");

    // 4. Follow-up message in same thread adds second prompt
    const followUpBody = JSON.stringify({
      type: "event_callback",
      team_id: "T-SMOKE",
      event_id: "Ev-smoke-follow",
      event: {
        type: "app_mention",
        text: "<@UARCA> also add documentation",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "user", user_id: "UARCA" }],
              },
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "also add documentation" }],
              },
            ],
          },
        ],
        channel: "C-SMOKE",
        ts: "1712345678.000600",
        thread_ts: threadTs,
        user: "U-SMOKE",
      },
    });
    const followUpSignature = createSlackSignature(slackSecret, timestamp, followUpBody);
    const followUpRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": followUpSignature,
      },
      body: followUpBody,
    });
    expect(followUpRes.status).toBe(200);
    const followUpPayload = await followUpRes.json();
    expect(followUpPayload.created).toBe(false);
    expect(followUpPayload.sessionId).toBe(sessionId);
    expect(followUpPayload.enqueued).toBe(true);

    // 5. Verify two prompts now
    const promptsRes2 = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    const promptsBody2 = await promptsRes2.json();
    expect(promptsBody2.prompts).toHaveLength(2);
    expect(promptsBody2.prompts[1].prompt).toContain("Current Slack message author: smoke-user.");
    expect(promptsBody2.prompts[1].prompt).not.toContain('<user_content source="slack_message"');
    expect(promptsBody2.prompts[1].prompt).toContain("also add documentation");
    expect(promptsBody2.prompts[1].replyToText).toBe("<@UARCA>\nalso add documentation");
  });

  it("Slack mentions resolve to display names (display strips ID, prompt keeps ID)", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser(9001, "smoke-user", "U-SMOKE");
    // Resolve the bot and a human teammate; leave any other ID unresolved.
    getUserInfoMock.mockImplementation(async (_token: string, userId: string) => {
      if (userId === "UARCA") return { id: "UARCA", displayName: "Cycloid", realName: null, name: null };
      if (userId === "U0HUMAN") return { id: "U0HUMAN", displayName: "Pat Human", realName: null, name: null };
      return null;
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSecret = String(env.SLACK_SIGNING_SECRET);
    const threadTs = "1712345678.000700";

    // 1. Create via app_mention. The session-view reply text resolves the bot
    //    mention to a bare @Name (display surface).
    const createBody = JSON.stringify({
      type: "event_callback",
      team_id: "T-SMOKE",
      event_id: "Ev-smoke-mentions",
      event: {
        type: "app_mention",
        text: "<@UARCA> repo=acme/smoke-repo, build the feature",
        channel: "C-SMOKE",
        ts: threadTs,
        user: "U-SMOKE",
      },
    });
    const createSignature = createSlackSignature(slackSecret, timestamp, createBody);
    const createRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": createSignature,
      },
      body: createBody,
    });
    expect(createRes.status).toBe(200);
    const createPayload = await createRes.json();
    expect(createPayload.created).toBe(true);
    const sessionId = String(createPayload.sessionId);

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts).toHaveLength(1);
    expect(promptsBody.prompts[0].replyToText).toContain("@Cycloid");
    expect(promptsBody.prompts[0].replyToText).not.toContain("<@UARCA>");

    // 2. Follow-up @mentioning the bot (required to add to the session) plus a
    //    human teammate, exercising both mention surfaces:
    //    - display reply text: bare @Name
    //    - agent prompt: @Name keeps the stable ID, `@Name (<@ID>)`
    const followUpBody = JSON.stringify({
      type: "event_callback",
      team_id: "T-SMOKE",
      event_id: "Ev-smoke-mentions-follow",
      event: {
        type: "app_mention",
        text: "<@UARCA> also ping <@U0HUMAN> for review",
        channel: "C-SMOKE",
        ts: "1712345678.000800",
        thread_ts: threadTs,
        user: "U-SMOKE",
      },
    });
    const followUpSignature = createSlackSignature(slackSecret, timestamp, followUpBody);
    const followUpRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": followUpSignature,
      },
      body: followUpBody,
    });
    expect(followUpRes.status).toBe(200);

    const promptsRes2 = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    const promptsBody2 = await promptsRes2.json();
    expect(promptsBody2.prompts).toHaveLength(2);

    const followUpPrompt = String(promptsBody2.prompts[1].prompt);
    expect(followUpPrompt).toContain("@Pat Human (<@U0HUMAN>)");

    const followUpReplyToText = String(promptsBody2.prompts[1].replyToText);
    expect(followUpReplyToText).toContain("@Pat Human");
    expect(followUpReplyToText).not.toContain("<@U0HUMAN>");
  });

  it("Slack attachments flow through new-session and follow-up prompts", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser(9003, "attachment-user", "U-ATTACH");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSecret = String(env.SLACK_SIGNING_SECRET);
    const threadTs = "1712345678.002000";
    const previousFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith("https://slack.com/api/files.info")) {
        const fileId = new URL(url).searchParams.get("file");
        const file =
          fileId === "FLOG"
            ? {
                id: "FLOG",
                name: "trace.log",
                mimetype: "text/plain",
                size: 16,
                url_private_download: "https://files.slack.com/files-pri/T/FLOG/trace.log",
              }
            : fileId === "FIMG"
              ? {
                  id: "FIMG",
                  name: "screen.png",
                  mimetype: "image/png",
                  size: 4,
                  url_private_download: "https://files.slack.com/files-pri/T/FIMG/screen.png",
                }
              : null;
        return Response.json(file ? { ok: true, file } : { ok: false, error: "file_not_found" });
      }
      if (url === "https://files.slack.com/files-pri/T/FLOG/trace.log") {
        return new Response("stack trace line", { headers: { "content-length": "16" } });
      }
      if (url === "https://files.slack.com/files-pri/T/FIMG/screen.png") {
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-length": "4" } });
      }
      return previousFetch(input as RequestInfo, init);
    };

    try {
      const createBody = JSON.stringify({
        type: "event_callback",
        team_id: "T-SMOKE",
        event_id: "Ev-smoke-attachment-create",
        event: {
          type: "app_mention",
          text: "<@UARCA> repo=acme/smoke-repo, inspect the log",
          channel: "C-SMOKE",
          ts: threadTs,
          user: "U-ATTACH",
          files: [{ id: "FLOG" }],
        },
      });
      const createSignature = createSlackSignature(slackSecret, timestamp, createBody);
      const createRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": createSignature,
        },
        body: createBody,
      });
      expect(createRes.status).toBe(200);
      const createPayload = await createRes.json();
      expect(createPayload.enqueued).toBe(true);
      const sessionId = String(createPayload.sessionId);

      const followUpBody = JSON.stringify({
        type: "event_callback",
        team_id: "T-SMOKE",
        event_id: "Ev-smoke-attachment-follow",
        event: {
          type: "app_mention",
          text: "<@UARCA> and compare with this screenshot",
          channel: "C-SMOKE",
          ts: "1712345678.002100",
          thread_ts: threadTs,
          user: "U-ATTACH",
          files: [{ id: "FIMG" }],
        },
      });
      const followUpSignature = createSlackSignature(slackSecret, timestamp, followUpBody);
      const followUpRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": followUpSignature,
        },
        body: followUpBody,
      });
      expect(followUpRes.status).toBe(200);
      const followUpPayload = await followUpRes.json();
      expect(followUpPayload.enqueued).toBe(true);

      const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
        headers: apiTokenHeaders(),
      });
      expect(promptsRes.status).toBe(200);
      const promptsBody = await promptsRes.json();
      expect(promptsBody.prompts).toHaveLength(2);
      expect(promptsBody.prompts[0].uploadedFiles).toEqual([{ name: "trace.log" }]);
      expect(promptsBody.prompts[0].prompt).not.toContain("files.slack.com");
      expect(promptsBody.prompts[1].uploadedImages).toEqual([
        { name: "screen.png", mediaType: "image/png", data: "iVBORw==" },
      ]);
      expect(promptsBody.prompts[1].prompt).not.toContain("files.slack.com");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("Slack stop command in thread -> session closed", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser(9002, "stop-user", "U-STOP");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSecret = String(env.SLACK_SIGNING_SECRET);
    const threadTs = "1712345678.001000";

    // Create session via app_mention
    const createBody = JSON.stringify({
      type: "event_callback",
      team_id: "T-SMOKE",
      event_id: "Ev-smoke-stop-create",
      event: {
        type: "app_mention",
        text: "<@UARCA> repo=acme/repo, do something",
        channel: "C-STOP",
        ts: threadTs,
        user: "U-STOP",
      },
    });
    const createSignature = createSlackSignature(slackSecret, timestamp, createBody);
    const createRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": createSignature,
      },
      body: createBody,
    });
    const createPayload = await createRes.json();
    const sessionId = String(createPayload.sessionId);

    // Send stop command
    const stopBody = JSON.stringify({
      type: "event_callback",
      team_id: "T-SMOKE",
      event_id: "Ev-smoke-stop",
      event: {
        type: "message",
        text: "stop",
        channel: "C-STOP",
        ts: "1712345678.001100",
        thread_ts: threadTs,
        user: "U-STOP",
      },
    });
    const stopSignature = createSlackSignature(slackSecret, timestamp, stopBody);
    const stopRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": stopSignature,
      },
      body: stopBody,
    });
    expect(stopRes.status).toBe(200);
    const stopPayload = await stopRes.json();
    expect(stopPayload.stopped).toBe(true);

    // Verify session is closed
    const sessionRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}`, {
      headers: apiTokenHeaders(),
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.status).toBe("archived");
  });

  it("Linear webhook with mapped actor -> session created with real user as owner", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";
    // Seed a user with a connected Linear account
    db.addLinearUser(9010, "linear-user", "linear-uuid-abc");

    // 1. Create a session via Linear webhook with actor field
    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-abc", type: "User", name: "Test User" },
      data: {
        id: "lin-smoke-issue-1",
        identifier: "SMOKE-1",
        title: "Implement the smoke feature",
        description: "Test that linear webhooks create sessions correctly.",
        url: "https://linear.app/acme/issue/SMOKE-1/implement-the-smoke-feature",
        labels: [{ name: "cycloid" }, { name: "smoke" }],
        project: { name: "Smoke Tests" },
        team: { key: "SMOKE" },
        assignee: { name: "Test User" },
        priorityLabel: "Medium",
      },
    });
    const issueSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const issueRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": issueSignature,
        "linear-delivery": "lin-delivery-create-1",
      },
      body: issueBody,
    });
    expect(issueRes.status).toBe(200);
    const issuePayload = await issueRes.json();
    expect(issuePayload.ok).toBe(true);
    expect(issuePayload.created).toBe(true);
    expect(issuePayload.enqueued).toBe(true);
    expectNarrowedEnqueueResponse(issuePayload);
    const sessionId = String(issuePayload.sessionId);

    // 2. Verify linear issue ref stored
    expect(db.linearIssueSessionRefs.get("lin-smoke-issue-1")).toBe(sessionId);

    // 3. Verify prompt was enqueued with linear issue context
    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts).toHaveLength(1);
    expect(promptsBody.prompts[0].prompt).toContain("SMOKE-1");
    expect(promptsBody.prompts[0].prompt).toContain('<user_content source="linear_issue_title" author="linear_user">');
    expect(promptsBody.prompts[0].prompt).toContain("Implement the smoke feature");
    expect(promptsBody.prompts[0].prompt).toContain(
      '<user_content source="linear_issue_description" author="linear_user">',
    );
    expect(promptsBody.prompts[0].prompt).toContain("Test that linear webhooks create sessions correctly.");
    expect(promptsBody.prompts[0].prompt).toContain(
      '<user_content source="linear_issue_metadata" author="linear_user">',
    );
    expect(promptsBody.prompts[0].prompt).toContain("Labels: cycloid, smoke");
    expect(promptsBody.prompts[0].prompt).toContain("Project: Smoke Tests");
    expect(promptsBody.prompts[0].prompt).toContain("Team: SMOKE");
    expect(promptsBody.prompts[0].prompt).toContain("Assignee: Test User");
    expect(promptsBody.prompts[0].prompt).toContain("Priority: Medium");

    // 4. Verify session owner is the resolved Cycloid user (numeric ID), not "linear:webhook"
    const sessionRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}`, {
      headers: apiTokenHeaders(),
    });
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.ownerUserId).toBe("1");

    // 5. Duplicate webhook for same issue is skipped (session already exists)
    const duplicateBody = linearWebhookBody({
      type: "Issue",
      action: "update",
      actor: { id: "linear-uuid-abc", type: "User", name: "Test User" },
      data: {
        id: "lin-smoke-issue-1",
        identifier: "SMOKE-1",
        title: "Implement the smoke feature",
        labels: [{ name: "cycloid" }],
      },
    });
    const duplicateSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), duplicateBody);
    const duplicateRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": duplicateSignature,
        "linear-delivery": "lin-delivery-update-1",
      },
      body: duplicateBody,
    });
    expect(duplicateRes.status).toBe(200);
    const duplicatePayload = await duplicateRes.json();
    expect(duplicatePayload.skipped).toBe(true);
    expect(duplicatePayload.reason).toBe("session_already_exists");
    expect(duplicatePayload.sessionId).toBe(sessionId);
  });

  it("Linear webhook uses repo= from issue description before the default repo", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/default-linear-repo";
    db.addLinearUser(9011, "linear-description-repo-user", "linear-uuid-description-repo");

    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-description-repo", type: "User", name: "Description Repo User" },
      data: {
        id: "lin-description-repo-issue-1",
        identifier: "REPO-1",
        title: "Use the ticket repo directive",
        description: "repo=acme/description-repo\nImplement Array<T> handling without changing <xml> tags.",
        url: "https://linear.app/acme/issue/REPO-1/use-the-ticket-repo-directive",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const issueRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-description-repo-1",
      },
      body: issueBody,
    });
    expect(issueRes.status).toBe(200);
    const issuePayload = await issueRes.json();
    expect(issuePayload.ok).toBe(true);
    expect(issuePayload.created).toBe(true);
    const sessionId = String(issuePayload.sessionId);

    const sessionRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}`, {
      headers: apiTokenHeaders(),
    });
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.repoOwner).toBe("acme");
    expect(sessionBody.session.repoName).toBe("description-repo");

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].prompt).toContain("Repository: https://github.com/acme/description-repo");
    expect(promptsBody.prompts[0].prompt).not.toContain("Repository: https://github.com/acme/default-linear-repo");
    expect(promptsBody.prompts[0].prompt).not.toContain("repo=acme/description-repo");
    expect(promptsBody.prompts[0].prompt).toContain("Implement Array<T> handling without changing <xml> tags.");
  });

  it("Linear webhook falls back to default repo when the issue description repo= value is invalid", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/default-linear-repo";
    db.addLinearUser(9012, "linear-invalid-repo-user", "linear-uuid-invalid-repo");

    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-invalid-repo", type: "User", name: "Invalid Repo User" },
      data: {
        id: "lin-invalid-repo-issue-1",
        identifier: "REPO-2",
        title: "Fallback to default repo",
        description: "repo=not-a-valid-repo\nImplement this with the fallback default repo.",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const issueRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-invalid-repo-1",
      },
      body: issueBody,
    });
    expect(issueRes.status).toBe(200);
    const issuePayload = await issueRes.json();
    expect(issuePayload.ok).toBe(true);
    expect(issuePayload.created).toBe(true);
    const sessionId = String(issuePayload.sessionId);

    const sessionRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}`, {
      headers: apiTokenHeaders(),
    });
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.repoOwner).toBe("acme");
    expect(sessionBody.session.repoName).toBe("default-linear-repo");

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: apiTokenHeaders(),
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].prompt).toContain("Repository: https://github.com/acme/default-linear-repo");
    expect(promptsBody.prompts[0].prompt).not.toContain("repo=not-a-valid-repo");
    expect(promptsBody.prompts[0].prompt).toContain("Implement this with the fallback default repo.");
  });

  it("Linear webhook emits a clear error when the issue description repo= value is not authorized", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/default-linear-repo";
    db.addLinearUser(9013, "linear-unauthorized-repo-user", "linear-uuid-unauthorized-repo");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url === "https://api.github.com/repos/acme/forbidden-repo") {
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      }
      return previousFetch(input as RequestInfo, init);
    };

    try {
      const issueBody = linearWebhookBody({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-unauthorized-repo", type: "User", name: "Unauthorized Repo User" },
        data: {
          id: "lin-unauthorized-repo-issue-1",
          identifier: "REPO-3",
          title: "Do not fall back from unauthorized explicit repo",
          description: "repo=acme/forbidden-repo\nThis should not use the default repo.",
          labels: [{ name: "cycloid" }],
        },
      });
      const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
      const issueRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signature,
          "linear-delivery": "lin-delivery-unauthorized-repo-1",
        },
        body: issueBody,
      });
      expect(issueRes.status).toBe(200);
      const issuePayload = await issueRes.json();
      expect(issuePayload.ok).toBe(true);
      expect(issuePayload.skipped).toBe(true);
      expect(issuePayload.reason).toBe("repo_not_authorized");
      expect(issuePayload.error).toContain("acme/forbidden-repo");
      expect(db.linearIssueSessionRefs.get("lin-unauthorized-repo-issue-1")).toBeUndefined();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("Linear webhook with unmapped actor -> session skipped", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";

    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "unknown-linear-uuid", type: "User", name: "Unknown User" },
      data: {
        id: "lin-smoke-issue-unmapped",
        identifier: "SMOKE-2",
        title: "Should not create a session",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-unmapped-1",
      },
      body: issueBody,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toBe("linear_user_not_connected");
  });

  it("Linear webhook targeting repo owner without GitHub App installation -> session skipped early", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    // Point Linear default repo at an owner that has NOT been seeded with an installation
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/no-install-owner/some-repo";
    db.addLinearUser(9030, "no-install-user", "linear-uuid-no-install");

    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-no-install", type: "User", name: "No Install User" },
      data: {
        id: "lin-no-install-issue-1",
        identifier: "NOINST-1",
        title: "Issue targeting uninstalled repo owner",
        description: "Should be skipped before any session is created.",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-no-install-1",
      },
      body: issueBody,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toBe("no_installation");
    // No session should have been created for this linear issue
    expect(db.linearIssueSessionRefs.get("lin-no-install-issue-1")).toBeUndefined();
  });

  it("Linear webhook with description repo owner without GitHub App installation -> session skipped with error", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";
    db.addLinearUser(9031, "description-no-install-user", "linear-uuid-description-no-install");

    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-description-no-install", type: "User", name: "Description No Install User" },
      data: {
        id: "lin-description-no-install-issue-1",
        identifier: "NOINST-2",
        title: "Issue targeting uninstalled repo owner from description",
        description: "repo=no-install-owner/description-repo\nThis should not use the default repo.",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-description-no-install-1",
      },
      body: issueBody,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toBe("no_installation");
    expect(payload.error).toContain("no-install-owner/description-repo");
    expect(db.linearIssueSessionRefs.get("lin-description-no-install-issue-1")).toBeUndefined();
  });

  it("Linear webhook with non-user actor (Integration) -> session skipped", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";

    const issueBody = linearWebhookBody({
      type: "Issue",
      action: "update",
      actor: { id: "integration-id", type: "Integration", name: "GitHub Sync" },
      data: {
        id: "lin-smoke-issue-integration",
        identifier: "SMOKE-3",
        title: "Automated update",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), issueBody);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-integration-1",
      },
      body: issueBody,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toBe("non_user_actor");
  });

  it("Linear create-then-label-add: second webhook not dropped as duplicate", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";
    db.addLinearUser(9020, "label-user", "linear-uuid-label");

    // 1. Send create webhook WITHOUT the cycloid label (should be skipped)
    const createBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-label", type: "User", name: "Label User" },
      data: {
        id: "lin-label-issue-1",
        identifier: "LABEL-1",
        title: "Issue without label initially",
        labels: [],
      },
    });
    const createSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), createBody);
    const createRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": createSignature,
        "linear-delivery": "lin-delivery-label-create",
      },
      body: createBody,
    });
    expect(createRes.status).toBe(200);
    const createPayload = await createRes.json();
    expect(createPayload.skipped).toBe(true);
    expect(createPayload.reason).toBe("trigger_label_missing");

    // 2. Send update webhook for SAME issue WITH cycloid label added
    const updateBody = linearWebhookBody({
      type: "Issue",
      action: "update",
      actor: { id: "linear-uuid-label", type: "User", name: "Label User" },
      data: {
        id: "lin-label-issue-1",
        identifier: "LABEL-1",
        title: "Issue without label initially",
        description: "Now has the cycloid label.",
        labels: [{ name: "cycloid" }],
      },
    });
    const updateSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), updateBody);
    const updateRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": updateSignature,
        "linear-delivery": "lin-delivery-label-update",
      },
      body: updateBody,
    });
    expect(updateRes.status).toBe(200);
    const updatePayload = await updateRes.json();
    // The second webhook must NOT be dropped as a duplicate
    expect(updatePayload.ok).toBe(true);
    expect(updatePayload.created).toBe(true);
    expect(updatePayload.enqueued).toBe(true);
  });

  it("Linear idempotency: duplicate delivery ID is skipped", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";
    db.addLinearUser(9021, "dedup-user", "linear-uuid-dedup");

    const webhookBody = linearWebhookBody({
      type: "Issue",
      action: "create",
      actor: { id: "linear-uuid-dedup", type: "User", name: "Dedup User" },
      data: {
        id: "lin-dedup-issue-1",
        identifier: "DEDUP-1",
        title: "Dedup test issue",
        description: "Test deduplication.",
        labels: [{ name: "cycloid" }],
      },
    });
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), webhookBody);

    // First delivery succeeds
    const firstRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-dedup-same",
      },
      body: webhookBody,
    });
    expect(firstRes.status).toBe(200);
    const firstPayload = await firstRes.json();
    expect(firstPayload.ok).toBe(true);
    expect(firstPayload.created).toBe(true);

    // Second delivery with SAME linear-delivery header is dropped as duplicate
    // (even though body could differ slightly in practice)
    const secondRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-dedup-same",
      },
      body: webhookBody,
    });
    expect(secondRes.status).toBe(200);
    const secondPayload = await secondRes.json();
    expect(secondPayload.skipped).toBe(true);
    expect(secondPayload.reason).toBe("duplicate");
  });

  it("Linear issue claim allows only one session across concurrent deliveries", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/linear-repo";
    db.addLinearUser(9022, "claim-user", "linear-uuid-claim");

    // Two distinct deliveries (different bodies, so payload-hash idempotency
    // does not collapse them) racing to claim the same issue.
    const issueData = {
      id: "lin-claim-issue-1",
      identifier: "CLAIM-1",
      title: "Concurrent claim test issue",
      description: "Only one session should be created.",
      labels: [{ name: "cycloid" }],
    };
    const firstBody = linearWebhookBody({
      type: "Issue",
      action: "update",
      actor: { id: "linear-uuid-claim", type: "User", name: "Claim User" },
      data: issueData,
    });
    const secondBody = linearWebhookBody(
      {
        type: "Issue",
        action: "update",
        actor: { id: "linear-uuid-claim", type: "User", name: "Claim User" },
        data: issueData,
      },
      { webhookTimestamp: Date.now() + 1 },
    );

    const [firstRes, secondRes] = await Promise.all([
      workerFetch(workerModule, env, "/api/webhooks/linear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), firstBody),
          "linear-delivery": "lin-delivery-claim-a",
        },
        body: firstBody,
      }),
      workerFetch(workerModule, env, "/api/webhooks/linear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), secondBody),
          "linear-delivery": "lin-delivery-claim-b",
        },
        body: secondBody,
      }),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    const payloads = [await firstRes.json(), await secondRes.json()] as Array<Record<string, unknown>>;
    const createdPayloads = payloads.filter((payload) => payload.created === true);
    const skippedPayloads = payloads.filter((payload) => payload.skipped === true);

    expect(createdPayloads).toHaveLength(1);
    expect(skippedPayloads).toHaveLength(1);
    expect(skippedPayloads[0]).toMatchObject({ reason: "session_already_exists" });
    expect(skippedPayloads[0].sessionId).toBe(createdPayloads[0].sessionId);

    const sessionId = String(createdPayloads[0].sessionId);
    expect(db.linearIssueSessionRefs.get("lin-claim-issue-1")).toBe(sessionId);
    expect([...db.sessionIndex.keys()]).toEqual([sessionId]);
  });

  it("GitHub webhook idempotency: duplicate delivery is skipped", async () => {
    const { env } = createWorkerEnv(workerModule);
    const prUrl = "https://github.com/acme/repo/pull/42";

    // Create session with PR binding
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: apiTokenHeaders(),
      body: JSON.stringify({
        sessionId: "s-gh-idempotent",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
        githubPrUrl: prUrl,
      }),
    });

    const webhookBody = JSON.stringify({
      action: "closed",
      pull_request: { html_url: prUrl },
    });
    const signature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), webhookBody);
    const deliveryHeaders = {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-delivery": "delivery-idempotent-42",
      "x-github-event": "pull_request",
    };

    // First delivery succeeds
    const firstRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: deliveryHeaders,
      body: webhookBody,
    });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.archived).toBe(1);

    // Second delivery is idempotent
    const secondRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: deliveryHeaders,
      body: webhookBody,
    });
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("duplicate");
  });
});
