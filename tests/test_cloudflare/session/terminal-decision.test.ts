import { describe, expect, it } from "vitest";

import { decideTerminalEvent } from "../../../apps/control-plane-worker/src/session/lifecycle/terminal-decision.ts";

describe("terminal-decision", () => {
  it("completes the active prompt when the event belongs to the current generation", () => {
    expect(
      decideTerminalEvent({
        promptId: "prompt-1",
        activePromptId: "prompt-1",
        currentConnectionGeneration: 3,
        eventConnectionGeneration: 3,
      }),
    ).toEqual({ action: "complete-active", promptId: "prompt-1" });
  });

  it("ignores late completions for user-stopped prompts", () => {
    expect(
      decideTerminalEvent({
        promptId: "prompt-1",
        activePromptId: null,
        currentConnectionGeneration: 3,
        eventConnectionGeneration: 3,
        promptStoppedBy: "user",
      }),
    ).toEqual({ action: "ack-ignore-user-stopped", promptId: "prompt-1" });
  });

  it("does not complete an active prompt after the user has already stopped it", () => {
    expect(
      decideTerminalEvent({
        promptId: "prompt-1",
        activePromptId: "prompt-1",
        currentConnectionGeneration: 3,
        eventConnectionGeneration: 3,
        promptStoppedBy: "user",
      }),
    ).toEqual({ action: "ack-ignore-user-stopped", promptId: "prompt-1" });
  });

  it("treats older-generation completions for superseded prompts as ignorable", () => {
    expect(
      decideTerminalEvent({
        promptId: "prompt-1",
        activePromptId: "prompt-2",
        currentConnectionGeneration: 4,
        eventConnectionGeneration: 3,
      }),
    ).toEqual({
      action: "ack-ignore-superseded",
      promptId: "prompt-1",
      activePromptId: "prompt-2",
    });
  });

  it("falls back to stale prompt_runs when the marker has already been cleared", () => {
    expect(
      decideTerminalEvent({
        promptId: "prompt-1",
        activePromptId: null,
        currentConnectionGeneration: null,
        eventConnectionGeneration: null,
        promptRun: {
          outcome: "failed",
          errorCode: "stale_prompt",
        },
      }),
    ).toEqual({
      action: "recover-stale",
      promptId: "prompt-1",
      staleReason: "stale_prompt",
    });
  });

  it("does not recover failed prompts whose stored error code was not stale_prompt", () => {
    expect(
      decideTerminalEvent({
        promptId: "prompt-1",
        activePromptId: null,
        currentConnectionGeneration: null,
        eventConnectionGeneration: null,
        promptRun: {
          outcome: "failed",
          errorCode: "sandbox_disconnected",
        },
      }),
    ).toEqual({
      action: "ignore-unknown-prompt",
      promptId: "prompt-1",
    });
  });
});
