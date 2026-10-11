import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertActiveTemplateSupportsAgentBackend,
  getCurrentSandboxBaseTemplate,
  getSandboxBaseTemplatesByRef,
  registerSandboxBaseTemplates,
  resolveCurrentSandboxBaseTemplate,
  resolveFreestyleSnapshotAdvertisedAgentBackends,
  SandboxBaseTemplateError,
  SandboxTemplateCapabilityError,
} from "../../apps/control-plane-worker/src/sandbox/base-template-service";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import type { Env } from "../../apps/control-plane-worker/src/types";

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

function env(db = createDb(), overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    E2B_SANDBOX_TEMPLATE: "base-template",
    SANDBOX_IMAGE_VERSION: "base-version-env",
    ...overrides,
  } as Env;
}

describe("sandbox base template service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers current base templates and supersedes previous current rows", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template-v1",
          baseVersion: "sha-v1",
          contentHash: "hash-v1",
          gitSha: "sha-v1",
          workflowRunUrl: "https://github.com/trycycloid/cycloid/actions/runs/1",
          githubActor: "github-actions[bot]",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });
    const [current] = await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template-v2",
          baseVersion: "sha-v2",
          contentHash: "hash-v2",
          gitSha: "sha-v2",
          workflowRunUrl: "https://github.com/trycycloid/cycloid/actions/runs/2",
          githubActor: "github-actions[bot]",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 200,
    });

    expect(current?.base_template_ref).toBe("base-template-v2");
    expect(current?.content_hash).toBe("hash-v2");
    const rows = (db as unknown as SqliteD1).sqlite
      .prepare(
        `SELECT base_template_ref, base_version, content_hash, registered_by_kind, registered_by_user_id,
                github_actor, git_sha, workflow_run_url, smoke_status, is_current, superseded_at
         FROM sandbox_base_templates
         ORDER BY created_at`,
      )
      .all() as Array<{
      base_template_ref: string;
      base_version: string;
      content_hash: string | null;
      registered_by_kind: string;
      registered_by_user_id: number | null;
      github_actor: string | null;
      git_sha: string | null;
      workflow_run_url: string | null;
      smoke_status: string;
      is_current: number;
      superseded_at: number | null;
    }>;
    expect(rows).toEqual([
      {
        base_template_ref: "base-template-v1",
        base_version: "sha-v1",
        content_hash: "hash-v1",
        registered_by_kind: "admin",
        registered_by_user_id: 1,
        github_actor: "github-actions[bot]",
        git_sha: "sha-v1",
        workflow_run_url: "https://github.com/trycycloid/cycloid/actions/runs/1",
        smoke_status: "passed",
        is_current: 0,
        superseded_at: 200,
      },
      {
        base_template_ref: "base-template-v2",
        base_version: "sha-v2",
        content_hash: "hash-v2",
        registered_by_kind: "admin",
        registered_by_user_id: 1,
        github_actor: "github-actions[bot]",
        git_sha: "sha-v2",
        workflow_run_url: "https://github.com/trycycloid/cycloid/actions/runs/2",
        smoke_status: "passed",
        is_current: 1,
        superseded_at: null,
      },
    ]);
  });

  it("resolves registry rows before environment fallback", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "registered-template",
          baseVersion: "registered-sha",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 100,
    });

    const resolved = await resolveCurrentSandboxBaseTemplate(env(db), {
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      resourceProfileKey: "default",
      resourceProfile: {
        repoOwner: "default",
        repoName: "default",
        source: "default",
        specKey: "default",
        cpuCount: 2,
        memoryMB: 4096,
        timeoutMs: 1000,
        runtimeTemplateId: "env-template",
      },
    });

    expect(resolved).toMatchObject({
      baseTemplateRef: "registered-template",
      baseVersion: "registered-sha",
      source: "registry",
      versionQuality: "versioned",
    });
  });

  it("reads the current base template content hash", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "registered-template",
          baseVersion: "registered-sha",
          contentHash: "sha256:payload",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 100,
    });

    const current = await getCurrentSandboxBaseTemplate(db, {
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      resourceProfileKey: "default",
    });

    expect(current?.content_hash).toBe("sha256:payload");
  });

  it("keeps the previous current base if replacement registration fails", async () => {
    const db = createDb();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("base-template-row" as `${string}-${string}-${string}-${string}-${string}`)
      .mockReturnValueOnce("base-template-row" as `${string}-${string}-${string}-${string}-${string}`);

    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [
        {
          resourceProfileKey: "default",
          baseTemplateRef: "base-template-v1",
          baseVersion: "sha-v1",
          smokeStatus: "passed",
        },
      ],
      registeredByKind: "admin",
      registeredByUserId: 1,
      nowMs: 100,
    });

    await expect(
      registerSandboxBaseTemplates(db, {
        provider: "e2b",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        bases: [
          {
            resourceProfileKey: "default",
            baseTemplateRef: "base-template-v2",
            baseVersion: "sha-v2",
            smokeStatus: "passed",
          },
        ],
        registeredByKind: "admin",
        registeredByUserId: 1,
        nowMs: 200,
      }),
    ).rejects.toThrow(/UNIQUE|constraint/i);

    const current = await resolveCurrentSandboxBaseTemplate(env(db), {
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      resourceProfileKey: "default",
      resourceProfile: {
        repoOwner: "default",
        repoName: "default",
        source: "default",
        specKey: "default",
        cpuCount: 2,
        memoryMB: 4096,
        timeoutMs: 1000,
        runtimeTemplateId: "env-template",
      },
    });
    expect(current.baseTemplateRef).toBe("base-template-v1");
  });

  it("falls back to environment and reports unversioned fallback", async () => {
    const resolved = await resolveCurrentSandboxBaseTemplate(
      env(createDb(), { SANDBOX_IMAGE_VERSION: undefined, SENTRY_RELEASE: undefined }),
      {
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        resourceProfileKey: "default",
        resourceProfile: {
          repoOwner: "default",
          repoName: "default",
          source: "default",
          specKey: "default",
          cpuCount: 2,
          memoryMB: 4096,
          timeoutMs: 1000,
          runtimeTemplateId: "env-template",
        },
      },
    );

    expect(resolved).toMatchObject({
      baseTemplateRef: "env-template",
      baseVersion: "unversioned",
      source: "env_fallback",
      versionQuality: "unversioned",
    });
  });

  it("persists and resolves advertised agent runtime backends", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [{ resourceProfileKey: "default", baseTemplateRef: "tpl", baseVersion: "sha", smokeStatus: "passed" }],
      capabilities: ["opencode", "codex", "claude_code", "opencode"],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 100,
    });
    const resolved = await resolveCurrentSandboxBaseTemplate(env(db), {
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      resourceProfileKey: "default",
      resourceProfile: { runtimeTemplateId: "env-template" },
    });
    // Deduped and ordered by the canonical backend list.
    expect(resolved.agentRuntimeBackends).toEqual(["codex", "claude_code", "opencode"]);
  });

  it("rejects registration with an unknown capability backend", async () => {
    const db = createDb();
    await expect(
      registerSandboxBaseTemplates(db, {
        provider: "e2b",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        bases: [{ resourceProfileKey: "default", baseTemplateRef: "tpl", baseVersion: "sha", smokeStatus: "passed" }],
        capabilities: ["gemini"],
        registeredByKind: "automation",
        registeredByUserId: null,
        nowMs: 100,
      }),
    ).rejects.toBeInstanceOf(SandboxBaseTemplateError);
  });

  it("treats a legacy capabilities-less row as advertising no opt-in backends", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [{ resourceProfileKey: "default", baseTemplateRef: "tpl", baseVersion: "sha", smokeStatus: "passed" }],
      // no capabilities -> stored as []
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 100,
    });
    const resolved = await resolveCurrentSandboxBaseTemplate(env(db), {
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      resourceProfileKey: "default",
      resourceProfile: { runtimeTemplateId: "env-template" },
    });
    expect(resolved.agentRuntimeBackends).toEqual([]);
  });

  it("queries historical base templates by ref and version in newest-first order", async () => {
    const db = createDb();
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [{ resourceProfileKey: "default", baseTemplateRef: "tpl", baseVersion: "sha", smokeStatus: "passed" }],
      capabilities: ["opencode"],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 100,
    });
    await registerSandboxBaseTemplates(db, {
      provider: "e2b",
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      bases: [{ resourceProfileKey: "default", baseTemplateRef: "tpl", baseVersion: "sha", smokeStatus: "passed" }],
      capabilities: [],
      registeredByKind: "automation",
      registeredByUserId: null,
      nowMs: 200,
    });

    const rows = await getSandboxBaseTemplatesByRef(db, {
      runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
      resourceProfileKey: "default",
      baseTemplateRef: "tpl",
      baseVersion: "sha",
    });
    expect(rows.map((row) => row.created_at)).toEqual([200, 100]);
    await expect(
      getSandboxBaseTemplatesByRef(db, {
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        resourceProfileKey: "default",
        baseTemplateRef: "missing",
        baseVersion: "sha",
      }),
    ).resolves.toEqual([]);
  });

  describe("assertActiveTemplateSupportsAgentBackend", () => {
    async function registerWith(db: D1Database, capabilities: string[]) {
      await registerSandboxBaseTemplates(db, {
        provider: "e2b",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        bases: [{ resourceProfileKey: "default", baseTemplateRef: "tpl", baseVersion: "sha", smokeStatus: "passed" }],
        capabilities,
        registeredByKind: "automation",
        registeredByUserId: null,
        nowMs: 100,
      });
    }

    it("allows opencode when the active template advertises it", async () => {
      const db = createDb();
      await registerWith(db, ["codex", "claude_code", "opencode"]);
      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "opencode",
          resourceProfileKey: "default",
        }),
      ).resolves.toBeUndefined();
    });

    it("allows opencode when the selected layer artifact was built on an opencode-capable historical base", async () => {
      const db = createDb();
      await registerWith(db, ["codex", "claude_code", "opencode"]);
      await registerSandboxBaseTemplates(db, {
        provider: "e2b",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        bases: [
          {
            resourceProfileKey: "default",
            baseTemplateRef: "new-current-tpl",
            baseVersion: "new-sha",
            smokeStatus: "passed",
          },
        ],
        capabilities: ["codex", "claude_code", "opencode"],
        registeredByKind: "automation",
        registeredByUserId: null,
        nowMs: 200,
      });

      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "opencode",
          resourceProfileKey: "default",
          layerArtifactBase: {
            artifactId: "artifact-1",
            providerArtifactRef: "layer-template",
            resourceProfileKey: "default",
            baseTemplateRef: "tpl",
            baseVersion: "sha",
          },
        }),
      ).resolves.toBeUndefined();
    });

    it("rejects opencode when a selected layer artifact was built on a pre-opencode base even if current base advertises it", async () => {
      const db = createDb();
      await registerWith(db, []);
      (db as unknown as SqliteD1).sqlite
        .prepare("UPDATE sandbox_base_templates SET capabilities = NULL WHERE base_template_ref = ?")
        .run("tpl");
      await registerSandboxBaseTemplates(db, {
        provider: "e2b",
        runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        bases: [
          {
            resourceProfileKey: "default",
            baseTemplateRef: "new-current-tpl",
            baseVersion: "new-sha",
            smokeStatus: "passed",
          },
        ],
        capabilities: ["codex", "claude_code", "opencode"],
        registeredByKind: "automation",
        registeredByUserId: null,
        nowMs: 200,
      });

      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "opencode",
          resourceProfileKey: "default",
          layerArtifactBase: {
            artifactId: "artifact-1",
            providerArtifactRef: "layer-template",
            resourceProfileKey: "default",
            baseTemplateRef: "tpl",
            baseVersion: "sha",
          },
        }),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("fails closed when a selected layer artifact has no matching historical base row", async () => {
      const db = createDb();
      await registerWith(db, ["codex", "claude_code", "opencode"]);

      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "opencode",
          resourceProfileKey: "default",
          layerArtifactBase: {
            artifactId: "artifact-1",
            providerArtifactRef: "layer-template",
            resourceProfileKey: "default",
            baseTemplateRef: "missing-tpl",
            baseVersion: "missing-sha",
          },
        }),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("fails closed when duplicate historical layer base rows disagree on advertised backends", async () => {
      const db = createDb();
      await registerWith(db, ["codex", "claude_code", "opencode"]);
      await registerWith(db, ["codex", "claude_code"]);

      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "opencode",
          resourceProfileKey: "default",
          layerArtifactBase: {
            artifactId: "artifact-1",
            providerArtifactRef: "layer-template",
            resourceProfileKey: "default",
            baseTemplateRef: "tpl",
            baseVersion: "sha",
          },
        }),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("never gates baseline backends on the layer path", async () => {
      const db = {
        prepare() {
          throw new Error("baseline backend preflight should not query templates");
        },
      } as unknown as D1Database;
      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "codex",
          resourceProfileKey: "default",
          layerArtifactBase: {
            artifactId: "artifact-1",
            providerArtifactRef: "layer-template",
            resourceProfileKey: "default",
            baseTemplateRef: "missing-tpl",
            baseVersion: "missing-sha",
          },
        }),
      ).resolves.toBeUndefined();
    });

    it("rejects opencode when the active template does not advertise it", async () => {
      const db = createDb();
      await registerWith(db, ["codex", "claude_code"]);
      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "opencode",
          resourceProfileKey: "default",
        }),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("never gates baseline backends, even on a legacy capabilities-less template", async () => {
      const db = createDb();
      await registerWith(db, []);
      await expect(
        assertActiveTemplateSupportsAgentBackend(env(db), {
          agentRuntimeBackend: "codex",
          resourceProfileKey: "default",
        }),
      ).resolves.toBeUndefined();
    });

    it("rejects opencode on env fallback outside local dev (cannot prove capability)", async () => {
      const db = createDb();
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(db, { WORKER_ENV: "production", E2B_SANDBOX_TEMPLATE: "arc-default-template" }),
          { agentRuntimeBackend: "opencode", resourceProfileKey: "default" },
        ),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("allows opencode on env fallback in local dev (image installs every backend)", async () => {
      const db = createDb();
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(db, { WORKER_ENV: "local", E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-dev-local" }),
          { agentRuntimeBackend: "opencode", resourceProfileKey: "default" },
        ),
      ).resolves.toBeUndefined();
    });

    // A DB whose every access throws proves the freestyle path validates against the configured
    // snapshot and never falls through to the E2B `sandbox_base_templates` registry / env fallback
    // (the pre-fix bug that rejected opencode-on-Freestyle with source=env_fallback, empty caps).
    const throwingDb = {
      prepare() {
        throw new Error("freestyle preflight must not query the E2B template registry");
      },
    } as unknown as D1Database;
    const PROD_FREESTYLE_SNAPSHOT_ID = "sh-oqd4vrtk2araj4vj90io";

    it("allows opencode on a freestyle-routed session against the mapped prod snapshot", async () => {
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(throwingDb, { WORKER_ENV: "production", FREESTYLE_DEFAULT_SNAPSHOT_ID: PROD_FREESTYLE_SNAPSHOT_ID }),
          {
            agentRuntimeBackend: "opencode",
            resourceProfileKey: "trycycloid/cycloid",
            runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
          },
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects opencode on a freestyle session whose configured snapshot is not in the capability map", async () => {
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(throwingDb, { WORKER_ENV: "production", FREESTYLE_DEFAULT_SNAPSHOT_ID: "sh-unknown-snapshot" }),
          {
            agentRuntimeBackend: "opencode",
            resourceProfileKey: "trycycloid/cycloid",
            runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
          },
        ),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("fails closed for opencode on a freestyle session with no configured snapshot id", async () => {
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(throwingDb, { WORKER_ENV: "production", FREESTYLE_DEFAULT_SNAPSHOT_ID: undefined }),
          {
            agentRuntimeBackend: "opencode",
            resourceProfileKey: "trycycloid/cycloid",
            runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
          },
        ),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("rejects opencode against an unmapped per-repo snapshot even when the default is mapped", async () => {
      // The per-repo prebaked snapshot is what actually boots (freestyleSnapshotId beats
      // FREESTYLE_DEFAULT_SNAPSHOT_ID in the client), so the gate must validate it —
      // not the default — or opencode would spawn against an unproven snapshot.
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(throwingDb, { WORKER_ENV: "production", FREESTYLE_DEFAULT_SNAPSHOT_ID: PROD_FREESTYLE_SNAPSHOT_ID }),
          {
            agentRuntimeBackend: "opencode",
            resourceProfileKey: "trycycloid/cycloid",
            runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
            freestyleSnapshotId: "sh-repo-prebaked-unmapped",
          },
        ),
      ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);
    });

    it("allows opencode against a per-repo snapshot present in the capability map", async () => {
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(throwingDb, { WORKER_ENV: "production", FREESTYLE_DEFAULT_SNAPSHOT_ID: "sh-unknown-snapshot" }),
          {
            agentRuntimeBackend: "opencode",
            resourceProfileKey: "trycycloid/cycloid",
            runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
            freestyleSnapshotId: PROD_FREESTYLE_SNAPSHOT_ID,
          },
        ),
      ).resolves.toBeUndefined();
    });

    it("never gates baseline backends on a freestyle session (no snapshot lookup needed)", async () => {
      await expect(
        assertActiveTemplateSupportsAgentBackend(
          env(throwingDb, { WORKER_ENV: "production", FREESTYLE_DEFAULT_SNAPSHOT_ID: "sh-unknown-snapshot" }),
          {
            agentRuntimeBackend: "codex",
            resourceProfileKey: "trycycloid/cycloid",
            runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
          },
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("resolveFreestyleSnapshotAdvertisedAgentBackends", () => {
    it("advertises the full image set for the mapped prod snapshot", () => {
      const resolved = resolveFreestyleSnapshotAdvertisedAgentBackends(
        env(createDb(), { FREESTYLE_DEFAULT_SNAPSHOT_ID: "sh-oqd4vrtk2araj4vj90io" }),
      );
      expect(resolved.snapshotId).toBe("sh-oqd4vrtk2araj4vj90io");
      expect(resolved.agentRuntimeBackends).toEqual(["codex", "claude_code", "opencode"]);
    });

    it("advertises the full set for the cycloid per-repo prebaked snapshot", () => {
      const resolved = resolveFreestyleSnapshotAdvertisedAgentBackends(
        env(createDb(), { FREESTYLE_DEFAULT_SNAPSHOT_ID: "sh-unrelated-default" }),
        "sh-uxeq4e8pjym6o7zp5khx",
      );
      expect(resolved.snapshotId).toBe("sh-uxeq4e8pjym6o7zp5khx");
      expect(resolved.agentRuntimeBackends).toEqual(["codex", "claude_code", "opencode"]);
    });

    it("advertises nothing for an unmapped snapshot id", () => {
      const resolved = resolveFreestyleSnapshotAdvertisedAgentBackends(
        env(createDb(), { FREESTYLE_DEFAULT_SNAPSHOT_ID: "sh-unmapped" }),
      );
      expect(resolved.snapshotId).toBe("sh-unmapped");
      expect(resolved.agentRuntimeBackends).toEqual([]);
    });

    it("advertises nothing and reports a null snapshot id when unset", () => {
      const resolved = resolveFreestyleSnapshotAdvertisedAgentBackends(
        env(createDb(), { FREESTYLE_DEFAULT_SNAPSHOT_ID: undefined }),
      );
      expect(resolved.snapshotId).toBeNull();
      expect(resolved.agentRuntimeBackends).toEqual([]);
    });
  });

  it("passes selected layer artifact base provenance from the session spawn call site", () => {
    const source = readFileSync("apps/control-plane-worker/src/session/durable-object.ts", "utf8");
    const callStart = source.indexOf("await assertActiveTemplateSupportsAgentBackend");
    const callEnd = source.indexOf(");", callStart);
    const preflightCall = source.slice(callStart, callEnd + 2);
    expect(preflightCall).toContain("layerArtifactBase: sandboxLayerArtifact");
    expect(preflightCall).toContain("resourceProfileKey: sandboxLayerArtifact.resource_profile_key");
    expect(preflightCall).toContain("baseTemplateRef: sandboxLayerArtifact.base_template_ref");
    expect(preflightCall).toContain("baseVersion: sandboxLayerArtifact.base_version");
  });
});
