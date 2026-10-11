import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { resetAuthMeUserCache } from "../../apps/control-plane-worker/src/auth/auth-me";
import { createSlackLinkToken } from "../../apps/control-plane-worker/src/slack/link-token";
import { createWorkerEnv, type FakeD1, seedAuthUser, workerFetch, type WorkerModule } from "./helpers";

const FRONTEND = "https://app.test";
const SIGNING_KEY = "test-slack-link-signing-key";

/** Seed an installed Slack workspace owned by the default smoke business (biz-1). */
function seedSlackWorkspace(db: FakeD1, teamId: string): void {
  db.slackWorkspaces.set(teamId, {
    team_id: teamId,
    bot_token_encrypted: "enc:dummy",
    bot_user_id: "U_BOT",
    team_name: "Biz Workspace",
    business_id: "biz-1",
    team_domain: null,
    enterprise_id: null,
    installed_by_user_id: 1001,
    installed_at: 1,
    updated_at: 1,
    uninstalled_at: null,
  });
}

describe("smoke: Slack magic-link routes", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
    resetAuthMeUserCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /auth/slack/link returns 503 when the signing key is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link?token=abc");
    expect(res.status).toBe(503);
  });

  it("GET /auth/slack/link redirects to settings when the token is missing", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${FRONTEND}/settings/integrations?error=slack_link_invalid`);
  });

  it("GET /auth/slack/link renders a sign-in prompt for an unauthenticated visitor", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link?token=abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Sign in to finish linking Slack");
  });

  it("GET /auth/slack/link redirects an authenticated user with an invalid token", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;
    seedAuthUser(db, "user-token", 1001, "testuser");

    const res = await workerFetch(workerModule, env, "/auth/slack/link?token=garbage", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${FRONTEND}/settings/integrations?error=slack_link_invalid`);
  });

  it("POST /auth/slack/link/confirm returns 503 when the signing key is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: { origin: FRONTEND, "content-type": "application/x-www-form-urlencoded" },
      body: "token=abc&csrf=x",
    });
    expect(res.status).toBe(503);
  });

  it("POST /auth/slack/link/confirm rejects a request from a foreign origin", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
      body: "token=abc&csrf=x",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("origin");
  });

  it("POST /auth/slack/link/confirm rejects when the origin header is missing", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=abc&csrf=x",
    });
    expect(res.status).toBe(403);
  });

  it("POST /auth/slack/link/confirm returns 401 when unauthenticated", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;

    const res = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: { origin: FRONTEND, "content-type": "application/x-www-form-urlencoded" },
      body: "token=abc&csrf=x",
    });
    expect(res.status).toBe(401);
  });

  it("POST /auth/slack/link/confirm rejects a missing or mismatched CSRF token", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = "k";
    env.FRONTEND_URL = FRONTEND;
    seedAuthUser(db, "user-token", 1001, "testuser");

    const mismatched = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: {
        origin: FRONTEND,
        "content-type": "application/x-www-form-urlencoded",
        cookie: "session_token=user-token; slack_link_csrf=cookie-value",
      },
      body: "token=abc&csrf=form-value",
    });
    expect(mismatched.status).toBe(403);

    const missing = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: {
        origin: FRONTEND,
        "content-type": "application/x-www-form-urlencoded",
        cookie: "session_token=user-token",
      },
      body: "token=abc",
    });
    expect(missing.status).toBe(403);
  });

  it("POST /auth/slack/link/confirm binds and redirects to the success page", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = SIGNING_KEY;
    env.FRONTEND_URL = FRONTEND;
    seedAuthUser(db, "user-token", 1001, "testuser");
    seedSlackWorkspace(db, "T_BIZ");
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const res = await workerFetch(workerModule, env, "/auth/slack/link/confirm", {
      method: "POST",
      headers: {
        origin: FRONTEND,
        "content-type": "application/x-www-form-urlencoded",
        cookie: "session_token=user-token; slack_link_csrf=csrf-value",
      },
      body: `token=${encodeURIComponent(token)}&csrf=csrf-value`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${FRONTEND}/settings/integrations?success=slack_link_success`);
    // The double-submit CSRF cookie is cleared on the confirm response.
    expect(res.headers.get("set-cookie")).toContain("slack_link_csrf=; Max-Age=0");
  });

  it("POST /auth/slack/link/confirm is idempotent on a double-submit (the ticket repro)", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_LINK_SIGNING_KEY = SIGNING_KEY;
    env.FRONTEND_URL = FRONTEND;
    seedAuthUser(db, "user-token", 1001, "testuser");
    seedSlackWorkspace(db, "T_BIZ");
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const post = () =>
      workerFetch(workerModule, env, "/auth/slack/link/confirm", {
        method: "POST",
        headers: {
          origin: FRONTEND,
          "content-type": "application/x-www-form-urlencoded",
          cookie: "session_token=user-token; slack_link_csrf=csrf-value",
        },
        body: `token=${encodeURIComponent(token)}&csrf=csrf-value`,
      });

    const first = await post();
    expect(first.headers.get("location")).toBe(`${FRONTEND}/settings/integrations?success=slack_link_success`);

    // Second POST of the same form. Before the fix this landed on
    // ?error=slack_link_already_bound; it must still be the success page.
    const second = await post();
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe(`${FRONTEND}/settings/integrations?success=slack_link_success`);
  });
});
