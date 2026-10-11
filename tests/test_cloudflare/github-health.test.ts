import { beforeEach, describe, expect, it, vi } from "vitest";

const tracedFetch = vi.fn();
vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch,
}));

type HealthRow = {
  id: string;
  business_id: string;
  integration_id: string;
  check_kind: string;
  status: "passed" | "failed" | "skipped";
  operation: string;
  checked_at: number;
  latency_ms: number;
  diagnostic: string;
  failure_reason: string | null;
  details_json: string | null;
  created_at: number;
};

type UserRow = {
  id: number;
  business_id: string | null;
};

type GithubTokenRow = {
  user_id: number;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  encrypted: number;
};

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("SELECT business_id FROM users WHERE id = ?")) {
      const [userId] = this.values as [number];
      return (this.db.users.get(userId) as T | undefined) ?? null;
    }

    if (
      this.query.includes("FROM user_integrations") &&
      (this.query.includes("integration_id = 'github'") ||
        (this.query.includes("integration_id = ?") && this.values[1] === "github"))
    ) {
      const [userId] = this.values as [number, string?];
      const token = this.db.githubTokens.get(userId);
      if (!token?.oauth_access_token) return null;
      return (token as T | undefined) ?? null;
    }

    if (this.query.includes("FROM business_integration_health_checks")) {
      const [businessId, integrationId, checkKind] = this.values as [string, string, string];
      const rows = this.db.healthChecks
        .filter(
          (row) =>
            row.business_id === businessId && row.integration_id === integrationId && row.check_kind === checkKind,
        )
        .sort((a, b) => b.checked_at - a.checked_at);
      return (rows[0] as T | undefined) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }> {
    if (this.query.includes("DELETE FROM business_integration_health_checks")) {
      const [integrationId, cutoffCreatedAt] = this.values as [string, number];
      const originalLength = this.db.healthChecks.length;
      this.db.healthChecks = this.db.healthChecks.filter(
        (row) => row.integration_id !== integrationId || row.created_at >= cutoffCreatedAt,
      );
      return { success: true, meta: { last_row_id: 0, changes: originalLength - this.db.healthChecks.length } };
    }

    if (this.query.includes("INSERT INTO business_integration_health_checks")) {
      const [
        id,
        businessId,
        integrationId,
        checkKind,
        status,
        operation,
        checkedAt,
        latencyMs,
        diagnostic,
        failureReason,
        detailsJson,
        createdAt,
      ] = this.values as [
        string,
        string,
        string,
        string,
        HealthRow["status"],
        string,
        number,
        number,
        string,
        string | null,
        string | null,
        number,
      ];
      this.db.healthChecks.push({
        id,
        business_id: businessId,
        integration_id: integrationId,
        check_kind: checkKind,
        status,
        operation,
        checked_at: checkedAt,
        latency_ms: latencyMs,
        diagnostic,
        failure_reason: failureReason,
        details_json: detailsJson,
        created_at: createdAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }
}

class FakeD1 {
  readonly users = new Map<number, UserRow>();
  readonly githubTokens = new Map<number, GithubTokenRow>();
  healthChecks: HealthRow[] = [];

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

function seedGithubOwner(db: FakeD1, userId = 101, businessId = "biz-1"): void {
  db.users.set(userId, { id: userId, business_id: businessId });
  db.githubTokens.set(userId, {
    user_id: userId,
    oauth_access_token: "github-access-token",
    oauth_refresh_token: null,
    oauth_expires_at: null,
    encrypted: 0,
  });
}

function createGithubEnv(db: FakeD1): import("../../apps/control-plane-worker/src/types").Env {
  seedGithubOwner(db);
  return {
    DB: db as unknown as D1Database,
    GITHUB_HEALTH_ENABLED: "true",
    GITHUB_HEALTH_OWNER_USER_ID: "101",
    GITHUB_HEALTH_REPO_OWNER: "trycycloid",
    GITHUB_HEALTH_REPO_NAME: "cycloid",
  } as import("../../apps/control-plane-worker/src/types").Env;
}

describe("GitHub integration health checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("proves configured GitHub repo access with the owner user's OAuth token", async () => {
    const { runDueGithubHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/github-health.js");
    const db = new FakeD1();
    const env = createGithubEnv(db);
    tracedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ full_name: "trycycloid/cycloid", private: true, default_branch: "main" }), {
        status: 200,
      }),
    );

    const result = await runDueGithubHealthChecks(env, { now: 1234 });

    expect(result).toEqual({ checked: 1, skipped: 0, failed: 0 });
    expect(tracedFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/trycycloid/cycloid",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer github-access-token" }),
      }),
      "github.health.repo",
    );
    expect(db.healthChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          business_id: "biz-1",
          integration_id: "github",
          check_kind: "basic",
          status: "passed",
          operation: "github.repos.get",
          diagnostic: "github_repo_access_confirmed",
        }),
      ]),
    );
  });

  it("fails closed when the configured owner user has no GitHub OAuth token", async () => {
    const { runDueGithubHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/github-health.js");
    const db = new FakeD1();
    const env = createGithubEnv(db);
    db.githubTokens.delete(101);

    const result = await runDueGithubHealthChecks(env, { now: 1234 });

    expect(result).toEqual({ checked: 1, skipped: 0, failed: 1 });
    expect(tracedFetch).not.toHaveBeenCalled();
    expect(db.healthChecks[0]).toMatchObject({
      status: "failed",
      diagnostic: "github_token_missing",
      failure_reason: "GitHub OAuth token could not be resolved or refreshed for the configured owner user.",
    });
  });

  it("prunes only old GitHub health rows during the retention sweep", async () => {
    const { runDueGithubHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/github-health.js");
    const db = new FakeD1();
    const env = createGithubEnv(db);
    env.GITHUB_HEALTH_ENABLED = "false";
    db.healthChecks.push(
      {
        id: "old-github",
        business_id: "biz-1",
        integration_id: "github",
        check_kind: "basic",
        status: "passed",
        operation: "github.repos.get",
        checked_at: 1,
        latency_ms: 1,
        diagnostic: "github_repo_access_confirmed",
        failure_reason: null,
        details_json: null,
        created_at: 1,
      },
      {
        id: "old-sentry",
        business_id: "biz-1",
        integration_id: "sentry",
        check_kind: "basic",
        status: "passed",
        operation: "sentry.projects.list",
        checked_at: 1,
        latency_ms: 1,
        diagnostic: "sentry_ok",
        failure_reason: null,
        details_json: null,
        created_at: 1,
      },
    );

    const result = await runDueGithubHealthChecks(env, { now: 100 * 24 * 60 * 60 * 1000 });

    expect(result).toEqual({ checked: 0, skipped: 0, failed: 0 });
    expect(db.healthChecks).toEqual([expect.objectContaining({ id: "old-sentry", integration_id: "sentry" })]);
  });
});
