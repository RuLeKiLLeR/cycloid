import { isAbsolute, relative, resolve, sep } from "node:path";

import { CLAUDE_CODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import { scanFetchedWebContentForStructuralInjection } from "../../../../shared/utils/prompt-safety.js";
import { nonNegNumber } from "../../../../shared/utils/type-guards.js";
import { PromptLoopState } from "../prompt-loop-state.js";
import { ToolPartTracker } from "../trackers/tool-part-tracker.js";
import type { PromptExecutionState } from "../types.js";
import { toolSummary } from "../utils/bridge-runtime.js";
import { classifyError } from "../utils/classify.js";
import { isGenuineBashFailure } from "../utils/diagnostics.js";
import type { ExtendedEvent } from "../utils/event-guards.js";
import { describeError } from "../utils/llm-errors.js";
import { estimateTokens } from "../utils/tokens.js";
import { shouldEmitClaudeRateLimitedMetric } from "./agent-observability.js";
import { sanitizeText } from "./braintrust.js";
import { parseClaudeFirstPartyDynamicToolName } from "./claude-first-party-dynamic-tools.js";
import type { TranslateEventDeps, TranslateOutcome } from "./event-translator.js";
import { redactFirstPartyDynamicToolInputForPersistence } from "./first-party-dynamic-tools.js";

const NEXT: TranslateOutcome = { control: "next" };
const BREAK: TranslateOutcome = { control: "break" };

/**
 * One typed `SDKMessage` from the Agent SDK message generator, viewed
 * structurally. The envelope is `{ type, ... }`; `stream_event` wraps a raw
 * Anthropic SSE event under `event`, `assistant`/`user` carry full Anthropic
 * message snapshots, and `system`/`result` carry lifecycle + turn outcome.
 */
export type ClaudeStreamEvent = {
  type: string;
  subtype?: string;
  event?: Record<string, unknown>;
  message?: { role?: string; id?: string; content?: ClaudeContentBlock[] };
  [key: string]: unknown;
};

type ClaudeContentBlock = {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
};

/**
 * Per-prompt mutable state the stream-json translator needs across events but the
 * shared {@link PromptLoopState} does not model: the active assistant message id
 * (for stable per-block part ids) and the tool name behind each `tool_use_id`
 * (the `tool_result` turn only carries the id).
 */
export class ClaudeTurnState {
  constructor(readonly repoRoot: string = process.cwd()) {}

  currentMessageId: string | null = null;
  /**
   * The message id of the in-flight model call, for Braintrust llm spans. Set
   * on `message_start`, cleared on `message_stop`. Distinct from
   * `currentMessageId`, which persists across the whole turn for part ids.
   */
  activeLlmCallId: string | null = null;
  readonly toolNameById = new Map<string, string>();
  readonly patchFilesByToolId = new Map<string, string[]>();
  /**
   * Assistant text blocks recorded into loop state, counted per message id.
   * Gives each snapshot text block a distinct, arrival-ordered loop-state
   * partId across both per-block and consolidated assistant snapshot shapes.
   */
  readonly textBlockCounts = new Map<string, number>();
  /**
   * Tool calls already finalized this turn (a `tool_update` emitted + span
   * ended). Dedupes the two paths that can complete a denied call — the
   * `permission_denied` system message and the errored `tool_result` user turn
   * the SDK also produces — so a denial yields exactly one `tool_update`.
   */
  readonly finalizedToolIds = new Set<string>();
}

const CLAUDE_EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Map AskUserQuestion option blocks onto the durable question-event option
 * union (`string | { label, description? }`), dropping anything malformed.
 */
function toQuestionOptions(raw: unknown): Array<string | { label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((option): Array<string | { label: string; description?: string }> => {
    if (typeof option === "string") return [option];
    if (option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string") {
      const description = (option as { description?: unknown }).description;
      return [
        {
          label: (option as { label: string }).label,
          ...(typeof description === "string" ? { description } : {}),
        },
      ];
    }
    return [];
  });
}

/**
 * Pick the model that did the most token work in a `result.modelUsage` breakdown.
 * A single turn is usually one model, but compaction/sub-agent turns can mix in a
 * cheaper model; the dominant model is the right single tag for the per-prompt
 * usage row. Returns undefined when the breakdown is missing or empty.
 */
function dominantModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let best: string | undefined;
  let bestTokens = -1;
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    const u = (raw ?? {}) as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cacheReadInputTokens?: unknown;
      cacheCreationInputTokens?: unknown;
    };
    // Count every token bucket (camelCase here, unlike `result.usage`): a main
    // model can serve most of its work via cache reads and have few raw
    // input/output tokens, so omitting cache would mis-rank it behind a small
    // compaction/sub-agent model in a multi-model turn.
    const tokens =
      nonNegNumber(u.inputTokens) +
      nonNegNumber(u.outputTokens) +
      nonNegNumber(u.cacheReadInputTokens) +
      nonNegNumber(u.cacheCreationInputTokens);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = model;
    }
  }
  return best;
}

/**
 * Emit a `usage` durable event from a terminal Claude `result` message so the
 * Claude path feeds the same per-prompt usage pipeline the Codex path already
 * uses (`usage` event → session DO `accumulateUsage` → `prompt_usage` /
 * `usage_records`). Notes on the field mapping:
 *
 * - `result.usage` is per-prompt-turn, NOT session-cumulative (verified against
 *   real CLI captures: a turn with a 44k-token cache read still reports
 *   `input_tokens: 18`), so one emit per result yields the prompt's true usage.
 * - Anthropic's `input_tokens` already EXCLUDES cached tokens, so it maps
 *   straight onto the event's `inputTokens`; the DO honours the normalized
 *   `cacheReadTokens` and does not re-subtract. Do NOT pre-subtract here (that is
 *   a Codex-only normalization).
 * - Cost uses the SDK's authoritative `total_cost_usd`. The bridge's
 *   `computeCost` has no Anthropic cache-write rate, so deriving cost locally
 *   would understate BYOK spend; the SDK value is the source of truth.
 *
 * The backend (Anthropic vs OpenAI) is derivable downstream from the `model` tag.
 */
function emitClaudeResultUsage(event: ClaudeStreamEvent, deps: TranslateEventDeps): void {
  const usage = (event as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const inputTokens = nonNegNumber(u.input_tokens);
  const outputTokens = nonNegNumber(u.output_tokens);
  const cacheReadTokens = nonNegNumber(u.cache_read_input_tokens);
  const cacheWriteTokens = nonNegNumber(u.cache_creation_input_tokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return;

  const model = dominantModel((event as { modelUsage?: unknown }).modelUsage);
  deps.emit({
    type: "usage",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    totalCostUsd: nonNegNumber((event as { total_cost_usd?: unknown }).total_cost_usd),
    ...(model ? { model } : {}),
  });
}

/** Stringify a `tool_result.content` payload (string, or Anthropic content-part array). */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function normalizeToolPath(repoRoot: string, rawPath: unknown): string | null {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(repoRoot, rawPath);
  const repoRelativePath = relative(repoRoot, absolutePath);
  if (
    repoRelativePath === "" ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(repoRelativePath)
  ) {
    return null;
  }
  return repoRelativePath.split(sep).join("/");
}

function extractPatchFiles(tool: string, input: Record<string, unknown>, repoRoot: string): string[] {
  if (!CLAUDE_EDIT_TOOL_NAMES.has(tool)) return [];
  const pathKeys = tool === "NotebookEdit" ? ["notebook_path"] : ["file_path"];
  const files = pathKeys.flatMap((key) => {
    const file = normalizeToolPath(repoRoot, input[key]);
    return file ? [file] : [];
  });
  return [...new Set(files)];
}

/**
 * Translate one `claude -p` stream-json record into bridge effects, emitting the
 * same durable event contract as the Codex translator (`token`, `reasoning`,
 * `tool_call`, `tool_update`, `error`, `raw_agent_runtime`) and returning a
 * {@link TranslateOutcome} that tells the driver whether to continue or break.
 *
 * Text and thinking stream incrementally via `stream_event` deltas; tool calls
 * are emitted from the consolidated `assistant` snapshot (which carries the fully
 * assembled `input`, unlike the partial `input_json_delta` chunks); tool results
 * arrive on the `user` turn; `result` is terminal.
 */
export async function translateClaudeEvent(
  event: ClaudeStreamEvent,
  deps: TranslateEventDeps,
  loopState: PromptLoopState,
  promptState: PromptExecutionState,
  turnState: ClaudeTurnState,
  toolTracker: ToolPartTracker,
): Promise<TranslateOutcome> {
  const { emit, logToBt, promptLog } = deps;

  if (event.type === "memory.recall.telemetry") {
    deps.emitMemoryRecallUsage?.(event as unknown as ExtendedEvent, deps.messageId, deps.now);
    return NEXT;
  }

  switch (event.type) {
    case "system":
      // `init` fires once at query startup (per session, not per turn). Marking
      // prompt-start here satisfies the cold turn-1 start deadline before the
      // first model token; turns 2+ have no `init` and fall back to the first
      // assistant/partial token (warm, so fast). See §6 of the migration plan.
      if (event.subtype === "init") {
        deps.markPromptStarted("system_init");
        return NEXT;
      }
      // A refusal fallback is an expected in-turn provider retry. Mark the
      // prompt as started before waiting for the fallback result so a slow
      // retry cannot trip the warm-turn prompt-start deadline.
      if (event.subtype === "model_refusal_fallback") {
        deps.markPromptStarted("model_refusal_fallback");
        return NEXT;
      }
      // A `canUseTool` deny short-circuit — finalize the denied call as an
      // errored tool_update so it stays visible and no span is leaked.
      if (event.subtype === "permission_denied") {
        translatePermissionDenied(event, deps, loopState, turnState, toolTracker);
        return NEXT;
      }
      // Context compaction happened mid-turn. No durable event, but log the
      // ARC-1580 structured compaction event (same @event facet as the
      // opencode/codex path in bridge.ts handleMessageUpdated) so the
      // arcanist.prompt.compaction metric counts Claude turns too. The SDK
      // boundary only reports pre-compaction tokens, so no tokens_reclaimed.
      if (event.subtype === "compact_boundary") {
        const meta = (event as { compact_metadata?: { trigger?: unknown; pre_tokens?: unknown } }).compact_metadata;
        promptLog.info(
          {
            event: "prompt.compaction",
            trigger: typeof meta?.trigger === "string" ? meta.trigger : "unknown",
            contextTokensBefore: nonNegNumber(meta?.pre_tokens),
            agent_runtime_backend: "claude_code",
          },
          "Compaction boundary",
        );
        return NEXT;
      }
      // Other lifecycle/telemetry subtypes carry no durable event; unknown
      // subtypes surface as drift keyed by SDK message type.
      if (!KNOWN_SYSTEM_SUBTYPES.has(event.subtype ?? "")) {
        deps.recordRawFallback({ eventType: `system.${event.subtype ?? "unknown"}` });
        emit({ type: "raw_agent_runtime", eventType: `system.${event.subtype ?? "unknown"}` });
      }
      return NEXT;

    case "stream_event":
      return translateStreamEvent(event.event ?? {}, deps, turnState);

    case "assistant":
      translateAssistantSnapshot(event, deps, loopState, turnState, toolTracker);
      return NEXT;

    case "user":
      translateUserToolResults(event, deps, loopState, turnState, toolTracker);
      return NEXT;

    case "result": {
      // Per-prompt token + cost telemetry rides every terminal result (success
      // or error — a failed turn still burned tokens), feeding the shared usage
      // pipeline. Safe to emit before the error branch: it is a no-op when the
      // result carries no usage (the minimal synthetic error shape).
      emitClaudeResultUsage(event, deps);
      // Braintrust turn cost: the SDK's total_cost_usd is per-turn and
      // authoritative (one terminal result per turn), so it accumulates here
      // rather than at the backend-agnostic emit seam, where Codex's
      // session-cumulative snapshots would double-count.
      loopState.addUsageCost(nonNegNumber((event as { total_cost_usd?: unknown }).total_cost_usd));
      // SDK error results use `subtype` of `error_during_execution`,
      // `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.
      const isError =
        event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error"));
      if (!isError) {
        loopState.idle = true;
        promptLog.info({ subtype: event.subtype }, "Claude turn complete");
        return BREAK;
      }
      // `SDKResultError` carries `errors: string[]` (not the `result` text of a
      // success); fall back to `result`/`subtype` for synthetic/legacy shapes.
      const rawErrors = (event as { errors?: unknown }).errors;
      const errors: unknown[] = Array.isArray(rawErrors) ? rawErrors : [];
      const errorMsg = String(
        errors[0] ?? (event as { result?: unknown }).result ?? event.subtype ?? "Claude turn failed",
      );
      const errorDetails = describeError(errorMsg);
      const errorCode = classifyError(errorMsg);
      logToBt("error", { error: errorMsg, code: errorCode });
      emit({ type: "error", error: errorMsg, code: errorCode, errorDetails });
      if (!promptState.abortReason) {
        promptState.abortReason = `Session error: ${errorMsg}`;
        promptState.errorDetails = errorDetails;
        promptState.lastErrorCode = errorCode;
      }
      return BREAK;
    }

    case "rate_limit_event": {
      const rateLimitInfo =
        event.rate_limit_info && typeof event.rate_limit_info === "object"
          ? (event.rate_limit_info as Record<string, unknown>)
          : null;
      if (shouldEmitClaudeRateLimitedMetric(rateLimitInfo)) {
        promptLog.info(
          {
            event: "sandbox_agent.rate_limited",
            provider: "anthropic",
            model: deps.effectiveModel ?? null,
            agent_runtime_backend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
            reason: typeof rateLimitInfo?.status === "string" ? rateLimitInfo.status : "rate_limit_event",
            rate_limit_type: typeof rateLimitInfo?.rateLimitType === "string" ? rateLimitInfo.rateLimitType : null,
          },
          "Sandbox agent rate limited",
        );
      }
      return NEXT;
    }

    // Bridge-synthetic message pushed by the session manager when a provider
    // setup call (query open / model switch) is retried via `withProviderRetry`.
    // Emits the same durable `retry_status` event Codex projects so the UI retry
    // box renders identically.
    case "cycloid_retry_status": {
      const attempt = Math.floor(nonNegNumber((event as { attempt?: unknown }).attempt));
      const maxAttempts = Math.floor(nonNegNumber((event as { maxAttempts?: unknown }).maxAttempts));
      const delayMs = Math.max(0, Number((event as { delayMs?: unknown }).delayMs) || 0);
      const suffix = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt);
      emit({
        type: "retry_status",
        attempt,
        message: `Retrying Anthropic request (attempt ${suffix})`,
        nextRetryAt: new Date(deps.now + delayMs).toISOString(),
        provider: "Anthropic",
        ...(maxAttempts > 0 ? { maxAttempts } : {}),
      });
      return NEXT;
    }

    // Bridge-synthetic message pushed by the session manager when the SDK
    // `canUseTool` gate intercepts an AskUserQuestion call. Emits the same
    // durable `question` event as the Codex translator; the gate stays open
    // until the user's answer arrives via `respondToQuestion`.
    case "cycloid_question": {
      deps.markPromptStarted("question.asked");
      const questionId = String((event as { id?: unknown }).id ?? "");
      const questionText = String((event as { question?: unknown }).question ?? "");
      const options = toQuestionOptions((event as { options?: unknown }).options);
      promptLog.info({ requestId: questionId, question: questionText }, "Question asked");
      loopState.questionCount++;
      logToBt("question", { questionId, question: sanitizeText(questionText) });
      emit({
        type: "question",
        questionId,
        question: questionText,
        ...(options.length ? { options } : {}),
      });
      return NEXT;
    }

    default:
      deps.recordRawFallback({ eventType: event.type });
      emit({ type: "raw_agent_runtime", eventType: event.type });
      return NEXT;
  }
}

// `init`, `permission_denied`, and `compact_boundary` are handled explicitly
// above; the rest are benign SDK lifecycle/telemetry subtypes that carry no
// durable event. Anything outside this set surfaces as `raw_agent_runtime` drift.
const KNOWN_SYSTEM_SUBTYPES = new Set([
  "init",
  "model_refusal_fallback",
  "status",
  "thinking_tokens",
  "commands_changed",
  "plugin_install",
  "task_notification",
  "task_started",
  "task_updated",
  "task_progress",
]);

// `assistant`/`user` snapshot blocks we intentionally handle (tool_use/tool_result,
// plus assistant text recorded into loop state) or knowingly drop (thinking streams
// via stream_event deltas instead; user text is not assistant output). Any
// other block type surfaces as drift so new snapshot shapes stay visible.
const KNOWN_ASSISTANT_BLOCK_TYPES = new Set(["thinking", "text", "tool_use"]);
const KNOWN_USER_BLOCK_TYPES = new Set(["tool_result", "text"]);

function translateStreamEvent(
  ev: Record<string, unknown>,
  deps: TranslateEventDeps,
  turnState: ClaudeTurnState,
): TranslateOutcome {
  const et = ev.type as string | undefined;
  switch (et) {
    case "message_start": {
      deps.markPromptStarted("message_start");
      const msg = ev.message as { id?: string; model?: string; usage?: Record<string, unknown> } | undefined;
      turnState.currentMessageId = msg?.id ?? turnState.currentMessageId;
      // One Anthropic API call per message_start..message_stop bracket — open
      // the Braintrust llm span here. `usage` on message_start carries the
      // call's input-side tokens (input + cache buckets).
      if (msg?.id) {
        turnState.activeLlmCallId = msg.id;
        deps.llmSpans?.startCall(msg.id, {
          now: deps.now,
          model: typeof msg.model === "string" ? msg.model : undefined,
          inputTokens: nonNegNumber(msg.usage?.input_tokens),
          cacheReadTokens: nonNegNumber(msg.usage?.cache_read_input_tokens),
          cacheWriteTokens: nonNegNumber(msg.usage?.cache_creation_input_tokens),
        });
      }
      return NEXT;
    }
    case "content_block_delta": {
      const index = (ev.index as number) ?? 0;
      const delta = (ev.delta as Record<string, unknown>) ?? {};
      const partId = `${turnState.currentMessageId ?? deps.messageId}:${index}`;
      if (delta.type === "text_delta") {
        const text = String(delta.text ?? "");
        deps.emit({ type: "token", content: text, partId });
        if (turnState.activeLlmCallId) deps.llmSpans?.appendText(turnState.activeLlmCallId, text);
      } else if (delta.type === "thinking_delta") {
        const thinking = String(delta.thinking ?? "");
        deps.emit({ type: "reasoning", content: thinking, partId });
        if (turnState.activeLlmCallId) deps.llmSpans?.appendReasoning(turnState.activeLlmCallId, thinking);
      }
      // signature_delta / input_json_delta carry no durable content (tool input is
      // read from the consolidated `assistant` snapshot instead).
      return NEXT;
    }
    case "message_delta": {
      // Carries the call's output-side usage (cumulative output_tokens) and
      // terminal stop_reason for the in-flight llm span.
      if (turnState.activeLlmCallId) {
        const usage = (ev.usage as Record<string, unknown> | undefined) ?? {};
        const delta = (ev.delta as Record<string, unknown> | undefined) ?? {};
        deps.llmSpans?.noteUsage(turnState.activeLlmCallId, {
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
          stopReason: typeof delta.stop_reason === "string" ? delta.stop_reason : undefined,
        });
      }
      return NEXT;
    }
    case "message_stop": {
      if (turnState.activeLlmCallId) {
        deps.llmSpans?.endCall(turnState.activeLlmCallId, deps.now);
        turnState.activeLlmCallId = null;
      }
      return NEXT;
    }
    // content_block_start/stop: lifecycle only.
    case "content_block_start":
    case "content_block_stop":
      return NEXT;
    default:
      if (et) {
        deps.recordRawFallback({ eventType: `stream_event.${et}` });
        deps.emit({ type: "raw_agent_runtime", eventType: `stream_event.${et}` });
      }
      return NEXT;
  }
}

function translateAssistantSnapshot(
  event: ClaudeStreamEvent,
  deps: TranslateEventDeps,
  loopState: PromptLoopState,
  turnState: ClaudeTurnState,
  toolTracker: ToolPartTracker,
): void {
  const blocks = event.message?.content ?? [];
  const snapshotMessageId = event.message?.id ?? turnState.currentMessageId ?? deps.messageId;
  for (const block of blocks) {
    // Record the fully assembled text into loop state so downstream consumers
    // (PR summary, post-execution narrative, response assertions) see the final
    // message. Streamed deltas never write loop state on this path, so the
    // partId only needs to be unique and arrival-ordered per text block — a
    // per-message counter, NOT the content-array index: real captures emit one
    // assistant snapshot per block with a single-element content array, so the
    // array index is always 0 and distinct text blocks would collide (the
    // tracker keeps the longest text per part, silently dropping the rest).
    // Re-snapshotted identical text is collapsed by the tracker's text alias.
    // Tokens are not re-emitted: stream_event deltas already carried them, and
    // for non-streaming turns the snapshot is the only text source.
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      const textIndex = turnState.textBlockCounts.get(snapshotMessageId) ?? 0;
      turnState.textBlockCounts.set(snapshotMessageId, textIndex + 1);
      loopState.updateTextDelta(`${snapshotMessageId}:text:${textIndex}`, block.text, snapshotMessageId);
      loopState.checkExternalStateReferences(block.text);
      continue;
    }
    if (block.type !== "tool_use") {
      if (!KNOWN_ASSISTANT_BLOCK_TYPES.has(block.type)) {
        deps.recordRawFallback({ partType: `assistant.${block.type}` });
        deps.emit({ type: "raw_agent_runtime", eventType: `assistant.${block.type}` });
      }
      continue;
    }
    const callId = block.id;
    if (!callId || loopState.emittedToolParts.has(callId)) continue;
    const tool = block.name ?? "tool";
    const input = block.input ?? {};
    const firstPartyTool = parseClaudeFirstPartyDynamicToolName(tool);
    const redactedInput = firstPartyTool
      ? redactFirstPartyDynamicToolInputForPersistence(firstPartyTool.namespace, firstPartyTool.name, input)
      : undefined;
    const persistedInput = redactedInput === undefined ? input : (redactedInput ?? {});

    loopState.emittedToolParts.add(callId);
    loopState.startNewTextSegment();
    loopState.toolStartTimes.set(callId, deps.now);
    loopState.toolCallCount++;
    loopState.recordBehavioralSignals(tool, persistedInput);
    turnState.toolNameById.set(callId, tool);
    const patchFiles = extractPatchFiles(tool, input, turnState.repoRoot);
    if (patchFiles.length > 0) {
      turnState.patchFilesByToolId.set(callId, patchFiles);
    }
    toolTracker.startSpan(callId, tool, persistedInput);

    deps.emit({
      type: "tool_call",
      tool,
      args: persistedInput,
      callId,
      summary: toolSummary(tool, persistedInput),
    });
  }
}

/**
 * Map a Claude `tool_result`'s `is_error` flag to a tool status. For most tools
 * `is_error` is a faithful failure signal. For Bash the SDK sets it purely on a
 * non-zero exit and never exposes the exit code, so it fires on benign commands
 * that ran fine but report via non-zero exit (grep/rg/diff/test, `git diff
 * --exit-code`, ...). For Bash we keep "error" only when the output shows a
 * genuine execution failure and otherwise report the command as completed, so
 * the transcript badge and telemetry spans stop flagging benign non-zero exits.
 */
function resolveToolResultStatus(tool: string, isError: boolean, output: string): "completed" | "error" {
  if (!isError) return "completed";
  if (tool.toLowerCase() === "bash") {
    return isGenuineBashFailure(output) ? "error" : "completed";
  }
  return "error";
}

function translateUserToolResults(
  event: ClaudeStreamEvent,
  deps: TranslateEventDeps,
  loopState: PromptLoopState,
  turnState: ClaudeTurnState,
  toolTracker: ToolPartTracker,
): void {
  const blocks = event.message?.content ?? [];
  for (const block of blocks) {
    if (block.type !== "tool_result") {
      if (!KNOWN_USER_BLOCK_TYPES.has(block.type)) {
        deps.recordRawFallback({ partType: `user.${block.type}` });
        deps.emit({ type: "raw_agent_runtime", eventType: `user.${block.type}` });
      }
      continue;
    }
    const callId = block.tool_use_id;
    if (!callId || turnState.finalizedToolIds.has(callId)) continue;
    turnState.finalizedToolIds.add(callId);
    const tool = turnState.toolNameById.get(callId) ?? "tool";
    const output = stringifyToolResultContent(block.content);
    const status = resolveToolResultStatus(tool, block.is_error === true, output);
    if (status === "completed" && tool.toLowerCase() === "webfetch" && output) {
      const hits = scanFetchedWebContentForStructuralInjection(output);
      if (hits.length > 0) {
        loopState.recordStructuralPromptInjectionHits(hits);
      }
    }
    if (status === "completed") {
      loopState.recordSuccessfulEdit(tool);
      const patchFiles = turnState.patchFilesByToolId.get(callId);
      if (patchFiles && patchFiles.length > 0) {
        deps.emit({ type: "patch", files: patchFiles });
      }
    }

    const completedAt = deps.now;
    const start = loopState.toolStartTimes.get(callId);
    const durationMs = start !== undefined ? completedAt - start : undefined;
    loopState.toolStartTimes.delete(callId);

    const outputEstTokens = status === "completed" ? estimateTokens(output) : undefined;

    deps.emit({
      type: "tool_update",
      callId,
      tool,
      status,
      completedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(outputEstTokens !== undefined ? { outputEstimatedTokens: outputEstTokens, outputChars: output.length } : {}),
    });

    toolTracker.endSpan(callId, status, durationMs, outputEstTokens, output);
  }
}

/**
 * Translate a `system/permission_denied` message — the SDK's signal that the
 * `canUseTool` gate denied a tool call. Emits an errored `tool_update` for the
 * call and ends its span so a denied tool stays visible and no span is leaked.
 * Finalizes the call so the errored `tool_result` the SDK also produces does not
 * emit a duplicate update.
 */
function translatePermissionDenied(
  event: ClaudeStreamEvent,
  deps: TranslateEventDeps,
  loopState: PromptLoopState,
  turnState: ClaudeTurnState,
  toolTracker: ToolPartTracker,
): void {
  const callId = (event as { tool_use_id?: string }).tool_use_id;
  if (!callId || turnState.finalizedToolIds.has(callId)) return;
  turnState.finalizedToolIds.add(callId);
  const tool = turnState.toolNameById.get(callId) ?? (event as { tool_name?: string }).tool_name ?? "tool";
  const reason = String((event as { message?: unknown }).message ?? "Tool call denied by safety gate");

  const completedAt = deps.now;
  const start = loopState.toolStartTimes.get(callId);
  const durationMs = start !== undefined ? completedAt - start : undefined;
  loopState.toolStartTimes.delete(callId);

  // `reason` is the model-facing denial text (no tool input), safe to log.
  deps.logToBt("tool_denied", { tool, reason });
  deps.emit({
    type: "tool_update",
    callId,
    tool,
    status: "error",
    completedAt,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  toolTracker.endSpan(callId, "error", durationMs, undefined, reason);
}
