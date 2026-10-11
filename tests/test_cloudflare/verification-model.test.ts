import { describe, expect, it } from "vitest";

import {
  resolveBaseModelForAutomaticRouting,
  resolvePrReviewModel,
  resolveVerificationModel,
} from "../../apps/control-plane-worker/src/services/session-model-routing";
import {
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
} from "../../shared/agent/agent-runtime-backend";
import { AnthropicModel, BasetenModel, OpenAIModel } from "../../shared/constants/models";

describe("resolveBaseModelForAutomaticRouting", () => {
  it("uses session-start eligible Codex models", () => {
    expect(resolveBaseModelForAutomaticRouting(OpenAIModel.GPT54Mini)).toEqual({
      currentModel: OpenAIModel.GPT54Mini,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("uses session-start eligible Claude models", () => {
    expect(resolveBaseModelForAutomaticRouting(AnthropicModel.Opus48)).toEqual({
      currentModel: AnthropicModel.Opus48,
      agentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back for stale Nano automation pins", () => {
    expect(resolveBaseModelForAutomaticRouting(OpenAIModel.GPT54Nano)).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back for provider-prefixed stale Nano automation pins", () => {
    expect(resolveBaseModelForAutomaticRouting(`openai:${OpenAIModel.GPT54Nano}`)).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("normalizes retired Baseten automation pins to Kimi", () => {
    expect(resolveBaseModelForAutomaticRouting("glm-4.7")).toEqual({
      currentModel: BasetenModel.KimiK27Code,
      agentRuntimeBackend: "opencode",
    });
  });
});

describe("resolvePrReviewModel", () => {
  it("routes a Claude Code author to the Codex default", () => {
    expect(
      resolvePrReviewModel(
        { authorModel: AnthropicModel.Opus48, authorAgentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND },
        { anthropicAvailable: true },
      ),
    ).toEqual({ currentModel: OpenAIModel.GPT54, agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND });
  });

  it("routes a credentialed Codex author to the Claude default", () => {
    expect(
      resolvePrReviewModel(
        { authorModel: OpenAIModel.GPT54, authorAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND },
        { anthropicAvailable: true },
      ),
    ).toEqual({ currentModel: AnthropicModel.Opus48, agentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND });
  });

  it("falls back to Codex when Claude credentials are unavailable", () => {
    expect(
      resolvePrReviewModel(
        { authorModel: OpenAIModel.GPT54, authorAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND },
        { anthropicAvailable: false },
      ),
    ).toEqual({ currentModel: OpenAIModel.GPT54, agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND });
  });

  it.each([
    { authorModel: null, authorAgentRuntimeBackend: null },
    { authorModel: "unknown-model", authorAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND },
    { authorModel: BasetenModel.KimiK27Code, authorAgentRuntimeBackend: "opencode" as const },
  ])("uses Codex for an unknown or non-Codex/Claude author: $authorModel", (author) => {
    expect(resolvePrReviewModel(author, { anthropicAvailable: true })).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });
});

describe("resolveVerificationModel", () => {
  it("verifies a codex parent on its own model", () => {
    expect(
      resolveVerificationModel({
        parentModel: OpenAIModel.GPT55,
        parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: OpenAIModel.GPT55,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("verifies a GPT-5.6 codex parent on its own model", () => {
    expect(
      resolveVerificationModel({
        parentModel: OpenAIModel.GPT56Sol,
        parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: OpenAIModel.GPT56Sol,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("keeps a codex mid parent on gpt-5.4/codex", () => {
    expect(
      resolveVerificationModel({
        parentModel: OpenAIModel.GPT54,
        parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back for a codex nano parent because Codex tool_search is incompatible", () => {
    expect(
      resolveVerificationModel({
        parentModel: OpenAIModel.GPT54Nano,
        parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("verifies a claude_code frontier parent on its own backend/model", () => {
    expect(
      resolveVerificationModel({
        parentModel: AnthropicModel.Opus48,
        parentAgentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: AnthropicModel.Opus48,
      agentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
    });
  });

  it("verifies a claude_code mid parent on its own backend/model", () => {
    expect(
      resolveVerificationModel({
        parentModel: AnthropicModel.Sonnet46,
        parentAgentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: AnthropicModel.Sonnet46,
      agentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back to the codex default when the parent model is null or absent", () => {
    expect(resolveVerificationModel({ parentModel: null, parentAgentRuntimeBackend: null })).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
    expect(resolveVerificationModel({ parentModel: undefined, parentAgentRuntimeBackend: undefined })).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back when the parent model is not a known session-start model", () => {
    expect(
      resolveVerificationModel({
        parentModel: "gpt-4.0-legacy",
        parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back when the parent backend is missing instead of deriving from model", () => {
    expect(resolveVerificationModel({ parentModel: AnthropicModel.Opus48, parentAgentRuntimeBackend: null })).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back when the parent model/backend pair is invalid", () => {
    expect(
      resolveVerificationModel({
        parentModel: AnthropicModel.Opus48,
        parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
      }),
    ).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("falls back to the user default model (deriving its backend) when there is no parent pair", () => {
    expect(
      resolveVerificationModel({ parentModel: null, parentAgentRuntimeBackend: null }, AnthropicModel.Opus48),
    ).toEqual({
      currentModel: AnthropicModel.Opus48,
      agentRuntimeBackend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
    });
  });

  it("normalizes retired Baseten user defaults and parent models to Kimi", () => {
    expect(
      resolveVerificationModel({ parentModel: "gpt-oss-120b", parentAgentRuntimeBackend: "opencode" }, "glm-4.7"),
    ).toEqual({
      currentModel: BasetenModel.KimiK27Code,
      agentRuntimeBackend: "opencode",
    });
  });

  it("falls back to the codex default when the user default model is null or unknown", () => {
    expect(resolveVerificationModel({ parentModel: null, parentAgentRuntimeBackend: null }, null)).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
    expect(resolveVerificationModel({ parentModel: null, parentAgentRuntimeBackend: null }, "gpt-4.0-legacy")).toEqual({
      currentModel: OpenAIModel.GPT54,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });

  it("keeps the valid parent pair even when a user default model is supplied", () => {
    expect(
      resolveVerificationModel(
        { parentModel: OpenAIModel.GPT55, parentAgentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND },
        AnthropicModel.Opus48,
      ),
    ).toEqual({
      currentModel: OpenAIModel.GPT55,
      agentRuntimeBackend: CODEX_AGENT_RUNTIME_BACKEND,
    });
  });
});
