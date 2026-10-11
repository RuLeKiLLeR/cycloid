import { beforeAll, describe, expect, it, vi } from "vitest";

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

const mockGetSlackBotUserId = vi.fn().mockResolvedValue("BOT");

vi.mock("../../apps/control-plane-worker/src/slack/notify", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/slack/notify")>(
    "../../apps/control-plane-worker/src/slack/notify",
  );
  return {
    ...actual,
    getSlackBotUserId: (...args: unknown[]) => mockGetSlackBotUserId(...args),
  };
});

import { storeWorkspaceInstall } from "../../apps/control-plane-worker/src/slack/workspaces";
import { apiTokenHeaders, createSlackSignature, createWorkerEnv, seedAuthUser } from "../smoke/helpers";
import { workerFetch, type WorkerModule } from "./helpers/worker-harness";

async function seedSlackWorkspace(env: Record<string, unknown>, teamId = "T_TEST"): Promise<void> {
  await storeWorkspaceInstall(
    env.DB as D1Database,
    {
      teamId,
      botToken: "xoxb-test-token",
      botUserId: "UBOT",
      teamName: "Test Workspace",
    },
    String(env.TOKEN_ENCRYPTION_KEY),
  );
}

describe("slack link", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  describe("webhook handler resolves linked user for actorUserId", () => {
    it("uses real user ID when slack user is linked", async () => {
      expect(workerModule).toBeDefined();
      const { env, db } = createWorkerEnv(workerModule);
      await seedSlackWorkspace(env);

      // Seed a user with slack_user_id
      const githubId = 12345;
      const userId = db.addUser(githubId, "testlinkeduser");
      const user = db.users.get(githubId) as Record<string, unknown>;
      user.slack_user_id = "ULINKED";

      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T_TEST",
        event_id: "ev-linked-user-1",
        event: {
          type: "app_mention",
          text: "<@UBOT> repo=acme/repo, fix the bug",
          channel: "C456",
          ts: "1234567890.000002",
          user: "ULINKED",
        },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createSlackSignature(String(env.SLACK_SIGNING_SECRET), ts, body);

      const res = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.created).toBe(true);

      // Verify the session was created with the real user ID
      const sessionId = data.sessionId as string;
      const sessionRow = db.sessionIndex.get(sessionId);
      expect(sessionRow).toBeDefined();
      expect(sessionRow!.owner_user_id).toBe(String(userId));
    });
  });

  describe("GET /auth/slack", () => {
    it("redirects to Slack authorize when user is authenticated", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.SLACK_CLIENT_ID = "test-client-id";
      env.SLACK_OAUTH_CALLBACK_URL = "https://app.trycycloid.com/auth/slack/callback";

      seedAuthUser(db, "valid-token", 1, "testuser");

      const res = await workerFetch(workerModule, env, "/auth/slack", {
        headers: { cookie: "session_token=valid-token" },
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("https://slack.com/oauth/v2/authorize");
      expect(location).toContain("client_id=test-client-id");
      expect(location).toContain(encodeURIComponent("https://app.trycycloid.com/auth/slack/callback"));
    });

    it("redirects to settings when no session token", async () => {
      const { env } = createWorkerEnv(workerModule);
      env.SLACK_CLIENT_ID = "test-client-id";
      env.SLACK_OAUTH_CALLBACK_URL = "https://app.trycycloid.com/auth/slack/callback";
      env.FRONTEND_URL = "https://app.trycycloid.com";

      const res = await workerFetch(workerModule, env, "/auth/slack");

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://app.trycycloid.com/settings");
    });

    it("does not redirect loop when worker origin differs from callback origin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.SLACK_CLIENT_ID = "test-client-id";
      // Callback URL is on a different origin than the worker (worker.test)
      env.SLACK_OAUTH_CALLBACK_URL = "https://app.trycycloid.com/auth/slack/callback";

      seedAuthUser(db, "valid-token", 1, "testuser");

      const res = await workerFetch(workerModule, env, "/auth/slack", {
        headers: { cookie: "session_token=valid-token" },
      });

      // Should redirect to Slack, not back to /auth/slack (which would loop)
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("https://slack.com/oauth/v2/authorize");
      expect(location).not.toContain("worker.test");
    });

    it("returns 503 when SLACK_CLIENT_ID is not set", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/auth/slack");

      expect(res.status).toBe(503);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.error).toBe("Slack OAuth not configured");
    });
  });

  describe("session creation resolves slack:* ownerUserId", () => {
    it("resolves slack:ULINKED to real user ID", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      const githubId = 99999;
      const userId = db.addUser(githubId, "slacklinked");
      const user = db.users.get(githubId) as Record<string, unknown>;
      user.slack_user_id = "URESOLVED";

      const res = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: apiTokenHeaders(),
        body: JSON.stringify({
          sessionId: "s-slack-resolve",
          ownerUserId: "slack:URESOLVED",
          repoUrl: "https://github.com/test-owner/test-repo",
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.ok).toBe(true);

      const sessionRow = db.sessionIndex.get("s-slack-resolve");
      expect(sessionRow).toBeDefined();
      expect(sessionRow!.owner_user_id).toBe(String(userId));
    });

    it("rejects slack:* ownerUserId when not linked", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: apiTokenHeaders(),
        body: JSON.stringify({
          sessionId: "s-slack-unlinked",
          ownerUserId: "slack:UNOTLINKED",
          repoUrl: "https://github.com/test-owner/test-repo",
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.error).toBe("ownerUserId must be a positive integer");
      const sessionRow = db.sessionIndex.get("s-slack-unlinked");
      expect(sessionRow).toBeUndefined();
    });
  });
});
