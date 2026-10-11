import { stringifyError } from "../../../../shared/utils/errors.js";
import type { Logger } from "../logger";
import { resolvePublicSessionUrl } from "../services/public-url";
import { MEMORY_FEEDBACK_CHANNEL_ID } from "../slack/internal-channels";
import { postMessage } from "../slack/notify";
import type { Env } from "../types";
import {
  insertMemoryReviewBotRunResults,
  listPendingMemoryReviewBotDigestRuns,
  markMemoryReviewBotDigestRunsSlackDelivery,
  type MemoryReviewBotDigestRun,
  updateMemoryReviewBotRunSessionEventDelivery,
} from "./review-db";
import { runMemoryReviewReviewer, type RunMemoryReviewReviewerDeps } from "./reviewer";
import {
  MEMORY_REVIEW_BOT_DEFAULT_MODEL,
  MEMORY_REVIEW_BOT_PROMPT_VERSION,
  MEMORY_REVIEW_BOT_SCHEMA_VERSION,
  type MemoryReviewBotFailureCode,
  type MemoryReviewBotRun,
  type MemoryReviewCompletedPromptContext,
  type MemoryReviewEffect,
  type MemoryReviewEvidence,
  type MemoryReviewInput,
  type MemoryReviewLifecycleState,
  type MemoryReviewMemorySnapshot,
  type MemoryReviewOutput,
  type MemoryReviewRecallResult,
  type MemoryReviewReturnedMemory,
  type MemoryReviewScopeDefect,
  type MemoryReviewScopeStatus,
  type MemoryReviewUsageEvent,
  type MemoryReviewUsageSource,
} from "./types";

const SYNTHETIC_PROMPT_IDS = new Set(["company-memory-recall", "company-memory-reasoning-chain"]);
const ELIGIBLE_USAGE_SOURCES = new Set<string>(["recall", "company_recall"]);
const MEMORY_TEXT_MAX_CHARS = 1_200;
const SLACK_ERROR_MAX_LENGTH = 500;
const SLACK_SECTION_TEXT_MAX_LENGTH = 2900;
const DAILY_DIGEST_CURSOR_JOB = "memory_review_bot_daily_digest";
const DAILY_DIGEST_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CompletionDbRow {
  businessId: string;
  sessionId: string;
  promptId: string;
  repoOwner: string | null;
  repoName: string | null;
  promptText: string;
  title: string | null;
  diffSummary: string | null;
  success: number;
  completedAtMs: number;
}

interface RepoMemoryDbRow {
  memoryId: string;
  status: "active" | "superseded";
  contextHint: string;
  content: string;
  memoryJson: string;
}

interface MemoryFactDbRow {
  id: string;
  status: "active" | "expired" | "superseded" | "rejected";
  kind: string;
  claim: string;
  holder: string;
  confidence: number;
  sourceEventId: string;
}

interface MemoryTakeDbRow {
  id: string;
  kind: string;
  claim: string;
  holder: string;
  weight: number;
  active: number;
  supersededBy: string | null;
}

interface MemoryConclusionReviewDbRow {
  id: string;
  status: MemoryReviewLifecycleState;
  kind: string;
  content: string;
  level: string;
  confidence: string;
  enforcement: string;
  sourceKind: string | null;
  sourceId: string | null;
}

interface MemoryMessageReviewDbRow {
  id: string;
  role: string;
  contentText: string;
  sourceUri: string | null;
  occurredAtMs: number;
}

interface MemoryContextQueryReviewDbRow {
  id: string;
  intent: string;
  selectorStatus: string;
  selectedIdsJson: string;
  candidateIdsJson: string;
  rejectedJson: string;
  vectorAvailable: number;
  vectorUnavailableReason: string | null;
  createdAtMs: number;
}

export type MemoryReviewEligibilityResult =
  | { eligible: true; input: MemoryReviewInput }
  | { eligible: false; reason: MemoryReviewBotFailureCode; message: string };

export type MemoryReviewMemoryCatalog = Map<string, MemoryReviewMemorySnapshot>;

export type RunMemoryReviewBotForCompletedPromptResult =
  | { status: "complete"; runId: string }
  | { status: "skipped"; reason: MemoryReviewBotFailureCode }
  | { status: "failed"; failureCode: MemoryReviewBotFailureCode };

type MemoryReviewLogger = Pick<Logger, "info" | "warn" | "error">;

export function selectEligibleMemoryUsageEvents(
  context: MemoryReviewCompletedPromptContext,
  usageEvents: MemoryReviewUsageEvent[],
): MemoryReviewUsageEvent[] {
  if (!context.success || SYNTHETIC_PROMPT_IDS.has(context.promptId)) return [];
  return usageEvents.filter((event) => {
    if (event.sessionId !== context.sessionId) return false;
    if (!event.memoryId.trim()) return false;
    if (!ELIGIBLE_USAGE_SOURCES.has(event.source)) return false;
    if (event.source === "company_recall" && SYNTHETIC_PROMPT_IDS.has(event.promptId)) return false;
    if (event.promptId === context.promptId) return true;
    if (SYNTHETIC_PROMPT_IDS.has(event.promptId)) return false;
    if (event.source !== "recall") return false;
    if (event.usedAtMs > context.completedAtMs) return false;
    return true;
  });
}

export function buildMemoryReviewInputFromContext(
  context: MemoryReviewCompletedPromptContext,
  usageEvents: MemoryReviewUsageEvent[],
  memoryCatalog: MemoryReviewMemoryCatalog,
  options: { allowEmptyReview?: boolean; contextQueryEvidence?: MemoryReviewEvidence[] } = {},
): MemoryReviewEligibilityResult {
  if (!context.success) {
    return { eligible: false, reason: "failed_prompt", message: "Prompt did not complete successfully" };
  }
  if (SYNTHETIC_PROMPT_IDS.has(context.promptId)) {
    return { eligible: false, reason: "no_eligible_memory_usage", message: "Synthetic memory prompt is excluded" };
  }

  const eligibleEvents = dedupeUsageEvents(selectEligibleMemoryUsageEvents(context, usageEvents));
  if (eligibleEvents.length === 0 && options.allowEmptyReview !== true) {
    return { eligible: false, reason: "no_eligible_memory_usage", message: "No prompt-linked recall usage events" };
  }

  const evidence: MemoryReviewEvidence[] = [
    {
      id: "prompt",
      kind: "prompt" as const,
      text: context.promptText.slice(0, 4_000),
    },
    {
      id: "completion",
      kind: "completion" as const,
      text: [context.title, context.diffSummary].filter(Boolean).join("\n").slice(0, 4_000) || "No completion summary.",
    },
    ...(options.contextQueryEvidence ?? []),
  ];
  const returnedMemories: MemoryReviewReturnedMemory[] = [];
  const scopeDefects: MemoryReviewScopeDefect[] = [];

  for (const event of eligibleEvents) {
    const source = event.source as MemoryReviewUsageSource;
    const usageEvidenceId = `usage:${event.memoryId}`;
    const memoryEvidenceId = `memory:${event.memoryId}`;
    const scopeEvidenceId = `scope:${event.memoryId}`;
    evidence.push({
      id: usageEvidenceId,
      kind: "usage",
      memoryId: event.memoryId,
      text: summarizeUsageEvent(event),
    });

    const scopedMemory = isUsageEventInScope(context, event) ? memoryCatalog.get(event.memoryId) : undefined;
    const scopeStatus: MemoryReviewScopeStatus = scopedMemory ? "in_scope" : "out_of_scope";
    const evidenceIds = [usageEvidenceId];

    if (scopedMemory) {
      evidence.push({
        id: memoryEvidenceId,
        kind: "memory",
        memoryId: event.memoryId,
        text: [scopedMemory.contextHint, scopedMemory.content]
          .filter(Boolean)
          .join("\n")
          .slice(0, MEMORY_TEXT_MAX_CHARS),
      });
      evidenceIds.push(memoryEvidenceId);
    } else {
      const reason = isUsageEventInScope(context, event) ? "memory_not_found_in_scope" : "repo_scope_mismatch";
      evidence.push({
        id: scopeEvidenceId,
        kind: "scope_defect",
        memoryId: event.memoryId,
        text:
          reason === "repo_scope_mismatch"
            ? `Usage event repo ${event.repoOwner ?? "unknown"}/${event.repoName ?? "unknown"} did not match prompt repo ${context.repoOwner ?? "unknown"}/${context.repoName ?? "unknown"}.`
            : "Usage event referenced a memory ID that was not found in the scoped memory tables.",
      });
      evidenceIds.push(scopeEvidenceId);
      scopeDefects.push({ memoryId: event.memoryId, source, reason, usageEvidenceId });
    }

    returnedMemories.push({
      memoryId: event.memoryId,
      source,
      lifecycleState: scopedMemory?.lifecycleState ?? "unknown",
      scopeStatus,
      content: scopedMemory?.content ?? null,
      contextHint: scopedMemory?.contextHint ?? null,
      provenance: scopedMemory?.provenance ?? null,
      rank: event.selectionRank,
      score: event.selectionScore,
      explanation: event.explanation,
      expectedEffect: event.expectedEffect,
      observedEffect: event.observedEffect,
      intent: event.intent,
      files: parseStringArrayJson(event.filesJson),
      symbols: parseStringArrayJson(event.symbolsJson),
      evidenceIds,
    });
  }

  return {
    eligible: true,
    input: {
      schemaVersion: MEMORY_REVIEW_BOT_SCHEMA_VERSION,
      businessId: context.businessId,
      sessionId: context.sessionId,
      promptId: context.promptId,
      repoOwner: context.repoOwner,
      repoName: context.repoName,
      task: {
        promptText: context.promptText,
        title: context.title,
        diffSummary: context.diffSummary,
        completedAtMs: context.completedAtMs,
      },
      returnedMemories,
      evidence,
      scopeDefects,
    },
  };
}

export async function loadMemoryReviewInputForCompletedPrompt(
  db: D1Database,
  params: { businessId: string; sessionId: string; promptId: string },
): Promise<MemoryReviewEligibilityResult> {
  const [completionResult, usageResult] = await db.batch([
    db
      .prepare(
        `SELECT business_id AS businessId,
                session_id AS sessionId,
                prompt_id AS promptId,
                repo_owner AS repoOwner,
                repo_name AS repoName,
                prompt_text AS promptText,
                title,
                diff_summary AS diffSummary,
                success,
                completed_at AS completedAtMs
         FROM session_completions
         WHERE business_id = ? AND session_id = ? AND prompt_id = ?
         LIMIT 1`,
      )
      .bind(params.businessId, params.sessionId, params.promptId),
    db
      .prepare(
        `SELECT id,
                repo_owner AS repoOwner,
                repo_name AS repoName,
                session_id AS sessionId,
                prompt_id AS promptId,
                memory_id AS memoryId,
                source,
                selection_rank AS selectionRank,
                selection_score AS selectionScore,
                explanation,
                expected_effect AS expectedEffect,
                observed_effect AS observedEffect,
                intent,
                files_json AS filesJson,
                symbols_json AS symbolsJson,
                review_outcome AS reviewOutcome,
                used_at AS usedAtMs
         FROM memory_usage_events
         WHERE session_id = ?
           AND (
             prompt_id = ?
             OR (
               used_at > COALESCE(
                 (
                   SELECT MAX(previous.completed_at)
                   FROM session_completions previous
                   WHERE previous.session_id = ?
                     AND previous.completed_at < (
                       SELECT current.completed_at
                       FROM session_completions current
                       WHERE current.business_id = ?
                         AND current.session_id = ?
                         AND current.prompt_id = ?
                       LIMIT 1
                     )
                 ),
                 0
               )
               AND used_at <= (
                 SELECT current.completed_at
                 FROM session_completions current
                 WHERE current.business_id = ?
                   AND current.session_id = ?
                   AND current.prompt_id = ?
                 LIMIT 1
               )
             )
           )
         ORDER BY used_at ASC`,
      )
      .bind(
        params.sessionId,
        params.promptId,
        params.sessionId,
        params.businessId,
        params.sessionId,
        params.promptId,
        params.businessId,
        params.sessionId,
        params.promptId,
      ),
  ]);

  const completion = (completionResult.results as CompletionDbRow[])[0];
  if (!completion) {
    return { eligible: false, reason: "no_completed_prompt", message: "Completed prompt row not found" };
  }

  const context: MemoryReviewCompletedPromptContext = {
    businessId: completion.businessId,
    sessionId: completion.sessionId,
    promptId: completion.promptId,
    repoOwner: completion.repoOwner,
    repoName: completion.repoName,
    promptText: completion.promptText,
    title: completion.title,
    diffSummary: completion.diffSummary,
    success: completion.success === 1,
    completedAtMs: completion.completedAtMs,
  };
  const usageEvents = usageResult.results as MemoryReviewUsageEvent[];
  const eligibleEvents = selectEligibleMemoryUsageEvents(context, usageEvents);
  if (!context.success) {
    return { eligible: false, reason: "failed_prompt", message: "Prompt did not complete successfully" };
  }
  const contextQueryEvidence = await loadMemoryContextQueryEvidenceForPromptWindow(db, context);
  if (eligibleEvents.length === 0 && contextQueryEvidence.length === 0) {
    return { eligible: false, reason: "no_eligible_memory_usage", message: "No prompt-linked recall usage events" };
  }
  const memoryCatalog = await loadMemoryCatalogForUsageEvents(db, context, eligibleEvents);
  return buildMemoryReviewInputFromContext(context, usageEvents, memoryCatalog, {
    allowEmptyReview: contextQueryEvidence.length > 0,
    contextQueryEvidence,
  });
}

export async function runMemoryReviewBotForCompletedPrompt(
  env: Env,
  params: { businessId: string; sessionId: string; promptId: string },
  deps: RunMemoryReviewReviewerDeps & {
    nowMs?: number;
    model?: string;
    logger?: MemoryReviewLogger;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<RunMemoryReviewBotForCompletedPromptResult> {
  const startedAtMs = deps.nowMs ?? Date.now();
  try {
    const inputResult = await loadMemoryReviewInputForCompletedPrompt(env.DB, {
      businessId: params.businessId,
      sessionId: params.sessionId,
      promptId: params.promptId,
    });
    if (!inputResult.eligible) {
      deps.logger?.info(
        { event: "memory_review_bot_skipped", ...params, reason: inputResult.reason },
        "Memory review bot skipped completed prompt",
      );
      return { status: "skipped", reason: inputResult.reason };
    }

    const review = await runMemoryReviewReviewer(
      {
        env,
        input: inputResult.input,
        model: deps.model ?? MEMORY_REVIEW_BOT_DEFAULT_MODEL,
        promptVersion: MEMORY_REVIEW_BOT_PROMPT_VERSION,
        telemetry: {
          subsystem: "memory_review_bot",
          callType: "review",
          phase: "memory",
          sourceId: params.promptId,
          sessionId: params.sessionId,
          promptId: params.promptId,
          businessId: params.businessId,
          repoOwner: inputResult.input.repoOwner,
          repoName: inputResult.input.repoName,
          waitUntil: deps.waitUntil,
        },
      },
      deps,
    );
    if (!review.ok) {
      console.log(
        JSON.stringify({
          event: "memory_review_bot_failed",
          sessionId: params.sessionId,
          promptId: params.promptId,
          failureCode: review.failureCode,
        }),
      );
      return { status: "failed", failureCode: review.failureCode };
    }

    const run = await insertMemoryReviewBotRunResults(env.DB, {
      businessId: params.businessId,
      sessionId: params.sessionId,
      promptId: params.promptId,
      reviewerModel: deps.model ?? MEMORY_REVIEW_BOT_DEFAULT_MODEL,
      promptVersion: MEMORY_REVIEW_BOT_PROMPT_VERSION,
      schemaVersion: MEMORY_REVIEW_BOT_SCHEMA_VERSION,
      inputSnapshotJson: JSON.stringify(inputResult.input),
      outputJson: JSON.stringify(review.output),
      promptOutcome: review.output.promptOutcome,
      confidence: review.output.confidence,
      summary: review.output.summary,
      evidenceJson: JSON.stringify(inputResult.input.evidence),
      recallResults: buildRecallResults(inputResult.input, review.output),
      itemResults: review.output.memoryResults.map((item) => {
        const sourceMemory = inputResult.input.returnedMemories.find((memory) => memory.memoryId === item.memoryId);
        return {
          ...item,
          source: sourceMemory?.source ?? "recall",
          scopeStatus: sourceMemory?.scopeStatus ?? "unknown",
        };
      }),
      startedAtMs,
    });

    await deliverMemoryReviewBotCompletion(
      env,
      { run, input: inputResult.input, output: review.output },
      {
        logger: deps.logger,
      },
    ).catch((err) => {
      deps.logger?.warn(
        { runId: run.id, sessionId: params.sessionId, promptId: params.promptId, error: String(err) },
        "Memory review bot delivery failed after review persistence",
      );
    });
    console.log(
      JSON.stringify({
        event: "memory_review_bot_completed",
        runId: run.id,
        sessionId: params.sessionId,
        promptId: params.promptId,
        promptOutcome: review.output.promptOutcome,
        confidence: review.output.confidence,
      }),
    );
    return { status: "complete", runId: run.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown reviewer exception";
    deps.logger?.warn(
      { event: "memory_review_bot_failed", ...params, error: message },
      "Memory review bot failed for completed prompt",
    );
    return { status: "failed", failureCode: "reviewer_exception" };
  }
}

export async function deliverMemoryReviewBotCompletion(
  env: Env,
  params: { run: MemoryReviewBotRun; input: MemoryReviewInput; output: MemoryReviewOutput },
  deps: { logger?: MemoryReviewLogger } = {},
): Promise<void> {
  await deliverMemoryReviewCompletedSessionEvent(env, params, deps);
}

async function deliverMemoryReviewCompletedSessionEvent(
  env: Env,
  params: { run: MemoryReviewBotRun; input: MemoryReviewInput; output: MemoryReviewOutput },
  deps: { logger?: MemoryReviewLogger },
): Promise<void> {
  if (!env.SESSION) {
    await updateMemoryReviewBotRunSessionEventDelivery(env.DB, {
      businessId: params.run.businessId,
      runId: params.run.id,
      status: "skipped",
      error: "SESSION binding unavailable",
    });
    return;
  }

  try {
    const stub = env.SESSION.get(env.SESSION.idFromName(params.run.sessionId));
    const response = await stub.fetch("https://session.internal/session/memory-review-bot/completed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCompletionEventPayload(params)),
    });
    if (!response.ok) {
      const error = await response.text();
      await updateMemoryReviewBotRunSessionEventDelivery(env.DB, {
        businessId: params.run.businessId,
        runId: params.run.id,
        status: "failed",
        error: error || `Session event append failed with ${response.status}`,
      });
      deps.logger?.warn(
        { runId: params.run.id, sessionId: params.run.sessionId, status: response.status, error },
        "Memory review bot session event delivery failed",
      );
      return;
    }
    const body = (await response.json().catch(() => null)) as { eventId?: unknown } | null;
    await updateMemoryReviewBotRunSessionEventDelivery(env.DB, {
      businessId: params.run.businessId,
      runId: params.run.id,
      status: "sent",
      eventId: typeof body?.eventId === "string" ? body.eventId : null,
    });
  } catch (err) {
    const error = boundedError(err);
    await updateMemoryReviewBotRunSessionEventDelivery(env.DB, {
      businessId: params.run.businessId,
      runId: params.run.id,
      status: "failed",
      error,
    });
    deps.logger?.warn(
      { runId: params.run.id, sessionId: params.run.sessionId, error },
      "Memory review bot session event delivery failed",
    );
  }
}

export async function runMemoryReviewBotDailyDigest(
  env: Env,
  deps: { nowMs?: number; logger?: MemoryReviewLogger; postSlackMessage?: typeof postMessage } = {},
): Promise<{ status: "sent" | "skipped" | "failed"; runCount: number; reason?: string }> {
  if (!env.DB) return { status: "skipped", runCount: 0, reason: "db_unavailable" };
  const nowMs = deps.nowMs ?? Date.now();
  const window = previousUtcDayWindow(nowMs);
  const cursor = await getMemoryReviewDigestCursor(env.DB);
  if (cursor === window.cursorKey) return { status: "skipped", runCount: 0, reason: "already_sent" };

  const runs = await listPendingMemoryReviewBotDigestRuns(env.DB, {
    startMs: window.startMs,
    endMs: window.endMs,
    limit: DAILY_DIGEST_LIMIT,
  });
  if (runs.length === 0) {
    await setMemoryReviewDigestCursor(env.DB, window.cursorKey, nowMs);
    return { status: "skipped", runCount: 0, reason: "no_runs" };
  }

  const token = configuredEnvValue(env.SLACK_BOT_TOKEN);
  const channel = MEMORY_FEEDBACK_CHANNEL_ID;
  if (!token) {
    return { status: "skipped", runCount: runs.length, reason: "slack_token_missing" };
  }

  try {
    const slackResp = await (deps.postSlackMessage ?? postMessage)(
      token,
      channel,
      memoryReviewDigestFallbackText(env, runs, window),
      memoryReviewDigestSlackBlocks(env, runs, window),
    );
    if (slackResp.ok) {
      await markMemoryReviewBotDigestRunsSlackDelivery(env.DB, {
        runRefs: runs.map((entry) => ({ businessId: entry.run.businessId, runId: entry.run.id })),
        status: "sent",
        channelId: slackResp.channel ?? channel,
        messageTs: slackResp.ts ?? null,
      });
      if (runs.length < DAILY_DIGEST_LIMIT) {
        await setMemoryReviewDigestCursor(env.DB, window.cursorKey, nowMs);
      }
      return { status: "sent", runCount: runs.length };
    }
    const error = boundedTrimmedString(slackResp.error, SLACK_ERROR_MAX_LENGTH) ?? "Slack post failed";
    await markMemoryReviewBotDigestRunsSlackDelivery(env.DB, {
      runRefs: runs.map((entry) => ({ businessId: entry.run.businessId, runId: entry.run.id })),
      status: "failed",
      channelId: channel,
      error,
    });
    deps.logger?.warn(
      { runCount: runs.length, error: slackResp.error },
      "Memory review bot daily Slack digest delivery failed",
    );
    return { status: "failed", runCount: runs.length, reason: error };
  } catch (err) {
    const error = boundedError(err);
    await markMemoryReviewBotDigestRunsSlackDelivery(env.DB, {
      runRefs: runs.map((entry) => ({ businessId: entry.run.businessId, runId: entry.run.id })),
      status: "failed",
      channelId: channel,
      error,
    });
    deps.logger?.warn({ runCount: runs.length, error }, "Memory review bot daily Slack digest delivery failed");
    return { status: "failed", runCount: runs.length, reason: error };
  }
}

function buildCompletionEventPayload(params: {
  run: MemoryReviewBotRun;
  input: MemoryReviewInput;
  output: MemoryReviewOutput;
}): Record<string, unknown> {
  const counts = reviewOutputCounts(params.output);
  return {
    sessionId: params.run.sessionId,
    promptId: params.run.promptId,
    runId: params.run.id,
    promptOutcome: params.output.promptOutcome,
    confidence: params.output.confidence,
    summary: params.output.summary,
    returnedMemoryCount: params.input.returnedMemories.length,
    usefulCount: counts.useful,
    notUsefulCount: counts.notUseful,
    hurtCount: counts.hurt,
    falsePositiveHurt: params.output.promptOutcome === "false_positive" && counts.hurt > 0,
  };
}

interface MemoryReviewDigestWindow {
  startMs: number;
  endMs: number;
  cursorKey: string;
  label: string;
}

function memoryReviewDigestFallbackText(
  env: Env,
  runs: MemoryReviewBotDigestRun[],
  window: MemoryReviewDigestWindow,
): string {
  const summary = memoryReviewDigestSummary(runs);
  return [
    `Memory recall daily review (${window.label})`,
    `Runs: ${runs.length}; evaluated: ${summary.evaluatedRuns}; selector failure runs: ${summary.selectorFailureRuns}; TP: ${summary.truePositive}; FP: ${summary.falsePositive}; TN: ${summary.trueNegative}; FN: ${summary.falseNegative}; hurt: ${summary.hurt}`,
    ...runs.slice(0, 8).map((entry) => memoryReviewDigestRunLine(env, entry)),
  ].join("\n");
}

function memoryReviewDigestSlackBlocks(
  env: Env,
  runs: MemoryReviewBotDigestRun[],
  window: MemoryReviewDigestWindow,
): unknown[] {
  const summary = memoryReviewDigestSummary(runs);
  const fields = [
    `*Runs:*\n${runs.length}`,
    `*Evaluated:*\n${summary.evaluatedRuns}`,
    `*Selector failure runs:*\n${summary.selectorFailureRuns}`,
    `*True positive:*\n${summary.truePositive}`,
    `*False positive:*\n${summary.falsePositive}`,
    `*True negative:*\n${summary.trueNegative}`,
    `*False negative:*\n${summary.falseNegative}`,
    `*Hurt:*\n${summary.hurt}`,
    `*Useful memories:*\n${summary.useful}`,
    `*Window:*\n${slackEscape(window.label)}`,
  ];
  const detailLines = runs
    .slice(0, 8)
    .map((entry) => `• ${memoryReviewDigestRunLine(env, entry)}`)
    .join("\n");
  const omitted = runs.length > 8 ? `\n_${runs.length - 8} additional runs omitted._` : "";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Memory recall daily review*" },
    },
    { type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedSlackSectionText(`*Notable runs:*\n${slackEscape(detailLines)}${omitted}`),
      },
    },
  ];
}

function memoryReviewDigestSummary(runs: MemoryReviewBotDigestRun[]): {
  evaluatedRuns: number;
  selectorFailureRuns: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  hurt: number;
  useful: number;
} {
  const evaluatedRuns = runs.filter((entry) => !hasSelectorFailure(entry));
  return {
    evaluatedRuns: evaluatedRuns.length,
    selectorFailureRuns: runs.length - evaluatedRuns.length,
    truePositive: evaluatedRuns.filter((entry) => entry.run.promptOutcome === "true_positive").length,
    falsePositive: evaluatedRuns.filter((entry) => entry.run.promptOutcome === "false_positive").length,
    trueNegative: evaluatedRuns.filter((entry) => entry.run.promptOutcome === "true_negative").length,
    falseNegative: evaluatedRuns.filter((entry) => entry.run.promptOutcome === "false_negative").length,
    hurt: evaluatedRuns.reduce((sum, entry) => sum + entry.hurtCount, 0),
    useful: evaluatedRuns.reduce((sum, entry) => sum + entry.usefulCount, 0),
  };
}

function memoryReviewDigestRunLine(env: Env, entry: MemoryReviewBotDigestRun): string {
  const run = entry.run;
  const sessionUrl = resolvePublicSessionUrl(env, run.sessionId);
  const session = sessionUrl ?? run.sessionId;
  const memoryIds = entry.memoryIds.length ? ` | memories=${entry.memoryIds.join(",")}` : "";
  const rootCauses = entry.rootCauses.length ? ` | roots=${entry.rootCauses.join(",")}` : "";
  if (hasSelectorFailure(entry)) {
    return `selector_failure | evaluation excluded${memoryIds}${rootCauses} | ${session} | ${run.summary}`;
  }
  return `${run.promptOutcome} ${Math.round(run.confidence * 100)}% | ${entry.itemCount} returned, ${entry.usefulCount} useful, ${entry.hurtCount} hurt${memoryIds}${rootCauses} | ${session} | ${run.summary}`;
}

function hasSelectorFailure(entry: MemoryReviewBotDigestRun): boolean {
  try {
    const snapshot = JSON.parse(entry.run.inputSnapshotJson) as { evidence?: unknown };
    if (!Array.isArray(snapshot.evidence)) return false;
    return snapshot.evidence.some((evidence) => {
      if (!evidence || typeof evidence !== "object") return false;
      const record = evidence as { kind?: unknown; text?: unknown };
      return (
        record.kind === "context_query" &&
        typeof record.text === "string" &&
        /^trace_id=[^;]*;\s*selector_status=(?:failed|timeout)(?:;|$)/.test(record.text)
      );
    });
  } catch {
    return false;
  }
}

function previousUtcDayWindow(nowMs: number): MemoryReviewDigestWindow {
  const now = new Date(nowMs);
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = endMs - DAY_MS;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  return {
    startMs,
    endMs,
    cursorKey: startDate,
    label: `${startDate} UTC`,
  };
}

async function getMemoryReviewDigestCursor(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = ?")
    .bind(DAILY_DIGEST_CURSOR_JOB)
    .first<{ cursor: string | null }>();
  return row?.cursor ?? null;
}

async function setMemoryReviewDigestCursor(db: D1Database, cursorKey: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cron_sweep_cursors (job_name, cursor, last_updated_at, last_processed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         cursor = excluded.cursor,
         last_updated_at = excluded.last_updated_at,
         last_processed_at = excluded.last_processed_at`,
    )
    .bind(DAILY_DIGEST_CURSOR_JOB, cursorKey, nowMs, nowMs)
    .run();
}

function reviewOutputCounts(output: MemoryReviewOutput): { useful: number; notUseful: number; hurt: number } {
  return {
    useful: output.memoryResults.filter((result) => result.usefulness === "useful").length,
    notUseful: output.memoryResults.filter((result) => result.usefulness === "not_useful").length,
    hurt: output.memoryResults.filter((result) => result.effect === "hurt").length,
  };
}

function configuredEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "CHANGE_ME") return null;
  return trimmed;
}

function boundedTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function boundedError(err: unknown): string {
  return boundedTrimmedString(stringifyError(err), SLACK_ERROR_MAX_LENGTH) ?? "unknown";
}

function slackEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function boundedSlackSectionText(value: string): string {
  if (value.length <= SLACK_SECTION_TEXT_MAX_LENGTH) return value;
  return `${value.slice(0, SLACK_SECTION_TEXT_MAX_LENGTH - 3)}...`;
}

async function loadMemoryContextQueryEvidenceForPromptWindow(
  db: D1Database,
  context: MemoryReviewCompletedPromptContext,
): Promise<MemoryReviewEvidence[]> {
  const result = await db
    .prepare(
      `SELECT id,
              intent,
              selector_status AS selectorStatus,
              selected_ids_json AS selectedIdsJson,
              candidate_ids_json AS candidateIdsJson,
              rejected_json AS rejectedJson,
              vector_available AS vectorAvailable,
              vector_unavailable_reason AS vectorUnavailableReason,
              created_at_ms AS createdAtMs
       FROM memory_context_queries
       WHERE business_id = ?
         AND session_id = ?
         AND created_at_ms > COALESCE(
           (
             SELECT MAX(previous.completed_at)
             FROM session_completions previous
             WHERE previous.session_id = ?
               AND previous.completed_at < ?
           ),
           0
         )
         AND created_at_ms <= ?
       ORDER BY created_at_ms ASC
       LIMIT 5`,
    )
    .bind(context.businessId, context.sessionId, context.sessionId, context.completedAtMs, context.completedAtMs)
    .all<MemoryContextQueryReviewDbRow>();

  return result.results.map((row) => ({
    id: `context_query:${row.id}`,
    kind: "context_query" as const,
    text: summarizeMemoryContextQuery(row),
  }));
}

function summarizeMemoryContextQuery(row: MemoryContextQueryReviewDbRow): string {
  const selectedIds = parseStringArrayJson(row.selectedIdsJson);
  const candidateIds = parseStringArrayJson(row.candidateIdsJson);
  const rejected = parseJsonArrayLength(row.rejectedJson);
  return [
    `trace_id=${row.id}`,
    `selector_status=${row.selectorStatus}`,
    `intent=${row.intent}`,
    `selected=${selectedIds.length ? selectedIds.join(",") : "none"}`,
    `candidate_count=${candidateIds.length}`,
    `rejected_count=${rejected}`,
    `vector_available=${row.vectorAvailable === 1 ? "true" : "false"}`,
    row.vectorUnavailableReason ? `vector_unavailable_reason=${row.vectorUnavailableReason}` : null,
  ]
    .filter(Boolean)
    .join("; ")
    .slice(0, 1_000);
}

function parseJsonArrayLength(value: string | null): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function loadMemoryCatalogForUsageEvents(
  db: D1Database,
  context: MemoryReviewCompletedPromptContext,
  usageEvents: MemoryReviewUsageEvent[],
): Promise<MemoryReviewMemoryCatalog> {
  const catalog: MemoryReviewMemoryCatalog = new Map();
  const repoMemoryIds = unique(
    usageEvents
      .filter((event) => event.source === "recall" && isUsageEventInScope(context, event))
      .map((event) => event.memoryId),
  );
  const graphConclusionIds = unique(repoMemoryIds.map(graphConclusionIdFromMemoryId).filter(isNonNullString));
  // Message-backed context memory ids carry the `memory-message:` prefix (see the
  // memory-context id scheme), so they always contain colons. Match on the prefix
  // instead of `!includes(":")`, which excluded every message and mis-routed them
  // into the repo-memory lookup where they surfaced as missing.
  const graphMessageIds = unique(
    repoMemoryIds.filter((memoryId) => memoryId.startsWith(GRAPH_MESSAGE_MEMORY_ID_PREFIX)),
  );
  const companyMemoryIds = unique(
    usageEvents.filter((event) => event.source === "company_recall").map((event) => event.memoryId),
  );

  if (repoMemoryIds.length > 0 && context.repoOwner && context.repoName) {
    const placeholders = repoMemoryIds.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT memory_id AS memoryId,
                status,
                context_hint AS contextHint,
                content,
                memory_json AS memoryJson
         FROM repo_memories
         WHERE repo_owner = ? AND repo_name = ? AND memory_id IN (${placeholders})`,
      )
      .bind(context.repoOwner, context.repoName, ...repoMemoryIds)
      .all<RepoMemoryDbRow>();
    for (const row of rows.results) {
      catalog.set(row.memoryId, {
        memoryId: row.memoryId,
        source: "recall",
        lifecycleState: row.status,
        scopeStatus: "in_scope",
        content: row.content.slice(0, MEMORY_TEXT_MAX_CHARS),
        contextHint: row.contextHint,
        provenance: repoMemoryProvenance(row.memoryJson),
      });
    }
  }

  if (companyMemoryIds.length > 0) {
    const placeholders = companyMemoryIds.map(() => "?").join(", ");
    const [factResult, takeResult] = await db.batch([
      db
        .prepare(
          `SELECT id,
                  status,
                  kind,
                  claim,
                  holder,
                  confidence,
                  source_event_id AS sourceEventId
           FROM memory_facts
           WHERE business_id = ? AND id IN (${placeholders})`,
        )
        .bind(context.businessId, ...companyMemoryIds),
      db
        .prepare(
          `SELECT id,
                  kind,
                  claim,
                  holder,
                  weight,
                  active,
                  superseded_by AS supersededBy
           FROM memory_takes
           WHERE business_id = ? AND id IN (${placeholders})`,
        )
        .bind(context.businessId, ...companyMemoryIds),
    ]);
    for (const row of factResult.results as MemoryFactDbRow[]) {
      catalog.set(row.id, {
        memoryId: row.id,
        source: "company_recall",
        lifecycleState: row.status,
        scopeStatus: "in_scope",
        content: row.claim.slice(0, MEMORY_TEXT_MAX_CHARS),
        contextHint: `${row.kind} held by ${row.holder}`,
        provenance: `memory_facts:${row.sourceEventId}`,
      });
    }
    for (const row of takeResult.results as MemoryTakeDbRow[]) {
      catalog.set(row.id, {
        memoryId: row.id,
        source: "company_recall",
        lifecycleState: memoryTakeLifecycle(row),
        scopeStatus: "in_scope",
        content: row.claim.slice(0, MEMORY_TEXT_MAX_CHARS),
        contextHint: `${row.kind} held by ${row.holder}`,
        provenance: "memory_takes",
      });
    }
  }

  if (graphConclusionIds.length > 0) {
    const placeholders = graphConclusionIds.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT id,
                status,
                kind,
                content,
                level,
                confidence,
                enforcement,
                source_kind AS sourceKind,
                source_id AS sourceId
         FROM memory_conclusions
         WHERE business_id = ?
           AND id IN (${placeholders})
           AND status IN ('active', 'superseded', 'rejected', 'expired')
           AND deleted_at_ms IS NULL`,
      )
      .bind(context.businessId, ...graphConclusionIds)
      .all<MemoryConclusionReviewDbRow>();
    for (const row of rows.results) {
      const memoryId = `memory_conclusion:${row.id}`;
      catalog.set(memoryId, {
        memoryId,
        source: "recall",
        lifecycleState: row.status,
        scopeStatus: "in_scope",
        content: row.content.slice(0, MEMORY_TEXT_MAX_CHARS),
        contextHint: `${row.kind} ${row.level}; confidence=${row.confidence}; enforcement=${row.enforcement}`,
        provenance: [row.sourceKind, row.sourceId].filter(Boolean).join(":") || null,
      });
    }
  }

  const unresolvedGraphMessageIds = graphMessageIds.filter((memoryId) => !catalog.has(memoryId));
  if (unresolvedGraphMessageIds.length > 0) {
    const placeholders = unresolvedGraphMessageIds.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT id,
                role,
                content_text AS contentText,
                source_uri AS sourceUri,
                occurred_at_ms AS occurredAtMs
         FROM memory_messages
         WHERE business_id = ?
           AND id IN (${placeholders})
           AND deleted_at_ms IS NULL`,
      )
      .bind(context.businessId, ...unresolvedGraphMessageIds)
      .all<MemoryMessageReviewDbRow>();
    for (const row of rows.results) {
      catalog.set(row.id, {
        memoryId: row.id,
        source: "recall",
        lifecycleState: "active",
        scopeStatus: "in_scope",
        content: row.contentText.slice(0, MEMORY_TEXT_MAX_CHARS),
        contextHint: `session observation from ${row.role}`,
        provenance: row.sourceUri ?? `memory_messages:${row.id}`,
      });
    }
  }

  return catalog;
}

function buildRecallResults(input: MemoryReviewInput, output: MemoryReviewOutput): MemoryReviewRecallResult[] {
  const resultByMemoryId = new Map(output.memoryResults.map((result) => [result.memoryId, result]));
  const sources = new Set(input.returnedMemories.map((memory) => memory.source));
  const recallResults: MemoryReviewRecallResult[] = [];
  for (const source of sources) {
    const memories = input.returnedMemories.filter((memory) => memory.source === source);
    const itemResults = memories
      .map((memory) => resultByMemoryId.get(memory.memoryId))
      .filter((result): result is MemoryReviewOutput["memoryResults"][number] => result !== undefined);
    const effects = itemResults.map((result) => result.effect);
    recallResults.push({
      source,
      memoryCount: memories.length,
      relevantCount: itemResults.filter((result) => result.relevance === "relevant").length,
      usefulCount: itemResults.filter((result) => result.usefulness === "useful").length,
      hurtCount: itemResults.filter((result) => result.effect === "hurt").length,
      promptOutcome: output.promptOutcome,
      aggregateEffect: aggregateEffect(effects),
      provenanceNotes: input.scopeDefects
        .filter((defect) => defect.source === source)
        .map((defect) => `${defect.memoryId}:${defect.reason}`),
      evidenceIds: unique(memories.flatMap((memory) => memory.evidenceIds)),
    });
  }
  return recallResults;
}

function aggregateEffect(effects: MemoryReviewEffect[]): MemoryReviewEffect {
  if (effects.includes("hurt")) return "hurt";
  if (effects.includes("helped")) return "helped";
  return "neutral";
}

function dedupeUsageEvents(events: MemoryReviewUsageEvent[]): MemoryReviewUsageEvent[] {
  const seen = new Set<string>();
  const deduped: MemoryReviewUsageEvent[] = [];
  for (const event of events) {
    const key = event.memoryId;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function isUsageEventInScope(context: MemoryReviewCompletedPromptContext, event: MemoryReviewUsageEvent): boolean {
  if (event.source !== "recall") return true;
  if (!event.repoOwner && !event.repoName) return true;
  return event.repoOwner === context.repoOwner && event.repoName === context.repoName;
}

function summarizeUsageEvent(event: MemoryReviewUsageEvent): string {
  return [
    `source=${event.source}`,
    `rank=${event.selectionRank ?? "unknown"}`,
    `score=${event.selectionScore ?? "unknown"}`,
    event.explanation ? `explanation=${event.explanation}` : null,
    event.expectedEffect ? `expected_effect=${event.expectedEffect}` : null,
    event.observedEffect ? `observed_effect=${event.observedEffect}` : null,
    event.reviewOutcome ? `review_outcome=${event.reviewOutcome}` : null,
  ]
    .filter(Boolean)
    .join("; ")
    .slice(0, 1_000);
}

function parseStringArrayJson(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").slice(0, 25);
  } catch {
    return [];
  }
}

const GRAPH_MESSAGE_MEMORY_ID_PREFIX = "memory-message:";

function graphConclusionIdFromMemoryId(memoryId: string): string | null {
  const prefix = "memory_conclusion:";
  return memoryId.startsWith(prefix) ? memoryId.slice(prefix.length).trim() || null : null;
}

function isNonNullString(value: string | null): value is string {
  return value !== null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function repoMemoryProvenance(memoryJson: string): string | null {
  try {
    const parsed = JSON.parse(memoryJson) as { source_pr_urls?: unknown; source_session_ids?: unknown };
    const prUrls = Array.isArray(parsed.source_pr_urls)
      ? parsed.source_pr_urls.filter((entry): entry is string => typeof entry === "string")
      : [];
    const sessionIds = Array.isArray(parsed.source_session_ids)
      ? parsed.source_session_ids.filter((entry): entry is string => typeof entry === "string")
      : [];
    return [...prUrls, ...sessionIds].slice(0, 5).join(", ") || null;
  } catch {
    return null;
  }
}

function memoryTakeLifecycle(row: MemoryTakeDbRow): MemoryReviewLifecycleState {
  if (row.active === 1) return "active";
  return row.supersededBy ? "superseded" : "expired";
}
