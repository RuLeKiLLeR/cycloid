import type { ModelPricing } from "../../../../shared/constants/model-pricing.js";
import { isModelCostTracked } from "../../../../shared/constants/models.js";
import { isErrorCode } from "../../../../shared/types/error-codes.js";
import type { ErrorCode } from "../../../../shared/types/sandbox.js";
import { DEFAULT_MODEL_PRICING, ERROR_PATTERNS, MODEL_PRICING, TOKENS_PER_MILLION } from "../constants/bridge.js";

/** Classify an error message into a structured error code. */
export function classifyError(error: string): ErrorCode {
  for (const { pattern, code } of ERROR_PATTERNS) {
    if (pattern.test(error)) return code;
  }
  return "unknown";
}

export function normalizeBridgeLocalErrorCode(
  code: string,
  message: string,
  context: { wasIntentionalClose: boolean },
): ErrorCode | null {
  switch (code) {
    case "shutdown":
      return context.wasIntentionalClose ? null : "codex_transport_closed";
    case "timeout":
      return "api_error";
    case "runtime_error":
      return classifyError(message) === "codex_transport_closed" ? "codex_transport_closed" : "codex_unrecoverable";
    case "protocol_error":
      return "codex_unrecoverable";
    default:
      return null;
  }
}

/**
 * Extract a validated `ErrorCode` directly off a thrown value's `errorCode`
 * field. Use this at prompt-catch sites in preference to `classifyError` on
 * the message so structured codes (`codex_not_ready`, future additions)
 * survive without being absorbed by the regex table. Returns `null` when
 * the error has no valid code; callers fall back to `classifyError`.
 */
export function extractStructuredErrorCode(error: unknown): ErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const maybe = (error as { errorCode?: unknown }).errorCode;
  if (isErrorCode(maybe)) return maybe;
  if (typeof maybe !== "string") return null;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "");
  const wasIntentionalClose = (error as { wasIntentionalClose?: unknown }).wasIntentionalClose === true;
  return normalizeBridgeLocalErrorCode(maybe, message, { wasIntentionalClose });
}

/** Compute total cost in USD from token counts and model pricing. */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  model?: string,
  options: { peakContextTokens?: number } = {},
): number {
  if (model && !isModelCostTracked(model)) return 0;

  const pricing: ModelPricing = (model ? MODEL_PRICING[model] : undefined) ?? DEFAULT_MODEL_PRICING;
  const resolvedPricing =
    pricing.longContext && options.peakContextTokens && options.peakContextTokens > pricing.longContext.thresholdTokens
      ? pricing.longContext
      : pricing;
  const inputCost = (inputTokens / TOKENS_PER_MILLION) * resolvedPricing.inputPerMillion;
  const outputCost = (outputTokens / TOKENS_PER_MILLION) * resolvedPricing.outputPerMillion;
  const cacheReadCost = (cacheReadTokens / TOKENS_PER_MILLION) * (resolvedPricing.cacheReadPerMillion ?? 0);
  const cacheWriteCost = (cacheWriteTokens / TOKENS_PER_MILLION) * (resolvedPricing.cacheWritePerMillion ?? 0);
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
