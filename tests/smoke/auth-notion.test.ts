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

import { createWorkerEnv, seedAuthUser, workerFetch, type WorkerModule } from "./helpers";

describe("smoke: Notion OAuth flow", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /auth/notion returns 503 when Notion OAuth is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);
    const res = await workerFetch(workerModule, env, "/auth/notion");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("GET /auth/notion redirects unauthenticated users to settings", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.FRONTEND_URL = "https://app.test";

    const res = await workerFetch(workerModule, env, "/auth/notion");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings");
  });

  it("GET /auth/notion redirects authenticated users to the Notion authorize URL", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CALLBACK_URL = "https://api.test/auth/notion/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const res = await workerFetch(workerModule, env, "/auth/notion", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("api.notion.com/v1/oauth/authorize");
    expect(location).toContain("client_id=notion-client");
    expect(location).toContain("redirect_uri=" + encodeURIComponent("https://api.test/auth/notion/callback"));
    expect(location).toContain("response_type=code");
    expect(res.headers.get("set-cookie")).toContain("notion_oauth_state=");
  });

  it("GET /auth/notion/callback returns 400 on state mismatch", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";

    const res = await workerFetch(workerModule, env, "/auth/notion/callback?code=abc&state=wrong", {
      headers: { cookie: "notion_oauth_state=correct" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid OAuth state");
  });

  it("GET /auth/notion/callback redirects to settings on token exchange failure", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/oauth/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return fetch(input, init);
    });

    const res = await workerFetch(workerModule, env, "/auth/notion/callback?code=badcode&state=validstate", {
      headers: { cookie: "notion_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?error=notion_connect_failed");
  });

  it("GET /auth/notion/callback fails closed when the Notion integration is disabled", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedAuthUser(db, "user-token", 1001, "testuser");
    db.setBusinessMembership(1001, "biz-disabled", "admin");
    db.businessIntegrations.set("biz-disabled:notion", {
      business_id: "biz-disabled",
      integration_id: "notion",
      scope: "disabled",
    });

    const res = await workerFetch(workerModule, env, "/auth/notion/callback?code=goodcode&state=validstate", {
      headers: { cookie: "notion_oauth_state=validstate; session_token=user-token" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?error=notion_connect_failed");

    const afterRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const afterBody = (await afterRes.json()) as { authenticated: boolean; user: { notionConnected: boolean } };
    expect(afterBody.authenticated).toBe(true);
    expect(afterBody.user.notionConnected).toBe(false);
  });

  it("GET /auth/notion/callback stores long-lived tokens and /auth/notion/disconnect clears them", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";
    env.NOTION_OAUTH_CALLBACK_URL = "https://api.test/auth/notion/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const beforeRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const beforeBody = (await beforeRes.json()) as { authenticated: boolean; user: { notionConnected: boolean } };
    expect(beforeBody.authenticated).toBe(true);
    expect(beforeBody.user.notionConnected).toBe(false);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "notion_access_123",
            bot_id: "bot-123",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/oauth/revoke")) {
        return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
      }
      return fetch(input, init);
    });

    const connectRes = await workerFetch(workerModule, env, "/auth/notion/callback?code=goodcode&state=validstate", {
      headers: { cookie: "notion_oauth_state=validstate; session_token=user-token" },
    });
    expect(connectRes.status).toBe(302);
    expect(connectRes.headers.get("location")).toBe("https://app.test/settings/integrations");

    const afterRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const afterBody = (await afterRes.json()) as { authenticated: boolean; user: { notionConnected: boolean } };
    expect(afterBody.authenticated).toBe(true);
    expect(afterBody.user.notionConnected).toBe(true);

    const disconnectRes = await workerFetch(workerModule, env, "/auth/notion/disconnect", {
      method: "POST",
      headers: { cookie: "session_token=user-token" },
    });
    expect(disconnectRes.status).toBe(200);

    const finalRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const finalBody = (await finalRes.json()) as { authenticated: boolean; user: { notionConnected: boolean } };
    expect(finalBody.authenticated).toBe(true);
    expect(finalBody.user.notionConnected).toBe(false);
  });

  it("GET /auth/notion/callback defaults expiry when Notion omits expires_in but returns a refresh token", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";
    env.NOTION_OAUTH_CALLBACK_URL = "https://api.test/auth/notion/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedAuthUser(db, "user-token", 1001, "testuser");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "notion_access_123",
            refresh_token: "notion_refresh_456",
            bot_id: "bot-123",
          }),
          { status: 200 },
        );
      }
      return fetch(input, init);
    });

    const before = Date.now();
    const connectRes = await workerFetch(workerModule, env, "/auth/notion/callback?code=goodcode&state=validstate", {
      headers: { cookie: "notion_oauth_state=validstate; session_token=user-token" },
    });
    const after = Date.now();

    expect(connectRes.status).toBe(302);
    const row = db.userIntegrations.get("1001:notion");
    expect(row?.oauth_expires_at).toBeGreaterThanOrEqual(before + 55 * 60 * 1000);
    expect(row?.oauth_expires_at).toBeLessThanOrEqual(after + 65 * 60 * 1000);
  });

  it("GET /auth/notion/callback preserves an immediate expiry when Notion returns expires_in=0", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.NOTION_OAUTH_CLIENT_ID = "notion-client";
    env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";
    env.NOTION_OAUTH_CALLBACK_URL = "https://api.test/auth/notion/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedAuthUser(db, "user-token", 1001, "testuser");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "notion_access_123",
            refresh_token: "notion_refresh_456",
            expires_in: 0,
            bot_id: "bot-123",
          }),
          { status: 200 },
        );
      }
      return fetch(input, init);
    });

    const before = Date.now();
    const connectRes = await workerFetch(workerModule, env, "/auth/notion/callback?code=goodcode&state=validstate", {
      headers: { cookie: "notion_oauth_state=validstate; session_token=user-token" },
    });
    const after = Date.now();

    expect(connectRes.status).toBe(302);
    const row = db.userIntegrations.get("1001:notion");
    expect(row?.oauth_expires_at).toBeGreaterThanOrEqual(before);
    expect(row?.oauth_expires_at).toBeLessThanOrEqual(after + 1000);
  });
});
