import { businessIdsMatch } from "../constants/businesses";
import { SlackInteractionKind } from "../enums/slack-interaction";
import { createLogger } from "../logger";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import { getSessionPlanMarkdown } from "../session/state";
import type { Env } from "../types";
import { slackInteractionActionId } from "./blocks";
import {
  getNewestPending,
  insertInteractionRequest,
  listPendingInteractionRequests,
  type SlackInteractionRequestRecord,
  supersedeInteractionRequest,
  supersedePending,
} from "./interaction-requests-db";
import { postThreadReply, updateMessage, uploadFile } from "./notify";
import { getBotTokenForTeam } from "./workspaces";

const log = createLogger({ bindings: { component: "slack-plan-approval" } });

export type PlanApprovalSupersessionReason = "edited" | "discussed" | "approved" | "stopped" | "archived";
export type PlanApprovalInteractionMessageState = "approved" | "stale" | "unavailable";

interface PlanApprovalRequestPayload {
  revision: number;
}

interface PlanApprovalMessage {
  text: string;
  blocks: unknown[];
}

function sessionUrl(env: Env, sessionId: string): string {
  return `${env.FRONTEND_URL || DEFAULT_FRONTEND_URL}/sessions/${sessionId}`;
}

type PlanApprovalMessageState =
  "ready" | "retry" | PlanApprovalInteractionMessageState | PlanApprovalSupersessionReason;

// States whose message reflects the CURRENT plan: "ready" (deciding whether to
// approve) and "approved" (what is about to be implemented). Superseded states
// (edited/discussed/stopped/…) point at a plan that changed or is moot, so they
// stay link-only and send the reader to Cycloid for the latest.
const PLAN_BODY_STATES = new Set<PlanApprovalMessageState>(["ready", "approved"]);

// Slack section `text` mrkdwn caps at 3000 chars; keep headroom for the
// truncation footer and mrkdwn expansion.
const PLAN_SLACK_MAX_CHARS = 2800;

/**
 * Best-effort GitHub-markdown -> Slack mrkdwn conversion for the two glyphs that
 * render literally in Slack: `**bold**`/`__bold__` (Slack bold is single `*`)
 * and ATX `#` headings (rendered as bold lines). Links `[t](u)` become `<u|t>`.
 * Bullets, numbered lists, and code fences already render acceptably as-is.
 *
 * Plan text is model/user/repo-derived, so it is first escaped for Slack's three
 * control characters (`&`, `<`, `>`) BEFORE any mrkdwn markup is introduced. This
 * neutralizes embedded Slack control sequences - `<!here>`, `<!channel>`,
 * `<@U123>`, `<!subteam^…>` - which would otherwise ping people or render as
 * mentions rather than showing the literal plan. Our own emitted markup (`*bold*`,
 * `<url|label>`) is added after escaping so its control characters survive; the
 * link URL is un-escaped in the replacement so query `&`s are not mangled.
 */
export function planMarkdownToSlackMrkdwn(markdown: string): string {
  const escaped = markdown.replace(/\r\n/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    escaped
      // [text](url) -> <url|text>. The URL char class allows one level of balanced
      // parentheses so links like `…/C_(programming_language)` are not truncated at
      // the first `)`. The captured URL is un-escaped (raw `&`) for Slack.
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s()]+(?:\([^\s)]*\)[^\s()]*)*)\)/g,
        (_match, label: string, url: string) => `<${url.replace(/&amp;/g, "&")}|${label}>`,
      )
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/__([^_\n]+)__/g, "*$1*")
      .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, "*$1*")
      .trim()
  );
}

function truncatePlanForSlack(text: string, url: string): string {
  if (text.length <= PLAN_SLACK_MAX_CHARS) return text;
  const slice = text.slice(0, PLAN_SLACK_MAX_CHARS);
  const lastBreak = slice.lastIndexOf("\n");
  const body = lastBreak > PLAN_SLACK_MAX_CHARS * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${body.trimEnd()}\n\n_Plan truncated. <${url}|Open in Cycloid> for the full plan._`;
}

/**
 * Resolve the plan body Slack block for a plan-body state, or null to keep the
 * link-only notice.
 *
 * `planMarkdown` contract:
 *  - `string` - use it verbatim (DO-resident callers pass the plan they already
 *    hold in `this.sql`, avoiding a re-entrant DO self-fetch).
 *  - `null` - the DO looked and there is no plan text; render link-only.
 *  - `undefined` - worker-side caller with no plan in hand; fetch it from the
 *    session DO (worker -> DO is the safe direction). Fetch failures fall back
 *    to link-only.
 */
async function resolvePlanBodyBlock(
  env: Env,
  sessionId: string,
  url: string,
  planMarkdown: string | null | undefined,
): Promise<PlanApprovalMessage["blocks"][number] | null> {
  const markdown = (
    planMarkdown === undefined ? (await getSessionPlanMarkdown(env, sessionId))?.markdown : planMarkdown
  )?.trim();
  if (!markdown) return null;
  const text = truncatePlanForSlack(planMarkdownToSlackMrkdwn(markdown), url);
  return { type: "section", text: { type: "mrkdwn", text } };
}

function buildMessage(
  env: Env,
  sessionId: string,
  state: PlanApprovalMessageState,
  requestId: string | null = null,
  planBodyBlock: PlanApprovalMessage["blocks"][number] | null = null,
): PlanApprovalMessage {
  const url = sessionUrl(env, sessionId);
  const copy = {
    ready: ["Your plan is ready to review.", "The plan is attached to this message. Edit or discuss it in Cycloid."],
    retry: ["We couldn't approve the plan. Please try again.", "You can also review the plan in Cycloid."],
    approved: ["Plan approved. Implementation is starting.", "View the session in Cycloid."],
    stale: ["The plan changed since this button was created.", "Review the latest plan in Cycloid."],
    unavailable: ["Plan approval is unavailable from this message.", "Open the session in Cycloid."],
    edited: ["The plan was edited.", "Review the latest plan in Cycloid."],
    discussed: ["The plan is being revised.", "Review the latest plan in Cycloid."],
    stopped: ["The session was stopped.", "Open the session in Cycloid to continue."],
    archived: ["The session was archived.", "View the session in Cycloid."],
  } as const;
  const [headline, linkCopy] = copy[state];
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headline}*\n<${url}|${linkCopy}>` },
    },
  ];
  if (planBodyBlock) blocks.push(planBodyBlock);
  if (requestId) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: slackInteractionActionId(SlackInteractionKind.ApprovePlan, requestId),
        },
      ],
    });
  }
  return { text: `${headline}\n\n${linkCopy} ${url}`, blocks };
}

async function updateWithToken(
  env: Env,
  row: Pick<SlackInteractionRequestRecord, "sessionId" | "slackChannelId" | "messageTs">,
  botToken: string,
  state: Parameters<typeof buildMessage>[2],
  requestId: string | null,
  planMarkdown: string | null | undefined = undefined,
): Promise<boolean> {
  if (!row.messageTs) return false;
  const planBodyBlock = PLAN_BODY_STATES.has(state)
    ? await resolvePlanBodyBlock(env, row.sessionId, sessionUrl(env, row.sessionId), planMarkdown)
    : null;
  const message = buildMessage(env, row.sessionId, state, requestId, planBodyBlock);
  const result = await updateMessage(botToken, row.slackChannelId, row.messageTs, message.text, message.blocks);
  return result.ok;
}

async function postPlanThreadReply(
  // ci-sync
  env: Env,
  params: {
    sessionId: string;
    slackChannelId: string;
    messageTs: string;
    botToken: string;
    planMarkdown: string | null;
  },
): Promise<void> {
  const markdown = params.planMarkdown?.trim();
  if (!markdown) return;

  try {
    const result = await uploadFile(
      params.botToken,
      params.slackChannelId,
      params.messageTs,
      `plan-${params.sessionId}.md`,
      markdown,
      "Here's the full plan.",
    );
    if (result.ok) return;
    if (result.error === "missing_scope") {
      log.debug(
        { action: "plan_ready_thread_file", sessionId: params.sessionId, error: result.error },
        "Slack plan file upload unavailable for this workspace; using inline fallback",
      );
    } else {
      log.warn(
        { action: "plan_ready_thread_file", sessionId: params.sessionId, error: result.error },
        "Slack plan file upload failed; using inline fallback",
      );
    }
  } catch (error) {
    log.warn(
      { action: "plan_ready_thread_file", sessionId: params.sessionId, error: String(error) },
      "Slack plan file upload threw; using inline fallback",
    );
  }

  try {
    const block = await resolvePlanBodyBlock(env, params.sessionId, sessionUrl(env, params.sessionId), markdown);
    if (!block) return;
    const result = await postThreadReply(
      params.botToken,
      params.slackChannelId,
      params.messageTs,
      "Here's the full plan.",
      [block],
    );
    if (!result.ok) {
      log.warn(
        { action: "plan_ready_thread_reply", sessionId: params.sessionId, error: result.error },
        "Slack plan thread fallback failed",
      );
    }
  } catch (error) {
    log.warn(
      { action: "plan_ready_thread_reply", sessionId: params.sessionId, error: String(error) },
      "Slack plan thread fallback threw",
    );
  }
}

export async function publishPlanApprovalInteractionButton(
  env: Env,
  params: {
    businessId: string;
    sessionId: string;
    revision: number;
    slackTeamId: string;
    slackChannelId: string;
    messageTs: string;
    botToken: string;
    // The DO holds the plan in `this.sql`; pass it so the ready message renders
    // it inline without a re-entrant DO self-fetch. `null` = no plan text.
    planMarkdown: string | null;
  },
): Promise<string | null> {
  await supersedePlanApprovalInteractionRequests(env, params.sessionId, "discussed");
  const requestId = await insertInteractionRequest(env.DB, {
    businessId: params.businessId,
    sessionId: params.sessionId,
    kind: SlackInteractionKind.ApprovePlan,
    payloadJson: JSON.stringify({ revision: params.revision } satisfies PlanApprovalRequestPayload),
    slackTeamId: params.slackTeamId,
    slackChannelId: params.slackChannelId,
    messageTs: params.messageTs,
    expiresAt: null,
  });
  const row = {
    sessionId: params.sessionId,
    slackChannelId: params.slackChannelId,
    messageTs: params.messageTs,
  };
  try {
    if (await updateWithToken(env, row, params.botToken, "ready", requestId, null)) {
      await postPlanThreadReply(env, {
        sessionId: params.sessionId,
        slackChannelId: params.slackChannelId,
        messageTs: params.messageTs,
        botToken: params.botToken,
        planMarkdown: params.planMarkdown,
      });
      return requestId;
    }
  } catch (error) {
    log.warn(
      { action: "plan_approval_button_publish", sessionId: params.sessionId, requestId, error: String(error) },
      "Plan approval button publish failed",
    );
  }
  await supersedeInteractionRequest(env.DB, requestId);
  return null;
}

export async function updatePlanApprovalInteractionMessage(
  env: Env,
  row: SlackInteractionRequestRecord,
  state: PlanApprovalInteractionMessageState,
): Promise<void> {
  if (!env.TOKEN_ENCRYPTION_KEY || !row.messageTs) return;
  try {
    const botToken = await getBotTokenForTeam(env.DB, row.slackTeamId, env.TOKEN_ENCRYPTION_KEY);
    if (!botToken) return;
    await updateWithToken(env, row, botToken, state, null);
  } catch (error) {
    // Approval state is already authoritative by the time success/stale copy
    // is rendered. A Slack failure must never masquerade as a pre-commit
    // approval failure and mint a live replacement button.
    log.warn(
      {
        action: "plan_approval_message_update",
        sessionId: row.sessionId,
        requestId: row.id,
        state,
        error: String(error),
      },
      "Plan approval outcome DM update failed",
    );
  }
}

export async function replacePlanApprovalInteractionRequest(
  env: Env,
  consumed: SlackInteractionRequestRecord,
): Promise<string | null> {
  if (!env.TOKEN_ENCRYPTION_KEY || !consumed.messageTs) return null;
  const existing = await getNewestPending(env.DB, consumed.sessionId, SlackInteractionKind.ApprovePlan);
  if (existing) return existing.id;
  const botToken = await getBotTokenForTeam(env.DB, consumed.slackTeamId, env.TOKEN_ENCRYPTION_KEY);
  if (!botToken) return null;
  const requestId = await insertInteractionRequest(env.DB, {
    businessId: consumed.businessId,
    sessionId: consumed.sessionId,
    kind: SlackInteractionKind.ApprovePlan,
    payloadJson: consumed.payloadJson,
    slackTeamId: consumed.slackTeamId,
    slackChannelId: consumed.slackChannelId,
    messageTs: consumed.messageTs,
    expiresAt: null,
  });
  try {
    if (await updateWithToken(env, consumed, botToken, "retry", requestId)) return requestId;
  } catch (error) {
    log.warn(
      { action: "plan_approval_button_replace", sessionId: consumed.sessionId, requestId, error: String(error) },
      "Plan approval replacement button publish failed",
    );
  }
  await supersedeInteractionRequest(env.DB, requestId);
  return null;
}

export async function supersedePlanApprovalInteractionRequests(
  env: Env,
  sessionId: string,
  reason: PlanApprovalSupersessionReason,
  // Only the D1 supersession must complete before a replacement row is minted;
  // the Slack repaint retries on 429s and can be handed off (e.g. ctx.waitUntil)
  // by latency-sensitive callers. The handed-off promise never rejects: per-row
  // failures are caught and logged internally.
  options?: {
    deferSlackUpdates?: (work: Promise<void>) => void;
    // Supplied by the DO for reason "approved" so the resolved message renders
    // the plan inline without a re-entrant DO self-fetch. Ignored for
    // non-plan-body reasons (edited/discussed/stopped/archived).
    planMarkdown?: string | null;
  },
): Promise<void> {
  const pending = await listPendingInteractionRequests(env.DB, sessionId, SlackInteractionKind.ApprovePlan);
  if (pending.length === 0) return;
  await supersedePending(env.DB, sessionId, SlackInteractionKind.ApprovePlan, Date.now());
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return;

  const slackUpdates = Promise.all(
    pending.map(async (row) => {
      if (!row.messageTs) return;
      try {
        const botToken = await getBotTokenForTeam(env.DB, row.slackTeamId, encryptionKey);
        if (!botToken) return;
        await updateWithToken(env, row, botToken, reason, null, options?.planMarkdown ?? null);
      } catch (error) {
        log.warn(
          { action: "plan_approval_button_supersede", sessionId, requestId: row.id, reason, error: String(error) },
          "Plan approval button disable failed",
        );
      }
    }),
  ).then(() => undefined);
  if (options?.deferSlackUpdates) {
    options.deferSlackUpdates(slackUpdates);
    return;
  }
  await slackUpdates;
}

export function parsePlanApprovalInteractionPayload(payloadJson: string): PlanApprovalRequestPayload | null {
  try {
    const value = JSON.parse(payloadJson) as unknown;
    if (!value || typeof value !== "object") return null;
    const revision = (value as { revision?: unknown }).revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) return null;
    return { revision };
  } catch {
    return null;
  }
}

export function planApprovalRequestMatchesBusiness(
  row: SlackInteractionRequestRecord,
  sessionBusinessId: string | null | undefined,
): boolean {
  return Boolean(sessionBusinessId && businessIdsMatch(row.businessId, sessionBusinessId));
}
