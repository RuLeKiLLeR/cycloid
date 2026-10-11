import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
  inferenceProviderForBackend,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "../../shared/agent/agent-runtime-backend.js";

describe("inferenceProviderForBackend", () => {
  it("maps each known backend to its inference provider", () => {
    expect(inferenceProviderForBackend(OPENCODE_AGENT_RUNTIME_BACKEND)).toBe("baseten");
    expect(inferenceProviderForBackend(CODEX_AGENT_RUNTIME_BACKEND)).toBe("openai");
    expect(inferenceProviderForBackend(CLAUDE_CODE_AGENT_RUNTIME_BACKEND)).toBe("anthropic");
  });

  it("returns null for unset backends", () => {
    expect(inferenceProviderForBackend(null)).toBeNull();
    expect(inferenceProviderForBackend(undefined)).toBeNull();
  });

  it("returns null for an unrecognized backend value", () => {
    // Types forbid this, but a stale persisted column could surface an unknown string; the
    // telemetry path must degrade to a null provider tag rather than throw.
    expect(inferenceProviderForBackend("gemini" as never)).toBeNull();
  });
});
