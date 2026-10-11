import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { SandboxLayerBuildReason } from "../../apps/control-plane-worker/src/sandbox/layer-db";
import {
  createOrGetSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  getSandboxLayerArtifactForBuild,
  getSandboxLayerBuild,
  listSandboxLayerBuildLogChunks,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";
import type { SandboxLayerProviderAdapter } from "../../apps/control-plane-worker/src/sandbox/layer-e2b-provider";
import {
  processSandboxLayerBuildMessage,
  queueSandboxLayerBuildRequest,
  SandboxLayerBuildQueueError,
  setSandboxLayerProviderAdapterForTest,
} from "../../apps/control-plane-worker/src/sandbox/layer-provider-build-service";
import type { Env, SandboxLayerBuildQueueMessage } from "../../apps/control-plane-worker/src/types";

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
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function fakeQueue(messages: SandboxLayerBuildQueueMessage[] = []): Queue<SandboxLayerBuildQueueMessage> {
  return {
    send: async (message: SandboxLayerBuildQueueMessage) => {
      messages.push(message);
    },
  } as unknown as Queue<SandboxLayerBuildQueueMessage>;
}

async function seedBuild(
  db: D1Database,
  input: {
    id?: string;
    sourceContentHash?: string;
    promotionEligibility?: "default_branch_head" | "non_default_ref";
    resourceProfileKey?: string;
    baseTemplateRef?: string;
    baseVersion?: string;
    buildReason?: SandboxLayerBuildReason;
  } = {},
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
  return createOrGetSandboxLayerBuild(db, {
    id: input.id ?? "build-1",
    sourceId: source.id,
    commitSha: "a".repeat(40),
    sourceContentHash: input.sourceContentHash ?? "source-hash",
    manifestHash: "manifest-hash",
    layerHash: "layer-hash",
    normalizedLayerHash: "normalized-layer-hash",
    manifestPath: ".cycloid/sandbox.yaml",
    layerPath: ".cycloid/sandbox.layer.Dockerfile",
    layerInstructionsJson: JSON.stringify([{ kind: "run", command: "apt-get update", startLine: 1, endLine: 1 }]),
    smokeCommandsJson: JSON.stringify([["bash", "-lc", "true"]]),
    baseTemplateRef: input.baseTemplateRef ?? "base-template",
    baseVersion: input.baseVersion ?? "base-version",
    resourceProfileKey: input.resourceProfileKey ?? "default",
    compilerVersion: "sandbox-layer-v1",
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    buildReason: input.buildReason ?? "manual",
    initialStatus: "validated",
    requestedRef: input.promotionEligibility === "non_default_ref" ? "feature" : "main",
    promotionEligibility: input.promotionEligibility ?? "default_branch_head",
    willPromote: (input.promotionEligibility ?? "default_branch_head") === "default_branch_head" ? 1 : 0,
    createdByUserId: 1,
    nowMs: 200,
  });
}

function fakeProvider(overrides: Partial<SandboxLayerProviderAdapter> = {}): SandboxLayerProviderAdapter {
  return {
    async startBuild() {
      return { providerTemplateRef: "layer-template", providerBuildId: "provider-build" };
    },
    async getBuildStatus() {
      return { status: "ready", logEntries: [{ message: "build ready" }], nextLogsOffset: 1 };
    },
    async createSmokeSandbox() {
      return { sandboxId: "smoke-sandbox" };
    },
    async runSmokeCommand() {
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async terminateSmokeSandbox() {
      return;
    },
    ...overrides,
  };
}

async function seedActiveArtifact(
  db: D1Database,
  input: { id: string; baseVersion: string; providerArtifactRef: string; sourceContentHash: string },
): Promise<void> {
  const { row } = await seedBuild(db, {
    id: input.id,
    sourceContentHash: input.sourceContentHash,
    baseVersion: input.baseVersion,
  });
  await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'completed', provider_artifact_ref = ?, completed_at = 300
       WHERE id = ?`,
    )
    .bind(input.providerArtifactRef, row.id)
    .run();
  const artifact = await createSandboxLayerArtifact(db, {
    id: `artifact-${input.id}`,
    sourceId: row.source_id,
    buildId: row.id,
    provider: "e2b",
    providerArtifactRef: input.providerArtifactRef,
    runtimeBackend: "e2b_cloud",
    resourceProfileKey: "default",
    status: "active",
    nowMs: 301,
  });
  await db
    .prepare(
      `INSERT INTO sandbox_layer_active_artifacts (source_id, resource_profile_key, artifact_id, build_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.source_id, "default", artifact.id, row.id, 302)
    .run();
}

async function captureStartBuildSkipCache(env: Env, buildId: string): Promise<Array<boolean | undefined>> {
  const skipCacheRequests: Array<boolean | undefined> = [];
  setSandboxLayerProviderAdapterForTest(
    fakeProvider({
      async startBuild(input) {
        skipCacheRequests.push(input.skipCache);
        return { providerTemplateRef: `layer-${buildId}`, providerBuildId: `provider-${buildId}` };
      },
    }),
  );
  await processSandboxLayerBuildMessage(env, { buildId, reason: "start", attempt: 0 });
  return skipCacheRequests;
}

describe("sandbox layer provider build service", () => {
  let db: D1Database;
  let messages: SandboxLayerBuildQueueMessage[];
  let env: Env;

  beforeEach(() => {
    db = createDb();
    messages = [];
    env = { DB: db, SANDBOX_LAYER_BUILD_QUEUE: fakeQueue(messages) } as Env;
    setSandboxLayerProviderAdapterForTest(null);
  });

  it("leaves validated rows untouched when the queue binding is missing", async () => {
    const { row } = await seedBuild(db);

    await expect(
      queueSandboxLayerBuildRequest({ DB: db } as Env, {
        id: row.id,
        status: "validated",
        repo: "trycycloid/repo",
        requestedRef: "main",
        commitSha: row.commit_sha,
        manifestPath: row.manifest_path,
        layerPath: row.layer_path,
        sourceContentHash: row.source_content_hash,
        baseTemplateRef: row.base_template_ref,
        baseVersion: row.base_version,
        resourceProfileKey: row.resource_profile_key,
        promotionEligibility: "default_branch_head",
      }),
    ).rejects.toBeInstanceOf(SandboxLayerBuildQueueError);

    expect((await getSandboxLayerBuild(db, row.id))?.status).toBe("validated");
  });

  it("sends the queue message before moving a validated request to queued", async () => {
    const { row } = await seedBuild(db);
    const queued = await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });

    expect(messages).toEqual([{ buildId: row.id, reason: "start", attempt: 0 }]);
    expect(queued.status).toBe("queued");
    expect((await getSandboxLayerBuild(db, row.id))?.status).toBe("queued");
  });

  it("does not start duplicate provider builds for duplicate start messages", async () => {
    const { row } = await seedBuild(db);
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    let starts = 0;
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async startBuild() {
          starts += 1;
          return { providerTemplateRef: "layer-template", providerBuildId: "provider-build" };
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });

    expect(starts).toBe(1);
    expect((await getSandboxLayerBuild(db, row.id))?.status).toBe("polling_provider");
  });

  it("persists provider logs, smokes, and promotes default branch artifacts", async () => {
    const { row } = await seedBuild(db);
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    const commands: string[] = [];
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async runSmokeCommand(input) {
          commands.push(input.command);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "smoke", attempt: 0 });

    const completed = await getSandboxLayerBuild(db, row.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.provider_logs_offset).toBe(1);
    expect(commands[0]).toBe("test -x /app/start-bridge.sh");
    expect(commands[1]).toBe("test -r /etc/cycloid/layer-env.sh");
    expect(commands[2]).toBe("bash -lc '. /etc/cycloid/layer-env.sh && test \"${ARCANIST_SANDBOX_LAYER_ENV:-}\" = 1'");
    expect((await listSandboxLayerBuildLogChunks(db, { buildId: row.id })).length).toBeGreaterThan(0);
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }))
        ?.provider_artifact_ref,
    ).toBe("layer-template");
  });

  it("reschedules transient provider poll errors instead of leaving builds stuck in polling_provider", async () => {
    const { row } = await seedBuild(db, { id: "build-poll-retry" });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    let pollAttempts = 0;
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async getBuildStatus() {
          pollAttempts += 1;
          if (pollAttempts === 1) throw new Error("network timeout talking to E2B");
          return { status: "ready", logEntries: [{ message: "build ready" }], nextLogsOffset: 1 };
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });

    const rescheduled = await getSandboxLayerBuild(db, row.id);
    expect(rescheduled?.status).toBe("queued");
    expect(rescheduled?.attempts).toBe(1);
    const retryStartMessage = messages.at(-1);
    expect(retryStartMessage).toEqual({ buildId: row.id, reason: "start", attempt: 0 });

    await processSandboxLayerBuildMessage(env, retryStartMessage!);
    await processSandboxLayerBuildMessage(env, messages.at(-1)!);

    const readyForSmoke = await getSandboxLayerBuild(db, row.id);
    const logMessages = (await listSandboxLayerBuildLogChunks(db, { buildId: row.id }))
      .map((chunk) => chunk.message)
      .join("\n");
    expect(readyForSmoke?.status).toBe("smoke_testing");
    expect(readyForSmoke?.provider_logs_offset).toBe(1);
    expect(logMessages).toContain('"retryNumber":1');
    expect(logMessages).toContain("provider_network_error");
  });

  it("fails provider poll errors after the retry budget is exhausted", async () => {
    const { row } = await seedBuild(db, { id: "build-poll-exhausted" });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async getBuildStatus() {
          throw new Error("network timeout talking to E2B");
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, messages.at(-1)!);
    await processSandboxLayerBuildMessage(env, messages.at(-1)!);
    await processSandboxLayerBuildMessage(env, messages.at(-1)!);
    await processSandboxLayerBuildMessage(env, messages.at(-1)!);

    const failed = await getSandboxLayerBuild(db, row.id);
    const logMessages = (await listSandboxLayerBuildLogChunks(db, { buildId: row.id }))
      .map((chunk) => chunk.message)
      .join("\n");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("provider_network_error");
    expect(failed?.attempts).toBe(2);
    expect(logMessages).toContain('"retryable":true');
    expect(logMessages).toContain('"retryNumber":1');
    expect(logMessages).toContain('"retryNumber":2');
    expect(logMessages).toContain('"exhausted":true');
  });

  it("logs non-retryable provider poll failures without marking them exhausted", async () => {
    const { row } = await seedBuild(db, { id: "build-poll-non-retryable" });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async getBuildStatus() {
          throw new Error("unauthorized by provider");
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });

    const failed = await getSandboxLayerBuild(db, row.id);
    const logMessages = (await listSandboxLayerBuildLogChunks(db, { buildId: row.id }))
      .map((chunk) => chunk.message)
      .join("\n");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("provider_auth_failed");
    expect(logMessages).toContain('"retryable":false');
    expect(logMessages).not.toContain('"exhausted":true');
  });

  it("recovers a queued provider poll retry when enqueueing the replacement start message fails", async () => {
    const { row } = await seedBuild(db, { id: "build-poll-recover-queued" });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    let failRecoveryStartEnqueue = true;
    env.SANDBOX_LAYER_BUILD_QUEUE = {
      send: async (message: SandboxLayerBuildQueueMessage) => {
        if (message.reason === "start" && failRecoveryStartEnqueue && message.buildId === row.id) {
          failRecoveryStartEnqueue = false;
          throw new Error("queue send failed");
        }
        messages.push(message);
      },
    } as Queue<SandboxLayerBuildQueueMessage>;
    let pollAttempts = 0;
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async getBuildStatus() {
          pollAttempts += 1;
          if (pollAttempts === 1) throw new Error("network timeout talking to E2B");
          return { status: "ready", logEntries: [{ message: "build ready" }], nextLogsOffset: 1 };
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await expect(processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 })).rejects.toThrow(
      "queue send failed",
    );

    const queued = await getSandboxLayerBuild(db, row.id);
    expect(queued?.status).toBe("queued");
    expect(queued?.attempts).toBe(1);

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    expect((await getSandboxLayerBuild(db, row.id))?.status).toBe("polling_provider");

    const recoveredPollMessage = messages.at(-1);
    expect(recoveredPollMessage).toEqual({ buildId: row.id, reason: "poll", attempt: 0 });

    await processSandboxLayerBuildMessage(env, recoveredPollMessage!);

    const recovered = await getSandboxLayerBuild(db, row.id);
    expect(recovered?.status).toBe("smoke_testing");
    expect(recovered?.provider_logs_offset).toBe(1);
  });

  it("marks smoke command runtime exceptions with command diagnostics", async () => {
    const { row } = await seedBuild(db);
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    const terminatedSandboxIds: string[] = [];
    let commandAttempts = 0;
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async runSmokeCommand() {
          commandAttempts += 1;
          if (commandAttempts === 4) {
            throw new Error("E2B runCommand failed ghp_abcdefghijklmnopqrstuvwxyz");
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        async terminateSmokeSandbox(input) {
          terminatedSandboxIds.push(input.sandboxId);
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "smoke", attempt: 0 });

    const failed = await getSandboxLayerBuild(db, row.id);
    const logs = await listSandboxLayerBuildLogChunks(db, { buildId: row.id });
    const smoke = JSON.parse(failed?.smoke_result_json ?? "{}") as {
      command?: string;
      commandIndex?: number;
      message?: string;
      results?: Array<{ command: string; commandIndex: number }>;
    };
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("smoke_runtime_error:E2B runCommand failed [redacted]");
    expect(smoke).toMatchObject({
      error: "smoke_runtime_error",
      command: "user smoke command",
      commandIndex: 3,
      message: "E2B runCommand failed [redacted]",
    });
    expect(smoke.results?.map((result) => result.command)).toEqual([
      "test -x /app/start-bridge.sh",
      "test -r /etc/cycloid/layer-env.sh",
      "verify layer env hook",
    ]);
    const logMessages = logs.map((chunk) => chunk.message).join("\n");
    expect(logMessages).toContain("smoke_runtime_error");
    expect(logMessages).toContain('"command":"user smoke command"');
    expect(logMessages).toContain('"commandIndex":3');
    expect(logMessages).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(terminatedSandboxIds).toEqual(["smoke-sandbox"]);
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();
  });

  it("marks non-zero smoke command results with command output diagnostics", async () => {
    const { row } = await seedBuild(db, {
      id: "build-smoke-command-failure",
      sourceContentHash: "smoke-command-failure-hash",
    });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    let commandAttempts = 0;
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async runSmokeCommand() {
          commandAttempts += 1;
          if (commandAttempts === 4) {
            return { exitCode: 42, stdout: "git missing", stderr: "python missing" };
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "smoke", attempt: 0 });

    const failed = await getSandboxLayerBuild(db, row.id);
    const smoke = JSON.parse(failed?.smoke_result_json ?? "{}") as {
      results?: Array<{ command: string; commandIndex: number; exitCode: number; stdout: string; stderr: string }>;
    };
    const logs = await listSandboxLayerBuildLogChunks(db, { buildId: row.id });
    const failedCommand = smoke.results?.at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("smoke_command_failed");
    expect(failedCommand).toMatchObject({
      command: "user smoke command",
      commandIndex: 3,
      exitCode: 42,
      stdout: "git missing",
      stderr: "python missing",
    });
    const logMessages = logs.map((chunk) => chunk.message).join("\n");
    expect(logMessages).toContain('"command":"user smoke command"');
    expect(logMessages).toContain('"stdout":"git missing"');
    expect(logMessages).toContain('"stderr":"python missing"');
  });

  it("marks smoke sandbox creation exceptions as terminal build failures", async () => {
    const { row } = await seedBuild(db, { id: "build-smoke-create-failure" });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
    let terminateCalls = 0;
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async createSmokeSandbox() {
          throw new Error("E2B create sandbox failed");
        },
        async terminateSmokeSandbox() {
          terminateCalls += 1;
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "smoke", attempt: 0 });

    const failed = await getSandboxLayerBuild(db, row.id);
    const smoke = JSON.parse(failed?.smoke_result_json ?? "{}") as Record<string, unknown>;
    const logs = await listSandboxLayerBuildLogChunks(db, { buildId: row.id });
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("smoke_runtime_error:E2B create sandbox failed");
    expect(failed?.smoke_sandbox_id).toBeNull();
    expect(smoke).not.toHaveProperty("command");
    expect(smoke).not.toHaveProperty("commandIndex");
    expect(logs.map((chunk) => chunk.message).join("\n")).not.toContain('"command"');
    expect(terminateCalls).toBe(0);
  });

  it("keeps non-default successful builds as candidates without promotion", async () => {
    const { row } = await seedBuild(db, {
      id: "build-feature",
      sourceContentHash: "feature-hash",
      promotionEligibility: "non_default_ref",
    });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "feature",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "non_default_ref",
    });
    setSandboxLayerProviderAdapterForTest(fakeProvider());

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "smoke", attempt: 0 });

    expect((await getSandboxLayerBuild(db, row.id))?.status).toBe("completed");
    expect((await getSandboxLayerArtifactForBuild(db, row.id))?.status).toBe("candidate");
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();
  });

  it("promotes an already-completed candidate when identical content later becomes default branch eligible", async () => {
    const candidate = await seedBuild(db, {
      id: "build-candidate",
      promotionEligibility: "non_default_ref",
    });
    await queueSandboxLayerBuildRequest(env, {
      id: candidate.row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "feature",
      commitSha: candidate.row.commit_sha,
      manifestPath: candidate.row.manifest_path,
      layerPath: candidate.row.layer_path,
      sourceContentHash: candidate.row.source_content_hash,
      baseTemplateRef: candidate.row.base_template_ref,
      baseVersion: candidate.row.base_version,
      resourceProfileKey: candidate.row.resource_profile_key,
      promotionEligibility: "non_default_ref",
      willPromote: 0,
    });
    setSandboxLayerProviderAdapterForTest(fakeProvider());

    await processSandboxLayerBuildMessage(env, { buildId: candidate.row.id, reason: "start", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: candidate.row.id, reason: "poll", attempt: 0 });
    await processSandboxLayerBuildMessage(env, { buildId: candidate.row.id, reason: "smoke", attempt: 0 });

    expect((await getSandboxLayerArtifactForBuild(db, candidate.row.id))?.status).toBe("candidate");
    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: candidate.row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();

    const upgraded = await createOrGetSandboxLayerBuild(db, {
      ...candidate.row,
      id: "build-default-duplicate",
      sourceId: candidate.row.source_id,
      commitSha: "b".repeat(40),
      sourceContentHash: candidate.row.source_content_hash,
      manifestHash: candidate.row.manifest_hash,
      layerHash: candidate.row.layer_hash,
      normalizedLayerHash: candidate.row.normalized_layer_hash,
      manifestPath: candidate.row.manifest_path,
      layerPath: candidate.row.layer_path,
      layerInstructionsJson: candidate.row.layer_instructions_json,
      smokeCommandsJson: candidate.row.smoke_commands_json,
      baseTemplateRef: candidate.row.base_template_ref,
      baseVersion: candidate.row.base_version,
      resourceProfileKey: candidate.row.resource_profile_key,
      compilerVersion: candidate.row.compiler_version,
      provider: candidate.row.provider,
      runtimeBackend: candidate.row.runtime_backend,
      requestedRef: "main",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
      createdByUserId: 1,
      nowMs: 900,
    });
    expect(upgraded.row.status).toBe("completed");
    expect(upgraded.row.promotion_eligibility).toBe("default_branch_head");

    await queueSandboxLayerBuildRequest(env, {
      id: upgraded.row.id,
      status: "completed",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: upgraded.row.commit_sha,
      manifestPath: upgraded.row.manifest_path,
      layerPath: upgraded.row.layer_path,
      sourceContentHash: upgraded.row.source_content_hash,
      baseTemplateRef: upgraded.row.base_template_ref,
      baseVersion: upgraded.row.base_version,
      resourceProfileKey: upgraded.row.resource_profile_key,
      promotionEligibility: "default_branch_head",
      willPromote: 1,
    });

    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: candidate.row.source_id, resourceProfileKey: "default" }))
        ?.build_id,
    ).toBe(candidate.row.id);
  });

  it("repairs and promotes a completed cached build when the artifact row is missing", async () => {
    const { row } = await seedBuild(db, {
      id: "build-completed-missing-artifact",
      promotionEligibility: "default_branch_head",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'layer-template',
             completed_at = 300
         WHERE id = ?`,
      )
      .bind(row.id)
      .run();

    expect(await getSandboxLayerArtifactForBuild(db, row.id)).toBeNull();

    const queued = await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "completed",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      providerArtifactRef: "layer-template",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
    });

    const artifact = await getSandboxLayerArtifactForBuild(db, row.id);
    expect(artifact?.status).toBe("active");
    expect(queued.activeTemplateRef).toBe("layer-template");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }))?.build_id,
    ).toBe(row.id);
  });

  it("promotes a completed default build when the artifact exists but no active pointer exists", async () => {
    const { row } = await seedBuild(db, {
      id: "build-completed-missing-active-pointer",
      promotionEligibility: "default_branch_head",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'layer-template',
             completed_at = 300
         WHERE id = ?`,
      )
      .bind(row.id)
      .run();
    const artifact = await createSandboxLayerArtifact(db, {
      id: "artifact-missing-active-pointer",
      sourceId: row.source_id,
      buildId: row.id,
      provider: "e2b",
      providerArtifactRef: "layer-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 301,
    });

    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();

    const queued = await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "completed",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      providerArtifactRef: "layer-template",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
    });

    expect((await getSandboxLayerArtifactForBuild(db, row.id))?.status).toBe("active");
    expect(queued.activeTemplateRef).toBe("layer-template");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: row.source_id, resourceProfileKey: "default" }))
        ?.artifact_id,
    ).toBe(artifact.id);
  });

  it("promotes the newest completed default artifact when an older completed build is stale", async () => {
    const older = await seedBuild(db, {
      id: "build-older-stale",
      sourceContentHash: "older-stale-hash",
      promotionEligibility: "default_branch_head",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'older-template',
             completed_at = 300,
             created_at = 200
         WHERE id = ?`,
      )
      .bind(older.row.id)
      .run();
    await createSandboxLayerArtifact(db, {
      id: "artifact-older-stale",
      sourceId: older.row.source_id,
      buildId: older.row.id,
      provider: "e2b",
      providerArtifactRef: "older-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 301,
    });

    const newer = await seedBuild(db, {
      id: "build-newer-stale",
      sourceContentHash: "newer-stale-hash",
      promotionEligibility: "default_branch_head",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'newer-template',
             completed_at = 500,
             created_at = 400
         WHERE id = ?`,
      )
      .bind(newer.row.id)
      .run();
    const newerArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-newer-stale",
      sourceId: newer.row.source_id,
      buildId: newer.row.id,
      provider: "e2b",
      providerArtifactRef: "newer-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 501,
    });

    expect(
      await getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }),
    ).toBeNull();

    const queued = await queueSandboxLayerBuildRequest(env, {
      id: older.row.id,
      status: "completed",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: older.row.commit_sha,
      manifestPath: older.row.manifest_path,
      layerPath: older.row.layer_path,
      sourceContentHash: older.row.source_content_hash,
      baseTemplateRef: older.row.base_template_ref,
      baseVersion: older.row.base_version,
      resourceProfileKey: older.row.resource_profile_key,
      providerArtifactRef: "older-template",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
    });

    expect(queued.activeTemplateRef).toBe("newer-template");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }))
        ?.artifact_id,
    ).toBe(newerArtifact.id);
  });

  it("does not promote a stale completed build over an existing active artifact", async () => {
    const older = await seedBuild(db, {
      id: "build-older-stale-with-active",
      sourceContentHash: "older-stale-active-hash",
      promotionEligibility: "default_branch_head",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'older-template',
             completed_at = 300,
             created_at = 200
         WHERE id = ?`,
      )
      .bind(older.row.id)
      .run();
    await createSandboxLayerArtifact(db, {
      id: "artifact-older-stale-with-active",
      sourceId: older.row.source_id,
      buildId: older.row.id,
      provider: "e2b",
      providerArtifactRef: "older-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 301,
    });

    const newer = await seedBuild(db, {
      id: "build-newer-stale-with-active",
      sourceContentHash: "newer-stale-active-hash",
      promotionEligibility: "default_branch_head",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'newer-template',
             completed_at = 500,
             created_at = 400
         WHERE id = ?`,
      )
      .bind(newer.row.id)
      .run();
    await createSandboxLayerArtifact(db, {
      id: "artifact-newer-stale-with-active",
      sourceId: newer.row.source_id,
      buildId: newer.row.id,
      provider: "e2b",
      providerArtifactRef: "newer-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "candidate",
      nowMs: 501,
    });

    const activeBuild = await seedBuild(db, {
      id: "build-existing-active",
      sourceContentHash: "existing-active-hash",
      promotionEligibility: "non_default_ref",
    });
    await db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             provider_artifact_ref = 'active-template',
             completed_at = 700,
             created_at = 600
         WHERE id = ?`,
      )
      .bind(activeBuild.row.id)
      .run();
    const activeArtifact = await createSandboxLayerArtifact(db, {
      id: "artifact-existing-active",
      sourceId: activeBuild.row.source_id,
      buildId: activeBuild.row.id,
      provider: "e2b",
      providerArtifactRef: "active-template",
      runtimeBackend: "e2b_cloud",
      resourceProfileKey: "default",
      status: "active",
      nowMs: 701,
    });
    await db
      .prepare(
        `INSERT INTO sandbox_layer_active_artifacts (source_id, resource_profile_key, artifact_id, build_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(activeBuild.row.source_id, "default", activeArtifact.id, activeBuild.row.id, 702)
      .run();

    const queued = await queueSandboxLayerBuildRequest(env, {
      id: older.row.id,
      status: "completed",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: older.row.commit_sha,
      manifestPath: older.row.manifest_path,
      layerPath: older.row.layer_path,
      sourceContentHash: older.row.source_content_hash,
      baseTemplateRef: older.row.base_template_ref,
      baseVersion: older.row.base_version,
      resourceProfileKey: older.row.resource_profile_key,
      providerArtifactRef: "older-template",
      promotionEligibility: "default_branch_head",
      willPromote: 1,
    });

    expect(queued.activeTemplateRef).toBe("active-template");
    expect(
      (await getActiveSandboxLayerArtifact(db, { sourceId: older.row.source_id, resourceProfileKey: "default" }))
        ?.artifact_id,
    ).toBe(activeArtifact.id);
  });

  it("passes the exact resolved resource profile dimensions to provider builds", async () => {
    const { row } = await seedBuild(db, {
      id: "build-large-profile",
      sourceContentHash: "large-profile-hash",
      resourceProfileKey: "trycycloid/cycloid",
    });
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
      willPromote: 1,
    });
    const resourceRequests: Array<{ cpuCount: number; memoryMB: number }> = [];
    setSandboxLayerProviderAdapterForTest(
      fakeProvider({
        async startBuild(input) {
          resourceRequests.push({ cpuCount: input.cpuCount, memoryMB: input.memoryMB });
          return { providerTemplateRef: "layer-template", providerBuildId: "provider-build" };
        },
      }),
    );

    await processSandboxLayerBuildMessage(env, { buildId: row.id, reason: "start", attempt: 0 });

    expect(resourceRequests).toEqual([{ cpuCount: 4, memoryMB: 8192 }]);
  });

  async function queueValidatedBuild(row: {
    id: string;
    commit_sha: string;
    manifest_path: string;
    layer_path: string;
    source_content_hash: string;
    base_template_ref: string;
    base_version: string;
    resource_profile_key: string;
  }): Promise<void> {
    await queueSandboxLayerBuildRequest(env, {
      id: row.id,
      status: "validated",
      repo: "trycycloid/repo",
      requestedRef: "main",
      commitSha: row.commit_sha,
      manifestPath: row.manifest_path,
      layerPath: row.layer_path,
      sourceContentHash: row.source_content_hash,
      baseTemplateRef: row.base_template_ref,
      baseVersion: row.base_version,
      resourceProfileKey: row.resource_profile_key,
      promotionEligibility: "default_branch_head",
    });
  }

  it("skips the provider layer cache for a base_update rebuild (base propagation)", async () => {
    // A base_update rebuild MUST bust the cached FROM TEMPLATE base pull, even if
    // a concurrently-completed build already recorded the target base_version —
    // that race is exactly how stale layers got recorded as current.
    await seedActiveArtifact(db, {
      id: "build-active-base-v1",
      baseVersion: "base-v2",
      providerArtifactRef: "layer-v2",
      sourceContentHash: "hash-active",
    });
    const { row } = await seedBuild(db, {
      id: "build-base-update",
      sourceContentHash: "hash-base-update",
      baseVersion: "base-v2",
      buildReason: "base_update",
    });
    await queueValidatedBuild(row);

    expect(await captureStartBuildSkipCache(env, row.id)).toEqual([true]);
  });

  it("skips the provider layer cache for a manual rebuild (ops/recovery correctness over speed)", async () => {
    const { row } = await seedBuild(db, {
      id: "build-manual",
      sourceContentHash: "hash-manual",
      buildReason: "manual",
    });
    await queueValidatedBuild(row);

    expect(await captureStartBuildSkipCache(env, row.id)).toEqual([true]);
  });

  it("keeps the provider layer cache for a source_update build (base unchanged)", async () => {
    const { row } = await seedBuild(db, {
      id: "build-source-update",
      sourceContentHash: "hash-source-update",
      buildReason: "source_update",
    });
    await queueValidatedBuild(row);

    expect(await captureStartBuildSkipCache(env, row.id)).toEqual([false]);
  });

  it("keeps the provider layer cache for a legacy build with null build_reason", async () => {
    // Rows written before the build_reason column existed carry null. The INSERT
    // path defaults new builds to "manual", so only legacy rows reach this branch;
    // lock in that they stay cache-fast rather than flipping behavior on migration.
    const { row } = await seedBuild(db, { id: "build-legacy-null", sourceContentHash: "hash-legacy-null" });
    await db.prepare(`UPDATE sandbox_layer_builds SET build_reason = NULL WHERE id = ?`).bind(row.id).run();
    await queueValidatedBuild(row);

    expect(await captureStartBuildSkipCache(env, row.id)).toEqual([false]);
  });
});
