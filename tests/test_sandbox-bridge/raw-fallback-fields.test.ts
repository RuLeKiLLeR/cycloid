import { describe, expect, it } from "vitest";

import { buildRawFallbackLogFields } from "../../apps/sandbox-bridge/src/services/event-translator.js";

describe("buildRawFallbackLogFields", () => {
  it("scopes codex fallbacks to codex.* fields", () => {
    const runtime = { backend: "codex", rawFallbackPrefix: "codex" } as const;
    expect(buildRawFallbackLogFields(runtime, "p-1", { eventType: "weird.event", partType: "weird-part" })).toEqual({
      event: "codex.raw_fallback",
      prompt_id: "p-1",
      agent_runtime_backend: "codex",
      codex_event_type: "weird.event",
      codex_part_type: "weird-part",
    });
  });

  it("scopes claude_code fallbacks to claude.* fields (never counted as codex drift)", () => {
    const runtime = { backend: "claude_code", rawFallbackPrefix: "claude" } as const;
    expect(buildRawFallbackLogFields(runtime, "p-2", { eventType: "system.new_subtype" })).toEqual({
      event: "claude.raw_fallback",
      prompt_id: "p-2",
      agent_runtime_backend: "claude_code",
      claude_event_type: "system.new_subtype",
    });
  });

  it("omits absent kind fields", () => {
    const runtime = { backend: "claude_code", rawFallbackPrefix: "claude" } as const;
    expect(buildRawFallbackLogFields(runtime, "p-3", { partType: "assistant.new_block" })).toEqual({
      event: "claude.raw_fallback",
      prompt_id: "p-3",
      agent_runtime_backend: "claude_code",
      claude_part_type: "assistant.new_block",
    });
  });

  it("scopes opencode fallbacks to opencode.* fields", () => {
    const runtime = { backend: "opencode", rawFallbackPrefix: "opencode" } as const;
    expect(buildRawFallbackLogFields(runtime, "p-4", { eventType: "message.new", partType: "part.new" })).toEqual({
      event: "opencode.raw_fallback",
      prompt_id: "p-4",
      agent_runtime_backend: "opencode",
      opencode_event_type: "message.new",
      opencode_part_type: "part.new",
    });
  });
});
