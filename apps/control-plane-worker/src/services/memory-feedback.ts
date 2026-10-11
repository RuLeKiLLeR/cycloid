import { recordMemoryConclusionFeedback } from "../company-memory/context-db";
import { createMemoryContextMetricSink } from "../company-memory/context-metrics";
import { createLogger } from "../logger";
import { memoryUsageFeedbackTargetExists, updateMemoryUsageReviewOutcome } from "../memory/db";
import {
  buildMemoryFeedbackKey,
  getLatestMemoryFeedbackForSessionUser,
  insertMemoryFeedback,
  type MemoryFeedbackDisplayEventType,
  type MemoryFeedbackRating,
  type MemoryFeedbackRow,
  type MemoryFeedbackUsageSource,
  updateMemoryFeedbackSlackDelivery,
} from "../session/memory-feedback-db";
import { assertDatabase } from "../session/state";
import { postInternalAlert } from "../slack/internal-alerts";
import { MEMORY_FEEDBACK_CHANNEL_ID } from "../slack/internal-channels";
import type { Env } from "../types";
import { resolvePublicSessionUrl } from "./public-url";

const log = createLogger({ bindings: { component: "memory-feedback-service" } });

const MEMORY_FEEDBACK_MESSAGE_MAX_LENGTH = 2000;
const MEMORY_FEEDBACK_SNAPSHOT_MAX_LENGTH = 2000;
const MEMORY_FEEDBACK_ID_MAX_LENGTH = 256;
const SLACK_ERROR_MAX_LENGTH = 500;
const SLACK_SECTION_TEXT_MAX_LENGTH = 2900;

type MemoryFeedbackSessionContext = {
  businessId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
};

type MemoryFeedbackAuthContext = {
  userId: string;
  userLogin?: string | null;
};

type MemoryFeedbackPayload = {
  promptId: string;
  activityEventId: string;
  displayEventType: MemoryFeedbackDisplayEventType;
  usageSource: MemoryFeedbackUsageSource;
  memoryId: string;
  rating: MemoryFeedbackRating;
  message: string | null;
  memoryTitle: string | null;
  memoryPath: string | null;
  memoryReason: string | null;
  memoryExpectedEffect: string | null;
  memoryObservedEffect: string | null;
};

export type MemoryFeedbackApiEntry = {
  feedbackKey: string;
  promptId: string;
  activityEventId: string;
  displayEventType: MemoryFeedbackDisplayEventType;
  usageSource: MemoryFeedbackUsageSource;
  memoryId: string;
  rating: MemoryFeedbackRating;
  message: string | null;
  createdAt: number;
};

export type SubmitMemoryFeedbackResult = { ok: true; feedback: MemoryFeedbackApiEntry } | { ok: false; error: string };

type ReviewableMemoryUsageSource = "prompt_start" | "recall" | "company_bootstrap" | "company_recall";

function boundedTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function configuredEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "CHANGE_ME") return null;
  return trimmed;
}

function requiredBoundedId(value: unknown): string | null {
  const trimmed = boundedTrimmedString(value, MEMORY_FEEDBACK_ID_MAX_LENGTH);
  if (!trimmed) return null;
  return /^[A-Za-z0-9_.:/@-]+$/.test(trimmed) ? trimmed : null;
}

function parseMemoryFeedbackPayload(payload: Record<string, unknown>): MemoryFeedbackPayload | { error: string } {
  const promptId = requiredBoundedId(payload.promptId);
  if (!promptId) return { error: "promptId is required" };
  const activityEventId = requiredBoundedId(payload.activityEventId);
  if (!activityEventId) return { error: "activityEventId is required" };
  const memoryId = requiredBoundedId(payload.memoryId);
  if (!memoryId) return { error: "memoryId is required" };

  const displayEventType = payload.displayEventType;
  if (displayEventType !== "memory_usage" && displayEventType !== "memory_recall_usage") {
    return { error: "displayEventType is invalid" };
  }
  const usageSource = payload.usageSource;
  if (
    usageSource !== "prompt_start" &&
    usageSource !== "recall" &&
    usageSource !== "company_bootstrap" &&
    usageSource !== "company_recall"
  ) {
    return { error: "usageSource is invalid" };
  }
  if (displayEventType === "memory_usage" && (usageSource === "recall" || usageSource === "company_recall")) {
    return { error: "memory_usage feedback cannot use recall source" };
  }
  if (displayEventType === "memory_recall_usage" && usageSource !== "recall" && usageSource !== "company_recall") {
    return { error: "memory_recall_usage feedback must use recall source" };
  }

  const rating = payload.rating;
  if (rating !== "up" && rating !== "down") return { error: "rating must be 'up' or 'down'" };

  return {
    promptId,
    activityEventId,
    displayEventType,
    usageSource,
    memoryId,
    rating,
    message: boundedTrimmedString(payload.message, MEMORY_FEEDBACK_MESSAGE_MAX_LENGTH),
    memoryTitle: boundedTrimmedString(payload.memoryTitle, MEMORY_FEEDBACK_SNAPSHOT_MAX_LENGTH),
    memoryPath: boundedTrimmedString(payload.memoryPath, MEMORY_FEEDBACK_SNAPSHOT_MAX_LENGTH),
    memoryReason: boundedTrimmedString(payload.memoryReason, MEMORY_FEEDBACK_SNAPSHOT_MAX_LENGTH),
    memoryExpectedEffect: boundedTrimmedString(payload.memoryExpectedEffect, MEMORY_FEEDBACK_SNAPSHOT_MAX_LENGTH),
    memoryObservedEffect: boundedTrimmedString(payload.memoryObservedEffect, MEMORY_FEEDBACK_SNAPSHOT_MAX_LENGTH),
  };
}

function slackEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function boundedSlackSectionText(value: string): string {
  if (value.length <= SLACK_SECTION_TEXT_MAX_LENGTH) return value;
  return `${value.slice(0, SLACK_SECTION_TEXT_MAX_LENGTH - 3)}...`;
}

function memoryFeedbackEventLabel(displayEventType: MemoryFeedbackDisplayEventType): string {
  return displayEventType === "memory_usage" ? "Memory Applied" : "Memory Recalled";
}

function memoryFeedbackFallbackText(row: MemoryFeedbackRow): string {
  const emoji = row.rating === "up" ? ":thumbsup:" : ":thumbsdown:";
  const user = row.user_login ?? row.user_id;
  const repo = row.repo_owner && row.repo_name ? `${row.repo_owner}/${row.repo_name}` : "unknown repo";
  const memoryLabel = row.memory_title ?? row.memory_id;
  return [
    `${emoji} Memory feedback: ${row.rating} from ${user} on ${repo}`,
    `Session: ${row.session_url ?? row.session_id}`,
    `Memory: ${memoryLabel} (${row.memory_id})`,
    `Event: ${memoryFeedbackEventLabel(row.display_event_type)} / ${row.usage_source}`,
  ].join("\n");
}

function memoryFeedbackSlackBlocks(row: MemoryFeedbackRow): unknown[] {
  const emoji = row.rating === "up" ? ":thumbsup:" : ":thumbsdown:";
  const fields = [
    `*User:*\n${slackEscape(row.user_login ?? row.user_id)}`,
    row.repo_owner && row.repo_name ? `*Repo:*\n${slackEscape(`${row.repo_owner}/${row.repo_name}`)}` : null,
    row.session_url ? `*Session:*\n<${row.session_url}|Open session>` : `*Session:*\n${slackEscape(row.session_id)}`,
    `*Prompt:*\n${slackEscape(row.prompt_id)}`,
    `*Memory event:*\n${memoryFeedbackEventLabel(row.display_event_type)}`,
    `*Source:*\n${row.usage_source}`,
  ].filter((field): field is string => Boolean(field));

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${emoji} *Memory feedback: ${row.rating}*` },
    },
    { type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedSlackSectionText(
          [
            `*Memory:*\n${slackEscape(row.memory_title ?? row.memory_id)}`,
            row.memory_path ? `*Path:* \`${slackEscape(row.memory_path)}\`` : null,
            `*ID:* \`${slackEscape(row.memory_id)}\``,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      },
    },
  ];

  if (row.message) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `>${slackEscape(row.message)}` } });
  }

  const contextLines = [
    row.memory_reason ? `*Why this mattered:*\n${slackEscape(row.memory_reason)}` : null,
    row.memory_expected_effect || row.memory_observed_effect
      ? `*How it steered:*\n${slackEscape(row.memory_observed_effect ?? row.memory_expected_effect ?? "")}`
      : null,
  ].filter((line): line is string => Boolean(line));
  if (contextLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: boundedSlackSectionText(contextLines.join("\n\n")) },
    });
  }

  return blocks;
}

function memoryFeedbackApiShape(row: MemoryFeedbackRow): MemoryFeedbackApiEntry {
  return {
    feedbackKey: row.feedback_key,
    promptId: row.prompt_id,
    activityEventId: row.activity_event_id,
    displayEventType: row.display_event_type,
    usageSource: row.usage_source,
    memoryId: row.memory_id,
    rating: row.rating,
    message: row.message,
    createdAt: row.created_at,
  };
}

function sessionRepoContext(session: MemoryFeedbackSessionContext): {
  repoOwner: string | null;
  repoName: string | null;
} {
  return {
    repoOwner: typeof session.repoOwner === "string" && session.repoOwner.trim() ? session.repoOwner.trim() : null,
    repoName: typeof session.repoName === "string" && session.repoName.trim() ? session.repoName.trim() : null,
  };
}

function graphConclusionIdFromFeedbackMemoryId(memoryId: string): string | null {
  const trimmed = memoryId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("memory_conclusion:")) return trimmed.slice("memory_conclusion:".length).trim() || null;
  return trimmed.includes(":") ? null : trimmed;
}

async function resolveFeedbackTargetSource(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    memoryId: string;
    displayEventType: MemoryFeedbackDisplayEventType;
    usageSource: ReviewableMemoryUsageSource;
  },
): Promise<ReviewableMemoryUsageSource | null> {
  if (
    await memoryUsageFeedbackTargetExists(db, {
      sessionId: params.sessionId,
      promptId: params.promptId,
      memoryId: params.memoryId,
      source: params.usageSource,
    })
  ) {
    return params.usageSource;
  }

  if (params.displayEventType !== "memory_usage" || params.usageSource !== "company_bootstrap") return null;

  const promptStartExists = await memoryUsageFeedbackTargetExists(db, {
    sessionId: params.sessionId,
    promptId: params.promptId,
    memoryId: params.memoryId,
    source: "prompt_start",
  });
  return promptStartExists ? "prompt_start" : null;
}

export async function submitMemoryFeedback(params: {
  env: Env;
  sessionId: string;
  session: MemoryFeedbackSessionContext;
  auth: MemoryFeedbackAuthContext;
  payload: Record<string, unknown>;
}): Promise<SubmitMemoryFeedbackResult> {
  const parsed = parseMemoryFeedbackPayload(params.payload);
  if ("error" in parsed) return { ok: false, error: parsed.error };

  const db = assertDatabase(params.env);
  const targetSource = await resolveFeedbackTargetSource(db, {
    sessionId: params.sessionId,
    promptId: parsed.promptId,
    memoryId: parsed.memoryId,
    displayEventType: parsed.displayEventType,
    usageSource: parsed.usageSource,
  });
  if (!targetSource) return { ok: false, error: "memory feedback target is invalid" };

  const sessionUrl = resolvePublicSessionUrl(params.env, params.sessionId);
  const feedbackKey = buildMemoryFeedbackKey({
    sessionId: params.sessionId,
    promptId: parsed.promptId,
    activityEventId: parsed.activityEventId,
    memoryId: parsed.memoryId,
    userId: params.auth.userId,
  });
  const repoContext = sessionRepoContext(params.session);
  const row = await insertMemoryFeedback(db, {
    id: crypto.randomUUID(),
    feedbackKey,
    sessionId: params.sessionId,
    promptId: parsed.promptId,
    activityEventId: parsed.activityEventId,
    displayEventType: parsed.displayEventType,
    usageSource: targetSource,
    memoryId: parsed.memoryId,
    userId: params.auth.userId,
    userLogin: params.auth.userLogin ?? null,
    rating: parsed.rating,
    message: parsed.message,
    memoryTitle: parsed.memoryTitle,
    memoryPath: parsed.memoryPath,
    memoryReason: parsed.memoryReason,
    memoryExpectedEffect: parsed.memoryExpectedEffect,
    memoryObservedEffect: parsed.memoryObservedEffect,
    repoOwner: repoContext.repoOwner,
    repoName: repoContext.repoName,
    sessionUrl,
  });

  try {
    await updateMemoryUsageReviewOutcome(db, {
      sessionId: params.sessionId,
      promptId: parsed.promptId,
      memoryId: parsed.memoryId,
      source: targetSource,
      reviewOutcome: parsed.rating === "up" ? "helpful" : "incorrect",
    });
    if (parsed.displayEventType === "memory_recall_usage") {
      createMemoryContextMetricSink(params.env).emit({
        event: parsed.rating === "up" ? "memory_context.feedback_upvoted" : "memory_context.feedback_downvoted",
        sessionId: params.sessionId,
        repoOwner: repoContext.repoOwner,
        repoName: repoContext.repoName,
        memoryId: parsed.memoryId,
        rating: parsed.rating,
        usageSource: targetSource,
      });
    }
  } catch (err) {
    log.error(
      { err, sessionId: params.sessionId, memoryId: parsed.memoryId },
      "Failed to update memory usage feedback aggregate",
    );
  }

  const graphConclusionId = graphConclusionIdFromFeedbackMemoryId(parsed.memoryId);
  if (params.session.businessId && graphConclusionId) {
    try {
      await recordMemoryConclusionFeedback(db, {
        businessId: params.session.businessId,
        conclusionId: graphConclusionId,
        rating: parsed.rating,
        nowMs: Date.now(),
      });
    } catch (err) {
      log.error(
        { err, sessionId: params.sessionId, memoryId: parsed.memoryId, conclusionId: graphConclusionId },
        "Failed to update memory conclusion feedback aggregate",
      );
    }
  }

  const slackToken = configuredEnvValue(params.env.SLACK_BOT_TOKEN);
  const slackChannel = MEMORY_FEEDBACK_CHANNEL_ID;
  if (!slackToken) {
    await updateMemoryFeedbackSlackDelivery(db, { id: row.id, status: "skipped_config" });
    return { ok: true, feedback: memoryFeedbackApiShape(row) };
  }

  // Config presence is already verified above, so postInternalAlert only returns
  // null here when the underlying Slack call threw (it swallows it) -> record as
  // failed, matching the prior try/catch default. Pass the row id as logContext
  // so the helper's exception log (which has the real error message) can be
  // correlated to this delivery record.
  const slackResp = await postInternalAlert(
    params.env,
    slackChannel,
    memoryFeedbackFallbackText(row),
    memoryFeedbackSlackBlocks(row),
    { memoryFeedbackId: row.id },
  );
  if (slackResp?.ok) {
    await updateMemoryFeedbackSlackDelivery(db, {
      id: row.id,
      status: "sent",
      channelId: slackResp.channel ?? slackChannel,
      messageTs: slackResp.ts ?? null,
    });
  } else {
    // When slackResp is null the underlying call threw; postInternalAlert already
    // logged the exception under memoryFeedbackId, but slackResp?.error is
    // undefined so this record only captures the generic fallback. The error
    // string is recoverable from the correlated log entry.
    await updateMemoryFeedbackSlackDelivery(db, {
      id: row.id,
      status: "failed",
      channelId: slackChannel,
      error: boundedTrimmedString(slackResp?.error, SLACK_ERROR_MAX_LENGTH) ?? "Slack post failed",
    });
  }

  return { ok: true, feedback: memoryFeedbackApiShape(row) };
}

export async function getLatestMemoryFeedbackForUser(params: {
  env: Env;
  sessionId: string;
  userId: string;
}): Promise<MemoryFeedbackApiEntry[]> {
  const rows = await getLatestMemoryFeedbackForSessionUser(assertDatabase(params.env), params.sessionId, params.userId);
  return rows.map(memoryFeedbackApiShape);
}
