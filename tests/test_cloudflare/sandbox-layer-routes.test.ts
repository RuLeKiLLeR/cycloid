import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { sandboxLayerRoutes } from "../../apps/control-plane-worker/src/routes/sandbox-layers";
import {
  createOrGetSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";
import {
  beginIdempotentRequest,
  commitIdempotentRequest,
  releaseIdempotentRequest,
} from "../../apps/control-plane-worker/src/services/idempotency";
import type { AuthInfo, Env, SandboxLayerBuildQueueMessage } from "../../apps/control-plane-worker/src/types";

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

class RepairFailingD1 extends SqliteD1 {
  prepare(query: string): SqliteD1Statement {
    if (
      query.includes("SELECT b.*, s.business_id, s.repo_owner, s.repo_name, s.manifest_path") &&
      !query.includes("created_by_login")
    ) {
      return {
        bind() {
          return this;
        },
        async run() {
          throw new Error("repair query failed");
        },
        runSync() {
          throw new Error("repair query failed");
        },
        async first() {
          throw new Error("repair query failed");
        },
        async all() {
          throw new Error("repair query failed");
        },
      } as unknown as SqliteD1Statement;
    }
    return super.prepare(query);
  }
}

function createDb(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0004_auth_tables.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0162_idempotency_keys.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0179_sandbox_layers.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0180_sandbox_layer_provider_worker.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0182_sandbox_base_templates.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0206_sandbox_base_template_capabilities.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0208_sandbox_base_template_content_hash.sql", "utf8"));
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function env(db = createDb()): Env {
  return {
    DB: db,
    SANDBOX_LAYER_BUILD_QUEUE: { send: async () => undefined } as Queue<SandboxLayerBuildQueueMessage>,
  } as Env;
}

function internalAuth(): AuthInfo {
  return {
    userId: "1",
    tokenSource: "session",
    authMode: "session",
    canAccessAllSessions: true,
    user: {
      id: 1,
      login: "octo",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "admin",
    },
  };
}

function readCliAuth(): AuthInfo {
  return {
    ...internalAuth(),
    authMode: "cli_token",
    cliTokenScope: "read",
  };
}

function repairFailingEnv(db: D1Database): Env {
  const sqlite = (db as unknown as SqliteD1).sqlite;
  return env(new RepairFailingD1(sqlite) as unknown as D1Database);
}

function rateLimitedEnv(db: D1Database): Env {
  return {
    ...env(db),
    SESSION_RESUME_RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ ok: true, allowed: false, remaining: 0 }),
      }),
    },
  } as unknown as Env;
}

async function seedBuild(
  db: D1Database,
  input: { id: string; sourceContentHash: string; createdAt: number; template: string },
) {
  const source = await upsertSandboxLayerSource(db, {
    id: "source-1",
    businessId: "biz-1",
    repoOwner: "trycycloid",
    repoName: "repo",
    manifestPath: ".cycloid/sandbox.yaml",
    createdByUserId: 1,
    nowMs: 100,
  });
  const { row } = await createOrGetSandboxLayerBuild(db, {
    id: input.id,
    sourceId: source.id,
    commitSha: "a".repeat(40),
    sourceContentHash: input.sourceContentHash,
    manifestHash: `${input.sourceContentHash}-manifest`,
    layerHash: `${input.sourceContentHash}-layer`,
    normalizedLayerHash: input.sourceContentHash,
    manifestPath: ".cycloid/sandbox.yaml",
    layerPath: ".cycloid/sandbox.layer.Dockerfile",
    layerInstructionsJson: "[]",
    smokeCommandsJson: "[]",
    baseTemplateRef: "base-template",
    baseVersion: "base-version",
    resourceProfileKey: "default",
    compilerVersion: "sandbox-layer-v1",
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    initialStatus: "validated",
    requestedRef: "main",
    promotionEligibility: "default_branch_head",
    willPromote: 1,
    createdByUserId: 1,
    nowMs: input.createdAt,
  });
  await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'completed',
           provider_artifact_ref = ?,
           completed_at = ?
       WHERE id = ?`,
    )
    .bind(input.template, input.createdAt + 10, row.id)
    .run();
  const artifact = await createSandboxLayerArtifact(db, {
    id: `artifact-${input.id}`,
    sourceId: row.source_id,
    buildId: row.id,
    provider: "e2b",
    providerArtifactRef: input.template,
    runtimeBackend: "e2b_cloud",
    resourceProfileKey: "default",
    status: "candidate",
    nowMs: input.createdAt + 11,
  });
  return { row, artifact };
}

describe("sandbox layer routes", () => {
  it("registers the authenticated build, status, and log endpoints", () => {
    const routeKeys = sandboxLayerRoutes.map((route) => `${route.method}:${route.auth}:${route.pattern}`);
    expect(routeKeys).toEqual([
      "POST:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/repos\\/(?<owner>[^/]+)\\/(?<repo>[^/]+)\\/sandbox-layer\\/build-requests$/",
      "GET:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/sandbox-layer\\/build-requests$/",
      "GET:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/sandbox-layer\\/build-requests\\/(?<buildId>[^/]+)$/",
      "GET:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/sandbox-layer\\/build-requests\\/(?<buildId>[^/]+)\\/logs$/",
    ]);
  });

  it("repairs stale completed build activation before returning build status", async () => {
    const db = createDb();
    const older = await seedBuild(db, {
      id: "build-older",
      sourceContentHash: "older-hash",
      createdAt: 200,
      template: "older-template",
    });
    const newer = await seedBuild(db, {
      id: "build-newer",
      sourceContentHash: "newer-hash",
      createdAt: 400,
      template: "newer-template",
    });
    const route = sandboxLayerRoutes.find(
      (item) => item.method === "GET" && item.pattern.test("/api/businesses/biz-1/sandbox-layer/build-requests/x"),
    );
    expect(route).toBeDefined();
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();

    const path = `/api/businesses/biz-1/sandbox-layer/build-requests/${older.row.id}`;
    const response = await route!.handler(
      new Request(`https://api.trycycloid.com${path}`),
      env(db),
      path.match(route!.pattern)!,
      internalAuth(),
    );
    const payload = (await response.json()) as { buildRequest: { activeTemplateRef: string | null } };

    expect(response.status).toBe(200);
    expect(payload.buildRequest.activeTemplateRef).toBe("newer-template");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }))
        ?.artifact_id,
    ).toBe(newer.artifact.id);
  });

  it("does not repair stale completed build activation for read-scoped CLI status reads", async () => {
    const db = createDb();
    const older = await seedBuild(db, {
      id: "build-older",
      sourceContentHash: "older-hash",
      createdAt: 200,
      template: "older-template",
    });
    await seedBuild(db, {
      id: "build-newer",
      sourceContentHash: "newer-hash",
      createdAt: 400,
      template: "newer-template",
    });
    const route = sandboxLayerRoutes.find(
      (item) => item.method === "GET" && item.pattern.test("/api/businesses/biz-1/sandbox-layer/build-requests/x"),
    );
    expect(route).toBeDefined();

    const path = `/api/businesses/biz-1/sandbox-layer/build-requests/${older.row.id}`;
    const response = await route!.handler(
      new Request(`https://api.trycycloid.com${path}`),
      env(db),
      path.match(route!.pattern)!,
      readCliAuth(),
    );
    const payload = (await response.json()) as { buildRequest: { activeTemplateRef: string | null } };

    expect(response.status).toBe(200);
    expect(payload.buildRequest.activeTemplateRef).toBeNull();
    await expect(
      getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }),
    ).resolves.toBeNull();
  });

  it("returns the existing build status when best-effort activation repair fails", async () => {
    const db = createDb();
    const older = await seedBuild(db, {
      id: "build-older",
      sourceContentHash: "older-hash",
      createdAt: 200,
      template: "older-template",
    });
    await seedBuild(db, {
      id: "build-newer",
      sourceContentHash: "newer-hash",
      createdAt: 400,
      template: "newer-template",
    });
    const route = sandboxLayerRoutes.find(
      (item) => item.method === "GET" && item.pattern.test("/api/businesses/biz-1/sandbox-layer/build-requests/x"),
    );
    expect(route).toBeDefined();

    const path = `/api/businesses/biz-1/sandbox-layer/build-requests/${older.row.id}`;
    const response = await route!.handler(
      new Request(`https://api.trycycloid.com${path}`),
      repairFailingEnv(db),
      path.match(route!.pattern)!,
      internalAuth(),
    );
    const payload = (await response.json()) as { buildRequest: { activeTemplateRef: string | null } };

    expect(response.status).toBe(200);
    expect(payload.buildRequest.activeTemplateRef).toBeNull();
    await expect(
      getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }),
    ).resolves.toBeNull();
  });

  it("replays duplicate sandbox build requests with the same idempotency key and payload", async () => {
    const db = createDb();
    const seeded = await seedBuild(db, {
      id: "build-replay",
      sourceContentHash: "replay-hash",
      createdAt: 200,
      template: "replay-template",
    });
    const requestBody = {
      businessId: "biz-1",
      sourceRepo: { owner: "trycycloid", repo: "repo" },
      targetRepo: null,
      ref: "main",
      manifestPath: ".cycloid/sandbox.yaml",
    };
    const claim = await beginIdempotentRequest(db, {
      key: "sandbox-retry",
      ownerUserId: "1",
      route: "sandbox_layer_build_request",
      requestBody,
    });
    expect(claim.kind).toBe("proceed");
    if (claim.kind === "proceed") {
      await commitIdempotentRequest(db, claim.token, seeded.row.id);
    }

    const route = sandboxLayerRoutes.find((item) =>
      item.pattern.test("/api/businesses/biz-1/repos/trycycloid/repo/sandbox-layer/build-requests"),
    );
    expect(route).toBeDefined();
    const path = "/api/businesses/biz-1/repos/trycycloid/repo/sandbox-layer/build-requests";
    const response = await route!.handler(
      new Request(`https://api.trycycloid.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "sandbox-retry" },
        body: JSON.stringify({ ref: "main", manifestPath: ".cycloid/sandbox.yaml" }),
      }),
      env(db),
      path.match(route!.pattern)!,
      internalAuth(),
    );
    const payload = (await response.json()) as { buildRequest: { id: string }; idempotentReplay: boolean };

    expect(response.status).toBe(200);
    expect(payload.idempotentReplay).toBe(true);
    expect(payload.buildRequest.id).toBe(seeded.row.id);
  });

  it("rejects duplicate sandbox build keys with a different payload", async () => {
    const db = createDb();
    const claim = await beginIdempotentRequest(db, {
      key: "sandbox-retry",
      ownerUserId: "1",
      route: "sandbox_layer_build_request",
      requestBody: {
        businessId: "biz-1",
        sourceRepo: { owner: "trycycloid", repo: "repo" },
        targetRepo: null,
        ref: "main",
        manifestPath: ".cycloid/sandbox.yaml",
      },
    });
    expect(claim.kind).toBe("proceed");

    const route = sandboxLayerRoutes.find((item) =>
      item.pattern.test("/api/businesses/biz-1/repos/trycycloid/repo/sandbox-layer/build-requests"),
    );
    expect(route).toBeDefined();
    const path = "/api/businesses/biz-1/repos/trycycloid/repo/sandbox-layer/build-requests";
    const response = await route!.handler(
      new Request(`https://api.trycycloid.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "sandbox-retry" },
        body: JSON.stringify({ ref: "feature", manifestPath: ".cycloid/sandbox.yaml" }),
      }),
      env(db),
      path.match(route!.pattern)!,
      internalAuth(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "duplicate_request" });
  });

  it("releases the idempotency key when sandbox build requests are rate limited", async () => {
    const db = createDb();
    const route = sandboxLayerRoutes.find((item) =>
      item.pattern.test("/api/businesses/biz-1/repos/trycycloid/repo/sandbox-layer/build-requests"),
    );
    expect(route).toBeDefined();
    const path = "/api/businesses/biz-1/repos/trycycloid/repo/sandbox-layer/build-requests";
    const requestBody = { ref: "main", manifestPath: ".cycloid/sandbox.yaml" };

    const response = await route!.handler(
      new Request(`https://api.trycycloid.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "sandbox-rate-limited" },
        body: JSON.stringify(requestBody),
      }),
      rateLimitedEnv(db),
      path.match(route!.pattern)!,
      internalAuth(),
    );

    expect(response.status).toBe(429);
    const retryClaim = await beginIdempotentRequest(db, {
      key: "sandbox-rate-limited",
      ownerUserId: "1",
      route: "sandbox_layer_build_request",
      requestBody: {
        businessId: "biz-1",
        sourceRepo: { owner: "trycycloid", repo: "repo" },
        targetRepo: null,
        ...requestBody,
      },
    });
    expect(retryClaim.kind).toBe("proceed");
    if (retryClaim.kind === "proceed") await releaseIdempotentRequest(db, retryClaim.token);
  });
});
