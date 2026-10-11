import { isInternalCycloidBusinessId } from "../constants/businesses";
import { createLogger } from "../logger";
import { escapeSlackMrkdwnText } from "../slack/blocks";
import { postInternalAlert } from "../slack/internal-alerts";
import { SESSION_MONITORING_CHANNEL_ID } from "../slack/internal-channels";
import type { Env } from "../types";
import {
  claimWebhookIdempotency,
  listSessionIdsByWebhookRef,
  releaseWebhookIdempotencyClaim,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
} from "../webhooks/db";
import { getSessionIndexBusinessId } from "./business-id";

const log = createLogger({ bindings: { component: "human-github-pr-action-alert" } });
const ALERT_IDEMPOTENCY_SOURCE = "human_github_pr_action_alert";

export type HumanGithubPrActionKind = "issue_comment" | "pull_request_review" | "pull_request_review_comment";

type HumanGithubPrActionAlertEnv = Pick<Env, "DB" | "FRONTEND_URL" | "SLACK_BOT_TOKEN">;

export interface HumanGithubPrActionAlertInput {
  env: HumanGithubPrActionAlertEnv;
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  actorLogin: string | null;
  actorType: string;
  actionKind: HumanGithubPrActionKind;
  reviewId?: number | null;
  commentId?: number | null;
  sessionIds?: string[];
  deliveryId?: string | null;
}

// "Actor:" read like a Cycloid login and caused internal panic when a customer's
// teammate reviewed a PR; label the person by what they did on GitHub instead.
const ACTION_LABELS: Record<HumanGithubPrActionKind, { title: string; actor: string }> = {
  issue_comment: { title: "comment", actor: "Comment by" },
  pull_request_review: { title: "review", actor: "Reviewed by" },
  pull_request_review_comment: { title: "inline review comment", actor: "Inline comment by" },
};

function safeSlackLink(url: string, label: string): string {
  return `<${url}|${escapeSlackMrkdwnText(label).replaceAll("|", "¦")}>`;
}

function sessionLabel(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}...` : sessionId;
}

function formatSessionRefs(env: HumanGithubPrActionAlertEnv, sessionIds: string[]): string {
  const frontendUrl = env.FRONTEND_URL?.replace(/\/+$/, "");
  const refs = sessionIds.slice(0, 3).map((sessionId) => {
    if (!frontendUrl) return `\`${escapeSlackMrkdwnText(sessionLabel(sessionId))}\``;
    return safeSlackLink(`${frontendUrl}/sessions/${encodeURIComponent(sessionId)}`, sessionLabel(sessionId));
  });
  const remaining = sessionIds.length - refs.length;
  return remaining > 0 ? `${refs.join(", ")} +${remaining} more` : refs.join(", ");
}

export function buildHumanGithubPrActionAlertText(
  env: HumanGithubPrActionAlertEnv,
  input: Omit<HumanGithubPrActionAlertInput, "env" | "sessionIds"> & { sessionIds: string[] },
): string {
  const repo = `${input.repoOwner}/${input.repoName}`;
  const prRef = safeSlackLink(input.prUrl, `${repo}#${input.prNumber}`);
  const labels = ACTION_LABELS[input.actionKind];
  const actor = input.actorLogin
    ? safeSlackLink(`https://github.com/${input.actorLogin}`, `@${input.actorLogin}`)
    : "Unknown";
  return [
    `*Human ${labels.title} on a Cycloid-authored PR*`,
    `PR: ${prRef}`,
    `${labels.actor}: ${actor} — GitHub account on the PR, not necessarily a Cycloid user`,
    `Linked Cycloid sessions: ${formatSessionRefs(env, input.sessionIds)}`,
  ].join("\n");
}

async function resolveSessionIds(input: HumanGithubPrActionAlertInput): Promise<string[]> {
  if (input.sessionIds) return input.sessionIds;
  return listSessionIdsByWebhookRef(input.env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, input.prUrl);
}

function buildAlertIdempotencyKey(input: HumanGithubPrActionAlertInput): string | null {
  if (input.actionKind === "issue_comment") {
    if (!input.commentId) return null;
    return `${ALERT_IDEMPOTENCY_SOURCE}:issue-comment:${input.repoOwner}/${input.repoName}#${input.prNumber}:${input.commentId}`;
  }

  if (input.reviewId) {
    return `${ALERT_IDEMPOTENCY_SOURCE}:review:${input.repoOwner}/${input.repoName}#${input.prNumber}:${input.reviewId}`;
  }

  if (input.commentId) {
    return `${ALERT_IDEMPOTENCY_SOURCE}:review-comment:${input.repoOwner}/${input.repoName}#${input.prNumber}:${input.commentId}`;
  }

  return null;
}

async function releaseAlertIdempotencyClaimBestEffort(
  env: HumanGithubPrActionAlertEnv,
  idempotencyKey: string | null,
  input: HumanGithubPrActionAlertInput,
): Promise<void> {
  if (!idempotencyKey) return;
  try {
    await releaseWebhookIdempotencyClaim(env.DB, ALERT_IDEMPOTENCY_SOURCE, idempotencyKey);
  } catch (error) {
    log.warn(
      {
        error: String(error),
        idempotencyKey,
        prUrl: input.prUrl,
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        actionKind: input.actionKind,
        deliveryId: input.deliveryId ?? null,
      },
      "Failed to release human GitHub PR action alert claim",
    );
  }
}

export async function notifyHumanGithubPrAction(input: HumanGithubPrActionAlertInput): Promise<boolean> {
  if (input.actorType !== "User") return false;
  if (!input.actorLogin) return false;
  const sessionIds = await resolveSessionIds(input);
  if (sessionIds.length === 0) return false;
  // Internal Cycloid sessions (our own dogfood) are our traffic, not customer
  // signal; skip them so this channel stays a clean customer feed - the same
  // isInternalCycloidBusinessId guard the customer-session-start alert uses. All
  // sessions linked to one PR share a business (a session's business comes from
  // the acting user, and repo access is business-scoped), so the first is
  // representative. Runs before the idempotency claim so we never claim a key for
  // a suppressed alert. Fail open: only suppress on a positive internal match, so
  // neither an unresolved business nor a transient lookup error hides genuine
  // customer activity.
  let businessId: string | null = null;
  try {
    businessId = await getSessionIndexBusinessId(input.env.DB, sessionIds[0]);
  } catch (error) {
    log.warn(
      { error: String(error), prUrl: input.prUrl, prNumber: input.prNumber, sessionId: sessionIds[0] },
      "Failed to resolve session business for internal-alert suppression; posting alert (fail open)",
    );
  }
  if (businessId && isInternalCycloidBusinessId(businessId)) return false;
  const idempotencyKey = buildAlertIdempotencyKey(input);
  if (idempotencyKey) {
    const claimed = await claimWebhookIdempotency(input.env.DB, ALERT_IDEMPOTENCY_SOURCE, idempotencyKey, null);
    if (!claimed) return false;
  }

  const text = buildHumanGithubPrActionAlertText(input.env, { ...input, sessionIds });
  try {
    const result = await postInternalAlert(input.env, SESSION_MONITORING_CHANNEL_ID, text, undefined, {
      prNumber: input.prNumber,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      actorLogin: input.actorLogin,
      actionKind: input.actionKind,
      reviewId: input.reviewId ?? null,
      commentId: input.commentId ?? null,
      deliveryId: input.deliveryId ?? null,
    });
    if (result?.ok === true) return true;
    await releaseAlertIdempotencyClaimBestEffort(input.env, idempotencyKey, input);
    return false;
  } catch (error) {
    await releaseAlertIdempotencyClaimBestEffort(input.env, idempotencyKey, input);
    throw error;
  }
}

export function dispatchHumanGithubPrActionAlert(
  input: HumanGithubPrActionAlertInput,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const promise = notifyHumanGithubPrAction(input).catch((err) => {
    log.warn(
      {
        error: String(err),
        prUrl: input.prUrl,
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        actionKind: input.actionKind,
        deliveryId: input.deliveryId ?? null,
      },
      "Human GitHub PR action alert failed",
    );
  });
  if (waitUntil) {
    waitUntil(promise);
  }
}
