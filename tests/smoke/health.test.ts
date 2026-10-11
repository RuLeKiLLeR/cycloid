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

import { createWorkerEnv, seedAuthUser, sessionTokenHeaders, workerFetch, type WorkerModule } from "./helpers";

describe("smoke: health and public endpoints", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  it("GET /health returns 200 with service name", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.WORKER_ENV = "production";

    const res = await workerFetch(workerModule, env, "/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: "cycloid-control-plane-worker" });
    expect(body).not.toHaveProperty("environment");
  });

  it("GET /api/health returns 200 with service name", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.WORKER_ENV = "production";

    const res = await workerFetch(workerModule, env, "/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: "cycloid-control-plane-worker" });
    expect(body).not.toHaveProperty("environment");
  });

  it("GET /api/version returns 200 with only the public version string", async () => {
    const { env } = createWorkerEnv(workerModule);
    env.SENTRY_RELEASE = "d8dc738f0c4d1c9bb17d05a2b17c40cdd504cb8d";
    env.WORKER_ENV = "production";

    const res = await workerFetch(workerModule, env, "/api/version");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(body).not.toHaveProperty("commit");
    expect(body).not.toHaveProperty("environment");
  });

  it("public endpoints do not require auth headers", async () => {
    const { env } = createWorkerEnv(workerModule);

    // All public routes should work without any auth
    const healthRes = await workerFetch(workerModule, env, "/health");
    expect(healthRes.status).toBe(200);

    const apiHealthRes = await workerFetch(workerModule, env, "/api/health");
    expect(apiHealthRes.status).toBe(200);

    const authStatusRes = await workerFetch(workerModule, env, "/auth/status");
    expect(authStatusRes.status).toBe(200);
    await expect(authStatusRes.json()).resolves.toEqual({ authenticated: false });

    const versionRes = await workerFetch(workerModule, env, "/api/version");
    expect(versionRes.status).toBe(200);
    await expect(versionRes.json()).resolves.toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it("GET /auth/status returns only auth presence for a valid session", async () => {
    const { env } = createWorkerEnv(workerModule);
    seedAuthUser(env.DB, "status-user", 1002, "status-user");

    const res = await workerFetch(workerModule, env, "/auth/status", {
      headers: sessionTokenHeaders("status-user"),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: true });
  });

  it("GET /auth/status returns false for an expired session", async () => {
    const { env } = createWorkerEnv(workerModule);
    seedAuthUser(env.DB, "expired-status-user", 1003, "expired-status-user");
    const seededSession = env.DB.authTokens.get("expired-status-user");
    expect(seededSession).toBeDefined();
    seededSession!.expires_at = Date.now() - 1;

    const res = await workerFetch(workerModule, env, "/auth/status", {
      headers: sessionTokenHeaders("expired-status-user"),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
  });

  it("GET /auth/status clears stale impersonation without falling through to session auth", async () => {
    const { env } = createWorkerEnv(workerModule);
    seedAuthUser(env.DB, "status-session-user", 1004, "status-session-user");

    const res = await workerFetch(workerModule, env, "/auth/status", {
      headers: {
        cookie: "impersonation_token=stale-impersonation; session_token=status-session-user",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
    expect(res.headers.get("set-cookie")).toContain("impersonation_token=");
  });

  it("GET /auth/status returns transient status when auth session lookup fails", async () => {
    const { env } = createWorkerEnv(workerModule);
    seedAuthUser(env.DB, "status-db-error-user", 1005, "status-db-error-user");
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("SELECT 1 AS active FROM auth_sessions")) {
        throw new Error("db unavailable");
      }
      return originalPrepare(query);
    });

    const res = await workerFetch(workerModule, env, "/auth/status", {
      headers: sessionTokenHeaders("status-db-error-user"),
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    prepareSpy.mockRestore();
  });

  it("CORS preflight returns 204 for any path", async () => {
    const { env } = createWorkerEnv(workerModule);
    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("CORS preflight echoes an allowed origin", async () => {
    const { env } = createWorkerEnv(workerModule);
    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "OPTIONS",
      headers: { origin: "https://app.trycycloid.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.trycycloid.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("unknown routes return 404", async () => {
    const { env } = createWorkerEnv(workerModule);
    const res = await workerFetch(workerModule, env, "/api/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});
