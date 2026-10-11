import { describe, expect, it } from "vitest";

import { PROVIDER_ENV_VAR } from "../../apps/control-plane-worker/src/integrations/db.js";
import { MODEL_PRICING } from "../../apps/sandbox-bridge/src/constants/bridge.js";
import {
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
} from "../../shared/agent/agent-runtime-backend.js";
import {
  AnthropicModel,
  BasetenModel,
  DEFAULT_SESSION_START_MODEL_ID,
  extractModelId,
  extractSessionStartModelIdForBackend,
  formatModelLabel,
  getModelDefinition,
  getModelDesktopImageFeedbackConfig,
  getProviderForModel,
  getSessionStartModelIdsForBackend,
  isModelCostTracked,
  isSessionStartModelAllowedForBackend,
  MODEL_CONTEXT_WINDOWS,
  MODEL_REGISTRY,
  modelSupportsCodexToolSearch,
  OpenAIModel,
  PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS,
  toModelSelection,
  VALID_MODEL_IDS,
} from "../../shared/constants/models.js";

describe("model ID coverage", () => {
  it("every valid model in VALID_MODEL_IDS has pricing", () => {
    for (const model of VALID_MODEL_IDS) {
      if (!isModelCostTracked(model)) continue;
      expect(MODEL_PRICING, `Missing MODEL_PRICING entry for ${model}`).toHaveProperty(model);
    }
  });

  it("every valid model in VALID_MODEL_IDS has a context window", () => {
    for (const model of VALID_MODEL_IDS) {
      expect(MODEL_CONTEXT_WINDOWS, `Missing MODEL_CONTEXT_WINDOWS entry for ${model}`).toHaveProperty(model);
    }
  });
});

describe("session start model allowlist", () => {
  it("allows frontier models and GPT-5.4 Mini for new sessions", () => {
    expect(getSessionStartModelIdsForBackend(CODEX_AGENT_RUNTIME_BACKEND)).toEqual([
      "gpt-5.4",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(DEFAULT_SESSION_START_MODEL_ID).toBe("gpt-5.4");

    expect(extractSessionStartModelIdForBackend("openai/gpt-5.6", CODEX_AGENT_RUNTIME_BACKEND)).toBe("gpt-5.6");
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.6-sol", CODEX_AGENT_RUNTIME_BACKEND)).toBe("gpt-5.6-sol");
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.6-terra", CODEX_AGENT_RUNTIME_BACKEND)).toBe(
      "gpt-5.6-terra",
    );
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.6-luna", CODEX_AGENT_RUNTIME_BACKEND)).toBe(
      "gpt-5.6-luna",
    );
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.5", CODEX_AGENT_RUNTIME_BACKEND)).toBe("gpt-5.5");
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.4", CODEX_AGENT_RUNTIME_BACKEND)).toBe("gpt-5.4");
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.4-mini", CODEX_AGENT_RUNTIME_BACKEND)).toBe(
      "gpt-5.4-mini",
    );
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.3-codex-spark", CODEX_AGENT_RUNTIME_BACKEND)).toBe(
      "gpt-5.3-codex-spark",
    );

    for (const model of [
      "gpt-5.4-pro",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5.2-chat-latest",
      "gpt-5.2-codex",
    ]) {
      expect(
        isSessionStartModelAllowedForBackend(model, CODEX_AGENT_RUNTIME_BACKEND),
        `${model} should not start sessions`,
      ).toBe(false);
      expect(extractSessionStartModelIdForBackend(model, CODEX_AGENT_RUNTIME_BACKEND)).toBeUndefined();
    }
  });

  it("keeps non-launch OpenAI models in the internal registry while excluding them from launch provider groups", () => {
    expect(MODEL_REGISTRY.some((model) => model.id === "gpt-5.4-mini")).toBe(true);

    // Launch groups span all agent runtime backends; each model carries its
    // backends so chooser surfaces can derive the session backend.
    const launchModelIds = PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS.flatMap((provider) =>
      provider.models.map((model) => model.id),
    );
    expect(launchModelIds).toEqual([
      "gpt-5.4",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "kimi-k2.7-code",
    ]);

    for (const provider of PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS) {
      for (const model of provider.models) {
        expect(model.backends.length, `${model.id} must declare backends`).toBeGreaterThan(0);
      }
    }

    expect(launchModelIds).toContain("kimi-k2.7-code");
    expect(launchModelIds).not.toContain("gpt-5.4-nano");
    expect(launchModelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it("fails closed for Codex tool_search support", () => {
    expect(modelSupportsCodexToolSearch("gpt-5.4")).toBe(true);
    expect(modelSupportsCodexToolSearch("gpt-5.4-mini")).toBe(true);
    expect(modelSupportsCodexToolSearch("gpt-5.4-nano")).toBe(false);
    expect(modelSupportsCodexToolSearch("nope-9-9")).toBe(false);
  });
});

describe("getProviderForModel", () => {
  it("returns 'openai' for OpenAI models", () => {
    expect(getProviderForModel("gpt-5.6")).toBe("openai");
    expect(getProviderForModel("gpt-5.6-sol")).toBe("openai");
    expect(getProviderForModel("gpt-5.6-terra")).toBe("openai");
    expect(getProviderForModel("gpt-5.6-luna")).toBe("openai");
    expect(getProviderForModel("gpt-5.5")).toBe("openai");
    expect(getProviderForModel("gpt-5.4")).toBe("openai");
    expect(getProviderForModel("gpt-5.4-pro")).toBe("openai");
    expect(getProviderForModel("gpt-5.4-mini")).toBe("openai");
    expect(getProviderForModel("gpt-5.4-nano")).toBe("openai");
    expect(getProviderForModel("gpt-5.3-codex")).toBe("openai");
    expect(getProviderForModel("gpt-5.2")).toBe("openai");
    expect(getProviderForModel("gpt-5.2-chat-latest")).toBe("openai");
    expect(getProviderForModel("gpt-5.2-codex")).toBe("openai");
    expect(getProviderForModel("kimi-k2.7-code")).toBe("baseten");
  });

  it("defaults to 'openai' for unknown models", () => {
    expect(getProviderForModel("unknown-model")).toBe("openai");
  });
});

describe("desktop image feedback capability", () => {
  it("uses verified harness-wide delivery for Codex and Claude Code models", () => {
    expect(getModelDesktopImageFeedbackConfig(OpenAIModel.GPT54, CODEX_AGENT_RUNTIME_BACKEND)).toEqual({
      backend: "codex",
      fixture: "known_image_fixture",
      deliveryPath: "synthetic_image_context",
      verifiedAt: "2026-07-07",
    });
    expect(getModelDesktopImageFeedbackConfig(AnthropicModel.Opus48, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toEqual({
      backend: "claude_code",
      fixture: "known_image_fixture",
      deliveryPath: "native_mcp_tool_result_image",
      verifiedAt: "2026-07-07",
    });
  });

  it("fails closed for model/backend mismatches and unknown models", () => {
    expect(getModelDesktopImageFeedbackConfig(OpenAIModel.GPT54, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBeUndefined();
    expect(getModelDesktopImageFeedbackConfig(AnthropicModel.Opus48, CODEX_AGENT_RUNTIME_BACKEND)).toBeUndefined();
    expect(getModelDesktopImageFeedbackConfig("unknown-model", CODEX_AGENT_RUNTIME_BACKEND)).toBeUndefined();
  });
});

describe("baseten probe model wire ids", () => {
  // Regression: Baseten serves namespaced ids (`moonshotai/Kimi-K2.7-Code`). The
  // registry id must stay slash-free so provider/model parsing resolves it to
  // baseten (not openai), while the real upstream wire id is carried in
  // providerModelId. A bare wire id makes Baseten return model-not-found and
  // the opencode session errors. Verified against GET /v1/models 2026-06-26.
  const basetenWireIds = [[BasetenModel.KimiK27Code, "moonshotai/Kimi-K2.7-Code"]] as const;

  for (const [registryId, wireId] of basetenWireIds) {
    it(`${registryId} carries a slash-free registry id and namespaced wire id`, () => {
      const def = getModelDefinition(registryId);
      expect(def?.id).toBe(registryId);
      expect(def?.id).not.toContain("/");
      expect(def?.providerModelId).toBe(wireId);
      expect(getProviderForModel(registryId)).toBe("baseten");
    });
  }

  it("keeps every Baseten session-start model priced and contextualized", () => {
    for (const [registryId] of basetenWireIds) {
      const def = getModelDefinition(registryId);
      expect(def?.backends).toEqual(["opencode"]);
      expect(def?.pricing).toBeDefined();
      expect(def?.contextWindow).toBeGreaterThan(0);
      expect(def?.providerModelId).toBeTruthy();
    }
  });

  it("keeps opencode desktop image feedback as an explicit approved model capability", () => {
    expect(getModelDesktopImageFeedbackConfig(BasetenModel.KimiK27Code, "opencode")).toEqual({
      backend: "opencode",
      fixture: "known_image_fixture",
      deliveryPath: "native_mcp_tool_result_image",
      verifiedAt: "2026-07-07",
    });
    expect(getModelDesktopImageFeedbackConfig("glm-4.7", "opencode")).toBeUndefined();
    expect(getModelDesktopImageFeedbackConfig("gpt-oss-120b", "opencode")).toBeUndefined();
  });
});

describe("extractModelId", () => {
  it("returns bare model ID from plain string", () => {
    expect(extractModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("strips provider: prefix", () => {
    expect(extractModelId("openai:gpt-5.4")).toBe("gpt-5.4");
  });

  it("strips provider/ prefix", () => {
    expect(extractModelId("openai/gpt-5.4")).toBe("gpt-5.4");
  });

  it("extracts modelID from object", () => {
    expect(extractModelId({ modelID: "gpt-5.4-mini" })).toBe("gpt-5.4-mini");
  });

  it("rejects unsupported provider prefixes", () => {
    expect(extractModelId("other:gpt-5.4")).toBeUndefined();
    expect(extractModelId("other/gpt-5.4")).toBeUndefined();
    expect(extractModelId({ modelID: "other:gpt-5.4" })).toBeUndefined();
  });

  it("strips provider/ prefix from object modelID", () => {
    expect(extractModelId({ modelID: "openai/gpt-5.4" })).toBe("gpt-5.4");
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(extractModelId(undefined)).toBeUndefined();
    expect(extractModelId(null)).toBeUndefined();
    expect(extractModelId("")).toBeUndefined();
    expect(extractModelId({})).toBeUndefined();
  });
});

describe("toModelSelection", () => {
  it("resolves provider from a bare model id", () => {
    expect(toModelSelection("gpt-5.5")).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  });

  it("keeps legacy GPT-5.4 Nano mapped to the OpenAI provider", () => {
    expect(toModelSelection("gpt-5.4-nano")).toEqual({ providerID: "openai", modelID: "gpt-5.4-nano" });
  });

  it("preserves OpenAI provider from composite string inputs", () => {
    expect(toModelSelection("openai/gpt-5.4")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    });
  });

  it("resolves provider from object inputs", () => {
    expect(toModelSelection({ providerID: "openai", modelID: "gpt-5.3-codex" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex",
    });
  });
});

describe("formatModelLabel", () => {
  it("formats shared labels with and without provider context", () => {
    expect(formatModelLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(formatModelLabel("gpt-5.5", { includeProvider: true })).toBe("OpenAI / GPT-5.5");
    expect(formatModelLabel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(formatModelLabel("gpt-5.4-mini", { includeProvider: true })).toBe("OpenAI / GPT-5.4 Mini");
  });
});

describe("PROVIDER_ENV_VAR", () => {
  it("every customer BYOK model provider has a corresponding env var entry", () => {
    const providers = new Set<string>();
    for (const modelId of VALID_MODEL_IDS) {
      const provider = getProviderForModel(modelId);
      providers.add(provider);
    }
    for (const provider of providers) {
      expect(PROVIDER_ENV_VAR, `Missing PROVIDER_ENV_VAR entry for provider "${provider}"`).toHaveProperty(provider);
    }
  });

  it("maps Baseten models to BASETEN_API_KEY", () => {
    expect(PROVIDER_ENV_VAR.baseten).toBe("BASETEN_API_KEY");
  });

  it("maps anthropic models to ANTHROPIC_API_KEY", () => {
    expect(PROVIDER_ENV_VAR.anthropic).toBe("ANTHROPIC_API_KEY");
  });
});
