import {
  BRAINTRUST_DEFAULT_API_URL,
  isSupportedDatadogSite,
  isValidCloudflareAccountId,
  isValidCloudflareD1DatabaseId,
  normalizeBraintrustApiUrl,
  normalizeDatadogSite,
} from "../../../../shared/constants/integrations.js";
import { CREDENTIAL_VALIDATION_STATUS } from "../../../../shared/constants/onboarding.js";
import { upsertRepoLoginEnvVariable } from "../env-blobs/service";
import { upsertInstallation } from "../github/installations-db";
import { connectBusinessCredentials, setBusinessIntegrationScope } from "../integrations/service";
import { decrypt } from "../settings/encryption";
import type { Env } from "../types";
import { jsonErrorResponse, jsonResponse } from "../utils";

const QA_BUSINESS_ID = "b004178c-58e4-421b-a6b9-43b410fc64ec";
const QA_BUSINESS_NAME = "Cycloid QA";
const DEFAULT_QA_REPO_OWNER = "trycycloid";
const DEFAULT_QA_REPO_NAME = "dummy-docker-app";
const BUSINESS_MANAGED_QA_FIXTURE_IDS = ["cloudflare", "datadog", "braintrust"] as const;
const REPO_LOGIN_ENV_KEYS = [
  "ARCANIST_LOGIN_USERNAME",
  "ARCANIST_LOGIN_PASSWORD",
  "ARCANIST_LOGIN_PAGE",
  "ARCANIST_AUTHENTICATED_PAGE",
] as const;

type BusinessManagedQaFixtureId = (typeof BUSINESS_MANAGED_QA_FIXTURE_IDS)[number];
type QaFixtureStatus = "configured" | "missing" | "invalid_config";

interface QaFixtureSeedResult {
  integrationId: BusinessManagedQaFixtureId;
  status: QaFixtureStatus;
  reason: string;
}

interface QaFixtureEnvStatus {
  required: string[];
  present: string[];
  missing: string[];
  sources?: Record<string, string>;
}

interface QaFixtureHealthRow extends QaFixtureSeedResult {
  env: QaFixtureEnvStatus;
  credentialRow: "present" | "missing";
  scope: "business" | "user" | "disabled" | "missing";
}

class QaSeedError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "QaSeedError";
  }
}

function requireQaEnv(env: Env): void {
  if (env.WORKER_ENV !== "qa") {
    throw new QaSeedError("QA seed is only allowed when WORKER_ENV=qa", 403);
  }
}

function requiredString(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new QaSeedError(`${String(key)} is required`);
  }
  return value.trim();
}

function optionalString(env: Env, key: keyof Env): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalStringAny(env: Env, ...keys: (keyof Env)[]): string | null {
  for (const key of keys) {
    const value = optionalString(env, key);
    if (value) return value;
  }
  return null;
}

function requiredPositiveInteger(env: Env, key: keyof Env): number {
  const raw = requiredString(env, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new QaSeedError(`${String(key)} must be a positive integer`);
  }
  return value;
}

function missingEnvKeys(env: Env, keys: readonly (keyof Env)[]): string[] {
  return keys.filter((key) => !optionalString(env, key)).map(String);
}

function buildResolvedEnvStatus(env: Env, required: readonly { name: string; keys: readonly (keyof Env)[] }[]) {
  const missing: string[] = [];
  const present: string[] = [];
  const sources: Record<string, string> = {};
  for (const entry of required) {
    const sourceKey = entry.keys.find((key) => optionalString(env, key));
    if (sourceKey) {
      present.push(String(sourceKey));
      sources[entry.name] = String(sourceKey);
    } else {
      missing.push(entry.name);
    }
  }
  return {
    required: required.map((entry) => entry.name),
    present,
    missing,
    sources,
  };
}

async function inspectStoredValue(
  value: string | null,
  encrypted: number | null,
  encryptionKey: string | undefined,
): Promise<{ ok: boolean; value: string | null }> {
  if (!value) return { ok: false, value: null };
  if (encrypted !== 1) return { ok: true, value };
  try {
    return { ok: true, value: await decrypt(value, encryptionKey) };
  } catch {
    return { ok: false, value: null };
  }
}

function optionalRepoPart(env: Env, key: keyof Env, fallback: string): string {
  const value = typeof env[key] === "string" ? env[key].trim() : "";
  const normalized = value || fallback;
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new QaSeedError(`${String(key)} is invalid`);
  }
  return normalized;
}

async function ensureQaBusiness(db: D1Database): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO businesses (id, name, shared_sessions, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         shared_sessions = 1,
         updated_at = excluded.updated_at`,
    )
    .bind(QA_BUSINESS_ID, QA_BUSINESS_NAME, now, now)
    .run();
}

async function ensureQaOwner(env: Env): Promise<number> {
  const githubId = requiredPositiveInteger(env, "QA_OWNER_GITHUB_ID");
  const login = requiredString(env, "QA_OWNER_LOGIN");
  const email = requiredString(env, "QA_OWNER_EMAIL");
  const existing = await env.DB.prepare("SELECT id, business_id FROM users WHERE github_id = ? LIMIT 1")
    .bind(githubId)
    .first<{ id: number; business_id: string }>();

  if (existing && existing.business_id !== QA_BUSINESS_ID) {
    throw new QaSeedError(`QA owner github_id is already attached to business ${existing.business_id}`, 409);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET
       login = excluded.login,
       name = excluded.name,
       email = excluded.email,
       business_id = excluded.business_id,
       updated_at = excluded.updated_at`,
  )
    .bind(githubId, login, login, email, QA_BUSINESS_ID, now, now)
    .run();

  const user = await env.DB.prepare("SELECT id FROM users WHERE github_id = ? LIMIT 1")
    .bind(githubId)
    .first<{ id: number }>();
  if (!user) {
    throw new QaSeedError("Failed to resolve QA owner after upsert", 500);
  }

  await env.DB.prepare(
    `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, 'admin', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       business_id = excluded.business_id,
       role = 'admin',
       updated_at = excluded.updated_at`,
  )
    .bind(QA_BUSINESS_ID, user.id, now, now)
    .run();

  return user.id;
}

async function ensureGithubInstallation(env: Env): Promise<number> {
  const installationId = requiredPositiveInteger(env, "QA_INSTALLATION_ID");
  await upsertInstallation(env.DB, {
    installationId,
    ownerLogin: optionalRepoPart(env, "QA_FIXTURE_REPO_OWNER", DEFAULT_QA_REPO_OWNER),
    ownerId: requiredPositiveInteger(env, "QA_OWNER_GITHUB_ID"),
    ownerType: "Organization",
    repositorySelection: "selected",
    permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    events: ["pull_request"],
  });
  return installationId;
}

async function ensureValidatedOpenAiCredential(env: Env): Promise<void> {
  await setBusinessIntegrationScope(env.DB, QA_BUSINESS_ID, "openai", "business");
  await connectBusinessCredentials(
    env.DB,
    QA_BUSINESS_ID,
    "openai",
    { apiKey: requiredString(env, "ARCANIST_OPENAI_API_KEY") },
    env.TOKEN_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `UPDATE business_integration_credentials
     SET last_validated_at = ?, last_validation_status = ?, last_validation_reason_code = NULL, updated_at = ?
     WHERE business_id = ? AND integration_id = 'openai'`,
  )
    .bind(Date.now(), CREDENTIAL_VALIDATION_STATUS.VALIDATED, Date.now(), QA_BUSINESS_ID)
    .run();
}

async function ensureOptionalCloudflareFixture(env: Env): Promise<QaFixtureSeedResult> {
  const requiredKeys = [
    "QA_CLOUDFLARE_D1_API_TOKEN",
    "QA_CLOUDFLARE_D1_ACCOUNT_ID",
    "QA_CLOUDFLARE_D1_DATABASE_ID",
  ] as const;
  const missing = missingEnvKeys(env, requiredKeys);
  if (missing.length === requiredKeys.length) {
    return { integrationId: "cloudflare", status: "missing", reason: "QA Cloudflare D1 fixture env is not set" };
  }
  if (missing.length > 0) {
    return {
      integrationId: "cloudflare",
      status: "invalid_config",
      reason: `QA Cloudflare D1 fixture env is incomplete: ${missing.join(", ")}`,
    };
  }

  const accountId = requiredString(env, "QA_CLOUDFLARE_D1_ACCOUNT_ID");
  const databaseId = requiredString(env, "QA_CLOUDFLARE_D1_DATABASE_ID");
  if (!isValidCloudflareAccountId(accountId)) {
    return { integrationId: "cloudflare", status: "invalid_config", reason: "QA_CLOUDFLARE_D1_ACCOUNT_ID is invalid" };
  }
  if (!isValidCloudflareD1DatabaseId(databaseId)) {
    return {
      integrationId: "cloudflare",
      status: "invalid_config",
      reason: "QA_CLOUDFLARE_D1_DATABASE_ID is invalid",
    };
  }

  await setBusinessIntegrationScope(env.DB, QA_BUSINESS_ID, "cloudflare", "business");
  await connectBusinessCredentials(
    env.DB,
    QA_BUSINESS_ID,
    "cloudflare",
    {
      apiKey: requiredString(env, "QA_CLOUDFLARE_D1_API_TOKEN"),
      applicationKey: accountId,
      serviceUrl: databaseId,
    },
    env.TOKEN_ENCRYPTION_KEY,
  );
  return { integrationId: "cloudflare", status: "configured", reason: "QA Cloudflare D1 fixture seeded" };
}

async function ensureOptionalDatadogFixture(env: Env): Promise<QaFixtureSeedResult> {
  const apiKey = optionalStringAny(env, "QA_DATADOG_API_KEY", "DD_API_KEY");
  const appKey = optionalStringAny(env, "QA_DATADOG_APP_KEY", "DD_APP_KEY");
  const site = normalizeDatadogSite(optionalString(env, "QA_DATADOG_SITE") ?? "us5.datadoghq.com");
  const missing = [
    !apiKey ? "QA_DATADOG_API_KEY" : null,
    !appKey ? "QA_DATADOG_APP_KEY" : null,
    !site ? "QA_DATADOG_SITE" : null,
  ].filter((key): key is string => Boolean(key));
  if (!apiKey && !appKey && !optionalString(env, "QA_DATADOG_SITE")) {
    return { integrationId: "datadog", status: "missing", reason: "QA Datadog fixture env is not set" };
  }
  if (missing.length > 0) {
    return {
      integrationId: "datadog",
      status: "invalid_config",
      reason: `QA Datadog fixture env is incomplete: ${missing.join(", ")}`,
    };
  }
  if (!apiKey || !appKey || !site) {
    return { integrationId: "datadog", status: "invalid_config", reason: "QA Datadog fixture env is incomplete" };
  }

  if (!isSupportedDatadogSite(site)) {
    return { integrationId: "datadog", status: "invalid_config", reason: "QA_DATADOG_SITE is invalid" };
  }

  await setBusinessIntegrationScope(env.DB, QA_BUSINESS_ID, "datadog", "business");
  await connectBusinessCredentials(
    env.DB,
    QA_BUSINESS_ID,
    "datadog",
    {
      apiKey,
      applicationKey: appKey,
      serviceUrl: site,
    },
    env.TOKEN_ENCRYPTION_KEY,
  );
  return { integrationId: "datadog", status: "configured", reason: "QA Datadog fixture seeded" };
}

async function ensureOptionalBraintrustFixture(env: Env): Promise<QaFixtureSeedResult> {
  const apiKey = optionalStringAny(env, "QA_BRAINTRUST_API_KEY", "BRAINTRUST_API_KEY");
  if (!apiKey) {
    return { integrationId: "braintrust", status: "missing", reason: "QA Braintrust fixture env is not set" };
  }

  const rawApiUrl = optionalString(env, "QA_BRAINTRUST_API_URL");
  const apiUrl = rawApiUrl ? normalizeBraintrustApiUrl(rawApiUrl) : BRAINTRUST_DEFAULT_API_URL;
  if (!apiUrl) {
    return { integrationId: "braintrust", status: "invalid_config", reason: "QA_BRAINTRUST_API_URL is invalid" };
  }

  await setBusinessIntegrationScope(env.DB, QA_BUSINESS_ID, "braintrust", "business");
  await connectBusinessCredentials(
    env.DB,
    QA_BUSINESS_ID,
    "braintrust",
    {
      apiKey,
      serviceUrl: apiUrl,
    },
    env.TOKEN_ENCRYPTION_KEY,
  );
  return { integrationId: "braintrust", status: "configured", reason: "QA Braintrust fixture seeded" };
}

async function ensureOptionalBusinessManagedFixtures(env: Env): Promise<QaFixtureSeedResult[]> {
  return Promise.all([
    ensureOptionalCloudflareFixture(env),
    ensureOptionalDatadogFixture(env),
    ensureOptionalBraintrustFixture(env),
  ]);
}

async function ensureRepoLoginEnv(env: Env, ownerUserId: number): Promise<string[]> {
  const repoOwner = optionalRepoPart(env, "QA_FIXTURE_REPO_OWNER", DEFAULT_QA_REPO_OWNER);
  const repoName = optionalRepoPart(env, "QA_FIXTURE_REPO_NAME", DEFAULT_QA_REPO_NAME);
  const seededKeys: string[] = [];

  for (const key of REPO_LOGIN_ENV_KEYS) {
    const value = requiredString(env, key);
    await upsertRepoLoginEnvVariable(env.DB, {
      businessId: QA_BUSINESS_ID,
      actorUserId: ownerUserId,
      repoOwner,
      repoName,
      key,
      value,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    });
    seededKeys.push(key);
  }

  return seededKeys;
}

export async function seedQaEnvironment(env: Env): Promise<{
  ok: true;
  businessId: string;
  ownerUserId: number;
  installationId: number;
  repo: string;
  providerCredentials: string[];
  businessManagedFixtures: QaFixtureSeedResult[];
  repoLoginEnvKeys: string[];
}> {
  requireQaEnv(env);
  await ensureQaBusiness(env.DB);
  const ownerUserId = await ensureQaOwner(env);
  const installationId = await ensureGithubInstallation(env);
  await ensureValidatedOpenAiCredential(env);
  const businessManagedFixtures = await ensureOptionalBusinessManagedFixtures(env);
  const repoLoginEnvKeys = await ensureRepoLoginEnv(env, ownerUserId);
  const repoOwner = optionalRepoPart(env, "QA_FIXTURE_REPO_OWNER", DEFAULT_QA_REPO_OWNER);
  const repoName = optionalRepoPart(env, "QA_FIXTURE_REPO_NAME", DEFAULT_QA_REPO_NAME);

  return {
    ok: true,
    businessId: QA_BUSINESS_ID,
    ownerUserId,
    installationId,
    repo: `${repoOwner}/${repoName}`,
    providerCredentials: ["openai"],
    businessManagedFixtures,
    repoLoginEnvKeys,
  };
}

async function getBusinessIntegrationScope(env: Env, integrationId: BusinessManagedQaFixtureId) {
  const row = await env.DB.prepare(
    "SELECT scope FROM business_integrations WHERE business_id = ? AND integration_id = ? LIMIT 1",
  )
    .bind(QA_BUSINESS_ID, integrationId)
    .first<{ scope: "business" | "user" | "disabled" }>();
  return row?.scope ?? "missing";
}

async function getBusinessCredentialRow(
  env: Env,
  integrationId: BusinessManagedQaFixtureId,
): Promise<{
  api_key: string | null;
  oauth_access_token: string | null;
  service_url: string | null;
  encrypted: number | null;
} | null> {
  return env.DB.prepare(
    `SELECT api_key, oauth_access_token, service_url, encrypted
     FROM business_integration_credentials
     WHERE business_id = ? AND integration_id = ? LIMIT 1`,
  )
    .bind(QA_BUSINESS_ID, integrationId)
    .first<{
      api_key: string | null;
      oauth_access_token: string | null;
      service_url: string | null;
      encrypted: number | null;
    }>();
}

function buildEnvStatus(env: Env, required: readonly (keyof Env)[]) {
  const missing = missingEnvKeys(env, required);
  return {
    required: required.map(String),
    present: required.map(String).filter((key) => !missing.includes(key)),
    missing,
  };
}

async function cloudflareHealth(env: Env): Promise<QaFixtureHealthRow> {
  const required = [
    "QA_CLOUDFLARE_D1_API_TOKEN",
    "QA_CLOUDFLARE_D1_ACCOUNT_ID",
    "QA_CLOUDFLARE_D1_DATABASE_ID",
  ] as const;
  const envStatus = buildEnvStatus(env, required);
  const row = await getBusinessCredentialRow(env, "cloudflare");
  const scope = await getBusinessIntegrationScope(env, "cloudflare");
  const apiToken = row
    ? await inspectStoredValue(row.api_key, row.encrypted, env.TOKEN_ENCRYPTION_KEY)
    : { ok: false, value: null };
  const accountId = row
    ? await inspectStoredValue(row.oauth_access_token, row.encrypted, env.TOKEN_ENCRYPTION_KEY)
    : { ok: false, value: null };
  const hasValidRow =
    apiToken.ok &&
    !!apiToken.value &&
    accountId.ok &&
    !!accountId.value &&
    isValidCloudflareAccountId(accountId.value) &&
    isValidCloudflareD1DatabaseId(row?.service_url);
  const hasValidEnv =
    envStatus.missing.length === 0 &&
    isValidCloudflareAccountId(optionalString(env, "QA_CLOUDFLARE_D1_ACCOUNT_ID")) &&
    isValidCloudflareD1DatabaseId(optionalString(env, "QA_CLOUDFLARE_D1_DATABASE_ID"));
  const envMissingAll = envStatus.missing.length === required.length;
  const envInvalid =
    (!envMissingAll && envStatus.missing.length > 0) || (envStatus.missing.length === 0 && !hasValidEnv);

  const status: QaFixtureStatus =
    envInvalid || (row && (!hasValidRow || scope !== "business"))
      ? "invalid_config"
      : envMissingAll || !row
        ? "missing"
        : "configured";
  return {
    integrationId: "cloudflare",
    status,
    reason:
      status === "configured"
        ? "QA Cloudflare D1 fixture env and credential row are configured"
        : status === "missing"
          ? "QA Cloudflare D1 fixture env or credential row is missing"
          : "QA Cloudflare D1 fixture env or credential row is invalid",
    env: envStatus,
    credentialRow: row ? "present" : "missing",
    scope,
  };
}

async function datadogHealth(env: Env): Promise<QaFixtureHealthRow> {
  const required = [
    { name: "QA_DATADOG_API_KEY", keys: ["QA_DATADOG_API_KEY", "DD_API_KEY"] as const },
    { name: "QA_DATADOG_APP_KEY", keys: ["QA_DATADOG_APP_KEY", "DD_APP_KEY"] as const },
    { name: "QA_DATADOG_SITE", keys: ["QA_DATADOG_SITE"] as const },
  ] as const;
  const envStatus = buildResolvedEnvStatus(env, required);
  if (!optionalString(env, "QA_DATADOG_SITE")) {
    envStatus.sources.QA_DATADOG_SITE = "default:us5.datadoghq.com";
  }
  const row = await getBusinessCredentialRow(env, "datadog");
  const scope = await getBusinessIntegrationScope(env, "datadog");
  const site = normalizeDatadogSite(row?.service_url);
  const apiKey = row
    ? await inspectStoredValue(row.api_key, row.encrypted, env.TOKEN_ENCRYPTION_KEY)
    : { ok: false, value: null };
  const appKey = row
    ? await inspectStoredValue(row.oauth_access_token, row.encrypted, env.TOKEN_ENCRYPTION_KEY)
    : { ok: false, value: null };
  const hasValidRow = apiKey.ok && !!apiKey.value && appKey.ok && !!appKey.value && isSupportedDatadogSite(site);
  const envSite = normalizeDatadogSite(optionalString(env, "QA_DATADOG_SITE") ?? "us5.datadoghq.com");
  const hasValidEnv =
    !envStatus.missing.includes("QA_DATADOG_API_KEY") &&
    !envStatus.missing.includes("QA_DATADOG_APP_KEY") &&
    isSupportedDatadogSite(envSite);
  const envMissingAll =
    !optionalStringAny(env, "QA_DATADOG_API_KEY", "DD_API_KEY") &&
    !optionalStringAny(env, "QA_DATADOG_APP_KEY", "DD_APP_KEY") &&
    !optionalString(env, "QA_DATADOG_SITE");
  const envInvalid =
    (!envMissingAll &&
      (envStatus.missing.includes("QA_DATADOG_API_KEY") || envStatus.missing.includes("QA_DATADOG_APP_KEY"))) ||
    (!envStatus.missing.includes("QA_DATADOG_API_KEY") &&
      !envStatus.missing.includes("QA_DATADOG_APP_KEY") &&
      !hasValidEnv);

  const status: QaFixtureStatus =
    envInvalid || (row && (!hasValidRow || scope !== "business"))
      ? "invalid_config"
      : envMissingAll || !row
        ? "missing"
        : "configured";
  return {
    integrationId: "datadog",
    status,
    reason:
      status === "configured"
        ? "QA Datadog fixture env and credential row are configured"
        : status === "missing"
          ? "QA Datadog fixture env or credential row is missing"
          : "QA Datadog fixture env or credential row is invalid",
    env: envStatus,
    credentialRow: row ? "present" : "missing",
    scope,
  };
}

async function braintrustHealth(env: Env): Promise<QaFixtureHealthRow> {
  const required = [{ name: "QA_BRAINTRUST_API_KEY", keys: ["QA_BRAINTRUST_API_KEY", "BRAINTRUST_API_KEY"] as const }];
  const envStatus = buildResolvedEnvStatus(env, required);
  const row = await getBusinessCredentialRow(env, "braintrust");
  const scope = await getBusinessIntegrationScope(env, "braintrust");
  const rawEnvApiUrl = optionalString(env, "QA_BRAINTRUST_API_URL");
  const envApiUrl = rawEnvApiUrl ? normalizeBraintrustApiUrl(rawEnvApiUrl) : BRAINTRUST_DEFAULT_API_URL;
  const rowApiUrl = normalizeBraintrustApiUrl(row?.service_url) ?? BRAINTRUST_DEFAULT_API_URL;
  const apiKey = row
    ? await inspectStoredValue(row.api_key, row.encrypted, env.TOKEN_ENCRYPTION_KEY)
    : { ok: false, value: null };
  const hasValidRow = apiKey.ok && !!apiKey.value && !!rowApiUrl;
  const hasValidEnv = envStatus.missing.length === 0 && !!envApiUrl;
  const envMissingAll = !optionalStringAny(env, "QA_BRAINTRUST_API_KEY", "BRAINTRUST_API_KEY") && !rawEnvApiUrl;
  const envInvalid = rawEnvApiUrl !== null && !envApiUrl;

  const status: QaFixtureStatus =
    envInvalid || (row && (!hasValidRow || scope !== "business"))
      ? "invalid_config"
      : envMissingAll || !row || !hasValidEnv
        ? "missing"
        : "configured";
  return {
    integrationId: "braintrust",
    status,
    reason:
      status === "configured"
        ? "QA Braintrust fixture env and credential row are configured"
        : status === "missing"
          ? "QA Braintrust fixture env or credential row is missing"
          : "QA Braintrust fixture env or credential row is invalid",
    env: envStatus,
    credentialRow: row ? "present" : "missing",
    scope,
  };
}

export async function getQaIntegrationHealth(env: Env): Promise<{
  ok: true;
  workerEnv: string | null;
  businessId: string;
  fixtures: QaFixtureHealthRow[];
}> {
  const fixtures = await Promise.all([cloudflareHealth(env), datadogHealth(env), braintrustHealth(env)]);
  return {
    ok: true,
    workerEnv: env.WORKER_ENV ?? null,
    businessId: QA_BUSINESS_ID,
    fixtures,
  };
}

export async function handleQaIntegrationHealth(_request: Request, env: Env): Promise<Response> {
  return jsonResponse(await getQaIntegrationHealth(env));
}

export async function handleSeedQaEnvironment(_request: Request, env: Env): Promise<Response> {
  try {
    return jsonResponse(await seedQaEnvironment(env));
  } catch (error) {
    if (error instanceof QaSeedError) {
      return jsonErrorResponse(error.message, error.status);
    }
    throw error;
  }
}
