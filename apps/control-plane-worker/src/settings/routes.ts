import { z } from "zod";

import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import {
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { CREDENTIAL_VALIDATION_STATUS } from "../../../../shared/constants/onboarding.js";
import {
  isValidGithubOwnerLogin,
  isValidGithubRepoName,
  PR_REVIEW_BOT_IDS,
  PR_REVIEW_EXPECTED_BOT_LIMIT,
  type PrReviewExpectedBot,
} from "../../../../shared/constants/pr-review-bots.js";
import { normalizePlanModeSetting } from "../../../../shared/plan-mode.js";
import { getValidGithubTokenResult } from "../auth/db";
import { verifyUserRepoAccess } from "../auth/repo-authorization";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import { parseRepoUrl } from "../github/pr";
import type { KeyProvider } from "../integrations/db";
import { PROVIDER_KEY_CONFIG } from "../integrations/provider-key-validation";
import { createLogger } from "../logger";
import { getOpenAIGatewayUsagePayload } from "../openai-gateway/usage";
import { paginateQueryFromRequest } from "../routes/shared";
import { invalidateModelsMemoryCache, modelsCacheKey } from "../services/bootstrap";
import type { AuthInfo, Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { SETTINGS_PROFILES, type SettingsProfile } from "./autonomy";
import { UserRowMissingError } from "./db";
import {
  checkApiKeyDeleteRateLimit,
  checkApiKeyValidationRateLimit,
  checkPrReviewBotSettingsRateLimit,
} from "./rate-limit";
import {
  clearCodexSubscriptionAuthJsonForUser,
  clearProviderApiKeyForUser,
  getCodexSubscriptionStatePayload,
  getPrReviewBotSettingsPayload,
  getSettingsPayload,
  isCodexSubscriptionEligibleForUser,
  listPrReviewBotSettingsPayload,
  prReviewBotSettingsRejectionMessage,
  saveCodexSubscriptionAuthJsonForUser,
  saveProviderApiKeyForUser,
  setCodexSubscriptionEnabledForUser,
  updatePrReviewBotSettingsPayload,
  updateSettingsPayload,
  validateProviderApiKeyForUser,
} from "./service";

const log = createLogger({ bindings: { component: "settings" } });

const CODEX_SUBSCRIPTION_RATE_LIMIT_BUCKET = "codex_subscription";

function resolveUserId(auth: AuthInfo): number | null {
  const id = Number(auth.userId);
  return Number.isFinite(id) ? id : null;
}

async function invalidateModelsCacheForUser(env: Env, userId: number): Promise<void> {
  invalidateModelsMemoryCache(userId);
  try {
    await env.DERIVED_MODELS.delete(modelsCacheKey(userId));
  } catch {
    /* non-critical */
  }
}

const PR_REVIEW_BOTS_JSON_MAX_BYTES = 8 * 1024;
const textEncoder = new TextEncoder();

const knownPrReviewBotSchema = z
  .object({
    type: z.literal("known"),
    id: z.enum(PR_REVIEW_BOT_IDS),
  })
  .strict();

const customPrReviewBotSchema = z
  .object({
    type: z.literal("custom"),
    login: z.string().min(1).max(39),
  })
  .strict();

const prReviewBotSettingsBodySchema = z
  .object({
    expectedBots: z
      .array(z.discriminatedUnion("type", [knownPrReviewBotSchema, customPrReviewBotSchema]))
      .max(PR_REVIEW_EXPECTED_BOT_LIMIT),
    mergeConflictResolutionEnabled: z.boolean().optional(),
  })
  .strict();

type ParsedRepoParams = { ok: true; owner: string; repo: string } | { ok: false; response: Response };

function resolveCookieSessionUserId(auth: AuthInfo): number | Response {
  if (auth.authMode !== "user_session") return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);
  return userId;
}

function decodeRouteParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePrReviewBotRepoParams(ownerParam: string, repoParam: string): ParsedRepoParams {
  const owner = decodeRouteParam(ownerParam);
  const repo = decodeRouteParam(repoParam);
  if (!owner || !repo || !isValidGithubOwnerLogin(owner) || !isValidGithubRepoName(repo)) {
    return { ok: false, response: jsonErrorResponse("Invalid repository", 400) };
  }
  return { ok: true, owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

async function parseBoundedPrReviewBotSettingsBody(request: Request): Promise<
  | {
      ok: true;
      expectedBots: PrReviewExpectedBot[];
      mergeConflictResolutionEnabled?: boolean;
    }
  | { ok: false; response: Response }
> {
  const mediaType = request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE)?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    return { ok: false, response: jsonErrorResponse("Unsupported content type", 415) };
  }

  const raw = await request.text();
  if (textEncoder.encode(raw).byteLength > PR_REVIEW_BOTS_JSON_MAX_BYTES) {
    return { ok: false, response: jsonErrorResponse("Invalid PR review bot settings", 400) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: jsonErrorResponse("Invalid PR review bot settings", 400) };
  }

  const body = prReviewBotSettingsBodySchema.safeParse(parsed);
  if (!body.success) {
    return { ok: false, response: jsonErrorResponse("Invalid PR review bot settings", 400) };
  }
  return {
    ok: true,
    expectedBots: body.data.expectedBots,
    mergeConflictResolutionEnabled: body.data.mergeConflictResolutionEnabled,
  };
}

async function verifyPrReviewBotRepoAccess(
  env: Env,
  userId: number,
  owner: string,
  repo: string,
): Promise<Response | null> {
  let hasAccess: boolean;
  try {
    hasAccess = await verifyUserRepoAccess(env.DB, String(userId), owner, repo, {
      githubTokenEnv: env,
      reposCacheEnv: env.REPOS_CACHE ? env : undefined,
    });
  } catch (err) {
    log.warn({ userId, owner, repo, error: String(err) }, "PR review bot repo access verification unavailable");
    return jsonErrorResponse("Unable to verify repository access", 503);
  }
  if (!hasAccess) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  return null;
}

// A settings read/write for a user_id with no `users` row means the session is
// a stale KV cache for a deleted/renumbered user. Fail closed with 401 (client
// re-auths) and WARN so stale-cache-after-user-mutation incidents are visible.
function staleUserSettingsResponse(request: Request, userId: number): Response {
  log.warn(
    { event: "settings_user_row_missing", userId, requestId: request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID) },
    "Settings request rejected: no users row for cached session",
  );
  return jsonErrorResponse("Authentication required", 401);
}

export async function handleGetSettings(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  const url = new URL(request.url);
  const scopeFull = url.searchParams.get("scope") === "full";
  try {
    return jsonResponse(await getSettingsPayload(env.DB, userId, scopeFull));
  } catch (err) {
    if (err instanceof UserRowMissingError) return staleUserSettingsResponse(request, userId);
    throw err;
  }
}

export async function handleGetOpenAIUsage(env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  return jsonResponse(await getOpenAIGatewayUsagePayload(env.DB, userId));
}

export async function handleGetCodexSubscription(env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  return jsonResponse(await getCodexSubscriptionStatePayload(env.DB, userId));
}

export async function handlePutSettings(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  const body = await parseJsonBody(request);
  if (!body) return jsonErrorResponse("Invalid JSON body", 400);

  // Validate fields
  if (body.defaultPrDraft !== undefined && typeof body.defaultPrDraft !== "boolean") {
    return jsonErrorResponse("defaultPrDraft must be a boolean", 400);
  }
  if (body.autoVerifyEnabled !== undefined && typeof body.autoVerifyEnabled !== "boolean") {
    return jsonErrorResponse("autoVerifyEnabled must be a boolean", 400);
  }
  if (body.automaticReviewsEnabled !== undefined && typeof body.automaticReviewsEnabled !== "boolean") {
    return jsonErrorResponse("automaticReviewsEnabled must be a boolean", 400);
  }
  if (body.settingsProfile !== undefined && !SETTINGS_PROFILES.includes(body.settingsProfile as SettingsProfile)) {
    return jsonErrorResponse('settingsProfile must be one of "manual", "autonomous", or "custom"', 400);
  }
  if (
    body.planApprovalRequired !== undefined &&
    body.planApprovalRequired !== null &&
    typeof body.planApprovalRequired !== "boolean"
  ) {
    return jsonErrorResponse("planApprovalRequired must be a boolean or null", 400);
  }
  const normalizedPlanMode = normalizePlanModeSetting(typeof body.planMode === "string" ? body.planMode : undefined);
  if (body.planMode !== undefined && normalizedPlanMode === undefined) {
    return jsonErrorResponse('planMode must be one of "off", "on", or "auto"', 400);
  }
  if (body.useCodexSubscription !== undefined && typeof body.useCodexSubscription !== "boolean") {
    return jsonErrorResponse("useCodexSubscription must be a boolean", 400);
  }
  if (body.useCodexSubscription === true && !(await isCodexSubscriptionEligibleForUser(env.DB, userId))) {
    return jsonErrorResponse("Codex subscription auth is not enabled for your workspace", 403);
  }
  if (body.defaultModel !== undefined && body.defaultModel !== null && typeof body.defaultModel !== "string") {
    return jsonErrorResponse("defaultModel must be a string or null", 400);
  }
  // Normalize "provider:modelId" to bare modelId and validate against known models
  if (typeof body.defaultModel === "string") {
    const normalized = normalizeRetiredBasetenModelId(body.defaultModel);
    // Any-backend: a Claude default model is valid; the backend is derived
    // from the model at session create.
    const sessionStartModel = extractSessionStartModelIdAnyBackend(normalized);
    if (!normalized || !sessionStartModel) {
      return jsonErrorResponse(`Invalid model: ${body.defaultModel}`, 400);
    }
    body.defaultModel = sessionStartModel;
  }
  if (body.defaultRepo !== undefined && body.defaultRepo !== null) {
    if (typeof body.defaultRepo !== "string") {
      return jsonErrorResponse("defaultRepo must be a string or null", 400);
    }
    let parsedRepo: { owner: string; repo: string };
    try {
      parsedRepo = parseRepoUrl(body.defaultRepo as string);
    } catch {
      return jsonErrorResponse("Invalid repository format. Use owner/repo, SSH, or HTTPS URL.", 400);
    }

    let hasAccess: boolean;
    try {
      hasAccess = await verifyUserRepoAccess(env.DB, String(userId), parsedRepo.owner, parsedRepo.repo, {
        githubTokenEnv: env,
      });
    } catch (err) {
      log.error(
        { owner: parsedRepo.owner, repo: parsedRepo.repo, userId: String(userId), error: String(err) },
        "Settings rejected: repo access verification unavailable",
      );
      return jsonErrorResponse("Unable to verify repository access. Please try again.", 503);
    }
    if (!hasAccess) {
      return jsonErrorResponse("You do not have access to this repository on GitHub", 403);
    }
  }

  try {
    const response = await updateSettingsPayload(env.DB, userId, {
      defaultPrDraft: body.defaultPrDraft as boolean | undefined,
      autoVerifyEnabled: body.autoVerifyEnabled as boolean | undefined,
      automaticReviewsEnabled: body.automaticReviewsEnabled as boolean | undefined,
      planMode: normalizedPlanMode,
      planApprovalRequired: body.planApprovalRequired as boolean | null | undefined,
      settingsProfile: body.settingsProfile as SettingsProfile | undefined,
      useCodexSubscription: body.useCodexSubscription as boolean | undefined,
      defaultModel: body.defaultModel as string | null | undefined,
      defaultRepo: body.defaultRepo as string | null | undefined,
    });
    if (body.useCodexSubscription !== undefined) {
      await invalidateModelsCacheForUser(env, userId);
    }
    return jsonResponse(response);
  } catch (err) {
    if (err instanceof UserRowMissingError) return staleUserSettingsResponse(request, userId);
    throw err;
  }
}

async function resolveApiKeyRequest(
  request: Request,
  env: Env,
  auth: AuthInfo,
  provider: string,
): Promise<{ userId: number; keyProvider: KeyProvider; apiKey: string } | Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  if (!(provider in PROVIDER_KEY_CONFIG)) {
    return jsonErrorResponse(`Unknown provider: ${provider}`, 400);
  }
  const keyProvider = provider as KeyProvider;
  const config = PROVIDER_KEY_CONFIG[keyProvider];

  const body = await parseJsonBody(request);
  if (!body || typeof body.apiKey !== "string" || (body.apiKey as string).length === 0) {
    return jsonErrorResponse("Missing apiKey", 400);
  }

  const apiKey = body.apiKey as string;
  if (config.prefix && !apiKey.startsWith(config.prefix)) {
    return jsonErrorResponse(`API key must start with "${config.prefix}"`, 400);
  }

  if (!(await checkApiKeyValidationRateLimit(env, userId, keyProvider))) {
    return jsonErrorResponse("Too many API key validation attempts. Try again in a minute.", 429);
  }

  return { userId, keyProvider, apiKey };
}

export async function handleValidateApiKey(
  request: Request,
  env: Env,
  auth: AuthInfo,
  provider: string,
): Promise<Response> {
  const resolved = await resolveApiKeyRequest(request, env, auth, provider);
  if (resolved instanceof Response) return resolved;
  const { userId, keyProvider, apiKey } = resolved;

  const result = await validateProviderApiKeyForUser({ db: env.DB, userId, provider: keyProvider, apiKey });
  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error }, result.status);
  }

  // Nothing is persisted on this path, so the persistence-scoped
  // "saved_unverified" status is reported as "unverified".
  const validationStatus =
    result.validationStatus === CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED ? "unverified" : result.validationStatus;
  return jsonResponse({ ok: true, validationStatus, reasonCode: result.reasonCode });
}

export async function handlePutApiKey(request: Request, env: Env, auth: AuthInfo, provider: string): Promise<Response> {
  const resolved = await resolveApiKeyRequest(request, env, auth, provider);
  if (resolved instanceof Response) return resolved;
  const { userId, keyProvider, apiKey } = resolved;

  const result = await saveProviderApiKeyForUser({
    db: env.DB,
    userId,
    provider: keyProvider,
    apiKey,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
  });

  if (result.ok || result.state) {
    // Invalidate cached /api/models so saved keys, including invalid persisted keys, are reflected immediately
    await invalidateModelsCacheForUser(env, userId);
  }

  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        error: result.error,
        ...(result.state ? { state: result.state } : {}),
      },
      result.status,
    );
  }

  return jsonResponse(result.state);
}

export async function handleDeleteApiKey(env: Env, auth: AuthInfo, provider: string): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  if (!(provider in PROVIDER_KEY_CONFIG)) {
    return jsonErrorResponse(`Unknown provider: ${provider}`, 400);
  }
  const keyProvider = provider as KeyProvider;

  if (!(await checkApiKeyDeleteRateLimit(env, userId, keyProvider))) {
    return jsonErrorResponse("Too many credential updates. Try again in a minute.", 429);
  }

  const result = await clearProviderApiKeyForUser(env.DB, userId, keyProvider);
  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error }, result.status);
  }

  // Invalidate cached /api/models so the removed key is reflected immediately
  await invalidateModelsCacheForUser(env, userId);

  return jsonResponse(result.state);
}

export async function handlePutCodexSubscriptionAuthJson(
  request: Request,
  env: Env,
  auth: AuthInfo,
): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  const body = await parseJsonBody(request);
  if (!body || typeof body.authJson !== "string") return jsonErrorResponse("Missing authJson", 400);
  if (!(await checkApiKeyValidationRateLimit(env, userId, CODEX_SUBSCRIPTION_RATE_LIMIT_BUCKET))) {
    return jsonErrorResponse("Too many credential updates. Try again in a minute.", 429);
  }

  const result = await saveCodexSubscriptionAuthJsonForUser({
    db: env.DB,
    userId,
    authJson: body.authJson,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
  });
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
  await invalidateModelsCacheForUser(env, userId);

  return jsonResponse(result.state);
}

export async function handleDeleteCodexSubscriptionAuthJson(env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);
  if (!(await checkApiKeyDeleteRateLimit(env, userId, CODEX_SUBSCRIPTION_RATE_LIMIT_BUCKET))) {
    return jsonErrorResponse("Too many credential updates. Try again in a minute.", 429);
  }

  const result = await clearCodexSubscriptionAuthJsonForUser(env.DB, userId);
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
  await invalidateModelsCacheForUser(env, userId);
  return jsonResponse(result.state);
}

export async function handlePutCodexSubscriptionEnabled(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveUserId(auth);
  if (!userId) return jsonErrorResponse("Authentication required", 401);

  const body = await parseJsonBody(request);
  if (!body || typeof body.enabled !== "boolean") return jsonErrorResponse("Missing boolean `enabled`", 400);

  const result = await setCodexSubscriptionEnabledForUser({ db: env.DB, userId, enabled: body.enabled });
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
  await invalidateModelsCacheForUser(env, userId);

  return jsonResponse({ useCodexSubscription: result.useCodexSubscription });
}

export async function handleGetPrReviewBotSettings(
  _request: Request,
  env: Env,
  auth: AuthInfo,
  ownerParam: string,
  repoParam: string,
): Promise<Response> {
  const userId = resolveCookieSessionUserId(auth);
  if (userId instanceof Response) return userId;

  const parsedRepo = parsePrReviewBotRepoParams(ownerParam, repoParam);
  if (!parsedRepo.ok) return parsedRepo.response;

  const accessError = await verifyPrReviewBotRepoAccess(env, userId, parsedRepo.owner, parsedRepo.repo);
  if (accessError) return accessError;

  return jsonResponse(await getPrReviewBotSettingsPayload(env.DB, userId, parsedRepo.owner, parsedRepo.repo));
}

export async function handlePutPrReviewBotSettings(
  request: Request,
  env: Env,
  auth: AuthInfo,
  ownerParam: string,
  repoParam: string,
): Promise<Response> {
  const userId = resolveCookieSessionUserId(auth);
  if (userId instanceof Response) return userId;

  const parsedRepo = parsePrReviewBotRepoParams(ownerParam, repoParam);
  if (!parsedRepo.ok) return parsedRepo.response;

  const accessError = await verifyPrReviewBotRepoAccess(env, userId, parsedRepo.owner, parsedRepo.repo);
  if (accessError) return accessError;

  if (!(await checkPrReviewBotSettingsRateLimit(env, userId, parsedRepo.owner, parsedRepo.repo))) {
    return jsonErrorResponse("Too many requests", 429);
  }

  const body = await parseBoundedPrReviewBotSettingsBody(request);
  if (!body.ok) return body.response;

  const updated = await updatePrReviewBotSettingsPayload(env.DB, userId, parsedRepo.owner, parsedRepo.repo, {
    expectedBots: body.expectedBots,
    mergeConflictResolutionEnabled: body.mergeConflictResolutionEnabled,
  });
  if ("ok" in updated && updated.ok === false) {
    log.warn(
      { userId, owner: parsedRepo.owner, repo: parsedRepo.repo, reason: updated.reason },
      "Invalid PR review bot settings rejected",
    );
    return jsonErrorResponse(prReviewBotSettingsRejectionMessage(updated.reason), 400, { code: updated.reason });
  }

  log.info({ userId, owner: parsedRepo.owner, repo: parsedRepo.repo }, "PR review bot settings saved");
  return jsonResponse(updated);
}

export async function handleListPrReviewBotSettings(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const userId = resolveCookieSessionUserId(auth);
  if (userId instanceof Response) return userId;

  const { cursor, limit } = paginateQueryFromRequest(request, 100);
  let githubTokenResultPromise: ReturnType<typeof getValidGithubTokenResult> | null = null;
  const payload = await listPrReviewBotSettingsPayload({
    db: env.DB,
    userId,
    cursor,
    limit: limit ?? 50,
    verifyAccess: async (owner, repo) => {
      githubTokenResultPromise ??= getValidGithubTokenResult(env.DB, String(userId), env);
      return await verifyUserRepoAccess(env.DB, String(userId), owner, repo, {
        preloadedGithubTokenResult: await githubTokenResultPromise,
        reposCacheEnv: env.REPOS_CACHE ? env : undefined,
      });
    },
  });

  return jsonResponse(payload);
}
