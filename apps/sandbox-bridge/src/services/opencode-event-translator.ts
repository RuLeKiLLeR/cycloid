import { OPENCODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import { MODEL_REGISTRY } from "../../../../shared/constants/models.js";
import { scanFetchedWebContentForStructuralInjection } from "../../../../shared/utils/prompt-safety.js";
import { nonNegNumber } from "../../../../shared/utils/type-guards.js";
import { PromptLoopState } from "../prompt-loop-state.js";
import { ToolPartTracker } from "../trackers/tool-part-tracker.js";
import type { PromptExecutionState } from "../types.js";
import { toolSummary } from "../utils/bridge-runtime.js";
import { classifyError } from "../utils/classify.js";
import { describeError } from "../utils/llm-errors.js";
import { checkToolSafety, type ToolSafetyOptions } from "../utils/protection.js";
import { estimateTokens } from "../utils/tokens.js";
import { sanitizeText } from "./braintrust.js";
import type { TranslateEventDeps, TranslateOutcome } from "./event-translator.js";

const NEXT: TranslateOutcome = { control: "next" };
const BREAK: TranslateOutcome = { control: "break" };

type OpencodeEvent = {
  type?: string;
  data?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventProperties(event: OpencodeEvent): Record<string, unknown> {
  return objectValue(event.properties) ?? event;
}

function eventPayload(event: OpencodeEvent): Record<string, unknown> {
  return objectValue(event.data) ?? objectValue(event.properties) ?? event;
}

// Opencode `session.error` carries `properties.error` as a structured object
// ({ name, data: { message, statusCode?, responseBody? } }) for
// ProviderAuthError/UnknownError/MessageOutputLengthError/MessageAbortedError/
// APIError. A bare stringValue() over that object yields nothing, so without
// this the real cause (e.g. APIError status=404 model-not-found) is dropped in
// favor of a generic "Opencode session error". Extract name + message + status.
export function describeSessionError(properties: Record<string, unknown>): string | undefined {
  const direct = stringValue(properties.message) ?? stringValue(properties.error);
  if (direct) return direct;
  const errorObj = objectValue(properties.error);
  if (!errorObj) return undefined;
  const name = stringValue(errorObj.name);
  const data = objectValue(errorObj.data);
  const message = data ? (stringValue(data.message) ?? stringValue(data.responseBody)) : undefined;
  const status = data && typeof data.statusCode === "number" ? `status=${data.statusCode}` : undefined;
  const parts = [name, status, message].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function partFromEvent(event: OpencodeEvent): Record<string, unknown> | null {
  const properties = eventProperties(event);
  return objectValue(properties.part) ?? objectValue(properties);
}

function sessionIdFrom(value: Record<string, unknown>): string | undefined {
  return stringValue(value.sessionID) ?? stringValue(value.sessionId);
}

function partId(part: Record<string, unknown>, fallback: string): string {
  return stringValue(part.id) ?? stringValue(part.partID) ?? stringValue(part.messageID) ?? fallback;
}

function textFromPart(part: Record<string, unknown>): string | undefined {
  return stringValue(part.text) ?? stringValue(part.content) ?? stringValue(part.delta);
}

function roleFrom(value: Record<string, unknown>): "user" | "assistant" | undefined {
  const role = stringValue(value.role);
  return role === "user" || role === "assistant" ? role : undefined;
}

function isCompactionSummary(value: Record<string, unknown>): boolean {
  return (
    value.summary === true || stringValue(value.agent) === "compaction" || stringValue(value.mode) === "compaction"
  );
}

function toolName(part: Record<string, unknown>): string {
  return stringValue(part.tool) ?? stringValue(part.name) ?? "tool";
}

function normalizeOpencodeUsageModel(model: unknown): string | undefined {
  const raw = stringValue(model);
  if (!raw) return undefined;
  return MODEL_REGISTRY.find((definition) => definition.providerModelId === raw)?.id ?? raw;
}

function emitUsageFromMessageUpdated(
  info: Record<string, unknown> | null,
  deps: TranslateEventDeps,
  loopState: PromptLoopState,
): void {
  if (!info || stringValue(info.role) !== "assistant") return;
  const tokens = objectValue(info.tokens);
  if (!tokens) return;
  const cache = objectValue(tokens.cache) ?? {};
  const inputTokens = nonNegNumber(tokens.input);
  const outputTokens = nonNegNumber(tokens.output);
  const cacheReadTokens = nonNegNumber(cache.read);
  const cacheWriteTokens = nonNegNumber(cache.write);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return;
  const model = normalizeOpencodeUsageModel(info.modelID);
  deps.emit({
    type: "usage",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    totalCostUsd: nonNegNumber(info.cost),
    ...(model ? { model } : {}),
  });

  // Retrospective Braintrust llm span: opencode only reveals a model call as a
  // completed assistant message (tokens/cost/time on message.updated), so the
  // span is recorded one-shot once the message is complete. The tracker dedupes
  // by message id and reports whether this call was newly recorded — turn cost
  // accumulates only then, so a re-fired message.updated never double-counts
  // (`info.cost` is per-message on this backend).
  const messageId = stringValue(info.id);
  const time = objectValue(info.time) ?? {};
  const completedAt = typeof time.completed === "number" ? time.completed : undefined;
  if (!messageId || completedAt === undefined) return;
  const startedAt = typeof time.created === "number" ? time.created : undefined;
  const outputText = [...loopState.responseTextByPartId.entries()]
    .filter(([partId]) => loopState.textPartMessageIds.get(partId) === messageId)
    .map(([, text]) => text)
    .join("\n\n");
  const recorded = deps.llmSpans?.recordCompletedCall(
    {
      callId: messageId,
      model,
      startedAt,
      endedAt: completedAt,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: nonNegNumber(info.cost),
      outputText: outputText || undefined,
    },
    deps.now,
  );
  if (recorded) loopState.addUsageCost(nonNegNumber(info.cost));
}

function emitFlushedRoleParts(
  flushed: ReturnType<PromptLoopState["flushPendingUnknownRoleParts"]>,
  deps: TranslateEventDeps,
  loopState: PromptLoopState,
): void {
  for (const f of flushed) {
    if (f.kind === "text") {
      loopState.checkExternalStateReferences(f.fullText);
      deps.emit({ type: "token", content: f.delta, partId: f.partId });
    } else {
      deps.emit({ type: "reasoning", content: f.delta, partId: f.partId });
    }
  }
}

function recordOpencodeMessageRole(
  info: Record<string, unknown> | null,
  deps: TranslateEventDeps & { opencodeSessionId: string },
  loopState: PromptLoopState,
): void {
  if (!info || sessionIdFrom(info) !== deps.opencodeSessionId) return;
  const messageID = stringValue(info.id);
  if (isCompactionSummary(info)) {
    loopState.suppressMessage(messageID);
    return;
  }
  const role = roleFrom(info);
  if (!messageID || !role) return;
  loopState.recordMessageRole(messageID, role);
  emitFlushedRoleParts(loopState.flushPendingUnknownRoleParts(messageID, role), deps, loopState);
}

function emitOpencodeTextDelta(
  part: Record<string, unknown>,
  deps: TranslateEventDeps & { opencodeSessionId: string },
  loopState: PromptLoopState,
): void {
  if (sessionIdFrom(part) !== deps.opencodeSessionId || part.synthetic === true) return;
  const text = textFromPart(part);
  if (!text) return;
  const messageID = stringValue(part.messageID);
  if (isCompactionSummary(part) || loopState.isMessageSuppressed(messageID)) return;
  const id = partId(part, `${deps.messageId}:text`);
  const role = loopState.getMessageRole(messageID);
  if (role !== "assistant") {
    if (role === undefined && messageID) {
      loopState.stashPendingUnknownRolePart(messageID, { partId: id, fullText: text, kind: "text" });
    }
    return;
  }
  const delta = loopState.updateTextDelta(id, text, messageID);
  if (!delta) return;
  loopState.checkExternalStateReferences(delta);
  deps.emit({ type: "token", content: delta, partId: id });
}

function emitOpencodeReasoningDelta(
  part: Record<string, unknown>,
  deps: TranslateEventDeps & { opencodeSessionId: string },
  loopState: PromptLoopState,
): void {
  if (sessionIdFrom(part) !== deps.opencodeSessionId || part.synthetic === true) return;
  const text = textFromPart(part);
  if (!text) return;
  const messageID = stringValue(part.messageID);
  if (isCompactionSummary(part) || loopState.isMessageSuppressed(messageID)) return;
  const id = partId(part, `${deps.messageId}:reasoning`);
  const role = loopState.getMessageRole(messageID);
  if (role !== "assistant") {
    if (role === undefined && messageID) {
      loopState.stashPendingUnknownRolePart(messageID, { partId: id, fullText: text, kind: "reasoning" });
    }
    return;
  }
  // Track reasoning on a separate `reasoning-` cursor (not updateTextDelta),
  // so it never lands in responseTextByPartId and bleeds into the agent's
  // final answer / PR evidence. Mirrors the Codex reasoning path.
  const delta = loopState.updateTrackedDelta(`reasoning-${id}`, text);
  if (!delta) return;
  deps.emit({ type: "reasoning", content: delta, partId: id });
}

// Opencode `ToolPart` (SDK 1.17.x) nests live tool data under `part.state`
// ({ status, input, output?, error? }), NOT at the top level. `state.status`
// transitions pending -> running -> completed/error across repeated
// `message.part.updated` events for the same `part.callID`.
function terminalToolOutput(state: Record<string, unknown>): string {
  const output = state.output ?? state.error;
  if (typeof output === "string") return output;
  if (output == null) return "";
  return JSON.stringify(output);
}

export type OpencodePermissionReply = "once" | "reject";

export type OpencodePermissionResponder = (
  sessionId: string,
  permissionId: string,
  response: OpencodePermissionReply,
) => Promise<void>;

export type OpencodeSafetyDeps = {
  respondToPermission?: OpencodePermissionResponder;
  safetyOptions?: ToolSafetyOptions;
  drainMemoryTelemetry?: () => Record<string, unknown>[];
};

type OpencodeToolSafetyDecision =
  | { response: "once"; tool: string; input: Record<string, unknown> }
  | { response: "reject"; tool: string; input: Record<string, unknown>; message: string };

function permissionPatterns(permission: Record<string, unknown>): string[] {
  const pattern = permission.patterns ?? permission.pattern;
  if (Array.isArray(pattern))
    return pattern.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const value = stringValue(pattern);
  return value && value.trim().length > 0 ? [value] : [];
}

function permissionToolInputs(
  permission: Record<string, unknown>,
): Array<{ tool: string; input: Record<string, unknown> }> {
  const type = (stringValue(permission.permission) ?? stringValue(permission.type) ?? "").toLowerCase();
  const patterns = permissionPatterns(permission);
  if (type === "bash") return patterns.map((command) => ({ tool: "bash", input: { command } }));
  if (type === "edit") return patterns.map((filePath) => ({ tool: "edit", input: { filePath } }));
  if (type === "webfetch") return patterns.map((url) => ({ tool: "webfetch", input: { url } }));
  if (type === "external_directory") return patterns.map((path) => ({ tool: "external_directory", input: { path } }));
  return [];
}

export function resolveOpencodePermissionDecision(
  permission: Record<string, unknown>,
  options: ToolSafetyOptions = {},
): OpencodeToolSafetyDecision {
  const checks = permissionToolInputs(permission);
  if (checks.length === 0) {
    const tool = (stringValue(permission.permission) ?? stringValue(permission.type) ?? "unknown").toLowerCase();
    return { response: "reject", tool, input: {}, message: "missing concrete opencode permission input; blocking" };
  }
  for (const { tool, input } of checks) {
    const violation = checkToolSafety(tool, input, options);
    if (violation) return { response: "reject", tool, input, message: violation.message };
  }
  return { response: "once", tool: checks[0].tool, input: checks[0].input };
}

function blockingEventReplyId(event: OpencodeEvent, properties: Record<string, unknown>): string | undefined {
  const data = objectValue(event.data);
  return stringValue(data?.id) ?? stringValue(properties.id) ?? stringValue(event.id);
}

function isBlockingAskedEvent(eventType: string): boolean {
  return eventType.endsWith(".asked");
}

function isV1PermissionPayload(payload: Record<string, unknown>): boolean {
  return Boolean(stringValue(payload.permission) ?? stringValue(payload.type));
}

function logBlockingFailsafe(
  deps: TranslateEventDeps,
  fields: Record<string, unknown>,
  message = "Opencode blocking event failsafe triggered",
): void {
  deps.promptLog.error(
    {
      event: "opencode.blocking_event.failsafe",
      ...fields,
      ...(typeof fields.eventType === "string" ? { opencode_event_type: fields.eventType } : {}),
    },
    message,
  );
}

function abortForBlockingFailsafe(
  promptState: PromptExecutionState,
  reason: string,
  deps: TranslateEventDeps,
  fields: Record<string, unknown>,
): TranslateOutcome {
  logBlockingFailsafe(deps, { ...fields, action: "abort", reason });
  if (!promptState.abortReason) {
    promptState.abortReason = reason;
    promptState.lastErrorCode = "aborted";
  }
  return BREAK;
}

export async function translateOpencodeEvent(
  event: OpencodeEvent,
  deps: TranslateEventDeps & { opencodeSessionId: string } & OpencodeSafetyDeps,
  loopState: PromptLoopState,
  promptState: PromptExecutionState,
  toolTracker: ToolPartTracker,
): Promise<TranslateOutcome> {
  const properties = eventProperties(event);
  const payload = eventPayload(event);
  const eventType = event.type ?? stringValue(properties.type) ?? "unknown";
  // sessionID lives in different places per event: top-level for session.*,
  // `part.sessionID` for message.part.updated, `info.sessionID` for
  // message.updated. Check all three so cross-session events are filtered out.
  const eventPart = partFromEvent(event);
  const eventInfo = objectValue(properties.info);
  const sessionID =
    sessionIdFrom(properties) ??
    (eventPart ? sessionIdFrom(eventPart) : undefined) ??
    (eventInfo ? sessionIdFrom(eventInfo) : undefined);
  if (sessionID && sessionID !== deps.opencodeSessionId && !isBlockingAskedEvent(eventType)) return NEXT;

  switch (eventType) {
    case "session.created":
    case "session.updated":
      deps.markPromptStarted(eventType);
      return NEXT;

    case "session.deleted":
      if (sessionID !== deps.opencodeSessionId) return NEXT;
      if (!promptState.abortReason) {
        promptState.abortReason = "Session was deleted externally";
        promptState.lastErrorCode = "aborted";
      }
      return BREAK;

    case "session.status": {
      if (sessionID !== deps.opencodeSessionId) return NEXT;
      deps.markPromptStarted(eventType);
      const status = objectValue(properties.status);
      if (status?.type === "retry") {
        deps.emit({
          type: "retry_status",
          attempt: typeof status.attempt === "number" ? status.attempt : 0,
          message: stringValue(status.message) ?? "Retrying...",
          ...(typeof status.next === "number" ? { nextRetryAt: new Date(status.next).toISOString() } : {}),
          // Constant by design: opencode routes exclusively through Baseten.
          provider: "baseten",
        });
      }
      return NEXT;
    }

    case "session.compacted":
      if (sessionID !== deps.opencodeSessionId) return NEXT;
      deps.markPromptStarted(eventType);
      return NEXT;

    // Loop-terminating events: only act when the event is positively ours. The
    // pre-switch filter let it through, but a missing sessionID slips past that
    // short-circuit, so an idle/error event lacking session context (or for
    // another session) would otherwise break the wrong prompt loop.
    case "session.idle":
      if (sessionID !== deps.opencodeSessionId) return NEXT;
      loopState.idle = true;
      return BREAK;

    case "session.error": {
      if (sessionID !== deps.opencodeSessionId) return NEXT;
      const message = describeSessionError(properties) ?? "Opencode session error";
      const errorCode = classifyError(message);
      const errorDetails = describeError(message);
      if (errorCode === "rate_limit") {
        deps.promptLog.warn(
          {
            event: "sandbox_agent.rate_limited",
            provider: "baseten",
            model: deps.effectiveModel ?? null,
            agent_runtime_backend: OPENCODE_AGENT_RUNTIME_BACKEND,
            reason: "session_error",
          },
          "Sandbox agent rate limited",
        );
      }
      deps.logToBt("error", { error: message, code: errorCode });
      deps.emit({ type: "error", error: message, code: errorCode, errorDetails });
      if (!promptState.abortReason) {
        promptState.abortReason = `Session error: ${message}`;
        promptState.errorDetails = errorDetails;
        promptState.lastErrorCode = errorCode;
      }
      return BREAK;
    }

    // Incremental token deltas. The cumulative `part.text` on each
    // message.part.updated already drives token emission via updateTextDelta,
    // so the deltas are redundant - ignore them instead of flooding raw
    // fallback (one delta per token would otherwise dominate the stream).
    case "message.part.delta":
      return NEXT;

    case "message.updated": {
      // Carries `properties.info` (Message metadata: role/parentID), not
      // content. Content streams via message.part.updated. Use it only as a
      // prompt-start signal so it never falls to raw fallback.
      deps.markPromptStarted(eventType, eventInfo ? { role: stringValue(eventInfo.role) } : undefined);
      recordOpencodeMessageRole(eventInfo, deps, loopState);
      emitUsageFromMessageUpdated(eventInfo, deps, loopState);
      return NEXT;
    }

    case "permission.asked": {
      const permission = payload;
      const targetSessionId = sessionIdFrom(permission);
      if (!targetSessionId) {
        return abortForBlockingFailsafe(promptState, "Opencode permission.asked event was missing a session id", deps, {
          eventType,
        });
      }
      const permissionId = stringValue(permission.id);
      if (!permissionId) {
        return abortForBlockingFailsafe(
          promptState,
          "Opencode permission.asked event was missing a permission id",
          deps,
          {
            eventType,
            opencodeSessionId: targetSessionId,
          },
        );
      }
      deps.markPromptStarted(eventType);
      const decision = resolveOpencodePermissionDecision(permission, deps.safetyOptions);
      try {
        await deps.respondToPermission?.(targetSessionId, permissionId, decision.response);
      } catch (error) {
        return abortForBlockingFailsafe(promptState, "Failed to reply to opencode permission request", deps, {
          eventType,
          opencodeSessionId: targetSessionId,
          permissionId,
          response: decision.response,
          error: String(error),
        });
      }
      if (decision.response === "reject") {
        deps.promptLog.warn(
          { event: "opencode.permission.denied", permissionId, tool: decision.tool, reason: decision.message },
          "Opencode permission denied by safety gate",
        );
      }
      return NEXT;
    }

    case "message.part.updated": {
      const part = eventPart;
      if (!part) return NEXT;
      const type = stringValue(part.type) ?? eventType;
      deps.markPromptStarted(eventType, { partType: type });
      if (type === "text") {
        emitOpencodeTextDelta(part, deps, loopState);
        return NEXT;
      }
      if (type === "tool") {
        handleToolPart(part, deps, loopState, toolTracker, deps.safetyOptions);
        return NEXT;
      }
      if (type === "patch") {
        const files = Array.isArray(part.files)
          ? part.files.filter((file): file is string => typeof file === "string")
          : [];
        if (files.length > 0) deps.emit({ type: "patch", files });
        return NEXT;
      }
      if (type === "retry") {
        const error = objectValue(part.error);
        deps.emit({
          type: "retry_status",
          attempt: typeof part.attempt === "number" ? part.attempt : 0,
          message: (error && (stringValue(error.message) ?? stringValue(error.name))) ?? "Retrying...",
          // Constant by design: opencode routes exclusively through Baseten
          // (`enabled_providers: ["baseten"]` in opencode-session.ts). Revisit if
          // opencode ever gains a second provider.
          provider: "baseten",
        });
        return NEXT;
      }
      if (type === "reasoning") {
        emitOpencodeReasoningDelta(part, deps, loopState);
        return NEXT;
      }
      // Step boundary markers carry no surfaceable content; they only bracket
      // the backend's internal turn lifecycle.
      if (type === "step-start" || type === "step-finish" || type === "compaction") return NEXT;
      deps.recordRawFallback({ eventType, partType: type });
      deps.emit({ type: "raw_agent_runtime", eventType, backend: OPENCODE_AGENT_RUNTIME_BACKEND });
      return NEXT;
    }

    case "todo.updated": {
      if (sessionID !== deps.opencodeSessionId) return NEXT;
      // A malformed event with no `todos` array is not a deliberate clear-all;
      // dropping it avoids a spurious empty todo_update. An explicit `[]` still
      // emits (valid clear-all).
      if (!Array.isArray(properties.todos)) return NEXT;
      const todos = properties.todos.filter((todo): todo is { id: string; content: string; status: string } => {
        const value = objectValue(todo);
        return (
          value !== null &&
          typeof value.id === "string" &&
          typeof value.content === "string" &&
          typeof value.status === "string"
        );
      });
      deps.emit({ type: "todo_update", todos });
      return NEXT;
    }

    default:
      if (isBlockingAskedEvent(eventType)) {
        const permissionId = blockingEventReplyId(event, properties);
        const targetSessionId = sessionIdFrom(payload);
        if (permissionId && isV1PermissionPayload(payload) && deps.respondToPermission) {
          if (!targetSessionId) {
            return abortForBlockingFailsafe(promptState, `Unhandled opencode blocking event: ${eventType}`, deps, {
              eventType,
              permissionId,
            });
          }
          logBlockingFailsafe(deps, { eventType, opencodeSessionId: targetSessionId, permissionId, action: "reject" });
          try {
            await deps.respondToPermission(targetSessionId, permissionId, "reject");
            return NEXT;
          } catch (error) {
            return abortForBlockingFailsafe(promptState, "Failed to reject unknown opencode blocking event", deps, {
              eventType,
              opencodeSessionId: targetSessionId,
              permissionId,
              error: String(error),
            });
          }
        }
        return abortForBlockingFailsafe(promptState, `Unhandled opencode blocking event: ${eventType}`, deps, {
          eventType,
          ...(targetSessionId ? { opencodeSessionId: targetSessionId } : {}),
          permissionId,
        });
      }
      deps.recordRawFallback({ eventType });
      deps.emit({ type: "raw_agent_runtime", eventType, backend: OPENCODE_AGENT_RUNTIME_BACKEND });
      return NEXT;
  }
}

// A single opencode tool call surfaces as repeated `message.part.updated`
// events for one `part.callID`, with `part.state.status` advancing
// pending -> running -> completed/error. Emit one `tool_call` on first sight
// (deduped via emittedToolParts) and exactly one terminal `tool_update`
// (deduped via toolStartTimes: a present start = update not yet emitted).
function handleToolPart(
  part: Record<string, unknown>,
  deps: TranslateEventDeps & { opencodeSessionId: string } & OpencodeSafetyDeps,
  loopState: PromptLoopState,
  toolTracker: ToolPartTracker,
  safetyOptions: ToolSafetyOptions = {},
): void {
  const callId = stringValue(part.callID) ?? partId(part, `${deps.messageId}:tool`);
  const tool = toolName(part);
  const state = objectValue(part.state) ?? {};
  const status = stringValue(state.status) ?? "pending";
  const input = objectValue(state.input) ?? {};
  const isTerminal = status === "completed" || status === "error";

  // A tool part starts as pending with an empty `state.input`, then fills the
  // input on `running` before terminating. Defer the tool_call until the input
  // is populated (or the tool terminates) so the edited path reaches
  // recordBehavioralSignals -> loopState.modifiedFiles. Staging keys NEW
  // (untracked) files off that set, so emitting with an empty input leaves the
  // written file unstaged and the session falsely reports no_diff.
  if (!loopState.emittedToolParts.has(callId)) {
    if (Object.keys(input).length === 0 && !isTerminal) return;
    const violation = checkToolSafety(tool, input, safetyOptions);
    if (violation) {
      deps.promptLog.warn(
        { event: "opencode.tool_denied", callId, tool, reason: violation.message },
        "Opencode tool call denied by safety gate",
      );
      deps.emit({
        type: "tool_update",
        callId,
        tool,
        status: "error",
        completedAt: deps.now,
        durationMs: 0,
      });
      loopState.emittedToolParts.add(callId);
      return;
    }
    loopState.emittedToolParts.add(callId);
    loopState.startNewTextSegment();
    loopState.toolStartTimes.set(callId, deps.now);
    loopState.toolCallCount++;
    loopState.recordBehavioralSignals(tool, input);
    toolTracker.startSpan(callId, tool, input);
    deps.logToBt("tool_call", { tool, args: sanitizeText(JSON.stringify(input)) });
    deps.emit({ type: "tool_call", tool, args: input, callId, summary: toolSummary(tool, input) });
  }

  if (!isTerminal) return;

  const start = loopState.toolStartTimes.get(callId);
  if (start === undefined) return; // terminal already emitted
  loopState.toolStartTimes.delete(callId);
  const completedAt = deps.now;
  const durationMs = completedAt - start;
  if (status === "completed") loopState.recordSuccessfulEdit(tool);
  const output = terminalToolOutput(state);
  if (status === "completed" && tool.toLowerCase() === "webfetch" && output) {
    const hits = scanFetchedWebContentForStructuralInjection(output);
    if (hits.length > 0) {
      loopState.recordStructuralPromptInjectionHits(hits);
    }
  }
  const outputEstimatedTokens = status === "completed" && output ? estimateTokens(output) : undefined;
  deps.emit({
    type: "tool_update",
    callId,
    tool,
    status,
    completedAt,
    durationMs,
    ...(outputEstimatedTokens !== undefined ? { outputEstimatedTokens, outputChars: output.length } : {}),
  });
  toolTracker.endSpan(callId, status, durationMs, outputEstimatedTokens, output);
  for (const telemetry of deps.drainMemoryTelemetry?.() ?? []) {
    deps.emitMemoryRecallUsage?.(
      { type: "memory.recall.telemetry", properties: { ...telemetry, sessionID: deps.opencodeSessionId } },
      deps.messageId,
      deps.now,
    );
  }
}
