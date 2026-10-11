import {
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import type { ProviderApiKeyState } from "../../../../shared/constants/onboarding.js";
import { type CredentialValidationStatus, type OnboardingReasonCode } from "../../../../shared/constants/onboarding.js";
import {
  isValidGithubOwnerLogin,
  normalizeGithubLogin,
  PR_REVIEW_EXPECTED_BOT_LIMIT,
  PR_REVIEW_KNOWN_BOT_ID_SET,
  type PrReviewExpectedBot,
  type PrReviewKnownBotId,
} from "../../../../shared/constants/pr-review-bots.js";
import type { PlanModeSetting } from "../../../../shared/plan-mode.js";
import { getMemberBusinessId, isCodexByosEnabledForBusiness } from "../business/db";
import {
  ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  normalizeGitHubActorLogin,
  PR_REVIEW_BOT_ACTOR_ALIAS_LOGINS,
} from "../github/pr-review-bots";
import {
  clearCodexSubscriptionAuthJson,
  getCodexSubscriptionAuthJsonState,
  setCodexSubscriptionAuthJson,
} from "../integrations/db";
import { validateProviderApiKey } from "../integrations/provider-key-validation";
import { isBusinessManaged, isIntegrationAvailable } from "../integrations/service";
import { createLogger } from "../logger";
import { normalizeSettingsProfile, resolveEffectiveAutonomySettings, type SettingsProfile } from "./autonomy";
import type { KeyProvider } from "./db";
import {
  clearProviderApiKey,
  getProviderKeyStates,
  getSettingsWithKeyStatus,
  getUserPrReviewBotSettings,
  getUserSettingsIfExists,
  listUserPrReviewBotSettings,
  setProviderApiKey,
  setUserPrReviewBotSettings,
  updateUserSettings,
} from "./db";

const log = createLogger({ bindings: { component: "settings-service" } });
const CODEX_AUTH_JSON_MAX_BYTES = 64 * 1024;

type PersistedProviderApiKeyResult =
  { ok: true; state: ProviderApiKeyState } | { ok: false; status: number; error: string; state?: ProviderApiKeyState };

export type CodexSubscriptionCredentialState = {
  isSet: boolean;
  lastValidatedAt: number | null;
  lastValidationStatus: CredentialValidationStatus | null;
  lastValidationReasonCode: OnboardingReasonCode | null;
};

function emptyCodexSubscriptionState(): CodexSubscriptionCredentialState {
  return {
    isSet: false,
    lastValidatedAt: null,
    lastValidationStatus: null,
    lastValidationReasonCode: null,
  };
}

function validateCodexSubscriptionAuthJson(
  authJson: string,
): { ok: true; normalized: string } | { ok: false; error: string } {
  const trimmed = authJson.trim();
  if (!trimmed) return { ok: false, error: "Missing authJson" };
  if (new TextEncoder().encode(trimmed).byteLength > CODEX_AUTH_JSON_MAX_BYTES) {
    return { ok: false, error: "Codex auth.json is too large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Codex auth.json must be valid JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Codex auth.json must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.auth_mode !== "chatgpt") {
    return { ok: false, error: "Codex auth.json must use ChatGPT auth" };
  }
  if (!record.tokens || typeof record.tokens !== "object" || Array.isArray(record.tokens)) {
    return { ok: false, error: "Codex auth.json is missing ChatGPT tokens" };
  }
  const tokens = record.tokens as Record<string, unknown>;
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token.trim()) {
    return { ok: false, error: "Codex auth.json is missing a refresh token" };
  }

  return { ok: true, normalized: JSON.stringify(parsed) };
}

/**
 * Whether the user's workspace may connect and use a Codex bring-your-own-subscription
 * credential (BYOS), alongside BYOK. Per-business opt-in, default off (ARC-1517).
 * Resolves the user's business and reads its `codex_byos_enabled` capability; fails
 * closed (false) when the user has no business membership.
 */
export async function isCodexSubscriptionEligibleForUser(db: D1Database, userId: number): Promise<boolean> {
  const businessId = await getMemberBusinessId(db, userId);
  return isCodexByosEnabledForBusiness(db, businessId);
}

function mapSettingsResponse(
  settings: Awaited<ReturnType<typeof updateUserSettings>>,
  apiKeys: Record<string, ProviderApiKeyState>,
  scopeFull: boolean,
): Record<string, unknown> {
  const effective = resolveEffectiveAutonomySettings(settings);
  const base: Record<string, unknown> = {
    defaultPrDraft: effective.defaultPrDraft,
    autoVerifyEnabled: effective.autoVerifyEnabled,
    automaticReviewsEnabled: effective.automaticReviewsEnabled,
    planMode: effective.planMode,
    planApprovalRequired: effective.planApprovalRequired,
    settingsProfile: effective.profile,
    rawSettings: {
      defaultPrDraft: settings.default_pr_draft !== 0,
      autoVerifyEnabled: settings.auto_verify_enabled !== 0,
      automaticReviewsEnabled: settings.automatic_reviews_enabled !== 0,
      planMode: settings.plan_mode_setting,
      planApprovalRequired: settings.plan_approval_required === null ? null : settings.plan_approval_required !== 0,
    },
    useCodexSubscription: settings.use_codex_subscription === 1,
    defaultModel: extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(settings.default_model)) ?? null,
    defaultRepo: settings.default_repo,
  };

  if (scopeFull) {
    base.apiKeys = apiKeys;
  }

  return base;
}

function toProviderApiKeyState(validation: {
  lastValidatedAt: number;
  lastValidationStatus: CredentialValidationStatus;
  lastValidationReasonCode: OnboardingReasonCode | null;
}): ProviderApiKeyState {
  return {
    isSet: true,
    lastValidatedAt: validation.lastValidatedAt,
    lastValidationStatus: validation.lastValidationStatus,
    lastValidationReasonCode: validation.lastValidationReasonCode,
  };
}

export async function getSettingsPayload(
  db: D1Database,
  userId: number,
  scopeFull: boolean,
): Promise<Record<string, unknown>> {
  const { settings, apiKeys } = await getSettingsWithKeyStatus(db, userId);
  return mapSettingsResponse(settings, apiKeys, scopeFull);
}

export async function updateSettingsPayload(
  db: D1Database,
  userId: number,
  fields: {
    defaultPrDraft?: boolean;
    autoVerifyEnabled?: boolean;
    automaticReviewsEnabled?: boolean;
    planMode?: PlanModeSetting;
    planApprovalRequired?: boolean | null;
    settingsProfile?: SettingsProfile;
    useCodexSubscription?: boolean;
    defaultModel?: string | null;
    defaultRepo?: string | null;
  },
): Promise<Record<string, unknown>> {
  const current = await getUserSettingsIfExists(db, userId);
  const rawAutonomyWrite =
    fields.defaultPrDraft !== undefined ||
    fields.autoVerifyEnabled !== undefined ||
    fields.automaticReviewsEnabled !== undefined ||
    fields.planMode !== undefined ||
    fields.planApprovalRequired !== undefined;
  const currentProfile = normalizeSettingsProfile(current?.settings_profile);
  const settingsProfile = rawAutonomyWrite
    ? current === null || currentProfile !== "custom"
      ? "custom"
      : fields.settingsProfile
    : fields.settingsProfile;
  const [settings, apiKeys] = await Promise.all([
    updateUserSettings(db, userId, { ...fields, settingsProfile }),
    getProviderKeyStates(db, userId),
  ]);
  return mapSettingsResponse(settings, apiKeys, true);
}

export async function getCodexSubscriptionStatePayload(
  db: D1Database,
  userId: number,
): Promise<{ eligible: boolean; credential: CodexSubscriptionCredentialState }> {
  if (!(await isCodexSubscriptionEligibleForUser(db, userId))) {
    return { eligible: false, credential: emptyCodexSubscriptionState() };
  }
  const credential = await getCodexSubscriptionAuthJsonState(db, userId);
  return { eligible: true, credential: credential ?? emptyCodexSubscriptionState() };
}

export async function saveCodexSubscriptionAuthJsonForUser(opts: {
  db: D1Database;
  userId: number;
  authJson: string;
  encryptionKey: string | undefined;
}): Promise<
  | { ok: true; state: CodexSubscriptionCredentialState }
  | { ok: false; status: number; error: string; state?: CodexSubscriptionCredentialState }
> {
  if (!(await isCodexSubscriptionEligibleForUser(opts.db, opts.userId))) {
    return { ok: false, status: 403, error: "Codex subscription auth is not enabled for your workspace" };
  }
  const validation = validateCodexSubscriptionAuthJson(opts.authJson);
  if (!validation.ok) return { ok: false, status: 400, error: validation.error };
  const state = await setCodexSubscriptionAuthJson(opts.db, opts.userId, validation.normalized, opts.encryptionKey);
  log.info({ userId: opts.userId, action: "codex_subscription.auth_json_saved" }, "Codex subscription auth saved");
  return { ok: true, state };
}

export async function clearCodexSubscriptionAuthJsonForUser(
  db: D1Database,
  userId: number,
): Promise<{ ok: true; state: CodexSubscriptionCredentialState } | { ok: false; status: number; error: string }> {
  // Clearing your own stored credential is always allowed — never gated on current
  // workspace eligibility. A business can disable `codex_byos_enabled` after users
  // have saved a personal auth.json; `cycloid codex logout` (and the UI clear) must
  // still be able to remove it. Fail-safe off, mirroring the selector disable path.
  const state = await clearCodexSubscriptionAuthJson(db, userId);
  log.info({ userId, action: "codex_subscription.auth_json_revoked" }, "Codex subscription auth revoked");
  return { ok: true, state };
}

// Enable/disable the per-user "use Codex subscription auth for OpenAI sessions"
// selector (the same `use_codex_subscription` flag the Settings toggle drives).
// Enabling requires workspace eligibility; disabling is always allowed so a user
// can turn it off even after the business opt-in is revoked (fail-safe off).
export async function setCodexSubscriptionEnabledForUser(opts: {
  db: D1Database;
  userId: number;
  enabled: boolean;
}): Promise<{ ok: true; useCodexSubscription: boolean } | { ok: false; status: number; error: string }> {
  if (opts.enabled && !(await isCodexSubscriptionEligibleForUser(opts.db, opts.userId))) {
    return { ok: false, status: 403, error: "Codex subscription auth is not enabled for your workspace" };
  }
  await updateUserSettings(opts.db, opts.userId, { useCodexSubscription: opts.enabled });
  log.info(
    { userId: opts.userId, action: "codex_subscription.selector_set", enabled: opts.enabled },
    "Codex subscription selector updated",
  );
  return { ok: true, useCodexSubscription: opts.enabled };
}

export async function saveProviderApiKeyForUser(opts: {
  db: D1Database;
  userId: number;
  provider: KeyProvider;
  apiKey: string;
  encryptionKey: string | undefined;
}): Promise<PersistedProviderApiKeyResult> {
  const { db, userId, provider, apiKey, encryptionKey } = opts;

  if (!(await isIntegrationAvailable(db, userId, provider))) {
    return { ok: false, status: 403, error: `${provider} integration is disabled for your organization` };
  }

  if (provider !== "baseten" && (await isBusinessManaged(db, userId, provider))) {
    return { ok: false, status: 409, error: "Managed by your organization" };
  }

  const validation = await validateProviderApiKey(provider, apiKey);
  if (!validation.accepted) {
    await setProviderApiKey(db, userId, provider, apiKey, encryptionKey, validation);
    return {
      ok: false,
      status: 400,
      error: validation.error,
      state: toProviderApiKeyState(validation),
    };
  }

  await setProviderApiKey(db, userId, provider, apiKey, encryptionKey, validation);
  return {
    ok: true,
    state: toProviderApiKeyState(validation),
  };
}

export type ProviderApiKeyValidationResult =
  | { ok: true; validationStatus: CredentialValidationStatus; reasonCode: OnboardingReasonCode | null }
  | { ok: false; status: number; error: string };

export async function validateProviderApiKeyForUser(opts: {
  db: D1Database;
  userId: number;
  provider: KeyProvider;
  apiKey: string;
}): Promise<ProviderApiKeyValidationResult> {
  const { db, userId, provider, apiKey } = opts;

  if (!(await isIntegrationAvailable(db, userId, provider))) {
    return { ok: false, status: 403, error: `${provider} integration is disabled for your organization` };
  }

  if (provider !== "baseten" && (await isBusinessManaged(db, userId, provider))) {
    return { ok: false, status: 409, error: "Managed by your organization" };
  }

  const validation = await validateProviderApiKey(provider, apiKey);
  if (!validation.accepted) {
    return { ok: false, status: 400, error: validation.error };
  }

  return {
    ok: true,
    validationStatus: validation.lastValidationStatus,
    reasonCode: validation.lastValidationReasonCode,
  };
}

export async function clearProviderApiKeyForUser(
  db: D1Database,
  userId: number,
  provider: KeyProvider,
): Promise<{ ok: true; state: ProviderApiKeyState } | { ok: false; status: number; error: string }> {
  if (provider !== "baseten" && (await isBusinessManaged(db, userId, provider))) {
    return { ok: false, status: 409, error: "Managed by your organization" };
  }

  await clearProviderApiKey(db, userId, provider);

  return {
    ok: true,
    state: {
      isSet: false,
      lastValidatedAt: null,
      lastValidationStatus: null,
      lastValidationReasonCode: null,
    },
  };
}

export type { PrReviewExpectedBot };

export type RepoAccessVerifier = (repoOwner: string, repoName: string) => Promise<boolean>;

export interface PrReviewBotSettingsListPayload {
  repositories: Array<{
    repoOwner: string;
    repoName: string;
    expectedBots: PrReviewExpectedBot[];
    mergeConflictResolutionEnabled: boolean;
  }>;
  nextCursor: string | null;
}

export type PrReviewBotSettingsValidationResult =
  { ok: true; expectedBots: PrReviewExpectedBot[] } | { ok: false; reason: string };

export function normalizeAndValidatePrReviewBotSettings(
  expectedBots: PrReviewExpectedBot[],
): PrReviewBotSettingsValidationResult {
  if (expectedBots.length > PR_REVIEW_EXPECTED_BOT_LIMIT) {
    return { ok: false, reason: "too_many_bots" };
  }

  const seenKnown = new Set<string>();
  const seenCustom = new Set<string>();
  const reservedActorLogins = new Set<string>([
    ...PR_REVIEW_BOT_ACTOR_ALIAS_LOGINS,
    ...ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  ]);
  const normalized: PrReviewExpectedBot[] = [];

  for (const bot of expectedBots) {
    if (bot.type === "known") {
      const id = String(bot.id).toLowerCase();
      if (!PR_REVIEW_KNOWN_BOT_ID_SET.has(id)) {
        return { ok: false, reason: "invalid_known_bot" };
      }
      if (seenKnown.has(id)) {
        return { ok: false, reason: "duplicate_known_bot" };
      }
      seenKnown.add(id);
      normalized.push({ type: "known", id: id as PrReviewKnownBotId });
      continue;
    }

    const login = normalizeGithubLogin(bot.login);
    if (!isValidGithubOwnerLogin(login)) {
      return { ok: false, reason: "invalid_custom_login" };
    }
    if (seenCustom.has(login)) {
      return { ok: false, reason: "duplicate_custom_bot" };
    }
    if (PR_REVIEW_KNOWN_BOT_ID_SET.has(login)) {
      return { ok: false, reason: "custom_collides_with_known_id" };
    }
    const normalizedActor = normalizeGitHubActorLogin(login);
    if (reservedActorLogins.has(normalizedActor)) {
      return { ok: false, reason: "custom_collides_with_reserved_actor" };
    }
    seenCustom.add(login);
    normalized.push({ type: "custom", login });
  }

  return { ok: true, expectedBots: normalized };
}

// User-facing message for a checklist validation rejection. The reason codes
// are logged and returned as `code` for debugging; this is what the UI shows.
export function prReviewBotSettingsRejectionMessage(reason: string): string {
  switch (reason) {
    case "too_many_bots":
      return `You can configure at most ${PR_REVIEW_EXPECTED_BOT_LIMIT} bots per repository.`;
    case "invalid_known_bot":
      return "One of the selected bots is not recognized.";
    case "duplicate_known_bot":
      return "That bot is already in the checklist.";
    case "invalid_custom_login":
      return "Enter a valid GitHub login for the custom bot.";
    case "duplicate_custom_bot":
      return "That custom bot is already in the checklist.";
    case "custom_collides_with_known_id":
      return "That custom login matches a built-in bot — add it from the list above instead.";
    case "custom_collides_with_reserved_actor":
      return "That login is reserved and can't be added as a custom bot.";
    default:
      return "Invalid PR review bot settings.";
  }
}

export async function getPrReviewBotSettingsPayload(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
): Promise<{
  expectedBots: PrReviewExpectedBot[];
  mergeConflictResolutionEnabled: boolean;
}> {
  const settings = await getUserPrReviewBotSettings(db, userId, repoOwner, repoName);
  return {
    expectedBots: settings.expectedBots,
    mergeConflictResolutionEnabled: settings.mergeConflictResolutionEnabled,
  };
}

export async function updatePrReviewBotSettingsPayload(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
  input: {
    expectedBots: PrReviewExpectedBot[];
    mergeConflictResolutionEnabled?: boolean;
  },
): Promise<
  | {
      expectedBots: PrReviewExpectedBot[];
      mergeConflictResolutionEnabled: boolean;
    }
  | { ok: false; reason: string }
> {
  const validated = normalizeAndValidatePrReviewBotSettings(input.expectedBots);
  if (!validated.ok) return validated;
  // Read current so a partial PUT (e.g. only bots) preserves the other fields.
  const current = await getUserPrReviewBotSettings(db, userId, repoOwner, repoName);
  const mergeConflictResolutionEnabled = input.mergeConflictResolutionEnabled ?? current.mergeConflictResolutionEnabled;
  const settings = await setUserPrReviewBotSettings(db, userId, repoOwner, repoName, {
    expectedBots: validated.expectedBots,
    mergeConflictResolutionEnabled,
  });
  return {
    expectedBots: settings.expectedBots,
    mergeConflictResolutionEnabled: settings.mergeConflictResolutionEnabled,
  };
}

export async function listPrReviewBotSettingsPayload(options: {
  db: D1Database;
  userId: number;
  cursor?: string | null;
  limit?: number;
  verifyAccess: RepoAccessVerifier;
}): Promise<PrReviewBotSettingsListPayload> {
  const listed = await listUserPrReviewBotSettings(options.db, options.userId, {
    cursor: options.cursor,
    limit: options.limit,
  });
  const repositories: PrReviewBotSettingsListPayload["repositories"] = [];

  for (const row of listed.rows) {
    try {
      if (await options.verifyAccess(row.repoOwner, row.repoName)) {
        repositories.push({
          repoOwner: row.repoOwner,
          repoName: row.repoName,
          expectedBots: row.expectedBots,
          mergeConflictResolutionEnabled: row.mergeConflictResolutionEnabled,
        });
      } else {
        log.warn(
          { userId: options.userId, owner: row.repoOwner, repo: row.repoName },
          "Omitting inaccessible PR review bot setting",
        );
      }
    } catch (error) {
      log.warn(
        { userId: options.userId, owner: row.repoOwner, repo: row.repoName, error: String(error) },
        "Omitting PR review bot setting because repo access could not be verified",
      );
    }
  }

  return { repositories, nextCursor: listed.nextCursor };
}
