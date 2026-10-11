import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import {
  getProviderForModel,
  isValidReasoningEffort,
  MODEL_REASONING_CONFIG,
  MODEL_REGISTRY,
  type ReasoningEffort,
  VALID_MODEL_IDS,
} from "../../shared/constants/models.js";

const ALL_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

// Models that expose no reasoning config (derived from the registry).
const MODELS_WITHOUT_REASONING = new Set<string>(
  MODEL_REGISTRY.filter((model) => !model.reasoning).map((model) => model.id),
);

describe("model reasoning config", () => {
  describe("isValidReasoningEffort", () => {
    it("accepts valid efforts for GPT-5.4 Mini", () => {
      for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
        expect(isValidReasoningEffort("gpt-5.4-mini", effort)).toBe(true);
      }
    });

    it("accepts valid efforts for GPT-5.4", () => {
      for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
        expect(isValidReasoningEffort("gpt-5.4", effort)).toBe(true);
      }
    });

    it("accepts valid efforts for GPT-5.5", () => {
      for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
        expect(isValidReasoningEffort("gpt-5.5", effort)).toBe(true);
      }
    });

    it("accepts valid efforts for GPT-5.6 models", () => {
      for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
          expect(isValidReasoningEffort(model, effort), `${model} should accept ${effort}`).toBe(true);
        }
      }
    });

    it("accepts valid efforts for GPT-5.3 Codex Spark", () => {
      for (const effort of ["low", "medium", "high", "xhigh"]) {
        expect(isValidReasoningEffort("gpt-5.3-codex-spark", effort)).toBe(true);
      }
      expect(isValidReasoningEffort("gpt-5.3-codex-spark", "none")).toBe(false);
    });

    it("accepts valid Claude Code efforts per model", () => {
      for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
        expect(isValidReasoningEffort("claude-opus-4-8", effort)).toBe(true);
      }
      for (const effort of ["none", "low", "medium", "high", "max"]) {
        expect(isValidReasoningEffort("claude-sonnet-4-6", effort)).toBe(true);
      }
      for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
        expect(isValidReasoningEffort("claude-sonnet-5", effort)).toBe(true);
      }
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        expect(isValidReasoningEffort("claude-fable-5", effort)).toBe(true);
      }
    });

    it("rejects efforts not in the model's list", () => {
      expect(isValidReasoningEffort("gpt-5.4", "max")).toBe(false);
      expect(isValidReasoningEffort("gpt-5.4-mini", "max")).toBe(false);
      expect(isValidReasoningEffort("gpt-5.5", "max")).toBe(false);
      expect(isValidReasoningEffort("gpt-5.6-sol", "ultra")).toBe(false);
      expect(isValidReasoningEffort("claude-sonnet-4-6", "xhigh")).toBe(false);
      expect(isValidReasoningEffort("claude-fable-5", "none")).toBe(false);
    });

    it("rejects unknown effort levels and models", () => {
      expect(isValidReasoningEffort("gpt-5.4-mini", "turbo")).toBe(false);
      expect(isValidReasoningEffort("gpt-5.4-mini", "")).toBe(false);
      expect(isValidReasoningEffort("gpt-unknown-99", "high")).toBe(false);
    });
  });

  describe("default reasoning effort", () => {
    it("GPT-5.5 defaults to medium", () => {
      expect(VALID_MODEL_IDS.has("gpt-5.5")).toBe(true);
      expect(MODEL_REASONING_CONFIG["gpt-5.5"]?.default).toBe("medium");
    });

    it("GPT-5.6 models default to medium", () => {
      for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        expect(VALID_MODEL_IDS.has(model)).toBe(true);
        expect(MODEL_REASONING_CONFIG[model]?.default).toBe("medium");
      }
    });

    it("GPT-5.4 defaults to medium (codex default after the gpt-5.5 downgrade)", () => {
      expect(VALID_MODEL_IDS.has("gpt-5.4")).toBe(true);
      expect(MODEL_REASONING_CONFIG["gpt-5.4"]?.default).toBe("medium");
    });

    it("Claude Code models default to high", () => {
      expect(MODEL_REASONING_CONFIG["claude-opus-4-8"]?.default).toBe("high");
      expect(MODEL_REASONING_CONFIG["claude-sonnet-4-6"]?.default).toBe("high");
      expect(MODEL_REASONING_CONFIG["claude-sonnet-5"]?.default).toBe("high");
      expect(MODEL_REASONING_CONFIG["claude-fable-5"]?.default).toBe("high");
    });

    it("GPT-5.3 Codex Spark defaults to high", () => {
      expect(MODEL_REASONING_CONFIG["gpt-5.3-codex-spark"]?.default).toBe("high");
    });
  });

  describe("models without reasoning support", () => {
    it("contains exactly the internal Baseten probe", () => {
      for (const modelId of MODELS_WITHOUT_REASONING) {
        expect(getProviderForModel(modelId), `${modelId} should be baseten`).toBe("baseten");
      }
      const basetenCount = [...VALID_MODEL_IDS].filter((id) => getProviderForModel(id) === "baseten").length;
      expect(MODELS_WITHOUT_REASONING.size).toBe(basetenCount);
    });

    for (const modelId of MODELS_WITHOUT_REASONING) {
      it(`${modelId} rejects all reasoning efforts`, () => {
        for (const effort of ALL_EFFORTS) {
          expect(isValidReasoningEffort(modelId, effort)).toBe(false);
        }
      });
    }
  });
});
