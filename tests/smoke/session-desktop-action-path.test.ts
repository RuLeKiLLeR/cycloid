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

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { createWorkerEnv, seedAuthUser, sessionTokenHeaders, workerFetch, type WorkerModule } from "./helpers";

function createDenyingRateLimiter() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, allowed: false, remaining: 0 }), {
          headers: { "content-type": "application/json" },
        }),
    }),
  };
}

describe("smoke: session desktop action path", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  it("serves the authenticated snapshot and hides it from other users", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 2201, "owner", null, SEEDED_BUSINESS_IDS.cycloid);
    seedAuthUser(db, "intruder-token", 2202, "intruder", null, SEEDED_BUSINESS_IDS.cycloid);

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
      body: JSON.stringify({
        sessionId: "desktop-action-path-smoke",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createRes.status).toBe(201);

    const ownerRes = await workerFetch(
      workerModule,
      env,
      "/api/sessions/desktop-action-path-smoke/desktop/action-path",
      { headers: sessionTokenHeaders("owner-token") },
    );
    expect(ownerRes.status).toBe(200);
    await expect(ownerRes.json()).resolves.toEqual({ ok: true, rows: [], maxDesktopActionSeq: 0 });

    const intruderRes = await workerFetch(
      workerModule,
      env,
      "/api/sessions/desktop-action-path-smoke/desktop/action-path",
      { headers: sessionTokenHeaders("intruder-token") },
    );
    expect(intruderRes.status).toBe(404);
  });

  it("rate limits snapshot reads per viewer session", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 2203, "owner-rate", null, SEEDED_BUSINESS_IDS.cycloid);

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
      body: JSON.stringify({
        sessionId: "desktop-action-path-limited",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createRes.status).toBe(201);

    env.SESSION_RESUME_RATE_LIMITER = createDenyingRateLimiter();
    const limitedRes = await workerFetch(
      workerModule,
      env,
      "/api/sessions/desktop-action-path-limited/desktop/action-path",
      { headers: sessionTokenHeaders("owner-token") },
    );
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get("Retry-After")).toBe("2");
  });
});
