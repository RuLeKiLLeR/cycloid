import { CODEX_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import {
  type ToggleableIntegrationId,
  USER_API_KEY_PROVIDER_IDS,
} from "../../../../shared/constants/integration-helpers.js";
import {
  CODEX_SUBSCRIPTION_SESSION_START_MODEL_PROVIDER_GROUPS,
  extractSessionStartModelIdAnyBackend,
  getDefaultSessionStartModelIdForBackend,
  getProviderForModel,
  MODEL_CONTEXT_WINDOWS,
  normalizeRetiredBasetenModelId,
  PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS,
} from "../../../../shared/constants/models.js";
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
} from "../../../../shared/constants/onboarding.js";
import type {
  BootstrapCapabilities,
  BootstrapModelGroup,
  BootstrapRepo,
  BootstrapResponse,
  BootstrapSettings,
  BootstrapUser,
  SsoOrg,
} from "../../../../shared/types/bootstrap.js";
import { resolveAuthUserExtras } from "../auth/db";
import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";
import { listBusinessMemberUserIds } from "../business/db";
import { SEEDED_BUSINESS_IDS } from "../constants/businesses";
import { PLAN_APPROVAL_ACTIVATION } from "../constants/plan-approval";
import type { IntegrationScope } from "../enums/integrations";
import { CODEX_SUBSCRIPTION_INTEGRATION_ID, codexSubscriptionAuthJsonExternalUserId } from "../integrations/db";
import {
  buildIntegrationScopes,
  deriveAvailableIntegrations,
  getEffectiveProviderScope,
} from "../integrations/service";
import { createLogger } from "../logger";
import { resolveEffectiveAutonomySettings } from "../settings/autonomy";
import { getSettingsWithKeyStatus, UserRowMissingError } from "../settings/db";
import type { AuthInfo, Env } from "../types";
import { isCycloidAdmin as isCycloidAdminGate, isCycloidMember as isCycloidMemberGate } from "./internal-feature-gate";

const log = createLogger({ bindings: { component: "bootstrap" } });
const USER_API_KEY_PROVIDER_SQL_LIST = USER_API_KEY_PROVIDER_IDS.map((provider) => `'${provider}'`).join(", ");
// Provider of the DEFAULT agent runtime backend (codex/openai today). Its
// model group is always shown, key or not; other providers are key-gated.
const DEFAULT_BACKEND_PROVIDER_ID = getProviderForModel(
  getDefaultSessionStartModelIdForBackend(CODEX_AGENT_RUNTIME_BACKEND),
);
const MODELS_MEMORY_CACHE_MAX_ENTRIES = 500;
const MODELS_MEMORY_TTL_MS = 60_000;
const modelsMemoryCache = createBoundedTtlMemoryCache<number, BootstrapModelGroup[]>(MODELS_MEMORY_CACHE_MAX_ENTRIES);
const MODELS_CACHE_SCHEMA_VERSION = 5;

type UserModelAvailabilityRow = {
  integration_id: string;
  api_key?: string | null;
  external_user_id?: string | null;
  encrypted?: number | null;
  last_validation_status?: CredentialValidationStatus | null;
};

export const MODELS_CACHE_TTL = 300;
export type ModelsCacheStatus = "hit" | "miss" | "n/a";

export function modelsCacheKey(userId: number): string {
  return `models:v${MODELS_CACHE_SCHEMA_VERSION}:${userId}`;
}

export function invalidateModelsMemoryCache(userId: number): void {
  modelsMemoryCache.delete(userId);
}

export async function invalidateBusinessModelsCache(
  env: Pick<Env, "DB" | "DERIVED_MODELS">,
  businessId: string,
): Promise<void> {
  let userIds: number[];
  try {
    userIds = await listBusinessMemberUserIds(env.DB, businessId);
  } catch {
    // Best-effort: stale entries expire via the short model cache TTL.
    return;
  }

  await Promise.all(
    userIds.map(async (userId) => {
      invalidateModelsMemoryCache(userId);
      try {
        await env.DERIVED_MODELS.delete(modelsCacheKey(userId));
      } catch {
        // Best-effort: stale entries expire via the short model cache TTL.
      }
    }),
  );
}

export function resetModelsMemoryCache(): void {
  modelsMemoryCache.clear();
}

function buildProviderKeyStatusFromPresence(
  userProviderIds: Set<string>,
  businessProviderIds: Set<string>,
  scopes: Record<ToggleableIntegrationId, IntegrationScope> | null,
): Record<string, boolean> {
  if (!scopes) {
    return Object.fromEntries(USER_API_KEY_PROVIDER_IDS.map((provider) => [provider, userProviderIds.has(provider)]));
  }

  const result: Record<string, boolean> = {};
  for (const provider of USER_API_KEY_PROVIDER_IDS) {
    const scope = getEffectiveProviderScope(scopes, provider);
    if (scope === "business") {
      result[provider] = businessProviderIds.has(provider);
    } else if (scope === "disabled") {
      result[provider] = false;
    } else {
      result[provider] = userProviderIds.has(provider);
    }
  }
  return result;
}

function getLocalDevProviderKeyStatus(env: Env): Record<string, boolean> {
  if (env.WORKER_ENV !== ENVIRONMENT.Local) return {};
  const openaiKey = env.OPENAI_API_KEY ?? env.OPENAI_API_KEY_INTERNAL_REVIEW ?? env.ARCANIST_OPENAI_API_KEY;
  return {
    openai: Boolean(openaiKey?.trim()),
    baseten: Boolean(env.BASETEN_API_KEY?.trim()),
  };
}

function mergeLocalDevProviderKeyStatus(env: Env, apiKeys: Record<string, boolean>): Record<string, boolean> {
  const localStatus = getLocalDevProviderKeyStatus(env);
  if (!Object.values(localStatus).some(Boolean)) return apiKeys;
  return Object.fromEntries(
    USER_API_KEY_PROVIDER_IDS.map((provider) => [provider, apiKeys[provider] || localStatus[provider] || false]),
  );
}

function hasEnabledCodexSubscriptionAuth(
  userId: number,
  userIntegrationRows: UserModelAvailabilityRow[],
  useCodexSubscription: boolean,
): boolean {
  if (!useCodexSubscription) return false;
  return userIntegrationRows.some(
    (row) =>
      row.integration_id === CODEX_SUBSCRIPTION_INTEGRATION_ID &&
      !!row.api_key &&
      row.encrypted === 1 &&
      row.external_user_id === codexSubscriptionAuthJsonExternalUserId(userId) &&
      row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.VALIDATED,
  );
}

/**
 * Assemble the minimum UI-safe bootstrap payload for an authenticated browser session.
 *
 * Sub-queries run in parallel. User identity is required (failure = throw);
 * models, repos, and settings degrade gracefully (failure = null + warning).
 */
export async function assembleBootstrap(env: Env, request: Request, auth: AuthInfo): Promise<BootstrapResponse> {
  if (!auth.user) {
    throw new Error("Bootstrap requires an authenticated user with profile data");
  }

  const userId = Number(auth.userId);
  const { user: userInfo } = auth;
  const warnings: string[] = [];

  // Launch all sub-queries in parallel
  const [userResult, modelsResult, reposResult, settingsResult] = await Promise.allSettled([
    resolveBootstrapUser(env, userInfo),
    resolveBootstrapModels(env, userId),
    resolveBootstrapRepos(env, request, auth.userId),
    resolveBootstrapSettings(env, userId),
  ]);

  // User is required -- propagate failure. A missing `users` row (stale cached
  // session for a deleted/renumbered user) is the authoritative 401 signal and
  // is thrown here before the settings branch is ever reached; the route maps
  // it to 401 and WARN-logs, so don't ERROR-log it as a generic failure.
  if (userResult.status === "rejected") {
    if (!(userResult.reason instanceof UserRowMissingError)) {
      log.error({ userId: auth.userId, error: String(userResult.reason) }, "Bootstrap user query failed");
    }
    throw userResult.reason;
  }

  // Models: degrade gracefully
  let models: BootstrapModelGroup[] | null = null;
  if (modelsResult.status === "fulfilled") {
    models = modelsResult.value;
  } else {
    log.error({ userId: auth.userId, error: String(modelsResult.reason) }, "Bootstrap models query failed");
    warnings.push("Failed to load models");
  }

  // Repos: degrade gracefully. `reposPending` (cache miss/stale, no GitHub
  // repo-list fetch on the critical path) is distinct from a genuine failure --
  // the client lazy-loads `/api/repos` rather than showing an error.
  let repos: BootstrapRepo[] | null = null;
  let ssoOrgs: SsoOrg[] = [];
  let reposPending = false;
  if (reposResult.status === "fulfilled") {
    repos = reposResult.value.repos;
    ssoOrgs = reposResult.value.ssoOrgs;
    reposPending = reposResult.value.pending;
  } else {
    log.error({ userId: auth.userId, error: String(reposResult.reason) }, "Bootstrap repos query failed");
    warnings.push("Failed to load repositories");
  }

  // Settings: degrade gracefully, EXCEPT a missing `users` row (stale cached
  // session for a deleted/renumbered user), which must surface as 401 at the
  // route rather than render a degraded shell.
  let settings: BootstrapSettings | null = null;
  if (settingsResult.status === "fulfilled") {
    settings = settingsResult.value;
  } else if (settingsResult.reason instanceof UserRowMissingError) {
    throw settingsResult.reason;
  } else {
    log.error({ userId: auth.userId, error: String(settingsResult.reason) }, "Bootstrap settings query failed");
    warnings.push("Failed to load settings");
  }

  const bootstrapUser: BootstrapUser = auth.impersonationId
    ? {
        ...userResult.value.user,
        impersonation: {
          impersonationId: auth.impersonationId,
          actor: auth.actorUser ? { id: auth.actorUser.id, login: auth.actorUser.login ?? null } : null,
          readOnly: true,
        },
      }
    : userResult.value.user;

  return {
    authenticated: true,
    user: bootstrapUser,
    capabilities: buildBootstrapCapabilities({
      ...bootstrapUser,
      isImpersonating: Boolean(auth.impersonationId),
    }),
    models,
    repos,
    reposPending,
    ssoOrgs,
    settings,
    warnings,
  };
}

export function buildBootstrapCapabilities(
  user: Pick<BootstrapUser, "id" | "businessId" | "businessRole" | "sharedSessions"> & {
    isCycloidAdmin?: boolean;
    isImpersonating?: boolean;
  },
): BootstrapCapabilities {
  return {
    canAccessIntegrationDebug: user.businessRole === "admin",
    canManageBusinessIntegrations: user.businessRole === "admin",
    canManageCliTokens: true,
    canUseBusinessSessions: Boolean(user.businessId && user.sharedSessions),
    canAdminPendingSignups: ("isCycloidAdmin" in user ? Boolean(user.isCycloidAdmin) : false) && !user.isImpersonating,
    canStartSupportView: isCycloidAdminGate(user) && !user.isImpersonating,
    canUseInternalModelProviderKeys: user.businessId === SEEDED_BUSINESS_IDS.cycloid,
    computerUse: isCycloidMemberGate(user),
    // Internal control-room surfaces (activity, PR inbox, repo context). Derived
    // from the canonical member gate (prod + QA). Excludes impersonation to match
    // the other canonical-gate capabilities (canStartSupportView); a read-only
    // internal dashboard should not surface for the impersonated customer.
    canUseControlRoom: isCycloidMemberGate(user) && !user.isImpersonating,
    planApproval: PLAN_APPROVAL_ACTIVATION,
  };
}

// ---------------------------------------------------------------------------
// Sub-query resolvers
// ---------------------------------------------------------------------------

async function resolveBootstrapUser(
  env: Env,
  userInfo: NonNullable<AuthInfo["user"]>,
): Promise<{ user: BootstrapUser }> {
  const extras = await resolveAuthUserExtras(env.DB, userInfo.id, userInfo.businessId);
  const isCycloidAdmin = isCycloidAdminGate({
    businessId: extras.businessId,
    businessRole: extras.businessRole,
  });

  return {
    user: {
      id: userInfo.id,
      login: userInfo.login ?? "",
      name: userInfo.name,
      email: userInfo.email,
      avatarUrl: extras.avatarUrl,
      businessId: extras.businessId,
      businessRole: extras.businessRole,
      sharedSessions: userInfo.sharedSessions ?? false,
      egressAllowlist: extras.egressAllowlist,
      isCycloidAdmin,
      linearConnected: extras.linearConnected,
      jiraConnected: extras.jiraConnected,
      jiraSiteName: extras.jiraSiteName,
      notionConnected: extras.notionConnected,
      slackConnected: extras.slackConnected,
      slackNeedsReconnect: extras.slackNeedsReconnect,
    },
  };
}

/**
 * Build the enriched model list for a user, with KV caching.
 *
 * Shared by /api/models and the bootstrap models sub-query so the
 * enrichment pipeline has a single home.
 */
export async function buildAndCacheModels(env: Env, userId: number): Promise<BootstrapModelGroup[]> {
  return (await buildAndCacheModelsWithMetadata(env, userId)).models;
}

export async function buildAndCacheModelsWithMetadata(
  env: Env,
  userId: number,
): Promise<{ models: BootstrapModelGroup[]; cacheStatus: ModelsCacheStatus }> {
  if (!Number.isFinite(userId)) {
    return { models: PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS.map(toBootstrapModelGroup), cacheStatus: "n/a" };
  }

  const now = Date.now();
  const hasLocalDevProviderKeys = Object.values(getLocalDevProviderKeyStatus(env)).some(Boolean);
  if (!hasLocalDevProviderKeys) {
    const memoryCached = modelsMemoryCache.get(userId, now);
    if (memoryCached) {
      return { models: memoryCached, cacheStatus: "hit" };
    }
  }

  const cacheKey = modelsCacheKey(userId);

  // Check KV cache first
  if (!hasLocalDevProviderKeys) {
    try {
      const cached = (await env.DERIVED_MODELS.get(cacheKey, "json")) as BootstrapModelGroup[] | null;
      if (cached) {
        modelsMemoryCache.set(userId, cached, MODELS_MEMORY_TTL_MS, now);
        return { models: cached, cacheStatus: "hit" };
      }
    } catch {
      // KV read failed, fall through to D1
    }
  }

  let businessId: string | null = null;
  let scopes: Record<ToggleableIntegrationId, IntegrationScope> | null = null;
  let apiKeys: Record<string, boolean>;
  let available: string[] | undefined;
  let hasCodexSubscriptionOpenAIAccess = false;

  {
    const [membershipResult, userProviderResult, userSettingsResult] = await env.DB.batch([
      env.DB.prepare("SELECT business_id FROM business_members WHERE user_id = ? LIMIT 1").bind(userId),
      env.DB.prepare(
        `SELECT integration_id, api_key, external_user_id, encrypted, last_validation_status
         FROM user_integrations
         WHERE user_id = ? AND integration_id IN (${USER_API_KEY_PROVIDER_SQL_LIST}, '${CODEX_SUBSCRIPTION_INTEGRATION_ID}')`,
      ).bind(userId),
      env.DB.prepare("SELECT use_codex_subscription FROM user_settings WHERE user_id = ? LIMIT 1").bind(userId),
    ]);

    businessId = ((membershipResult.results ?? []) as Array<{ business_id: string }>)[0]?.business_id ?? null;
    const userIntegrationRows = (userProviderResult.results ?? []) as UserModelAvailabilityRow[];
    const userProviderIds = new Set(
      userIntegrationRows
        .map((row) => row.integration_id)
        .filter((integrationId, index): integrationId is (typeof USER_API_KEY_PROVIDER_IDS)[number] => {
          if (!USER_API_KEY_PROVIDER_IDS.includes(integrationId as (typeof USER_API_KEY_PROVIDER_IDS)[number])) {
            return false;
          }
          return (
            integrationId !== "baseten" ||
            userIntegrationRows[index]?.last_validation_status === CREDENTIAL_VALIDATION_STATUS.VALIDATED
          );
        }),
    );
    const userSettings = (userSettingsResult.results ?? []) as Array<{ use_codex_subscription: number | null }>;
    const useCodexSubscriptionSetting = userSettings[0]?.use_codex_subscription === 1;
    const businessProviderIds = new Set<string>();
    let codexByosEnabled = false;

    if (businessId) {
      const [scopeRows, businessProviderRows, businessCapabilityRows] = await env.DB.batch([
        env.DB.prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?").bind(
          businessId,
        ),
        env.DB.prepare(
          `SELECT integration_id FROM business_integration_credentials WHERE business_id = ? AND integration_id IN (${USER_API_KEY_PROVIDER_SQL_LIST})`,
        ).bind(businessId),
        env.DB.prepare("SELECT codex_byos_enabled FROM businesses WHERE id = ? LIMIT 1").bind(businessId),
      ]);

      scopes = buildIntegrationScopes(
        (scopeRows.results ?? []) as Array<{ integration_id: string; scope: IntegrationScope }>,
      );
      for (const row of (businessProviderRows.results ?? []) as Array<{ integration_id: string }>) {
        businessProviderIds.add(row.integration_id);
      }
      available = deriveAvailableIntegrations(scopes);
      codexByosEnabled =
        ((businessCapabilityRows?.results ?? []) as Array<{ codex_byos_enabled: number | null }>)[0]
          ?.codex_byos_enabled === 1;
    }

    // BYOS model availability follows the per-business opt-in (ARC-1517), not the old
    // Cycloid-only gate, so newly-eligible workspaces get OpenAI/Codex models in the
    // picker instead of "missing key".
    hasCodexSubscriptionOpenAIAccess =
      codexByosEnabled && hasEnabledCodexSubscriptionAuth(userId, userIntegrationRows, useCodexSubscriptionSetting);

    apiKeys = mergeLocalDevProviderKeyStatus(
      env,
      buildProviderKeyStatusFromPresence(userProviderIds, businessProviderIds, scopes),
    );
    if (hasCodexSubscriptionOpenAIAccess) {
      apiKeys.openai = true;
    }
  }

  const availableSet = available ? new Set<string>(available) : null;
  const providerGroups = hasCodexSubscriptionOpenAIAccess
    ? CODEX_SUBSCRIPTION_SESSION_START_MODEL_PROVIDER_GROUPS
    : PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS;
  const result = providerGroups
    .filter((provider) => provider.id === "baseten" || !availableSet || availableSet.has(provider.id))
    // Non-default-backend providers (anthropic / claude_code) are exposed only
    // when a key actually resolves: this is the per-business gate for the
    // claude_code backend, and it keeps Claude models out of the customer UI
    // while the anthropic integration is customerFacing: false (PR #4210).
    // The default backend's provider stays visible key or not (existing
    // codex/openai behavior: models render with hasApiKey=false unless
    // a credential resolves — BYOK, business key, or Codex subscription).
    .filter((provider) => provider.id === DEFAULT_BACKEND_PROVIDER_ID || apiKeys[provider.id])
    .map((provider) => ({
      ...toBootstrapModelGroup(provider),
      hasApiKey: apiKeys[provider.id] || false,
    }));

  if (!hasLocalDevProviderKeys) {
    try {
      await env.DERIVED_MODELS.put(cacheKey, JSON.stringify(result), { expirationTtl: MODELS_CACHE_TTL });
    } catch {
      // Best-effort cache write
    }
    modelsMemoryCache.set(userId, result, MODELS_MEMORY_TTL_MS, now);
  }
  return { models: result, cacheStatus: "miss" };
}

async function resolveBootstrapModels(env: Env, userId: number): Promise<BootstrapModelGroup[]> {
  return buildAndCacheModels(env, userId);
}

export function toBootstrapModelGroup(provider: {
  id: string;
  name: string;
  models: Array<{
    id: string;
    name: string;
    label: string;
    backends?: readonly string[];
    reasoning?: { efforts: string[]; default?: string };
  }>;
}): BootstrapModelGroup {
  return {
    id: provider.id,
    name: provider.name,
    models: provider.models.map((m) => ({
      id: m.id,
      name: m.name,
      label: m.label,
      ...(m.backends ? { backends: [...m.backends] } : {}),
      ...(MODEL_CONTEXT_WINDOWS[m.id] != null ? { contextWindow: MODEL_CONTEXT_WINDOWS[m.id] } : {}),
      ...(m.reasoning ? { reasoning: { efforts: [...m.reasoning.efforts], default: m.reasoning.default } } : {}),
    })),
  };
}

async function resolveBootstrapRepos(
  env: Env,
  request: Request,
  userId: string,
): Promise<{ repos: BootstrapRepo[] | null; ssoOrgs: SsoOrg[]; pending: boolean }> {
  const { listAccessibleReposCacheFirst } = await import("./repos");
  const result = await listAccessibleReposCacheFirst(env, request, userId);
  if (!result.ok) {
    throw new Error(result.error);
  }
  // Cache miss/stale on the non-refresh path: repo list deferred to the client's
  // `/api/repos` call. Not a failure -- no warning, repos stay null + pending.
  if (result.repos === null) {
    return { repos: null, ssoOrgs: result.ssoOrgs, pending: true };
  }
  return {
    repos: result.repos.map((r) => ({
      fullName: r.fullName,
      url: r.url,
      private: r.private,
      defaultBranch: r.defaultBranch,
      ownerType: r.ownerType,
    })),
    ssoOrgs: result.ssoOrgs,
    pending: false,
  };
}

async function resolveBootstrapSettings(env: Env, userId: number): Promise<BootstrapSettings> {
  const { settings, apiKeys } = await getSettingsWithKeyStatus(env.DB, userId);
  const effective = resolveEffectiveAutonomySettings(settings);
  return {
    defaultPrDraft: effective.defaultPrDraft,
    autoVerifyEnabled: effective.autoVerifyEnabled,
    automaticReviewsEnabled: effective.automaticReviewsEnabled,
    planMode: effective.planMode,
    planApprovalRequired: effective.planApprovalRequired,
    settingsProfile: effective.profile,
    useCodexSubscription: settings.use_codex_subscription === 1,
    defaultModel: extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(settings.default_model)) ?? null,
    defaultRepo: settings.default_repo,
    apiKeys,
  };
}
