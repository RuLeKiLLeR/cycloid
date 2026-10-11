import { isCodeReviewerAgentRole, isQaTesterAgentRole } from "../../../../shared/agent/constants.js";
import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import { isInternalCycloidBusinessId } from "../constants/businesses";
import { isSmokeTestRepo } from "../constants/smoke-test";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import { escapeSlackText } from "../slack/internal-alert-session-context";
import { postInternalAlert } from "../slack/internal-alerts";
import { CUSTOMER_SESSION_TRACKING_CHANNEL_ID } from "../slack/internal-channels";
import type { Env } from "../types";

type CustomerSessionStartAlertEnv = Pick<Env, "FRONTEND_URL" | "SLACK_BOT_TOKEN" | "WORKER_ENV">;

export interface CustomerSessionStartAlertInput {
  sessionId: string;
  ownerUserId: string;
  /** GitHub login for the owner; rendered in place of the numeric id. Null/absent when unresolved. */
  ownerUserLogin?: string | null;
  businessId: string;
  repoOwner?: string | null;
  repoName?: string | null;
  /** Which surface created the session; see {@link SessionEntrypoint}. */
  entrypoint?: string | null;
  agentRole?: string | null;
}

export function shouldNotifyCustomerSessionStarted(
  env: Pick<Env, "WORKER_ENV">,
  session: Pick<CustomerSessionStartAlertInput, "agentRole" | "businessId" | "repoOwner" | "repoName">,
): boolean {
  if (env.WORKER_ENV !== ENVIRONMENT.Production) return false;
  // Skip the prod smoke-test repo; those sessions are synthetic operator traffic
  // that would otherwise spam the tracking channel.
  if (isSmokeTestRepo(session.repoOwner, session.repoName)) return false;
  // Only external customer sessions surface here. Internal Cycloid/Cycloid-QA
  // dogfood traffic is excluded so the channel stays a clean customer signal.
  if (isInternalCycloidBusinessId(session.businessId)) return false;
  return true;
}

function safeText(value: string | null | undefined, fallback = "unknown"): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return escapeSlackText(normalized || fallback);
}

function buildSupportViewSessionUrl(
  env: Pick<Env, "FRONTEND_URL" | "WORKER_ENV">,
  session: CustomerSessionStartAlertInput,
): string {
  const params = new URLSearchParams({
    sessionId: session.sessionId,
    targetUserId: session.ownerUserId,
  });
  return `${resolvePublicAppBaseUrl(env)}/admin/support-view?${params.toString()}`;
}

export function buildCustomerSessionStartAlertText(
  env: Pick<Env, "FRONTEND_URL" | "WORKER_ENV">,
  session: CustomerSessionStartAlertInput,
): string {
  // Only external customer sessions reach this channel, so there's no audience
  // branch. Business is dropped -- it duplicates the User line for our purposes
  // -- leaving Repo/User/Entrypoint as a compact, blockquoted body.
  const header = isQaTesterAgentRole(session.agentRole)
    ? "🔍 *Verification session started*"
    : isCodeReviewerAgentRole(session.agentRole)
      ? "🔎 *Code review session started*"
      : "👤 *Customer session started*";
  // Slack uses a proportional font, so bold-label + inline-code rows never line
  // up into columns -- the values stagger by label width. Render the body as a
  // single monospace code block with space-padded labels so Repo/User/Entrypoint
  // and their values align cleanly.
  const rows: [string, string][] = [
    ["Repo", `${safeText(session.repoOwner)}/${safeText(session.repoName)}`],
    ["User", safeText(session.ownerUserLogin ?? session.ownerUserId)],
    // Every creation surface sets `entrypoint`; the API fallback is a backstop so
    // a future surface that forgets still never renders "unknown".
    ["Entrypoint", safeText(session.entrypoint, "api")],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length + 1)) + 1;
  const body = rows.map(([label, value]) => `${`${label}:`.padEnd(labelWidth)}${value}`).join("\n");
  return [
    `${header} · <${buildSupportViewSessionUrl(env, session)}|${safeText(session.sessionId)}>`,
    "```",
    body,
    "```",
  ].join("\n");
}

export async function notifyCustomerSessionStarted(
  env: CustomerSessionStartAlertEnv,
  session: CustomerSessionStartAlertInput,
): Promise<boolean> {
  if (!shouldNotifyCustomerSessionStarted(env, session)) return false;
  const result = await postInternalAlert(
    env,
    CUSTOMER_SESSION_TRACKING_CHANNEL_ID,
    buildCustomerSessionStartAlertText(env, session),
    undefined,
    {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      businessId: session.businessId,
      repoOwner: session.repoOwner ?? null,
      repoName: session.repoName ?? null,
    },
  );
  return result?.ok === true;
}
