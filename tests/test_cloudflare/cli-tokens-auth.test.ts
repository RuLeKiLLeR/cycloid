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

// Mock service-level CLI token resolution so we control the outcome
const mockResolveCliToken = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/cli-tokens", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCliToken: (...args: unknown[]) => mockResolveCliToken(...args),
  };
});

import { createWorkerEnv, seedAuthUser } from "../smoke/helpers";
import { workerFetch, type WorkerModule } from "./helpers/worker-harness";

describe("CLI token auth middleware", () => {
  let workerModule: WorkerModule;
  let env: Record<string, unknown>;
  let db: ReturnType<typeof createWorkerEnv>["db"];

  const validUser = {
    id: 42,
    login: "cliuser",
    name: null,
    email: null,
    businessId: "biz-1",
    sharedSessions: false,
  };

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createWorkerEnv(workerModule);
    env = created.env;
    db = created.db;
    // Seed a regular session user for cookie-based tests
    seedAuthUser(db, "session-token-123", 1, "testuser");
  });

  // ---------------------------------------------------------------------------
  // arc_ prefix detection on bearer token
  // ---------------------------------------------------------------------------

  describe("bearer token with arc_ prefix", () => {
    it("routes to CLI token resolution", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        headers: {
          authorization: "Bearer arc_abc123def456",
          "content-type": "application/json",
        },
      });
      // Should reach the handler (200) rather than 401
      expect(res.status).toBe(200);
      expect(mockResolveCliToken).toHaveBeenCalledOnce();
    });

    it("returns 401 when CLI token resolution fails", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "invalid" });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        headers: {
          authorization: "Bearer arc_invalid_token",
          "content-type": "application/json",
        },
      });
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Cookie with arc_ prefix should NOT trigger CLI token resolution
  // ---------------------------------------------------------------------------

  describe("cookie with arc_ value", () => {
    it("does NOT route to CLI token resolution", async () => {
      // Even if the session_token cookie value starts with arc_,
      // it should go through normal session resolution, not CLI token path
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        headers: {
          cookie: "session_token=arc_something",
          "content-type": "application/json",
        },
      });
      // Should not call resolveCliToken -- falls through to normal session auth
      expect(mockResolveCliToken).not.toHaveBeenCalled();
      // Without a valid session, this returns 401
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // CLI token auth returns authMode "cli_token"
  // ---------------------------------------------------------------------------

  describe("authMode for CLI tokens", () => {
    it("returns authMode cli_token in auth info", async () => {
      // The authMode is set in authenticateRequest and checked by the router
      // for scope restriction. We verify the scope restriction works, which
      // proves authMode is set correctly.
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      // CLI tokens CAN access /api/cli-tokens
      const allowedRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
        headers: { authorization: "Bearer arc_valid_token" },
      });
      expect(allowedRes.status).toBe(200);

      // CLI tokens CANNOT access /api/settings (not in allowed list)
      const forbiddenRes = await workerFetch(workerModule, env, "/api/settings", {
        headers: { authorization: "Bearer arc_valid_token" },
      });
      // 403 proves the router sees authMode === "cli_token" and blocks it
      expect(forbiddenRes.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // CLI token scope restriction (router.ts)
  // ---------------------------------------------------------------------------

  describe("CLI token route scope restriction", () => {
    const authHeader = { authorization: "Bearer arc_test_token" };

    it("read-scoped CLI token can reach /api/repos", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const res = await workerFetch(workerModule, env, "/api/repos", {
        headers: authHeader,
      });
      // The route may fail later in this unit harness because GitHub fetches are blocked,
      // but a non-403 proves the CLI-token router allowlist admitted it.
      expect(res.status).not.toBe(403);
    });

    it("read-scoped CLI token cannot access /api/settings", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        headers: authHeader,
      });
      expect(res.status).toBe(403);
    });

    it("read-scoped CLI token can access /api/models", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: authHeader,
      });
      expect(res.status).toBe(200);
    });

    it("read-scoped CLI token can access allowed GET session and auth routes", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "read",
        tokenId: 123,
        user: { ...validUser, email: "cli@example.com" },
      });

      const res = await workerFetch(workerModule, env, "/api/sessions", {
        headers: authHeader,
      });
      expect(res.status).not.toBe(403);

      const detailRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id", {
        headers: authHeader,
      });
      expect(detailRes.status).not.toBe(403);

      const promptsRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/prompts", {
        headers: authHeader,
      });
      expect(promptsRes.status).not.toBe(403);

      const eventsRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/events", {
        headers: authHeader,
      });
      expect(eventsRes.status).not.toBe(403);

      const historyRes = await workerFetch(
        workerModule,
        env,
        "/api/sessions/some-session-id/events/history?prompt_id=p-1",
        {
          headers: authHeader,
        },
      );
      expect(historyRes.status).not.toBe(403);

      const usageRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/usage", {
        headers: authHeader,
      });
      expect(usageRes.status).not.toBe(403);

      const exportRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/export", {
        headers: authHeader,
      });
      expect(exportRes.status).not.toBe(403);

      const whoamiRes = await workerFetch(workerModule, env, "/api/auth/whoami", {
        headers: authHeader,
      });
      expect(whoamiRes.status).toBe(200);
      const whoami = (await whoamiRes.json()) as {
        tokenId: number;
        tokenScope: string;
        email: string;
        businessId: string;
      };
      expect(whoami.tokenId).toBe(123);
      expect(whoami.tokenScope).toBe("read");
      expect(whoami.email).toBe("cli@example.com");
      expect(whoami.businessId).toBe("biz-1");
    });

    it("read-scoped CLI token can inspect sandbox layer routes but cannot mutate them", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const inspectPaths = [
        "/api/businesses/biz-1/sandbox-layer/build-requests",
        "/api/businesses/biz-1/sandbox-layer/build-requests/build-1",
        "/api/businesses/biz-1/sandbox-layer/build-requests/build-1/logs",
        "/api/businesses/biz-1/sandbox-layer/assignments",
        "/api/businesses/biz-1/repos/acme/heavy/sandbox-layer/resolution",
      ];
      for (const path of inspectPaths) {
        const res = await workerFetch(workerModule, env, path, { headers: authHeader });
        if (res.status === 403) {
          const body = (await res.json()) as { error?: string };
          expect(body.error).not.toMatch(/CLI tokens/);
        }
      }

      const buildRes = await workerFetch(
        workerModule,
        env,
        "/api/businesses/biz-1/repos/acme/source/sandbox-layer/build-requests",
        {
          method: "POST",
          headers: { ...authHeader, "content-type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      expect(buildRes.status).toBe(403);
      const buildBody = (await buildRes.json()) as { error?: string };
      expect(buildBody.error).toMatch(/CLI tokens/);
    });

    it("write-scoped CLI token can reach sandbox layer mutation routes", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "write", user: validUser });

      const mutationRequests = [
        {
          path: "/api/businesses/biz-1/repos/acme/source/sandbox-layer/build-requests",
          init: { method: "POST", body: JSON.stringify({ ref: "main" }) },
        },
        {
          path: "/api/businesses/biz-1/sandbox-layer/default-source",
          init: {
            method: "PUT",
            body: JSON.stringify({ sourceRepoOwner: "acme", sourceRepoName: "source" }),
          },
        },
        {
          path: "/api/businesses/biz-1/sandbox-layer/default-source",
          init: { method: "DELETE" },
        },
        {
          path: "/api/businesses/biz-1/repos/acme/heavy/sandbox-layer/assignment",
          init: {
            method: "PUT",
            body: JSON.stringify({ sourceRepoOwner: "acme", sourceRepoName: "source" }),
          },
        },
        {
          path: "/api/businesses/biz-1/repos/acme/heavy/sandbox-layer/assignment",
          init: { method: "DELETE" },
        },
      ];

      for (const request of mutationRequests) {
        const res = await workerFetch(workerModule, env, request.path, {
          ...request.init,
          headers: { ...authHeader, "content-type": "application/json" },
        });
        if (res.status === 403) {
          const body = (await res.json()) as { error?: string };
          expect(body.error).not.toMatch(/CLI tokens/);
        }
      }
    });

    it("read-scoped CLI token rejects session mutations", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({ context: { repoUrl: "owner/repo" } }),
      });
      expect(createRes.status).toBe(403);

      const promptRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/prompts", {
        method: "POST",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "hi" }),
      });
      expect(promptRes.status).toBe(403);
    });

    it("write-scoped CLI token can access session mutations", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "write", user: validUser });

      const promptRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/prompts", {
        method: "POST",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "hi" }),
      });
      expect(promptRes.status).not.toBe(403);

      const stopRes = await workerFetch(workerModule, env, "/api/sessions/some-session-id/stop", {
        method: "POST",
        headers: authHeader,
      });
      expect(stopRes.status).not.toBe(403);
    });

    it("read-scoped CLI token can manage tokens without escalating", async () => {
      mockResolveCliToken.mockResolvedValue({ status: "ok", scope: "read", user: validUser });

      const listRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
        headers: authHeader,
      });
      expect(listRes.status).not.toBe(403);

      const createReadRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope: "read" }),
      });
      expect(createReadRes.status).not.toBe(403);

      const createWriteRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope: "write" }),
      });
      expect(createWriteRes.status).toBe(403);
    });

    it("regular session token can still access /api/settings", async () => {
      const res = await workerFetch(workerModule, env, "/api/settings", {
        headers: { cookie: "session_token=session-token-123" },
      });
      expect(res.status).not.toBe(403);
    });
  });
});
