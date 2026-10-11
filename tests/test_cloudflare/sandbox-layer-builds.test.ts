import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  handleSandboxLayerBuildQueue,
  setSandboxLayerProviderAdapterForTest,
} from "../../apps/control-plane-worker/src/sandbox/layer-builds";
import {
  createOrGetSandboxLayerBuild,
  getActiveSandboxLayerArtifact,
  upsertSandboxLayerSource,
} from "../../apps/control-plane-worker/src/sandbox/layer-db";
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
    const result = this.db.prepare(this.query).run(...this.params);
    return { success: true, meta: { changes: result.changes } };
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
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const run = this.db.transaction((items: SqliteD1Statement[]) => items.map((statement) => statement.runSync()));
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

function message(buildId: string): Message<SandboxLayerBuildQueueMessage> & { acked: boolean; retried: boolean } {
  return {
    body: { buildId, reason: "start", attempt: 0 },
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  } as Message<SandboxLayerBuildQueueMessage> & { acked: boolean; retried: boolean };
}

describe("sandbox layer builds", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = createDb();
    env = { DB: db, E2B_API_KEY: "test-key" } as Env;
    setSandboxLayerProviderAdapterForTest(null);
  });

  it("polls the provider adapter and promotes a completed default-branch artifact", async () => {
    const source = await upsertSandboxLayerSource(db, {
      id: "source-1",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "example",
      manifestPath: ".cycloid/sandbox.yaml",
      createdByUserId: 1,
      nowMs: 100,
    });
    const { row: build } = await createOrGetSandboxLayerBuild(db, {
      id: "build-1",
      sourceId: source.id,
      commitSha: "a".repeat(40),
      sourceContentHash: "hash-1",
      manifestHash: "manifest-hash",
      layerHash: "layer-hash",
      normalizedLayerHash: "normalized-hash",
      manifestPath: ".cycloid/sandbox.yaml",
      layerPath: ".cycloid/sandbox.layer.Dockerfile",
      layerInstructionsJson: JSON.stringify([{ kind: "run", command: "apt-get update", startLine: 1, endLine: 1 }]),
      smokeCommandsJson: JSON.stringify([["bash", "-lc", "true"]]),
      baseTemplateRef: "base-template",
      baseVersion: "base-version",
      resourceProfileKey: "default",
      compilerVersion: "sandbox-layer-v1",
      provider: "e2b",
      runtimeBackend: "e2b_cloud",
      initialStatus: "queued",
      requestedRef: null,
      promotionEligibility: "default_branch_head",
      rebuildCampaignId: null,
      buildReason: "manual",
      willPromote: 1,
      createdByUserId: 1,
      nowMs: 200,
    });

    setSandboxLayerProviderAdapterForTest({
      async startBuild(input) {
        expect(input.baseTemplateRef).toBe("base-template");
        return { providerTemplateRef: "layer-template", providerBuildId: "provider-build" };
      },
      async getBuildStatus() {
        return { status: "ready", logEntries: [{ message: "done" }], nextLogsOffset: 1 };
      },
      async createSmokeSandbox() {
        return { sandboxId: "smoke-sandbox" };
      },
      async runSmokeCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async terminateSmokeSandbox() {
        return;
      },
    });
    env = {
      ...env,
      SANDBOX_LAYER_BUILD_QUEUE: {
        send: async () => undefined,
      } as unknown as Queue<SandboxLayerBuildQueueMessage>,
    } as Env;

    const first = message(build.id);
    await handleSandboxLayerBuildQueue({ messages: [first] } as MessageBatch<SandboxLayerBuildQueueMessage>, env);
    expect(first.acked).toBe(true);

    const second = { ...message(build.id), body: { buildId: build.id, reason: "poll", attempt: 0 } };
    await handleSandboxLayerBuildQueue({ messages: [second] } as MessageBatch<SandboxLayerBuildQueueMessage>, env);
    expect(second.acked).toBe(true);

    const third = { ...message(build.id), body: { buildId: build.id, reason: "smoke", attempt: 0 } };
    await handleSandboxLayerBuildQueue({ messages: [third] } as MessageBatch<SandboxLayerBuildQueueMessage>, env);
    expect(third.acked).toBe(true);

    const active = await getActiveSandboxLayerArtifact(db, {
      sourceId: source.id,
      resourceProfileKey: "default",
    });
    expect(active?.provider_artifact_ref).toBe("layer-template");
    expect(active?.build_id).toBe(build.id);
  });
});
