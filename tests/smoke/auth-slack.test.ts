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
import { getBotTokenForTeam } from "../../apps/control-plane-worker/src/slack/workspaces";
import { createWorkerEnv, seedAuthUser, workerFetch, type WorkerModule } from "./helpers";

function seedBusinessSessionUser(
  db: ReturnType<typeof createWorkerEnv>["db"],
  token: string,
  githubId: number,
  login: string,
): number {
  const userId = db.addBusinessUser(githubId, login, "biz-1");
  db.setAuthToken(token, {
    user_id: userId,
    id: userId,
    expires_at: Date.now() + 60_000,
    login,
    name: null,
    email: null,
    business_id: "biz-1",
  });
  return userId;
}

describe("smoke: Slack OAuth v2 flow", () => {
  // ci-sync
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
    // The /auth/me user cache is module-global; tests that hit /auth/me must
    // not leak cached users into each other.
    resetAuthMeUserCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /auth/slack returns 503 when Slack OAuth is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/auth/slack");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("GET /auth/slack redirects unauthenticated user to settings", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.FRONTEND_URL = "https://app.test";

    const res = await workerFetch(workerModule, env, "/auth/slack");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings");
  });

  it("GET /auth/slack redirects authenticated user to Slack OAuth v2 authorize URL", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_OAUTH_CALLBACK_URL = "https://api.test/auth/slack/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const res = await workerFetch(workerModule, env, "/auth/slack", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);

    const location = res.headers.get("location")!;
    expect(location).toContain("slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=test-slack-client");
    expect(location).toContain("redirect_uri=" + encodeURIComponent("https://api.test/auth/slack/callback"));
    // Only `search:read` is requested as a user scope; history scopes moved to
    // the bot via the workspace install, so they must no longer appear here.
    expect(location).toContain("user_scope=search%3Aread&");
    expect(location).not.toContain("channels%3Ahistory");
    expect(location).not.toContain("groups%3Ahistory");
    expect(location).not.toContain("im%3Ahistory");
    expect(location).not.toContain("mpim%3Ahistory");

    const cookies = res.headers.get("set-cookie")!;
    expect(cookies).toContain("slack_oauth_state=");
  });

  it("GET /auth/slack/install redirects an authenticated business admin to the Slack bot install URL", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");

    const res = await workerFetch(workerModule, env, "/auth/slack/install", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);

    const location = res.headers.get("location")!;
    expect(location).toContain("slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=test-slack-client");
    expect(location).toContain("redirect_uri=" + encodeURIComponent("https://app.test/auth/slack/install/callback"));
    expect(location).toContain("scope=");
    expect(location).toContain("app_mentions%3Aread");
    expect(location).toContain("chat%3Awrite");
    expect(location).toContain("files%3Awrite");
    expect(location).toContain("channels%3Ahistory");
    expect(location).toContain("groups%3Ahistory");
    expect(location).toContain("mpim%3Ahistory");
    expect(location).not.toContain("user_scope=");

    const cookies = res.headers.get("set-cookie")!;
    expect(cookies).toContain("slack_install_oauth_state=");
  });

  it("GET /auth/slack/install stores a whitelisted return target for the callback redirect", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");

    const res = await workerFetch(workerModule, env, "/auth/slack/install?returnTo=%2Fsettings%2Fintegrations", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);

    const cookies = res.headers.get("set-cookie")!;
    expect(cookies).toContain("slack_install_oauth_state=");
    expect(cookies).toContain("slack_install_return_to=/settings/integrations");
  });

  it("GET /auth/slack/install redirects a non-admin member with the admin-required code", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "member");

    const res = await workerFetch(workerModule, env, "/auth/slack/install", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/integrations?error=slack_business_admin_required",
    );
  });

  it("GET /auth/slack/callback returns 400 on state mismatch", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";

    const res = await workerFetch(workerModule, env, "/auth/slack/callback?code=abc&state=wrong", {
      headers: { cookie: "slack_oauth_state=correct" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid OAuth state");
  });

  it("GET /auth/slack/callback returns 401 for unauthenticated user", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";

    const res = await workerFetch(workerModule, env, "/auth/slack/callback?code=abc&state=validstate", {
      headers: { cookie: "slack_oauth_state=validstate" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("GET /auth/slack/callback redirects to settings on token exchange failure", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("slack.com/api/oauth.v2.access")) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/slack/callback?code=badcode&state=validstate", {
      headers: { cookie: "slack_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?error=slack_connect_failed");
  });

  it("GET /auth/slack/callback stores tokens and redirects to settings on success", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.SLACK_OAUTH_CALLBACK_URL = "https://api.test/auth/slack/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("slack.com/api/oauth.v2.access")) {
        return new Response(
          JSON.stringify({
            ok: true,
            authed_user: {
              id: "U_SLACK_123",
              access_token: "xoxp-user-access-token",
              token_type: "user",
              refresh_token: "xoxe-1-refresh-token",
              expires_in: 43200,
            },
          }),
          { status: 200 },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/slack/callback?code=goodcode&state=validstate", {
      headers: { cookie: "slack_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations");

    // Verify the fetch mock was called with the right token exchange params
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const tokenCall = fetchCalls.find((call: unknown[]) => {
      const url =
        typeof call[0] === "string" ? call[0] : call[0] instanceof URL ? call[0].toString() : (call[0] as Request).url;
      return url.includes("slack.com/api/oauth.v2.access");
    });
    expect(tokenCall).toBeDefined();
    const tokenReq = tokenCall![1] as RequestInit | undefined;
    expect(tokenReq?.method).toBe("POST");
  });

  it("GET /auth/slack/install/callback stores the workspace bot token and redirects with the success code", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.SLACK_INSTALL_CALLBACK_URL = "https://api.test/auth/slack/install/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("slack.com/api/oauth.v2.access")) {
        const body = init?.body as URLSearchParams;
        expect(body.get("redirect_uri")).toBe("https://api.test/auth/slack/install/callback");
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-customer-workspace-token",
            bot_user_id: "U_BOT_123",
            team: {
              id: "T_CUSTOMER",
              name: "Customer Workspace",
            },
          }),
          { status: 200 },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/slack/install/callback?code=goodcode&state=validstate", {
      headers: { cookie: "slack_install_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/workspace-integrations?success=slack_install_success",
    );

    const row = db.slackWorkspaces.get("T_CUSTOMER");
    expect(row).toBeDefined();
    expect(row!.bot_user_id).toBe("U_BOT_123");
    expect(row!.team_name).toBe("Customer Workspace");
    expect(row!.installed_by_user_id).toBe(1001);
    expect(row!.bot_token_encrypted).toContain("enc:");
    expect(row!.bot_token_encrypted).not.toContain("xoxb-customer-workspace-token");
    await expect(
      getBotTokenForTeam(env.DB as D1Database, "T_CUSTOMER", env.TOKEN_ENCRYPTION_KEY as string),
    ).resolves.toBe("xoxb-customer-workspace-token");

    // The /auth/me cache is invalidated by the callback, so the install signal
    // flips immediately after the redirect.
    const meRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const meBody = (await meRes.json()) as { user: { slackWorkspaceInstalled: boolean } };
    expect(meBody.user.slackWorkspaceInstalled).toBe(true);
  });

  it("GET /auth/slack/install/callback returns to personal integrations when requested by the install start", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("slack.com/api/oauth.v2.access")) {
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-customer-workspace-token",
            bot_user_id: "U_BOT_123",
            team: {
              id: "T_CUSTOMER",
              name: "Customer Workspace",
            },
          }),
          { status: 200 },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/slack/install/callback?code=goodcode&state=validstate", {
      headers: {
        cookie:
          "slack_install_oauth_state=validstate; slack_install_return_to=/settings/integrations; session_token=user-token",
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?success=slack_install_success");
    const cookies = res.headers.get("set-cookie")!;
    expect(cookies).toContain("slack_install_return_to=");
    expect(cookies).toContain("Max-Age=0");
  });

  it("GET /auth/slack/install/callback redirects a non-admin member without storing a token", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "member");

    const res = await workerFetch(workerModule, env, "/auth/slack/install/callback?code=goodcode&state=validstate", {
      headers: { cookie: "slack_install_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/integrations?error=slack_business_admin_required",
    );
    expect(db.slackWorkspaces.size).toBe(0);
  });

  it("GET /auth/slack/install/callback maps a Slack access_denied error to the approval-required code", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");

    const res = await workerFetch(
      workerModule,
      env,
      "/auth/slack/install/callback?error=access_denied&state=validstate",
      {
        headers: { cookie: "slack_install_oauth_state=validstate; session_token=user-token" },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/workspace-integrations?error=slack_workspace_approval_required",
    );
    expect(db.slackWorkspaces.size).toBe(0);
  });

  it("GET /auth/slack/install/callback rejects a second distinct workspace for the same business", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.SLACK_INSTALL_CALLBACK_URL = "https://api.test/auth/slack/install/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");
    db.slackWorkspaces.set("T_EXISTING", {
      team_id: "T_EXISTING",
      bot_token_encrypted: "enc:existing",
      bot_user_id: "U_BOT_EXISTING",
      team_name: "Existing Workspace",
      business_id: "biz-1",
      team_domain: null,
      enterprise_id: null,
      installed_by_user_id: 1001,
      installed_at: 100,
      updated_at: 100,
      uninstalled_at: null,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("slack.com/api/oauth.v2.access")) {
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-second-workspace-token",
            bot_user_id: "U_BOT_456",
            team: { id: "T_SECOND", name: "Second Workspace" },
          }),
          { status: 200 },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/slack/install/callback?code=goodcode&state=validstate", {
      headers: { cookie: "slack_install_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/workspace-integrations?error=slack_workspace_already_installed",
    );
    expect(db.slackWorkspaces.has("T_SECOND")).toBe(false);
  });

  it("GET /auth/slack/install/callback redirects to workspace integrations on token exchange failure", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_CLIENT_ID = "test-slack-client";
    env.SLACK_CLIENT_SECRET = "test-slack-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-1", "admin");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("slack.com/api/oauth.v2.access")) {
        return new Response(JSON.stringify({ ok: false, error: "bad_redirect_uri" }), { status: 200 });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/slack/install/callback?code=badcode&state=validstate", {
      headers: { cookie: "slack_install_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/workspace-integrations?error=slack_connect_failed",
    );
    expect(db.slackWorkspaces.size).toBe(0);
  });

  it("GET /auth/me reports slackWorkspaceInstalled from active business installs only", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedBusinessSessionUser(db, "user-token", 1001, "testuser");

    const fetchInstalled = async () => {
      const res = await workerFetch(workerModule, env, "/auth/me?fresh=1", {
        headers: { cookie: "session_token=user-token" },
      });
      const body = (await res.json()) as { user: { slackWorkspaceInstalled: boolean } };
      return body.user.slackWorkspaceInstalled;
    };

    await expect(fetchInstalled()).resolves.toBe(false);

    db.slackWorkspaces.set("T_BIZ", {
      team_id: "T_BIZ",
      bot_token_encrypted: "enc:token",
      bot_user_id: "U_BOT",
      team_name: "Biz Workspace",
      business_id: "biz-1",
      team_domain: null,
      enterprise_id: null,
      installed_by_user_id: 1001,
      installed_at: 100,
      updated_at: 100,
      uninstalled_at: null,
    });
    await expect(fetchInstalled()).resolves.toBe(true);

    db.slackWorkspaces.get("T_BIZ")!.uninstalled_at = 200;
    await expect(fetchInstalled()).resolves.toBe(false);
  });

  it("POST /api/internal/slack/workspaces/seed stores the existing env bot token", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_BOT_TOKEN = "xoxb-cycloid-workspace-token";

    const res = await workerFetch(workerModule, env, "/api/internal/slack/workspaces/seed", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        teamId: "T_CYCLOID",
        teamName: "Cycloid",
        botUserId: "U_CYCLOID_BOT",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      teamId: "T_CYCLOID",
      teamName: "Cycloid",
      botUserId: "U_CYCLOID_BOT",
    });

    const row = db.slackWorkspaces.get("T_CYCLOID");
    expect(row).toBeDefined();
    expect(row!.installed_by_user_id).toBeNull();
    expect(row!.bot_token_encrypted).not.toContain("xoxb-cycloid-workspace-token");
    await expect(
      getBotTokenForTeam(env.DB as D1Database, "T_CYCLOID", env.TOKEN_ENCRYPTION_KEY as string),
    ).resolves.toBe("xoxb-cycloid-workspace-token");
  });

  it("POST /api/internal/slack/workspaces/seed rejects body values that conflict with env workspace identity", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_BOT_TOKEN = "xoxb-cycloid-workspace-token";
    env.SLACK_WORKSPACE_TEAM_ID = "T_CYCLOID";
    env.SLACK_BOT_USER_ID = "U_CYCLOID_BOT";

    const res = await workerFetch(workerModule, env, "/api/internal/slack/workspaces/seed", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        teamId: "T_OTHER",
        botUserId: "U_CYCLOID_BOT",
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "teamId must match SLACK_WORKSPACE_TEAM_ID",
    });
    expect(db.slackWorkspaces.size).toBe(0);
  });

  it("POST /api/internal/slack/workspaces/seed handles malformed JSON as a structured 400", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SLACK_BOT_TOKEN = "xoxb-cycloid-workspace-token";

    const res = await workerFetch(workerModule, env, "/api/internal/slack/workspaces/seed", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "teamId or SLACK_WORKSPACE_TEAM_ID is required",
    });
    expect(db.slackWorkspaces.size).toBe(0);
  });

  it("GET /auth/me treats a magic-link identity binding (no OAuth token) as not needing reconnect", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const userId = seedBusinessSessionUser(db, "user-token", 1001, "testuser");
    const now = Date.now();
    // Identity-only row: external_user_id set, no OAuth token (magic-link bind).
    db.userIntegrations.set(`${userId}:slack`, {
      user_id: userId,
      integration_id: "slack",
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: "U_SLACK_LINKED",
      service_url: null,
      encrypted: 0,
      connected_at: now,
      updated_at: now,
    });

    const res = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const body = (await res.json()) as { user: { slackConnected: boolean; slackNeedsReconnect: boolean } };
    // search:read not connected, but the identity link must not read as broken.
    expect(body.user.slackConnected).toBe(false);
    expect(body.user.slackNeedsReconnect).toBe(false);
  });

  it("POST /auth/slack/disconnect clears cached Slack status immediately", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const userId = seedBusinessSessionUser(db, "user-token", 1001, "testuser");
    const now = Date.now();
    db.userIntegrations.set(`${userId}:slack`, {
      user_id: userId,
      integration_id: "slack",
      oauth_access_token: "encrypted-slack-token",
      oauth_refresh_token: "encrypted-slack-refresh",
      oauth_expires_at: now + 60_000,
      api_key: null,
      external_user_id: "U_SLACK_123",
      service_url: null,
      encrypted: 1,
      connected_at: now,
      updated_at: now,
    });

    const beforeRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const beforeBody = (await beforeRes.json()) as { authenticated: boolean; user: { slackConnected: boolean } };
    expect(beforeBody.authenticated).toBe(true);
    expect(beforeBody.user.slackConnected).toBe(true);

    const res = await workerFetch(workerModule, env, "/auth/slack/disconnect", {
      method: "POST",
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const afterRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const afterBody = (await afterRes.json()) as { authenticated: boolean; user: { slackConnected: boolean } };
    expect(afterBody.authenticated).toBe(true);
    expect(afterBody.user.slackConnected).toBe(false);
  });
});
