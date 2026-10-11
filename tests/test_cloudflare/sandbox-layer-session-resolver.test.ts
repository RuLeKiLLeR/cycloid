import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  upsertSandboxLayerBusinessDefaultSource,
  upsertSandboxLayerRepoSourceAssignment,
} from "../../apps/control-plane-worker/src/sandbox/layer-assignment-db";
import {
  claimSandboxLayerBuild,
  createOrGetSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  promoteSandboxLayerArtifact,
  recordSandboxLayerProviderBuildStart,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";
import { resolveSandboxLayerForSession } from "../../apps/control-plane-worker/src/sandbox/layer-resolver";
import type { Env } from "../../apps/control-plane-worker/src/types";

// Test-only fixtures mirroring former layer-db DAOs that had no production
// callers. Behavior matches the deleted DAOs exactly.
async function setSandboxLayerSourceStatus(
  db: D1Database,
  input: { sourceId: string; status: "active" | "blocked"; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE sandbox_layer_sources SET status = ?, updated_at = ? WHERE id = ?")
    .bind(input.status, input.nowMs, input.sourceId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

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

async function blockSandboxLayerArtifact(
  db: D1Database,
  input: { artifactId: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE sandbox_layer_artifacts SET status = 'blocked', blocked_at = ? WHERE id = ?")
    .bind(input.nowMs, input.artifactId)
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

function dbWithThrowingRepoSourceLookup(db: D1Database): D1Database {
  return {
    prepare(query: string) {
      if (
        query.includes("FROM sandbox_layer_sources") &&
        query.includes("WHERE business_id = ? AND LOWER(repo_owner)")
      ) {
        throw new Error("repo source lookup failed");
      }
      return db.prepare(query);
    },
    batch(statements) {
      return db.batch(statements);
    },
  } as D1Database;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    E2B_SANDBOX_TEMPLATE: "base-template-v2",
    SANDBOX_IMAGE_VERSION: "base-version-v2",
    ...overrides,
  } as Env;
}

async function seedCompletedBuild(
  db: D1Database,
  input: {
    resourceProfileKey?: string;
    baseVersion?: string;
    sourceStatus?: "active" | "blocked";
    timeOffset?: number;
    sourceId?: string;
    repoOwner?: string;
    repoName?: string;
  } = {},
) {
  const timeOffset = input.timeOffset ?? 0;
  const sourceId = input.sourceId ?? "source-1";
  const repoOwner = input.repoOwner ?? "acme";
  const repoName = input.repoName ?? "repo";
  const resourceProfileKey = input.resourceProfileKey ?? "default";
  const source = await upsertSandboxLayerSource(db, {
    id: sourceId,
    businessId: "biz-1",
    repoOwner,
    repoName,
    manifestPath: ".cycloid/sandbox.yaml",
    createdByUserId: 1,
    nowMs: 100 + timeOffset,
  });
  if (input.sourceStatus === "blocked") {
    await setSandboxLayerSourceStatus(db, { sourceId: source.id, status: "blocked", nowMs: 110 + timeOffset });
  }
  const { row } = await createOrGetSandboxLayerBuild(db, {
    id: `build-${sourceId}-${resourceProfileKey}`,
    sourceId: source.id,
    commitSha: "a".repeat(40),
    sourceContentHash: `source-hash-${sourceId}-${resourceProfileKey}`,
    manifestHash: "manifest-hash",
    layerHash: "layer-hash",
    normalizedLayerHash: "normalized-layer-hash",
    manifestPath: ".cycloid/sandbox.yaml",
    layerPath: ".cycloid/sandbox.layer.Dockerfile",
    layerInstructionsJson: "[]",
    smokeCommandsJson: "[]",
    baseTemplateRef: "base-template-v1",
    baseVersion: input.baseVersion ?? "base-version-v1",
    resourceProfileKey,
    compilerVersion: "sandbox-layer-v1",
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    initialStatus: "queued",
    promotionEligibility: "default_branch_head",
    willPromote: 1,
    createdByUserId: 1,
    nowMs: 200 + timeOffset,
  });
  expect(
    await claimSandboxLayerBuild(db, {
      buildId: row.id,
      fromStatus: "queued",
      toStatus: "validating",
      nowMs: 201 + timeOffset,
    }),
  ).toBe(true);
  expect(
    await recordSandboxLayerProviderBuildStart(db, {
      buildId: row.id,
      providerTemplateRef: `layer-template-${sourceId}-${resourceProfileKey}`,
      providerBuildId: "provider-build",
      nowMs: 202 + timeOffset,
    }),
  ).toBe(true);
  expect(
    await claimSandboxLayerBuild(db, {
      buildId: row.id,
      fromStatus: "polling_provider",
      toStatus: "smoke_testing",
      nowMs: 203 + timeOffset,
    }),
  ).toBe(true);
  expect(
    await markSandboxLayerBuildCompleted(db, {
      buildId: row.id,
      smokeResultJson: "{}",
      nowMs: 204 + timeOffset,
      providerArtifactRef: `layer-template-${sourceId}-${resourceProfileKey}`,
    }),
  ).toBe(true);
  const artifact = await createSandboxLayerArtifact(db, {
    id: `artifact-${sourceId}-${resourceProfileKey}`,
    sourceId: source.id,
    buildId: row.id,
    provider: "e2b",
    providerArtifactRef: `layer-template-${sourceId}-${resourceProfileKey}`,
    runtimeBackend: "e2b_cloud",
    resourceProfileKey,
    status: "active",
    nowMs: 205 + timeOffset,
  });
  expect(
    await promoteSandboxLayerArtifact(db, { buildId: row.id, artifactId: artifact.id, nowMs: 206 + timeOffset }),
  ).toBe("promoted");
  return { source, build: row, artifact };
}

function deleteActivePointer(db: D1Database, input: { sourceId: string; resourceProfileKey?: string }) {
  (db as unknown as SqliteD1).sqlite
    .prepare("DELETE FROM sandbox_layer_active_artifacts WHERE source_id = ? AND resource_profile_key = ?")
    .run(input.sourceId, input.resourceProfileKey ?? "default");
}

function deleteArtifactForBuild(db: D1Database, buildId: string) {
  (db as unknown as SqliteD1).sqlite.prepare("DELETE FROM sandbox_layer_artifacts WHERE build_id = ?").run(buildId);
}

describe("sandbox layer session resolver", () => {
  it("returns business_missing without business context", async () => {
    await expect(
      resolveSandboxLayerForSession({
        db: createDb(),
        env: env(),
        businessId: null,
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "not_selected",
      runtimeTemplateId: null,
      misses: [{ tier: "repo_local", code: "business_missing" }],
    });
  });

  // Removed: self-hosted E2B backend_unsupported routing (self-hosted backend deleted).

  it("returns no_active_artifact when no source or active pointer exists", async () => {
    const db = createDb();
    const missingSourceResolution = await resolveSandboxLayerForSession({
      db,
      env: env(),
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      runtimeBackend: "e2b_cloud",
    });
    expect(missingSourceResolution.decision).toBe("not_selected");
    expect(missingSourceResolution.misses).toContainEqual({ tier: "repo_local", code: "no_active_artifact" });

    await upsertSandboxLayerSource(db, {
      id: "source-1",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      manifestPath: ".cycloid/sandbox.yaml",
      createdByUserId: 1,
      nowMs: 100,
    });
    const missingPointerResolution = await resolveSandboxLayerForSession({
      db,
      env: env(),
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      runtimeBackend: "e2b_cloud",
    });
    expect(missingPointerResolution.decision).toBe("not_selected");
    expect(missingPointerResolution.misses).toContainEqual({ tier: "repo_local", code: "no_active_artifact" });
  });

  it("repairs a repo-local completed build missing its active pointer before selecting it", async () => {
    const db = createDb();
    const seeded = await seedCompletedBuild(db);
    deleteActivePointer(db, { sourceId: seeded.source.id });

    const resolution = await resolveSandboxLayerForSession({
      db,
      env: env(),
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      runtimeBackend: "e2b_cloud",
    });

    expect(resolution).toMatchObject({
      decision: "selected",
      selectedTier: "repo_local",
      runtimeTemplateId: seeded.artifact.provider_artifact_ref,
    });
    await expect(
      getActiveSandboxLayerArtifact(db, { sourceId: seeded.source.id, resourceProfileKey: "default" }),
    ).resolves.toMatchObject({ id: seeded.artifact.id });
  });

  it("repairs a repo-local completed build missing its artifact row before selecting it", async () => {
    const db = createDb();
    const seeded = await seedCompletedBuild(db);
    deleteActivePointer(db, { sourceId: seeded.source.id });
    deleteArtifactForBuild(db, seeded.build.id);

    const resolution = await resolveSandboxLayerForSession({
      db,
      env: env(),
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      runtimeBackend: "e2b_cloud",
    });

    expect(resolution).toMatchObject({
      decision: "selected",
      selectedTier: "repo_local",
      runtimeTemplateId: seeded.artifact.provider_artifact_ref,
    });
    await expect(
      getActiveSandboxLayerArtifact(db, { sourceId: seeded.source.id, resourceProfileKey: "default" }),
    ).resolves.toMatchObject({ provider_artifact_ref: seeded.artifact.provider_artifact_ref });
  });

  it("ignores candidate artifacts and reports unusable active pointers", async () => {
    const db = createDb();
    const { artifact, source } = await seedCompletedBuild(db);
    await blockSandboxLayerArtifact(db, { artifactId: artifact.id, nowMs: 300 });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "not_selected",
      misses: expect.arrayContaining([{ tier: "repo_local", code: "artifact_not_usable", sourceId: source.id }]),
    });

    expect(await getActiveSandboxLayerArtifact(db, { sourceId: source.id, resourceProfileKey: "default" })).toBeNull();
  });

  it("returns resource_profile_mismatch when only another profile is active", async () => {
    const db = createDb();
    await seedCompletedBuild(db, { resourceProfileKey: "large" });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "not_selected",
      resourceProfileKey: "default",
      misses: expect.arrayContaining([
        { tier: "repo_local", code: "source_missing_active_artifact_for_profile", sourceId: "source-1" },
      ]),
    });
  });

  it("selects the matching active profile even when another profile is newer", async () => {
    const db = createDb();
    const { artifact } = await seedCompletedBuild(db);
    await seedCompletedBuild(db, { resourceProfileKey: "large", timeOffset: 1_000 });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "repo_local",
      runtimeTemplateId: artifact.provider_artifact_ref,
      resourceProfileKey: "default",
    });
  });

  it("selects a matching active E2B cloud artifact and ignores base-version drift", async () => {
    const db = createDb();
    const { artifact } = await seedCompletedBuild(db, { baseVersion: "old-base-version" });

    const resolution = await resolveSandboxLayerForSession({
      db,
      env: env({ SANDBOX_IMAGE_VERSION: "new-base-version" }),
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "repo",
      runtimeBackend: "e2b_cloud",
    });

    expect(resolution).toMatchObject({
      decision: "selected",
      selectedTier: "repo_local",
      runtimeTemplateId: artifact.provider_artifact_ref,
      resourceProfileKey: "default",
    });
    expect(resolution.artifact?.base_version).toBe("old-base-version");
  });

  it("selects repo-local artifacts case-insensitively for GitHub owner and repo casing", async () => {
    const db = createDb();
    const { artifact } = await seedCompletedBuild(db, {
      repoOwner: "trycycloid",
      repoName: "cycloid",
      resourceProfileKey: "trycycloid/cycloid",
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "TryCycloid",
        repoName: "Cycloid",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "repo_local",
      runtimeTemplateId: artifact.provider_artifact_ref,
    });
  });

  it("uses repo-local active artifacts before repo assignments", async () => {
    const db = createDb();
    const local = await seedCompletedBuild(db, { sourceId: "source-local", repoOwner: "acme", repoName: "repo" });
    const assigned = await seedCompletedBuild(db, {
      sourceId: "source-assigned",
      repoOwner: "acme",
      repoName: "sandbox-templates",
    });
    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "acme",
      targetRepoName: "repo",
      sourceId: assigned.source.id,
      userId: 1,
      nowMs: 500,
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "repo_local",
      runtimeTemplateId: local.artifact.provider_artifact_ref,
    });
  });

  it("uses repo assignment before business default", async () => {
    const db = createDb();
    const assigned = await seedCompletedBuild(db, {
      sourceId: "source-assigned",
      repoOwner: "acme",
      repoName: "repo-template",
    });
    const businessDefault = await seedCompletedBuild(db, {
      sourceId: "source-default",
      repoOwner: "acme",
      repoName: "default-template",
    });
    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "acme",
      targetRepoName: "repo",
      sourceId: assigned.source.id,
      userId: 1,
      nowMs: 500,
    });
    await upsertSandboxLayerBusinessDefaultSource(db, {
      businessId: "biz-1",
      sourceId: businessDefault.source.id,
      userId: 1,
      nowMs: 501,
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "repo_assignment",
      runtimeTemplateId: assigned.artifact.provider_artifact_ref,
    });
  });

  it("uses repo assignment when repo-local active artifact repair fails", async () => {
    const db = createDb();
    const assigned = await seedCompletedBuild(db, {
      sourceId: "source-assigned",
      repoOwner: "acme",
      repoName: "repo-template",
    });
    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "acme",
      targetRepoName: "repo",
      sourceId: assigned.source.id,
      userId: 1,
      nowMs: 500,
    });

    await expect(
      resolveSandboxLayerForSession({
        db: dbWithThrowingRepoSourceLookup(db),
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "repo_assignment",
      runtimeTemplateId: assigned.artifact.provider_artifact_ref,
    });
  });

  it("repairs assigned completed builds before selecting repo assignments", async () => {
    const db = createDb();
    const assigned = await seedCompletedBuild(db, {
      sourceId: "source-assigned",
      repoOwner: "acme",
      repoName: "repo-template",
    });
    deleteActivePointer(db, { sourceId: assigned.source.id });
    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "acme",
      targetRepoName: "repo",
      sourceId: assigned.source.id,
      userId: 1,
      nowMs: 500,
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "repo_assignment",
      runtimeTemplateId: assigned.artifact.provider_artifact_ref,
    });
  });

  it("repairs assigned completed builds before selecting business defaults", async () => {
    const db = createDb();
    const businessDefault = await seedCompletedBuild(db, {
      sourceId: "source-default",
      repoOwner: "acme",
      repoName: "default-template",
    });
    deleteActivePointer(db, { sourceId: businessDefault.source.id });
    await upsertSandboxLayerBusinessDefaultSource(db, {
      businessId: "biz-1",
      sourceId: businessDefault.source.id,
      userId: 1,
      nowMs: 501,
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "business_default",
      runtimeTemplateId: businessDefault.artifact.provider_artifact_ref,
    });
  });

  it("falls through missing repo assignment profile coverage to business default", async () => {
    const db = createDb();
    const assigned = await seedCompletedBuild(db, {
      sourceId: "source-assigned",
      repoOwner: "acme",
      repoName: "repo-template",
      resourceProfileKey: "large",
    });
    const businessDefault = await seedCompletedBuild(db, {
      sourceId: "source-default",
      repoOwner: "acme",
      repoName: "default-template",
    });
    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "acme",
      targetRepoName: "repo",
      sourceId: assigned.source.id,
      userId: 1,
      nowMs: 500,
    });
    await upsertSandboxLayerBusinessDefaultSource(db, {
      businessId: "biz-1",
      sourceId: businessDefault.source.id,
      userId: 1,
      nowMs: 501,
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "selected",
      selectedTier: "business_default",
      runtimeTemplateId: businessDefault.artifact.provider_artifact_ref,
      misses: expect.arrayContaining([
        {
          tier: "repo_assignment",
          code: "source_missing_active_artifact_for_profile",
          sourceId: assigned.source.id,
        },
      ]),
    });
  });

  it("records business default profile misses and falls back to non-layer runtime", async () => {
    const db = createDb();
    const businessDefault = await seedCompletedBuild(db, {
      sourceId: "source-default",
      repoOwner: "acme",
      repoName: "default-template",
      resourceProfileKey: "large",
    });
    await upsertSandboxLayerBusinessDefaultSource(db, {
      businessId: "biz-1",
      sourceId: businessDefault.source.id,
      userId: 1,
      nowMs: 501,
    });

    await expect(
      resolveSandboxLayerForSession({
        db,
        env: env(),
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        runtimeBackend: "e2b_cloud",
      }),
    ).resolves.toMatchObject({
      decision: "not_selected",
      runtimeTemplateId: null,
      misses: expect.arrayContaining([
        {
          tier: "business_default",
          code: "source_missing_active_artifact_for_profile",
          sourceId: businessDefault.source.id,
        },
      ]),
    });
  });
});
