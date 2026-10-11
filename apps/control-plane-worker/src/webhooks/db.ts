import type { UploadedImage } from "../../../../shared/types/sandbox.js";
import { D1_RETRY_SAFE_MARKER, d1Changed } from "../db/errors";
import { normalizeWebhookReference, nowIso } from "../utils";

export const SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR = "github_pr_url";
export const SESSION_WEBHOOK_REF_SOURCE_GITHUB_ISSUE = "github_issue";
export const SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT = "pagerduty_incident";
export const SESSION_WEBHOOK_REF_SOURCE_SLACK_THREAD = "slack_thread";

export function buildPagerDutyIncidentWebhookRef(businessId: string, incidentId: string): string {
  return `${businessId}:${incidentId}`;
}
export const WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LinearWebhookInstallation {
  businessId: string;
  linearOrganizationId: string;
  linearOrganizationName: string | null;
  linearOrganizationUrlKey: string | null;
  linearWebhookId: string | null;
  connectedByUserId: number;
  status: "active" | "revoked";
  connectedAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

interface LinearWebhookInstallationRow {
  business_id: string;
  linear_organization_id: string;
  linear_organization_name: string | null;
  linear_organization_url_key: string | null;
  linear_webhook_id: string | null;
  connected_by_user_id: number;
  status: "active" | "revoked";
  connected_at: number;
  updated_at: number;
  revoked_at: number | null;
}

function mapLinearWebhookInstallation(row: LinearWebhookInstallationRow): LinearWebhookInstallation {
  return {
    businessId: row.business_id,
    linearOrganizationId: row.linear_organization_id,
    linearOrganizationName: row.linear_organization_name ?? null,
    linearOrganizationUrlKey: row.linear_organization_url_key ?? null,
    linearWebhookId: row.linear_webhook_id,
    connectedByUserId: row.connected_by_user_id,
    status: row.status,
    connectedAt: Number(row.connected_at),
    updatedAt: Number(row.updated_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export async function upsertLinearWebhookInstallation(
  db: D1Database,
  params: {
    businessId: string;
    linearOrganizationId: string;
    linearOrganizationName?: string | null;
    linearOrganizationUrlKey?: string | null;
    linearWebhookId?: string | null;
    connectedByUserId: number;
  },
): Promise<void> {
  const linearOrganizationId = normalizeWebhookReference(params.linearOrganizationId);
  const linearWebhookId = normalizeWebhookReference(params.linearWebhookId) ?? null;
  const linearOrganizationName = normalizeWebhookReference(params.linearOrganizationName) ?? null;
  const linearOrganizationUrlKey = normalizeWebhookReference(params.linearOrganizationUrlKey) ?? null;
  if (!params.businessId || !linearOrganizationId || !params.connectedByUserId) return;

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO linear_webhook_installations (
         business_id, linear_organization_id, linear_organization_name, linear_organization_url_key,
         linear_webhook_id, connected_by_user_id,
         status, connected_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(business_id, linear_organization_id) DO UPDATE SET
         linear_organization_name = COALESCE(excluded.linear_organization_name, linear_webhook_installations.linear_organization_name),
         linear_organization_url_key = COALESCE(excluded.linear_organization_url_key, linear_webhook_installations.linear_organization_url_key),
         linear_webhook_id = excluded.linear_webhook_id,
         connected_by_user_id = excluded.connected_by_user_id,
         status = 'active',
         updated_at = excluded.updated_at,
         revoked_at = NULL`,
    )
    .bind(
      params.businessId,
      linearOrganizationId,
      linearOrganizationName,
      linearOrganizationUrlKey,
      linearWebhookId,
      params.connectedByUserId,
      now,
      now,
    )
    .run();
}

export async function getActiveLinearWebhookInstallationByOrganization(
  db: D1Database,
  linearOrganizationId: unknown,
): Promise<LinearWebhookInstallation | null> {
  const normalizedOrganizationId = normalizeWebhookReference(linearOrganizationId);
  if (!normalizedOrganizationId) return null;

  const row = await db
    .prepare(
      `SELECT business_id, linear_organization_id, linear_organization_name, linear_organization_url_key,
              linear_webhook_id, connected_by_user_id,
              status, connected_at, updated_at, revoked_at
       FROM linear_webhook_installations
       WHERE linear_organization_id = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(normalizedOrganizationId)
    .first<LinearWebhookInstallationRow>();

  return row ? mapLinearWebhookInstallation(row) : null;
}

export async function getLinearWebhookInstallationByBusiness(
  db: D1Database,
  businessId: string,
): Promise<LinearWebhookInstallation | null> {
  if (!businessId) return null;

  const row = await db
    .prepare(
      `SELECT business_id, linear_organization_id, linear_organization_name, linear_organization_url_key,
              linear_webhook_id, connected_by_user_id,
              status, connected_at, updated_at, revoked_at
       FROM linear_webhook_installations
       WHERE business_id = ?
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(businessId)
    .first<LinearWebhookInstallationRow>();

  return row ? mapLinearWebhookInstallation(row) : null;
}

export async function bindLinearWebhookInstallationWebhookId(
  db: D1Database,
  params: {
    businessId: string;
    linearOrganizationId: string;
    linearWebhookId: string;
  },
): Promise<void> {
  const linearOrganizationId = normalizeWebhookReference(params.linearOrganizationId);
  const linearWebhookId = normalizeWebhookReference(params.linearWebhookId);
  if (!params.businessId || !linearOrganizationId || !linearWebhookId) return;

  await db
    .prepare(
      `UPDATE linear_webhook_installations
       SET linear_webhook_id = ?, updated_at = ?
       WHERE business_id = ?
         AND linear_organization_id = ?
         AND status = 'active'
         AND linear_webhook_id IS NULL`,
    )
    .bind(linearWebhookId, Date.now(), params.businessId, linearOrganizationId)
    .run();
}

export async function revokeLinearWebhookInstallation(
  db: D1Database,
  linearOrganizationId: unknown,
  linearWebhookId?: unknown,
): Promise<void> {
  const normalizedOrganizationId = normalizeWebhookReference(linearOrganizationId);
  const normalizedWebhookId = normalizeWebhookReference(linearWebhookId);
  if (!normalizedOrganizationId) return;

  const now = Date.now();
  await db
    .prepare(
      `UPDATE linear_webhook_installations
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE linear_organization_id = ?
         AND status = 'active'
         AND (? IS NULL OR linear_webhook_id IS NULL OR linear_webhook_id = ?)`,
    )
    .bind(now, now, normalizedOrganizationId, normalizedWebhookId, normalizedWebhookId)
    .run();
}

export async function revokeLinearWebhookInstallationByBusiness(db: D1Database, businessId: string): Promise<boolean> {
  if (!businessId) return false;

  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE linear_webhook_installations
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE business_id = ?
         AND status = 'active'`,
    )
    .bind(now, now, businessId)
    .run();

  return d1Changed(result);
}

export interface JiraWebhookInstallation {
  businessId: string;
  jiraCloudId: string;
  siteUrl: string | null;
  siteName: string | null;
  webhooksJson: string | null;
  installationToken: string;
  triggerLabel: string | null;
  connectedByUserId: number;
  status: "active" | "degraded" | "revoked";
  webhookRegisteredAt: number | null;
  webhookExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

interface JiraWebhookInstallationRow {
  business_id: string;
  jira_cloud_id: string;
  site_url: string | null;
  site_name: string | null;
  webhooks_json: string | null;
  installation_token: string;
  trigger_label: string | null;
  connected_by_user_id: number;
  status: "active" | "degraded" | "revoked";
  webhook_registered_at: number | null;
  webhook_expires_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

const JIRA_INSTALLATION_COLUMNS = `business_id, jira_cloud_id, site_url, site_name, webhooks_json,
              installation_token, trigger_label, connected_by_user_id, status,
              webhook_registered_at, webhook_expires_at, created_at, updated_at, revoked_at`;

function mapJiraWebhookInstallation(row: JiraWebhookInstallationRow): JiraWebhookInstallation {
  return {
    businessId: row.business_id,
    jiraCloudId: row.jira_cloud_id,
    siteUrl: row.site_url ?? null,
    siteName: row.site_name ?? null,
    webhooksJson: row.webhooks_json ?? null,
    installationToken: row.installation_token,
    triggerLabel: row.trigger_label ?? null,
    connectedByUserId: row.connected_by_user_id,
    status: row.status,
    webhookRegisteredAt: row.webhook_registered_at === null ? null : Number(row.webhook_registered_at),
    webhookExpiresAt: row.webhook_expires_at === null ? null : Number(row.webhook_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export async function upsertJiraWebhookInstallation(
  db: D1Database,
  params: {
    businessId: string;
    jiraCloudId: string;
    siteUrl?: string | null;
    siteName?: string | null;
    installationToken: string;
    connectedByUserId: number;
  },
): Promise<void> {
  const jiraCloudId = normalizeWebhookReference(params.jiraCloudId);
  const installationToken = normalizeWebhookReference(params.installationToken);
  const siteUrl = normalizeWebhookReference(params.siteUrl) ?? null;
  const siteName = normalizeWebhookReference(params.siteName) ?? null;
  if (!params.businessId || !jiraCloudId || !installationToken || !params.connectedByUserId) return;

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO jira_webhook_installations (
         business_id, jira_cloud_id, site_url, site_name, installation_token,
         connected_by_user_id, status, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(business_id, jira_cloud_id) DO UPDATE SET
         site_url = COALESCE(excluded.site_url, jira_webhook_installations.site_url),
         site_name = COALESCE(excluded.site_name, jira_webhook_installations.site_name),
         installation_token = excluded.installation_token,
         connected_by_user_id = excluded.connected_by_user_id,
         status = 'active',
         updated_at = excluded.updated_at,
         revoked_at = NULL`,
    )
    .bind(params.businessId, jiraCloudId, siteUrl, siteName, installationToken, params.connectedByUserId, now, now)
    .run();
}

/** Webhook ingress lookup. Accepts active and degraded installations; revoked rows never match. */
export async function getJiraWebhookInstallationByToken(
  db: D1Database,
  installationToken: unknown,
): Promise<JiraWebhookInstallation | null> {
  const normalizedToken = normalizeWebhookReference(installationToken);
  if (!normalizedToken) return null;

  const row = await db
    .prepare(
      `SELECT ${JIRA_INSTALLATION_COLUMNS}
       FROM jira_webhook_installations
       WHERE installation_token = ? AND status != 'revoked'
       LIMIT 1`,
    )
    .bind(normalizedToken)
    .first<JiraWebhookInstallationRow>();

  return row ? mapJiraWebhookInstallation(row) : null;
}

export async function getJiraWebhookInstallationByBusiness(
  db: D1Database,
  businessId: string,
): Promise<JiraWebhookInstallation | null> {
  if (!businessId) return null;

  const row = await db
    .prepare(
      `SELECT ${JIRA_INSTALLATION_COLUMNS}
       FROM jira_webhook_installations
       WHERE business_id = ?
       ORDER BY CASE WHEN status != 'revoked' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(businessId)
    .first<JiraWebhookInstallationRow>();

  return row ? mapJiraWebhookInstallation(row) : null;
}

export async function getJiraWebhookInstallationByBusinessAndCloudId(
  db: D1Database,
  businessId: string,
  jiraCloudId: string,
): Promise<JiraWebhookInstallation | null> {
  if (!businessId || !jiraCloudId) return null;

  const row = await db
    .prepare(
      `SELECT ${JIRA_INSTALLATION_COLUMNS}
       FROM jira_webhook_installations
       WHERE business_id = ? AND jira_cloud_id = ?
       ORDER BY CASE WHEN status != 'revoked' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(businessId, jiraCloudId)
    .first<JiraWebhookInstallationRow>();

  return row ? mapJiraWebhookInstallation(row) : null;
}

export async function listNonRevokedJiraWebhookInstallations(db: D1Database): Promise<JiraWebhookInstallation[]> {
  const result = await db
    .prepare(
      `SELECT ${JIRA_INSTALLATION_COLUMNS}
       FROM jira_webhook_installations
       WHERE status != 'revoked'`,
    )
    .bind()
    .all<JiraWebhookInstallationRow>();

  return (result.results ?? []).map(mapJiraWebhookInstallation);
}

/** Persist a successful (re-)registration: webhook IDs, expiry, label, and reset status to active. */
export async function recordJiraWebhookRegistration(
  db: D1Database,
  params: {
    businessId: string;
    jiraCloudId: string;
    webhooksJson: string;
    triggerLabel: string;
    webhookExpiresAt: number | null;
  },
): Promise<void> {
  const jiraCloudId = normalizeWebhookReference(params.jiraCloudId);
  if (!params.businessId || !jiraCloudId) return;

  const now = Date.now();
  await db
    .prepare(
      `UPDATE jira_webhook_installations
       SET webhooks_json = ?, trigger_label = ?, webhook_registered_at = ?, webhook_expires_at = ?,
           status = 'active', updated_at = ?
       WHERE business_id = ? AND jira_cloud_id = ? AND status != 'revoked'`,
    )
    .bind(params.webhooksJson, params.triggerLabel, now, params.webhookExpiresAt, now, params.businessId, jiraCloudId)
    .run();
}

/**
 * Flip an active installation to degraded. Returns true only on the
 * `active -> degraded` transition (zero rows changed when already degraded or
 * revoked), so reactive callers can coalesce their metric to the first
 * detection without a separate read.
 */
export async function markJiraWebhookInstallationDegraded(
  db: D1Database,
  businessId: string,
  jiraCloudId: string,
): Promise<boolean> {
  const normalizedCloudId = normalizeWebhookReference(jiraCloudId);
  if (!businessId || !normalizedCloudId) return false;

  const result = await db
    .prepare(
      `UPDATE jira_webhook_installations
       SET status = 'degraded', updated_at = ?
       WHERE business_id = ? AND jira_cloud_id = ? AND status = 'active'`,
    )
    .bind(Date.now(), businessId, normalizedCloudId)
    .run();
  return d1Changed(result);
}

export async function updateJiraWebhookInstallationExpiry(
  db: D1Database,
  params: { businessId: string; jiraCloudId: string; webhookExpiresAt: number },
): Promise<void> {
  const normalizedCloudId = normalizeWebhookReference(params.jiraCloudId);
  if (!params.businessId || !normalizedCloudId) return;

  await db
    .prepare(
      `UPDATE jira_webhook_installations
       SET webhook_expires_at = ?, status = 'active', updated_at = ?
       WHERE business_id = ? AND jira_cloud_id = ? AND status != 'revoked'`,
    )
    .bind(params.webhookExpiresAt, Date.now(), params.businessId, normalizedCloudId)
    .run();
}

export async function revokeJiraWebhookInstallationByBusiness(db: D1Database, businessId: string): Promise<boolean> {
  if (!businessId) return false;

  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE jira_webhook_installations
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE business_id = ?
         AND status != 'revoked'`,
    )
    .bind(now, now, businessId)
    .run();

  return d1Changed(result);
}

export interface PagerDutyWebhookInstallation {
  businessId: string;
  installationToken: string;
  connectedByUserId: number;
  repoOwner: string;
  repoName: string;
  modelId: string | null;
  webhookSigningSecretEncrypted: string | null;
  status: "active" | "revoked";
  connectedAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

interface PagerDutyWebhookInstallationRow {
  business_id: string;
  installation_token: string;
  connected_by_user_id: number;
  repo_owner: string;
  repo_name: string;
  model_id: string | null;
  webhook_signing_secret_encrypted: string | null;
  status: "active" | "revoked";
  connected_at: number;
  updated_at: number;
  revoked_at: number | null;
}

const PAGERDUTY_INSTALLATION_COLUMNS = `business_id, installation_token, connected_by_user_id,
              repo_owner, repo_name, model_id, webhook_signing_secret_encrypted,
              status, connected_at, updated_at, revoked_at`;

function mapPagerDutyWebhookInstallation(row: PagerDutyWebhookInstallationRow): PagerDutyWebhookInstallation {
  return {
    businessId: row.business_id,
    installationToken: row.installation_token,
    connectedByUserId: row.connected_by_user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    modelId: row.model_id ?? null,
    webhookSigningSecretEncrypted: row.webhook_signing_secret_encrypted ?? null,
    status: row.status,
    connectedAt: Number(row.connected_at),
    updatedAt: Number(row.updated_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export async function upsertPagerDutyWebhookInstallation(
  db: D1Database,
  params: {
    businessId: string;
    installationToken: string;
    connectedByUserId: number;
    repoOwner: string;
    repoName: string;
    modelId?: string | null;
    webhookSigningSecretEncrypted?: string | null;
  },
): Promise<void> {
  const installationToken = normalizeWebhookReference(params.installationToken);
  const repoOwner = normalizeWebhookReference(params.repoOwner);
  const repoName = normalizeWebhookReference(params.repoName);
  const modelId = normalizeWebhookReference(params.modelId) ?? null;
  if (!params.businessId || !installationToken || !params.connectedByUserId || !repoOwner || !repoName) return;

  const now = Date.now();
  const webhookSigningSecretEncrypted = params.webhookSigningSecretEncrypted ?? null;
  await db
    .prepare(
      `INSERT INTO pagerduty_webhook_installations (
         business_id, installation_token, connected_by_user_id,
         repo_owner, repo_name, model_id, webhook_signing_secret_encrypted,
         status, connected_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(business_id) DO UPDATE SET
         installation_token = excluded.installation_token,
         connected_by_user_id = excluded.connected_by_user_id,
         repo_owner = excluded.repo_owner,
         repo_name = excluded.repo_name,
         model_id = excluded.model_id,
         webhook_signing_secret_encrypted = COALESCE(excluded.webhook_signing_secret_encrypted, pagerduty_webhook_installations.webhook_signing_secret_encrypted),
         status = 'active',
         updated_at = excluded.updated_at,
         revoked_at = NULL`,
    )
    .bind(
      params.businessId,
      installationToken,
      params.connectedByUserId,
      repoOwner,
      repoName,
      modelId,
      webhookSigningSecretEncrypted,
      now,
      now,
    )
    .run();
}

export async function getPagerDutyWebhookInstallationByToken(
  db: D1Database,
  installationToken: unknown,
): Promise<PagerDutyWebhookInstallation | null> {
  const normalizedToken = normalizeWebhookReference(installationToken);
  if (!normalizedToken) return null;

  const row = await db
    .prepare(
      `SELECT ${PAGERDUTY_INSTALLATION_COLUMNS}
       FROM pagerduty_webhook_installations
       WHERE installation_token = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(normalizedToken)
    .first<PagerDutyWebhookInstallationRow>();

  return row ? mapPagerDutyWebhookInstallation(row) : null;
}

export async function getPagerDutyWebhookInstallationByBusiness(
  db: D1Database,
  businessId: string,
): Promise<PagerDutyWebhookInstallation | null> {
  if (!businessId) return null;

  const row = await db
    .prepare(
      `SELECT ${PAGERDUTY_INSTALLATION_COLUMNS}
       FROM pagerduty_webhook_installations
       WHERE business_id = ?
       LIMIT 1`,
    )
    .bind(businessId)
    .first<PagerDutyWebhookInstallationRow>();

  return row ? mapPagerDutyWebhookInstallation(row) : null;
}

export async function revokePagerDutyWebhookInstallationByBusiness(
  db: D1Database,
  businessId: string,
): Promise<boolean> {
  if (!businessId) return false;

  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE pagerduty_webhook_installations
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE business_id = ?
         AND status = 'active'`,
    )
    .bind(now, now, businessId)
    .run();

  return d1Changed(result);
}

export async function claimJiraIssueSessionRef(
  db: D1Database,
  jiraIssueId: string,
  sessionId: string,
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(jiraIssueId);
  if (!normalizedIssueId || !sessionId) return false;

  const result = await db
    .prepare(
      `INSERT INTO jira_issue_session_refs (jira_issue_id, session_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(jira_issue_id) DO NOTHING`,
    )
    .bind(normalizedIssueId, sessionId, nowIso())
    .run();

  return d1Changed(result);
}

export async function deleteJiraIssueSessionRefIfSession(
  db: D1Database,
  jiraIssueId: string,
  sessionId: string,
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(jiraIssueId);
  if (!normalizedIssueId || !sessionId) return false;

  const result = await db
    .prepare(`DELETE FROM jira_issue_session_refs WHERE jira_issue_id = ? AND session_id = ?`)
    .bind(normalizedIssueId, sessionId)
    .run();

  return d1Changed(result);
}

export interface JiraIssueSessionRef {
  sessionId: string;
  updatedAt: string | null;
}

export async function getJiraIssueSessionRef(db: D1Database, jiraIssueId: string): Promise<JiraIssueSessionRef | null> {
  const normalizedIssueId = normalizeWebhookReference(jiraIssueId);
  if (!normalizedIssueId) return null;

  const row = await db
    .prepare(`SELECT session_id, updated_at FROM jira_issue_session_refs WHERE jira_issue_id = ? LIMIT 1`)
    .bind(normalizedIssueId)
    .first<{ session_id: string; updated_at: string | null }>();

  if (!row?.session_id) return null;
  return { sessionId: String(row.session_id), updatedAt: row.updated_at ? String(row.updated_at) : null };
}

export async function getSessionIdByJiraIssueRef(db: D1Database, jiraIssueId: string): Promise<string | null> {
  const normalizedIssueId = normalizeWebhookReference(jiraIssueId);
  if (!normalizedIssueId) return null;

  const row = await db
    .prepare(`SELECT session_id FROM jira_issue_session_refs WHERE jira_issue_id = ? LIMIT 1`)
    .bind(normalizedIssueId)
    .first<{ session_id: string }>();

  return row?.session_id ? String(row.session_id) : null;
}

export async function upsertSessionWebhookRef(
  db: D1Database,
  source: string,
  externalRef: unknown,
  sessionId: string,
): Promise<void> {
  const normalizedRef = normalizeWebhookReference(externalRef);
  if (!normalizedRef) return;

  await db
    .prepare(
      `INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, external_ref, session_id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(source, normalizedRef, sessionId, nowIso())
    .run();
}

export async function claimSessionWebhookRef(
  db: D1Database,
  source: string,
  externalRef: unknown,
  sessionId: string,
): Promise<boolean> {
  const normalizedRef = normalizeWebhookReference(externalRef);
  if (!normalizedRef || !sessionId) return false;

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO session_webhook_refs (source, external_ref, session_id, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(source, normalizedRef, sessionId, nowIso())
    .run();

  return d1Changed(result);
}

/**
 * Thrown when a session creation is attempted for a Slack thread that is already
 * owned by a different session. Carries the owning session id so callers can route
 * the triggering message to the existing session as a follow-up instead of spawning
 * a second session on the same thread.
 */
export class SlackThreadAlreadyClaimedError extends Error {
  readonly existingSessionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  constructor(existingSessionId: string, channelId: string, threadTs: string) {
    super(`Slack thread ${channelId}/${threadTs} is already claimed by session ${existingSessionId}`);
    this.name = "SlackThreadAlreadyClaimedError";
    this.existingSessionId = existingSessionId;
    this.channelId = channelId;
    this.threadTs = threadTs;
  }
}

export async function claimSlackThreadSessionRef(
  db: D1Database,
  businessId: string,
  teamId: string,
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<boolean> {
  const normalizedBusinessId = normalizeWebhookReference(businessId);
  const normalizedTeamId = normalizeWebhookReference(teamId);
  const normalizedChannelId = normalizeWebhookReference(channelId);
  const normalizedThreadTs = normalizeWebhookReference(threadTs);
  if (!normalizedBusinessId || !normalizedTeamId || !normalizedChannelId || !normalizedThreadTs || !sessionId) {
    return false;
  }

  const result = await db
    .prepare(
      `INSERT INTO slack_thread_session_refs (business_id, team_id, channel_id, thread_ts, session_id, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, team_id, channel_id, thread_ts) DO NOTHING`,
    )
    .bind(normalizedBusinessId, normalizedTeamId, normalizedChannelId, normalizedThreadTs, sessionId, Date.now())
    .run();

  return d1Changed(result);
}

export async function deleteSlackThreadSessionRefIfSession(
  db: D1Database,
  businessId: string,
  teamId: string,
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<boolean> {
  const normalizedBusinessId = normalizeWebhookReference(businessId);
  const normalizedTeamId = normalizeWebhookReference(teamId);
  const normalizedChannelId = normalizeWebhookReference(channelId);
  const normalizedThreadTs = normalizeWebhookReference(threadTs);
  if (!normalizedBusinessId || !normalizedTeamId || !normalizedChannelId || !normalizedThreadTs || !sessionId) {
    return false;
  }

  const result = await db
    .prepare(
      `DELETE FROM slack_thread_session_refs
       WHERE business_id = ? AND team_id = ? AND channel_id = ? AND thread_ts = ? AND session_id = ?`,
    )
    .bind(normalizedBusinessId, normalizedTeamId, normalizedChannelId, normalizedThreadTs, sessionId)
    .run();

  return d1Changed(result);
}

export async function getSessionIdBySlackThreadRef(
  db: D1Database,
  businessId: string,
  teamId: string,
  channelId: string,
  threadTs: string,
): Promise<string | null> {
  const normalizedBusinessId = normalizeWebhookReference(businessId);
  const normalizedTeamId = normalizeWebhookReference(teamId);
  const normalizedChannelId = normalizeWebhookReference(channelId);
  const normalizedThreadTs = normalizeWebhookReference(threadTs);
  if (!normalizedBusinessId || !normalizedTeamId || !normalizedChannelId || !normalizedThreadTs) return null;

  const row = await db
    .prepare(
      `SELECT session_id FROM slack_thread_session_refs
       WHERE business_id = ? AND team_id IN (?, '') AND channel_id = ? AND thread_ts = ?
       ORDER BY CASE WHEN team_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(normalizedBusinessId, normalizedTeamId, normalizedChannelId, normalizedThreadTs, normalizedTeamId)
    .first<{ session_id: string }>();

  return row?.session_id ? String(row.session_id) : null;
}

export interface SlackRepoDisambiguationCandidate {
  repoOwner: string;
  repoName: string;
}

export interface SlackRepoDisambiguationRecord {
  id: string;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  actorUserId: string;
  actorSlackUserId: string | null;
  promptText: string;
  attachmentFileIds: string[];
  attachmentOmittedCount: number;
  candidates: SlackRepoDisambiguationCandidate[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

interface SlackRepoDisambiguationRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string | null;
  actor_user_id: string;
  actor_slack_user_id: string | null;
  prompt_text: string;
  attachment_file_ids_json: string | null;
  attachment_omitted_count: number | null;
  candidates_json: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

function parseSlackRepoDisambiguationAttachmentFileIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeWebhookReference(entry)).filter((entry): entry is string => entry !== null);
  } catch {
    return [];
  }
}

function normalizeSlackRepoDisambiguationAttachmentOmittedCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function mapSlackRepoDisambiguation(row: SlackRepoDisambiguationRow): SlackRepoDisambiguationRecord | null {
  let candidates: SlackRepoDisambiguationCandidate[];
  try {
    const parsed = JSON.parse(row.candidates_json) as unknown;
    if (!Array.isArray(parsed)) return null;
    candidates = parsed
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .map((entry) => ({
        repoOwner: String(entry.repoOwner ?? ""),
        repoName: String(entry.repoName ?? ""),
      }))
      .filter((c) => c.repoOwner.length > 0 && c.repoName.length > 0);
  } catch {
    return null;
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    actorUserId: row.actor_user_id,
    actorSlackUserId: row.actor_slack_user_id,
    promptText: row.prompt_text,
    attachmentFileIds: parseSlackRepoDisambiguationAttachmentFileIds(row.attachment_file_ids_json),
    attachmentOmittedCount: normalizeSlackRepoDisambiguationAttachmentOmittedCount(row.attachment_omitted_count),
    candidates,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  };
}

export async function insertSlackRepoDisambiguation(
  db: D1Database,
  record: SlackRepoDisambiguationRecord,
): Promise<void> {
  if (!record.id || !record.channelId || !record.threadTs || !record.actorUserId) return;
  if (record.candidates.length === 0) return;
  await db
    .prepare(
      `INSERT INTO slack_repo_disambiguations (
         id, channel_id, thread_ts, message_ts, actor_user_id, actor_slack_user_id,
         prompt_text, attachment_file_ids_json, attachment_omitted_count, candidates_json,
         created_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      record.id,
      record.channelId,
      record.threadTs,
      record.messageTs,
      record.actorUserId,
      record.actorSlackUserId,
      record.promptText,
      record.attachmentFileIds.length > 0 ? JSON.stringify(record.attachmentFileIds) : null,
      normalizeSlackRepoDisambiguationAttachmentOmittedCount(record.attachmentOmittedCount),
      JSON.stringify(record.candidates),
      record.createdAt,
      record.expiresAt,
    )
    .run();
}

// Returns the row only if it exists, has not been consumed, and has not
// expired. Callers must validate identity/allowlist before calling
// consumeSlackRepoDisambiguation to atomically claim it.
export async function peekSlackRepoDisambiguation(
  db: D1Database,
  id: string,
  now: number,
): Promise<SlackRepoDisambiguationRecord | null> {
  const normalizedId = normalizeWebhookReference(id);
  if (!normalizedId) return null;

  const row = await db
    .prepare(
      `SELECT id, channel_id, thread_ts, message_ts, actor_user_id, actor_slack_user_id,
              prompt_text, attachment_file_ids_json, attachment_omitted_count, candidates_json,
              created_at, expires_at, consumed_at
         FROM slack_repo_disambiguations
        WHERE id = ? LIMIT 1`,
    )
    .bind(normalizedId)
    .first<SlackRepoDisambiguationRow>();

  if (!row) return null;
  const record = mapSlackRepoDisambiguation(row);
  if (!record) return null;
  if (record.consumedAt !== null) return null;
  if (record.expiresAt <= now) return null;
  return record;
}

export async function consumeSlackRepoDisambiguation(db: D1Database, id: string, now: number): Promise<boolean> {
  const normalizedId = normalizeWebhookReference(id);
  if (!normalizedId) return false;

  const claim = await db
    .prepare(
      `UPDATE slack_repo_disambiguations
          SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(now, normalizedId, now)
    .run();
  return d1Changed(claim);
}

export async function deleteExpiredSlackRepoDisambiguations(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db
    .prepare("DELETE FROM slack_repo_disambiguations WHERE expires_at < ? OR consumed_at IS NOT NULL")
    .bind(now)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export const SKIP_NOTICE_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Records a skip notice for (issue, reason). Returns true only for the first
 * caller inside the dedup window; concurrent or duplicate webhook deliveries
 * return false, so we post at most one comment per skip reason on a given issue
 * in 24 hours.
 */
export async function claimLinearIssueSkipNotice(
  db: D1Database,
  linearIssueId: string,
  reason: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId || !reason) return false;

  await db
    .prepare(`DELETE FROM linear_issue_skip_notices WHERE linear_issue_id = ? AND reason = ? AND created_at <= ?`)
    .bind(normalizedIssueId, reason, nowMs - SKIP_NOTICE_DEDUP_TTL_MS)
    .run();

  const result = await db
    .prepare(
      `INSERT INTO linear_issue_skip_notices (linear_issue_id, reason, created_at) VALUES (?, ?, ?)
       ON CONFLICT(linear_issue_id, reason) DO NOTHING`,
    )
    .bind(normalizedIssueId, reason, nowMs)
    .run();

  return d1Changed(result);
}

/**
 * Releases a skip-notice claim so a later webhook delivery can retry posting the
 * comment. Used when comment delivery failed after the slot was claimed, so a
 * transient token miss or API error does not permanently suppress the notice.
 */
export async function deleteLinearIssueSkipNotice(
  db: D1Database,
  linearIssueId: string,
  reason: string,
): Promise<void> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId || !reason) return;

  await db
    .prepare(`DELETE FROM linear_issue_skip_notices WHERE linear_issue_id = ? AND reason = ?`)
    .bind(normalizedIssueId, reason)
    .run();
}

/**
 * Records a skip notice for (Jira issue ref, reason). Returns true only for the
 * first caller inside the dedup window; concurrent or duplicate webhook
 * deliveries return false, so we post at most one comment per skip reason on a
 * given issue in 24 hours.
 */
export async function claimJiraIssueSkipNotice(
  db: D1Database,
  jiraIssueId: string,
  reason: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(jiraIssueId);
  if (!normalizedIssueId || !reason) return false;

  await db
    .prepare(`DELETE FROM jira_issue_skip_notices WHERE jira_issue_id = ? AND reason = ? AND created_at <= ?`)
    .bind(normalizedIssueId, reason, nowMs - SKIP_NOTICE_DEDUP_TTL_MS)
    .run();

  const result = await db
    .prepare(
      `INSERT INTO jira_issue_skip_notices (jira_issue_id, reason, created_at) VALUES (?, ?, ?)
       ON CONFLICT(jira_issue_id, reason) DO NOTHING`,
    )
    .bind(normalizedIssueId, reason, nowMs)
    .run();

  return d1Changed(result);
}

/**
 * Releases a Jira skip-notice claim so a later webhook delivery can retry
 * posting the comment after a transient token miss or API failure.
 */
export async function deleteJiraIssueSkipNotice(db: D1Database, jiraIssueId: string, reason: string): Promise<void> {
  const normalizedIssueId = normalizeWebhookReference(jiraIssueId);
  if (!normalizedIssueId || !reason) return;

  await db
    .prepare(`DELETE FROM jira_issue_skip_notices WHERE jira_issue_id = ? AND reason = ?`)
    .bind(normalizedIssueId, reason)
    .run();
}

export async function deleteLinearIssueSessionRefIfSession(
  db: D1Database,
  linearIssueId: string,
  sessionId: string,
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId || !sessionId) return false;

  const result = await db
    .prepare(`DELETE FROM linear_issue_session_refs WHERE linear_issue_id = ? AND session_id = ?`)
    .bind(normalizedIssueId, sessionId)
    .run();

  return d1Changed(result);
}

export async function getSessionIdByLinearIssueRef(db: D1Database, linearIssueId: string): Promise<string | null> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return null;

  const row = await db
    .prepare(`SELECT session_id FROM linear_issue_session_refs WHERE linear_issue_id = ? LIMIT 1`)
    .bind(normalizedIssueId)
    .first<{ session_id: string }>();

  return row?.session_id ? String(row.session_id) : null;
}

export interface LinearIssueSessionRef {
  sessionId: string;
  updatedAt: string | null;
}

export async function getLinearIssueSessionRef(
  db: D1Database,
  linearIssueId: string,
): Promise<LinearIssueSessionRef | null> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return null;

  const row = await db
    .prepare(`SELECT session_id, updated_at FROM linear_issue_session_refs WHERE linear_issue_id = ? LIMIT 1`)
    .bind(normalizedIssueId)
    .first<{ session_id: string; updated_at: string | null }>();

  if (!row?.session_id) return null;
  return { sessionId: String(row.session_id), updatedAt: row.updated_at ? String(row.updated_at) : null };
}

// --- Linear webhook bootstrap jobs (ARC-1051) ---
//
// Durable, resumable record of a Linear-originated session bootstrap. Mirrors
// `automation_slot_jobs`: a `phase` checkpoint advanced after each step and a
// `terminal_outcome` (NULL = in-flight). Keyed on `linear_issue_id`, the same
// per-issue dedup boundary as `linear_issue_session_refs`, and written
// atomically alongside that ref so the job and the claim share one boundary.

export type LinearBootstrapJobPhase =
  "linear_issue_claimed" | "gate_revalidated" | "session_projected" | "prompt_enqueued" | "linked" | "picked_up";

export type LinearBootstrapJobTerminalOutcome = "completed" | "failed";

export type LinearBootstrapJobRow = {
  linear_issue_id: string;
  session_id: string;
  business_id: string;
  actor_user_id: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  model: string | null;
  prompt_template: string;
  issue_snapshot: string;
  uploaded_images_json: string | null;
  phase: LinearBootstrapJobPhase;
  terminal_outcome: LinearBootstrapJobTerminalOutcome | null;
  failure_reason: string | null;
  linear_attachment_external_id: string | null;
  attempt_count: number;
  retry_after_ms: number;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type LinearBootstrapJob = {
  linearIssueId: string;
  sessionId: string;
  businessId: string;
  actorUserId: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  model: string | null;
  promptTemplate: string;
  issueSnapshot: string;
  uploadedImages: UploadedImage[];
  phase: LinearBootstrapJobPhase;
  terminalOutcome: LinearBootstrapJobTerminalOutcome | null;
  failureReason: string | null;
  linearAttachmentExternalId: string | null;
  attemptCount: number;
  retryAfterMs: number;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const LINEAR_BOOTSTRAP_JOB_COLUMNS = `linear_issue_id, session_id, business_id, actor_user_id, repo_owner, repo_name,
  installation_id, model, prompt_template, issue_snapshot, uploaded_images_json, phase, terminal_outcome, failure_reason,
  linear_attachment_external_id, attempt_count, retry_after_ms, lease_expires_at, created_at, updated_at`;

function parseLinearBootstrapUploadedImages(rawValue: string | null): UploadedImage[] {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((image): image is UploadedImage => {
      if (!image || typeof image !== "object") return false;
      const value = image as Record<string, unknown>;
      return typeof value.name === "string" && typeof value.mediaType === "string" && typeof value.data === "string";
    });
  } catch {
    return [];
  }
}

function rowToLinearBootstrapJob(row: LinearBootstrapJobRow): LinearBootstrapJob {
  return {
    linearIssueId: row.linear_issue_id,
    sessionId: row.session_id,
    businessId: row.business_id,
    actorUserId: row.actor_user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    installationId: row.installation_id,
    model: row.model,
    promptTemplate: row.prompt_template,
    issueSnapshot: row.issue_snapshot,
    uploadedImages: parseLinearBootstrapUploadedImages(row.uploaded_images_json),
    phase: row.phase,
    terminalOutcome: row.terminal_outcome,
    failureReason: row.failure_reason,
    linearAttachmentExternalId: row.linear_attachment_external_id,
    attemptCount: row.attempt_count,
    retryAfterMs: row.retry_after_ms,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ClaimLinearBootstrapJobInput = {
  linearIssueId: string;
  sessionId: string;
  businessId: string;
  actorUserId: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  model: string | null;
  promptTemplate: string;
  issueSnapshot: string;
  uploadedImages: UploadedImage[];
  /** Initial `retry_after_ms`; set to `now + LEASE_MS` so the sweep does not
   * steal a job the in-request attempt is still driving. */
  retryAfterMs: number;
  nowMs: number;
};

/**
 * Atomically claim a Linear issue bootstrap: insert the `linear_issue_session_refs`
 * dedup row AND the bootstrap job in one batch. The job insert is guarded by a
 * `WHERE EXISTS` on the ref winning, so only the caller that wins the ref claim
 * writes the job (mirrors `claimScheduledRuleFire`). Returns true when this
 * caller won. The ref row keeps its ISO `updated_at`; job timestamps are ms.
 */
export async function claimLinearBootstrapJob(db: D1Database, input: ClaimLinearBootstrapJobInput): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(input.linearIssueId);
  if (!normalizedIssueId || !input.sessionId) return false;

  const [, jobClaim] = await db.batch([
    db
      .prepare(
        `INSERT INTO linear_issue_session_refs (linear_issue_id, session_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(linear_issue_id) DO NOTHING`,
      )
      .bind(normalizedIssueId, input.sessionId, nowIso()),
    db
      .prepare(
        `INSERT INTO linear_webhook_bootstrap_jobs (
          linear_issue_id, session_id, business_id, actor_user_id, repo_owner, repo_name,
          installation_id, model, prompt_template, issue_snapshot, uploaded_images_json, phase, terminal_outcome, failure_reason,
          linear_attachment_external_id, attempt_count, retry_after_ms, lease_expires_at, created_at, updated_at
        )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linear_issue_claimed', NULL, NULL, NULL, 0, ?, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM linear_issue_session_refs
           WHERE linear_issue_id = ? AND session_id = ?
         )
         ON CONFLICT(linear_issue_id) DO NOTHING`,
      )
      .bind(
        normalizedIssueId,
        input.sessionId,
        input.businessId,
        input.actorUserId,
        input.repoOwner,
        input.repoName,
        input.installationId,
        input.model,
        input.promptTemplate,
        input.issueSnapshot,
        input.uploadedImages.length > 0 ? JSON.stringify(input.uploadedImages) : null,
        input.retryAfterMs,
        input.nowMs,
        input.nowMs,
        normalizedIssueId,
        input.sessionId,
      ),
  ]);
  return d1Changed(jobClaim);
}

export async function getLinearBootstrapJob(db: D1Database, linearIssueId: string): Promise<LinearBootstrapJob | null> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return null;
  const row = await db
    .prepare(
      `SELECT ${LINEAR_BOOTSTRAP_JOB_COLUMNS} FROM linear_webhook_bootstrap_jobs WHERE linear_issue_id = ? LIMIT 1`,
    )
    .bind(normalizedIssueId)
    .first<LinearBootstrapJobRow>();
  return row ? rowToLinearBootstrapJob(row) : null;
}

export async function updateLinearBootstrapJobUploadedImages(
  db: D1Database,
  linearIssueId: string,
  uploadedImages: UploadedImage[],
  nowMs: number,
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return false;
  const result = await db
    .prepare(
      `UPDATE linear_webhook_bootstrap_jobs
       SET uploaded_images_json = ?, updated_at = ?
       WHERE linear_issue_id = ? AND terminal_outcome IS NULL`,
    )
    .bind(uploadedImages.length > 0 ? JSON.stringify(uploadedImages) : null, nowMs, normalizedIssueId)
    .run();
  return d1Changed(result);
}

export async function listDueLinearBootstrapJobs(
  db: D1Database,
  nowMs: number,
  limit: number,
): Promise<LinearBootstrapJob[]> {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT ${LINEAR_BOOTSTRAP_JOB_COLUMNS}
       FROM linear_webhook_bootstrap_jobs
       WHERE terminal_outcome IS NULL
         AND retry_after_ms <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(nowMs, nowMs, bounded)
    .all<LinearBootstrapJobRow>();
  return (result.results ?? []).map(rowToLinearBootstrapJob);
}

/**
 * Claim the lease for a bootstrap job. Both the in-request driver and the sweep
 * take this so they never run the same job concurrently. Returns true on win.
 */
export async function claimLinearBootstrapJobLease(
  db: D1Database,
  linearIssueId: string,
  nowMs: number,
  leaseExpiresAtMs: number,
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return false;
  const result = await db
    .prepare(
      `UPDATE linear_webhook_bootstrap_jobs
       SET lease_expires_at = ?, updated_at = ?
       WHERE linear_issue_id = ?
         AND terminal_outcome IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    )
    .bind(leaseExpiresAtMs, nowMs, normalizedIssueId, nowMs)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Advance the phase. Phase-conditional: the update only lands when the current
 * phase is `fromPhase`, so a lease-overrun double-runner cannot skip a phase or
 * re-run a non-idempotent step (B9, S11).
 */
export async function updateLinearBootstrapJobPhase(
  db: D1Database,
  linearIssueId: string,
  fromPhase: LinearBootstrapJobPhase,
  toPhase: LinearBootstrapJobPhase,
  nowMs: number,
  options: { installationId?: number; attachmentExternalId?: string | null } = {},
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return false;
  const sets = ["phase = ?", "updated_at = ?"];
  const binds: (string | number | null)[] = [toPhase, nowMs];
  if (options.installationId !== undefined) {
    sets.push("installation_id = ?");
    binds.push(options.installationId);
  }
  if (options.attachmentExternalId !== undefined) {
    sets.push("linear_attachment_external_id = ?");
    binds.push(options.attachmentExternalId);
  }
  const result = await db
    .prepare(
      `UPDATE linear_webhook_bootstrap_jobs
       SET ${sets.join(", ")}
       WHERE linear_issue_id = ? AND terminal_outcome IS NULL AND phase = ?`,
    )
    .bind(...binds, normalizedIssueId, fromPhase)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** Reschedule a transient failure for the next sweep; bumps `attempt_count`. */
export async function rescheduleLinearBootstrapJob(
  db: D1Database,
  linearIssueId: string,
  retryAfterMs: number,
  nowMs: number,
  failureReason: string | null,
): Promise<void> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return;
  await db
    .prepare(
      `UPDATE linear_webhook_bootstrap_jobs
       SET retry_after_ms = ?, lease_expires_at = NULL, failure_reason = ?,
           attempt_count = attempt_count + 1, updated_at = ?
       WHERE linear_issue_id = ? AND terminal_outcome IS NULL`,
    )
    .bind(retryAfterMs, failureReason, nowMs, normalizedIssueId)
    .run();
}

export async function markLinearBootstrapJobTerminal(
  db: D1Database,
  linearIssueId: string,
  outcome: LinearBootstrapJobTerminalOutcome,
  nowMs: number,
  failureReason: string | null = null,
): Promise<void> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId) return;
  await db
    .prepare(
      `UPDATE linear_webhook_bootstrap_jobs
       SET terminal_outcome = ?, failure_reason = ?, lease_expires_at = NULL, updated_at = ?
       WHERE linear_issue_id = ? AND terminal_outcome IS NULL`,
    )
    .bind(outcome, failureReason, nowMs, normalizedIssueId)
    .run();
}

/**
 * Delete a bootstrap job scoped to BOTH keys (B8): a concurrent re-claim's
 * newer job (different `session_id`) is never removed. Used by displacement.
 */
export async function deleteLinearBootstrapJob(
  db: D1Database,
  linearIssueId: string,
  sessionId: string,
): Promise<boolean> {
  const normalizedIssueId = normalizeWebhookReference(linearIssueId);
  if (!normalizedIssueId || !sessionId) return false;
  const result = await db
    .prepare(`DELETE FROM linear_webhook_bootstrap_jobs WHERE linear_issue_id = ? AND session_id = ?`)
    .bind(normalizedIssueId, sessionId)
    .run();
  return d1Changed(result);
}

export async function listSessionIdsByWebhookRef(
  db: D1Database,
  source: string,
  externalRef: string,
): Promise<string[]> {
  const normalizedRef = normalizeWebhookReference(externalRef);
  if (!normalizedRef) return [];

  const result = await db
    .prepare(
      `SELECT session_id FROM session_webhook_refs WHERE source = ? AND external_ref = ? ORDER BY session_id ASC`,
    )
    .bind(source, normalizedRef)
    .all<{ session_id: string }>();

  return (result.results ?? [])
    .map((row) => (row.session_id ? String(row.session_id) : ""))
    .filter((id) => id.length > 0);
}

export async function countVerificationSessionsByGithubPrRef(db: D1Database, externalRef: string): Promise<number> {
  const normalizedRef = normalizeWebhookReference(externalRef);
  if (!normalizedRef) return 0;

  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT s.session_id) AS count
       FROM session_index s
       LEFT JOIN session_webhook_refs refs
         ON refs.session_id = s.session_id
        AND refs.source = ?
        AND refs.external_ref = ?
       WHERE s.agent_role = 'verification'
         AND (refs.session_id IS NOT NULL OR s.target_pr_url = ?)`,
    )
    .bind(SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, normalizedRef, normalizedRef)
    .first<{ count: number }>();

  return Math.max(0, Number(row?.count ?? 0));
}

export async function countStandaloneVerificationSessionsByGithubPrRef(
  db: D1Database,
  externalRef: string,
): Promise<number> {
  const normalizedRef = normalizeWebhookReference(externalRef);
  if (!normalizedRef) return 0;

  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT s.session_id) AS count
       FROM session_index s
       LEFT JOIN session_webhook_refs refs
         ON refs.session_id = s.session_id
        AND refs.source = ?
        AND refs.external_ref = ?
       LEFT JOIN qa_loop_session_bindings qa_loop
         ON qa_loop.qa_session_id = s.session_id
       WHERE s.agent_role = 'verification'
         AND (refs.session_id IS NOT NULL OR s.target_pr_url = ?)
         AND qa_loop.qa_session_id IS NULL`,
    )
    .bind(SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, normalizedRef, normalizedRef)
    .first<{ count: number }>();

  return Math.max(0, Number(row?.count ?? 0));
}

export interface ReviewListeningGithubPrRef {
  sessionId: string;
  ownerUserId: number | null;
  prUrl: string;
  /** Sweep rotation watermark (Unix ms): when the reconcile sweep last visited this ref. */
  sweptAt: number;
}

export interface ListReviewListeningGithubPrRefsResult {
  data: ReviewListeningGithubPrRef[];
  nextCursor: string | null;
}

const REVIEW_LISTENING_GITHUB_PR_REFS_CURSOR_VERSION = "rlpr3";

function encodeReviewListeningGithubPrRefsCursor(row: ReviewListeningGithubPrRef): string {
  return btoa(`${REVIEW_LISTENING_GITHUB_PR_REFS_CURSOR_VERSION}|${row.sweptAt}|${row.sessionId}|${row.prUrl}`);
}

function decodeReviewListeningGithubPrRefsCursor(cursor: string | null | undefined): {
  sweptAt: number;
  sessionId: string;
  prUrl: string;
} | null {
  if (!cursor) return null;
  try {
    const [version, sweptAtRaw, sessionId, ...prUrlParts] = atob(cursor).split("|");
    const prUrl = prUrlParts.join("|");
    const sweptAt = Number(sweptAtRaw);
    if (
      version !== REVIEW_LISTENING_GITHUB_PR_REFS_CURSOR_VERSION ||
      !Number.isFinite(sweptAt) ||
      !sessionId ||
      !prUrl
    ) {
      return null;
    }
    return { sweptAt, sessionId, prUrl };
  } catch {
    return null;
  }
}

export async function listReviewListeningGithubPrRefs(
  db: D1Database,
  options: { limit?: number; cursor?: string | null; sweptBefore?: number } = {},
): Promise<ListReviewListeningGithubPrRefsResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const cursor = decodeReviewListeningGithubPrRefsCursor(options.cursor);
  // FIX #15: do NOT key reconciliation solely on the transient rich_status='review_listening'
  // projection — a session loses that projection (becomes 'running') whenever a review-loop response
  // prompt is active, which would skip head-change / PR-close reconciliation during processing. Also
  // include any session that has a DURABLE non-terminal review-loop epoch (collecting/ready/reserving/
  // enqueued/processing/publishing/waiting_for_owner) for this PR ref, so reconciliation is driven by
  // the persistent epoch signal rather than the lossy phase projection.
  const conditions = [
    "s.status != 'closed'",
    "s.status != 'archived'",
    `(s.rich_status = 'review_listening' OR EXISTS (
        SELECT 1 FROM pr_review_response_epochs e
        WHERE e.session_id = s.session_id
          AND e.pr_url = refs.external_ref
          AND e.status NOT IN ('completed', 'blocked', 'stale')
      ))`,
    // Merge-ready dormancy (epoch-aware): skip a caught-up session (review-loop done + Cycloid done /
    // verification settled) ONLY while it has no in-flight epoch. The moment any feedback webhook records
    // work it creates a ready/collecting (non-terminal) epoch, the NOT EXISTS flips false and the session
    // is re-admitted on the next tick — reconcileReviewLoopDoneState then resets done-state to 'working'.
    // No explicit wake handler is needed. NULL/'working' done-states are never excluded.
    `NOT (
      COALESCE(s.review_loop_done_state, '') = 'done'
      AND s.arcanist_done_state = 'done'
      AND NOT EXISTS (
        SELECT 1 FROM pr_review_response_epochs e
        WHERE e.session_id = s.session_id
          AND e.pr_url = refs.external_ref
          AND e.status NOT IN ('completed', 'blocked', 'stale')
      )
    )`,
  ];
  const binds: unknown[] = [SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR];
  if (cursor) {
    conditions.push(
      `(refs.review_loop_swept_at > ?
        OR (refs.review_loop_swept_at = ? AND (
          s.session_id > ?
          OR (s.session_id = ? AND refs.external_ref > ?)
        )))`,
    );
    binds.push(cursor.sweptAt, cursor.sweptAt, cursor.sessionId, cursor.sessionId, cursor.prUrl);
  }
  // Excludes refs already bumped this tick: the cursor encodes the pre-bump sweptAt, so without
  // this bound a bumped ref re-matches the cursor condition and can be fetched (and processed)
  // twice within one tick whenever the per-tick limit spans multiple query pages.
  if (typeof options.sweptBefore === "number") {
    conditions.push("refs.review_loop_swept_at < ?");
    binds.push(options.sweptBefore);
  }

  // Order least-recently-swept first (rotation watermark): refs the sweep cannot act on are still
  // bumped on every visit, so they rotate to the back instead of pinning the queue head and starving
  // newer sessions out of the per-tick budget.
  const result = await db
    .prepare(
      `SELECT s.session_id, s.owner_user_id, refs.external_ref AS pr_url, refs.review_loop_swept_at AS swept_at
       FROM session_index s
       JOIN session_webhook_refs refs ON refs.session_id = s.session_id AND refs.source = ?
       WHERE ${conditions.join(" AND ")}
       ORDER BY refs.review_loop_swept_at ASC, s.session_id ASC, refs.external_ref ASC
       LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<{ session_id: string; owner_user_id: number | string | null; pr_url: string; swept_at: number | null }>();

  const rows = (result.results ?? [])
    .map((row) => ({
      sessionId: String(row.session_id ?? ""),
      ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id),
      prUrl: String(row.pr_url ?? ""),
      sweptAt: Number(row.swept_at ?? 0),
    }))
    .filter((row) => row.sessionId.length > 0 && row.prUrl.length > 0 && Number.isFinite(row.sweptAt));
  const data = rows.slice(0, limit);
  return {
    data,
    nextCursor: rows.length > limit ? encodeReviewListeningGithubPrRefsCursor(data[data.length - 1]) : null,
  };
}

/** Bumps the sweep rotation watermark for the given refs (one tick's fetched page). */
export async function markReviewListeningGithubPrRefsSwept(
  db: D1Database,
  refs: Array<{ sessionId: string; prUrl: string }>,
  sweptAtMs: number,
): Promise<void> {
  if (refs.length === 0) return;
  await db.batch(
    refs.map((ref) =>
      db
        .prepare(
          `UPDATE session_webhook_refs SET review_loop_swept_at = ?
           WHERE source = ? AND external_ref = ? AND session_id = ?`,
        )
        .bind(sweptAtMs, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, ref.prUrl, ref.sessionId),
    ),
  );
}

/** Deletes a single webhook ref row. Returns whether a row was actually removed. */
export async function deleteSessionWebhookRef(
  db: D1Database,
  source: string,
  externalRef: string,
  sessionId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM session_webhook_refs WHERE source = ? AND external_ref = ? AND session_id = ?")
    .bind(source, externalRef, sessionId)
    .run();
  return d1Changed(result);
}

export async function deleteOrphanedWebhookRefs(db: D1Database, sessionId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM session_webhook_refs WHERE session_id = ?").bind(sessionId),
    db.prepare("DELETE FROM slack_thread_session_refs WHERE session_id = ?").bind(sessionId),
    db.prepare("DELETE FROM linear_issue_session_refs WHERE session_id = ?").bind(sessionId),
    // The bootstrap job shares the issue's dedup boundary; clear it with the
    // ref so a re-labelled issue can start a fresh job (S6, ARC-1051).
    db.prepare("DELETE FROM linear_webhook_bootstrap_jobs WHERE session_id = ?").bind(sessionId),
  ]);
}

export async function claimWebhookIdempotency(
  db: D1Database,
  source: string,
  idempotencyKey: string,
  payloadHash: string | null,
): Promise<boolean> {
  const normalizedKey = normalizeWebhookReference(idempotencyKey);
  if (!normalizedKey) return true;

  const receivedAt = nowIso();
  const expiresBefore = new Date(Date.now() - WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS).toISOString();

  // Deliberately not marked d1-retry-safe: if D1 commits an expired-claim
  // reclaim and the wrapper retries, the replay sees a fresh row and reports
  // changes = 0, which would incorrectly skip the delivery as a duplicate.
  const result = await db
    .prepare(
      `INSERT INTO webhook_idempotency (idempotency_key, source, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         source = excluded.source,
         payload_hash = excluded.payload_hash,
         received_at = excluded.received_at
       WHERE webhook_idempotency.source = excluded.source
         AND webhook_idempotency.received_at <= ?`,
    )
    .bind(normalizedKey, source, payloadHash || null, receivedAt, expiresBefore)
    .run();
  return d1Changed(result);
}

export async function deleteExpiredWebhookIdempotencyClaims(db: D1Database, now = Date.now()): Promise<number> {
  const expiresBefore = new Date(now - WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS).toISOString();
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} DELETE FROM webhook_idempotency
       WHERE received_at <= ?`,
    )
    .bind(expiresBefore)
    .run();

  return Number(result.meta?.changes ?? 0);
}

export async function releaseWebhookIdempotencyClaim(
  db: D1Database,
  source: string,
  idempotencyKey: string,
): Promise<void> {
  const normalizedKey = normalizeWebhookReference(idempotencyKey);
  if (!normalizedKey) return;

  // Release is still the fast retry path. The received_at TTL above is the
  // durability fallback if this DELETE never lands during a sustained outage.
  await db
    .prepare(`${D1_RETRY_SAFE_MARKER} DELETE FROM webhook_idempotency WHERE source = ? AND idempotency_key = ?`)
    .bind(source, normalizedKey)
    .run();
}

export function buildWebhookIdempotencyKey(source: string, explicitKey: unknown, payloadHash: string): string {
  const explicit = normalizeWebhookReference(explicitKey);
  if (explicit) return `${source}:${explicit}`;
  return `${source}:sha256:${payloadHash}`;
}
