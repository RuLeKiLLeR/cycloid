// Re-export shared protocol types from shared/events/bridge.ts and shared/types/sandbox.ts.
export type { BridgeEvent as SandboxEvent, SandboxPromptActivityPhase } from "../../../shared/events/bridge.js";
export type {
  DiagnosticEntry,
  ErrorCode,
  ExecutionVerification,
  HandlePromptOptions,
  PreviewContract,
  SandboxAckMessage,
  SandboxCommand,
  SandboxSocketMessage,
  UploadedFile,
  UploadedImage,
  VerificationArtifact,
  VerificationParentPrompt,
} from "../../../shared/types/sandbox.js";

import type { ToolFailurePhase } from "../../../shared/tool-failure.js";
import type { ErrorCode, ErrorDetails } from "../../../shared/types/sandbox.js";

/** Distributes Omit across a union so each variant keeps its own shape. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Per-prompt mutable execution state shared between the bridge driver and the event translator. */
export type PromptExecutionState = {
  abortReason: string | null;
  dispatchSucceeded: boolean;
  handledAutomaticallyBlockCount: number;
  errorDetails?: ErrorDetails;
  lastErrorCode?: ErrorCode;
  promptRetryCount: number;
  promptRetryCountsByErrorCode: Partial<Record<ErrorCode, number>>;
};

/** Minimal Codex tool-part shape consumed by the bridge + event translator. */
export type ParentToolPart = {
  id: string;
  callID?: string;
  tool: string;
  state?: { input?: Record<string, unknown>; status?: string; output?: string; error?: string };
};

/**
 * Shared Datadog tag set for the per-turn latency metrics
 * (`prompt.predispatch` and `prompt.dispatch_to_first_event`). Built once per
 * prompt so both metrics carry identical dimensions.
 */
export interface PromptLatencyTags {
  repo?: string;
  agent_runtime_backend: string;
  model: string;
  agent: string;
  /** Resolved reasoning effort, or `"provider_default"` when none was set. */
  reasoning_effort: string;
  /** True when this bridge instance already dispatched a prompt this session. */
  is_followup: boolean;
  /** True when org memories exist, so the ranking LLM call ran. */
  has_memories: boolean;
}

export interface PromptObservabilityContext {
  model: string;
  agent: string;
  reasoningEffort: string;
}

// Behavioral signals collected during a prompt execution
export type PromptBehaviorSignals = {
  toolCallCount: number;
  handledAutomaticallyViolation: boolean;
  contextFillPercent: number;
  editCount: number;
  /** Number of times the agent asked the user a question during this prompt */
  questionCount: number;
  /** Whether the agent referenced PR/issue/commit identifiers in output */
  referencedExternalState: boolean;
  /** Whether the agent successfully ran gh CLI or similar verification tools */
  usedVerificationTools: boolean;
  /** Whether the agent ran a recognized functional check command */
  ranFunctionalCheck: boolean;
  /** Number of malformed grep/rg search commands blocked before execution */
  malformedSearchCommandCount: number;
  /** Number of executed grep/egrep/fgrep repo-search commands */
  grepSearchCommandCount: number;
  /** Number of executed rg/ripgrep repo-search commands */
  ripgrepSearchCommandCount: number;
  /** Hidden HTML-comment prompt-injection hits detected in fetched web content. */
  structuralInjectionCommentHitCount: number;
  /** Zero-width / invisible-fragment prompt-injection hits detected in fetched web content. */
  structuralInjectionZeroWidthHitCount: number;
  /** Terminal tool failures grouped by the phase where the failure originated. */
  toolFailureCountsByPhase: Record<ToolFailurePhase, number>;
};
