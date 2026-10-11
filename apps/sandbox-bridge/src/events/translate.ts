import type { BridgeEvent } from "../../../../shared/events/bridge.js";
import type { CycloidEvent, CycloidPayloadByPhase, Phase } from "../../../../shared/events/schema.js";

type TransportPayload<P extends Phase> = CycloidPayloadByPhase[P];
type TransportEvent<P extends Phase = Phase> = CycloidEvent<P> & { ackId?: string };

const TRANSPORT_OMIT_KEYS = new Set(["type", "timestamp", "sandboxId", "ackId"]);

function buildBridgeData(event: BridgeEvent): Record<string, unknown> {
  const bridgeData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (TRANSPORT_OMIT_KEYS.has(key) || value === undefined) continue;
    bridgeData[key] = value;
  }
  return bridgeData;
}

function ackField(event: BridgeEvent): { ackId?: string } {
  return "ackId" in event && typeof event.ackId === "string" && event.ackId.length > 0 ? { ackId: event.ackId } : {};
}

function promptIdForEvent(event: BridgeEvent): string | undefined {
  if ("promptId" in event && typeof event.promptId === "string") {
    return event.promptId;
  }
  if ("messageId" in event && typeof event.messageId === "string") {
    return event.messageId;
  }
  return undefined;
}

function payloadWithBridgeCompat<P extends Phase>(
  event: BridgeEvent,
  payload: Omit<CycloidPayloadByPhase[P], "bridgeEventType" | "bridgeData">,
): TransportPayload<P> {
  return {
    ...payload,
    bridgeEventType: event.type,
    bridgeData: buildBridgeData(event),
  } as TransportPayload<P>;
}

export function translateBridgeEventToCycloidEvent(sessionId: string, event: BridgeEvent): TransportEvent {
  const promptId = promptIdForEvent(event);
  const base = {
    sessionId,
    timestampMs: event.timestamp,
    ...(promptId ? { promptId } : {}),
    ...(typeof event.sandboxId === "string" ? { sandboxId: event.sandboxId } : {}),
  };

  switch (event.type) {
    case "heartbeat":
      return {
        ...base,
        phase: "bridge.connect",
        payload: payloadWithBridgeCompat(event, { status: "connected" }),
      };
    case "prompt_accepted":
    case "prompt_activity":
    case "agent_progress":
    case "agent_prompt_sent":
      return {
        ...base,
        phase: "prompt.dispatch",
        payload: payloadWithBridgeCompat(event, {
          startupAttemptId: "startupAttemptId" in event ? (event.startupAttemptId ?? null) : null,
        }),
      };
    case "token":
    case "final_answer":
      return {
        ...base,
        ...(event.type === "final_answer" ? ackField(event) : {}),
        phase: "text.delta",
        payload: payloadWithBridgeCompat(event, {
          channel: "output",
          text: event.content,
          partId: event.partId ?? (event.type === "final_answer" ? `${event.messageId}:final_answer` : undefined),
        }),
      };
    case "reasoning":
      return {
        ...base,
        phase: "text.delta",
        payload: payloadWithBridgeCompat(event, {
          channel: "reasoning",
          text: event.content,
          partId: event.partId,
        }),
      };
    case "tool_call":
      return {
        ...base,
        ...ackField(event),
        phase: "tool.call",
        payload: payloadWithBridgeCompat(event, {
          callId: event.callId,
          tool: event.tool,
          summary: event.summary,
          args: event.args,
        }),
      };
    case "tool_result":
      return {
        ...base,
        ...ackField(event),
        phase: "tool.result",
        payload: payloadWithBridgeCompat(event, {
          callId: event.callId,
          tool: event.tool,
          ok: event.error === undefined,
          result: event.result,
          error: event.error,
        }),
      };
    case "error":
      return {
        ...base,
        phase: "error",
        payload: payloadWithBridgeCompat(event, {
          message: event.error,
          code: event.code,
          details: event.errorDetails,
        }),
      };
    case "execution_complete":
      return {
        ...base,
        ...ackField(event),
        phase: "prompt.complete",
        payload: payloadWithBridgeCompat(event, {
          success: event.success,
          error: event.error,
          errorCode: event.errorCode,
          errorDetails: event.errorDetails,
        }),
      };
    case "push_complete":
      if (typeof event.branchName !== "string" || event.branchName.length === 0) {
        return {
          ...base,
          ...ackField(event),
          phase: "bridge.event",
          payload: {
            bridgeEventType: event.type,
            bridgeData: buildBridgeData(event),
          },
        };
      }
      return {
        ...base,
        ...ackField(event),
        phase: "git.push",
        payload: payloadWithBridgeCompat(event, {
          branch: event.branchName,
          success: true,
        }),
      };
    case "push_error":
      if (typeof event.branchName !== "string" || event.branchName.length === 0) {
        return {
          ...base,
          ...ackField(event),
          phase: "bridge.event",
          payload: {
            bridgeEventType: event.type,
            bridgeData: buildBridgeData(event),
          },
        };
      }
      return {
        ...base,
        ...ackField(event),
        phase: "git.push",
        payload: payloadWithBridgeCompat(event, {
          branch: event.branchName,
          success: false,
          error: event.error,
        }),
      };
    case "question":
      return {
        ...base,
        ...ackField(event),
        phase: "user_question",
        payload: payloadWithBridgeCompat(event, {
          questionId: event.questionId,
          question: event.question,
          options: event.options,
        }),
      };
    case "session_idle":
      return {
        ...base,
        phase: "idle",
        payload: payloadWithBridgeCompat(event, {
          sessionEditCount: event.sessionEditCount,
          sessionPromptCount: event.sessionPromptCount,
        }),
      };
    case "agent_session_created":
      return {
        ...base,
        phase: "agent.session.create",
        payload: payloadWithBridgeCompat(event, {
          status: "complete",
          agentSessionId: event.agentSessionId,
          agentRuntimeBackend: event.agentRuntimeBackend,
          agent: event.agent,
        }),
      };
    case "agent_timeline":
      return {
        ...base,
        phase: "timeline",
        payload: payloadWithBridgeCompat(event, {
          eventType: event.eventType,
          source: event.source,
          observer: event.observer,
          summary: event.summary,
          status: event.status,
          metadata: event.metadata,
        }),
      };
    case "verification_phase_artifact":
      return {
        ...base,
        phase: "bridge.event",
        payload: payloadWithBridgeCompat(event, {
          verificationPhase: event.verificationPhase,
          intermediate: true,
        }),
      };
    default:
      return {
        ...base,
        ...ackField(event),
        phase: "bridge.event",
        payload: {
          bridgeEventType: event.type,
          bridgeData: buildBridgeData(event),
        },
      };
  }
}
