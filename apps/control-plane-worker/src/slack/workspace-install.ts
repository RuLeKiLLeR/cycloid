import { getUserBusinessIdOrNull } from "../auth/db";
import { SLACK_API_BASE, SLACK_TOKEN_URL } from "../constants/slack";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import {
  getActiveWorkspaceInstallForBusiness,
  getWorkspaceInstallMetadata,
  SlackWorkspaceInstallError,
  storeWorkspaceInstall,
} from "./workspaces";

const log = createLogger({ bindings: { component: "slack-workspace-install" } });

const SLACK_WORKSPACE_INSTALL_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "reactions:write",
  "users:read",
  "users:read.email",
  "files:read",
  // Powers plan-file attachments; existing installs must reinstall to grant it.
  "files:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "im:write",
  "im:read",
  "channels:read",
  "groups:read",
  "team:read",
] as const;

export const SLACK_WORKSPACE_INSTALL_SCOPE = SLACK_WORKSPACE_INSTALL_SCOPES.join(",");

export const SLACK_WORKSPACE_INSTALL_STATE_COOKIE = "slack_install_oauth_state";
const SLACK_WORKSPACE_INSTALL_CALLBACK_PATH = "/auth/slack/install/callback";

interface SlackWorkspaceTokenResponse {
  ok?: boolean;
  access_token?: string;
  bot_user_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
  enterprise?: {
    id?: string;
  } | null;
  error?: string;
}

interface SlackWorkspaceInstallResult {
  teamId: string;
  teamName: string | null;
  botUserId: string;
}

interface SlackTeamInfoResponse {
  ok?: boolean;
  team?: {
    domain?: string;
  };
}

interface SeedSlackWorkspaceParams {
  teamId?: unknown;
  teamName?: unknown;
  botUserId?: unknown;
}

export function slackInstallCallbackUrl(env: Env, requestUrl: string): string {
  if (env.SLACK_INSTALL_CALLBACK_URL) return env.SLACK_INSTALL_CALLBACK_URL;
  if (env.FRONTEND_URL) return new URL(SLACK_WORKSPACE_INSTALL_CALLBACK_PATH, env.FRONTEND_URL).toString();
  if (requestUrl) return new URL(SLACK_WORKSPACE_INSTALL_CALLBACK_PATH, requestUrl).toString();
  return `http://localhost:3000${SLACK_WORKSPACE_INSTALL_CALLBACK_PATH}`;
}

export { SlackWorkspaceInstallError } from "./workspaces";

function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredSlackInstallConfig(env: Env): { clientId: string; clientSecret: string } {
  const clientId = env.SLACK_CLIENT_ID;
  const clientSecret = env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Slack OAuth not configured");
  }
  return { clientId, clientSecret };
}

function parseWorkspaceTokenResponse(
  data: SlackWorkspaceTokenResponse,
): SlackWorkspaceInstallResult & { botToken: string; enterpriseId: string | null } {
  const botToken = data.access_token?.trim();
  const botUserId = data.bot_user_id?.trim();
  const teamId = data.team?.id?.trim();
  const teamName = data.team?.name?.trim() || null;

  if (!data.ok || !botToken || !botUserId || !teamId) {
    throw new Error("Slack workspace token exchange returned an incomplete install payload");
  }

  return { teamId, teamName, botUserId, botToken, enterpriseId: data.enterprise?.id?.trim() || null };
}

async function fetchTeamDomain(botToken: string): Promise<string | null> {
  try {
    const response = await tracedFetch(
      `${SLACK_API_BASE}/team.info`,
      { headers: { authorization: `Bearer ${botToken}` } },
      "slack.workspaceInstall.teamInfo",
    );
    if (!response.ok) return null;
    const body = (await response.json()) as SlackTeamInfoResponse;
    return body.ok ? body.team?.domain?.trim() || null : null;
  } catch (err) {
    log.warn({ error: String(err) }, "Slack team.info lookup failed during workspace install");
    return null;
  }
}

export async function installSlackWorkspaceFromCode(
  env: Env,
  code: string,
  installedByUserId: number,
  redirectUri: string,
): Promise<SlackWorkspaceInstallResult> {
  const { clientId, clientSecret } = requiredSlackInstallConfig(env);

  const tokenRes = await tracedFetch(
    SLACK_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    },
    "slack.workspaceInstall.oauth",
  );
  const tokenData = (await tokenRes.json()) as SlackWorkspaceTokenResponse;
  if (!tokenRes.ok || !tokenData.ok) {
    log.warn(
      { status: tokenRes.status, providerError: tokenData.error ?? null },
      "Slack workspace install token exchange failed",
    );
    throw new Error(`Slack token exchange failed: ${tokenData.error ?? `HTTP ${tokenRes.status}`}`);
  }

  const install = parseWorkspaceTokenResponse(tokenData);
  const [businessId, existingWorkspace] = await Promise.all([
    getUserBusinessIdOrNull(env.DB, installedByUserId),
    getWorkspaceInstallMetadata(env.DB, install.teamId),
  ]);
  if (
    existingWorkspace?.businessId &&
    existingWorkspace.uninstalledAt === null &&
    existingWorkspace.businessId !== businessId
  ) {
    log.warn(
      {
        teamId: install.teamId,
        existingBusinessId: existingWorkspace.businessId,
        installerBusinessId: businessId,
        installedByUserId,
      },
      "Rejected Slack workspace install for a different business",
    );
    throw new SlackWorkspaceInstallError(
      "workspace_bound_to_other_business",
      "Slack workspace is already installed for a different business",
    );
  }

  // One workspace per business: reject a second distinct team while one is
  // active. Re-installing the same team stays allowed (token refresh).
  if (businessId) {
    const activeForBusiness = await getActiveWorkspaceInstallForBusiness(env.DB, businessId);
    if (activeForBusiness && activeForBusiness.teamId !== install.teamId) {
      log.warn(
        {
          teamId: install.teamId,
          existingTeamId: activeForBusiness.teamId,
          businessId,
          installedByUserId,
        },
        "Rejected Slack workspace install: business already has an active workspace",
      );
      throw new SlackWorkspaceInstallError(
        "business_has_other_workspace",
        "This business already has an active Slack workspace install",
      );
    }
  }

  const teamDomain = await fetchTeamDomain(install.botToken);
  await storeWorkspaceInstall(
    env.DB,
    {
      teamId: install.teamId,
      teamName: install.teamName,
      botUserId: install.botUserId,
      botToken: install.botToken,
      businessId,
      teamDomain,
      enterpriseId: install.enterpriseId,
      installedByUserId,
    },
    env.TOKEN_ENCRYPTION_KEY,
  );

  return {
    teamId: install.teamId,
    teamName: install.teamName,
    botUserId: install.botUserId,
  };
}

export async function seedSlackWorkspaceFromEnv(
  env: Env,
  params: SeedSlackWorkspaceParams,
): Promise<SlackWorkspaceInstallResult> {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const envTeamId = env.SLACK_WORKSPACE_TEAM_ID?.trim();
  const envTeamName = env.SLACK_WORKSPACE_TEAM_NAME?.trim() ?? null;
  const envBotUserId = env.SLACK_BOT_USER_ID?.trim();
  const requestTeamId = optionalTrimmedString(params.teamId);
  const requestTeamName = optionalTrimmedString(params.teamName);
  const requestBotUserId = optionalTrimmedString(params.botUserId);

  if (envTeamId && requestTeamId && requestTeamId !== envTeamId) {
    throw new Error("teamId must match SLACK_WORKSPACE_TEAM_ID");
  }
  if (envBotUserId && requestBotUserId && requestBotUserId !== envBotUserId) {
    throw new Error("botUserId must match SLACK_BOT_USER_ID");
  }

  const teamId = envTeamId ?? requestTeamId;
  const teamName = envTeamName ?? requestTeamName ?? null;
  const botUserId = envBotUserId ?? requestBotUserId;

  if (!botToken) throw new Error("SLACK_BOT_TOKEN is required to seed Slack workspace install");
  if (!teamId) throw new Error("teamId or SLACK_WORKSPACE_TEAM_ID is required");
  if (!botUserId) throw new Error("botUserId or SLACK_BOT_USER_ID is required");

  await storeWorkspaceInstall(
    env.DB,
    {
      teamId,
      teamName,
      botUserId,
      botToken,
      businessId: null,
      teamDomain: null,
      enterpriseId: null,
      installedByUserId: null,
    },
    env.TOKEN_ENCRYPTION_KEY,
  );

  return { teamId, teamName, botUserId };
}
