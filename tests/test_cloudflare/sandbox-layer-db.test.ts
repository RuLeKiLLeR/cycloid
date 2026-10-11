import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { repairLatestPromotableSandboxLayerForSourceProfile } from "../../apps/control-plane-worker/src/sandbox/layer-active-artifact-repair-service";
import {
  appendSandboxLayerBuildLogChunk,
  blockActiveSandboxLayerArtifactIfCurrent,
  claimSandboxLayerBuild,
  completeSandboxLayerBuild,
  createOrGetSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  getNewestCompletedPromotableSandboxLayerBuildForSource,
  getNewestCompletedPromotableSandboxLayerBuildForSourceProfile,
  getSandboxLayerArtifactForBuild,
  getSandboxLayerBuild,
  getSandboxLayerSourceByRepoPath,
  listSandboxLayerBuildLogChunks,
  markSandboxLayerBuildFailed,
  promoteSandboxLayerArtifact,
  recordSandboxLayerProviderBuildStart,
  rescheduleSandboxLayerBuild,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";
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

class FailingBatchSqliteD1 extends SqliteD1 {
  constructor(
    sqlite: Database.Database,
    private readonly failAfterStatements: number,
  ) {
    super(sqlite);
  }

  override async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const run = this.sqlite.transaction((items: SqliteD1Statement[]) => {
      const results: Array<{ success: true; meta: { changes: number } }> = [];
      for (let index = 0; index < items.length; index += 1) {
        if (index === this.failAfterStatements) throw new Error("injected batch failure");
        results.push(items[index]!.runSync());
      }
      return results;
    });
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
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function createEnv(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

async function seedSource(db: D1Database, id = "source-1") {
  return upsertSandboxLayerSource(db, {
    id,
    businessId: "biz-1",
    repoOwner: "trycycloid",
    repoName: "repo",
    manifestPath: ".cycloid/sandbox.yaml",
    createdByUserId: 1,
    nowMs: 100,
  });
}

async function seedBuild(db: D1Database, input: Partial<Parameters<typeof createOrGetSandboxLayerBuild>[1]> = {}) {
  const source = input.sourceId ? null : await seedSource(db);
  return createOrGetSandboxLayerBuild(db, {
    id: input.id ?? "build-1",
    sourceId: input.sourceId ?? source!.id,
    commitSha: input.commitSha ?? "a".repeat(40),
    sourceContentHash: input.sourceContentHash ?? "source-hash-1",
    manifestHash: input.manifestHash ?? "manifest-hash",
    layerHash: input.layerHash ?? "layer-hash",
    normalizedLayerHash: input.normalizedLayerHash ?? "normalized-layer-hash",
    manifestPath: input.manifestPath ?? ".cycloid/sandbox.yaml",
    layerPath: input.layerPath ?? ".cycloid/sandbox.layer.Dockerfile",
    layerInstructionsJson: input.layerInstructionsJson ?? "[]",
    smokeCommandsJson: input.smokeCommandsJson ?? "[]",
    baseTemplateRef: input.baseTemplateRef ?? "base-template",
    baseVersion: input.baseVersion ?? "base-version-1",
    resourceProfileKey: input.resourceProfileKey ?? "default",
    compilerVersion: input.compilerVersion ?? "sandbox-layer-v1",
    provider: input.provider ?? "e2b",
    runtimeBackend: input.runtimeBackend ?? "e2b_cloud",
    requestedRef: input.requestedRef ?? "main",
    promotionEligibility: input.promotionEligibility ?? "default_branch_head",
    willPromote: input.willPromote ?? 1,
    createdByUserId: input.createdByUserId ?? 1,
    nowMs: input.nowMs ?? 200,
  });
}

async function completeBuild(db: D1Database, buildId: string, nowMs = 300): Promise<void> {
  expect(await claimSandboxLayerBuild(db, { buildId, fromStatus: "queued", toStatus: "validating", nowMs })).toBe(true);
  expect(
    await recordSandboxLayerProviderBuildStart(db, {
      buildId,
      providerTemplateRef: `template-${buildId}`,
      providerBuildId: `provider-${buildId}`,
      nowMs: nowMs + 1,
    }),
  ).toBe(true);
  expect(
    await claimSandboxLayerBuild(db, { buildId, fromStatus: "polling_provider", toStatus: "smoke_testing", nowMs }),
  ).toBe(true);
  expect(await markSandboxLayerBuildCompleted(db, { buildId, smokeResultJson: "{}", nowMs })).toBe(true);
}

describe("sandbox layer DB", () => {
  it("upserts sources idempotently and scopes repo-path reads by business", async () => {
    const db = createDb();
    const first = await seedSource(db);
    const second = await seedSource(db, "source-2");

    expect(second.id).toBe(first.id);
    expect(second.updated_at).toBe(100);
    expect(
      await getSandboxLayerSourceByRepoPath(db, {
        businessId: "biz-2",
        repoOwner: "trycycloid",
        repoName: "repo",
        manifestPath: ".cycloid/sandbox.yaml",
      }),
    ).toBeNull();
    expect(await setSandboxLayerSourceStatus(db, { sourceId: first.id, status: "blocked", nowMs: 150 })).toBe(true);
    const blocked = await getSandboxLayerSourceByRepoPath(db, {
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "repo",
      manifestPath: ".cycloid/sandbox.yaml",
    });
    expect(blocked?.status).toBe("blocked");
  });

  it("deduplicates builds by source content, base, compiler, profile, and provider", async () => {
    const db = createDb();
    const first = await seedBuild(db);
    const duplicate = await seedBuild(db, { id: "build-duplicate" });
    const newBase = await seedBuild(db, { id: "build-base-2", baseVersion: "base-version-2" });
    const newCompiler = await seedBuild(db, { id: "build-compiler-2", compilerVersion: "sandbox-layer-v2" });
    const newProfile = await seedBuild(db, { id: "build-profile-2", resourceProfileKey: "large" });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.row.id).toBe(first.row.id);
    expect(newBase.row.id).not.toBe(first.row.id);
    expect(newCompiler.row.id).not.toBe(first.row.id);
    expect(newProfile.row.id).not.toBe(first.row.id);
  });

  it("resets failed duplicate builds to validated so transient provider failures can retry", async () => {
    const db = createDb();
    const first = await seedBuild(db);
    expect(
      await claimSandboxLayerBuild(db, {
        buildId: first.row.id,
        fromStatus: "queued",
        toStatus: "validating",
        nowMs: 1,
      }),
    ).toBe(true);
    expect(
      await recordSandboxLayerProviderBuildStart(db, {
        buildId: first.row.id,
        providerTemplateRef: "template-failed",
        providerBuildId: "provider-failed",
        nowMs: 2,
      }),
    ).toBe(true);
    expect(await markSandboxLayerBuildFailed(db, { buildId: first.row.id, error: "rate_limit", nowMs: 3 })).toBe(true);
    expect(
      await appendSandboxLayerBuildLogChunk(db, {
        id: "old-log-0",
        buildId: first.row.id,
        sequence: 0,
        message: "old validation",
        nowMs: 4,
      }),
    ).toBe(true);
    expect(
      await appendSandboxLayerBuildLogChunk(db, {
        id: "old-log-1",
        buildId: first.row.id,
        sequence: 1,
        message: "old failure",
        nowMs: 5,
      }),
    ).toBe(true);

    const retry = await seedBuild(db, { id: "build-retry", nowMs: 500 });

    expect(retry.created).toBe(false);
    expect(retry.row.id).toBe(first.row.id);
    expect(retry.row.status).toBe("validated");
    expect(retry.row.provider_template_ref).toBeNull();
    expect(retry.row.provider_build_id).toBeNull();
    expect(retry.row.error).toBeNull();
    expect(retry.row.attempts).toBe(0);
    expect(retry.row.created_at).toBe(500);
    expect(await listSandboxLayerBuildLogChunks(db, { buildId: retry.row.id })).toEqual([]);
    expect(
      await appendSandboxLayerBuildLogChunk(db, {
        id: "new-log-0",
        buildId: retry.row.id,
        sequence: 0,
        message: "new validation",
        nowMs: 501,
      }),
    ).toBe(true);
    expect((await listSandboxLayerBuildLogChunks(db, { buildId: retry.row.id })).map((chunk) => chunk.message)).toEqual(
      ["new validation"],
    );
  });

  it("guards build transitions and provider start idempotency", async () => {
    const db = createDb();
    const { row } = await seedBuild(db);

    expect(
      await claimSandboxLayerBuild(db, {
        buildId: row.id,
        fromStatus: "polling_provider",
        toStatus: "smoke_testing",
        nowMs: 1,
      }),
    ).toBe(false);
    expect(
      await claimSandboxLayerBuild(db, { buildId: row.id, fromStatus: "queued", toStatus: "validating", nowMs: 2 }),
    ).toBe(true);
    expect(
      await recordSandboxLayerProviderBuildStart(db, {
        buildId: row.id,
        providerTemplateRef: "template-1",
        providerBuildId: "provider-1",
        nowMs: 3,
      }),
    ).toBe(true);
    expect(
      await recordSandboxLayerProviderBuildStart(db, {
        buildId: row.id,
        providerTemplateRef: "template-1",
        providerBuildId: "provider-1",
        nowMs: 4,
      }),
    ).toBe(true);
    expect(
      await recordSandboxLayerProviderBuildStart(db, {
        buildId: row.id,
        providerTemplateRef: "template-2",
        providerBuildId: "provider-2",
        nowMs: 5,
      }),
    ).toBe(false);
    expect(
      await claimSandboxLayerBuild(db, {
        buildId: row.id,
        fromStatus: "polling_provider",
        toStatus: "smoke_testing",
        nowMs: 6,
      }),
    ).toBe(true);
    expect(
      await markSandboxLayerBuildCompleted(db, { buildId: row.id, smokeResultJson: '{"ok":true}', nowMs: 7 }),
    ).toBe(true);
    expect(await markSandboxLayerBuildFailed(db, { buildId: row.id, error: "too late", nowMs: 8 })).toBe(false);
  });

  it("reschedules and lists due builds without returning terminal builds", async () => {
    const db = createDb();
    const first = await seedBuild(db);
    const second = await seedBuild(db, { id: "build-2", sourceContentHash: "source-hash-2", nowMs: 201 });

    expect(await rescheduleSandboxLayerBuild(db, { buildId: first.row.id, nextAttemptAt: 500 })).toBe(true);
    expect(await markSandboxLayerBuildFailed(db, { buildId: second.row.id, error: "failed", nowMs: 300 })).toBe(true);
    const listDueIds = async (nowMs: number): Promise<string[]> =>
      (
        await db
          .prepare(
            `SELECT id FROM sandbox_layer_builds
             WHERE status IN ('queued', 'polling_provider')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY created_at ASC
             LIMIT 100`,
          )
          .bind(nowMs)
          .all<{ id: string }>()
      ).results.map((row) => row.id);
    expect(await listDueIds(499)).toEqual([]);
    expect(await listDueIds(500)).toEqual([first.row.id]);
    expect((await getSandboxLayerBuild(db, first.row.id))?.attempts).toBe(1);
  });

  it("creates artifacts idempotently and promotes by source/profile active pointer", async () => {
    const db = createDb();
    const first = await seedBuild(db);
    await completeBuild(db, first.row.id);
    const artifact = await createSandboxLayerArtifact(db, {
      id: "artifact-1",
      sourceId: first.row.source_id,
      buildId: first.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-1",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 400,
    });
    const duplicate = await createSandboxLayerArtifact(db, {
      id: "artifact-duplicate",
      sourceId: first.row.source_id,
      buildId: first.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-1",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 401,
    });

    expect(duplicate.id).toBe(artifact.id);
    expect(await promoteSandboxLayerArtifact(db, { buildId: first.row.id, artifactId: artifact.id, nowMs: 500 })).toBe(
      "promoted",
    );
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: first.row.source_id, resourceProfileKey: "default" }))?.id,
    ).toBe(artifact.id);

    const second = await seedBuild(db, { id: "build-2", sourceContentHash: "source-hash-2", nowMs: 250 });
    await completeBuild(db, second.row.id, 600);
    const secondArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-2",
      sourceId: second.row.source_id,
      buildId: second.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-2",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 700,
    });
    expect(
      await promoteSandboxLayerArtifact(db, { buildId: second.row.id, artifactId: secondArtifact.id, nowMs: 800 }),
    ).toBe("promoted");
    expect(await promoteSandboxLayerArtifact(db, { buildId: first.row.id, artifactId: artifact.id, nowMs: 900 })).toBe(
      "stale",
    );
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: first.row.source_id, resourceProfileKey: "default" }))?.id,
    ).toBe(secondArtifact.id);
  });

  it("upserts the artifact when a build id is rebuilt, instead of hard-failing on UNIQUE(build_id)", async () => {
    const db = createDb();
    const { row } = await seedBuild(db);

    // First completion creates the active artifact for this build id.
    expect(
      await claimSandboxLayerBuild(db, { buildId: row.id, fromStatus: "queued", toStatus: "validating", nowMs: 210 }),
    ).toBe(true);
    expect(
      await recordSandboxLayerProviderBuildStart(db, {
        buildId: row.id,
        providerTemplateRef: "template-v1",
        providerBuildId: "provider-v1",
        nowMs: 220,
      }),
    ).toBe(true);
    const firstBuild = await getSandboxLayerBuild(db, row.id);
    const firstArtifact = await completeSandboxLayerBuild(db, firstBuild!, "template-v1", "{}", 300);
    expect(firstArtifact.provider_artifact_ref).toBe("template-v1");
    expect(firstArtifact.status).toBe("active");

    // Rebuild the same build id (recovery of a current-but-stale layer): reset to
    // polling_provider and complete again with a freshly built template. The prior
    // artifact row is reused and re-pointed rather than colliding on UNIQUE(build_id).
    await db.prepare(`UPDATE sandbox_layer_builds SET status = 'polling_provider' WHERE id = ?`).bind(row.id).run();
    const secondBuild = await getSandboxLayerBuild(db, row.id);
    const secondArtifact = await completeSandboxLayerBuild(db, secondBuild!, "template-v2", "{}", 500);

    expect(secondArtifact.id).toBe(firstArtifact.id);
    expect(secondArtifact.provider_artifact_ref).toBe("template-v2");
    expect(secondArtifact.status).toBe("active");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }))
        ?.provider_artifact_ref,
    ).toBe("template-v2");
  });

  it("keeps the previous active artifact if promotion batch fails", async () => {
    const db = createDb();
    const first = await seedBuild(db);
    await completeBuild(db, first.row.id);
    const firstArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-1",
      sourceId: first.row.source_id,
      buildId: first.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-1",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 400,
    });
    expect(
      await promoteSandboxLayerArtifact(db, { buildId: first.row.id, artifactId: firstArtifact.id, nowMs: 500 }),
    ).toBe("promoted");

    const second = await seedBuild(db, { id: "build-2", sourceContentHash: "source-hash-2", nowMs: 250 });
    await completeBuild(db, second.row.id, 600);
    const secondArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-2",
      sourceId: second.row.source_id,
      buildId: second.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-2",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 700,
    });

    const failingDb = new FailingBatchSqliteD1((db as unknown as SqliteD1).sqlite, 1) as unknown as D1Database;
    await expect(
      promoteSandboxLayerArtifact(failingDb, { buildId: second.row.id, artifactId: secondArtifact.id, nowMs: 800 }),
    ).rejects.toThrow("injected batch failure");

    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: first.row.source_id, resourceProfileKey: "default" }))?.id,
    ).toBe(firstArtifact.id);
    expect(
      (
        await (db as unknown as SqliteD1).sqlite
          .prepare("SELECT status FROM sandbox_layer_artifacts WHERE id = ?")
          .get(secondArtifact.id)
      )?.status,
    ).toBe("candidate");
  });

  it("rolls back build completion if artifact persistence fails", async () => {
    const db = createDb();
    const seeded = await seedBuild(db);
    expect(
      await claimSandboxLayerBuild(db, {
        buildId: seeded.row.id,
        fromStatus: "queued",
        toStatus: "validating",
        nowMs: 300,
      }),
    ).toBe(true);
    expect(
      await recordSandboxLayerProviderBuildStart(db, {
        buildId: seeded.row.id,
        providerTemplateRef: "provider-template-1",
        providerBuildId: "provider-build-1",
        nowMs: 301,
      }),
    ).toBe(true);
    expect(
      await claimSandboxLayerBuild(db, {
        buildId: seeded.row.id,
        fromStatus: "polling_provider",
        toStatus: "smoke_testing",
        nowMs: 302,
      }),
    ).toBe(true);

    const failingDb = new FailingBatchSqliteD1((db as unknown as SqliteD1).sqlite, 1) as unknown as D1Database;
    await expect(
      completeSandboxLayerBuild(failingDb, seeded.row, "provider-template-1", '{"ok":true}', 400),
    ).rejects.toThrow("injected batch failure");

    expect((await getSandboxLayerBuild(db, seeded.row.id))?.status).toBe("smoke_testing");
    expect(await getSandboxLayerArtifactForBuild(db, seeded.row.id)).toBeNull();
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: seeded.row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();
  });

  it("does not let newer non-default candidate builds make default promotion stale", async () => {
    const db = createDb();
    const defaultBuild = await seedBuild(db, { id: "build-default", nowMs: 200 });
    await completeBuild(db, defaultBuild.row.id, 300);
    const defaultArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-default",
      sourceId: defaultBuild.row.source_id,
      buildId: defaultBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-default",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 400,
    });
    const candidateBuild = await seedBuild(db, {
      id: "build-candidate",
      sourceContentHash: "source-hash-candidate",
      requestedRef: "feature",
      promotionEligibility: "non_default_ref",
      willPromote: 0,
      nowMs: 250,
    });
    await completeBuild(db, candidateBuild.row.id, 500);
    await createSandboxLayerArtifact(db, {
      id: "artifact-candidate",
      sourceId: candidateBuild.row.source_id,
      buildId: candidateBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-candidate",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 600,
    });

    expect(
      await promoteSandboxLayerArtifact(db, {
        buildId: defaultBuild.row.id,
        artifactId: defaultArtifact.id,
        nowMs: 700,
      }),
    ).toBe("promoted");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: defaultBuild.row.source_id, resourceProfileKey: "default" }))
        ?.id,
    ).toBe(defaultArtifact.id);
  });

  it("getNewestCompletedPromotableSandboxLayerBuildForSourceProfile skips blocked artifacts", async () => {
    const db = createDb();
    const olderBuild = await seedBuild(db, { id: "build-older", nowMs: 200 });
    await completeBuild(db, olderBuild.row.id, 300);
    await createSandboxLayerArtifact(db, {
      id: "artifact-older",
      sourceId: olderBuild.row.source_id,
      buildId: olderBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-older",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 350,
    });

    const newerBuild = await seedBuild(db, {
      id: "build-newer",
      sourceId: olderBuild.row.source_id,
      sourceContentHash: "source-hash-newer",
      manifestHash: "manifest-hash-newer",
      layerHash: "layer-hash-newer",
      normalizedLayerHash: "normalized-layer-hash-newer",
      nowMs: 250,
    });
    await completeBuild(db, newerBuild.row.id, 400);
    await createSandboxLayerArtifact(db, {
      id: "artifact-newer",
      sourceId: newerBuild.row.source_id,
      buildId: newerBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-newer",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "blocked",
      nowMs: 450,
    });

    const result = await getNewestCompletedPromotableSandboxLayerBuildForSourceProfile(db, {
      sourceId: olderBuild.row.source_id,
      resourceProfileKey: "default",
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
    });

    expect(result?.id).toBe(olderBuild.row.id);
  });

  it("getNewestCompletedPromotableSandboxLayerBuildForSource skips blocked artifacts", async () => {
    const db = createDb();
    const olderBuild = await seedBuild(db, { id: "build-source-older", nowMs: 200 });
    await completeBuild(db, olderBuild.row.id, 300);
    await createSandboxLayerArtifact(db, {
      id: "artifact-source-older",
      sourceId: olderBuild.row.source_id,
      buildId: olderBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-source-older",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 350,
    });

    const newerBuild = await seedBuild(db, {
      id: "build-source-newer",
      sourceId: olderBuild.row.source_id,
      sourceContentHash: "source-hash-source-newer",
      manifestHash: "manifest-hash-source-newer",
      layerHash: "layer-hash-source-newer",
      normalizedLayerHash: "normalized-layer-hash-source-newer",
      nowMs: 250,
    });
    await completeBuild(db, newerBuild.row.id, 400);
    await createSandboxLayerArtifact(db, {
      id: "artifact-source-newer",
      sourceId: newerBuild.row.source_id,
      buildId: newerBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-source-newer",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "blocked",
      nowMs: 450,
    });

    const result = await getNewestCompletedPromotableSandboxLayerBuildForSource(db, {
      sourceId: olderBuild.row.source_id,
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
    });

    expect(result?.id).toBe(olderBuild.row.id);
  });

  it("getNewestCompletedPromotableSandboxLayerBuildForSourceProfile still returns completed builds missing artifact rows", async () => {
    const db = createDb();
    const olderBuild = await seedBuild(db, { id: "build-with-artifact", nowMs: 200 });
    await completeBuild(db, olderBuild.row.id, 300);
    await createSandboxLayerArtifact(db, {
      id: "artifact-with-artifact",
      sourceId: olderBuild.row.source_id,
      buildId: olderBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-with-artifact",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 350,
    });

    const newerBuild = await seedBuild(db, {
      id: "build-missing-artifact",
      sourceId: olderBuild.row.source_id,
      sourceContentHash: "source-hash-missing-artifact",
      manifestHash: "manifest-hash-missing-artifact",
      layerHash: "layer-hash-missing-artifact",
      normalizedLayerHash: "normalized-layer-hash-missing-artifact",
      nowMs: 250,
    });
    await completeBuild(db, newerBuild.row.id, 400);

    const result = await getNewestCompletedPromotableSandboxLayerBuildForSourceProfile(db, {
      sourceId: olderBuild.row.source_id,
      resourceProfileKey: "default",
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
    });

    expect(result?.id).toBe(newerBuild.row.id);
    expect(await getSandboxLayerArtifactForBuild(db, newerBuild.row.id)).toBeNull();
  });

  it("blocks artifacts before promotion and keeps active pointers profile-scoped", async () => {
    const db = createDb();
    const defaultBuild = await seedBuild(db);
    const largeBuild = await seedBuild(db, {
      id: "build-large",
      sourceContentHash: "source-hash-large",
      resourceProfileKey: "large",
    });
    await completeBuild(db, defaultBuild.row.id);
    await completeBuild(db, largeBuild.row.id, 500);

    const blocked = await createSandboxLayerArtifact(db, {
      id: "artifact-blocked",
      sourceId: defaultBuild.row.source_id,
      buildId: defaultBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-blocked",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 600,
    });
    expect(await blockSandboxLayerArtifact(db, { artifactId: blocked.id, nowMs: 650 })).toBe(true);
    expect(
      await promoteSandboxLayerArtifact(db, { buildId: defaultBuild.row.id, artifactId: blocked.id, nowMs: 700 }),
    ).toBe("blocked");

    const largeArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-large",
      sourceId: largeBuild.row.source_id,
      buildId: largeBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-large",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "large",
      nowMs: 800,
    });
    expect(
      await promoteSandboxLayerArtifact(db, { buildId: largeBuild.row.id, artifactId: largeArtifact.id, nowMs: 900 }),
    ).toBe("promoted");
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: largeBuild.row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: largeBuild.row.source_id, resourceProfileKey: "large" }))
        ?.id,
    ).toBe(largeArtifact.id);
  });

  it("blocks and clears only the current active artifact pointer", async () => {
    const db = createDb();
    const first = await seedBuild(db);
    await completeBuild(db, first.row.id);
    const firstArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-1",
      sourceId: first.row.source_id,
      buildId: first.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-1",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 400,
    });
    expect(
      await promoteSandboxLayerArtifact(db, { buildId: first.row.id, artifactId: firstArtifact.id, nowMs: 500 }),
    ).toBe("promoted");

    const second = await seedBuild(db, { id: "build-2", sourceContentHash: "source-hash-2", nowMs: 250 });
    await completeBuild(db, second.row.id, 600);
    const secondArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-2",
      sourceId: second.row.source_id,
      buildId: second.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-2",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      nowMs: 700,
    });
    expect(
      await promoteSandboxLayerArtifact(db, { buildId: second.row.id, artifactId: secondArtifact.id, nowMs: 800 }),
    ).toBe("promoted");

    expect(
      await blockActiveSandboxLayerArtifactIfCurrent(db, {
        sourceId: first.row.source_id,
        resourceProfileKey: "default",
        artifactId: firstArtifact.id,
        reason: "provider_missing",
        nowMs: 900,
      }),
    ).toBe(false);
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: first.row.source_id, resourceProfileKey: "default" }))?.id,
    ).toBe(secondArtifact.id);

    expect(
      await blockActiveSandboxLayerArtifactIfCurrent(db, {
        sourceId: first.row.source_id,
        resourceProfileKey: "default",
        artifactId: secondArtifact.id,
        reason: "provider_missing",
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: first.row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();
  });

  it("repairs the repo_local/profile active artifact by re-promoting the newest non-blocked artifact", async () => {
    const db = createDb();
    const olderBuild = await seedBuild(db, { id: "build-repair-older", nowMs: 200 });
    await completeBuild(db, olderBuild.row.id, 300);
    const olderArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-repair-older",
      sourceId: olderBuild.row.source_id,
      buildId: olderBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-repair-older",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 350,
    });
    expect(
      await promoteSandboxLayerArtifact(db, {
        buildId: olderBuild.row.id,
        artifactId: olderArtifact.id,
        nowMs: 400,
      }),
    ).toBe("promoted");

    const newerBuild = await seedBuild(db, {
      id: "build-repair-newer",
      sourceId: olderBuild.row.source_id,
      sourceContentHash: "source-hash-repair-newer",
      manifestHash: "manifest-hash-repair-newer",
      layerHash: "layer-hash-repair-newer",
      normalizedLayerHash: "normalized-layer-hash-repair-newer",
      nowMs: 250,
    });
    await completeBuild(db, newerBuild.row.id, 500);
    const newerArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-repair-newer",
      sourceId: newerBuild.row.source_id,
      buildId: newerBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "provider-template-repair-newer",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 550,
    });
    expect(
      await promoteSandboxLayerArtifact(db, {
        buildId: newerBuild.row.id,
        artifactId: newerArtifact.id,
        nowMs: 600,
      }),
    ).toBe("promoted");
    expect(
      await blockActiveSandboxLayerArtifactIfCurrent(db, {
        sourceId: newerBuild.row.source_id,
        resourceProfileKey: "default",
        artifactId: newerArtifact.id,
        reason: "missing_template",
        nowMs: 650,
      }),
    ).toBe(true);

    const repaired = await repairLatestPromotableSandboxLayerForSourceProfile(createEnv(db), {
      sourceId: olderBuild.row.source_id,
      resourceProfileKey: "default",
      reason: "unit_test_missing_template",
    });

    expect(repaired).toBe("provider-template-repair-older");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: olderBuild.row.source_id, resourceProfileKey: "default" }))
        ?.id,
    ).toBe(olderArtifact.id);
    expect((await getSandboxLayerArtifactForBuild(db, newerBuild.row.id))?.status).toBe("blocked");
    expect((await getSandboxLayerArtifactForBuild(db, olderBuild.row.id))?.status).toBe("active");
  });

  it("appends build logs idempotently and lists them by sequence cursor with a limit cap", async () => {
    const db = createDb();
    const { row } = await seedBuild(db);

    expect(
      await appendSandboxLayerBuildLogChunk(db, {
        id: "log-2",
        buildId: row.id,
        sequence: 2,
        message: "two",
        nowMs: 2,
      }),
    ).toBe(true);
    expect(
      await appendSandboxLayerBuildLogChunk(db, {
        id: "log-1",
        buildId: row.id,
        sequence: 1,
        message: "one",
        nowMs: 1,
      }),
    ).toBe(true);
    expect(
      await appendSandboxLayerBuildLogChunk(db, {
        id: "log-1-duplicate",
        buildId: row.id,
        sequence: 1,
        message: "duplicate",
        nowMs: 3,
      }),
    ).toBe(false);

    expect((await listSandboxLayerBuildLogChunks(db, { buildId: row.id })).map((chunk) => chunk.message)).toEqual([
      "one",
      "two",
    ]);
    expect(
      (await listSandboxLayerBuildLogChunks(db, { buildId: row.id, afterSequence: 1 })).map((chunk) => chunk.message),
    ).toEqual(["two"]);
  });

  it("keeps conflict-prone sandbox layer inserts conflict-safe", () => {
    const source = readFileSync("apps/control-plane-worker/src/sandbox/layer-db.ts", "utf8");
    const unsafeInserts = [
      ...source.matchAll(/INSERT\s+INTO\s+(sandbox_layer_\w+)([\s\S]*?)(?:`,|\n\s*\)\n\s*\.bind)/g),
    ]
      .map((match) => match[0])
      .filter((statement) => !/ON\s+CONFLICT|OR\s+IGNORE|SELECT \?, source_id, id/i.test(statement));

    expect(unsafeInserts).toEqual([]);
  });
});
