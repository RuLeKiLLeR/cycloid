import { OAUTH_CALLBACK_CODES, type OAuthCallbackCode } from "../../../../shared/constants/onboarding.js";
import { resetAuthMeUserCache } from "../auth/auth-me";
import { SLACK_LINK_TOKEN_TTL_MS } from "../constants/slack";
import { createLogger } from "../logger";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import type { Env } from "../types";
import { slackLinkDmText } from "../webhooks/slack-operational-replies";
import { bindSlackIdentity, pruneExpiredSlackLinkConsumptions } from "./link-db";
import { createSlackLinkToken, verifySlackLinkToken } from "./link-token";
import { getUserInfo, postDirectMessage } from "./notify";
import { getBotTokenForTeam, getWorkspaceInstallMetadata } from "./workspaces";

const log = createLogger({ bindings: { component: "slack-link-service" } });

/** At most one magic-link DM per Slack user per workspace in this window. */
const SLACK_LINK_DM_RATE_LIMIT_WINDOW_SECONDS = Math.floor(SLACK_LINK_TOKEN_TTL_MS / 1000);

export type SlackLinkDmResult = "sent" | "rate_limited" | "not_configured" | "failed";

/**
 * DM a Slack user a single-use magic link to bind their identity. Rate-limited
 * per `(team, user)` so repeated mentions before they click do not spam DMs.
 * Fails open to a non-send result (the caller falls back to a thread reply);
 * never throws into the webhook path.
 */
export async function sendSlackLinkDm(
  env: Env,
  args: { slackUserId: string; slackTeamId: string; botToken: string; now?: number },
): Promise<SlackLinkDmResult> {
  const secret = env.SLACK_LINK_SIGNING_KEY;
  if (!secret) return "not_configured";

  const now = args.now ?? Date.now();
  const kv = env.RATE_LIMITS;
  const bucket = Math.floor(now / (SLACK_LINK_DM_RATE_LIMIT_WINDOW_SECONDS * 1000));
  const rateKey = `slack-link-dm:${args.slackTeamId}:${args.slackUserId}:${bucket}`;
  if (kv) {
    const sentThisWindow = await kv.get(rateKey).catch(() => null);
    if (sentThisWindow) return "rate_limited";
  }

  const token = await createSlackLinkToken(
    { slackUserId: args.slackUserId, slackTeamId: args.slackTeamId },
    secret,
    now,
  );
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const linkUrl = `${frontendUrl}/auth/slack/link?token=${encodeURIComponent(token)}`;

  const result = await postDirectMessage(args.botToken, args.slackUserId, slackLinkDmText(linkUrl)).catch(() => null);
  if (!result?.ok) {
    log.warn({ slackTeamId: args.slackTeamId, error: result?.error }, "Failed to DM Slack magic link");
    return "failed";
  }

  // Record the send only after success so a failed DM does not block a retry.
  if (kv) {
    await kv.put(rateKey, "1", { expirationTtl: SLACK_LINK_DM_RATE_LIMIT_WINDOW_SECONDS * 2 }).catch(() => undefined);
  }
  log.info({ slackTeamId: args.slackTeamId, action: "slack_link_dm_sent" }, "Sent Slack magic-link DM");
  return "sent";
}

export interface SlackLinkContext {
  slackUserId: string;
  slackTeamId: string;
  jti: string;
  expiresAt: number;
  workspaceName: string | null;
  /** Best-effort Slack display name for the consent screen; may be null. */
  slackDisplayName: string | null;
}

export type SlackLinkResolution = { ok: true; context: SlackLinkContext } | { ok: false; code: OAuthCallbackCode };

/**
 * Verify a magic-link token and confirm the workspace it names is installed and
 * owned by the acting user's business. Shared by the consent-screen render and
 * the confirm POST so both fail closed identically. Does NOT bind or consume
 * the token.
 */
export async function resolveSlackLink(
  env: Env,
  token: string,
  userBusinessId: string | null,
): Promise<SlackLinkResolution> {
  const secret = env.SLACK_LINK_SIGNING_KEY;
  if (!secret) {
    log.error({}, "SLACK_LINK_SIGNING_KEY not configured; cannot verify Slack link token");
    return { ok: false, code: OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID };
  }

  const payload = await verifySlackLinkToken(token, secret);
  if (!payload) return { ok: false, code: OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID };

  // Fail closed unless the token's workspace is installed, active, and owned by
  // the acting user's business. Blocks binding a forwarded/leaked link to an
  // unrelated business.
  const workspace = await getWorkspaceInstallMetadata(env.DB, payload.slackTeamId);
  if (!workspace || workspace.uninstalledAt !== null || !workspace.businessId) {
    return { ok: false, code: OAUTH_CALLBACK_CODES.SLACK_LINK_WORKSPACE_MISMATCH };
  }
  if (!userBusinessId || workspace.businessId !== userBusinessId) {
    log.warn(
      { slackTeamId: payload.slackTeamId, workspaceBusinessId: workspace.businessId },
      "Slack link workspace/business mismatch",
    );
    return { ok: false, code: OAUTH_CALLBACK_CODES.SLACK_LINK_WORKSPACE_MISMATCH };
  }

  // Best-effort display name for the consent screen. Never block on it.
  let slackDisplayName: string | null = null;
  const botToken = await getBotTokenForTeam(env.DB, payload.slackTeamId, env.TOKEN_ENCRYPTION_KEY).catch(() => null);
  if (botToken) {
    const info = await getUserInfo(botToken, payload.slackUserId).catch(() => null);
    slackDisplayName = info?.displayName || info?.realName || info?.name || null;
  }

  return {
    ok: true,
    context: {
      slackUserId: payload.slackUserId,
      slackTeamId: payload.slackTeamId,
      jti: payload.jti,
      expiresAt: payload.expiresAt,
      workspaceName: workspace.teamName,
      slackDisplayName,
    },
  };
}

/**
 * Confirm a magic-link bind: re-verify the token and workspace ownership, then
 * atomically consume the token and link the Slack identity to `userId`. Returns
 * a callback code for the redirect.
 */
export async function confirmSlackLink(
  env: Env,
  args: { token: string; userId: number; userBusinessId: string | null },
): Promise<OAuthCallbackCode> {
  const resolution = await resolveSlackLink(env, args.token, args.userBusinessId);
  if (!resolution.ok) return resolution.code;

  const { slackUserId, slackTeamId, jti, expiresAt } = resolution.context;
  const result = await bindSlackIdentity(env.DB, {
    userId: args.userId,
    slackUserId,
    slackTeamId,
    jti,
    expiresAt,
  });

  switch (result) {
    case "bound":
      resetAuthMeUserCache();
      log.info(
        { userId: args.userId, slackTeamId, action: "slack_link_bound" },
        "Slack identity linked via magic link",
      );
      void runWithSentryTag("pruneExpiredSlackLinkConsumptions", () => pruneExpiredSlackLinkConsumptions(env.DB), log);
      return OAUTH_CALLBACK_CODES.SLACK_LINK_SUCCESS;
    case "already_linked_same":
      // Idempotent double-submit / re-confirm of the same identity. Nothing
      // mutated on this call, so skip the cache reset and prune; the link
      // already exists for this user, so land on the success page.
      log.info(
        { userId: args.userId, slackTeamId, action: "slack_link_idempotent" },
        "Slack link already bound to same identity",
      );
      return OAUTH_CALLBACK_CODES.SLACK_LINK_SUCCESS;
    case "already_linked_self":
    case "already_linked_other":
      log.info({ userId: args.userId, slackTeamId, reason: result }, "Slack link refused: already bound");
      return OAUTH_CALLBACK_CODES.SLACK_LINK_ALREADY_BOUND;
    case "replayed":
      return OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID;
  }
}
