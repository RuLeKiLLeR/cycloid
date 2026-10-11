import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CLI_TOKEN_EXPIRY_DAYS } from "../../apps/control-plane-worker/src/constants/cli-tokens";

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

// Mock service functions to isolate route-level validation
const mockCreateCliToken = vi.fn();
const mockListCliTokensByUser = vi.fn();
const mockGetCliTokenForUser = vi.fn();
const mockRevokeCliToken = vi.fn();
const mockDeleteCliToken = vi.fn();
const mockResolveCliToken = vi.fn();
const mockBeginIdempotentRequest = vi.fn();
const mockCommitIdempotentRequest = vi.fn();
const mockReleaseIdempotentRequest = vi.fn();

vi.mock("../../apps/control-plane-worker/src/auth/cli-tokens", () => ({
  listCliTokensByUser: (...args: unknown[]) => mockListCliTokensByUser(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/cli-tokens", () => ({
  createCliToken: (...args: unknown[]) => mockCreateCliToken(...args),
  getCliTokenForUser: (...args: unknown[]) => mockGetCliTokenForUser(...args),
  revokeCliToken: (...args: unknown[]) => mockRevokeCliToken(...args),
  deleteCliToken: (...args: unknown[]) => mockDeleteCliToken(...args),
  resolveCliToken: (...args: unknown[]) => mockResolveCliToken(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/idempotency", () => ({
  readIdempotencyKeyHeader: (request: Request) => request.headers.get("Idempotency-Key")?.trim() || null,
  beginIdempotentRequest: (...args: unknown[]) => mockBeginIdempotentRequest(...args),
  commitIdempotentRequest: (...args: unknown[]) => mockCommitIdempotentRequest(...args),
  releaseIdempotentRequest: (...args: unknown[]) => mockReleaseIdempotentRequest(...args),
}));

import { createWorkerEnv, seedAuthUser } from "../smoke/helpers";
import { workerFetch, type WorkerModule } from "./helpers/worker-harness";

describe("CLI token routes", () => {
  let workerModule: WorkerModule;
  let env: Record<string, unknown>;
  let db: ReturnType<typeof createWorkerEnv>["db"];

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockBeginIdempotentRequest.mockResolvedValue({ kind: "disabled" });
    mockCommitIdempotentRequest.mockResolvedValue(true);
    mockReleaseIdempotentRequest.mockResolvedValue(undefined);
    const created = createWorkerEnv(workerModule);
    env = created.env;
    db = created.db;
    // Seed an authenticated user
    seedAuthUser(db, "test-session-token", 1, "testuser");
  });

  // ---------------------------------------------------------------------------
  // POST /api/cli-tokens (create)
  // ---------------------------------------------------------------------------

  describe("POST /api/cli-tokens", () => {
    it("returns 401 without authentication", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 when expiresInDays is outside the allowed range", async () => {
      for (const bad of [0, -1, 1.5, "abc"]) {
        const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
          method: "POST",
          headers: {
            cookie: "session_token=test-session-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ expiresInDays: bad }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { ok: boolean; error: string };
        expect(body.error).toMatch(/expiresInDays/);
      }
    });

    it("validates expiresInDays before claiming an idempotency key", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
          "Idempotency-Key": "retry-key",
        },
        body: JSON.stringify({ expiresInDays: 0 }),
      });

      expect(res.status).toBe(400);
      expect(mockBeginIdempotentRequest).not.toHaveBeenCalled();
    });

    it("returns 400 when expiresInDays exceeds the max", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expiresInDays: MAX_CLI_TOKEN_EXPIRY_DAYS + 1 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toContain(String(MAX_CLI_TOKEN_EXPIRY_DAYS));
    });

    it("returns token with cache-control: no-store header", async () => {
      mockCreateCliToken.mockResolvedValue({ ok: true, token: "arc_abc123", id: 1, scope: "read" });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store, private");

      const body = (await res.json()) as { ok: boolean; token: string; id: number; scope: string };
      expect(body.ok).toBe(true);
      expect(body.token).toBe("arc_abc123");
      expect(body.scope).toBe("read");
      expect(mockCreateCliToken).toHaveBeenCalledWith(expect.anything(), 1, "read", undefined);
    });

    it("returns duplicate_request for repeated idempotency keys without replaying raw tokens", async () => {
      mockBeginIdempotentRequest.mockResolvedValue({
        kind: "replay",
        resolvedId: "1",
        token: { ownerUserId: "1", key: "retry-key", route: "cli_token_create" },
      });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
          "Idempotency-Key": "retry-key",
        },
        body: JSON.stringify({ scope: "read" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ ok: false, code: "duplicate_request" });
      expect(mockCreateCliToken).not.toHaveBeenCalled();
    });

    it("commits idempotency after token creation succeeds", async () => {
      const token = { ownerUserId: "1", key: "retry-key", route: "cli_token_create" };
      mockBeginIdempotentRequest.mockResolvedValue({ kind: "proceed", token });
      mockCreateCliToken.mockResolvedValue({ ok: true, token: "arc_abc123", id: 7, scope: "read" });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
          "Idempotency-Key": "retry-key",
        },
        body: JSON.stringify({ scope: "read" }),
      });

      expect(res.status).toBe(200);
      expect(mockCommitIdempotentRequest).toHaveBeenCalledWith(expect.anything(), token, "7");
    });

    it("returns 409 when the active-token limit has been reached", async () => {
      mockCreateCliToken.mockResolvedValue({
        ok: false,
        error: "You already have 25 active CLI tokens. Revoke one before creating a new token.",
      });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/25 active CLI tokens/);
    });

    it("returns 400 for malformed JSON bodies before creating a token", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
        },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/expected object/i);
      expect(mockBeginIdempotentRequest).not.toHaveBeenCalled();
      expect(mockCreateCliToken).not.toHaveBeenCalled();
    });

    it("returns 400 for non-object JSON bodies", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify("read"),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/expected object/i),
      });
      expect(mockBeginIdempotentRequest).not.toHaveBeenCalled();
      expect(mockCreateCliToken).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid scope", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens", {
        method: "POST",
        headers: {
          cookie: "session_token=test-session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope: "admin" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/scope must be one of/);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/cli-tokens (list)
  // ---------------------------------------------------------------------------

  describe("GET /api/cli-tokens", () => {
    it("returns 401 without authentication", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens");
      expect(res.status).toBe(401);
    });

    it("returns paginated tokens", async () => {
      const mockData = {
        data: [
          {
            id: 1,
            tokenPrefix: "arc_1234",
            scope: "read",
            createdAt: Date.now(),
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
          },
        ],
        nextCursor: null,
      };
      mockListCliTokensByUser.mockResolvedValue(mockData);

      const res = await workerFetch(workerModule, env, "/api/cli-tokens?limit=10", {
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof mockData;
      expect(body.data).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
      expect(mockListCliTokensByUser).toHaveBeenCalledWith(
        expect.anything(), // db
        1, // userId
        10, // limit
        undefined, // cursor
      );
    });

    it("passes cursor query parameter", async () => {
      mockListCliTokensByUser.mockResolvedValue({ data: [], nextCursor: null });

      await workerFetch(workerModule, env, "/api/cli-tokens?cursor=42", {
        headers: { cookie: "session_token=test-session-token" },
      });

      expect(mockListCliTokensByUser).toHaveBeenCalledWith(
        expect.anything(),
        1,
        50, // default limit
        "42",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/cli-tokens/:id/revoke
  // ---------------------------------------------------------------------------

  describe("POST /api/cli-tokens/:id/revoke", () => {
    it("returns 401 without authentication", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/1/revoke", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for non-integer id", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/abc/revoke", {
        method: "POST",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/Invalid token ID/);
    });

    it("returns 400 for zero id", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/0/revoke", {
        method: "POST",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for negative id", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/-1/revoke", {
        method: "POST",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(400);
    });

    it("revokes the token successfully", async () => {
      mockRevokeCliToken.mockResolvedValue(undefined);

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42/revoke", {
        method: "POST",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(mockRevokeCliToken).toHaveBeenCalledWith(
        expect.anything(),
        1, // userId
        42, // tokenId
      );
    });

    it("blocks read-scoped CLI tokens from revoking write-scoped CLI tokens", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "read",
        tokenId: 7,
        user: { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false },
      });
      mockGetCliTokenForUser.mockResolvedValue({ id: 42, scope: "write" });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42/revoke", {
        method: "POST",
        headers: { authorization: "Bearer arc_read_token" },
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/Read-scoped CLI tokens cannot revoke write-scoped CLI tokens/);
      expect(mockGetCliTokenForUser).toHaveBeenCalledWith(expect.anything(), 1, 42);
      expect(mockRevokeCliToken).not.toHaveBeenCalled();
    });

    it("allows read-scoped CLI tokens to revoke read-scoped CLI tokens", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "read",
        tokenId: 7,
        user: { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false },
      });
      mockGetCliTokenForUser.mockResolvedValue({ id: 42, scope: "read" });
      mockRevokeCliToken.mockResolvedValue(undefined);

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42/revoke", {
        method: "POST",
        headers: { authorization: "Bearer arc_read_token" },
      });

      expect(res.status).toBe(200);
      expect(mockRevokeCliToken).toHaveBeenCalledWith(expect.anything(), 1, 42);
    });

    it("allows read-scoped CLI tokens to retry revoking an already-revoked write-scoped token", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "read",
        tokenId: 7,
        user: { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false },
      });
      mockGetCliTokenForUser.mockResolvedValue(null);
      mockRevokeCliToken.mockResolvedValue(undefined);

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42/revoke", {
        method: "POST",
        headers: { authorization: "Bearer arc_read_token" },
      });

      expect(res.status).toBe(200);
      expect(mockGetCliTokenForUser).toHaveBeenCalledWith(expect.anything(), 1, 42);
      expect(mockRevokeCliToken).toHaveBeenCalledWith(expect.anything(), 1, 42);
    });

    it("allows write-scoped CLI tokens to revoke write-scoped CLI tokens", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "write",
        tokenId: 7,
        user: { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false },
      });
      mockRevokeCliToken.mockResolvedValue(undefined);

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42/revoke", {
        method: "POST",
        headers: { authorization: "Bearer arc_write_token" },
      });

      expect(res.status).toBe(200);
      expect(mockGetCliTokenForUser).not.toHaveBeenCalled();
      expect(mockRevokeCliToken).toHaveBeenCalledWith(expect.anything(), 1, 42);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/cli-tokens/:id
  // ---------------------------------------------------------------------------

  describe("DELETE /api/cli-tokens/:id", () => {
    it("returns 401 without authentication", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/1", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for non-integer id", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/abc", {
        method: "DELETE",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/Invalid token ID/);
    });

    it("returns 400 for zero id", async () => {
      const res = await workerFetch(workerModule, env, "/api/cli-tokens/0", {
        method: "DELETE",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(400);
    });

    it("deletes the token successfully", async () => {
      mockDeleteCliToken.mockResolvedValue(undefined);

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42", {
        method: "DELETE",
        headers: { cookie: "session_token=test-session-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(mockDeleteCliToken).toHaveBeenCalledWith(
        expect.anything(),
        1, // userId
        42, // tokenId
      );
    });

    it("rejects read-scoped CLI tokens before the delete handler runs", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "read",
        tokenId: 7,
        user: { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false },
      });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42", {
        method: "DELETE",
        headers: { authorization: "Bearer arc_read_token" },
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/CLI tokens cannot access this resource/);
      expect(mockGetCliTokenForUser).not.toHaveBeenCalled();
      expect(mockDeleteCliToken).not.toHaveBeenCalled();
    });

    it("rejects write-scoped CLI tokens before the delete handler runs", async () => {
      mockResolveCliToken.mockResolvedValue({
        status: "ok",
        scope: "write",
        tokenId: 7,
        user: { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false },
      });

      const res = await workerFetch(workerModule, env, "/api/cli-tokens/42", {
        method: "DELETE",
        headers: { authorization: "Bearer arc_write_token" },
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/CLI tokens cannot access this resource/);
      expect(mockGetCliTokenForUser).not.toHaveBeenCalled();
      expect(mockDeleteCliToken).not.toHaveBeenCalled();
    });
  });
});
