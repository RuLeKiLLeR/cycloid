import { afterEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses.js";
import { PROVIDER_ENV_VAR } from "../../apps/control-plane-worker/src/integrations/db.js";
import {
  CODEX_SUBSCRIPTION_AUTH_JSON_ENV,
  getSpawnIntegrationCredentialEnvKeys,
  resolveAppRuntimeLlmKey,
  resolveSpawnIntegrationRuntime,
  SpawnProviderCredentialError,
} from "../../apps/control-plane-worker/src/integrations/runtime.js";
import type { Logger } from "../../apps/control-plane-worker/src/logger.js";
import { hashVirtualKey } from "../../apps/control-plane-worker/src/openai-gateway/db.js";
import { encrypt } from "../../apps/control-plane-worker/src/settings/encryption.js";
import type { Env } from "../../apps/control-plane-worker/src/types.js";
import { USER_API_KEY_PROVIDER_IDS, type UserApiKeyProviderId } from "../../shared/constants/integration-helpers.js";
import { CREDENTIAL_VALIDATION_STATUS, type CredentialValidationStatus } from "../../shared/constants/onboarding.js";
import { DEFAULT_JIRA_TRIGGER_LABEL } from "../../shared/constants/sandbox-env.js";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../shared/enums/integration-lifecycle.js";

// A session-start model whose provider matches each API-key provider, so spawn
// resolution (keyed by the model's provider) exercises that provider's path.
type BusinessScopedKeyProviderId = Exclude<UserApiKeyProviderId, "baseten">;
const BUSINESS_SCOPED_KEY_PROVIDER_IDS = USER_API_KEY_PROVIDER_IDS.filter(
  (provider): provider is BusinessScopedKeyProviderId => provider !== "baseten",
);
const MODEL_FOR_PROVIDER: Record<UserApiKeyProviderId, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-opus-4-8",
  baseten: "kimi-k2.7-code",
};

type UserIntegrationRow = {
  user_id: number;
  integration_id: string;
  oauth_access_token?: string | null;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: number | null;
  api_key?: string | null;
  external_user_id?: string | null;
  service_url?: string | null;
  encrypted?: number | null;
  last_validated_at?: number | null;
  last_validation_status?: CredentialValidationStatus | null;
  last_validation_reason_code?: string | null;
};

type BusinessIntegrationRow = {
  business_id: string;
  integration_id: string;
  scope: "disabled" | "user" | "business";
};

type BusinessCredentialRow = {
  business_id: string;
  integration_id: string;
  oauth_access_token?: string | null;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: number | null;
  api_key?: string | null;
  service_url?: string | null;
  encrypted?: number | null;
  last_validation_status?: CredentialValidationStatus | null;
};

type OpenAIVirtualKeyRow = {
  id: string;
  key_hash: string;
  owner_user_id: string;
  status: string;
};

type OpenAIGatewaySessionTokenRow = {
  token_hash: string;
  owner_user_id: number;
  business_id: string | null;
  credential_source: string;
  credential_owner_id: string;
  session_id: string;
  expires_at: number;
};

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
    if (this.query.includes("SELECT business_id FROM business_members")) {
      const [userId] = this.boundValues as [number];
      if (this.db.throwBusinessMembershipLookupForUserId === userId) {
        throw new Error("forced business membership lookup failure");
      }
      const membership = this.db.businessMembers.get(userId);
      return membership ? ({ business_id: membership } as T) : null;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("integration_id = 'linear'")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:linear`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("integration_id = 'jira'")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:jira`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (this.query.includes("FROM jira_user_sites")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.jiraUserSites.get(Number(userId));
      return row ? ({ ...row } as T) : null;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("integration_id = 'notion'")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:notion`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (
      this.query.includes("FROM user_integrations") &&
      this.query.includes("integration_id = ?") &&
      this.query.includes("oauth_access_token")
    ) {
      const [userId, integrationId] = this.boundValues as [number, string];
      const row = this.db.userIntegrations.get(`${userId}:${integrationId}`);
      if (!row?.oauth_access_token) return null;
      return {
        oauth_access_token: row.oauth_access_token,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        api_key: row.api_key ?? null,
        external_user_id: row.external_user_id ?? null,
        service_url: row.service_url ?? null,
        encrypted: row.encrypted ?? 0,
        last_validated_at: row.last_validated_at ?? null,
        last_validation_status: row.last_validation_status ?? null,
        last_validation_reason_code: row.last_validation_reason_code ?? null,
      } as T;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("integration_id = ?")) {
      const [userId, integrationId] = this.boundValues as [number, string];
      if (this.db.throwUserApiKeyFor === integrationId) {
        throw new Error(`forced ${integrationId} lookup failure`);
      }
      const row = this.db.userIntegrations.get(`${userId}:${integrationId}`);
      if (!row) return null;
      return {
        api_key: row.api_key ?? null,
        encrypted: row.encrypted ?? 0,
        last_validation_status: row.last_validation_status ?? null,
      } as T;
    }

    if (this.query.includes("FROM business_integration_credentials") && this.query.includes("integration_id = ?")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.businessCredentials.get(`${businessId}:${integrationId}`);
      if (!row) return null;
      return {
        api_key: row.api_key ?? null,
        encrypted: row.encrypted ?? 0,
        last_validation_status: row.last_validation_status ?? null,
      } as T;
    }

    if (
      this.query.includes("FROM business_integration_credentials") &&
      this.query.includes("integration_id = 'sentry'")
    ) {
      const [businessId] = this.boundValues as [string];
      const row = this.db.businessCredentials.get(`${businessId}:sentry`);
      if (!row) return null;
      if (this.query.includes("oauth_access_token IS NOT NULL") && !row.oauth_access_token) {
        return null;
      }
      return {
        business_id: row.business_id,
        integration_id: row.integration_id,
        oauth_access_token: row.oauth_access_token ?? null,
        oauth_refresh_token: row.oauth_refresh_token ?? null,
        oauth_expires_at: row.oauth_expires_at ?? null,
        api_key: row.api_key ?? null,
        service_url: row.service_url ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (
      this.query.includes("FROM business_integration_credentials") &&
      this.query.includes("integration_id = 'datadog'")
    ) {
      const [businessId] = this.boundValues as [string];
      const row = this.db.businessCredentials.get(`${businessId}:datadog`);
      if (!row) return null;
      return {
        api_key: row.api_key ?? null,
        oauth_access_token: row.oauth_access_token ?? null,
        service_url: row.service_url ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (
      this.query.includes("FROM business_integration_credentials") &&
      this.query.includes("integration_id = 'braintrust'")
    ) {
      const [businessId] = this.boundValues as [string];
      const row = this.db.businessCredentials.get(`${businessId}:braintrust`);
      if (!row) return null;
      return {
        api_key: row.api_key ?? null,
        service_url: row.service_url ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (
      this.query.includes("FROM business_integration_credentials") &&
      this.query.includes("integration_id = 'terraform'")
    ) {
      const [businessId] = this.boundValues as [string];
      const row = this.db.businessCredentials.get(`${businessId}:terraform`);
      if (!row) return null;
      return {
        api_key: row.api_key ?? null,
        encrypted: row.encrypted ?? 0,
      } as T;
    }

    if (this.query.includes("FROM business_integrations")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.businessIntegrations.get(`${businessId}:${integrationId}`);
      return row ? ({ scope: row.scope } as T) : null;
    }

    if (this.query.includes("FROM jira_webhook_installations")) {
      const [businessId, jiraCloudId] = this.boundValues as [string, string];
      const rows = [...this.db.jiraWebhookInstallations.values()].filter(
        (row) => row.business_id === businessId && row.jira_cloud_id === jiraCloudId,
      );
      // Mirrors the DAO ordering: prefer non-revoked, then most recently updated.
      rows.sort(
        (a, b) => (a.status !== "revoked" ? 0 : 1) - (b.status !== "revoked" ? 0 : 1) || b.updated_at - a.updated_at,
      );
      return (rows[0] as T) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM business_integrations")) {
      const [businessId] = this.boundValues as [string];
      if (this.db.throwIntegrationScopesForBusinessId === businessId) {
        throw new Error("forced business integration scope lookup failure");
      }
      const results = [...this.db.businessIntegrations.values()]
        .filter((row) => row.business_id === businessId)
        .map((row) => ({ integration_id: row.integration_id, scope: row.scope }));
      return { results: results as T[] };
    }

    if (this.query.includes("FROM business_members")) {
      const [userId] = this.boundValues as [number];
      if (this.db.throwBusinessMembershipLookupForUserId === userId) {
        throw new Error("forced business membership lookup failure");
      }
      const businessId = this.db.businessMembers.get(userId);
      return { results: (businessId ? [{ business_id: businessId }] : []) as T[] };
    }

    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userSettings.get(userId);
      return { results: (row ? [row] : []) as T[] };
    }

    if (this.query.includes("FROM user_integrations")) {
      const [userId] = this.boundValues as [number];
      const results = [...this.db.userIntegrations.values()]
        .filter((row) => row.user_id === userId)
        .map((row) => ({
          integration_id: row.integration_id,
          oauth_access_token: row.oauth_access_token ?? null,
          oauth_refresh_token: row.oauth_refresh_token ?? null,
          oauth_expires_at: row.oauth_expires_at ?? null,
          api_key: row.api_key ?? null,
          service_url: row.service_url ?? null,
          encrypted: row.encrypted ?? 0,
          last_validation_status: row.last_validation_status ?? null,
        }));
      this.injectPoisonedSnapshotRow(results);
      return { results: results as T[] };
    }

    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId] = this.boundValues as [string];
      const results = [...this.db.businessCredentials.values()]
        .filter((row) => row.business_id === businessId)
        .map((row) => ({
          business_id: row.business_id,
          integration_id: row.integration_id,
          oauth_access_token: row.oauth_access_token ?? null,
          oauth_refresh_token: row.oauth_refresh_token ?? null,
          oauth_expires_at: row.oauth_expires_at ?? null,
          api_key: row.api_key ?? null,
          service_url: row.service_url ?? null,
          encrypted: row.encrypted ?? 0,
          last_validation_status: row.last_validation_status ?? null,
        }));
      this.injectPoisonedSnapshotRow(results, businessId);
      return { results: results as T[] };
    }

    if (this.query.includes("FROM businesses")) {
      const [businessId] = this.boundValues as [string];
      // Mirror migration 0255: prod Cycloid is seeded on; any business the test
      // explicitly opted in via `codexByosBusinessIds` is also on.
      const enabled = businessId === SEEDED_ARCANIST_BUSINESS_ID || this.db.codexByosBusinessIds.has(businessId);
      return { results: [{ codex_byos_enabled: enabled ? 1 : 0 }] as T[] };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  // The old per-integration credential lookup honored `throwUserApiKeyFor` by
  // throwing from `first()` inside the provider-resolution try/catch (-> the
  // provider diagnostic became `lookup_failed` -> TOKEN_REFRESH_FAILED). The
  // batch path resolves the provider credential from the batched snapshot row
  // via `resolveSnapshotApiKey`, so reproduce the same failure by seeding a
  // poisoned snapshot row for the flagged provider: `encrypted` is truthy (so
  // it bypasses the missing-key guard) but != 1, and the `enc:`-prefixed value
  // makes `decrypt` throw "TOKEN_ENCRYPTION_KEY is required", which surfaces
  // inside the credential-resolution try/catch exactly as before.
  private injectPoisonedSnapshotRow(results: Array<Record<string, unknown>>, businessId?: string): void {
    const provider = this.db.throwUserApiKeyFor;
    if (!provider || !this.query.includes("integration_id IN (")) return;
    const base = {
      integration_id: provider,
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: "enc:poison",
      service_url: null,
      encrypted: 2,
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    };
    const existing = results.find((row) => row.integration_id === provider);
    if (existing) {
      existing.api_key = base.api_key;
      existing.encrypted = base.encrypted;
      existing.last_validation_status = CREDENTIAL_VALIDATION_STATUS.VALIDATED;
      return;
    }
    results.push(businessId === undefined ? base : { business_id: businessId, ...base });
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    if (this.query.includes("INSERT INTO user_integrations")) {
      const [
        userId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        _externalUserId,
        serviceUrl,
        encrypted,
      ] = this.boundValues as [
        number,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number,
      ];
      this.db.userIntegrations.set(`${userId}:${integrationId}`, {
        user_id: userId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        service_url: serviceUrl,
        encrypted,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO business_integration_credentials")) {
      const [
        businessId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        serviceUrl,
        encrypted,
      ] = this.boundValues as [
        string,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        number,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
      this.db.businessCredentials.set(`${businessId}:${integrationId}`, {
        business_id: businessId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        service_url: serviceUrl,
        encrypted,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO openai_gateway_session_tokens")) {
      const [tokenHash, ownerUserId, businessId, credentialSource, credentialOwnerId, sessionId, expiresAt] = this
        .boundValues as [string, number, string | null, string, string, string, number, number];
      this.db.openAIGatewaySessionTokens.set(tokenHash, {
        token_hash: tokenHash,
        owner_user_id: ownerUserId,
        business_id: businessId,
        credential_source: credentialSource,
        credential_owner_id: credentialOwnerId,
        session_id: sessionId,
        expires_at: expiresAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE business_integration_credentials")) {
      const [, businessId] = this.boundValues as [number, string];
      const row = this.db.businessCredentials.get(`${businessId}:sentry`);
      if (row) {
        row.oauth_access_token = null;
        row.oauth_refresh_token = null;
        row.oauth_expires_at = null;
        row.service_url = null;
        row.encrypted = row.api_key ? (row.encrypted ?? 0) : 0;
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async executeBatch(): Promise<{ results: unknown[]; meta?: { last_row_id: number } }> {
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
  readonly businessMembers = new Map<number, string>();
  readonly businessIntegrations = new Map<string, BusinessIntegrationRow>();
  readonly businessCredentials = new Map<string, BusinessCredentialRow>();
  readonly userIntegrations = new Map<string, UserIntegrationRow>();
  readonly userSettings = new Map<number, { use_codex_subscription: number }>();
  readonly jiraUserSites = new Map<number, Record<string, unknown>>();
  readonly jiraWebhookInstallations = new Map<
    string,
    { business_id: string; trigger_label: string | null; status: string; updated_at: number } & Record<string, unknown>
  >();
  readonly openAIVirtualKeys = new Map<string, OpenAIVirtualKeyRow>();
  readonly openAIGatewaySessionTokens = new Map<string, OpenAIGatewaySessionTokenRow>();
  readonly codexByosBusinessIds = new Set<string>();
  throwBusinessMembershipLookupForUserId: number | null = null;
  throwIntegrationScopesForBusinessId: string | null = null;
  throwUserApiKeyFor: string | null = null;

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.executeBatch()));
  }
}

class BatchedFakeD1 extends FakeD1 {
  batch(stmts: FakeD1Statement[]): Promise<unknown[]> {
    return Promise.all(stmts.map((stmt) => stmt.all()));
  }
}

const TEST_ENCRYPTION_KEY = "test-token-encryption-key";
// Prod Cycloid business UUID; migration 0255 seeds codex_byos_enabled=1 for it, so
// the fake DB mirrors that. Single source of truth = the shared constant.
const SEEDED_ARCANIST_BUSINESS_ID = SEEDED_BUSINESS_IDS.cycloid;

function createLoggerSpy(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function stubLinearProbe(
  response: Response | ((req: Request) => Response | Promise<Response>) = new Response(
    JSON.stringify({ data: { viewer: { id: "v1" } } }),
    { status: 200 },
  ),
): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href !== "https://api.linear.app/graphql") {
      throw new Error(`Unexpected fetch URL: ${href}`);
    }
    return typeof response === "function" ? response(new Request(href, init)) : response;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION: {} as Env["SESSION"],
    DB: {} as Env["DB"],
    REPOS_CACHE: {} as Env["REPOS_CACHE"],
    RATE_LIMITS: {} as Env["RATE_LIMITS"],
    DERIVED_MODELS: {} as Env["DERIVED_MODELS"],
    ...overrides,
  } as Env;
}

function addUserProviderKey(
  db: FakeD1,
  userId: number,
  provider: UserApiKeyProviderId,
  apiKey: string,
  lastValidationStatus: CredentialValidationStatus | null = CREDENTIAL_VALIDATION_STATUS.VALIDATED,
): void {
  db.userIntegrations.set(`${userId}:${provider}`, {
    user_id: userId,
    integration_id: provider,
    api_key: apiKey,
    last_validation_status: lastValidationStatus,
  });
}

function addJiraWebhookInstallation(
  db: FakeD1,
  businessId: string,
  jiraCloudId: string,
  triggerLabel: string,
  status = "active",
): void {
  db.jiraWebhookInstallations.set(`${businessId}:${jiraCloudId}:${status}`, {
    business_id: businessId,
    jira_cloud_id: jiraCloudId,
    site_url: null,
    site_name: null,
    webhooks_json: null,
    installation_token: `tok-${businessId}`,
    trigger_label: triggerLabel,
    connected_by_user_id: 1,
    status,
    webhook_registered_at: null,
    webhook_expires_at: null,
    created_at: 1,
    updated_at: 1,
    revoked_at: status === "revoked" ? 2 : null,
  });
}

async function addDefaultOpenAIVirtualKey(db: FakeD1, userId: number, secretSeed: string): Promise<string> {
  const secret = `arc-vk-${await hashVirtualKey(`openai-gateway:${secretSeed}:${userId}`)}`;
  db.openAIVirtualKeys.set(`vk_user_${userId}`, {
    id: `vk_user_${userId}`,
    key_hash: await hashVirtualKey(secret),
    owner_user_id: String(userId),
    status: "active",
  });
  return secret;
}

describe("resolveSpawnIntegrationRuntime", () => {
  it("returns only credential-bearing integration env vars in sorted order", () => {
    expect(
      getSpawnIntegrationCredentialEnvKeys({
        OWNER_USER_ID: "7",
        DD_API_KEY: "dd-api-key",
        DD_APP_KEY: "dd-app-key",
        DD_SITE: "us5.datadoghq.com",
        LAUNCHDARKLY_ACCESS_TOKEN: "launchdarkly-token",
        CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        CF_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
        CF_API_TOKEN: "cf-token",
        BRAINTRUST_INTEGRATION_API_KEY: "braintrust-key",
        BRAINTRUST_INTEGRATION_API_URL: "https://api.braintrust.dev",
        STRIPE_SECRET_KEY: "sk_test_123",
        TF_IN_AUTOMATION: "1",
        ARCANIST_TERRAFORM_PLAN_TOKEN: "terraform-token",
        OPENAI_API_KEY: "openai-key",
        BASETEN_API_KEY: "baseten-key",
        ARCANIST_CODEX_AUTH_JSON: '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}',
        JIRA_TRIGGER_LABEL: "cycloid",
        LINEAR_ACCESS_TOKEN: "linear-token",
        NOTION_ACCESS_TOKEN: "notion-token",
        SENTRY_ACCESS_TOKEN: "sentry-token",
        SENTRY_ORGANIZATION_SLUG: "acme",
        SLACK_TOKEN: "xoxb-slack-bot",
        SLACK_USER_TOKEN: "xoxp-slack-user",
      }),
    ).toEqual([
      "ARCANIST_CODEX_AUTH_JSON",
      "ARCANIST_TERRAFORM_PLAN_TOKEN",
      "BASETEN_API_KEY",
      "BRAINTRUST_INTEGRATION_API_KEY",
      "BRAINTRUST_INTEGRATION_API_URL",
      "CF_ACCOUNT_ID",
      "CF_API_TOKEN",
      "CF_D1_DATABASE_ID",
      "DD_API_KEY",
      "DD_APP_KEY",
      "DD_SITE",
      "LAUNCHDARKLY_ACCESS_TOKEN",
      "LINEAR_ACCESS_TOKEN",
      "NOTION_ACCESS_TOKEN",
      "OPENAI_API_KEY",
      "SENTRY_ACCESS_TOKEN",
      "SENTRY_ORGANIZATION_SLUG",
      "SLACK_TOKEN",
      "SLACK_USER_TOKEN",
      "STRIPE_SECRET_KEY",
      "TF_IN_AUTOMATION",
    ]);
  });

  it.each(USER_API_KEY_PROVIDER_IDS)("treats missing business membership as unrestricted for %s", async (provider) => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    addUserProviderKey(db, 7, provider, `${provider}-user-key`);

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv(),
      logger,
      businessId: null,
      ownerUserId: "7",
      selectedModel: MODEL_FOR_PROVIDER[provider],
      sessionId: "sess-unrestricted",
    });

    expect(result.businessId).toBeNull();
    if (provider === "openai") {
      expect(result.envVars.OPENAI_API_KEY).toMatch(/^arc-gw-/);
      expect(result.envVars.ARCANIST_OPENAI_GATEWAY_ENABLED).toBe("1");
      expect(result.envVars.ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE).toBe("user_byok");
      expect([...db.openAIGatewaySessionTokens.values()]).toEqual([
        expect.objectContaining({
          owner_user_id: 7,
          business_id: null,
          credential_source: "user_byok",
          credential_owner_id: "7",
          session_id: "sess-unrestricted",
        }),
      ]);
    } else {
      expect(result.envVars[PROVIDER_ENV_VAR[provider]]).toBe(`${provider}-user-key`);
      expect(db.openAIGatewaySessionTokens.size).toBe(0);
    }
    expect(result.diagnostics.provider.status).toBe("user_key_resolved");
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: provider,
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("uses local .dev.vars provider key fallback when local D1 has no BYOK row", async () => {
    const db = new FakeD1();
    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ WORKER_ENV: "local", OPENAI_API_KEY_INTERNAL_REVIEW: "local-openai-key" }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-local-dev-key",
    });

    expect(result.envVars["OPENAI_API_KEY"]).toBe("local-openai-key");
    expect(result.diagnostics.provider.status).toBe("local_dev_key_resolved");
    expect(result.diagnostics.provider.envInjected).toBe(true);
  });

  it("ignores managed OpenAI virtual keys when BYOK is absent", async () => {
    const db = new FakeD1();
    await addDefaultOpenAIVirtualKey(db, 7, TEST_ENCRYPTION_KEY);

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-managed-virtual-key",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "openai",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
        }),
      ]),
    );
  });

  it("uses BYOK when a managed OpenAI virtual key row also exists", async () => {
    const db = new FakeD1();
    await addDefaultOpenAIVirtualKey(db, 7, TEST_ENCRYPTION_KEY);
    addUserProviderKey(db, 7, "openai", "openai-user-key");

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-byok-with-managed-key-row",
    });

    expect(result.envVars.OPENAI_API_KEY).toMatch(/^arc-gw-/);
    expect(result.envVars.ARCANIST_OPENAI_GATEWAY_ENABLED).toBe("1");
    expect(result.envVars.ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE).toBe("user_byok");
    expect(result.diagnostics.provider.status).toBe("user_key_resolved");
    expect([...db.openAIGatewaySessionTokens.values()]).toEqual([
      expect.objectContaining({
        owner_user_id: 7,
        business_id: null,
        credential_source: "user_byok",
        credential_owner_id: "7",
        session_id: "sess-byok-with-managed-key-row",
      }),
    ]);
  });

  it("uses Codex subscription auth when the explicit selector is enabled", async () => {
    const db = new FakeD1();
    await addDefaultOpenAIVirtualKey(db, 7, TEST_ENCRYPTION_KEY);
    db.businessMembers.set(7, SEEDED_ARCANIST_BUSINESS_ID);
    db.userSettings.set(7, { use_codex_subscription: 1 });
    addUserProviderKey(db, 7, "openai", "openai-user-key");
    db.userIntegrations.set("7:codex_subscription", {
      user_id: 7,
      integration_id: "codex_subscription",
      api_key: await encrypt('{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}', TEST_ENCRYPTION_KEY),
      external_user_id: "auth_json:7",
      encrypted: 1,
    });
    db.userIntegrations.set("7:linear", {
      user_id: 7,
      integration_id: "linear",
      oauth_access_token: await encrypt("linear-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("linear-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    stubLinearProbe();

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: SEEDED_ARCANIST_BUSINESS_ID,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-codex-subscription",
    });

    expect(result.envVars).toEqual({
      [CODEX_SUBSCRIPTION_AUTH_JSON_ENV]: '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}',
      LINEAR_ACCESS_TOKEN: "linear-token",
    });
    expect(result.diagnostics.provider.status).toBe("codex_subscription_resolved");
    expect(result.diagnostics.linear.status).toBe("token_resolved");
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "codex_subscription",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("fails closed without falling back when Codex subscription auth is selected but missing", async () => {
    const db = new FakeD1();
    const expectedSecret = await addDefaultOpenAIVirtualKey(db, 7, TEST_ENCRYPTION_KEY);
    db.businessMembers.set(7, SEEDED_ARCANIST_BUSINESS_ID);
    db.userSettings.set(7, { use_codex_subscription: 1 });
    addUserProviderKey(db, 7, "openai", "openai-user-key");

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: SEEDED_ARCANIST_BUSINESS_ID,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-codex-subscription-missing",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as Error).message).toBe("Codex subscription auth.json is not configured.");
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
    expect(expectedSecret).toBeTruthy();
  });

  it("rejects GPT-5.3 Codex Spark dispatch without Codex subscription auth", async () => {
    const db = new FakeD1();
    await addDefaultOpenAIVirtualKey(db, 7, TEST_ENCRYPTION_KEY);
    db.businessMembers.set(7, SEEDED_ARCANIST_BUSINESS_ID);
    db.userSettings.set(7, { use_codex_subscription: 0 });
    addUserProviderKey(db, 7, "openai", "openai-user-key");

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: SEEDED_ARCANIST_BUSINESS_ID,
      ownerUserId: "7",
      selectedModel: "gpt-5.3-codex-spark",
      sessionId: "sess-codex-spark-byok",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as Error).message).toBe("Codex subscription auth.json is required for this model.");
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("ignores Codex subscription auth for Anthropic models and uses the Anthropic key", async () => {
    const db = new FakeD1();
    db.businessMembers.set(7, SEEDED_ARCANIST_BUSINESS_ID);
    db.userSettings.set(7, { use_codex_subscription: 1 });
    addUserProviderKey(db, 7, "anthropic", "anthropic-user-key");
    db.userIntegrations.set("7:codex_subscription", {
      user_id: 7,
      integration_id: "codex_subscription",
      api_key: await encrypt('{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}', TEST_ENCRYPTION_KEY),
      external_user_id: "auth_json:7",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: SEEDED_ARCANIST_BUSINESS_ID,
      ownerUserId: "7",
      selectedModel: "claude-opus-4-8",
      sessionId: "sess-codex-subscription-anthropic",
    });

    expect(result.envVars).toEqual({
      [PROVIDER_ENV_VAR.anthropic]: "anthropic-user-key",
    });
    expect(result.diagnostics.provider.status).toBe("user_key_resolved");
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("ignores Codex subscription auth for Baseten models and uses the Baseten key", async () => {
    const db = new FakeD1();
    db.businessMembers.set(7, "biz-1");
    db.businessIntegrations.set("biz-1:baseten", {
      business_id: "biz-1",
      integration_id: "baseten",
      scope: "business",
    });
    db.userSettings.set(7, { use_codex_subscription: 1 });
    addUserProviderKey(db, 7, "baseten", "baseten-user-key");
    db.userIntegrations.set("7:codex_subscription", {
      user_id: 7,
      integration_id: "codex_subscription",
      api_key: await encrypt('{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}', TEST_ENCRYPTION_KEY),
      external_user_id: "auth_json:7",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "7",
      selectedModel: "kimi-k2.7-code",
      sessionId: "sess-codex-subscription-baseten",
    });

    expect(result.envVars).toEqual({
      [PROVIDER_ENV_VAR.baseten]: "baseten-user-key",
    });
    expect(result.diagnostics.provider.status).toBe("user_key_resolved");
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("does not fall back to a managed OpenAI virtual key when a user BYOK row is invalid", async () => {
    const db = new BatchedFakeD1();
    await addDefaultOpenAIVirtualKey(db, 7, TEST_ENCRYPTION_KEY);
    addUserProviderKey(db, 7, "openai", "invalid-openai-user-key", CREDENTIAL_VALIDATION_STATUS.INVALID);

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-invalid-user-byok-managed-key",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "openai",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
        }),
      ]),
    );
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("blocks invalid business BYOK rows instead of falling back to managed OpenAI virtual keys", async () => {
    const db = new BatchedFakeD1();
    await addDefaultOpenAIVirtualKey(db, 9, TEST_ENCRYPTION_KEY);
    db.businessMembers.set(9, "biz-1");
    db.businessIntegrations.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      api_key: "invalid-openai-business-key",
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.INVALID,
    });

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "9",
      selectedModel: "gpt-5.4",
      sessionId: "sess-invalid-business-byok-managed-key",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "openai",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
        }),
      ]),
    );
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("ignores managed OpenAI virtual keys even when their stored secret does not match TOKEN_ENCRYPTION_KEY", async () => {
    const db = new FakeD1();
    await addDefaultOpenAIVirtualKey(db, 7, "old-random-compatible-seed");

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: "gpt-5.4",
      sessionId: "sess-managed-key-mismatch",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as Error).message).toBe(
      "No API key configured for OpenAI. Add your OpenAI API key in Settings → API Keys to use gpt-5.4.",
    );
    // The fatal credential failure must still carry a FAILED lifecycle row so
    // the caller can persist it before the spawn aborts.
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "openai",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
        }),
      ]),
    );
  });

  it("carries a provider FAILED lifecycle row when no provider API key is available", async () => {
    const db = new FakeD1();

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv(),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: MODEL_FOR_PROVIDER.anthropic,
      sessionId: "sess-provider-key-missing",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "anthropic",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
        }),
      ]),
    );
  });

  it("carries a TOKEN_REFRESH_FAILED row when provider credential resolution throws", async () => {
    const db = new FakeD1();
    db.throwUserApiKeyFor = "anthropic"; // a non-mismatch error during resolution -> lookup_failed

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv(),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "16",
      selectedModel: MODEL_FOR_PROVIDER.anthropic,
      sessionId: "sess-provider-lookup-failed",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "anthropic",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
        }),
      ]),
    );
  });

  it("carries an INTEGRATION_DISABLED row when the selected provider is disabled for the business", async () => {
    const db = new FakeD1();
    db.businessMembers.set(16, "biz-1");
    // Disable the anthropic integration for the business so the provider drops
    // out of availableIntegrations -> diagnostics status integration_unavailable.
    db.businessIntegrations.set("biz-1:anthropic", {
      business_id: "biz-1",
      integration_id: "anthropic",
      scope: "disabled",
    });

    const error = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv(),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "16",
      selectedModel: MODEL_FOR_PROVIDER.anthropic,
      sessionId: "sess-provider-disabled",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpawnProviderCredentialError);
    expect((error as SpawnProviderCredentialError).lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "anthropic",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.INTEGRATION_DISABLED,
        }),
      ]),
    );
  });

  it.each(BUSINESS_SCOPED_KEY_PROVIDER_IDS)(
    "uses business-managed %s credentials when scope is business",
    async (provider) => {
      const db = new FakeD1();
      const logger = createLoggerSpy();
      db.businessMembers.set(9, "biz-1");
      db.businessIntegrations.set(`biz-1:${provider}`, {
        business_id: "biz-1",
        integration_id: provider,
        scope: "business",
      });
      db.businessCredentials.set(`biz-1:${provider}`, {
        business_id: "biz-1",
        integration_id: provider,
        api_key: `${provider}-business-key`,
        last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
      });

      const result = await resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger,
        businessId: "biz-1",
        ownerUserId: "9",
        selectedModel: MODEL_FOR_PROVIDER[provider],
        sessionId: "sess-business-provider",
      });

      expect(result.businessId).toBe("biz-1");
      expect(result.scopes?.[provider]).toBe("business");
      if (provider === "openai") {
        expect(result.envVars.OPENAI_API_KEY).toMatch(/^arc-gw-/);
        expect(result.envVars.ARCANIST_OPENAI_GATEWAY_ENABLED).toBe("1");
        expect(result.envVars.ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE).toBe("business_byok");
        expect([...db.openAIGatewaySessionTokens.values()]).toEqual([
          expect.objectContaining({
            owner_user_id: 9,
            business_id: "biz-1",
            credential_source: "business_byok",
            credential_owner_id: "biz-1",
            session_id: "sess-business-provider",
          }),
        ]);
      } else {
        expect(result.envVars[PROVIDER_ENV_VAR[provider]]).toBe(`${provider}-business-key`);
        expect(db.openAIGatewaySessionTokens.size).toBe(0);
      }
      expect(result.diagnostics.provider.status).toBe("business_key_resolved");
    },
  );

  it("fails closed when an encrypted business-managed provider key is read without TOKEN_ENCRYPTION_KEY", async () => {
    const db = new BatchedFakeD1();
    const logger = createLoggerSpy();
    db.businessMembers.set(9, "biz-1");
    db.businessIntegrations.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      api_key: await encrypt("openai-business-key", TEST_ENCRYPTION_KEY),
      encrypted: 1,
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    });

    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger,
        businessId: "biz-1",
        ownerUserId: "9",
        selectedModel: "gpt-5.4",
        sessionId: "sess-business-provider-missing-encryption-key",
      }),
    ).rejects.toThrow(
      "No API key configured for OpenAI. Add your OpenAI API key in Settings → API Keys to use gpt-5.4.",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      {
        action: "openai.credential.decrypt_failed",
        reason: "encryption_key_missing",
        credentialScope: "business",
        ownerUserId: "9",
        businessId: "biz-1",
      },
      "Cannot decrypt openai business credential: TOKEN_ENCRYPTION_KEY missing",
    );
  });

  it("fails closed in the non-batched provider path when an encrypted business key is read without TOKEN_ENCRYPTION_KEY", async () => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.businessMembers.set(9, "biz-1");
    db.businessIntegrations.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      api_key: await encrypt("openai-business-key", TEST_ENCRYPTION_KEY),
      encrypted: 1,
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    });

    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger,
        businessId: "biz-1",
        ownerUserId: "9",
        selectedModel: "gpt-5.4",
        sessionId: "sess-non-batched-business-provider-missing-encryption-key",
      }),
    ).rejects.toThrow(
      "No API key configured for OpenAI. Add your OpenAI API key in Settings → API Keys to use gpt-5.4.",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      {
        action: "openai.credential.decrypt_failed",
        reason: "encryption_key_missing",
        credentialScope: "business",
        ownerUserId: "9",
        businessId: "biz-1",
      },
      "Cannot decrypt openai business credential: TOKEN_ENCRYPTION_KEY missing",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-non-batched-business-provider-missing-encryption-key",
        provider: "openai",
      }),
      "Failed to resolve model-provider BYOK credentials for spawn",
    );
  });

  it("threads ownerUserId (and omits businessId) into the user-scope decrypt-failure warn", async () => {
    // C2: a user-scoped credential that cannot be decrypted must carry ownerUserId so an admin can
    // trace whose credentials are inaccessible; businessId is absent for a user-owned credential.
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.userIntegrations.set("7:anthropic", {
      user_id: 7,
      integration_id: "anthropic",
      api_key: await encrypt("anthropic-user-key", TEST_ENCRYPTION_KEY),
      encrypted: 1,
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    });

    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger,
        businessId: null,
        ownerUserId: "7",
        selectedModel: "claude-opus-4-8",
        sessionId: "sess-user-scope-missing-encryption-key",
      }),
    ).rejects.toThrow(/Anthropic/);

    expect(logger.warn).toHaveBeenCalledWith(
      {
        action: "anthropic.credential.decrypt_failed",
        reason: "encryption_key_missing",
        credentialScope: "user",
        ownerUserId: "7",
      },
      "Cannot decrypt anthropic user credential: TOKEN_ENCRYPTION_KEY missing",
    );
  });

  it("fails closed for a claude_code model when no Anthropic key resolves", async () => {
    const db = new FakeD1();
    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger: createLoggerSpy(),
        businessId: null,
        ownerUserId: "7",
        selectedModel: "claude-opus-4-8",
        sessionId: "sess-anthropic-missing",
      }),
    ).rejects.toThrow(/Anthropic/);
  });

  it("uses the local-dev platform Anthropic key for a claude_code model in local mode", async () => {
    const db = new FakeD1();
    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ WORKER_ENV: "local", ARCANIST_ANTHROPIC_API_KEY: "sk-ant-local" }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "7",
      selectedModel: "claude-opus-4-8",
      sessionId: "sess-anthropic-local",
    });

    expect(result.envVars.ANTHROPIC_API_KEY).toBe("sk-ant-local");
    expect(result.envVars.OPENAI_API_KEY).toBeUndefined();
    expect(result.diagnostics.provider.status).toBe("local_dev_key_resolved");
  });

  it("injects business-managed Sentry credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 31, "openai", "openai-user-key");
    db.businessMembers.set(31, "biz-1");
    db.businessIntegrations.set("biz-1:sentry", {
      business_id: "biz-1",
      integration_id: "sentry",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:sentry", {
      business_id: "biz-1",
      integration_id: "sentry",
      api_key: await encrypt("sentry-access-token", TEST_ENCRYPTION_KEY),
      service_url: "acme-org",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "31",
      selectedModel: "gpt-5.4",
      sessionId: "sess-sentry-runtime",
    });

    expect(result.envVars.SENTRY_ACCESS_TOKEN).toBe("sentry-access-token");
    expect(result.envVars.SENTRY_ORGANIZATION_SLUG).toBe("acme-org");
    expect(result.diagnostics.sentry).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "sentry",
          stage: "credential_resolved",
          status: "passed",
        }),
        expect.objectContaining({
          integrationId: "sentry",
          stage: "sandbox_token_prepared",
          status: "passed",
        }),
      ]),
    );
  });

  it("normalizes Sentry service URLs into organization slugs", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 31, "openai", "openai-user-key");
    db.businessMembers.set(31, "biz-1");
    db.businessIntegrations.set("biz-1:sentry", {
      business_id: "biz-1",
      integration_id: "sentry",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:sentry", {
      business_id: "biz-1",
      integration_id: "sentry",
      api_key: await encrypt("sentry-access-token", TEST_ENCRYPTION_KEY),
      service_url: "https://sentry.io/organizations/acme-org/issues/",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "31",
      selectedModel: "gpt-5.4",
      sessionId: "sess-sentry-runtime-url",
    });

    expect(result.envVars.SENTRY_ORGANIZATION_SLUG).toBe("acme-org");
  });

  it("injects business-managed Datadog credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 32, "openai", "openai-user-key");
    db.businessMembers.set(32, "biz-1");
    db.businessIntegrations.set("biz-1:datadog", {
      business_id: "biz-1",
      integration_id: "datadog",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:datadog", {
      business_id: "biz-1",
      integration_id: "datadog",
      api_key: await encrypt("dd-api-key", TEST_ENCRYPTION_KEY),
      oauth_access_token: await encrypt("dd-app-key", TEST_ENCRYPTION_KEY),
      service_url: "us5.datadoghq.com",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "32",
      selectedModel: "gpt-5.4",
      sessionId: "sess-datadog-runtime",
    });

    expect(result.envVars).toMatchObject({
      DD_API_KEY: "dd-api-key",
      DD_APP_KEY: "dd-app-key",
      DD_SITE: "us5.datadoghq.com",
    });
    expect(result.diagnostics.datadog).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "datadog",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("fails closed for unsupported Datadog sites in stored business credentials", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 32, "openai", "openai-user-key");
    db.businessMembers.set(32, "biz-1");
    db.businessIntegrations.set("biz-1:datadog", {
      business_id: "biz-1",
      integration_id: "datadog",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:datadog", {
      business_id: "biz-1",
      integration_id: "datadog",
      api_key: await encrypt("dd-api-key", TEST_ENCRYPTION_KEY),
      oauth_access_token: await encrypt("dd-app-key", TEST_ENCRYPTION_KEY),
      service_url: "https://evil.example.com",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "32",
      selectedModel: "gpt-5.4",
      sessionId: "sess-datadog-runtime-invalid-site",
    });

    expect(result.envVars.DD_API_KEY).toBeUndefined();
    expect(result.envVars.DD_APP_KEY).toBeUndefined();
    expect(result.envVars.DD_SITE).toBeUndefined();
    expect(result.diagnostics.datadog).toMatchObject({
      available: true,
      scope: "business",
      envInjected: false,
      status: "credentials_missing",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "datadog",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: "token_missing",
        }),
      ]),
    );
  });

  it("injects business-managed LaunchDarkly credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 32, "openai", "openai-user-key");
    db.businessMembers.set(32, "biz-1");
    db.businessIntegrations.set("biz-1:launchdarkly", {
      business_id: "biz-1",
      integration_id: "launchdarkly",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:launchdarkly", {
      business_id: "biz-1",
      integration_id: "launchdarkly",
      api_key: await encrypt("launchdarkly-access-token", TEST_ENCRYPTION_KEY),
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "32",
      selectedModel: "gpt-5.4",
      sessionId: "sess-launchdarkly-runtime",
    });

    expect(result.envVars).toMatchObject({
      LAUNCHDARKLY_ACCESS_TOKEN: "launchdarkly-access-token",
    });
    expect(result.diagnostics.launchdarkly).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "launchdarkly",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it.each([
    {
      integrationId: "sentry",
      envKeys: ["SENTRY_ACCESS_TOKEN", "SENTRY_ORGANIZATION_SLUG"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: "acme-org",
      },
    },
    {
      integrationId: "datadog",
      envKeys: ["DD_API_KEY", "DD_APP_KEY", "DD_SITE"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: "us5.datadoghq.com",
      },
    },
    {
      integrationId: "launchdarkly",
      envKeys: ["LAUNCHDARKLY_ACCESS_TOKEN"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: null,
      },
    },
    {
      integrationId: "cloudflare",
      envKeys: ["CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: "11111111-2222-3333-4444-555555555555",
      },
    },
    {
      integrationId: "braintrust",
      envKeys: ["BRAINTRUST_INTEGRATION_API_KEY", "BRAINTRUST_INTEGRATION_API_URL"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: "https://api.braintrust.dev",
      },
    },
    {
      integrationId: "stripe",
      envKeys: ["STRIPE_SECRET_KEY"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: null,
      },
    },
    {
      integrationId: "terraform",
      envKeys: ["ARCANIST_TERRAFORM_PLAN_TOKEN"],
      row: {
        api_key: null,
        oauth_access_token: null,
        service_url: null,
      },
    },
  ] as const)(
    "fails closed when encrypted $integrationId business credentials are read without TOKEN_ENCRYPTION_KEY",
    async ({ integrationId, envKeys, row }) => {
      const db = new BatchedFakeD1();
      const logger = createLoggerSpy();
      addUserProviderKey(db, 35, "openai", "openai-user-key");
      db.businessMembers.set(35, "biz-1");
      db.businessIntegrations.set(`biz-1:${integrationId}`, {
        business_id: "biz-1",
        integration_id: integrationId,
        scope: "business",
      });
      db.businessCredentials.set(`biz-1:${integrationId}`, {
        business_id: "biz-1",
        integration_id: integrationId,
        api_key: await encrypt(`${integrationId}-api-key`, TEST_ENCRYPTION_KEY),
        oauth_access_token:
          integrationId === "sentry" || integrationId === "braintrust" || integrationId === "stripe"
            ? null
            : await encrypt(`${integrationId}-secondary-secret`, TEST_ENCRYPTION_KEY),
        service_url: row.service_url,
        encrypted: 1,
      });

      const result = await resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger,
        businessId: "biz-1",
        ownerUserId: "35",
        selectedModel: "gpt-5.4",
        sessionId: `sess-${integrationId}-missing-encryption-key`,
      });

      for (const envKey of envKeys) {
        expect(result.envVars[envKey]).toBeUndefined();
      }
      expect(result.diagnostics[integrationId]).toMatchObject({
        available: true,
        scope: "business",
        envInjected: false,
        status: "credentials_missing",
      });
      expect(logger.warn).toHaveBeenCalledWith(
        {
          action: `${integrationId}.credential.decrypt_failed`,
          reason: "encryption_key_missing",
          credentialScope: "business",
          // Business-only integrations carry the businessId correlation but no ownerUserId
          // (the credential is owned by the business, not a user). C2.
          businessId: "biz-1",
        },
        `Cannot decrypt ${integrationId} business credential: TOKEN_ENCRYPTION_KEY missing`,
      );
    },
  );

  it("injects business-managed Cloudflare D1 credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 41, "openai", "openai-user-key");
    db.businessMembers.set(41, "biz-1");
    db.businessIntegrations.set("biz-1:cloudflare", {
      business_id: "biz-1",
      integration_id: "cloudflare",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:cloudflare", {
      business_id: "biz-1",
      integration_id: "cloudflare",
      // api_key carries the token, oauth_access_token the account ID (both encrypted),
      // service_url the plaintext database ID.
      api_key: await encrypt("cf-token", TEST_ENCRYPTION_KEY),
      oauth_access_token: await encrypt("0123456789abcdef0123456789abcdef", TEST_ENCRYPTION_KEY),
      service_url: "11111111-2222-3333-4444-555555555555",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "41",
      selectedModel: "gpt-5.4",
      sessionId: "sess-cloudflare-runtime",
    });

    expect(result.envVars).toMatchObject({
      CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CF_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
      CF_API_TOKEN: "cf-token",
    });
    expect(result.diagnostics.cloudflare).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integrationId: "cloudflare", stage: "credential_resolved", status: "passed" }),
      ]),
    );
  });

  it("fails closed for malformed Cloudflare D1 identifiers in stored business credentials", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 41, "openai", "openai-user-key");
    db.businessMembers.set(41, "biz-1");
    db.businessIntegrations.set("biz-1:cloudflare", {
      business_id: "biz-1",
      integration_id: "cloudflare",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:cloudflare", {
      business_id: "biz-1",
      integration_id: "cloudflare",
      api_key: await encrypt("cf-token", TEST_ENCRYPTION_KEY),
      oauth_access_token: await encrypt("not-a-valid-account-id", TEST_ENCRYPTION_KEY),
      service_url: "also-not-a-uuid",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "41",
      selectedModel: "gpt-5.4",
      sessionId: "sess-cloudflare-runtime-invalid",
    });

    expect(result.envVars.CF_ACCOUNT_ID).toBeUndefined();
    expect(result.envVars.CF_D1_DATABASE_ID).toBeUndefined();
    expect(result.envVars.CF_API_TOKEN).toBeUndefined();
    expect(result.diagnostics.cloudflare).toMatchObject({
      available: true,
      scope: "business",
      envInjected: false,
      status: "credentials_missing",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integrationId: "cloudflare", stage: "credential_resolved", status: "failed" }),
      ]),
    );
  });

  it("injects business-managed Braintrust credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 33, "openai", "openai-user-key");
    db.businessMembers.set(33, "biz-1");
    db.businessIntegrations.set("biz-1:braintrust", {
      business_id: "biz-1",
      integration_id: "braintrust",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:braintrust", {
      business_id: "biz-1",
      integration_id: "braintrust",
      api_key: await encrypt("braintrust-api-key", TEST_ENCRYPTION_KEY),
      service_url: "https://api-eu.braintrust.dev/",
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "33",
      selectedModel: "gpt-5.4",
      sessionId: "sess-braintrust-runtime",
    });

    expect(result.envVars).toMatchObject({
      BRAINTRUST_INTEGRATION_API_KEY: "braintrust-api-key",
      BRAINTRUST_INTEGRATION_API_URL: "https://api-eu.braintrust.dev",
    });
    expect(result.diagnostics.braintrust).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "braintrust",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("injects business-managed Stripe credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 36, "openai", "openai-user-key");
    db.businessMembers.set(36, "biz-1");
    db.businessIntegrations.set("biz-1:stripe", {
      business_id: "biz-1",
      integration_id: "stripe",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:stripe", {
      business_id: "biz-1",
      integration_id: "stripe",
      api_key: await encrypt("sk_test_1234567890", TEST_ENCRYPTION_KEY),
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "36",
      selectedModel: "gpt-5.4",
      sessionId: "sess-stripe-runtime",
    });

    expect(result.envVars).toMatchObject({
      STRIPE_SECRET_KEY: "sk_test_1234567890",
    });
    expect(result.diagnostics.stripe).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "stripe",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("injects business-managed Terraform Cloud credentials into the spawn runtime", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 34, "openai", "openai-user-key");
    db.businessMembers.set(34, "biz-1");
    db.businessIntegrations.set("biz-1:terraform", {
      business_id: "biz-1",
      integration_id: "terraform",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:terraform", {
      business_id: "biz-1",
      integration_id: "terraform",
      api_key: await encrypt("terraform-cloud-token", TEST_ENCRYPTION_KEY),
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "34",
      selectedModel: "gpt-5.4",
      sessionId: "sess-terraform-runtime",
    });

    expect(result.envVars).toMatchObject({
      ARCANIST_TERRAFORM_PLAN_TOKEN: "terraform-cloud-token",
      TF_IN_AUTOMATION: "1",
    });
    expect(result.envVars.TF_TOKEN_app_terraform_io).toBeUndefined();
    expect(result.diagnostics.terraform).toMatchObject({
      available: true,
      scope: "business",
      envInjected: true,
      status: "credentials_resolved",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "terraform",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("does not inject Terraform Cloud env vars when the business credential is empty", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 34, "openai", "openai-user-key");
    db.businessMembers.set(34, "biz-1");
    db.businessIntegrations.set("biz-1:terraform", {
      business_id: "biz-1",
      integration_id: "terraform",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:terraform", {
      business_id: "biz-1",
      integration_id: "terraform",
      api_key: "   ",
      encrypted: 0,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: "biz-1",
      ownerUserId: "34",
      selectedModel: "gpt-5.4",
      sessionId: "sess-terraform-runtime-empty",
    });

    expect(result.envVars.ARCANIST_TERRAFORM_PLAN_TOKEN).toBeUndefined();
    expect(result.envVars.TF_IN_AUTOMATION).toBeUndefined();
    expect(result.envVars.TF_TOKEN_app_terraform_io).toBeUndefined();
    expect(result.diagnostics.terraform).toMatchObject({
      available: true,
      scope: "business",
      envInjected: false,
      status: "credentials_missing",
    });
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "terraform",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: "token_missing",
        }),
      ]),
    );
  });

  it("fails closed when business integration context lookup fails", async () => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.throwIntegrationScopesForBusinessId = "biz-1";

    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv({ ARCANIST_OPENAI_API_KEY: "platform-openai-key" }),
        logger,
        businessId: "biz-1",
        ownerUserId: "10",
        selectedModel: "gpt-5.4",
        sessionId: "sess-context-lookup-failure",
      }),
    ).rejects.toThrow("forced business integration scope lookup failure");

    expect(logger.warn).toHaveBeenCalledWith(
      {
        sessionId: "sess-context-lookup-failure",
        ownerUserId: "10",
        error: "Error: forced business integration scope lookup failure",
      },
      "Failed to resolve business integration context for spawn",
    );
  });

  it("fails when OpenAI BYOK lookup fails even if a platform key exists", async () => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.throwUserApiKeyFor = "openai";

    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv({ ARCANIST_OPENAI_API_KEY: "platform-openai-key" }),
        logger,
        businessId: null,
        ownerUserId: "13",
        selectedModel: "gpt-5.4",
        sessionId: "sess-platform-fallback",
      }),
    ).rejects.toThrow(
      "No API key configured for OpenAI. Add your OpenAI API key in Settings → API Keys to use gpt-5.4.",
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("fails when OpenAI resolution cannot find credentials", async () => {
    const db = new FakeD1();
    db.throwUserApiKeyFor = "openai";

    await expect(
      resolveSpawnIntegrationRuntime({
        db: db as unknown as D1Database,
        env: createEnv(),
        logger: createLoggerSpy(),
        businessId: null,
        ownerUserId: "15",
        selectedModel: "gpt-5.4",
        sessionId: "sess-provider-missing",
      }),
    ).rejects.toThrow(
      "No API key configured for OpenAI. Add your OpenAI API key in Settings → API Keys to use gpt-5.4.",
    );
  });

  it("decrypts encrypted Linear rows from the batched spawn snapshot", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 21, "openai", "openai-user-key");
    db.userIntegrations.set("21:linear", {
      user_id: 21,
      integration_id: "linear",
      oauth_access_token: await encrypt("linear-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("linear-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    stubLinearProbe();

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "21",
      selectedModel: "gpt-5.4",
      sessionId: "sess-linear-encrypted",
    });

    expect(result.envVars["LINEAR_ACCESS_TOKEN"]).toBe("linear-token");
    expect(result.diagnostics.linear.status).toBe("token_resolved");
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "linear",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("injects Jira token, cloud ID, site URL, and default trigger label from the batched spawn snapshot", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 31, "openai", "openai-user-key");
    db.userIntegrations.set("31:jira", {
      user_id: 31,
      integration_id: "jira",
      oauth_access_token: await encrypt("jira-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("jira-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    db.jiraUserSites.set(31, {
      user_id: 31,
      jira_cloud_id: "cloud-31",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      jira_account_id: "acct-31",
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "31",
      selectedModel: "gpt-5.4",
      sessionId: "sess-jira-encrypted",
    });

    expect(result.envVars["JIRA_ACCESS_TOKEN"]).toBe("jira-token");
    expect(result.envVars["JIRA_CLOUD_ID"]).toBe("cloud-31");
    expect(result.envVars["JIRA_SITE_URL"]).toBe("https://acme.atlassian.net");
    expect(result.envVars["JIRA_TRIGGER_LABEL"]).toBe(DEFAULT_JIRA_TRIGGER_LABEL);
    expect(result.diagnostics.jira.status).toBe("token_resolved");
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "jira",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("prefers the Jira installation's stored trigger label over the env default", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 33, "openai", "openai-user-key");
    db.businessMembers.set(33, "biz-33");
    db.userIntegrations.set("33:jira", {
      user_id: 33,
      integration_id: "jira",
      oauth_access_token: await encrypt("jira-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("jira-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    db.jiraUserSites.set(33, {
      user_id: 33,
      jira_cloud_id: "cloud-33",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      jira_account_id: "acct-33",
    });
    addJiraWebhookInstallation(db, "biz-33", "cloud-33", "Deploy-Bot");
    // A second installation on another site with a different label must not win.
    addJiraWebhookInstallation(db, "biz-33", "cloud-other", "other-site-label");

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, JIRA_TRIGGER_LABEL: "cycloid" }),
      logger: createLoggerSpy(),
      businessId: "biz-33",
      ownerUserId: "33",
      selectedModel: "gpt-5.4",
      sessionId: "sess-jira-stored-label",
    });

    expect(result.envVars["JIRA_TRIGGER_LABEL"]).toBe("deploy-bot");
  });

  it("ignores installations for other Jira sites when resolving the trigger label", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 35, "openai", "openai-user-key");
    db.businessMembers.set(35, "biz-35");
    db.userIntegrations.set("35:jira", {
      user_id: 35,
      integration_id: "jira",
      oauth_access_token: await encrypt("jira-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("jira-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    db.jiraUserSites.set(35, {
      user_id: 35,
      jira_cloud_id: "cloud-35",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      jira_account_id: "acct-35",
    });
    // Only installation belongs to a different site; its label must not leak in.
    addJiraWebhookInstallation(db, "biz-35", "cloud-other", "other-site-label");

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, JIRA_TRIGGER_LABEL: "cycloid" }),
      logger: createLoggerSpy(),
      businessId: "biz-35",
      ownerUserId: "35",
      selectedModel: "gpt-5.4",
      sessionId: "sess-jira-other-site",
    });

    expect(result.envVars["JIRA_TRIGGER_LABEL"]).toBe("cycloid");
  });

  it("falls back to the env trigger label when the only Jira installation is revoked", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 34, "openai", "openai-user-key");
    db.businessMembers.set(34, "biz-34");
    db.userIntegrations.set("34:jira", {
      user_id: 34,
      integration_id: "jira",
      oauth_access_token: await encrypt("jira-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("jira-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });
    db.jiraUserSites.set(34, {
      user_id: 34,
      jira_cloud_id: "cloud-34",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      jira_account_id: "acct-34",
    });
    addJiraWebhookInstallation(db, "biz-34", "cloud-34", "stale-label", "revoked");

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, JIRA_TRIGGER_LABEL: "Custom" }),
      logger: createLoggerSpy(),
      businessId: "biz-34",
      ownerUserId: "34",
      selectedModel: "gpt-5.4",
      sessionId: "sess-jira-revoked-install",
    });

    expect(result.envVars["JIRA_TRIGGER_LABEL"]).toBe("custom");
  });

  it("does not inject Jira env when the user has no site selection", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 32, "openai", "openai-user-key");
    db.userIntegrations.set("32:jira", {
      user_id: 32,
      integration_id: "jira",
      oauth_access_token: await encrypt("jira-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("jira-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "32",
      selectedModel: "gpt-5.4",
      sessionId: "sess-jira-no-site",
    });

    expect(result.envVars["JIRA_ACCESS_TOKEN"]).toBeUndefined();
    expect(result.envVars["JIRA_CLOUD_ID"]).toBeUndefined();
    expect(result.diagnostics.jira.status).toBe("site_missing");
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integrationId: "jira", status: "failed", reasonCode: "site_not_selected" }),
      ]),
    );
  });

  it("reports token_missing when Jira has no stored credential", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 33, "openai", "openai-user-key");

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "33",
      selectedModel: "gpt-5.4",
      sessionId: "sess-jira-missing",
    });

    expect(result.envVars["JIRA_ACCESS_TOKEN"]).toBeUndefined();
    expect(result.diagnostics.jira.status).toBe("token_missing");
  });

  it("fails closed for encrypted Linear snapshot rows when TOKEN_ENCRYPTION_KEY is missing", async () => {
    const db = new BatchedFakeD1();
    const logger = createLoggerSpy();
    addUserProviderKey(db, 23, "openai", "openai-user-key");
    db.userIntegrations.set("23:linear", {
      user_id: 23,
      integration_id: "linear",
      oauth_access_token: await encrypt("linear-token", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv(),
      logger,
      businessId: null,
      ownerUserId: "23",
      selectedModel: "gpt-5.4",
      sessionId: "sess-linear-missing-key",
    });

    expect(result.envVars["LINEAR_ACCESS_TOKEN"]).toBeUndefined();
    expect(result.diagnostics.linear.status).toBe("lookup_failed");
    expect(logger.warn).toHaveBeenCalled();
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "linear",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: "token_refresh_failed",
        }),
      ]),
    );
  });

  it("read-repairs plaintext legacy Linear snapshot rows before injecting the token", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 25, "openai", "openai-user-key");
    db.userIntegrations.set("25:linear", {
      user_id: 25,
      integration_id: "linear",
      oauth_access_token: "linear-token",
      oauth_refresh_token: "linear-refresh",
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 0,
    });
    stubLinearProbe();

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "25",
      selectedModel: "gpt-5.4",
      sessionId: "sess-linear-read-repair",
    });

    const row = db.userIntegrations.get("25:linear");
    expect(result.envVars["LINEAR_ACCESS_TOKEN"]).toBe("linear-token");
    expect(row?.encrypted).toBe(1);
    expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
  });

  it("injects a valid Notion token from the batched spawn snapshot", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 27, "openai", "openai-user-key");
    db.userIntegrations.set("27:notion", {
      user_id: 27,
      integration_id: "notion",
      oauth_access_token: await encrypt("notion-token", TEST_ENCRYPTION_KEY),
      oauth_refresh_token: await encrypt("notion-refresh", TEST_ENCRYPTION_KEY),
      oauth_expires_at: Date.now() + 60 * 60 * 1000,
      encrypted: 1,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "27",
      selectedModel: "gpt-5.4",
      sessionId: "sess-notion-encrypted",
    });

    expect(result.envVars["NOTION_ACCESS_TOKEN"]).toBe("notion-token");
    expect(result.diagnostics.notion.status).toBe("token_resolved");
    expect(result.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: "notion",
          stage: "credential_resolved",
          status: "passed",
        }),
      ]),
    );
  });

  it("read-repairs plaintext legacy Notion snapshot rows before injecting the token", async () => {
    const db = new BatchedFakeD1();
    addUserProviderKey(db, 29, "openai", "openai-user-key");
    db.userIntegrations.set("29:notion", {
      user_id: 29,
      integration_id: "notion",
      oauth_access_token: "notion-token",
      oauth_refresh_token: null,
      oauth_expires_at: null,
      encrypted: 0,
    });

    const result = await resolveSpawnIntegrationRuntime({
      db: db as unknown as D1Database,
      env: createEnv({ TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      logger: createLoggerSpy(),
      businessId: null,
      ownerUserId: "29",
      selectedModel: "gpt-5.4",
      sessionId: "sess-notion-read-repair",
    });

    const row = db.userIntegrations.get("29:notion");
    expect(result.envVars["NOTION_ACCESS_TOKEN"]).toBe("notion-token");
    expect(row?.encrypted).toBe(1);
    expect(row?.oauth_access_token?.startsWith("enc:")).toBe(true);
  });
});

describe("resolveAppRuntimeLlmKey (customer app runtime BYOK fallback)", () => {
  it("returns the raw business key for openai, never a gateway token", async () => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.businessMembers.set(9, "biz-1");
    db.businessIntegrations.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:openai", {
      business_id: "biz-1",
      integration_id: "openai",
      api_key: "openai-business-key",
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    });

    const key = await resolveAppRuntimeLlmKey(db as unknown as D1Database, {
      ownerUserId: "9",
      businessId: "biz-1",
      provider: "openai",
      encryptionKey: undefined,
      logger,
    });

    expect(key).toBe("openai-business-key");
    expect(db.openAIGatewaySessionTokens.size).toBe(0);
  });

  it("never falls back to the session owner's personal key when scope is not business", async () => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.businessMembers.set(9, "biz-1");
    // Default (user) scope + a personal key present: the source promised the
    // BUSINESS key, so this must resolve null, not the user's key.
    db.userIntegrations.set("9:openai", {
      user_id: 9,
      integration_id: "openai",
      api_key: "personal-user-key",
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    });

    const key = await resolveAppRuntimeLlmKey(db as unknown as D1Database, {
      ownerUserId: "9",
      businessId: "biz-1",
      provider: "openai",
      encryptionKey: undefined,
      logger,
    });

    expect(key).toBeNull();
  });

  it("returns null when the business has no runnable provider key", async () => {
    const db = new FakeD1();
    const logger = createLoggerSpy();
    db.businessMembers.set(9, "biz-1");

    const key = await resolveAppRuntimeLlmKey(db as unknown as D1Database, {
      ownerUserId: "9",
      businessId: "biz-1",
      provider: "anthropic",
      encryptionKey: undefined,
      logger,
    });

    expect(key).toBeNull();
  });
});
