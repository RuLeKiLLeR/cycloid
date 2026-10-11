import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSessionResult } from "../../apps/control-plane-worker/src/types";
import { computeSha256Hex } from "../../apps/control-plane-worker/src/utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockResolveAuthSession = vi.fn<(db: unknown, token: string) => Promise<AuthSessionResult>>();
const mockGetAuthSessionTokensForBusiness = vi.fn<(db: unknown, businessId: string) => Promise<string[]>>();
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  resolveAuthSession: (...args: unknown[]) => mockResolveAuthSession(args[0], args[1] as string),
  getAuthSessionTokensForBusiness: (...args: unknown[]) =>
    mockGetAuthSessionTokensForBusiness(args[0], args[1] as string),
  resolveAuthUser: vi.fn(),
  resolveAuthUserExtras: vi.fn(),
  clearGithubToken: vi.fn(),
  getValidGithubToken: vi.fn(),
  clearSlackLink: vi.fn(),
  createAuthSession: vi.fn(),
  deleteAuthSession: vi.fn(),
  storeLinearTokens: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/service", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/auth/service")>(
    "../../apps/control-plane-worker/src/auth/service",
  );
  return {
    ...actual,
    persistAuthenticatedGitHubUser: vi.fn(),
  };
});

const mockResolveCliToken = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/cli-tokens", () => ({
  resolveCliToken: (...args: unknown[]) => mockResolveCliToken(...args),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/db", () => ({
  clearProviderApiKey: vi.fn(),
  connectIntegration: vi.fn(),
  getProviderKeyStates: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getUserApiKey: vi.fn(),
  mapProviderKeyStateRows: vi.fn(),
  setProviderApiKey: vi.fn(),
  storeLinearTokens: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/service", () => ({
  isIntegrationAvailable: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/github/db", () => ({
  getUserGitIdentity: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  getAppSlug: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/settings/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue("encrypted"),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { authenticateRequest } from "../../apps/control-plane-worker/src/auth/routes";
import {
  invalidateAuthSessionCache,
  invalidateBusinessAuthSessionCache,
} from "../../apps/control-plane-worker/src/auth/service";
import { AUTH_SESSION_CACHE_TTL } from "../../apps/control-plane-worker/src/constants/auth";

// ---------------------------------------------------------------------------
// FakeKV – in-memory KVNamespace mock
// ---------------------------------------------------------------------------

class FakeKV {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string, type?: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): IterableIterator<string> {
    return this.store.keys();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validAuthResult: AuthSessionResult = {
  status: "ok",
  user: {
    id: 42,
    login: "testuser",
    name: "Test User",
    email: "test@example.com",
    businessId: "biz-test",
    sharedSessions: false,
  },
};

function buildEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: {},
    RATE_LIMITS: new FakeKV(),
    ...overrides,
  };
}

function buildRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.test/api/sessions", {
    headers: {
      cookie: "session_token=tok_valid",
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AUTH_SESSION_CACHE_TTL constant", () => {
  it("meets Cloudflare KV minimum expirationTtl of 60 seconds", () => {
    // Cloudflare KV rejects puts with expirationTtl < 60. This test prevents
    // a regression where the constant was set below that threshold.
    expect(AUTH_SESSION_CACHE_TTL).toBeGreaterThanOrEqual(60);
  });
});

describe("auth session KV cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthSessionTokensForBusiness.mockReset();
  });

  it("writes to KV with AUTH_SESSION_CACHE_TTL as expirationTtl", async () => {
    mockResolveAuthSession.mockResolvedValue(validAuthResult);
    const putSpy = vi.fn<FakeKV["put"]>();
    const spyKV = new FakeKV();
    spyKV.put = putSpy.mockImplementation(FakeKV.prototype.put.bind(spyKV));
    const env = buildEnv({ RATE_LIMITS: spyKV });

    await authenticateRequest(buildRequest(), env as never);

    // The cache write is fire-and-forget (not routed through ctx.waitUntil), so
    // poll the observable spy state until the put lands rather than sleeping.
    let sessionPut: (typeof putSpy.mock.calls)[number] | undefined;
    await vi.waitFor(() => {
      sessionPut = putSpy.mock.calls.find(([key]) => key.startsWith("auth:session:"));
      expect(sessionPut).toBeDefined();
    });
    expect(sessionPut?.[2]).toEqual({ expirationTtl: AUTH_SESSION_CACHE_TTL });
  });

  it("caches resolveAuthSession result in KV on first call", async () => {
    mockResolveAuthSession.mockResolvedValue(validAuthResult);
    const env = buildEnv();
    const kv = env.RATE_LIMITS as FakeKV;

    const result = await authenticateRequest(buildRequest(), env as never);

    expect(result.ok).toBe(true);
    expect(mockResolveAuthSession).toHaveBeenCalledTimes(1);

    // KV should now have an entry with the auth:session: prefix.
    // The put is fire-and-forget; poll the observable KV state until it lands.
    await vi.waitFor(() => {
      const kvKeys = [...kv.keys()];
      expect(kvKeys.some((k) => k.startsWith("auth:session:"))).toBe(true);
    });
  });

  it("returns cached result on second call without hitting D1", async () => {
    mockResolveAuthSession.mockResolvedValue(validAuthResult);
    const env = buildEnv();
    const kv = env.RATE_LIMITS as FakeKV;

    // First call: populates cache
    const result1 = await authenticateRequest(buildRequest(), env as never);
    expect(result1.ok).toBe(true);
    expect(mockResolveAuthSession).toHaveBeenCalledTimes(1);

    // The cache write is fire-and-forget; poll until the entry is observable so
    // the second call deterministically hits the cache.
    await vi.waitFor(() => {
      expect([...kv.keys()].some((k) => k.startsWith("auth:session:"))).toBe(true);
    });

    // Second call: should use cache
    mockResolveAuthSession.mockClear();
    const result2 = await authenticateRequest(buildRequest(), env as never);
    expect(result2.ok).toBe(true);
    expect(mockResolveAuthSession).not.toHaveBeenCalled();

    // Verify both results return the same user
    if (result1.ok && result2.ok) {
      expect(result1.auth.userId).toBe(result2.auth.userId);
      expect(result1.auth.user?.login).toBe(result2.auth.user?.login);
    }
  });

  it("does not cache invalid auth sessions", async () => {
    mockResolveAuthSession.mockResolvedValue({ status: "invalid" });
    const env = buildEnv();
    const kv = env.RATE_LIMITS as FakeKV;

    const result = await authenticateRequest(buildRequest(), env as never);
    expect(result.ok).toBe(false);

    // Invalid sessions never reach the cache-write branch (it is guarded on
    // status === "ok"), so no async put is ever scheduled: the KV state is
    // final once the handler resolves. No wait needed.
    expect(kv.size).toBe(0);
  });

  it("falls back to D1 when KV is unavailable", async () => {
    mockResolveAuthSession.mockResolvedValue(validAuthResult);
    const env = buildEnv({ RATE_LIMITS: undefined });

    const result = await authenticateRequest(buildRequest(), env as never);
    expect(result.ok).toBe(true);
    expect(mockResolveAuthSession).toHaveBeenCalledTimes(1);
  });

  it("falls back to D1 when KV read throws", async () => {
    mockResolveAuthSession.mockResolvedValue(validAuthResult);
    const brokenKV = {
      get: () => {
        throw new Error("KV down");
      },
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const env = buildEnv({ RATE_LIMITS: brokenKV });

    const result = await authenticateRequest(buildRequest(), env as never);
    expect(result.ok).toBe(true);
    expect(mockResolveAuthSession).toHaveBeenCalledTimes(1);
  });

  it("skips cache for admin token auth", async () => {
    const env = buildEnv({ ARCANIST_ADMIN_TOKEN: "admin-secret" });
    const kv = env.RATE_LIMITS as FakeKV;

    const result = await authenticateRequest(buildRequest({ authorization: "Bearer admin-secret" }), env as never);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth.authMode).toBe("admin_token");
    expect(mockResolveAuthSession).not.toHaveBeenCalled();
    expect(kv.size).toBe(0);
  });

  it("rejects a wrong admin token", async () => {
    mockResolveAuthSession.mockResolvedValue({ status: "not_found" } as never);
    const env = buildEnv({ ARCANIST_ADMIN_TOKEN: "admin-secret" });

    const result = await authenticateRequest(
      buildRequest({ authorization: "Bearer admin-secre7", cookie: "" }),
      env as never,
    );

    expect(result.ok).toBe(false);
  });

  it("authenticates the CI automation token without session access", async () => {
    const env = buildEnv({ CI_AUTOMATION_TOKEN: "ci-secret" });

    const result = await authenticateRequest(buildRequest({ authorization: "Bearer ci-secret" }), env as never);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.authMode).toBe("ci_automation_token");
      expect(result.auth.canAccessAllSessions).toBe(false);
    }
  });

  it("rejects a wrong CI automation token", async () => {
    mockResolveAuthSession.mockResolvedValue({ status: "not_found" } as never);
    const env = buildEnv({ CI_AUTOMATION_TOKEN: "ci-secret" });

    const result = await authenticateRequest(
      buildRequest({ authorization: "Bearer ci-secre7", cookie: "" }),
      env as never,
    );

    expect(result.ok).toBe(false);
  });

  it("skips cache for CLI token auth", async () => {
    mockResolveCliToken.mockResolvedValue({
      status: "ok",
      scope: "read",
      user: { id: 42, login: "testuser", name: null, email: null, businessId: "biz-test" },
    });
    const env = buildEnv();
    const kv = env.RATE_LIMITS as FakeKV;

    const result = await authenticateRequest(
      buildRequest({ authorization: "Bearer arc_testtoken123", cookie: "" }),
      env as never,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth.authMode).toBe("cli_token");
    expect(mockResolveAuthSession).not.toHaveBeenCalled();
    // CLI tokens bypass the session-cache path entirely (resolveAuthSessionCached
    // is never called), so no async KV put is ever scheduled: state is final once
    // the handler resolves. No wait needed.
    const hasSessionKey = [...kv.keys()].some((k) => k.startsWith("auth:session:"));
    expect(hasSessionKey).toBe(false);
  });
});

describe("invalidateAuthSessionCache", () => {
  it("removes the cached entry for the given token", async () => {
    mockResolveAuthSession.mockResolvedValue(validAuthResult);
    const env = buildEnv();
    const kv = env.RATE_LIMITS as FakeKV;

    // Populate cache. The write is fire-and-forget, so poll until observable.
    await authenticateRequest(buildRequest(), env as never);
    await vi.waitFor(() => {
      expect(kv.size).toBeGreaterThan(0);
    });

    // Invalidate
    await invalidateAuthSessionCache("tok_valid", kv as unknown as KVNamespace);
    expect(kv.size).toBe(0);
  });

  it("is a no-op when KV is undefined", async () => {
    // Should not throw
    await invalidateAuthSessionCache("tok_any", undefined);
  });

  it("silently ignores KV errors", async () => {
    const brokenKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: () => {
        throw new Error("KV down");
      },
    };
    // Should not throw
    await invalidateAuthSessionCache("tok_any", brokenKV as unknown as KVNamespace);
  });
});

describe("invalidateBusinessAuthSessionCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthSessionTokensForBusiness.mockReset();
  });

  it("removes cached entries for all active business session tokens", async () => {
    const db = {};
    const kv = new FakeKV();
    mockGetAuthSessionTokensForBusiness.mockResolvedValue(["tok_a", "tok_b"]);

    const keyA = `auth:session:${await computeSha256Hex("tok_a")}`;
    const keyB = `auth:session:${await computeSha256Hex("tok_b")}`;
    await kv.put(keyA, JSON.stringify(validAuthResult));
    await kv.put(keyB, JSON.stringify(validAuthResult));

    await invalidateBusinessAuthSessionCache(db as never, "biz-test", kv as unknown as KVNamespace);

    expect(mockGetAuthSessionTokensForBusiness).toHaveBeenCalledWith(db, "biz-test");
    expect(kv.has(keyA)).toBe(false);
    expect(kv.has(keyB)).toBe(false);
  });

  it("is a no-op when KV is undefined", async () => {
    await invalidateBusinessAuthSessionCache({} as never, "biz-test", undefined);
    expect(mockGetAuthSessionTokensForBusiness).not.toHaveBeenCalled();
  });

  it("silently ignores KV lookup or delete failures", async () => {
    mockGetAuthSessionTokensForBusiness.mockRejectedValue(new Error("DB down"));

    await expect(
      invalidateBusinessAuthSessionCache({} as never, "biz-test", {
        delete: vi.fn(),
      } as unknown as KVNamespace),
    ).resolves.toBeUndefined();
  });
});
