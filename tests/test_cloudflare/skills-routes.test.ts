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

const mockFetchRepoSkills = vi.fn();
vi.mock("../../apps/control-plane-worker/src/github/skills", () => ({
  fetchRepoSkills: (...args: unknown[]) => mockFetchRepoSkills(...args),
}));

const mockVerifyUserRepoAccess = vi.fn();
vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

type WorkerModule = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
};

// ---------------------------------------------------------------------------
// Minimal D1 fake (auth only)
// ---------------------------------------------------------------------------

type AuthRow = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id: string | null;
  shared_sessions: number | null;
};

class FakeD1Statement {
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}
  private boundValues: unknown[] = [];
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      return (this.db.authTokens.get(token) ?? null) as T | null;
    }
    return null;
  }
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    return { success: true, meta: { last_row_id: 0 } };
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

class FakeD1 {
  authTokens = new Map<string, AuthRow>();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
  batch(stmts: FakeD1Statement[]): Promise<unknown[]> {
    return Promise.all(stmts.map((s) => s.run()));
  }
}

// ---------------------------------------------------------------------------
// Fake DO namespace + KV
// ---------------------------------------------------------------------------

class FakeStorage {
  private readonly map = new Map<string, unknown>();
  private alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") this.map.set(keyOrEntries, value);
    else for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, v);
  }
  async setAlarm(): Promise<void> {
    this.alarm = Date.now() + 60000;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  sql = {
    exec(_query: string, ..._params: unknown[]) {
      return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
    },
    get databaseSize() {
      return 0;
    },
  };
}

class FakeDurableState {
  readonly storage = new FakeStorage();
  readonly id = { toString: () => "fake-do-id" };
  blockConcurrencyWhile = async (fn: () => Promise<unknown>) => {
    await fn();
  };
  waitUntil(): void {}
}

function createEnv(db: FakeD1): Record<string, unknown> {
  return {
    DB: db,
    SESSION: {
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true })) }),
      idFromName: () => ({ toString: () => "fake-id" }),
    },
    REPOS_CACHE: { get: async () => null, put: async () => {} },
    RATE_LIMITS: { get: async () => null, put: async () => {} },
    DERIVED_MODELS: { get: async () => null, put: async () => {} },
    WORKER_ENV: "test",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/repos/:owner/:repo/skills", () => {
  let worker: WorkerModule;
  let db: FakeD1;
  let env: Record<string, unknown>;
  const AUTH_TOKEN = "test-session-token";

  beforeAll(async () => {
    worker = (await import("../../apps/control-plane-worker/src/index")) as unknown as WorkerModule;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = new FakeD1();
    env = createEnv(db);
    mockVerifyUserRepoAccess.mockResolvedValue(true);

    // Seed auth user (matches the JOIN shape from resolveAuthSession)
    db.authTokens.set(AUTH_TOKEN, {
      user_id: 1,
      expires_at: Date.now() + 86400000,
      id: 1,
      login: "testuser",
      name: "Test",
      email: "test@example.com",
      business_id: "biz-1",
      shared_sessions: 0,
    });
  });

  function makeRequest(path: string, cookie?: string): Request {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = `session_token=${cookie}`;
    return new Request(`https://test.example.com${path}`, { headers });
  }

  it("returns 401 without auth", async () => {
    const res = await worker.default.fetch(makeRequest("/api/repos/owner/repo/skills"), env);
    expect(res.status).toBe(401);
  });

  it("returns skills for authenticated user", async () => {
    mockFetchRepoSkills.mockResolvedValue([
      {
        name: "review-spec",
        description: "Review a tech spec",
        argument: "optional -- spec path",
        content: "# Review\n\nFull content here",
      },
      { name: "ship-prod", description: "Deploy to production", content: "# Deploy\n\nSteps..." },
    ]);

    const res = await worker.default.fetch(makeRequest("/api/repos/myorg/myrepo/skills", AUTH_TOKEN), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; description: string; argument?: string; content?: string }>;
    };
    expect(body.skills).toHaveLength(2);
    expect(body.skills[0]).toMatchObject({
      name: "review-spec",
      description: "Review a tech spec",
      argument: "optional -- spec path",
    });
    expect(body.skills[0]).not.toHaveProperty("content");
    expect(mockFetchRepoSkills).toHaveBeenCalledTimes(1);
    const [, userId, owner, repo] = mockFetchRepoSkills.mock.calls[0];
    expect(userId).toBe("1");
    expect(owner).toBe("myorg");
    expect(repo).toBe("myrepo");
    const [, accessUserId, accessOwner, accessRepo, accessOptions] = mockVerifyUserRepoAccess.mock.calls[0];
    expect(accessUserId).toBe("1");
    expect(accessOwner).toBe("myorg");
    expect(accessRepo).toBe("myrepo");
    expect(accessOptions.githubTokenEnv).toBe(accessOptions.reposCacheEnv);
  });

  it("returns 404 without fetching skills when repo access is denied", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(false);

    const res = await worker.default.fetch(makeRequest("/api/repos/owner/repo/skills", AUTH_TOKEN), env);

    expect(res.status).toBe(404);
    expect(mockFetchRepoSkills).not.toHaveBeenCalled();
  });

  it("returns 503 without fetching skills when repo access cannot be verified", async () => {
    mockVerifyUserRepoAccess.mockRejectedValue(new Error("github unavailable"));

    const res = await worker.default.fetch(makeRequest("/api/repos/owner/repo/skills", AUTH_TOKEN), env);

    expect(res.status).toBe(503);
    expect(mockFetchRepoSkills).not.toHaveBeenCalled();
  });

  it("returns empty array when repo has no skills", async () => {
    mockFetchRepoSkills.mockResolvedValue([]);

    const res = await worker.default.fetch(makeRequest("/api/repos/owner/empty-repo/skills", AUTH_TOKEN), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: unknown[] };
    expect(body.skills).toEqual([]);
  });
});
