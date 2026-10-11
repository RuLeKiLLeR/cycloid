import type { ErrorCode } from "../../../../../shared/types/sandbox.js";
import type { PromptStoppedBy } from "../../constants/sessions";

export const TERMINAL_ERROR_PRECEDENCE: ErrorCode[] = [
  "spawn_timeout",
  "spawn_provider_error",
  "spawn_modal_error",
  "spawn_deadline_no_object",
  "spawn_deadline_no_bridge",
  "spawn_preconnect",
  "sandbox_terminated",
  "sandbox_disconnected_exhausted",
  "sandbox_never_started",
  "sandbox_disconnected",
  "session_archived",
  "sandbox_callback",
  "codex_startup_timeout",
  "codex_not_ready",
  "codex_api_readiness_timeout",
  "codex_session_create_timeout",
  "codex_prompt_dispatch_timeout",
  "codex_transport_closed",
  "codex_unrecoverable",
  "stale_prompt",
  "max_duration_exceeded",
  "failure_loop_suspected",
  "failed_edits",
  "memory_enforcement_failed",
  "empty_completion",
  "followup_not_started",
  "context_overflow",
  "output_length",
  "rate_limit",
  "api_error",
  "aborted",
  "config_error",
  "auth",
  "policy_block",
  "handled_automatically",
  "question_delivery_failed",
  "malformed_search_command",
  "unknown",
];

const PRECEDENCE = new Map(TERMINAL_ERROR_PRECEDENCE.map((code, index) => [code, index]));

export function pickTerminalErrorCode(
  existing: ErrorCode | null | undefined,
  incoming: ErrorCode | null | undefined,
): ErrorCode | null {
  if (!existing) return incoming ?? null;
  if (!incoming) return existing;
  const existingRank = PRECEDENCE.get(existing) ?? Number.MAX_SAFE_INTEGER;
  const incomingRank = PRECEDENCE.get(incoming) ?? Number.MAX_SAFE_INTEGER;
  return incomingRank < existingRank ? incoming : existing;
}

export function shouldRecoverTerminalFailure(code: ErrorCode | null | undefined): boolean {
  return code === "stale_prompt";
}

type PromptRunOutcome = {
  outcome: string | null;
  errorCode: string | null;
};

type TerminalEventDecision =
  | { action: "complete-active"; promptId: string }
  | { action: "recover-stale"; promptId: string; staleReason: string }
  | { action: "ack-ignore-user-stopped"; promptId: string }
  | { action: "ack-ignore-superseded"; promptId: string; activePromptId: string | null }
  | { action: "ignore-unknown-prompt"; promptId: string };

type TerminalDecisionInput = {
  promptId: string;
  activePromptId: string | null;
  currentConnectionGeneration: number | null;
  eventConnectionGeneration: number | null;
  promptStoppedBy?: PromptStoppedBy | null;
  promptRun?: PromptRunOutcome | null;
};

export function decideTerminalEvent(input: TerminalDecisionInput): TerminalEventDecision {
  const {
    promptId,
    activePromptId,
    currentConnectionGeneration,
    eventConnectionGeneration,
    promptStoppedBy,
    promptRun,
  } = input;

  const isOlderGeneration =
    currentConnectionGeneration !== null &&
    eventConnectionGeneration !== null &&
    eventConnectionGeneration < currentConnectionGeneration;

  if (promptStoppedBy === "user") {
    return { action: "ack-ignore-user-stopped", promptId };
  }

  if (activePromptId === promptId && !isOlderGeneration) {
    return { action: "complete-active", promptId };
  }

  if (
    shouldRecoverTerminalFailure(promptRun?.errorCode as ErrorCode | null | undefined) &&
    promptRun?.outcome === "failed"
  ) {
    return { action: "recover-stale", promptId, staleReason: "stale_prompt" };
  }

  if (activePromptId && activePromptId !== promptId) {
    return { action: "ack-ignore-superseded", promptId, activePromptId };
  }

  return { action: "ignore-unknown-prompt", promptId };
}
