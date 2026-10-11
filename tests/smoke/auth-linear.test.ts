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

function seedBusinessSessionUser(
  db: ReturnType<typeof createWorkerEnv>["db"],
  token: string,
  githubId: number,
  login: string,
  role: "admin" | "member" = "member",
): number {
  const userId = db.addBusinessUser(githubId, login, "biz-1");
  db.setBusinessMembership(userId, "biz-1", role);
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

describe("smoke: Linear OAuth flow", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /auth/linear returns 503 when Linear OAuth is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/auth/linear");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("GET /auth/linear redirects unauthenticated user to settings", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.FRONTEND_URL = "https://app.test";

    const res = await workerFetch(workerModule, env, "/auth/linear");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings");
  });

  it("GET /auth/linear redirects authenticated user to Linear authorize URL", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CALLBACK_URL = "https://api.test/auth/linear/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const res = await workerFetch(workerModule, env, "/auth/linear", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);

    const location = res.headers.get("location")!;
    expect(location).toContain("linear.app/oauth/authorize");
    expect(location).toContain("client_id=test-linear-client");
    expect(location).toContain("redirect_uri=" + encodeURIComponent("https://api.test/auth/linear/callback"));
    expect(location).toContain("scope=read,write,issues:create");
    expect(location).toContain("response_type=code");
    expect(location).not.toContain("prompt=consent");

    const cookies = res.headers.get("set-cookie")!;
    expect(cookies).toContain("linear_oauth_state=");
  });

  it("GET /auth/linear/business requires a business admin and redirects to Linear", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CALLBACK_URL = "https://api.test/auth/linear/callback";
    env.FRONTEND_URL = "https://app.test";
    seedBusinessSessionUser(db, "member-token", 1001, "member-user");
    seedBusinessSessionUser(db, "admin-token", 1002, "admin-user", "admin");

    const memberRes = await workerFetch(workerModule, env, "/auth/linear/business", {
      headers: { cookie: "session_token=member-token" },
    });
    expect(memberRes.status).toBe(302);
    expect(memberRes.headers.get("location")).toBe(
      "https://app.test/settings/business-integrations?error=linear_business_admin_required",
    );

    const adminRes = await workerFetch(workerModule, env, "/auth/linear/business", {
      headers: { cookie: "session_token=admin-token" },
    });
    expect(adminRes.status).toBe(302);
    const location = adminRes.headers.get("location")!;
    expect(location).toContain("linear.app/oauth/authorize");
    expect(location).toContain("scope=read,write,issues:create");
    expect(location).not.toContain("admin");
    expect(adminRes.headers.get("set-cookie")).toContain("linear_business_oauth_state=");
  });

  it("GET /auth/linear/business redirects to settings when Linear is disabled", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CALLBACK_URL = "https://api.test/auth/linear/callback";
    env.FRONTEND_URL = "https://app.test";
    seedBusinessSessionUser(db, "admin-token", 1002, "admin-user", "admin");
    db.setBusinessIntegrationScope("biz-1", "linear", "disabled");

    const res = await workerFetch(workerModule, env, "/auth/linear/business", {
      headers: { cookie: "session_token=admin-token" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/business-integrations?error=linear_integration_disabled",
    );
  });

  it("GET /auth/linear/callback returns 400 on state mismatch", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CLIENT_SECRET = "test-linear-secret";

    const res = await workerFetch(workerModule, env, "/auth/linear/callback?code=abc&state=wrong", {
      headers: { cookie: "linear_oauth_state=correct" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid OAuth state");
  });

  it("GET /auth/linear/callback returns 401 for unauthenticated user", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CLIENT_SECRET = "test-linear-secret";

    const res = await workerFetch(workerModule, env, "/auth/linear/callback?code=abc&state=validstate", {
      headers: { cookie: "linear_oauth_state=validstate" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("GET /auth/linear/callback redirects to settings on token exchange failure", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CLIENT_SECRET = "test-linear-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.linear.app/oauth/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/linear/callback?code=badcode&state=validstate", {
      headers: { cookie: "linear_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?error=linear_connect_failed");
  });

  it("GET /auth/linear/callback stores tokens and redirects to settings on success", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CLIENT_SECRET = "test-linear-secret";
    env.LINEAR_OAUTH_CALLBACK_URL = "https://api.test/auth/linear/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedBusinessSessionUser(db, "user-token", 1001, "testuser");

    const beforeRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const beforeBody = (await beforeRes.json()) as { authenticated: boolean; user: { linearConnected: boolean } };
    expect(beforeBody.authenticated).toBe(true);
    expect(beforeBody.user.linearConnected).toBe(false);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.linear.app/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "lin_access_123",
            refresh_token: "lin_refresh_456",
            expires_in: 5184000,
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.linear.app/graphql")) {
        return new Response(JSON.stringify({ data: { viewer: { id: "linear-viewer-uuid" } } }), { status: 200 });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/linear/callback?code=goodcode&state=validstate", {
      headers: { cookie: "linear_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations");

    // Verify the fetch mock was called with the right token exchange params
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const tokenCall = fetchCalls.find((call: unknown[]) => {
      const url =
        typeof call[0] === "string" ? call[0] : call[0] instanceof URL ? call[0].toString() : (call[0] as Request).url;
      return url.includes("api.linear.app/oauth/token");
    });
    expect(tokenCall).toBeDefined();
    const tokenReq = tokenCall![1] as RequestInit | undefined;
    expect(tokenReq?.method).toBe("POST");

    const afterRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const afterBody = (await afterRes.json()) as { authenticated: boolean; user: { linearConnected: boolean } };
    expect(afterBody.authenticated).toBe(true);
    expect(afterBody.user.linearConnected).toBe(true);
  });

  it("GET /auth/linear/callback stores business webhook organization mapping on business setup", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CLIENT_SECRET = "test-linear-secret";
    env.LINEAR_OAUTH_CALLBACK_URL = "https://api.test/auth/linear/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "admin-token", 1003, "linear-admin", "admin");
    db.addLinearWebhookInstallation("linear-org-business", "biz-1", "old-linear-webhook", userId);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.linear.app/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "lin_access_business",
            refresh_token: "lin_refresh_business",
            expires_in: 5184000,
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.linear.app/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: "linear-admin-uuid",
                organization: { id: "linear-org-business", name: "Cycloid Inc", urlKey: "cycloid" },
              },
            },
          }),
          { status: 200 },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/linear/callback?code=goodcode&state=businessstate", {
      headers: { cookie: "linear_business_oauth_state=businessstate; session_token=admin-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/business-integrations");

    const installation = db.linearWebhookInstallations.get("biz-1:linear-org-business");
    expect(installation).toMatchObject({
      business_id: "biz-1",
      linear_organization_id: "linear-org-business",
      linear_organization_name: "Cycloid Inc",
      linear_organization_url_key: "cycloid",
      linear_webhook_id: null,
      connected_by_user_id: userId,
      status: "active",
    });
  });

  it("GET /auth/linear/callback preserves stored workspace name when a reconnect returns no metadata", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_OAUTH_CLIENT_ID = "test-linear-client";
    env.LINEAR_OAUTH_CLIENT_SECRET = "test-linear-secret";
    env.LINEAR_OAUTH_CALLBACK_URL = "https://api.test/auth/linear/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "admin-token", 1004, "linear-admin2", "admin");
    db.addLinearWebhookInstallation("linear-org-business", "biz-1", "old-linear-webhook", userId);
    const seeded = db.linearWebhookInstallations.get("biz-1:linear-org-business")!;
    seeded.linear_organization_name = "Cycloid Inc";
    seeded.linear_organization_url_key = "cycloid";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.linear.app/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "lin_access_business",
            refresh_token: "lin_refresh_business",
            expires_in: 5184000,
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.linear.app/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: "linear-admin-uuid",
                organization: { id: "linear-org-business" },
              },
            },
          }),
          { status: 200 },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    const res = await workerFetch(workerModule, env, "/auth/linear/callback?code=goodcode&state=businessstate", {
      headers: { cookie: "linear_business_oauth_state=businessstate; session_token=admin-token" },
    });
    expect(res.status).toBe(302);

    const installation = db.linearWebhookInstallations.get("biz-1:linear-org-business");
    expect(installation?.linear_organization_name).toBe("Cycloid Inc");
    expect(installation?.linear_organization_url_key).toBe("cycloid");
  });

  it("POST /auth/linear/disconnect clears cached Linear status immediately", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "user-token", 1002, "linearuser");
    const now = Date.now();
    db.userIntegrations.set(`${userId}:linear`, {
      user_id: userId,
      integration_id: "linear",
      oauth_access_token: "encrypted-linear-token",
      oauth_refresh_token: "encrypted-linear-refresh",
      oauth_expires_at: now + 60_000,
      api_key: null,
      external_user_id: "linear-user-1",
      service_url: null,
      encrypted: 1,
      connected_at: now,
      updated_at: now,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.linear.app/oauth/revoke")) {
        return new Response(null, { status: 200 });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const beforeRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const beforeBody = (await beforeRes.json()) as { authenticated: boolean; user: { linearConnected: boolean } };
    expect(beforeBody.authenticated).toBe(true);
    expect(beforeBody.user.linearConnected).toBe(true);

    const disconnectRes = await workerFetch(workerModule, env, "/auth/linear/disconnect", {
      method: "POST",
      headers: { cookie: "session_token=user-token" },
    });
    expect(disconnectRes.status).toBe(200);

    const afterRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const afterBody = (await afterRes.json()) as { authenticated: boolean; user: { linearConnected: boolean } };
    expect(afterBody.authenticated).toBe(true);
    expect(afterBody.user.linearConnected).toBe(false);
  });
});
