import { beforeEach, describe, expect, it, vi } from "vitest";

const tracedFetch = vi.fn();
vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch,
}));

const getLinearTokens = vi.fn();
vi.mock("../../apps/control-plane-worker/src/integrations/db", () => ({
  getLinearTokens,
}));

type InstallationRow = {
  business_id: string;
  linear_organization_id: string;
  linear_webhook_id: string | null;
  connected_by_user_id: number;
  updated_at: number | null;
};

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

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM linear_webhook_installations")) {
      const sorted = [...this.db.installations].sort((a, b) => {
        if (a.business_id !== b.business_id) return a.business_id < b.business_id ? -1 : 1;
        const au = a.updated_at ?? 0;
        const bu = b.updated_at ?? 0;
        if (au !== bu) return bu - au;
        return a.linear_organization_id < b.linear_organization_id ? -1 : 1;
      });
      return { results: sorted as T[] };
    }
    if (this.query.includes("json_each")) {
      this.db.batchedHealthCheckQueryCount += 1;
      const [businessIdsJson, integrationId, checkKind] = this.values as [string, string, string];
      const businessIds = new Set(JSON.parse(businessIdsJson) as string[]);
      const results = [...businessIds]
        .map(
          (businessId) =>
            this.db.healthChecks
              .filter(
                (row) =>
                  row.business_id === businessId &&
                  row.integration_id === integrationId &&
                  row.check_kind === checkKind,
              )
              .sort((a, b) => {
                if (a.checked_at !== b.checked_at) return b.checked_at - a.checked_at;
                return b.id.localeCompare(a.id);
              })[0],
        )
        .filter((row): row is HealthRow => Boolean(row));
      return { results: results as T[] };
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM business_integration_health_checks")) {
      this.db.singleHealthCheckQueryCount += 1;
      const [businessId, integrationId, checkKind] = this.values as [string, string, string];
      const rows = this.db.healthChecks
        .filter(
          (row) =>
            row.business_id === businessId && row.integration_id === integrationId && row.check_kind === checkKind,
        )
        .sort((a, b) => {
          if (a.checked_at !== b.checked_at) return b.checked_at - a.checked_at;
          return b.id.localeCompare(a.id);
        });
      return (rows[0] as T | undefined) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }> {
    if (this.query.includes("DELETE FROM business_integration_health_checks")) {
      const [cutoff] = this.values as [number];
      const before = this.db.healthChecks.length;
      this.db.healthChecks = this.db.healthChecks.filter((row) => row.created_at >= cutoff);
      return { success: true, meta: { last_row_id: 0, changes: before - this.db.healthChecks.length } };
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
  installations: InstallationRow[] = [];
  healthChecks: HealthRow[] = [];
  batchedHealthCheckQueryCount = 0;
  singleHealthCheckQueryCount = 0;

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

function seedInstallation(db: FakeD1, overrides: Partial<InstallationRow> = {}): InstallationRow {
  const row: InstallationRow = {
    business_id: "biz-1",
    linear_organization_id: "org-1",
    linear_webhook_id: "wh-1",
    connected_by_user_id: 42,
    updated_at: 1000,
    ...overrides,
  };
  db.installations.push(row);
  return row;
}

function emptyEnv(): import("../../apps/control-plane-worker/src/types").Env {
  return { TOKEN_ENCRYPTION_KEY: "k" } as import("../../apps/control-plane-worker/src/types").Env;
}

function passingResponse(overrides: { orgId?: string } = {}) {
  return new Response(
    JSON.stringify({
      data: {
        viewer: { id: "viewer-1" },
        organization: { id: overrides.orgId ?? "org-1", urlKey: "trycycloid", name: "Cycloid" },
      },
    }),
    { status: 200 },
  );
}

describe("Linear integration health checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    getLinearTokens.mockResolvedValue({ accessToken: "linear-token", refreshToken: null, expiresAt: null });
  });

  it("passes when viewer and organization resolve against the stored workspace", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockResolvedValueOnce(passingResponse());

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation, {
      now: 1234,
    });

    expect(result).toMatchObject({
      businessId: "biz-1",
      status: "passed",
      operation: "linear.viewer_org",
      checkedAt: 1234,
      diagnostic: "linear_ok",
      failureReason: null,
      details: { expectedOrgId: "org-1", organizationUrlKey: "trycycloid", webhookId: "wh-1" },
    });
    expect(tracedFetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer linear-token" }),
      }),
      "linear.health.viewer_org",
    );
    const sentBody = tracedFetch.mock.calls[0][1].body;
    expect(sentBody).not.toContain("webhook");
  });

  it("fails closed when the installer's Linear token cannot be resolved", async () => {
    getLinearTokens.mockResolvedValueOnce(null);
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.status).toBe("failed");
    expect(result.diagnostic).toBe("linear_installer_token_missing");
    expect(tracedFetch).not.toHaveBeenCalled();
  });

  it("classifies 401/403 as auth rejected", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.status).toBe("failed");
    expect(result.diagnostic).toBe("linear_auth_rejected");
    expect(result.failureReason).toContain("HTTP 403");
  });

  it("classifies rate limiting and 5xx errors", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);

    tracedFetch.mockResolvedValueOnce(new Response("slow", { status: 429 }));
    expect((await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation)).diagnostic).toBe(
      "linear_rate_limited",
    );

    tracedFetch.mockResolvedValueOnce(new Response("oops", { status: 502 }));
    expect((await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation)).diagnostic).toBe(
      "linear_server_error",
    );
  });

  it("flags GraphQL-level errors", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "scope insufficient" }] }), { status: 200 }),
    );

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.status).toBe("failed");
    expect(result.diagnostic).toBe("linear_graphql_error");
    expect(result.failureReason).toContain("scope insufficient");
  });

  it("classifies HTTP 200 GraphQL AUTHENTICATION_ERROR as auth rejected", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errors: [{ message: "Authentication failed", extensions: { code: "AUTHENTICATION_ERROR" } }],
        }),
        { status: 200 },
      ),
    );

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.diagnostic).toBe("linear_auth_rejected");
    expect(result.failureReason).toContain("reconnect Linear");
  });

  it("flags missing data field as a shape problem", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.diagnostic).toBe("linear_response_shape_invalid");
  });

  it("fails when the resolved organization no longer matches the stored workspace", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockResolvedValueOnce(passingResponse({ orgId: "different-org" }));

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.status).toBe("failed");
    expect(result.diagnostic).toBe("linear_organization_mismatch");
    expect(result.details).toMatchObject({ expectedOrgId: "org-1", observedOrgId: "different-org" });
  });

  it("sanitizes unexpected exceptions before returning evidence", async () => {
    const { runLinearBusinessHealthCheck } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const installation = seedInstallation(db);
    tracedFetch.mockRejectedValueOnce(new Error("fetch failed for https://api.linear.app/secret"));

    const result = await runLinearBusinessHealthCheck(db as unknown as D1Database, emptyEnv(), installation);

    expect(result.diagnostic).toBe("linear_health_exception");
    expect(result.failureReason).toBe("Linear health check failed unexpectedly.");
  });

  it("runs only due Linear checks and skips recently checked businesses", async () => {
    const { runDueLinearHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const now = 6 * 60 * 60 * 1000 + 10_000;
    seedInstallation(db, { business_id: "due-biz", linear_organization_id: "org-due", updated_at: now - 200 });
    seedInstallation(db, { business_id: "recent-biz", linear_organization_id: "org-recent", updated_at: now - 200 });
    db.healthChecks.push({
      id: "recent",
      business_id: "recent-biz",
      integration_id: "linear",
      check_kind: "basic",
      status: "passed",
      operation: "linear.viewer_org",
      checked_at: now - 100,
      latency_ms: 20,
      diagnostic: "linear_ok",
      failure_reason: null,
      details_json: null,
      created_at: now - 100,
    });
    tracedFetch.mockResolvedValueOnce(passingResponse({ orgId: "org-due" }));

    const result = await runDueLinearHealthChecks(
      {
        DB: db as unknown as D1Database,
        TOKEN_ENCRYPTION_KEY: "k",
      } as import("../../apps/control-plane-worker/src/types").Env,
      { now },
    );

    expect(result).toEqual({ checked: 1, skipped: 1, failed: 0 });
    expect(db.batchedHealthCheckQueryCount).toBe(1);
    expect(db.singleHealthCheckQueryCount).toBe(0);
    expect(db.healthChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          business_id: "due-biz",
          integration_id: "linear",
          status: "passed",
          checked_at: now,
        }),
      ]),
    );
  });

  it("prefetches latest Linear checks once for multiple candidates and handles missing history", async () => {
    const { runDueLinearHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const now = 10_000;
    seedInstallation(db, { business_id: "missing-history", linear_organization_id: "org-missing", updated_at: 100 });
    seedInstallation(db, { business_id: "recent-history", linear_organization_id: "org-recent", updated_at: 100 });
    seedInstallation(db, { business_id: "old-history", linear_organization_id: "org-old", updated_at: 100 });
    db.healthChecks.push(
      {
        id: "recent-older",
        business_id: "recent-history",
        integration_id: "linear",
        check_kind: "basic",
        status: "failed",
        operation: "linear.viewer_org",
        checked_at: now - 8_000,
        latency_ms: 20,
        diagnostic: "linear_auth_rejected",
        failure_reason: null,
        details_json: null,
        created_at: now - 8_000,
      },
      {
        id: "recent-latest",
        business_id: "recent-history",
        integration_id: "linear",
        check_kind: "basic",
        status: "passed",
        operation: "linear.viewer_org",
        checked_at: now - 100,
        latency_ms: 20,
        diagnostic: "linear_ok",
        failure_reason: null,
        details_json: null,
        created_at: now - 100,
      },
      {
        id: "old-latest",
        business_id: "old-history",
        integration_id: "linear",
        check_kind: "basic",
        status: "passed",
        operation: "linear.viewer_org",
        checked_at: now - 7_000,
        latency_ms: 20,
        diagnostic: "linear_ok",
        failure_reason: null,
        details_json: null,
        created_at: now - 7_000,
      },
      {
        id: "wrong-kind",
        business_id: "old-history",
        integration_id: "linear",
        check_kind: "synthetic_session",
        status: "passed",
        operation: "linear.synthetic",
        checked_at: now - 100,
        latency_ms: 20,
        diagnostic: "synthetic_ok",
        failure_reason: null,
        details_json: null,
        created_at: now - 100,
      },
    );
    tracedFetch
      .mockResolvedValueOnce(passingResponse({ orgId: "org-missing" }))
      .mockResolvedValueOnce(passingResponse({ orgId: "org-old" }));

    const result = await runDueLinearHealthChecks(
      {
        DB: db as unknown as D1Database,
        TOKEN_ENCRYPTION_KEY: "k",
        LINEAR_HEALTH_INTERVAL_MS: "6000",
      } as import("../../apps/control-plane-worker/src/types").Env,
      { now },
    );

    expect(result).toEqual({ checked: 2, skipped: 1, failed: 0 });
    expect(db.batchedHealthCheckQueryCount).toBe(1);
    expect(db.singleHealthCheckQueryCount).toBe(0);
    expect(tracedFetch).toHaveBeenCalledTimes(2);
    expect(db.healthChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ business_id: "missing-history", checked_at: now, status: "passed" }),
        expect.objectContaining({ business_id: "old-history", checked_at: now, status: "passed" }),
      ]),
    );
    expect(db.healthChecks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ business_id: "recent-history", checked_at: now })]),
    );
  });

  it("rechecks Linear when the installation row was updated after the latest evidence", async () => {
    const { runDueLinearHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const now = 10_000;
    seedInstallation(db, { business_id: "changed-biz", linear_organization_id: "org-c", updated_at: now - 50 });
    db.healthChecks.push({
      id: "recent-but-stale",
      business_id: "changed-biz",
      integration_id: "linear",
      check_kind: "basic",
      status: "failed",
      operation: "linear.viewer_org",
      checked_at: now - 100,
      latency_ms: 20,
      diagnostic: "linear_auth_rejected",
      failure_reason: null,
      details_json: null,
      created_at: now - 100,
    });
    tracedFetch.mockResolvedValueOnce(passingResponse({ orgId: "org-c" }));

    const result = await runDueLinearHealthChecks(
      {
        DB: db as unknown as D1Database,
        TOKEN_ENCRYPTION_KEY: "k",
      } as import("../../apps/control-plane-worker/src/types").Env,
      { now },
    );

    expect(result).toEqual({ checked: 1, skipped: 0, failed: 0 });
    expect(tracedFetch).toHaveBeenCalledTimes(1);
  });

  it("checks the most recent active installation when a business has multiple", async () => {
    const { runDueLinearHealthChecks } =
      await import("../../apps/control-plane-worker/src/integrations/linear-health.js");
    const db = new FakeD1();
    const now = 10_000;
    seedInstallation(db, { business_id: "multi-biz", linear_organization_id: "org-old", updated_at: now - 5_000 });
    seedInstallation(db, { business_id: "multi-biz", linear_organization_id: "org-new", updated_at: now - 100 });
    tracedFetch.mockResolvedValueOnce(passingResponse({ orgId: "org-new" }));

    const result = await runDueLinearHealthChecks(
      {
        DB: db as unknown as D1Database,
        TOKEN_ENCRYPTION_KEY: "k",
      } as import("../../apps/control-plane-worker/src/types").Env,
      { now },
    );

    expect(result).toEqual({ checked: 1, skipped: 0, failed: 0 });
    expect(tracedFetch).toHaveBeenCalledTimes(1);
    expect(db.healthChecks).toHaveLength(1);
    expect(db.healthChecks[0]).toMatchObject({
      business_id: "multi-biz",
      status: "passed",
      details_json: expect.stringContaining("org-new"),
    });
  });
});
