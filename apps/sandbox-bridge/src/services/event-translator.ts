import { CODEX_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import { buildToolFailureReport } from "../../../../shared/tool-failure.js";
import { isErrorCode } from "../../../../shared/types/error-codes.js";
import type { ErrorCode } from "../../../../shared/types/sandbox.js";
import type { AgentRuntimeAdapter } from "../agent/agent-runtime-adapter.js";
import {
  CODEX_HANDLED_EVENT_TYPES,
  maxPromptRetriesForErrorCode,
  RETRYABLE_ERROR_CODES,
  VERIFICATION_PROMPT_MAX_ATTEMPTS,
} from "../constants/bridge.js";
import { type BridgeLogger } from "../logger.js";
import { PromptLoopState } from "../prompt-loop-state.js";
import { sanitizeText } from "../services/braintrust.js";
import type { LlmSpanTracker } from "../trackers/llm-span-tracker.js";
import { ToolPartTracker } from "../trackers/tool-part-tracker.js";
import type { DistributiveOmit, ParentToolPart, PromptExecutionState, SandboxEvent } from "../types.js";
import { canonicalPartId, promptRetryDelayMs, toolSummary } from "../utils/bridge-runtime.js";
import { classifyError } from "../utils/classify.js";
import { type ExtendedEvent, getEventProperties, isQuestionAskedEvent } from "../utils/event-guards.js";
import { emitReasoningDelta, emitTextDelta } from "../utils/event-handlers.js";
import { describeError } from "../utils/llm-errors.js";
import { estimateTokens } from "../utils/tokens.js";

/** Event envelope (`messageId`/`sandboxId`/`timestamp`) is added by the driver's `emit`. */
type EmitEvent = DistributiveOmit<SandboxEvent, "messageId" | "sandboxId" | "timestamp">;

/**
 * Backend-scoped raw-fallback log fields. Claude fallbacks must not count as
 * codex drift: the `event` name and per-backend field names feed the
 * per-backend Datadog log-derived metrics
 * (`cycloid.{codex,claude,opencode}.raw_fallback`, grouped by
 * `{codex,claude,opencode}_event_type` / `{codex,claude,opencode}_part_type`).
 */
export function buildRawFallbackLogFields(
  runtime: Pick<AgentRuntimeAdapter, "backend" | "rawFallbackPrefix">,
  promptId: string,
  kind: { eventType?: string; partType?: string },
): { event: string } & Record<string, unknown> {
  const prefix = runtime.rawFallbackPrefix;
  return {
    event: `${prefix}.raw_fallback`,
    prompt_id: promptId,
    agent_runtime_backend: runtime.backend,
    ...(kind.eventType !== undefined ? { [`${prefix}_event_type`]: kind.eventType } : {}),
    ...(kind.partType !== undefined ? { [`${prefix}_part_type`]: kind.partType } : {}),
  };
}

/** Params forwarded verbatim to the bridge's `emitParentToolCallWithInput`. */
export type EmitParentToolCallParams = {
  canonical: string;
  input: Record<string, unknown>;
  loopState: PromptLoopState;
  messageId: string;
  now: number;
  part: ParentToolPart;
  promptLog: BridgeLogger;
  promptState: PromptExecutionState;
  eventFields?: Record<string, unknown>;
  onSafetyViolation?: () => void;
};

/** Params forwarded verbatim to the bridge's `recordTerminalToolEvidence`. */
export type RecordTerminalToolEvidenceParams = {
  part: ParentToolPart;
  toolStatus: string | undefined;
  toolOutput: string | undefined;
  loopState: PromptLoopState;
};

/**
 * Backend-neutral bridge operations every event translator (Codex, Claude, …)
 * calls inline. This is the contract the neutral {@link import("../agent/agent-runtime-adapter.js").AgentRuntimeAdapter}
 * `translateEvent` seam types its `deps` against; backend-specific translators
 * extend it with the extra hooks they need.
 */
export interface TranslateEventDeps {
  /** `Date.now()` captured once for this event by the driver. */
  now: number;
  messageId: string;
  effectiveModel?: string;
  /** Sends a bridge event; the driver supplies the messageId/sandboxId/timestamp envelope. */
  emit: (event: EmitEvent) => void;
  logToBt: (eventType: string, data: Record<string, unknown>) => void;
  promptLog: BridgeLogger;
  /** Records the prompt-start signal (driver-owned closure over `result.started`). */
  markPromptStarted: (signal: string, extra?: Record<string, unknown>) => void;
  /**
   * Records a `raw_agent_runtime` passthrough — an event/part type the bridge does
   * not translate. Tracked by `eventType`/`partType` as a backend-version-drift
   * signal (a rising count means the CLI emitted a shape we should handle).
   */
  recordRawFallback: (kind: { eventType?: string; partType?: string }) => void;
  emitMemoryRecallUsage?: (event: ExtendedEvent, fallbackMessageId: string, timestamp: number) => void;
  /**
   * Braintrust per-call llm span tracker. Optional so translator unit tests
   * need no fake; translators must guard with `?.`.
   */
  llmSpans?: LlmSpanTracker;
  /** Codex-only translator hooks. Non-Codex adapters ignore this bag. */
  codex?: TranslateCodexEventRuntimeDeps;
}

/**
 * Bridge-coupled operations the Codex translator calls inline. Everything here
 * fires with the SAME ordering as the original in-loop code so observable emit /
 * BT span / evidence ordering is preserved; the translator is a structural
 * move, not a re-sequencing.
 */
export interface TranslateCodexEventRuntimeDeps {
  /** Current Codex session id (driver guarantees non-null before calling). */
  codexSessionId: string;
  isVerificationPrompt: boolean;
  requestedProviderID: string;
  /** Whether prompt start has already been observed (driver-owned `result.started`). */
  isStarted: () => boolean;
  /** Registers the pending question and returns the promise that resolves when answered. */
  setPendingQuestion: (id: string) => Promise<void>;
  emitMemoryRecallUsage: (event: ExtendedEvent, fallbackMessageId: string, timestamp: number) => void;
  emitParentToolCallWithInput: (params: EmitParentToolCallParams) => Promise<"blocked" | "emitted">;
  recordTerminalToolEvidence: (params: RecordTerminalToolEvidenceParams) => void;
  /** Folds a parent `message.updated` into the token budget (driver binds loopState/log/logToBt/emit). */
  handleMessageUpdated: (info: unknown) => void;
  /**
   * Resets the worktree before a `failed_edits` retry. Returns false when the
   * reset fails, in which case the retry is abandoned (the prompt errors out
   * rather than retrying against a dirty tree).
   */
  resetWorktreeForPromptRetry: (errorCode: ErrorCode) => boolean;
  /**
   * Records that `errorCode` exhausted its per-prompt retry budget (session
   * scoped, keyed on prompt id + error class + code-state token). The second
   * exhaustion of the same key is a suspected failure loop and the prompt is
   * aborted with an explicit `failure_loop_suspected` error.
   */
  recordRetryBudgetExhaustion: (errorCode: ErrorCode) => { suspectedLoop: boolean; exhaustionCount: number };
}

export type TranslateCodexEventDeps = TranslateEventDeps & TranslateCodexEventRuntimeDeps;

/**
 * How the driver should proceed after translating one Codex event:
 * - `next`: advance to the next event (mirrors a bare `continue` / fall-through).
 * - `break`: stop the prompt loop (idle reached or terminal session error).
 * - `retry`: sleep `delayMs`, re-dispatch the prompt, reset the start deadline.
 */
export type TranslateOutcome =
  { control: "next" } | { control: "break" } | { control: "retry"; delayMs: number; attempt: number };

const NEXT: TranslateOutcome = { control: "next" };
const BREAK: TranslateOutcome = { control: "break" };
const MAX_TOOL_ERROR_REASON_CHARS = 2_000;

function verificationPromptRetryCapMessage(errorCode: ErrorCode, errorMsg: string, totalAttempts: number): string {
  return `Verification prompt retry cap reached after ${totalAttempts} total attempts (max ${VERIFICATION_PROMPT_MAX_ATTEMPTS}). Last retryable error (${errorCode}): ${errorMsg}`;
}

function sanitizeToolErrorReason(reason: unknown): string {
  const raw = typeof reason === "string" ? reason : String(reason);
  const sanitized = sanitizeText(raw).replace(/\s+/g, " ").trim();
  if (sanitized.length <= MAX_TOOL_ERROR_REASON_CHARS) return sanitized;
  return `${sanitized.slice(0, MAX_TOOL_ERROR_REASON_CHARS)}...[truncated]`;
}

function logToolCallError(promptLog: BridgeLogger, part: ParentToolPart, reason: unknown): void {
  promptLog.warn(
    {
      event: "tool_call_errored",
      tool: part.tool,
      callId: canonicalPartId(part),
      reason: sanitizeToolErrorReason(reason),
    },
    "Tool call errored",
  );
}

function logTerminalToolPartError(promptLog: BridgeLogger, part: ParentToolPart): void {
  if (part.tool !== "question" && part.state?.status === "error") {
    logToolCallError(promptLog, part, part.state.error);
  }
}

/**
 * Translate a single Codex stream event into bridge effects. Pure with respect
 * to control flow — all I/O happens through `deps`, and the return value tells
 * the driver (`streamPromptToClient`) whether to continue, break, or retry.
 *
 * Stays an exact behavioral move of the former in-loop body: every branch
 * (prompt-start detection, stale-event suppression, the `emittedToolParts`
 * dedup guard, transient-only `session.error` retry, both `raw_agent_runtime`
 * fallbacks) is preserved.
 */
export async function translateCodexEvent(
  event: ExtendedEvent,
  deps: TranslateCodexEventDeps,
  loopState: PromptLoopState,
  promptState: PromptExecutionState,
  toolTracker: ToolPartTracker,
): Promise<TranslateOutcome> {
  const { codexSessionId, now, messageId, requestedProviderID, emit, logToBt, promptLog } = deps;

  if (event.type === "memory.recall.telemetry") {
    deps.emitMemoryRecallUsage(event, messageId, now);
    return NEXT;
  }

  if (event.type === "message.part.updated") {
    const part = event.properties?.part;
    if (part?.sessionID === codexSessionId) {
      deps.markPromptStarted("message.part.updated", { partType: part.type ?? "unknown" });
    }
  }

  if (event.type === "message.updated") {
    const info = event.properties?.info;
    if (info?.sessionID === codexSessionId) {
      deps.markPromptStarted("message.updated");
    }
  }

  if (isQuestionAskedEvent(event) && event.properties.sessionID === codexSessionId) {
    deps.markPromptStarted("question.asked");
  }

  if (event.type === "session.status" && event.properties.sessionID === codexSessionId) {
    const statusObj = event.properties.status as { type?: string } | undefined;
    if (statusObj?.type && statusObj.type !== "idle") {
      deps.markPromptStarted("session.status", { status: statusObj.type });
    }
  }

  if (isQuestionAskedEvent(event)) {
    const req = event.properties;
    if (req.sessionID === codexSessionId) {
      const q = req.questions?.[0];
      const questionText = q?.question ?? "";
      const questionOptions = q?.options;
      promptLog.info({ requestId: req.id, question: questionText }, "Question asked");
      loopState.questionCount++;

      const answerPromise = deps.setPendingQuestion(req.id);

      logToBt("question", { questionId: req.id, question: sanitizeText(questionText) });
      emit({
        type: "question",
        questionId: req.id,
        question: questionText,
        ...(questionOptions?.length ? { options: questionOptions } : {}),
      });

      await answerPromise;
    }
  }

  if (event.type === "message.part.updated") {
    const part = event.properties?.part;

    const textDelta = emitTextDelta({ part, codexSessionId, loopState });
    if (textDelta) {
      loopState.checkExternalStateReferences((part as { text: string }).text);
      emit({
        type: "token",
        content: textDelta,
        partId: part.id,
      });
    }

    if (part?.type === "tool" && part?.sessionID === codexSessionId) {
      const canonical = canonicalPartId(part);
      const isNew = !loopState.seenPartIds.has(part.id) && !loopState.seenPartIds.has(canonical);

      if (isNew) {
        loopState.seenPartIds.add(part.id);
        if (canonical !== part.id) loopState.seenPartIds.add(canonical);
        loopState.toolCallCount++;
        if (part.tool !== "question") loopState.recordToolCall(part.tool);

        const input = part.state?.input;
        const hasInput = input && Object.keys(input).length > 0;

        // Keep the emittedToolParts guard: the subtask path adds subtaskPid to
        // emittedToolParts WITHOUT adding it to seenPartIds, so a later part whose
        // id equals that subtaskPid can be isNew yet already emitted. The guard
        // prevents that duplicate emission.
        if (part.tool !== "question" && hasInput && !loopState.emittedToolParts.has(part.id)) {
          const emissionResult = await deps.emitParentToolCallWithInput({
            canonical,
            input,
            loopState,
            messageId,
            now,
            part,
            promptLog,
            promptState,
            eventFields: {
              status: part.state?.status,
              startedAt: now,
            },
            onSafetyViolation: () => {
              loopState.deferredSafetyRejectedToolPartIds.add(canonical);
            },
          });
          if (emissionResult === "blocked") {
            return NEXT;
          }
        }

        if (hasInput && part.tool !== "question") {
          loopState.recordBehavioralSignals(part.tool, input, false);
        }

        logTerminalToolPartError(promptLog, part);
      } else {
        const toolStatus = part.state?.status as string | undefined;
        const emittedKey = loopState.emittedToolParts.has(canonical)
          ? canonical
          : loopState.emittedToolParts.has(part.id)
            ? part.id
            : null;
        if (emittedKey && toolStatus && loopState.emittedToolStatuses.get(emittedKey) !== toolStatus) {
          loopState.emittedToolStatuses.set(emittedKey, toolStatus);

          let completedAt: number | undefined;
          let durationMs: number | undefined;
          if (toolStatus === "completed" || toolStatus === "error") {
            completedAt = now;
            const start = loopState.toolStartTimes.get(canonical) ?? loopState.toolStartTimes.get(part.id);
            if (start !== undefined) {
              durationMs = completedAt - start;
            }
            loopState.toolStartTimes.delete(canonical);
            loopState.toolStartTimes.delete(part.id);
          }

          const toolOutput =
            part.state?.status === "completed"
              ? part.state.output
              : part.state?.status === "error"
                ? part.state.error
                : undefined;
          if (toolStatus === "error") {
            logToolCallError(promptLog, part, toolOutput);
          }

          const outputEstTokens =
            toolStatus === "completed" && toolOutput !== undefined ? estimateTokens(toolOutput) : undefined;
          const failure =
            toolStatus === "error" ? buildToolFailureReport({ tool: part.tool, rawOutput: toolOutput }) : undefined;
          if (failure) {
            loopState.recordToolFailure(failure.phase);
          }

          // Emit tool_update FIRST so the terminal evidence is visible
          // in the transcript before any abort error follows. The
          // decision-only recordTerminalToolEvidence runs after.
          emit({
            type: "tool_update",
            callId: canonicalPartId(part),
            tool: part.tool,
            status: toolStatus,
            completedAt,
            durationMs,
            ...(outputEstTokens !== undefined
              ? { outputEstimatedTokens: outputEstTokens, outputChars: toolOutput!.length }
              : {}),
            ...(failure ? { failure } : {}),
          });

          deps.recordTerminalToolEvidence({
            part,
            toolStatus,
            toolOutput,
            loopState,
          });

          if (toolStatus === "completed" || toolStatus === "error") {
            toolTracker.endSpan(canonicalPartId(part), toolStatus, durationMs, outputEstTokens, toolOutput);
          }

          if (toolStatus === "completed") {
            if (!loopState.usedVerificationTools && part.tool.toLowerCase() === "bash") {
              const cmd = part.state?.input?.command;
              if (typeof cmd === "string" && /\bgh\s+(pr|issue)\s+(view|diff|list)/.test(cmd)) {
                loopState.usedVerificationTools = true;
              }
            }
          }
        }

        const input = part.state?.input;

        if (
          !loopState.emittedToolParts.has(part.id) &&
          !loopState.emittedToolParts.has(canonical) &&
          !loopState.deferredSafetyRejectedToolPartIds.has(canonical) &&
          input &&
          Object.keys(input).length > 0 &&
          part.tool !== "question"
        ) {
          const emissionResult = await deps.emitParentToolCallWithInput({
            canonical,
            input,
            loopState,
            messageId,
            now,
            part,
            promptLog,
            promptState,
            eventFields: {
              summary: toolSummary(part.tool, input),
            },
            onSafetyViolation: () => {
              loopState.deferredSafetyRejectedToolPartIds.add(canonical);
            },
          });
          if (emissionResult === "blocked") {
            return NEXT;
          }

          loopState.startNewTextSegment();
          loopState.recordBehavioralSignals(part.tool, input, false);
          logTerminalToolPartError(promptLog, part);
        }
      }
    }

    if (part?.type === "subtask" && part?.sessionID === codexSessionId) {
      const subtask = part as unknown as {
        id: string;
        callID?: string;
        prompt: string;
        description: string;
        agent: string;
      };
      if (!loopState.emittedToolParts.has(subtask.id)) {
        loopState.seenPartIds.add(subtask.id);
        const subtaskPid = canonicalPartId(subtask);
        loopState.emittedToolParts.add(subtask.id);
        if (subtaskPid !== subtask.id) loopState.emittedToolParts.add(subtaskPid);
        loopState.startNewTextSegment();
        loopState.toolStartTimes.set(subtaskPid, now);
        const subtaskArgs = { prompt: subtask.prompt, agent: subtask.agent };
        toolTracker.startSpan(subtaskPid, "agent", subtaskArgs);
        emit({
          type: "tool_call",
          tool: "agent",
          args: subtaskArgs,
          callId: subtaskPid,
          summary: subtask.description || subtask.agent || "agent",
        });
      }
    }

    const reasoningDelta = emitReasoningDelta({ part, codexSessionId, loopState });
    if (reasoningDelta) {
      emit({
        type: "reasoning",
        content: reasoningDelta,
        partId: part.id as string,
      });
    }

    if (part?.type === "patch" && part?.sessionID === codexSessionId) {
      const files = part.files as string[] | undefined;
      if (Array.isArray(files) && files.length > 0) {
        emit({
          type: "patch",
          files,
        });
      }
    }

    if (
      part?.type &&
      part.sessionID === codexSessionId &&
      part.type !== "text" &&
      part.type !== "tool" &&
      part.type !== "step-start" &&
      part.type !== "step-finish" &&
      part.type !== "subtask" &&
      part.type !== "reasoning" &&
      part.type !== "patch"
    ) {
      deps.recordRawFallback({ partType: part.type as string });
      emit({
        type: "raw_agent_runtime",
        partType: part.type as string,
        id: canonicalPartId(part as { callID?: string; id?: string }),
      });
    }
  }

  if (event.type === "message.updated") {
    deps.handleMessageUpdated(event.properties.info);
  }

  if (event.type === "session.status" && event.properties.sessionID === codexSessionId) {
    const statusObj = event.properties.status;
    if (statusObj.type === "retry") {
      emit({
        type: "retry_status",
        attempt: statusObj.attempt ?? 0,
        message: statusObj.message ?? "Retrying...",
        nextRetryAt: String(statusObj.next ?? new Date().toISOString()),
        provider: requestedProviderID,
      });
    }

    if (statusObj.type === "idle") {
      if (!deps.isStarted() && !promptState.dispatchSucceeded) {
        promptLog.info({}, "Prompt loop: ignoring stale idle status before prompt start");
        return NEXT;
      }
      loopState.idle = true;
      promptLog.info({}, "Session idle");
      return BREAK;
    }
  }
  if (event.type === "session.idle" && event.properties?.sessionID === codexSessionId) {
    if (!deps.isStarted() && !promptState.dispatchSucceeded) {
      promptLog.info({}, "Prompt loop: ignoring stale idle before prompt start");
      return NEXT;
    }
    loopState.idle = true;
    promptLog.info({}, "Session idle");
    return BREAK;
  }

  if (event.type === "session.error" && event.properties?.sessionID === codexSessionId) {
    const error = event.properties.error;
    const errorMsg = error?.data?.message ?? error?.name ?? "Unknown error";
    const errorDetails = describeError(error);
    const structuredErrorCode: unknown = event.properties.errorCode;
    const errorCode: ErrorCode = isErrorCode(structuredErrorCode)
      ? structuredErrorCode
      : classifyError(String(errorMsg));
    if (!deps.isStarted() && !promptState.dispatchSucceeded) {
      promptLog.info(
        { reason: errorMsg, errorDetails },
        "Prompt loop: ignoring stale session.error before prompt start",
      );
      return NEXT;
    }

    if (errorCode === "rate_limit") {
      promptLog.warn(
        {
          event: "sandbox_agent.rate_limited",
          provider: requestedProviderID,
          model: deps.effectiveModel ?? null,
          agent_runtime_backend: CODEX_AGENT_RUNTIME_BACKEND,
          reason: "session_error",
        },
        "Sandbox agent rate limited",
      );
    }

    const maxRetries = maxPromptRetriesForErrorCode(errorCode);
    const errorCodeRetryCount = promptState.promptRetryCountsByErrorCode[errorCode] ?? 0;
    const totalAttempts = promptState.promptRetryCount + 1;
    if (
      deps.isVerificationPrompt &&
      RETRYABLE_ERROR_CODES.has(errorCode) &&
      totalAttempts >= VERIFICATION_PROMPT_MAX_ATTEMPTS
    ) {
      const capMessage = verificationPromptRetryCapMessage(errorCode, String(errorMsg), totalAttempts);
      promptLog.warn(
        { error: errorMsg, errorDetails, errorCode, totalAttempts, maxAttempts: VERIFICATION_PROMPT_MAX_ATTEMPTS },
        "Verification prompt retry cap reached; aborting prompt",
      );
      logToBt("verification_prompt_retry_cap_reached", {
        errorCode,
        totalAttempts,
        maxAttempts: VERIFICATION_PROMPT_MAX_ATTEMPTS,
      });
      emit({
        type: "error",
        error: capMessage,
        code: errorCode,
        errorDetails,
      });
      if (!promptState.abortReason) {
        promptState.abortReason = capMessage;
        promptState.errorDetails = errorDetails;
        promptState.lastErrorCode = errorCode;
      }
      return BREAK;
    }

    if (RETRYABLE_ERROR_CODES.has(errorCode) && errorCodeRetryCount < maxRetries) {
      if (errorCode === "failed_edits" && !deps.resetWorktreeForPromptRetry(errorCode)) {
        promptLog.error(
          { error: errorMsg, errorDetails, errorCode },
          "Prompt retry blocked because worktree could not be reset",
        );
        emit({
          type: "error",
          error: String(errorMsg),
          code: errorCode,
          errorDetails,
        });
        if (!promptState.abortReason) {
          promptState.abortReason = `Session error: ${errorMsg}`;
          promptState.errorDetails = errorDetails;
          promptState.lastErrorCode = errorCode;
        }
        return BREAK;
      }
      promptState.promptRetryCount++;
      const nextErrorCodeRetryCount = errorCodeRetryCount + 1;
      promptState.promptRetryCountsByErrorCode[errorCode] = nextErrorCodeRetryCount;
      const delay = promptRetryDelayMs(nextErrorCodeRetryCount);
      promptLog.warn(
        {
          error: errorMsg,
          errorDetails,
          errorCode,
          attempt: nextErrorCodeRetryCount,
          totalRetryCount: promptState.promptRetryCount,
          maxRetries,
          delayMs: Math.round(delay),
        },
        "Retrying prompt after transient error",
      );
      emit({
        type: "retry_status",
        attempt: nextErrorCodeRetryCount,
        message: `Transient ${errorCode} — retrying (attempt ${nextErrorCodeRetryCount}/${maxRetries})`,
        nextRetryAt: new Date(now + delay).toISOString(),
        provider: requestedProviderID,
        errorCode,
      });
      return { control: "retry", delayMs: delay, attempt: nextErrorCodeRetryCount };
    }

    // Budget exhausted (or never retryable). For retryable classes, a SECOND
    // exhaustion of the same (prompt, error class, code state) is a suspected
    // failure loop: abort explicitly instead of letting re-dispatches burn the
    // same budget forever.
    if (RETRYABLE_ERROR_CODES.has(errorCode)) {
      const verdict = deps.recordRetryBudgetExhaustion(errorCode);
      if (verdict.suspectedLoop) {
        const loopError = `Suspected failure loop: '${errorCode}' exhausted its retry budget ${verdict.exhaustionCount} times for this prompt with no code-state change. Original error: ${errorMsg}`;
        promptLog.error(
          { errorCode, exhaustionCount: verdict.exhaustionCount, error: errorMsg, errorDetails },
          "Suspected failure loop; aborting prompt",
        );
        logToBt("failure_loop_suspected", { errorCode, exhaustionCount: verdict.exhaustionCount });
        emit({
          type: "error",
          error: loopError,
          code: "failure_loop_suspected",
          errorDetails,
        });
        if (!promptState.abortReason) {
          promptState.abortReason = loopError;
          promptState.errorDetails = errorDetails;
          promptState.lastErrorCode = "failure_loop_suspected";
        }
        return BREAK;
      }
    }

    emit({
      type: "error",
      error: String(errorMsg),
      code: errorCode,
      errorDetails,
    });
    if (!promptState.abortReason) {
      promptState.abortReason = `Session error: ${errorMsg}`;
      promptState.errorDetails = errorDetails;
      promptState.lastErrorCode = errorCode;
    }
    return BREAK;
  }

  if (event.type === "session.deleted") {
    const info = event.properties.info;
    if (!promptState.abortReason && info.id === codexSessionId) {
      promptState.abortReason = "Session was deleted externally";
      promptState.lastErrorCode = "aborted";
    }
  }

  if (event.type === "todo.updated") {
    if (event.properties.sessionID === codexSessionId && Array.isArray(event.properties.todos)) {
      emit({
        type: "todo_update",
        todos: event.properties.todos as Array<{ id: string; content: string; status: string }>,
      });
    }
  }

  if (!CODEX_HANDLED_EVENT_TYPES.has(event.type)) {
    deps.recordRawFallback({ eventType: event.type });
    emit({
      type: "raw_agent_runtime",
      eventType: event.type,
      ...getEventProperties(event),
    });
  }

  return NEXT;
}
