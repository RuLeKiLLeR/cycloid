import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING,
  TOKENS_PER_MILLION,
} from "../../apps/sandbox-bridge/src/constants/bridge.js";
import { computeCost } from "../../apps/sandbox-bridge/src/utils/classify.js";
import { AnthropicModel, OpenAIModel } from "../../shared/constants/models.js";

const VERIFIED_OPENAI_PRICING = {
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
  [OpenAIModel.GPT54Pro]: {
    inputPerMillion: 30,
    outputPerMillion: 180,
    longContext: {
      thresholdTokens: 272_000,
      inputPerMillion: 60,
      outputPerMillion: 270,
    },
  },
  [OpenAIModel.GPT54Mini]: { inputPerMillion: 0.75, outputPerMillion: 4.5, cacheReadPerMillion: 0.075 },
  [OpenAIModel.GPT54Nano]: { inputPerMillion: 0.2, outputPerMillion: 1.25, cacheReadPerMillion: 0.02 },
  [OpenAIModel.GPT53Codex]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT52]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT52ChatLatest]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  [OpenAIModel.GPT52Codex]: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
} as const;

describe("computeCost", () => {
  it("keeps Anthropic cache-write pricing explicit for current claude_code models", () => {
    expect(MODEL_PRICING[AnthropicModel.Opus48]).toMatchObject({
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    });
    expect(MODEL_PRICING[AnthropicModel.Sonnet46]).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    });
  });

  it("prices Anthropic cache-write tokens instead of silently treating them as free", () => {
    expect(computeCost(0, 0, 0, 1_000_000, AnthropicModel.Opus48)).toBeCloseTo(6.25, 4);
    expect(computeCost(0, 0, 0, 1_000_000, AnthropicModel.Sonnet46)).toBeCloseTo(3.75, 4);
  });

  it("computes cost for known model (gpt-5.4-mini)", () => {
    const model = "gpt-5.4-mini";
    const pricing = MODEL_PRICING[model]!;
    const input = 1_000_000;
    const output = 1_000_000;
    const expected = pricing.inputPerMillion + pricing.outputPerMillion;
    expect(computeCost(input, output, 0, 0, model)).toBeCloseTo(expected, 4);
  });

  it("computes cost for known model (gpt-5.4)", () => {
    const model = "gpt-5.4";
    const pricing = MODEL_PRICING[model]!;
    const input = 500_000;
    const output = 200_000;
    const expected =
      (500_000 / TOKENS_PER_MILLION) * pricing.inputPerMillion +
      (200_000 / TOKENS_PER_MILLION) * pricing.outputPerMillion;
    expect(computeCost(input, output, 0, 0, model)).toBeCloseTo(expected, 4);
  });

  it("computes cost for known model (gpt-5.5)", () => {
    const model = "gpt-5.5";
    const pricing = MODEL_PRICING[model]!;
    const input = 500_000;
    const output = 200_000;
    const cacheRead = 100_000;
    const cacheWrite = 50_000;
    const expected =
      (input / TOKENS_PER_MILLION) * pricing.inputPerMillion +
      (output / TOKENS_PER_MILLION) * pricing.outputPerMillion +
      (cacheRead / TOKENS_PER_MILLION) * (pricing.cacheReadPerMillion ?? 0) +
      (cacheWrite / TOKENS_PER_MILLION) * (pricing.cacheWritePerMillion ?? 0);
    expect(computeCost(input, output, cacheRead, cacheWrite, model)).toBeCloseTo(expected, 4);
  });

  it("falls back to DEFAULT_MODEL_PRICING for unknown models", () => {
    const input = 1_000_000;
    const output = 1_000_000;
    const expected = DEFAULT_MODEL_PRICING.inputPerMillion + DEFAULT_MODEL_PRICING.outputPerMillion;
    expect(computeCost(input, output, 0, 0, "unknown-model-xyz")).toBeCloseTo(expected, 4);
  });

  it("falls back to DEFAULT_MODEL_PRICING when model is undefined", () => {
    const input = 1_000_000;
    const output = 1_000_000;
    const expected = DEFAULT_MODEL_PRICING.inputPerMillion + DEFAULT_MODEL_PRICING.outputPerMillion;
    expect(computeCost(input, output, 0, 0, undefined)).toBeCloseTo(expected, 4);
  });

  it("returns 0 for non-cost-tracked registry models", () => {
    expect(computeCost(1_000_000, 1_000_000, 500_000, 250_000, OpenAIModel.GPT53CodexSpark)).toBe(0);
  });

  it("includes cache read tokens in cost", () => {
    const model = "gpt-5.4-mini";
    const pricing = MODEL_PRICING[model]!;
    const cacheRead = 1_000_000;
    const expected = pricing.inputPerMillion + pricing.outputPerMillion + (pricing.cacheReadPerMillion ?? 0);
    expect(computeCost(1_000_000, 1_000_000, cacheRead, 0, model)).toBeCloseTo(expected, 4);
  });

  it("includes cache write tokens in cost", () => {
    const model = "gpt-5.4-mini";
    const pricing = MODEL_PRICING[model]!;
    const cacheWrite = 1_000_000;
    const expected = pricing.inputPerMillion + pricing.outputPerMillion + (pricing.cacheWritePerMillion ?? 0);
    expect(computeCost(1_000_000, 1_000_000, 0, cacheWrite, model)).toBeCloseTo(expected, 4);
  });

  it("returns 0 for zero tokens", () => {
    expect(computeCost(0, 0, 0, 0, "gpt-5.4-mini")).toBe(0);
    expect(computeCost(0, 0, 0, 0, undefined)).toBe(0);
  });

  it("handles GPT-5.4 Mini pricing correctly", () => {
    const model = "gpt-5.4-mini";
    const pricing = MODEL_PRICING[model]!;
    const cost = computeCost(1_000_000, 1_000_000, 0, 0, model);
    expect(cost).toBeCloseTo(pricing.inputPerMillion + pricing.outputPerMillion, 4);
  });

  it("keeps the verified OpenAI pricing table", () => {
    for (const [model, expected] of Object.entries(VERIFIED_OPENAI_PRICING)) {
      expect(MODEL_PRICING[model]).toEqual(expected);
    }
  });

  it("keeps the legacy GPT-5.4 Nano rate card for historical usage", () => {
    expect(MODEL_PRICING[OpenAIModel.GPT54Nano]).toEqual(VERIFIED_OPENAI_PRICING[OpenAIModel.GPT54Nano]);

    const cost = computeCost(1_000_000, 1_000_000, 500_000, 0, OpenAIModel.GPT54Nano);
    const expected = 0.2 + 1.25 + (500_000 / TOKENS_PER_MILLION) * 0.02;

    expect(cost).toBeCloseTo(expected, 4);
  });

  it("computes GPT-5.4 cost using the verified OpenAI rate card", () => {
    const cost = computeCost(1_000_000, 250_000, 500_000, 0, OpenAIModel.GPT54);
    const expected = 2.5 + (250_000 / TOKENS_PER_MILLION) * 15 + (500_000 / TOKENS_PER_MILLION) * 0.25;

    expect(cost).toBeCloseTo(expected, 4);
  });

  it("computes GPT-5.5 cost using the verified OpenAI rate card", () => {
    const cost = computeCost(1_000_000, 250_000, 500_000, 0, OpenAIModel.GPT55);
    const expected = 5 + (250_000 / TOKENS_PER_MILLION) * 30 + (500_000 / TOKENS_PER_MILLION) * 0.5;

    expect(cost).toBeCloseTo(expected, 4);
  });

  it("does not apply cached-token pricing to GPT-5.4 Pro", () => {
    const cost = computeCost(500_000, 200_000, 100_000, 50_000, OpenAIModel.GPT54Pro);
    const expected = (500_000 / TOKENS_PER_MILLION) * 30 + (200_000 / TOKENS_PER_MILLION) * 180;

    expect(cost).toBeCloseTo(expected, 4);
  });

  it("applies GPT-5.4 long-context pricing once the prompt crosses 272K tokens", () => {
    const cost = computeCost(1_000_000, 250_000, 500_000, 0, OpenAIModel.GPT54, {
      peakContextTokens: 300_000,
    });
    const expected = 5 + (250_000 / TOKENS_PER_MILLION) * 22.5 + (500_000 / TOKENS_PER_MILLION) * 0.5;

    expect(cost).toBeCloseTo(expected, 4);
  });

  it("applies GPT-5.5 long-context pricing once the prompt crosses 272K tokens", () => {
    const cost = computeCost(1_000_000, 250_000, 500_000, 0, OpenAIModel.GPT55, {
      peakContextTokens: 300_000,
    });
    const expected = 10 + (250_000 / TOKENS_PER_MILLION) * 45 + (500_000 / TOKENS_PER_MILLION) * 1;

    expect(cost).toBeCloseTo(expected, 4);
  });

  it("applies GPT-5.4 Pro long-context pricing once the prompt crosses 272K tokens", () => {
    const cost = computeCost(500_000, 200_000, 100_000, 50_000, OpenAIModel.GPT54Pro, {
      peakContextTokens: 300_000,
    });
    const expected = (500_000 / TOKENS_PER_MILLION) * 60 + (200_000 / TOKENS_PER_MILLION) * 270;

    expect(cost).toBeCloseTo(expected, 4);
  });
});
