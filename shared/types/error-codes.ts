import type { ErrorCode } from "./sandbox.js";

// Single source of truth for terminal error codes: the ErrorCode type in
// sandbox.ts is derived from this array, so adding a code here is the only
// step needed and the union can never drift from the isErrorCode set.
export const ERROR_CODES = [
  "auth",
  "policy_block",
  "handled_automatically",
  "output_length",
  "context_overflow",
  "aborted",
  "rate_limit",
  "api_error",
  "config_error",
  "failed_edits",
  "memory_enforcement_failed",
  "failure_loop_suspected",
  "empty_completion",
  "followup_not_started",
  "stale_prompt",
  "max_duration_exceeded",
  "spawn_timeout",
  "spawn_modal_error",
  "spawn_provider_error",
  "spawn_deadline_no_object",
  "spawn_deadline_no_bridge",
  "spawn_preconnect",
  "sandbox_terminated",
  "sandbox_disconnected",
  "sandbox_disconnected_exhausted",
  "sandbox_never_started",
  "session_archived",
  "sandbox_callback",
  "codex_startup_timeout",
  "codex_api_readiness_timeout",
  "codex_session_create_timeout",
  "codex_prompt_dispatch_timeout",
  "codex_not_ready",
  "codex_transport_closed",
  "codex_unrecoverable",
  "question_delivery_failed",
  "malformed_search_command",
  "unknown",
] as const;

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export function canonicalErrorCode(value: ErrorCode): ErrorCode {
  return value === "spawn_modal_error" ? "spawn_provider_error" : value;
}

export const ERROR_CODE_LABELS: Record<ErrorCode, string> = {
  auth: "Authentication failed",
  policy_block: "Policy block",
  handled_automatically: "Handled automatically",
  output_length: "Output was too long",
  context_overflow: "Context window exceeded",
  aborted: "Stopped by user",
  rate_limit: "Rate limited - please retry shortly",
  api_error: "Model service error",
  config_error: "Configuration error",
  failed_edits: "Edit failure",
  memory_enforcement_failed: "Memory enforcement failed",
  failure_loop_suspected: "Suspected failure loop",
  empty_completion: "Empty completion",
  followup_not_started: "Follow-up did not start",
  stale_prompt: "Prompt became inactive",
  max_duration_exceeded: "Prompt exceeded maximum duration",
  spawn_timeout: "Sandbox spawn timed out",
  spawn_modal_error: "Sandbox spawn failed (legacy provider error)",
  spawn_provider_error: "Sandbox spawn failed (provider API error)",
  spawn_deadline_no_object: "Sandbox spawn timed out before provider responded",
  spawn_deadline_no_bridge: "Sandbox startup timed out before the runtime became reachable",
  spawn_preconnect: "Sandbox failed before connecting",
  sandbox_terminated: "Sandbox terminated",
  sandbox_disconnected: "Sandbox disconnected",
  sandbox_disconnected_exhausted: "Sandbox kept disconnecting",
  sandbox_never_started: "Sandbox never started the prompt",
  session_archived: "Session archived while processing",
  sandbox_callback: "Sandbox callback failed",
  codex_startup_timeout: "Agent runtime startup timed out",
  codex_api_readiness_timeout: "Agent runtime did not become ready",
  codex_session_create_timeout: "Agent runtime session could not be created",
  codex_prompt_dispatch_timeout: "Prompt could not be delivered to the agent runtime",
  codex_not_ready: "Agent runtime did not become ready",
  codex_transport_closed: "Agent runtime connection closed",
  codex_unrecoverable: "Agent runtime stopped unexpectedly",
  question_delivery_failed: "Answer could not be delivered to the agent",
  malformed_search_command: "Malformed search command blocked",
  unknown: "Unknown failure",
};

export const ERROR_CODE_HINTS: Partial<Record<ErrorCode, string>> = {
  auth: "Reconnect GitHub in Cycloid settings, then retry.",
  policy_block: "The command was blocked by Cycloid safety policy. Continue with a permitted path or command.",
  output_length: "Open the session for the full output, then retry with a narrower request.",
  context_overflow: "Retry with a narrower prompt or fewer attached files.",
  rate_limit: "Wait a few minutes, then retry.",
  api_error: "Retry in a few minutes. If it repeats, open the session for details.",
  config_error: "Check the repository or session configuration, then retry.",
  failed_edits:
    "The agent could not apply repeated edits to the same file. Retry with a narrower request, or open the session for details.",
  memory_enforcement_failed:
    "Cycloid blocked a memory violation but could not prove the forbidden code was removed. Open the session for details.",
  failure_loop_suspected:
    "The same failure repeated until its retry budget was exhausted twice with no code change. Open the session for details and retry with a different approach.",
  max_duration_exceeded: "Retry with a smaller task, or split the work into follow-ups.",
  spawn_timeout: "The sandbox did not start in time. Retry in a few minutes.",
  spawn_modal_error: "The sandbox failed before it was ready. Retry in a few minutes.",
  spawn_provider_error: "The sandbox failed before it was ready. Retry in a few minutes.",
  spawn_deadline_no_object: "The sandbox did not start in time. Retry in a few minutes.",
  spawn_deadline_no_bridge: "The sandbox did not connect in time. Retry in a few minutes.",
  spawn_preconnect: "The sandbox failed before connecting. Retry in a few minutes.",
  sandbox_terminated: "The sandbox stopped before finishing. Retry the request.",
  sandbox_disconnected: "The sandbox disconnected before finishing. Retry the request.",
  sandbox_disconnected_exhausted:
    "The sandbox kept disconnecting across automatic re-runs. Open the session for details, then retry.",
  sandbox_never_started: "The sandbox went away before the prompt started running. Retry the request.",
  sandbox_callback: "The sandbox could not report progress. Open the session for details, then retry.",
  codex_startup_timeout: "The agent runtime did not start in time. Retry in a few minutes.",
  codex_api_readiness_timeout: "The agent runtime did not become ready. Retry in a few minutes.",
  codex_session_create_timeout: "The agent session could not be created. Retry in a few minutes.",
  codex_prompt_dispatch_timeout: "The prompt could not be delivered to the agent. Retry the request.",
  codex_not_ready: "The agent runtime was not ready. Retry in a few minutes.",
  codex_transport_closed: "The agent runtime connection closed unexpectedly. Retry the request.",
  codex_unrecoverable: "The agent runtime stopped unexpectedly. Open the session for details.",
  question_delivery_failed: "The answer could not be delivered to the agent. Retry the request.",
  malformed_search_command:
    "Rewrite the search command with balanced quotes, or split the pipeline into simpler rg/grep commands.",
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

export function errorCodeLabel(value: unknown): string {
  return isErrorCode(value) ? ERROR_CODE_LABELS[value] : ERROR_CODE_LABELS.unknown;
}

export function errorCodeHint(value: unknown): string | null {
  return isErrorCode(value) ? (ERROR_CODE_HINTS[value] ?? null) : null;
}

export function formatSessionErrorMessage(error: string, code?: string | null): string {
  if (!code || !isErrorCode(code) || code === "unknown") return error;
  const label = errorCodeLabel(code);
  return error.includes(label) ? error : `${label}: ${error}`;
}

export function datadogErrorCodeTag(value: unknown): ErrorCode {
  return isErrorCode(value) ? canonicalErrorCode(value) : "unknown";
}
