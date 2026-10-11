import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  deleteSandboxLayerBusinessDefaultSource,
  deleteSandboxLayerRepoSourceAssignment,
  getAssignableSandboxLayerSourceByRepoPath,
  getSandboxLayerBusinessDefaultSource,
  getSandboxLayerBusinessDefaultSourceDetails,
  getSandboxLayerRepoSourceAssignment,
  hasSandboxLayerSourceInAnotherBusiness,
  listSandboxLayerRepoSourceAssignments,
  upsertSandboxLayerBusinessDefaultSource,
  upsertSandboxLayerRepoSourceAssignment,
} from "../../apps/control-plane-worker/src/sandbox/layer-assignment-db";

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
}

function createDb(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0179_sandbox_layers.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0180_sandbox_layer_provider_worker.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0181_sandbox_layer_assignments.sql", "utf8"));
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function seedSource(db: D1Database, input: { businessId?: string; sourceId?: string } = {}) {
  const sqlite = (db as unknown as SqliteD1).sqlite;
  const businessId = input.businessId ?? "biz-1";
  const sourceId = input.sourceId ?? "source-1";
  sqlite
    .prepare(
      `INSERT INTO sandbox_layer_sources (
         id, business_id, repo_owner, repo_name, manifest_path, status, created_by_user_id, created_at, updated_at
       )
       VALUES (?, ?, 'acme', 'templates', '.cycloid/sandbox.yaml', 'active', 1, 100, 100)`,
    )
    .run(sourceId, businessId);
  sqlite
    .prepare(
      `INSERT INTO sandbox_layer_builds (
         id, source_id, commit_sha, source_content_hash, manifest_hash, layer_hash, normalized_layer_hash,
         manifest_path, layer_path, layer_instructions_json, smoke_commands_json,
         base_template_ref, base_version, resource_profile_key, compiler_version, provider, runtime_backend,
         status, will_promote, created_by_user_id, created_at, attempts
       )
       VALUES (?, ?, ?, 'hash', 'mh', 'lh', 'nh', '.cycloid/sandbox.yaml', '.cycloid/layer.Dockerfile', '[]', '[]',
         'base-template', 'base-version', 'default', 'sandbox-layer-v1', 'e2b', 'e2b_cloud',
         'completed', 1, 1, 110, 0)`,
    )
    .run(`build-${sourceId}`, sourceId, "a".repeat(40));
  sqlite
    .prepare(
      `INSERT INTO sandbox_layer_artifacts (
         id, source_id, build_id, commit_sha, source_content_hash, base_template_ref, base_version, provider,
         provider_artifact_ref, runtime_backend, resource_profile_key, status, created_at
       )
       VALUES (?, ?, ?, ?, 'hash', 'base-template', 'base-version', 'e2b', ?, 'e2b_cloud', 'default', 'active', 120)`,
    )
    .run(`artifact-${sourceId}`, sourceId, `build-${sourceId}`, "a".repeat(40), `template-${sourceId}`);
  sqlite
    .prepare(
      `INSERT INTO sandbox_layer_active_artifacts (source_id, resource_profile_key, artifact_id, build_id, updated_at)
       VALUES (?, 'default', ?, ?, 130)`,
    )
    .run(sourceId, `artifact-${sourceId}`, `build-${sourceId}`);
  return { sourceId };
}

describe("sandbox layer assignment DB", () => {
  it("upserts and deletes business default assignments", async () => {
    const db = createDb();
    const { sourceId } = seedSource(db);

    await expect(
      upsertSandboxLayerBusinessDefaultSource(db, { businessId: "biz-1", sourceId, userId: 1, nowMs: 200 }),
    ).resolves.toMatchObject({ business_id: "biz-1", source_id: sourceId, updated_at: 200 });
    await expect(getSandboxLayerBusinessDefaultSourceDetails(db, "biz-1")).resolves.toMatchObject({
      source_id: sourceId,
      repo_owner: "acme",
      latest_active_artifact_ref: `template-${sourceId}`,
    });
    await expect(deleteSandboxLayerBusinessDefaultSource(db, "biz-1")).resolves.toBe(true);
    await expect(getSandboxLayerBusinessDefaultSource(db, "biz-1")).resolves.toBeNull();
  });

  it("upserts repo assignments with lowercased target repo identity", async () => {
    const db = createDb();
    const { sourceId } = seedSource(db);

    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "ACME",
      targetRepoName: "Backend",
      sourceId,
      userId: 1,
      nowMs: 200,
    });
    await upsertSandboxLayerRepoSourceAssignment(db, {
      businessId: "biz-1",
      targetRepoOwner: "acme",
      targetRepoName: "backend",
      sourceId,
      userId: 2,
      nowMs: 250,
    });

    await expect(
      getSandboxLayerRepoSourceAssignment(db, {
        businessId: "biz-1",
        targetRepoOwner: "acme",
        targetRepoName: "backend",
      }),
    ).resolves.toMatchObject({
      target_repo_owner: "acme",
      target_repo_name: "backend",
      updated_by_user_id: 2,
      updated_at: 250,
    });
    await expect(listSandboxLayerRepoSourceAssignments(db, "biz-1")).resolves.toHaveLength(1);
    await expect(
      deleteSandboxLayerRepoSourceAssignment(db, {
        businessId: "biz-1",
        targetRepoOwner: "acme",
        targetRepoName: "backend",
      }),
    ).resolves.toBe(true);
  });

  it("does not return sources from another business as assignable", async () => {
    const db = createDb();
    seedSource(db, { businessId: "biz-2", sourceId: "source-other" });

    await expect(
      getAssignableSandboxLayerSourceByRepoPath(db, {
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "templates",
        manifestPath: ".cycloid/sandbox.yaml",
      }),
    ).resolves.toBeNull();
    await expect(
      hasSandboxLayerSourceInAnotherBusiness(db, {
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "templates",
        manifestPath: ".cycloid/sandbox.yaml",
      }),
    ).resolves.toBe(true);
  });
});
