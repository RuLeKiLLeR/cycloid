import { describe, expect, it } from "vitest";

import {
  AGENT_RUNTIME_BACKENDS,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "../../shared/agent/agent-runtime-backend.js";
import {
  AnthropicModel,
  BasetenModel,
  DEFAULT_SESSION_START_MODEL_ID,
  extractSessionStartModelIdAnyBackend,
  extractSessionStartModelIdForBackend,
  getAgentRuntimeBackendForModel,
  getBackendsForModel,
  getDefaultSessionStartModelIdForBackend,
  getProviderForModel,
  getSessionStartModelIdsForBackend,
  isModelAllowedForBackend,
  isSessionStartModelAllowedForBackend,
  MODEL_REGISTRY,
  modelSupportsCodexToolSearch,
  OpenAIModel,
} from "../../shared/constants/models.js";

describe("Anthropic models in the registry", () => {
  it("exposes current Opus, Sonnet, and Fable tiers as bare claude_code-scoped ids", () => {
    expect(AnthropicModel.Opus48).toBe("claude-opus-4-8");
    expect(AnthropicModel.Sonnet46).toBe("claude-sonnet-4-6");
    expect(AnthropicModel.Sonnet5).toBe("claude-sonnet-5");
    expect(AnthropicModel.Fable5).toBe("claude-fable-5");

    for (const id of [AnthropicModel.Opus48, AnthropicModel.Sonnet46, AnthropicModel.Sonnet5, AnthropicModel.Fable5]) {
      const def = MODEL_REGISTRY.find((m) => m.id === id);
      expect(def, `${id} must be in MODEL_REGISTRY`).toBeDefined();
      expect(def?.provider).toBe("anthropic");
      expect(def?.backends).toEqual([CLAUDE_CODE_AGENT_RUNTIME_BACKEND]);
      expect(getProviderForModel(id)).toBe("anthropic");
    }
  });
});

describe("per-backend model scoping", () => {
  it("codex backend runs only OpenAI models, claude_code only Anthropic models", () => {
    expect(isModelAllowedForBackend(OpenAIModel.GPT55, CODEX_AGENT_RUNTIME_BACKEND)).toBe(true);
    expect(isModelAllowedForBackend(OpenAIModel.GPT55, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(false);

    expect(isModelAllowedForBackend(AnthropicModel.Opus48, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(true);
    expect(isModelAllowedForBackend(AnthropicModel.Opus48, CODEX_AGENT_RUNTIME_BACKEND)).toBe(false);
  });

  it("fails closed for unknown model ids", () => {
    expect(getBackendsForModel("nope-9-9")).toBeUndefined();
    expect(isModelAllowedForBackend("nope-9-9", CODEX_AGENT_RUNTIME_BACKEND)).toBe(false);
    expect(isModelAllowedForBackend("nope-9-9", CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(false);
  });
});

describe("session-start model selection per backend", () => {
  it("scopes the selectable session-start set by backend", () => {
    expect(getSessionStartModelIdsForBackend(CODEX_AGENT_RUNTIME_BACKEND)).toEqual([
      OpenAIModel.GPT54,
      OpenAIModel.GPT56,
      OpenAIModel.GPT56Sol,
      OpenAIModel.GPT56Terra,
      OpenAIModel.GPT56Luna,
      OpenAIModel.GPT55,
      OpenAIModel.GPT54Mini,
      OpenAIModel.GPT53CodexSpark,
    ]);
    expect(getSessionStartModelIdsForBackend(CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toEqual([
      AnthropicModel.Opus48,
      AnthropicModel.Sonnet46,
      AnthropicModel.Sonnet5,
      AnthropicModel.Fable5,
    ]);
    expect(getSessionStartModelIdsForBackend(OPENCODE_AGENT_RUNTIME_BACKEND)).toEqual([BasetenModel.KimiK27Code]);
  });

  it("defaults codex to GPT-5.4 and claude_code to Opus 4.8", () => {
    expect(getDefaultSessionStartModelIdForBackend(CODEX_AGENT_RUNTIME_BACKEND)).toBe(OpenAIModel.GPT54);
    expect(getDefaultSessionStartModelIdForBackend(CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(AnthropicModel.Opus48);
    expect(getDefaultSessionStartModelIdForBackend(OPENCODE_AGENT_RUNTIME_BACKEND)).toBe(BasetenModel.KimiK27Code);
  });

  it("derives every selectable and default model from MODEL_REGISTRY", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      const selectable = getSessionStartModelIdsForBackend(backend);
      expect(selectable.length, `${backend} must expose at least one session-start model`).toBeGreaterThan(0);

      const defaults = MODEL_REGISTRY.filter(
        (model) => model.sessionStart?.isDefault === true && model.backends.includes(backend),
      ).map((model) => model.id);
      expect(defaults, `${backend} must have exactly one default session-start model`).toEqual([
        getDefaultSessionStartModelIdForBackend(backend),
      ]);
      expect(selectable, `${backend} selectable models must include its default`).toContain(defaults[0]);
    }
  });

  it("keeps each backend scoped to a single model provider", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      const providers = new Set(
        MODEL_REGISTRY.filter((model) => model.backends.includes(backend)).map((model) => model.provider),
      );
      expect([...providers], `${backend} must map to one provider while provider is derived at spawn`).toHaveLength(1);
    }
  });

  it("allows a model only for its own backend", () => {
    expect(isSessionStartModelAllowedForBackend(OpenAIModel.GPT55, CODEX_AGENT_RUNTIME_BACKEND)).toBe(true);
    expect(isSessionStartModelAllowedForBackend(OpenAIModel.GPT54Mini, CODEX_AGENT_RUNTIME_BACKEND)).toBe(true);
    expect(isSessionStartModelAllowedForBackend(OpenAIModel.GPT54Nano, CODEX_AGENT_RUNTIME_BACKEND)).toBe(false);
    expect(isSessionStartModelAllowedForBackend(OpenAIModel.GPT55, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(false);
    expect(isSessionStartModelAllowedForBackend(AnthropicModel.Opus48, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(true);
    expect(isSessionStartModelAllowedForBackend(AnthropicModel.Opus48, CODEX_AGENT_RUNTIME_BACKEND)).toBe(false);
  });

  it("extracts a session-start model id only when allowed for the chosen backend", () => {
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.6-sol", CODEX_AGENT_RUNTIME_BACKEND)).toBe(
      OpenAIModel.GPT56Sol,
    );
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.5", CODEX_AGENT_RUNTIME_BACKEND)).toBe(OpenAIModel.GPT55);
    // Right model, wrong backend -> undefined (caller then rejects with 400).
    expect(extractSessionStartModelIdForBackend("openai/gpt-5.5", CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBeUndefined();

    expect(extractSessionStartModelIdForBackend("anthropic/claude-opus-4-8", CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe(
      AnthropicModel.Opus48,
    );
    expect(
      extractSessionStartModelIdForBackend("anthropic/claude-opus-4-8", CODEX_AGENT_RUNTIME_BACKEND),
    ).toBeUndefined();
  });
});

describe("any-backend session-start resolution", () => {
  it("accepts session-start models from every backend and rejects the rest", () => {
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.6")).toBe(OpenAIModel.GPT56);
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.6-sol")).toBe(OpenAIModel.GPT56Sol);
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.6-terra")).toBe(OpenAIModel.GPT56Terra);
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.6-luna")).toBe(OpenAIModel.GPT56Luna);
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.5")).toBe(OpenAIModel.GPT55);
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.4-mini")).toBe(OpenAIModel.GPT54Mini);
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.4-nano")).toBeUndefined();
    expect(extractSessionStartModelIdAnyBackend("openai/gpt-5.3-codex-spark")).toBe(OpenAIModel.GPT53CodexSpark);
    expect(extractSessionStartModelIdAnyBackend(AnthropicModel.Opus48)).toBe(AnthropicModel.Opus48);
    expect(extractSessionStartModelIdAnyBackend("anthropic/claude-sonnet-4-6")).toBe(AnthropicModel.Sonnet46);
    expect(extractSessionStartModelIdAnyBackend("anthropic/claude-sonnet-5")).toBe(AnthropicModel.Sonnet5);
    expect(extractSessionStartModelIdAnyBackend("anthropic/claude-fable-5")).toBe(AnthropicModel.Fable5);
    expect(extractSessionStartModelIdAnyBackend("nope-9-9")).toBeUndefined();
    expect(extractSessionStartModelIdAnyBackend(null)).toBeUndefined();
  });

  it("derives the agent runtime backend from a model id, fail-closed for unknown", () => {
    expect(getAgentRuntimeBackendForModel(OpenAIModel.GPT55)).toBe(CODEX_AGENT_RUNTIME_BACKEND);
    expect(getAgentRuntimeBackendForModel(AnthropicModel.Opus48)).toBe(CLAUDE_CODE_AGENT_RUNTIME_BACKEND);
    expect(getAgentRuntimeBackendForModel("nope-9-9")).toBeUndefined();
  });

  it("fails closed for Codex tool_search compatibility", () => {
    expect(modelSupportsCodexToolSearch(OpenAIModel.GPT54)).toBe(true);
    expect(modelSupportsCodexToolSearch(OpenAIModel.GPT54Mini)).toBe(true);
    expect(modelSupportsCodexToolSearch(OpenAIModel.GPT54Nano)).toBe(false);
    expect(modelSupportsCodexToolSearch("nope-9-9")).toBe(false);
  });
});

describe("bare default export stays codex-scoped", () => {
  it("keeps the default model on the codex backend", () => {
    expect(DEFAULT_SESSION_START_MODEL_ID).toBe(OpenAIModel.GPT54);
  });
});
