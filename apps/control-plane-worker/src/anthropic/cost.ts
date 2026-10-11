import { AnthropicModel } from "../../../../shared/constants/models.js";
import { TOKENS_PER_MILLION } from "../openai-gateway/cost";

export type AnthropicMessagesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type AnthropicModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWrite5mPerMillion: number;
  cacheReadPerMillion: number;
};

type NormalizedAnthropicUsage = {
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type AnthropicPricingProvenance = {
  helperName: "computeAnthropicMessagesCostUsdMicros";
  pricingTable: "ANTHROPIC_MESSAGES_MODEL_PRICING";
  model: string;
  pricingSource: "anthropic_pricing_page_2026_07_12";
  cacheCreationRateSource: "5m_cache_write_rate";
};

export type AnthropicCostResult =
  | {
      costUsdMicros: number;
      normalized: NormalizedAnthropicUsage;
      provenance: AnthropicPricingProvenance;
      pricingUnavailableReason?: never;
    }
  | {
      costUsdMicros: null;
      normalized: NormalizedAnthropicUsage;
      provenance: null;
      pricingUnavailableReason: "unknown_model";
    };

// Verified against https://www.anthropic.com/pricing on 2026-07-12. Models
// without verified Messages API rates fail closed with null
// cost attribution. Anthropic also publishes 1-hour cache write rates, but
// Messages usage does not identify cache TTL, so platform sidecar pricing uses
// the 5-minute cache write rate for cache_creation_input_tokens.
export const ANTHROPIC_MESSAGES_MODEL_PRICING: Record<string, AnthropicModelPricing> = {
  [AnthropicModel.Opus48]: {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheWrite5mPerMillion: 6.25,
    cacheReadPerMillion: 0.5,
  },
  [AnthropicModel.Sonnet46]: {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWrite5mPerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  [AnthropicModel.Sonnet5]: {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWrite5mPerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  [AnthropicModel.Fable5]: {
    inputPerMillion: 10,
    outputPerMillion: 50,
    cacheWrite5mPerMillion: 12.5,
    cacheReadPerMillion: 1,
  },
};

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeAnthropicUsage(usage: AnthropicMessagesUsage): NormalizedAnthropicUsage {
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const cacheReadInputTokens = nonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens: inputTokens,
  };
}

export function computeAnthropicMessagesCostUsdMicros(params: {
  model: string;
  usage: AnthropicMessagesUsage;
}): AnthropicCostResult {
  const normalized = normalizeAnthropicUsage(params.usage);
  const pricing = ANTHROPIC_MESSAGES_MODEL_PRICING[params.model];
  if (!pricing) {
    return {
      costUsdMicros: null,
      normalized,
      provenance: null,
      pricingUnavailableReason: "unknown_model",
    };
  }

  const costUsd =
    (normalized.uncachedInputTokens / TOKENS_PER_MILLION) * pricing.inputPerMillion +
    (normalized.cacheReadInputTokens / TOKENS_PER_MILLION) * pricing.cacheReadPerMillion +
    (normalized.cacheCreationInputTokens / TOKENS_PER_MILLION) * pricing.cacheWrite5mPerMillion +
    (normalized.outputTokens / TOKENS_PER_MILLION) * pricing.outputPerMillion;

  return {
    costUsdMicros: Math.round(costUsd * 1_000_000),
    normalized,
    provenance: {
      helperName: "computeAnthropicMessagesCostUsdMicros",
      pricingTable: "ANTHROPIC_MESSAGES_MODEL_PRICING",
      model: params.model,
      pricingSource: "anthropic_pricing_page_2026_07_12",
      cacheCreationRateSource: "5m_cache_write_rate",
    },
  };
}
