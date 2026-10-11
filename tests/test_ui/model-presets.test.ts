import { describe, expect, it } from "vitest";

import type { Provider } from "../../apps/ui/src/types";
import {
  buildModelOptions,
  findModelOption,
  getDefaultReasoningEffortForModel,
  getReasoningEffortsForModel,
} from "../../apps/ui/src/utils/models";

describe("model options", () => {
  it("builds one option per model grouped by harness", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            label: "OpenAI / GPT-5.5",
            backends: ["codex"],
            reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
          },
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            label: "OpenAI / GPT-5.4",
            backends: ["codex"],
            reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"] },
          },
        ],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            label: "Anthropic / Claude Opus 4.8",
            backends: ["claude_code"],
          },
        ],
      },
      {
        id: "baseten",
        name: "Baseten",
        models: [
          {
            id: "kimi-k2.7-code",
            name: "Kimi-K2.7-Code",
            label: "Baseten / Kimi-K2.7-Code",
            backends: ["opencode"],
          },
        ],
      },
    ];

    // Codex group is sorted within-group by name, so GPT-5.4 precedes GPT-5.5
    // even though the provider lists them in the reverse (registry) order.
    expect(buildModelOptions(providers)).toEqual([
      {
        id: "openai:gpt-5.4",
        label: "GPT-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        disabled: false,
        disabledReason: undefined,
        groupLabel: "Codex",
      },
      {
        id: "openai:gpt-5.5",
        label: "GPT-5.5",
        providerID: "openai",
        modelID: "gpt-5.5",
        disabled: false,
        disabledReason: undefined,
        groupLabel: "Codex",
      },
      {
        id: "anthropic:claude-opus-4-8",
        label: "Claude Opus 4.8",
        providerID: "anthropic",
        modelID: "claude-opus-4-8",
        disabled: false,
        disabledReason: undefined,
        groupLabel: "Claude Code",
      },
      {
        id: "baseten:kimi-k2.7-code",
        label: "Kimi-K2.7-Code",
        providerID: "baseten",
        modelID: "kimi-k2.7-code",
        disabled: false,
        disabledReason: undefined,
        groupLabel: "opencode",
      },
    ]);
  });

  it("falls back to provider name when a model has no backend", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-5.4", name: "GPT-5.4", label: "OpenAI / GPT-5.4", backends: [] }],
      },
    ];

    expect(buildModelOptions(providers)[0]?.groupLabel).toBe("OpenAI");
  });

  it("disables every model option for providers without an API key", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        hasApiKey: false,
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            label: "OpenAI / GPT-5.5",
            reasoning: { efforts: ["medium", "high"], default: "medium" },
            backends: ["codex"],
          },
        ],
      },
    ];

    expect(buildModelOptions(providers)).toEqual([
      expect.objectContaining({
        id: "openai:gpt-5.5",
        disabled: true,
        disabledReason: "API key required",
      }),
    ]);
  });

  it("resolves selected model efforts by provider and model id", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "shared-model",
            name: "OpenAI Shared",
            label: "OpenAI / Shared",
            reasoning: { efforts: ["none", "low", "high", "xhigh"], default: "low" },
          },
        ],
      },
      {
        id: "baseten",
        name: "Baseten",
        models: [
          {
            id: "shared-model",
            name: "Baseten Shared",
            label: "Baseten / Shared",
          },
          {
            id: "kimi-k2.7-code",
            name: "Kimi-K2.7-Code",
            label: "Baseten / Kimi-K2.7-Code",
          },
        ],
      },
    ];

    expect(findModelOption(providers, { providerID: "baseten", modelID: "shared-model" })?.name).toBe("Baseten Shared");
    expect(getReasoningEffortsForModel(providers, { providerID: "openai", modelID: "shared-model" })).toEqual([
      "xhigh",
      "high",
      "low",
    ]);
    expect(getReasoningEffortsForModel(providers, { providerID: "baseten", modelID: "kimi-k2.7-code" })).toEqual([]);
  });

  it("derives a selectable default reasoning effort for selected models", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "undefined-default",
            name: "Undefined Default",
            label: "OpenAI / Undefined Default",
            reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
          },
          {
            id: "none-default",
            name: "None Default",
            label: "OpenAI / None Default",
            reasoning: { efforts: ["none", "low", "medium"], default: "none" },
          },
          {
            id: "none-only",
            name: "None Only",
            label: "OpenAI / None Only",
            reasoning: { efforts: ["none"], default: "none" },
          },
        ],
      },
    ];

    expect(getDefaultReasoningEffortForModel(providers, { providerID: "openai", modelID: "undefined-default" })).toBe(
      "high",
    );
    expect(getDefaultReasoningEffortForModel(providers, { providerID: "openai", modelID: "none-default" })).toBe(
      "medium",
    );
    expect(getDefaultReasoningEffortForModel(providers, { providerID: "openai", modelID: "none-only" })).toBe(
      undefined,
    );
  });
});
