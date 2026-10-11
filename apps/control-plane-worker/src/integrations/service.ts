import {
  type BusinessWideIntegrationId,
  type IntegrationId,
  type ToggleableIntegrationId,
  USER_API_KEY_PROVIDER_IDS,
} from "../../../../shared/constants/integration-helpers.js";
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
  type OnboardingReasonCode,
} from "../../../../shared/constants/onboarding.js";
import { parseNeonBranchCredentialConfig } from "../../../../shared/integrations/neon.js";
import type { BusinessIntegrationInfo } from "../../../../shared/types/integrations.js";
import { getMemberBusinessId } from "../business/db";
import {
  BUSINESS_ONLY_SET,
  BUSINESS_WIDE_INTEGRATION_IDS,
  BUSINESS_WIDE_SET,
  type IntegrationScope,
  TOGGLEABLE_INTEGRATION_IDS,
} from "../enums/integrations";
import { getGithubBusinessLifecycleSummary } from "../services/integration-gating";
import { encrypt } from "../settings/encryption";
import { getActiveWorkspaceInstallForBusiness } from "../slack/workspaces";
import type { Env } from "../types";
import {
  getJiraWebhookInstallationByBusiness,
  getLinearWebhookInstallationByBusiness,
  revokeJiraWebhookInstallationByBusiness,
  revokeLinearWebhookInstallationByBusiness,
} from "../webhooks/db";
import { deriveCurrentIntegrationHealth } from "./current-health";
import type { KeyProvider } from "./db";
import {
  buildDeleteBusinessCredentialStatement,
  buildUpsertBusinessIntegrationScopeStatement,
  getBusinessApiKeyForValidation,
  insertBusinessCredential,
  updateBusinessCredentialValidation,
} from "./db";
import { getLatestBusinessIntegrationHealthCheck } from "./health-db";
import { getIntegrationLifecycleSummaries } from "./lifecycle/service";
import { validateProviderApiKey } from "./provider-key-validation";

const ALWAYS_AVAILABLE: IntegrationId[] = ["github"];
const USER_API_KEY_PROVIDER_SET = new Set<string>(USER_API_KEY_PROVIDER_IDS);

// ---------------------------------------------------------------------------
// Scope queries
// ---------------------------------------------------------------------------

/**
 * Get the scope for a single integration within a business.
 * No row = 'user' (permissive default).
 */
async function getIntegrationScope(
  db: D1Database,
  businessId: string,
  integrationId: ToggleableIntegrationId,
): Promise<IntegrationScope> {
  const row = await db
    .prepare("SELECT scope FROM business_integrations WHERE business_id = ? AND integration_id = ? LIMIT 1")
    .bind(businessId, integrationId)
    .first<{ scope: IntegrationScope }>();
  return row?.scope ?? defaultScope(integrationId);
}

/** Default scope when no DB row exists. Business-only integrations default to disabled. */
export function defaultScope(id: ToggleableIntegrationId): IntegrationScope {
  return BUSINESS_ONLY_SET.has(id) ? "disabled" : "user";
}

/**
 * Build the scopes record from raw DB rows, applying defaults for missing integrations.
 */
export function buildIntegrationScopes(
  rows: Array<{ integration_id: string; scope: IntegrationScope }>,
): Record<ToggleableIntegrationId, IntegrationScope> {
  const result = {} as Record<ToggleableIntegrationId, IntegrationScope>;
  for (const id of TOGGLEABLE_INTEGRATION_IDS) {
    result[id] = defaultScope(id);
  }
  for (const row of rows) {
    if (row.integration_id in result) {
      result[row.integration_id as ToggleableIntegrationId] = row.scope;
    }
  }
  return result;
}

export function getEffectiveProviderScope(
  scopes: Record<ToggleableIntegrationId, IntegrationScope> | null | undefined,
  provider: string,
): IntegrationScope | undefined {
  return provider === "baseten" ? "user" : scopes?.[provider as ToggleableIntegrationId];
}

/**
 * Get integration scopes for all toggleable integrations for a user's business.
 */
export async function getIntegrationScopes(
  db: D1Database,
  businessId: string,
): Promise<Record<ToggleableIntegrationId, IntegrationScope>> {
  const rows = await db
    .prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?")
    .bind(businessId)
    .all<{ integration_id: string; scope: IntegrationScope }>();

  return buildIntegrationScopes(rows.results ?? []);
}

/**
 * Derive available integrations from a pre-fetched scopes record.
 */
export function deriveAvailableIntegrations(
  scopes: Record<ToggleableIntegrationId, IntegrationScope>,
): IntegrationId[] {
  const available: IntegrationId[] = [...ALWAYS_AVAILABLE];
  for (const id of TOGGLEABLE_INTEGRATION_IDS) {
    if (scopes[id] !== "disabled") available.push(id);
  }
  return available;
}

// ---------------------------------------------------------------------------
// Scope-aware guards
// ---------------------------------------------------------------------------

/**
 * Check if a specific integration is available for a user.
 * No business = no restrictions. No row in business_integrations = enabled (permissive default).
 */
export async function isIntegrationAvailable(
  db: D1Database,
  userId: number,
  integrationId: IntegrationId,
): Promise<boolean> {
  if (integrationId === "github") return true;

  const businessId = await getMemberBusinessId(db, userId);
  if (!businessId) return true; // no business = no restrictions

  const scope = await getIntegrationScope(db, businessId, integrationId as ToggleableIntegrationId);
  return scope !== "disabled";
}

/**
 * Check if an integration is managed at the business level (scope='business').
 * Returns a 409 error message if managed, or null if the user can proceed.
 */
export async function isBusinessManaged(
  db: D1Database,
  userId: number,
  integrationId: ToggleableIntegrationId,
): Promise<boolean> {
  const businessId = await getMemberBusinessId(db, userId);
  if (!businessId) return false;
  const scope = await getIntegrationScope(db, businessId, integrationId);
  return scope === "business";
}

// ---------------------------------------------------------------------------
// Business integration admin display
// ---------------------------------------------------------------------------

/**
 * Get business integration settings for admin display.
 * Returns scope + credential connection status per integration.
 */
export async function getBusinessIntegrations(
  db: D1Database,
  businessId: string,
): Promise<Record<ToggleableIntegrationId | "github", BusinessIntegrationInfo>> {
  const [
    scopes,
    credRows,
    linearWorkspace,
    jiraWorkspace,
    githubHealth,
    githubLifecycle,
    slackWorkspace,
    lifecycleSummaries,
  ] = await Promise.all([
    getIntegrationScopes(db, businessId),
    db
      .prepare(
        "SELECT integration_id, oauth_access_token, api_key, service_url, last_validation_status FROM business_integration_credentials WHERE business_id = ?",
      )
      .bind(businessId)
      .all<{
        integration_id: string;
        oauth_access_token: string | null;
        api_key: string | null;
        service_url: string | null;
        last_validation_status: CredentialValidationStatus | null;
      }>(),
    getLinearWebhookInstallationByBusiness(db, businessId),
    getJiraWebhookInstallationByBusiness(db, businessId),
    getLatestBusinessIntegrationHealthCheck(db, businessId, "github", "basic"),
    getGithubBusinessLifecycleSummary(db, businessId),
    getActiveWorkspaceInstallForBusiness(db, businessId),
    getIntegrationLifecycleSummaries(
      db,
      TOGGLEABLE_INTEGRATION_IDS.map((integrationId) => ({
        integrationId,
        businessId,
      })),
    ),
  ]);

  const credentialRows = credRows.results ?? [];
  const credMap = new Map(credentialRows.map((r) => [r.integration_id, r]));
  const linearHealth =
    linearWorkspace?.status === "active"
      ? await getLatestBusinessIntegrationHealthCheck(db, businessId, "linear", "basic")
      : null;
  const jiraHealth =
    jiraWorkspace && jiraWorkspace.status !== "revoked"
      ? await getLatestBusinessIntegrationHealthCheck(db, businessId, "jira", "basic")
      : null;
  const githubHealthShape = githubHealth
    ? {
        status: githubHealth.status,
        checkKind: "basic" as const,
        operation: githubHealth.operation,
        checkedAt: githubHealth.checked_at,
        latencyMs: githubHealth.latency_ms,
        diagnostic: githubHealth.diagnostic,
        failureReason: githubHealth.failure_reason,
      }
    : null;
  const linearHealthShape = linearHealth
    ? {
        status: linearHealth.status,
        checkKind: "basic" as const,
        operation: linearHealth.operation,
        checkedAt: linearHealth.checked_at,
        latencyMs: linearHealth.latency_ms,
        diagnostic: linearHealth.diagnostic,
        failureReason: linearHealth.failure_reason,
      }
    : null;
  const jiraHealthShape = jiraHealth
    ? {
        status: jiraHealth.status,
        checkKind: "basic" as const,
        operation: jiraHealth.operation,
        checkedAt: jiraHealth.checked_at,
        latencyMs: jiraHealth.latency_ms,
        diagnostic: jiraHealth.diagnostic,
        failureReason: jiraHealth.failure_reason,
      }
    : null;

  const result = {} as Record<ToggleableIntegrationId | "github", BusinessIntegrationInfo>;
  result.github = {
    scope: "business",
    credentialsConnected: githubHealth?.status === "passed",
    credentialKind: null,
    credentialValidationStatus: null,
    health: githubHealthShape,
    currentHealth: deriveCurrentIntegrationHealth({ health: githubHealthShape, lifecycle: githubLifecycle }),
    lifecycle: githubLifecycle,
  };
  for (const id of TOGGLEABLE_INTEGRATION_IDS) {
    result[id] = {
      scope: scopes[id],
      credentialsConnected: false,
      credentialKind: null,
      credentialValidationStatus: null,
      ...(id === "linear" || id === "jira"
        ? {}
        : { currentHealth: deriveCurrentIntegrationHealth({ lifecycle: lifecycleSummaries.get(id) ?? null }) }),
    };
  }
  for (const id of BUSINESS_WIDE_INTEGRATION_IDS) {
    const row = credMap.get(id);
    const credentialsConnected =
      id === "datadog" || id === "cloudflare"
        ? !!row?.api_key && !!row.oauth_access_token && !!row.service_url
        : id === "braintrust"
          ? !!row?.api_key
          : !!row && (!!row.api_key || !!row.oauth_access_token);
    result[id].credentialsConnected = credentialsConnected;
    result[id].credentialKind = credentialsConnected ? "manual" : null;
    result[id].credentialValidationStatus = row?.last_validation_status ?? null;
  }
  const neonCredentialRow = credMap.get("neon");
  if (neonCredentialRow?.service_url) {
    const neonCredentialConfig = parseNeonBranchCredentialConfig(neonCredentialRow.service_url);
    if (neonCredentialConfig) {
      result.neon.neonCredentialConfig = {
        projectId: neonCredentialConfig.projectId,
        parentBranchId: neonCredentialConfig.parentBranchId ?? null,
      };
    }
  }
  // Revoked rows pass through as "revoked": the settings UI distinguishes a
  // removed binding (Reconnect) from one that never existed (Connect).
  result.jira.jiraWorkspace = jiraWorkspace
    ? {
        status: jiraWorkspace.status,
        cloudId: jiraWorkspace.jiraCloudId,
        siteName: jiraWorkspace.siteName,
        siteUrl: jiraWorkspace.siteUrl,
        webhookBound: jiraWorkspace.status !== "revoked" && Boolean(jiraWorkspace.webhooksJson),
        webhookExpiresAt: jiraWorkspace.status === "revoked" ? null : jiraWorkspace.webhookExpiresAt,
        triggerLabel: jiraWorkspace.triggerLabel,
      }
    : {
        status: "not_connected",
        cloudId: null,
        siteName: null,
        siteUrl: null,
        webhookBound: false,
        webhookExpiresAt: null,
        triggerLabel: null,
      };
  result.jira.health =
    jiraWorkspace && jiraWorkspace.status !== "revoked" && jiraHealthShape
      ? jiraHealthShape
      : (result.jira.health ?? null);
  result.jira.currentHealth = deriveCurrentIntegrationHealth({
    health: result.jira.health,
    lifecycle: lifecycleSummaries.get("jira") ?? null,
  });
  result.linear.linearWorkspace = linearWorkspace
    ? {
        status: linearWorkspace.status,
        organizationId: linearWorkspace.linearOrganizationId,
        organizationName: linearWorkspace.linearOrganizationName,
        organizationUrlKey: linearWorkspace.linearOrganizationUrlKey,
        webhookId: linearWorkspace.linearWebhookId,
        webhookBound: Boolean(linearWorkspace.linearWebhookId),
      }
    : {
        status: "not_connected",
        organizationId: null,
        organizationName: null,
        organizationUrlKey: null,
        webhookId: null,
        webhookBound: false,
      };
  result.linear.health = linearWorkspace?.status === "active" && linearHealthShape ? linearHealthShape : null;
  result.linear.currentHealth = deriveCurrentIntegrationHealth({
    health: result.linear.health,
    lifecycle: lifecycleSummaries.get("linear") ?? null,
  });
  // One workspace per business by design; the DAO lookup already filters
  // uninstalled rows.
  result.slack.slackWorkspace = slackWorkspace
    ? {
        status: "installed",
        teamId: slackWorkspace.teamId,
        teamName: slackWorkspace.teamName,
        teamDomain: slackWorkspace.teamDomain,
        installedAt: slackWorkspace.installedAt,
      }
    : {
        status: "not_installed",
        teamId: null,
        teamName: null,
        teamDomain: null,
        installedAt: null,
      };
  return result;
}

// ---------------------------------------------------------------------------
// Scope mutations
// ---------------------------------------------------------------------------

function assertBusinessIntegrationScopeAllowed(integrationId: ToggleableIntegrationId, scope: IntegrationScope): void {
  if (scope === "business" && !BUSINESS_WIDE_SET.has(integrationId)) {
    throw new Error(`Integration '${integrationId}' does not support business-wide scope`);
  }
  if (scope === "user" && BUSINESS_ONLY_SET.has(integrationId)) {
    throw new Error(`Integration '${integrationId}' only supports business-wide scope`);
  }
}

/**
 * Set the scope for an integration within a business.
 * Only business-wide integrations support scope='business'.
 * Business-only integrations cannot be set to 'user'.
 */
export async function setBusinessIntegrationScope(
  db: D1Database,
  businessId: string,
  integrationId: ToggleableIntegrationId,
  scope: IntegrationScope,
): Promise<void> {
  assertBusinessIntegrationScopeAllowed(integrationId, scope);
  await buildUpsertBusinessIntegrationScopeStatement(db, businessId, integrationId, scope).run();
}

// ---------------------------------------------------------------------------
// Business credential orchestration
// ---------------------------------------------------------------------------

/**
 * Store business-wide credentials for an integration. Encrypts secrets before storage.
 */
export async function connectBusinessCredentials(
  db: D1Database,
  businessId: string,
  integrationId: BusinessWideIntegrationId,
  data: { apiKey?: string; applicationKey?: string; oauthAccessToken?: string; serviceUrl?: string },
  encryptionKey: string | undefined,
  validation?: {
    lastValidatedAt: number;
    lastValidationStatus: CredentialValidationStatus;
    lastValidationReasonCode: OnboardingReasonCode | null;
  },
): Promise<void> {
  const encrypted = data.apiKey ? await encrypt(data.apiKey, encryptionKey) : undefined;
  const secondarySecret = data.applicationKey ?? data.oauthAccessToken;
  const encryptedOAuthAccessToken = secondarySecret ? await encrypt(secondarySecret, encryptionKey) : undefined;
  await insertBusinessCredential(db, businessId, integrationId, {
    oauthAccessToken: encryptedOAuthAccessToken,
    apiKey: encrypted,
    serviceUrl: data.serviceUrl,
    encrypted: !!(data.apiKey || secondarySecret),
    lastValidatedAt: validation?.lastValidatedAt ?? null,
    lastValidationStatus: validation
      ? validation.lastValidationStatus
      : data.apiKey && USER_API_KEY_PROVIDER_SET.has(integrationId)
        ? CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED
        : null,
    lastValidationReasonCode: validation?.lastValidationReasonCode ?? null,
  });
}

export async function revalidateBusinessProviderCredential(opts: {
  db: D1Database;
  businessId: string;
  provider: KeyProvider;
  encryptionKey: string | undefined;
}): Promise<
  | { ok: true; validationStatus: CredentialValidationStatus; reasonCode: OnboardingReasonCode | null }
  | { ok: false; status: number; error: string }
> {
  const stored = await getBusinessApiKeyForValidation(opts.db, opts.businessId, opts.provider, opts.encryptionKey);
  if (!stored) return { ok: false, status: 404, error: "No business credential is configured" };
  const validation = await validateProviderApiKey(opts.provider, stored.apiKey);
  await updateBusinessCredentialValidation(opts.db, opts.businessId, opts.provider, validation);
  if (!validation.accepted) return { ok: false, status: 400, error: validation.error ?? "API key is invalid" };
  return {
    ok: true,
    validationStatus: validation.lastValidationStatus,
    reasonCode: validation.lastValidationReasonCode,
  };
}

/**
 * Remove business-wide credentials and reset scope to the integration default.
 */
export async function disconnectBusinessCredentials(
  db: D1Database,
  businessId: string,
  integrationId: BusinessWideIntegrationId,
): Promise<void> {
  const now = Date.now();
  const scope = BUSINESS_ONLY_SET.has(integrationId) ? "disabled" : "user";
  assertBusinessIntegrationScopeAllowed(integrationId, scope);
  await db.batch([
    buildDeleteBusinessCredentialStatement(db, businessId, integrationId),
    buildUpsertBusinessIntegrationScopeStatement(db, businessId, integrationId, scope, now),
  ]);
}

export async function disconnectBusinessLinearWorkspace(
  db: D1Database,
  businessId: string,
): Promise<{ disconnected: boolean }> {
  const disconnected = await revokeLinearWebhookInstallationByBusiness(db, businessId);
  return { disconnected };
}

/**
 * Disconnects the Jira workspace binding: best-effort remote webhook deletion
 * (the registration may already be expired or unauthorized), then revokes the
 * installation row locally.
 */
export async function disconnectBusinessJiraWorkspace(
  env: Env,
  db: D1Database,
  businessId: string,
): Promise<{ disconnected: boolean }> {
  const installation = await getJiraWebhookInstallationByBusiness(db, businessId);
  if (installation && installation.status !== "revoked") {
    const { deleteJiraWebhooksBestEffort } = await import("../webhooks/jira-registration.js");
    await deleteJiraWebhooksBestEffort(env, db, installation);
  }
  const disconnected = await revokeJiraWebhookInstallationByBusiness(db, businessId);
  return { disconnected };
}
