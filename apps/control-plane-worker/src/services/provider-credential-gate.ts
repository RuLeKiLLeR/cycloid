import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import { USER_API_KEY_PROVIDER_IDS } from "../../../../shared/constants/integration-helpers.js";
import { getProviderForModel, requiresCodexSubscriptionAuthForModel } from "../../../../shared/constants/models.js";
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
  ONBOARDING_REASON_CODES,
  type OnboardingReasonCode,
} from "../../../../shared/constants/onboarding.js";
import type { IntegrationScope } from "../enums/integrations";
import { CODEX_SUBSCRIPTION_INTEGRATION_ID, type KeyProvider } from "../integrations/db";
import { buildIntegrationScopes, getEffectiveProviderScope } from "../integrations/service";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "provider-credential-gate" } });
const USER_API_KEY_PROVIDER_SET = new Set<string>(USER_API_KEY_PROVIDER_IDS);

export const PROVIDER_KEY_NOT_VALIDATED_ERROR = "provider_key_not_validated";

export class ProviderCredentialNotValidatedError extends Error {
  readonly provider: KeyProvider;
  readonly modelId: string;
  readonly reasonCode: OnboardingReasonCode;

  constructor(provider: KeyProvider, modelId: string, reasonCode: OnboardingReasonCode) {
    const providerName = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "Baseten";
    super(`No validated ${providerName} key. Validate your key in Settings to use ${modelId}.`);
    this.name = "ProviderCredentialNotValidatedError";
    this.provider = provider;
    this.modelId = modelId;
    this.reasonCode = reasonCode;
  }
}

export class ProviderCredentialGateSkipDeniedError extends Error {
  readonly workerEnv: string | undefined;

  constructor(workerEnv: string | undefined) {
    super("Provider credential gate skip is only allowed in test or local worker environments.");
    this.name = "ProviderCredentialGateSkipDeniedError";
    this.workerEnv = workerEnv;
  }
}

interface UserProviderCredentialRow {
  api_key: string | null;
  last_validation_status: CredentialValidationStatus | null;
  last_validation_reason_code: OnboardingReasonCode | null;
}

interface BusinessProviderCredentialRow {
  api_key: string | null;
  last_validation_status: CredentialValidationStatus | null;
  last_validation_reason_code: OnboardingReasonCode | null;
}

interface CodexSubscriptionCredentialRow {
  api_key: string | null;
  encrypted: number | null;
  last_validation_status: CredentialValidationStatus | null;
}

function isKeyProvider(provider: string): provider is KeyProvider {
  return USER_API_KEY_PROVIDER_SET.has(provider);
}

function getLocalDevProviderApiKey(env: Env, provider: KeyProvider): string | null {
  if (env.WORKER_ENV !== ENVIRONMENT.Local) return null;
  const apiKey =
    provider === "anthropic"
      ? env.ARCANIST_ANTHROPIC_API_KEY
      : provider === "baseten"
        ? env.BASETEN_API_KEY
        : (env.OPENAI_API_KEY ?? env.OPENAI_API_KEY_INTERNAL_REVIEW ?? env.ARCANIST_OPENAI_API_KEY);
  return apiKey?.trim() ? apiKey : null;
}

function userCredentialReasonCode(row: UserProviderCredentialRow | null): OnboardingReasonCode {
  if (!row?.api_key) return ONBOARDING_REASON_CODES.CREDENTIALS_MISSING;
  if (row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.INVALID) {
    return row.last_validation_reason_code ?? ONBOARDING_REASON_CODES.CREDENTIALS_INVALID;
  }
  return row.last_validation_reason_code ?? ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT;
}

function businessCredentialReasonCode(row: BusinessProviderCredentialRow | null): OnboardingReasonCode {
  if (!row?.api_key) return ONBOARDING_REASON_CODES.BUSINESS_MANAGED;
  if (row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.INVALID) {
    return row.last_validation_reason_code ?? ONBOARDING_REASON_CODES.CREDENTIALS_INVALID;
  }
  return row.last_validation_reason_code ?? ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT;
}

function hasRunnableCodexSubscriptionCredential(row: CodexSubscriptionCredentialRow | null): boolean {
  return (
    !!row?.api_key?.trim() && row.encrypted === 1 && row.last_validation_status !== CREDENTIAL_VALIDATION_STATUS.INVALID
  );
}

export interface AssertEffectiveProviderCredentialInput {
  ownerUserId: string;
  businessId: string | null;
  modelId: string;
  sessionId?: string | null;
  credentialGate?: { mode: "enforce" } | { mode: "skip"; reason: string };
}

/**
 * Result of evaluating whether a session for `modelId` would be allowed to start.
 *
 * This is the single source of truth for "will the backend gate let this
 * session through?". The session-create path uses it (via the throwing
 * `assertEffectiveProviderCredentialForModel` wrapper); the
 * `/api/sessions/prerequisites` endpoint also returns it so the UI can disable
 * the submit button before the user clicks. Keep both readers on this function
 * so they cannot drift.
 */
export type ProviderCredentialEvaluation =
  { ok: true; provider: KeyProvider | null } | { ok: false; provider: KeyProvider; reasonCode: OnboardingReasonCode };

export async function evaluateProviderCredentialForModel(
  env: Env,
  input: AssertEffectiveProviderCredentialInput,
): Promise<ProviderCredentialEvaluation> {
  if (input.credentialGate?.mode === "skip") {
    const workerEnv = env.WORKER_ENV;
    if (workerEnv !== ENVIRONMENT.Test && workerEnv !== ENVIRONMENT.Local) {
      const event = {
        event: "session_create.provider_credential_gate_skip_denied",
        action: "session_create.provider_credential_gate_skip_denied",
        workerEnv: workerEnv ?? null,
        ownerUserId: input.ownerUserId,
        businessId: input.businessId,
        modelId: input.modelId,
        sessionId: input.sessionId ?? null,
        reason: input.credentialGate.reason,
      };
      log.warn(event, "Provider credential gate skip denied outside non-deployed environments");
      await postStructuredEventToDd(env, event);
      throw new ProviderCredentialGateSkipDeniedError(workerEnv);
    }
    log.info(
      {
        action: "session_create.provider_credential_gate_skipped",
        ownerUserId: input.ownerUserId,
        modelId: input.modelId,
        reason: input.credentialGate.reason,
      },
      "Provider credential gate skipped for session create",
    );
    return { ok: true, provider: null };
  }

  const provider = getProviderForModel(input.modelId);
  if (!isKeyProvider(provider)) return { ok: true, provider: null };

  const ownerUserIdNumber = Number(input.ownerUserId);
  if (!Number.isFinite(ownerUserIdNumber)) {
    return { ok: false, provider, reasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_MISSING };
  }

  const db = env.DB;
  const batchResults = await db.batch([
    input.businessId
      ? db
          .prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?")
          .bind(input.businessId)
      : db.prepare("SELECT integration_id, scope FROM business_integrations WHERE 1 = 0"),
    db
      .prepare(
        "SELECT api_key, last_validation_status, last_validation_reason_code FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1",
      )
      .bind(ownerUserIdNumber, provider),
    ...(provider === "openai"
      ? [
          db
            .prepare("SELECT use_codex_subscription FROM user_settings WHERE user_id = ? LIMIT 1")
            .bind(ownerUserIdNumber),
          db
            .prepare(
              "SELECT api_key, encrypted, last_validation_status FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1",
            )
            .bind(ownerUserIdNumber, CODEX_SUBSCRIPTION_INTEGRATION_ID),
          input.businessId
            ? db.prepare("SELECT codex_byos_enabled FROM businesses WHERE id = ? LIMIT 1").bind(input.businessId)
            : db.prepare("SELECT 0 AS codex_byos_enabled WHERE 1 = 0"),
        ]
      : []),
  ]);
  const [
    scopeRowsResult,
    userCredentialResult,
    codexSubscriptionSettingsResult,
    codexSubscriptionCredentialResult,
    codexByosCapabilityResult,
  ] = batchResults;

  if (provider === "openai") {
    const settings = (codexSubscriptionSettingsResult?.results ?? []) as Array<{
      use_codex_subscription: number | null;
    }>;
    const rows = (codexSubscriptionCredentialResult?.results ?? []) as CodexSubscriptionCredentialRow[];
    const capabilityRows = (codexByosCapabilityResult?.results ?? []) as Array<{ codex_byos_enabled: number | null }>;
    const byosEnabled = capabilityRows[0]?.codex_byos_enabled === 1;
    const selected = settings[0]?.use_codex_subscription === 1;
    if (selected) {
      if (!byosEnabled) {
        return { ok: false, provider, reasonCode: ONBOARDING_REASON_CODES.INTEGRATION_DISABLED };
      }
      return hasRunnableCodexSubscriptionCredential(rows[0] ?? null)
        ? { ok: true, provider }
        : { ok: false, provider, reasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_MISSING };
    }
    if (requiresCodexSubscriptionAuthForModel(input.modelId)) {
      return byosEnabled
        ? { ok: false, provider, reasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_MISSING }
        : { ok: false, provider, reasonCode: ONBOARDING_REASON_CODES.INTEGRATION_DISABLED };
    }
  }

  const scopes = buildIntegrationScopes(
    (scopeRowsResult.results ?? []) as Array<{ integration_id: string; scope: IntegrationScope }>,
  );
  const scope = getEffectiveProviderScope(scopes, provider);
  if (scope === "disabled") {
    return { ok: false, provider, reasonCode: ONBOARDING_REASON_CODES.INTEGRATION_DISABLED };
  }

  let businessCredentialFailureReason: OnboardingReasonCode | null = null;
  if (input.businessId && scope === "business") {
    const row = await db
      .prepare(
        "SELECT api_key, last_validation_status, last_validation_reason_code FROM business_integration_credentials WHERE business_id = ? AND integration_id = ? LIMIT 1",
      )
      .bind(input.businessId, provider)
      .first<BusinessProviderCredentialRow>();
    if (row?.api_key?.trim() && row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.VALIDATED) {
      return { ok: true, provider };
    }
    businessCredentialFailureReason = businessCredentialReasonCode(row);
  } else {
    const rows = (userCredentialResult.results ?? []) as UserProviderCredentialRow[];
    const row = rows[0] ?? null;
    if (row?.api_key?.trim() && row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.VALIDATED) {
      return { ok: true, provider };
    }
  }

  if (getLocalDevProviderApiKey(env, provider)) return { ok: true, provider };
  if (businessCredentialFailureReason) {
    return { ok: false, provider, reasonCode: businessCredentialFailureReason };
  }

  const rows = (userCredentialResult.results ?? []) as UserProviderCredentialRow[];
  return { ok: false, provider, reasonCode: userCredentialReasonCode(rows[0] ?? null) };
}

export async function assertEffectiveProviderCredentialForModel(
  env: Env,
  input: AssertEffectiveProviderCredentialInput,
): Promise<void> {
  const evaluation = await evaluateProviderCredentialForModel(env, input);
  if (evaluation.ok) return;
  log.warn(
    {
      action: "session_create.provider_credential_blocked",
      provider: evaluation.provider,
      ownerUserId: input.ownerUserId,
      reasonCode: evaluation.reasonCode,
      sessionId: input.sessionId ?? null,
    },
    "Provider credential gate blocked session create",
  );
  throw new ProviderCredentialNotValidatedError(evaluation.provider, input.modelId, evaluation.reasonCode);
}
