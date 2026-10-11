import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveAuthUserExtras = vi.fn();

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  resolveAuthUserExtras: (...args: unknown[]) => mockResolveAuthUserExtras(...args),
}));

import { resetAuthMeUserCache, resolveAuthMeUser } from "../../apps/control-plane-worker/src/auth/auth-me";
import type { AuthUserExtras } from "../../apps/control-plane-worker/src/auth/db";
import { AUTH_ME_USER_CACHE_TTL_MS } from "../../apps/control-plane-worker/src/constants/auth";

const fakeDb = {} as D1Database;
const fakeEnv = {} as import("../../apps/control-plane-worker/src/types").Env;

const authUser = {
  id: 42,
  login: "test-user",
  name: "Test User",
  email: "test@example.com",
  businessId: "biz-1",
  sharedSessions: false,
};

function buildExtras(overrides: Partial<AuthUserExtras> = {}): AuthUserExtras {
  return {
    avatarUrl: "https://example.com/avatar.png",
    businessId: "biz-1",
    businessRole: "admin" as const,
    githubUserId: null,
    linearConnected: true,
    notionConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
    availableIntegrations: ["github", "linear"],
    integrationScopes: { github: "user", linear: "user" },
    ...overrides,
  };
}

describe("resolveAuthMeUser", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetAuthMeUserCache();
  });

  it("reuses the enriched /auth/me user within the cache TTL", async () => {
    mockResolveAuthUserExtras.mockResolvedValue(buildExtras());

    const first = await resolveAuthMeUser(fakeDb, fakeEnv, authUser);
    const second = await resolveAuthMeUser(fakeDb, fakeEnv, authUser);

    expect(mockResolveAuthUserExtras).toHaveBeenCalledTimes(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.user).toEqual(first.user);
  });

  it("refreshes the cache after the TTL expires", async () => {
    vi.useFakeTimers();
    const startTime = new Date("2026-04-11T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);
    mockResolveAuthUserExtras
      .mockResolvedValueOnce(buildExtras({ avatarUrl: "https://example.com/first.png" }))
      .mockResolvedValueOnce(buildExtras({ avatarUrl: "https://example.com/second.png" }));

    const first = await resolveAuthMeUser(fakeDb, fakeEnv, authUser);
    vi.setSystemTime(startTime + AUTH_ME_USER_CACHE_TTL_MS + 1);
    const second = await resolveAuthMeUser(fakeDb, fakeEnv, authUser);

    expect(mockResolveAuthUserExtras).toHaveBeenCalledTimes(2);
    expect(first.user.avatarUrl).toBe("https://example.com/first.png");
    expect(second.cacheHit).toBe(false);
    expect(second.user.avatarUrl).toBe("https://example.com/second.png");
  });

  it("bypasses the cache when a fresh read is requested", async () => {
    mockResolveAuthUserExtras
      .mockResolvedValueOnce(buildExtras({ avatarUrl: "https://example.com/cached.png" }))
      .mockResolvedValueOnce(buildExtras({ avatarUrl: "https://example.com/fresh.png" }));

    const cached = await resolveAuthMeUser(fakeDb, fakeEnv, authUser);
    const fresh = await resolveAuthMeUser(fakeDb, fakeEnv, authUser, { fresh: true });

    expect(mockResolveAuthUserExtras).toHaveBeenCalledTimes(2);
    expect(cached.user.avatarUrl).toBe("https://example.com/cached.png");
    expect(fresh.cacheHit).toBe(false);
    expect(fresh.user.avatarUrl).toBe("https://example.com/fresh.png");
  });
});
