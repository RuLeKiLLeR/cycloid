import { describe, expect, it } from "vitest";

import { computeAnthropicMessagesCostUsdMicros } from "../../apps/control-plane-worker/src/anthropic/cost";

describe("Anthropic structured output cost", () => {
  // Keep the authoritative model row covered with the registry pricing suite.
  it("computes Sonnet Messages API costs including both cache token classes", () => {
    const result = computeAnthropicMessagesCostUsdMicros({
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 200_000,
      },
    });

    // 1M uncached input at $3/M + 100k cache read at $0.30/M +
    // 200k cache write at $3.75/M + 100k output at $15/M = $5.28.
    expect(result).toMatchObject({
      costUsdMicros: 5_280_000,
      normalized: {
        inputTokens: 1_000_000,
        uncachedInputTokens: 1_000_000,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 200_000,
        outputTokens: 100_000,
      },
      provenance: {
        helperName: "computeAnthropicMessagesCostUsdMicros",
        pricingTable: "ANTHROPIC_MESSAGES_MODEL_PRICING",
        pricingSource: "anthropic_pricing_page_2026_07_12",
        cacheCreationRateSource: "5m_cache_write_rate",
      },
    });
  });

  it("computes Opus 4.8 pricing from the registered model table", () => {
    const result = computeAnthropicMessagesCostUsdMicros({
      model: "claude-opus-4-8",
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    });

    expect(result).toMatchObject({
      costUsdMicros: 7_500_000,
      provenance: {
        model: "claude-opus-4-8",
      },
    });
  });

  it("returns null pricing for unregistered Anthropic models", () => {
    const result = computeAnthropicMessagesCostUsdMicros({
      model: "claude-haiku-4-5",
      usage: { input_tokens: 1_000, output_tokens: 100 },
    });

    expect(result).toMatchObject({
      costUsdMicros: null,
      pricingUnavailableReason: "unknown_model",
      provenance: null,
    });
  });

  it("computes Sonnet 5 standard pricing including both cache token classes", () => {
    const result = computeAnthropicMessagesCostUsdMicros({
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 200_000,
      },
    });

    // Standard pricing: 1M input at $3/M + 100k cache read at $0.30/M +
    // 200k cache write at $3.75/M + 100k output at $15/M = $5.28.
    expect(result).toMatchObject({
      costUsdMicros: 5_280_000,
      provenance: {
        model: "claude-sonnet-5",
        pricingSource: "anthropic_pricing_page_2026_07_12",
      },
    });
  });

  it("computes Fable pricing from verified Messages API rates", () => {
    const result = computeAnthropicMessagesCostUsdMicros({
      model: "claude-fable-5",
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 200_000,
      },
    });

    // 1M uncached input at $10/M + 100k cache read at $1/M +
    // 200k cache write at $12.50/M + 100k output at $50/M = $17.60.
    expect(result).toMatchObject({
      costUsdMicros: 17_600_000,
      provenance: {
        model: "claude-fable-5",
        pricingSource: "anthropic_pricing_page_2026_07_12",
      },
    });
  });
});
