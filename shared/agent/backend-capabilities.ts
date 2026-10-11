import type { BridgeEvent } from "../events/bridge.js";
import {
  type AgentRuntimeBackend,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "./agent-runtime-backend.js";

export type CapabilitySupport =
  | { supported: true }
  | { supported: false; status: "partial"; rationale: string }
  | { supported: false; status: "intentional"; rationale: string }
  | { supported: false; status: "gap"; rationale: string; ticket: string };

export interface BackendCapabilities {
  cycloidMcpTools: CapabilitySupport;
  fileEditBashTools: CapabilitySupport;
  toolSafetyGates: CapabilitySupport;
  memoryRecallTelemetry: CapabilitySupport;
  multimodalInput: CapabilitySupport;
  followupContinuation: CapabilitySupport;
  crossSandboxResume: CapabilitySupport;
  verificationV2: CapabilitySupport;
  reviewLoop: CapabilitySupport;
  prodSelectability: CapabilitySupport;
  reasoningOutput: CapabilitySupport;
  tokenUsageEvents: CapabilitySupport;
  questionReplies: CapabilitySupport;
  variantReasoning: CapabilitySupport;
  patchEvents: CapabilitySupport;
  retryStatusEvents: CapabilitySupport;
  todoUpdateEvents: CapabilitySupport;
  planTurnReadOnly: CapabilitySupport;
}

export type AgentRuntimeCapability = keyof BackendCapabilities;

export const BACKEND_CAPABILITIES = {
  [CODEX_AGENT_RUNTIME_BACKEND]: {
    cycloidMcpTools: { supported: true },
    fileEditBashTools: { supported: true },
    toolSafetyGates: { supported: true },
    memoryRecallTelemetry: { supported: true },
    multimodalInput: { supported: true },
    followupContinuation: { supported: true },
    crossSandboxResume: { supported: true },
    verificationV2: { supported: true },
    reviewLoop: { supported: true },
    prodSelectability: { supported: true },
    reasoningOutput: { supported: true },
    tokenUsageEvents: { supported: true },
    questionReplies: { supported: true },
    variantReasoning: { supported: true },
    patchEvents: { supported: true },
    retryStatusEvents: { supported: true },
    todoUpdateEvents: { supported: true },
    planTurnReadOnly: { supported: true },
  },
  [CLAUDE_CODE_AGENT_RUNTIME_BACKEND]: {
    cycloidMcpTools: { supported: true },
    fileEditBashTools: { supported: true },
    toolSafetyGates: { supported: true },
    memoryRecallTelemetry: { supported: true },
    multimodalInput: { supported: true },
    followupContinuation: { supported: true },
    crossSandboxResume: { supported: true },
    verificationV2: { supported: true },
    reviewLoop: { supported: true },
    prodSelectability: { supported: true },
    reasoningOutput: { supported: true },
    tokenUsageEvents: { supported: true },
    questionReplies: { supported: true },
    variantReasoning: { supported: true },
    patchEvents: { supported: true },
    retryStatusEvents: { supported: true },
    todoUpdateEvents: {
      supported: false,
      status: "intentional",
      rationale:
        "Claude Code renders todos via its native TodoWrite tool, so the translator deliberately does not project todo_update bridge events.",
    },
    planTurnReadOnly: { supported: true },
  },
  [OPENCODE_AGENT_RUNTIME_BACKEND]: {
    cycloidMcpTools: { supported: true },
    fileEditBashTools: { supported: true },
    toolSafetyGates: { supported: true },
    memoryRecallTelemetry: { supported: true },
    multimodalInput: { supported: true },
    followupContinuation: { supported: true },
    crossSandboxResume: { supported: true },
    verificationV2: { supported: true },
    reviewLoop: { supported: true },
    prodSelectability: { supported: true },
    reasoningOutput: { supported: true },
    tokenUsageEvents: { supported: true },
    questionReplies: {
      supported: false,
      status: "partial",
      rationale: "Opencode exposes approve/reject permission replies but no SDK primitive for free-form human answers.",
    },
    variantReasoning: {
      supported: false,
      status: "intentional",
      rationale: "The opencode backend does not pass Codex reasoning variants to OSS providers.",
    },
    patchEvents: { supported: true },
    retryStatusEvents: { supported: true },
    todoUpdateEvents: { supported: true },
    planTurnReadOnly: { supported: true },
  },
} satisfies Record<AgentRuntimeBackend, BackendCapabilities>;

export const BRIDGE_EVENT_CAPABILITY_BY_EVENT_TYPE = {
  patch: "patchEvents",
  retry_status: "retryStatusEvents",
  todo_update: "todoUpdateEvents",
} satisfies Partial<Record<BridgeEvent["type"], AgentRuntimeCapability>>;

export function backendSupports(backend: AgentRuntimeBackend, capability: AgentRuntimeCapability): boolean {
  return BACKEND_CAPABILITIES[backend][capability].supported;
}
