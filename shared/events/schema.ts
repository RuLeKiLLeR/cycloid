import type { AgentRuntimeBackend } from "../agent/agent-runtime-backend.js";
import {
  AGENT_TIMELINE_EVENT_TYPES,
  AGENT_TIMELINE_OBSERVERS,
  AGENT_TIMELINE_SOURCES,
  AGENT_TIMELINE_STATUSES,
  type AgentTimelineEventType,
  type AgentTimelineObserver,
  type AgentTimelineSource,
  type AgentTimelineStatus,
} from "../types/agent-timeline.js";
import { isRecord } from "../utils/type-guards.js";
import { VERIFICATION_PHASE_NAMES, type VerificationPhaseName } from "../verification/phase-artifacts.js";

const LEGACY_VERIFICATION_EVENT_PHASE_NAMES = ["verification-checker"] as const;
type VerificationEventPhaseName = VerificationPhaseName | (typeof LEGACY_VERIFICATION_EVENT_PHASE_NAMES)[number];
const VERIFICATION_EVENT_PHASE_NAMES = [...VERIFICATION_PHASE_NAMES, ...LEGACY_VERIFICATION_EVENT_PHASE_NAMES] as const;

export const PHASES = [
  "session.create",
  "sandbox.spawn",
  "bridge.connect",
  "bridge.event",
  "prompt.enqueue",
  "prompt.context",
  "prompt.dispatch",
  "agent.session.create",
  "tool.call",
  "tool.result",
  "text.delta",
  "prompt.complete",
  "git.push",
  "pr.open",
  "timeline",
  "error",
  "user_question",
  "idle",
] as const;

export type Phase = (typeof PHASES)[number];

export type CycloidSessionKind = "repo";
export type CycloidEventSource = "ui" | "cli" | "slack" | "api";
export type SandboxSpawnStatus = "requested" | "started" | "ready" | "failed";
export type BridgeConnectStatus = "connected" | "disconnected" | "reconnecting";
export type AgentSessionCreateStatus = "started" | "complete" | "failed";
export type TextDeltaChannel = "output" | "reasoning";

export type QuestionOption =
  | string
  | {
      label: string;
      description?: string;
    };

export type BridgeCompatPayload = {
  bridgeEventType?: string;
  bridgeData?: Record<string, unknown>;
};

export type CycloidPayloadByPhase = {
  "session.create": BridgeCompatPayload & {
    source: CycloidEventSource;
    sessionKind?: CycloidSessionKind;
  };
  "sandbox.spawn": BridgeCompatPayload & {
    status: SandboxSpawnStatus;
    attempt?: number;
    reason?: string;
  };
  "bridge.connect": BridgeCompatPayload & {
    status: BridgeConnectStatus;
  };
  "bridge.event": {
    bridgeEventType: string;
    bridgeData?: Record<string, unknown>;
    verificationPhase?: VerificationEventPhaseName;
    intermediate?: boolean;
  };
  "prompt.enqueue": BridgeCompatPayload & {
    actorUserId?: string | null;
    agent?: string;
    model?: string | null;
  };
  "prompt.context": BridgeCompatPayload;
  "prompt.dispatch": BridgeCompatPayload & {
    startupAttemptId?: string | null;
  };
  "agent.session.create": BridgeCompatPayload & {
    status: AgentSessionCreateStatus;
    agentSessionId?: string;
    agentRuntimeBackend?: AgentRuntimeBackend;
    agent?: string;
  };
  "tool.call": BridgeCompatPayload & {
    callId: string;
    tool: string;
    summary?: string;
    args?: Record<string, unknown>;
  };
  "tool.result": BridgeCompatPayload & {
    callId: string;
    tool: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  };
  "text.delta": BridgeCompatPayload & {
    channel: TextDeltaChannel;
    text: string;
    partId?: string;
  };
  "prompt.complete": BridgeCompatPayload & {
    success: boolean;
    error?: string;
    errorCode?: string;
    errorDetails?: unknown;
  };
  "git.push": BridgeCompatPayload & {
    branch: string;
    success: boolean;
    error?: string;
  };
  "pr.open": BridgeCompatPayload & {
    success: boolean;
    prUrl?: string;
    prNumber?: number;
    error?: string;
  };
  timeline: BridgeCompatPayload & {
    eventType: AgentTimelineEventType;
    source: AgentTimelineSource;
    observer: AgentTimelineObserver;
    summary: string;
    status?: AgentTimelineStatus;
    metadata?: Record<string, unknown>;
  };
  error: BridgeCompatPayload & {
    code?: string;
    message: string;
    details?: unknown;
  };
  user_question: BridgeCompatPayload & {
    questionId: string;
    question: string;
    options?: QuestionOption[];
  };
  idle: BridgeCompatPayload & {
    sessionEditCount?: number;
    sessionPromptCount?: number;
  };
};

export type CycloidEvent<P extends Phase = Phase> = {
  phase: P;
  timestampMs: number;
  sessionId: string;
  promptId?: string;
  sandboxId?: string;
  payload: CycloidPayloadByPhase[P];
};

export const REMOVED_BRIDGE_EVENT_TYPES = new Set([
  "step_start",
  "step_finish",
  "branch_changed",
  "subagent_start",
  "subagent_complete",
  "subagent_text",
  "subagent_tool_call",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value);
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function isQuestionOption(value: unknown): value is QuestionOption {
  return (
    typeof value === "string" ||
    (isRecord(value) && typeof value.label === "string" && isOptionalString(value.description))
  );
}

function hasValidCompatPayload(payload: Record<string, unknown>): boolean {
  return (
    isOptionalString(payload.bridgeEventType) &&
    !hasRemovedBridgeEventType(payload) &&
    isOptionalRecord(payload.bridgeData)
  );
}

function hasRemovedBridgeEventType(payload: Record<string, unknown>): boolean {
  return typeof payload.bridgeEventType === "string" && REMOVED_BRIDGE_EVENT_TYPES.has(payload.bridgeEventType);
}

function isPayloadForPhase(phase: Phase, payload: Record<string, unknown>): boolean {
  switch (phase) {
    case "session.create":
      return (
        hasValidCompatPayload(payload) &&
        isOneOf(payload.source, ["ui", "cli", "slack", "api"] as const) &&
        (payload.sessionKind === undefined || isOneOf(payload.sessionKind, ["repo"] as const))
      );
    case "sandbox.spawn":
      return (
        hasValidCompatPayload(payload) &&
        isOneOf(payload.status, ["requested", "started", "ready", "failed"] as const) &&
        (payload.attempt === undefined || isFiniteNumber(payload.attempt)) &&
        isOptionalString(payload.reason)
      );
    case "bridge.connect":
      return (
        hasValidCompatPayload(payload) &&
        isOneOf(payload.status, ["connected", "disconnected", "reconnecting"] as const)
      );
    case "bridge.event":
      return (
        typeof payload.bridgeEventType === "string" &&
        !hasRemovedBridgeEventType(payload) &&
        isOptionalRecord(payload.bridgeData) &&
        (payload.verificationPhase === undefined ||
          isOneOf(payload.verificationPhase, VERIFICATION_EVENT_PHASE_NAMES)) &&
        (payload.intermediate === undefined || typeof payload.intermediate === "boolean")
      );
    case "prompt.enqueue":
      return (
        hasValidCompatPayload(payload) &&
        isOptionalNullableString(payload.actorUserId) &&
        isOptionalString(payload.agent) &&
        isOptionalNullableString(payload.model)
      );
    case "prompt.context":
      return hasValidCompatPayload(payload);
    case "prompt.dispatch":
      return hasValidCompatPayload(payload) && isOptionalNullableString(payload.startupAttemptId);
    case "agent.session.create":
      return (
        hasValidCompatPayload(payload) &&
        isOneOf(payload.status, ["started", "complete", "failed"] as const) &&
        isOptionalString(payload.agentSessionId) &&
        isOptionalString(payload.agent)
      );
    case "tool.call":
      return (
        hasValidCompatPayload(payload) &&
        typeof payload.callId === "string" &&
        typeof payload.tool === "string" &&
        isOptionalString(payload.summary) &&
        (payload.args === undefined || isRecord(payload.args))
      );
    case "tool.result":
      return (
        hasValidCompatPayload(payload) &&
        typeof payload.callId === "string" &&
        typeof payload.tool === "string" &&
        typeof payload.ok === "boolean" &&
        isOptionalString(payload.error)
      );
    case "text.delta":
      return (
        hasValidCompatPayload(payload) &&
        isOneOf(payload.channel, ["output", "reasoning"] as const) &&
        typeof payload.text === "string" &&
        isOptionalString(payload.partId)
      );
    case "prompt.complete":
      return (
        hasValidCompatPayload(payload) &&
        typeof payload.success === "boolean" &&
        isOptionalString(payload.error) &&
        isOptionalString(payload.errorCode)
      );
    case "git.push":
      return (
        hasValidCompatPayload(payload) &&
        typeof payload.branch === "string" &&
        typeof payload.success === "boolean" &&
        isOptionalString(payload.error)
      );
    case "pr.open":
      return (
        hasValidCompatPayload(payload) &&
        typeof payload.success === "boolean" &&
        isOptionalString(payload.prUrl) &&
        (payload.prNumber === undefined || isFiniteNumber(payload.prNumber)) &&
        isOptionalString(payload.error)
      );
    case "timeline":
      return (
        hasValidCompatPayload(payload) &&
        isOneOf(payload.eventType, AGENT_TIMELINE_EVENT_TYPES) &&
        isOneOf(payload.source, AGENT_TIMELINE_SOURCES) &&
        isOneOf(payload.observer, AGENT_TIMELINE_OBSERVERS) &&
        typeof payload.summary === "string" &&
        payload.summary.trim().length > 0 &&
        (payload.status === undefined || isOneOf(payload.status, AGENT_TIMELINE_STATUSES)) &&
        (payload.metadata === undefined || isRecord(payload.metadata))
      );
    case "error":
      return hasValidCompatPayload(payload) && typeof payload.message === "string" && isOptionalString(payload.code);
    case "user_question":
      return (
        hasValidCompatPayload(payload) &&
        typeof payload.questionId === "string" &&
        typeof payload.question === "string" &&
        (payload.options === undefined || (Array.isArray(payload.options) && payload.options.every(isQuestionOption)))
      );
    case "idle":
      return (
        hasValidCompatPayload(payload) &&
        (payload.sessionEditCount === undefined || isFiniteNumber(payload.sessionEditCount)) &&
        (payload.sessionPromptCount === undefined || isFiniteNumber(payload.sessionPromptCount))
      );
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

export function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

export function encodeCycloidEvent<P extends Phase>(event: CycloidEvent<P>): string {
  return JSON.stringify(event);
}

export function validateCycloidEvent(value: unknown): CycloidEvent {
  if (!isRecord(value)) throw new Error("Invalid CycloidEvent");
  if (!isPhase(value.phase)) throw new Error("Invalid phase");
  if (typeof value.timestampMs !== "number" || !Number.isFinite(value.timestampMs)) {
    throw new Error("Invalid timestampMs");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("Invalid sessionId");
  }
  if (value.promptId !== undefined && typeof value.promptId !== "string") {
    throw new Error("Invalid promptId");
  }
  if (value.sandboxId !== undefined && typeof value.sandboxId !== "string") {
    throw new Error("Invalid sandboxId");
  }
  if (!isRecord(value.payload)) throw new Error("Invalid payload");
  if (!isPayloadForPhase(value.phase, value.payload)) throw new Error(`Invalid payload for phase ${value.phase}`);
  return value as CycloidEvent;
}

export function decodeCycloidEvent(json: string): CycloidEvent {
  return validateCycloidEvent(JSON.parse(json));
}
