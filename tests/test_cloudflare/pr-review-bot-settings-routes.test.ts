import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";
import { createDurableNamespace, type DurableNamespace, type WorkerModule } from "./helpers/worker-harness";

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

const repoAuthMocks = vi.hoisted(() => ({
  verifyUserRepoAccess: vi.fn(),
}));

const authDbMocks = vi.hoisted(() => ({
  getValidGithubTokenResult: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: repoAuthMocks.verifyUserRepoAccess,
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/auth/db")>(
    "../../apps/control-plane-worker/src/auth/db",
  );
  return {
    ...actual,
    getValidGithubTokenResult: authDbMocks.getValidGithubTokenResult,
  };
});

type ExpectedPrReviewBot =
  | { type: "known"; id: "greptile" | "coderabbit" | "cursor-bugbot" | "chatgpt-codex" | "strix" }
  | { type: "custom"; login: string };

type RoutesModule = typeof import("../../apps/control-plane-worker/src/settings/routes") & {
  handleGetPrReviewBotSettings: (
    request: Request,
    env: Env,
    auth: AuthInfo,
    owner: string,
    repo: string,
  ) => Promise<Response>;
  handlePutPrReviewBotSettings: (
    request: Request,
    env: Env,
    auth: AuthInfo,
    owner: string,
    repo: string,
  ) => Promise<Response>;
  handleListPrReviewBotSettings: (request: Request, env: Env, auth: AuthInfo) => Promise<Response>;
};

interface PrReviewBotSettingsRow {
  user_id: number;
  repo_owner: string;
  repo_name: string;
  expected_bots_json: string;
  merge_conflict_resolution_enabled: number;
  created_at: number;
  updated_at: number;
}

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true }> {
    if (this.query.includes("INSERT INTO user_pr_review_bot_settings")) {
      const [userId, repoOwner, repoName, expectedBotsJson, mergeConflictResolutionEnabled, createdAt, updatedAt] = this
        .boundValues as [number, string, string, string, number, number, number];
      const key = `${userId}:${repoOwner}/${repoName}`;
      const existing = this.db.rows.get(key);
      this.db.rows.set(key, {
        user_id: userId,
        repo_owner: repoOwner,
        repo_name: repoName,
        expected_bots_json: expectedBotsJson,
        merge_conflict_resolution_enabled: mergeConflictResolutionEnabled,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }
    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM user_pr_review_bot_settings")) {
      const [userId, repoOwner, repoName] = this.boundValues as [number, string, string];
      return (this.db.rows.get(`${userId}:${repoOwner}/${repoName}`) as T | undefined) ?? null;
    }
    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM user_pr_review_bot_settings")) {
      const userId = this.boundValues[0] as number;
      const hasCursor = this.boundValues.length >= 5;
      const cursorOwner = hasCursor ? (this.boundValues[1] as string) : null;
      const cursorRepo = hasCursor ? (this.boundValues[3] as string) : null;
      const limit = this.boundValues[this.boundValues.length - 1] as number;
      const results = [...this.db.rows.values()]
        .filter((row) => row.user_id === userId)
        .filter((row) => row.expected_bots_json !== "[]" || row.merge_conflict_resolution_enabled !== 1)
        .filter((row) => {
          if (!cursorOwner || !cursorRepo) return true;
          return row.repo_owner > cursorOwner || (row.repo_owner === cursorOwner && row.repo_name > cursorRepo);
        })
        .sort((a, b) => a.repo_owner.localeCompare(b.repo_owner) || a.repo_name.localeCompare(b.repo_name))
        .slice(0, limit);
      return { results: results as unknown as Array<Record<string, unknown>> };
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }
}

class FakeD1 {
  readonly rows = new Map<string, PrReviewBotSettingsRow>();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

async function createRateLimiterNamespace(): Promise<DurableNamespace> {
  const { SessionResumeRateLimiterDO } =
    await import("../../apps/control-plane-worker/src/session/resume-rate-limiter-do");
  return createDurableNamespace(
    SessionResumeRateLimiterDO as unknown as WorkerModule["SessionResumeRateLimiterDO"],
    {},
  );
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://worker.test${path}`, init);
}

const userSessionAuth: AuthInfo = {
  userId: "42",
  tokenSource: "cookie",
  authMode: "user_session",
  canAccessAllSessions: false,
};

const cliAuth: AuthInfo = {
  userId: "42",
  tokenSource: "bearer",
  authMode: "cli_token",
  canAccessAllSessions: false,
  cliTokenScope: "write",
  cliTokenId: 1,
};

function jsonRequest(path: string, body: unknown): Request {
  return request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PR review bot settings routes", () => {
  let routes: RoutesModule;
  let db: FakeD1;
  let rateLimiter: DurableNamespace;
  let env: Env;

  beforeEach(async () => {
    routes = (await import("../../apps/control-plane-worker/src/settings/routes")) as RoutesModule;
    db = new FakeD1();
    rateLimiter = await createRateLimiterNamespace();
    env = { DB: db, SESSION_RESUME_RATE_LIMITER: rateLimiter } as unknown as Env;
    repoAuthMocks.verifyUserRepoAccess.mockReset().mockResolvedValue(true);
    authDbMocks.getValidGithubTokenResult.mockReset().mockResolvedValue({ ok: true, token: "ghp_test_token" });
  });

  it("returns an empty checklist for missing repo settings after repo authorization", async () => {
    const res = await routes.handleGetPrReviewBotSettings(
      request("/api/settings/repositories/TryCycloid/Cycloid/pr-review-bots"),
      env,
      userSessionAuth,
      "TryCycloid",
      "Cycloid",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    expect(repoAuthMocks.verifyUserRepoAccess).toHaveBeenCalledWith(db, "42", "trycycloid", "cycloid", {
      githubTokenEnv: env,
      reposCacheEnv: undefined,
    });
  });

  it("saves normalized known and custom bots and allows saving an empty list", async () => {
    const save = await routes.handlePutPrReviewBotSettings(
      jsonRequest("/api/settings/repositories/TryCycloid/Cycloid/pr-review-bots", {
        expectedBots: [
          { type: "known", id: "greptile" },
          { type: "custom", login: "Team-Review-Bot" },
        ] satisfies ExpectedPrReviewBot[],
        mergeConflictResolutionEnabled: true,
      }),
      env,
      userSessionAuth,
      "TryCycloid",
      "Cycloid",
    );

    expect(save.status).toBe(200);
    expect(await save.json()).toEqual({
      expectedBots: [
        { type: "known", id: "greptile" },
        { type: "custom", login: "team-review-bot" },
      ],
      mergeConflictResolutionEnabled: true,
    });

    const empty = await routes.handlePutPrReviewBotSettings(
      jsonRequest("/api/settings/repositories/TryCycloid/Cycloid/pr-review-bots", { expectedBots: [] }),
      env,
      userSessionAuth,
      "TryCycloid",
      "Cycloid",
    );

    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    expect(db.rows.get("42:trycycloid/cycloid")?.expected_bots_json).toBe("[]");
  });

  it("rejects a legacy reviewTimeoutMinutes field (schema is strict)", async () => {
    const res = await routes.handlePutPrReviewBotSettings(
      jsonRequest("/api/settings/repositories/TryCycloid/Cycloid/pr-review-bots", {
        expectedBots: [],
        reviewTimeoutMinutes: 20,
      }),
      env,
      userSessionAuth,
      "TryCycloid",
      "Cycloid",
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Invalid PR review bot settings" });
  });

  it("rejects CLI token auth for all checklist endpoints", async () => {
    const res = await routes.handleGetPrReviewBotSettings(
      request("/api/settings/repositories/owner/repo/pr-review-bots"),
      env,
      cliAuth,
      "owner",
      "repo",
    );

    expect(res.status).toBe(403);
  });

  it("validates route params before authorization", async () => {
    const res = await routes.handleGetPrReviewBotSettings(
      request("/api/settings/repositories/-bad/repo/pr-review-bots"),
      env,
      userSessionAuth,
      "-bad",
      "repo",
    );

    expect(res.status).toBe(400);
    expect(repoAuthMocks.verifyUserRepoAccess).not.toHaveBeenCalled();
  });

  it("uses bounded JSON parsing with generic errors", async () => {
    const nonJson = await routes.handlePutPrReviewBotSettings(
      request("/api/settings/repositories/owner/repo/pr-review-bots", {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ expectedBots: [] }),
      }),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );
    expect(nonJson.status).toBe(415);

    const malformed = await routes.handlePutPrReviewBotSettings(
      request("/api/settings/repositories/owner/repo/pr-review-bots", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );
    expect(malformed.status).toBe(400);

    const oversized = await routes.handlePutPrReviewBotSettings(
      request("/api/settings/repositories/owner/repo/pr-review-bots", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedBots: [], padding: "x".repeat(9_000) }),
      }),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );
    expect(oversized.status).toBe(400);
  });

  it("rejects duplicate and colliding bots with a specific reason", async () => {
    const { prReviewBotSettingsRejectionMessage } =
      await import("../../apps/control-plane-worker/src/settings/service");
    const cases: Array<{ expectedBots: ExpectedPrReviewBot[]; code: string }> = [
      {
        expectedBots: [
          { type: "known", id: "greptile" },
          { type: "known", id: "greptile" },
        ],
        code: "duplicate_known_bot",
      },
      {
        expectedBots: [
          { type: "custom", login: "team-bot" },
          { type: "custom", login: "Team-Bot" },
        ],
        code: "duplicate_custom_bot",
      },
      { expectedBots: [{ type: "custom", login: "greptile" }], code: "custom_collides_with_known_id" },
      { expectedBots: [{ type: "custom", login: "cursor" }], code: "custom_collides_with_reserved_actor" },
      { expectedBots: [{ type: "custom", login: "cycloid-dev" }], code: "custom_collides_with_reserved_actor" },
    ];

    for (const { expectedBots, code } of cases) {
      const res = await routes.handlePutPrReviewBotSettings(
        jsonRequest("/api/settings/repositories/owner/repo/pr-review-bots", { expectedBots }),
        env,
        userSessionAuth,
        "owner",
        "repo",
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: prReviewBotSettingsRejectionMessage(code),
        code,
      });
    }
  });

  it("returns 403 and 503 for repo authorization failures", async () => {
    repoAuthMocks.verifyUserRepoAccess.mockResolvedValueOnce(false);
    const denied = await routes.handleGetPrReviewBotSettings(
      request("/api/settings/repositories/owner/repo/pr-review-bots"),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );
    expect(denied.status).toBe(403);

    repoAuthMocks.verifyUserRepoAccess.mockRejectedValueOnce(new Error("github exploded"));
    const unavailable = await routes.handleGetPrReviewBotSettings(
      request("/api/settings/repositories/owner/repo/pr-review-bots"),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ ok: false, error: "Unable to verify repository access" });
  });

  it("does not consume write rate limit quota before repo authorization succeeds", async () => {
    repoAuthMocks.verifyUserRepoAccess.mockResolvedValueOnce(false);
    const denied = await routes.handlePutPrReviewBotSettings(
      jsonRequest("/api/settings/repositories/owner/repo/pr-review-bots", { expectedBots: [] }),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );

    expect(denied.status).toBe(403);
    expect(rateLimiter._requests).toHaveLength(0);

    repoAuthMocks.verifyUserRepoAccess.mockRejectedValueOnce(new Error("github exploded"));
    const unavailable = await routes.handlePutPrReviewBotSettings(
      jsonRequest("/api/settings/repositories/owner/repo/pr-review-bots", { expectedBots: [] }),
      env,
      userSessionAuth,
      "owner",
      "repo",
    );

    expect(unavailable.status).toBe(503);
    expect(rateLimiter._requests).toHaveLength(0);
  });

  it("lists accessible non-empty repo configurations and omits stale inaccessible rows", async () => {
    db.rows.set("42:a/repo", {
      user_id: 42,
      repo_owner: "a",
      repo_name: "repo",
      expected_bots_json: JSON.stringify([{ type: "known", id: "greptile" }]),
      merge_conflict_resolution_enabled: 0,
      created_at: 1,
      updated_at: 1,
    });
    db.rows.set("42:b/repo", {
      user_id: 42,
      repo_owner: "b",
      repo_name: "repo",
      expected_bots_json: JSON.stringify([{ type: "known", id: "coderabbit" }]),
      merge_conflict_resolution_enabled: 0,
      created_at: 1,
      updated_at: 1,
    });
    // Fully-default empty row → omitted by the non-default list predicate.
    db.rows.set("42:c/repo", {
      user_id: 42,
      repo_owner: "c",
      repo_name: "repo",
      expected_bots_json: "[]",
      merge_conflict_resolution_enabled: 1,
      created_at: 1,
      updated_at: 1,
    });
    repoAuthMocks.verifyUserRepoAccess.mockImplementation(
      async (_db: unknown, _userId: string, owner: string) => owner !== "b",
    );

    const res = await routes.handleListPrReviewBotSettings(
      request("/api/settings/repositories/pr-review-bots?limit=50"),
      env,
      userSessionAuth,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
        {
          repoOwner: "a",
          repoName: "repo",
          expectedBots: [{ type: "known", id: "greptile" }],
          mergeConflictResolutionEnabled: false,
        },
      ],
      nextCursor: null,
    });
    expect(authDbMocks.getValidGithubTokenResult).toHaveBeenCalledTimes(1);
    expect(repoAuthMocks.verifyUserRepoAccess).toHaveBeenNthCalledWith(1, db, "42", "a", "repo", {
      preloadedGithubTokenResult: { ok: true, token: "ghp_test_token" },
      reposCacheEnv: undefined,
    });
    expect(repoAuthMocks.verifyUserRepoAccess).toHaveBeenNthCalledWith(2, db, "42", "b", "repo", {
      preloadedGithubTokenResult: { ok: true, token: "ghp_test_token" },
      reposCacheEnv: undefined,
    });
  });

  it("does not resolve a GitHub token when the settings list has no non-default rows", async () => {
    const res = await routes.handleListPrReviewBotSettings(
      request("/api/settings/repositories/pr-review-bots?limit=50"),
      env,
      userSessionAuth,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repositories: [], nextCursor: null });
    expect(authDbMocks.getValidGithubTokenResult).not.toHaveBeenCalled();
    expect(repoAuthMocks.verifyUserRepoAccess).not.toHaveBeenCalled();
  });

  it("rate limits checklist writes per user and repository", async () => {
    let lastStatus = 0;
    for (let index = 0; index < 31; index += 1) {
      const res = await routes.handlePutPrReviewBotSettings(
        jsonRequest("/api/settings/repositories/owner/repo/pr-review-bots", { expectedBots: [] }),
        env,
        userSessionAuth,
        "owner",
        "repo",
      );
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it("normalizes repo casing in rate limit keys", async () => {
    const { checkPrReviewBotSettingsRateLimit } =
      await import("../../apps/control-plane-worker/src/settings/rate-limit");

    await expect(
      checkPrReviewBotSettingsRateLimit(
        env as Parameters<typeof checkPrReviewBotSettingsRateLimit>[0],
        42,
        "Owner",
        "Repo",
      ),
    ).resolves.toBe(true);

    const ids = rateLimiter._requests.map((req) => req.id);
    expect(ids).toEqual(["pr_review_bots:rl:42:owner:repo"]);
  });

  it("enforces the cap under concurrent writes", async () => {
    const { checkPrReviewBotSettingsRateLimit } =
      await import("../../apps/control-plane-worker/src/settings/rate-limit");
    const limiterEnv = env as Parameters<typeof checkPrReviewBotSettingsRateLimit>[0];

    const results = await Promise.all(
      Array.from({ length: 40 }, () => checkPrReviewBotSettingsRateLimit(limiterEnv, 42, "owner", "repo")),
    );

    expect(results.filter((allowed) => allowed)).toHaveLength(30);
  });

  it("fails open when the rate limiter binding is missing", async () => {
    const { checkPrReviewBotSettingsRateLimit } =
      await import("../../apps/control-plane-worker/src/settings/rate-limit");

    await expect(
      checkPrReviewBotSettingsRateLimit({ SESSION_RESUME_RATE_LIMITER: undefined }, 42, "owner", "repo"),
    ).resolves.toBe(true);
  });
});
