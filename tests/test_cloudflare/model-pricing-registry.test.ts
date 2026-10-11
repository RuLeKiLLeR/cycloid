import { describe, expect, it } from "vitest";

import { ANTHROPIC_MESSAGES_MODEL_PRICING } from "../../apps/control-plane-worker/src/anthropic/cost";
import { OPENAI_GATEWAY_MODEL_PRICING } from "../../apps/control-plane-worker/src/openai-gateway/cost";
import { MODEL_PRICING } from "../../apps/sandbox-bridge/src/constants/bridge";
import { AGENT_RUNTIME_BACKENDS, CODEX_AGENT_RUNTIME_BACKEND } from "../../shared/agent/agent-runtime-backend";
import {
  AnthropicModel,
  BasetenModel,
  DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND,
  isModelCostTracked,
  MODEL_REGISTRY,
  type ModelId,
  OpenAIModel,
  requiresCodexSubscriptionAuthForModel,
  SESSION_START_MODEL_IDS_BY_BACKEND,
  VALID_MODEL_IDS,
} from "../../shared/constants/models";

const MODEL_ID_ENUM_VALUES = [
  ...Object.values(OpenAIModel).filter((id) => id !== OpenAIModel.GPT54Pro),
  ...Object.values(AnthropicModel),
  ...Object.values(BasetenModel),
] satisfies ModelId[];

const GPT56_SOL_PRICING = {
  inputPerMillion: 5,
  outputPerMillion: 30,
  cacheReadPerMillion: 0.5,
  longContext: {
    thresholdTokens: 272_000,
    inputPerMillion: 10,
    outputPerMillion: 45,
    cacheReadPerMillion: 1,
  },
} as const;

const FROZEN_OPENAI_GATEWAY_PRICING = {
  // gpt-5.6 is an alias that resolves to gpt-5.6-sol, so it carries Sol's rates.
  [OpenAIModel.GPT56]: GPT56_SOL_PRICING,
  [OpenAIModel.GPT56Sol]: GPT56_SOL_PRICING,
  [OpenAIModel.GPT56Terra]: {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.25,
    longContext: {
      thresholdTokens: 272_000,
      inputPerMillion: 5,
      outputPerMillion: 22.5,
      cacheReadPerMillion: 0.5,
    },
  },
  [OpenAIModel.GPT56Luna]: {
    inputPerMillion: 1,
    outputPerMillion: 6,
    cacheReadPerMillion: 0.1,
    longContext: {
      thresholdTokens: 272_000,
      inputPerMillion: 2,
      outputPerMillion: 9,
      cacheReadPerMillion: 0.2,
    },
  },
  [OpenAIModel.GPT55]: {
    inputPerMillion: 5,
    outputPerMillion: 30,
    cacheReadPerMillion: 0.5,
    longContext: {
      thresholdTokens: 272_000,
      inputPerMillion: 10,
      outputPerMillion: 45,
      cacheReadPerMillion: 1,
    },
  },
  [OpenAIModel.GPT54]: {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.25,
    longContext: {
      thresholdTokens: 272_000,
      inputPerMillion: 5,
      outputPerMillion: 22.5,
      cacheReadPerMillion: 0.5,
    },
  },
  [OpenAIModel.GPT54Mini]: {
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    cacheReadPerMillion: 0.075,
    flex: { inputPerMillion: 0.375, outputPerMillion: 2.25, cacheReadPerMillion: 0.0375 },
  },
  [OpenAIModel.GPT54Nano]: { inputPerMillion: 0.2, outputPerMillion: 1.25, cacheReadPerMillion: 0.02 },
  [OpenAIModel.GPT53Codex]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT52]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT52ChatLatest]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT52Codex]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT54Pro]: {
    inputPerMillion: 30,
    outputPerMillion: 180,
    longContext: {
      thresholdTokens: 272_000,
      inputPerMillion: 60,
      outputPerMillion: 270,
    },
  },
} as const;

const FROZEN_BRIDGE_MODEL_PRICING = {
  // No flex/longContext.flex on the 5.6 family, so the bridge table keeps the gateway shape.
  [OpenAIModel.GPT56]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT56],
  [OpenAIModel.GPT56Sol]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT56Sol],
  [OpenAIModel.GPT56Terra]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT56Terra],
  [OpenAIModel.GPT56Luna]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT56Luna],
  [OpenAIModel.GPT55]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT55],
  [OpenAIModel.GPT54]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT54],
  [OpenAIModel.GPT54Mini]: { inputPerMillion: 0.75, outputPerMillion: 4.5, cacheReadPerMillion: 0.075 },
  [OpenAIModel.GPT54Nano]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT54Nano],
  [OpenAIModel.GPT53Codex]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT53Codex],
  [OpenAIModel.GPT52]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT52],
  [OpenAIModel.GPT52ChatLatest]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT52ChatLatest],
  [OpenAIModel.GPT52Codex]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT52Codex],
  [AnthropicModel.Opus48]: {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  [AnthropicModel.Sonnet46]: {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  [AnthropicModel.Sonnet5]: {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  [AnthropicModel.Fable5]: {
    inputPerMillion: 10,
    outputPerMillion: 50,
    cacheReadPerMillion: 1,
    cacheWritePerMillion: 12.5,
  },
  [BasetenModel.KimiK27Code]: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16 },
  [OpenAIModel.GPT54Pro]: FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT54Pro],
} as const;

// Authoritative control-plane Anthropic Messages billing table. Hand-maintained
// and intentionally allowed to diverge from the registry `pricing` estimate, so
// this is frozen and coverage-checked on its own rather than cross-compared.
const FROZEN_ANTHROPIC_MESSAGES_PRICING = {
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
} as const;

describe("registry-derived model pricing", () => {
  it("keeps the OpenAI gateway pricing table byte-identical to the frozen pre-refactor fixture", () => {
    expect(OPENAI_GATEWAY_MODEL_PRICING).toEqual(FROZEN_OPENAI_GATEWAY_PRICING);
  });

  it("keeps the bridge pricing table byte-identical to the frozen pre-refactor fixture", () => {
    expect(MODEL_PRICING).toEqual(FROZEN_BRIDGE_MODEL_PRICING);
  });

  it("requires every billable registry model to carry pricing", () => {
    for (const model of MODEL_REGISTRY) {
      if (!isModelCostTracked(model.id)) {
        expect(model.pricing, `${model.id} must not invent pricing`).toBeUndefined();
        continue;
      }
      expect(model.pricing, `${model.id} must define registry pricing`).toBeDefined();
    }
  });

  it("prices every OpenAI model that can route through the metered gateway", () => {
    // The gateway reserves budget up front from OPENAI_GATEWAY_MODEL_PRICING and hard-fails the
    // request (HTTP 400 "Unknown OpenAI model pricing") for ANY OpenAI model absent from that
    // table — not only session-start models (a verification/probe/internal path can route a
    // non-eligible model through /openai/responses too). So every registry OpenAI model that
    // does not require Codex subscription auth (which bypasses the metered gateway) must carry
    // gateway pricing and be cost-tracked, regardless of session-start eligibility. This is
    // exactly what gpt-5.6 lacked when it shipped with costTracked:false and no pricing.
    for (const model of MODEL_REGISTRY) {
      if (model.provider !== "openai") continue;
      if (requiresCodexSubscriptionAuthForModel(model.id)) continue;
      expect(
        OPENAI_GATEWAY_MODEL_PRICING[model.id],
        `${model.id} routes through the metered OpenAI gateway and must define gateway pricing`,
      ).toBeDefined();
      expect(
        isModelCostTracked(model.id),
        `${model.id} routes through the metered OpenAI gateway and must be cost-tracked`,
      ).toBe(true);
    }
  });

  it("keeps the Anthropic Messages pricing table byte-identical to the frozen fixture", () => {
    expect(ANTHROPIC_MESSAGES_MODEL_PRICING).toEqual(FROZEN_ANTHROPIC_MESSAGES_PRICING);
  });

  it("prices every Anthropic model that can route through the metered gateway", () => {
    // Anthropic models are billed through the control-plane Anthropic Messages gateway, which
    // prices usage from ANTHROPIC_MESSAGES_MODEL_PRICING. Unlike the OpenAI gateway (which
    // hard-fails), a missing model fails SOFT here: cost attribution silently drops to null (see
    // anthropic/cost.ts `pricingUnavailableReason: "unknown_model"`), so an unpriced model leaks
    // revenue instead of erroring. Anthropic has no subscription-auth bypass, so — like the
    // OpenAI guard above and independent of session-start eligibility — every registry Anthropic
    // model must carry gateway pricing and be cost-tracked.
    for (const model of MODEL_REGISTRY) {
      if (model.provider !== "anthropic") continue;
      expect(
        ANTHROPIC_MESSAGES_MODEL_PRICING[model.id],
        `${model.id} routes through the metered Anthropic gateway and must define gateway pricing`,
      ).toBeDefined();
      expect(
        isModelCostTracked(model.id),
        `${model.id} routes through the metered Anthropic gateway and must be cost-tracked`,
      ).toBe(true);
    }
  });

  it("keeps ModelId membership aligned with the registry except GPT-5.4 Pro", () => {
    expect([...VALID_MODEL_IDS].sort()).toEqual([...MODEL_ID_ENUM_VALUES].sort());
    expect(MODEL_REGISTRY.map((model) => model.id).sort()).toEqual([...MODEL_ID_ENUM_VALUES].sort());
  });

  it("keeps GPT-5.4 Pro as the only priced OpenAI model outside ModelId and the registry", () => {
    expect(VALID_MODEL_IDS.has(OpenAIModel.GPT54Pro)).toBe(false);
    expect(MODEL_REGISTRY.some((model) => model.id === OpenAIModel.GPT54Pro)).toBe(false);
    expect(OPENAI_GATEWAY_MODEL_PRICING[OpenAIModel.GPT54Pro]).toEqual(
      FROZEN_OPENAI_GATEWAY_PRICING[OpenAIModel.GPT54Pro],
    );
    expect(MODEL_PRICING[OpenAIModel.GPT54Pro]).toEqual(FROZEN_BRIDGE_MODEL_PRICING[OpenAIModel.GPT54Pro]);
  });

  it("derives session-start eligibility and defaults from the registry", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      const expected = MODEL_REGISTRY.filter(
        (model) =>
          model.sessionStart?.eligible &&
          model.backends.includes(backend) &&
          (backend !== CODEX_AGENT_RUNTIME_BACKEND || model.capabilities?.codexToolSearch === true),
      ).map((model) => model.id);
      expect(SESSION_START_MODEL_IDS_BY_BACKEND[backend]).toEqual(expected);

      const defaults = MODEL_REGISTRY.filter(
        (model) =>
          model.sessionStart?.eligible && model.sessionStart.isDefault === true && model.backends.includes(backend),
      );
      expect(defaults, `${backend} must have exactly one default`).toHaveLength(1);
      expect(DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND[backend]).toBe(defaults[0]!.id);
    }
    expect(DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND[CODEX_AGENT_RUNTIME_BACKEND]).toBe(OpenAIModel.GPT54);
  });
});
