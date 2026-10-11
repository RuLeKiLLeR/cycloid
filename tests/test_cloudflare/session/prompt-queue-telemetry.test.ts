import { describe, expect, it } from "vitest";

import {
  buildPromptQueueWaitEvent,
  resolvePromptDispatchPath,
} from "../../../apps/control-plane-worker/src/session/prompt-queue";
import type { PromptState, SessionState } from "../../../apps/control-plane-worker/src/types";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "session-1",
    agentRuntimeBackend: "codex",
    ...overrides,
  } as SessionState;
}

function prompt(overrides: Partial<PromptState> = {}): Pick<PromptState, "promptId" | "createdAt"> {
  return {
    promptId: "p-1",
    createdAt: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("prompt queue wait telemetry helpers", () => {
  it("classifies dispatches as live, warm, or cold from the admit state", () => {
    expect(resolvePromptDispatchPath(true, { stopped: false, paused: false, expired: false, resumable: false })).toBe(
      "live",
    );
    expect(resolvePromptDispatchPath(false, { stopped: false, paused: true, expired: false, resumable: true })).toBe(
      "warm",
    );
    expect(resolvePromptDispatchPath(false, { stopped: true, paused: true, expired: true, resumable: true })).toBe(
      "cold",
    );
  });

  it("builds the direct-post payload with queue wait duration and tags", () => {
    expect(
      buildPromptQueueWaitEvent(
        session({ agentRuntimeBackend: "claude_code" }),
        prompt(),
        "cold",
        Date.UTC(2026, 3, 1, 12, 0, 30),
      ),
    ).toMatchObject({
      event: "prompt.queue_wait",
      sessionId: "session-1",
      promptId: "p-1",
      queue_wait_ms: 30_000,
      dispatch_path: "cold",
      agent_runtime_backend: "claude_code",
    });
  });

  it("returns null when the prompt createdAt timestamp is invalid", () => {
    expect(buildPromptQueueWaitEvent(session(), prompt({ createdAt: "not-a-date" }), "live", Date.now())).toBeNull();
  });
});
