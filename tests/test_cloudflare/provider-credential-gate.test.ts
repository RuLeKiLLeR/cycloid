import { describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  assertEffectiveProviderCredentialForModel,
  evaluateProviderCredentialForModel,
  ProviderCredentialGateSkipDeniedError,
  ProviderCredentialNotValidatedError,
} from "../../apps/control-plane-worker/src/services/provider-credential-gate";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { ENVIRONMENT } from "../../shared/constants/environment";
import { CREDENTIAL_VALIDATION_STATUS } from "../../shared/constants/onboarding";

interface UserCredentialRow {
  api_key: string | null;
  external_user_id?: string | null;
  encrypted?: number | null;
  last_validation_status: string | null;
  last_validation_reason_code: string | null;
}

interface BusinessScopeRow {
  integration_id: string;
  scope: "disabled" | "user" | "business";
}

interface BusinessCredentialRow {
  api_key: string | null;
  last_validation_status: string | null;
  last_validation_reason_code: string | null;
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId, provider] = this.values as [string, string];
      return (this.db.businessCredentials.get(`${businessId}:${provider}`) as T | undefined) ?? null;
    }
    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM business_integrations")) {
      const [businessId] = this.values as [string | undefined];
      const results =
        businessId === undefined
          ? []
          : [...this.db.businessScopes.values()].filter(
              (row) => row.integration_id && businessId === this.db.businessId,
            );
      return { results: results as T[] };
    }
    if (this.query.includes("FROM user_integrations")) {
      const [userId, provider] = this.values as [number, string];
      const row = this.db.userCredentials.get(`${userId}:${provider}`);
      return { results: (row ? [row] : []) as T[] };
    }
    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.values as [number];
      const value = this.db.useCodexSubscriptionByUserId.get(userId) ?? 0;
      return { results: [{ use_codex_subscription: value }] as T[] };
    }
    if (this.query.includes("codex_byos_enabled")) {
      // Placeholder `SELECT 0 ... WHERE 1 = 0` (no businessId) yields no row.
      if (this.query.includes("WHERE 1 = 0")) return { results: [] as T[] };
      const [businessId] = this.values as [string];
      // Mirror migration 0255: prod Cycloid is seeded on; any business the test
      // explicitly opted in via `codexByosBusinessIds` is also on.
      const enabled = businessId === SEEDED_ARCANIST_BUSINESS_ID || this.db.codexByosBusinessIds.has(businessId);
      return { results: [{ codex_byos_enabled: enabled ? 1 : 0 }] as T[] };
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }
}

// Prod Cycloid business UUID; migration 0255 seeds codex_byos_enabled=1 for it, so
// the fake DB mirrors that. Single source of truth = the shared constant.
const SEEDED_ARCANIST_BUSINESS_ID = SEEDED_BUSINESS_IDS.cycloid;

class FakeD1 {
  businessId = "biz-1";
  userCredentials = new Map<string, UserCredentialRow>();
  useCodexSubscriptionByUserId = new Map<number, number>();
  businessScopes = new Map<string, BusinessScopeRow>();
  businessCredentials = new Map<string, BusinessCredentialRow>();
  codexByosBusinessIds = new Set<string>();

  prepare(query: string): FakeStatement {
    return new FakeStatement(this, query);
  }

  async batch<T extends Array<{ all: () => Promise<{ results: unknown[] }> }>>(
    statements: T,
  ): Promise<Array<{ results: unknown[] }>> {
    return Promise.all(statements.map((statement) => statement.all()));
  }
}

function envFor(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ...overrides,
  } as Env;
}

function addUserKey(
  db: FakeD1,
  provider: "openai" | "anthropic" | "baseten",
  status: string | null,
  apiKey = `${provider}-key`,
): void {
  db.userCredentials.set(`42:${provider}`, {
    api_key: apiKey,
    last_validation_status: status,
    last_validation_reason_code: null,
  });
}

function addCodexSubscriptionAuth(
  db: FakeD1,
  status: string | null,
  options: { useCodexSubscription?: number } = {},
): void {
  db.userCredentials.set("42:codex_subscription", {
    api_key: "encrypted-auth-json",
    external_user_id: "auth_json:42",
    encrypted: 1,
    last_validation_status: status,
    last_validation_reason_code: null,
  });
  db.useCodexSubscriptionByUserId.set(42, options.useCodexSubscription ?? 1);
}

describe("assertEffectiveProviderCredentialForModel", () => {
  const cycloidBusinessId = SEEDED_ARCANIST_BUSINESS_ID;
  it.each([ENVIRONMENT.Test, ENVIRONMENT.Local])(
    "allows credential-gate skip in the %s worker environment",
    async (workerEnv) => {
      const db = new FakeD1();

      await expect(
        evaluateProviderCredentialForModel(envFor(db, { WORKER_ENV: workerEnv }), {
          ownerUserId: "42",
          businessId: "biz-1",
          modelId: "claude-opus-4-8",
          sessionId: "session-skip",
          credentialGate: { mode: "skip", reason: "unit test" },
        }),
      ).resolves.toEqual({ ok: true, provider: null });

      expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
    },
  );

  it.each([ENVIRONMENT.Production, ENVIRONMENT.Qa, ENVIRONMENT.Development, undefined])(
    "denies credential-gate skip in the %s worker environment",
    async (workerEnv) => {
      const db = new FakeD1();
      const env = envFor(db, workerEnv === undefined ? {} : { WORKER_ENV: workerEnv });

      await expect(
        evaluateProviderCredentialForModel(env, {
          ownerUserId: "42",
          businessId: "biz-1",
          modelId: "claude-opus-4-8",
          sessionId: "session-skip",
          credentialGate: { mode: "skip", reason: "unit test" },
        }),
      ).rejects.toBeInstanceOf(ProviderCredentialGateSkipDeniedError);

      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          event: "session_create.provider_credential_gate_skip_denied",
          workerEnv: workerEnv ?? null,
          ownerUserId: "42",
          businessId: "biz-1",
          modelId: "claude-opus-4-8",
          sessionId: "session-skip",
          reason: "unit test",
        }),
      );
      mockPostStructuredEventToDd.mockClear();
    },
  );

  it("allows a validated user BYOK row", async () => {
    const db = new FakeD1();
    addUserKey(db, "anthropic", CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "biz-1",
        modelId: "claude-opus-4-8",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a present user BYOK row that is not validated", async () => {
    const db = new FakeD1();
    addUserKey(db, "anthropic", CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED);

    const error = await assertEffectiveProviderCredentialForModel(envFor(db), {
      ownerUserId: "42",
      businessId: "biz-1",
      modelId: "claude-opus-4-8",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderCredentialNotValidatedError);
    expect(error).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
  });

  it("allows local-dev provider keys without a validated BYOK row", async () => {
    const db = new FakeD1();

    await expect(
      assertEffectiveProviderCredentialForModel(
        envFor(db, { WORKER_ENV: "local", ARCANIST_ANTHROPIC_API_KEY: "local-anthropic-key" }),
        {
          ownerUserId: "42",
          businessId: "biz-1",
          modelId: "claude-opus-4-8",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("allows a validated Baseten user key for the opencode OSS model", async () => {
    const db = new FakeD1();
    addUserKey(db, "baseten", CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "customer-business",
        modelId: "kimi-k2.7-code",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks the Baseten opencode OSS model without a validated user key", async () => {
    const db = new FakeD1();

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "customer-business",
        modelId: "kimi-k2.7-code",
      }),
    ).rejects.toMatchObject({
      provider: "baseten",
      modelId: "kimi-k2.7-code",
      reasonCode: "credentials_missing",
      message: expect.stringContaining("Baseten"),
    });
  });

  it("does not use business-scoped Baseten credentials for opencode OSS models", async () => {
    const db = new FakeD1();
    db.businessCredentials.set("customer-business:baseten", {
      api_key: "business-baseten-key",
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
      last_validation_reason_code: null,
    });

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "customer-business",
        modelId: "kimi-k2.7-code",
      }),
    ).rejects.toMatchObject({
      provider: "baseten",
      reasonCode: "credentials_missing",
    });
  });

  it("allows Spark with validated Codex subscription auth selected", async () => {
    const db = new FakeD1();
    addCodexSubscriptionAuth(db, CREDENTIAL_VALIDATION_STATUS.VALIDATED);

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: cycloidBusinessId,
        modelId: "gpt-5.3-codex-spark",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows Spark with saved-unverified Codex subscription auth selected", async () => {
    const db = new FakeD1();
    addCodexSubscriptionAuth(db, CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED);

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: cycloidBusinessId,
        modelId: "gpt-5.3-codex-spark",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks Spark when Codex subscription auth is invalid", async () => {
    const db = new FakeD1();
    addCodexSubscriptionAuth(db, CREDENTIAL_VALIDATION_STATUS.INVALID);

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: cycloidBusinessId,
        modelId: "gpt-5.3-codex-spark",
      }),
    ).rejects.toMatchObject({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      reasonCode: "credentials_missing",
    });
  });

  it("allows a standard OpenAI model with Codex subscription auth selected", async () => {
    const db = new FakeD1();
    addCodexSubscriptionAuth(db, CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED);

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: cycloidBusinessId,
        modelId: "gpt-5.4",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows validated business-scope keys", async () => {
    const db = new FakeD1();
    db.businessScopes.set("biz-1:anthropic", {
      integration_id: "anthropic",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:anthropic", {
      api_key: "business-anthropic-key",
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
      last_validation_reason_code: null,
    });

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "biz-1",
        modelId: "claude-opus-4-8",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks invalid business-scope keys", async () => {
    const db = new FakeD1();
    db.businessScopes.set("biz-1:anthropic", {
      integration_id: "anthropic",
      scope: "business",
    });
    db.businessCredentials.set("biz-1:anthropic", {
      api_key: "business-anthropic-key",
      last_validation_status: CREDENTIAL_VALIDATION_STATUS.INVALID,
      last_validation_reason_code: null,
    });

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "biz-1",
        modelId: "claude-opus-4-8",
      }),
    ).rejects.toMatchObject({ reasonCode: "credentials_invalid" });
  });

  it("blocks missing business-scope keys with a business-managed reason", async () => {
    const db = new FakeD1();
    db.businessScopes.set("biz-1:anthropic", {
      integration_id: "anthropic",
      scope: "business",
    });

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "biz-1",
        modelId: "claude-opus-4-8",
      }),
    ).rejects.toMatchObject({ reasonCode: "business_managed" });
  });

  it("blocks disabled provider scope even when a validated user key exists", async () => {
    const db = new FakeD1();
    addUserKey(db, "anthropic", CREDENTIAL_VALIDATION_STATUS.VALIDATED);
    db.businessScopes.set("biz-1:anthropic", {
      integration_id: "anthropic",
      scope: "disabled",
    });

    await expect(
      assertEffectiveProviderCredentialForModel(envFor(db), {
        ownerUserId: "42",
        businessId: "biz-1",
        modelId: "claude-opus-4-8",
      }),
    ).rejects.toMatchObject({ reasonCode: "integration_disabled" });
  });
});
