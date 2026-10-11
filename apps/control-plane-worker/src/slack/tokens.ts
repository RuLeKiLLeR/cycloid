import { createLogger } from "../logger";
import type { CallbackContext, Env } from "../types";
import { getBotTokenForTeam } from "./workspaces";

const log = createLogger({ bindings: { component: "slack-tokens" } });

export async function resolveInstalledSlackBotToken(
  env: Env,
  teamId: string | null | undefined,
): Promise<string | null> {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return null;
  try {
    return await getBotTokenForTeam(env.DB, normalizedTeamId, env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    log.warn(
      {
        teamId: normalizedTeamId,
        action: "slack.workspace_token.lookup_failed",
        error: String(err),
      },
      "Failed to resolve Slack workspace bot token",
    );
    return null;
  }
}

interface SlackBotTokenResolutionContext {
  operation: string;
  sessionId: string;
}

export async function resolveSlackBotTokenForCallback(
  env: Env,
  callbackContext: CallbackContext,
  context: SlackBotTokenResolutionContext,
): Promise<string | null> {
  if (callbackContext.source === "slack") {
    // Older persisted callback_context_json rows predate slackTeamId. Keep the
    // write-time type strict, but guard runtime deserialization here.
    const slackTeamId = callbackContext.slackTeamId?.trim();
    if (!slackTeamId) {
      log.warn(
        {
          action: "slack.callback_context.missing_team_id",
          operation: context.operation,
          sessionId: context.sessionId,
          channel: callbackContext.channel,
          threadTs: callbackContext.threadTs,
        },
        "Slack callback token resolution skipped: missing team id",
      );
      return null;
    }
    return resolveInstalledSlackBotToken(env, slackTeamId);
  }
  return env.SLACK_BOT_TOKEN?.trim() || null;
}
