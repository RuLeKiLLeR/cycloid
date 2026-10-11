import { describe, expect, it } from "vitest";

import {
  getSessionVerificationRuntimeMode,
  getUseOpenAIFlexServiceTier,
  hasRestorableAgentSession,
  parseSessionConfig,
} from "../../apps/sandbox-bridge/src/utils/session-config.ts";

describe("session config helpers", () => {
  it("reads camelCase restore fields", () => {
    const config = {
      agentSessionId: "agent-session-existing",
      agentSessionAgent: "default",
      agentRuntimeBackend: "claude_code",
      verificationRuntimeMode: "none",
    };

    expect(getSessionVerificationRuntimeMode(config)).toBe("none");
    expect(hasRestorableAgentSession(config)).toBe(true);
  });

  it("reads snake_case restore fields as a fallback", () => {
    const config = {
      agent_session_id: "snake-agent-session",
      agent_session_agent: "build",
      agent_runtime_backend: "codex",
      verification_runtime_mode: "app_runtime",
    };

    expect(getSessionVerificationRuntimeMode(config)).toBe("app_runtime");
  });

  it("returns no restorable session when fields are absent", () => {
    expect(hasRestorableAgentSession({})).toBe(false);
  });

  it("returns an empty config for invalid JSON", () => {
    expect(parseSessionConfig("{not-json")).toEqual({});
  });

  it("treats only literal boolean true as OpenAI flex opt-in", () => {
    expect(getUseOpenAIFlexServiceTier({ useOpenAIFlexServiceTier: true })).toBe(true);
    expect(getUseOpenAIFlexServiceTier({ use_openai_flex_service_tier: true })).toBe(true);
    expect(getUseOpenAIFlexServiceTier({})).toBe(false);
    expect(getUseOpenAIFlexServiceTier({ useOpenAIFlexServiceTier: false })).toBe(false);
    expect(getUseOpenAIFlexServiceTier({ useOpenAIFlexServiceTier: "true" })).toBe(false);
    expect(getUseOpenAIFlexServiceTier({ useOpenAIFlexServiceTier: 1 })).toBe(false);
    expect(getUseOpenAIFlexServiceTier({ useOpenAIFlexServiceTier: "flex" })).toBe(false);
    expect(getUseOpenAIFlexServiceTier(parseSessionConfig("{not-json"))).toBe(false);
  });
});
