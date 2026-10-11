import type { ErrorDetails } from "../ws/types.js";

export function serializeErrorDetails(errorDetails?: ErrorDetails | null): string | null {
  if (!errorDetails) return null;
  try {
    return JSON.stringify(errorDetails);
  } catch {
    return JSON.stringify({ message: errorDetails.message });
  }
}

/**
 * Build the `prompt.trace.finalized` Datadog event. Pure so it can be emitted
 * from both the bridge-terminal handler and `finalizePromptRun` (the common D1
 * sink that control-plane terminals like sandbox_disconnected / spawn_* /
 * max_duration_exceeded reach), and unit-tested without the Durable Object.
 */
export function buildPromptTraceFinalizationEvent(args: {
  sessionId: string;
  promptId: string;
  repo: string | null;
  model: string | null;
  agent: string | null;
  outcome: string;
  errorCode: string | null;
  errorDetails?: ErrorDetails | null;
  durationMs: number | null;
  ddTraceId: string | null;
  btSpanId: string | null;
  traceExpected: boolean;
  runtimeProvider?: string | null;
  runtimeBackend?: string | null;
  source: "execution_complete";
}): Record<string, unknown> {
  return {
    event: "prompt.trace.finalized",
    session_id: args.sessionId,
    prompt_id: args.promptId,
    source: args.source,
    // True only when the prompt crossed into runtime execution territory and
    // therefore should have emitted prompt-level Braintrust span telemetry.
    // Control-plane-only terminals such as spawn_* stay false so the
    // completeness monitor ignores non-executed prompt failures.
    trace_expected: args.traceExpected,
    // Telemetry completeness now tracks the Braintrust span; bridge OTLP trace
    // export was removed. dd_trace_id_present stays as a legacy-only signal that
    // is true only for historical rows that already carry a dd_trace_id.
    telemetry_complete: Boolean(args.btSpanId),
    // Alias `telemetry_complete` so the Terraform log-metric/monitor that filters
    // @trace_complete (arcanist.prompt.trace_finalization) matches — the emitted
    // field was renamed to telemetry_complete and the TF side still reads
    // trace_complete, so the completeness monitor never fired.
    trace_complete: Boolean(args.btSpanId),
    dd_trace_id_present: Boolean(args.ddTraceId),
    bt_span_id_present: Boolean(args.btSpanId),
    ...(args.ddTraceId ? { dd_trace_id: args.ddTraceId } : {}),
    ...(args.btSpanId ? { bt_span_id: args.btSpanId } : {}),
    ...(args.repo ? { repo: args.repo } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    ...(args.runtimeProvider ? { runtime_provider: args.runtimeProvider } : {}),
    ...(args.runtimeBackend ? { runtime_backend: args.runtimeBackend } : {}),
    outcome: args.outcome,
    ...(args.errorCode ? { error_code: args.errorCode } : {}),
    error_details_present: Boolean(args.errorDetails),
    // Only bounded, structured error fields go to Datadog (third-party log
    // storage). Free-form fields (message, raw error_details_json, hostname,
    // cause.message) can carry provider responses / infra details, so they are
    // deliberately omitted here (CWE-532); the full ErrorDetails is still
    // persisted to D1 prompt_runs.error_details_json and SessionDO export data
    // for debugging.
    ...(args.errorDetails?.name ? { error_name: args.errorDetails.name } : {}),
    ...(args.errorDetails?.code ? { error_detail_code: args.errorDetails.code } : {}),
    ...(args.errorDetails?.syscall ? { error_syscall: args.errorDetails.syscall } : {}),
    ...(args.errorDetails?.port !== undefined ? { error_port: args.errorDetails.port } : {}),
    ...(args.errorDetails?.statusCode !== undefined ? { error_status_code: args.errorDetails.statusCode } : {}),
    ...(args.errorDetails?.isRetryable !== undefined ? { error_retryable: args.errorDetails.isRetryable } : {}),
    ...(args.errorDetails?.cause?.code ? { error_cause_code: args.errorDetails.cause.code } : {}),
    ...(args.durationMs !== null ? { duration_ms: args.durationMs } : {}),
  };
}
