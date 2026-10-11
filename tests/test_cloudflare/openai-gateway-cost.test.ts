import { describe, expect, it } from "vitest";

import {
  computeOpenAIResponsesCostUsdMicros,
  estimateOpenAIResponsesCostUsdMicros,
  OpenAIGatewayPricingError,
} from "../../apps/control-plane-worker/src/openai-gateway/cost";
import { OpenAICanonicalServiceTier } from "../../shared/enums/openai-service-tier";

describe("OpenAI gateway cost helper", () => {
  it("costs uncached input and output tokens", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.4-mini",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });

    expect(result.costUsdMicros).toBe(5_250_000);
    expect(result.normalized).toMatchObject({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
  });

  it("treats cached input tokens as included in total input tokens", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.4",
      usage: {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 250_000 },
        output_tokens: 0,
      },
    });

    expect(result.costUsdMicros).toBe(1_937_500);
    expect(result.normalized.uncachedInputTokens).toBe(750_000);
  });

  it("records reasoning tokens without double-charging them outside output tokens", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.5",
      usage: {
        input_tokens: 100_000,
        input_tokens_details: { cached_tokens: 50_000 },
        output_tokens: 100_000,
        output_tokens_details: { reasoning_tokens: 25_000 },
      },
    });

    expect(result.normalized.reasoningOutputTokens).toBe(25_000);
    expect(result.costUsdMicros).toBe(3_275_000);
    expect(result.provenance.reasoningOutputTokensIncludedInOutputTokens).toBe(true);
  });

  it("clamps anomalous reasoning tokens to output tokens", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.5",
      usage: {
        input_tokens: 1,
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 11 },
      },
    });

    expect(result.normalized.outputTokens).toBe(10);
    expect(result.normalized.reasoningOutputTokens).toBe(10);
  });

  it("reports pricing provenance for cache-creation fallback and long-context tiers", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.4",
      usage: {
        input_tokens: 1_000_000,
        input_tokens_details: { cache_creation_tokens: 100_000 },
        output_tokens: 0,
      },
      peakContextTokens: 300_000,
    });

    expect(result.costUsdMicros).toBe(5_000_000);
    expect(result.provenance).toEqual({
      helperName: "computeOpenAIResponsesCostUsdMicros",
      pricingTable: "OPENAI_GATEWAY_MODEL_PRICING",
      model: "gpt-5.4",
      pricingTier: "long_context",
      serviceTier: OpenAICanonicalServiceTier.Standard,
      longContextThresholdTokens: 272_000,
      cacheCreationRateSource: "input_rate_fallback",
      reasoningOutputTokensIncludedInOutputTokens: true,
    });
  });

  it("applies flex (Batch-rate) pricing for gpt-5.4-mini at a flat 50% off, cached input included", () => {
    const usage = {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 250_000 },
      output_tokens: 1_000_000,
    };
    const standard = computeOpenAIResponsesCostUsdMicros({ model: "gpt-5.4-mini", usage });
    const flex = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.4-mini",
      usage,
      serviceTier: OpenAICanonicalServiceTier.Flex,
    });

    // 750k uncached @0.375 + 250k cached @0.0375 + 1M output @2.25 = 281250 + 9375 + 2250000.
    expect(flex.costUsdMicros).toBe(2_540_625);
    // Flat 50% off standard across every token class.
    expect(flex.costUsdMicros).toBe(Math.round(standard.costUsdMicros / 2));
    expect(flex.provenance.serviceTier).toBe("flex");
    expect(standard.provenance.serviceTier).toBe("standard");
  });

  it("keeps the service-tier axis separate from the long-context pricing tier", () => {
    const flex = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.4-mini",
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      serviceTier: OpenAICanonicalServiceTier.Flex,
    });
    // gpt-5.4-mini has no long-context table, so the context axis stays standard while flex applies.
    expect(flex.provenance.pricingTier).toBe("standard");
    expect(flex.provenance.serviceTier).toBe("flex");
  });

  it("falls back to standard pricing when flex is requested for a model without flex rates", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.4",
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      serviceTier: OpenAICanonicalServiceTier.Flex,
    });
    // gpt-5.4 has no flex rate table, so standard rates apply and provenance records standard.
    expect(result.costUsdMicros).toBe(2_500_000);
    expect(result.provenance.serviceTier).toBe("standard");
  });

  it("handles missing cache details", () => {
    const result = computeOpenAIResponsesCostUsdMicros({
      model: "gpt-5.2",
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    });

    expect(result.normalized.cachedInputTokens).toBe(0);
    expect(result.costUsdMicros).toBe(31_500);
  });

  it("fails closed for unknown model pricing", () => {
    expect(() =>
      computeOpenAIResponsesCostUsdMicros({
        model: "unknown-model",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(OpenAIGatewayPricingError);
    expect(() => estimateOpenAIResponsesCostUsdMicros({ model: "unknown-model", input: "hello" })).toThrow(
      OpenAIGatewayPricingError,
    );
  });
});
