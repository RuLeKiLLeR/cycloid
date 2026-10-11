import type { OpenAIServiceTier } from "../enums/openai-service-tier.js";
import type { StructuredOutputReasoningEffort } from "./structured-output.js";

export const PLATFORM_LLM_CALL_TYPES = ["pr_template_fill", "review_loop_triage", "slack_progress_narration"] as const;

export type PlatformLlmCallType = (typeof PLATFORM_LLM_CALL_TYPES)[number];

export const PLATFORM_LLM_PHASES = ["prompt_preparation", "post_execution"] as const;

export type PlatformLlmPhase = (typeof PLATFORM_LLM_PHASES)[number];

export const PLATFORM_LLM_DEFAULT_MAX_ATTEMPTS = 3;

export type PlatformLlmProvider = "openai";

export type PlatformLlmCapabilityRecord = {
  idHash: string;
  sessionId: string;
  sandboxId: string;
  promptId: string;
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
};

export type PlatformLlmCapability = {
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  token: string;
  expiresAt: number;
};

export type PlatformLlmCapabilityManifest = {
  capabilities: PlatformLlmCapability[];
};

export type PlatformLlmFailureCategory =
  | "capability_invalid"
  | "capability_expired"
  | "capability_consumed"
  | "wrong_phase"
  | "wrong_call_type"
  | "input_too_large"
  | "output_too_large"
  | "budget_exhausted"
  | "provider_timeout"
  | "provider_error_retryable"
  | "provider_error_nonretryable"
  | "output_shape";

export type PlatformLlmFailureDetails = {
  inputBytes?: number;
  maxInputBytes?: number;
  outputBytes?: number;
  maxOutputBytes?: number;
};

export type PlatformLlmResponse<T> =
  | { ok: true; data: T; attempts: number; durationMs: number; model: string; toolName: string }
  | {
      ok: false;
      category: PlatformLlmFailureCategory;
      attempts: number;
      durationMs: number;
      model?: string;
      toolName: string;
      details?: PlatformLlmFailureDetails;
    };

export type PlatformLlmBrokerRequest = {
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  input: unknown;
};

export type PlatformLlmCallPlan = {
  sessionId: string;
  sandboxId: string;
  promptId: string;
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  provider: PlatformLlmProvider;
  model: string;
  reasoningEffort?: StructuredOutputReasoningEffort;
  // Optional requested OpenAI service tier ("flex" for Batch-rate background calls). Minted into
  // the plan control-plane-side; the sandbox never sets it.
  serviceTier?: OpenAIServiceTier;
  maxTokens: number;
  timeoutMs: number;
  maxAttempts: number;
  toolName: string;
  maxOutputBytes: number;
};

export function isPlatformLlmCallType(value: unknown): value is PlatformLlmCallType {
  return typeof value === "string" && (PLATFORM_LLM_CALL_TYPES as readonly string[]).includes(value);
}

export function isPlatformLlmPhase(value: unknown): value is PlatformLlmPhase {
  return typeof value === "string" && (PLATFORM_LLM_PHASES as readonly string[]).includes(value);
}
