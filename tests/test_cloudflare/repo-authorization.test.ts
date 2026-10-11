import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock getValidGithubTokenResult
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getValidGithubTokenResult: vi.fn(),
}));

const mockHasCachedRepoAccess = vi.fn().mockResolvedValue(false);
vi.mock("../../apps/control-plane-worker/src/services/repos", () => ({
  hasCachedRepoAccess: (...args: unknown[]) => mockHasCachedRepoAccess(...args),
}));

const { mockLoggerDebug, mockLoggerInfo, mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

// Mock logger
vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  }),
}));

import { getValidGithubTokenResult } from "../../apps/control-plane-worker/src/auth/db";
import {
  probeGithubRepoAccess,
  resetSessionViewRepoAccessCache,
  SESSION_VIEW_REPO_ACCESS_CACHE_TTL_MS,
  verifyUserRepoAccess,
} from "../../apps/control-plane-worker/src/auth/repo-authorization";

const mockGetTokenResult = getValidGithubTokenResult as ReturnType<typeof vi.fn>;
const fakeDb = {} as D1Database;
const githubTokenEnv = {
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEY: "test-encryption-key",
};

describe("verifyUserRepoAccess", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetSessionViewRepoAccessCache();
    mockGetTokenResult.mockReset();
    mockHasCachedRepoAccess.mockReset().mockResolvedValue(false);
    mockLoggerDebug.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
  });

  it("throws when user has no GitHub token so callers do not treat auth rejection as repo denial", async () => {
    mockGetTokenResult.mockResolvedValue({
      ok: false,
      reason: "token_missing",
      message: "No GitHub OAuth token is stored for this user.",
    });
    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).rejects.toThrow(
      "GitHub credentials rejected during repo access verification for owner/repo",
    );
  });

  it("throws the provider unavailability message when token refresh fails transiently", async () => {
    mockGetTokenResult.mockResolvedValue({
      ok: false,
      reason: "token_refresh_unavailable",
      status: 503,
      message: "GitHub token refresh failed with HTTP 503.",
    });

    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).rejects.toThrow(
      "GitHub token refresh failed with HTTP 503.",
    );
  });

  it("preserves transient token refresh failures as provider API unavailability for direct probe callers", async () => {
    mockGetTokenResult.mockResolvedValue({
      ok: false,
      reason: "token_refresh_unavailable",
      status: 503,
      message: "GitHub token refresh failed with HTTP 503.",
    });

    await expect(probeGithubRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).resolves.toEqual({
      ok: false,
      reason: "provider_api_unavailable",
      status: 503,
      message: "GitHub token refresh failed with HTTP 503.",
    });
  });

  it("throws without refresh env instead of attempting token resolution", async () => {
    mockGetTokenResult.mockClear();
    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo")).rejects.toThrow(
      "GitHub token verification environment missing",
    );
    expect(mockGetTokenResult).not.toHaveBeenCalled();
  });

  it("returns true from the cached repo list without calling GitHub", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    mockHasCachedRepoAccess.mockResolvedValue(true);
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    expect(await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns true when GitHub API returns 200", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 });
    expect(await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).toBe(true);
  });

  it("passes the refresh env to the token lookup", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 });

    await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv });

    expect(mockGetTokenResult).toHaveBeenCalledWith(fakeDb, "1", githubTokenEnv);
  });

  it("uses a preloaded token result without resolving the token again", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 });

    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        preloadedGithubTokenResult: { ok: true, token: "ghp_test_token" },
      }),
    ).resolves.toBe(true);

    expect(mockGetTokenResult).not.toHaveBeenCalled();
  });

  it("returns false when GitHub API returns 404", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404 });
    expect(await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).toBe(false);
  });

  it("returns false when GitHub API returns 403", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 403 });
    expect(await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).toBe(false);
  });

  it("throws on GitHub 401 so callers do not show repo-access remediation for auth rejection", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401 });

    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).rejects.toThrow(
      "GitHub credentials rejected during repo access verification for owner/repo",
    );
  });

  it("throws on GitHub rate limiting so callers can retry instead of treating it as denied", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 429 });

    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).rejects.toThrow(
      "GitHub API rate limited repo access verification for owner/repo",
    );
  });

  it("throws on unexpected status codes (fail closed)", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 500 });

    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).rejects.toThrow(
      "GitHub API returned unexpected status 500 verifying repo access",
    );

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "1",
        owner: "owner",
        repo: "repo",
        status: 500,
        error: expect.objectContaining({
          message: "GitHub API returned unexpected status 500 verifying repo access",
        }),
      }),
      "Unexpected GitHub API response for repo access check",
    );
  });

  it("throws on network errors (fail closed)", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    await expect(verifyUserRepoAccess(fakeDb, "1", "owner", "repo", { githubTokenEnv })).rejects.toThrow(
      "GitHub API call failed verifying repo access",
    );
  });

  it("calls GitHub API with correct URL and token", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    globalThis.fetch = mockFetch;
    await verifyUserRepoAccess(fakeDb, "1", "MyOrg", "my-repo", { githubTokenEnv });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/MyOrg/my-repo",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer ghp_test_token" }),
      }),
    );
  });

  it("reuses session-view repo access hits within the TTL", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    globalThis.fetch = mockFetch;

    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(true);
    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not reuse session-view cache entries after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T23:30:00.000Z"));
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    globalThis.fetch = mockFetch;

    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(true);

    vi.advanceTimersByTime(SESSION_VIEW_REPO_ACCESS_CACHE_TTL_MS + 1);

    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a session-view cache entry after the session repo changes", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    globalThis.fetch = mockFetch;

    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo-one", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(true);
    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo-two", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache denied session-view checks", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    const mockFetch = vi.fn().mockResolvedValue({ status: 404 });
    globalThis.fetch = mockFetch;

    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(false);
    await expect(
      verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: "sess-1" },
      }),
    ).resolves.toBe(false);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used session-view cache entries under high churn", async () => {
    mockGetTokenResult.mockResolvedValue({ ok: true, token: "ghp_test_token" });
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    globalThis.fetch = mockFetch;

    // Warm entries for 1001 distinct session IDs; the cache caps at 1000 entries,
    // so the first one inserted should be evicted when the last one arrives.
    for (let i = 0; i < 1001; i++) {
      await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
        githubTokenEnv,
        sessionViewCache: { sessionId: `sess-${i}` },
      });
    }

    // Each of the initial 1001 verifications was a cache miss.
    expect(mockFetch).toHaveBeenCalledTimes(1001);

    // The oldest entry (sess-0) should have been evicted, so this call hits GitHub again.
    await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
      githubTokenEnv,
      sessionViewCache: { sessionId: "sess-0" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1002);

    // sess-1000 is still cached -- no additional fetch.
    await verifyUserRepoAccess(fakeDb, "1", "owner", "repo", {
      githubTokenEnv,
      sessionViewCache: { sessionId: "sess-1000" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1002);
  });
});
