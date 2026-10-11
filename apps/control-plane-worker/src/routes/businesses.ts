import type {
  BusinessWideIntegrationId,
  ToggleableIntegrationId,
} from "../../../../shared/constants/integration-helpers.js";
import {
  isAllowedStripeBusinessSecretKey,
  isSupportedDatadogSite,
  isValidCloudflareAccountId,
  isValidCloudflareD1DatabaseId,
  normalizeBraintrustApiUrl,
  normalizeDatadogSite,
} from "../../../../shared/constants/integrations.js";
import {
  parseNeonBranchCredentialConfig,
  serializeNeonBranchCredentialConfig,
} from "../../../../shared/integrations/neon.js";
import { assertSecretImportText, SecretImportValidationError } from "../../../../shared/secrets/import-format.js";
import type { BusinessEgressPolicy } from "../../../../shared/types/business-egress-policy.js";
import {
  MAX_BUSINESS_EGRESS_DOMAINS,
  normalizeBusinessEgressPolicy,
} from "../../../../shared/types/business-egress-policy.js";
import { invalidateBusinessAuthSessionCache } from "../auth/service";
import { createBusiness, getBusiness } from "../business/db";
import {
  createBusinessEgressAllowlistPullRequest,
  EgressAllowlistSourceError,
  normalizeEgressAllowlistSourceInput,
  resolveBusinessEgressAllowlistSourceFile,
  syncBusinessEgressAllowlistFromSource,
} from "../business/egress-allowlist-source";
import { offboardBusiness } from "../business/offboarding-service";
import {
  isBusinessAdmin,
  loadBusinessForAuth,
  setBusinessEgressAllowlistSource,
  setBusinessEgressPolicy,
  setBusinessSharedSessions,
} from "../business/service";
import { isInternalCycloidBusinessId } from "../constants/businesses";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import {
  BUSINESS_WIDE_INTEGRATION_IDS,
  BUSINESS_WIDE_SET,
  INTEGRATION_SCOPES,
  type IntegrationScope,
  TOGGLEABLE_INTEGRATION_IDS,
} from "../enums/integrations";
import {
  bulkUpsertRepoLoginEnvVariables,
  deleteRepoLoginEnvVariable,
  getRepoLoginEnvBlobForRepo,
  RepoLoginEnvServiceError,
  upsertRepoLoginEnvVariable,
} from "../env-blobs/service";
import { type KeyProvider, readBusinessCredentialRow } from "../integrations/db";
import { PROVIDER_KEY_CONFIG, validateProviderApiKey } from "../integrations/provider-key-validation";
import {
  connectBusinessCredentials,
  disconnectBusinessCredentials,
  disconnectBusinessJiraWorkspace,
  disconnectBusinessLinearWorkspace,
  getBusinessIntegrations,
  revalidateBusinessProviderCredential,
  setBusinessIntegrationScope,
} from "../integrations/service";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { invalidateBusinessModelsCache } from "../services/bootstrap";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import { assertDatabase } from "../session/state";
import type { AuthInfo } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

const log = createLogger({ bindings: { component: "business-routes" } });

const TOGGLEABLE_SET = new Set<string>(TOGGLEABLE_INTEGRATION_IDS);
const SCOPE_SET = new Set<string>(INTEGRATION_SCOPES);
const MANUAL_BUSINESS_CREDENTIAL_SET = new Set<string>(BUSINESS_WIDE_INTEGRATION_IDS);
const BUSINESS_SETTING_FIELDS = new Set(["sharedSessions", "egressAllowlist"]);
const BUSINESS_SETTING_RATE_LIMIT_MAX = 20;
const BUSINESS_SETTING_RATE_LIMIT_WINDOW_SECONDS = 60;

type BusinessSettingField = "sharedSessions" | "egressAllowlist";

/**
 * Check if the caller is authorized as a business admin.
 * API token callers (canAccessAllSessions) bypass role checks.
 */
async function requireAdmin(db: D1Database, auth: AuthInfo, businessId: string): Promise<Response | null> {
  if (auth.canAccessAllSessions) return null; // API token = super-admin
  const userId = Number(auth.userId);
  if (!Number.isFinite(userId)) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  const admin = await isBusinessAdmin(db, userId, businessId);
  if (!admin) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  return null;
}

function parseBusinessSettingsUpdatePayload(
  payload: Record<string, unknown>,
):
  | Response
  | { field: "sharedSessions"; value: boolean }
  | { field: "egressAllowlist"; value: BusinessEgressPolicy | null } {
  const keys = Object.keys(payload);
  const supportedKeys = keys.filter((key) => BUSINESS_SETTING_FIELDS.has(key));
  if (keys.length === 0 || supportedKeys.length !== 1 || keys.length !== 1) {
    if (keys.some((key) => !BUSINESS_SETTING_FIELDS.has(key))) {
      return jsonErrorResponse("Unsupported business setting", 400);
    }
    return jsonErrorResponse("Update exactly one supported field", 400);
  }
  const field = supportedKeys[0] as BusinessSettingField;
  const value = payload[field];
  if (field === "egressAllowlist") {
    if (value === null) return { field, value: null };
    try {
      return { field, value: normalizeBusinessEgressPolicy(value, "egressAllowlist") };
    } catch (error) {
      return jsonErrorResponse(error instanceof Error ? error.message : "Invalid egressAllowlist", 400);
    }
  }
  if (typeof value !== "boolean") {
    return jsonErrorResponse(`${field} must be a boolean`, 400);
  }
  return { field, value };
}

async function checkBusinessSettingRateLimit(
  kv: KVNamespace,
  auth: AuthInfo,
  businessId: string,
  field: BusinessSettingField,
): Promise<boolean> {
  const actor = auth.authMode === "user_session" ? `user:${auth.userId}` : `${auth.authMode}:${auth.userId}`;
  const bucket = Math.floor(Date.now() / (BUSINESS_SETTING_RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `business-setting:${field}:${businessId}:${actor}:${bucket}`;
  const current = Number((await kv.get(key)) ?? "0");
  if (Number.isFinite(current) && current >= BUSINESS_SETTING_RATE_LIMIT_MAX) return false;
  await kv.put(key, String((Number.isFinite(current) ? current : 0) + 1), {
    expirationTtl: BUSINESS_SETTING_RATE_LIMIT_WINDOW_SECONDS * 2,
  });
  return true;
}

export const businessRoutes: Route[] = [
  // Create a business
  {
    method: "POST",
    pattern: parsePattern("/api/businesses"),
    auth: "authenticated",
    adminTokenOnly: true,
    handler: async (request, env, _match, auth) => {
      if (!auth!.canAccessAllSessions) {
        return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
      }
      const payload = (await parseJsonBody(request)) || {};
      const name = payload.name as string;
      if (!name) {
        return jsonErrorResponse("name is required", 400);
      }
      const db = assertDatabase(env);
      const id = await createBusiness(db, name);
      return jsonResponse({ ok: true, id }, 201);
    },
  },

  {
    method: "POST",
    pattern: parsePattern("/api/admin/businesses/:businessId/offboard"),
    auth: "authenticated",
    adminTokenOnly: true,
    handler: async (request, env, match, auth) => {
      if (!auth!.canAccessAllSessions) {
        return jsonErrorResponse("Forbidden", 403);
      }
      const businessId = match.groups!.businessId;
      const payload = (await parseJsonBody(request)) || {};
      const confirm = payload.confirm === true;
      const overrideProtectedBusiness = payload.overrideProtectedBusiness === true;
      const businessNameConfirmation =
        typeof payload.businessNameConfirmation === "string" ? payload.businessNameConfirmation : "";
      const db = assertDatabase(env);
      const business = await getBusiness(db, businessId);
      if (!business) return jsonErrorResponse("Business not found", 404);
      if (isInternalCycloidBusinessId(businessId) && !overrideProtectedBusiness) {
        return jsonErrorResponse("Refusing to offboard protected Cycloid business without override", 403);
      }
      if (confirm && businessNameConfirmation !== business.name) {
        return jsonErrorResponse("businessNameConfirmation must exactly match the business name", 400);
      }

      const result = await offboardBusiness(env, db, { businessId, confirm }, log);
      return jsonResponse({ ...result, business: { id: business.id, name: business.name } });
    },
  },

  // Get business details
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:id"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);
      const business = await loadBusinessForAuth(db, auth!, businessId, { allowMember: true });
      if (!business) return jsonErrorResponse("Business not found", 404);

      return jsonResponse({ ok: true, business });
    },
  },

  // Update business settings
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:id"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);
      const business = await loadBusinessForAuth(db, auth!, businessId);
      if (!business) return jsonErrorResponse("Business not found", 404);

      const payload = (await parseJsonBody(request)) || {};
      const parsed = parseBusinessSettingsUpdatePayload(payload);
      if (parsed instanceof Response) return parsed;
      if (!(await checkBusinessSettingRateLimit(env.RATE_LIMITS, auth!, businessId, parsed.field))) {
        return jsonErrorResponse("Too many business setting updates. Please try again later.", 429);
      }

      if (parsed.field === "egressAllowlist") {
        await setBusinessEgressPolicy(db, businessId, parsed.value);
        await invalidateBusinessAuthSessionCache(db, businessId, env.RATE_LIMITS);
        log.info(
          {
            event: "business.egress_allowlist.update",
            businessId,
            actorUserId: auth!.userId,
            authMode: auth!.authMode,
            previousDomainCount: business.egressAllowlist?.length ?? 0,
            newDomainCount: parsed.value?.domains.length ?? 0,
            outcome: "updated",
          },
          "Business egress allowlist updated",
        );
        await postStructuredEventToDd(env, {
          event: "business.egress_policy.changed",
          businessId,
          actorUserId: auth!.userId,
          authMode: auth!.authMode,
          previousDomainCount: business.egressAllowlist?.length ?? 0,
          newDomainCount: parsed.value?.domains.length ?? 0,
          outcome: "updated",
        });
        return jsonResponse({ ok: true, egressAllowlist: parsed.value?.domains ?? null });
      }

      await setBusinessSharedSessions(db, businessId, parsed.value);
      await invalidateBusinessAuthSessionCache(db, businessId, env.RATE_LIMITS);
      log.info(
        {
          event: "business.shared_sessions.update",
          businessId,
          sharedSessions: parsed.value,
          actorUserId: auth!.userId,
          authMode: auth!.authMode,
          previousValue: business.sharedSessions,
          newValue: parsed.value,
          outcome: "updated",
        },
        "Business shared_sessions updated",
      );
      return jsonResponse({ ok: true });
    },
  },

  // Read configured egress allowlist source and the current source-file resolution.
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:id/egress-allowlist/source"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);
      const business = await loadBusinessForAuth(db, auth!, businessId);
      if (!business) return jsonErrorResponse("Business not found", 404);
      if (!business.egressAllowlistSource) {
        return jsonResponse({ ok: true, source: null, path: ".cycloid/egress-allowlist.txt", domains: [] });
      }
      try {
        const resolution = await resolveBusinessEgressAllowlistSourceFile(env, businessId);
        return jsonResponse({ ok: true, ...resolution });
      } catch (error) {
        if (error instanceof EgressAllowlistSourceError) {
          return jsonResponse(
            {
              ok: false,
              source: business.egressAllowlistSource,
              path: ".cycloid/egress-allowlist.txt",
              domains: [],
              error: error.message,
              code: error.code,
            },
            error.status,
          );
        }
        throw error;
      }
    },
  },

  // Configure the org egress allowlist source repo.
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:id/egress-allowlist/source"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;
      if (auth!.authMode !== "user_session") {
        return jsonErrorResponse("A user session is required to configure the egress allowlist source", 400);
      }
      const payload = (await parseJsonBody(request)) || {};
      try {
        const source = normalizeEgressAllowlistSourceInput(payload);
        const gate = await verifyRepoAccessAndInstallation(
          db,
          {
            userId: auth!.userId,
            canAccessAllSessions: !!auth!.canAccessAllSessions,
            businessRole: auth!.user?.businessRole ?? null,
          },
          source.sourceRepoOwner,
          source.sourceRepoName,
          { githubTokenEnv: env, reposCacheEnv: env },
        );
        if (!gate.ok) return gate.response;
        await setBusinessEgressAllowlistSource(db, businessId, source);
        return jsonResponse({ ok: true, source, path: ".cycloid/egress-allowlist.txt" });
      } catch (error) {
        if (error instanceof EgressAllowlistSourceError) {
          return jsonErrorResponse(error.message, error.status, { code: error.code });
        }
        throw error;
      }
    },
  },

  // Create or update a PR against the source file for requested egress domains.
  {
    method: "POST",
    pattern: parsePattern("/api/businesses/:id/egress-allowlist/pull-request"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;
      const payload = (await parseJsonBody(request)) || {};
      const domains = Array.isArray(payload.domains) ? payload.domains : null;
      if (!domains || domains.some((entry) => typeof entry !== "string")) {
        return jsonErrorResponse("domains must be an array of domain names", 400);
      }
      if (domains.length > MAX_BUSINESS_EGRESS_DOMAINS) {
        return jsonErrorResponse(`domains must contain at most ${MAX_BUSINESS_EGRESS_DOMAINS} domain names`, 400);
      }
      try {
        const result = await createBusinessEgressAllowlistPullRequest(env, {
          businessId,
          domains,
          reason: typeof payload.reason === "string" ? payload.reason : null,
          actorUserId: auth!.userId,
        });
        return jsonResponse({ ok: true, ...result });
      } catch (error) {
        if (error instanceof EgressAllowlistSourceError) {
          return jsonErrorResponse(error.message, error.status, { code: error.code });
        }
        return jsonErrorResponse(error instanceof Error ? error.message : "Unable to create egress allowlist PR", 500);
      }
    },
  },

  // Explicitly sync the merged source file into the runtime D1 egress policy.
  {
    method: "POST",
    pattern: parsePattern("/api/businesses/:id/egress-allowlist/sync"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;
      try {
        const resolution = await syncBusinessEgressAllowlistFromSource(env, businessId);
        if (resolution.fileExists) {
          await invalidateBusinessAuthSessionCache(db, businessId, env.RATE_LIMITS);
        }
        return jsonResponse({
          ok: true,
          ...resolution,
          applied: resolution.fileExists,
          egressAllowlist: resolution.domains,
        });
      } catch (error) {
        if (error instanceof EgressAllowlistSourceError) {
          return jsonErrorResponse(error.message, error.status, { code: error.code });
        }
        return jsonErrorResponse(error instanceof Error ? error.message : "Unable to sync egress allowlist", 500);
      }
    },
  },

  // Get integration visibility
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:id/integrations"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const integrations = await getBusinessIntegrations(db, businessId);
      return jsonResponse({ ok: true, integrations });
    },
  },

  // Get repo-scoped environment variable metadata for one repository.
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:id/repos/:repoOwner/:repoName/environment-variables"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const repoOwner = match.groups!.repoOwner;
      const repoName = match.groups!.repoName;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      try {
        const loginEnv = await getRepoLoginEnvBlobForRepo(db, businessId, repoOwner, repoName);
        return jsonResponse({ ok: true, loginEnv });
      } catch (error) {
        if (error instanceof RepoLoginEnvServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },

  // Upsert one repo-scoped environment variable without exposing current secret values.
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:id/repos/:repoOwner/:repoName/environment-variables/:envKey"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const repoOwner = match.groups!.repoOwner;
      const repoName = match.groups!.repoName;
      const envKey = match.groups!.envKey;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      if (auth!.authMode !== "user_session") {
        return jsonErrorResponse("A user session is required to update repository environment variables", 400);
      }
      const actorUserId = Number(auth!.userId);
      if (!Number.isFinite(actorUserId)) {
        return jsonErrorResponse("A user session is required to update repository environment variables", 400);
      }

      const payload = (await parseJsonBody(request)) || {};
      const value = typeof payload.value === "string" ? payload.value : null;
      if (value === null) {
        return jsonErrorResponse("value is required", 400);
      }
      const usageNote =
        payload.usageNote === null ? null : typeof payload.usageNote === "string" ? payload.usageNote : undefined;
      const sensitive = typeof payload.sensitive === "boolean" ? payload.sensitive : undefined;

      try {
        const loginEnv = await upsertRepoLoginEnvVariable(db, {
          businessId,
          actorUserId,
          repoOwner,
          repoName,
          key: envKey,
          value,
          usageNote,
          sensitive,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return jsonResponse({ ok: true, loginEnv });
      } catch (error) {
        if (error instanceof RepoLoginEnvServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },

  // Bulk-import repo-scoped environment variables (KEY=VALUE paste / file contents).
  {
    method: "POST",
    pattern: parsePattern("/api/businesses/:id/repos/:repoOwner/:repoName/environment-variables/import"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const repoOwner = match.groups!.repoOwner;
      const repoName = match.groups!.repoName;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      if (auth!.authMode !== "user_session") {
        return jsonErrorResponse("A user session is required to import repository environment variables", 400);
      }
      const actorUserId = Number(auth!.userId);
      if (!Number.isFinite(actorUserId)) {
        return jsonErrorResponse("A user session is required to import repository environment variables", 400);
      }

      const payload = (await parseJsonBody(request)) || {};
      const text = typeof payload.text === "string" ? payload.text : null;
      if (text === null) {
        return jsonErrorResponse("text is required", 400);
      }
      const sensitive = payload.sensitive === false ? false : true;

      try {
        const entries = assertSecretImportText(text);
        const loginEnv = await bulkUpsertRepoLoginEnvVariables(db, {
          businessId,
          actorUserId,
          repoOwner,
          repoName,
          entries,
          sensitive,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return jsonResponse({ ok: true, loginEnv, importedCount: entries.length });
      } catch (error) {
        if (error instanceof SecretImportValidationError) {
          return jsonErrorResponse(error.message, 400, { errors: error.errors });
        }
        if (error instanceof RepoLoginEnvServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },

  // Delete one repo-scoped environment variable without exposing other secret values.
  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:id/repos/:repoOwner/:repoName/environment-variables/:envKey"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const repoOwner = match.groups!.repoOwner;
      const repoName = match.groups!.repoName;
      const envKey = match.groups!.envKey;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      if (auth!.authMode !== "user_session") {
        return jsonErrorResponse("A user session is required to delete repository environment variables", 400);
      }
      const actorUserId = Number(auth!.userId);
      if (!Number.isFinite(actorUserId)) {
        return jsonErrorResponse("A user session is required to delete repository environment variables", 400);
      }

      try {
        const result = await deleteRepoLoginEnvVariable(db, {
          businessId,
          actorUserId,
          repoOwner,
          repoName,
          key: envKey,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return jsonResponse({ ok: true, loginEnv: result.loginEnv, changed: result.changed });
      } catch (error) {
        if (error instanceof RepoLoginEnvServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },

  // Set integration scope
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:id/integrations/:integrationId"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const integrationId = match.groups!.integrationId;
      const db = assertDatabase(env);

      if (!TOGGLEABLE_SET.has(integrationId)) {
        return jsonErrorResponse(`Integration '${integrationId}' is not toggleable`, 400);
      }

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const payload = (await parseJsonBody(request)) || {};
      const scope = payload.scope as string;
      if (!scope || !SCOPE_SET.has(scope)) {
        return jsonErrorResponse(`scope must be one of: ${INTEGRATION_SCOPES.join(", ")}`, 400);
      }

      try {
        await setBusinessIntegrationScope(
          db,
          businessId,
          integrationId as ToggleableIntegrationId,
          scope as IntegrationScope,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Invalid scope for this integration";
        return jsonErrorResponse(msg, 400);
      }
      await invalidateBusinessModelsCache(env, businessId);
      log.info({ businessId, integrationId, scope, actorUserId: auth!.userId }, "Integration scope changed");
      return jsonResponse({ ok: true });
    },
  },

  // Disconnect Linear workspace automation
  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:id/integrations/linear/workspace"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const result = await disconnectBusinessLinearWorkspace(db, businessId);
      log.info(
        { businessId, disconnected: result.disconnected, actorUserId: auth!.userId },
        "Linear workspace disconnected",
      );
      return jsonResponse({ ok: true, ...result });
    },
  },

  // Disconnect Jira workspace automation
  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:id/integrations/jira/workspace"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const result = await disconnectBusinessJiraWorkspace(env, db, businessId);
      log.info(
        { businessId, disconnected: result.disconnected, actorUserId: auth!.userId },
        "Jira workspace disconnected",
      );
      return jsonResponse({ ok: true, ...result });
    },
  },

  // Store business-wide credentials
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:id/integrations/:integrationId/credentials"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const businessId = match.groups!.id;
      const integrationId = match.groups!.integrationId;
      const db = assertDatabase(env);

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      if (!MANUAL_BUSINESS_CREDENTIAL_SET.has(integrationId)) {
        return jsonErrorResponse(`Integration '${integrationId}' does not support manual business credentials`, 400);
      }

      const payload = (await parseJsonBody(request)) || {};
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      const applicationKey = typeof payload.applicationKey === "string" ? payload.applicationKey.trim() : "";
      const rawServiceUrl = typeof payload.serviceUrl === "string" ? payload.serviceUrl : null;
      let serviceUrl =
        integrationId === "datadog"
          ? (normalizeDatadogSite(rawServiceUrl) ?? "")
          : integrationId === "braintrust"
            ? (normalizeBraintrustApiUrl(rawServiceUrl) ?? "")
            : typeof payload.serviceUrl === "string"
              ? payload.serviceUrl.trim()
              : "";

      if (!apiKey) {
        return jsonErrorResponse("apiKey is required", 400);
      }
      if (integrationId === "sentry" && !serviceUrl) {
        return jsonErrorResponse("serviceUrl is required", 400);
      }
      if (integrationId === "datadog" && !applicationKey) {
        return jsonErrorResponse("applicationKey is required", 400);
      }
      if (integrationId === "datadog" && !serviceUrl) {
        return jsonErrorResponse("serviceUrl is required", 400);
      }
      if (integrationId === "datadog" && !isSupportedDatadogSite(serviceUrl)) {
        return jsonErrorResponse("serviceUrl must be one of the supported Datadog site values", 400);
      }
      // Cloudflare D1: apiKey carries the API token, applicationKey the account ID,
      // serviceUrl the database ID. The token must be a D1 Read-scoped token (the
      // sandbox tool also rejects any non-SELECT statement as defense in depth).
      if (integrationId === "cloudflare") {
        if (!applicationKey) {
          return jsonErrorResponse("applicationKey (Cloudflare account ID) is required", 400);
        }
        if (!serviceUrl) {
          return jsonErrorResponse("serviceUrl (Cloudflare D1 database ID) is required", 400);
        }
        if (!isValidCloudflareAccountId(applicationKey)) {
          return jsonErrorResponse("applicationKey must be a valid Cloudflare account ID", 400);
        }
        if (!isValidCloudflareD1DatabaseId(serviceUrl)) {
          return jsonErrorResponse("serviceUrl must be a valid Cloudflare D1 database ID", 400);
        }
      }
      if (integrationId === "braintrust" && rawServiceUrl && !serviceUrl) {
        return jsonErrorResponse("serviceUrl must be one of the allowed Braintrust API hosts", 400);
      }
      if (integrationId === "stripe" && !isAllowedStripeBusinessSecretKey(apiKey)) {
        return jsonErrorResponse(
          "Use a Stripe test-mode or restricted secret key; live unrestricted keys are not allowed",
          400,
        );
      }
      if (integrationId === "neon") {
        let config = parseNeonBranchCredentialConfig(rawServiceUrl);
        if (!config) {
          return jsonErrorResponse(
            "serviceUrl must be a JSON object containing Neon projectId and optional parentBranchId",
            400,
          );
        }
        const existingRow = await readBusinessCredentialRow(db, businessId, "neon", ["service_url"]);
        const existingConfig = parseNeonBranchCredentialConfig(existingRow?.service_url);
        if (
          existingConfig &&
          existingConfig.projectId === config.projectId &&
          !config.parentBranchId &&
          existingConfig.parentBranchId
        ) {
          config = { ...config, parentBranchId: existingConfig.parentBranchId };
        }
        serviceUrl = serializeNeonBranchCredentialConfig(config);
      }

      const validation =
        integrationId in PROVIDER_KEY_CONFIG
          ? await validateProviderApiKey(integrationId as KeyProvider, apiKey)
          : undefined;

      // Do not destroy an existing credential when a replacement key is rejected.
      if (validation && !validation.accepted) {
        const existing = await readBusinessCredentialRow(db, businessId, integrationId as BusinessWideIntegrationId, [
          "api_key",
        ]);
        if (existing?.api_key) {
          return jsonResponse(
            { ok: false, error: validation.error, validationStatus: validation.lastValidationStatus },
            400,
          );
        }
      }

      await connectBusinessCredentials(
        db,
        businessId,
        integrationId as BusinessWideIntegrationId,
        { apiKey, applicationKey, serviceUrl },
        env.TOKEN_ENCRYPTION_KEY,
        validation,
      );
      await invalidateBusinessAuthSessionCache(db, businessId, env.RATE_LIMITS);
      await invalidateBusinessModelsCache(env, businessId);
      log.info(
        { event: "business.credentials.connected", businessId, integrationId, actorUserId: auth!.userId },
        "Business credentials connected",
      );
      await postStructuredEventToDd(env, {
        event: "business.credentials.connected",
        businessId,
        integrationId,
        actorUserId: auth!.userId,
      });
      if (validation && !validation.accepted) {
        return jsonResponse(
          { ok: false, error: validation.error, validationStatus: validation.lastValidationStatus },
          400,
        );
      }
      return jsonResponse({ ok: true, validationStatus: validation?.lastValidationStatus ?? null });
    },
  },

  {
    method: "POST",
    pattern: parsePattern("/api/businesses/:id/integrations/:integrationId/credentials/validate"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const integrationId = match.groups!.integrationId;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;
      if (!(integrationId in PROVIDER_KEY_CONFIG)) {
        return jsonErrorResponse(`Integration '${integrationId}' does not support provider key validation`, 400);
      }
      const result = await revalidateBusinessProviderCredential({
        db,
        businessId,
        provider: integrationId as KeyProvider,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      });
      await invalidateBusinessAuthSessionCache(db, businessId, env.RATE_LIMITS);
      await invalidateBusinessModelsCache(env, businessId);
      if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
      return jsonResponse(result);
    },
  },

  // Remove business-wide credentials (also resets scope to the integration default)
  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:id/integrations/:integrationId/credentials"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const businessId = match.groups!.id;
      const integrationId = match.groups!.integrationId;
      const db = assertDatabase(env);

      if (!BUSINESS_WIDE_SET.has(integrationId)) {
        return jsonErrorResponse(`Integration '${integrationId}' does not support business-wide credentials`, 400);
      }

      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      await disconnectBusinessCredentials(db, businessId, integrationId as BusinessWideIntegrationId);
      await invalidateBusinessAuthSessionCache(db, businessId, env.RATE_LIMITS);
      await invalidateBusinessModelsCache(env, businessId);
      log.info(
        { event: "business.credentials.disconnected", businessId, integrationId, actorUserId: auth!.userId },
        "Business credentials disconnected",
      );
      await postStructuredEventToDd(env, {
        event: "business.credentials.disconnected",
        businessId,
        integrationId,
        actorUserId: auth!.userId,
      });
      return jsonResponse({ ok: true });
    },
  },
];
