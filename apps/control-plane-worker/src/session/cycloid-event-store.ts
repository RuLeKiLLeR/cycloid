import type { BridgeCompatPayload, CycloidEvent, Phase } from "../../../../shared/events/schema.js";
import { redactSecretsInValue } from "../../../../shared/observability/redact.js";
import { isRecord } from "../../../../shared/utils/type-guards.js";
import type { SessionEvent } from "../types";
import { toClientErrorDetailsFromUnknown } from "./client-error-details.js";
import { generateToolSummary } from "./tool-summary.js";

type StoredCycloidEvent = CycloidEvent<Phase>;

type SimpleDurableEntry = {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  eventId?: string;
};

type TransportDurableEntry = SimpleDurableEntry & {
  transportEvent: StoredCycloidEvent;
};

export type DurableEntry = SimpleDurableEntry | TransportDurableEntry;

type SessionEventRowMeta = {
  sequence: number;
  eventId: string;
  timestamp: string;
};

function compatPayload(event: StoredCycloidEvent): Record<string, unknown> & BridgeCompatPayload {
  return event.payload as Record<string, unknown> & BridgeCompatPayload;
}

function bridgeData(event: StoredCycloidEvent): Record<string, unknown> {
  const payload = compatPayload(event);
  return isRecord(payload.bridgeData) ? { ...payload.bridgeData } : {};
}

function sanitizeBridgeDataErrorDetails(rawBridgeData: Record<string, unknown>): Record<string, unknown> {
  if (!("errorDetails" in rawBridgeData)) return rawBridgeData;
  const errorDetails = toClientErrorDetailsFromUnknown(rawBridgeData.errorDetails);
  if (errorDetails) return { ...rawBridgeData, errorDetails };
  const { errorDetails: _errorDetails, ...rest } = rawBridgeData;
  return rest;
}

function sanitizeStoredCycloidEvent(event: StoredCycloidEvent): StoredCycloidEvent {
  const payload = compatPayload(event);
  const rawBridgeData = bridgeData(event);

  if (event.phase === "error") {
    const details = "details" in payload ? toClientErrorDetailsFromUnknown(payload.details) : null;
    const sanitizedBridgeData = sanitizeBridgeDataErrorDetails(rawBridgeData);
    if (!details && !("details" in payload) && sanitizedBridgeData === rawBridgeData) return event;
    const { details: _details, ...payloadWithoutDetails } = payload;
    return {
      ...event,
      payload: {
        ...payloadWithoutDetails,
        ...(details ? { details } : {}),
        ...(sanitizedBridgeData !== rawBridgeData ? { bridgeData: sanitizedBridgeData } : {}),
      },
    };
  }

  if (event.phase === "prompt.complete") {
    const errorDetails = "errorDetails" in payload ? toClientErrorDetailsFromUnknown(payload.errorDetails) : null;
    const sanitizedBridgeData = sanitizeBridgeDataErrorDetails(rawBridgeData);
    if (!errorDetails && !("errorDetails" in payload) && sanitizedBridgeData === rawBridgeData) return event;
    const { errorDetails: _errorDetails, ...payloadWithoutErrorDetails } = payload;
    return {
      ...event,
      payload: {
        ...payloadWithoutErrorDetails,
        ...(errorDetails ? { errorDetails } : {}),
        ...(sanitizedBridgeData !== rawBridgeData ? { bridgeData: sanitizedBridgeData } : {}),
      },
    };
  }

  return event;
}

/**
 * Strip injected credentials (ghs_/github_pat_/sk-ant-/Bearer/connection strings,
 * etc.) from an event's payload before it is projected for broadcast, persistence,
 * and replay. Tool-call args, free-text deltas, and bridgeData can all carry raw
 * secrets the agent observed in the sandbox; field-precise redaction scrubs the
 * secret substrings while preserving the surrounding structure analysts and the UI
 * rely on. Returns the original event when no secret is present (no allocation on
 * the secret-free hot path). Non-payload fields (ids, timestamps) never hold
 * secrets, so only the payload is walked.
 */
export function redactCycloidEventSecrets<T extends StoredCycloidEvent>(event: T): T {
  const redactedPayload = redactSecretsInValue(event.payload);
  if (redactedPayload === event.payload) return event;
  return { ...event, payload: redactedPayload as T["payload"] };
}

function resolveBridgeEventType(event: StoredCycloidEvent): string {
  const payload = compatPayload(event);
  if (typeof payload.bridgeEventType === "string" && payload.bridgeEventType.length > 0) {
    return payload.bridgeEventType;
  }

  switch (event.phase) {
    case "bridge.connect":
      return "heartbeat";
    case "prompt.dispatch":
      return "prompt_accepted";
    case "text.delta":
      return payload.channel === "reasoning" ? "reasoning" : "token";
    case "tool.call":
      return "tool_call";
    case "tool.result":
      return "tool_result";
    case "prompt.complete":
      return "execution_complete";
    case "git.push":
      return payload.success === false ? "push_error" : "push_complete";
    case "error":
      return "error";
    case "user_question":
      return "question";
    case "idle":
      return "session_idle";
    case "agent.session.create":
      return "agent_session_created";
    case "timeline":
      return "agent_timeline";
    case "bridge.event":
      return typeof payload.bridgeEventType === "string" ? payload.bridgeEventType : "bridge_event";
    default:
      return event.phase;
  }
}

function timestampIso(event: StoredCycloidEvent): string {
  return new Date(event.timestampMs).toISOString();
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Session events are persisted and replayed to session viewers (and broadcast
// live over WS), so internal selector/retrieval traces — which include claims
// from candidates that were NOT injected into the session — must never reach
// that surface. Bounded identifiers and returned-memory refs stay: those
// memories were injected into the session and power the feedback UI.
export function omitMemoryRecallTraceFields(data: Record<string, unknown>): Record<string, unknown> {
  const { retrievalTrace: _retrievalTrace, decisionTrace: _decisionTrace, ...rest } = data;
  return rest;
}

function buildSandboxEventData(
  event: StoredCycloidEvent,
  bridgeEventType: string,
  rawBridgeData: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    type: bridgeEventType,
    timestamp: event.timestampMs,
    ...rawBridgeData,
  };

  if (typeof event.promptId === "string" && event.promptId.length > 0 && data.messageId === undefined) {
    data.messageId = event.promptId;
  }
  if (typeof event.sandboxId === "string" && event.sandboxId.length > 0 && data.sandboxId === undefined) {
    data.sandboxId = event.sandboxId;
  }

  return data;
}

function isFinalAnswerEvent(event: StoredCycloidEvent, bridgeEventType: string): boolean {
  const payload = compatPayload(event);
  return bridgeEventType === "final_answer" || payload.bridgeEventType === "final_answer";
}

function buildAgentTimelineData(
  payload: Record<string, unknown>,
  rawData: Record<string, unknown>,
): Record<string, unknown> {
  const eventType =
    typeof payload.eventType === "string"
      ? payload.eventType
      : typeof rawData.eventType === "string"
        ? rawData.eventType
        : "unknown";
  const summary =
    typeof payload.summary === "string"
      ? payload.summary
      : typeof rawData.summary === "string"
        ? rawData.summary
        : eventType;
  const source =
    typeof payload.source === "string"
      ? payload.source
      : typeof rawData.source === "string"
        ? rawData.source
        : "observed";
  const observer =
    typeof payload.observer === "string"
      ? payload.observer
      : typeof rawData.observer === "string"
        ? rawData.observer
        : "sandbox_bridge";
  const metadata = isRecord(payload.metadata)
    ? payload.metadata
    : isRecord(rawData.metadata)
      ? rawData.metadata
      : undefined;
  const status =
    typeof payload.status === "string"
      ? payload.status
      : typeof rawData.status === "string"
        ? rawData.status
        : undefined;

  return {
    eventType,
    source,
    observer,
    summary,
    ...(status ? { status } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function translateCycloidEventToSandboxEvent(
  event: StoredCycloidEvent & { ackId?: string },
): Record<string, unknown> {
  const data = buildSandboxEventData(event, resolveBridgeEventType(event), bridgeData(event));
  if (typeof event.ackId === "string" && event.ackId.length > 0) {
    data.ackId = event.ackId;
  }
  return data;
}

export function projectCycloidEventToDurableEntry(event: StoredCycloidEvent): TransportDurableEntry | null {
  // Redact secrets first so every downstream surface -- data.input args, the
  // persisted transportEvent, and all derived fields -- is sourced from a scrubbed
  // event. This is the single chokepoint feeding broadcast (WS/SSE), persistence,
  // and replay/history.
  const sanitizedEvent = redactCycloidEventSecrets(sanitizeStoredCycloidEvent(event));
  const payload = compatPayload(sanitizedEvent);
  const rawBridgeData = bridgeData(sanitizedEvent);
  const bridgeEventType = resolveBridgeEventType(sanitizedEvent);
  const timestamp = timestampIso(sanitizedEvent);

  switch (bridgeEventType) {
    case "token":
    case "final_answer": {
      if (
        typeof payload.text !== "string" ||
        payload.text.length === 0 ||
        typeof payload.partId !== "string" ||
        payload.partId.length === 0
      ) {
        return null;
      }
      return {
        type: "text",
        timestamp,
        data: {
          id: payload.partId,
          text: payload.text,
          ...(isFinalAnswerEvent(sanitizedEvent, bridgeEventType) ? { finalAnswer: true } : {}),
        },
        transportEvent: sanitizedEvent,
      };
    }
    case "reasoning": {
      if (
        typeof payload.text !== "string" ||
        payload.text.length === 0 ||
        typeof payload.partId !== "string" ||
        payload.partId.length === 0
      ) {
        return null;
      }
      return {
        type: "reasoning",
        timestamp,
        data: {
          id: payload.partId,
          text: payload.text,
        },
        transportEvent: sanitizedEvent,
      };
    }
    case "tool_call": {
      if (typeof payload.tool !== "string" || payload.tool.length === 0) return null;
      const args = isRecord(payload.args) ? payload.args : {};
      const summary =
        typeof payload.summary === "string" && payload.summary.length > 0
          ? payload.summary
          : generateToolSummary(payload.tool, args);
      const data: Record<string, unknown> = {
        id: payload.callId ?? "",
        tool: payload.tool,
        input: args,
        summary,
      };
      const inputEstimatedTokens = numeric(rawBridgeData.inputEstimatedTokens);
      if (inputEstimatedTokens !== undefined) data.inputEstimatedTokens = inputEstimatedTokens;
      return { type: "tool_call", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "tool_update": {
      const data: Record<string, unknown> = {
        id: typeof rawBridgeData.callId === "string" ? rawBridgeData.callId : "",
        status: typeof rawBridgeData.status === "string" ? rawBridgeData.status : "",
      };
      const outputEstimatedTokens = numeric(rawBridgeData.outputEstimatedTokens);
      if (outputEstimatedTokens !== undefined) data.outputEstimatedTokens = outputEstimatedTokens;
      const outputChars = numeric(rawBridgeData.outputChars);
      if (outputChars !== undefined) data.outputChars = outputChars;
      if (isRecord(rawBridgeData.failure)) data.failure = rawBridgeData.failure;
      return { type: "tool_update", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "tool_result": {
      const error =
        typeof payload.error === "string"
          ? payload.error
          : typeof rawBridgeData.error === "string"
            ? rawBridgeData.error
            : undefined;
      const data: Record<string, unknown> = {
        id:
          typeof payload.callId === "string"
            ? payload.callId
            : typeof rawBridgeData.callId === "string"
              ? rawBridgeData.callId
              : "",
        status: error === undefined ? "completed" : "error",
      };
      if (payload.result !== undefined) data.output = payload.result;
      if (error !== undefined) data.error = error;
      return { type: "tool_update", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "question": {
      if (typeof payload.questionId !== "string" || typeof payload.question !== "string") return null;
      const data: Record<string, unknown> = {
        id: payload.questionId,
        question: payload.question,
      };
      if (Array.isArray(payload.options) && payload.options.length > 0) data.options = payload.options;
      return { type: "question", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "patch": {
      const files = Array.isArray(rawBridgeData.files)
        ? rawBridgeData.files.filter((file): file is string => typeof file === "string")
        : [];
      if (files.length === 0) return null;
      return {
        type: "patch",
        timestamp,
        data: { files },
        transportEvent: sanitizedEvent,
      };
    }
    case "usage": {
      const data: Record<string, unknown> = {
        inputTokens: rawBridgeData.inputTokens ?? 0,
        outputTokens: rawBridgeData.outputTokens ?? 0,
        contextTokens: rawBridgeData.contextTokens ?? 0,
        cacheReadTokens: rawBridgeData.cacheReadTokens ?? 0,
        cacheWriteTokens: rawBridgeData.cacheWriteTokens ?? 0,
        totalCostUsd: rawBridgeData.totalCostUsd ?? 0,
        model: rawBridgeData.model,
      };
      for (const key of [
        "contextWindow",
        "peakContextTokens",
        "contextCacheRead",
        "contextCacheWrite",
        "contextUncachedInput",
        "cumulativeCacheRead",
        "cumulativeCacheWrite",
        "instructionFilesEst",
      ] as const) {
        if (rawBridgeData[key] !== undefined) data[key] = rawBridgeData[key];
      }
      return { type: "usage", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "session_idle": {
      const data: Record<string, unknown> = {};
      for (const key of ["sessionEditCount", "sessionPromptCount"] as const) {
        const value = numeric(rawBridgeData[key]);
        if (value !== undefined) data[key] = value;
      }
      return { type: "session_idle", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "prompt_result":
      return { type: "prompt_result", timestamp, data: {}, transportEvent: sanitizedEvent };
    case "todo_update":
      return {
        type: "todo_update",
        timestamp,
        data: { todos: rawBridgeData.todos ?? [] },
        transportEvent: sanitizedEvent,
      };
    case "retry_status": {
      const data: Record<string, unknown> = {
        timestamp: sanitizedEvent.timestampMs,
        attempt: rawBridgeData.attempt ?? 0,
        message: rawBridgeData.message ?? "Retrying...",
        nextRetryAt: rawBridgeData.nextRetryAt ?? "",
      };
      for (const key of ["provider", "errorCode", "scope", "maxAttempts", "reason", "retryAfterMs"] as const) {
        if (rawBridgeData[key] !== undefined) data[key] = rawBridgeData[key];
      }
      return { type: "retry_status", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "compaction_start": {
      const data: Record<string, unknown> = { timestamp: sanitizedEvent.timestampMs };
      const contextTokens = numeric(rawBridgeData.contextTokens);
      if (contextTokens !== undefined) data.contextTokens = contextTokens;
      return { type: "sandbox_compaction_start", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "compaction_complete": {
      const data: Record<string, unknown> = { timestamp: sanitizedEvent.timestampMs };
      const before = numeric(rawBridgeData.contextTokensBefore);
      const after = numeric(rawBridgeData.contextTokensAfter);
      if (before !== undefined) data.contextTokensBefore = before;
      if (after !== undefined) data.contextTokensAfter = after;
      return { type: "sandbox_compaction_complete", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "context_fill_warning": {
      const fillPercent = numeric(rawBridgeData.fillPercent);
      if (fillPercent === undefined) return null;
      const data: Record<string, unknown> = { timestamp: sanitizedEvent.timestampMs, fillPercent };
      const contextTokens = numeric(rawBridgeData.contextTokens);
      const contextWindow = numeric(rawBridgeData.contextWindow);
      if (contextTokens !== undefined) data.contextTokens = contextTokens;
      if (contextWindow !== undefined) data.contextWindow = contextWindow;
      return { type: "sandbox_context_fill_warning", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "raw_agent_runtime":
      return {
        type: "raw_agent_runtime",
        timestamp,
        data: { ...rawBridgeData },
        transportEvent: sanitizedEvent,
      };
    case "error": {
      const data: Record<string, unknown> = {
        error: typeof payload.message === "string" ? payload.message : "Unknown error",
        code: typeof payload.code === "string" ? payload.code : "unknown",
      };
      const errorDetails =
        toClientErrorDetailsFromUnknown(payload.details) ?? toClientErrorDetailsFromUnknown(rawBridgeData.errorDetails);
      if (errorDetails) data.errorDetails = errorDetails;
      return { type: "session_error", timestamp, data, transportEvent: sanitizedEvent };
    }
    case "push_error": {
      const branch =
        typeof rawBridgeData.branchName === "string"
          ? rawBridgeData.branchName
          : typeof payload.branch === "string"
            ? payload.branch
            : typeof rawBridgeData.branch === "string"
              ? rawBridgeData.branch
              : undefined;
      const error =
        typeof payload.error === "string"
          ? payload.error
          : typeof rawBridgeData.error === "string"
            ? rawBridgeData.error
            : "unknown";
      return {
        type: "session_error",
        timestamp,
        data: {
          error: `Push failed${branch ? ` (${branch})` : ""}: ${error}`,
          code: "push_error",
        },
        transportEvent: sanitizedEvent,
      };
    }
    case "memory_usage":
      return {
        type: "memory_usage",
        timestamp,
        data: {
          activeMemoryIds: rawBridgeData.activeMemoryIds ?? [],
          ...(Array.isArray(rawBridgeData.activeMemories) ? { activeMemories: rawBridgeData.activeMemories } : {}),
        },
        transportEvent: sanitizedEvent,
      };
    case "memory_recall_usage":
      return {
        type: "memory_recall_usage",
        timestamp,
        data: buildSandboxEventData(sanitizedEvent, "memory_recall_usage", omitMemoryRecallTraceFields(rawBridgeData)),
        transportEvent: sanitizedEvent,
      };
    case "agent_timeline":
      return {
        type: "agent_timeline",
        timestamp,
        data: buildAgentTimelineData(payload, rawBridgeData),
        transportEvent: sanitizedEvent,
      };
    case "prompt_activity":
      return {
        type: "prompt_activity",
        timestamp,
        data: buildSandboxEventData(sanitizedEvent, bridgeEventType, rawBridgeData),
        transportEvent: sanitizedEvent,
      };
    case "agent_progress":
      return {
        type: "agent_progress",
        timestamp,
        data: buildSandboxEventData(sanitizedEvent, bridgeEventType, rawBridgeData),
        transportEvent: sanitizedEvent,
      };
    default:
      if (sanitizedEvent.phase === "bridge.event") {
        return null;
      }
      return {
        type: `sandbox_${bridgeEventType}`,
        timestamp,
        data: buildSandboxEventData(sanitizedEvent, bridgeEventType, rawBridgeData),
        transportEvent: sanitizedEvent,
      };
  }
}

export function projectStoredCycloidEventToSessionEvent(
  meta: SessionEventRowMeta,
  event: StoredCycloidEvent,
): SessionEvent | null {
  const projected = projectCycloidEventToDurableEntry(event);
  if (!projected) return null;
  const data = { ...projected.data };
  if (
    typeof event.promptId === "string" &&
    event.promptId.length > 0 &&
    (data.promptId === undefined || data.promptId === "")
  ) {
    data.promptId = event.promptId;
  }
  return {
    sequence: meta.sequence,
    id: meta.eventId,
    type: projected.type,
    timestamp: meta.timestamp,
    data,
  };
}
