import {
  type BusinessWideIntegrationId,
  type IntegrationId,
  type IntegrationScope,
  type ToggleableIntegrationId,
  USER_API_KEY_PROVIDER_IDS,
  type UserApiKeyProviderId,
} from "../../../../shared/constants/integration-helpers.js";
import {
  CREDENTIAL_VALIDATION_STATUS,
  type CredentialValidationStatus,
  ONBOARDING_REASON_CODES,
  type OnboardingReasonCode,
  type ProviderApiKeyState,
} from "../../../../shared/constants/onboarding.js";
import { d1Changed } from "../db/errors";
import { getEncryptedRow, upsertRow } from "../db-helpers";
import { createLogger } from "../logger";
import { decrypt, encrypt } from "../settings/encryption";

const log = createLogger({ bindings: { component: "integration-db" } });
const USER_API_KEY_PROVIDER_SQL_LIST = USER_API_KEY_PROVIDER_IDS.map((provider) => `'${provider}'`).join(", ");
const NOTION_DEFAULT_EXPIRES_IN_SECONDS = 3600;
export const CODEX_SUBSCRIPTION_INTEGRATION_ID = "codex_subscription" as const;

// ---------------------------------------------------------------------------
// Shared credential data shape used by both user and business upserts
// ---------------------------------------------------------------------------

interface CredentialData {
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
  apiKey?: string;
  externalUserId?: string;
  serviceUrl?: string;
  encrypted?: boolean;
  lastValidatedAt?: number | null;
  lastValidationStatus?: CredentialValidationStatus | null;
  lastValidationReasonCode?: OnboardingReasonCode | null;
}

type StoredIntegrationId = IntegrationId | "slack";
type OAuthTokenIntegrationId = "github" | "linear" | "jira" | "notion";

interface OAuthTokenBaseRow {
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  encrypted: number | null;
}

interface LinearOAuthTokenRow extends OAuthTokenBaseRow {
  api_key: string | null;
  external_user_id: string | null;
  service_url: string | null;
  last_validated_at: number | null;
  last_validation_status: CredentialValidationStatus | null;
  last_validation_reason_code: OnboardingReasonCode | null;
}

type OAuthTokenRow = OAuthTokenBaseRow | LinearOAuthTokenRow;

export interface DecryptedTokenRow {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenCiphertext: string | null;
}

const OAUTH_TOKEN_SELECTS = {
  github: "oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted",
  linear:
    "oauth_access_token, oauth_refresh_token, oauth_expires_at, api_key, external_user_id, service_url, encrypted, last_validated_at, last_validation_status, last_validation_reason_code",
  jira: "oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted",
  notion: "oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted",
} satisfies Record<OAuthTokenIntegrationId, string>;

function isInvalidCredential(row: { last_validation_status: CredentialValidationStatus | null } | null): boolean {
  return row?.last_validation_status === CREDENTIAL_VALIDATION_STATUS.INVALID;
}

function hasLinearTokenMetadata(row: OAuthTokenRow): row is LinearOAuthTokenRow {
  return "api_key" in row;
}

function buildReadRepairCredentialData(
  integrationId: OAuthTokenIntegrationId,
  row: OAuthTokenRow,
  encryptedAccess: string,
  encryptedRefresh: string | null,
): CredentialData {
  const data: CredentialData = {
    oauthAccessToken: encryptedAccess,
    oauthRefreshToken: encryptedRefresh ?? undefined,
    oauthExpiresAt: row.oauth_expires_at ?? undefined,
    encrypted: true,
  };

  if (integrationId === "linear" && hasLinearTokenMetadata(row)) {
    return {
      ...data,
      apiKey: row.api_key ?? undefined,
      externalUserId: row.external_user_id ?? undefined,
      serviceUrl: row.service_url ?? undefined,
      lastValidatedAt: row.last_validated_at,
      lastValidationStatus: row.last_validation_status,
      lastValidationReasonCode: row.last_validation_reason_code,
    };
  }

  return data;
}

export async function readOAuthTokenRow(
  db: D1Database,
  opts: {
    integrationId: OAuthTokenIntegrationId;
    userId: string;
    encryptionKey: string | undefined;
    readRepair?: boolean;
  },
): Promise<DecryptedTokenRow | null> {
  const { integrationId, userId, encryptionKey, readRepair = false } = opts;
  const row = await db
    .prepare(
      `SELECT ${OAUTH_TOKEN_SELECTS[integrationId]} FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1`,
    )
    .bind(Number(userId), integrationId)
    .first<OAuthTokenRow>();
  if (!row?.oauth_access_token) return null;

  // Fail closed when an encrypted row is read without a key: decrypt() would
  // otherwise pass the enc:... payload through unchanged, and downstream
  // callers would treat that ciphertext as a bearer token.
  if (row.encrypted === 1 && !encryptionKey) {
    log.warn(
      { userId, action: `${integrationId}.token.decrypt_failed`, reason: "encryption_key_missing" },
      `Cannot decrypt ${integrationId} token: TOKEN_ENCRYPTION_KEY missing`,
    );
    return null;
  }

  let accessToken: string;
  let refreshToken: string | null;
  try {
    accessToken = row.encrypted === 1 ? await decrypt(row.oauth_access_token, encryptionKey) : row.oauth_access_token;
    refreshToken = row.oauth_refresh_token
      ? row.encrypted === 1
        ? await decrypt(row.oauth_refresh_token, encryptionKey)
        : row.oauth_refresh_token
      : null;
  } catch (err) {
    log.warn(
      { userId, action: `${integrationId}.token.decrypt_failed`, reason: "decrypt_threw", error: String(err) },
      `Failed to decrypt ${integrationId} token`,
    );
    return null;
  }

  let storedRefreshCiphertext = row.oauth_refresh_token;

  if (readRepair && row.encrypted !== 1 && encryptionKey) {
    try {
      const encryptedAccess = await encrypt(accessToken, encryptionKey);
      const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
      await connectIntegration(
        db,
        Number(userId),
        integrationId,
        buildReadRepairCredentialData(integrationId, row, encryptedAccess, encryptedRefresh),
      );
      storedRefreshCiphertext = encryptedRefresh;
      log.info(
        { userId, action: `${integrationId}.token.read_repaired` },
        `Encrypted legacy plaintext ${integrationId} row`,
      );
    } catch (err) {
      log.warn(
        { userId, action: `${integrationId}.token.read_repair_failed`, error: String(err) },
        "Read-repair write-back failed (non-fatal)",
      );
    }
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: row.oauth_expires_at ?? null,
    refreshTokenCiphertext: storedRefreshCiphertext,
  };
}

function buildConnectIntegrationSql(conflictTarget: string, valueSql: string): string {
  return `INSERT INTO user_integrations (
    user_id,
    integration_id,
    oauth_access_token,
    oauth_refresh_token,
    oauth_expires_at,
    api_key,
    external_user_id,
    service_url,
    encrypted,
    last_validated_at,
    last_validation_status,
    last_validation_reason_code,
    connected_at,
    updated_at
  )
  ${valueSql}
  ON CONFLICT(${conflictTarget}) DO UPDATE SET
    oauth_access_token = excluded.oauth_access_token,
    oauth_refresh_token = excluded.oauth_refresh_token,
    oauth_expires_at = excluded.oauth_expires_at,
    api_key = excluded.api_key,
    external_user_id = COALESCE(excluded.external_user_id, user_integrations.external_user_id),
    service_url = excluded.service_url,
    encrypted = excluded.encrypted,
    last_validated_at = excluded.last_validated_at,
    last_validation_status = excluded.last_validation_status,
    last_validation_reason_code = excluded.last_validation_reason_code,
    updated_at = excluded.updated_at`;
}

function integrationStatementValues(integrationId: StoredIntegrationId, data: CredentialData, now: number): unknown[] {
  return [
    integrationId,
    data.oauthAccessToken ?? null,
    data.oauthRefreshToken ?? null,
    data.oauthExpiresAt ?? null,
    data.apiKey ?? null,
    data.externalUserId ?? null,
    data.serviceUrl ?? null,
    data.encrypted ? 1 : 0,
    data.lastValidatedAt ?? null,
    data.lastValidationStatus ?? null,
    data.lastValidationReasonCode ?? null,
    now,
    now,
  ];
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

export function buildConnectIntegrationStatement(
  db: D1Database,
  userId: number,
  integrationId: StoredIntegrationId,
  data: CredentialData,
  now = Date.now(),
): D1PreparedStatement {
  const sql = buildConnectIntegrationSql(
    "user_id, integration_id",
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return db.prepare(sql).bind(userId, ...integrationStatementValues(integrationId, data, now));
}

export function buildConnectIntegrationStatementForGithubUser(
  db: D1Database,
  githubUserId: number,
  integrationId: StoredIntegrationId,
  data: CredentialData,
  now = Date.now(),
): D1PreparedStatement {
  const sql = buildConnectIntegrationSql(
    "user_id, integration_id",
    `SELECT
      users.id,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
     FROM users
     WHERE users.github_id = ?`,
  );

  return db.prepare(sql).bind(...integrationStatementValues(integrationId, data, now), githubUserId);
}

export async function connectIntegration(
  db: D1Database,
  userId: number,
  integrationId: StoredIntegrationId,
  data: CredentialData,
): Promise<void> {
  await buildConnectIntegrationStatement(db, userId, integrationId, data).run();
}

export async function disconnectIntegration(
  db: D1Database,
  userId: number,
  integrationId: StoredIntegrationId,
): Promise<void> {
  await db
    .prepare("DELETE FROM user_integrations WHERE user_id = ? AND integration_id = ?")
    .bind(userId, integrationId)
    .run();
}

// ---------------------------------------------------------------------------
// Jira site selection (one selected site per user; reconnect switches it)
// ---------------------------------------------------------------------------

export interface JiraUserSite {
  userId: number;
  jiraCloudId: string;
  siteUrl: string;
  siteName: string | null;
  jiraAccountId: string;
}

interface JiraUserSiteRow {
  user_id: number;
  jira_cloud_id: string;
  site_url: string;
  site_name: string | null;
  jira_account_id: string;
}

export async function upsertJiraUserSite(
  db: D1Database,
  params: {
    userId: number;
    jiraCloudId: string;
    siteUrl: string;
    siteName?: string | null;
    jiraAccountId: string;
  },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO jira_user_sites (user_id, jira_cloud_id, site_url, site_name, jira_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         jira_cloud_id = excluded.jira_cloud_id,
         site_url = excluded.site_url,
         site_name = excluded.site_name,
         jira_account_id = excluded.jira_account_id,
         updated_at = excluded.updated_at`,
    )
    .bind(params.userId, params.jiraCloudId, params.siteUrl, params.siteName ?? null, params.jiraAccountId, now, now)
    .run();
}

export async function getJiraUserSite(db: D1Database, userId: number): Promise<JiraUserSite | null> {
  const row = await db
    .prepare(
      `SELECT user_id, jira_cloud_id, site_url, site_name, jira_account_id
       FROM jira_user_sites WHERE user_id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<JiraUserSiteRow>();

  if (!row) return null;
  return {
    userId: Number(row.user_id),
    jiraCloudId: row.jira_cloud_id,
    siteUrl: row.site_url,
    siteName: row.site_name ?? null,
    jiraAccountId: row.jira_account_id,
  };
}

export async function deleteJiraUserSite(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM jira_user_sites WHERE user_id = ?").bind(userId).run();
}

// ---------------------------------------------------------------------------
// Jira personal-data reporting
// ---------------------------------------------------------------------------

export interface JiraPersonalDataReportAccount {
  jiraAccountId: string;
  personalDataUpdatedAt: number;
}

interface JiraPersonalDataReportAccountRow {
  jira_account_id: string;
  personal_data_updated_at: number;
}

interface JiraPersonalDataReportAccountIdRow {
  jira_account_id: string;
}

export async function upsertJiraPersonalDataReportAccount(
  db: D1Database,
  params: { jiraAccountId: string; personalDataUpdatedAt: number; now?: number },
): Promise<void> {
  const jiraAccountId = params.jiraAccountId.trim();
  if (!jiraAccountId || jiraAccountId === "unknown") return;

  const now = params.now ?? Date.now();
  await db
    .prepare(
      `INSERT INTO jira_personal_data_reports (
         jira_account_id, personal_data_updated_at, next_report_after, created_at, updated_at
       )
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(jira_account_id) DO UPDATE SET
         personal_data_updated_at = excluded.personal_data_updated_at,
         next_report_after = CASE
           WHEN jira_personal_data_reports.last_reported_at IS NULL THEN 0
           ELSE jira_personal_data_reports.next_report_after
         END,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(jiraAccountId, params.personalDataUpdatedAt, now, now)
    .run();
}

export async function listJiraPersonalDataReportAccountIdsForUser(db: D1Database, userId: number): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT external_user_id AS jira_account_id
       FROM user_integrations
       WHERE user_id = ?
         AND integration_id = 'jira'
         AND external_user_id IS NOT NULL
         AND external_user_id != ''
         AND external_user_id != 'unknown'
       UNION
       SELECT jira_account_id
       FROM jira_user_sites
       WHERE user_id = ?
         AND jira_account_id IS NOT NULL
         AND jira_account_id != ''
         AND jira_account_id != 'unknown'`,
    )
    .bind(userId, userId)
    .all<JiraPersonalDataReportAccountIdRow>();

  return result.results.map((row) => row.jira_account_id);
}

export async function listDueJiraPersonalDataReportAccounts(
  db: D1Database,
  params: { now: number; limit: number },
): Promise<JiraPersonalDataReportAccount[]> {
  const result = await db
    .prepare(
      `SELECT jira_account_id, personal_data_updated_at
       FROM jira_personal_data_reports
       WHERE next_report_after <= ?
         AND jira_account_id != ''
         AND jira_account_id != 'unknown'
       ORDER BY next_report_after ASC, updated_at ASC
       LIMIT ?`,
    )
    .bind(params.now, params.limit)
    .all<JiraPersonalDataReportAccountRow>();

  return result.results.map((row) => ({
    jiraAccountId: row.jira_account_id,
    personalDataUpdatedAt: Number(row.personal_data_updated_at),
  }));
}

export async function markJiraPersonalDataReportAccountsReported(
  db: D1Database,
  jiraAccountIds: string[],
  params: { reportedAt: number; nextReportAfter: number; status: string },
): Promise<void> {
  if (jiraAccountIds.length === 0) return;
  await db.batch(
    jiraAccountIds.map((jiraAccountId) =>
      db
        .prepare(
          `UPDATE jira_personal_data_reports
           SET last_reported_at = ?, next_report_after = ?, last_status = ?, last_error = NULL, updated_at = ?
           WHERE jira_account_id = ?`,
        )
        .bind(params.reportedAt, params.nextReportAfter, params.status, params.reportedAt, jiraAccountId),
    ),
  );
}

export async function markJiraPersonalDataReportAccountsFailed(
  db: D1Database,
  jiraAccountIds: string[],
  params: { error: string; now: number; nextReportAfter: number },
): Promise<void> {
  if (jiraAccountIds.length === 0) return;
  await db.batch(
    jiraAccountIds.map((jiraAccountId) =>
      db
        .prepare(
          `UPDATE jira_personal_data_reports
           SET next_report_after = ?, last_status = 'failed', last_error = ?, updated_at = ?
           WHERE jira_account_id = ?`,
        )
        .bind(params.nextReportAfter, params.error.slice(0, 128), params.now, jiraAccountId),
    ),
  );
}

export async function markJiraPersonalDataReportAccountsUpdated(
  db: D1Database,
  jiraAccountIds: string[],
  params: { personalDataUpdatedAt: number; reportedAt: number; nextReportAfter: number },
): Promise<void> {
  if (jiraAccountIds.length === 0) return;
  await db.batch(
    jiraAccountIds.map((jiraAccountId) =>
      db
        .prepare(
          `UPDATE jira_personal_data_reports
           SET personal_data_updated_at = ?, last_reported_at = ?, next_report_after = ?,
               last_status = 'updated', last_error = NULL, updated_at = ?
           WHERE jira_account_id = ?`,
        )
        .bind(
          params.personalDataUpdatedAt,
          params.reportedAt,
          params.nextReportAfter,
          params.reportedAt,
          jiraAccountId,
        ),
    ),
  );
}

const JIRA_USER_DATA_DELETE_CHUNK_SIZE = 100;

export async function deleteJiraUserDataByAccountIds(db: D1Database, jiraAccountIds: string[]): Promise<void> {
  const normalizedAccountIds = [
    ...new Set(jiraAccountIds.map((jiraAccountId) => jiraAccountId.trim()).filter((id) => id && id !== "unknown")),
  ];
  if (normalizedAccountIds.length === 0) return;

  for (let index = 0; index < normalizedAccountIds.length; index += JIRA_USER_DATA_DELETE_CHUNK_SIZE) {
    const chunk = normalizedAccountIds.slice(index, index + JIRA_USER_DATA_DELETE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    await db.batch([
      db.prepare(`DELETE FROM jira_user_sites WHERE jira_account_id IN (${placeholders})`).bind(...chunk),
      db
        .prepare(
          `DELETE FROM user_integrations WHERE integration_id = 'jira' AND external_user_id IN (${placeholders})`,
        )
        .bind(...chunk),
      db.prepare(`DELETE FROM jira_personal_data_reports WHERE jira_account_id IN (${placeholders})`).bind(...chunk),
    ]);
  }
}

export async function deleteUnreferencedJiraPersonalDataReportAccounts(
  db: D1Database,
  jiraAccountIds: string[],
): Promise<void> {
  const normalizedAccountIds = [
    ...new Set(jiraAccountIds.map((jiraAccountId) => jiraAccountId.trim()).filter((id) => id && id !== "unknown")),
  ];
  if (normalizedAccountIds.length === 0) return;

  await db.batch(
    normalizedAccountIds.map((jiraAccountId) =>
      db
        .prepare(
          `DELETE FROM jira_personal_data_reports
           WHERE jira_account_id = ?
             AND NOT EXISTS (
               SELECT 1
               FROM user_integrations
               WHERE integration_id = 'jira'
                 AND external_user_id = ?
               UNION ALL
               SELECT 1
               FROM jira_user_sites
               WHERE jira_account_id = ?
             )`,
        )
        .bind(jiraAccountId, jiraAccountId, jiraAccountId),
    ),
  );
}

export async function deleteJiraPersonalDataReportAccountsForUser(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM jira_personal_data_reports
       WHERE jira_account_id IN (
         SELECT external_user_id
         FROM user_integrations
         WHERE user_id = ?
           AND integration_id = 'jira'
           AND external_user_id IS NOT NULL
         UNION
         SELECT jira_account_id
         FROM jira_user_sites
         WHERE user_id = ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM user_integrations
         WHERE integration_id = 'jira'
           AND external_user_id = jira_personal_data_reports.jira_account_id
           AND user_id != ?
         UNION ALL
         SELECT 1
         FROM jira_user_sites
         WHERE jira_account_id = jira_personal_data_reports.jira_account_id
           AND user_id != ?
       )`,
    )
    .bind(userId, userId, userId, userId)
    .run();
}

export async function getJiraPersonalDataReportingTokenUserId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT user_id
       FROM user_integrations
       WHERE integration_id = 'jira'
         AND oauth_access_token IS NOT NULL
         AND (last_validation_status IS NULL OR last_validation_status != ?)
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(CREDENTIAL_VALIDATION_STATUS.INVALID)
    .first<{ user_id: number }>();
  return row ? Number(row.user_id) : null;
}

// ---------------------------------------------------------------------------
// Reverse lookup (external ID -> user)
// ---------------------------------------------------------------------------

export async function getUserByExternalId(
  db: D1Database,
  integrationId: StoredIntegrationId,
  externalUserId: string,
): Promise<{ id: number; login: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.login FROM user_integrations ui
       INNER JOIN users u ON u.id = ui.user_id
       WHERE ui.integration_id = ? AND ui.external_user_id = ? LIMIT 1`,
    )
    .bind(integrationId, externalUserId)
    .first<{ id: number; login: string | null }>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// GitHub token
// ---------------------------------------------------------------------------

export interface GithubTokenRow {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export async function getGithubTokens(
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
): Promise<GithubTokenRow | null> {
  const row = await readOAuthTokenRow(db, { integrationId: "github", userId, encryptionKey });
  if (!row) return null;
  return { accessToken: row.accessToken, refreshToken: row.refreshToken, expiresAt: row.expiresAt };
}

export async function buildGithubCredentialData(
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,
  encryptionKey: string | undefined,
): Promise<CredentialData> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store GitHub tokens");
  }
  const [encryptedAccess, encryptedRefresh] = await Promise.all([
    encrypt(accessToken, encryptionKey),
    refreshToken ? encrypt(refreshToken, encryptionKey) : Promise.resolve(undefined),
  ]);
  return {
    oauthAccessToken: encryptedAccess,
    oauthRefreshToken: encryptedRefresh,
    oauthExpiresAt: expiresAt ?? undefined,
    encrypted: true,
  };
}

export async function storeGithubTokens(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,
  encryptionKey: string | undefined,
): Promise<void> {
  const data = await buildGithubCredentialData(accessToken, refreshToken, expiresAt, encryptionKey);
  await connectIntegration(db, userId, "github", data);
}

// ---------------------------------------------------------------------------
// Linear tokens
// ---------------------------------------------------------------------------

export async function getLinearTokens(
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenCiphertext: string | null;
} | null> {
  return readOAuthTokenRow(db, { integrationId: "linear", userId, encryptionKey, readRepair: true });
}

export async function storeLinearTokens(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number,
  encryptionKey: string | undefined,
  externalUserId?: string,
): Promise<void> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Linear tokens");
  }
  const encryptedAccess = await encrypt(accessToken, encryptionKey);
  const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
  const expiresAt = Date.now() + expiresIn * 1000;
  await connectIntegration(db, userId, "linear", {
    oauthAccessToken: encryptedAccess,
    oauthRefreshToken: encryptedRefresh ?? undefined,
    oauthExpiresAt: expiresAt,
    externalUserId,
    encrypted: true,
  });
}

/**
 * CAS persist for a rotating Linear refresh token: writes the rotated pair only
 * while the stored refresh-token ciphertext still equals the one this refresh
 * used. Returns false when a concurrent refresh already rotated the row, so the
 * caller must re-read and use the newer stored tokens instead of clobbering
 * them. Leaves external_user_id untouched (a refresh does not change identity).
 */
export async function storeLinearTokensIfRefreshMatches(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number,
  encryptionKey: string | undefined,
  expectedRefreshCiphertext: string,
): Promise<boolean> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Linear tokens");
  }
  const encryptedAccess = await encrypt(accessToken, encryptionKey);
  const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE user_integrations
       SET oauth_access_token = ?, oauth_refresh_token = ?, oauth_expires_at = ?, encrypted = 1, updated_at = ?
       WHERE user_id = ? AND integration_id = 'linear' AND oauth_refresh_token = ?`,
    )
    .bind(encryptedAccess, encryptedRefresh, now + expiresIn * 1000, now, userId, expectedRefreshCiphertext)
    .run();
  return d1Changed(result);
}

// ---------------------------------------------------------------------------
// Jira tokens
// ---------------------------------------------------------------------------

export interface JiraTokenRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  /**
   * The stored (encrypted) refresh-token ciphertext. Used as the CAS guard
   * when persisting a rotation: encryption is non-deterministic, so the
   * compare must run against the exact stored value, not a re-encryption.
   */
  refreshTokenCiphertext: string | null;
}

export async function getJiraTokens(
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
): Promise<JiraTokenRecord | null> {
  return readOAuthTokenRow(db, { integrationId: "jira", userId, encryptionKey });
}

export async function storeJiraTokens(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number,
  encryptionKey: string | undefined,
  externalUserId?: string,
): Promise<void> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Jira tokens");
  }
  const encryptedAccess = await encrypt(accessToken, encryptionKey);
  const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
  const expiresAt = Date.now() + expiresIn * 1000;
  await connectIntegration(db, userId, "jira", {
    oauthAccessToken: encryptedAccess,
    oauthRefreshToken: encryptedRefresh ?? undefined,
    oauthExpiresAt: expiresAt,
    externalUserId,
    encrypted: true,
  });
}

/**
 * CAS persist for rotating refresh tokens: writes the rotated pair only while
 * the stored refresh-token ciphertext still equals the one this refresh used.
 * Returns false when a concurrent refresh already rotated the row, in which
 * case the caller must re-read and use the newer stored tokens instead of
 * clobbering them (Atlassian invalidates the family on stale-token reuse).
 */
export async function storeJiraTokensIfRefreshMatches(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number,
  encryptionKey: string | undefined,
  expectedRefreshCiphertext: string,
): Promise<boolean> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Jira tokens");
  }
  const encryptedAccess = await encrypt(accessToken, encryptionKey);
  const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE user_integrations
       SET oauth_access_token = ?, oauth_refresh_token = ?, oauth_expires_at = ?, encrypted = 1, updated_at = ?
       WHERE user_id = ? AND integration_id = 'jira' AND oauth_refresh_token = ?`,
    )
    .bind(encryptedAccess, encryptedRefresh, now + expiresIn * 1000, now, userId, expectedRefreshCiphertext)
    .run();
  return d1Changed(result);
}

export async function markJiraCredentialInvalid(
  db: D1Database,
  userId: number,
  reasonCode: OnboardingReasonCode,
): Promise<void> {
  await db
    .prepare(
      `UPDATE user_integrations
       SET last_validated_at = ?, last_validation_status = ?, last_validation_reason_code = ?, updated_at = ?
       WHERE user_id = ? AND integration_id = 'jira'`,
    )
    .bind(Date.now(), CREDENTIAL_VALIDATION_STATUS.INVALID, reasonCode, Date.now(), userId)
    .run();
}

// ---------------------------------------------------------------------------
// Jira pending OAuth (multi-site picker holding area; single-use rows)
// ---------------------------------------------------------------------------

export interface JiraOAuthPendingRecord {
  nonce: string;
  userId: number;
  flow: "user" | "business";
  tokenPayload: string;
  sitesJson: string;
  jiraAccountId: string | null;
  expiresAt: number;
}

export async function insertJiraOAuthPending(
  db: D1Database,
  params: {
    nonce: string;
    userId: number;
    flow: "user" | "business";
    tokenPayload: string;
    sitesJson: string;
    jiraAccountId: string | null;
    ttlMs: number;
  },
): Promise<void> {
  const now = Date.now();
  // Opportunistic cleanup keeps the table from accumulating abandoned rows.
  await db.prepare("DELETE FROM jira_oauth_pending WHERE expires_at <= ?").bind(now).run();
  await db
    .prepare(
      `INSERT INTO jira_oauth_pending (nonce, user_id, flow, token_payload, sites_json, jira_account_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.nonce,
      params.userId,
      params.flow,
      params.tokenPayload,
      params.sitesJson,
      params.jiraAccountId,
      now,
      now + params.ttlMs,
    )
    .run();
}

export async function getJiraOAuthPending(db: D1Database, nonce: string): Promise<JiraOAuthPendingRecord | null> {
  if (!nonce) return null;
  const row = await db
    .prepare(
      `SELECT nonce, user_id, flow, token_payload, sites_json, jira_account_id, expires_at
       FROM jira_oauth_pending WHERE nonce = ? LIMIT 1`,
    )
    .bind(nonce)
    .first<{
      nonce: string;
      user_id: number;
      flow: "user" | "business";
      token_payload: string;
      sites_json: string;
      jira_account_id: string | null;
      expires_at: number;
    }>();
  if (!row) return null;
  return {
    nonce: row.nonce,
    userId: Number(row.user_id),
    flow: row.flow,
    tokenPayload: row.token_payload,
    sitesJson: row.sites_json,
    jiraAccountId: row.jira_account_id ?? null,
    expiresAt: Number(row.expires_at),
  };
}

/**
 * Single-use claim: the DELETE is the atomic gate against concurrent
 * finalizes. The expires_at guard makes the claim self-enforcing even when an
 * expired row has not been garbage-collected yet.
 */
export async function consumeJiraOAuthPending(db: D1Database, nonce: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM jira_oauth_pending WHERE nonce = ? AND expires_at > ?")
    .bind(nonce, Date.now())
    .run();
  return d1Changed(result);
}

export async function getNotionTokens(
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenCiphertext: string | null;
} | null> {
  return readOAuthTokenRow(db, { integrationId: "notion", userId, encryptionKey, readRepair: true });
}

export async function storeNotionTokens(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number | null,
  encryptionKey: string | undefined,
  externalUserId?: string,
): Promise<void> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Notion tokens");
  }
  const encryptedAccess = await encrypt(accessToken, encryptionKey);
  const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
  const effectiveExpiresIn = expiresIn ?? (refreshToken ? NOTION_DEFAULT_EXPIRES_IN_SECONDS : null);
  const expiresAt = effectiveExpiresIn === null ? null : Date.now() + effectiveExpiresIn * 1000;
  await connectIntegration(db, userId, "notion", {
    oauthAccessToken: encryptedAccess,
    oauthRefreshToken: encryptedRefresh ?? undefined,
    oauthExpiresAt: expiresAt ?? undefined,
    externalUserId,
    encrypted: true,
  });
}

/**
 * CAS persist for a rotating Notion refresh token: writes the rotated pair only
 * while the stored refresh-token ciphertext still equals the one this refresh
 * used. Returns false when a concurrent refresh already rotated the row, so the
 * caller must re-read and use the newer stored tokens instead of clobbering
 * them. Leaves external_user_id untouched (a refresh does not change identity).
 */
export async function storeNotionTokensIfRefreshMatches(
  db: D1Database,
  userId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number | null,
  encryptionKey: string | undefined,
  expectedRefreshCiphertext: string,
): Promise<boolean> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Notion tokens");
  }
  const encryptedAccess = await encrypt(accessToken, encryptionKey);
  const encryptedRefresh = refreshToken ? await encrypt(refreshToken, encryptionKey) : null;
  const effectiveExpiresIn = expiresIn ?? (refreshToken ? NOTION_DEFAULT_EXPIRES_IN_SECONDS : null);
  const now = Date.now();
  const expiresAt = effectiveExpiresIn === null ? null : now + effectiveExpiresIn * 1000;
  const result = await db
    .prepare(
      `UPDATE user_integrations
       SET oauth_access_token = ?, oauth_refresh_token = ?, oauth_expires_at = ?, encrypted = 1, updated_at = ?
       WHERE user_id = ? AND integration_id = 'notion' AND oauth_refresh_token = ?`,
    )
    .bind(encryptedAccess, encryptedRefresh, expiresAt, now, userId, expectedRefreshCiphertext)
    .run();
  return d1Changed(result);
}

// ---------------------------------------------------------------------------
// BYOK API keys
// ---------------------------------------------------------------------------

export type KeyProvider = UserApiKeyProviderId;

export interface ProviderKeyStateRow {
  integration_id: KeyProvider;
  last_validated_at: number | null;
  last_validation_status: CredentialValidationStatus | null;
  last_validation_reason_code: OnboardingReasonCode | null;
}

function emptyProviderApiKeyState(): ProviderApiKeyState {
  return {
    isSet: false,
    lastValidatedAt: null,
    lastValidationStatus: null,
    lastValidationReasonCode: null,
  };
}

export function mapProviderKeyStateRows(rows: Iterable<ProviderKeyStateRow>): Record<KeyProvider, ProviderApiKeyState> {
  const states = Object.fromEntries(
    USER_API_KEY_PROVIDER_IDS.map((provider) => [provider, emptyProviderApiKeyState()]),
  ) as Record<KeyProvider, ProviderApiKeyState>;

  for (const row of rows) {
    states[row.integration_id] = {
      isSet: true,
      lastValidatedAt: row.last_validated_at ?? null,
      lastValidationStatus: row.last_validation_status ?? null,
      lastValidationReasonCode: row.last_validation_reason_code ?? null,
    };
  }

  return states;
}

export const PROVIDER_ENV_VAR: Record<KeyProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  baseten: "BASETEN_API_KEY",
};

export async function getProviderKeyStates(
  db: D1Database,
  userId: number,
): Promise<Record<KeyProvider, ProviderApiKeyState>> {
  const rows = await db
    .prepare(
      `SELECT integration_id, last_validated_at, last_validation_status, last_validation_reason_code
       FROM user_integrations
       WHERE user_id = ? AND integration_id IN (${USER_API_KEY_PROVIDER_SQL_LIST})`,
    )
    .bind(userId)
    .all<ProviderKeyStateRow>();
  return mapProviderKeyStateRows(rows.results ?? []);
}

export async function getProviderKeyStatus(db: D1Database, userId: number): Promise<Record<string, boolean>> {
  const states = await getProviderKeyStates(db, userId);
  return Object.fromEntries(USER_API_KEY_PROVIDER_IDS.map((provider) => [provider, states[provider].isSet]));
}

export async function setProviderApiKey(
  db: D1Database,
  userId: number,
  provider: KeyProvider,
  apiKey: string,
  encryptionKey: string | undefined,
  validationState: {
    lastValidatedAt: number;
    lastValidationStatus: CredentialValidationStatus;
    lastValidationReasonCode: OnboardingReasonCode | null;
  } = {
    lastValidatedAt: Date.now(),
    lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
    lastValidationReasonCode: null,
  },
): Promise<void> {
  const encrypted = await encrypt(apiKey, encryptionKey);
  await connectIntegration(db, userId, provider, {
    apiKey: encrypted,
    encrypted: true,
    lastValidatedAt: validationState.lastValidatedAt,
    lastValidationStatus: validationState.lastValidationStatus,
    lastValidationReasonCode: validationState.lastValidationReasonCode,
  });
}

export async function clearProviderApiKey(db: D1Database, userId: number, provider: KeyProvider): Promise<void> {
  await disconnectIntegration(db, userId, provider);
}

export async function getUserApiKey(
  db: D1Database,
  userId: string,
  provider: string,
  encryptionKey: string | undefined,
): Promise<{ envVar: string; apiKey: string } | null> {
  if (!USER_API_KEY_PROVIDER_IDS.includes(provider as KeyProvider)) return null;

  const key = provider as KeyProvider;
  const envVar = PROVIDER_ENV_VAR[key];
  if (!envVar) return null;

  const row = await getEncryptedRow<{ api_key: string; last_validation_status: CredentialValidationStatus | null }>(
    db,
    {
      sql: "SELECT api_key, last_validation_status FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1",
      binds: [Number(userId), provider],
      encryptedFields: ["api_key"],
      encryptionKey,
      context: `user:${provider}`,
    },
  );
  if (!row || isInvalidCredential(row)) return null;

  return { envVar, apiKey: row.api_key };
}

export type CodexSubscriptionCredentialState = {
  isSet: boolean;
  lastValidatedAt: number | null;
  lastValidationStatus: CredentialValidationStatus | null;
  lastValidationReasonCode: OnboardingReasonCode | null;
};

export function codexSubscriptionAuthJsonExternalUserId(userId: number): string {
  return `auth_json:${userId}`;
}

export async function setCodexSubscriptionAuthJson(
  db: D1Database,
  userId: number,
  authJson: string,
  encryptionKey: string | undefined,
): Promise<CodexSubscriptionCredentialState> {
  const now = Date.now();
  const encrypted = await encrypt(authJson, encryptionKey);
  await connectIntegration(db, userId, CODEX_SUBSCRIPTION_INTEGRATION_ID, {
    apiKey: encrypted,
    externalUserId: codexSubscriptionAuthJsonExternalUserId(userId),
    encrypted: true,
    lastValidatedAt: now,
    lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED,
    lastValidationReasonCode: ONBOARDING_REASON_CODES.NETWORK_VALIDATION_SKIPPED,
  });
  return {
    isSet: true,
    lastValidatedAt: now,
    lastValidationStatus: CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED,
    lastValidationReasonCode: ONBOARDING_REASON_CODES.NETWORK_VALIDATION_SKIPPED,
  };
}

export async function clearCodexSubscriptionAuthJson(
  db: D1Database,
  userId: number,
): Promise<CodexSubscriptionCredentialState> {
  await disconnectIntegration(db, userId, CODEX_SUBSCRIPTION_INTEGRATION_ID);
  return {
    isSet: false,
    lastValidatedAt: null,
    lastValidationStatus: null,
    lastValidationReasonCode: null,
  };
}

export async function getCodexSubscriptionAuthJsonState(
  db: D1Database,
  userId: number,
): Promise<CodexSubscriptionCredentialState | null> {
  const row = await db
    .prepare(
      "SELECT api_key, external_user_id, encrypted, last_validated_at, last_validation_status, last_validation_reason_code FROM user_integrations WHERE user_id = ? AND integration_id = ? LIMIT 1",
    )
    .bind(userId, CODEX_SUBSCRIPTION_INTEGRATION_ID)
    .first<{
      api_key: string | null;
      external_user_id: string | null;
      encrypted: number | null;
      last_validated_at: number | null;
      last_validation_status: CredentialValidationStatus | null;
      last_validation_reason_code: OnboardingReasonCode | null;
    }>();
  if (
    !row ||
    !row.api_key ||
    row.encrypted !== 1 ||
    row.external_user_id !== codexSubscriptionAuthJsonExternalUserId(userId) ||
    isInvalidCredential(row)
  ) {
    return null;
  }
  return {
    isSet: true,
    lastValidatedAt: row.last_validated_at ?? null,
    lastValidationStatus: row.last_validation_status ?? null,
    lastValidationReasonCode: row.last_validation_reason_code ?? null,
  };
}

// ---------------------------------------------------------------------------
// Business-wide credentials (CRUD for business_integration_credentials)
// ---------------------------------------------------------------------------

export async function insertBusinessCredential(
  db: D1Database,
  businessId: string,
  integrationId: BusinessWideIntegrationId,
  data: CredentialData,
): Promise<void> {
  const now = Date.now();
  // service_url is provider-specific metadata: Datadog stores site, and
  // Sentry OAuth stores the best-effort organization slug. Neon stores the
  // workspace-selected project/parent-branch JSON payload.
  await upsertRow(db, {
    table: "business_integration_credentials",
    columns: [
      "business_id",
      "integration_id",
      "oauth_access_token",
      "oauth_refresh_token",
      "oauth_expires_at",
      "api_key",
      "service_url",
      "encrypted",
      "last_validated_at",
      "last_validation_status",
      "last_validation_reason_code",
      "connected_at",
      "updated_at",
    ],
    values: [
      businessId,
      integrationId,
      data.oauthAccessToken ?? null,
      data.oauthRefreshToken ?? null,
      data.oauthExpiresAt ?? null,
      data.apiKey ?? null,
      data.serviceUrl ?? null,
      data.encrypted ? 1 : 0,
      data.lastValidatedAt ?? null,
      data.lastValidationStatus ?? null,
      data.lastValidationReasonCode ?? null,
      now,
      now,
    ],
    conflictKeys: ["business_id", "integration_id"],
    excludeFromUpdate: ["connected_at"],
  });
}

export function buildDeleteBusinessCredentialStatement(
  db: D1Database,
  businessId: string,
  integrationId: BusinessWideIntegrationId,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM business_integration_credentials WHERE business_id = ? AND integration_id = ?")
    .bind(businessId, integrationId);
}

export type BusinessCredentialColumn = "api_key" | "oauth_access_token" | "service_url" | "encrypted";
const BUSINESS_CREDENTIAL_COLUMNS: readonly BusinessCredentialColumn[] = [
  "api_key",
  "oauth_access_token",
  "service_url",
  "encrypted",
];
export type BusinessCredentialRow<Column extends BusinessCredentialColumn> = Pick<
  {
    api_key: string | null;
    oauth_access_token: string | null;
    service_url: string | null;
    encrypted: number | null;
  },
  Column
>;

export async function readBusinessCredentialRow<Column extends BusinessCredentialColumn>(
  db: D1Database,
  businessId: string,
  integrationId: BusinessWideIntegrationId,
  columns: readonly Column[],
): Promise<BusinessCredentialRow<Column> | null> {
  // The Column type constrains callers at compile time, but interpolating column
  // names into SQL warrants a runtime allowlist so a cast or JS-only caller can't
  // inject arbitrary SQL.
  for (const column of columns) {
    if (!BUSINESS_CREDENTIAL_COLUMNS.includes(column)) {
      throw new Error(`readBusinessCredentialRow: unknown column ${JSON.stringify(column)}`);
    }
  }
  return db
    .prepare(
      `SELECT ${columns.join(", ")}
       FROM business_integration_credentials
       WHERE business_id = ? AND integration_id = ? LIMIT 1`,
    )
    .bind(businessId, integrationId)
    .first<BusinessCredentialRow<Column>>();
}

// Raw statement builder for batched writes; service callers own scope validation.
export function buildUpsertBusinessIntegrationScopeStatement(
  db: D1Database,
  businessId: string,
  integrationId: ToggleableIntegrationId,
  scope: IntegrationScope,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO business_integrations (business_id, integration_id, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (business_id, integration_id) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at`,
    )
    .bind(businessId, integrationId, scope, now, now);
}

export async function getBusinessApiKey(
  db: D1Database,
  businessId: string,
  provider: KeyProvider,
  encryptionKey: string | undefined,
): Promise<{ envVar: string; apiKey: string } | null> {
  const envVar = PROVIDER_ENV_VAR[provider];
  if (!envVar) return null;

  const row = await getEncryptedRow<{ api_key: string; last_validation_status: CredentialValidationStatus | null }>(
    db,
    {
      sql: "SELECT api_key, last_validation_status FROM business_integration_credentials WHERE business_id = ? AND integration_id = ? LIMIT 1",
      binds: [businessId, provider],
      encryptedFields: ["api_key"],
      encryptionKey,
      context: `business:${provider}`,
    },
  );
  if (!row || isInvalidCredential(row)) return null;

  return { envVar, apiKey: row.api_key };
}

export async function getBusinessApiKeyForValidation(
  db: D1Database,
  businessId: string,
  provider: KeyProvider,
  encryptionKey: string | undefined,
): Promise<{ apiKey: string } | null> {
  const row = await getEncryptedRow<{ api_key: string }>(db, {
    sql: "SELECT api_key FROM business_integration_credentials WHERE business_id = ? AND integration_id = ? LIMIT 1",
    binds: [businessId, provider],
    encryptedFields: ["api_key"],
    encryptionKey,
    context: `business:${provider}:validation`,
  });
  return row?.api_key ? { apiKey: row.api_key } : null;
}

export async function updateBusinessCredentialValidation(
  db: D1Database,
  businessId: string,
  provider: KeyProvider,
  validation: {
    lastValidatedAt: number;
    lastValidationStatus: CredentialValidationStatus;
    lastValidationReasonCode: OnboardingReasonCode | null;
  },
): Promise<void> {
  await db
    .prepare(
      "UPDATE business_integration_credentials SET last_validated_at = ?, last_validation_status = ?, last_validation_reason_code = ?, updated_at = ? WHERE business_id = ? AND integration_id = ?",
    )
    .bind(
      validation.lastValidatedAt,
      validation.lastValidationStatus,
      validation.lastValidationReasonCode,
      Date.now(),
      businessId,
      provider,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Slack user token (OAuth v2)
// ---------------------------------------------------------------------------

/**
 * Retrieve Slack user OAuth tokens. Manual decryption (not getEncryptedRow)
 * because oauth_refresh_token is optional — getEncryptedRow returns null if
 * any encrypted field is null, which would break non-rotating installs.
 */
export async function getSlackUserTokens(
  db: D1Database,
  userId: string,
  encryptionKey: string | undefined,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number | null } | null> {
  const row = await db
    .prepare(
      "SELECT oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted FROM user_integrations WHERE user_id = ? AND integration_id = 'slack' LIMIT 1",
    )
    .bind(Number(userId))
    .first<{
      oauth_access_token: string | null;
      oauth_refresh_token: string | null;
      oauth_expires_at: number | null;
      encrypted: number;
    }>();
  if (!row?.oauth_access_token) return null;

  const accessToken = row.encrypted ? await decrypt(row.oauth_access_token, encryptionKey) : row.oauth_access_token;
  const refreshToken =
    row.oauth_refresh_token && row.encrypted
      ? await decrypt(row.oauth_refresh_token, encryptionKey)
      : row.oauth_refresh_token;

  return { accessToken, refreshToken, expiresAt: row.oauth_expires_at };
}
