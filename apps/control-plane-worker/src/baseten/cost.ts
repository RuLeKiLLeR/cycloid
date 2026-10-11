import { TOKENS_PER_MILLION } from "../openai-gateway/cost";

export type BasetenChatCompletionsUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

type BasetenModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
};

type NormalizedBasetenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
};

type BasetenPricingProvenance = {
  helperName: "computeBasetenCostUsdMicros";
  pricingTable: "BASETEN_MODEL_API_PRICING";
  model: string;
  pricingSource:
    "baseten_pricing_page_2026_06_26" | "baseten_pricing_page_2026_06_30" | "baseten_pricing_page_2026_07_04";
  dedicatedDeploymentsPricedPerMinute: true;
};

export type BasetenCostResult =
  | {
      costUsdMicros: number;
      normalized: NormalizedBasetenUsage;
      provenance: BasetenPricingProvenance;
      pricingUnavailableReason?: never;
    }
  | {
      costUsdMicros: null;
      normalized: NormalizedBasetenUsage;
      provenance: BasetenPricingProvenance | null;
      pricingUnavailableReason: "unknown_model" | "dedicated_deployment_gpu_minute";
    };

// Verified against https://www.baseten.co/pricing on 2026-06-26. Baseten Model
// APIs are token-priced; dedicated deployments are GPU-minute priced and must
// not reuse this table.
export const BASETEN_MODEL_API_PRICING: Record<string, BasetenModelPricing> = {
  "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 5,
  },
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 5,
  },
  "moonshotai/Kimi-K2-Instruct-0905": {
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.12,
    outputPerMillion: 2.5,
  },
  "zai-org/GLM-4.6": {
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.12,
    outputPerMillion: 2.2,
  },
  // Retained for cost attribution from historical usage events. These wire
  // ids are intentionally absent from the supported model registry above.
  "zai-org/GLM-4.7": {
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.12,
    outputPerMillion: 2.2,
  },
  "openai/gpt-oss-120b": {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 0.5,
  },
  "moonshotai/Kimi-K2.7-Code": {
    inputPerMillion: 0.95,
    cachedInputPerMillion: 0.16,
    outputPerMillion: 4,
  },
  "deepseek-ai/DeepSeek-V3.2-Exp": {
    inputPerMillion: 0.28,
    cachedInputPerMillion: 0.056,
    outputPerMillion: 0.42,
  },
};

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeBasetenUsage(usage: BasetenChatCompletionsUsage): NormalizedBasetenUsage {
  const inputTokens = nonNegativeInteger(usage.prompt_tokens);
  const cachedInputTokens = Math.min(nonNegativeInteger(usage.prompt_tokens_details?.cached_tokens), inputTokens);
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens: nonNegativeInteger(usage.completion_tokens),
  };
}

function isDedicatedDeployment(params: { baseUrl?: string; dedicatedDeployment?: boolean }): boolean {
  if (params.dedicatedDeployment) return true;
  if (!params.baseUrl) return false;
  const baseUrl = params.baseUrl.replace(/\/+$/, "");
  return baseUrl !== "https://inference.baseten.co/v1" && !baseUrl.startsWith("https://inference.baseten.co/v1/");
}

export function computeBasetenCostUsdMicros(params: {
  model: string;
  usage: BasetenChatCompletionsUsage;
  baseUrl?: string;
  dedicatedDeployment?: boolean;
}): BasetenCostResult {
  const normalized = normalizeBasetenUsage(params.usage);
  if (isDedicatedDeployment(params)) {
    return {
      costUsdMicros: null,
      normalized,
      provenance: null,
      pricingUnavailableReason: "dedicated_deployment_gpu_minute",
    };
  }

  const pricing = BASETEN_MODEL_API_PRICING[params.model];
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
    (normalized.cachedInputTokens / TOKENS_PER_MILLION) * pricing.cachedInputPerMillion +
    (normalized.outputTokens / TOKENS_PER_MILLION) * pricing.outputPerMillion;

  return {
    costUsdMicros: Math.round(costUsd * 1_000_000),
    normalized,
    provenance: {
      helperName: "computeBasetenCostUsdMicros",
      pricingTable: "BASETEN_MODEL_API_PRICING",
      model: params.model,
      pricingSource:
        params.model === "moonshotai/Kimi-K2.7-Code" || params.model === "openai/gpt-oss-120b"
          ? "baseten_pricing_page_2026_07_04"
          : params.model === "zai-org/GLM-4.7"
            ? "baseten_pricing_page_2026_06_30"
            : "baseten_pricing_page_2026_06_26",
      dedicatedDeploymentsPricedPerMinute: true,
    },
  };
}
