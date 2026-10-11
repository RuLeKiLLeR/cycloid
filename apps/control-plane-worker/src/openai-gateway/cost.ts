import type { ModelFlexPricing, ModelPricing } from "../../../../shared/constants/model-pricing.js";
import { GPT54_PRO_MODEL_PRICING, MODEL_REGISTRY, OpenAIModel } from "../../../../shared/constants/models.js";
import { OpenAICanonicalServiceTier } from "../../../../shared/enums/openai-service-tier.js";

export const TOKENS_PER_MILLION = 1_000_000;

export const OPENAI_GATEWAY_MODEL_PRICING: Record<string, ModelPricing> = {
  ...Object.fromEntries(
    MODEL_REGISTRY.filter((model) => model.provider === "openai" && model.pricing).map((model) => [
      model.id,
      model.pricing!,
    ]),
  ),
  [OpenAIModel.GPT54Pro]: GPT54_PRO_MODEL_PRICING,
};

export type OpenAIResponsesUsage = {
  input_tokens?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

type NormalizedOpenAIUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type PricingProvenance = {
  helperName: "computeOpenAIResponsesCostUsdMicros";
  pricingTable: "OPENAI_GATEWAY_MODEL_PRICING";
  model: string;
  // The context axis: standard vs long-context rates. Independent of the service-tier axis below.
  pricingTier: "standard" | "long_context";
  // The service-tier axis: whether flex (Batch-rate) pricing was applied. "flex" only when flex
  // was both requested (the actual returned tier) and a flex rate table exists for this tier.
  serviceTier: OpenAICanonicalServiceTier;
  longContextThresholdTokens: number | null;
  cacheCreationRateSource: "explicit_cache_write_rate" | "input_rate_fallback";
  reasoningOutputTokensIncludedInOutputTokens: true;
};

export class OpenAIGatewayPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIGatewayPricingError";
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function resolvePricing(
  model: string,
  peakContextTokens?: number,
): {
  pricing: ModelPricing;
  tier: "standard" | "long_context";
  thresholdTokens: number | null;
} {
  const pricing = OPENAI_GATEWAY_MODEL_PRICING[model];
  if (!pricing) throw new OpenAIGatewayPricingError(`Unknown OpenAI model pricing: ${model}`);
  if (
    pricing.longContext &&
    peakContextTokens !== undefined &&
    peakContextTokens > pricing.longContext.thresholdTokens
  ) {
    return { pricing: pricing.longContext, tier: "long_context", thresholdTokens: pricing.longContext.thresholdTokens };
  }
  return {
    pricing,
    tier: "standard",
    thresholdTokens: pricing.longContext?.thresholdTokens ?? null,
  };
}

function normalizeOpenAIResponsesUsage(usage: OpenAIResponsesUsage): NormalizedOpenAIUsage {
  const inputTokens = nonNegativeInteger(usage.input_tokens ?? usage.prompt_tokens);
  const cachedInputTokens = nonNegativeInteger(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
  );
  const cacheCreationTokens = nonNegativeInteger(
    usage.input_tokens_details?.cache_creation_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens,
  );
  const outputTokens = nonNegativeInteger(usage.output_tokens ?? usage.completion_tokens);
  const reasoningOutputTokens = nonNegativeInteger(
    usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens,
  );

  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    uncachedInputTokens: Math.max(inputTokens - cachedInputTokens - cacheCreationTokens, 0),
    outputTokens,
    reasoningOutputTokens: Math.min(reasoningOutputTokens, outputTokens),
  };
}

// Resolve the effective per-class rates for the chosen context tier, applying flex (Batch-rate)
// pricing when the ACTUAL returned tier is flex AND the context tier has a flex sub-table. Always
// called with the actual returned tier (not the requested one) so a flex->default fallback is
// costed at standard. Flex composes with (does not replace) the long-context axis: a request can
// be both flex and long-context.
function resolveEffectiveRates(
  pricing: ModelPricing,
  actualServiceTier: OpenAICanonicalServiceTier,
): {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreationRate: number;
  appliedServiceTier: OpenAICanonicalServiceTier;
  cacheCreationRateSource: "explicit_cache_write_rate" | "input_rate_fallback";
} {
  const flex: ModelFlexPricing | undefined =
    actualServiceTier === OpenAICanonicalServiceTier.Flex ? pricing.flex : undefined;
  if (flex) {
    return {
      inputPerMillion: flex.inputPerMillion,
      outputPerMillion: flex.outputPerMillion,
      cacheReadPerMillion: flex.cacheReadPerMillion ?? 0,
      cacheCreationRate: flex.cacheWritePerMillion ?? flex.inputPerMillion,
      appliedServiceTier: OpenAICanonicalServiceTier.Flex,
      cacheCreationRateSource:
        flex.cacheWritePerMillion === undefined ? "input_rate_fallback" : "explicit_cache_write_rate",
    };
  }
  return {
    inputPerMillion: pricing.inputPerMillion,
    outputPerMillion: pricing.outputPerMillion,
    cacheReadPerMillion: pricing.cacheReadPerMillion ?? 0,
    cacheCreationRate: pricing.cacheWritePerMillion ?? pricing.inputPerMillion,
    appliedServiceTier: OpenAICanonicalServiceTier.Standard,
    cacheCreationRateSource:
      pricing.cacheWritePerMillion === undefined ? "input_rate_fallback" : "explicit_cache_write_rate",
  };
}

export function computeOpenAIResponsesCostUsdMicros(params: {
  model: string;
  usage: OpenAIResponsesUsage;
  peakContextTokens?: number;
  // The service tier the provider actually used (priced by the returned tier, not the requested
  // one, so a flex->default fallback is costed correctly). Defaults to standard.
  serviceTier?: OpenAICanonicalServiceTier;
}): { costUsdMicros: number; normalized: NormalizedOpenAIUsage; provenance: PricingProvenance } {
  const resolved = resolvePricing(params.model, params.peakContextTokens);
  const pricing = resolved.pricing;
  const rates = resolveEffectiveRates(pricing, params.serviceTier ?? OpenAICanonicalServiceTier.Standard);
  const normalized = normalizeOpenAIResponsesUsage(params.usage);
  const costUsd =
    (normalized.uncachedInputTokens / TOKENS_PER_MILLION) * rates.inputPerMillion +
    (normalized.cachedInputTokens / TOKENS_PER_MILLION) * rates.cacheReadPerMillion +
    (normalized.cacheCreationTokens / TOKENS_PER_MILLION) * rates.cacheCreationRate +
    (normalized.outputTokens / TOKENS_PER_MILLION) * rates.outputPerMillion;

  return {
    costUsdMicros: Math.round(costUsd * 1_000_000),
    normalized,
    provenance: {
      helperName: "computeOpenAIResponsesCostUsdMicros",
      pricingTable: "OPENAI_GATEWAY_MODEL_PRICING",
      model: params.model,
      pricingTier: resolved.tier,
      serviceTier: rates.appliedServiceTier,
      longContextThresholdTokens: resolved.thresholdTokens,
      cacheCreationRateSource: rates.cacheCreationRateSource,
      reasoningOutputTokensIncludedInOutputTokens: true,
    },
  };
}

export function estimateOpenAIResponsesCostUsdMicros(payload: Record<string, unknown>): number {
  const model = typeof payload.model === "string" ? payload.model : "";
  if (!model) throw new OpenAIGatewayPricingError("Missing OpenAI model");
  const inputEstimateTokens = estimateInputTokens(payload.input);
  const maxOutputTokens = nonNegativeInteger(payload.max_output_tokens ?? payload.max_completion_tokens);
  const outputEstimateTokens = maxOutputTokens > 0 ? maxOutputTokens : 16_384;
  return computeOpenAIResponsesCostUsdMicros({
    model,
    usage: {
      input_tokens: inputEstimateTokens,
      output_tokens: outputEstimateTokens,
    },
    peakContextTokens: inputEstimateTokens,
  }).costUsdMicros;
}

function estimateInputTokens(input: unknown): number {
  if (input === undefined || input === null) return 0;
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  return Math.max(1, Math.ceil(serialized.length / 4));
}
