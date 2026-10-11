// Reusable "post a message into the Cycloid Slack workspace" utility for
// internal operator alerts (Type A sends via `env.SLACK_BOT_TOKEN`). It wraps
// `postMessage` from `slack/notify.ts` and adds the best-effort envelope every
// internal-alert callsite needs: no-op when unconfigured, never throw, and
// metadata-only logging.
//
// Out of scope: customer/session-thread sends (per-business decrypted tokens,
// thread-bound product behavior). Those stay on their own code paths.

import { createLogger } from "../logger";
import type { Env } from "../types";
import { postMessage, type SlackPostMessageResponse } from "./notify";

const log = createLogger({ bindings: { component: "internal-alerts" } });

type InternalAlertEnv = Pick<Env, "SLACK_BOT_TOKEN">;

/** Treat empty/whitespace-only / placeholder config as unconfigured. */
function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "CHANGE_ME") return null;
  return trimmed;
}

export function resolveInternalAlertConfig(
  env: InternalAlertEnv,
  channel: string | undefined,
): { token: string; channel: string } | null {
  const token = configured(env.SLACK_BOT_TOKEN);
  const resolvedChannel = configured(channel);
  if (!token || !resolvedChannel) return null;
  return { token, channel: resolvedChannel };
}

/** Whether a channel value looks like a Slack user id (DM) vs a channel id. */
function channelType(channel: string): "user" | "channel" {
  return channel.startsWith("U") || channel.startsWith("W") ? "user" : "channel";
}

/**
 * Post a best-effort message into the Cycloid Slack workspace.
 *
 * No-ops when token or channel is absent/blank (local dev / unconfigured).
 * Never throws: Slack hiccups must not break the caller's flow.
 * `channel` may be a channel id or a user id (DM — Slack accepts a user id as
 * the `channel` of `chat.postMessage`).
 *
 * Returns the Slack response on a completed call, or `null` when it no-ops
 * (missing config) or the underlying call threw. Callers that only care about
 * success check `result?.ok`; callers that thread/persist read `result.ts` /
 * `result.channel`.
 *
 * Logging is metadata-only: never log `text`, `blocks`, the token, or any raw
 * Slack payload (alerts can carry PII; see docs/security.md). Logs only the
 * channel presence/type, Slack error code, and the optional `logContext`.
 */
export async function postInternalAlert(
  env: InternalAlertEnv,
  channel: string | undefined,
  text: string,
  blocks?: unknown[],
  logContext?: Record<string, string | number | boolean | null>,
): Promise<SlackPostMessageResponse | null> {
  const config = resolveInternalAlertConfig(env, channel);
  if (!config) return null;

  try {
    // Do not log on `ok:false`: the underlying `slackApi` layer (notify.ts)
    // already logs every non-ok Slack response via `logSlackApiFailure`, so a
    // warn here would double-log the same failure. The thrown-error path below
    // is the only case `slackApi` does not log, so it keeps its own warn.
    return await postMessage(config.token, config.channel, text, blocks);
  } catch (err) {
    log.warn(
      { ...logContext, channelType: channelType(config.channel), error: String(err) },
      "Internal Slack alert threw",
    );
    return null;
  }
}
