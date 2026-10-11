import { SLACK_API_BASE } from "../constants/slack";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import { decrypt, encrypt } from "../settings/encryption";

const log = createLogger({ bindings: { component: "slack-workspaces" } });

/**
 * Install failures that map to a specific user-facing callback code, as
 * opposed to generic token-exchange/network errors.
 */
export class SlackWorkspaceInstallError extends Error {
  constructor(
    readonly code: "workspace_bound_to_other_business" | "business_has_other_workspace",
    message: string,
  ) {
    super(message);
    this.name = "SlackWorkspaceInstallError";
  }
}

interface SlackWorkspaceRow {
  team_id: string;
  bot_token_encrypted: string;
  bot_user_id: string;
  team_name: string | null;
  business_id: string | null;
  team_domain: string | null;
  enterprise_id: string | null;
  installed_by_user_id: number | null;
  installed_at: number;
  updated_at: number;
  uninstalled_at: number | null;
}

interface StoreWorkspaceInstallParams {
  teamId: string;
  botToken: string;
  botUserId: string;
  teamName?: string | null;
  businessId?: string | null;
  teamDomain?: string | null;
  enterpriseId?: string | null;
  installedByUserId?: number | null;
  installedAt?: number;
}

export interface SlackWorkspaceInstallMetadata {
  teamId: string;
  botUserId: string;
  teamName: string | null;
  businessId: string | null;
  teamDomain: string | null;
  enterpriseId: string | null;
  installedByUserId: number | null;
  installedAt: number;
  uninstalledAt: number | null;
}

function toInstallMetadata(row: SlackWorkspaceRow): SlackWorkspaceInstallMetadata {
  return {
    teamId: row.team_id,
    botUserId: row.bot_user_id,
    teamName: row.team_name,
    businessId: row.business_id,
    teamDomain: row.team_domain,
    enterpriseId: row.enterprise_id,
    installedByUserId: row.installed_by_user_id,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
  };
}

export interface SlackWorkspaceChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

interface SlackConversationListResponse {
  ok?: boolean;
  channels?: Array<{
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_group?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    is_member?: boolean;
    is_archived?: boolean;
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

export interface SlackWorkspaceAlertSenderCandidate {
  appId: string | null;
  botId: string | null;
  botName: string | null;
  sampleTs: string;
  messageCount: number;
}

interface SlackConversationHistoryResponse {
  ok?: boolean;
  messages?: Array<{
    type?: string;
    subtype?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    app_id?: string;
    bot_id?: string;
    username?: string;
    bot_profile?: {
      id?: string;
      app_id?: string;
      name?: string;
    };
  }>;
  error?: string;
}

export async function listWorkspaceInstallMetadataForBusiness(
  db: D1Database,
  businessId: string,
): Promise<SlackWorkspaceInstallMetadata[]> {
  const normalizedBusinessId = businessId.trim();
  if (!normalizedBusinessId) return [];
  const result = await db
    .prepare(
      `SELECT
        team_id,
        bot_user_id,
        team_name,
        business_id,
        team_domain,
        enterprise_id,
        installed_by_user_id,
        installed_at,
        updated_at,
        uninstalled_at
      FROM slack_workspaces
      WHERE business_id = ?
      ORDER BY team_name ASC, team_id ASC`,
    )
    .bind(normalizedBusinessId)
    .all<SlackWorkspaceRow>();
  return result.results.map(toInstallMetadata);
}

export async function getActiveWorkspaceInstallForBusiness(
  db: D1Database,
  businessId: string,
): Promise<SlackWorkspaceInstallMetadata | null> {
  const normalizedBusinessId = businessId.trim();
  if (!normalizedBusinessId) return null;
  const row = await db
    .prepare(
      `SELECT
        team_id,
        bot_user_id,
        team_name,
        business_id,
        team_domain,
        enterprise_id,
        installed_by_user_id,
        installed_at,
        updated_at,
        uninstalled_at
      FROM slack_workspaces
      WHERE business_id = ? AND uninstalled_at IS NULL
      LIMIT 1`,
    )
    .bind(normalizedBusinessId)
    .first<SlackWorkspaceRow>();
  return row ? toInstallMetadata(row) : null;
}

export async function getSoleActiveWorkspaceInstallForBusiness(
  db: D1Database,
  businessId: string,
): Promise<SlackWorkspaceInstallMetadata | null> {
  const normalizedBusinessId = businessId.trim();
  if (!normalizedBusinessId) return null;
  const result = await db
    .prepare(
      `SELECT
        team_id,
        bot_user_id,
        team_name,
        business_id,
        team_domain,
        enterprise_id,
        installed_by_user_id,
        installed_at,
        updated_at,
        uninstalled_at
      FROM slack_workspaces
      WHERE business_id = ? AND uninstalled_at IS NULL`,
    )
    .bind(normalizedBusinessId)
    .all<SlackWorkspaceRow>();
  return result.results.length === 1 ? toInstallMetadata(result.results[0]) : null;
}

export async function storeWorkspaceInstall(
  db: D1Database,
  params: StoreWorkspaceInstallParams,
  encryptionKey: string | undefined,
): Promise<void> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Slack workspace bot tokens");
  }

  const teamId = params.teamId.trim();
  const botToken = params.botToken.trim();
  const botUserId = params.botUserId.trim();
  if (!teamId) throw new Error("Slack workspace team_id is required");
  if (!botToken) throw new Error("Slack workspace bot token is required");
  if (!botUserId) throw new Error("Slack workspace bot_user_id is required");

  const now = params.installedAt ?? Date.now();
  const encryptedToken = await encrypt(botToken, encryptionKey);
  const businessId = params.businessId?.trim() || null;

  // Both guards live in the statement itself so concurrent installs cannot
  // race past an application-level pre-check: the SELECT WHERE blocks a
  // business from holding two distinct active workspaces, and the upsert
  // WHERE blocks rebinding an active workspace to a different business.
  const result = await db
    .prepare(
      `INSERT INTO slack_workspaces (
        team_id,
        bot_token_encrypted,
        bot_user_id,
        team_name,
        business_id,
        team_domain,
        enterprise_id,
        installed_by_user_id,
        installed_at,
        updated_at,
        uninstalled_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
      WHERE
        ? IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM slack_workspaces existing
          WHERE existing.business_id = ?
            AND existing.uninstalled_at IS NULL
            AND existing.team_id != ?
        )
      ON CONFLICT(team_id) DO UPDATE SET
        bot_token_encrypted = excluded.bot_token_encrypted,
        bot_user_id = excluded.bot_user_id,
        team_name = excluded.team_name,
        business_id = COALESCE(excluded.business_id, slack_workspaces.business_id),
        team_domain = COALESCE(excluded.team_domain, slack_workspaces.team_domain),
        enterprise_id = COALESCE(excluded.enterprise_id, slack_workspaces.enterprise_id),
        installed_by_user_id = excluded.installed_by_user_id,
        installed_at = excluded.installed_at,
        updated_at = excluded.updated_at,
        uninstalled_at = NULL
      WHERE
        slack_workspaces.uninstalled_at IS NOT NULL
        OR excluded.business_id IS NULL
        OR slack_workspaces.business_id IS NULL
        OR slack_workspaces.business_id = excluded.business_id`,
    )
    .bind(
      teamId,
      encryptedToken,
      botUserId,
      params.teamName?.trim() || null,
      businessId,
      params.teamDomain?.trim() || null,
      params.enterpriseId?.trim() || null,
      params.installedByUserId ?? null,
      now,
      now,
      businessId,
      businessId,
      teamId,
    )
    .run();
  if (result.meta.changes === 0) {
    const blockingInstall = businessId ? await getActiveWorkspaceInstallForBusiness(db, businessId) : null;
    if (blockingInstall && blockingInstall.teamId !== teamId) {
      throw new SlackWorkspaceInstallError(
        "business_has_other_workspace",
        "This business already has an active Slack workspace install",
      );
    }
    throw new SlackWorkspaceInstallError(
      "workspace_bound_to_other_business",
      "Slack workspace is already installed for a different business",
    );
  }
}

export async function getBotTokenForTeam(
  db: D1Database,
  teamId: string,
  encryptionKey: string | undefined,
): Promise<string | null> {
  const normalizedTeamId = teamId.trim();
  if (!normalizedTeamId) return null;

  const row = await db
    .prepare(
      `SELECT
        team_id,
        bot_token_encrypted,
        bot_user_id,
        team_name,
        business_id,
        team_domain,
        enterprise_id,
        installed_by_user_id,
        installed_at,
        updated_at,
        uninstalled_at
      FROM slack_workspaces
      WHERE team_id = ?
      LIMIT 1`,
    )
    .bind(normalizedTeamId)
    .first<SlackWorkspaceRow>();

  if (!row || row.uninstalled_at !== null) return null;

  if (!encryptionKey) {
    log.warn(
      { teamId: normalizedTeamId, action: "slack.workspace_token.decrypt_failed", reason: "encryption_key_missing" },
      "Cannot decrypt Slack workspace bot token: TOKEN_ENCRYPTION_KEY missing",
    );
    return null;
  }

  if (!row.bot_token_encrypted.startsWith("enc:")) {
    log.warn(
      { teamId: normalizedTeamId, action: "slack.workspace_token.decrypt_failed", reason: "plaintext_token_stored" },
      "Refusing to use plaintext Slack workspace bot token",
    );
    return null;
  }

  try {
    const token = await decrypt(row.bot_token_encrypted, encryptionKey);
    if (!token || token === row.bot_token_encrypted || token.startsWith("enc:")) {
      log.warn(
        {
          teamId: normalizedTeamId,
          action: "slack.workspace_token.decrypt_failed",
          reason: "malformed_encrypted_payload",
        },
        "Refusing malformed Slack workspace bot token payload",
      );
      return null;
    }
    return token;
  } catch (err) {
    log.warn(
      {
        teamId: normalizedTeamId,
        action: "slack.workspace_token.decrypt_failed",
        reason: "decrypt_threw",
        error: String(err),
      },
      "Failed to decrypt Slack workspace bot token",
    );
    return null;
  }
}

export async function listWorkspaceChannels(
  db: D1Database,
  params: { businessId: string; teamId: string },
  encryptionKey: string | undefined,
): Promise<SlackWorkspaceChannel[]> {
  const businessId = params.businessId.trim();
  const teamId = params.teamId.trim();
  if (!businessId || !teamId) return [];

  const workspace = await getWorkspaceInstallMetadata(db, teamId);
  if (!workspace || workspace.businessId !== businessId || workspace.uninstalledAt !== null) return [];

  const token = await getBotTokenForTeam(db, teamId, encryptionKey);
  if (!token) return [];

  const channels: SlackWorkspaceChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await tracedFetch(
      `${SLACK_API_BASE}/conversations.list?${query.toString()}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      "slack.conversations.list",
    );
    const result = (await response.json()) as SlackConversationListResponse;
    if (!result.ok || !Array.isArray(result.channels)) {
      log.warn(
        { teamId, slackError: result.error, status: response.status },
        "Failed to list Slack workspace channels",
      );
      break;
    }

    for (const channel of result.channels) {
      if (!channel.id || !channel.name || channel.is_im || channel.is_mpim || channel.is_archived) continue;
      channels.push({
        id: channel.id,
        name: channel.name,
        isPrivate: Boolean(channel.is_private || channel.is_group),
        isMember: Boolean(channel.is_member),
      });
    }

    cursor = result.response_metadata?.next_cursor?.trim() ?? "";
    if (!cursor) break;
  }

  channels.sort((a, b) => {
    if (a.isPrivate !== b.isPrivate) return a.isPrivate ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return channels;
}

function nonEmptySlackString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerKeywordMatches(provider: "datadog" | "sentry", value: string | null): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(provider);
}

function candidateSortValue(candidate: SlackWorkspaceAlertSenderCandidate): string {
  return `${candidate.appId ?? ""}:${candidate.botId ?? ""}:${candidate.botName ?? ""}`;
}

export async function detectWorkspaceAlertSenders(
  db: D1Database,
  params: { businessId: string; teamId: string; channelId: string; provider: "datadog" | "sentry"; limit?: number },
  encryptionKey: string | undefined,
): Promise<SlackWorkspaceAlertSenderCandidate[]> {
  const businessId = params.businessId.trim();
  const teamId = params.teamId.trim();
  const channelId = params.channelId.trim();
  if (!businessId || !teamId || !channelId) return [];

  const workspace = await getWorkspaceInstallMetadata(db, teamId);
  if (!workspace || workspace.businessId !== businessId || workspace.uninstalledAt !== null) return [];

  const token = await getBotTokenForTeam(db, teamId, encryptionKey);
  if (!token) return [];

  const query = new URLSearchParams({
    channel: channelId,
    limit: String(Math.max(1, Math.min(200, Math.floor(params.limit ?? 100)))),
  });
  const response = await tracedFetch(
    `${SLACK_API_BASE}/conversations.history?${query.toString()}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    "slack.conversations.history",
  );
  const result = (await response.json()) as SlackConversationHistoryResponse;
  if (!result.ok || !Array.isArray(result.messages)) {
    log.warn(
      { teamId, channelId, slackError: result.error, status: response.status },
      "Failed to inspect Slack workspace channel history",
    );
    return [];
  }

  const candidates = new Map<
    string,
    SlackWorkspaceAlertSenderCandidate & { providerMatched: boolean; latestTsNumber: number }
  >();
  for (const message of result.messages) {
    if (message.type !== "message") continue;
    if (message.thread_ts && message.thread_ts !== message.ts) continue;

    const appId = nonEmptySlackString(message.app_id) ?? nonEmptySlackString(message.bot_profile?.app_id);
    const botId = nonEmptySlackString(message.bot_id) ?? nonEmptySlackString(message.bot_profile?.id);
    if (!appId && !botId && message.subtype !== "bot_message") continue;

    const sampleTs = nonEmptySlackString(message.ts);
    if (!sampleTs) continue;

    const botName = nonEmptySlackString(message.bot_profile?.name) ?? nonEmptySlackString(message.username);
    const key = `${appId ?? ""}:${botId ?? ""}`;
    const providerMatched =
      providerKeywordMatches(params.provider, appId) ||
      providerKeywordMatches(params.provider, botId) ||
      providerKeywordMatches(params.provider, botName) ||
      providerKeywordMatches(params.provider, nonEmptySlackString(message.text));
    const latestTsNumber = Number(sampleTs);
    const existing = candidates.get(key);
    if (existing) {
      existing.messageCount += 1;
      existing.providerMatched = existing.providerMatched || providerMatched;
      if (Number.isFinite(latestTsNumber) && latestTsNumber > existing.latestTsNumber) {
        existing.sampleTs = sampleTs;
        existing.latestTsNumber = latestTsNumber;
      }
      continue;
    }
    candidates.set(key, {
      appId,
      botId,
      botName,
      sampleTs,
      messageCount: 1,
      providerMatched,
      latestTsNumber: Number.isFinite(latestTsNumber) ? latestTsNumber : 0,
    });
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      if (a.providerMatched !== b.providerMatched) return a.providerMatched ? -1 : 1;
      if (a.latestTsNumber !== b.latestTsNumber) return b.latestTsNumber - a.latestTsNumber;
      return candidateSortValue(a).localeCompare(candidateSortValue(b));
    })
    .map(({ providerMatched: _providerMatched, latestTsNumber: _latestTsNumber, ...candidate }) => candidate);
}

export async function getWorkspaceInstallMetadata(
  db: D1Database,
  teamId: string,
): Promise<SlackWorkspaceInstallMetadata | null> {
  const normalizedTeamId = teamId.trim();
  if (!normalizedTeamId) return null;
  const row = await db
    .prepare(
      `SELECT
        team_id,
        bot_user_id,
        team_name,
        business_id,
        team_domain,
        enterprise_id,
        installed_by_user_id,
        installed_at,
        updated_at,
        uninstalled_at
      FROM slack_workspaces
      WHERE team_id = ?
      LIMIT 1`,
    )
    .bind(normalizedTeamId)
    .first<SlackWorkspaceRow>();
  return row ? toInstallMetadata(row) : null;
}
