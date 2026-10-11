import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const mocks = vi.hoisted(() => ({
  isBusinessAdmin: vi.fn(),
  verifyRepoAccessAndInstallation: vi.fn(),
  createInstallationToken: vi.fn(),
  createScopedInstallationToken: vi.fn(),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getDefaultBranch: vi.fn(),
  resolveRepoCommitSha: vi.fn(),
  fetchRepoTextFileAtCommit: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/business/service", () => ({
  isBusinessAdmin: mocks.isBusinessAdmin,
}));

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: mocks.verifyRepoAccessAndInstallation,
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: mocks.createInstallationToken,
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getDefaultBranch: mocks.getDefaultBranch,
}));

vi.mock("../../apps/control-plane-worker/src/github/repo-source", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/github/repo-source")>(
    "../../apps/control-plane-worker/src/github/repo-source",
  );
  return {
    ...actual,
    resolveRepoCommitSha: mocks.resolveRepoCommitSha,
    fetchRepoTextFileAtCommit: mocks.fetchRepoTextFileAtCommit,
  };
});

const {
  prepareSandboxLayerBuildRequest,
  getSandboxLayerBuildRequest,
  getSandboxLayerBuildRequestLogs,
  listSandboxLayerBuildRequests,
  resolveBuildCreatorUserId,
  SANDBOX_LAYER_SYSTEM_USER_ID,
  SandboxLayerBuildRequestError,
} = await import("../../apps/control-plane-worker/src/sandbox/layer-source-service");
const { createSandboxLayerArtifact, getSandboxLayerBuild, markSandboxLayerBuildFailed, markSandboxLayerBuildStatus } =
  await import("../../apps/control-plane-worker/src/sandbox/layer-db");
const { registerSandboxBaseTemplates } =
  await import("../../apps/control-plane-worker/src/sandbox/base-template-service");

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

  executeBatchSync(): { results: Record<string, unknown>[]; meta?: { changes: number } } {
    if (this.query.trim().toUpperCase().startsWith("SELECT")) {
      return { results: this.db.prepare(this.query).all(...this.params) as Record<string, unknown>[] };
    }
    const result = this.runSync();
    return { results: [], meta: result.meta };
  }
}

class SqliteD1 {
  readonly queries: string[] = [];
  constructor(readonly sqlite: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    this.queries.push(query);
    return new SqliteD1Statement(this.sqlite, query);
  }

  async batch(
    statements: SqliteD1Statement[],
  ): Promise<Array<{ results: Record<string, unknown>[]; meta?: { changes: number } }>> {
    const run = this.sqlite.transaction((items: SqliteD1Statement[]) =>
      items.map((statement) => statement.executeBatchSync()),
    );
    return run(statements);
  }
}

function createDb(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0004_auth_tables.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0179_sandbox_layers.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0180_sandbox_layer_provider_worker.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0182_sandbox_base_templates.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0206_sandbox_base_template_capabilities.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0208_sandbox_base_template_content_hash.sql", "utf8"));
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function seedUser(db: D1Database, input: { id: number; login: string; name?: string | null }): void {
  (db as unknown as SqliteD1).sqlite
    .prepare(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, github_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.id + 1000, input.login, input.name ?? null, `${input.login}@example.com`, null, null, 1, 1);
}

function env(db = createDb()): Env {
  return {
    DB: db,
    E2B_SANDBOX_TEMPLATE: "base-template",
    SANDBOX_IMAGE_VERSION: "base-version-1",
  } as Env;
}

function adminAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "1",
    tokenSource: "session",
    authMode: "session",
    canAccessAllSessions: false,
    user: {
      id: 1,
      login: "octo",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "admin",
    },
    ...overrides,
  };
}

function adminTokenAuth(): AuthInfo {
  return {
    userId: "admin-token",
    tokenSource: "admin_token",
    authMode: "admin_token",
    canAccessAllSessions: true,
  };
}

function validManifest(): string {
  return [
    "version: 1",
    "layer:",
    "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
    "smoke:",
    "  commands:",
    '    - ["bash", "-lc", "command -v jq"]',
    "",
  ].join("\n");
}

function validLayer(): string {
  return "RUN apt-get update && apt-get install -y jq\n";
}

function setupGithubSource(files: Record<string, string> = {}) {
  const commitSha = "a".repeat(40);
  mocks.getDefaultBranch.mockResolvedValue("main");
  mocks.resolveRepoCommitSha.mockImplementation(async (_token: string, _owner: string, _repo: string, ref: string) => {
    if (ref === "missing") {
      const { RepoSourceError } = await import("../../apps/control-plane-worker/src/github/repo-source");
      throw new RepoSourceError("ref_not_found", "not found", 404);
    }
    return ref === commitSha ? commitSha : commitSha;
  });
  mocks.fetchRepoTextFileAtCommit.mockImplementation(
    async (_token: string, _owner: string, _repo: string, path: string, sha: string) => {
      expect(sha).toBe(commitSha);
      const value = files[path];
      if (value == null) {
        const { RepoSourceError } = await import("../../apps/control-plane-worker/src/github/repo-source");
        throw new RepoSourceError("source_file_missing", "missing", 404);
      }
      return value;
    },
  );
  return commitSha;
}

describe("sandbox layer source service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBusinessAdmin.mockResolvedValue(true);
    mocks.verifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 123 });
    mocks.createInstallationToken.mockResolvedValue("installation-token");
    setupGithubSource({
      ".cycloid/sandbox.yaml": validManifest(),
      ".cycloid/sandbox.layer.Dockerfile": validLayer(),
    });
  });

  it("resolves build creator ids for user-backed auth and admin-token auth", () => {
    expect(resolveBuildCreatorUserId(adminAuth({ userId: "42" }))).toBe(42);
    expect(resolveBuildCreatorUserId(adminTokenAuth())).toBe(SANDBOX_LAYER_SYSTEM_USER_ID);
  });

  it("creates a validated build request from source files fetched at one resolved commit", async () => {
    const db = createDb();
    seedUser(db, { id: 1, login: "octo" });
    const result = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });

    expect(result.created).toBe(true);
    expect(result.buildRequest.status).toBe("validated");
    expect(result.buildRequest.repo).toBe("trycycloid/repo");
    expect(result.buildRequest.requestedRef).toBe("main");
    expect(result.buildRequest.layerPath).toBe(".cycloid/sandbox.layer.Dockerfile");
    expect(result.buildRequest.baseTemplateRef).toBe("base-template-mem4096-cpu2");
    expect(result.buildRequest.promotionEligibility).toBe("default_branch_head");
    expect(mocks.fetchRepoTextFileAtCommit).toHaveBeenCalledWith(
      "installation-token",
      "trycycloid",
      "repo",
      ".cycloid/sandbox.yaml",
      "a".repeat(40),
    );

    const row = await getSandboxLayerBuild(db, result.buildRequest.id);
    expect(row?.status).toBe("validated");
    expect(row?.requested_ref).toBe("main");
    expect(row?.promotion_eligibility).toBe("default_branch_head");
    expect(result.buildRequest.baseSource).toBe("env_fallback");
    expect(result.buildRequest.baseVersionQuality).toBe("versioned");
  });

  it("attributes admin-token sandbox builds to the system user sentinel", async () => {
    const db = createDb();
    const result = await prepareSandboxLayerBuildRequest(env(db), adminTokenAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const build = await getSandboxLayerBuild(db, result.buildRequest.id);
    const source = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT created_by_user_id FROM sandbox_layer_sources WHERE id = ?")
      .get(build?.source_id) as { created_by_user_id: number } | undefined;

    expect(build?.created_by_user_id).toBe(SANDBOX_LAYER_SYSTEM_USER_ID);
    expect(source?.created_by_user_id).toBe(SANDBOX_LAYER_SYSTEM_USER_ID);
    expect(result.buildRequest.createdBy).toEqual({
      userId: SANDBOX_LAYER_SYSTEM_USER_ID,
      login: null,
      name: null,
    });
  });

  it("attributes CLI-token sandbox builds to the token owner without exposing token metadata", async () => {
    const db = createDb();
    seedUser(db, { id: 42, login: "alice", name: "Alice Example" });
    const cliAuth = adminAuth({
      userId: "42",
      tokenSource: "cli_token",
      authMode: "cli_token",
      cliTokenScope: "write",
      cliTokenId: 987654,
      user: {
        id: 42,
        login: "alice",
        name: "Alice Example",
        email: "alice@example.com",
        businessId: "biz-1",
        businessRole: "admin",
      },
    });

    const result = await prepareSandboxLayerBuildRequest(env(db), cliAuth, {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const row = await getSandboxLayerBuild(db, result.buildRequest.id);
    const status = await getSandboxLayerBuildRequest(env(db), cliAuth, {
      businessId: "biz-1",
      buildId: result.buildRequest.id,
    });
    const history = await listSandboxLayerBuildRequests(env(db), cliAuth, {
      businessId: "biz-1",
      sourceRepo: "trycycloid/repo",
      limit: 20,
    });
    const logs = await getSandboxLayerBuildRequestLogs(env(db), cliAuth, {
      businessId: "biz-1",
      buildId: result.buildRequest.id,
    });

    expect(row?.created_by_user_id).toBe(42);
    expect(result.buildRequest.createdBy).toEqual({ userId: 42, login: "alice", name: "Alice Example" });
    expect(status.createdBy).toEqual({ userId: 42, login: "alice", name: "Alice Example" });
    expect(history).toHaveLength(1);
    expect(history[0]!.createdBy).toEqual({ userId: 42, login: "alice", name: "Alice Example" });

    const responseText = JSON.stringify({ result, status, history, logs });
    expect(responseText).not.toContain("alice@example.com");
    expect(responseText).not.toContain("cliTokenId");
    expect(responseText).not.toContain("987654");
    expect(responseText).not.toContain("arc_");
  });

  it("persists registered sandbox base provenance during build preparation", async () => {
    const db = createDb();
    seedUser(db, { id: 1, login: "octo" });
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "registered-base-template",
          baseVersion: "registered-base-sha",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });

    const result = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const row = await getSandboxLayerBuild(db, result.buildRequest.id);

    expect(row?.base_template_ref).toBe("registered-base-template");
    expect(row?.base_version).toBe("registered-base-sha");
    expect(result.buildRequest.baseSource).toBe("registry");
    expect(result.buildRequest.baseVersionQuality).toBe("versioned");
  });

  it("lists build history with batched artifact and base provenance lookups", async () => {
    const db = createDb();
    seedUser(db, { id: 1, login: "octo" });
    const fallback = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "registered-base-template",
          baseVersion: "registered-base-sha",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 300,
    });
    const registry = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const registryRow = await getSandboxLayerBuild(db, registry.buildRequest.id);
    expect(registryRow).not.toBeNull();
    await createSandboxLayerArtifact(db, {
      id: "artifact-registry",
      sourceId: registryRow!.source_id,
      buildId: registryRow!.id,
      provider: "e2b",
      providerArtifactRef: "template-active",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "active",
      nowMs: 400,
    });
    (db as unknown as SqliteD1).sqlite
      .prepare(
        `INSERT INTO sandbox_layer_active_artifacts (source_id, resource_profile_key, artifact_id, build_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(registryRow!.source_id, "default", "artifact-registry", registryRow!.id, 401);

    const queryLog = (db as unknown as SqliteD1).queries;
    queryLog.length = 0;
    const history = await listSandboxLayerBuildRequests(env(db), adminAuth(), {
      businessId: "biz-1",
      sourceRepo: "trycycloid/repo",
      limit: 20,
    });

    expect(
      history.map((item) => ({ id: item.id, baseSource: item.baseSource, quality: item.baseVersionQuality })),
    ).toEqual([
      { id: registry.buildRequest.id, baseSource: "registry", quality: "versioned" },
      { id: fallback.buildRequest.id, baseSource: "env_fallback", quality: "versioned" },
    ]);
    expect(queryLog.filter((query) => query.includes("FROM sandbox_layer_active_artifacts active"))).toHaveLength(1);
    expect(queryLog.filter((query) => query.includes("FROM sandbox_base_templates"))).toHaveLength(1);
    expect(queryLog.some((query) => query.includes("WHERE active.source_id = ?"))).toBe(false);
    expect(queryLog.some((query) => query.includes("WHERE runtime_backend = ?"))).toBe(false);
    expect(
      queryLog.some((query) => query.includes("runtime_backend IN") && query.includes("resource_profile_key IN")),
    ).toBe(true);
  });

  it("redacts and bounds failed smoke output in build failure summaries", async () => {
    const db = createDb();
    seedUser(db, { id: 1, login: "octo" });
    const prepared = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const longOutput = `${"x".repeat(520)} ghp_${"a".repeat(24)} sk-${"b".repeat(24)} e2b_${"c".repeat(24)}`;

    await markSandboxLayerBuildStatus(db, prepared.buildRequest.id, "smoke_testing", 499);
    await markSandboxLayerBuildFailed(db, {
      buildId: prepared.buildRequest.id,
      error: "smoke_command_failed: token ghp_" + "d".repeat(24),
      nowMs: 500,
      smokeResultJson: JSON.stringify({
        ok: false,
        results: [
          {
            command: "npm test",
            commandIndex: 2,
            exitCode: 1,
            stdout: longOutput,
            stderr: `failed ${longOutput}`,
          },
        ],
      }),
    });

    const history = await listSandboxLayerBuildRequests(env(db), adminAuth(), {
      businessId: "biz-1",
      sourceRepo: "trycycloid/repo",
      limit: 20,
    });

    expect(history[0]?.failureSummary).toEqual(
      expect.objectContaining({
        phase: "smoke",
        command: "npm test",
        commandIndex: 2,
        exitCode: 1,
        activeTemplateUnchanged: false,
      }),
    );
    expect(history[0]?.failureSummary?.stderrPreview).toHaveLength(500);
    expect(history[0]?.failureSummary?.stdoutPreview).toHaveLength(500);
    expect(JSON.stringify(history[0]?.failureSummary)).not.toContain("ghp_");
    expect(JSON.stringify(history[0]?.failureSummary)).not.toContain("sk-");
    expect(JSON.stringify(history[0]?.failureSummary)).not.toContain("e2b_");
  });

  it("reuses duplicate content identity and changes identity when base version changes", async () => {
    const db = createDb();
    const first = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const duplicate = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });
    const changedBase = await prepareSandboxLayerBuildRequest(
      { ...env(db), SANDBOX_IMAGE_VERSION: "base-version-2" } as Env,
      adminAuth(),
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "repo",
      },
    );

    expect(duplicate.created).toBe(false);
    expect(duplicate.buildRequest.id).toBe(first.buildRequest.id);
    expect(changedBase.buildRequest.id).not.toBe(first.buildRequest.id);
  });

  it("marks non-default refs as non-promotable", async () => {
    mocks.resolveRepoCommitSha.mockImplementation(async (_token: string, _owner: string, _repo: string, ref: string) =>
      ref === "feature" ? "b".repeat(40) : "a".repeat(40),
    );
    mocks.fetchRepoTextFileAtCommit.mockImplementation(
      async (_token: string, _owner: string, _repo: string, path: string, sha: string) => {
        expect(sha).toBe("b".repeat(40));
        return path.endsWith("sandbox.yaml") ? validManifest() : validLayer();
      },
    );

    const result = await prepareSandboxLayerBuildRequest(env(), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
      ref: "feature",
    });

    expect(result.buildRequest.commitSha).toBe("b".repeat(40));
    expect(result.buildRequest.promotionEligibility).toBe("non_default_ref");
  });

  it("rejects mismatched business, non-admin users, repo denial, and missing base template", async () => {
    await expect(
      prepareSandboxLayerBuildRequest(env(), adminAuth(), {
        businessId: "biz-2",
        repoOwner: "trycycloid",
        repoName: "repo",
      }),
    ).rejects.toMatchObject({ code: "business_context_required" });

    mocks.isBusinessAdmin.mockResolvedValue(false);
    await expect(
      prepareSandboxLayerBuildRequest(env(), adminAuth(), {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "repo",
      }),
    ).rejects.toMatchObject({ code: "business_admin_required" });

    mocks.isBusinessAdmin.mockResolvedValue(true);
    mocks.verifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      response: new Response("no", { status: 403 }),
    });
    await expect(
      prepareSandboxLayerBuildRequest(env(), adminAuth(), {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "repo",
      }),
    ).rejects.toMatchObject({ code: "repo_access_denied" });

    mocks.verifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 123 });
    await expect(
      prepareSandboxLayerBuildRequest({ ...env(), E2B_SANDBOX_TEMPLATE: "" } as Env, adminAuth(), {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "repo",
      }),
    ).rejects.toMatchObject({ code: "base_template_unresolved" });
  });

  it("returns parser diagnostics and writes no build for invalid source", async () => {
    const db = createDb();
    setupGithubSource({
      ".cycloid/sandbox.yaml": [
        "version: 1",
        "resources:",
        "  cpu: 8",
        "layer:",
        "  dockerfile: .cycloid/layer",
        "",
      ].join("\n"),
    });

    await expect(
      prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "repo",
      }),
    ).rejects.toMatchObject({ code: "manifest_invalid" });
    const count = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT COUNT(*) AS count FROM sandbox_layer_builds")
      .get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("reads status and logs after same-business and repo access checks", async () => {
    const db = createDb();
    const prepared = await prepareSandboxLayerBuildRequest(env(db), adminAuth(), {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
    });

    const status = await getSandboxLayerBuildRequest(
      env(db),
      adminAuth({ user: { ...adminAuth().user!, businessRole: "member" } }),
      {
        businessId: "biz-1",
        buildId: prepared.buildRequest.id,
      },
    );
    const logs = await getSandboxLayerBuildRequestLogs(env(db), adminAuth(), {
      businessId: "biz-1",
      buildId: prepared.buildRequest.id,
    });

    expect(status.id).toBe(prepared.buildRequest.id);
    expect(logs).toEqual([
      expect.objectContaining({ sequence: 0, message: "Sandbox layer source validated." }),
      expect.objectContaining({ sequence: 1, message: "Sandbox base resolved from environment fallback." }),
    ]);

    await expect(
      getSandboxLayerBuildRequest(env(db), adminAuth({ user: { ...adminAuth().user!, businessId: "biz-2" } }), {
        businessId: "biz-2",
        buildId: prepared.buildRequest.id,
      }),
    ).rejects.toBeInstanceOf(SandboxLayerBuildRequestError);
  });
});
