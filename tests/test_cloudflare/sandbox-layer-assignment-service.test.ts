import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: vi.fn(async () => ({ ok: true, installationId: 1 })),
}));

import { upsertSandboxLayerBusinessDefaultSource } from "../../apps/control-plane-worker/src/sandbox/layer-assignment-db";
import {
  listSandboxLayerAssignments,
  setSandboxLayerBusinessDefaultSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-assignment-service";
import {
  claimSandboxLayerBuild,
  createOrGetSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  recordSandboxLayerProviderBuildStart,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

// Test-only fixture: advances a smoke-testing build to completed. Mirrors the
// former layer-db DAO of the same name, which had no production callers.
async function markSandboxLayerBuildCompleted(
  db: D1Database,
  input: { buildId: string; smokeResultJson: string; nowMs: number; providerArtifactRef?: string | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'completed',
           smoke_result_json = ?,
           provider_artifact_ref = COALESCE(?, provider_artifact_ref),
           completed_at = ?
       WHERE id = ? AND status = 'smoke_testing'`,
    )
    .bind(input.smokeResultJson, input.providerArtifactRef ?? null, input.nowMs, input.buildId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

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
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0181_sandbox_layer_assignments.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0182_sandbox_base_templates.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0206_sandbox_base_template_capabilities.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0208_sandbox_base_template_content_hash.sql", "utf8"));
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function env(db = createDb()): Env {
  return { DB: db } as Env;
}

function auth(): AuthInfo {
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

async function seedCompletedBuildWithoutActivePointer(db: D1Database) {
  const source = await upsertSandboxLayerSource(db, {
    id: "source-1",
    businessId: "biz-1",
    repoOwner: "acme",
    repoName: "templates",
    manifestPath: ".cycloid/sandbox.yaml",
    createdByUserId: 1,
    nowMs: 100,
  });
  const { row: build } = await createOrGetSandboxLayerBuild(db, {
    id: "build-1",
    sourceId: source.id,
    commitSha: "a".repeat(40),
    sourceContentHash: "source-hash",
    manifestHash: "manifest-hash",
    layerHash: "layer-hash",
    normalizedLayerHash: "normalized-layer-hash",
    manifestPath: ".cycloid/sandbox.yaml",
    layerPath: ".cycloid/sandbox.layer.Dockerfile",
    layerInstructionsJson: "[]",
    smokeCommandsJson: "[]",
    baseTemplateRef: "base-template-v1",
    baseVersion: "base-version-v1",
    resourceProfileKey: "default",
    compilerVersion: "sandbox-layer-v1",
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    initialStatus: "queued",
    promotionEligibility: "default_branch_head",
    willPromote: 1,
    createdByUserId: 1,
    nowMs: 200,
  });
  await claimSandboxLayerBuild(db, { buildId: build.id, fromStatus: "queued", toStatus: "validating", nowMs: 201 });
  await recordSandboxLayerProviderBuildStart(db, {
    buildId: build.id,
    providerTemplateRef: "template-1",
    providerBuildId: "provider-build",
    nowMs: 202,
  });
  await claimSandboxLayerBuild(db, {
    buildId: build.id,
    fromStatus: "polling_provider",
    toStatus: "smoke_testing",
    nowMs: 203,
  });
  await markSandboxLayerBuildCompleted(db, {
    buildId: build.id,
    smokeResultJson: "{}",
    providerArtifactRef: "template-1",
    nowMs: 204,
  });
  const artifact = await createSandboxLayerArtifact(db, {
    id: "artifact-1",
    sourceId: source.id,
    buildId: build.id,
    provider: "e2b",
    providerArtifactRef: "template-1",
    runtimeBackend: "e2b_cloud",
    resourceProfileKey: "default",
    status: "active",
    nowMs: 205,
  });
  return { source, artifact };
}

describe("sandbox layer assignment service", () => {
  it("repairs a completed source before validating it as the workspace default", async () => {
    const db = createDb();
    const seeded = await seedCompletedBuildWithoutActivePointer(db);

    const result = await setSandboxLayerBusinessDefaultSource(env(db), auth(), {
      businessId: "biz-1",
      source: {
        sourceRepoOwner: "acme",
        sourceRepoName: "templates",
        manifestPath: ".cycloid/sandbox.yaml",
      },
    });

    expect(result.assignment).toMatchObject({
      sourceRepo: "acme/templates",
      sourceId: seeded.source.id,
      latestActiveBuildId: seeded.artifact.build_id,
      latestActiveArtifactRef: seeded.artifact.provider_artifact_ref,
    });
    await expect(
      getActiveSandboxLayerArtifact(db, { sourceId: seeded.source.id, resourceProfileKey: "default" }),
    ).resolves.toMatchObject({ id: seeded.artifact.id });
  });

  it("repairs completed sources before returning assignment list details", async () => {
    const db = createDb();
    const seeded = await seedCompletedBuildWithoutActivePointer(db);
    await upsertSandboxLayerBusinessDefaultSource(db, {
      businessId: "biz-1",
      sourceId: seeded.source.id,
      userId: 1,
      nowMs: 300,
    });

    const result = await listSandboxLayerAssignments(env(db), auth(), { businessId: "biz-1" });

    expect(result.businessDefault).toMatchObject({
      sourceRepo: "acme/templates",
      sourceId: seeded.source.id,
      latestActiveBuildId: seeded.artifact.build_id,
      latestActiveArtifactRef: seeded.artifact.provider_artifact_ref,
    });
  });
});
