import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  getInstallationByOwner: vi.fn(),
  createInstallationToken: vi.fn(),
  createScopedInstallationToken: vi.fn(),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  fetchRepoTextFileAtCommit: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: githubMocks.getInstallationByOwner,
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: githubMocks.createInstallationToken,
}));

vi.mock("../../apps/control-plane-worker/src/github/repo-source", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/github/repo-source")>(
    "../../apps/control-plane-worker/src/github/repo-source",
  );
  return {
    ...actual,
    fetchRepoTextFileAtCommit: githubMocks.fetchRepoTextFileAtCommit,
  };
});

import { registerSandboxBaseTemplates } from "../../apps/control-plane-worker/src/sandbox/base-template-service";
import {
  claimSandboxLayerBuild,
  createOrGetSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  getSandboxLayerBuild,
  listSandboxLayerRebuildCandidatesForItems,
  markSandboxLayerBuildStatus,
  promoteSandboxLayerArtifact,
  recordSandboxLayerProviderBuildStart,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";

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
import {
  parseSandboxLayerSource,
  SANDBOX_LAYER_COMPILER_VERSION,
} from "../../apps/control-plane-worker/src/sandbox/layer-parser";
import {
  processSandboxLayerBuildMessage,
  setSandboxLayerProviderAdapterForTest,
} from "../../apps/control-plane-worker/src/sandbox/layer-provider-build-service";
import {
  createSandboxLayerRebuildCampaign,
  getSandboxLayerRebuildCampaign,
  processSandboxLayerRebuildCampaignsTick,
} from "../../apps/control-plane-worker/src/sandbox/layer-rebuild-campaign-service";
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

function env(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    E2B_SANDBOX_TEMPLATE: "base-template",
    SANDBOX_IMAGE_VERSION: "base-v2",
    ...overrides,
  } as Env;
}

function fakeQueue(messages: SandboxLayerBuildQueueMessage[]): Queue<SandboxLayerBuildQueueMessage> {
  return {
    send: async (message: SandboxLayerBuildQueueMessage) => {
      messages.push(message);
    },
  } as unknown as Queue<SandboxLayerBuildQueueMessage>;
}

function auth(): AuthInfo {
  return {
    userId: "1",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 1,
      login: "internal",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "admin",
    },
  };
}

async function seedActiveArtifact(
  db: D1Database,
  input: {
    sourceId: string;
    buildId: string;
    artifactId: string;
    baseVersion: string;
    resourceProfileKey?: string;
    commitSha?: string;
    sourceContentHash?: string;
  },
) {
  const source = await upsertSandboxLayerSource(db, {
    id: input.sourceId,
    businessId: "biz-1",
    repoOwner: "trycycloid",
    repoName: input.sourceId,
    manifestPath: ".cycloid/sandbox.yaml",
    createdByUserId: 1,
    nowMs: 100,
  });
  const { row } = await createOrGetSandboxLayerBuild(db, {
    id: input.buildId,
    sourceId: source.id,
    commitSha: input.commitSha ?? "a".repeat(40),
    sourceContentHash: input.sourceContentHash ?? `source-hash-${input.sourceId}`,
    manifestHash: "manifest-hash",
    layerHash: "layer-hash",
    normalizedLayerHash: "normalized-layer-hash",
    manifestPath: ".cycloid/sandbox.yaml",
    layerPath: ".cycloid/sandbox.layer.Dockerfile",
    layerInstructionsJson: "[]",
    smokeCommandsJson: "[]",
    baseTemplateRef: "base-template",
    baseVersion: input.baseVersion,
    resourceProfileKey: input.resourceProfileKey ?? "default",
    compilerVersion: "sandbox-layer-v1",
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    requestedRef: "main",
    promotionEligibility: "default_branch_head",
    willPromote: 1,
    createdByUserId: 1,
    nowMs: 200,
  });
  expect(
    await claimSandboxLayerBuild(db, { buildId: row.id, fromStatus: "queued", toStatus: "validating", nowMs: 201 }),
  ).toBe(true);
  expect(
    await recordSandboxLayerProviderBuildStart(db, {
      buildId: row.id,
      providerTemplateRef: `template-${input.artifactId}`,
      providerBuildId: `provider-${input.artifactId}`,
      nowMs: 202,
    }),
  ).toBe(true);
  expect(
    await claimSandboxLayerBuild(db, {
      buildId: row.id,
      fromStatus: "polling_provider",
      toStatus: "smoke_testing",
      nowMs: 203,
    }),
  ).toBe(true);
  expect(
    await markSandboxLayerBuildCompleted(db, {
      buildId: row.id,
      smokeResultJson: '{"status":"passed"}',
      providerArtifactRef: `provider-${input.artifactId}`,
      nowMs: 204,
    }),
  ).toBe(true);
  const artifact = await createSandboxLayerArtifact(db, {
    id: input.artifactId,
    sourceId: source.id,
    buildId: row.id,
    provider: "e2b",
    providerArtifactRef: `provider-${input.artifactId}`,
    runtimeBackend: "e2b_cloud",
    resourceProfileKey: input.resourceProfileKey ?? "default",
    nowMs: 300,
  });
  expect(await promoteSandboxLayerArtifact(db, { buildId: row.id, artifactId: artifact.id, nowMs: 400 })).toBe(
    "promoted",
  );
}

describe("sandbox layer rebuild campaign service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSandboxLayerProviderAdapterForTest(null);
    githubMocks.getInstallationByOwner.mockResolvedValue({
      installation_id: 123,
      owner_login: "trycycloid",
      suspended_at: null,
    });
    githubMocks.createInstallationToken.mockResolvedValue("installation-token");
    githubMocks.fetchRepoTextFileAtCommit.mockImplementation(
      async (_token: string, _owner: string, _repo: string, path: string) => {
        if (path === ".cycloid/sandbox.yaml") {
          return [
            "version: 1",
            "name: test",
            "layer:",
            "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
            "smoke:",
            "  commands:",
            '    - ["bash", "-lc", "true"]',
            "",
          ].join("\n");
        }
        if (path === ".cycloid/sandbox.layer.Dockerfile") return "RUN echo rebuilt\n";
        throw new Error(`unexpected path ${path}`);
      },
    );
  });

  it("dry-runs stale/current/unversioned active artifacts without queueing builds", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });
    await seedActiveArtifact(db, {
      sourceId: "current",
      buildId: "build-current",
      artifactId: "artifact-current",
      baseVersion: "base-v2",
    });

    const campaign = await createSandboxLayerRebuildCampaign(env(db), auth(), {
      scope: "business",
      businessId: "biz-1",
      reason: "base_update",
      dryRun: true,
    });

    expect(campaign.campaign.summary).toMatchObject({
      activeArtifactsScanned: 2,
      staleArtifactsFound: 1,
      currentArtifactsSkipped: 1,
      buildsQueued: 0,
    });
    expect(campaign.itemCounts).toMatchObject({ planned: 1, skipped_current: 1 });
    expect(campaign.items.find((item) => item.status === "planned")).toMatchObject({
      repo: "trycycloid/old",
      previousBaseVersion: "base-v1",
      targetBaseVersion: "base-v2",
      buildId: null,
    });
    const buildCount = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT COUNT(*) AS count FROM sandbox_layer_builds")
      .get() as { count: number };
    expect(buildCount.count).toBe(2);
  });

  it("batch-inserts planned campaign items and memoizes base-template resolution per profile", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    for (let index = 0; index < 105; index += 1) {
      await seedActiveArtifact(db, {
        sourceId: `old-${index}`,
        buildId: `build-old-${index}`,
        artifactId: `artifact-old-${index}`,
        baseVersion: "base-v1",
      });
    }
    const batchSizes: number[] = [];
    const preparedQueries: string[] = [];
    const countingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            preparedQueries.push(query);
            return target.prepare(query);
          };
        }
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchSizes.push(statements.length);
            return target.batch(statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    const campaign = await createSandboxLayerRebuildCampaign(env(countingDb), auth(), {
      scope: "business",
      businessId: "biz-1",
      reason: "base_update",
      dryRun: true,
    });

    expect(campaign.campaign.summary).toMatchObject({ activeArtifactsScanned: 105, staleArtifactsFound: 105 });
    expect(campaign.items).toHaveLength(105);
    expect(batchSizes).toEqual([50, 50, 5]);
    expect(
      preparedQueries.filter(
        (query) => query.includes("FROM sandbox_base_templates") && query.includes("resource_profile_key = ?"),
      ),
    ).toHaveLength(1);
  });

  it("lists rebuild candidates keyed by campaign item id", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old-a",
      buildId: "build-old-a",
      artifactId: "artifact-old-a",
      baseVersion: "base-v1",
    });
    await seedActiveArtifact(db, {
      sourceId: "old-b",
      buildId: "build-old-b",
      artifactId: "artifact-old-b",
      baseVersion: "base-v1",
    });
    const campaign = await createSandboxLayerRebuildCampaign(env(db), auth(), {
      scope: "business",
      businessId: "biz-1",
      reason: "base_update",
      dryRun: true,
    });
    const itemIds = campaign.items.map((item) => item.id).reverse();

    const candidatesByItemId = await listSandboxLayerRebuildCandidatesForItems(db, itemIds);

    expect([...candidatesByItemId.keys()].sort()).toEqual([...itemIds].sort());
    for (const item of campaign.items) {
      expect(candidatesByItemId.get(item.id)).toMatchObject({
        artifact_id: item.previousArtifactId,
        source_id: item.sourceId,
        source_repo_name: item.repo?.split("/")[1],
      });
    }
  });

  it("does not enqueue layer rebuilds when a no-op base registration keeps the content-addressed version", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-hash",
          contentHash: "base-hash",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "current",
      buildId: "build-current",
      artifactId: "artifact-current",
      baseVersion: "base-hash",
    });

    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-hash",
          contentHash: "base-hash",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 200,
    });

    const campaign = await createSandboxLayerRebuildCampaign(env(db), auth(), {
      scope: "business",
      businessId: "biz-1",
      reason: "base_update",
      dryRun: true,
    });

    expect(campaign.campaign.summary).toMatchObject({
      activeArtifactsScanned: 1,
      staleArtifactsFound: 0,
      currentArtifactsSkipped: 1,
      buildsQueued: 0,
    });
    expect(campaign.itemCounts).toMatchObject({ skipped_current: 1 });
    expect(campaign.items).toHaveLength(1);
    expect(campaign.items[0]).toMatchObject({
      status: "skipped_current",
      previousBaseVersion: "base-hash",
      targetBaseVersion: "base-hash",
      buildId: null,
    });
  });

  it("skips rebuild candidates when only an unversioned env fallback is available", async () => {
    const db = createDb();
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });

    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_IMAGE_VERSION: undefined, SENTRY_RELEASE: undefined }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: true,
      },
    );

    expect(campaign.campaign.summary).toMatchObject({
      activeArtifactsScanned: 1,
      staleArtifactsFound: 0,
      unversionedBaseSkips: 1,
      buildsQueued: 0,
    });
    expect(campaign.itemCounts).toMatchObject({ skipped_unversioned_base: 1 });
  });

  it("plans and queues deferred rebuild campaigns across scheduled batches", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    for (const suffix of ["a", "b", "c"]) {
      await seedActiveArtifact(db, {
        sourceId: `old-${suffix}`,
        buildId: `build-old-${suffix}`,
        artifactId: `artifact-old-${suffix}`,
        baseVersion: "base-v1",
      });
    }

    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: false,
      },
    );

    expect(campaign.campaign.status).toBe("queued");
    expect(campaign.items).toEqual([]);
    expect(githubMocks.fetchRepoTextFileAtCommit).not.toHaveBeenCalled();

    expect(
      await processSandboxLayerRebuildCampaignsTick(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
        candidateLimit: 2,
        itemQueueLimit: 1,
      }),
    ).toMatchObject({ campaignsScanned: 1, candidatesPlanned: 2, itemsQueued: 1 });
    let refreshed = await getSandboxLayerRebuildCampaign(db, campaign.campaign.id);
    expect(refreshed.campaign.summary).toMatchObject({ activeArtifactsScanned: 2, buildsQueued: 1 });
    expect(refreshed.itemCounts).toMatchObject({ planned: 1, queued: 1 });

    expect(
      await processSandboxLayerRebuildCampaignsTick(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
        candidateLimit: 2,
        itemQueueLimit: 1,
      }),
    ).toMatchObject({ campaignsScanned: 1, candidatesPlanned: 1, itemsQueued: 1 });
    refreshed = await getSandboxLayerRebuildCampaign(db, campaign.campaign.id);
    expect(refreshed.campaign.summary).toMatchObject({ activeArtifactsScanned: 3, buildsQueued: 2 });
    expect(refreshed.itemCounts).toMatchObject({ planned: 1, queued: 2 });

    expect(
      await processSandboxLayerRebuildCampaignsTick(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
        candidateLimit: 2,
        itemQueueLimit: 1,
      }),
    ).toMatchObject({ campaignsScanned: 1, candidatesPlanned: 0, itemsQueued: 1 });
    refreshed = await getSandboxLayerRebuildCampaign(db, campaign.campaign.id);
    expect(refreshed.campaign.status).toBe("queued");
    expect(refreshed.campaign.summary).toMatchObject({ activeArtifactsScanned: 3, buildsQueued: 3 });
    expect(refreshed.itemCounts).toMatchObject({ queued: 3 });
    expect(messages).toHaveLength(3);
  });

  it("does not let scanned campaigns with only queued builds consume scheduler slots", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old-a",
      buildId: "build-old-a",
      artifactId: "artifact-old-a",
      baseVersion: "base-v1",
    });

    const firstCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: false,
        processInline: false,
      },
    );
    expect(
      await processSandboxLayerRebuildCampaignsTick(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
        campaignLimit: 1,
        candidateLimit: 2,
        itemQueueLimit: 2,
      }),
    ).toMatchObject({ campaignsScanned: 1, candidatesPlanned: 1, itemsQueued: 1 });
    expect((await getSandboxLayerRebuildCampaign(db, firstCampaign.campaign.id)).itemCounts).toMatchObject({
      queued: 1,
    });

    await seedActiveArtifact(db, {
      sourceId: "old-b",
      buildId: "build-old-b",
      artifactId: "artifact-old-b",
      baseVersion: "base-v1",
    });
    const secondCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: false,
        processInline: false,
      },
    );

    expect(
      await processSandboxLayerRebuildCampaignsTick(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
        campaignLimit: 1,
        candidateLimit: 2,
        itemQueueLimit: 1,
      }),
    ).toMatchObject({ campaignsScanned: 1, candidatesPlanned: 2, itemsQueued: 1 });
    expect((await getSandboxLayerRebuildCampaign(db, secondCampaign.campaign.id)).items.length).toBe(2);
    expect(messages).toHaveLength(2);
  });

  it("starts a rebuild campaign from the active artifact commit and queues one idempotent build", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    const activeCommit = "c".repeat(40);
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
      commitSha: activeCommit,
    });

    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: false,
        processInline: true,
      },
    );
    const buildId = campaign.items[0]?.buildId;

    expect(campaign.campaign.status).toBe("queued");
    expect(campaign.campaign.summary).toMatchObject({ staleArtifactsFound: 1, buildsQueued: 1 });
    expect(campaign.items[0]).toMatchObject({ status: "queued", targetBaseVersion: "base-v2" });
    expect(messages).toEqual([{ buildId, reason: "start", attempt: 0 }]);
    expect(githubMocks.fetchRepoTextFileAtCommit).toHaveBeenCalledWith(
      "installation-token",
      "trycycloid",
      "old",
      ".cycloid/sandbox.yaml",
      activeCommit,
    );
    const build = await getSandboxLayerBuild(db, buildId!);
    expect(build).toMatchObject({
      commit_sha: activeCommit,
      build_reason: "base_update",
      rebuild_campaign_id: campaign.campaign.id,
      will_promote: 1,
      status: "queued",
    });

    const secondCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: false,
        processInline: true,
      },
    );

    const rebuildBuildCount = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT COUNT(*) AS count FROM sandbox_layer_builds WHERE build_reason = 'base_update'")
      .get() as { count: number };
    expect(rebuildBuildCount.count).toBe(1);
    expect(messages).toHaveLength(1);
    expect(secondCampaign.items[0]).toMatchObject({ buildId, status: "queued" });
    const campaignLogChunks = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT sequence, message FROM sandbox_layer_build_log_chunks WHERE build_id = ? ORDER BY sequence ASC")
      .all(buildId) as Array<{ sequence: number; message: string }>;
    expect(campaignLogChunks).toEqual([
      {
        sequence: 0,
        message: `Sandbox layer rebuild campaign ${campaign.campaign.id} item ${campaign.items[0]!.id} queued for active commit ${activeCommit}.`,
      },
      {
        sequence: 1,
        message: `Sandbox layer rebuild campaign ${secondCampaign.campaign.id} item ${secondCampaign.items[0]!.id} queued for active commit ${activeCommit}.`,
      },
    ]);

    setSandboxLayerProviderAdapterForTest({
      async startBuild() {
        return { providerTemplateRef: "rebuilt-template", providerBuildId: "provider-build" };
      },
      async getBuildStatus() {
        return { status: "ready", logEntries: [], nextLogsOffset: 0 };
      },
      async createSmokeSandbox() {
        return { sandboxId: "smoke" };
      },
      async runSmokeCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async terminateSmokeSandbox() {
        return;
      },
    });

    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId: buildId!,
      reason: "start",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId: buildId!,
      reason: "poll",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId: buildId!,
      reason: "smoke",
      attempt: 0,
    });

    const linkedItems = (db as unknown as SqliteD1).sqlite
      .prepare(
        "SELECT campaign_id, status, error FROM sandbox_layer_rebuild_campaign_items WHERE build_id = ? ORDER BY created_at ASC",
      )
      .all(buildId) as Array<{ campaign_id: string; status: string; error: string | null }>;
    expect(linkedItems).toHaveLength(2);
    expect(linkedItems).toEqual([
      { campaign_id: campaign.campaign.id, status: "promoted", error: null },
      { campaign_id: secondCampaign.campaign.id, status: "promoted", error: null },
    ]);
    const active = await getActiveSandboxLayerArtifact(db, { sourceId: "old", resourceProfileKey: "default" });
    expect(active?.build_id).toBe(buildId);
  });

  it("skips queueing when the GitHub installation is missing", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    githubMocks.getInstallationByOwner.mockResolvedValueOnce(null);
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });

    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      {
        scope: "business",
        businessId: "biz-1",
        reason: "base_update",
        dryRun: false,
        processInline: true,
      },
    );

    expect(campaign.campaign.status).toBe("completed_with_failures");
    expect(campaign.itemCounts).toMatchObject({ skipped_missing_installation: 1 });
    expect(campaign.campaign.summary).toMatchObject({ missingInstallationSkips: 1, buildsQueued: 0 });
    expect(messages).toEqual([]);
  });

  it("promotes a successful rebuild only when the previous active artifact still matches", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });
    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );
    const buildId = campaign.items[0]!.buildId!;
    setSandboxLayerProviderAdapterForTest({
      async startBuild() {
        return { providerTemplateRef: "rebuilt-template", providerBuildId: "provider-build" };
      },
      async getBuildStatus() {
        return { status: "ready", logEntries: [], nextLogsOffset: 0 };
      },
      async createSmokeSandbox() {
        return { sandboxId: "smoke" };
      },
      async runSmokeCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async terminateSmokeSandbox() {
        return;
      },
    });

    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "start",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "poll",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "smoke",
      attempt: 0,
    });

    const active = await getActiveSandboxLayerArtifact(db, { sourceId: "old", resourceProfileKey: "default" });
    const refreshed = await createSandboxLayerRebuildCampaign(env(db), auth(), {
      scope: "business",
      businessId: "biz-1",
      reason: "base_update",
      dryRun: true,
    });
    expect(active?.build_id).toBe(buildId);
    expect(refreshed.campaign.summary.currentArtifactsSkipped).toBe(1);
  });

  it("does not promote a rebuild when the active artifact changed during the campaign", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });
    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );
    const buildId = campaign.items[0]!.buildId!;
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-newer-active",
      artifactId: "artifact-newer-active",
      baseVersion: "base-v1.5",
      sourceContentHash: "newer-active-source",
    });
    setSandboxLayerProviderAdapterForTest({
      async startBuild() {
        return { providerTemplateRef: "rebuilt-template", providerBuildId: "provider-build" };
      },
      async getBuildStatus() {
        return { status: "ready", logEntries: [], nextLogsOffset: 0 };
      },
      async createSmokeSandbox() {
        return { sandboxId: "smoke" };
      },
      async runSmokeCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async terminateSmokeSandbox() {
        return;
      },
    });

    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "start",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "poll",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "smoke",
      attempt: 0,
    });

    const active = await getActiveSandboxLayerArtifact(db, { sourceId: "old", resourceProfileKey: "default" });
    const item = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT status, error FROM sandbox_layer_rebuild_campaign_items WHERE build_id = ?")
      .get(buildId) as { status: string; error: string };
    expect(active?.build_id).toBe("build-newer-active");
    expect(item.status).toBe("skipped_active_changed");
    expect(item.error).toContain("Active artifact changed");
  });

  it("promotes a reused rebuild build for the linked campaign item whose previous artifact is still active", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });
    const firstCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );
    const buildId = firstCampaign.items[0]!.buildId!;
    const reusedBuild = await getSandboxLayerBuild(db, buildId);
    expect(reusedBuild).toBeTruthy();
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-newer-active",
      artifactId: "artifact-newer-active",
      baseVersion: "base-v1.5",
      sourceContentHash: reusedBuild!.source_content_hash,
    });
    const secondCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );
    expect(secondCampaign.items[0]).toMatchObject({ buildId, status: "queued" });
    expect(messages).toHaveLength(1);
    setSandboxLayerProviderAdapterForTest({
      async startBuild() {
        return { providerTemplateRef: "rebuilt-template", providerBuildId: "provider-build" };
      },
      async getBuildStatus() {
        return { status: "ready", logEntries: [], nextLogsOffset: 0 };
      },
      async createSmokeSandbox() {
        return { sandboxId: "smoke" };
      },
      async runSmokeCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async terminateSmokeSandbox() {
        return;
      },
    });

    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "start",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "poll",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId,
      reason: "smoke",
      attempt: 0,
    });

    const active = await getActiveSandboxLayerArtifact(db, { sourceId: "old", resourceProfileKey: "default" });
    const linkedItems = (db as unknown as SqliteD1).sqlite
      .prepare(
        "SELECT campaign_id, status, error FROM sandbox_layer_rebuild_campaign_items WHERE build_id = ? ORDER BY created_at ASC",
      )
      .all(buildId) as Array<{ campaign_id: string; status: string; error: string | null }>;
    expect(active?.build_id).toBe(buildId);
    expect(linkedItems).toContainEqual({
      campaign_id: firstCampaign.campaign.id,
      status: "skipped_active_changed",
      error: "Active artifact changed before rebuild promotion",
    });
    expect(linkedItems).toContainEqual({ campaign_id: secondCampaign.campaign.id, status: "promoted", error: null });
  });

  it("does not rewrite an existing default build reason when a rebuild campaign reuses it", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    const activeCommit = "a".repeat(40);
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
      commitSha: activeCommit,
    });
    const parsed = await parseSandboxLayerSource({
      manifestPath: ".cycloid/sandbox.yaml",
      manifestText: [
        "version: 1",
        "name: test",
        "layer:",
        "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
        "smoke:",
        "  commands:",
        '    - ["bash", "-lc", "true"]',
        "",
      ].join("\n"),
      layerPath: ".cycloid/sandbox.layer.Dockerfile",
      layerText: "RUN echo rebuilt\n",
      buildIdentity: {
        baseTemplateRef: "base-template",
        baseVersion: "base-v2",
        compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
      },
    });
    const { row: defaultBuild } = await createOrGetSandboxLayerBuild(db, {
      id: "build-default",
      sourceId: "old",
      commitSha: activeCommit,
      sourceContentHash: parsed.hashes.normalizedSourceHash,
      manifestHash: parsed.hashes.manifestHash,
      layerHash: parsed.hashes.layerHash,
      normalizedLayerHash: parsed.hashes.normalizedSourceHash,
      manifestPath: ".cycloid/sandbox.yaml",
      layerPath: parsed.manifest.layerDockerfile,
      layerInstructionsJson: JSON.stringify(parsed.layer.instructions),
      smokeCommandsJson: JSON.stringify(parsed.manifest.smokeCommands),
      baseTemplateRef: "base-template",
      baseVersion: "base-v2",
      resourceProfileKey: "default",
      compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      initialStatus: "validated",
      requestedRef: "main",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
      createdByUserId: 1,
      nowMs: 500,
    });

    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );
    expect(campaign.items[0]).toMatchObject({ buildId: defaultBuild.id, status: "queued" });
    expect(await getSandboxLayerBuild(db, defaultBuild.id)).toMatchObject({ build_reason: "manual" });
    setSandboxLayerProviderAdapterForTest({
      async startBuild() {
        return { providerTemplateRef: "rebuilt-template", providerBuildId: "provider-build" };
      },
      async getBuildStatus() {
        return { status: "ready", logEntries: [], nextLogsOffset: 0 };
      },
      async createSmokeSandbox() {
        return { sandboxId: "smoke" };
      },
      async runSmokeCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async terminateSmokeSandbox() {
        return;
      },
    });

    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId: defaultBuild.id,
      reason: "start",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId: defaultBuild.id,
      reason: "poll",
      attempt: 0,
    });
    await processSandboxLayerBuildMessage(env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }), {
      buildId: defaultBuild.id,
      reason: "smoke",
      attempt: 0,
    });

    const item = (db as unknown as SqliteD1).sqlite
      .prepare("SELECT status, error FROM sandbox_layer_rebuild_campaign_items WHERE build_id = ?")
      .get(defaultBuild.id) as { status: string; error: string | null };
    const active = await getActiveSandboxLayerArtifact(db, { sourceId: "old", resourceProfileKey: "default" });
    expect(item).toEqual({ status: "promoted", error: null });
    expect(active?.build_id).toBe(defaultBuild.id);
  });

  it("fails a campaign item when a reused completed build has no artifact", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });
    const firstCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );
    const buildId = firstCampaign.items[0]!.buildId!;
    await markSandboxLayerBuildStatus(db, buildId, "smoke_testing", 499);
    await markSandboxLayerBuildCompleted(db, {
      buildId,
      smokeResultJson: '{"ok":true,"results":[]}',
      providerArtifactRef: "orphan-template",
      nowMs: 500,
    });

    const secondCampaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );

    expect(secondCampaign.items[0]).toMatchObject({
      buildId,
      status: "failed",
      error: "Completed sandbox layer build is missing its provider artifact",
    });
    expect(secondCampaign.campaign.status).toBe("failed");
  });

  it("links a reused completed build before promoting its existing artifact", async () => {
    const db = createDb();
    const messages: SandboxLayerBuildQueueMessage[] = [];
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template",
          baseVersion: "base-v2",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    await seedActiveArtifact(db, {
      sourceId: "old",
      buildId: "build-old",
      artifactId: "artifact-old",
      baseVersion: "base-v1",
    });
    const parsed = await parseSandboxLayerSource({
      manifestPath: ".cycloid/sandbox.yaml",
      manifestText: [
        "version: 1",
        "name: test",
        "layer:",
        "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
        "smoke:",
        "  commands:",
        '    - ["bash", "-lc", "true"]',
        "",
      ].join("\n"),
      layerPath: ".cycloid/sandbox.layer.Dockerfile",
      layerText: "RUN echo rebuilt\n",
      buildIdentity: {
        baseTemplateRef: "base-template",
        baseVersion: "base-v2",
        compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
      },
    });
    const { row } = await createOrGetSandboxLayerBuild(db, {
      id: "completed-reusable-build",
      sourceId: "old",
      commitSha: "a".repeat(40),
      sourceContentHash: parsed.hashes.normalizedSourceHash,
      manifestHash: parsed.hashes.manifestHash,
      layerHash: parsed.hashes.layerHash,
      normalizedLayerHash: parsed.hashes.normalizedSourceHash,
      manifestPath: ".cycloid/sandbox.yaml",
      layerPath: parsed.manifest.layerDockerfile,
      layerInstructionsJson: JSON.stringify(parsed.layer.instructions),
      smokeCommandsJson: JSON.stringify(parsed.manifest.smokeCommands),
      baseTemplateRef: "base-template",
      baseVersion: "base-v2",
      resourceProfileKey: "default",
      compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      requestedRef: "main",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
      createdByUserId: 1,
      nowMs: 500,
    });
    await markSandboxLayerBuildStatus(db, row.id, "smoke_testing", 501);
    await markSandboxLayerBuildCompleted(db, {
      buildId: row.id,
      smokeResultJson: '{"ok":true,"results":[]}',
      providerArtifactRef: "reused-template",
      nowMs: 502,
    });
    await createSandboxLayerArtifact(db, {
      id: "reused-artifact",
      sourceId: "old",
      buildId: row.id,
      provider: "e2b",
      providerArtifactRef: "reused-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 503,
    });

    const campaign = await createSandboxLayerRebuildCampaign(
      env(db, { SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) }),
      auth(),
      { scope: "business", businessId: "biz-1", reason: "base_update", dryRun: false, processInline: true },
    );

    expect(messages).toHaveLength(0);
    expect(campaign.items[0]).toMatchObject({
      buildId: row.id,
      status: "promoted",
      error: null,
    });
    const active = await getActiveSandboxLayerArtifact(db, { sourceId: "old", resourceProfileKey: "default" });
    expect(active?.id).toBe("reused-artifact");
    expect(active?.build_id).toBe(row.id);
  });
});
