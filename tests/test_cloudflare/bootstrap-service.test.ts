import { beforeEach, describe, expect, it, vi } from "vitest";

import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";
import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";

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

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  resolveAuthUserExtras: vi.fn().mockResolvedValue({
    avatarUrl: "https://github.com/avatar.png",
    businessId: "biz-1",
    businessRole: "admin",
    githubUserId: null,
    linearConnected: true,
    notionConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
    availableIntegrations: ["openai", "linear"],
    integrationScopes: { openai: "user", linear: "user" },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  // Real error class so `assembleBootstrap`'s instanceof check works under the mock.
  UserRowMissingError: class UserRowMissingError extends Error {
    constructor(readonly userId: number) {
      super(`No users row for user_id ${userId}; settings write rejected`);
      this.name = "UserRowMissingError";
    }
  },
  getSettingsWithKeyStatus: vi.fn().mockResolvedValue({
    settings: {
      user_id: 42,
      default_pr_draft: 0,
      auto_verify_enabled: 1,
      automatic_reviews_enabled: 1,
      plan_mode_setting: "auto",
      use_codex_subscription: 0,
      default_model: "gpt-5.4-mini",
      default_repo: "acme/widgets",
      created_at: 1000,
      updated_at: 2000,
    },
    apiKeys: {
      openai: {
        isSet: true,
        lastValidatedAt: 123,
        lastValidationStatus: "validated",
        lastValidationReasonCode: null,
      },
    },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/services/repos", () => ({
  listAccessibleReposCacheFirst: vi.fn().mockResolvedValue({
    ok: true,
    repos: [
      {
        fullName: "acme/widgets",
        url: "https://github.com/acme/widgets",
        private: false,
        defaultBranch: "main",
        ownerType: "Organization",
      },
      {
        fullName: "acme/api",
        url: "https://github.com/acme/api",
        private: true,
        defaultBranch: "develop",
        ownerType: "Organization",
      },
    ],
    ssoOrgs: [{ orgId: 144570272, login: "mialabs", authorizeUrl: "https://github.com/orgs/mialabs/sso" }],
    cacheStatus: "hit",
  }),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/service", () => ({
  buildIntegrationScopes: vi
    .fn()
    .mockImplementation((rows: Array<{ integration_id: string; scope: string }>) =>
      Object.fromEntries(rows.map((row) => [row.integration_id, row.scope])),
    ),
  deriveAvailableIntegrations: vi.fn().mockReturnValue(["openai"]),
  getEffectiveProviderScope: vi
    .fn()
    .mockImplementation((scopes: Record<string, string> | null | undefined, provider: string) =>
      provider === "baseten" ? "user" : scopes?.[provider],
    ),
  getIntegrationScopes: vi.fn().mockResolvedValue({ openai: "user" }),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: vi.fn(),
  tracedEnv: (env: unknown) => env,
}));

import {
  assembleBootstrap,
  buildAndCacheModels,
  buildBootstrapCapabilities,
  MODELS_CACHE_TTL,
  modelsCacheKey,
  resetModelsMemoryCache,
} from "../../apps/control-plane-worker/src/services/bootstrap";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAuth(overrides?: Partial<AuthInfo>): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session_token",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 42,
      login: "jdoe",
      name: "Jane Doe",
      email: "jane@example.com",
      businessId: "biz-1",
      sharedSessions: true,
    },
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const batch = vi
    .fn()
    .mockResolvedValueOnce([
      { results: [{ business_id: "biz-1" }] },
      { results: [{ integration_id: "openai" }] },
      { results: [] },
    ])
    .mockResolvedValueOnce([
      {
        results: [
          { integration_id: "openai", scope: "user" },
          { integration_id: "openai", scope: "user" },
        ],
      },
      { results: [] },
    ]);

  const fakeDB = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ business_id: "biz-1" }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 0 } }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }),
    batch,
  };

  return {
    DB: fakeDB,
    REPOS_CACHE: { get: vi.fn(), put: vi.fn() },
    DERIVED_MODELS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
    },
    ...overrides,
  } as unknown as Env;
}

function makeRequest(): Request {
  return new Request("https://example.com/api/bootstrap");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelsMemoryCache();
  });

  it("returns complete bootstrap payload on success", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    expect(result.authenticated).toBe(true);
    expect(result.warnings).toEqual([]);

    // User fields present
    expect(result.user.id).toBe(42);
    expect(result.user.login).toBe("jdoe");
    expect(result.user.name).toBe("Jane Doe");
    expect(result.user.email).toBe("jane@example.com");
    expect(result.user.avatarUrl).toBe("https://github.com/avatar.png");
    expect(result.user.businessId).toBe("biz-1");
    expect(result.user.businessRole).toBe("admin");
    expect(result.user.sharedSessions).toBe(true);
    expect(result.user.linearConnected).toBe(true);
    expect(result.user.slackConnected).toBe(false);
    expect(result.capabilities).toEqual({
      canAccessIntegrationDebug: true,
      canManageBusinessIntegrations: true,
      canManageCliTokens: true,
      canUseBusinessSessions: true,
      canAdminPendingSignups: false,
      canStartSupportView: false,
      canUseInternalModelProviderKeys: false,
      computerUse: false,
      canUseControlRoom: false,
      planApproval: true,
    });

    // Models present
    expect(result.models).not.toBeNull();
    expect(result.models!.length).toBeGreaterThan(0);
    for (const group of result.models!) {
      expect(group).toHaveProperty("id");
      expect(group).toHaveProperty("name");
      expect(group).toHaveProperty("models");
      for (const model of group.models) {
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("name");
        expect(model).toHaveProperty("label");
      }
    }

    // Repos present
    expect(result.repos).toEqual([
      {
        fullName: "acme/widgets",
        url: "https://github.com/acme/widgets",
        private: false,
        defaultBranch: "main",
        ownerType: "Organization",
      },
      {
        fullName: "acme/api",
        url: "https://github.com/acme/api",
        private: true,
        defaultBranch: "develop",
        ownerType: "Organization",
      },
    ]);

    // SSO-withheld orgs are carried through for first paint
    expect(result.ssoOrgs).toEqual([
      { orgId: 144570272, login: "mialabs", authorizeUrl: "https://github.com/orgs/mialabs/sso" },
    ]);

    // Settings present
    expect(result.settings).toEqual({
      defaultPrDraft: false,
      autoVerifyEnabled: true,
      automaticReviewsEnabled: true,
      planMode: "auto",
      planApprovalRequired: true,
      settingsProfile: "custom",
      useCodexSubscription: false,
      defaultModel: "gpt-5.4-mini",
      defaultRepo: "acme/widgets",
      apiKeys: {
        openai: {
          isSet: true,
          lastValidatedAt: 123,
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        },
      },
    });
  });

  it("excludes internal fields from user (no integrationTools, integrationScopes, availableIntegrations)", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const userKeys = Object.keys(result.user);
    expect(userKeys).not.toContain("availableIntegrations");
    expect(userKeys).not.toContain("integrationTools");
    expect(userKeys).not.toContain("integrationScopes");
  });

  it("includes the full settings payload needed by the UI without integration metadata", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const settingsKeys = Object.keys(result.settings!);
    expect(settingsKeys).toContain("apiKeys");
    expect(settingsKeys).not.toContain("availableIntegrations");
    expect(settingsKeys).not.toContain("integrationScopes");
  });

  it("derives capability flags from server-side user state", () => {
    expect(
      buildBootstrapCapabilities({
        id: 1,
        businessId: ARCANIST_BUSINESS_ID,
        businessRole: "admin",
        sharedSessions: true,
      }),
    ).toEqual({
      canAccessIntegrationDebug: true,
      canManageBusinessIntegrations: true,
      canManageCliTokens: true,
      canUseBusinessSessions: true,
      canAdminPendingSignups: false,
      canStartSupportView: true,
      canUseInternalModelProviderKeys: true,
      computerUse: true,
      canUseControlRoom: true,
      planApproval: true,
    });

    expect(
      buildBootstrapCapabilities({
        id: 1,
        businessId: "biz-1",
        businessRole: "admin",
        sharedSessions: true,
      }),
    ).toEqual({
      canAccessIntegrationDebug: true,
      canManageBusinessIntegrations: true,
      canManageCliTokens: true,
      canUseBusinessSessions: true,
      canAdminPendingSignups: false,
      canStartSupportView: false,
      canUseInternalModelProviderKeys: false,
      computerUse: false,
      canUseControlRoom: false,
      planApproval: true,
    });

    expect(
      buildBootstrapCapabilities({
        id: 42,
        businessId: "biz-1",
        businessRole: "member",
        sharedSessions: false,
      }),
    ).toEqual({
      canAccessIntegrationDebug: false,
      canManageBusinessIntegrations: false,
      canManageCliTokens: true,
      canUseBusinessSessions: false,
      canAdminPendingSignups: false,
      canStartSupportView: false,
      canUseInternalModelProviderKeys: false,
      computerUse: false,
      canUseControlRoom: false,
      planApproval: true,
    });
  });

  it("gates canUseControlRoom to Cycloid members (prod + QA), excluding customers and impersonation", () => {
    // Prod Cycloid member (non-admin) is granted.
    expect(
      buildBootstrapCapabilities({
        id: 1,
        businessId: ARCANIST_BUSINESS_ID,
        businessRole: "member",
        sharedSessions: false,
      }).canUseControlRoom,
    ).toBe(true);

    // QA Cycloid member is treated the same as prod.
    expect(
      buildBootstrapCapabilities({
        id: 2,
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        businessRole: "member",
        sharedSessions: false,
      }).canUseControlRoom,
    ).toBe(true);

    // Customer-business member is denied.
    expect(
      buildBootstrapCapabilities({
        id: 3,
        businessId: "biz-customer",
        businessRole: "admin",
        sharedSessions: false,
      }).canUseControlRoom,
    ).toBe(false);

    // Cycloid member while impersonating a customer is denied (read-only
    // internal dashboards must not surface for the impersonated customer).
    expect(
      buildBootstrapCapabilities({
        id: 4,
        businessId: ARCANIST_BUSINESS_ID,
        businessRole: "admin",
        sharedSessions: true,
        isImpersonating: true,
      }).canUseControlRoom,
    ).toBe(false);
  });

  it("derives all internal-admin capabilities from Cycloid business admin status, not a GitHub allowlist", async () => {
    const auth = makeAuth({
      user: {
        id: 42,
        login: "jdoe",
        name: "Jane Doe",
        email: "jane@example.com",
        businessId: "biz-customer",
        githubUserId: 99999999,
        sharedSessions: true,
      },
    });
    const { resolveAuthUserExtras } = await import("../../apps/control-plane-worker/src/auth/db");
    vi.mocked(resolveAuthUserExtras).mockResolvedValueOnce({
      avatarUrl: "https://github.com/avatar.png",
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "admin",
      githubUserId: 99999999,
      linearConnected: true,
      notionConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
      availableIntegrations: ["openai", "linear"],
      integrationScopes: { openai: "user", linear: "user" },
    });

    const result = await assembleBootstrap(makeEnv(), makeRequest(), auth);

    expect(result.user.businessId).toBe(ARCANIST_BUSINESS_ID);
    // Admin of the Cycloid business, not in any GitHub allowlist: now a full
    // internal admin since membership is the single source of truth.
    expect(result.user.isCycloidAdmin).toBe(true);
    expect(result.capabilities.canAdminPendingSignups).toBe(true);
    expect(result.capabilities.canStartSupportView).toBe(true);
  });

  // Removed: self-hosted sandbox capability gating no longer exists (backend removed).

  it("sets canAdminPendingSignups when the bootstrap user is a Cycloid admin", () => {
    const capabilities = buildBootstrapCapabilities({
      id: 1,
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "admin",
      sharedSessions: true,
      isCycloidAdmin: true,
    });

    expect(capabilities.canAdminPendingSignups).toBe(true);
    expect(capabilities.canStartSupportView).toBe(true);
    expect(capabilities.planApproval).toBe(true);
  });

  it("hides Cycloid-admin support capabilities while impersonating", () => {
    const capabilities = buildBootstrapCapabilities({
      id: 1,
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "admin",
      sharedSessions: true,
      isCycloidAdmin: true,
      isImpersonating: true,
    });

    expect(capabilities.canAdminPendingSignups).toBe(false);
    expect(capabilities.canStartSupportView).toBe(false);
    expect(capabilities.canUseControlRoom).toBe(false);
  });

  it("degrades gracefully when repos fail", async () => {
    const { listAccessibleReposCacheFirst } = await import("../../apps/control-plane-worker/src/services/repos");
    vi.mocked(listAccessibleReposCacheFirst).mockRejectedValueOnce(new Error("GitHub API error"));

    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    expect(result.authenticated).toBe(true);
    expect(result.user.id).toBe(42);
    expect(result.repos).toBeNull();
    expect(result.reposPending).toBe(false);
    expect(result.ssoOrgs).toEqual([]);
    expect(result.warnings).toContain("Failed to load repositories");
    expect(result.models).not.toBeNull();
    expect(result.settings).not.toBeNull();
  });

  it("marks repos pending (no warning) when the cache-only read defers the fetch", async () => {
    const { listAccessibleReposCacheFirst } = await import("../../apps/control-plane-worker/src/services/repos");
    vi.mocked(listAccessibleReposCacheFirst).mockResolvedValueOnce({
      ok: true,
      pending: true,
      repos: null,
      ssoOrgs: [],
      cacheStatus: "pending",
    });

    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    expect(result.authenticated).toBe(true);
    expect(result.repos).toBeNull();
    expect(result.reposPending).toBe(true);
    expect(result.warnings).not.toContain("Failed to load repositories");
    expect(result.models).not.toBeNull();
    expect(result.settings).not.toBeNull();
  });

  it("degrades gracefully when settings fail", async () => {
    const { getSettingsWithKeyStatus } = await import("../../apps/control-plane-worker/src/settings/db");
    vi.mocked(getSettingsWithKeyStatus).mockRejectedValueOnce(new Error("D1 unavailable"));

    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    expect(result.authenticated).toBe(true);
    expect(result.settings).toBeNull();
    expect(result.warnings).toContain("Failed to load settings");
    expect(result.repos).not.toBeNull();
  });

  it("propagates UserRowMissingError instead of degrading (route maps it to 401)", async () => {
    const { getSettingsWithKeyStatus, UserRowMissingError } =
      await import("../../apps/control-plane-worker/src/settings/db");
    vi.mocked(getSettingsWithKeyStatus).mockRejectedValueOnce(new UserRowMissingError(42));

    await expect(assembleBootstrap(makeEnv(), makeRequest(), makeAuth())).rejects.toBeInstanceOf(UserRowMissingError);
  });

  it("degrades gracefully when models fail", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch).mockReset();
    vi.mocked(env.DB.batch).mockRejectedValueOnce(new Error("D1 unavailable"));

    const result = await assembleBootstrap(env, makeRequest(), makeAuth());

    expect(result.authenticated).toBe(true);
    expect(result.models).toBeNull();
    expect(result.warnings).toContain("Failed to load models");
    expect(result.repos).not.toBeNull();
    expect(result.settings).not.toBeNull();
  });

  it("throws when user resolution fails (required field)", async () => {
    const { resolveAuthUserExtras } = await import("../../apps/control-plane-worker/src/auth/db");
    vi.mocked(resolveAuthUserExtras).mockRejectedValueOnce(new Error("D1 unavailable"));

    await expect(assembleBootstrap(makeEnv(), makeRequest(), makeAuth())).rejects.toThrow("D1 unavailable");
  });

  it("throws when auth has no user profile", async () => {
    const authNoUser = makeAuth({ user: undefined });

    await expect(assembleBootstrap(makeEnv(), makeRequest(), authNoUser)).rejects.toThrow(
      "Bootstrap requires an authenticated user with profile data",
    );
  });

  it("handles multiple simultaneous failures gracefully", async () => {
    const { listAccessibleReposCacheFirst } = await import("../../apps/control-plane-worker/src/services/repos");
    const { getSettingsWithKeyStatus } = await import("../../apps/control-plane-worker/src/settings/db");
    const env = makeEnv();

    vi.mocked(listAccessibleReposCacheFirst).mockRejectedValueOnce(new Error("repos fail"));
    vi.mocked(getSettingsWithKeyStatus).mockRejectedValueOnce(new Error("settings fail"));
    vi.mocked(env.DB.batch).mockReset();
    vi.mocked(env.DB.batch).mockRejectedValueOnce(new Error("models fail"));

    const result = await assembleBootstrap(env, makeRequest(), makeAuth());

    expect(result.authenticated).toBe(true);
    expect(result.user.id).toBe(42);
    expect(result.models).toBeNull();
    expect(result.repos).toBeNull();
    expect(result.settings).toBeNull();
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings).toContain("Failed to load models");
    expect(result.warnings).toContain("Failed to load repositories");
    expect(result.warnings).toContain("Failed to load settings");
  });

  it("model groups have display-safe shape only", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const allowedGroupKeys = new Set(["id", "name", "models", "hasApiKey"]);
    const allowedModelKeys = new Set(["id", "name", "label", "backends", "contextWindow", "reasoning"]);

    for (const group of result.models ?? []) {
      for (const key of Object.keys(group)) {
        expect(allowedGroupKeys).toContain(key);
      }
      for (const model of group.models) {
        for (const key of Object.keys(model)) {
          expect(allowedModelKeys).toContain(key);
        }
        // Core fields always present
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("name");
        expect(model).toHaveProperty("label");
      }
    }
  });

  it("returns only session-start launch models", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const allModelIds = (result.models ?? []).flatMap((group) => group.models.map((model) => model.id));
    expect(allModelIds).toEqual([
      "gpt-5.4",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
  });

  it("adds Codex subscription models only for validated subscription auth", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([
        { results: [{ business_id: ARCANIST_BUSINESS_ID }] },
        {
          results: [
            {
              integration_id: "codex_subscription",
              api_key: "encrypted-auth-json",
              external_user_id: "auth_json:42",
              encrypted: 1,
              last_validation_status: "validated",
            },
          ],
        },
        { results: [{ use_codex_subscription: 1 }] },
      ])
      .mockResolvedValueOnce([
        { results: [{ integration_id: "openai", scope: "user" }] },
        { results: [] },
        { results: [{ codex_byos_enabled: 1 }] },
      ]);

    const models = await buildAndCacheModels(env, 42);

    const allModelIds = models.flatMap((group) => group.models.map((model) => model.id));
    expect(allModelIds).toContain("gpt-5.3-codex-spark");
  });

  it("adds Codex subscription models for a non-Cycloid workspace opted into BYOS (ARC-1517)", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([
        { results: [{ business_id: "cust-biz-byos" }] },
        {
          results: [
            {
              integration_id: "codex_subscription",
              api_key: "encrypted-auth-json",
              external_user_id: "auth_json:42",
              encrypted: 1,
              last_validation_status: "validated",
            },
          ],
        },
        { results: [{ use_codex_subscription: 1 }] },
      ])
      .mockResolvedValueOnce([
        { results: [{ integration_id: "openai", scope: "user" }] },
        { results: [] },
        { results: [{ codex_byos_enabled: 1 }] },
      ]);

    const models = await buildAndCacheModels(env, 42);

    const allModelIds = models.flatMap((group) => group.models.map((model) => model.id));
    expect(allModelIds).toContain("gpt-5.3-codex-spark");
  });

  it("hides Codex subscription models for a workspace not opted into BYOS (ARC-1517)", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([
        { results: [{ business_id: "cust-biz-no-byos" }] },
        {
          results: [
            {
              integration_id: "codex_subscription",
              api_key: "encrypted-auth-json",
              external_user_id: "auth_json:42",
              encrypted: 1,
              last_validation_status: "validated",
            },
          ],
        },
        { results: [{ use_codex_subscription: 1 }] },
      ])
      .mockResolvedValueOnce([
        { results: [{ integration_id: "openai", scope: "user" }] },
        { results: [] },
        { results: [{ codex_byos_enabled: 0 }] },
      ]);

    const models = await buildAndCacheModels(env, 42);

    const allModelIds = models.flatMap((group) => group.models.map((model) => model.id));
    expect(allModelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it("hides Codex subscription models when subscription auth is unvalidated", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([
        { results: [{ business_id: ARCANIST_BUSINESS_ID }] },
        {
          results: [
            {
              integration_id: "codex_subscription",
              api_key: "encrypted-auth-json",
              external_user_id: "auth_json:42",
              encrypted: 1,
              last_validation_status: "saved_unverified",
            },
          ],
        },
        { results: [{ use_codex_subscription: 1 }] },
      ])
      .mockResolvedValueOnce([{ results: [{ integration_id: "openai", scope: "user" }] }, { results: [] }]);

    const models = await buildAndCacheModels(env, 42);

    const allModelIds = models.flatMap((group) => group.models.map((model) => model.id));
    expect(allModelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it("shows the Baseten opencode model only when a validated user key is present", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([
        { results: [{ business_id: ARCANIST_BUSINESS_ID }] },
        { results: [{ integration_id: "baseten", api_key: "enc:baseten", last_validation_status: "validated" }] },
        { results: [] },
      ])
      .mockResolvedValueOnce([{ results: [] }, { results: [] }]);

    const models = await buildAndCacheModels(env, 42);

    expect(models.find((group) => group.id === "baseten")).toEqual(
      expect.objectContaining({
        hasApiKey: true,
        models: [expect.objectContaining({ id: "kimi-k2.7-code" })],
      }),
    );
  });

  it("hides the Baseten opencode model when the saved user key is not validated", async () => {
    const env = makeEnv();
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([
        { results: [{ business_id: ARCANIST_BUSINESS_ID }] },
        { results: [{ integration_id: "baseten", api_key: "enc:baseten", last_validation_status: "invalid" }] },
        { results: [] },
      ])
      .mockResolvedValueOnce([{ results: [] }, { results: [] }]);

    const models = await buildAndCacheModels(env, 42);

    expect(models.find((group) => group.id === "baseten")).toBeUndefined();
  });

  it("model options include reasoning config where applicable", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const allModels = (result.models ?? []).flatMap((g) => g.models);
    expect(allModels.find((model) => model.id === "gpt-5.6-sol")?.reasoning).toEqual({
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      default: "medium",
    });

    // Launch models should carry reasoning metadata where providers support it.
    const withReasoning = allModels.filter((m) => m.reasoning);
    expect(withReasoning.length).toBeGreaterThan(0);

    for (const model of withReasoning) {
      expect(Array.isArray(model.reasoning!.efforts)).toBe(true);
      expect(model.reasoning!.efforts.length).toBeGreaterThan(0);
      // default is optional (some models have undefined default)
    }
  });

  it("model options include contextWindow where applicable", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const allModels = (result.models ?? []).flatMap((g) => g.models);

    // At least one model should have a context window (OpenAI models do)
    const withContextWindow = allModels.filter((m) => m.contextWindow != null);
    expect(withContextWindow.length).toBeGreaterThan(0);

    for (const model of withContextWindow) {
      expect(typeof model.contextWindow).toBe("number");
      expect(model.contextWindow!).toBeGreaterThan(0);
    }
  });

  it("reasoning config does not leak internal type names", async () => {
    const result = await assembleBootstrap(makeEnv(), makeRequest(), makeAuth());

    const allModels = (result.models ?? []).flatMap((g) => g.models);
    for (const model of allModels) {
      if (!model.reasoning) continue;
      // Efforts should be plain strings, not objects
      for (const effort of model.reasoning.efforts) {
        expect(typeof effort).toBe("string");
      }
      if (model.reasoning.default != null) {
        expect(typeof model.reasoning.default).toBe("string");
      }
    }
  });

  it("writes models to DERIVED_MODELS KV cache on cache miss", async () => {
    const env = makeEnv();
    const result = await assembleBootstrap(env, makeRequest(), makeAuth());

    expect(result.models).not.toBeNull();
    expect(env.DERIVED_MODELS.put).toHaveBeenCalledWith(modelsCacheKey(42), expect.any(String), {
      expirationTtl: MODELS_CACHE_TTL,
    });
  });

  it("marks local .dev.vars provider keys as available without using stale model cache", async () => {
    const env = makeEnv({ WORKER_ENV: "local", OPENAI_API_KEY_INTERNAL_REVIEW: "local-openai-key" });
    vi.mocked(env.DB.batch)
      .mockReset()
      .mockResolvedValueOnce([{ results: [{ business_id: "biz-1" }] }, { results: [] }, { results: [] }])
      .mockResolvedValueOnce([
        {
          results: [{ integration_id: "openai", scope: "user" }],
        },
        { results: [] },
      ]);
    vi.mocked(env.DERIVED_MODELS.get).mockResolvedValueOnce([
      { id: "openai", name: "OpenAI", models: [], hasApiKey: false },
    ]);

    const models = await buildAndCacheModels(env, 42);

    expect(models.find((group) => group.id === "openai")?.hasApiKey).toBe(true);
    expect(env.DERIVED_MODELS.get).not.toHaveBeenCalled();
    expect(env.DERIVED_MODELS.put).not.toHaveBeenCalled();
  });

  it("serves repeated model requests from memory before checking KV", async () => {
    const env = makeEnv();

    const first = await buildAndCacheModels(env, 42);
    expect(first.length).toBeGreaterThan(0);

    vi.mocked(env.DERIVED_MODELS.get).mockClear();
    vi.mocked(env.DB.batch).mockClear();

    const second = await buildAndCacheModels(env, 42);

    expect(second).toEqual(first);
    expect(env.DERIVED_MODELS.get).not.toHaveBeenCalled();
    expect(env.DB.batch).not.toHaveBeenCalled();
  });

  it("returns cached models from DERIVED_MODELS KV on cache hit", async () => {
    const cachedModels = [{ id: "openai", name: "OpenAI", models: [], hasApiKey: true }];
    const env = makeEnv();
    vi.mocked(env.DERIVED_MODELS.get).mockResolvedValueOnce(cachedModels);

    const result = await assembleBootstrap(env, makeRequest(), makeAuth());

    expect(result.models).toEqual(cachedModels);
  });

  it("falls back to D1 when DERIVED_MODELS KV read fails", async () => {
    const env = makeEnv();
    vi.mocked(env.DERIVED_MODELS.get).mockRejectedValueOnce(new Error("KV unavailable"));

    const result = await assembleBootstrap(env, makeRequest(), makeAuth());

    // Should still return models from D1 fallback
    expect(result.models).not.toBeNull();
    expect(result.models!.length).toBeGreaterThan(0);
  });
});
