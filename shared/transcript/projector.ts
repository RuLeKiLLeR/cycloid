import type { AgentProgressStep, MemoryRef } from "../events/bridge.js";
import type { BridgeCompatPayload, CycloidEvent, Phase } from "../events/schema.js";
import type { ToolFailureReport } from "../tool-failure.js";
import { isRecord } from "../utils/type-guards.js";
import { containsMalformedSearchBashEof, isMalformedSearchBlockedError } from "./malformed-search.js";

type LegacyRawSessionEvent = {
  type: string;
  sequence?: number;
  data?: Record<string, unknown>;
};

type CanonicalRawSessionEvent<P extends Phase = Phase> = CycloidEvent<P> & {
  sequence?: number;
};

export type RawSessionEvent = LegacyRawSessionEvent | CanonicalRawSessionEvent;

type PromptScopedActivity = {
  promptId?: string;
};

export type ToolCallActivityEvent = {
  type: "tool_call";
  tool: string;
  id: string;
  summary: string;
  input?: Record<string, unknown>;
  toolStatus?: "running" | "completed" | "error";
  truncated?: boolean;
  inputEstimatedTokens?: number;
  outputEstimatedTokens?: number;
  outputChars?: number;
  failure?: ToolFailureReport;
  duplicateCount?: number;
} & PromptScopedActivity;

export type TextActivityEvent = {
  type: "text";
  id: string;
  streamId?: string;
  text: string;
} & PromptScopedActivity;

export type QuestionActivityEvent = {
  type: "question";
  id: string;
  question: string;
  answer: string | null;
  options?: Array<string | { label: string; description?: string }>;
} & PromptScopedActivity;

export type ReasoningActivityEvent = {
  type: "reasoning";
  id: string;
  streamId?: string;
  text: string;
  /** Timestamp (ms) of the first reasoning delta in this segment. */
  startedAtMs?: number;
  /** Timestamp (ms) of the most recent reasoning delta in this segment. */
  endedAtMs?: number;
} & PromptScopedActivity;
export type PatchActivityEvent = { type: "patch"; id: string; files: string[] } & PromptScopedActivity;
export type CompactionStartActivityEvent = {
  type: "compaction_start";
  id: string;
  contextTokens?: number;
} & PromptScopedActivity;
export type CompactionCompleteActivityEvent = {
  type: "compaction_complete";
  id: string;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
} & PromptScopedActivity;
export type ContextFillWarningActivityEvent = {
  type: "context_fill_warning";
  id: string;
  fillPercent: number;
  contextTokens?: number;
  contextWindow?: number;
} & PromptScopedActivity;
export type ToolTruncatedActivityEvent = {
  type: "tool_truncated";
  id: string;
  tool: string;
  reason?: "truncation_marker" | "size_threshold";
} & PromptScopedActivity;
export type RetryStatusActivityEvent = {
  type: "retry_status";
  id: string;
  attempt: number;
  message: string;
  nextRetryAt?: string;
  provider?: string;
  errorCode?: string;
  scope?: string;
  maxAttempts?: number;
  reason?: string;
  retryAfterMs?: number;
} & PromptScopedActivity;
export type MemoryUsageActivityEvent = {
  type: "memory_usage";
  id: string;
  activeMemoryIds: string[];
  activeMemories: MemoryRef[];
  usageSource: "prompt_start" | "company_bootstrap";
} & PromptScopedActivity;

export type MemoryRecallUsageActivityEvent = {
  type: "memory_recall_usage";
  id: string;
  eventName: string;
  requestedMemoryIds: string[];
  returnedMemoryIds: string[];
  requestedMemories: MemoryRef[];
  returnedMemories: MemoryRef[];
  usageSource: "recall" | "company_recall";
  intent?: string;
  tool?: string;
} & PromptScopedActivity;
export type RawCodexActivityEvent = {
  type: "raw_agent_runtime";
  id: string;
  partType?: string;
  eventType?: string;
  data: Record<string, unknown>;
} & PromptScopedActivity;
export type SessionErrorActivityEvent = {
  type: "session_error";
  id: string;
  error: string;
  code?: string;
} & PromptScopedActivity;
export type AgentTimelineActivityEvent = {
  type: "agent_timeline";
  id: string;
  eventType: string;
  source: string;
  observer: string;
  summary: string;
  status?: string;
  metadata?: Record<string, unknown>;
} & PromptScopedActivity;
export type PromptActivityActivityEvent = {
  type: "prompt_activity";
  id: string;
  phase: string;
  detail?: string;
} & PromptScopedActivity;
export type AgentProgressActivityEvent = {
  type: "agent_progress";
  id: string;
  step: AgentProgressStep | string;
  label: string;
  terminal: boolean;
} & PromptScopedActivity;
export type SessionResumedColdActivityEvent = {
  type: "session_resumed_cold";
  id: string;
  reason?: string;
  lostSnapshotImageId?: string | null;
} & PromptScopedActivity;

export type CustomerActivityDetail = {
  tool: string;
  content: string;
};

export type CustomerActivityEvent = {
  type: "customer_activity";
  id: string;
  category: "inspect" | "change" | "verify" | "plan" | "git" | "command";
  title: string;
  summary: string;
  status?: "running" | "completed" | "error";
  count: number;
  details: CustomerActivityDetail[];
  overflow?: number;
} & PromptScopedActivity;

export type ActivityEvent =
  | ToolCallActivityEvent
  | TextActivityEvent
  | QuestionActivityEvent
  | ReasoningActivityEvent
  | PatchActivityEvent
  | CompactionStartActivityEvent
  | CompactionCompleteActivityEvent
  | ContextFillWarningActivityEvent
  | ToolTruncatedActivityEvent
  | RetryStatusActivityEvent
  | MemoryUsageActivityEvent
  | MemoryRecallUsageActivityEvent
  | RawCodexActivityEvent
  | SessionErrorActivityEvent
  | AgentTimelineActivityEvent
  | PromptActivityActivityEvent
  | AgentProgressActivityEvent
  | SessionResumedColdActivityEvent
  | CustomerActivityEvent;

const DUPLICATE_TEXT_DELTA_MIN_CHARS = 24;

export const RAW_CODEX_NOISE = new Set([
  "session.updated",
  "session.diff",
  "server.heartbeat",
  "session.idle",
  "lsp.updated",
  "lsp.client.diagnostics",
]);

function isCanonicalRawSessionEvent(event: RawSessionEvent): event is CanonicalRawSessionEvent {
  return "phase" in event && typeof event.phase === "string";
}

function compatPayload(event: CanonicalRawSessionEvent): Record<string, unknown> & BridgeCompatPayload {
  return event.payload as Record<string, unknown> & BridgeCompatPayload;
}

function compatBridgeData(event: CanonicalRawSessionEvent): Record<string, unknown> {
  const bridgeData = compatPayload(event).bridgeData;
  return isRecord(bridgeData) ? { ...bridgeData } : {};
}

function compatBridgeEventType(event: CanonicalRawSessionEvent): string | undefined {
  const bridgeEventType = compatPayload(event).bridgeEventType;
  return typeof bridgeEventType === "string" && bridgeEventType.length > 0 ? bridgeEventType : undefined;
}

function canonicalPromptId(event: CanonicalRawSessionEvent): string | undefined {
  if (typeof event.promptId === "string" && event.promptId.length > 0) {
    return event.promptId;
  }
  const bridgeData = compatBridgeData(event);
  if (typeof bridgeData.promptId === "string" && bridgeData.promptId.length > 0) {
    return bridgeData.promptId;
  }
  return typeof bridgeData.messageId === "string" && bridgeData.messageId.length > 0 ? bridgeData.messageId : undefined;
}

function withPromptId(event: CanonicalRawSessionEvent, data: Record<string, unknown>): Record<string, unknown> {
  const promptId = canonicalPromptId(event);
  return promptId && data.promptId === undefined ? { ...data, promptId } : data;
}

function normalizeBridgeCompatEventData(
  event: CanonicalRawSessionEvent,
  bridgeEventType: string | undefined,
  bridgeData: Record<string, unknown>,
): Record<string, unknown> {
  switch (bridgeEventType) {
    case "tool_call":
      return withPromptId(event, {
        ...bridgeData,
        ...(typeof bridgeData.callId === "string" &&
        bridgeData.callId.length > 0 &&
        !(typeof bridgeData.id === "string" && bridgeData.id.length > 0)
          ? { id: bridgeData.callId }
          : {}),
        ...(isRecord(bridgeData.args) && bridgeData.input === undefined ? { input: bridgeData.args } : {}),
      });
    case "tool_update":
      return withPromptId(event, {
        ...bridgeData,
        ...(typeof bridgeData.callId === "string" &&
        bridgeData.callId.length > 0 &&
        !(typeof bridgeData.id === "string" && bridgeData.id.length > 0)
          ? { id: bridgeData.callId }
          : {}),
      });
    default:
      return withPromptId(event, bridgeData);
  }
}

export function getRawSessionEventPromptId(event: RawSessionEvent): string | undefined {
  if (isCanonicalRawSessionEvent(event)) {
    return canonicalPromptId(event);
  }
  return typeof event.data?.promptId === "string" && event.data.promptId.length > 0 ? event.data.promptId : undefined;
}

export function getRawSessionEventKind(event: RawSessionEvent): string {
  if (!isCanonicalRawSessionEvent(event)) return event.type;

  const payload = compatPayload(event);
  const bridgeEventType = compatBridgeEventType(event);
  if (bridgeEventType === "prompt_activity") return "prompt_activity";
  if (bridgeEventType === "agent_progress") return "agent_progress";
  switch (event.phase) {
    case "text.delta":
      return payload.channel === "reasoning" ? "reasoning" : "text";
    case "tool.call":
      return "tool_call";
    case "tool.result":
      return "tool_update";
    case "prompt.enqueue":
      return "prompt_enqueued";
    case "prompt.dispatch":
      return "prompt_processing";
    case "prompt.complete":
      return payload.success === false ? "prompt_failed" : "prompt_completed";
    case "user_question":
      return "question";
    case "error":
      return "session_error";
    case "bridge.event":
      return bridgeEventType ?? event.phase;
    case "timeline":
      return bridgeEventType ?? "agent_timeline";
    case "idle":
      return bridgeEventType ?? "session_idle";
    case "agent.session.create":
    case "git.push":
    case "pr.open":
    case "session.create":
    case "sandbox.spawn":
    case "bridge.connect":
      return bridgeEventType ?? event.phase;
    default:
      return bridgeEventType ?? event.phase;
  }
}

export function getRawSessionEventTimestamp(event: RawSessionEvent): string | undefined {
  if (isCanonicalRawSessionEvent(event)) {
    return Number.isFinite(event.timestampMs) && Number.isFinite(new Date(event.timestampMs).getTime())
      ? new Date(event.timestampMs).toISOString()
      : undefined;
  }

  // Prefer `data.timestamp` (the long-standing source other callers rely on),
  // then fall back to a top-level `timestamp` for events that only carry it
  // there (e.g. sandbox-disconnect retry frames).
  const dataTimestamp = event.data?.timestamp;
  if ((typeof dataTimestamp === "string" && dataTimestamp.length > 0) || typeof dataTimestamp === "number") {
    const parsed = new Date(dataTimestamp);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  const topLevelTimestamp = (event as RawSessionEvent & { timestamp?: unknown }).timestamp;
  if (
    (typeof topLevelTimestamp === "string" && topLevelTimestamp.length > 0) ||
    typeof topLevelTimestamp === "number"
  ) {
    const parsed = new Date(topLevelTimestamp);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  return undefined;
}

export function getRawSessionEventTimestampMs(event: RawSessionEvent): number | undefined {
  const iso = getRawSessionEventTimestamp(event);
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export function getRawSessionEventData(event: RawSessionEvent): Record<string, unknown> | undefined {
  if (!isCanonicalRawSessionEvent(event)) {
    return isRecord(event.data) ? event.data : undefined;
  }

  const payload = compatPayload(event);
  const bridgeEventType = compatBridgeEventType(event);
  const base = withPromptId(event, compatBridgeData(event));

  switch (event.phase) {
    case "text.delta":
      return withPromptId(event, {
        ...base,
        ...(typeof payload.partId === "string" && payload.partId.length > 0 ? { id: payload.partId } : {}),
        text: payload.text,
      });
    case "tool.call":
      return withPromptId(event, {
        ...base,
        id: payload.callId,
        tool: payload.tool,
        input: isRecord(payload.args) ? payload.args : {},
        summary: typeof payload.summary === "string" ? payload.summary : "",
      });
    case "tool.result":
      return withPromptId(event, {
        ...base,
        id: payload.callId,
        status: typeof base.status === "string" ? base.status : payload.ok ? "completed" : "error",
      });
    case "prompt.enqueue":
      return withPromptId(event, {
        ...base,
        source: payload.source,
        ...(payload.actorUserId !== undefined ? { actorUserId: payload.actorUserId } : {}),
        ...(typeof payload.agent === "string" ? { agent: payload.agent } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
      });
    case "prompt.dispatch":
      return withPromptId(event, {
        ...base,
        ...(payload.startupAttemptId !== undefined ? { startupAttemptId: payload.startupAttemptId } : {}),
      });
    case "prompt.complete":
      return withPromptId(event, {
        ...base,
        success: payload.success,
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        ...(typeof payload.errorCode === "string" ? { code: payload.errorCode } : {}),
        ...(payload.errorDetails !== undefined ? { errorDetails: payload.errorDetails } : {}),
      });
    case "user_question":
      return withPromptId(event, {
        ...base,
        id: payload.questionId,
        question: payload.question,
        ...(Array.isArray(payload.options) ? { options: payload.options } : {}),
      });
    case "error":
      return withPromptId(event, {
        ...base,
        error: payload.message,
        ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        ...(payload.details !== undefined ? { errorDetails: payload.details } : {}),
      });
    case "bridge.event":
      return normalizeBridgeCompatEventData(event, bridgeEventType, base);
    case "timeline":
      return withPromptId(event, {
        ...base,
        ...(typeof payload.eventType === "string" ? { eventType: payload.eventType } : {}),
        ...(typeof payload.source === "string" ? { source: payload.source } : {}),
        ...(typeof payload.observer === "string" ? { observer: payload.observer } : {}),
        ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(isRecord(payload.metadata) ? { metadata: payload.metadata } : {}),
      });
    case "idle":
      return withPromptId(event, {
        ...base,
        ...(typeof payload.sessionEditCount === "number" ? { sessionEditCount: payload.sessionEditCount } : {}),
        ...(typeof payload.sessionPromptCount === "number" ? { sessionPromptCount: payload.sessionPromptCount } : {}),
      });
    default:
      return withPromptId(event, base);
  }
}

type NormalizedRawSessionEvent<T extends RawSessionEvent = RawSessionEvent> = {
  raw: T;
  type: string;
  data?: Record<string, unknown>;
  promptId?: string;
};

function normalizeRawSessionEvent<T extends RawSessionEvent>(event: T): NormalizedRawSessionEvent<T> {
  const data = getRawSessionEventData(event);
  return {
    raw: event,
    type: getRawSessionEventKind(event),
    data,
    promptId: getRawSessionEventPromptId(event),
  };
}

function normalizeRawSessionEvents<T extends RawSessionEvent>(events: T[]): NormalizedRawSessionEvent<T>[] {
  return events.map((event) => normalizeRawSessionEvent(event));
}

export function shouldAppendTextDelta(existingText: string, incomingText: string): boolean {
  if (!incomingText) return false;
  if (incomingText.length < DUPLICATE_TEXT_DELTA_MIN_CHARS) return true;
  return !existingText.endsWith(incomingText);
}

export type StreamActivityType = "text" | "reasoning";

export type StreamCoalescerState = {
  streamableIndexById: Map<string, number>;
  segmentOrdinalByStreamId: Map<string, number>;
  concatByStreamId: Map<string, string>;
  interstitialScanEndByStreamId: Map<string, number>;
};

export function createStreamCoalescerState(): StreamCoalescerState {
  return {
    streamableIndexById: new Map<string, number>(),
    segmentOrdinalByStreamId: new Map<string, number>(),
    concatByStreamId: new Map<string, string>(),
    interstitialScanEndByStreamId: new Map<string, number>(),
  };
}

function streamableKey(type: StreamActivityType, streamId: string): string {
  return `${type}:${streamId}`;
}

function resolveSegmentId(streamId: string, segmentOrdinal: number): string {
  return segmentOrdinal === 0 ? streamId : `${streamId}#${segmentOrdinal}`;
}

function resolveEventId(data: Record<string, unknown> | undefined, prefix: string, index: number): string {
  return typeof data?.id === "string" ? data.id : `${prefix}-${index}`;
}

function resolveTextValue(data: Record<string, unknown> | undefined): string {
  const text = data?.text;
  if (typeof text === "string") return text;
  const content = data?.content;
  return typeof content === "string" ? content : "";
}

function isNonContentInterstitial(event: ActivityEvent): boolean {
  switch (event.type) {
    case "agent_progress":
    case "retry_status":
    case "memory_usage":
    case "memory_recall_usage":
    case "agent_timeline":
      return true;
    default:
      return false;
  }
}

function canAppendAcrossNonContentInterstitials(
  events: ActivityEvent[],
  state: StreamCoalescerState,
  key: string,
  existingIdx: number,
): boolean {
  if (existingIdx === events.length - 1) return true;

  const scanStart = Math.max(existingIdx + 1, state.interstitialScanEndByStreamId.get(key) ?? existingIdx + 1);
  for (let i = scanStart; i < events.length; i++) {
    if (!isNonContentInterstitial(events[i])) return false;
  }
  state.interstitialScanEndByStreamId.set(key, events.length);
  return true;
}

function resolvePromptId(data: Record<string, unknown> | undefined): string | undefined {
  return typeof data?.promptId === "string" ? data.promptId : undefined;
}

export function coalesceStreamDelta(
  events: ActivityEvent[],
  state: StreamCoalescerState,
  type: StreamActivityType,
  streamId: string,
  text: string,
  promptId?: string,
  timestampMs?: number,
): boolean {
  const key = streamableKey(type, streamId);
  const existingText = state.concatByStreamId.get(key) ?? "";
  const existingIdx = state.streamableIndexById.get(key);
  const appendableText = shouldAppendTextDelta(existingText, text);

  if (existingIdx !== undefined) {
    const existing = events[existingIdx];
    if (
      existing.type === type &&
      appendableText &&
      canAppendAcrossNonContentInterstitials(events, state, key, existingIdx)
    ) {
      existing.text += text;
      state.concatByStreamId.set(key, existingText + text);
      if (!existing.promptId && promptId) existing.promptId = promptId;
      if (existing.type === "reasoning" && timestampMs !== undefined) {
        // Anchor startedAtMs to the first timestamped delta so the pair is never
        // left half-set (endedAtMs without startedAtMs) when an untimed delta opens the segment.
        if (existing.startedAtMs === undefined) existing.startedAtMs = timestampMs;
        existing.endedAtMs = timestampMs;
      }
      return true;
    }
    if (existingIdx === events.length - 1 || !appendableText) return false;
  }

  if (existingText && !appendableText) return false;

  const previousOrdinal = state.segmentOrdinalByStreamId.get(key);
  const segmentOrdinal = previousOrdinal === undefined ? 0 : previousOrdinal + 1;
  state.segmentOrdinalByStreamId.set(key, segmentOrdinal);
  state.streamableIndexById.set(key, events.length);
  state.concatByStreamId.set(key, existingText + text);
  state.interstitialScanEndByStreamId.set(key, events.length + 1);

  if (type === "text") {
    events.push({
      type: "text",
      id: resolveSegmentId(streamId, segmentOrdinal),
      ...(segmentOrdinal > 0 ? { streamId } : {}),
      text,
      ...(promptId ? { promptId } : {}),
    });
  } else {
    events.push({
      type: "reasoning",
      id: resolveSegmentId(streamId, segmentOrdinal),
      ...(segmentOrdinal > 0 ? { streamId } : {}),
      text,
      ...(promptId ? { promptId } : {}),
      ...(timestampMs !== undefined ? { startedAtMs: timestampMs, endedAtMs: timestampMs } : {}),
    });
  }

  return true;
}

type ToolCallMergeInput = {
  type: "tool_call";
  id: string;
  tool?: string;
  summary?: string;
} & Partial<Omit<ToolCallActivityEvent, "type" | "id" | "tool" | "summary">>;

export function mergeToolCall(previous: ToolCallActivityEvent, incoming: ToolCallMergeInput): ToolCallActivityEvent {
  return {
    ...previous,
    ...incoming,
    tool: incoming.tool ?? previous.tool,
    summary: incoming.summary ?? previous.summary,
    ...(incoming.promptId === undefined && previous.promptId !== undefined ? { promptId: previous.promptId } : {}),
    ...(incoming.input === undefined && previous.input !== undefined ? { input: previous.input } : {}),
    ...(incoming.toolStatus === undefined && previous.toolStatus !== undefined
      ? { toolStatus: previous.toolStatus }
      : {}),
    ...(incoming.truncated === undefined && previous.truncated !== undefined ? { truncated: previous.truncated } : {}),
    ...(incoming.inputEstimatedTokens === undefined && previous.inputEstimatedTokens !== undefined
      ? { inputEstimatedTokens: previous.inputEstimatedTokens }
      : {}),
    ...(incoming.outputEstimatedTokens === undefined && previous.outputEstimatedTokens !== undefined
      ? { outputEstimatedTokens: previous.outputEstimatedTokens }
      : {}),
    ...(incoming.outputChars === undefined && previous.outputChars !== undefined
      ? { outputChars: previous.outputChars }
      : {}),
    ...(incoming.failure === undefined && previous.failure !== undefined ? { failure: previous.failure } : {}),
    ...(incoming.duplicateCount === undefined && previous.duplicateCount !== undefined
      ? { duplicateCount: previous.duplicateCount }
      : {}),
  };
}

function normalizeToolStatus(value: unknown): ToolCallActivityEvent["toolStatus"] | undefined {
  return value === "running" || value === "completed" || value === "error" ? value : undefined;
}

export function applyToolCallUpdate(
  previous: ToolCallActivityEvent,
  data: Record<string, unknown> | undefined,
): ToolCallActivityEvent {
  const toolStatus = normalizeToolStatus(data?.status);
  return {
    ...previous,
    ...(toolStatus ? { toolStatus } : {}),
    ...(typeof data?.outputEstimatedTokens === "number" ? { outputEstimatedTokens: data.outputEstimatedTokens } : {}),
    ...(typeof data?.outputChars === "number" ? { outputChars: data.outputChars } : {}),
    ...(isRecord(data?.failure) ? { failure: data.failure as ToolFailureReport } : {}),
    ...(typeof data?.truncated === "boolean" ? { truncated: data.truncated } : {}),
  };
}

type FlattenState = {
  merged: ActivityEvent[];
  streams: StreamCoalescerState;
  toolCallIndexById: Map<string, number>;
  agentProgressIndexByKey: Map<string, number>;
  questionIndexById: Map<string, number>;
  malformedSearchBlockedPromptIds: Set<string>;
  malformedSearchBlockedWithoutPrompt: boolean;
};

function createFlattenState(): FlattenState {
  return {
    merged: [],
    streams: createStreamCoalescerState(),
    toolCallIndexById: new Map<string, number>(),
    agentProgressIndexByKey: new Map<string, number>(),
    questionIndexById: new Map<string, number>(),
    malformedSearchBlockedPromptIds: new Set(),
    malformedSearchBlockedWithoutPrompt: false,
  };
}

// Runs after coalescing so the bash-EOF signature matches even when it was
// split across stream deltas (split deltas share a stream id and merge into
// one text segment). Suppression is per-segment: only segments containing the
// garbage pattern are dropped, so normal assistant text in a prompt with a
// blocked search survives.
function suppressMalformedSearchSegments(state: FlattenState): ActivityEvent[] {
  if (state.malformedSearchBlockedPromptIds.size === 0 && !state.malformedSearchBlockedWithoutPrompt) {
    return state.merged;
  }
  return state.merged.filter((event) => {
    if (event.type !== "text") return true;
    const blocked = event.promptId
      ? state.malformedSearchBlockedPromptIds.has(event.promptId)
      : state.malformedSearchBlockedWithoutPrompt;
    return !(blocked && containsMalformedSearchBashEof(event.text));
  });
}

function pushEvent(state: FlattenState, event: ActivityEvent | null): void {
  if (event) state.merged.push(event);
}

function projectCompactionStart(
  data: Record<string, unknown> | undefined,
  index: number,
): CompactionStartActivityEvent {
  return {
    type: "compaction_start",
    id: `cs-${data?.timestamp ?? index}`,
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    ...(typeof data?.contextTokens === "number" ? { contextTokens: data.contextTokens } : {}),
  };
}

function projectCompactionComplete(
  data: Record<string, unknown> | undefined,
  index: number,
): CompactionCompleteActivityEvent {
  return {
    type: "compaction_complete",
    id: `cc-${data?.timestamp ?? index}`,
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    ...(typeof data?.contextTokensBefore === "number" ? { contextTokensBefore: data.contextTokensBefore } : {}),
    ...(typeof data?.contextTokensAfter === "number" ? { contextTokensAfter: data.contextTokensAfter } : {}),
  };
}

function projectContextFillWarning(
  data: Record<string, unknown> | undefined,
  index: number,
): ContextFillWarningActivityEvent {
  return {
    type: "context_fill_warning",
    id: `cfw-${data?.timestamp ?? index}`,
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    fillPercent: typeof data?.fillPercent === "number" ? data.fillPercent : Number(data?.fillPercent ?? 0),
    ...(typeof data?.contextTokens === "number" ? { contextTokens: data.contextTokens } : {}),
    ...(typeof data?.contextWindow === "number" ? { contextWindow: data.contextWindow } : {}),
  };
}

function projectToolTruncated(data: Record<string, unknown> | undefined, index: number): ToolTruncatedActivityEvent {
  return {
    type: "tool_truncated",
    id: typeof data?.callId === "string" ? data.callId : String(index),
    tool: typeof data?.tool === "string" ? data.tool : "",
    ...(data?.reason === "truncation_marker" || data?.reason === "size_threshold" ? { reason: data.reason } : {}),
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
  };
}

function projectRetryStatus(data: Record<string, unknown> | undefined, index: number): RetryStatusActivityEvent {
  return {
    type: "retry_status",
    id: `rs-${data?.timestamp ?? index}`,
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    attempt: typeof data?.attempt === "number" ? data.attempt : Number(data?.attempt ?? 0),
    message: typeof data?.message === "string" ? data.message : "Retrying...",
    ...(typeof data?.nextRetryAt === "string" ? { nextRetryAt: data.nextRetryAt } : {}),
    ...(typeof data?.provider === "string" ? { provider: data.provider } : {}),
    ...(typeof data?.errorCode === "string" ? { errorCode: data.errorCode } : {}),
    ...(typeof data?.scope === "string" ? { scope: data.scope } : {}),
    ...(typeof data?.maxAttempts === "number" ? { maxAttempts: data.maxAttempts } : {}),
    ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
    ...(typeof data?.retryAfterMs === "number" ? { retryAfterMs: data.retryAfterMs } : {}),
  };
}

// A mid-turn `sandbox_disconnected` recovery: the prompt is being re-run on a
// freshly-spawned sandbox. Projected as a soft `retry_status` inline note (not a
// failure) so the transcript shows "retrying", reusing the existing renderer.
function projectPromptRetrying(data: Record<string, unknown> | undefined, index: number): RetryStatusActivityEvent {
  const attempt = typeof data?.attempt === "number" ? data.attempt : Number(data?.attempt ?? 0);
  const cap = typeof data?.cap === "number" ? data.cap : undefined;
  const retryPromptId = typeof data?.retryPromptId === "string" ? data.retryPromptId : resolvePromptId(data);
  return {
    type: "retry_status",
    // Key off retryPromptId (always present in the emitted payload, unique per
    // retry) rather than the index, so the id is stable across replays. The
    // event's `timestamp` lives at the top level, not inside `data`.
    id: `pr-retry-${retryPromptId ?? index}`,
    ...(retryPromptId ? { promptId: retryPromptId } : {}),
    attempt,
    message: "Sandbox dropped mid-task; retrying on a fresh sandbox",
    scope: "sandbox_disconnect",
    ...(cap !== undefined ? { maxAttempts: cap } : {}),
    ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
  };
}

function projectMemoryUsage(data: Record<string, unknown> | undefined, index: number): MemoryUsageActivityEvent {
  const activeMemoryIds = Array.isArray(data?.activeMemoryIds)
    ? data.activeMemoryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const activeMemories = mergeMemoryRefs(activeMemoryIds, data?.activeMemories);
  return {
    type: "memory_usage",
    id: `mem-${data?.timestamp ?? index}`,
    activeMemoryIds,
    activeMemories,
    usageSource: data?.usageSource === "company_bootstrap" ? "company_bootstrap" : "prompt_start",
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
  };
}

function projectMemoryRecallUsage(
  data: Record<string, unknown> | undefined,
  index: number,
): MemoryRecallUsageActivityEvent {
  const requestedMemoryIds = Array.isArray(data?.requestedMemoryIds)
    ? data.requestedMemoryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const returnedMemoryIds = Array.isArray(data?.returnedMemoryIds)
    ? data.returnedMemoryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const requestedMemories = mergeMemoryRefs(requestedMemoryIds, data?.requestedMemories);
  const returnedMemories = mergeMemoryRefs(returnedMemoryIds, data?.returnedMemories);
  const eventName = typeof data?.eventName === "string" ? data.eventName : "memory_recall.returned";
  return {
    type: "memory_recall_usage",
    id: `mrec-${data?.timestamp ?? index}-${eventName}`,
    eventName,
    requestedMemoryIds,
    returnedMemoryIds,
    requestedMemories,
    returnedMemories,
    usageSource: data?.usageSource === "company_recall" ? "company_recall" : "recall",
    ...(typeof data?.intent === "string" && data.intent.trim() ? { intent: data.intent.trim() } : {}),
    ...(typeof data?.tool === "string" && data.tool.trim() ? { tool: data.tool.trim() } : {}),
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
  };
}

function mergeMemoryRefs(ids: readonly string[], rawRefs: unknown): MemoryRef[] {
  const byId = new Map<string, MemoryRef>();
  if (Array.isArray(rawRefs)) {
    for (const entry of rawRefs) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) continue;
      const ref: MemoryRef = { id };
      if (typeof record.path === "string" && record.path.trim()) ref.path = record.path.trim();
      if (typeof record.title === "string" && record.title.trim()) ref.title = record.title.trim();
      if (typeof record.selectionRank === "number") ref.selectionRank = record.selectionRank;
      if (typeof record.selectionScore === "number") ref.selectionScore = record.selectionScore;
      if (typeof record.reason === "string" && record.reason.trim()) ref.reason = record.reason.trim();
      if (typeof record.expectedEffect === "string" && record.expectedEffect.trim()) {
        ref.expectedEffect = record.expectedEffect.trim();
      }
      if (typeof record.observedEffect === "string" && record.observedEffect.trim()) {
        ref.observedEffect = record.observedEffect.trim();
      }
      byId.set(id, ref);
    }
  }
  return ids.map((id) => byId.get(id) ?? { id });
}

function projectAgentTimeline(data: Record<string, unknown> | undefined, index: number): AgentTimelineActivityEvent {
  return {
    type: "agent_timeline",
    id: `atl-${index}-${typeof data?.eventType === "string" ? data.eventType : "unknown"}`,
    eventType: typeof data?.eventType === "string" ? data.eventType : "unknown",
    source: typeof data?.source === "string" ? data.source : "observed",
    observer: typeof data?.observer === "string" ? data.observer : "unknown",
    summary: typeof data?.summary === "string" ? data.summary : "Observed agent timeline event.",
    ...(typeof data?.status === "string" ? { status: data.status } : {}),
    ...(isRecord(data?.metadata) ? { metadata: data.metadata } : {}),
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
  };
}

function projectAgentProgress(data: Record<string, unknown> | undefined, index: number): AgentProgressActivityEvent {
  const promptId = resolvePromptId(data);
  return {
    type: "agent_progress",
    id: resolveEventId(data, "ap", index),
    step: typeof data?.step === "string" ? data.step : "unknown",
    label: typeof data?.label === "string" ? data.label : "Working",
    terminal: data?.terminal === true,
    ...(promptId ? { promptId } : {}),
  };
}

function projectAgentProgressEvent(data: Record<string, unknown> | undefined, state: FlattenState): void {
  const event = projectAgentProgress(data, state.merged.length);
  const key = `${event.promptId ?? ""}\u0000${event.step}`;
  const existingIdx = state.agentProgressIndexByKey.get(key);
  if (existingIdx !== undefined) {
    const existing = state.merged[existingIdx];
    state.merged[existingIdx] = existing.type === "agent_progress" ? { ...event, id: existing.id } : event;
    return;
  }
  state.agentProgressIndexByKey.set(key, state.merged.length);
  state.merged.push(event);
}

function projectSessionError(data: Record<string, unknown> | undefined, index: number): SessionErrorActivityEvent {
  return {
    type: "session_error",
    id: resolveEventId(data, "err", index),
    error: typeof data?.error === "string" ? data.error : "Unknown error",
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    ...(typeof data?.code === "string" ? { code: data.code } : {}),
  };
}

function recordMalformedSearchBlock(data: Record<string, unknown> | undefined, state: FlattenState): void {
  if (!isMalformedSearchBlockedError(data?.error)) return;
  const promptId = resolvePromptId(data);
  if (promptId) {
    state.malformedSearchBlockedPromptIds.add(promptId);
  } else {
    state.malformedSearchBlockedWithoutPrompt = true;
  }
}

function projectSessionResumedCold(
  data: Record<string, unknown> | undefined,
  index: number,
): SessionResumedColdActivityEvent {
  return {
    type: "session_resumed_cold",
    id: resolveEventId(data, "rescold", index),
    ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
    ...(typeof data?.lostSnapshotImageId === "string"
      ? { lostSnapshotImageId: data.lostSnapshotImageId }
      : data?.lostSnapshotImageId === null
        ? { lostSnapshotImageId: null }
        : {}),
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
  };
}

function projectRawCodex(data: Record<string, unknown> | undefined, index: number): RawCodexActivityEvent | null {
  const partType = typeof data?.partType === "string" ? data.partType : undefined;
  const eventType = typeof data?.eventType === "string" ? data.eventType : undefined;
  if (partType === "text") return null;
  if (eventType && RAW_CODEX_NOISE.has(eventType)) return null;
  return {
    type: "raw_agent_runtime",
    id: resolveEventId(data, "raw", index),
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    ...(partType ? { partType } : {}),
    ...(eventType ? { eventType } : {}),
    data: data ?? {},
  };
}

function projectPatch(data: Record<string, unknown> | undefined, index: number): PatchActivityEvent | null {
  const files = Array.isArray(data?.files) ? data.files.filter((item): item is string => typeof item === "string") : [];
  if (files.length === 0) return null;
  return {
    type: "patch",
    id: `patch-${index}`,
    files,
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
  };
}

function projectStream(
  type: StreamActivityType,
  data: Record<string, unknown> | undefined,
  state: FlattenState,
  timestampMs?: number,
): void {
  coalesceStreamDelta(
    state.merged,
    state.streams,
    type,
    resolveEventId(data, type, state.merged.length),
    resolveTextValue(data),
    resolvePromptId(data),
    timestampMs,
  );
}

function projectToolCall(data: Record<string, unknown> | undefined, state: FlattenState): void {
  const id = resolveEventId(data, "tool", state.merged.length);
  const existingIdx = state.toolCallIndexById.get(id);
  if (existingIdx !== undefined) {
    const previous = state.merged[existingIdx];
    if (previous.type === "tool_call") {
      const toolStatus = normalizeToolStatus(data?.toolStatus);
      const input = isRecord(data?.input) ? data.input : undefined;
      const nextEntry: ToolCallMergeInput = {
        type: "tool_call",
        id,
        ...(typeof data?.tool === "string"
          ? { tool: data.tool }
          : typeof data?.toolName === "string"
            ? { tool: data.toolName }
            : {}),
        ...(typeof data?.summary === "string" && data.summary.length > 0 ? { summary: data.summary } : {}),
        ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
        ...(input && Object.keys(input).length > 0 ? { input } : {}),
        ...(toolStatus ? { toolStatus } : {}),
        ...(typeof data?.truncated === "boolean" ? { truncated: data.truncated } : {}),
        ...(typeof data?.inputEstimatedTokens === "number" ? { inputEstimatedTokens: data.inputEstimatedTokens } : {}),
        ...(typeof data?.outputEstimatedTokens === "number"
          ? { outputEstimatedTokens: data.outputEstimatedTokens }
          : {}),
        ...(typeof data?.outputChars === "number" ? { outputChars: data.outputChars } : {}),
        ...(isRecord(data?.failure) ? { failure: data.failure as ToolFailureReport } : {}),
      };
      state.merged[existingIdx] = mergeToolCall(previous, nextEntry);
    }
  } else {
    const toolStatus = normalizeToolStatus(data?.toolStatus);
    const nextEntry: ToolCallActivityEvent = {
      type: "tool_call",
      id,
      tool: typeof data?.tool === "string" ? data.tool : typeof data?.toolName === "string" ? data.toolName : "unknown",
      summary: typeof data?.summary === "string" ? data.summary : "",
      ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
      ...(isRecord(data?.input) ? { input: data.input } : {}),
      ...(toolStatus ? { toolStatus } : {}),
      ...(typeof data?.truncated === "boolean" ? { truncated: data.truncated } : {}),
      ...(typeof data?.inputEstimatedTokens === "number" ? { inputEstimatedTokens: data.inputEstimatedTokens } : {}),
      ...(typeof data?.outputEstimatedTokens === "number" ? { outputEstimatedTokens: data.outputEstimatedTokens } : {}),
      ...(typeof data?.outputChars === "number" ? { outputChars: data.outputChars } : {}),
      ...(isRecord(data?.failure) ? { failure: data.failure as ToolFailureReport } : {}),
    };
    state.toolCallIndexById.set(id, state.merged.length);
    state.merged.push(nextEntry);
  }
}

function projectToolUpdate(data: Record<string, unknown> | undefined, state: FlattenState): void {
  const id = typeof data?.id === "string" ? data.id : "";
  const existingIdx = state.toolCallIndexById.get(id);
  if (existingIdx === undefined) return;
  const previous = state.merged[existingIdx];
  if (previous.type === "tool_call") {
    state.merged[existingIdx] = applyToolCallUpdate(previous, data);
  }
}

function projectQuestion(data: Record<string, unknown> | undefined, state: FlattenState): void {
  const question: QuestionActivityEvent = {
    type: "question",
    id: resolveEventId(data, "question", state.merged.length),
    question: typeof data?.question === "string" ? data.question : "",
    answer: data?.answer == null ? null : String(data.answer),
    ...(resolvePromptId(data) ? { promptId: resolvePromptId(data) } : {}),
    ...(Array.isArray(data?.options)
      ? { options: data.options as Array<string | { label: string; description?: string }> }
      : {}),
  };
  state.questionIndexById.set(question.id, state.merged.length);
  state.merged.push(question);
}

function applyAnswer(data: Record<string, unknown> | undefined, state: FlattenState): void {
  const questionId = typeof data?.id === "string" ? data.id : undefined;
  if (!questionId) return;
  const existingIdx = state.questionIndexById.get(questionId);
  if (existingIdx === undefined) return;
  const existing = state.merged[existingIdx];
  if (existing?.type === "question") {
    state.merged[existingIdx] = {
      ...existing,
      answer: data?.answer == null ? null : String(data.answer),
    };
  }
}

function applyTodoUpdate(data: Record<string, unknown> | undefined, state: FlattenState): void {
  const todos = Array.isArray(data?.todos) ? data.todos : [];
  if (todos.length === 0) return;
  for (let index = state.merged.length - 1; index >= 0; index--) {
    const existing = state.merged[index];
    if (existing.type === "tool_call" && existing.tool.toLowerCase() === "todowrite") {
      state.merged[index] = { ...existing, input: { ...existing.input, todos } };
      break;
    }
  }
}

export function flattenSessionEvents(raw: RawSessionEvent[]): ActivityEvent[] {
  const state = createFlattenState();
  const normalizedEvents = normalizeRawSessionEvents(raw);

  for (const normalized of normalizedEvents) {
    const { type } = normalized;
    const data = normalized.data;

    switch (type) {
      case "sandbox_compaction_start":
        pushEvent(state, projectCompactionStart(data, state.merged.length));
        break;
      case "sandbox_compaction_complete":
        pushEvent(state, projectCompactionComplete(data, state.merged.length));
        break;
      case "sandbox_context_fill_warning":
        pushEvent(state, projectContextFillWarning(data, state.merged.length));
        break;
      case "sandbox_tool_truncated":
        pushEvent(state, projectToolTruncated(data, state.merged.length));
        break;
      case "retry_status":
        pushEvent(state, projectRetryStatus(data, state.merged.length));
        break;
      case "prompt_retrying":
        pushEvent(state, projectPromptRetrying(data, state.merged.length));
        break;
      case "memory_usage":
        pushEvent(state, projectMemoryUsage(data, state.merged.length));
        break;
      case "memory_recall_usage":
        pushEvent(state, projectMemoryRecallUsage(data, state.merged.length));
        break;
      case "agent_timeline":
        pushEvent(state, projectAgentTimeline(data, state.merged.length));
        break;
      case "prompt_activity":
        break;
      case "agent_progress":
        projectAgentProgressEvent(data, state);
        break;
      case "session_error":
        recordMalformedSearchBlock(data, state);
        pushEvent(state, projectSessionError(data, state.merged.length));
        break;
      case "session_resumed_cold":
        pushEvent(state, projectSessionResumedCold(data, state.merged.length));
        break;
      case "raw_agent_runtime":
        pushEvent(state, projectRawCodex(data, state.merged.length));
        break;
      case "reasoning":
        projectStream("reasoning", data, state, getRawSessionEventTimestampMs(normalized.raw));
        break;
      case "text":
        projectStream("text", data, state);
        break;
      case "patch":
        pushEvent(state, projectPatch(data, state.merged.length));
        break;
      case "todo_update":
        applyTodoUpdate(data, state);
        break;
      case "answer":
        applyAnswer(data, state);
        break;
      case "tool_call":
        projectToolCall(data, state);
        break;
      case "tool_update":
        projectToolUpdate(data, state);
        break;
      case "question":
        projectQuestion(data, state);
        break;
    }
  }

  return suppressMalformedSearchSegments(state);
}

export function filterEventsForPrompt<T extends RawSessionEvent>(allEvents: T[], promptId: string): T[] {
  const bucket: T[] = [];
  let currentPromptId: string | null = null;

  for (const event of normalizeRawSessionEvents(allEvents)) {
    const explicitPromptId = event.promptId ?? null;
    if (event.type === "prompt_processing") {
      currentPromptId = explicitPromptId === promptId ? promptId : null;
    }
    if (explicitPromptId === promptId || currentPromptId === promptId) {
      bucket.push(event.raw);
    }
  }

  return bucket;
}

export function partitionEventsByPrompt<T extends RawSessionEvent>(
  allEvents: T[],
  promptIds: string[],
): Map<string, T[]> {
  const promptSet = new Set(promptIds);
  const buckets = new Map<string, T[]>(promptIds.map((id) => [id, []]));
  let currentPromptId: string | null = null;

  for (const event of normalizeRawSessionEvents(allEvents)) {
    const eventPromptId = event.promptId;
    const explicitPromptId = typeof eventPromptId === "string" && promptSet.has(eventPromptId) ? eventPromptId : null;
    if (event.type === "prompt_processing") {
      currentPromptId = explicitPromptId;
    }
    const targetPromptId = explicitPromptId ?? currentPromptId;
    if (targetPromptId) {
      const bucket = buckets.get(targetPromptId);
      if (bucket) bucket.push(event.raw);
    }
  }

  return buckets;
}

function getEmbeddedTerminalHistoryFromNormalized<T extends RawSessionEvent>(
  normalizedEvents: NormalizedRawSessionEvent<T>[],
): T[] | null {
  for (let index = normalizedEvents.length - 1; index >= 0; index--) {
    const event = normalizedEvents[index];
    if (event.type !== "prompt_completed" && event.type !== "prompt_failed") continue;
    const history = event.data?.history;
    if (!Array.isArray(history) || history.length === 0) return null;
    return history as T[];
  }
  return null;
}

function promptActivityKey(event: NormalizedRawSessionEvent): string {
  const data = event.data;
  return [
    event.promptId ?? "",
    typeof data?.phase === "string" ? data.phase : "",
    typeof data?.detail === "string" ? data.detail : "",
  ].join("\u0000");
}

function agentProgressKey(event: NormalizedRawSessionEvent): string {
  const data = event.data;
  return [event.promptId ?? "", typeof data?.step === "string" ? data.step : ""].join("\u0000");
}

export type AuthoritativePromptEventsDiagnostics = {
  embeddedHistoryPresent: boolean;
  durablePromptActivityCount: number;
  embeddedPromptActivityCount: number;
  mergedDurablePromptActivityCount: number;
  duplicateDurablePromptActivityCount: number;
  durableAgentProgressCount: number;
  embeddedAgentProgressCount: number;
  mergedDurableAgentProgressCount: number;
  duplicateDurableAgentProgressCount: number;
};

export type AuthoritativePromptEventsResult<T extends RawSessionEvent> = {
  events: T[];
  diagnostics: AuthoritativePromptEventsDiagnostics;
};

export function resolveAuthoritativePromptEventsWithDiagnostics<T extends RawSessionEvent>(
  raw: T[],
): AuthoritativePromptEventsResult<T> {
  const normalizedRaw = normalizeRawSessionEvents(raw);
  const embeddedHistory = getEmbeddedTerminalHistoryFromNormalized(normalizedRaw);
  const durablePromptActivity = normalizedRaw.filter((event) => event.type === "prompt_activity");
  const durableAgentProgress = normalizedRaw.filter((event) => event.type === "agent_progress");
  if (!embeddedHistory) {
    return {
      events: raw,
      diagnostics: {
        embeddedHistoryPresent: false,
        durablePromptActivityCount: durablePromptActivity.length,
        embeddedPromptActivityCount: 0,
        mergedDurablePromptActivityCount: 0,
        duplicateDurablePromptActivityCount: 0,
        durableAgentProgressCount: durableAgentProgress.length,
        embeddedAgentProgressCount: 0,
        mergedDurableAgentProgressCount: 0,
        duplicateDurableAgentProgressCount: 0,
      },
    };
  }

  const normalizedEmbeddedHistory = normalizeRawSessionEvents(embeddedHistory);
  const embeddedPromptActivity = normalizedEmbeddedHistory.filter((event) => event.type === "prompt_activity");
  const embeddedAgentProgress = normalizedEmbeddedHistory.filter((event) => event.type === "agent_progress");
  const embeddedPromptActivityKeys = new Set(embeddedPromptActivity.map(promptActivityKey));
  const embeddedAgentProgressKeys = new Set(embeddedAgentProgress.map(agentProgressKey));
  const embeddedPromptActivityCount = embeddedPromptActivity.length;
  const embeddedAgentProgressCount = embeddedAgentProgress.length;
  let duplicateDurablePromptActivityCount = 0;
  let duplicateDurableAgentProgressCount = 0;
  const missingDurablePromptActivity = durablePromptActivity.filter((event) => {
    const key = promptActivityKey(event);
    if (embeddedPromptActivityKeys.has(key)) {
      duplicateDurablePromptActivityCount += 1;
      return false;
    }
    embeddedPromptActivityKeys.add(key);
    return true;
  });
  const missingDurableAgentProgress = durableAgentProgress.filter((event) => {
    const key = agentProgressKey(event);
    if (embeddedAgentProgressKeys.has(key)) {
      duplicateDurableAgentProgressCount += 1;
      return false;
    }
    embeddedAgentProgressKeys.add(key);
    return true;
  });
  const missingDurableSideChannelEvents = [...missingDurablePromptActivity, ...missingDurableAgentProgress].map(
    (event) => event.raw,
  );

  return {
    events:
      missingDurableSideChannelEvents.length > 0
        ? ([...missingDurableSideChannelEvents, ...embeddedHistory] as T[])
        : embeddedHistory,
    diagnostics: {
      embeddedHistoryPresent: true,
      durablePromptActivityCount: durablePromptActivity.length,
      embeddedPromptActivityCount,
      mergedDurablePromptActivityCount: missingDurablePromptActivity.length,
      duplicateDurablePromptActivityCount,
      durableAgentProgressCount: durableAgentProgress.length,
      embeddedAgentProgressCount,
      mergedDurableAgentProgressCount: missingDurableAgentProgress.length,
      duplicateDurableAgentProgressCount,
    },
  };
}

export function resolveAuthoritativePromptEvents<T extends RawSessionEvent>(raw: T[]): T[] {
  return resolveAuthoritativePromptEventsWithDiagnostics(raw).events;
}
