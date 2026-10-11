import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { drainSpans, endSpan, runInSpan, startSpan } from "../../apps/control-plane-worker/src/observability/context";
import { modelRoutes } from "../../apps/control-plane-worker/src/routes/models";
import { modelsCacheKey } from "../../apps/control-plane-worker/src/services/bootstrap";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";
import { BaseFakeD1Statement, batchFakeD1Statements } from "./helpers/fake-d1";
import { createWorkerTestEnv } from "./helpers/worker-env";
import {
  FakeKV,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "./helpers/worker-harness";

mockCloudflareWorkers();

vi.mock("../../apps/control-plane-worker/src/github/octokit", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../apps/control-plane-worker/src/github/octokit")>();
  return {
    ...original,
    getAppSlug: async () => "cycloid-test",
  };
});

mockSentryCloudflare();

// ---------------------------------------------------------------------------
// Fake storage and D1
// ---------------------------------------------------------------------------

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
};

interface UserRow {
  id: number;
  openai_api_key: string | null;
  github_token: string | null;
}

interface UserSettingsRow {
  use_codex_subscription: number;
}

interface IntegrationRow {
  integration_id: string;
  api_key?: string | null;
  external_user_id?: string | null;
  encrypted?: number | null;
  last_validation_status?: string | null;
}

interface OpenAIVirtualKeyRow {
  id: string;
  owner_user_id: string;
  status: string;
}

class FakeD1Statement extends BaseFakeD1Statement<FakeD1> {
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    if (this.isSchemaQuery()) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    // github_installations: getActiveInstallationsForOwners (with IN clause) or getActiveInstallations
    if (this.query.includes("FROM github_installations")) {
      let results = Array.from(this.db.githubInstallations.values()).filter((i) => i.suspended_at === null);
      // If query has IN clause, filter by bound owner logins
      if (this.query.includes("IN (")) {
        const lowerBound = this.boundValues.map((v) => String(v).toLowerCase());
        results = results.filter((i) => lowerBound.includes(i.owner_login.toLowerCase()));
      }
      return { results: results as unknown as Array<Record<string, unknown>> };
    }

    if (this.query.includes("FROM user_settings")) {
      const userId = Number(this.boundValues[0]);
      const row = this.db.userSettings.get(userId);
      return { results: row ? [row as unknown as Record<string, unknown>] : [] };
    }

    // user_integrations: getProviderKeyStatus
    if (this.query.includes("FROM user_integrations")) {
      const userId = Number(this.boundValues[0]);
      const results: Array<{ integration_id: string }> = [];
      const userRow = this.db.users.get(userId);
      if (userRow) {
        if (userRow.openai_api_key) results.push({ integration_id: "openai" });
      }
      for (const [key, row] of this.db.integrationRows) {
        if (key.startsWith(`${userId}:`)) {
          results.push(row as { integration_id: string });
        }
      }
      return { results };
    }

    // business_integrations (all)
    if (this.query.includes("FROM business_integrations")) {
      const businessId = this.boundValues[0] as string;
      const results = this.db.businessIntegrations.filter((r) => r.business_id === businessId);
      return { results: results as unknown as Array<Record<string, unknown>> };
    }

    // business_integration_credentials (all)
    if (this.query.includes("FROM business_integration_credentials")) {
      const businessId = this.boundValues[0] as string;
      const results = this.db.businessIntegrationCredentials.filter((r) => r.business_id === businessId);
      return { results: results as unknown as Array<Record<string, unknown>> };
    }

    // businesses: Codex BYOS capability (mirror migration 0255 seeding prod Cycloid)
    if (this.query.includes("FROM businesses") && this.query.includes("codex_byos_enabled")) {
      const businessId = String(this.boundValues[0]);
      return { results: [{ codex_byos_enabled: businessId === SEEDED_BUSINESS_IDS.cycloid ? 1 : 0 }] };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const user = this.db.authTokens.get(token);
      return user ?? null;
    }

    // user_integrations: getValidGithubToken
    if (
      this.query.includes("FROM user_integrations") &&
      (this.query.includes("integration_id = 'github'") ||
        (this.query.includes("integration_id = ?") && this.boundValues[1] === "github")) &&
      this.query.includes("oauth_access_token")
    ) {
      const userId = Number(this.boundValues[0]);
      const userRow = this.db.users.get(userId);
      if (!userRow?.github_token) return null;
      return {
        oauth_access_token: userRow.github_token,
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      };
    }

    // user_integrations: getUserApiKey (SELECT api_key ...)
    if (this.query.includes("FROM user_integrations") && this.query.includes("api_key")) {
      return null;
    }

    // user_integrations: generic first
    if (this.query.includes("FROM user_integrations")) {
      return null;
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      const userId = Number(this.boundValues[0]);
      const row = this.db.businessMembers.find((r) => r.user_id === userId);
      return row ? { business_id: row.business_id } : null;
    }

    // business_integrations (first)
    if (this.query.includes("FROM business_integrations")) {
      const businessId = this.boundValues[0] as string;
      const integrationId = this.boundValues[1] as string;
      const row = this.db.businessIntegrations.find(
        (r) => r.business_id === businessId && r.integration_id === integrationId,
      );
      return row ? { scope: row.scope } : null;
    }

    // Legacy users.openai_api_key lookup should not be used.
    if (this.query.includes("openai_api_key") && this.query.includes("FROM users")) {
      throw new Error(`Deprecated OpenAI key query used: ${this.query}`);
    }

    // Legacy user.github_token lookup should not be used by GitHub token callers.
    if (this.query.includes("github_token") && this.query.includes("FROM users")) {
      throw new Error(`Deprecated GitHub token query used: ${this.query}`);
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

interface InstallationRow {
  installation_id: number;
  owner_login: string;
  owner_id: number;
  owner_type: string;
  repository_selection: string | null;
  created_at: number;
  suspended_at: number | null;
}

interface BusinessMemberRow {
  business_id: string;
  user_id: number;
}

interface BusinessIntegrationCredentialRow {
  business_id: string;
  integration_id: string;
}

interface BusinessIntegrationRow {
  business_id: string;
  integration_id: string;
  scope: string;
}

class FakeD1 {
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly users = new Map<number, UserRow>();
  readonly userSettings = new Map<number, UserSettingsRow>();
  readonly integrationRows = new Map<string, IntegrationRow>();
  readonly githubInstallations = new Map<string, InstallationRow>();
  readonly businessMembers: BusinessMemberRow[] = [];
  readonly businessIntegrationCredentials: BusinessIntegrationCredentialRow[] = [];
  readonly businessIntegrations: BusinessIntegrationRow[] = [];
  readonly openAIVirtualKeys: OpenAIVirtualKeyRow[] = [];

  setAuthToken(token: string, user: AuthTokenUser): void {
    this.authTokens.set(token, user);
  }

  setUser(user: UserRow): void {
    this.users.set(user.id, user);
  }

  seedInstallation(ownerLogin: string, installationId = 1): void {
    this.githubInstallations.set(ownerLogin, {
      installation_id: installationId,
      owner_login: ownerLogin,
      owner_id: installationId,
      owner_type: "Organization",
      repository_selection: "all",
      created_at: Date.now(),
      suspended_at: null,
    });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return batchFakeD1Statements(statements);
  }
}

function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
  kv: FakeKV;
  modelsKv: FakeKV;
} {
  const db = new FakeD1();
  const kv = new FakeKV();
  const modelsKv = new FakeKV();
  const { env } = createWorkerTestEnv(workerModule, {
    db,
    bindings: {
      kv: { envKey: "REPOS_CACHE", value: kv },
      modelsKv: { envKey: "DERIVED_MODELS", value: modelsKv },
    },
  });

  return { env, db, kv, modelsKv };
}

function createCookieAuth(userId: number): AuthInfo {
  return {
    userId: String(userId),
    tokenSource: "session_token",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: userId,
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId: "biz-1",
      sharedSessions: false,
      businessMemberIds: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("models and repos routes", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  // ---- GET /api/models ----

  describe("GET /api/models", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models");
      expect(res.status).toBe(401);
    });

    it("returns models without BYOK status for admin token auth", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // Admin token auth should return models without hasApiKey
      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.models.length).toBeGreaterThan(0);
      expect(openai.hasApiKey).toBeUndefined();
    });

    it("rejects unknown bearer token auth on models routes", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer mcp-secret" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects CI automation token on authenticated routes outside its allowlist", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer ci-automation-secret" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden: CI automation token cannot access this resource");
    });

    it("returns models with BYOK status for cookie-auth user", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-1", {
        user_id: 701,
        id: 701,
        expires_at: Date.now() + 60_000,
        login: "modeluser",
        name: null,
        email: null,
      });
      db.setUser({ id: 701, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(false);
    });

    it("returns models with all false BYOK when no user record exists", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-2", {
        user_id: 702,
        id: 702,
        expires_at: Date.now() + 60_000,
        login: "nouser",
        name: null,
        email: null,
      });
      // No db.setUser -- user row doesn't exist

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-2" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai.hasApiKey).toBe(false);
    });

    it("returns hasApiKey false for openai when only a platform key exists", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.ARCANIST_OPENAI_API_KEY = "platform-key";

      db.setAuthToken("sess-models-3", {
        user_id: 703,
        id: 703,
        expires_at: Date.now() + 60_000,
        login: "platformuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 703, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-3" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(false);
    });

    it("returns hasApiKey false for openai when the user only has an active managed virtual key", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-virtual-key", {
        user_id: 704,
        id: 704,
        expires_at: Date.now() + 60_000,
        login: "virtualkeyuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 704, openai_api_key: null, github_token: null });
      db.openAIVirtualKeys.push({ id: "vk_user_704", owner_user_id: "704", status: "active" });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-virtual-key" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(false);
    });

    it("returns hasApiKey true for openai when Codex subscription auth is enabled with validated auth", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-codex-subscription", {
        user_id: 705,
        id: 705,
        expires_at: Date.now() + 60_000,
        login: "codexsubscriptionuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 705, openai_api_key: null, github_token: null });
      db.businessMembers.push({ business_id: "295d2abc-d10b-4662-b84d-7bfa66242882", user_id: 705 });
      db.userSettings.set(705, { use_codex_subscription: 1 });
      db.integrationRows.set("705:codex_subscription", {
        integration_id: "codex_subscription",
        api_key: "encrypted-auth-json",
        external_user_id: "auth_json:705",
        encrypted: 1,
        last_validation_status: "validated",
      });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-codex-subscription" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(true);
    });

    it("includes expected provider ids and model ids", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const providerIds = body.map((p: { id: string }) => p.id);
      expect(providerIds).toContain("openai");
      // Admin token auth has no user key context, so it serves the raw
      // cross-backend groups, including internal probe providers.
      expect(providerIds).toContain("anthropic");
      expect(providerIds).toContain("baseten");
      expect(body.flatMap((p: { models: Array<{ id: string }> }) => p.models.map((m) => m.id))).toEqual([
        "gpt-5.4",
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4-mini",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-fable-5",
        "kimi-k2.7-code",
      ]);
    });

    it("returns stable labels derived from the shared registry", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      const gpt56Sol = openai.models.find((m: { id: string }) => m.id === "gpt-5.6-sol");
      expect(gpt56Sol.name).toBe("GPT-5.6 Sol");
      expect(gpt56Sol.label).toBe("OpenAI / GPT-5.6 Sol");

      const gpt55 = openai.models.find((m: { id: string }) => m.id === "gpt-5.5");
      expect(gpt55.name).toBe("GPT-5.5");
      expect(gpt55.label).toBe("OpenAI / GPT-5.5");

      const gpt54 = openai.models.find((m: { id: string }) => m.id === "gpt-5.4");
      expect(gpt54.name).toBe("GPT-5.4");
      expect(gpt54.label).toBe("OpenAI / GPT-5.4");

      const gpt54Mini = openai.models.find((m: { id: string }) => m.id === "gpt-5.4-mini");
      expect(gpt54Mini.name).toBe("GPT-5.4 Mini");
      expect(gpt54Mini.label).toBe("OpenAI / GPT-5.4 Mini");

      expect(openai.models.find((m: { id: string }) => m.id === "gpt-5.4-nano")).toBeUndefined();
      expect(openai.models.map((m: { id: string }) => m.id)).toEqual([
        "gpt-5.4",
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4-mini",
      ]);

      const anthropic = body.find((p: { id: string }) => p.id === "anthropic");
      const opus = anthropic.models.find((m: { id: string }) => m.id === "claude-opus-4-8");
      expect(opus.name).toBe("Claude Opus 4.8");
      expect(opus.label).toBe("Anthropic / Claude Opus 4.8");
      expect(opus.backends).toEqual(["claude_code"]);
      expect(anthropic.models.map((m: { id: string }) => m.id)).toEqual([
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-fable-5",
      ]);
    });

    it("includes reasoning config per model", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      const gpt56Sol = openai.models.find((m: { id: string }) => m.id === "gpt-5.6-sol");
      expect(gpt56Sol.reasoning.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
      expect(gpt56Sol.reasoning.default).toBe("medium");

      const gpt55 = openai.models.find((m: { id: string }) => m.id === "gpt-5.5");
      expect(gpt55.reasoning).toBeDefined();
      expect(gpt55.reasoning.efforts).toContain("xhigh");
      expect(gpt55.reasoning.default).toBe("medium");

      const gpt54 = openai.models.find((m: { id: string }) => m.id === "gpt-5.4");
      expect(gpt54.reasoning).toBeDefined();
      expect(gpt54.reasoning.efforts).toContain("xhigh");
      expect(gpt54.reasoning.default).toBe("medium");

      const anthropic = body.find((p: { id: string }) => p.id === "anthropic");
      const opus = anthropic.models.find((m: { id: string }) => m.id === "claude-opus-4-8");
      expect(opus.reasoning.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
      expect(opus.reasoning.default).toBe("high");

      const sonnet = anthropic.models.find((m: { id: string }) => m.id === "claude-sonnet-4-6");
      expect(sonnet.reasoning.efforts).toEqual(["none", "low", "medium", "high", "max"]);
      expect(sonnet.reasoning.default).toBe("high");
    });

    it("returns hasApiKey true for openai when business-wide credentials are configured", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-biz", {
        user_id: 710,
        id: 710,
        expires_at: Date.now() + 60_000,
        login: "bizuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 710, openai_api_key: null, github_token: null });

      // User belongs to a business
      db.businessMembers.push({ business_id: "biz-test", user_id: 710 });
      // OpenAI is set to business scope
      db.businessIntegrations.push({ business_id: "biz-test", integration_id: "openai", scope: "business" });
      // Business has OpenAI credentials
      db.businessIntegrationCredentials.push({ business_id: "biz-test", integration_id: "openai" });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-biz" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(true);
    });

    it("returns hasApiKey false for openai when business scope is set but no credentials exist", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-biz2", {
        user_id: 711,
        id: 711,
        expires_at: Date.now() + 60_000,
        login: "bizuser2",
        name: null,
        email: null,
      });
      db.setUser({ id: 711, openai_api_key: null, github_token: null });

      db.businessMembers.push({ business_id: "biz-test2", user_id: 711 });
      // OpenAI is set to business scope but no credentials stored
      db.businessIntegrations.push({ business_id: "biz-test2", integration_id: "openai", scope: "business" });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-biz2" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(false);
    });

    it("hides the anthropic provider group when no anthropic key resolves", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-anthropic-1", {
        user_id: 730,
        id: 730,
        expires_at: Date.now() + 60_000,
        login: "claudeless",
        name: null,
        email: null,
      });
      db.setUser({ id: 730, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-anthropic-1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Per-business claude_code gating: Claude models stay hidden until an
      // Anthropic key resolves (anthropic is customerFacing: false, PR #4210).
      expect(body.map((p: { id: string }) => p.id)).toEqual(["openai"]);
    });

    it("exposes the anthropic provider group when business-wide anthropic credentials exist", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-anthropic-2", {
        user_id: 731,
        id: 731,
        expires_at: Date.now() + 60_000,
        login: "claudeuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 731, openai_api_key: null, github_token: null });
      db.businessMembers.push({ business_id: "biz-claude", user_id: 731 });
      db.businessIntegrations.push({ business_id: "biz-claude", integration_id: "anthropic", scope: "business" });
      db.businessIntegrationCredentials.push({ business_id: "biz-claude", integration_id: "anthropic" });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-anthropic-2" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const anthropic = body.find((p: { id: string }) => p.id === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic.hasApiKey).toBe(true);
      expect(anthropic.models.map((m: { id: string }) => m.id)).toEqual([
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-fable-5",
      ]);
      const opus = anthropic.models.find((m: { id: string }) => m.id === "claude-opus-4-8");
      expect(opus.backends).toEqual(["claude_code"]);
    });

    it("returns display-safe model shape (no internal registry fields)", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const allowedGroupKeys = new Set(["id", "name", "models", "hasApiKey"]);
      const allowedModelKeys = new Set(["id", "name", "label", "backends", "contextWindow", "reasoning"]);

      for (const group of body) {
        for (const key of Object.keys(group)) {
          expect(allowedGroupKeys, `unexpected group key: ${key}`).toContain(key);
        }
        for (const model of group.models) {
          for (const key of Object.keys(model)) {
            expect(allowedModelKeys, `unexpected model key: ${key}`).toContain(key);
          }
          expect(model).toHaveProperty("id");
          expect(model).toHaveProperty("name");
          expect(model).toHaveProperty("label");
        }
      }
    });

    // ---- KV caching behaviour ----

    it("populates DERIVED_MODELS KV cache on first request", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-cache-1", {
        user_id: 720,
        id: 720,
        expires_at: Date.now() + 60_000,
        login: "cacheuser1",
        name: null,
        email: null,
      });
      db.setUser({ id: 720, openai_api_key: null, github_token: null });

      // KV should be empty before the request
      expect(modelsKv.store.size).toBe(0);

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-1" },
      });
      expect(res.status).toBe(200);

      // KV should now have the cached entry
      const cached = (await modelsKv.get(modelsCacheKey(720), "json")) as Array<{ id: string }> | null;
      expect(cached).not.toBeNull();
      expect(Array.isArray(cached)).toBe(true);

      const openai = cached!.find((p) => p.id === "openai");
      expect(openai).toBeDefined();
    });

    it("serves from KV cache on second request (no extra D1 queries)", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-cache-2", {
        user_id: 721,
        id: 721,
        expires_at: Date.now() + 60_000,
        login: "cacheuser2",
        name: null,
        email: null,
      });
      db.setUser({ id: 721, openai_api_key: null, github_token: null });

      // First request -- populates KV
      const first = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-2" },
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      // Count D1 prepare calls from this point
      let d1PrepareCount = 0;
      const originalPrepare = db.prepare.bind(db);
      db.prepare = (query: string) => {
        d1PrepareCount++;
        return originalPrepare(query);
      };

      // Second request -- should serve from KV
      const second = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-2" },
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json();

      // Same result
      expect(secondBody).toEqual(firstBody);

      // The only D1 query should be the auth token lookup, not model enrichment queries.
      // Auth lookup = 1 prepare call. Without cache, models would add 3-4 more.
      expect(d1PrepareCount).toBe(1);
    });

    it("does not record db.rows_returned on route spans for cache-hit responses", async () => {
      const { env, modelsKv } = createWorkerEnv(workerModule);
      const route = modelRoutes.find((candidate) => candidate.method === "GET");
      if (!route) throw new Error("Model route not found");

      await modelsKv.put(
        modelsCacheKey(722),
        JSON.stringify([{ id: "openai", name: "OpenAI", hasApiKey: false, models: [] }]),
      );

      const root = startSpan("worker.fetch", { "request.id": "req-models-hit" });
      let spans = [] as ReturnType<typeof drainSpans>;

      await runInSpan(root, async () => {
        const response = await route.handler(
          new Request("https://worker.test/api/models"),
          env as never,
          route.pattern.exec("/api/models")!,
          createCookieAuth(722),
        );

        expect(response.status).toBe(200);
        endSpan(root, "ok");
        spans = drainSpans();
      });

      const routeSpan = spans.find((span) => span.name === "models.list");
      expect(routeSpan).toBeDefined();
      expect(routeSpan?.attributes["cache.status"]).toBe("hit");
      expect(routeSpan?.attributes["db.rows_returned"]).toBeUndefined();
    });

    it("returns Cache-Control: private, max-age=60 for authenticated users", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-cache-3", {
        user_id: 722,
        id: 722,
        expires_at: Date.now() + 60_000,
        login: "cacheuser3",
        name: null,
        email: null,
      });
      db.setUser({ id: 722, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-3" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    });

    it("returns correct data even when KV read fails", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      // Replace DERIVED_MODELS with a broken KV that throws on read
      env.DERIVED_MODELS = {
        get: () => {
          throw new Error("KV unavailable");
        },
        put: () => {
          throw new Error("KV unavailable");
        },
        delete: () => {
          throw new Error("KV unavailable");
        },
      };

      db.setAuthToken("sess-models-cache-4", {
        user_id: 723,
        id: 723,
        expires_at: Date.now() + 60_000,
        login: "cacheuser4",
        name: null,
        email: null,
      });
      db.setUser({ id: 723, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-4" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      const openai = body.find((p: { id: string }) => p.id === "openai");
      expect(openai).toBeDefined();
      expect(openai.hasApiKey).toBe(false);
    });

    it("serves pre-populated KV cache data without hitting D1 for model enrichment", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-cache-5", {
        user_id: 724,
        id: 724,
        expires_at: Date.now() + 60_000,
        login: "cacheuser5",
        name: null,
        email: null,
      });
      db.setUser({ id: 724, openai_api_key: null, github_token: null });

      // Pre-populate KV with custom data
      const cachedData = [{ id: "openai", name: "OpenAI", models: [], hasApiKey: true }];
      await modelsKv.put(modelsCacheKey(724), JSON.stringify(cachedData));

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-5" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Should return the cached data, not freshly computed data
      expect(body).toEqual(cachedData);
    });

    it("ignores pre-allowlist KV cache entries from the old models key", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-models-cache-6", {
        user_id: 725,
        id: 725,
        expires_at: Date.now() + 60_000,
        login: "cacheuser6",
        name: null,
        email: null,
      });
      db.setUser({ id: 725, openai_api_key: null, github_token: null });

      await modelsKv.put(
        "models:725",
        JSON.stringify([{ id: "openai", name: "OpenAI", models: [{ id: "gpt-5.4-mini" }] }]),
      );

      const res = await workerFetch(workerModule, env, "/api/models", {
        headers: { cookie: "session_token=sess-models-cache-6" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.flatMap((p: { models: Array<{ id: string }> }) => p.models.map((m) => m.id))).toEqual([
        "gpt-5.4",
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4-mini",
      ]);
    });
  });

  describe("GET /api/repos", () => {
    it("rejects unknown bearer token auth on repos routes", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/repos", {
        headers: { authorization: "Bearer mcp-secret" },
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- GET /api/repos ----

  describe("GET /api/repos", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/repos");
      expect(res.status).toBe(401);
    });

    it("rejects admin token outside the explicit bearer allowlist", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/repos", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden: admin token cannot access this resource");
    });

    it("returns 401 when user has no GitHub token stored", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-1", {
        user_id: 801,
        id: 801,
        expires_at: Date.now() + 60_000,
        login: "repouser",
        name: null,
        email: null,
      });
      db.setUser({ id: 801, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/repos", {
        headers: { cookie: "session_token=sess-repos-1" },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("No GitHub OAuth token is stored for this user.");
    });

    it("returns 502 when GitHub API call fails", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-2", {
        user_id: 802,
        id: 802,
        expires_at: Date.now() + 60_000,
        login: "repouser2",
        name: null,
        email: null,
      });
      db.setUser({ id: 802, openai_api_key: null, github_token: "ghp_test_token" });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-2" },
        });
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.error).toContain("GitHub API error");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns only repos whose owner has an active Cycloid installation", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-3", {
        user_id: 803,
        id: 803,
        expires_at: Date.now() + 60_000,
        login: "repouser3",
        name: null,
        email: null,
      });
      db.setUser({ id: 803, openai_api_key: null, github_token: "ghp_valid_token" });
      db.seedInstallation("acme", 1);

      const mockRepos = [
        {
          full_name: "acme/secret-project",
          html_url: "https://github.com/acme/secret-project",
          private: true,
          default_branch: "develop",
        },
        {
          full_name: "acme/open-source",
          html_url: "https://github.com/acme/open-source",
          private: false,
          default_branch: "main",
        },
        {
          full_name: "no-install-org/some-repo",
          html_url: "https://github.com/no-install-org/some-repo",
          private: false,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-3" },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.repos)).toBe(true);
        expect(body.ssoOrgs).toEqual([]);
        // Only acme repos should be returned (no-install-org filtered out)
        expect(body.repos).toHaveLength(2);
        expect(body.repos[0].fullName).toBe("acme/secret-project");
        expect(body.repos[0].private).toBe(true);
        expect(body.repos[0].defaultBranch).toBe("develop");
        expect(body.repos[1].fullName).toBe("acme/open-source");
        expect(body.repos[1].private).toBe(false);
        expect(body.repos[1].defaultBranch).toBe("main");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("excludes repos from suspended installations", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-5", {
        user_id: 805,
        id: 805,
        expires_at: Date.now() + 60_000,
        login: "repouser5",
        name: null,
        email: null,
      });
      db.setUser({ id: 805, openai_api_key: null, github_token: "ghp_valid_token" });

      // acme is active, suspended-org is suspended
      db.seedInstallation("acme", 1);
      db.githubInstallations.set("suspended-org", {
        installation_id: 2,
        owner_login: "suspended-org",
        owner_id: 2,
        owner_type: "Organization",
        repository_selection: "all",
        created_at: Date.now(),
        suspended_at: Date.now() - 1000,
      });

      const mockRepos = [
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: false,
          default_branch: "main",
        },
        {
          full_name: "suspended-org/repo-b",
          html_url: "https://github.com/suspended-org/repo-b",
          private: false,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-5" },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.repos).toHaveLength(1);
        expect(body.repos[0].fullName).toBe("acme/repo-a");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("filters repos for 'selected' installations using GitHub API", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-selected", {
        user_id: 810,
        id: 810,
        expires_at: Date.now() + 60_000,
        login: "repouser-selected",
        name: null,
        email: null,
      });
      db.setUser({ id: 810, openai_api_key: null, github_token: "ghp_valid_token" });

      // "all" installation for acme, "selected" installation for partial-org
      db.seedInstallation("acme", 1);
      db.githubInstallations.set("partial-org", {
        installation_id: 3,
        owner_login: "partial-org",
        owner_id: 3,
        owner_type: "Organization",
        repository_selection: "selected",
        created_at: Date.now(),
        suspended_at: null,
      });

      const mockRepos = [
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: false,
          default_branch: "main",
        },
        {
          full_name: "partial-org/granted-repo",
          html_url: "https://github.com/partial-org/granted-repo",
          private: true,
          default_branch: "main",
        },
        {
          full_name: "partial-org/not-granted-repo",
          html_url: "https://github.com/partial-org/not-granted-repo",
          private: true,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // Mock the installation repos endpoint -- only granted-repo is accessible
        if (url.includes("api.github.com/user/installations/3/repositories")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [{ full_name: "partial-org/granted-repo" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-selected" },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        // acme/repo-a (all) + partial-org/granted-repo (selected, granted) = 2
        // partial-org/not-granted-repo should be filtered out
        expect(body.repos).toHaveLength(2);
        const names = body.repos.map((r: { fullName: string }) => r.fullName);
        expect(names).toContain("acme/repo-a");
        expect(names).toContain("partial-org/granted-repo");
        expect(names).not.toContain("partial-org/not-granted-repo");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns empty repos when no installations exist", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-6", {
        user_id: 806,
        id: 806,
        expires_at: Date.now() + 60_000,
        login: "repouser6",
        name: null,
        email: null,
      });
      db.setUser({ id: 806, openai_api_key: null, github_token: "ghp_valid_token" });
      // No installations seeded

      const mockRepos = [
        {
          full_name: "some-org/some-repo",
          html_url: "https://github.com/some-org/some-repo",
          private: false,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-6" },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.repos).toHaveLength(0);
        expect(body.ssoOrgs).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("does not filter by visibility when calling GitHub API", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-4", {
        user_id: 804,
        id: 804,
        expires_at: Date.now() + 60_000,
        login: "repouser4",
        name: null,
        email: null,
      });
      db.setUser({ id: 804, openai_api_key: null, github_token: "ghp_valid_token" });

      let capturedUrl = "";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          capturedUrl = url;
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-4" },
        });
        expect(capturedUrl).not.toContain("visibility=private");
        expect(capturedUrl).toContain("api.github.com/user/repos");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns cached result on the second request", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-cache", {
        user_id: 811,
        id: 811,
        expires_at: Date.now() + 60_000,
        login: "repouser-cache",
        name: null,
        email: null,
      });
      db.setUser({ id: 811, openai_api_key: null, github_token: "ghp_valid_token" });
      db.seedInstallation("acme", 1);

      let githubCallCount = 0;
      const mockRepos = [
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: false,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          githubCallCount++;
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const firstRes = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-cache" },
        });
        expect(firstRes.status).toBe(200);
        expect(githubCallCount).toBe(1);

        const cached = (await kv.get("repos:811", "json")) as { repos: Array<{ fullName: string }> } | null;
        expect(cached).toBeTruthy();
        expect(cached!.repos.map((repo) => repo.fullName)).toEqual(["acme/repo-a"]);

        const secondRes = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-cache" },
        });
        expect(secondRes.status).toBe(200);
        expect(githubCallCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("bypasses the repo cache when Cache-Control: no-cache is set", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-bypass", {
        user_id: 812,
        id: 812,
        expires_at: Date.now() + 60_000,
        login: "repouser-bypass",
        name: null,
        email: null,
      });
      db.setUser({ id: 812, openai_api_key: null, github_token: "ghp_valid_token" });
      db.seedInstallation("acme", 1);

      let githubCallCount = 0;
      const mockRepos = [
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: false,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          githubCallCount++;
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const firstRes = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-bypass" },
        });
        expect(firstRes.status).toBe(200);
        expect(githubCallCount).toBe(1);

        const secondRes = await workerFetch(workerModule, env, "/api/repos", {
          headers: {
            cookie: "session_token=sess-repos-bypass",
            "cache-control": "no-cache",
          },
        });
        expect(secondRes.status).toBe(200);
        expect(githubCallCount).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("refetches repos when the installation cache version changes", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-repos-version", {
        user_id: 813,
        id: 813,
        expires_at: Date.now() + 60_000,
        login: "repouser-version",
        name: null,
        email: null,
      });
      db.setUser({ id: 813, openai_api_key: null, github_token: "ghp_valid_token" });
      db.seedInstallation("acme", 1);

      let githubCallCount = 0;
      const mockRepos = [
        {
          full_name: "acme/repo-a",
          html_url: "https://github.com/acme/repo-a",
          private: false,
          default_branch: "main",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/user/repos")) {
          githubCallCount++;
          return new Response(JSON.stringify(mockRepos), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const firstRes = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-version" },
        });
        expect(firstRes.status).toBe(200);
        expect(githubCallCount).toBe(1);

        await kv.put("repos:installations:version", "version-2");

        const secondRes = await workerFetch(workerModule, env, "/api/repos", {
          headers: { cookie: "session_token=sess-repos-version" },
        });
        expect(secondRes.status).toBe(200);
        expect(githubCallCount).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---- GET /api/github/install-url ----

  describe("GET /api/github/install-url", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/github/install-url");
      expect(res.status).toBe(401);
    });

    it("returns install URL when authenticated", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-install-1", {
        user_id: 901,
        id: 901,
        expires_at: Date.now() + 60_000,
        login: "installuser",
        name: null,
        email: null,
      });

      const res = await workerFetch(workerModule, env, "/api/github/install-url", {
        headers: { cookie: "session_token=sess-install-1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://github.com/apps/cycloid-test/installations/new");
    });
  });
});
