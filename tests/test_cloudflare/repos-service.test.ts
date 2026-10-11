import { beforeEach, describe, expect, it, vi } from "vitest";

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

const {
  mockCacheInstallationRepos,
  mockDeleteCachedInstallationReposForUser,
  mockGetActiveInstallationsForOwners,
  mockGetCachedInstallationReposForInstallations,
  mockGetInstallationsByOwnerIds,
  mockGetValidGithubToken,
  mockFetchRepoTree,
  mockLogError,
  mockLogInfo,
  mockLogWarn,
  mockTracedFetch,
} = vi.hoisted(() => ({
  mockGetValidGithubToken: vi.fn(),
  mockFetchRepoTree: vi.fn(),
  mockGetActiveInstallationsForOwners: vi.fn(),
  mockGetCachedInstallationReposForInstallations: vi.fn(),
  mockGetInstallationsByOwnerIds: vi.fn(),
  mockDeleteCachedInstallationReposForUser: vi.fn(),
  mockCacheInstallationRepos: vi.fn(),
  mockTracedFetch: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getValidGithubToken: (...args: unknown[]) => mockGetValidGithubToken(...args),
  // listAccessibleReposForUser now resolves tokens via getValidGithubTokenResult.
  // Adapt the existing string|null mock: a string token -> ok; null -> token_missing.
  getValidGithubTokenResult: async (...args: unknown[]) => {
    const token = await mockGetValidGithubToken(...args);
    return token
      ? { ok: true, token }
      : { ok: false, reason: "token_missing", message: "No GitHub OAuth token is stored for this user." };
  },
}));

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getActiveInstallationsForOwners: (...args: unknown[]) => mockGetActiveInstallationsForOwners(...args),
  getCachedInstallationReposForInstallations: (...args: unknown[]) =>
    mockGetCachedInstallationReposForInstallations(...args),
  getInstallationsByOwnerIds: (...args: unknown[]) => mockGetInstallationsByOwnerIds(...args),
  deleteCachedInstallationReposForUser: (...args: unknown[]) => mockDeleteCachedInstallationReposForUser(...args),
  cacheInstallationRepos: (...args: unknown[]) => mockCacheInstallationRepos(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) => mockTracedFetch(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/tree", () => ({
  fetchRepoTree: (...args: unknown[]) => mockFetchRepoTree(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    child: () => ({
      info: mockLogInfo,
      warn: mockLogWarn,
      error: mockLogError,
      child: () => ({
        info: mockLogInfo,
        warn: mockLogWarn,
        error: mockLogError,
      }),
    }),
  }),
}));

import { GitHubRequestError } from "../../apps/control-plane-worker/src/github/errors";
import {
  bumpReposInstallationVersion,
  hasCachedRepoAccess,
  invalidateReposCacheForUser,
  listAccessibleRepos,
  listAccessibleReposCacheFirst,
  listRepoFilesForUser,
  parseSsoWithheldOrgIds,
  REPOS_CACHE_KEY_PREFIX,
  REPOS_CACHE_SCHEMA_VERSION,
  REPOS_INSTALLATIONS_VERSION_KEY,
  resetReposMemoryCache,
} from "../../apps/control-plane-worker/src/services/repos";
import type { Env } from "../../apps/control-plane-worker/src/types";

type FakeKvStore = Map<string, string>;

function makeRequest(): Request {
  return new Request("https://example.com/api/repos");
}

function makeRefreshRequest(): Request {
  return new Request("https://example.com/api/repos?refresh=true");
}

function makeEnv(seed: { store?: FakeKvStore; getImpl?: (key: string, type?: string) => Promise<unknown> } = {}): Env {
  const store = seed.store ?? new Map<string, string>();
  const get = vi.fn(
    seed.getImpl ??
      (async (key: string, type?: string) => {
        const value = store.get(key);
        if (value === undefined) {
          return null;
        }
        return type === "json" ? JSON.parse(value) : value;
      }),
  );
  const put = vi.fn(async (key: string, value: string, _options?: unknown) => {
    store.set(key, value);
  });

  return {
    DB: {} as D1Database,
    REPOS_CACHE: {
      get,
      put,
    },
  } as unknown as Env;
}

function githubStatus(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubOkJson(body: unknown): Response {
  return githubStatus(200, body);
}

describe("repos service caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReposMemoryCache();
    mockGetValidGithubToken.mockResolvedValue("ghu_test");
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 1, owner_login: "acme", repository_selection: "all", suspended_at: null },
    ]);
    mockGetCachedInstallationReposForInstallations.mockResolvedValue(new Map());
    mockCacheInstallationRepos.mockResolvedValue(undefined);
    mockGetInstallationsByOwnerIds.mockResolvedValue([]);
    mockDeleteCachedInstallationReposForUser.mockResolvedValue(undefined);
  });

  it("serves repeated repo requests from memory and only rechecks the installation version", async () => {
    const env = makeEnv();
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: true,
          default_branch: "main",
          description: "Repository A API service.",
        },
      ]),
    );

    const first = await listAccessibleRepos(env, makeRequest(), "42");
    expect(first).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [{ fullName: "acme/repo-a", description: "Repository A API service." }],
    });

    vi.mocked(env.REPOS_CACHE.get).mockClear();
    mockTracedFetch.mockClear();
    mockLogInfo.mockClear();

    const second = await listAccessibleRepos(env, makeRequest(), "42");

    expect(second).toMatchObject({
      ok: true,
      cacheStatus: "hit",
      repos: [{ fullName: "acme/repo-a", description: "Repository A API service." }],
    });
    expect(env.REPOS_CACHE.get).toHaveBeenCalledTimes(1);
    expect(env.REPOS_CACHE.get).toHaveBeenCalledWith(REPOS_INSTALLATIONS_VERSION_KEY);
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "42", cache: "memory", repoCount: 1 }),
      "repos.list",
    );
  });

  it("starts the installation-version and cached-repos KV reads in parallel on cache hits", async () => {
    const store = new Map<string, string>();
    store.set(
      `${REPOS_CACHE_KEY_PREFIX}:42`,
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "version-1",
        repos: [
          { fullName: "acme/repo-a", url: "https://github.com/acme/repo-a", private: true, defaultBranch: "main" },
        ],
        ssoOrgs: [],
      }),
    );

    let sawRepoCacheReadBeforeVersionResolved = false;
    let resolveVersion: ((value: string) => void) | null = null;
    const versionPromise = new Promise<string>((resolve) => {
      resolveVersion = resolve;
    });

    const env = makeEnv({
      store,
      getImpl: async (key: string, type?: string) => {
        if (key === REPOS_INSTALLATIONS_VERSION_KEY) {
          return versionPromise;
        }
        if (key === `${REPOS_CACHE_KEY_PREFIX}:42`) {
          sawRepoCacheReadBeforeVersionResolved = true;
          const value = store.get(key);
          return type === "json" && value ? JSON.parse(value) : (value ?? null);
        }
        return null;
      },
    });

    const resultPromise = listAccessibleRepos(env, makeRequest(), "42");
    // Flush microtasks up to the point the cache/version reads fire. Token
    // resolution (getValidGithubTokenResult) runs first and costs a tick before
    // the parallel reads start; the property under test is that the repo-cache
    // read begins before the installation-version promise resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect(sawRepoCacheReadBeforeVersionResolved).toBe(true);

    resolveVersion?.("version-1");
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "hit",
      repos: [{ fullName: "acme/repo-a" }],
    });
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "42", cache: "kv", repoCount: 1 }),
      "repos.list",
    );
  });

  it("refreshes cached repo entries from older cache schemas", async () => {
    const store = new Map<string, string>();
    store.set(REPOS_INSTALLATIONS_VERSION_KEY, "version-1");
    store.set(
      `${REPOS_CACHE_KEY_PREFIX}:42`,
      JSON.stringify({
        installationVersion: "version-1",
        repos: [
          { fullName: "acme/repo-old", url: "https://github.com/acme/repo-old", private: true, defaultBranch: "main" },
        ],
      }),
    );
    const env = makeEnv({ store });
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/repo-new",
          html_url: "https://github.com/acme/repo-new",
          private: true,
          default_branch: "main",
          description: "Fresh repo metadata.",
        },
      ]),
    );

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [{ fullName: "acme/repo-new", description: "Fresh repo metadata." }],
    });
    expect(mockTracedFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com/user/repos"),
      expect.any(Object),
      "github.repoList",
    );
  });

  it("falls back to KV when a memory entry is stale but KV has a fresh repo list", async () => {
    const env = makeEnv();
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: true,
          default_branch: "main",
        },
      ]),
    );

    await listAccessibleRepos(env, makeRequest(), "42");
    await env.REPOS_CACHE.put(REPOS_INSTALLATIONS_VERSION_KEY, "version-2");
    await env.REPOS_CACHE.put(
      `${REPOS_CACHE_KEY_PREFIX}:42`,
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "version-2",
        repos: [
          { fullName: "acme/repo-b", url: "https://github.com/acme/repo-b", private: true, defaultBranch: "main" },
        ],
        ssoOrgs: [],
      }),
    );

    mockTracedFetch.mockClear();
    mockLogInfo.mockClear();

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "hit",
      repos: [{ fullName: "acme/repo-b" }],
    });
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "42", cache: "kv", repoCount: 1 }),
      "repos.list",
    );
  });

  it("uses fresh KV repo access data when memory is stale", async () => {
    const env = makeEnv();
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: true,
          default_branch: "main",
        },
      ]),
    );

    await listAccessibleRepos(env, makeRequest(), "42");
    await env.REPOS_CACHE.put(REPOS_INSTALLATIONS_VERSION_KEY, "version-2");
    await env.REPOS_CACHE.put(
      `${REPOS_CACHE_KEY_PREFIX}:42`,
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "version-2",
        repos: [
          { fullName: "acme/repo-b", url: "https://github.com/acme/repo-b", private: true, defaultBranch: "main" },
        ],
        ssoOrgs: [],
      }),
    );

    await expect(hasCachedRepoAccess(env, "42", "acme", "repo-b")).resolves.toBe(true);
    await expect(hasCachedRepoAccess(env, "42", "acme", "repo-a")).resolves.toBe(false);
  });

  it("clears repos memory cache when the installation version is bumped", async () => {
    const env = makeEnv();
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: true,
          default_branch: "main",
        },
      ]),
    );

    await listAccessibleRepos(env, makeRequest(), "42");
    await bumpReposInstallationVersion(env);

    vi.mocked(env.REPOS_CACHE.get).mockClear();
    mockTracedFetch.mockResolvedValueOnce(githubOkJson([]));

    await listAccessibleRepos(env, makeRequest(), "42");

    expect(env.REPOS_CACHE.get).toHaveBeenCalledWith(`${REPOS_CACHE_KEY_PREFIX}:42`, "json");
  });

  it("logs selected-installation fetch failures without treating them as empty-success installs", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/granted-repo",
            html_url: "https://github.com/partial-org/granted-repo",
            private: true,
            default_branch: "main",
          },
          {
            full_name: "partial-org/not-granted-repo",
            html_url: "https://github.com/partial-org/not-granted-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockResolvedValueOnce(githubStatus(403));

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [],
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 3,
        status: 403,
        error: "GitHub installation repositories API error: 403",
      }),
      "Failed to fetch selected installation repositories; filtering that owner closed",
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "42",
        fetchedRepoCount: 2,
        repoCount: 0,
        selectedInstallationCount: 1,
        selectedInstallationFailureCount: 1,
      }),
      "repos.list",
    );
  });

  it("uses cached selected-installation repositories instead of calling GitHub for each installation", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockGetCachedInstallationReposForInstallations.mockResolvedValue(
      new Map([[3, new Set(["partial-org/granted-repo"])]]),
    );
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "partial-org/granted-repo",
          html_url: "https://github.com/partial-org/granted-repo",
          private: true,
          default_branch: "main",
        },
        {
          full_name: "partial-org/not-granted-repo",
          html_url: "https://github.com/partial-org/not-granted-repo",
          private: true,
          default_branch: "main",
        },
      ]),
    );

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [{ fullName: "partial-org/granted-repo" }],
    });
    expect(mockGetCachedInstallationReposForInstallations).toHaveBeenCalledWith(env.DB, "42", [3], expect.any(Number));
    expect(mockTracedFetch).toHaveBeenCalledTimes(1);
    expect(mockTracedFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com/user/repos"),
      expect.any(Object),
      "github.repoList",
    );
    expect(mockCacheInstallationRepos).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedInstallationCount: 1,
        selectedInstallationCacheHitCount: 1,
        selectedInstallationFailureCount: 0,
      }),
      "repos.list",
    );
  });

  it("caches selected-installation repositories after a successful GitHub fetch", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/granted-repo",
            html_url: "https://github.com/partial-org/granted-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockResolvedValueOnce(githubOkJson({ repositories: [{ full_name: "partial-org/granted-repo" }] }));

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [{ fullName: "partial-org/granted-repo" }],
    });
    expect(mockCacheInstallationRepos).toHaveBeenCalledWith(
      env.DB,
      "42",
      [{ installationId: 3, repos: new Set(["partial-org/granted-repo"]) }],
      expect.any(Number),
      900_000,
    );
  });

  it("bypasses selected-installation repository cache reads but re-warms it on refresh", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockGetCachedInstallationReposForInstallations.mockResolvedValue(
      new Map([[3, new Set(["partial-org/stale-repo"])]]),
    );
    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/fresh-repo",
            html_url: "https://github.com/partial-org/fresh-repo",
            private: true,
            default_branch: "main",
          },
          {
            full_name: "partial-org/stale-repo",
            html_url: "https://github.com/partial-org/stale-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockResolvedValueOnce(githubOkJson({ repositories: [{ full_name: "partial-org/fresh-repo" }] }));

    const result = await listAccessibleRepos(env, makeRefreshRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "bypass",
      repos: [{ fullName: "partial-org/fresh-repo" }],
    });
    expect(mockGetCachedInstallationReposForInstallations).not.toHaveBeenCalled();
    // Refresh skips the cache read (forcing a live fetch) but still writes the
    // fresh result back, matching the merged-cache write-through-on-refresh contract.
    expect(mockCacheInstallationRepos).toHaveBeenCalledWith(
      env.DB,
      "42",
      [{ installationId: 3, repos: new Set(["partial-org/fresh-repo"]) }],
      expect.any(Number),
      900_000,
    );
    expect(mockTracedFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com/user/installations/3/repositories"),
      expect.any(Object),
      "github.installationRepos",
    );
  });

  it("does not warn when a selected installation legitimately returns zero repositories", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/not-granted-repo",
            html_url: "https://github.com/partial-org/not-granted-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockResolvedValueOnce(githubOkJson({ repositories: [] }));

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [],
    });
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "42",
        fetchedRepoCount: 1,
        repoCount: 0,
        selectedInstallationCount: 1,
        selectedInstallationFailureCount: 0,
      }),
      "repos.list",
    );
  });

  it("does not cache partial selected-installation failures", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/granted-repo",
            html_url: "https://github.com/partial-org/granted-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockResolvedValueOnce(githubStatus(403));

    const first = await listAccessibleRepos(env, makeRequest(), "42");

    expect(first).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [],
    });

    mockTracedFetch.mockClear();
    mockLogInfo.mockClear();

    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/granted-repo",
            html_url: "https://github.com/partial-org/granted-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockResolvedValueOnce(githubOkJson({ repositories: [{ full_name: "partial-org/granted-repo" }] }));

    const second = await listAccessibleRepos(env, makeRequest(), "42");

    expect(second).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [{ fullName: "partial-org/granted-repo" }],
    });
    expect(mockTracedFetch).toHaveBeenCalledTimes(2);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "42",
        repoCount: 1,
        selectedInstallationFailureCount: 0,
      }),
      "repos.list",
    );
  });

  it("converts thrown selected-installation fetch errors into per-installation failures", async () => {
    const env = makeEnv();
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 3, owner_login: "partial-org", repository_selection: "selected", suspended_at: null },
    ]);
    mockTracedFetch
      .mockResolvedValueOnce(
        githubOkJson([
          {
            full_name: "partial-org/granted-repo",
            html_url: "https://github.com/partial-org/granted-repo",
            private: true,
            default_branch: "main",
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("network exploded"));

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [],
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 3,
        status: 0,
        error: "GitHub installation repositories API exception: network exploded",
      }),
      "Failed to fetch selected installation repositories; filtering that owner closed",
    );
  });

  it("normalizes owner.type from /user/repos into ownerType, failing safe to User", async () => {
    const env = makeEnv();
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/org-repo",
          html_url: "https://github.com/acme/org-repo",
          private: true,
          default_branch: "main",
          owner: { login: "acme", type: "Organization" },
        },
        {
          full_name: "acme/user-repo",
          html_url: "https://github.com/acme/user-repo",
          private: false,
          default_branch: "main",
          owner: { login: "acme", type: "User" },
        },
        {
          full_name: "acme/bot-repo",
          html_url: "https://github.com/acme/bot-repo",
          private: false,
          default_branch: "main",
          owner: { login: "acme", type: "Bot" },
        },
      ]),
    );

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "miss",
      repos: [
        { fullName: "acme/org-repo", ownerType: "Organization" },
        { fullName: "acme/user-repo", ownerType: "User" },
        // Unexpected owner type (e.g. "Bot") normalizes to "User".
        { fullName: "acme/bot-repo", ownerType: "User" },
      ],
    });
  });

  it("returns ownerType on a KV cache hit (schema-version bump guard)", async () => {
    const store = new Map<string, string>();
    store.set(REPOS_INSTALLATIONS_VERSION_KEY, "version-1");
    store.set(
      `${REPOS_CACHE_KEY_PREFIX}:42`,
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "version-1",
        repos: [
          {
            fullName: "acme/org-repo",
            url: "https://github.com/acme/org-repo",
            private: true,
            defaultBranch: "main",
            ownerType: "Organization",
          },
        ],
        ssoOrgs: [],
      }),
    );
    const env = makeEnv({ store });

    const result = await listAccessibleRepos(env, makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      cacheStatus: "hit",
      repos: [{ fullName: "acme/org-repo", ownerType: "Organization" }],
    });
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });
});

describe("repo file listing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReposMemoryCache();
    mockGetValidGithubToken.mockResolvedValue("ghu_test");
    mockFetchRepoTree.mockResolvedValue(["README.md"]);
  });

  function seedAccessibleRepo(store: FakeKvStore, userId = "42", fullName = "acme/widgets") {
    store.set(REPOS_INSTALLATIONS_VERSION_KEY, "version-1");
    store.set(
      `${REPOS_CACHE_KEY_PREFIX}:${userId}`,
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "version-1",
        repos: [
          {
            fullName,
            url: `https://github.com/${fullName}`,
            private: true,
            defaultBranch: "main",
            ownerType: "Organization",
          },
        ],
        ssoOrgs: [],
      }),
    );
  }

  it("serves cached repo files after proving cached repo access", async () => {
    const store = new Map<string, string>();
    seedAccessibleRepo(store);
    store.set("files:42:acme:widgets:main", JSON.stringify({ files: ["README.md", "src/index.ts"] }));
    const env = makeEnv({ store });

    const result = await listRepoFilesForUser(env, "42", "acme", "widgets", "main");

    expect(result).toEqual({ ok: true, files: ["README.md", "src/index.ts"] });
    expect(mockFetchRepoTree).not.toHaveBeenCalled();
  });

  it("fetches and caches repo files on cache miss", async () => {
    const store = new Map<string, string>();
    seedAccessibleRepo(store);
    const env = makeEnv({ store });
    mockFetchRepoTree.mockResolvedValueOnce(["README.md", "src/index.ts"]);

    const result = await listRepoFilesForUser(env, "42", "acme", "widgets", "feature/a");

    expect(result).toEqual({ ok: true, files: ["README.md", "src/index.ts"] });
    expect(mockFetchRepoTree).toHaveBeenCalledWith("ghu_test", "acme", "widgets", "feature/a");
    expect(env.REPOS_CACHE.put).toHaveBeenCalledWith(
      "files:42:acme:widgets:feature/a",
      JSON.stringify({ files: ["README.md", "src/index.ts"] }),
      { expirationTtl: 300 },
    );
  });

  it("uses lowercase owner and repo segments for repo file cache keys", async () => {
    const store = new Map<string, string>();
    seedAccessibleRepo(store, "42", "acme/widgets");
    store.set("files:42:acme:widgets:main", JSON.stringify({ files: ["README.md"] }));
    const env = makeEnv({ store });

    const result = await listRepoFilesForUser(env, "42", "Acme", "Widgets", "main");

    expect(result).toEqual({ ok: true, files: ["README.md"] });
    expect(env.REPOS_CACHE.get).toHaveBeenCalledWith("files:42:acme:widgets:main", "json");
    expect(mockFetchRepoTree).not.toHaveBeenCalled();
  });

  it("rejects branch names that are too long for repo file cache keys", async () => {
    const env = makeEnv();

    const result = await listRepoFilesForUser(env, "42", "acme", "widgets", "a".repeat(201));

    expect(result).toEqual({ ok: false, status: 400, error: "Branch name too long" });
    expect(mockGetValidGithubToken).not.toHaveBeenCalled();
    expect(env.REPOS_CACHE.get).not.toHaveBeenCalled();
    expect(mockFetchRepoTree).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no usable GitHub token", async () => {
    const store = new Map<string, string>();
    seedAccessibleRepo(store);
    const env = makeEnv({ store });
    mockGetValidGithubToken.mockResolvedValueOnce(null);

    const result = await listRepoFilesForUser(env, "42", "acme", "widgets", "main");

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(mockFetchRepoTree).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid owner and repo segments", async () => {
    const env = makeEnv();

    await expect(listRepoFilesForUser(env, "42", "", "widgets", "main")).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(listRepoFilesForUser(env, "42", "acme", "../widgets", "main")).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    expect(mockGetValidGithubToken).not.toHaveBeenCalled();
  });

  it("denies repo access before reading a stale file cache or calling GitHub", async () => {
    const store = new Map<string, string>();
    store.set("files:42:acme:widgets:main", JSON.stringify({ files: ["stale-secret.ts"] }));
    const env = makeEnv({ store });

    const result = await listRepoFilesForUser(env, "42", "acme", "widgets", "main");

    expect(result).toEqual({ ok: false, status: 404, error: "Repository not found" });
    expect(env.REPOS_CACHE.get).not.toHaveBeenCalledWith("files:42:acme:widgets:main", "json");
    expect(mockFetchRepoTree).not.toHaveBeenCalled();
  });

  it.each([
    [new GitHubRequestError("GitHub tree fetch", 404), 404],
    [new GitHubRequestError("GitHub tree fetch", 403), 404],
    [new GitHubRequestError("GitHub tree fetch", 429), 429],
    [new GitHubRequestError("GitHub tree fetch", 500), 502],
    [new Error("network down"), 502],
  ])("maps repo tree failure %s to %s", async (error, status) => {
    const store = new Map<string, string>();
    seedAccessibleRepo(store);
    const env = makeEnv({ store });
    mockFetchRepoTree.mockRejectedValueOnce(error);

    await expect(listRepoFilesForUser(env, "42", "acme", "widgets", "main")).resolves.toMatchObject({
      ok: false,
      status,
    });
  });
});

function githubOkJsonWithSso(body: unknown, ssoHeader: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-github-sso": ssoHeader },
  });
}

const ACME_REPO = {
  full_name: "acme/repo-a",
  html_url: "https://github.com/acme/repo-a",
  private: true,
  default_branch: "main",
  description: "Repo A.",
};

describe("repos service cache-only (bootstrap)", () => {
  const USABLE_ENTRY = {
    schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
    installationVersion: "version-1",
    repos: [{ fullName: "acme/repo-a", url: "https://github.com/acme/repo-a", private: true, defaultBranch: "main" }],
    ssoOrgs: [],
  };

  function seedUsableCache(): FakeKvStore {
    const store = new Map<string, string>();
    store.set(REPOS_INSTALLATIONS_VERSION_KEY, "version-1");
    store.set(`${REPOS_CACHE_KEY_PREFIX}:42`, JSON.stringify(USABLE_ENTRY));
    return store;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetReposMemoryCache();
    mockGetValidGithubToken.mockResolvedValue("ghu_test");
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 1, owner_login: "acme", repository_selection: "all", suspended_at: null },
    ]);
    mockGetCachedInstallationReposForInstallations.mockResolvedValue(new Map());
    mockCacheInstallationRepos.mockResolvedValue(undefined);
    mockGetInstallationsByOwnerIds.mockResolvedValue([]);
    mockDeleteCachedInstallationReposForUser.mockResolvedValue(undefined);
  });

  it("returns a usable cache hit inline without a GitHub repo-list fetch", async () => {
    const env = makeEnv({ store: seedUsableCache() });

    const result = await listAccessibleReposCacheFirst(env, makeRequest(), "42");

    expect(result).toMatchObject({ ok: true, repos: [{ fullName: "acme/repo-a" }], cacheStatus: "hit" });
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("returns pending on a cache miss without fetching from GitHub", async () => {
    const env = makeEnv(); // empty store

    const result = await listAccessibleReposCacheFirst(env, makeRequest(), "42");

    expect(result).toMatchObject({ ok: true, pending: true, repos: null, cacheStatus: "pending" });
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(expect.objectContaining({ userId: "42", cache: "pending" }), "repos.list");
  });

  it("treats a version-stale entry as pending and never serves it (authorization)", async () => {
    const store = new Map<string, string>();
    // Entry tagged version-1 but the live installation version moved to version-2:
    // a user dropped from an installation must refetch, not see stale repos.
    store.set(REPOS_INSTALLATIONS_VERSION_KEY, "version-2");
    store.set(`${REPOS_CACHE_KEY_PREFIX}:42`, JSON.stringify(USABLE_ENTRY));
    const env = makeEnv({ store });

    const result = await listAccessibleReposCacheFirst(env, makeRequest(), "42");

    expect(result).toMatchObject({ ok: true, pending: true, repos: null });
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("still performs a full live fetch when the request asks to refresh", async () => {
    const env = makeEnv({ store: seedUsableCache() });
    mockTracedFetch.mockResolvedValueOnce(
      githubOkJson([
        {
          full_name: "acme/repo-fresh",
          html_url: "https://github.com/acme/repo-fresh",
          private: true,
          default_branch: "main",
        },
      ]),
    );

    const result = await listAccessibleReposCacheFirst(env, makeRefreshRequest(), "42");

    expect(result).toMatchObject({ ok: true, repos: [{ fullName: "acme/repo-fresh" }], cacheStatus: "bypass" });
    expect(mockTracedFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com/user/repos"),
      expect.any(Object),
      "github.repoList",
    );
  });

  it("fails closed (not pending) when the GitHub token is missing", async () => {
    mockGetValidGithubToken.mockResolvedValue(null);
    const env = makeEnv();

    const result = await listAccessibleReposCacheFirst(env, makeRequest(), "42");

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });
});

describe("parseSsoWithheldOrgIds", () => {
  it("parses a comma-separated org list", () => {
    expect([...parseSsoWithheldOrgIds("partial-results; organizations=1,2,3")]).toEqual([1, 2, 3]);
  });

  it("parses a single withheld org (live header form)", () => {
    expect([...parseSsoWithheldOrgIds("partial-results; organizations=144570272")]).toEqual([144570272]);
  });

  it("tolerates whitespace between ids", () => {
    expect([...parseSsoWithheldOrgIds("partial-results; organizations=1, 2 , 3")]).toEqual([1, 2, 3]);
  });

  it("returns empty for absent header", () => {
    expect(parseSsoWithheldOrgIds(null).size).toBe(0);
    expect(parseSsoWithheldOrgIds(undefined).size).toBe(0);
  });

  it("returns empty when there is no organizations token", () => {
    expect(parseSsoWithheldOrgIds("partial-results").size).toBe(0);
  });

  it("ignores non-numeric values", () => {
    expect(parseSsoWithheldOrgIds("partial-results; organizations=abc").size).toBe(0);
  });
});

describe("repos service SSO-withheld detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReposMemoryCache();
    mockGetValidGithubToken.mockResolvedValue("ghu_test");
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 1, owner_login: "acme", repository_selection: "all", suspended_at: null },
    ]);
    mockGetCachedInstallationReposForInstallations.mockResolvedValue(new Map());
    mockCacheInstallationRepos.mockResolvedValue(undefined);
    mockGetInstallationsByOwnerIds.mockResolvedValue([]);
  });

  it("maps a withheld org to its login and authorize URL when an installation exists", async () => {
    mockGetInstallationsByOwnerIds.mockResolvedValue([
      { owner_id: 144570272, owner_login: "mialabs", suspended_at: null },
    ]);
    mockTracedFetch.mockResolvedValueOnce(githubOkJsonWithSso([ACME_REPO], "partial-results; organizations=144570272"));

    const result = await listAccessibleRepos(makeEnv(), makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      ssoOrgs: [{ orgId: 144570272, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }],
    });
    expect(mockGetInstallationsByOwnerIds).toHaveBeenCalledWith(expect.anything(), [144570272]);
  });

  it("falls back to a null login when no installation row maps the org id", async () => {
    mockGetInstallationsByOwnerIds.mockResolvedValue([]);
    mockTracedFetch.mockResolvedValueOnce(githubOkJsonWithSso([ACME_REPO], "partial-results; organizations=999"));

    const result = await listAccessibleRepos(makeEnv(), makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      ssoOrgs: [{ orgId: 999, login: null, authorizeUrl: null }],
    });
  });

  it("returns no ssoOrgs when the header is absent", async () => {
    mockTracedFetch.mockResolvedValueOnce(githubOkJson([ACME_REPO]));
    const result = await listAccessibleRepos(makeEnv(), makeRequest(), "42");
    expect(result).toMatchObject({ ok: true, ssoOrgs: [] });
    expect(mockGetInstallationsByOwnerIds).not.toHaveBeenCalled();
  });

  it("unions withheld org ids across paginated pages", async () => {
    mockGetInstallationsByOwnerIds.mockResolvedValue([
      { owner_id: 111, owner_login: "org-a", suspended_at: null },
      { owner_id: 222, owner_login: "org-b", suspended_at: null },
    ]);
    // Page 1 returns a full 100 repos (forces a second fetch) with org 111
    // withheld; page 2 ends pagination and reports org 222.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      full_name: `acme/repo-${i}`,
      html_url: `https://github.com/acme/repo-${i}`,
      private: false,
      default_branch: "main",
    }));
    mockTracedFetch
      .mockResolvedValueOnce(githubOkJsonWithSso(fullPage, "partial-results; organizations=111"))
      .mockResolvedValueOnce(githubOkJsonWithSso([ACME_REPO], "partial-results; organizations=222"));

    const result = await listAccessibleRepos(makeEnv(), makeRequest(), "42");

    expect(result).toMatchObject({
      ok: true,
      ssoOrgs: [
        { orgId: 111, login: "org-a", authorizeUrl: "/auth/github/sso?org=org-a" },
        { orgId: 222, login: "org-b", authorizeUrl: "/auth/github/sso?org=org-b" },
      ],
    });
    expect(mockGetInstallationsByOwnerIds).toHaveBeenCalledTimes(1);
    expect(mockGetInstallationsByOwnerIds).toHaveBeenCalledWith(expect.anything(), [111, 222]);
  });

  it("rejects a cache entry whose ssoOrgs field is missing", async () => {
    const store = new Map<string, string>();
    store.set(REPOS_INSTALLATIONS_VERSION_KEY, "version-1");
    // Simulates a v4-tagged KV entry that lost ssoOrgs (malformed write).
    store.set(
      `${REPOS_CACHE_KEY_PREFIX}:42`,
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "version-1",
        repos: [{ fullName: "acme/repo-a", url: "https://github.com/acme/repo-a" }],
      }),
    );
    mockTracedFetch.mockResolvedValueOnce(githubOkJson([ACME_REPO]));

    const result = await listAccessibleRepos(makeEnv({ store }), makeRequest(), "42");

    // The malformed entry is treated as stale: refetch instead of serving a
    // hit with undefined ssoOrgs.
    expect(result).toMatchObject({ ok: true, cacheStatus: "miss", ssoOrgs: [] });
    expect(mockTracedFetch).toHaveBeenCalledTimes(1);
  });

  it("serves persisted ssoOrgs from the cache hit without refetching", async () => {
    mockGetInstallationsByOwnerIds.mockResolvedValue([
      { owner_id: 144570272, owner_login: "mialabs", suspended_at: null },
    ]);
    mockTracedFetch.mockResolvedValueOnce(githubOkJsonWithSso([ACME_REPO], "partial-results; organizations=144570272"));
    const env = makeEnv();

    const first = await listAccessibleRepos(env, makeRequest(), "42");
    expect(first).toMatchObject({ cacheStatus: "miss", ssoOrgs: [{ login: "mialabs" }] });

    mockTracedFetch.mockClear();
    const second = await listAccessibleRepos(env, makeRequest(), "42");

    expect(second).toMatchObject({
      cacheStatus: "hit",
      ssoOrgs: [{ orgId: 144570272, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }],
    });
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockGetInstallationsByOwnerIds).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateReposCacheForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReposMemoryCache();
    mockGetValidGithubToken.mockResolvedValue("ghu_test");
    mockGetActiveInstallationsForOwners.mockResolvedValue([
      { installation_id: 1, owner_login: "acme", repository_selection: "all", suspended_at: null },
    ]);
    mockGetCachedInstallationReposForInstallations.mockResolvedValue(new Map());
    mockCacheInstallationRepos.mockResolvedValue(undefined);
    mockGetInstallationsByOwnerIds.mockResolvedValue([]);
    mockDeleteCachedInstallationReposForUser.mockResolvedValue(undefined);
  });

  it("clears KV, memory, and the per-installation D1 cache so the next fetch is a miss", async () => {
    const store = new Map<string, string>();
    const del = vi.fn(async (key: string) => {
      store.delete(key);
    });
    const env = makeEnv({ store });
    (env.REPOS_CACHE as unknown as { delete: typeof del }).delete = del;

    // Prime the memory + KV cache via a miss.
    mockTracedFetch.mockResolvedValueOnce(githubOkJson([ACME_REPO]));
    await listAccessibleRepos(env, makeRequest(), "42");
    expect(store.has(`${REPOS_CACHE_KEY_PREFIX}:42`)).toBe(true);

    await invalidateReposCacheForUser(env, "42");

    expect(del).toHaveBeenCalledWith(`${REPOS_CACHE_KEY_PREFIX}:42`);
    expect(mockDeleteCachedInstallationReposForUser).toHaveBeenCalledWith(expect.anything(), "42");

    // Memory was dropped too: the next call refetches instead of serving a hit.
    mockTracedFetch.mockResolvedValueOnce(githubOkJson([ACME_REPO]));
    const after = await listAccessibleRepos(env, makeRequest(), "42");
    expect(after).toMatchObject({ cacheStatus: "miss" });
    expect(mockTracedFetch).toHaveBeenCalledTimes(2);
  });

  it("accepts a numeric user id", async () => {
    const del = vi.fn(async () => {});
    const env = makeEnv();
    (env.REPOS_CACHE as unknown as { delete: typeof del }).delete = del;
    await invalidateReposCacheForUser(env, 42);
    expect(del).toHaveBeenCalledWith(`${REPOS_CACHE_KEY_PREFIX}:42`);
    expect(mockDeleteCachedInstallationReposForUser).toHaveBeenCalledWith(expect.anything(), "42");
  });
});
