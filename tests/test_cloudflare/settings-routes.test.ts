import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { modelsCacheKey } from "../../apps/control-plane-worker/src/services/bootstrap";
import { getSettingsPayload, updateSettingsPayload } from "../../apps/control-plane-worker/src/settings/service";
import type { PlanModeSetting } from "../../shared/plan-mode";
import { BaseFakeD1Statement } from "./helpers/fake-d1";
import { createWorkerTestEnv } from "./helpers/worker-env";
import {
  createDurableNamespace,
  FakeKV,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "./helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

// ---------------------------------------------------------------------------
// Fake storage and D1 (following control-plane-worker.test.ts patterns)
// ---------------------------------------------------------------------------

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
};

interface UserSettingsRow {
  user_id: number;
  default_pr_draft: number;
  auto_verify_enabled: number;
  automatic_reviews_enabled: number;
  plan_mode_setting?: PlanModeSetting;
  plan_approval_required?: number | null;
  settings_profile?: "manual" | "autonomous" | "custom" | null;
  use_codex_subscription: number;
  default_model: string | null;
  default_repo: string | null;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  id: number;
  openai_api_key: string | null;
  github_token: string | null;
}

interface IntegrationRow {
  integration_id: string;
  api_key: string | null;
  external_user_id?: string | null;
  encrypted?: number | null;
  last_validated_at?: number | null;
  last_validation_status?: string | null;
  last_validation_reason_code?: string | null;
}

interface OpenAIVirtualKeyRow {
  id: string;
  key_hash: string;
  owner_user_id: string;
  business_id: string | null;
  monthly_limit_usd_micros: number;
  status: string;
  created_at: number;
  updated_at: number;
}

interface OpenAIGatewayLedgerRow {
  id: string;
  virtual_key_id: string;
  owner_user_id: string;
  business_id: string | null;
  lifecycle_status: "reserved" | "settled" | "released" | "settlement_unresolved";
  reserved_cost_usd_micros: number;
  actual_cost_usd_micros: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  created_at: number;
}

// Prod Cycloid business UUID; migration 0255 seeds codex_byos_enabled=1 for it, so
// the fake DB mirrors that. Single source of truth = the shared constant.
const SEEDED_ARCANIST_BUSINESS_ID = SEEDED_BUSINESS_IDS.cycloid;

class FakeD1Statement extends BaseFakeD1Statement<FakeD1> {
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    // Session webhook refs / idempotency / slack thread / linear tables
    if (this.isSchemaQuery()) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_index")) {
      const [sessionId, ownerUserId, businessId, status, createdAt, updatedAt, closedAt, lastEventId] = this
        .boundValues as [string, string, string | null, string, string, string, string | null, string | null];
      const resolvedBusinessId = businessId ?? this.db.businessMembers.get(Number(ownerUserId)) ?? null;
      this.db.sessionIndex.set(sessionId, {
        session_id: sessionId,
        owner_user_id: ownerUserId,
        business_id: resolvedBusinessId,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        closed_at: closedAt,
        last_event_id: lastEventId,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_webhook_refs")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO user_settings")) {
      // `INSERT ... SELECT id, ?, ... FROM users WHERE id = ?` binds the user
      // id LAST. No `users` row → the SELECT matches nothing → fail closed.
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      if (!this.db.users.has(userId)) {
        return { success: true, meta: { last_row_id: 0 } };
      }
      const hasPlanMode = this.query.includes("plan_mode_setting");
      const [default_pr_draft, auto_verify_enabled, automatic_reviews_enabled] = this.boundValues as [
        number,
        number,
        number,
      ];
      const plan_mode_setting = hasPlanMode ? (this.boundValues[3] as PlanModeSetting) : undefined;
      const plan_approval_required = hasPlanMode ? (this.boundValues[4] as number | null) : null;
      const settings_profile = hasPlanMode ? (this.boundValues[5] as "manual" | "autonomous" | "custom" | null) : null;
      const use_codex_subscription = this.boundValues[hasPlanMode ? 6 : 5] as number;
      const default_model = this.boundValues[hasPlanMode ? 7 : 6] as string | null;
      const default_repo = this.boundValues[hasPlanMode ? 8 : 7] as string | null;
      const createdAt = this.boundValues[hasPlanMode ? 9 : 8] as number;
      const updatedAt = this.boundValues[hasPlanMode ? 10 : 9] as number;
      this.db.userSettings.set(userId, {
        user_id: userId,
        default_pr_draft,
        auto_verify_enabled,
        automatic_reviews_enabled,
        plan_mode_setting,
        plan_approval_required,
        settings_profile,
        use_codex_subscription,
        default_model,
        default_repo,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE user_settings SET")) {
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const row = this.db.userSettings.get(userId);
      if (row) {
        const setClauses = this.query.match(/SET (.+?) WHERE/)?.[1] || "";
        const fields = setClauses.split(",").map((s) => s.trim().split(" = ")[0]);
        let valueIdx = 0;
        for (const field of fields) {
          if (field === "default_pr_draft") row.default_pr_draft = this.boundValues[valueIdx] as number;
          if (field === "auto_verify_enabled") row.auto_verify_enabled = this.boundValues[valueIdx] as number;
          if (field === "automatic_reviews_enabled")
            row.automatic_reviews_enabled = this.boundValues[valueIdx] as number;
          if (field === "plan_mode_setting") row.plan_mode_setting = this.boundValues[valueIdx] as PlanModeSetting;
          if (field === "plan_approval_required")
            row.plan_approval_required = this.boundValues[valueIdx] as number | null;
          if (field === "use_codex_subscription") row.use_codex_subscription = this.boundValues[valueIdx] as number;
          if (field === "default_model") row.default_model = this.boundValues[valueIdx] as string | null;
          if (field === "default_repo") row.default_repo = this.boundValues[valueIdx] as string | null;
          if (field === "updated_at") row.updated_at = this.boundValues[valueIdx] as number;
          valueIdx++;
        }
        this.db.userSettings.set(userId, row);
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    // user_integrations: connectIntegration / disconnectIntegration
    if (this.query.includes("INSERT INTO user_integrations")) {
      const [
        userId,
        integrationId,
        ,
        ,
        ,
        apiKey,
        externalUserId,
        ,
        encrypted,
        lastValidatedAt,
        lastValidationStatus,
        lastValidationReasonCode,
      ] = this.boundValues as [
        number,
        string,
        unknown,
        unknown,
        unknown,
        string | null,
        unknown,
        unknown,
        unknown,
        number | null,
        string | null,
        string | null,
        number,
        number,
      ];
      this.db.integrationRows.set(`${userId}:${integrationId}`, {
        integration_id: integrationId,
        api_key: apiKey,
        external_user_id: externalUserId as string | null,
        encrypted: encrypted as number | null,
        last_validated_at: lastValidatedAt,
        last_validation_status: lastValidationStatus,
        last_validation_reason_code: lastValidationReasonCode,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM user_integrations")) {
      const [userId, integrationId] = this.boundValues as [number, string];
      this.db.integrationRows.delete(`${userId}:${integrationId}`);
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE users SET")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM session_index")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM session_index")) {
      const rows = [...this.db.sessionIndex.values()];
      return { results: rows };
    }

    // user_settings: batch query path
    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userSettings.get(userId);
      return { results: row ? [row as unknown as Record<string, unknown>] : [] };
    }

    // user_integrations: getProviderKeyStatus / getProviderKeyStates
    if (this.query.includes("FROM user_integrations")) {
      const userId = Number(this.boundValues[0]);
      const results: Array<Record<string, unknown>> = [];
      for (const [key, row] of this.db.integrationRows) {
        if (key.startsWith(`${userId}:`)) {
          results.push({
            integration_id: row.integration_id,
            api_key: row.api_key ?? null,
            external_user_id: row.external_user_id ?? null,
            encrypted: row.encrypted ?? null,
            last_validated_at: row.last_validated_at ?? null,
            last_validation_status: row.last_validation_status ?? null,
            last_validation_reason_code: row.last_validation_reason_code ?? null,
          });
        }
      }
      return { results };
    }

    // business_integrations
    if (this.query.includes("FROM business_integrations")) {
      return { results: [] };
    }

    if (this.query.includes("FROM business_integration_credentials")) {
      return { results: [] };
    }

    if (this.query.includes("FROM business_members")) {
      const [userId] = this.boundValues as [number];
      const businessId = this.db.businessMembers.get(userId);
      return { results: businessId ? [{ business_id: businessId }] : [] };
    }

    // businesses: Codex BYOS capability read via batch (model-availability path).
    if (this.query.includes("FROM businesses") && this.query.includes("codex_byos_enabled")) {
      const [businessId] = this.boundValues as [string];
      const enabled = businessId === SEEDED_ARCANIST_BUSINESS_ID || this.db.codexByosBusinessIds.has(businessId);
      return { results: [{ codex_byos_enabled: enabled ? 1 : 0 }] };
    }

    if (this.query.includes("FROM openai_virtual_keys") && this.query.includes("ORDER BY created_at ASC")) {
      const [ownerUserId] = this.boundValues as [string];
      return {
        results: this.db.openAIVirtualKeys
          .filter((row) => row.owner_user_id === ownerUserId)
          .sort((a, b) => a.created_at - b.created_at)
          .map(({ id, status, monthly_limit_usd_micros, created_at, updated_at }) => ({
            id,
            status,
            monthly_limit_usd_micros,
            created_at,
            updated_at,
          })),
      };
    }

    if (this.query.includes("SELECT id FROM openai_virtual_keys")) {
      const [ownerUserId] = this.boundValues as [string];
      const row = this.db.openAIVirtualKeys.find((key) => key.owner_user_id === ownerUserId && key.status === "active");
      return { results: row ? [{ id: row.id }] : [] };
    }

    if (this.query.includes("FROM openai_gateway_ledger")) {
      const [ownerUserId, periodStartMs, periodEndMs] = this.boundValues as [string, number, number];
      const rows = this.db.openAIGatewayLedger.filter(
        (row) => row.owner_user_id === ownerUserId && row.created_at >= periodStartMs && row.created_at < periodEndMs,
      );
      const sum = (selector: (row: OpenAIGatewayLedgerRow) => number): number =>
        rows.reduce((total, row) => total + selector(row), 0);
      return {
        results: [
          {
            settled_cost_usd_micros: sum((row) =>
              row.lifecycle_status === "settled" ? (row.actual_cost_usd_micros ?? 0) : 0,
            ),
            reserved_cost_usd_micros: sum((row) =>
              row.lifecycle_status === "reserved" ? row.reserved_cost_usd_micros : 0,
            ),
            settled_request_count: sum((row) => (row.lifecycle_status === "settled" ? 1 : 0)),
            reserved_request_count: sum((row) => (row.lifecycle_status === "reserved" ? 1 : 0)),
            released_request_count: sum((row) => (row.lifecycle_status === "released" ? 1 : 0)),
            settlement_unresolved_request_count: sum((row) =>
              row.lifecycle_status === "settlement_unresolved" ? 1 : 0,
            ),
            input_tokens: sum((row) => (row.lifecycle_status === "settled" ? (row.input_tokens ?? 0) : 0)),
            cached_input_tokens: sum((row) =>
              row.lifecycle_status === "settled" ? (row.cached_input_tokens ?? 0) : 0,
            ),
            output_tokens: sum((row) => (row.lifecycle_status === "settled" ? (row.output_tokens ?? 0) : 0)),
            reasoning_output_tokens: sum((row) =>
              row.lifecycle_status === "settled" ? (row.reasoning_output_tokens ?? 0) : 0,
            ),
          },
        ],
      };
    }

    if (this.query.includes("FROM openai_virtual_keys") && this.query.includes("status = 'active'")) {
      const [ownerUserId] = this.boundValues as [string];
      return {
        results: [
          {
            monthly_limit_usd_micros: this.db.openAIVirtualKeys
              .filter((row) => row.owner_user_id === ownerUserId && row.status === "active")
              .reduce((total, row) => total + row.monthly_limit_usd_micros, 0),
          },
        ],
      };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const user = this.db.authTokens.get(token);
      return user ?? null;
    }

    if (this.query.includes("FROM durable_event_replay_metadata")) {
      return null;
    }

    // user_integrations: Codex subscription metadata state
    if (
      this.query.includes("FROM user_integrations") &&
      this.query.includes("external_user_id") &&
      this.query.includes("last_validation_reason_code")
    ) {
      const [userId, integrationId] = this.boundValues as [number, string];
      const row = this.db.integrationRows.get(`${userId}:${integrationId}`);
      if (!row) return null;
      return {
        api_key: row.api_key,
        external_user_id: row.external_user_id ?? null,
        encrypted: row.encrypted ?? null,
        last_validated_at: row.last_validated_at ?? null,
        last_validation_status: row.last_validation_status ?? null,
        last_validation_reason_code: row.last_validation_reason_code ?? null,
      };
    }

    // user_integrations: getUserApiKey
    if (
      this.query.includes("FROM user_integrations") &&
      this.query.includes("api_key") &&
      this.query.includes("integration_id = ?")
    ) {
      const [userId, integrationId] = this.boundValues as [number, string];
      const row = this.db.integrationRows.get(`${userId}:${integrationId}`);
      if (!row?.api_key) return null;
      return { api_key: row.api_key };
    }

    // user_integrations: getValidGithubToken
    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      return {
        oauth_access_token: "ghp_test",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      };
    }

    // user_integrations: generic
    if (this.query.includes("FROM user_integrations")) {
      return null;
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      const [userId] = this.boundValues as [number];
      const businessId = this.db.businessMembers.get(userId);
      return businessId ? { business_id: businessId } : null;
    }

    // businesses: Codex BYOS capability (mirror migration 0255 seeding prod Cycloid)
    if (this.query.includes("FROM businesses") && this.query.includes("codex_byos_enabled")) {
      const [businessId] = this.boundValues as [string];
      const enabled = businessId === SEEDED_ARCANIST_BUSINESS_ID || this.db.codexByosBusinessIds.has(businessId);
      return { codex_byos_enabled: enabled ? 1 : 0 };
    }

    // business_integrations: scope lookup (business_id + integration_id)
    if (this.query.includes("FROM business_integrations") && this.query.includes("integration_id = ?")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const scope = this.db.businessIntegrations.get(`${businessId}:${integrationId}`);
      return scope ? { scope } : null;
    }

    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      return null;
    }

    // Upsert: INSERT ... SELECT id, ? ... FROM users WHERE id = ? ON CONFLICT (user_id) DO UPDATE SET ... RETURNING *
    if (this.query.includes("INSERT INTO user_settings") && this.query.includes("ON CONFLICT")) {
      // The user id binds LAST (WHERE id = ?); the SELECT column values precede it.
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const hasPlanMode = this.query.includes("plan_mode_setting");
      const [default_pr_draft, auto_verify_enabled, automatic_reviews_enabled] = this.boundValues as [
        number,
        number,
        number,
      ];
      const plan_mode_setting = hasPlanMode ? (this.boundValues[3] as PlanModeSetting) : undefined;
      const plan_approval_required = hasPlanMode ? (this.boundValues[4] as number | null) : null;
      const settings_profile = hasPlanMode ? (this.boundValues[5] as "manual" | "autonomous" | "custom" | null) : null;
      const use_codex_subscription = this.boundValues[hasPlanMode ? 6 : 5] as number;
      const default_model = this.boundValues[hasPlanMode ? 7 : 6] as string | null;
      const default_repo = this.boundValues[hasPlanMode ? 8 : 7] as string | null;
      const createdAt = this.boundValues[hasPlanMode ? 9 : 8] as number;
      const updatedAt = this.boundValues[hasPlanMode ? 10 : 9] as number;

      // No `users` row → SELECT matches nothing → no insert, no conflict,
      // RETURNING empty. updateUserSettings maps that to UserRowMissingError.
      if (!this.db.users.has(userId)) {
        return null;
      }

      const existing = this.db.userSettings.get(userId);

      if (!existing) {
        const newRow: UserSettingsRow = {
          user_id: userId,
          default_pr_draft,
          auto_verify_enabled,
          automatic_reviews_enabled,
          plan_mode_setting,
          plan_approval_required,
          settings_profile,
          use_codex_subscription,
          default_model,
          default_repo,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        this.db.userSettings.set(userId, newRow);
        return newRow as unknown as Record<string, unknown>;
      }

      // Existing row: apply only the columns referenced via excluded.* in the SET clause.
      const setMatch = this.query.match(/DO UPDATE SET (.+?)(?:\s+RETURNING|\s*$)/s);
      const setClause = setMatch?.[1] ?? "";
      const excluded = {
        default_pr_draft,
        auto_verify_enabled,
        automatic_reviews_enabled,
        plan_mode_setting,
        plan_approval_required,
        settings_profile,
        use_codex_subscription,
        default_model,
        default_repo,
        updated_at: updatedAt,
      };

      if (setClause.includes("excluded.default_pr_draft")) existing.default_pr_draft = excluded.default_pr_draft;
      if (setClause.includes("excluded.auto_verify_enabled"))
        existing.auto_verify_enabled = excluded.auto_verify_enabled;
      if (setClause.includes("excluded.automatic_reviews_enabled"))
        existing.automatic_reviews_enabled = excluded.automatic_reviews_enabled;
      if (setClause.includes("excluded.plan_mode_setting")) existing.plan_mode_setting = excluded.plan_mode_setting;
      if (setClause.includes("excluded.plan_approval_required"))
        existing.plan_approval_required = excluded.plan_approval_required;
      if (setClause.includes("excluded.settings_profile")) existing.settings_profile = excluded.settings_profile;
      if (setClause.includes("excluded.use_codex_subscription"))
        existing.use_codex_subscription = excluded.use_codex_subscription;
      if (setClause.includes("excluded.default_model")) existing.default_model = excluded.default_model;
      if (setClause.includes("excluded.default_repo")) existing.default_repo = excluded.default_repo;
      if (setClause.includes("excluded.updated_at")) existing.updated_at = excluded.updated_at;

      return existing as unknown as Record<string, unknown>;
    }

    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userSettings.get(userId);
      return (row as unknown as Record<string, unknown>) ?? null;
    }

    if (
      this.query.includes("openai_api_key") &&
      this.query.includes("openai_api_key") &&
      this.query.includes("FROM users")
    ) {
      const [userId] = this.boundValues as [number];
      const userRow = this.db.users.get(userId);
      if (!userRow) return null;
      return {
        openai_api_key: userRow.openai_api_key,
      };
    }

    if (this.query.includes("FROM users")) {
      const [userId] = this.boundValues as [number];
      const userRow = this.db.users.get(userId);
      return userRow ? (userRow as unknown as Record<string, unknown>) : null;
    }

    if (this.query.includes("FROM openai_virtual_keys")) {
      const [ownerUserId] = this.boundValues as [string];
      const row = this.db.openAIVirtualKeys.find((key) => key.owner_user_id === ownerUserId && key.status === "active");
      return row ? { id: row.id } : null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

class FakeD1 {
  readonly sessionIndex = new Map<string, Record<string, unknown>>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly userSettings = new Map<number, UserSettingsRow>();
  readonly users = new Map<number, UserRow>();
  readonly integrationRows = new Map<string, IntegrationRow>();
  readonly openAIVirtualKeys: OpenAIVirtualKeyRow[] = [];
  readonly openAIGatewayLedger: OpenAIGatewayLedgerRow[] = [];
  // userId -> businessId
  readonly businessMembers = new Map<number, string>();
  // `${businessId}:${integrationId}` -> scope ('user' | 'business' | 'disabled')
  readonly businessIntegrations = new Map<string, string>();
  // businessIds with codex_byos_enabled=1 (in addition to the seeded prod Cycloid business)
  readonly codexByosBusinessIds = new Set<string>();

  setAuthToken(token: string, user: AuthTokenUser): void {
    this.authTokens.set(token, user);
  }

  setUser(user: UserRow): void {
    this.users.set(user.id, user);
    // Seed user_integrations for BYOK keys
    if (user.openai_api_key) {
      this.integrationRows.set(`${user.id}:openai`, {
        integration_id: "openai",
        api_key: user.openai_api_key,
      });
    }
  }

  setBusinessMember(userId: number, businessId: string): void {
    this.businessMembers.set(userId, businessId);
  }

  setCodexByosEnabled(businessId: string): void {
    this.codexByosBusinessIds.add(businessId);
  }

  setBusinessIntegrationScope(
    businessId: string,
    integrationId: string,
    scope: "user" | "business" | "disabled",
  ): void {
    this.businessIntegrations.set(`${businessId}:${integrationId}`, scope);
  }

  addOpenAIVirtualKey(row: OpenAIVirtualKeyRow): void {
    this.openAIVirtualKeys.push(row);
  }

  addOpenAIGatewayLedger(row: OpenAIGatewayLedgerRow): void {
    this.openAIGatewayLedger.push(row);
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(
    stmts: FakeD1Statement[],
  ): Promise<Array<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }>> {
    return Promise.all(
      stmts.map(async (s) => {
        const result = await s.all();
        return { results: result.results ?? [], success: true, meta: {} };
      }),
    );
  }
}

function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
  modelsKv: FakeKV;
  rateLimitsKv: FakeKV;
} {
  const db = new FakeD1();
  const modelsKv = new FakeKV();
  const rateLimitsKv = new FakeKV();
  const { env } = createWorkerTestEnv(workerModule, {
    db,
    bindings: {
      modelsKv: { envKey: "DERIVED_MODELS", value: modelsKv },
      rateLimitsKv: { envKey: "RATE_LIMITS", value: rateLimitsKv },
    },
  });
  env.SESSION_RESUME_RATE_LIMITER = createDurableNamespace(workerModule.SessionResumeRateLimiterDO, env);

  return { env, db, modelsKv, rateLimitsKv };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("settings routes", () => {
  let workerModule: WorkerModule;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(async () => {
    expect(workerModule).toBeDefined();
    const { resetModelsMemoryCache } = await import("../../apps/control-plane-worker/src/services/bootstrap");
    resetModelsMemoryCache();
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---- GET /api/settings ----

  describe("GET /api/settings", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/settings");
      expect(res.status).toBe(401);
    });

    it("rejects admin token auth outside the explicit bearer allowlist", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/settings", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden: admin token cannot access this resource");
    });

    it("returns narrowed settings by default (no apiKeys)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-1", {
        user_id: 501,
        id: 501,
        expires_at: Date.now() + 60_000,
        login: "settingsuser",
        name: "Settings User",
        email: "settings@test.com",
      });
      db.setUser({ id: 501, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        headers: { cookie: "session_token=sess-settings-1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoVerifyEnabled).toBe(false);
      expect(body.defaultModel).toBeNull();
      expect(body.defaultRepo).toBeNull();
      expect(body).not.toHaveProperty("apiKeys");
      expect(body).not.toHaveProperty("customInstructions");
    });

    it("returns full settings including apiKeys with ?scope=full", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-1", {
        user_id: 501,
        id: 501,
        expires_at: Date.now() + 60_000,
        login: "settingsuser",
        name: "Settings User",
        email: "settings@test.com",
      });
      db.setUser({ id: 501, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings?scope=full", {
        headers: { cookie: "session_token=sess-settings-1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoVerifyEnabled).toBe(false);
      expect(body.defaultModel).toBeNull();
      expect(body.defaultRepo).toBeNull();
      expect(body).not.toHaveProperty("customInstructions");
      expect(body.apiKeys).toEqual({
        openai: {
          isSet: false,
          lastValidatedAt: null,
          lastValidationStatus: null,
          lastValidationReasonCode: null,
        },
        anthropic: {
          isSet: false,
          lastValidatedAt: null,
          lastValidationStatus: null,
          lastValidationReasonCode: null,
        },
        baseten: {
          isSet: false,
          lastValidatedAt: null,
          lastValidationStatus: null,
          lastValidationReasonCode: null,
        },
      });
    });

    it("returns api key status with ?scope=full when keys are set", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-2", {
        user_id: 502,
        id: 502,
        expires_at: Date.now() + 60_000,
        login: "keyuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 502, openai_api_key: "enc:openai", github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings?scope=full", {
        headers: { cookie: "session_token=sess-settings-2" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.apiKeys.openai).toEqual({
        isSet: true,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      });
    });

    it("returns 401 when the cached session's users row is gone (stale cache)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      // Auth token resolves from cache, but the user row was deleted/renumbered
      // (no setUser), so the lazy user_settings insert fails closed.
      db.setAuthToken("sess-stale-get", {
        user_id: 777,
        id: 777,
        expires_at: Date.now() + 60_000,
        login: "ghostuser",
        name: null,
        email: null,
      });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        headers: { cookie: "session_token=sess-stale-get" },
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- GET /api/settings/openai-usage ----

  describe("GET /api/settings/openai-usage", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/settings/openai-usage");

      expect(res.status).toBe(401);
    });

    it("returns only the authenticated user's current-month keys and ledger summary", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const now = Date.now();
      const current = new Date(now);
      const periodStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1);
      const periodEnd = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);

      db.setAuthToken("sess-openai-usage", {
        user_id: 601,
        id: 601,
        expires_at: now + 60_000,
        login: "usageuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 601, openai_api_key: null, github_token: null });
      db.addOpenAIVirtualKey({
        id: "vk_user_601",
        key_hash: "secret-hash-never-returned",
        owner_user_id: "601",
        business_id: "biz-1",
        monthly_limit_usd_micros: 10_000_000,
        status: "active",
        created_at: periodStart,
        updated_at: periodStart,
      });
      db.addOpenAIVirtualKey({
        id: "vk_user_601_inactive",
        key_hash: "inactive-secret-hash-never-returned",
        owner_user_id: "601",
        business_id: "biz-1",
        monthly_limit_usd_micros: 90_000_000,
        status: "inactive",
        created_at: periodStart + 1,
        updated_at: periodStart + 1,
      });
      db.addOpenAIVirtualKey({
        id: "vk_user_602",
        key_hash: "other-secret-hash-never-returned",
        owner_user_id: "602",
        business_id: "biz-2",
        monthly_limit_usd_micros: 50_000_000,
        status: "active",
        created_at: periodStart,
        updated_at: periodStart,
      });
      db.addOpenAIGatewayLedger({
        id: "ledger-settled",
        virtual_key_id: "vk_user_601",
        owner_user_id: "601",
        business_id: "biz-1",
        lifecycle_status: "settled",
        reserved_cost_usd_micros: 200,
        actual_cost_usd_micros: 123,
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 3,
        reasoning_output_tokens: 2,
        created_at: periodStart,
      });
      db.addOpenAIGatewayLedger({
        id: "ledger-reserved",
        virtual_key_id: "vk_user_601",
        owner_user_id: "601",
        business_id: "biz-1",
        lifecycle_status: "reserved",
        reserved_cost_usd_micros: 50,
        actual_cost_usd_micros: null,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_output_tokens: null,
        created_at: periodStart + 1,
      });
      db.addOpenAIGatewayLedger({
        id: "ledger-unresolved",
        virtual_key_id: "vk_user_601",
        owner_user_id: "601",
        business_id: "biz-1",
        lifecycle_status: "settlement_unresolved",
        reserved_cost_usd_micros: 70,
        actual_cost_usd_micros: 0,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_output_tokens: null,
        created_at: periodStart + 2,
      });
      db.addOpenAIGatewayLedger({
        id: "ledger-previous-month",
        virtual_key_id: "vk_user_601",
        owner_user_id: "601",
        business_id: "biz-1",
        lifecycle_status: "settled",
        reserved_cost_usd_micros: 999,
        actual_cost_usd_micros: 999,
        input_tokens: 999,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        created_at: periodStart - 1,
      });
      db.addOpenAIGatewayLedger({
        id: "ledger-other-user",
        virtual_key_id: "vk_user_602",
        owner_user_id: "602",
        business_id: "biz-2",
        lifecycle_status: "settled",
        reserved_cost_usd_micros: 888,
        actual_cost_usd_micros: 888,
        input_tokens: 888,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        created_at: periodStart,
      });

      const res = await workerFetch(workerModule, env, "/api/settings/openai-usage", {
        headers: { cookie: "session_token=sess-openai-usage" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.currentMonth).toMatchObject({
        periodStartMs: periodStart,
        periodEndMs: periodEnd,
        spentUsdMicros: 123,
        reservedUsdMicros: 50,
        monthlyLimitUsdMicros: 10_000_000,
        settledRequestCount: 1,
        reservedRequestCount: 1,
        settlementUnresolvedRequestCount: 1,
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 3,
        reasoningOutputTokens: 2,
      });
      expect(body.virtualKeys).toEqual([
        {
          id: "vk_user_601",
          status: "active",
          monthlyLimitUsdMicros: 10_000_000,
          createdAt: periodStart,
          updatedAt: periodStart,
        },
        {
          id: "vk_user_601_inactive",
          status: "inactive",
          monthlyLimitUsdMicros: 90_000_000,
          createdAt: periodStart + 1,
          updatedAt: periodStart + 1,
        },
      ]);
      expect(JSON.stringify(body)).not.toContain("secret-hash-never-returned");
    });
  });

  // ---- PUT /api/settings ----

  describe("PUT /api/settings", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultPrDraft: true }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when the cached session's users row is gone (stale cache)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      // Cached session resolves, but the user row is gone (no setUser): the
      // settings upsert fails closed instead of hitting the users FK.
      db.setAuthToken("sess-stale-put", {
        user_id: 778,
        id: 778,
        expires_at: Date.now() + 60_000,
        login: "ghostuser",
        name: null,
        email: null,
      });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-stale-put",
        },
        body: JSON.stringify({ defaultPrDraft: true }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid JSON body", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-3", {
        user_id: 503,
        id: 503,
        expires_at: Date.now() + 60_000,
        login: "user3",
        name: null,
        email: null,
      });
      db.setUser({ id: 503, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-3",
        },
        body: "{invalid",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 for invalid autoVerifyEnabled", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-auto-verify-invalid", {
        user_id: 506,
        id: 506,
        expires_at: Date.now() + 60_000,
        login: "user6",
        name: null,
        email: null,
      });
      db.setUser({ id: 506, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-auto-verify-invalid",
        },
        body: JSON.stringify({ autoVerifyEnabled: "no" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("autoVerifyEnabled must be a boolean");
    });

    it("handlePutSettings rejects non-boolean automaticReviewsEnabled with 400", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-auto-reviews-invalid", {
        user_id: 507,
        id: 507,
        expires_at: Date.now() + 60_000,
        login: "user7",
        name: null,
        email: null,
      });
      db.setUser({ id: 507, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-auto-reviews-invalid",
        },
        body: JSON.stringify({ automaticReviewsEnabled: "no" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("automaticReviewsEnabled must be a boolean");
    });

    it("accepts enum planMode values and writes their text values unchanged", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-plan-mode", {
        user_id: 508,
        id: 508,
        expires_at: Date.now() + 60_000,
        login: "user8",
        name: null,
        email: null,
      });
      db.setUser({ id: 508, openai_api_key: null, github_token: null });

      for (const planMode of ["on", "off", "auto"] as const) {
        const res = await workerFetch(workerModule, env, "/api/settings", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-settings-plan-mode",
          },
          body: JSON.stringify({ planMode }),
        });
        expect(res.status).toBe(200);
        expect(db.userSettings.get(508)?.plan_mode_setting).toBe(planMode);
      }
    });

    it.each([true, false, "AUTO", 3, null, "yes"])("rejects invalid planMode value %j with 400", async (planMode) => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-plan-mode-invalid", {
        user_id: 509,
        id: 509,
        expires_at: Date.now() + 60_000,
        login: "user9",
        name: null,
        email: null,
      });
      db.setUser({ id: 509, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-plan-mode-invalid",
        },
        body: JSON.stringify({ planMode }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: expect.any(String) });
    });

    it("rejects invalid settings profiles", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-settings-profile-invalid", {
        user_id: 510,
        id: 510,
        expires_at: Date.now() + 60_000,
        login: "user10",
        name: null,
        email: null,
      });
      db.setUser({ id: 510, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-settings-profile-invalid" },
        body: JSON.stringify({ settingsProfile: "unattended" }),
      });
      expect(res.status).toBe(400);
    });

    it("switches a preset to Custom when a raw autonomy knob is edited", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-settings-profile-raw", {
        user_id: 511,
        id: 511,
        expires_at: Date.now() + 60_000,
        login: "user11",
        name: null,
        email: null,
      });
      db.setUser({ id: 511, openai_api_key: null, github_token: null });
      db.userSettings.set(511, {
        user_id: 511,
        default_pr_draft: 0,
        auto_verify_enabled: 1,
        automatic_reviews_enabled: 1,
        plan_mode_setting: "auto",
        plan_approval_required: 0,
        settings_profile: "autonomous",
        use_codex_subscription: 0,
        default_model: null,
        default_repo: null,
        created_at: 1,
        updated_at: 1,
      });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-settings-profile-raw" },
        body: JSON.stringify({ autoVerifyEnabled: false }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).settingsProfile).toBe("custom");
      expect(db.userSettings.get(511)?.settings_profile).toBe("custom");
    });

    // Removed: selfHostedSandboxesOptIn validation no longer exists.

    it("returns 400 for invalid defaultRepo format", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-repo-1", {
        user_id: 510,
        id: 510,
        expires_at: Date.now() + 60_000,
        login: "user-repo-1",
        name: null,
        email: null,
      });
      db.setUser({ id: 510, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-repo-1",
        },
        body: JSON.stringify({ defaultRepo: "not-a-valid-repo" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid repository format");
    });

    it("returns 400 when defaultRepo is not a string", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-repo-2", {
        user_id: 511,
        id: 511,
        expires_at: Date.now() + 60_000,
        login: "user-repo-2",
        name: null,
        email: null,
      });
      db.setUser({ id: 511, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-repo-2",
        },
        body: JSON.stringify({ defaultRepo: 123 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("defaultRepo must be a string or null");
    });

    it("updates defaultRepo with valid owner/repo", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-repo-3", {
        user_id: 512,
        id: 512,
        expires_at: Date.now() + 60_000,
        login: "user-repo-3",
        name: null,
        email: null,
      });
      db.setUser({ id: 512, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-repo-3",
        },
        body: JSON.stringify({ defaultRepo: "trycycloid/cycloid" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.defaultRepo).toBe("trycycloid/cycloid");
    });

    it("clears defaultRepo with null", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-repo-4", {
        user_id: 513,
        id: 513,
        expires_at: Date.now() + 60_000,
        login: "user-repo-4",
        name: null,
        email: null,
      });
      db.setUser({ id: 513, openai_api_key: null, github_token: null });

      // First set a repo
      await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-repo-4",
        },
        body: JSON.stringify({ defaultRepo: "org/repo" }),
      });

      // Then clear it
      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-repo-4",
        },
        body: JSON.stringify({ defaultRepo: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.defaultRepo).toBeNull();
    });

    it("accepts defaultRepo as HTTPS GitHub URL", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-repo-5", {
        user_id: 514,
        id: 514,
        expires_at: Date.now() + 60_000,
        login: "user-repo-5",
        name: null,
        email: null,
      });
      db.setUser({ id: 514, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-repo-5",
        },
        body: JSON.stringify({ defaultRepo: "https://github.com/org/repo" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.defaultRepo).toBe("https://github.com/org/repo");
    });

    it("accepts prefixed defaultModel inputs and persists the bare model id", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-model-1", {
        user_id: 515,
        id: 515,
        expires_at: Date.now() + 60_000,
        login: "user-model-1",
        name: null,
        email: null,
      });
      db.setUser({ id: 515, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-model-1",
        },
        body: JSON.stringify({ defaultModel: "openai:gpt-5.5" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.defaultModel).toBe("gpt-5.5");
    });

    it("accepts a Claude session-start defaultModel (backend derived at session create)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-model-3", {
        user_id: 517,
        id: 517,
        expires_at: Date.now() + 60_000,
        login: "user-model-3",
        name: null,
        email: null,
      });
      db.setUser({ id: 517, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-model-3",
        },
        body: JSON.stringify({ defaultModel: "anthropic:claude-opus-4-8" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.defaultModel).toBe("claude-opus-4-8");
    });

    it("rejects non-launch defaultModel values", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-model-2", {
        user_id: 516,
        id: 516,
        expires_at: Date.now() + 60_000,
        login: "user-model-2",
        name: null,
        email: null,
      });
      db.setUser({ id: 516, openai_api_key: null, github_token: null });

      for (const defaultModel of [
        "gpt-5.4-pro",
        "gpt-5.4-nano",
        "gpt-5.3-codex",
        "gpt-5.2",
        "gpt-5.2-chat-latest",
        "gpt-5.2-codex",
      ]) {
        const res = await workerFetch(workerModule, env, "/api/settings", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-settings-model-2",
          },
          body: JSON.stringify({ defaultModel }),
        });
        expect(res.status, defaultModel).toBe(400);
        const body = await res.json();
        expect(body.error).toContain(`Invalid model: ${defaultModel}`);
      }
    });

    it("updates settings successfully", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-7", {
        user_id: 507,
        id: 507,
        expires_at: Date.now() + 60_000,
        login: "user7",
        name: null,
        email: null,
      });
      db.setUser({ id: 507, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-7",
        },
        body: JSON.stringify({
          defaultPrDraft: true,
          autoVerifyEnabled: false,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.defaultPrDraft).toBe(true);
      expect(body.autoVerifyEnabled).toBe(false);
    });

    it("rejects non-boolean defaultPrDraft", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-settings-draft", {
        user_id: 521,
        id: 521,
        expires_at: Date.now() + 60_000,
        login: "user-draft",
        name: null,
        email: null,
      });
      db.setUser({ id: 521, openai_api_key: null, github_token: null });
      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-draft",
        },
        body: JSON.stringify({ defaultPrDraft: "yes" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "defaultPrDraft must be a boolean" });
    });

    it("rejects enabling Codex subscription auth for a workspace without BYOS opt-in", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-codex-ineligible", {
        user_id: 508,
        id: 508,
        expires_at: Date.now() + 60_000,
        login: "user8",
        name: null,
        email: null,
      });
      db.setUser({ id: 508, openai_api_key: null, github_token: null });
      // Member of a business that has NOT opted into Codex BYOS.
      db.setBusinessMember(508, "cust-biz-no-byos");

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-codex-ineligible",
        },
        body: JSON.stringify({ useCodexSubscription: true }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "Codex subscription auth is not enabled for your workspace",
      });
    });

    it("allows a non-Cycloid workspace that opted into Codex BYOS to enable it", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-codex-customer", {
        user_id: 515,
        id: 515,
        expires_at: Date.now() + 60_000,
        login: "user15",
        name: null,
        email: null,
      });
      db.setUser({ id: 515, openai_api_key: null, github_token: null });
      db.setBusinessMember(515, "cust-biz-byos");
      db.setCodexByosEnabled("cust-biz-byos");

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-codex-customer",
        },
        body: JSON.stringify({ useCodexSubscription: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ useCodexSubscription: true });
    });

    it("allows Cycloid users to enable Codex subscription auth", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-settings-codex-eligible", {
        user_id: 509,
        id: 509,
        expires_at: Date.now() + 60_000,
        login: "user9",
        name: null,
        email: null,
      });
      db.setUser({ id: 509, openai_api_key: null, github_token: null });
      db.setBusinessMember(509, SEEDED_ARCANIST_BUSINESS_ID);

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-codex-eligible",
        },
        body: JSON.stringify({ useCodexSubscription: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ useCodexSubscription: true });
    });

    it("invalidates the in-memory models cache when toggling Codex subscription auth", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const { buildAndCacheModels } = await import("../../apps/control-plane-worker/src/services/bootstrap");

      db.setAuthToken("sess-settings-codex-cache", {
        user_id: 510,
        id: 510,
        expires_at: Date.now() + 60_000,
        login: "user10",
        name: null,
        email: null,
      });
      db.setUser({ id: 510, openai_api_key: null, github_token: null });
      db.setBusinessMember(510, SEEDED_ARCANIST_BUSINESS_ID);
      db.integrationRows.set("510:codex_subscription", {
        integration_id: "codex_subscription",
        api_key: "encrypted-auth-json",
        external_user_id: "auth_json:510",
        encrypted: 1,
        last_validated_at: Date.now(),
        last_validation_status: "validated",
        last_validation_reason_code: null,
      });

      const beforeToggle = await buildAndCacheModels(env, 510);
      expect(beforeToggle.find((group) => group.id === "openai")?.hasApiKey).toBe(false);

      const res = await workerFetch(workerModule, env, "/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-settings-codex-cache",
        },
        body: JSON.stringify({ useCodexSubscription: true }),
      });

      expect(res.status).toBe(200);

      const afterToggle = await buildAndCacheModels(env, 510);
      expect(afterToggle.find((group) => group.id === "openai")?.hasApiKey).toBe(true);
    });
  });

  // ---- settings service payload mapping (no settings-service test file) ----

  describe("settings service payload", () => {
    it("returns the stored plan_mode_setting as the planMode enum", async () => {
      const { db } = createWorkerEnv(workerModule);
      db.setUser({ id: 549, openai_api_key: null, github_token: null });
      const dbArg = db as unknown as Parameters<typeof getSettingsPayload>[0];
      db.userSettings.set(549, {
        user_id: 549,
        default_pr_draft: 0,
        auto_verify_enabled: 0,
        automatic_reviews_enabled: 0,
        plan_mode_setting: "auto",
        use_codex_subscription: 0,
        default_model: null,
        default_repo: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const settings = await getSettingsPayload(dbArg, 549, false);

      expect(settings.planMode).toBe("auto");
      expect(settings).not.toHaveProperty("planModeSetting");
    });

    it("mapSettingsResponse maps automatic_reviews_enabled to automaticReviewsEnabled", async () => {
      const { db } = createWorkerEnv(workerModule);
      db.setUser({ id: 550, openai_api_key: null, github_token: null });
      const dbArg = db as unknown as Parameters<typeof getSettingsPayload>[0];

      db.userSettings.set(550, {
        user_id: 550,
        default_pr_draft: 0,
        auto_verify_enabled: 0,
        automatic_reviews_enabled: 1,
        plan_mode_setting: "off",
        use_codex_subscription: 0,
        default_model: null,
        default_repo: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const enabled = await getSettingsPayload(dbArg, 550, false);
      expect(enabled.automaticReviewsEnabled).toBe(true);

      db.userSettings.set(550, {
        user_id: 550,
        default_pr_draft: 0,
        auto_verify_enabled: 0,
        automatic_reviews_enabled: 0,
        plan_mode_setting: "off",
        use_codex_subscription: 0,
        default_model: null,
        default_repo: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const disabled = await getSettingsPayload(dbArg, 550, false);
      expect(disabled.automaticReviewsEnabled).toBe(false);
    });

    it("updateSettingsPayload forwards automaticReviewsEnabled", async () => {
      const { db } = createWorkerEnv(workerModule);
      db.setUser({ id: 551, openai_api_key: null, github_token: null });
      const dbArg = db as unknown as Parameters<typeof updateSettingsPayload>[0];

      const on = await updateSettingsPayload(dbArg, 551, { automaticReviewsEnabled: true });
      expect(on.automaticReviewsEnabled).toBe(true);

      const off = await updateSettingsPayload(dbArg, 551, { automaticReviewsEnabled: false });
      expect(off.automaticReviewsEnabled).toBe(false);
    });

    it("maps and forwards the planMode enum", async () => {
      const { db } = createWorkerEnv(workerModule);
      db.setUser({ id: 552, openai_api_key: null, github_token: null });
      const dbArg = db as unknown as Parameters<typeof updateSettingsPayload>[0];

      const on = await updateSettingsPayload(dbArg, 552, { planMode: "on" });
      expect(on.planMode).toBe("on");
      expect(on).not.toHaveProperty("planModeSetting");

      const auto = await updateSettingsPayload(dbArg, 552, { planMode: "auto" });
      expect(auto.planMode).toBe("auto");
      expect(auto).not.toHaveProperty("planModeSetting");

      const off = await updateSettingsPayload(dbArg, 552, { planMode: "off" });
      expect(off.planMode).toBe("off");
      expect(off).not.toHaveProperty("planModeSetting");
    });
  });

  // ---- GET /api/settings/codex-subscription ----

  describe("GET /api/settings/codex-subscription", () => {
    it("returns credential metadata without decrypting the stored auth JSON", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-codex-state", {
        user_id: 589,
        id: 589,
        expires_at: Date.now() + 60_000,
        login: "codexstate",
        name: null,
        email: null,
      });
      db.setUser({ id: 589, openai_api_key: null, github_token: null });
      db.setBusinessMember(589, SEEDED_ARCANIST_BUSINESS_ID);

      const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refresh" } });
      const putRes = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-codex-state",
        },
        body: JSON.stringify({ authJson }),
      });
      expect(putRes.status).toBe(200);

      delete env.TOKEN_ENCRYPTION_KEY;
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription", {
        headers: { cookie: "session_token=sess-codex-state" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        eligible: true,
        credential: {
          isSet: true,
          lastValidationStatus: "saved_unverified",
          lastValidationReasonCode: "network_validation_skipped",
        },
      });
    });
  });

  // ---- PUT /api/settings/codex-subscription/auth-json ----

  describe("PUT /api/settings/codex-subscription/auth-json", () => {
    it("stores valid Codex auth JSON for Cycloid business members", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-codex-auth-json", {
        user_id: 590,
        id: 590,
        expires_at: Date.now() + 60_000,
        login: "codexuser",
        name: null,
        email: null,
      });
      db.setUser({ id: 590, openai_api_key: null, github_token: null });
      db.setBusinessMember(590, SEEDED_ARCANIST_BUSINESS_ID);

      const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refresh" } });
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-codex-auth-json",
        },
        body: JSON.stringify({ authJson }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isSet: true, lastValidationStatus: "saved_unverified" });
      const row = db.integrationRows.get("590:codex_subscription");
      expect(row).toMatchObject({
        integration_id: "codex_subscription",
        external_user_id: "auth_json:590",
        encrypted: 1,
        last_validation_status: "saved_unverified",
      });
      expect(row?.api_key).not.toBe(authJson);
    });

    it("rejects malformed Codex auth JSON", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-codex-auth-json-invalid", {
        user_id: 591,
        id: 591,
        expires_at: Date.now() + 60_000,
        login: "codexuser2",
        name: null,
        email: null,
      });
      db.setUser({ id: 591, openai_api_key: null, github_token: null });
      db.setBusinessMember(591, SEEDED_ARCANIST_BUSINESS_ID);

      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-codex-auth-json-invalid",
        },
        body: JSON.stringify({ authJson: '{"auth_mode":"api"}' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "Codex auth.json must use ChatGPT auth" });
      expect(db.integrationRows.has("591:codex_subscription")).toBe(false);
    });

    it("invalidates the in-memory models cache when saving auth JSON", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const { buildAndCacheModels } = await import("../../apps/control-plane-worker/src/services/bootstrap");

      db.setAuthToken("sess-codex-auth-json-cache", {
        user_id: 592,
        id: 592,
        expires_at: Date.now() + 60_000,
        login: "codexuser-cache",
        name: null,
        email: null,
      });
      db.setUser({ id: 592, openai_api_key: null, github_token: null });
      db.setBusinessMember(592, SEEDED_ARCANIST_BUSINESS_ID);
      db.userSettings.set(592, {
        user_id: 592,
        default_pr_draft: 0,
        auto_verify_enabled: 1,
        automatic_reviews_enabled: 0,
        use_codex_subscription: 1,
        default_model: null,
        default_repo: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const beforeSave = await buildAndCacheModels(env, 592);
      expect(beforeSave.find((group) => group.id === "openai")?.hasApiKey).toBe(false);

      const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refresh" } });
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-codex-auth-json-cache",
        },
        body: JSON.stringify({ authJson }),
      });

      expect(res.status).toBe(200);

      const afterSave = await buildAndCacheModels(env, 592);
      expect(afterSave.find((group) => group.id === "openai")?.hasApiKey).toBe(false);
    });
  });

  // ---- DELETE /api/settings/codex-subscription/auth-json ----

  describe("DELETE /api/settings/codex-subscription/auth-json", () => {
    it("does not share the delete rate limit with auth JSON update attempts", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-codex-auth-json-delete-rl", {
        user_id: 594,
        id: 594,
        expires_at: Date.now() + 60_000,
        login: "codexuser-delete-rl",
        name: null,
        email: null,
      });
      db.setUser({ id: 594, openai_api_key: null, github_token: null });
      db.setBusinessMember(594, SEEDED_ARCANIST_BUSINESS_ID);

      const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refresh" } });
      for (let i = 0; i < 10; i++) {
        const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-codex-auth-json-delete-rl",
          },
          body: JSON.stringify({ authJson }),
        });
        expect(res.status).toBe(200);
      }

      const putLimited = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-codex-auth-json-delete-rl",
        },
        body: JSON.stringify({ authJson }),
      });
      expect(putLimited.status).toBe(429);

      const deleteRes = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-codex-auth-json-delete-rl" },
      });
      expect(deleteRes.status).toBe(200);
      expect(await deleteRes.json()).toMatchObject({ isSet: false });
    });

    it("invalidates DERIVED_MODELS KV cache when clearing auth JSON", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-codex-auth-json-delete-cache", {
        user_id: 593,
        id: 593,
        expires_at: Date.now() + 60_000,
        login: "codexuser-delete-cache",
        name: null,
        email: null,
      });
      db.setUser({ id: 593, openai_api_key: null, github_token: null });
      db.setBusinessMember(593, SEEDED_ARCANIST_BUSINESS_ID);
      db.integrationRows.set("593:codex_subscription", {
        integration_id: "codex_subscription",
        api_key: "encrypted-auth-json",
        external_user_id: "auth_json:593",
        encrypted: 1,
        last_validated_at: Date.now(),
        last_validation_status: "saved_unverified",
        last_validation_reason_code: "network_validation_skipped",
      });

      await modelsKv.put(modelsCacheKey(593), JSON.stringify([{ id: "openai", hasApiKey: true }]));
      expect(modelsKv.store.has(modelsCacheKey(593))).toBe(true);

      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-codex-auth-json-delete-cache" },
      });

      expect(res.status).toBe(200);
      expect(modelsKv.store.has(modelsCacheKey(593))).toBe(false);
    });

    it("clears the stored credential even after the workspace loses BYOS eligibility (ARC-1517)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-codex-clear-ineligible", {
        user_id: 596,
        id: 596,
        expires_at: Date.now() + 60_000,
        login: "codexuser-clear-ineligible",
        name: null,
        email: null,
      });
      db.setUser({ id: 596, openai_api_key: null, github_token: null });
      // Business is NOT opted into BYOS, but the user still has a saved auth.json.
      db.setBusinessMember(596, "cust-biz-no-byos");
      db.integrationRows.set("596:codex_subscription", {
        integration_id: "codex_subscription",
        api_key: "encrypted-auth-json",
        external_user_id: "auth_json:596",
        encrypted: 1,
        last_validated_at: Date.now(),
        last_validation_status: "saved_unverified",
        last_validation_reason_code: "network_validation_skipped",
      });

      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/auth-json", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-codex-clear-ineligible" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isSet: false });
    });
  });

  // ---- PUT /api/settings/codex-subscription/enabled ----

  describe("PUT /api/settings/codex-subscription/enabled", () => {
    function seedUser(db: ReturnType<typeof createWorkerEnv>["db"], id: number, token: string, businessId: string) {
      db.setAuthToken(token, {
        user_id: id,
        id,
        expires_at: Date.now() + 60_000,
        login: `u${id}`,
        name: null,
        email: null,
      });
      db.setUser({ id, openai_api_key: null, github_token: null });
      db.setBusinessMember(id, businessId);
    }

    it("returns 400 when `enabled` is missing", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedUser(db, 700, "sess-codex-enabled-400", "cust-biz-byos");
      db.setCodexByosEnabled("cust-biz-byos");
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/enabled", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-codex-enabled-400" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("enables the selector for an opted-in workspace", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedUser(db, 701, "sess-codex-enabled-on", "cust-biz-byos");
      db.setCodexByosEnabled("cust-biz-byos");
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/enabled", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-codex-enabled-on" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ useCodexSubscription: true });
    });

    it("rejects enabling for a workspace without BYOS opt-in", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedUser(db, 702, "sess-codex-enabled-403", "cust-biz-no-byos");
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/enabled", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-codex-enabled-403" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(403);
    });

    it("allows disabling even for a workspace without BYOS opt-in", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedUser(db, 703, "sess-codex-enabled-off", "cust-biz-no-byos");
      const res = await workerFetch(workerModule, env, "/api/settings/codex-subscription/enabled", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-codex-enabled-off" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ useCodexSubscription: false });
    });
  });

  // ---- PUT /api/settings/api-keys/:provider ----

  describe("PUT /api/settings/api-keys/:provider", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-openai-test" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for unknown provider", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-2", {
        user_id: 602,
        id: 602,
        expires_at: Date.now() + 60_000,
        login: "keyuser2",
        name: null,
        email: null,
      });
      db.setUser({ id: 602, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/gemini", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-keys-2",
        },
        body: JSON.stringify({ apiKey: "test-key" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Unknown provider");
    });

    it("returns 400 when apiKey is missing", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-3", {
        user_id: 603,
        id: 603,
        expires_at: Date.now() + 60_000,
        login: "keyuser3",
        name: null,
        email: null,
      });
      db.setUser({ id: 603, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-keys-3",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing apiKey");
    });

    it("returns 400 when apiKey has wrong prefix", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-4", {
        user_id: 604,
        id: 604,
        expires_at: Date.now() + 60_000,
        login: "keyuser4",
        name: null,
        email: null,
      });
      db.setUser({ id: 604, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-keys-4",
        },
        body: JSON.stringify({ apiKey: "wrong-prefix-key" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('must start with "sk-"');
    });

    it("sets api key successfully for openai", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-5", {
        user_id: 605,
        id: 605,
        expires_at: Date.now() + 60_000,
        login: "keyuser5",
        name: null,
        email: null,
      });
      db.setUser({ id: 605, openai_api_key: null, github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-5",
          },
          body: JSON.stringify({ apiKey: "sk-openai-test-key-123" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.isSet).toBe(true);
        expect(body.lastValidationStatus).toBe("validated");
        expect(body.lastValidationReasonCode).toBeNull();
        expect(typeof body.lastValidatedAt).toBe("number");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sets api key successfully for openai", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-6", {
        user_id: 606,
        id: 606,
        expires_at: Date.now() + 60_000,
        login: "keyuser6",
        name: null,
        email: null,
      });
      db.setUser({ id: 606, openai_api_key: null, github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-6",
          },
          body: JSON.stringify({ apiKey: "sk-test-openai-key" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.isSet).toBe(true);
        expect(body.lastValidationStatus).toBe("validated");
        expect(body.lastValidationReasonCode).toBeNull();
        expect(typeof body.lastValidatedAt).toBe("number");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 400 when openai api key is invalid", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-9", {
        user_id: 609,
        id: 609,
        expires_at: Date.now() + 60_000,
        login: "keyuser9",
        name: null,
        email: null,
      });
      db.setUser({ id: 609, openai_api_key: null, github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-9",
          },
          body: JSON.stringify({ apiKey: "sk-openai-invalid-key" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("API key is invalid");
        expect(body.state).toEqual({
          isSet: true,
          lastValidatedAt: expect.any(Number),
          lastValidationStatus: "invalid",
          lastValidationReasonCode: "credentials_invalid",
        });
        expect(db.integrationRows.get("609:openai")).toMatchObject({
          integration_id: "openai",
          last_validation_status: "invalid",
          last_validation_reason_code: "credentials_invalid",
        });
        expect(db.integrationRows.get("609:openai")?.api_key).toEqual(expect.any(String));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 400 when openai api key is invalid", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-10", {
        user_id: 610,
        id: 610,
        expires_at: Date.now() + 60_000,
        login: "keyuser10",
        name: null,
        email: null,
      });
      db.setUser({ id: 610, openai_api_key: null, github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-10",
          },
          body: JSON.stringify({ apiKey: "sk-invalid-openai-key" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("API key is invalid");
        expect(db.integrationRows.get("610:openai")).toMatchObject({
          integration_id: "openai",
          last_validation_status: "invalid",
          last_validation_reason_code: "credentials_invalid",
        });
        expect(db.integrationRows.get("610:openai")?.api_key).toEqual(expect.any(String));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 400 and persists invalid state for other provider 4xx validation responses", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-10b", {
        user_id: 612,
        id: 612,
        expires_at: Date.now() + 60_000,
        login: "keyuser10b",
        name: null,
        email: null,
      });
      db.setUser({ id: 612, openai_api_key: "enc:openai", github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ error: { message: "Malformed key" } }), { status: 422 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-10b",
          },
          body: JSON.stringify({ apiKey: "sk-openai-422-key" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("API key is invalid");
        expect(db.integrationRows.get("612:openai")).toMatchObject({
          integration_id: "openai",
          last_validation_status: "invalid",
          last_validation_reason_code: "credentials_invalid",
        });
        expect(db.integrationRows.get("612:openai")?.api_key).toEqual(expect.any(String));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("treats provider rate limiting as saved_unverified instead of invalid", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-10c", {
        user_id: 613,
        id: 613,
        expires_at: Date.now() + 60_000,
        login: "keyuser10c",
        name: null,
        email: null,
      });
      db.setUser({ id: 613, openai_api_key: null, github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-10c",
          },
          body: JSON.stringify({ apiKey: "sk-openai-429-key" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
          isSet: true,
          lastValidatedAt: expect.any(Number),
          lastValidationStatus: "saved_unverified",
          lastValidationReasonCode: "network_validation_skipped",
        });
        expect(db.integrationRows.get("613:openai")).toMatchObject({
          integration_id: "openai",
          last_validation_status: "saved_unverified",
          last_validation_reason_code: "network_validation_skipped",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // Regression: authorization gating must run BEFORE the external provider
    // validation fetch. Sending a user-supplied key to OpenAI on behalf
    // of an unauthorized caller leaks the secret and performs work for someone
    // we are about to 403/409. See ARC-500.
    it("returns 403 without calling the provider when integration is disabled for the business", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-gate-disabled", {
        user_id: 620,
        id: 620,
        expires_at: Date.now() + 60_000,
        login: "gate-disabled",
        name: null,
        email: null,
      });
      db.setUser({ id: 620, openai_api_key: null, github_token: null });
      db.setBusinessMember(620, "biz-disabled");
      db.setBusinessIntegrationScope("biz-disabled", "openai", "disabled");

      let providerFetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com")) {
          providerFetchCalled = true;
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-gate-disabled",
          },
          body: JSON.stringify({ apiKey: "sk-openai-should-not-leak" }),
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toContain("disabled for your organization");
        expect(providerFetchCalled).toBe(false);
        // Nothing should be persisted when gating rejects the request.
        expect(db.integrationRows.has("620:openai")).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 409 without calling the provider when integration is business-managed", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-gate-managed", {
        user_id: 621,
        id: 621,
        expires_at: Date.now() + 60_000,
        login: "gate-managed",
        name: null,
        email: null,
      });
      db.setUser({ id: 621, openai_api_key: null, github_token: null });
      db.setBusinessMember(621, "biz-managed");
      db.setBusinessIntegrationScope("biz-managed", "openai", "business");

      let providerFetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com")) {
          providerFetchCalled = true;
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-gate-managed",
          },
          body: JSON.stringify({ apiKey: "sk-should-not-leak" }),
        });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toBe("Managed by your organization");
        expect(providerFetchCalled).toBe(false);
        expect(db.integrationRows.has("621:openai")).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("allows key save when validation fetch fails (network error)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-11", {
        user_id: 611,
        id: 611,
        expires_at: Date.now() + 60_000,
        login: "keyuser11",
        name: null,
        email: null,
      });
      db.setUser({ id: 611, openai_api_key: null, github_token: null });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          throw new Error("Network error");
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-11",
          },
          body: JSON.stringify({ apiKey: "sk-openai-network-error-key" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.isSet).toBe(true);
        expect(body.lastValidationStatus).toBe("saved_unverified");
        expect(body.lastValidationReasonCode).toBe("network_validation_skipped");
        expect(typeof body.lastValidatedAt).toBe("number");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sets a baseten key for non-Cycloid users without prefix validation", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-baseten-customer", {
        user_id: 614,
        id: 614,
        expires_at: Date.now() + 60_000,
        login: "baseten-customer",
        name: null,
        email: null,
      });
      db.setUser({ id: 614, openai_api_key: null, github_token: null });
      db.setBusinessMember(614, "customer-business");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("inference.baseten.co/v1/models")) {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer seg.seg");
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/baseten", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-baseten-customer",
          },
          body: JSON.stringify({ apiKey: "seg.seg" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          isSet: true,
          lastValidatedAt: expect.any(Number),
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        });
        expect(db.integrationRows.get("614:baseten")).toMatchObject({
          integration_id: "baseten",
          last_validation_status: "validated",
          last_validation_reason_code: null,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sets a baseten key for Cycloid members without prefix validation", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-baseten-ok", {
        user_id: 615,
        id: 615,
        expires_at: Date.now() + 60_000,
        login: "baseten-ok",
        name: null,
        email: null,
      });
      db.setUser({ id: 615, openai_api_key: null, github_token: null });
      db.setBusinessMember(615, SEEDED_ARCANIST_BUSINESS_ID);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("inference.baseten.co/v1/models")) {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer seg.seg");
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/baseten", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-baseten-ok",
          },
          body: JSON.stringify({ apiKey: "seg.seg" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          isSet: true,
          lastValidatedAt: expect.any(Number),
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        });
        expect(db.integrationRows.get("615:baseten")).toMatchObject({
          integration_id: "baseten",
          last_validation_status: "validated",
          last_validation_reason_code: null,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---- POST /api/settings/api-keys/:provider/validate ----

  describe("POST /api/settings/api-keys/:provider/validate", () => {
    function seedKeyUser(db: FakeD1, token: string, userId: number, login: string): void {
      db.setAuthToken(token, {
        user_id: userId,
        id: userId,
        expires_at: Date.now() + 60_000,
        login,
        name: null,
        email: null,
      });
      db.setUser({ id: userId, openai_api_key: null, github_token: null });
    }

    function mockProviderModels(status: number): () => void {
      const original = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (
          url.includes("api.openai.com/v1/models") ||
          url.includes("api.anthropic.com/v1/models") ||
          url.includes("inference.baseten.co/v1/models")
        ) {
          return new Response(JSON.stringify({ data: [] }), { status });
        }
        return original(input, init);
      };
      return () => {
        globalThis.fetch = original;
      };
    }

    async function postValidate(
      env: Record<string, unknown>,
      provider: string,
      token: string,
      body: unknown,
    ): Promise<Response> {
      return workerFetch(workerModule, env, `/api/settings/api-keys/${provider}/validate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `session_token=${token}`,
        },
        body: JSON.stringify(body),
      });
    }

    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-x" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for an unknown provider", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-1", 701, "validateuser1");
      const res = await postValidate(env, "gemini", "sess-validate-1", { apiKey: "sk-x" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Unknown provider");
    });

    it("returns 400 when apiKey is missing", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-2", 702, "validateuser2");
      const res = await postValidate(env, "openai", "sess-validate-2", {});
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Missing apiKey");
    });

    it("returns 400 when the key prefix does not match the provider", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-3", 703, "validateuser3");
      const res = await postValidate(env, "anthropic", "sess-validate-3", { apiKey: "sk-not-anthropic" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('must start with "sk-ant-"');
    });

    it("validates a key without persisting it", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-4", 704, "validateuser4");
      const restoreFetch = mockProviderModels(200);
      try {
        const res = await postValidate(env, "openai", "sess-validate-4", { apiKey: "sk-valid-key" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ ok: true, validationStatus: "validated", reasonCode: null });
        expect(db.integrationRows.get("704:openai")).toBeUndefined();
      } finally {
        restoreFetch();
      }
    });

    it("validates baseten keys for Cycloid members without prefix validation", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-baseten", 709, "validatebaseten");
      db.setBusinessMember(709, SEEDED_ARCANIST_BUSINESS_ID);
      const restoreFetch = mockProviderModels(200);
      try {
        const res = await postValidate(env, "baseten", "sess-validate-baseten", { apiKey: "seg.seg" });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, validationStatus: "validated", reasonCode: null });
        expect(db.integrationRows.get("709:baseten")).toBeUndefined();
      } finally {
        restoreFetch();
      }
    });

    it("validates baseten keys for non-Cycloid users", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-baseten-customer", 710, "validatebasetencustomer");
      db.setBusinessMember(710, "customer-business");
      const restoreFetch = mockProviderModels(200);
      try {
        const res = await postValidate(env, "baseten", "sess-validate-baseten-customer", { apiKey: "seg.seg" });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, validationStatus: "validated", reasonCode: null });
        expect(db.integrationRows.get("710:baseten")).toBeUndefined();
      } finally {
        restoreFetch();
      }
    });

    it("returns 400 for an invalid key without persisting it", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-5", 705, "validateuser5");
      const restoreFetch = mockProviderModels(401);
      try {
        const res = await postValidate(env, "openai", "sess-validate-5", { apiKey: "sk-invalid-key" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain("API key is invalid");
        expect(db.integrationRows.get("705:openai")).toBeUndefined();
      } finally {
        restoreFetch();
      }
    });

    it("reports unverified when the provider check is degraded", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-6", 706, "validateuser6");
      const restoreFetch = mockProviderModels(500);
      try {
        const res = await postValidate(env, "openai", "sess-validate-6", { apiKey: "sk-degraded-key" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
          ok: true,
          validationStatus: "unverified",
          reasonCode: "network_validation_skipped",
        });
      } finally {
        restoreFetch();
      }
    });

    it("rate limits validation attempts per user and provider", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-7", 707, "validateuser7");
      const restoreFetch = mockProviderModels(200);
      try {
        for (let i = 0; i < 10; i++) {
          const res = await postValidate(env, "openai", "sess-validate-7", { apiKey: "sk-rl-key" });
          expect(res.status).toBe(200);
        }
        const limited = await postValidate(env, "openai", "sess-validate-7", { apiKey: "sk-rl-key" });
        expect(limited.status).toBe(429);
        expect((await limited.json()).error).toContain("Too many API key validation attempts");

        // Another provider keeps its own budget
        const otherProvider = await postValidate(env, "anthropic", "sess-validate-7", { apiKey: "sk-ant-other" });
        expect(otherProvider.status).toBe(200);
      } finally {
        restoreFetch();
      }
    });

    it("shares the rate limit with the save path", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedKeyUser(db, "sess-validate-8", 708, "validateuser8");
      const restoreFetch = mockProviderModels(200);
      try {
        for (let i = 0; i < 10; i++) {
          const res = await postValidate(env, "openai", "sess-validate-8", { apiKey: "sk-rl-key" });
          expect(res.status).toBe(200);
        }
        const put = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-validate-8",
          },
          body: JSON.stringify({ apiKey: "sk-rl-key" }),
        });
        expect(put.status).toBe(429);
      } finally {
        restoreFetch();
      }
    });
  });

  // ---- DELETE /api/settings/api-keys/:provider ----

  describe("DELETE /api/settings/api-keys/:provider", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for unknown provider", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-7", {
        user_id: 607,
        id: 607,
        expires_at: Date.now() + 60_000,
        login: "keyuser7",
        name: null,
        email: null,
      });
      db.setUser({ id: 607, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/gemini", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-7" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Unknown provider");
    });

    it("deletes api key successfully", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-8", {
        user_id: 608,
        id: 608,
        expires_at: Date.now() + 60_000,
        login: "keyuser8",
        name: null,
        email: null,
      });
      db.setUser({ id: 608, openai_api_key: null, github_token: null });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-8" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isSet).toBe(false);
    });

    it("rate limits delete attempts per user and provider", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-keys-delete-rl", {
        user_id: 619,
        id: 619,
        expires_at: Date.now() + 60_000,
        login: "delete-rl-user",
        name: null,
        email: null,
      });
      db.setUser({ id: 619, openai_api_key: null, github_token: null });

      for (let i = 0; i < 10; i++) {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "DELETE",
          headers: { cookie: "session_token=sess-keys-delete-rl" },
        });
        expect(res.status).toBe(200);
      }

      const limited = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-delete-rl" },
      });
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toContain("Too many credential updates");
    });

    it("does not share the delete rate limit with validation attempts", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.setAuthToken("sess-keys-delete-validation-rl", {
        user_id: 620,
        id: 620,
        expires_at: Date.now() + 60_000,
        login: "delete-validation-rl-user",
        name: null,
        email: null,
      });
      db.setUser({ id: 620, openai_api_key: null, github_token: null });

      const original = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return original(input, init);
      };
      try {
        for (let i = 0; i < 10; i++) {
          const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai/validate", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "session_token=sess-keys-delete-validation-rl",
            },
            body: JSON.stringify({ apiKey: "sk-rl-key" }),
          });
          expect(res.status).toBe(200);
        }

        const validateLimited = await workerFetch(workerModule, env, "/api/settings/api-keys/openai/validate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-delete-validation-rl",
          },
          body: JSON.stringify({ apiKey: "sk-rl-key" }),
        });
        expect(validateLimited.status).toBe(429);

        const deleteRes = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "DELETE",
          headers: { cookie: "session_token=sess-keys-delete-validation-rl" },
        });
        expect(deleteRes.status).toBe(200);
      } finally {
        globalThis.fetch = original;
      }
    });

    it("clears a baseten key for non-Cycloid users", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-baseten-delete-customer", {
        user_id: 617,
        id: 617,
        expires_at: Date.now() + 60_000,
        login: "baseten-delete-customer",
        name: null,
        email: null,
      });
      db.setUser({ id: 617, openai_api_key: null, github_token: null });
      db.setBusinessMember(617, "customer-business");
      db.integrationRows.set("617:baseten", {
        integration_id: "baseten",
        api_key: "enc:baseten",
        last_validation_status: "validated",
      });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/baseten", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-baseten-delete-customer" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        isSet: false,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      });
      expect(db.integrationRows.has("617:baseten")).toBe(false);
    });

    it("clears a baseten key for Cycloid members", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-baseten-delete", {
        user_id: 618,
        id: 618,
        expires_at: Date.now() + 60_000,
        login: "baseten-delete",
        name: null,
        email: null,
      });
      db.setUser({ id: 618, openai_api_key: null, github_token: null });
      db.setBusinessMember(618, SEEDED_ARCANIST_BUSINESS_ID);
      db.integrationRows.set("618:baseten", {
        integration_id: "baseten",
        api_key: "enc:baseten",
        last_validation_status: "validated",
      });

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/baseten", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-baseten-delete" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        isSet: false,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      });
      expect(db.integrationRows.has("618:baseten")).toBe(false);
    });

    it("invalidates DERIVED_MODELS KV cache on delete", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-cache-del", {
        user_id: 609,
        id: 609,
        expires_at: Date.now() + 60_000,
        login: "keyuser-cache-del",
        name: null,
        email: null,
      });
      db.setUser({ id: 609, openai_api_key: null, github_token: null });

      // Pre-populate models cache
      await modelsKv.put(modelsCacheKey(609), JSON.stringify([{ id: "openai", hasApiKey: true }]));
      expect(modelsKv.store.has(modelsCacheKey(609))).toBe(true);

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-cache-del" },
      });
      expect(res.status).toBe(200);

      // Cache entry should be deleted
      expect(modelsKv.store.has(modelsCacheKey(609))).toBe(false);
    });

    it("invalidates the in-memory models cache on delete", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const { buildAndCacheModels } = await import("../../apps/control-plane-worker/src/services/bootstrap");

      db.setAuthToken("sess-keys-cache-del-mem", {
        user_id: 612,
        id: 612,
        expires_at: Date.now() + 60_000,
        login: "keyuser-cache-del-mem",
        name: null,
        email: null,
      });
      db.setUser({ id: 612, openai_api_key: "enc:openai", github_token: null });

      const beforeDelete = await buildAndCacheModels(env, 612);
      expect(beforeDelete.find((group) => group.id === "openai")?.hasApiKey).toBe(true);

      const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-keys-cache-del-mem" },
      });
      expect(res.status).toBe(200);

      const afterDelete = await buildAndCacheModels(env, 612);
      expect(afterDelete.find((group) => group.id === "openai")?.hasApiKey).toBe(false);
    });
  });

  // ---- Models cache invalidation on PUT /api/settings/api-keys/:provider ----

  describe("PUT /api/settings/api-keys/:provider (cache invalidation)", () => {
    it("invalidates DERIVED_MODELS KV cache when saving an API key", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-cache-put", {
        user_id: 610,
        id: 610,
        expires_at: Date.now() + 60_000,
        login: "keyuser-cache-put",
        name: null,
        email: null,
      });
      db.setUser({ id: 610, openai_api_key: null, github_token: null });

      // Pre-populate models cache
      await modelsKv.put(modelsCacheKey(610), JSON.stringify([{ id: "openai", hasApiKey: false }]));
      expect(modelsKv.store.has(modelsCacheKey(610))).toBe(true);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-cache-put",
          },
          body: JSON.stringify({ apiKey: "sk-openai-test-key-123" }),
        });
        expect(res.status).toBe(200);

        // Cache entry should be deleted
        expect(modelsKv.store.has(modelsCacheKey(610))).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("invalidates DERIVED_MODELS KV cache when saving an invalid persisted API key", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-keys-cache-put-invalid", {
        user_id: 611,
        id: 611,
        expires_at: Date.now() + 60_000,
        login: "keyuser-cache-put-invalid",
        name: null,
        email: null,
      });
      db.setUser({ id: 611, openai_api_key: null, github_token: null });

      await modelsKv.put(modelsCacheKey(611), JSON.stringify([{ id: "openai", hasApiKey: true }]));
      expect(modelsKv.store.has(modelsCacheKey(611))).toBe(true);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-cache-put-invalid",
          },
          body: JSON.stringify({ apiKey: "sk-openai-invalid-cache-key" }),
        });
        expect(res.status).toBe(400);
        expect(modelsKv.store.has(modelsCacheKey(611))).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("invalidates the in-memory models cache when saving an API key", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const { buildAndCacheModels } = await import("../../apps/control-plane-worker/src/services/bootstrap");

      db.setAuthToken("sess-keys-cache-put-mem", {
        user_id: 613,
        id: 613,
        expires_at: Date.now() + 60_000,
        login: "keyuser-cache-put-mem",
        name: null,
        email: null,
      });
      db.setUser({ id: 613, openai_api_key: null, github_token: null });

      const beforeSave = await buildAndCacheModels(env, 613);
      expect(beforeSave.find((group) => group.id === "openai")?.hasApiKey).toBe(false);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.openai.com/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const res = await workerFetch(workerModule, env, "/api/settings/api-keys/openai", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "session_token=sess-keys-cache-put-mem",
          },
          body: JSON.stringify({ apiKey: "sk-openai-test-key-memory" }),
        });
        expect(res.status).toBe(200);

        const afterSave = await buildAndCacheModels(env, 613);
        expect(afterSave.find((group) => group.id === "openai")?.hasApiKey).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
