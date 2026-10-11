import { describe, expect, it } from "vitest";

import { computeBasetenCostUsdMicros } from "../../apps/control-plane-worker/src/baseten/cost";

describe("Baseten structured output cost", () => {
  it("computes hosted Model API token costs from verified pricing", () => {
    const result = computeBasetenCostUsdMicros({
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
    });

    expect(result).toMatchObject({
      costUsdMicros: 1_500_000,
      normalized: {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        uncachedInputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      provenance: {
        helperName: "computeBasetenCostUsdMicros",
        pricingTable: "BASETEN_MODEL_API_PRICING",
        pricingSource: "baseten_pricing_page_2026_06_26",
      },
    });
  });

  it("prices cached hosted Model API input tokens at the cached-token rate", () => {
    const result = computeBasetenCostUsdMicros({
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 250_000 },
      },
    });

    expect(result).toMatchObject({
      costUsdMicros: 1_300_000,
      normalized: {
        inputTokens: 1_000_000,
        cachedInputTokens: 250_000,
        uncachedInputTokens: 750_000,
        outputTokens: 100_000,
      },
    });
  });

  it("recognizes Baseten's documented Qwen model id", () => {
    const result = computeBasetenCostUsdMicros({
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
    });

    expect(result).toMatchObject({
      costUsdMicros: 1_500_000,
      provenance: {
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      },
    });
  });

  it("computes Kimi K2.7 Code hosted Model API token costs from published pricing", () => {
    const result = computeBasetenCostUsdMicros({
      model: "moonshotai/Kimi-K2.7-Code",
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 200_000 },
      },
    });

    // 0.8M uncached * $0.95 + 0.2M cached * $0.16 + 0.1M output * $4.00 = $1.192.
    expect(result).toMatchObject({
      costUsdMicros: 1_192_000,
      normalized: {
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        uncachedInputTokens: 800_000,
        outputTokens: 100_000,
      },
      provenance: {
        model: "moonshotai/Kimi-K2.7-Code",
        pricingSource: "baseten_pricing_page_2026_07_04",
      },
    });
  });

  it.each([
    ["zai-org/GLM-4.7", 724_000, "baseten_pricing_page_2026_06_30"],
    ["openai/gpt-oss-120b", 150_000, "baseten_pricing_page_2026_07_04"],
  ] as const)("retains historical pricing for retired wire model %s", (model, costUsdMicros, pricingSource) => {
    const result = computeBasetenCostUsdMicros({
      model,
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 200_000 },
      },
    });

    expect(result).toMatchObject({
      costUsdMicros,
      provenance: { model, pricingSource },
    });
  });

  it("returns null pricing for unknown hosted models", () => {
    const result = computeBasetenCostUsdMicros({
      model: "unknown/model",
      usage: { prompt_tokens: 1_000, completion_tokens: 100 },
    });

    expect(result).toMatchObject({
      costUsdMicros: null,
      pricingUnavailableReason: "unknown_model",
      provenance: null,
    });
  });

  it("returns null pricing for dedicated deployments because they are GPU-minute priced", () => {
    const result = computeBasetenCostUsdMicros({
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      baseUrl: "https://model-abc.api.baseten.co/environments/production/predict",
      usage: { prompt_tokens: 1_000, completion_tokens: 100 },
    });

    expect(result).toMatchObject({
      costUsdMicros: null,
      pricingUnavailableReason: "dedicated_deployment_gpu_minute",
      provenance: null,
    });
  });

  it("does not classify future v1-prefixed URLs as hosted Model API URLs", () => {
    const result = computeBasetenCostUsdMicros({
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      baseUrl: "https://inference.baseten.co/v1beta",
      usage: { prompt_tokens: 1_000, completion_tokens: 100 },
    });

    expect(result).toMatchObject({
      costUsdMicros: null,
      pricingUnavailableReason: "dedicated_deployment_gpu_minute",
      provenance: null,
    });
  });
});
