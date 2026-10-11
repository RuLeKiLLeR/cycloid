import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { USER_SETTINGS_SELECT_BY_USER_ID_SQL } from "../../apps/control-plane-worker/src/settings/db";
import { seedSandboxState } from "./session/helpers";

const mocks = vi.hoisted(() => ({
  createSandbox: vi.fn(async (request: { sandboxId?: string; template?: string }) => ({
    runtimeProvider: "e2b",
    runtimeSandboxId: request.sandboxId ?? "sbx-test",
    runtimeTemplateId: request.template ?? "cycloid-sandbox-test",
    status: "running",
    createdAt: Date.now(),
  })),
  startCommand: vi.fn(async () => ({ pid: 123, startedAt: Date.now() })),
  terminateSandbox: vi.fn(async () => ({ status: "killed" })),
  refreshSandbox: vi.fn(async () => ({ status: "refreshed", refreshedUntil: Date.now() + 3_600_000 })),
  freestyleCreateSandbox: vi.fn(
    async (request: { sandboxId?: string; freestyleSnapshotId?: string }, config: { defaultSnapshotId?: string }) => ({
      runtimeProvider: "freestyle",
      runtimeSandboxId: request.sandboxId ?? "vm-test",
      runtimeTemplateId: request.freestyleSnapshotId ?? config.defaultSnapshotId ?? "snap-test",
      status: "running",
      createdAt: Date.now(),
      createDurationMs: 5,
    }),
  ),
  resolveAppRuntimeProfile: vi.fn(async () => ({
    dockerEnabled: false,
    previewContract: null,
    source: "none",
    diagnostics: [],
  })),
  isRepoPrivate: vi.fn(async () => true),
  // When set, `resolveSpawnIntegrationRuntime` returns this instead of resolving
  // against the fake DB. Lets a test inject a customer/integration ANTHROPIC_API_KEY
  // into the assembled sandbox env. Reset to null in beforeEach.
  integrationRuntimeOverride: null as Record<string, unknown> | null,
}));

function previewContract(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/workspace/repo",
    kind: "web",
    runner: "docker",
    entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
    url: { hostPort: 3000 },
    ...overrides,
  };
}

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  isRepoPrivate: (...args: unknown[]) => mocks.isRepoPrivate(...args),
}));

vi.mock("../../apps/control-plane-worker/src/sandbox/e2b-client", () => ({
  E2BSandboxClient: class {
    async createSandbox(request: Record<string, unknown>) {
      return mocks.createSandbox(request);
    }

    async startCommand(request: Record<string, unknown>) {
      return mocks.startCommand(request);
    }

    async terminateSandbox(runtimeSandboxId: string) {
      return mocks.terminateSandbox(runtimeSandboxId);
    }

    async refreshSandbox(runtimeSandboxId: string, durationMs: number) {
      return mocks.refreshSandbox(runtimeSandboxId, durationMs);
    }
  },
  E2BSandboxRuntimeError: class extends Error {
    code: string;
    requestSent: boolean;
    constructor(msg: string, opts: { code: string; requestSent: boolean }) {
      super(msg);
      this.code = opts.code;
      this.requestSent = opts.requestSent;
    }
  },
}));

// Only the client class is replaced (buildVmName etc. stay real): a freestyle-routed
// spawn otherwise constructs the real SDK client and would hit the network. The mock
// receives the constructor config so tests can assert the default-vs-per-repo snapshot
// fallback the way the real client resolves it.
vi.mock("../../apps/control-plane-worker/src/sandbox/freestyle-client", async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    FreestyleSandboxClient: class {
      config: { defaultSnapshotId?: string };

      constructor(config: { defaultSnapshotId?: string }) {
        this.config = config;
      }

      async createSandbox(request: Record<string, unknown>) {
        return mocks.freestyleCreateSandbox(request, this.config);
      }

      async startCommand(request: Record<string, unknown>) {
        return mocks.startCommand(request);
      }

      async terminateSandbox(runtimeSandboxId: string) {
        return mocks.terminateSandbox(runtimeSandboxId);
      }

      async refreshSandbox(runtimeSandboxId: string, durationMs: number) {
        return mocks.refreshSandbox(runtimeSandboxId, durationMs);
      }
    },
  };
});

vi.mock("../../apps/control-plane-worker/src/services/repo-preview", () => ({
  resolveAppRuntimeProfile: (...args: unknown[]) => mocks.resolveAppRuntimeProfile(...args),
}));

// Passthrough by default so existing spawn tests keep the real integration
// resolution against the fake DB; a test can inject an env via
// `mocks.integrationRuntimeOverride` to exercise customer-supplied credentials.
vi.mock("../../apps/control-plane-worker/src/integrations/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/integrations/runtime")>(
    "../../apps/control-plane-worker/src/integrations/runtime",
  );
  return {
    ...actual,
    resolveSpawnIntegrationRuntime: async (options: Parameters<typeof actual.resolveSpawnIntegrationRuntime>[0]) => {
      if (mocks.integrationRuntimeOverride) {
        return mocks.integrationRuntimeOverride as unknown as Awaited<
          ReturnType<typeof actual.resolveSpawnIntegrationRuntime>
        >;
      }
      return actual.resolveSpawnIntegrationRuntime(options);
    },
  };
});

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
};

interface UserRow {
  id: number;
  github_id: number | null;
  login: string | null;
  name: string | null;
  email: string | null;
  business_id: string | null;
}

interface UserSettingsRow {
  user_id: number;
  use_codex_subscription?: number;
  default_model: string | null;
  default_repo: string | null;
  created_at: number;
  updated_at: number;
}

interface UserIntegrationRow {
  user_id: number;
  integration_id: string;
  oauth_access_token?: string | null;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: number | null;
  api_key?: string | null;
  service_url?: string | null;
  encrypted?: number;
  last_validation_status?: string | null;
}

interface EnvBlobRow {
  id: string;
  owner_user_id: number;
  business_id: string | null;
  name: string;
  env_text: string;
  encrypted: number;
  key_names_json: string;
  entry_meta_json?: string;
  is_global: number;
  created_at: number;
  updated_at: number;
  repo_owner: string;
  repo_name: string;
}

interface BusinessTestCredentialRow {
  business_id: string;
  repo_owner: string;
  repo_name: string;
  name: string;
  encrypted_value: string;
  encrypted: number;
}

interface BusinessRow {
  id: string;
  egress_allowlist_json: string | null;
}

interface OpenAIGatewaySessionTokenRow {
  token_hash: string;
  owner_user_id: number;
  business_id: string | null;
  credential_source: string;
  credential_provider: string;
  credential_owner_id: string;
  session_id: string;
  expires_at: number;
  created_at: number;
}

interface SandboxBaseTemplateTestRow {
  provider: "e2b";
  runtime_backend: "e2b_cloud";
  resource_profile_key: string;
  base_template_ref: string;
  base_version: string;
  is_current: number;
  capabilities: string | null;
  created_at: number;
}

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS next_attempt_at")) {
      return null;
    }

    if (this.query.includes("SELECT business_id FROM business_members")) {
      return null;
    }

    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return (session ? { business_id: session.business_id } : null) as T | null;
    }

    if (this.query.includes("SELECT business_id FROM users WHERE id = ? LIMIT 1")) {
      const [userId] = this.boundValues as [number | string];
      const user = this.db.users.get(Number(userId));
      return (user ? { business_id: user.business_id } : null) as T | null;
    }

    if (
      this.query.includes("SELECT github_id, login, name, email FROM users WHERE id = ? LIMIT 1") ||
      this.query.includes("SELECT login, name, email FROM users WHERE id = ? LIMIT 1")
    ) {
      const [userId] = this.boundValues as [number | string];
      return (this.db.users.get(Number(userId)) ?? null) as T | null;
    }

    if (this.query.includes(USER_SETTINGS_SELECT_BY_USER_ID_SQL)) {
      const [userId] = this.boundValues as [number];
      return (this.db.userSettings.get(userId) ?? null) as T | null;
    }

    if (this.query.includes("SELECT use_codex_subscription FROM user_settings WHERE user_id = ? LIMIT 1")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userSettings.get(userId);
      return { use_codex_subscription: row?.use_codex_subscription ?? 0 } as T;
    }

    if (
      this.query.includes(
        "SELECT oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted FROM user_integrations",
      ) &&
      this.query.includes("integration_id = 'github'")
    ) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:github`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (
      this.query.includes("SELECT oauth_access_token, oauth_refresh_token, oauth_expires_at") &&
      this.query.includes("integration_id = 'linear'")
    ) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:linear`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        api_key: row.api_key ?? null,
        external_user_id: null,
        service_url: row.service_url ?? null,
        encrypted: row.encrypted ?? 0,
        last_validated_at: row.last_validated_at ?? null,
        last_validation_status: row.last_validation_status ?? null,
        last_validation_reason_code: row.last_validation_reason_code ?? null,
      } as T;
    }

    if (
      this.query.includes(
        "SELECT oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted FROM user_integrations",
      ) &&
      this.query.includes("integration_id = 'slack'")
    ) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:slack`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (
      this.query.includes("SELECT api_key") &&
      this.query.includes("FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1")
    ) {
      const [userId, integrationId] = this.boundValues as [number, string];
      const row = this.db.userIntegrations.get(`${userId}:${integrationId}`);
      if (!row?.api_key) return null;
      return {
        api_key: row.api_key,
        encrypted: row.encrypted ?? 0,
        last_validation_status: row.last_validation_status ?? null,
      } as T;
    }

    if (this.query.includes("FROM env_blobs b") && this.query.includes("INNER JOIN env_blob_repos")) {
      const [businessId, name, repoOwner, repoName] = this.boundValues as [string, string, string, string];
      const rows = [...this.db.envBlobs.values()]
        .filter(
          (row) =>
            row.business_id === businessId &&
            row.name === name &&
            row.is_global === 0 &&
            row.repo_owner === repoOwner &&
            row.repo_name === repoName,
        )
        .sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id));
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        repo_owner: row.repo_owner,
        repo_name: row.repo_name,
      } as T;
    }

    // Personal secrets use a direct env_blobs lookup with `is_global = 1` and
    // `COALESCE(entry_meta_json, '{}')` in the SELECT list.
    if (this.query.includes("FROM env_blobs") && this.query.includes("is_global = 1")) {
      const [ownerUserId, name] = this.boundValues as [number | string, string];
      const ownerUserIdNumber = Number(ownerUserId);
      const rows = [...this.db.envBlobs.values()]
        .filter((row) => row.owner_user_id === ownerUserIdNumber && row.name === name && row.is_global === 1)
        .sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id));
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        entry_meta_json: row.entry_meta_json ?? "{}",
      } as T;
    }

    if (this.query.includes("FROM business_test_credentials")) {
      const [businessId, repoOwner, repoName, name] = this.boundValues as [string, string, string, string];
      const row = this.db.businessTestCredentials.get(`${businessId}:${repoOwner}:${repoName}:${name}`);
      if (!row) return null;
      return { encrypted_value: row.encrypted_value, encrypted: row.encrypted } as T;
    }

    if (
      this.query.includes("FROM sandbox_layer_sources s") &&
      this.query.includes("INNER JOIN sandbox_layer_active_artifacts active") &&
      this.query.includes("s.business_id = ?")
    ) {
      const [businessId, repoOwner, repoName, manifestPath, resourceProfileKey] = this.boundValues as [
        string,
        string,
        string,
        string,
        string | undefined,
      ];
      const row = this.db.sandboxLayerActiveArtifacts.get(`${businessId}:${repoOwner}:${repoName}:${manifestPath}`);
      if (!row) return null;
      if (this.query.includes("active.resource_profile_key = ?") && row.resource_profile_key !== resourceProfileKey) {
        return null;
      }
      return row as T;
    }

    if (this.query.includes("FROM sandbox_layer_repo_source_assignments a")) {
      const [businessId, targetRepoOwner, targetRepoName] = this.boundValues as [string, string, string];
      const sourceId = this.db.sandboxLayerRepoAssignments.get(`${businessId}:${targetRepoOwner}:${targetRepoName}`);
      if (!sourceId) return null;
      return (this.db.sandboxLayerSources.get(sourceId) as T | undefined) ?? null;
    }

    if (this.query.includes("FROM sandbox_layer_business_default_sources d")) {
      const [businessId] = this.boundValues as [string];
      const sourceId = this.db.sandboxLayerBusinessDefaults.get(businessId);
      if (!sourceId) return null;
      return (this.db.sandboxLayerSources.get(sourceId) as T | undefined) ?? null;
    }

    if (
      this.query.includes("FROM sandbox_layer_sources source") &&
      this.query.includes("INNER JOIN sandbox_layer_active_artifacts active") &&
      this.query.includes("source.id = ?")
    ) {
      const [businessId, sourceId, resourceProfileKey] = this.boundValues as [string, string, string];
      const row = [...this.db.sandboxLayerActiveArtifacts.values()].find(
        (candidate) =>
          candidate.source_id === sourceId &&
          (candidate.business_id == null || candidate.business_id === businessId) &&
          candidate.resource_profile_key === resourceProfileKey &&
          candidate.status === "active" &&
          candidate.source_status === "active",
      );
      return (row as T | undefined) ?? null;
    }

    if (this.query.includes("SELECT egress_allowlist_json FROM businesses WHERE id = ? LIMIT 1")) {
      const [businessId] = this.boundValues as [string];
      return (this.db.businesses.get(businessId) ?? { egress_allowlist_json: null }) as T;
    }

    if (this.query.includes("codex_byos_enabled")) {
      const [businessId] = this.boundValues as [string];
      return { codex_byos_enabled: businessId === "295d2abc-d10b-4662-b84d-7bfa66242882" ? 1 : 0 } as T;
    }

    if (this.query.includes("FROM sandbox_base_templates") && this.query.includes("is_current = 1")) {
      const [runtimeBackend, resourceProfileKey] = this.boundValues as [string, string];
      const row = [...this.db.sandboxBaseTemplates.values()].find(
        (candidate) =>
          candidate.runtime_backend === runtimeBackend &&
          candidate.resource_profile_key === resourceProfileKey &&
          candidate.is_current === 1,
      );
      return (row as T | undefined) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }> {
    if (this.query.includes("INSERT INTO user_settings")) {
      // `INSERT ... SELECT id, ?, ... FROM users WHERE id = ?` binds the user
      // id LAST; the SELECT column values come first.
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      // [0] default_pr_draft and [1] auto_verify_enabled are not modeled by
      // this fixture's row type.
      const use_codex_subscription = this.boundValues[2] as number;
      const default_model = this.boundValues[3] as string | null;
      const default_repo = this.boundValues[4] as string | null;
      const createdAt = this.boundValues[5] as number;
      const updatedAt = this.boundValues[6] as number;
      this.db.userSettings.set(userId, {
        user_id: userId,
        use_codex_subscription,
        default_model,
        default_repo,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE session_index SET snapshot_image_id = ? WHERE session_id = ?")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE session_index SET runtime_backend = ? WHERE session_id = ?")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("runtime_provider")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO openai_gateway_session_tokens")) {
      const [tokenHash, ownerUserId, businessId, credentialSource, credentialOwnerId, sessionId, expiresAt, createdAt] =
        this.boundValues as [string, number, string | null, string, string, string, number, number];
      this.db.openAIGatewaySessionTokens.set(tokenHash, {
        token_hash: tokenHash,
        owner_user_id: ownerUserId,
        business_id: businessId,
        credential_source: credentialSource,
        credential_provider: "openai",
        credential_owner_id: credentialOwnerId,
        session_id: sessionId,
        expires_at: expiresAt,
        created_at: createdAt,
      });
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (
      this.query.includes("UPDATE sandbox_layer_artifacts") &&
      this.query.includes("EXISTS") &&
      this.query.includes("sandbox_layer_active_artifacts")
    ) {
      const [blockedAt, artifactId, sourceId, resourceProfileKey] = this.boundValues as [
        number,
        string,
        string,
        string,
      ];
      const row = [...this.db.sandboxLayerActiveArtifacts.values()].find(
        (candidate) =>
          candidate.id === artifactId &&
          candidate.source_id === sourceId &&
          candidate.resource_profile_key === resourceProfileKey,
      );
      if (!row) return { success: true, meta: { last_row_id: 0, changes: 0 } };
      row.status = "blocked";
      row.blocked_at = blockedAt;
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (this.query.includes("DELETE FROM sandbox_layer_active_artifacts") && this.query.includes("artifact_id = ?")) {
      const [sourceId, resourceProfileKey, artifactId] = this.boundValues as [string, string, string];
      for (const [key, row] of this.db.sandboxLayerActiveArtifacts) {
        if (row.source_id === sourceId && row.resource_profile_key === resourceProfileKey && row.id === artifactId) {
          this.db.sandboxLayerActiveArtifacts.delete(key);
          return { success: true, meta: { last_row_id: 0, changes: 1 } };
        }
      }
      return { success: true, meta: { last_row_id: 0, changes: 0 } };
    }

    if (this.query.includes("INSERT INTO session_index")) {
      if (this.db.failSessionIndexInsert) {
        throw new Error("projection failed");
      }
      const sessionId = this.boundValues[0] as string;
      const ownerUserId = this.boundValues[1] as string;
      const businessId = this.boundValues[2] as string | null;
      const status = this.boundValues[3] as string;
      const createdAt = this.boundValues[4] as string;
      const updatedAt = this.boundValues[5] as string;
      const closedAt = this.boundValues[6] as string | null;
      const lastEventId = this.boundValues[7] as string | null;
      const installationId = this.boundValues[14] as number | null;
      const repoOwner = this.boundValues[15] as string | null;
      const repoName = this.boundValues[16] as string | null;
      const existing = this.db.sessionIndex.get(sessionId);
      this.db.sessionIndex.set(sessionId, {
        ...existing,
        session_id: sessionId,
        owner_user_id: ownerUserId,
        business_id: existing?.business_id ?? businessId ?? this.db.users.get(Number(ownerUserId))?.business_id ?? null,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        closed_at: closedAt,
        last_event_id: lastEventId,
        installation_id: installationId ?? existing?.installation_id ?? null,
        repo_owner: repoOwner ?? existing?.repo_owner ?? null,
        repo_name: repoName ?? existing?.repo_name ?? null,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM business_test_credentials")) {
      const [businessId, repoOwner, repoName, ...names] = this.boundValues as [string, string, string, ...string[]];
      const results = names.flatMap((name) => {
        const row = this.db.businessTestCredentials.get(`${businessId}:${repoOwner}:${repoName}:${name}`);
        return row ? [{ name: row.name, encrypted_value: row.encrypted_value, encrypted: row.encrypted } as T] : [];
      });
      return { results };
    }
    if (this.query.trim() === "SELECT integration_id, scope FROM business_integrations WHERE business_id = ?") {
      return { results: [] };
    }
    if (
      this.query.includes("FROM user_integrations") &&
      this.query.includes("integration_id IN (") &&
      this.query.includes("oauth_access_token")
    ) {
      // Batched spawn snapshot read (SPAWN_USER_INTEGRATION_SQL_LIST). Mirror the
      // per-integration rows the fallback path used to resolve one at a time.
      const [userId] = this.boundValues as [number];
      const providers = ["openai", "anthropic", "linear", "jira", "notion"];
      const results = providers.flatMap((integrationId) => {
        const row = this.db.userIntegrations.get(`${userId}:${integrationId}`);
        if (!row) return [];
        return [
          {
            integration_id: integrationId,
            oauth_access_token: row.oauth_access_token ?? null,
            oauth_refresh_token: row.oauth_refresh_token ?? null,
            oauth_expires_at: row.oauth_expires_at ?? null,
            api_key: row.api_key ?? null,
            service_url: row.service_url ?? null,
            encrypted: row.encrypted ?? 0,
            last_validation_status: row.last_validation_status ?? null,
          } as T,
        ];
      });
      return { results };
    }
    if (this.query.includes("FROM business_integration_credentials") && this.query.includes("integration_id IN (")) {
      return { results: [] };
    }
    if (this.query.includes("FROM mcp_servers")) {
      return { results: [] };
    }
    if (this.query.includes("FROM sandbox_base_templates")) {
      const [runtimeBackend, resourceProfileKey, baseTemplateRef, baseVersion] = this.boundValues as [
        string,
        string,
        string,
        string,
      ];
      const results = [...this.db.sandboxBaseTemplates.values()]
        .filter(
          (row) =>
            row.runtime_backend === runtimeBackend &&
            row.resource_profile_key === resourceProfileKey &&
            row.base_template_ref === baseTemplateRef &&
            row.base_version === baseVersion,
        )
        .sort((a, b) => b.created_at - a.created_at) as T[];
      return { results };
    }
    if (this.query.includes("FROM business_integrations")) {
      throw new Error(`Unhandled business_integrations query in test fake: ${this.query}`);
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async executeBatch(): Promise<{ results: unknown[]; meta?: { last_row_id: number; changes?: number } }> {
    const normalized = this.query.trim().toUpperCase();
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      try {
        return await this.all();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Unhandled all query")) {
          const row = await this.first();
          return { results: row ? [row] : [] };
        }
        throw error;
      }
    }
    const result = await this.run();
    return { results: [], meta: result.meta };
  }
}

class FakeD1 {
  readonly sessionIndex = new Map<string, Record<string, unknown>>();
  readonly users = new Map<number, UserRow>();
  readonly userSettings = new Map<number, UserSettingsRow>();
  readonly userIntegrations = new Map<string, UserIntegrationRow>();
  readonly businesses = new Map<string, BusinessRow>();
  readonly envBlobs = new Map<string, EnvBlobRow>();
  readonly businessTestCredentials = new Map<string, BusinessTestCredentialRow>();
  readonly openAIGatewaySessionTokens = new Map<string, OpenAIGatewaySessionTokenRow>();
  readonly sandboxLayerActiveArtifacts = new Map<string, Record<string, unknown>>();
  readonly sandboxLayerSources = new Map<string, Record<string, unknown>>();
  readonly sandboxLayerRepoAssignments = new Map<string, string>();
  readonly sandboxLayerBusinessDefaults = new Map<string, string>();
  readonly sandboxBaseTemplates = new Map<string, SandboxBaseTemplateTestRow>();
  failSessionIndexInsert = false;

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.executeBatch()));
  }
}

class FakeStorage {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined>;
  async get(keys: string[]): Promise<Map<string, unknown>>;
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, unknown>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, unknown>();
      for (const key of keyOrKeys) {
        if (this.map.has(key)) result.set(key, this.map.get(key));
      }
      return result;
    }
    return this.map.get(keyOrKeys) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, value);
      return;
    }
    for (const [key, entryValue] of Object.entries(keyOrEntries)) {
      this.map.set(key, entryValue);
    }
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) {
      for (const key of keyOrKeys) this.map.delete(key);
      return true;
    }
    return this.map.delete(keyOrKeys);
  }

  async setAlarm(_scheduledTime: number): Promise<void> {}
  async getAlarm(): Promise<number | null> {
    return null;
  }
  async deleteAlarm(): Promise<void> {}

  sql = (() => {
    const db = new Database(":memory:");
    return {
      exec(query: string, ...params: unknown[]) {
        const trimmed = query.trimStart().toUpperCase();
        const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
        if (params.length === 0) {
          if (isSelect) {
            const rows = db.prepare(query).all();
            return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
          }
          db.exec(query);
          return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
        }
        const stmt = db.prepare(query);
        if (isSelect) {
          const rows = stmt.all(...(params as unknown[]));
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        }
        stmt.run(...(params as unknown[]));
        return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
      },
      get databaseSize() {
        return 0;
      },
    };
  })();
}

class FakeDurableState {
  readonly storage = new FakeStorage();
  readonly id = { toString: () => "fake-do-id" };
  blockConcurrencyWhile = async (fn: () => Promise<unknown>) => {
    await fn();
  };
  waitUntil(_promise: Promise<unknown>): void {}
}

function createSession(sessionId: string) {
  return {
    sessionId,
    ownerUserId: "1",
    status: "active",
    createdAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
    closedAt: null,
    lastEventId: null,
    title: null,
  };
}

function createDb(): FakeD1 {
  const db = new FakeD1();
  db.users.set(1, {
    id: 1,
    github_id: 1001,
    business_id: "biz-1",
    login: "user-1",
    name: "Test User",
    email: "user-1@example.com",
  });
  db.userIntegrations.set("1:openai", {
    user_id: 1,
    integration_id: "openai",
    api_key: "test-openai-key",
    last_validated_at: Date.now(),
    last_validation_status: "validated",
    last_validation_reason_code: null,
  });
  db.userIntegrations.set("1:github", {
    user_id: 1,
    integration_id: "github",
    oauth_access_token: "user-github-token",
  });
  return db;
}

function createDbWithoutProviderKey(): FakeD1 {
  const db = createDb();
  db.userIntegrations.delete("1:openai");
  return db;
}

function seedActiveSandboxLayer(
  db: FakeD1,
  input: {
    businessId?: string;
    repoOwner?: string;
    repoName?: string;
    resourceProfileKey?: string;
    providerArtifactRef?: string;
    sourceStatus?: "active" | "blocked";
    artifactStatus?: "active" | "blocked" | "candidate" | "superseded";
  } = {},
) {
  const businessId = input.businessId ?? "biz-1";
  const repoOwner = input.repoOwner ?? "acme";
  const repoName = input.repoName ?? "repo";
  const manifestPath = ".cycloid/sandbox.yaml";
  const sourceId = `source-${repoOwner}-${repoName}`;
  const buildId = `build-${repoOwner}-${repoName}`;
  const artifactId = `artifact-${repoOwner}-${repoName}`;
  const sourceRow = {
    id: sourceId,
    business_id: businessId,
    repo_owner: repoOwner,
    repo_name: repoName,
    manifest_path: manifestPath,
    status: input.sourceStatus ?? "active",
    assignment_updated_at: Date.now(),
  };
  db.sandboxLayerSources.set(sourceId, sourceRow);
  db.sandboxLayerActiveArtifacts.set(`${businessId}:${repoOwner}:${repoName}:${manifestPath}`, {
    ...sourceRow,
    id: artifactId,
    artifact_id: artifactId,
    source_id: sourceId,
    build_id: buildId,
    active_build_id: buildId,
    commit_sha: "a".repeat(40),
    source_content_hash: "layer-source-hash",
    base_template_ref: "cycloid-sandbox-test",
    base_version: "sandbox-v1",
    provider: "e2b",
    provider_artifact_ref: input.providerArtifactRef ?? "layer-template-active",
    runtime_backend: "e2b_cloud",
    resource_profile_key: input.resourceProfileKey ?? "default",
    status: input.artifactStatus ?? "active",
    source_status: input.sourceStatus ?? "active",
    active_updated_at: Date.now(),
    created_at: Date.now(),
    blocked_at: null,
  });
}

function seedSandboxBaseTemplate(
  db: FakeD1,
  input: {
    resourceProfileKey?: string;
    baseTemplateRef?: string;
    baseVersion?: string;
    capabilities?: string[] | null;
    isCurrent?: boolean;
    createdAt?: number;
  } = {},
) {
  const row: SandboxBaseTemplateTestRow = {
    provider: "e2b",
    runtime_backend: "e2b_cloud",
    resource_profile_key: input.resourceProfileKey ?? "default",
    base_template_ref: input.baseTemplateRef ?? "cycloid-sandbox-test",
    base_version: input.baseVersion ?? "sandbox-v1",
    is_current: input.isCurrent ? 1 : 0,
    capabilities: input.capabilities === null ? null : JSON.stringify(input.capabilities ?? []),
    created_at: input.createdAt ?? Date.now(),
  };
  db.sandboxBaseTemplates.set(
    `${row.runtime_backend}:${row.resource_profile_key}:${row.base_template_ref}:${row.base_version}:${row.created_at}`,
    row,
  );
}

function createEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    WORKER_ENV: "test",
    E2B_API_KEY: "test-e2b-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    E2B_SANDBOX_TIMEOUT_MS: "3600000",
    E2B_RUNTIME_LIVE_LEASE_MS: "900000",
    SANDBOX_IMAGE_VERSION: "sandbox-v1",
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "test-private-key",
    CONTROL_PLANE_URL: "https://app.trycycloid.com",
    DB: createDb(),
    ...overrides,
  };
}

function createDO(workerModule: WorkerModule, envOverrides: Record<string, unknown> = {}) {
  const state = new FakeDurableState();
  const doInstance = new workerModule.SessionDO(state, createEnv(envOverrides));
  return { doInstance, state };
}

async function spawnBasicSandboxForBusiness(
  workerModule: WorkerModule,
  input: { businessId: string; workerEnv?: string; sessionId?: string; envOverrides?: Record<string, unknown> },
): Promise<{ request: { envs?: Record<string, string> }; state: FakeDurableState; db: FakeD1 }> {
  const db = createDb();
  const user = db.users.get(1);
  if (user) db.users.set(1, { ...user, business_id: input.businessId });
  const { doInstance, state } = createDO(workerModule, {
    DB: db,
    WORKER_ENV: input.workerEnv ?? "test",
    ...(input.envOverrides ?? {}),
  });
  const sessionId = input.sessionId ?? `sess-memory-env-${input.businessId}`;
  const now = Date.now();
  state.storage.sql.exec(
    `INSERT INTO session (
      session_id, owner_user_id, business_id, status, created_at, updated_at,
      repo_owner, repo_name, installation_id, base_branch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    "1",
    input.businessId,
    "active",
    now,
    now,
    "acme",
    "repo",
    1,
    "main",
  );
  seedSandboxState(state.storage.sql as unknown as SqlStorage, sessionId, { status: "spawning" });

  await (
    doInstance as unknown as {
      spawnSandbox(sessionId: string): Promise<void>;
    }
  ).spawnSandbox(sessionId);

  expect(mocks.createSandbox).toHaveBeenCalledOnce();
  return {
    request: mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> },
    state,
    db,
  };
}

describe("SessionDO repo visibility", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  }, 30_000);

  beforeEach(() => {
    mocks.integrationRuntimeOverride = null;
    mocks.createSandbox.mockReset();
    mocks.createSandbox.mockImplementation(async (request: { sandboxId?: string; template?: string }) => ({
      runtimeProvider: "e2b",
      runtimeSandboxId: request.sandboxId ?? "sbx-test",
      runtimeTemplateId: request.template ?? "cycloid-sandbox-test",
      status: "running",
      createdAt: Date.now(),
    }));
    mocks.freestyleCreateSandbox.mockReset();
    mocks.freestyleCreateSandbox.mockImplementation(
      async (
        request: { sandboxId?: string; freestyleSnapshotId?: string },
        config: { defaultSnapshotId?: string },
      ) => ({
        runtimeProvider: "freestyle",
        runtimeSandboxId: request.sandboxId ?? "vm-test",
        runtimeTemplateId: request.freestyleSnapshotId ?? config.defaultSnapshotId ?? "snap-test",
        status: "running",
        createdAt: Date.now(),
        createDurationMs: 5,
      }),
    );
    mocks.startCommand.mockReset();
    mocks.startCommand.mockImplementation(async () => ({ pid: 123, startedAt: Date.now() }));
    mocks.terminateSandbox.mockReset();
    mocks.terminateSandbox.mockImplementation(async () => ({ status: "killed" }));
    mocks.refreshSandbox.mockReset();
    mocks.refreshSandbox.mockImplementation(async () => ({
      status: "refreshed",
      refreshedUntil: Date.now() + 3_600_000,
    }));
    mocks.resolveAppRuntimeProfile.mockReset();
    mocks.resolveAppRuntimeProfile.mockResolvedValue({
      dockerEnabled: false,
      previewContract: null,
      source: "none",
      diagnostics: [],
    });
    mocks.isRepoPrivate.mockReset();
    mocks.isRepoPrivate.mockResolvedValue(true);
  });

  it("does not forward the Cycloid platform provider key to the sandbox", async () => {
    const { doInstance, state } = createDO(workerModule, {
      ARCANIST_OPENAI_API_KEY: "platform-openai-key",
      CODEX_AUTH_JSON_BASE64: "platform-auth-blob",
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch, agent_session_id, agent_session_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-platform-keys",
      "1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
      "codex-session-existing",
      "default",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-platform-keys",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-platform-keys");

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    expect(mocks.startCommand).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    // The sandbox receives only the repo-scoped installation token; the user OAuth
    // token is never shipped (PRs are opened server-side as the user).
    expect(request.envs).toMatchObject({
      GITHUB_CLONE_TOKEN: "ghs_install_token",
      GH_TOKEN: "ghs_install_token",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "user-1@example.com",
      OWNER_USER_ID: "1",
      REPO_PATH: "/workspace/repo",
      ARCANIST_RUNTIME_PROVIDER: "e2b",
      ARCANIST_SWAP_MAX_GB: "2",
      ARCANIST_DD_LOGS_BROKER_READY: "0",
    });
    expect(request.envs?.GITHUB_USER_TOKEN).toBeUndefined();
    expect(request.envs?.ARCANIST_OPENAI_API_KEY).toBeUndefined();
    expect(request.envs?.ARCANIST_BASETEN_API_KEY).toBeUndefined();
    expect(request.envs?.CODEX_AUTH_JSON_BASE64).toBeUndefined();
    // The two backend axes are independent: ARCANIST_RUNTIME_BACKEND is the E2B
    // sandbox provider, ARCANIST_AGENT_RUNTIME_BACKEND is the coding-agent runtime.
    expect(request.envs?.ARCANIST_AGENT_RUNTIME_BACKEND).toBe("codex");
    expect(request.envs?.AGENT_RUNTIME_BACKEND).toBe("codex");
    expect(request.envs?.ARCANIST_RUNTIME_BACKEND).not.toBe("codex");
    expect(request.envs?.ARCANIST_RUNTIME_BACKEND).not.toBe("claude_code");
    expect(JSON.parse(request.envs?.SESSION_CONFIG ?? "{}")).toMatchObject({
      agentSessionId: "codex-session-existing",
      agentSessionAgent: "default",
      agentRuntimeBackend: "codex",
    });
    const startRequest = mocks.startCommand.mock.calls[0][0] as {
      command?: string;
      cwd?: string;
      envs?: Record<string, string>;
    };
    expect(startRequest.command).toBe("bash /app/start-bridge.sh");
    expect(startRequest.cwd).toBe("/workspace");
    expect(startRequest.envs).toBe(request.envs);
    expect(request.envs?.OPENAI_API_KEY).toMatch(/^arc-gw-[0-9a-f]{64}$/);
    expect(request.envs).toMatchObject({
      ARCANIST_OPENAI_GATEWAY_ENABLED: "1",
      ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE: "user_byok",
    });

    const sandboxRows = state.storage.sql
      .exec(
        "SELECT runtime_provider, runtime_state, runtime_sandbox_id, runtime_state_expires_at, runtime_live_lease_expires_at FROM sandbox_state WHERE session_id = ?",
        "sess-platform-keys",
      )
      .toArray() as Array<Record<string, unknown>>;
    expect(sandboxRows[0]).toMatchObject({
      runtime_provider: "e2b",
      runtime_state: "running",
      runtime_sandbox_id: expect.any(String),
      runtime_state_expires_at: null,
      runtime_live_lease_expires_at: expect.any(Number),
    });
  });

  it("advertises DD log broker readiness without injecting the platform key", async () => {
    const { request } = await spawnBasicSandboxForBusiness(workerModule, {
      businessId: "biz-customer",
      sessionId: "sess-dd-broker-ready",
      envOverrides: { DD_API_KEY: "worker-held-datadog-key" },
    });

    expect(request.envs?.ARCANIST_DD_LOGS_BROKER_READY).toBe("1");
    expect(request.envs?.DD_API_KEY).toBeUndefined();
  });

  it("exposes memory tools to production customer businesses", async () => {
    const { request } = await spawnBasicSandboxForBusiness(workerModule, {
      businessId: "biz-customer",
      workerEnv: "production",
      sessionId: "sess-memory-env-customer",
    });

    expect(request.envs).toMatchObject({
      BUSINESS_ID: "biz-customer",
      ARCANIST_MEMORY_TOOLS_ENABLED: "1",
    });
  });

  it("exposes memory tools to the production Cycloid business", async () => {
    const { request } = await spawnBasicSandboxForBusiness(workerModule, {
      businessId: SEEDED_BUSINESS_IDS.cycloid,
      workerEnv: "production",
      sessionId: "sess-memory-env-cycloid",
    });

    expect(request.envs).toMatchObject({
      BUSINESS_ID: SEEDED_BUSINESS_IDS.cycloid,
      ARCANIST_MEMORY_TOOLS_ENABLED: "1",
    });
  });

  it("exposes memory tools to the QA Cycloid business in production", async () => {
    const { request } = await spawnBasicSandboxForBusiness(workerModule, {
      businessId: SEEDED_BUSINESS_IDS.cycloidQa,
      workerEnv: "production",
      sessionId: "sess-memory-env-cycloid-qa",
    });

    expect(request.envs).toMatchObject({
      BUSINESS_ID: SEEDED_BUSINESS_IDS.cycloidQa,
      ARCANIST_MEMORY_TOOLS_ENABLED: "1",
    });
  });

  it("fails closed for a claude_code session without a BYOK Anthropic key (platform key alone no longer suffices)", async () => {
    const seedClaudeSession = (state: { storage: { sql: { exec: (q: string, ...a: unknown[]) => unknown } } }) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO session (
          session_id, owner_user_id, status, created_at, updated_at,
          repo_owner, repo_name, installation_id, base_branch, agent_runtime_backend
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-claude-spawn",
        "1",
        "active",
        now,
        now,
        "acme",
        "repo",
        1,
        "main",
        "claude_code",
      );
      state.storage.sql.exec(
        "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
        "sess-claude-spawn",
        "spawning",
      );
    };

    // A configured platform key (ARCANIST_ANTHROPIC_API_KEY) is NOT a prod fallback:
    // claude_code requires a business/user BYOK Anthropic key, so with only the
    // platform key and no BYOK credential the control plane fails closed before spawn.
    {
      const { doInstance, state } = createDO(workerModule, { ARCANIST_ANTHROPIC_API_KEY: "sk-ant-platform" });
      seedClaudeSession(state);
      await expect(
        (doInstance as unknown as { spawnSandbox(id: string): Promise<void> }).spawnSandbox("sess-claude-spawn"),
      ).rejects.toThrow(/sandbox_auth_failure|Anthropic/);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    }

    mocks.createSandbox.mockClear();

    // Without any Anthropic credential at all, the control plane likewise fails closed.
    {
      const { doInstance, state } = createDO(workerModule, {});
      seedClaudeSession(state);
      await expect(
        (doInstance as unknown as { spawnSandbox(id: string): Promise<void> }).spawnSandbox("sess-claude-spawn"),
      ).rejects.toThrow(/sandbox_auth_failure|Anthropic/);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    }
  });

  it("honors an already-assembled Anthropic key for claude_code and never clobbers it with the platform key", async () => {
    const seedClaudeSession = (state: { storage: { sql: { exec: (q: string, ...a: unknown[]) => unknown } } }) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO session (
          session_id, owner_user_id, status, created_at, updated_at,
          repo_owner, repo_name, installation_id, base_branch, agent_runtime_backend
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-claude-customer",
        "1",
        "active",
        now,
        now,
        "acme",
        "repo",
        1,
        "main",
        "claude_code",
      );
      state.storage.sql.exec(
        "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
        "sess-claude-customer",
        "spawning",
      );
    };

    // A customer-supplied ANTHROPIC_API_KEY assembled into the sandbox env (here via
    // the integration runtime) must win over the platform key, not be overwritten.
    mocks.integrationRuntimeOverride = {
      availableIntegrations: [],
      businessId: null,
      scopes: null,
      envVars: { ANTHROPIC_API_KEY: "sk-ant-customer" },
      diagnostics: {},
      lifecycleEvents: [],
    };
    {
      const { doInstance, state } = createDO(workerModule, { ARCANIST_ANTHROPIC_API_KEY: "sk-ant-platform" });
      seedClaudeSession(state);
      await (doInstance as unknown as { spawnSandbox(id: string): Promise<void> }).spawnSandbox("sess-claude-customer");
      const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
      expect(request.envs?.ARCANIST_AGENT_RUNTIME_BACKEND).toBe("claude_code");
      expect(request.envs?.AGENT_RUNTIME_BACKEND).toBe("claude_code");
      expect(request.envs?.ANTHROPIC_API_KEY).toBe("sk-ant-customer");
      expect("ARCANIST_ANTHROPIC_API_KEY" in (request.envs ?? {})).toBe(false);
    }

    mocks.createSandbox.mockClear();

    // With only the assembled customer key and no platform key, the spawn must not
    // fail closed — the key is already present in the sandbox env.
    {
      const { doInstance, state } = createDO(workerModule, {});
      seedClaudeSession(state);
      await (doInstance as unknown as { spawnSandbox(id: string): Promise<void> }).spawnSandbox("sess-claude-customer");
      const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
      expect(request.envs?.ANTHROPIC_API_KEY).toBe("sk-ant-customer");
    }
  });

  it("uses the resolved repo sandbox spec for non-default cold E2B spawns", async () => {
    const { doInstance, state } = createDO(workerModule, {
      E2B_SANDBOX_TIMEOUT_MS: "4200000",
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-repo-spec",
      "1",
      "active",
      now,
      now,
      "trycycloid",
      "cycloid",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-repo-spec",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-repo-spec");

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as {
      template?: string;
      timeoutMs?: number;
      envs?: Record<string, string>;
      metadata?: Record<string, string>;
      resources?: { cpuCount: number; memoryMB: number; diskGB?: number };
    };
    expect(request.template).toBe("cycloid-sandbox-test-mem8192-cpu4");
    expect(request.timeoutMs).toBe(4_200_000);
    expect(request.envs?.E2B_SANDBOX_TEMPLATE).toBe("cycloid-sandbox-test-mem8192-cpu4");
    expect(request.metadata).toMatchObject({
      repo_sandbox_spec_source: "repo",
      repo_sandbox_spec_key: "trycycloid/cycloid",
      repo_sandbox_cpu_count: "4",
      repo_sandbox_memory_mb: "8192",
      repo_sandbox_timeout_ms: "4200000",
      repo_sandbox_template: "cycloid-sandbox-test-mem8192-cpu4",
    });
    // FREESTYLE-BIGSPEC: an explicitly-specced repo now carries typed VM sizing so the
    // Freestyle create call can size the VM (memSizeGb/vcpuCount). E2B ignores it. No disk
    // dimension is configured for cycloid, so diskGB is absent.
    expect(request.resources).toEqual({ cpuCount: 4, memoryMB: 8192 });
  });

  it("uses an active sandbox layer artifact as the E2B template and records provenance after attach", async () => {
    const db = createDb();
    seedActiveSandboxLayer(db, { providerArtifactRef: "layer-template-active" });
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-layer-active",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-layer-active",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-layer-active");

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as {
      template?: string;
      envs?: Record<string, string>;
      metadata?: Record<string, string>;
    };
    expect(request.template).toBe("layer-template-active");
    expect(request.envs?.E2B_SANDBOX_TEMPLATE).toBe("layer-template-active");
    expect(request.metadata).toMatchObject({
      sandbox_layer_selection_decision: "selected",
      sandbox_layer_artifact_id: "artifact-acme-repo",
      sandbox_layer_source_id: "source-acme-repo",
      sandbox_layer_build_id: "build-acme-repo",
      sandbox_layer_source_hash: "layer-source-hash",
    });
    const runtimeProvenance = await state.storage.get<Record<string, unknown>>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({
      sandboxLayerSelection: { decision: "selected" },
      sandboxLayer: {
        sourceId: "source-acme-repo",
        buildId: "build-acme-repo",
        providerArtifactRef: "layer-template-active",
      },
    });
  });

  it("keeps public repo snapshots lower priority than active sandbox layer artifacts", async () => {
    const db = createDb();
    seedActiveSandboxLayer(db, { repoOwner: "acme", repoName: "widget", providerArtifactRef: "layer-template-widget" });
    const { doInstance, state } = createDO(workerModule, {
      DB: db,
      E2B_REPO_SNAPSHOT_MAP_JSON: JSON.stringify({
        "acme/widget@main": "snap-acme-widget-main",
      }),
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, repo_private, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-layer-over-snapshot",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "widget",
      0,
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-layer-over-snapshot",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-layer-over-snapshot");

    const request = mocks.createSandbox.mock.calls[0][0] as { template?: string; envs?: Record<string, string> };
    expect(request.template).toBe("layer-template-widget");
    expect(request.envs?.E2B_SANDBOX_TEMPLATE).toBe("layer-template-widget");
  });

  it("uses a repo sandbox layer assignment when the target repo has no local layer", async () => {
    const db = createDb();
    seedActiveSandboxLayer(db, {
      repoOwner: "acme",
      repoName: "sandbox-templates",
      providerArtifactRef: "layer-template-assigned",
    });
    db.sandboxLayerRepoAssignments.set("biz-1:acme:repo", "source-acme-sandbox-templates");
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-layer-assignment",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-layer-assignment",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-layer-assignment");

    const request = mocks.createSandbox.mock.calls[0][0] as {
      template?: string;
      envs?: Record<string, string>;
      metadata?: Record<string, string>;
    };
    expect(request.template).toBe("layer-template-assigned");
    expect(request.envs?.E2B_SANDBOX_TEMPLATE).toBe("layer-template-assigned");
    expect(request.metadata).toMatchObject({
      sandbox_layer_selection_decision: "selected",
      sandbox_layer_selection_tier: "repo_assignment",
      sandbox_layer_resource_profile_key: "default",
      sandbox_layer_source_id: "source-acme-sandbox-templates",
    });
    const runtimeProvenance = await state.storage.get<Record<string, unknown>>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({
      sandboxLayerSelection: { decision: "selected", tier: "repo_assignment", resourceProfileKey: "default" },
      sandboxLayer: {
        sourceId: "source-acme-sandbox-templates",
        providerArtifactRef: "layer-template-assigned",
      },
    });
  });

  it("blocks a missing active sandbox layer artifact and falls back once to the non-layer template", async () => {
    const { E2BSandboxRuntimeError } = await import("../../apps/control-plane-worker/src/sandbox/e2b-client");
    const db = createDb();
    seedActiveSandboxLayer(db, { providerArtifactRef: "missing-layer-template" });
    let createCalls = 0;
    mocks.createSandbox.mockImplementation(async (request: { sandboxId?: string; template?: string }) => {
      createCalls += 1;
      if (createCalls === 1) {
        throw new E2BSandboxRuntimeError("template missing", { code: "missing_template", requestSent: true });
      }
      return {
        runtimeProvider: "e2b",
        runtimeSandboxId: request.sandboxId ?? "sbx-test",
        runtimeTemplateId: request.template ?? "cycloid-sandbox-test",
        status: "running",
        createdAt: Date.now(),
      };
    });
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-layer-missing-fallback",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-layer-missing-fallback",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-layer-missing-fallback");

    expect(mocks.createSandbox).toHaveBeenCalledTimes(2);
    expect((mocks.createSandbox.mock.calls[0][0] as { template?: string }).template).toBe("missing-layer-template");
    const fallbackRequest = mocks.createSandbox.mock.calls[1][0] as {
      template?: string;
      envs?: Record<string, string>;
      metadata?: Record<string, string>;
      resources?: { cpuCount: number; memoryMB: number; diskGB?: number };
    };
    expect(fallbackRequest.template).toBe("cycloid-sandbox-test-mem4096-cpu2");
    expect(fallbackRequest.envs?.E2B_SANDBOX_TEMPLATE).toBe("cycloid-sandbox-test-mem4096-cpu2");
    // acme/repo is unspecced (default tier): no resources are sent, so a Freestyle create
    // for it keeps the base snapshot's baked sizing — default behavior is unchanged.
    expect(fallbackRequest.resources).toBeUndefined();
    expect(fallbackRequest.metadata).toMatchObject({
      sandbox_layer_selection_decision: "provider_artifact_missing_fallback",
      sandbox_layer_artifact_id: "",
      repo_sandbox_template: "cycloid-sandbox-test-mem4096-cpu2",
    });
    expect(db.sandboxLayerActiveArtifacts.has("biz-1:acme:repo:.cycloid/sandbox.yaml")).toBe(false);
    const runtimeProvenance = await state.storage.get<Record<string, unknown>>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({
      sandboxLayerSelection: {
        decision: "provider_artifact_missing_fallback",
        fallbackRuntimeTemplateId: "cycloid-sandbox-test-mem4096-cpu2",
        fallbackReason: "sandbox_layer_provider_artifact_missing",
      },
      sandboxLayer: null,
    });
  });

  it("fails closed before missing-layer fallback when the fallback template cannot prove opencode support", async () => {
    const { E2BSandboxRuntimeError } = await import("../../apps/control-plane-worker/src/sandbox/e2b-client");
    const { SandboxTemplateCapabilityError } =
      await import("../../apps/control-plane-worker/src/sandbox/base-template-service");
    const db = createDb();
    seedActiveSandboxLayer(db, {
      businessId: SEEDED_BUSINESS_IDS.cycloidQa,
      providerArtifactRef: "missing-layer-template",
    });
    seedSandboxBaseTemplate(db, {
      baseTemplateRef: "cycloid-sandbox-test",
      baseVersion: "sandbox-v1",
      capabilities: ["opencode"],
    });
    mocks.createSandbox.mockRejectedValueOnce(
      new E2BSandboxRuntimeError("template missing", { code: "missing_template", requestSent: true }),
    );
    mocks.integrationRuntimeOverride = {
      availableIntegrations: [],
      businessId: "biz-1",
      diagnostics: {},
      envVars: { BASETEN_API_KEY: "test-baseten-key" },
      lifecycleEvents: [],
      scopes: null,
    };
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch, agent_runtime_backend, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-opencode-layer-missing-fallback",
      "1",
      SEEDED_BUSINESS_IDS.cycloidQa,
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
      "opencode",
      "kimi-k2.7-code",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-opencode-layer-missing-fallback",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-opencode-layer-missing-fallback"),
    ).rejects.toBeInstanceOf(SandboxTemplateCapabilityError);

    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    expect((mocks.createSandbox.mock.calls[0][0] as { template?: string }).template).toBe("missing-layer-template");
    expect(db.sandboxLayerActiveArtifacts.has(`${SEEDED_BUSINESS_IDS.cycloidQa}:acme:repo:.cycloid/sandbox.yaml`)).toBe(
      false,
    );
  });

  it("fails closed before spawn for persisted non-internal opencode sessions", async () => {
    const { OpencodeAccessDeniedError } =
      await import("../../apps/control-plane-worker/src/services/opencode-access-gate");
    const db = createDb();
    seedSandboxBaseTemplate(db, {
      baseTemplateRef: "cycloid-sandbox-test",
      baseVersion: "sandbox-v1",
      capabilities: ["codex", "claude_code", "opencode"],
    });
    mocks.integrationRuntimeOverride = {
      availableIntegrations: [],
      businessId: "biz-1",
      diagnostics: {},
      envVars: { BASETEN_API_KEY: "test-baseten-key" },
      lifecycleEvents: [],
      scopes: null,
    };
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch, agent_runtime_backend, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-opencode-non-internal",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
      "opencode",
      "kimi-k2.7-code",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-opencode-non-internal",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-opencode-non-internal"),
    ).rejects.toBeInstanceOf(OpencodeAccessDeniedError);

    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("does not fall back or block the active artifact for provider auth errors", async () => {
    const { E2BSandboxRuntimeError } = await import("../../apps/control-plane-worker/src/sandbox/e2b-client");
    const db = createDb();
    seedActiveSandboxLayer(db, { providerArtifactRef: "layer-template-active" });
    mocks.createSandbox.mockRejectedValueOnce(
      new E2BSandboxRuntimeError("auth failed", { code: "auth", requestSent: true }),
    );
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, business_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-layer-auth-no-fallback",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-layer-auth-no-fallback",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-layer-auth-no-fallback"),
    ).rejects.toThrow("auth failed");

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    expect(db.sandboxLayerActiveArtifacts.has("biz-1:acme:repo:.cycloid/sandbox.yaml")).toBe(true);
  });

  // Removed: self-hosted E2B template/routing, layer-ignore, and warm-pool-exclusion
  // tests (self-hosted backend deleted; only e2b_cloud remains).

  it("passes an outbound E2B network policy to the cold sandbox create", async () => {
    const { doInstance, state } = createDO(workerModule, {
      E2B_SANDBOX_NETWORK_ALLOW_OUT: "1.1.1.1",
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-policy",
      "1",
      "active",
      now,
      now,
      "trycycloid",
      "cycloid",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-policy",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-policy");

    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: expect.any(String),
        template: "cycloid-sandbox-test-mem8192-cpu4",
        network: {
          allowPublicTraffic: false,
          allowOut: ["1.1.1.1"],
        },
      }),
    );
    const runtimeProvenance = await state.storage.get<Record<string, unknown>>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({
      bootMode: "fresh_clone",
      sandboxImageVersion: "sandbox-v1",
      runtime: expect.objectContaining({
        provider: "e2b",
      }),
    });
  });

  it("passes sandbox domain egress allowlist when enforcement is enabled", async () => {
    const { doInstance, state } = createDO(workerModule, {
      E2B_SANDBOX_EGRESS_ALLOWLIST: "packages.acme.test",
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch, business_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-domain-policy",
      "1",
      "active",
      now,
      now,
      "trycycloid",
      "cycloid",
      1,
      "main",
      "biz-test",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-domain-policy",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-domain-policy");

    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    expect(request.envs).toMatchObject({
      ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "1",
    });
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("api.github.com");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("app.trycycloid.com");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("e2b.dev");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("api.e2b.dev");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("packages.acme.test");
  });

  it("passes unrestricted egress env and logs when spawning an internal Cycloid business session", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doInstance, state } = createDO(workerModule, {
        E2B_SANDBOX_EGRESS_ALLOWLIST: "packages.acme.test",
      });
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO session (
          session_id, owner_user_id, status, created_at, updated_at,
          repo_owner, repo_name, installation_id, base_branch, business_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-internal-egress",
        "1",
        "active",
        now,
        now,
        "trycycloid",
        "cycloid",
        1,
        "main",
        SEEDED_BUSINESS_IDS.cycloid,
      );
      state.storage.sql.exec(
        "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
        "sess-internal-egress",
        "spawning",
      );

      await (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-internal-egress");

      const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
      expect(request.envs).toMatchObject({
        ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "0",
      });
      expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toBeUndefined();
      expect(logSpy.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)).toContainEqual(
        expect.objectContaining({
          event: "sandbox_egress_unrestricted_internal_business",
          sessionId: "sess-internal-egress",
          businessId: SEEDED_BUSINESS_IDS.cycloid,
        }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("warns when internal unrestricted egress conflicts with E2B outbound policy", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { doInstance, state } = createDO(workerModule, {
        E2B_SANDBOX_ALLOW_INTERNET_ACCESS: "false",
      });
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO session (
          session_id, owner_user_id, status, created_at, updated_at,
          repo_owner, repo_name, installation_id, base_branch, business_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-internal-egress-conflict",
        "1",
        "active",
        now,
        now,
        "trycycloid",
        "cycloid",
        1,
        "main",
        SEEDED_BUSINESS_IDS.cycloid,
      );
      state.storage.sql.exec(
        "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
        "sess-internal-egress-conflict",
        "spawning",
      );

      await (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-internal-egress-conflict");

      expect(mocks.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          allowInternetAccess: false,
        }),
      );
      expect(warnSpy.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)).toContainEqual(
        expect.objectContaining({
          event: "sandbox_egress_unrestricted_internal_business_conflict",
          sessionId: "sess-internal-egress-conflict",
          businessId: SEEDED_BUSINESS_IDS.cycloid,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("passes D1-backed business egress allowlist to sandbox spawn before legacy env overrides", async () => {
    const db = createDb();
    db.businesses.set("biz-test", {
      id: "biz-test",
      egress_allowlist_json: JSON.stringify({ domains: ["d1.acme.test"] }),
    });
    const { doInstance, state } = createDO(workerModule, {
      DB: db,
      E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON: JSON.stringify({
        "biz-test": ["legacy.acme.test"],
      }),
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch, business_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-d1-domain-policy",
      "1",
      "active",
      now,
      now,
      "trycycloid",
      "cycloid",
      1,
      "main",
      "biz-test",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-d1-domain-policy",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-d1-domain-policy");

    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("api.github.com");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("d1.acme.test");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).not.toContain("legacy.acme.test");
  });

  it("ignores invalid stored business egress policy during sandbox spawn", async () => {
    const db = createDb();
    db.businesses.set("biz-test", {
      id: "biz-test",
      egress_allowlist_json: "{not-json",
    });
    const { doInstance, state } = createDO(workerModule, {
      DB: db,
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch, business_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-invalid-domain-policy",
      "1",
      "active",
      now,
      now,
      "trycycloid",
      "cycloid",
      1,
      "main",
      "biz-test",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-invalid-domain-policy",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-invalid-domain-policy");

    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("api.github.com");
    expect(request.envs?.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).not.toContain("d1.acme.test");
  });

  it("fails closed when E2B runtime config is missing", async () => {
    const { doInstance, state } = createDO(workerModule, { E2B_API_KEY: undefined });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-missing-e2b-config",
      "1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-missing-e2b-config",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-missing-e2b-config"),
    ).rejects.toThrow("E2B_API_KEY is not configured");

    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("uses the local dev E2B template default when the env var is omitted locally", async () => {
    const localControlPlaneUrl = "https://local-template-default.ngrok-free.dev";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      if (url === `${localControlPlaneUrl}/api/health`) {
        return Response.json({ ok: true });
      }
      if (url === `${localControlPlaneUrl}/api/sessions/sess-local-template-default/ws?type=sandbox`) {
        return new Response(null, { status: 426 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof globalThis.fetch;

    try {
      const { doInstance, state } = createDO(workerModule, {
        WORKER_ENV: "local",
        CONTROL_PLANE_URL: localControlPlaneUrl,
        E2B_SANDBOX_TEMPLATE: undefined,
      });
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO session (
          session_id, owner_user_id, status, created_at, updated_at,
          repo_owner, repo_name, repo_private, installation_id, base_branch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sess-local-template-default",
        "1",
        "active",
        now,
        now,
        "acme",
        "repo",
        1,
        1,
        "main",
      );
      state.storage.sql.exec(
        "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
        "sess-local-template-default",
        "spawning",
      );

      await (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-local-template-default");

      expect(mocks.createSandbox).toHaveBeenCalledOnce();
      const request = mocks.createSandbox.mock.calls[0][0] as {
        template?: string;
        envs?: Record<string, string>;
      };
      expect(request.template).toBe("cycloid-sandbox-dev-local-mem4096-cpu2");
      expect(request.envs?.E2B_SANDBOX_TEMPLATE).toBe("cycloid-sandbox-dev-local-mem4096-cpu2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still requires an explicit E2B template outside local dev", async () => {
    const { doInstance, state } = createDO(workerModule, { E2B_SANDBOX_TEMPLATE: undefined });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-missing-e2b-template",
      "1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-missing-e2b-template",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-missing-e2b-template"),
    ).rejects.toThrow("E2B_SANDBOX_TEMPLATE is not configured");

    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("requires a Freestyle snapshot id for freestyle-routed spawns (ARC-1480)", async () => {
    // Mirror of the E2B template guard above: routing enabled + key present but no
    // snapshot id must fail the spawn closed, never cold-boot a bare Debian VM.
    // Routed via org: (the prod flip's mechanism) — "all" is honored only in local
    // env (ARC-1483) and the harness runs with WORKER_ENV=test.
    const { doInstance, state } = createDO(workerModule, {
      FREESTYLE_SANDBOX_BACKEND_OVERRIDE: "org:acme",
      FREESTYLE_API_KEY: "freestyle-test-key",
      FREESTYLE_DEFAULT_SNAPSHOT_ID: undefined,
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-missing-freestyle-snapshot",
      "1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-missing-freestyle-snapshot",
      "spawning",
    );

    // Coded missing_config (not a plain Error): isRetryableSpawnFailure only
    // classifies coded runtime errors, so a plain Error would burn spawn retries
    // on a deterministic misconfiguration. (This file's e2b-client mock stubs the
    // error class without `name`, so assert code + message rather than name.)
    const spawnError = await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    )
      .spawnSandbox("sess-missing-freestyle-snapshot")
      .then(
        () => {
          throw new Error("expected spawn to fail closed");
        },
        (err: unknown) => err as { code?: string; message?: string },
      );
    expect(spawnError.code).toBe("missing_config");
    expect(spawnError.message).toContain("FREESTYLE_DEFAULT_SNAPSHOT_ID is not configured");

    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("fails closed without storing running state when E2B create returns a non-running sandbox", async () => {
    mocks.createSandbox.mockResolvedValueOnce({
      runtimeProvider: "e2b",
      runtimeSandboxId: "sbx-paused",
      runtimeTemplateId: "cycloid-sandbox-test",
      status: "paused",
      createdAt: Date.now(),
    });
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-create-paused",
      "1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-create-paused",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-create-paused"),
    ).rejects.toThrow("E2B sandbox create returned unusable state: paused");

    expect(mocks.terminateSandbox).toHaveBeenCalledWith("sbx-paused");
    const sandboxRows = state.storage.sql
      .exec(
        "SELECT runtime_provider, runtime_state, runtime_sandbox_id FROM sandbox_state WHERE session_id = ?",
        "sess-create-paused",
      )
      .toArray() as Array<Record<string, unknown>>;
    expect(sandboxRows[0]).toMatchObject({
      runtime_provider: null,
      runtime_state: null,
      runtime_sandbox_id: null,
    });
  });

  it("fails closed without storing running state when bridge start fails", async () => {
    mocks.startCommand.mockRejectedValueOnce(new Error("bridge failed"));
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-start-fails",
      "1",
      "active",
      now,
      now,
      "acme",
      "repo",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-start-fails",
      "spawning",
    );

    await expect(
      (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-start-fails"),
    ).rejects.toThrow("bridge failed");

    expect(mocks.terminateSandbox).toHaveBeenCalledWith(expect.any(String));
    const sandboxRows = state.storage.sql
      .exec(
        "SELECT runtime_provider, runtime_state, runtime_sandbox_id FROM sandbox_state WHERE session_id = ?",
        "sess-start-fails",
      )
      .toArray() as Array<Record<string, unknown>>;
    expect(sandboxRows[0]).toMatchObject({
      runtime_provider: null,
      runtime_state: null,
      runtime_sandbox_id: null,
    });
  });

  it("injects the Docker preview contract for a valid Docker App Runtime Profile", async () => {
    const contract = previewContract();
    mocks.resolveAppRuntimeProfile.mockImplementationOnce(async (_token, owner, repo, ref) => {
      expect(owner).toBe("acme");
      expect(repo).toBe("widgets");
      expect(ref).toBe("main");
      return {
        dockerEnabled: true,
        source: "config_docker",
        diagnostics: [],
        previewContract: contract,
      };
    });

    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-docker-preview-profile",
      "1",
      "active",
      now,
      now,
      "acme",
      "widgets",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-docker-preview-profile",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-docker-preview-profile");

    expect(mocks.resolveAppRuntimeProfile).toHaveBeenCalledWith("ghs_install_token", "acme", "widgets", "main");
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as {
      enableDocker?: boolean;
      envs?: Record<string, string>;
    };
    expect(request).not.toHaveProperty("enableDocker");
    expect(request.envs).toMatchObject({
      ARCANIST_PREVIEW_CONTRACT_JSON: JSON.stringify(contract),
    });
    expect(request.envs).not.toHaveProperty("ARCANIST_PREVIEW_SUPPORTED");
    expect(request.envs).not.toHaveProperty("DOCKER_ENABLED");
    for (const key of [
      "ARCANIST_PREVIEW_CWD",
      "ARCANIST_PREVIEW_PORT",
      "ARCANIST_PREVIEW_READY_PATH",
      "ARCANIST_PREVIEW_OPEN_PATH",
      "ARCANIST_PREVIEW_LABEL",
      "ARCANIST_PREVIEW_MODE",
      "ARCANIST_PREVIEW_COMPOSE_FILE",
      "ARCANIST_PREVIEW_CONTAINER_PORT",
      "ARCANIST_PREVIEW_TTL_SECONDS",
      "ARCANIST_PREVIEW_NOTES",
    ]) {
      expect(request.envs).not.toHaveProperty(key);
    }
    const runtimeProvenance = await state.storage.get<{
      dockerEnabled: boolean;
      appRuntimeProfileDiagnostics: Array<{ code: string; severity: string; message: string }>;
    }>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({ dockerEnabled: true });
  });

  it("injects an onboarding preview override contract", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-runtime-onboarding",
      "1",
      "active",
      now,
      now,
      "acme",
      "widgets",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-runtime-onboarding",
      "spawning",
    );
    await state.storage.put("runtime_preview_override", {
      source: "onboarding",
      diagnostics: [],
      previewContract: {
        cwd: "/workspace/repo",
        kind: "web",
        runner: "docker",
        entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
        url: { hostPort: 3000 },
      },
    });

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-runtime-onboarding");

    expect(mocks.resolveAppRuntimeProfile).not.toHaveBeenCalled();
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as {
      enableDocker?: boolean;
      envs?: Record<string, string>;
    };
    expect(request).not.toHaveProperty("enableDocker");
    expect(request.envs).toMatchObject({
      ARCANIST_PREVIEW_CONTRACT_JSON: JSON.stringify({
        cwd: "/workspace/repo",
        kind: "web",
        runner: "docker",
        entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
        url: { hostPort: 3000 },
      }),
    });
    expect(request.envs).not.toHaveProperty("ARCANIST_PREVIEW_SUPPORTED");
    expect(request.envs).not.toHaveProperty("DOCKER_ENABLED");

    const runtimeProvenance = await state.storage.get<{
      dockerEnabled: boolean;
      appRuntimeProfileSource: string;
      appRuntimeProfileDiagnostics: Array<{ code: string; severity: string; message: string }>;
    }>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({
      dockerEnabled: true,
      appRuntimeProfileSource: "onboarding",
    });
    expect(runtimeProvenance?.appRuntimeProfileDiagnostics).toEqual([]);
  });

  it("ignores onboarding preview overrides with a blank cwd", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-runtime-onboarding-blank-cwd",
      "1",
      "active",
      now,
      now,
      "acme",
      "widgets",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-runtime-onboarding-blank-cwd",
      "spawning",
    );
    await state.storage.put("runtime_preview_override", {
      source: "onboarding",
      diagnostics: [],
      previewContract: {
        cwd: "  ",
        kind: "web",
        runner: "docker",
        entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
        url: { hostPort: 3000 },
      },
    });

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-runtime-onboarding-blank-cwd");

    expect(mocks.resolveAppRuntimeProfile).toHaveBeenCalledWith("ghs_install_token", "acme", "widgets", "main");
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as {
      envs?: Record<string, string>;
    };
    expect(request.envs).not.toHaveProperty("ARCANIST_PREVIEW_CONTRACT_JSON");

    const runtimeProvenance = await state.storage.get<{
      dockerEnabled: boolean;
      appRuntimeProfileSource: string;
    }>("runtime_provenance");
    expect(runtimeProvenance).toMatchObject({
      dockerEnabled: false,
      appRuntimeProfileSource: "none",
    });
  });

  it("does not enable Docker solely because the repo has Docker-capable repo images", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at,
        repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-docker-repo-image-no-profile",
      "1",
      "active",
      now,
      now,
      "trycycloid",
      "dummy-docker-app",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-docker-repo-image-no-profile",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-docker-repo-image-no-profile");

    expect(mocks.resolveAppRuntimeProfile).toHaveBeenCalledWith(
      "ghs_install_token",
      "trycycloid",
      "dummy-docker-app",
      "main",
    );
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as {
      enableDocker?: boolean;
      envs?: Record<string, string>;
    };
    expect(request).not.toHaveProperty("enableDocker");
    expect(request.envs).not.toHaveProperty("ARCANIST_PREVIEW_SUPPORTED");
    expect(request.envs).not.toHaveProperty("DOCKER_ENABLED");
    expect(request.envs).not.toHaveProperty("ARCANIST_PREVIEW_CONTRACT_JSON");
  });

  it.each([0, 1])("does not pass repo visibility to the sandbox environment (repo_private=%s)", async (repoPrivate) => {
    const { doInstance, state } = createDO(workerModule);
    const sessionId = `sess-repo-private-${repoPrivate}`;
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, repo_private, installation_id, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      repoPrivate,
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      sessionId,
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox(sessionId);

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    expect(request.envs).not.toHaveProperty("REPO_PRIVATE");
  });

  it.each([
    {
      label: "public repo with a string entry",
      repoPrivate: false,
      repoPrivateColumn: 0,
      snapshotEntry: "snap-acme-widget-main",
      expectedTemplate: "snap-acme-widget-main",
      expectedSnapshotKey: "acme/widget@main",
    },
    {
      label: "private repo with a string entry",
      repoPrivate: true,
      repoPrivateColumn: 1,
      snapshotEntry: "snap-acme-widget-main",
      expectedTemplate: "cycloid-sandbox-test-mem4096-cpu2",
      expectedSnapshotKey: "",
    },
    {
      label: "private repo with allowPrivate omitted",
      repoPrivate: true,
      repoPrivateColumn: 1,
      snapshotEntry: { snapshotId: "snap-acme-widget-main" },
      expectedTemplate: "cycloid-sandbox-test-mem4096-cpu2",
      expectedSnapshotKey: "",
    },
    {
      label: "private repo with explicit allowPrivate",
      repoPrivate: true,
      repoPrivateColumn: 1,
      snapshotEntry: { snapshotId: "snap-acme-widget-main", allowPrivate: true },
      expectedTemplate: "snap-acme-widget-main",
      expectedSnapshotKey: "acme/widget@main",
    },
    {
      label: "unknown-visibility repo with allowPrivate omitted",
      repoPrivateColumn: null,
      failVisibilityLookup: true,
      snapshotEntry: { snapshotId: "snap-acme-widget-main" },
      expectedTemplate: "cycloid-sandbox-test-mem4096-cpu2",
      expectedSnapshotKey: "",
    },
    {
      label: "unknown-visibility repo with explicit allowPrivate",
      repoPrivateColumn: null,
      failVisibilityLookup: true,
      snapshotEntry: { snapshotId: "snap-acme-widget-main", allowPrivate: true },
      expectedTemplate: "snap-acme-widget-main",
      expectedSnapshotKey: "acme/widget@main",
    },
  ])(
    "uses configured E2B repo snapshots for a $label",
    async ({ repoPrivateColumn, failVisibilityLookup, snapshotEntry, expectedTemplate, expectedSnapshotKey }) => {
      if (failVisibilityLookup) {
        mocks.isRepoPrivate.mockRejectedValueOnce(new Error("visibility unavailable"));
      }
      const { doInstance, state } = createDO(workerModule, {
        E2B_REPO_SNAPSHOT_MAP_JSON: JSON.stringify({
          "acme/widget@main": snapshotEntry,
        }),
      });
      const now = Date.now();
      state.storage.sql.exec(
        "INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, repo_private, installation_id, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "sess-repo-snapshot",
        "1",
        "active",
        now,
        now,
        "acme",
        "widget",
        repoPrivateColumn,
        1,
        "main",
      );
      state.storage.sql.exec(
        "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
        "sess-repo-snapshot",
        "spawning",
      );

      await (
        doInstance as unknown as {
          spawnSandbox(sessionId: string): Promise<void>;
        }
      ).spawnSandbox("sess-repo-snapshot");

      expect(mocks.createSandbox).toHaveBeenCalledOnce();
      const request = mocks.createSandbox.mock.calls[0][0] as {
        template?: string;
        envs?: Record<string, string>;
        metadata?: Record<string, string>;
      };
      expect(request.template).toBe(expectedTemplate);
      expect(request.envs?.E2B_SANDBOX_TEMPLATE).toBe(expectedTemplate);
      expect(request.metadata?.e2b_repo_snapshot_key).toBe(expectedSnapshotKey);
    },
  );

  it.each([
    {
      label: "mapped private repo boots the per-repo prebaked snapshot",
      mapJson: JSON.stringify({ "acme/widget": { snapshotId: "snap-repo-prebaked", allowPrivate: true } }),
      expectedFreestyleSnapshotId: "snap-repo-prebaked",
      expectedSnapshotKey: "acme/widget",
    },
    {
      label: "unmapped repo falls back to the base snapshot",
      mapJson: JSON.stringify({ "acme/other": { snapshotId: "snap-other", allowPrivate: true } }),
      expectedFreestyleSnapshotId: undefined,
      expectedSnapshotKey: "",
    },
    {
      label: "private repo without allowPrivate falls back to the base snapshot",
      mapJson: JSON.stringify({ "acme/widget": { snapshotId: "snap-repo-prebaked" } }),
      expectedFreestyleSnapshotId: undefined,
      expectedSnapshotKey: "",
    },
    {
      label: "invalid map JSON is ignored and boots the base snapshot",
      mapJson: "{not json",
      expectedFreestyleSnapshotId: undefined,
      expectedSnapshotKey: "",
    },
  ])("Freestyle repo snapshots: $label", async ({ mapJson, expectedFreestyleSnapshotId, expectedSnapshotKey }) => {
    const { doInstance, state } = createDO(workerModule, {
      // Routed via org: (the prod flip's mechanism) — "all" is honored only in
      // local env (ARC-1483) and the harness runs with WORKER_ENV=test.
      FREESTYLE_SANDBOX_BACKEND_OVERRIDE: "org:acme",
      FREESTYLE_API_KEY: "freestyle-test-key",
      FREESTYLE_DEFAULT_SNAPSHOT_ID: "snap-base",
      FREESTYLE_REPO_SNAPSHOT_MAP_JSON: mapJson,
    });
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, repo_private, installation_id, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "sess-freestyle-repo-snapshot",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-freestyle-repo-snapshot",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-freestyle-repo-snapshot");

    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(mocks.freestyleCreateSandbox).toHaveBeenCalledOnce();
    const [request, config] = mocks.freestyleCreateSandbox.mock.calls[0] as [
      { freestyleSnapshotId?: string; metadata?: Record<string, string> },
      { defaultSnapshotId?: string },
    ];
    expect(request.freestyleSnapshotId).toBe(expectedFreestyleSnapshotId);
    expect(request.metadata?.freestyle_repo_snapshot_key).toBe(expectedSnapshotKey);
    expect(config.defaultSnapshotId).toBe("snap-base");
  });

  it("injects repo-scoped login env credentials for matching business repos", async () => {
    const db = createDb();
    const now = Date.now();
    db.envBlobs.set("login-env-1", {
      id: "login-env-1",
      owner_user_id: 1,
      business_id: "biz-1",
      name: "app_login",
      env_text: [
        "ARCANIST_LOGIN_USERNAME=admin@example.com",
        "ARCANIST_LOGIN_PASSWORD=s3cret-password",
        "ARCANIST_LOGIN_PAGE=/login",
        "ARCANIST_AUTHENTICATED_PAGE=/dashboard",
      ].join("\n"),
      encrypted: 0,
      key_names_json: JSON.stringify([
        "ARCANIST_LOGIN_USERNAME",
        "ARCANIST_LOGIN_PASSWORD",
        "ARCANIST_LOGIN_PAGE",
        "ARCANIST_AUTHENTICATED_PAGE",
      ]),
      is_global: 0,
      created_at: now,
      updated_at: now,
      repo_owner: "acme",
      repo_name: "widget",
    });

    const { doInstance, state } = createDO(workerModule, { DB: db });
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at, repo_owner, repo_name, repo_private, installation_id, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "sess-login-env",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-login-env",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-login-env");

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    expect(request.envs).toMatchObject({
      ARCANIST_LOGIN_USERNAME: "admin@example.com",
      ARCANIST_LOGIN_PASSWORD: "s3cret-password",
      ARCANIST_LOGIN_PAGE: "/login",
      ARCANIST_AUTHENTICATED_PAGE: "/dashboard",
    });
    await expect(state.storage.get("sandbox_credential_env_keys")).resolves.not.toContain(
      "CYCLOID_LOGIN_ENV:login-env-1",
    );
    await expect(state.storage.get("sandbox_credential_fingerprints")).resolves.toContain(
      `CYCLOID_LOGIN_ENV:login-env-1:${now}`,
    );
  });

  it("merges repo runtime env into Docker compose env and marks safe repo vars for the agent", async () => {
    const db = createDb();
    const now = Date.now();
    db.envBlobs.set("runtime-env-1", {
      id: "runtime-env-1",
      owner_user_id: 1,
      business_id: "biz-1",
      name: "app_login",
      env_text: [
        "DATABASE_URL=postgres://stored-from-env",
        "POSTGRES_PASSWORD=stored-password",
        "STRIPE_SECRET_KEY=stored-stripe-secret",
        "OPENAI_API_KEY=stored-openai-key",
        "NGROK_AUTH_TOKEN=stored-ngrok-token",
        "NGROK_DOMAIN=dev.example.ngrok-free.dev",
        "GITHUB_APP_ID=123456",
        "SANDBOX_AUTH_TOKEN=repo-override",
        "NODE_OPTIONS=--require ./pwn.js",
        "CODEX_CLI_PATH=/tmp/repo-codex",
        "CODEX_PATH=/tmp/repo-codex-legacy",
        "LD_PRELOAD=/tmp/preload.so",
        "DYLD_INSERT_LIBRARIES=/tmp/insert.dylib",
        "JAVA_TOOL_OPTIONS=-javaagent:/tmp/agent.jar",
        "RUBYOPT=-r/tmp/hook.rb",
        "PYTHONSTARTUP=/tmp/startup.py",
        "ARCANIST_LOGIN_USERNAME=admin@example.com",
        "ARCANIST_LOGIN_PASSWORD=s3cret-password",
        "ARCANIST_LOGIN_PAGE=/login",
        "ARCANIST_AUTHENTICATED_PAGE=/dashboard",
      ].join("\n"),
      encrypted: 0,
      key_names_json: JSON.stringify([
        "DATABASE_URL",
        "POSTGRES_PASSWORD",
        "STRIPE_SECRET_KEY",
        "OPENAI_API_KEY",
        "NGROK_AUTH_TOKEN",
        "NGROK_DOMAIN",
        "GITHUB_APP_ID",
        "SANDBOX_AUTH_TOKEN",
        "NODE_OPTIONS",
        "CODEX_CLI_PATH",
        "CODEX_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "JAVA_TOOL_OPTIONS",
        "RUBYOPT",
        "PYTHONSTARTUP",
        "ARCANIST_LOGIN_USERNAME",
        "ARCANIST_LOGIN_PASSWORD",
        "ARCANIST_LOGIN_PAGE",
        "ARCANIST_AUTHENTICATED_PAGE",
      ]),
      is_global: 0,
      created_at: now,
      updated_at: now,
      repo_owner: "acme",
      repo_name: "widget",
    });
    db.businessTestCredentials.set("biz-1:acme:widget:openai", {
      business_id: "biz-1",
      repo_owner: "acme",
      repo_name: "widget",
      name: "openai",
      encrypted_value: "explicit-openai-key",
      encrypted: 0,
    });
    mocks.resolveAppRuntimeProfile.mockResolvedValueOnce({
      dockerEnabled: true,
      previewContract: previewContract({
        composeEnv: {
          DATABASE_URL: "postgres://checked-in",
          CHECKED_IN_ONLY: "yes",
        },
        e2e: {
          testCommand: "npm run test:e2e",
          credentials: [
            { name: "database", envVar: "DATABASE_URL" },
            { name: "openai", envVar: "OPENAI_API_KEY" },
          ],
        },
      }),
      source: "config_docker",
      diagnostics: [],
    });

    const { doInstance, state } = createDO(workerModule, { DB: db });
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at, repo_owner, repo_name, repo_private, installation_id, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "sess-runtime-env",
      "1",
      "biz-1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-runtime-env",
      "spawning",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-runtime-env");

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    const request = mocks.createSandbox.mock.calls[0][0] as { envs?: Record<string, string> };
    expect(request.envs?.ARCANIST_LOGIN_USERNAME).toBe("admin@example.com");
    expect(request.envs?.POSTGRES_PASSWORD).toBeUndefined();
    expect(request.envs?.STRIPE_SECRET_KEY).toBeUndefined();
    expect(request.envs?.NGROK_AUTH_TOKEN).toBe("stored-ngrok-token");
    expect(request.envs?.NGROK_DOMAIN).toBe("dev.example.ngrok-free.dev");
    expect(request.envs?.GITHUB_APP_ID).toBeUndefined();
    expect(request.envs?.SANDBOX_AUTH_TOKEN).not.toBe("repo-override");
    expect(request.envs?.NODE_OPTIONS).toBeUndefined();
    expect(request.envs?.CODEX_CLI_PATH).toBeUndefined();
    expect(request.envs?.CODEX_PATH).toBeUndefined();
    expect(request.envs?.LD_PRELOAD).toBeUndefined();
    expect(request.envs?.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(request.envs?.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(request.envs?.RUBYOPT).toBeUndefined();
    expect(request.envs?.PYTHONSTARTUP).toBeUndefined();
    expect(request.envs?.DATABASE_URL).toBe("postgres://stored-from-env");
    expect(request.envs?.OPENAI_API_KEY).toBe("explicit-openai-key");
    expect(request.envs?.CODEX_API_KEY).toBe("explicit-openai-key");
    expect(JSON.parse(request.envs?.ARCANIST_REPO_RUNTIME_ENV_NAMES ?? "[]")).toEqual([
      "NGROK_AUTH_TOKEN",
      "NGROK_DOMAIN",
    ]);

    const contract = JSON.parse(request.envs?.ARCANIST_PREVIEW_CONTRACT_JSON ?? "{}") as {
      composeEnv?: Record<string, string>;
    };
    expect(contract.composeEnv).toMatchObject({
      DATABASE_URL: "postgres://stored-from-env",
      POSTGRES_PASSWORD: "stored-password",
      STRIPE_SECRET_KEY: "stored-stripe-secret",
      OPENAI_API_KEY: "explicit-openai-key",
      NGROK_AUTH_TOKEN: "stored-ngrok-token",
      NGROK_DOMAIN: "dev.example.ngrok-free.dev",
      GITHUB_APP_ID: "123456",
      SANDBOX_AUTH_TOKEN: "repo-override",
      NODE_OPTIONS: "--require ./pwn.js",
      CHECKED_IN_ONLY: "yes",
    });
  });

  it("clears repo_private when /session/repo changes the repo", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, repo_private) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "sess-repo-update",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      0,
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch) VALUES (?, ?, 0, 0)",
      "sess-repo-update",
      "idle",
    );

    const response = await doInstance.fetch(
      new Request("https://internal/session/repo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoOwner: "acme",
          repoName: "other-widget",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const row = state.storage.sql
      .exec("SELECT repo_owner, repo_name, repo_private FROM session WHERE session_id = ?", "sess-repo-update")
      .toArray()[0] as Record<string, unknown>;
    expect(row.repo_owner).toBe("acme");
    expect(row.repo_name).toBe("other-widget");
    expect(row.repo_private).toBeNull();
  });

  it("keeps existing repo fields when /session/repo projection sync fails", async () => {
    const db = createDb();
    db.failSessionIndexInsert = true;
    const { doInstance, state } = createDO(workerModule, { DB: db });
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, repo_private) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "sess-repo-projection-fail",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      0,
    );

    await expect(
      doInstance.fetch(
        new Request("https://internal/session/repo", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repoOwner: "acme",
            repoName: "other-widget",
          }),
        }),
      ),
    ).rejects.toThrow("projection failed");

    const row = state.storage.sql
      .exec("SELECT repo_owner, repo_name, repo_private FROM session WHERE session_id = ?", "sess-repo-projection-fail")
      .toArray()[0] as Record<string, unknown>;
    expect(row.repo_owner).toBe("acme");
    expect(row.repo_name).toBe("widget");
    expect(row.repo_private).toBe(0);
  });

  it("clears snapshot metadata when /session/repo changes the repo", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, base_branch,
        agent_session_id, agent_session_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-repo-snapshot-reset",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      "main",
      "codex-session-existing",
      "default",
    );
    state.storage.sql.exec(
      `INSERT INTO sandbox_state (
        session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id, snapshot_branch
      ) VALUES (?, ?, 0, 0, ?, ?)`,
      "sess-repo-snapshot-reset",
      "idle",
      "img-session-1",
      "main",
    );

    const response = await doInstance.fetch(
      new Request("https://internal/session/repo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoOwner: "acme",
          repoName: "other-widget",
          baseBranch: "main",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const sandboxRow = state.storage.sql
      .exec(
        "SELECT snapshot_image_id, last_snapshot_error FROM sandbox_state WHERE session_id = ?",
        "sess-repo-snapshot-reset",
      )
      .toArray()[0] as Record<string, unknown>;
    expect(sandboxRow.snapshot_image_id).toBeNull();
    expect(String(sandboxRow.last_snapshot_error)).toContain("repo changed");
    const sessionRow = state.storage.sql
      .exec(
        "SELECT agent_session_id, agent_session_agent FROM session WHERE session_id = ?",
        "sess-repo-snapshot-reset",
      )
      .toArray()[0] as Record<string, unknown>;
    expect(sessionRow.agent_session_id).toBeNull();
    expect(sessionRow.agent_session_agent).toBeNull();
  });

  it("clears snapshot metadata when /session/repo changes the base branch", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, base_branch,
        agent_session_id, agent_session_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-base-branch-reset",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      "main",
      "codex-session-existing",
      "default",
    );
    state.storage.sql.exec(
      `INSERT INTO sandbox_state (
        session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id, snapshot_branch
      ) VALUES (?, ?, 0, 0, ?, ?)`,
      "sess-base-branch-reset",
      "idle",
      "img-session-1",
      "main",
    );

    const response = await doInstance.fetch(
      new Request("https://internal/session/repo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoOwner: "acme",
          repoName: "widget",
          baseBranch: "develop",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const sandboxRow = state.storage.sql
      .exec(
        "SELECT snapshot_image_id, last_snapshot_error FROM sandbox_state WHERE session_id = ?",
        "sess-base-branch-reset",
      )
      .toArray()[0] as Record<string, unknown>;
    expect(sandboxRow.snapshot_image_id).toBeNull();
    expect(String(sandboxRow.last_snapshot_error)).toContain("base branch changed");
    const sessionRow = state.storage.sql
      .exec("SELECT agent_session_id, agent_session_agent FROM session WHERE session_id = ?", "sess-base-branch-reset")
      .toArray()[0] as Record<string, unknown>;
    expect(sessionRow.agent_session_id).toBeNull();
    expect(sessionRow.agent_session_agent).toBeNull();
  });

  it("does not pass legacy session snapshots to E2B spawns", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, installation_id, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "sess-snapshot-boot",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      "main",
    );
    state.storage.sql.exec(
      "INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id) VALUES (?, ?, 0, 0, ?)",
      "sess-snapshot-boot",
      "spawning",
      "img-session-1",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-snapshot-boot");

    const request = mocks.createSandbox.mock.calls.at(-1)?.[0] as { sessionSnapshotImageId?: string | null };
    expect(request).not.toHaveProperty("sessionSnapshotImageId");
  });

  it("regenerates the sandbox auth token when respawning with historical snapshot state", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-snapshot-auth-refresh",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      "main",
    );
    state.storage.sql.exec(
      `INSERT INTO sandbox_state (
        session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id, sandbox_auth_token_hash
      ) VALUES (?, ?, 0, 0, ?, ?)`,
      "sess-snapshot-auth-refresh",
      "spawning",
      "img-session-1",
      "old-hash",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-snapshot-auth-refresh");

    const request = mocks.createSandbox.mock.calls.at(-1)?.[0] as {
      envs?: Record<string, string>;
      sessionSnapshotImageId?: string | null;
    };
    expect(request).not.toHaveProperty("sessionSnapshotImageId");
    expect(request.envs?.SANDBOX_AUTH_TOKEN).toEqual(expect.any(String));

    const sandboxRow = state.storage.sql
      .exec("SELECT sandbox_auth_token_hash FROM sandbox_state WHERE session_id = ?", "sess-snapshot-auth-refresh")
      .toArray()[0] as Record<string, unknown>;
    expect(sandboxRow.sandbox_auth_token_hash).not.toBe("old-hash");
  });

  it("ignores historical snapshot credential metadata during E2B spawn", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-stale-credential-restore",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      "main",
    );
    state.storage.sql.exec(
      `INSERT INTO sandbox_state (
        session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id,
        snapshot_branch, snapshot_credential_env_keys_json
      ) VALUES (?, ?, 0, 0, ?, ?, ?)`,
      "sess-stale-credential-restore",
      "spawning",
      "img-session-1",
      "main",
      JSON.stringify(["GITHUB_CLONE_TOKEN", "OPENAI_API_KEY"]),
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-stale-credential-restore");

    const request = mocks.createSandbox.mock.calls.at(-1)?.[0] as { sessionSnapshotImageId?: string | null };
    expect(request).not.toHaveProperty("sessionSnapshotImageId");

    const sandboxRow = state.storage.sql
      .exec(
        "SELECT snapshot_image_id, last_snapshot_error FROM sandbox_state WHERE session_id = ?",
        "sess-stale-credential-restore",
      )
      .toArray()[0] as Record<string, unknown>;
    expect(sandboxRow.snapshot_image_id).toBe("img-session-1");
    expect(sandboxRow.last_snapshot_error).toBeNull();
  });

  it("ignores historical snapshot boot workspace metadata during E2B spawn", async () => {
    const { doInstance, state } = createDO(workerModule);
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-snapshot-workspace-mismatch",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      "main",
    );
    state.storage.sql.exec(
      `INSERT INTO sandbox_state (
        session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id,
        snapshot_branch, snapshot_modal_workspace
      ) VALUES (?, ?, 0, 0, ?, ?, ?)`,
      "sess-snapshot-workspace-mismatch",
      "spawning",
      "img-session-1",
      "main",
      "test-workspace",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-snapshot-workspace-mismatch");

    const request = mocks.createSandbox.mock.calls.at(-1)?.[0] as { sessionSnapshotImageId?: string | null };
    expect(request).not.toHaveProperty("sessionSnapshotImageId");

    const sandboxRow = state.storage.sql
      .exec(
        "SELECT snapshot_image_id, last_snapshot_error FROM sandbox_state WHERE session_id = ?",
        "sess-snapshot-workspace-mismatch",
      )
      .toArray()[0] as Record<string, unknown>;
    expect(sandboxRow.snapshot_image_id).toBe("img-session-1");
    expect(sandboxRow.last_snapshot_error).toBeNull();
  });

  it("ignores historical snapshot image-version metadata during E2B spawn", async () => {
    const { doInstance, state } = createDO(workerModule, {
      SANDBOX_IMAGE_VERSION: "sandbox-v2",
    });
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO session (
        session_id, owner_user_id, status, created_at, updated_at, repo_owner, repo_name, installation_id, base_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sess-snapshot-image-version-mismatch",
      "1",
      "active",
      now,
      now,
      "acme",
      "widget",
      1,
      "main",
    );
    state.storage.sql.exec(
      `INSERT INTO sandbox_state (
        session_id, status, spawn_retry_count, pending_prompt_dispatch, snapshot_image_id,
        snapshot_branch, snapshot_sandbox_image_version
      ) VALUES (?, ?, 0, 0, ?, ?, ?)`,
      "sess-snapshot-image-version-mismatch",
      "spawning",
      "img-session-1",
      "main",
      "sandbox-v1",
    );

    await (
      doInstance as unknown as {
        spawnSandbox(sessionId: string): Promise<void>;
      }
    ).spawnSandbox("sess-snapshot-image-version-mismatch");

    const request = mocks.createSandbox.mock.calls.at(-1)?.[0] as { sessionSnapshotImageId?: string | null };
    expect(request).not.toHaveProperty("sessionSnapshotImageId");

    const sandboxRow = state.storage.sql
      .exec(
        "SELECT snapshot_image_id, last_snapshot_error FROM sandbox_state WHERE session_id = ?",
        "sess-snapshot-image-version-mismatch",
      )
      .toArray()[0] as Record<string, unknown>;
    expect(sandboxRow.snapshot_image_id).toBe("img-session-1");
    expect(sandboxRow.last_snapshot_error).toBeNull();
  });
});
