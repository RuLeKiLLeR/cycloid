// Route + service tests for GET /api/repos/:owner/:repo/context. The repo-access
// gate is mocked; the aggregate is composed from real DAO reads over an
// in-memory D1 loaded from the migrations.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGate = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...args: unknown[]) => mockGate(...args),
}));

// The internal feature gate resolves identity from D1; mock it so route tests
// can drive membership directly. Defaults to a member in beforeEach.
const mockVerifyCycloidMember = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidMember: (...args: unknown[]) => mockVerifyCycloidMember(...args),
}));

import { repoContextRoutes } from "../../apps/control-plane-worker/src/routes/repo-context";
import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async run() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }
}

function makeEnv(d1: SqliteD1): Env {
  return { DB: d1 as unknown } as unknown as Env;
}

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: { businessId: "biz-a", businessRole: "member" } as AuthInfo["user"],
    ...overrides,
  } as AuthInfo;
}

function getRoute(): Route {
  const route = repoContextRoutes.find((r) => r.method === "GET" && r.pattern.test("/api/repos/acme/web/context"));
  if (!route) throw new Error("GET /api/repos/:owner/:repo/context not registered");
  return route;
}

async function invoke(env: Env, auth: AuthInfo | null, owner = "acme", repo = "web"): Promise<Response> {
  const route = getRoute();
  const url = `https://example.com/api/repos/${owner}/${repo}/context`;
  const request = new Request(url, { method: "GET" });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

describe("GET /api/repos/:owner/:repo/context", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
    mockVerifyCycloidMember.mockReset();
    mockVerifyCycloidMember.mockResolvedValue(true);
    // Satisfy foreign keys on mcp_servers / env_blobs / test creds.
    d1.sqlite.prepare("INSERT INTO businesses (id, name, created_at) VALUES ('biz-a', 'Acme', 1)").run();
    d1.sqlite
      .prepare(
        "INSERT INTO users (id, github_id, login, created_at, updated_at, business_id) VALUES (42, 4242, 'dev', 1, 1, 'biz-a')",
      )
      .run();
  });

  it("returns 403 for a customer-business member (not a Cycloid member), before the repo gate", async () => {
    mockVerifyCycloidMember.mockResolvedValue(false);
    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(403);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("returns 200 for a Cycloid member", async () => {
    mockVerifyCycloidMember.mockResolvedValue(true);
    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(200);
  });

  it("evaluates the gate via the request auth (actorUser during impersonation)", async () => {
    const auth = makeAuth({ actorUser: { id: 7 } as AuthInfo["actorUser"] });
    await invoke(env, auth);
    expect(mockVerifyCycloidMember).toHaveBeenCalledWith(env.DB, auth);
  });

  it("composes the context aggregate with redacted secret/env NAMES only", async () => {
    // MCP server with a referenced secret + header secret ref (no values in config).
    d1.sqlite
      .prepare(
        `INSERT INTO mcp_servers
         (id, business_id, name, description, transport, command, url, args_json, headers_json, secret_refs_json,
          scope_json, enabled, validation_status, validation_error, discovered_tools_json, last_validated_at,
          created_by_user_id, created_at, updated_at, deleted_at)
         VALUES ('mcp-1', 'biz-a', 'linear', 'Linear MCP', 'http', NULL, 'https://mcp', '[]',
           ?, ?, '{"type":"business"}', 1, 'valid', NULL, ?, NULL, 42, 1, 1, NULL)`,
      )
      .run(
        JSON.stringify({ Authorization: { secretRef: "LINEAR_TOKEN" } }),
        JSON.stringify(["LINEAR_TOKEN"]),
        JSON.stringify([{ name: "list_issues" }, { name: "get_issue" }]),
      );
    // Per-repo test credential (name only surfaces).
    d1.sqlite
      .prepare(
        `INSERT INTO business_test_credentials
         (business_id, repo_owner, repo_name, name, encrypted_value, encrypted, created_at, updated_at, rotated_by_user_id)
         VALUES ('biz-a', 'acme', 'web', 'STRIPE_KEY', 'ENCRYPTED_SECRET_VALUE', 1, 1, 1, 42)`,
      )
      .run();
    // Repo runtime login env blob (key_names_json holds NAMES only).
    d1.sqlite
      .prepare(
        `INSERT INTO env_blobs (id, owner_user_id, business_id, name, env_text, encrypted, key_names_json, is_global, created_at, updated_at)
         VALUES ('blob-1', 42, 'biz-a', 'app_login', 'ENCRYPTED_ENV_TEXT', 1, ?, 0, 1, 1)`,
      )
      .run(JSON.stringify(["DATABASE_URL", "API_KEY"]));
    d1.sqlite
      .prepare(`INSERT INTO env_blob_repos (env_blob_id, repo_owner, repo_name) VALUES ('blob-1', 'acme', 'web')`)
      .run();

    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Record<string, Record<string, unknown>> };
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, Record<string, unknown> & Array<Record<string, unknown>>>;

    expect(data.repo).toEqual({ owner: "acme", name: "web" });
    expect(data.instructionFiles.available).toBe(false);
    expect(data.skills.available).toBe(false);

    expect(data.mcpServers).toHaveLength(1);
    expect(data.mcpServers[0]).toMatchObject({
      name: "linear",
      transport: "http",
      enabled: true,
      validationStatus: "valid",
      scopeType: "business",
      discoveredToolCount: 2,
      secretRefs: ["LINEAR_TOKEN"],
      headerSecretRefs: { Authorization: "LINEAR_TOKEN" },
    });
    // Redaction: no raw secret value fields leak anywhere in the payload.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("ENCRYPTED_SECRET_VALUE");
    expect(serialized).not.toContain("ENCRYPTED_ENV_TEXT");

    expect(data.secrets.testCredentials).toEqual([{ name: "STRIPE_KEY", updatedAt: 1, rotatedByUserId: 42 }]);
    expect(data.secrets.repoRuntimeEnvVarNames).toEqual(["DATABASE_URL", "API_KEY"]);
    expect(data.reviewSettings).not.toHaveProperty("reviewTimeoutMinutes");
  });

  it("returns 403 when the caller has no business membership (fail closed)", async () => {
    const res = await invoke(env, makeAuth({ user: { businessRole: "member" } as AuthInfo["user"] }));
    expect(res.status).toBe(403);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("propagates a repo-gate denial (fail closed)", async () => {
    mockGate.mockResolvedValueOnce({
      ok: false,
      reason: "repo_access_denied",
      response: new Response(JSON.stringify({ ok: false, error: "denied" }), { status: 403 }),
    });
    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(403);
  });
});
