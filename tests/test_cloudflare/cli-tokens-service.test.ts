import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock DAO layer to isolate service logic
// ---------------------------------------------------------------------------

// resolveCliToken now routes the fire-and-forget last_used_at failure through
// runWithSentryTag, which calls Sentry.captureException. Stub it so the test does
// not depend on a real Sentry client.
vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn() }));

const mockInsertCliTokenIfBelowLimit = vi.fn();
const mockDeleteExpiredCliTokens = vi.fn();
const mockFindCliTokenByHash = vi.fn();
const mockFindCliTokenByUserAndId = vi.fn();
const mockUpdateLastUsedAt = vi.fn();
const mockListCliTokensByUser = vi.fn();
const mockSetRevokedAt = vi.fn();
const mockDeleteCliTokenRow = vi.fn();

vi.mock("../../apps/control-plane-worker/src/auth/cli-tokens", () => ({
  insertCliTokenIfBelowLimit: (...args: unknown[]) => mockInsertCliTokenIfBelowLimit(...args),
  deleteExpiredCliTokens: (...args: unknown[]) => mockDeleteExpiredCliTokens(...args),
  findCliTokenByHash: (...args: unknown[]) => mockFindCliTokenByHash(...args),
  findCliTokenByUserAndId: (...args: unknown[]) => mockFindCliTokenByUserAndId(...args),
  updateLastUsedAt: (...args: unknown[]) => mockUpdateLastUsedAt(...args),
  listCliTokensByUser: (...args: unknown[]) => mockListCliTokensByUser(...args),
  setRevokedAt: (...args: unknown[]) => mockSetRevokedAt(...args),
  deleteCliTokenRow: (...args: unknown[]) => mockDeleteCliTokenRow(...args),
}));

type ServiceModule = {
  createCliToken: (
    db: unknown,
    userId: number,
    scope: "read" | "write",
    expiresAt?: number,
  ) => Promise<{ ok: true; token: string; id: number; scope: "read" | "write" } | { ok: false; error: string }>;
  resolveCliToken: (
    db: unknown,
    rawToken: string,
  ) => Promise<{ status: "ok"; scope: "read" | "write"; user: Record<string, unknown> } | { status: "invalid" }>;
  listCliTokens: (db: unknown, userId: number, limit?: number, cursor?: string) => Promise<unknown>;
  getCliTokenForUser: (
    db: unknown,
    userId: number,
    tokenId: number,
  ) => Promise<{ id: number; scope: "read" | "write" } | null>;
  revokeCliToken: (db: unknown, userId: number, tokenId: number) => Promise<void>;
  deleteCliToken: (db: unknown, userId: number, tokenId: number) => Promise<void>;
};

let mod: ServiceModule;
const fakeDb = {} as D1Database;

describe("services/cli-tokens", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDeleteExpiredCliTokens.mockResolvedValue(undefined);
    mockInsertCliTokenIfBelowLimit.mockResolvedValue(1);
    const modulePath: string = "../../apps/control-plane-worker/src/services/cli-tokens";
    mod = (await import(modulePath)) as unknown as ServiceModule;
  });

  describe("createCliToken", () => {
    it("generates an arc_ prefixed token with 68 total chars", async () => {
      mockInsertCliTokenIfBelowLimit.mockResolvedValue(42);

      const result = await mod.createCliToken(fakeDb, 1, "read");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.token).toMatch(/^arc_[0-9a-f]{64}$/);
      expect(result.token).toHaveLength(68); // "arc_" (4) + 64 hex chars (32 bytes)
      expect(result.id).toBe(42);
      expect(result.scope).toBe("read");
      expect(mockDeleteExpiredCliTokens).toHaveBeenCalledWith(fakeDb, 1);
    });

    it("passes the SHA-256 hash (not raw token) and the cap to the atomic insert", async () => {
      mockInsertCliTokenIfBelowLimit.mockResolvedValue(1);

      const result = await mod.createCliToken(fakeDb, 1, "write");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(mockInsertCliTokenIfBelowLimit).toHaveBeenCalledOnce();
      const [, , tokenHash, tokenPrefix, scope, maxActive] = mockInsertCliTokenIfBelowLimit.mock.calls[0];
      // Hash should be a 64-char hex string (SHA-256)
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // Hash should NOT equal the raw token
      expect(tokenHash).not.toBe(result.token);
      // Prefix should be first 8 chars of the raw token
      expect(tokenPrefix).toBe(result.token.slice(0, 8));
      expect(scope).toBe("write");
      // Cap is enforced in-statement by the DAO.
      expect(maxActive).toBe(25);
    });

    it("passes expiresAt through to the DAO", async () => {
      mockInsertCliTokenIfBelowLimit.mockResolvedValue(1);
      const expiresAt = Date.now() + 86400000;

      await mod.createCliToken(fakeDb, 1, "read", expiresAt);

      const [, , , , , , passedExpiresAt] = mockInsertCliTokenIfBelowLimit.mock.calls[0];
      expect(passedExpiresAt).toBe(expiresAt);
    });

    it("deletes expired tokens before the atomic capped insert", async () => {
      mockInsertCliTokenIfBelowLimit.mockResolvedValue(7);

      const result = await mod.createCliToken(fakeDb, 1, "read");

      expect(result.ok).toBe(true);
      expect(mockDeleteExpiredCliTokens).toHaveBeenCalledWith(fakeDb, 1);
      expect(mockDeleteExpiredCliTokens.mock.invocationCallOrder[0]).toBeLessThan(
        mockInsertCliTokenIfBelowLimit.mock.invocationCallOrder[0],
      );
    });

    it("succeeds when the atomic insert returns an id (below the cap)", async () => {
      mockInsertCliTokenIfBelowLimit.mockResolvedValue(9);

      const result = await mod.createCliToken(fakeDb, 1, "read");

      expect(result.ok).toBe(true);
      expect(mockInsertCliTokenIfBelowLimit).toHaveBeenCalledOnce();
    });

    it("returns an error when the atomic insert is capped (returns null)", async () => {
      mockInsertCliTokenIfBelowLimit.mockResolvedValue(null);

      const result = await mod.createCliToken(fakeDb, 1, "read");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/25 active CLI tokens/);
    });
  });

  describe("resolveCliToken", () => {
    it("returns ok and touches last_used_at when it was never used (null)", async () => {
      const user = { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false };
      mockFindCliTokenByHash.mockResolvedValue({ tokenId: 42, scope: "read", lastUsedAt: null, user });
      mockUpdateLastUsedAt.mockResolvedValue(undefined);

      const result = await mod.resolveCliToken(
        fakeDb,
        "arc_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      );

      expect(result.status).toBe("ok");
      expect((result as { status: "ok"; scope: "read" | "write"; user: typeof user }).user).toEqual(user);
      expect((result as { status: "ok"; scope: "read" | "write"; user: typeof user }).scope).toBe("read");
      // null counts as stale → write fires; third arg is the computed staleBefore cutoff
      expect(mockUpdateLastUsedAt).toHaveBeenCalledWith(fakeDb, 42, expect.any(Number));
    });

    it("touches last_used_at when the stored value is older than the throttle window", async () => {
      const user = { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false };
      const stale = Date.now() - 60 * 60 * 1000; // 1h ago, well past the 5m window
      mockFindCliTokenByHash.mockResolvedValue({ tokenId: 7, scope: "read", lastUsedAt: stale, user });
      mockUpdateLastUsedAt.mockResolvedValue(undefined);

      await mod.resolveCliToken(fakeDb, "arc_stale_token");

      expect(mockUpdateLastUsedAt).toHaveBeenCalledWith(fakeDb, 7, expect.any(Number));
    });

    it("SKIPS the last_used_at write when the stored value is still fresh (throttled)", async () => {
      const user = { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false };
      const fresh = Date.now() - 1000; // 1s ago, inside the 5m window
      mockFindCliTokenByHash.mockResolvedValue({ tokenId: 9, scope: "read", lastUsedAt: fresh, user });

      const result = await mod.resolveCliToken(fakeDb, "arc_fresh_token");

      expect(result.status).toBe("ok");
      expect(mockUpdateLastUsedAt).not.toHaveBeenCalled();
    });

    it("returns invalid for a non-existent token", async () => {
      mockFindCliTokenByHash.mockResolvedValue(null);

      const result = await mod.resolveCliToken(fakeDb, "arc_nonexistent");

      expect(result.status).toBe("invalid");
      expect(mockUpdateLastUsedAt).not.toHaveBeenCalled();
    });

    it("handles last_used_at write failure gracefully (best-effort)", async () => {
      const user = { id: 1, login: "testuser", name: null, email: null, businessId: "biz-1", sharedSessions: false };
      mockFindCliTokenByHash.mockResolvedValue({ tokenId: 42, scope: "write", lastUsedAt: null, user });
      mockUpdateLastUsedAt.mockRejectedValue(new Error("D1 write failed"));

      const result = await mod.resolveCliToken(fakeDb, "arc_valid_token_here");

      // Should still return ok even though updateLastUsedAt threw
      expect(result.status).toBe("ok");
      expect((result as { status: "ok"; scope: "read" | "write"; user: typeof user }).user).toEqual(user);
      expect((result as { status: "ok"; scope: "read" | "write"; user: typeof user }).scope).toBe("write");
    });
  });

  describe("revokeCliToken", () => {
    it("delegates to setRevokedAt", async () => {
      mockSetRevokedAt.mockResolvedValue(undefined);

      await mod.revokeCliToken(fakeDb, 1, 42);

      expect(mockSetRevokedAt).toHaveBeenCalledWith(fakeDb, 1, 42);
    });
  });

  describe("getCliTokenForUser", () => {
    it("delegates to findCliTokenByUserAndId", async () => {
      mockFindCliTokenByUserAndId.mockResolvedValue({ id: 42, scope: "write" });

      const result = await mod.getCliTokenForUser(fakeDb, 1, 42);

      expect(result).toEqual({ id: 42, scope: "write" });
      expect(mockFindCliTokenByUserAndId).toHaveBeenCalledWith(fakeDb, 1, 42);
    });
  });

  describe("deleteCliToken", () => {
    it("delegates to deleteCliTokenRow", async () => {
      mockDeleteCliTokenRow.mockResolvedValue(undefined);

      await mod.deleteCliToken(fakeDb, 1, 42);

      expect(mockDeleteCliTokenRow).toHaveBeenCalledWith(fakeDb, 1, 42);
    });
  });
});
