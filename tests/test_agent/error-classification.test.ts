import { describe, expect, it } from "vitest";

import {
  ERROR_PATTERNS,
  mapCodexErrorInfo,
  RETRYABLE_ERROR_CODES,
} from "../../apps/sandbox-bridge/src/constants/bridge.js";
import type { ErrorCode } from "../../apps/sandbox-bridge/src/types.js";
import {
  classifyError,
  extractStructuredErrorCode,
  normalizeBridgeLocalErrorCode,
} from "../../apps/sandbox-bridge/src/utils/classify.js";

describe("classifyError", () => {
  it("classifies auth errors (401/403)", () => {
    expect(classifyError("HTTP 401 Unauthorized")).toBe("auth");
    expect(classifyError("HTTP 403 Forbidden")).toBe("auth");
    expect(classifyError("Authentication failed")).toBe("auth");
    expect(classifyError("Request forbidden by policy")).toBe("auth");
  });

  it("classifies handled-automatically errors", () => {
    expect(classifyError("git push is handled automatically by Cycloid.")).toBe("handled_automatically");
  });

  it("classifies output length errors", () => {
    expect(classifyError("Output length exceeded maximum")).toBe("output_length");
    expect(classifyError("Max tokens output reached")).toBe("output_length");
    expect(classifyError("Output too long for response")).toBe("output_length");
  });

  it("classifies context overflow errors", () => {
    expect(classifyError("Prompt too long for model context")).toBe("context_overflow");
    expect(classifyError("Context overflow: exceeded limit")).toBe("context_overflow");
    expect(classifyError("Token limit exceeded for input")).toBe("context_overflow");
    expect(classifyError("Max context window reached")).toBe("context_overflow");
  });

  it("classifies aborted errors", () => {
    expect(classifyError("Request aborted")).toBe("aborted");
    expect(classifyError("Operation cancelled by client")).toBe("aborted");
    expect(classifyError("Task was canceled")).toBe("aborted");
    expect(classifyError("Stopped by user")).toBe("aborted");
    expect(classifyError("The operation was aborted.")).toBe("aborted");
    expect(classifyError("AbortError")).toBe("aborted");
  });

  it("classifies rate limit errors", () => {
    expect(classifyError("Rate limit exceeded")).toBe("rate_limit");
    expect(classifyError("Too many requests, retry later")).toBe("rate_limit");
    expect(classifyError("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyError("Request throttled")).toBe("rate_limit");
  });

  it("classifies API errors", () => {
    expect(classifyError("API error occurred")).toBe("api_error");
    expect(classifyError("HTTP 500 Internal Server Error")).toBe("api_error");
    expect(classifyError("HTTP 502 Bad Gateway")).toBe("api_error");
    expect(classifyError("HTTP 503 Service Unavailable")).toBe("api_error");
    expect(classifyError("HTTP 504 Gateway Timeout")).toBe("api_error");
    expect(classifyError("Server error: internal failure")).toBe("api_error");
    // Transient OpenAI overload — retryable via api_error
    expect(classifyError("overloaded_error: OpenAI's API is temporarily overloaded")).toBe("api_error");
  });

  it("classifies transient timeout and transport failures as api_error", () => {
    expect(classifyError("Request timed out")).toBe("api_error");
    expect(classifyError("Network timeout")).toBe("api_error");
    expect(classifyError("Signal timed out waiting for provider response")).toBe("api_error");
    expect(classifyError("connect ETIMEDOUT 203.0.113.10:443")).toBe("api_error");
    expect(classifyError("read ECONNRESET")).toBe("api_error");
    expect(classifyError("socket hang up")).toBe("api_error");
    expect(classifyError("TypeError: fetch failed")).toBe("api_error");
    expect(classifyError("connection reset by peer")).toBe("api_error");
    expect(classifyError("connection refused")).toBe("api_error");
    expect(classifyError("upstream connection closed unexpectedly")).toBe("api_error");
    expect(classifyError("network transport failure")).toBe("api_error");
  });

  it("classifies config errors (permanent, non-retryable)", () => {
    // OpenAI model_not_found — retrying would waste the full retry budget
    expect(classifyError("model_not_found: The model 'gpt-5.4' does not exist")).toBe("config_error");
    expect(classifyError("404 The model `gpt-5.4` does not exist or you do not have access to it.")).toBe(
      "config_error",
    );
  });

  it("classifies prod unknown-bucket message shapes into structured codes", () => {
    // Shapes pulled from prod prompt_runs where error_code was 'unknown'.
    // Dominant bucket (~56%): human-text "Model not found" the token regex missed.
    expect(classifyError("Model not found: anthropic/claude-opus-4-7.")).toBe("config_error");
    expect(
      classifyError(
        "stream disconnected before completion: Project `proj_abc` does not have access to model `gpt-5.5`",
      ),
    ).toBe("config_error");
    // Quota/billing is permanent until billing is fixed -> config_error, NOT rate_limit
    // (rate_limit is retryable and would waste the retry budget here).
    expect(classifyError("Quota exceeded. Check your plan and billing details.")).toBe("config_error");
    expect(classifyError("in-process app-server event stream lagged; dropped 5 events")).toBe("codex_unrecoverable");
    expect(
      classifyError("Codex Exec exited with code 1: WARNING: proceeding, even though we could not update PATH"),
    ).toBe("codex_unrecoverable");
    expect(classifyError("Prompt start timed out after 10000ms")).toBe("codex_startup_timeout");
    expect(classifyError("Invalid API key · Fix external API key")).toBe("auth");
    // Provider capacity is transient -> api_error (retryable), like ServerOverloaded.
    expect(classifyError("Selected model is at capacity. Please try a different model.")).toBe("api_error");
  });

  it("classifies quota-exceeded as non-retryable config_error even with a 429 in the message", () => {
    // The dedicated quota pattern must win over the rate_limit pattern so a billing
    // cap is never retried. Plain rate limits (no quota wording) stay rate_limit.
    expect(classifyError("HTTP 429: Quota exceeded. Check your plan and billing details.")).toBe("config_error");
    expect(classifyError("Quota exceeded due to rate limit; check billing")).toBe("config_error");
    expect(RETRYABLE_ERROR_CODES.has(classifyError("HTTP 429: Quota exceeded."))).toBe(false);
    // No quota wording -> still a retryable rate_limit.
    expect(classifyError("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyError("Rate limit exceeded")).toBe("rate_limit");
  });

  it("preserves retry behavior for relabeled unknowns (only capacity becomes retryable)", () => {
    // Previously-`unknown` (non-retryable) shapes stay non-retryable after relabeling.
    expect(RETRYABLE_ERROR_CODES.has(classifyError("Model not found: anthropic/claude-opus-4-7."))).toBe(false);
    expect(RETRYABLE_ERROR_CODES.has(classifyError("Quota exceeded. Check your plan and billing details."))).toBe(
      false,
    );
    expect(
      RETRYABLE_ERROR_CODES.has(classifyError("in-process app-server event stream lagged; dropped 5 events")),
    ).toBe(false);
    expect(RETRYABLE_ERROR_CODES.has(classifyError("Prompt start timed out after 10000ms"))).toBe(false);
    expect(RETRYABLE_ERROR_CODES.has(classifyError("Invalid API key · Fix external API key"))).toBe(false);
    // Intentional change: transient capacity becomes retryable via api_error.
    expect(
      RETRYABLE_ERROR_CODES.has(classifyError("Selected model is at capacity. Please try a different model.")),
    ).toBe(true);
  });

  it("keeps existing classifications stable after adding prod-derived patterns", () => {
    // Guard against the new patterns shadowing or being shadowed by neighbors.
    expect(classifyError("model_not_found: The model 'gpt-5.4' does not exist")).toBe("config_error");
    expect(classifyError("overloaded_error: OpenAI's API is temporarily overloaded")).toBe("api_error");
    expect(classifyError("Rate limit exceeded")).toBe("rate_limit");
    expect(classifyError("Codex app-server is closed")).toBe("codex_transport_closed");
    expect(classifyError("Prompt timed out after 15 minutes of inactivity")).toBe("stale_prompt");
    expect(classifyError("Codex startup timeout")).toBe("codex_startup_timeout");
  });

  it("classifies failed edit errors", () => {
    expect(classifyError("Failed edit operation")).toBe("failed_edits");
    expect(classifyError("Repeated edit failures on file")).toBe("failed_edits");
    expect(classifyError("Failed to find expected lines in src/app.ts")).toBe("failed_edits");
    expect(classifyError("Failed to find context 'foo' in src/app.ts")).toBe("failed_edits");
  });

  it("prioritizes empty completion over generic provider errors", () => {
    expect(classifyError("empty_completion")).toBe("empty_completion");
    expect(classifyError("API error: empty_completion")).toBe("empty_completion");
    expect(classifyError("Server error: empty completion")).toBe("empty_completion");
  });

  it("classifies stale prompt errors", () => {
    expect(classifyError("Prompt timed out after 15 minutes of inactivity")).toBe("stale_prompt");
    expect(classifyError("Stale prompt detected")).toBe("stale_prompt");
  });

  it("classifies spawn timeout errors", () => {
    expect(classifyError("Sandbox failed to connect after 3 attempts")).toBe("spawn_timeout");
    expect(classifyError("Spawn timeout waiting for connection")).toBe("spawn_timeout");
    expect(classifyError("Failed spawn: no response from sandbox")).toBe("spawn_timeout");
  });

  it("classifies sandbox disconnected errors", () => {
    expect(classifyError("Sandbox disconnected while processing")).toBe("sandbox_disconnected");
  });

  it("classifies typed lifecycle errors", () => {
    expect(classifyError("Sandbox terminated while processing")).toBe("sandbox_terminated");
    expect(classifyError("Codex startup timeout")).toBe("codex_startup_timeout");
    expect(classifyError("Codex API readiness timeout")).toBe("codex_api_readiness_timeout");
    expect(classifyError("Codex session.create headers timeout")).toBe("codex_session_create_timeout");
    expect(classifyError("Codex prompt dispatch timeout")).toBe("codex_prompt_dispatch_timeout");
    expect(classifyError("Codex app-server is closed")).toBe("codex_transport_closed");
    expect(classifyError("Codex app-server exited unexpectedly (code=1 signal=null)")).toBe("codex_transport_closed");
    expect(classifyError("Malformed Codex app-server NDJSON line: {not-json}")).toBe("codex_unrecoverable");
    expect(classifyError("Codex unrecoverable failure")).toBe("codex_unrecoverable");
  });

  it("classifies sandbox callback errors", () => {
    expect(classifyError("Sandbox execution failed")).toBe("sandbox_callback");
    expect(classifyError("Modal execution failed")).toBe("sandbox_callback");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyError("Something completely unexpected")).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
  });

  it("keeps generic apply_patch feedback out of failed_edits", () => {
    expect(classifyError("apply_patch verification failed")).toBe("unknown");
  });

  it("keeps bridge-local timeout and sandbox failures out of api_error", () => {
    expect(classifyError("Prompt timed out after 15 minutes of inactivity")).toBe("stale_prompt");
    expect(classifyError("Sandbox failed to connect after 3 attempts")).toBe("spawn_timeout");
    expect(classifyError("Sandbox disconnected while processing")).toBe("sandbox_disconnected");
    expect(classifyError("Sandbox execution failed")).toBe("sandbox_callback");
  });

  it("prefers transport classification over incidental abort wording", () => {
    expect(classifyError("Request aborted after socket hang up")).toBe("api_error");
    expect(classifyError("Operation canceled because fetch failed")).toBe("api_error");
    expect(classifyError("Request aborted because Codex app-server is closed")).toBe("codex_transport_closed");
  });

  it("exposes a failed_edits hint", async () => {
    const { ERROR_CODE_HINTS } = await import("../../shared/types/error-codes.js");
    expect(ERROR_CODE_HINTS.failed_edits).toBeDefined();
    expect(typeof ERROR_CODE_HINTS.failed_edits).toBe("string");
  });

  it("every ERROR_PATTERNS entry maps to a valid ErrorCode", () => {
    const validCodes: ErrorCode[] = [
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
      "empty_completion",
      "followup_not_started",
      "stale_prompt",
      "spawn_timeout",
      "spawn_preconnect",
      "sandbox_terminated",
      "sandbox_disconnected",
      "sandbox_callback",
      "codex_startup_timeout",
      "codex_api_readiness_timeout",
      "codex_session_create_timeout",
      "codex_prompt_dispatch_timeout",
      "codex_transport_closed",
      "codex_unrecoverable",
      "max_duration_exceeded",
      "unknown",
    ];
    for (const { code } of ERROR_PATTERNS) {
      expect(validCodes).toContain(code);
    }
  });
});

describe("bridge-local error code normalization", () => {
  it("keeps intentional shutdowns silent", () => {
    expect(
      normalizeBridgeLocalErrorCode("shutdown", "Codex app-server closed", {
        wasIntentionalClose: true,
      }),
    ).toBeNull();
  });

  it("maps unexpected shutdowns to codex_transport_closed", () => {
    expect(
      normalizeBridgeLocalErrorCode("shutdown", "Codex app-server is closed", {
        wasIntentionalClose: false,
      }),
    ).toBe("codex_transport_closed");
  });

  it("keeps request timeouts retryable", () => {
    expect(
      normalizeBridgeLocalErrorCode("timeout", "Codex app-server request timed out: turn/start", {
        wasIntentionalClose: false,
      }),
    ).toBe("api_error");
  });

  it("maps app-server runtime exits to codex_transport_closed", () => {
    expect(
      normalizeBridgeLocalErrorCode("runtime_error", "Codex app-server exited unexpectedly (code=1 signal=null)", {
        wasIntentionalClose: false,
      }),
    ).toBe("codex_transport_closed");
  });

  it("maps non-transport runtime and protocol failures to codex_unrecoverable", () => {
    expect(
      normalizeBridgeLocalErrorCode("runtime_error", "Codex app-server turn failed unexpectedly", {
        wasIntentionalClose: false,
      }),
    ).toBe("codex_unrecoverable");
    expect(
      normalizeBridgeLocalErrorCode("protocol_error", "Malformed Codex app-server NDJSON line: {not-json}", {
        wasIntentionalClose: false,
      }),
    ).toBe("codex_unrecoverable");
  });

  it("lets extractStructuredErrorCode normalize bridge-local transport codes", () => {
    const err = Object.assign(new Error("Codex app-server request timed out: turn/start"), { errorCode: "timeout" });
    expect(extractStructuredErrorCode(err)).toBe("api_error");
  });
});

describe("mapCodexErrorInfo", () => {
  it("maps context and quota variants", () => {
    expect(mapCodexErrorInfo({ name: "ContextWindowExceeded" })).toBe("context_overflow");
    expect(mapCodexErrorInfo({ name: "UsageLimitExceeded" })).toBe("rate_limit");
    expect(mapCodexErrorInfo({ name: "ServerOverloaded" })).toBe("api_error");
    expect(mapCodexErrorInfo({ name: "CyberPolicy" })).toBe("config_error");
  });

  it("maps HTTP-backed variants by status code", () => {
    expect(mapCodexErrorInfo({ name: "HttpConnectionFailed", httpStatusCode: 401 })).toBe("auth");
    expect(mapCodexErrorInfo({ name: "ResponseStreamConnectionFailed", httpStatusCode: 403 })).toBe("auth");
    expect(mapCodexErrorInfo({ name: "ResponseStreamDisconnected", httpStatusCode: 429 })).toBe("rate_limit");
    expect(mapCodexErrorInfo({ name: "ResponseTooManyFailedAttempts", httpStatusCode: 500 })).toBe("api_error");
    expect(mapCodexErrorInfo({ name: "HttpConnectionFailed" })).toBe("api_error");
  });

  it("maps remaining structured Codex variants to their error codes", () => {
    expect(mapCodexErrorInfo({ name: "InternalServerError" })).toBe("api_error");
    expect(mapCodexErrorInfo({ name: "Unauthorized" })).toBe("auth");
    expect(mapCodexErrorInfo({ name: "BadRequest" })).toBe("codex_unrecoverable");
    expect(mapCodexErrorInfo({ name: "ThreadRollbackFailed" })).toBe("codex_unrecoverable");
    expect(mapCodexErrorInfo({ name: "SandboxError" })).toBe("codex_unrecoverable");
    expect(mapCodexErrorInfo({ name: "ActiveTurnNotSteerable" })).toBe("codex_unrecoverable");
    expect(mapCodexErrorInfo({ name: "Other" })).toBeNull();
  });
});
