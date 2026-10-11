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

import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";
import type { CreateDesktopViewTicketResponse } from "../../shared/types/desktop-viewer";
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

function sessionRequests(env: Record<string, unknown>, sessionId: string): Array<{ url: string; method: string }> {
  const namespace = env.SESSION as { _getRequests?: (id?: string) => Array<{ url: string; method: string }> };
  return namespace._getRequests?.(sessionId) ?? [];
}

describe("smoke: session desktop viewer tickets", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  it("creates same-origin view-only tickets without provider URLs or tokens", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 2401, "desktopowner", null, ARCANIST_BUSINESS_ID);

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
      body: JSON.stringify({
        sessionId: "desktop-viewer-smoke",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createRes.status).toBe(201);

    const ticketRes = await workerFetch(workerModule, env, "/api/sessions/desktop-viewer-smoke/desktop/view-ticket", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
    });
    expect(ticketRes.status).toBe(200);
    const body = (await ticketRes.json()) as CreateDesktopViewTicketResponse;
    expect(body.ticket.viewOnly).toBe(true);
    expect(body.ticket.websocketPath).toMatch(
      /^\/api\/sessions\/desktop-viewer-smoke\/desktop\/view-ticket\/[a-f0-9]{64}\/ws$/,
    );
    expect(body.ticket.heartbeatPath).toMatch(/\/heartbeat$/);
    expect(body.ticket.revokePath).not.toContain("heartbeat");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("e2b.app");
    expect(serialized).not.toContain("6080");
    expect(serialized).not.toContain("traffic");
    expect(serialized).not.toContain("token");

    const heartbeatRes = await workerFetch(workerModule, env, body.ticket.heartbeatPath, {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
    });
    expect(heartbeatRes.status).toBe(200);

    const revokeRes = await workerFetch(workerModule, env, body.ticket.revokePath, {
      method: "DELETE",
      headers: sessionTokenHeaders("owner-token"),
    });
    expect(revokeRes.status).toBe(200);

    const revokedHeartbeatRes = await workerFetch(workerModule, env, body.ticket.heartbeatPath, {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
    });
    expect(revokedHeartbeatRes.status).toBe(410);
  });

  it("rate limits ticket creation before touching SessionDO ticket state", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-token", 2402, "desktopratelimited", null, ARCANIST_BUSINESS_ID);

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("owner-token"),
      body: JSON.stringify({
        sessionId: "desktop-viewer-rate-limited",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createRes.status).toBe(201);
    const before = sessionRequests(env, "desktop-viewer-rate-limited").length;

    env.SESSION_RESUME_RATE_LIMITER = createDenyingRateLimiter();
    const limitedRes = await workerFetch(
      workerModule,
      env,
      "/api/sessions/desktop-viewer-rate-limited/desktop/view-ticket",
      {
        method: "POST",
        headers: sessionTokenHeaders("owner-token"),
      },
    );
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get("Retry-After")).toBe("2");

    const afterRequests = sessionRequests(env, "desktop-viewer-rate-limited");
    expect(afterRequests).toHaveLength(before);
    expect(afterRequests.some((request) => request.url.includes("/session/desktop/view-ticket"))).toBe(false);
  });
});
