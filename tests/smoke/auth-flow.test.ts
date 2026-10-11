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

import { SESSION_TTL_MS } from "../../apps/control-plane-worker/src/auth/constants";
import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";
import { generateSandboxPromptCallbackToken } from "../../apps/control-plane-worker/src/utils";
import {
  apiTokenHeaders,
  createWorkerEnv,
  seedAuthUser,
  sessionTokenHeaders,
  workerFetch,
  type WorkerModule,
} from "./helpers";

describe("smoke: auth flow", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  it("API token auth -> create session -> access session -> list all sessions", async () => {
    const { env } = createWorkerEnv(workerModule);

    // API token has canAccessAllSessions: true
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: apiTokenHeaders(),
      body: JSON.stringify({
        sessionId: "s-api-auth",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.auth.authMode).toBe("admin_token");
    expect(createBody.auth.tokenSource).toBe("bearer");

    // Can access the session
    const getRes = await workerFetch(workerModule, env, "/api/sessions/s-api-auth", {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(getRes.status).toBe(200);

    // Can list all sessions (no owner filter)
    const listRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("session-token auth -> scoped to own sessions only", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "user-a-token", 2001, "userA");
    seedAuthUser(db, "user-b-token", 2002, "userB");

    // User A creates a session
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("user-a-token"),
      body: JSON.stringify({ sessionId: "s-user-a", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    // User B creates a session
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("user-b-token"),
      body: JSON.stringify({ sessionId: "s-user-b", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    // User A can only see their own session
    const listARes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { cookie: "session_token=user-a-token" },
    });
    expect(listARes.status).toBe(200);
    const listABody = await listARes.json();
    expect(listABody.sessions).toHaveLength(1);
    expect(listABody.sessions[0].sessionId).toBe("s-user-a");

    // User B can only see their own session
    const listBRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { cookie: "session_token=user-b-token" },
    });
    expect(listBRes.status).toBe(200);
    const listBBody = await listBRes.json();
    expect(listBBody.sessions).toHaveLength(1);
    expect(listBBody.sessions[0].sessionId).toBe("s-user-b");

    // API token sees both sessions
    const listAllRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(listAllRes.status).toBe(200);
    const listAllBody = await listAllRes.json();
    const sessionIds = listAllBody.sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    expect(sessionIds).toEqual(["s-user-a", "s-user-b"]);
  });

  it("cross-user access is denied for session operations", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 3001, "owner");
    seedAuthUser(db, "intruder-token", 3002, "intruder");

    // Owner creates session
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
      body: JSON.stringify({ sessionId: "s-private", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    // Intruder cannot GET the session
    const getRes = await workerFetch(workerModule, env, "/api/sessions/s-private", {
      headers: { cookie: "session_token=intruder-token" },
    });
    expect(getRes.status).toBe(404); // returns 404 to avoid leaking session existence

    // Intruder cannot send prompts
    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-private/prompts", {
      method: "POST",
      headers: sessionTokenHeaders("intruder-token"),
      body: JSON.stringify({ prompt: "hack" }),
    });
    expect(promptRes.status).toBe(404);

    // Intruder cannot close
    const closeRes = await workerFetch(workerModule, env, "/api/sessions/s-private/close", {
      method: "POST",
      headers: { cookie: "session_token=intruder-token" },
    });
    expect(closeRes.status).toBe(404);

    // Intruder cannot list events
    const eventsRes = await workerFetch(workerModule, env, "/api/sessions/s-private/events", {
      headers: { cookie: "session_token=intruder-token" },
    });
    expect(eventsRes.status).toBe(404);
  });

  it("unauthenticated requests to protected routes return 401", async () => {
    const { env } = createWorkerEnv(workerModule);

    // No auth header at all
    const noAuthRes = await workerFetch(workerModule, env, "/api/sessions");
    expect(noAuthRes.status).toBe(401);
    const noAuthBody = await noAuthRes.json();
    expect(noAuthBody.error).toBe("Unauthorized");

    // Invalid bearer token
    const badBearerRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(badBearerRes.status).toBe(401);

    // Invalid session cookie
    const badCookieRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { cookie: "session_token=nonexistent" },
    });
    expect(badCookieRes.status).toBe(401);

    // Malformed percent encoding in an untrusted cookie must not throw and become a 500.
    const malformedCookieRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { cookie: "session_token=abc%" },
    });
    expect(malformedCookieRes.status).toBe(401);
  });

  it("expired session token is rejected", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    // Set an expired token (expires_at in the past)
    db.setAuthToken("expired-token", {
      user_id: 4001,
      id: 4001,
      expires_at: 1, // epoch ms = 1, definitely expired
      login: "expired",
      name: null,
      email: null,
    });

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { cookie: "session_token=expired-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated logout requests without clearing cookies", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "logout=1",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("logs out authenticated users and clears the session cookie", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "logout-token", 4002, "logout-user");

    const res = await workerFetch(workerModule, env, "/auth/logout", {
      method: "POST",
      headers: sessionTokenHeaders("logout-token"),
    });

    expect(res.status).toBe(200);
    expect(db.authTokens.has("logout-token")).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("session_token=;");
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it("internal callback route accepts scoped prompt tokens when configured", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SANDBOX_CALLBACK_SECRET = "sandbox-callback-secret";
    seedAuthUser(db, "cb-user", 5001, "cbuser");

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("cb-user"),
      body: JSON.stringify({ sessionId: "s-callback-scoped", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    const enqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-callback-scoped/prompts", {
      method: "POST",
      headers: sessionTokenHeaders("cb-user"),
      body: JSON.stringify({ prompt: "test" }),
    });

    expect(enqueueRes.status).toBe(202);
    const enqueueBody = (await enqueueRes.json()) as {
      dispatch: { callback?: unknown; prompt?: unknown };
    };
    // ARC-1024: the enqueue response must not carry the callback credential.
    expect(enqueueBody.dispatch.callback).toBeUndefined();
    expect(enqueueBody.dispatch.prompt).toBeUndefined();

    // The internal callback route still accepts a properly scoped prompt token,
    // minted the same way the DO mints it.
    const scopedAuth = `Bearer ${await generateSandboxPromptCallbackToken(
      "s-callback-scoped",
      "p-1",
      "sandbox-callback-secret",
    )}`;
    expect(scopedAuth).toMatch(/^Bearer [A-Za-z0-9_.-]+$/);

    const scopedCb = await workerFetch(
      workerModule,
      env,
      "/internal/sandbox/sessions/s-callback-scoped/prompts/p-1/callback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: scopedAuth,
        },
        body: JSON.stringify({ success: true }),
      },
    );

    expect(scopedCb.status).toBe(200);
  });

  it("auth/github renders the Turnstile challenge when configured", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.GITHUB_CLIENT_ID = "test-client-id";
    env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";

    const res = await workerFetch(workerModule, env, "/auth/github");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.has("x-script-nonce")).toBe(false);
    const body = await res.text();
    const nonce = body.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeDefined();
    expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(body).toContain("cf-turnstile");
    expect(body).toContain("test-turnstile-site-key");
    expect(body).toContain('data-callback="arcTurnstilePass"');
  });

  it("auth/github requires Turnstile when WORKER_ENV is missing", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.GITHUB_CLIENT_ID = "test-client-id";
    env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
    env.WORKER_ENV = undefined;

    const res = await workerFetch(workerModule, env, "/auth/github");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("cf-turnstile");
    expect(body).toContain('data-callback="arcTurnstilePass"');
  });

  it("auth/github/sso preserves org action while applying Turnstile nonce wiring", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.GITHUB_CLIENT_ID = "test-client-id";
    env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";

    const res = await workerFetch(workerModule, env, "/auth/github/sso?org=test-org");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.has("x-script-nonce")).toBe(false);
    const body = await res.text();
    const nonce = body.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeDefined();
    expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(body).toContain('action="/auth/github/sso?org=test-org"');
    expect(body).toContain('data-callback="arcTurnstilePass"');
  });

  it("auth/github returns 503 when GitHub OAuth is not configured", async () => {
    const { env } = createWorkerEnv(workerModule);
    // GITHUB_CLIENT_ID is not set

    const res = await workerFetch(workerModule, env, "/auth/github");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("redirects unknown GitHub users to /pending and creates a pending_signups row", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.GITHUB_CLIENT_ID = "test-client-id";
    env.GITHUB_CLIENT_SECRET = "test-client-secret";
    env.FRONTEND_URL = "https://app.test";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_test123" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.github.com/user")) {
        return new Response(
          JSON.stringify({ id: 99999999, login: "stranger", name: "Stranger", email: "x@x.com", avatar_url: null }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const res = await workerFetch(workerModule, env, "/auth/callback?code=abc123&state=state123", {
        headers: { cookie: "oauth_state=state123" },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://app.test/pending");
      const setCookies = res.headers.getSetCookie();
      expect(setCookies.find((c: string) => c.startsWith("session_token="))).toBeUndefined();
      expect([...db.pendingSignups.values()].some((r) => r.github_id === 99999999)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("session_token cookie persists for the server session lifetime", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.GITHUB_CLIENT_ID = "test-client-id";
    env.GITHUB_CLIENT_SECRET = "test-client-secret";
    env.FRONTEND_URL = `http://localhost:${process.env.UI_PORT || "5173"}`;
    db.addBusinessUser(42162445, "parappally", ARCANIST_BUSINESS_ID);

    // Mock global fetch to simulate GitHub OAuth token exchange and user API
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "ghp_test123" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.github.com/user")) {
        return new Response(
          JSON.stringify({ id: 42162445, login: "parappally", name: "Test", email: "test@test.com", avatar_url: null }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    try {
      const res = await workerFetch(workerModule, env, "/auth/callback?code=test-code&state=abc123", {
        headers: { cookie: "oauth_state=abc123" },
      });

      expect(res.status).toBe(302);

      const setCookies = res.headers.getSetCookie();
      const sessionCookie = setCookies.find((c: string) => c.startsWith("session_token="));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
      expect(sessionCookie).toContain("Path=/");
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie).toContain("Secure");
      expect(sessionCookie).toContain("SameSite=Lax");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
