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

const SINGLE_SITE = [{ id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" }];
const MULTI_SITES = [
  { id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" },
  { id: "cloud-2", url: "https://other.atlassian.net", name: "Other" },
];

function mockAtlassianFetch(options: {
  tokenStatus?: number;
  sites?: Array<{ id: string; url: string; name: string }> | null;
  accountId?: string | null;
  webhookRegistrationStatus?: number;
}): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/rest/api/3/webhook")) {
      if (options.webhookRegistrationStatus && options.webhookRegistrationStatus >= 400) {
        return new Response(JSON.stringify({ errorMessages: ["forbidden"] }), {
          status: options.webhookRegistrationStatus,
        });
      }
      return new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 7001 }] }), {
        status: 200,
      });
    }
    if (url.includes("auth.atlassian.com/oauth/token")) {
      if (options.tokenStatus && options.tokenStatus >= 400) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: options.tokenStatus });
      }
      return new Response(
        JSON.stringify({ access_token: "jira_access_123", refresh_token: "jira_refresh_456", expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (url.includes("api.atlassian.com/oauth/token/accessible-resources")) {
      if (options.sites === null) {
        return new Response("server error", { status: 500 });
      }
      return new Response(JSON.stringify(options.sites ?? SINGLE_SITE), { status: 200 });
    }
    if (url.includes("api.atlassian.com/me")) {
      if (options.accountId === null) {
        return new Response("unavailable", { status: 500 });
      }
      return new Response(JSON.stringify({ account_id: options.accountId ?? "acct-1" }), { status: 200 });
    }
    return originalFetch(input);
  }) as typeof fetch;
}

describe("smoke: Jira OAuth flow", () => {
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

  it("GET /auth/jira returns 503 when Jira OAuth is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/auth/jira");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("GET /auth/jira redirects unauthenticated user to settings", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.FRONTEND_URL = "https://app.test";

    const res = await workerFetch(workerModule, env, "/auth/jira");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings");
  });

  it("GET /auth/jira redirects authenticated user to the Atlassian authorize URL", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CALLBACK_URL = "https://api.test/auth/jira/callback";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");

    const res = await workerFetch(workerModule, env, "/auth/jira", {
      headers: { cookie: "session_token=user-token" },
    });
    expect(res.status).toBe(302);

    const location = res.headers.get("location")!;
    expect(location).toContain("auth.atlassian.com/authorize");
    expect(location).toContain("audience=api.atlassian.com");
    expect(location).toContain("client_id=test-jira-client");
    expect(location).toContain("redirect_uri=" + encodeURIComponent("https://api.test/auth/jira/callback"));
    expect(location).toContain(
      encodeURIComponent("read:jira-work write:jira-work read:jira-user read:me offline_access"),
    );
    expect(location).not.toContain(encodeURIComponent("manage:jira-webhook"));
    expect(location).toContain("response_type=code");
    expect(location).toContain("prompt=consent");

    const cookies = res.headers.get("set-cookie")!;
    expect(cookies).toContain("jira_oauth_state=");
  });

  it("GET /auth/jira/business requires a business admin and requests webhook scopes", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CALLBACK_URL = "https://api.test/auth/jira/callback";
    env.FRONTEND_URL = "https://app.test";
    seedBusinessSessionUser(db, "member-token", 1001, "member-user");
    seedBusinessSessionUser(db, "admin-token", 1002, "admin-user", "admin");

    const memberRes = await workerFetch(workerModule, env, "/auth/jira/business", {
      headers: { cookie: "session_token=member-token" },
    });
    expect(memberRes.status).toBe(302);
    expect(memberRes.headers.get("location")).toBe(
      "https://app.test/settings/business-integrations?error=jira_business_admin_required",
    );

    const adminRes = await workerFetch(workerModule, env, "/auth/jira/business", {
      headers: { cookie: "session_token=admin-token" },
    });
    expect(adminRes.status).toBe(302);
    const location = adminRes.headers.get("location")!;
    expect(location).toContain("auth.atlassian.com/authorize");
    expect(location).toContain(encodeURIComponent("manage:jira-webhook"));
    expect(adminRes.headers.get("set-cookie")).toContain("jira_business_oauth_state=");
  });

  it("GET /auth/jira/business redirects to settings when Jira is disabled", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.FRONTEND_URL = "https://app.test";
    seedBusinessSessionUser(db, "admin-token", 1002, "admin-user", "admin");
    db.setBusinessIntegrationScope("biz-1", "jira", "disabled");

    const res = await workerFetch(workerModule, env, "/auth/jira/business", {
      headers: { cookie: "session_token=admin-token" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/business-integrations?error=jira_integration_disabled",
    );
  });

  it("GET /auth/jira/callback returns 400 on state mismatch", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=abc&state=wrong", {
      headers: { cookie: "jira_oauth_state=correct" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid OAuth state");
  });

  it("GET /auth/jira/callback returns 401 for unauthenticated user", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=abc&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("GET /auth/jira/callback redirects to settings on token exchange failure", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    seedAuthUser(db, "user-token", 1001, "testuser");
    mockAtlassianFetch({ tokenStatus: 400 });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=badcode&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?error=jira_connect_failed");
  });

  it("GET /auth/jira/callback redirects with site-fetch error when accessible-resources fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedAuthUser(db, "user-token", 1001, "testuser");
    mockAtlassianFetch({ sites: null });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?error=jira_site_fetch_failed");
  });

  it("GET /auth/jira/callback auto-selects a single site, stores tokens and the site row", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.JIRA_OAUTH_CALLBACK_URL = "https://api.test/auth/jira/callback";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "user-token", 1001, "testuser");
    mockAtlassianFetch({ sites: SINGLE_SITE, accountId: "acct-42" });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations");

    const integration = db.userIntegrations.get(`${userId}:jira`);
    expect(integration).toBeDefined();
    expect(integration?.encrypted).toBe(1);
    expect(integration?.external_user_id).toBe("acct-42");
    // Tokens are stored encrypted, never verbatim.
    expect(integration?.oauth_access_token).not.toBe("jira_access_123");
    expect(integration?.oauth_refresh_token).not.toBe("jira_refresh_456");

    const site = db.jiraUserSites.get(userId);
    expect(site).toMatchObject({
      user_id: userId,
      jira_cloud_id: "cloud-1",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      jira_account_id: "acct-42",
    });
    expect(db.jiraPersonalDataReports.get("acct-42")).toMatchObject({
      jira_account_id: "acct-42",
      next_report_after: 0,
      last_error: null,
    });

    const meRes = await workerFetch(workerModule, env, "/auth/me", {
      headers: { cookie: "session_token=user-token" },
    });
    const meBody = (await meRes.json()) as {
      authenticated: boolean;
      user: { jiraConnected: boolean; jiraSiteName: string | null };
    };
    expect(meBody.authenticated).toBe(true);
    expect(meBody.user.jiraConnected).toBe(true);
    expect(meBody.user.jiraSiteName).toBe("Acme");
  });

  it("GET /auth/jira/callback warns when the account identity fetch fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "user-token", 1001, "testuser");
    // A stale mapping from a previous connection must not survive a reconnect
    // whose account identity cannot be verified.
    db.jiraUserSites.set(userId, {
      user_id: userId,
      jira_cloud_id: "cloud-old",
      site_url: "https://old.atlassian.net",
      site_name: "Old",
      jira_account_id: "acct-old",
    });
    mockAtlassianFetch({ sites: SINGLE_SITE, accountId: null });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/integrations?warning=jira_id_fetch_failed");
    expect(db.userIntegrations.get(`${userId}:jira`)).toBeDefined();
    // No account ID means no actor mapping row -- including any stale one.
    expect(db.jiraUserSites.get(userId)).toBeUndefined();
  });

  it("business callback binds the workspace installation with a server-side token", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "admin-token", 1003, "jira-admin", "admin");
    mockAtlassianFetch({ sites: SINGLE_SITE, accountId: "acct-admin" });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=businessstate", {
      headers: { cookie: "jira_business_oauth_state=businessstate; session_token=admin-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings/business-integrations");

    const installation = db.jiraWebhookInstallations.get("biz-1:cloud-1");
    expect(installation).toMatchObject({
      business_id: "biz-1",
      jira_cloud_id: "cloud-1",
      site_url: "https://acme.atlassian.net",
      connected_by_user_id: userId,
      status: "active",
    });
    expect(typeof installation?.installation_token).toBe("string");
    expect((installation?.installation_token as string).length).toBeGreaterThanOrEqual(64);
  });

  it("business callback rejects a member even with a forged business state cookie", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    seedBusinessSessionUser(db, "member-token", 1001, "member-user");
    mockAtlassianFetch({ sites: SINGLE_SITE });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=businessstate", {
      headers: { cookie: "jira_business_oauth_state=businessstate; session_token=member-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.test/settings/business-integrations?error=jira_business_admin_required",
    );
    expect(db.jiraWebhookInstallations.size).toBe(0);
  });

  it("multi-site callback holds tokens server-side and finalizes via the picker endpoints", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "user-token", 1001, "testuser");
    mockAtlassianFetch({ sites: MULTI_SITES, accountId: "acct-42" });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate; session_token=user-token" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("https://app.test/settings/integrations?jira_site_selection=");
    const nonce = new URL(location).searchParams.get("jira_site_selection")!;
    expect(nonce.length).toBeGreaterThanOrEqual(64);

    // Tokens are NOT stored yet; they are held in the pending row.
    expect(db.userIntegrations.get(`${userId}:jira`)).toBeUndefined();
    const pendingRow = db.jiraOAuthPending.get(nonce);
    expect(pendingRow).toBeDefined();
    expect(pendingRow?.token_payload).not.toContain("jira_access_123");

    // The picker lists the sites for the initiating user only.
    const sitesRes = await workerFetch(workerModule, env, `/auth/jira/pending?nonce=${nonce}`, {
      headers: { cookie: "session_token=user-token" },
    });
    expect(sitesRes.status).toBe(200);
    const sitesBody = (await sitesRes.json()) as { sites: Array<{ cloudId: string }> };
    expect(sitesBody.sites.map((site) => site.cloudId)).toEqual(["cloud-1", "cloud-2"]);

    // Another user cannot read or finalize the pending selection.
    seedBusinessSessionUser(db, "other-token", 2002, "otheruser");
    const otherRes = await workerFetch(workerModule, env, `/auth/jira/pending?nonce=${nonce}`, {
      headers: { cookie: "session_token=other-token" },
    });
    expect(otherRes.status).toBe(404);

    const finalizeRes = await workerFetch(workerModule, env, "/auth/jira/finalize", {
      method: "POST",
      headers: { cookie: "session_token=user-token", "content-type": "application/json" },
      body: JSON.stringify({ nonce, cloudId: "cloud-2" }),
    });
    expect(finalizeRes.status).toBe(200);

    const integration = db.userIntegrations.get(`${userId}:jira`);
    expect(integration).toBeDefined();
    expect(db.jiraUserSites.get(userId)).toMatchObject({ jira_cloud_id: "cloud-2" });

    // Single use: a replayed finalize is rejected.
    const replayRes = await workerFetch(workerModule, env, "/auth/jira/finalize", {
      method: "POST",
      headers: { cookie: "session_token=user-token", "content-type": "application/json" },
      body: JSON.stringify({ nonce, cloudId: "cloud-1" }),
    });
    expect(replayRes.status).toBe(404);
  });

  it("finalize rejects an unknown cloudId and an expired pending row", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.JIRA_OAUTH_CLIENT_ID = "test-jira-client";
    env.JIRA_OAUTH_CLIENT_SECRET = "test-jira-secret";
    env.FRONTEND_URL = "https://app.test";
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "user-token", 1001, "testuser");
    mockAtlassianFetch({ sites: MULTI_SITES, accountId: "acct-42" });

    const res = await workerFetch(workerModule, env, "/auth/jira/callback?code=goodcode&state=validstate", {
      headers: { cookie: "jira_oauth_state=validstate; session_token=user-token" },
    });
    const nonce = new URL(res.headers.get("location")!).searchParams.get("jira_site_selection")!;

    const badSiteRes = await workerFetch(workerModule, env, "/auth/jira/finalize", {
      method: "POST",
      headers: { cookie: "session_token=user-token", "content-type": "application/json" },
      body: JSON.stringify({ nonce, cloudId: "cloud-unknown" }),
    });
    expect(badSiteRes.status).toBe(400);

    // Expire the row and verify the finalize fails closed.
    const pendingRow = db.jiraOAuthPending.get(nonce)!;
    pendingRow.expires_at = Date.now() - 1;
    const expiredRes = await workerFetch(workerModule, env, "/auth/jira/finalize", {
      method: "POST",
      headers: { cookie: "session_token=user-token", "content-type": "application/json" },
      body: JSON.stringify({ nonce, cloudId: "cloud-1" }),
    });
    expect(expiredRes.status).toBe(404);
    expect(db.userIntegrations.get(`${userId}:jira`)).toBeUndefined();
  });

  it("DELETE /api/businesses/:id/integrations/jira/workspace revokes the binding for admins only", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const adminId = seedBusinessSessionUser(db, "admin-token", 1003, "jira-admin", "admin");
    seedBusinessSessionUser(db, "member-token", 1004, "jira-member");
    db.jiraWebhookInstallations.set("biz-1:cloud-1", {
      business_id: "biz-1",
      jira_cloud_id: "cloud-1",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      webhooks_json: null,
      installation_token: "tok-1",
      trigger_label: "cycloid",
      connected_by_user_id: adminId,
      status: "active",
      webhook_registered_at: null,
      webhook_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      revoked_at: null,
    });

    const unauthenticated = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/jira/workspace", {
      method: "DELETE",
    });
    expect(unauthenticated.status).toBe(401);

    const memberRes = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/jira/workspace", {
      method: "DELETE",
      headers: { cookie: "session_token=member-token" },
    });
    expect(memberRes.status).toBe(403);
    expect(db.jiraWebhookInstallations.get("biz-1:cloud-1")?.status).toBe("active");

    const adminRes = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/jira/workspace", {
      method: "DELETE",
      headers: { cookie: "session_token=admin-token" },
    });
    expect(adminRes.status).toBe(200);
    expect((await adminRes.json()) as Record<string, unknown>).toEqual({ ok: true, disconnected: true });
    expect(db.jiraWebhookInstallations.get("biz-1:cloud-1")?.status).toBe("revoked");
  });

  it("POST /auth/jira/disconnect removes the credential and the site mapping", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.TOKEN_ENCRYPTION_KEY = "test-token-encryption-key";
    const userId = seedBusinessSessionUser(db, "user-token", 1002, "jirauser");
    const now = Date.now();
    db.userIntegrations.set(`${userId}:jira`, {
      user_id: userId,
      integration_id: "jira",
      oauth_access_token: "encrypted-jira-token",
      oauth_refresh_token: "encrypted-jira-refresh",
      oauth_expires_at: now + 60_000,
      api_key: null,
      external_user_id: "acct-1",
      service_url: null,
      encrypted: 1,
      last_validated_at: null,
      last_validation_status: null,
      last_validation_reason_code: null,
      connected_at: now,
      updated_at: now,
    });
    db.jiraUserSites.set(userId, {
      user_id: userId,
      jira_cloud_id: "cloud-1",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      jira_account_id: "acct-1",
      created_at: now,
      updated_at: now,
    });
    db.jiraPersonalDataReports.set("acct-1", {
      jira_account_id: "acct-1",
      personal_data_updated_at: now,
      last_reported_at: null,
      next_report_after: 0,
      last_status: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    });

    const disconnectRes = await workerFetch(workerModule, env, "/auth/jira/disconnect", {
      method: "POST",
      headers: { cookie: "session_token=user-token" },
    });
    expect(disconnectRes.status).toBe(200);

    expect(db.userIntegrations.get(`${userId}:jira`)).toBeUndefined();
    expect(db.jiraUserSites.get(userId)).toBeUndefined();
    expect(db.jiraPersonalDataReports.get("acct-1")).toBeUndefined();
  });
});
