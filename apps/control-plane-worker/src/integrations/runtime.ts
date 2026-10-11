import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import type { IntegrationId, ToggleableIntegrationId } from "../../../../shared/constants/integration-helpers.js";
import {
  BRAINTRUST_DEFAULT_API_URL,
  isSupportedDatadogSite,
  isValidCloudflareAccountId,
  isValidCloudflareD1DatabaseId,
  normalizeBraintrustApiUrl,
  normalizeDatadogSite,
} from "../../../../shared/constants/integrations.js";
import { getProviderForModel, requiresCodexSubscriptionAuthForModel } from "../../../../shared/constants/models.js";
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
} from "../../../../shared/constants/onboarding.js";
import {
  BRAINTRUST_INTEGRATION_API_KEY_ENV,
  BRAINTRUST_INTEGRATION_API_URL_ENV,
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  CLOUDFLARE_D1_DATABASE_ID_ENV,
  DATADOG_API_KEY_ENV,
  DATADOG_APP_KEY_ENV,
  DATADOG_SITE_ENV,
  JIRA_ACCESS_TOKEN_ENV,
  JIRA_CLOUD_ID_ENV,
  JIRA_SITE_URL_ENV,
  JIRA_TRIGGER_LABEL_ENV,
  LAUNCHDARKLY_ACCESS_TOKEN_ENV,
  NOTION_ACCESS_TOKEN_ENV,
  SENTRY_ACCESS_TOKEN_ENV,
  SENTRY_ORGANIZATION_SLUG_ENV,
  STRIPE_SECRET_KEY_ENV,
  TERRAFORM_IN_AUTOMATION_ENV,
  TERRAFORM_PLAN_TOKEN_ENV,
  VERCEL_ACCESS_TOKEN_ENV,
  VERCEL_TEAM_ID_ENV,
} from "../../../../shared/constants/sandbox-env.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
  type IntegrationLifecycleReasonCode,
  type IntegrationLifecycleStage,
  type IntegrationLifecycleStatus,
} from "../../../../shared/enums/integration-lifecycle.js";
import { getValidJiraToken, getValidLinearToken, getValidNotionToken, type RefreshableOAuthTokens } from "../auth/db";
import { type IntegrationScope, TOGGLEABLE_INTEGRATION_IDS } from "../enums/integrations";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { createOpenAIGatewaySessionToken, type OpenAIGatewayCredentialSource } from "../openai-gateway/db";
import { decrypt } from "../settings/encryption";
import type { Env } from "../types";
import { normalizeWebhookReference } from "../utils";
import { getJiraWebhookInstallationByBusinessAndCloudId } from "../webhooks/db";
import { jiraTriggerLabel } from "../webhooks/jira-registration";
import {
  CODEX_SUBSCRIPTION_INTEGRATION_ID,
  getJiraTokens,
  getJiraUserSite,
  getLinearTokens,
  getNotionTokens,
  type JiraTokenRecord,
  type KeyProvider,
  PROVIDER_ENV_VAR,
  readBusinessCredentialRow,
} from "./db";
import { buildIntegrationScopes, deriveAvailableIntegrations, getEffectiveProviderScope } from "./service";

const runtimeLog = createLogger({ bindings: { component: "integration-runtime" } });
const DEFAULT_AVAILABLE_INTEGRATIONS: IntegrationId[] = ["github", ...TOGGLEABLE_INTEGRATION_IDS];
const SPAWN_USER_INTEGRATION_SQL_LIST =
  "'openai', 'anthropic', 'baseten', 'linear', 'jira', 'notion', 'codex_subscription'";
const SPAWN_BUSINESS_CREDENTIAL_SQL_LIST =
  "'openai', 'anthropic', 'sentry', 'datadog', 'launchdarkly', 'cloudflare', 'braintrust', 'stripe', 'terraform', 'vercel'";
export const CODEX_SUBSCRIPTION_AUTH_JSON_ENV = "ARCANIST_CODEX_AUTH_JSON";
const BASETEN_API_KEY_ENV = PROVIDER_ENV_VAR.baseten;
type SpawnModelProvider = KeyProvider;
const PROVIDER_DISPLAY_NAMES: Record<SpawnModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  baseten: "Baseten",
};
// Keep this whitelist aligned with docs/adding-integrations.md whenever a new
// spawn-time credential is introduced. Missing keys here would let restores
// ignore revoked credentials for that integration.
const SPAWN_INTEGRATION_CREDENTIAL_ENV_VARS = new Set<string>([
  ...Object.values(PROVIDER_ENV_VAR),
  BASETEN_API_KEY_ENV,
  SENTRY_ACCESS_TOKEN_ENV,
  SENTRY_ORGANIZATION_SLUG_ENV,
  DATADOG_API_KEY_ENV,
  DATADOG_APP_KEY_ENV,
  DATADOG_SITE_ENV,
  LAUNCHDARKLY_ACCESS_TOKEN_ENV,
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_D1_DATABASE_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  BRAINTRUST_INTEGRATION_API_KEY_ENV,
  BRAINTRUST_INTEGRATION_API_URL_ENV,
  STRIPE_SECRET_KEY_ENV,
  TERRAFORM_PLAN_TOKEN_ENV,
  TERRAFORM_IN_AUTOMATION_ENV,
  VERCEL_ACCESS_TOKEN_ENV,
  VERCEL_TEAM_ID_ENV,
  "LINEAR_ACCESS_TOKEN",
  JIRA_ACCESS_TOKEN_ENV,
  JIRA_CLOUD_ID_ENV,
  JIRA_SITE_URL_ENV,
  NOTION_ACCESS_TOKEN_ENV,
  "SLACK_TOKEN",
  "SLACK_USER_TOKEN",
  CODEX_SUBSCRIPTION_AUTH_JSON_ENV,
]);

type IntegrationDiagnostic = {
  available: boolean;
  scope: IntegrationScope | "n/a";
  status: string;
  envInjected: boolean;
};

type ProviderDiagnostic = IntegrationDiagnostic & {
  id: SpawnModelProvider;
};

export interface SpawnIntegrationLifecycleEvent {
  integrationId: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: IntegrationLifecycleStatus;
  reasonCode?: IntegrationLifecycleReasonCode | null;
  message: string;
  details?: Record<string, unknown> | null;
}

interface SpawnIntegrationDiagnostics {
  provider: ProviderDiagnostic;
  linear: IntegrationDiagnostic;
  jira: IntegrationDiagnostic;
  notion: IntegrationDiagnostic;
  sentry: IntegrationDiagnostic;
  datadog: IntegrationDiagnostic;
  launchdarkly: IntegrationDiagnostic;
  cloudflare: IntegrationDiagnostic;
  braintrust: IntegrationDiagnostic;
  stripe: IntegrationDiagnostic;
  terraform: IntegrationDiagnostic;
  vercel: IntegrationDiagnostic;
}

interface SpawnIntegrationRuntime {
  availableIntegrations: IntegrationId[];
  businessId: string | null;
  scopes: Record<ToggleableIntegrationId, IntegrationScope> | null;
  envVars: Record<string, string>;
  diagnostics: SpawnIntegrationDiagnostics;
  lifecycleEvents: SpawnIntegrationLifecycleEvent[];
}

interface ResolveSpawnIntegrationRuntimeOptions {
  db?: D1Database;
  env: Env;
  logger?: Logger;
  businessId: string | null;
  ownerUserId: string;
  selectedModel: string;
  sessionId: string;
}

interface SpawnUserIntegrationRow {
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key: string | null;
  service_url: string | null;
  encrypted: number | null;
  last_validation_status: CredentialValidationStatus | null;
}

interface SpawnBusinessCredentialRow {
  business_id: string;
  integration_id: string;
  api_key: string | null;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  service_url: string | null;
  encrypted: number | null;
  last_validation_status: CredentialValidationStatus | null;
}

interface BatchedSpawnDbSnapshot {
  businessId: string | null;
  scopes: Record<ToggleableIntegrationId, IntegrationScope> | null;
  availableIntegrations: IntegrationId[];
  useCodexSubscription: boolean;
  /** Whether the owning business has opted into Codex BYOS (per-business, default off). */
  codexByosEnabled: boolean;
  userIntegrations: Map<string, SpawnUserIntegrationRow>;
  businessCredentials: Map<string, SpawnBusinessCredentialRow>;
}

function createDiagnostic(
  available: boolean,
  scope: IntegrationScope | "n/a",
  status = "not_evaluated",
): IntegrationDiagnostic {
  return {
    available,
    scope,
    status,
    envInjected: false,
  };
}

function createLifecycleSuccessEvents(
  integrationId: IntegrationId,
  messagePrefix: string,
  credentialScope: "user" | "business" | "local_dev" | "managed_virtual_key" | "codex_subscription",
): SpawnIntegrationLifecycleEvent[] {
  return [
    {
      integrationId,
      stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
      message: `${messagePrefix} credentials resolved for session startup.`,
      details: { provider: integrationId, credentialScope },
    },
    {
      integrationId,
      stage: INTEGRATION_LIFECYCLE_STAGE.SANDBOX_TOKEN_PREPARED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
      message: `${messagePrefix} credentials prepared for sandbox startup.`,
      details: { provider: integrationId, credentialScope },
    },
  ];
}

function createLifecycleFailureEvent(
  integrationId: IntegrationId,
  reasonCode: IntegrationLifecycleReasonCode,
  message: string,
): SpawnIntegrationLifecycleEvent {
  return {
    integrationId,
    stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
    status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
    reasonCode,
    message,
    details: { provider: integrationId },
  };
}

/**
 * Thrown when the model provider's credential cannot be resolved for spawn.
 * This is fatal (the agent cannot run without an API key), but the failure
 * must still be recorded as a lifecycle event, so the collected events are
 * carried on the error for the caller to persist before the spawn aborts.
 */
export class SpawnProviderCredentialError extends Error {
  readonly lifecycleEvents: SpawnIntegrationLifecycleEvent[];

  constructor(message: string, lifecycleEvents: SpawnIntegrationLifecycleEvent[]) {
    super(message);
    this.name = "SpawnProviderCredentialError";
    this.lifecycleEvents = lifecycleEvents;
  }
}

function collectSpawnLifecycleEvents(diagnostics: SpawnIntegrationDiagnostics): SpawnIntegrationLifecycleEvent[] {
  const events: SpawnIntegrationLifecycleEvent[] = [];

  const providerId = diagnostics.provider.id;
  const providerName = PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
  switch (diagnostics.provider.status) {
    case "codex_subscription_resolved":
      events.push(...createLifecycleSuccessEvents("codex_subscription", "Codex subscription", "codex_subscription"));
      break;
    case "user_key_resolved":
      events.push(...createLifecycleSuccessEvents(providerId, providerName, "user"));
      break;
    case "business_key_resolved":
      events.push(...createLifecycleSuccessEvents(providerId, providerName, "business"));
      break;
    case "local_dev_key_resolved":
      events.push(...createLifecycleSuccessEvents(providerId, providerName, "local_dev"));
      break;
    case "user_key_missing":
    case "business_key_missing":
      events.push(
        createLifecycleFailureEvent(
          providerId,
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          `${providerName} API key was not available for session startup.`,
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          providerId,
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          `${providerName} credential lookup failed during session startup.`,
        ),
      );
      break;
    case "integration_unavailable":
      // The selected model's provider is disabled (or otherwise unavailable)
      // for this business, yet spawn still hard-fails on the missing key. Record
      // it so the disabled-provider case is observable like the others.
      events.push(
        createLifecycleFailureEvent(
          providerId,
          INTEGRATION_LIFECYCLE_REASON_CODE.INTEGRATION_DISABLED,
          `${providerName} is not enabled for this business; no credential could be resolved for session startup.`,
        ),
      );
      break;
  }

  switch (diagnostics.linear.status) {
    case "token_resolved":
      events.push(...createLifecycleSuccessEvents("linear", "Linear", "user"));
      break;
    case "token_missing":
      events.push(
        createLifecycleFailureEvent(
          "linear",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Linear token was not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "linear",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Linear token lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.jira.status) {
    case "token_resolved":
      events.push(...createLifecycleSuccessEvents("jira", "Jira", "user"));
      break;
    case "token_missing":
      events.push(
        createLifecycleFailureEvent(
          "jira",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Jira token was not available for session startup.",
        ),
      );
      break;
    case "site_missing":
      events.push(
        createLifecycleFailureEvent(
          "jira",
          INTEGRATION_LIFECYCLE_REASON_CODE.SITE_NOT_SELECTED,
          "Jira token resolved but no site selection exists; reconnect Jira to pick a site.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "jira",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Jira token lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.notion.status) {
    case "token_resolved":
      events.push(...createLifecycleSuccessEvents("notion", "Notion", "user"));
      break;
    case "token_missing":
      events.push(
        createLifecycleFailureEvent(
          "notion",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Notion token was not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "notion",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Notion token lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.sentry.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("sentry", "Sentry", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "sentry",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Sentry credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "sentry",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Sentry credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.datadog.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("datadog", "Datadog", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "datadog",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Datadog credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "datadog",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Datadog credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.launchdarkly.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("launchdarkly", "LaunchDarkly", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "launchdarkly",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "LaunchDarkly credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "launchdarkly",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "LaunchDarkly credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.cloudflare.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("cloudflare", "Cloudflare D1", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "cloudflare",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Cloudflare D1 credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "cloudflare",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Cloudflare D1 credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.braintrust.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("braintrust", "Braintrust", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "braintrust",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Braintrust credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "braintrust",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Braintrust credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.stripe.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("stripe", "Stripe", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "stripe",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Stripe credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "stripe",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Stripe credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.terraform.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("terraform", "Terraform Cloud", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "terraform",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Terraform Cloud credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "terraform",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Terraform Cloud credential lookup failed during session startup.",
        ),
      );
      break;
  }

  switch (diagnostics.vercel.status) {
    case "credentials_resolved":
      events.push(...createLifecycleSuccessEvents("vercel", "Vercel", "business"));
      break;
    case "credentials_missing":
      events.push(
        createLifecycleFailureEvent(
          "vercel",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          "Vercel credentials were not available for session startup.",
        ),
      );
      break;
    case "lookup_failed":
      events.push(
        createLifecycleFailureEvent(
          "vercel",
          INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
          "Vercel credential lookup failed during session startup.",
        ),
      );
      break;
  }

  return events;
}

function getProviderEnvVar(provider: SpawnModelProvider): string {
  return PROVIDER_ENV_VAR[provider];
}

function getLocalDevProviderApiKey(env: Env, provider: SpawnModelProvider): string | null {
  if (env.WORKER_ENV !== ENVIRONMENT.Local) return null;
  const apiKey =
    provider === "anthropic"
      ? env.ARCANIST_ANTHROPIC_API_KEY
      : provider === "baseten"
        ? env.BASETEN_API_KEY
        : (env.OPENAI_API_KEY ?? env.OPENAI_API_KEY_INTERNAL_REVIEW ?? env.ARCANIST_OPENAI_API_KEY);
  return apiKey?.trim() ? apiKey : null;
}

function openAIGatewayTokenExpiresAt(env: Env): number {
  const hours = Number(env.E2B_RUNTIME_RETENTION_HOURS ?? 72);
  const retentionHours = Number.isFinite(hours) && hours > 0 ? hours : 72;
  return Date.now() + retentionHours * 60 * 60 * 1000;
}

async function createOpenAIByokGatewayTokenForSpawn(
  db: D1Database,
  params: {
    env: Env;
    ownerUserId: number;
    businessId: string | null;
    sessionId: string;
    credentialSource: Extract<OpenAIGatewayCredentialSource, "user_byok" | "business_byok">;
  },
): Promise<string> {
  const credentialOwnerId =
    params.credentialSource === "business_byok" ? params.businessId : String(params.ownerUserId);
  if (!credentialOwnerId) throw new Error("credential owner is required to create an OpenAI gateway BYOK token");
  const { token } = await createOpenAIGatewaySessionToken(db, {
    ownerUserId: params.ownerUserId,
    businessId: params.businessId,
    credentialSource: params.credentialSource,
    credentialOwnerId,
    sessionId: params.sessionId,
    expiresAt: openAIGatewayTokenExpiresAt(params.env),
  });
  return token;
}

async function decryptIfNeeded(
  value: string | null | undefined,
  encrypted: number | null | undefined,
  encryptionKey: string | undefined,
): Promise<string | null> {
  if (!value) return null;
  return encrypted ? decrypt(value, encryptionKey) : value;
}

function encryptedCredentialUnavailable(
  row: { encrypted: number | null } | null | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  integrationId: IntegrationId,
  credentialScope: "user" | "business",
  // Owner/business correlation so an admin can trace WHOSE credentials are
  // inaccessible. ownerUserId is legitimately absent for business-scoped creds.
  correlation: { ownerUserId?: string | null; businessId?: string | null } = {},
): boolean {
  if (row?.encrypted !== 1 || encryptionKey) return false;
  logger.warn(
    {
      action: `${integrationId}.credential.decrypt_failed`,
      reason: "encryption_key_missing",
      credentialScope,
      ...(correlation.ownerUserId != null ? { ownerUserId: correlation.ownerUserId } : {}),
      ...(correlation.businessId != null ? { businessId: correlation.businessId } : {}),
    },
    `Cannot decrypt ${integrationId} ${credentialScope} credential: TOKEN_ENCRYPTION_KEY missing`,
  );
  return true;
}

function buildCodexSubscriptionCredentialError(message: string): SpawnProviderCredentialError {
  return new SpawnProviderCredentialError(message, [
    createLifecycleFailureEvent(
      "codex_subscription",
      INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
      message,
    ),
  ]);
}

async function resolveCodexSubscriptionAuthJsonForSpawn(
  snapshot: BatchedSpawnDbSnapshot,
  ownerUserIdNumber: number,
  encryptionKey: string | undefined,
): Promise<string> {
  if (!snapshot.codexByosEnabled) {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth is not enabled for this workspace.");
  }
  if (!Number.isFinite(ownerUserIdNumber)) {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth requires a valid user.");
  }

  const row = snapshot.userIntegrations.get(CODEX_SUBSCRIPTION_INTEGRATION_ID);
  if (!row || row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.INVALID || !row.api_key) {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth.json is not configured.");
  }
  if (row.encrypted !== 1) {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth.json is not stored encrypted.");
  }
  if (!encryptionKey?.trim()) {
    throw buildCodexSubscriptionCredentialError("TOKEN_ENCRYPTION_KEY is required for Codex subscription auth.");
  }

  let authJson: string | null;
  try {
    authJson = await decryptIfNeeded(row.api_key, row.encrypted, encryptionKey);
  } catch {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth.json could not be decrypted.");
  }
  if (!authJson) {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth.json is empty.");
  }
  return authJson;
}

function toUserIntegrationMap(rows: SpawnUserIntegrationRow[]): Map<string, SpawnUserIntegrationRow> {
  return new Map(rows.map((row) => [row.integration_id, row]));
}

function toBusinessCredentialMap(rows: SpawnBusinessCredentialRow[]): Map<string, SpawnBusinessCredentialRow> {
  return new Map(rows.map((row) => [row.integration_id, row]));
}

function isRunnableCredential(
  row: { last_validation_status: CredentialValidationStatus | null } | null | undefined,
): boolean {
  if (!row) return false;
  return row.last_validation_status === CREDENTIAL_VALIDATION_STATUS.VALIDATED;
}

async function loadBatchedSpawnDbSnapshot(
  db: D1Database,
  ownerUserIdNumber: number,
  businessId: string | null,
): Promise<BatchedSpawnDbSnapshot> {
  const [userIntegrationResult, userSettingsResult] = await db.batch([
    db
      .prepare(
        `SELECT integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at, api_key, service_url, encrypted, last_validation_status
       FROM user_integrations
       WHERE user_id = ? AND integration_id IN (${SPAWN_USER_INTEGRATION_SQL_LIST})`,
      )
      .bind(ownerUserIdNumber),
    db.prepare("SELECT use_codex_subscription FROM user_settings WHERE user_id = ? LIMIT 1").bind(ownerUserIdNumber),
  ]);

  const userIntegrations = toUserIntegrationMap((userIntegrationResult.results ?? []) as SpawnUserIntegrationRow[]);
  const userSettings = (userSettingsResult.results ?? []) as Array<{ use_codex_subscription: number | null }>;
  const useCodexSubscription = userSettings[0]?.use_codex_subscription === 1;

  if (!businessId) {
    return {
      businessId: null,
      scopes: null,
      availableIntegrations: [...DEFAULT_AVAILABLE_INTEGRATIONS],
      useCodexSubscription,
      codexByosEnabled: false,
      userIntegrations,
      businessCredentials: new Map(),
    };
  }

  const [scopeRows, businessCredentialRows, businessCapabilityRows] = await db.batch([
    db.prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?").bind(businessId),
    db
      .prepare(
        `SELECT business_id, integration_id, api_key, oauth_access_token, oauth_refresh_token, oauth_expires_at, service_url, encrypted, last_validation_status
       FROM business_integration_credentials
       WHERE business_id = ? AND integration_id IN (${SPAWN_BUSINESS_CREDENTIAL_SQL_LIST})`,
      )
      .bind(businessId),
    db.prepare("SELECT codex_byos_enabled FROM businesses WHERE id = ? LIMIT 1").bind(businessId),
  ]);

  const scopes = buildIntegrationScopes(
    (scopeRows.results ?? []) as Array<{ integration_id: string; scope: IntegrationScope }>,
  );

  const capabilityRows = (businessCapabilityRows.results ?? []) as Array<{ codex_byos_enabled: number | null }>;

  return {
    businessId,
    scopes,
    availableIntegrations: deriveAvailableIntegrations(scopes),
    useCodexSubscription,
    codexByosEnabled: capabilityRows[0]?.codex_byos_enabled === 1,
    userIntegrations,
    businessCredentials: toBusinessCredentialMap(
      (businessCredentialRows.results ?? []) as SpawnBusinessCredentialRow[],
    ),
  };
}

async function resolveSnapshotApiKey(
  snapshot: BatchedSpawnDbSnapshot,
  provider: KeyProvider,
  encryptionKey: string | undefined,
  logger: Logger,
  ownerUserId: string,
): Promise<{ envVar: string; apiKey: string } | null> {
  const envVar = PROVIDER_ENV_VAR[provider];
  if (!envVar) return null;

  const scope = getEffectiveProviderScope(snapshot.scopes, provider);
  if (scope === "disabled") return null;

  if (snapshot.businessId && scope === "business") {
    const row = snapshot.businessCredentials.get(provider);
    if (!isRunnableCredential(row)) return null;
    if (
      encryptedCredentialUnavailable(row, encryptionKey, logger, provider, "business", {
        ownerUserId,
        businessId: snapshot.businessId,
      })
    )
      return null;
    const apiKey = await decryptIfNeeded(row?.api_key, row?.encrypted, encryptionKey);
    return apiKey ? { envVar, apiKey } : null;
  }

  const row = snapshot.userIntegrations.get(provider);
  if (!isRunnableCredential(row)) return null;
  if (
    encryptedCredentialUnavailable(row, encryptionKey, logger, provider, "user", {
      ownerUserId,
      businessId: snapshot.businessId,
    })
  )
    return null;
  const apiKey = await decryptIfNeeded(row?.api_key, row?.encrypted, encryptionKey);
  return apiKey ? { envVar, apiKey } : null;
}

/**
 * Raw provider API key for injection into a CUSTOMER APP runtime, used by
 * declared credentials with `source: business_openai_key|business_anthropic_key`.
 * Unlike the agent path, OpenAI is NOT gateway-tokenized here: the customer app
 * calls the provider directly, so it needs the stored key itself. Same
 * scope/validation rules as the agent credential (business scope wins when the
 * integration is business-scoped). Returns null when no runnable key exists.
 */
export async function resolveAppRuntimeLlmKey(
  db: D1Database,
  params: {
    ownerUserId: string;
    businessId: string | null;
    provider: Extract<KeyProvider, "openai" | "anthropic">;
    encryptionKey: string | undefined;
    logger?: Logger;
  },
): Promise<string | null> {
  const logger = params.logger ?? runtimeLog;
  const ownerUserIdNumber = Number(params.ownerUserId);
  if (!Number.isFinite(ownerUserIdNumber)) return null;
  let scopes: Record<ToggleableIntegrationId, IntegrationScope> | null = null;
  try {
    const snapshot = await loadBatchedSpawnDbSnapshot(db, ownerUserIdNumber, params.businessId);
    scopes = snapshot.scopes;
  } catch (error) {
    logger.warn(
      { ownerUserId: params.ownerUserId, businessId: params.businessId, error: String(error) },
      "Failed to resolve integration scopes for app-runtime LLM key",
    );
    return null;
  }
  // The source promises the BUSINESS key. When the integration scope is not
  // business (or there is no business), return null instead of delegating to
  // the shared resolver, whose user fallthrough would silently inject the
  // session owner's PERSONAL provider key into a customer app runtime.
  const scope = getEffectiveProviderScope(scopes, params.provider);
  if (!params.businessId || scope !== "business") return null;
  const row = await db
    .prepare(
      "SELECT api_key, encrypted, last_validation_status FROM business_integration_credentials WHERE business_id = ? AND integration_id = ? LIMIT 1",
    )
    .bind(params.businessId, params.provider)
    .first<{
      api_key: string | null;
      encrypted: number | null;
      last_validation_status: CredentialValidationStatus | null;
    }>();
  if (!isRunnableCredential(row)) return null;
  if (
    encryptedCredentialUnavailable(row, params.encryptionKey, logger, params.provider, "business", {
      ownerUserId: params.ownerUserId,
      businessId: params.businessId,
    })
  ) {
    return null;
  }
  return (await decryptIfNeeded(row?.api_key, row?.encrypted, params.encryptionKey)) ?? null;
}

/**
 * Check whether a provider credential can be selected for an agent spawn.
 * This deliberately reads only credential metadata; it never decrypts or
 * returns the secret value.
 */
export async function canResolveProviderKeyForSpawn(
  db: D1Database,
  params: {
    env: Env;
    ownerUserId: string;
    businessId: string | null;
    provider: KeyProvider;
  },
): Promise<boolean> {
  if (getLocalDevProviderApiKey(params.env, params.provider)) return true;
  if (!PROVIDER_ENV_VAR[params.provider]) return false;

  const ownerUserIdNumber = Number(params.ownerUserId);
  if (!Number.isFinite(ownerUserIdNumber)) return false;
  try {
    const snapshot = await loadBatchedSpawnDbSnapshot(db, ownerUserIdNumber, params.businessId);
    const scope = getEffectiveProviderScope(snapshot.scopes, params.provider);
    if (scope === "disabled") return false;
    const row =
      params.businessId && scope === "business"
        ? snapshot.businessCredentials.get(params.provider)
        : snapshot.userIntegrations.get(params.provider);
    return (
      isRunnableCredential(row) &&
      Boolean(row?.api_key?.trim()) &&
      (row?.encrypted !== 1 || Boolean(params.env.TOKEN_ENCRYPTION_KEY?.trim()))
    );
  } catch {
    return false;
  }
}

async function resolveDbProviderApiKey(
  db: D1Database,
  params: {
    userId: string;
    businessId: string | null;
    scopes: Record<ToggleableIntegrationId, IntegrationScope> | null;
    provider: KeyProvider;
    encryptionKey: string | undefined;
    logger: Logger;
  },
): Promise<{ envVar: string; apiKey: string } | null> {
  const envVar = PROVIDER_ENV_VAR[params.provider];
  if (!envVar) return null;

  const scope = getEffectiveProviderScope(params.scopes, params.provider);
  if (scope === "disabled") return null;

  if (params.businessId && scope === "business") {
    const row = await db
      .prepare(
        "SELECT api_key, encrypted, last_validation_status FROM business_integration_credentials WHERE business_id = ? AND integration_id = ? LIMIT 1",
      )
      .bind(params.businessId, params.provider)
      .first<{
        api_key: string | null;
        encrypted: number | null;
        last_validation_status: CredentialValidationStatus | null;
      }>();
    if (!isRunnableCredential(row)) return null;
    if (
      encryptedCredentialUnavailable(row, params.encryptionKey, params.logger, params.provider, "business", {
        ownerUserId: params.userId,
        businessId: params.businessId,
      })
    ) {
      return null;
    }
    const apiKey = await decryptIfNeeded(row?.api_key, row?.encrypted, params.encryptionKey);
    return apiKey ? { envVar, apiKey } : null;
  }

  const row = await db
    .prepare(
      "SELECT api_key, encrypted, last_validation_status FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1",
    )
    .bind(Number(params.userId), params.provider)
    .first<{
      api_key: string | null;
      encrypted: number | null;
      last_validation_status: CredentialValidationStatus | null;
    }>();
  if (!isRunnableCredential(row)) return null;
  if (
    encryptedCredentialUnavailable(row, params.encryptionKey, params.logger, params.provider, "user", {
      ownerUserId: params.userId,
      businessId: params.businessId,
    })
  )
    return null;
  const apiKey = await decryptIfNeeded(row?.api_key, row?.encrypted, params.encryptionKey);
  return apiKey ? { envVar, apiKey } : null;
}

async function getJiraTokensFromSnapshot(
  snapshot: BatchedSpawnDbSnapshot,
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
): Promise<JiraTokenRecord | null> {
  const row = snapshot.userIntegrations.get("jira");
  if (!row?.oauth_access_token) return null;

  if (row.encrypted === 1 && !encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt Jira tokens");
  }

  if (row.encrypted !== 1) {
    // Jira rows are always written encrypted; fall back to the canonical read.
    return getJiraTokens(db, userId, encryptionKey);
  }

  const accessToken = await decryptIfNeeded(row.oauth_access_token, row.encrypted, encryptionKey);
  if (!accessToken) return null;
  const refreshToken = row.oauth_refresh_token
    ? await decryptIfNeeded(row.oauth_refresh_token, row.encrypted, encryptionKey)
    : null;

  return {
    accessToken,
    refreshToken,
    expiresAt: row.oauth_expires_at ?? null,
    refreshTokenCiphertext: row.oauth_refresh_token ?? null,
  };
}

async function getOAuthTokensFromSnapshot(
  snapshot: BatchedSpawnDbSnapshot,
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
  integrationId: "linear" | "notion",
  fallback: (
    db: D1Database,
    userId: string,
    encryptionKey: string | undefined,
  ) => Promise<RefreshableOAuthTokens | null>,
  label: string,
): Promise<RefreshableOAuthTokens | null> {
  const row = snapshot.userIntegrations.get(integrationId);
  if (!row?.oauth_access_token) return null;

  if (row.encrypted === 1 && !encryptionKey) {
    throw new Error(`TOKEN_ENCRYPTION_KEY is required to decrypt ${label} tokens`);
  }

  if (row.encrypted !== 1 && encryptionKey) {
    // Fall back to the canonical reader to trigger read-repair, encrypting the plaintext row in place.
    return fallback(db, userId, encryptionKey);
  }

  const accessToken = await decryptIfNeeded(row.oauth_access_token, row.encrypted, encryptionKey);
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: await decryptIfNeeded(row.oauth_refresh_token, row.encrypted, encryptionKey),
    expiresAt: row.oauth_expires_at ?? null,
    refreshTokenCiphertext: row.oauth_refresh_token ?? null,
  };
}

async function getSentryCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ accessToken: string; organizationSlug: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "sentry", [
    "api_key",
    "oauth_access_token",
    "service_url",
    "encrypted",
  ]);
  return resolveSentryCredentialRow(row, encryptionKey, logger, businessId);
}

async function getBraintrustCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ apiKey: string; apiUrl: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "braintrust", ["api_key", "service_url", "encrypted"]);
  return resolveBraintrustCredentialRow(row, encryptionKey, logger, businessId);
}

async function getTerraformCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ token: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "terraform", ["api_key", "encrypted"]);
  return resolveTerraformCredentialRow(row, encryptionKey, logger, businessId);
}

async function getStripeCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ secretKey: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "stripe", ["api_key", "encrypted"]);
  return resolveStripeCredentialRow(row, encryptionKey, logger, businessId);
}

async function getVercelCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ accessToken: string; teamId: string | null } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "vercel", ["api_key", "service_url", "encrypted"]);
  return resolveVercelCredentialRow(row, encryptionKey, logger, businessId);
}

async function resolveTerraformCredentialRow(
  row:
    | {
        api_key: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ token: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "terraform", "business", { businessId })) return null;
  const token = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  return token?.trim() ? { token: token.trim() } : null;
}

async function resolveStripeCredentialRow(
  row:
    | {
        api_key: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ secretKey: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "stripe", "business", { businessId })) return null;
  const secretKey = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  return secretKey?.trim() ? { secretKey: secretKey.trim() } : null;
}

async function resolveBraintrustCredentialRow(
  row:
    | {
        api_key: string | null;
        service_url: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ apiKey: string; apiUrl: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "braintrust", "business", { businessId })) return null;
  const apiKey = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  if (!apiKey) return null;
  const apiUrl = normalizeBraintrustApiUrl(row?.service_url) ?? BRAINTRUST_DEFAULT_API_URL;
  return { apiKey, apiUrl };
}

async function getDatadogCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ apiKey: string; appKey: string; site: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "datadog", [
    "api_key",
    "oauth_access_token",
    "service_url",
    "encrypted",
  ]);
  return resolveDatadogCredentialRow(row, encryptionKey, logger, businessId);
}

async function resolveDatadogCredentialRow(
  row:
    | {
        api_key: string | null;
        oauth_access_token: string | null;
        service_url: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ apiKey: string; appKey: string; site: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "datadog", "business", { businessId })) return null;
  const apiKey = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  const appKey = await decryptIfNeeded(row?.oauth_access_token, row?.encrypted ?? null, encryptionKey);
  const site = normalizeDatadogSite(row?.service_url);
  if (!apiKey || !appKey || !site || !isSupportedDatadogSite(site)) return null;
  return { apiKey, appKey, site };
}

async function getLaunchDarklyCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ accessToken: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "launchdarkly", ["api_key", "encrypted"]);
  return resolveLaunchDarklyCredentialRow(row, encryptionKey, logger, businessId);
}

async function resolveLaunchDarklyCredentialRow(
  row:
    | {
        api_key: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ accessToken: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "launchdarkly", "business", { businessId })) {
    return null;
  }
  const accessToken = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  return accessToken?.trim() ? { accessToken: accessToken.trim() } : null;
}

async function getCloudflareCredentialFromDb(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<{ accountId: string; databaseId: string; apiToken: string } | null> {
  const row = await readBusinessCredentialRow(db, businessId, "cloudflare", [
    "api_key",
    "oauth_access_token",
    "service_url",
    "encrypted",
  ]);
  return resolveCloudflareCredentialRow(row, encryptionKey, logger, businessId);
}

// Field mapping mirrors connectBusinessCredentials: the API token (the only
// secret) lives encrypted in api_key, the account ID encrypted in
// oauth_access_token, and the non-secret database ID in plaintext service_url.
async function resolveCloudflareCredentialRow(
  row:
    | {
        api_key: string | null;
        oauth_access_token: string | null;
        service_url: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ accountId: string; databaseId: string; apiToken: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "cloudflare", "business", { businessId })) return null;
  const apiToken = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  const accountId = await decryptIfNeeded(row?.oauth_access_token, row?.encrypted ?? null, encryptionKey);
  const databaseId = row?.service_url?.trim() ?? "";
  if (!apiToken || !isValidCloudflareAccountId(accountId) || !isValidCloudflareD1DatabaseId(databaseId)) {
    return null;
  }
  return { accountId: accountId!.trim(), databaseId, apiToken };
}

async function resolveSentryCredentialRow(
  row:
    | {
        api_key: string | null;
        oauth_access_token: string | null;
        service_url: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ accessToken: string; organizationSlug: string } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "sentry", "business", { businessId })) return null;
  const storedToken = row?.api_key ?? row?.oauth_access_token ?? null;
  const organizationSlug = extractSentryOrganizationSlug(row?.service_url);
  if (!storedToken || !organizationSlug) return null;

  const accessToken = await decryptIfNeeded(storedToken, row?.encrypted ?? null, encryptionKey);
  if (!accessToken) return null;

  return { accessToken, organizationSlug };
}

function normalizeVercelTeamId(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  return raw.startsWith("team_") ? raw : `team_${raw}`;
}

async function resolveVercelCredentialRow(
  row:
    | {
        api_key: string | null;
        service_url: string | null;
        encrypted: number | null;
      }
    | null
    | undefined,
  encryptionKey: string | undefined,
  logger: Logger,
  businessId: string | null,
): Promise<{ accessToken: string; teamId: string | null } | null> {
  if (encryptedCredentialUnavailable(row, encryptionKey, logger, "vercel", "business", { businessId })) return null;
  const accessToken = await decryptIfNeeded(row?.api_key, row?.encrypted ?? null, encryptionKey);
  if (!accessToken) return null;
  return { accessToken, teamId: normalizeVercelTeamId(row?.service_url) };
}

function extractSentryOrganizationSlug(value: string | null | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith(".sentry.io")) {
      return host.slice(0, -".sentry.io".length);
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "organizations") {
      return (parts[1] ?? "").trim().toLowerCase();
    }

    return "";
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Resolves the trigger label the bridge must strip from agent-created Jira
 * issues. The webhook handler honors the installation's stored trigger label
 * before the env default, so the injected value must match it — scoped to the
 * session's selected Jira cloud ID, since a business can hold installations
 * for multiple sites with different labels. Lookup failures fall back to the
 * env default: stripping the default label is better than injecting nothing.
 */
async function resolveJiraTriggerLabelForSpawn(
  db: D1Database,
  businessId: string | null,
  jiraCloudId: string,
  env: Env,
  logger: Logger,
  context: { sessionId?: string; ownerUserId: string },
): Promise<string> {
  if (businessId) {
    try {
      const installation = await getJiraWebhookInstallationByBusinessAndCloudId(db, businessId, jiraCloudId);
      const stored =
        installation && installation.status !== "revoked" ? normalizeWebhookReference(installation.triggerLabel) : null;
      if (stored) return stored.toLowerCase();
    } catch (error) {
      logger.warn(
        { ...context, businessId, error: String(error) },
        "Failed to resolve Jira installation trigger label for spawn; falling back to env default",
      );
    }
  }
  return jiraTriggerLabel(env);
}

export function getSpawnIntegrationCredentialEnvKeys(envVars: Record<string, string>): string[] {
  return Object.keys(envVars)
    .filter((key) => SPAWN_INTEGRATION_CREDENTIAL_ENV_VARS.has(key))
    .sort();
}

export async function resolveSpawnIntegrationRuntime({
  db,
  env,
  logger = runtimeLog,
  businessId: sessionBusinessId,
  ownerUserId,
  selectedModel,
  sessionId,
}: ResolveSpawnIntegrationRuntimeOptions): Promise<SpawnIntegrationRuntime> {
  // The session's model-provider credential is keyed by the model's provider.
  // OpenAI/Anthropic can be business-scoped; Baseten is intentionally user-only.
  const provider = getProviderForModel(selectedModel) as SpawnModelProvider;
  const businessScopedProvider = provider === "baseten" ? null : (provider as KeyProvider & ToggleableIntegrationId);
  const ownerUserIdNumber = Number(ownerUserId);
  let businessId: string | null = sessionBusinessId;
  let scopes: Record<ToggleableIntegrationId, IntegrationScope> | null = null;
  let availableIntegrations = [...DEFAULT_AVAILABLE_INTEGRATIONS];
  let batchedSnapshot: BatchedSpawnDbSnapshot | null = null;

  if (db && Number.isFinite(ownerUserIdNumber)) {
    try {
      batchedSnapshot = await loadBatchedSpawnDbSnapshot(db, ownerUserIdNumber, sessionBusinessId);
      businessId = batchedSnapshot.businessId;
      scopes = batchedSnapshot.scopes;
      availableIntegrations = [...batchedSnapshot.availableIntegrations];
    } catch (error) {
      logger.warn(
        { sessionId, ownerUserId, error: String(error) },
        "Failed to resolve business integration context for spawn",
      );
      throw error;
    }
  }

  const availableSet = new Set(availableIntegrations);
  const envVars: Record<string, string> = {};
  const providerScope = businessScopedProvider ? (scopes?.[businessScopedProvider] ?? "n/a") : "user";
  const providerAvailable = provider === "baseten" || availableSet.has(provider);
  const diagnostics: SpawnIntegrationDiagnostics = {
    provider: {
      id: provider,
      ...createDiagnostic(providerAvailable, providerScope),
    },
    linear: createDiagnostic(availableSet.has("linear"), scopes?.linear ?? "n/a"),
    jira: createDiagnostic(availableSet.has("jira"), scopes?.jira ?? "n/a"),
    notion: createDiagnostic(availableSet.has("notion"), scopes?.notion ?? "n/a"),
    sentry: createDiagnostic(availableSet.has("sentry"), scopes?.sentry ?? "n/a"),
    datadog: createDiagnostic(availableSet.has("datadog"), scopes?.datadog ?? "n/a"),
    launchdarkly: createDiagnostic(availableSet.has("launchdarkly"), scopes?.launchdarkly ?? "n/a"),
    cloudflare: createDiagnostic(availableSet.has("cloudflare"), scopes?.cloudflare ?? "n/a"),
    braintrust: createDiagnostic(availableSet.has("braintrust"), scopes?.braintrust ?? "n/a"),
    stripe: createDiagnostic(availableSet.has("stripe"), scopes?.stripe ?? "n/a"),
    terraform: createDiagnostic(availableSet.has("terraform"), scopes?.terraform ?? "n/a"),
    vercel: createDiagnostic(availableSet.has("vercel"), scopes?.vercel ?? "n/a"),
  };

  const useCodexSubscriptionAuth = provider === "openai" && batchedSnapshot?.useCodexSubscription === true;
  if (provider === "openai" && requiresCodexSubscriptionAuthForModel(selectedModel) && !useCodexSubscriptionAuth) {
    throw buildCodexSubscriptionCredentialError("Codex subscription auth.json is required for this model.");
  }
  if (useCodexSubscriptionAuth) {
    const authJson = await resolveCodexSubscriptionAuthJsonForSpawn(
      batchedSnapshot!,
      ownerUserIdNumber,
      env.TOKEN_ENCRYPTION_KEY,
    );
    envVars[CODEX_SUBSCRIPTION_AUTH_JSON_ENV] = authJson;
    diagnostics.provider.status = "codex_subscription_resolved";
    diagnostics.provider.envInjected = true;
  }

  if (useCodexSubscriptionAuth) {
    // Subscription auth replaces only the OpenAI model-provider credential. Keep
    // resolving the rest of the session integrations below.
  } else if (db && providerAvailable) {
    try {
      const key = batchedSnapshot
        ? await resolveSnapshotApiKey(batchedSnapshot, provider, env.TOKEN_ENCRYPTION_KEY, logger, ownerUserId)
        : await resolveDbProviderApiKey(db, {
            userId: ownerUserId,
            businessId,
            scopes,
            provider,
            encryptionKey: env.TOKEN_ENCRYPTION_KEY,
            logger,
          });

      if (key) {
        if (provider === "openai") {
          const credentialSource =
            businessId && businessScopedProvider && scopes?.[businessScopedProvider] === "business"
              ? ("business_byok" as const)
              : ("user_byok" as const);
          envVars[key.envVar] = await createOpenAIByokGatewayTokenForSpawn(db, {
            env,
            ownerUserId: ownerUserIdNumber,
            businessId,
            sessionId,
            credentialSource,
          });
          envVars.ARCANIST_OPENAI_GATEWAY_ENABLED = "1";
          envVars.ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE = credentialSource;
        } else {
          envVars[key.envVar] = key.apiKey;
        }
        diagnostics.provider.envInjected = true;
        diagnostics.provider.status =
          businessId && businessScopedProvider && scopes?.[businessScopedProvider] === "business"
            ? "business_key_resolved"
            : "user_key_resolved";
      } else {
        const localDevApiKey = getLocalDevProviderApiKey(env, provider);
        if (localDevApiKey) {
          envVars[getProviderEnvVar(provider)] = localDevApiKey;
          diagnostics.provider.envInjected = true;
          diagnostics.provider.status = "local_dev_key_resolved";
        } else {
          diagnostics.provider.status =
            businessId && businessScopedProvider && scopes?.[businessScopedProvider] === "business"
              ? "business_key_missing"
              : "user_key_missing";
        }
      }
    } catch (error) {
      logger.warn(
        { sessionId, ownerUserId, provider, error: String(error) },
        "Failed to resolve model-provider BYOK credentials for spawn",
      );
      diagnostics.provider.status = "lookup_failed";
    }
  } else {
    diagnostics.provider.status =
      businessScopedProvider && availableSet.has(businessScopedProvider)
        ? "byok_not_attempted"
        : "integration_unavailable";
  }

  if (db && availableSet.has("linear")) {
    try {
      const linearToken = await getValidLinearToken(
        db,
        ownerUserId,
        env,
        batchedSnapshot
          ? await getOAuthTokensFromSnapshot(
              batchedSnapshot,
              db,
              ownerUserId,
              env.TOKEN_ENCRYPTION_KEY,
              "linear",
              getLinearTokens,
              "Linear",
            )
          : undefined,
      );
      if (linearToken) {
        envVars["LINEAR_ACCESS_TOKEN"] = linearToken;
        diagnostics.linear.envInjected = true;
        diagnostics.linear.status = "token_resolved";
      } else {
        diagnostics.linear.status = "token_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, ownerUserId, error: String(error) }, "Failed to resolve Linear token for spawn");
      diagnostics.linear.status = "lookup_failed";
    }
  } else {
    diagnostics.linear.status = availableSet.has("linear") ? "token_not_attempted" : "integration_unavailable";
  }

  if (db && availableSet.has("jira")) {
    try {
      const jiraToken = await getValidJiraToken(
        db,
        ownerUserId,
        env,
        batchedSnapshot
          ? await getJiraTokensFromSnapshot(batchedSnapshot, db, ownerUserId, env.TOKEN_ENCRYPTION_KEY)
          : undefined,
      );
      if (jiraToken) {
        const site = await getJiraUserSite(db, Number(ownerUserId));
        if (site) {
          envVars[JIRA_ACCESS_TOKEN_ENV] = jiraToken;
          envVars[JIRA_CLOUD_ID_ENV] = site.jiraCloudId;
          envVars[JIRA_SITE_URL_ENV] = site.siteUrl;
          envVars[JIRA_TRIGGER_LABEL_ENV] = await resolveJiraTriggerLabelForSpawn(
            db,
            businessId,
            site.jiraCloudId,
            env,
            logger,
            { sessionId, ownerUserId },
          );
          diagnostics.jira.envInjected = true;
          diagnostics.jira.status = "token_resolved";
        } else {
          // A token without a selected site cannot target a Jira REST base URL.
          diagnostics.jira.status = "site_missing";
        }
      } else {
        diagnostics.jira.status = "token_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, ownerUserId, error: String(error) }, "Failed to resolve Jira token for spawn");
      diagnostics.jira.status = "lookup_failed";
    }
  } else {
    diagnostics.jira.status = availableSet.has("jira") ? "token_not_attempted" : "integration_unavailable";
  }

  if (db && availableSet.has("notion")) {
    try {
      const notionToken = await getValidNotionToken(
        db,
        ownerUserId,
        env,
        batchedSnapshot
          ? await getOAuthTokensFromSnapshot(
              batchedSnapshot,
              db,
              ownerUserId,
              env.TOKEN_ENCRYPTION_KEY,
              "notion",
              getNotionTokens,
              "Notion",
            )
          : undefined,
      );
      if (notionToken) {
        envVars[NOTION_ACCESS_TOKEN_ENV] = notionToken;
        diagnostics.notion.envInjected = true;
        diagnostics.notion.status = "token_resolved";
      } else {
        diagnostics.notion.status = "token_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, ownerUserId, error: String(error) }, "Failed to resolve Notion token for spawn");
      diagnostics.notion.status = "lookup_failed";
    }
  } else {
    diagnostics.notion.status = availableSet.has("notion") ? "token_not_attempted" : "integration_unavailable";
  }

  if (businessId && scopes?.sentry === "business") {
    try {
      const sentryCredential = batchedSnapshot
        ? await resolveSentryCredentialRow(
            batchedSnapshot.businessCredentials.get("sentry") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getSentryCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (sentryCredential) {
        envVars[SENTRY_ACCESS_TOKEN_ENV] = sentryCredential.accessToken;
        envVars[SENTRY_ORGANIZATION_SLUG_ENV] = sentryCredential.organizationSlug;
        diagnostics.sentry.envInjected = true;
        diagnostics.sentry.status = "credentials_resolved";
      } else {
        diagnostics.sentry.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, businessId, error: String(error) }, "Failed to resolve Sentry credentials for spawn");
      diagnostics.sentry.status = "lookup_failed";
    }
  } else {
    diagnostics.sentry.status = availableSet.has("sentry") ? "credentials_not_attempted" : "integration_unavailable";
  }

  if (businessId && scopes?.datadog === "business") {
    try {
      const datadogCredential = batchedSnapshot
        ? await resolveDatadogCredentialRow(
            batchedSnapshot.businessCredentials.get("datadog") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getDatadogCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (datadogCredential) {
        envVars[DATADOG_API_KEY_ENV] = datadogCredential.apiKey;
        envVars[DATADOG_APP_KEY_ENV] = datadogCredential.appKey;
        envVars[DATADOG_SITE_ENV] = datadogCredential.site;
        diagnostics.datadog.envInjected = true;
        diagnostics.datadog.status = "credentials_resolved";
      } else {
        diagnostics.datadog.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, businessId, error: String(error) }, "Failed to resolve Datadog credentials for spawn");
      diagnostics.datadog.status = "lookup_failed";
    }
  } else {
    diagnostics.datadog.status = availableSet.has("datadog") ? "credentials_not_attempted" : "integration_unavailable";
  }

  if (businessId && scopes?.launchdarkly === "business") {
    try {
      const launchDarklyCredential = batchedSnapshot
        ? await resolveLaunchDarklyCredentialRow(
            batchedSnapshot.businessCredentials.get("launchdarkly") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getLaunchDarklyCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (launchDarklyCredential) {
        envVars[LAUNCHDARKLY_ACCESS_TOKEN_ENV] = launchDarklyCredential.accessToken;
        diagnostics.launchdarkly.envInjected = true;
        diagnostics.launchdarkly.status = "credentials_resolved";
      } else {
        diagnostics.launchdarkly.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn(
        { sessionId, businessId, error: String(error) },
        "Failed to resolve LaunchDarkly credentials for spawn",
      );
      diagnostics.launchdarkly.status = "lookup_failed";
    }
  } else {
    diagnostics.launchdarkly.status = availableSet.has("launchdarkly")
      ? "credentials_not_attempted"
      : "integration_unavailable";
  }

  if (businessId && scopes?.cloudflare === "business") {
    try {
      const cloudflareCredential = batchedSnapshot
        ? await resolveCloudflareCredentialRow(
            batchedSnapshot.businessCredentials.get("cloudflare") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getCloudflareCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (cloudflareCredential) {
        envVars[CLOUDFLARE_ACCOUNT_ID_ENV] = cloudflareCredential.accountId;
        envVars[CLOUDFLARE_D1_DATABASE_ID_ENV] = cloudflareCredential.databaseId;
        envVars[CLOUDFLARE_API_TOKEN_ENV] = cloudflareCredential.apiToken;
        diagnostics.cloudflare.envInjected = true;
        diagnostics.cloudflare.status = "credentials_resolved";
      } else {
        diagnostics.cloudflare.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn(
        { sessionId, businessId, error: String(error) },
        "Failed to resolve Cloudflare D1 credentials for spawn",
      );
      diagnostics.cloudflare.status = "lookup_failed";
    }
  } else {
    diagnostics.cloudflare.status = availableSet.has("cloudflare")
      ? "credentials_not_attempted"
      : "integration_unavailable";
  }

  if (businessId && scopes?.braintrust === "business") {
    try {
      const braintrustCredential = batchedSnapshot
        ? await resolveBraintrustCredentialRow(
            batchedSnapshot.businessCredentials.get("braintrust") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getBraintrustCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (braintrustCredential) {
        envVars[BRAINTRUST_INTEGRATION_API_KEY_ENV] = braintrustCredential.apiKey;
        envVars[BRAINTRUST_INTEGRATION_API_URL_ENV] = braintrustCredential.apiUrl;
        diagnostics.braintrust.envInjected = true;
        diagnostics.braintrust.status = "credentials_resolved";
      } else {
        diagnostics.braintrust.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn(
        { sessionId, businessId, error: String(error) },
        "Failed to resolve Braintrust credentials for spawn",
      );
      diagnostics.braintrust.status = "lookup_failed";
    }
  } else {
    diagnostics.braintrust.status = availableSet.has("braintrust")
      ? "credentials_not_attempted"
      : "integration_unavailable";
  }

  if (businessId && scopes?.stripe === "business") {
    try {
      const stripeCredential = batchedSnapshot
        ? await resolveStripeCredentialRow(
            batchedSnapshot.businessCredentials.get("stripe") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getStripeCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (stripeCredential) {
        envVars[STRIPE_SECRET_KEY_ENV] = stripeCredential.secretKey;
        diagnostics.stripe.envInjected = true;
        diagnostics.stripe.status = "credentials_resolved";
      } else {
        diagnostics.stripe.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, businessId, error: String(error) }, "Failed to resolve Stripe credentials for spawn");
      diagnostics.stripe.status = "lookup_failed";
    }
  } else {
    diagnostics.stripe.status = availableSet.has("stripe") ? "credentials_not_attempted" : "integration_unavailable";
  }

  if (businessId && scopes?.terraform === "business") {
    try {
      const terraformCredential = batchedSnapshot
        ? await resolveTerraformCredentialRow(
            batchedSnapshot.businessCredentials.get("terraform") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getTerraformCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (terraformCredential) {
        envVars[TERRAFORM_PLAN_TOKEN_ENV] = terraformCredential.token;
        envVars[TERRAFORM_IN_AUTOMATION_ENV] = "1";
        diagnostics.terraform.envInjected = true;
        diagnostics.terraform.status = "credentials_resolved";
      } else {
        diagnostics.terraform.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn(
        { sessionId, businessId, error: String(error) },
        "Failed to resolve Terraform Cloud credentials for spawn",
      );
      diagnostics.terraform.status = "lookup_failed";
    }
  } else {
    diagnostics.terraform.status = availableSet.has("terraform")
      ? "credentials_not_attempted"
      : "integration_unavailable";
  }

  if (businessId && scopes?.vercel === "business") {
    try {
      const vercelCredential = batchedSnapshot
        ? await resolveVercelCredentialRow(
            batchedSnapshot.businessCredentials.get("vercel") ?? null,
            env.TOKEN_ENCRYPTION_KEY,
            logger,
            batchedSnapshot.businessId,
          )
        : db
          ? await getVercelCredentialFromDb(db, businessId, env.TOKEN_ENCRYPTION_KEY, logger)
          : null;
      if (vercelCredential) {
        envVars[VERCEL_ACCESS_TOKEN_ENV] = vercelCredential.accessToken;
        if (vercelCredential.teamId) {
          envVars[VERCEL_TEAM_ID_ENV] = vercelCredential.teamId;
        }
        diagnostics.vercel.envInjected = true;
        diagnostics.vercel.status = "credentials_resolved";
      } else {
        diagnostics.vercel.status = "credentials_missing";
      }
    } catch (error) {
      logger.warn({ sessionId, businessId, error: String(error) }, "Failed to resolve Vercel credentials for spawn");
      diagnostics.vercel.status = "lookup_failed";
    }
  } else {
    diagnostics.vercel.status = availableSet.has("vercel") ? "credentials_not_attempted" : "integration_unavailable";
  }

  const lifecycleEvents = collectSpawnLifecycleEvents(diagnostics);

  const requiredProviderEnvVar = getProviderEnvVar(provider);
  if (
    requiredProviderEnvVar &&
    !envVars[requiredProviderEnvVar] &&
    diagnostics.provider.status !== "codex_subscription_resolved"
  ) {
    const providerName = PROVIDER_DISPLAY_NAMES[provider];
    // Fatal: no provider API key resolved. Carry the lifecycle events (which
    // now include the provider FAILED row) on the error so the caller can
    // persist them before the spawn aborts -- a bare throw here would drop
    // every lifecycle row, leaving the only hard-throwing integration with no
    // FAILED record.
    throw new SpawnProviderCredentialError(
      `No API key configured for ${providerName}. Add your ${providerName} API key in Settings → API Keys to use ${selectedModel}.`,
      lifecycleEvents,
    );
  }

  return {
    availableIntegrations,
    businessId,
    scopes,
    envVars,
    diagnostics,
    lifecycleEvents,
  };
}
