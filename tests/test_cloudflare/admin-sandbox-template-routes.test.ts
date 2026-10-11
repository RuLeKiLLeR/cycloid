import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVerifyCycloidAdmin = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidAdmin: (...args: unknown[]) => mockVerifyCycloidAdmin(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB: D1Database }) => env.DB,
}));

import { adminSandboxTemplateRoutes } from "../../apps/control-plane-worker/src/routes/admin-sandbox-templates";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

class SqliteD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number } } {
    const result = this.db.prepare(this.query).run(...this.params);
    return { success: true, meta: { changes: result.changes } };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.params) as T[] };
  }
}

class SqliteD1 {
  constructor(readonly sqlite: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const run = this.sqlite.transaction((items: SqliteD1Statement[]) => items.map((statement) => statement.runSync()));
    return run(statements);
  }
}

function createDb(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0179_sandbox_layers.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0180_sandbox_layer_provider_worker.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0182_sandbox_base_templates.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0206_sandbox_base_template_capabilities.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0208_sandbox_base_template_content_hash.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0195_sandbox_rebuild_campaign_timer.sql", "utf8"));
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function registerRequest(): Request {
  return new Request("https://example.com/api/admin/sandbox-base-templates/register", {
    method: "POST",
    body: JSON.stringify({
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-sha",
          contentHash: "hash-v1",
          smokeStatus: "passed",
        },
      ],
    }),
  });
}

function currentRequest(resourceProfileKey = "default", runtimeBackend = "e2b_cloud"): Request {
  const url = new URL("https://example.com/api/admin/sandbox-base-templates/current");
  url.searchParams.set("resourceProfileKey", resourceProfileKey);
  url.searchParams.set("runtimeBackend", runtimeBackend);
  return new Request(url, { method: "GET" });
}

function rebuildRequest(dryRun = true): Request {
  return new Request("https://example.com/api/admin/sandbox-layer/rebuild-campaigns", {
    method: "POST",
    body: JSON.stringify({
      scope: "business",
      businessId: "biz-1",
      reason: "base_update",
      dryRun,
    }),
  });
}

describe("admin sandbox template routes", () => {
  beforeEach(() => {
    mockVerifyCycloidAdmin.mockReset();
  });

  it("registers a single authenticated base-template route", () => {
    const routes = adminSandboxTemplateRoutes.filter((route) =>
      route.pattern.test("/api/admin/sandbox-base-templates/register"),
    );

    expect(routes.map((route) => `${route.method}:${route.auth}`)).toEqual(["POST:authenticated"]);
  });

  it("registers a single authenticated current-base-template route", () => {
    const routes = adminSandboxTemplateRoutes.filter((route) =>
      route.pattern.test("/api/admin/sandbox-base-templates/current"),
    );

    expect(routes.map((route) => `${route.method}:${route.auth}`)).toEqual(["GET:authenticated"]);
  });

  it("lets automation tokens register current base templates without internal-admin user gating", async () => {
    const db = createDb();
    const route = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-base-templates/register"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      registerRequest(),
      { DB: db } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "ci_automation_token",
        userId: "ci-automation-token",
        tokenSource: "bearer",
        canAccessAllSessions: false,
      } as AuthInfo,
    );

    expect(response.status).toBe(200);
    expect(mockVerifyCycloidAdmin).not.toHaveBeenCalled();
    const body = (await response.json()) as { bases: Array<{ baseTemplateRef: string; contentHash: string | null }> };
    expect(body.bases[0]?.baseTemplateRef).toBe("base-template");
    expect(body.bases[0]?.contentHash).toBe("hash-v1");
    expect(JSON.stringify(body)).not.toContain("ci-automation-token");
    const row = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT registered_by_kind, registered_by_user_id, content_hash FROM sandbox_base_templates LIMIT 1")
      .get() as { registered_by_kind: string; registered_by_user_id: number | null; content_hash: string | null };
    expect(row).toEqual({ registered_by_kind: "automation", registered_by_user_id: null, content_hash: "hash-v1" });
  });

  it("lets automation tokens read current base template content hashes without internal-admin user gating", async () => {
    const db = createDb();
    const postRoute = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-base-templates/register"),
    );
    const getRoute = adminSandboxTemplateRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/admin/sandbox-base-templates/current"),
    );
    expect(postRoute).toBeTruthy();
    expect(getRoute).toBeTruthy();
    const ciAuth = {
      authMode: "ci_automation_token",
      userId: "ci-automation-token",
      tokenSource: "bearer",
      canAccessAllSessions: false,
    } as AuthInfo;

    expect(
      await postRoute!.handler(registerRequest(), { DB: db } as Env, [] as unknown as RegExpMatchArray, ciAuth),
    ).toMatchObject({
      status: 200,
    });
    const response = await getRoute!.handler(
      currentRequest(),
      { DB: db } as Env,
      [] as unknown as RegExpMatchArray,
      ciAuth,
    );

    expect(response.status).toBe(200);
    expect(mockVerifyCycloidAdmin).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      current: { resourceProfileKey: string; baseTemplateRef: string; baseVersion: string; contentHash: string | null };
    };
    expect(body.current).toMatchObject({
      resourceProfileKey: "default",
      baseTemplateRef: "base-template",
      baseVersion: "base-sha",
      contentHash: "hash-v1",
    });
  });

  it("returns null current base template when the registry has no row", async () => {
    const route = adminSandboxTemplateRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/admin/sandbox-base-templates/current"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      currentRequest("missing"),
      { DB: createDb() } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "ci_automation_token",
        userId: "ci-automation-token",
        tokenSource: "bearer",
        canAccessAllSessions: false,
      } as AuthInfo,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, current: null });
  });

  it("returns structured JSON when current base template lookup fails", async () => {
    const route = adminSandboxTemplateRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/admin/sandbox-base-templates/current"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      currentRequest(),
      {
        DB: {
          prepare: () => {
            throw new Error("d1 unavailable");
          },
        },
      } as unknown as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "ci_automation_token",
        userId: "ci-automation-token",
        tokenSource: "bearer",
        canAccessAllSessions: false,
      } as AuthInfo,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Unable to load current sandbox base template",
    });
  });

  it("keeps browser sessions behind the internal-admin gate", async () => {
    mockVerifyCycloidAdmin.mockResolvedValue(false);
    const route = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-base-templates/register"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      registerRequest(),
      { DB: createDb() } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "user_session",
        userId: "1",
        tokenSource: "cookie",
        canAccessAllSessions: false,
      } as AuthInfo,
    );

    expect(response.status).toBe(403);
    expect(mockVerifyCycloidAdmin).toHaveBeenCalled();
  });

  it("denies rebuild campaigns to non-internal customer admins", async () => {
    mockVerifyCycloidAdmin.mockResolvedValue(false);
    const route = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-layer/rebuild-campaigns"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      rebuildRequest(),
      { DB: createDb() } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "user_session",
        userId: "1",
        tokenSource: "cookie",
        canAccessAllSessions: false,
        user: { id: 1, login: "customer", name: null, email: null, businessId: "biz-1", businessRole: "admin" },
      } as AuthInfo,
    );

    expect(response.status).toBe(403);
  });

  it("allows internal admins to create dry-run rebuild campaigns", async () => {
    mockVerifyCycloidAdmin.mockResolvedValue(true);
    const route = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-layer/rebuild-campaigns"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      rebuildRequest(),
      { DB: createDb() } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "user_session",
        userId: "1",
        tokenSource: "cookie",
        canAccessAllSessions: false,
        user: { id: 1, login: "internal", name: null, email: null, businessId: "biz-1", businessRole: "admin" },
      } as AuthInfo,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      campaign: { status: string; summary: { activeArtifactsScanned: number } };
    };
    expect(body.campaign.status).toBe("completed");
    expect(body.campaign.summary.activeArtifactsScanned).toBe(0);
  });

  it("allows verified CLI admin auth to create dry-run rebuild campaigns", async () => {
    mockVerifyCycloidAdmin.mockResolvedValue(true);
    const route = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-layer/rebuild-campaigns"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      rebuildRequest(),
      { DB: createDb() } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "cli_token",
        userId: "1",
        tokenSource: "cli_token",
        cliTokenScope: "write",
        canAccessAllSessions: false,
        user: { id: 1, login: "internal", name: null, email: null, businessId: "biz-1", businessRole: "admin" },
      } as AuthInfo,
    );

    expect(response.status).toBe(200);
    expect(mockVerifyCycloidAdmin).toHaveBeenCalled();
  });

  it("defers real rebuild campaign processing to the scheduler", async () => {
    mockVerifyCycloidAdmin.mockResolvedValue(true);
    const route = adminSandboxTemplateRoutes.find(
      (candidate) =>
        candidate.method === "POST" && candidate.pattern.test("/api/admin/sandbox-layer/rebuild-campaigns"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      rebuildRequest(false),
      { DB: createDb() } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "user_session",
        userId: "1",
        tokenSource: "cookie",
        canAccessAllSessions: false,
        user: { id: 1, login: "internal", name: null, email: null, businessId: "biz-1", businessRole: "admin" },
      } as AuthInfo,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      campaign: { status: string; summary: { activeArtifactsScanned: number } };
      items: unknown[];
    };
    expect(body.campaign.status).toBe("queued");
    expect(body.campaign.summary.activeArtifactsScanned).toBe(0);
    expect(body.items).toEqual([]);
  });
});
