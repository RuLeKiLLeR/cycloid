// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.js";

describe("PromptLoopState", () => {
  it("initializes with default values", () => {
    const state = new PromptLoopState();
    expect(state.toolCallCount).toBe(0);
    expect(state.idle).toBe(false);
    expect(state.textEmittedLengths.size).toBe(0);
    expect(state.contextFillWarningEmitted).toBe(false);
    expect(state.activeCompactionMessageId).toBeNull();
    expect(state.handledAutomaticallyViolation).toBe(false);
    expect(state.editCount).toBe(0);
    expect(state.lastContextFillPercent).toBe(0);
    expect(state.questionCount).toBe(0);
    expect(state.referencedExternalState).toBe(false);
    expect(state.usedVerificationTools).toBe(false);
    expect(state.ranFunctionalCheck).toBe(false);
    expect(state.malformedSearchCommandCount).toBe(0);
    expect(state.grepSearchCommandCount).toBe(0);
    expect(state.ripgrepSearchCommandCount).toBe(0);
    expect(state.toolFailureCountsByPhase).toEqual({ auth: 0, provider: 0, policy: 0, wrapper: 0, command: 0 });
    expect(state.toolCounts.size).toBe(0);
    expect(state.seenPartIds.size).toBe(0);
    expect(state.emittedToolParts.size).toBe(0);
    expect(state.emittedToolStatuses.size).toBe(0);
    expect(state.responseTextByPartId.size).toBe(0);
    expect(state.textAliases.size).toBe(0);
    expect(state.messageRoles.size).toBe(0);
    expect(state.toolStartTimes.size).toBe(0);
    expect(state.textEmittedLengths.size).toBe(0);
  });

  it("sets ranFunctionalCheck when a recognized check command runs", () => {
    const state = new PromptLoopState();

    state.recordCommandExecution({ command: "npm test", status: "completed", hasOutput: true });

    expect(state.ranFunctionalCheck).toBe(true);
  });

  it("does not set ranFunctionalCheck for exploratory commands", () => {
    const state = new PromptLoopState();

    state.recordCommandExecution({ command: "rg TODO .", status: "completed", hasOutput: true });

    expect(state.ranFunctionalCheck).toBe(false);
  });

  it("records executed search command counts from completed and error commands", () => {
    const state = new PromptLoopState();

    state.recordCommandExecution({ command: "rg TODO .", status: "completed", hasOutput: true });
    state.recordCommandExecution({ command: "grep -r TODO .", status: "error", hasOutput: false });
    state.recordCommandExecution({ command: "rg --files | grep spec", status: "completed", hasOutput: true });

    expect(state.grepSearchCommandCount).toBe(1);
    expect(state.ripgrepSearchCommandCount).toBe(2);
  });

  describe("updateTextDelta", () => {
    it("returns full text on first call for a part", () => {
      const state = new PromptLoopState();
      const delta = state.updateTextDelta("part-1", "hello world");
      expect(delta).toBe("hello world");
    });

    it("returns only the new delta on subsequent calls", () => {
      const state = new PromptLoopState();
      state.updateTextDelta("part-1", "hello");
      const delta = state.updateTextDelta("part-1", "hello world");
      expect(delta).toBe(" world");
    });

    it("returns null when no new text", () => {
      const state = new PromptLoopState();
      state.updateTextDelta("part-1", "hello");
      const delta = state.updateTextDelta("part-1", "hello");
      expect(delta).toBeNull();
    });

    it("restarts the cumulative cursor when a stream resets", () => {
      const state = new PromptLoopState();
      const chunks = [
        "The",
        " tests",
        " are",
        " passing",
        ".",
        " I",
        "’m",
        " on",
        " the",
        " last",
        " required",
        " check",
        " now",
        ":",
        " the",
        " CLI",
        " package",
        " type",
        "check",
        ",",
        " which",
        " is",
        " the",
        " best",
        " narrow",
        " compile",
        " gate",
        " for",
        " the",
        " files",
        " touched",
        " in",
        " `",
        "apps",
        "/",
        "cli",
        "`.",
      ];

      state.updateTrackedDelta("text-part", "prior response.");
      const emitted = chunks.map((chunk, index) =>
        state.updateTrackedDelta("text-part", chunks.slice(0, index + 1).join("")),
      );

      expect(emitted.filter((delta): delta is string => delta !== null).join("")).toBe(chunks.join(""));
    });

    it("restarts the reasoning cursor when a stream resets", () => {
      const state = new PromptLoopState();

      state.updateTrackedDelta("reasoning-part", "prior reasoning.");
      expect(state.updateTrackedDelta("reasoning-part", "The model reconsidered.")).toBe("The model reconsidered.");
    });

    it("resets the cursor after an empty cumulative snapshot", () => {
      const state = new PromptLoopState();

      state.updateTrackedDelta("text-part", "prior response.");
      expect(state.updateTrackedDelta("text-part", "")).toBeNull();
      expect(state.updateTrackedDelta("text-part", "The tests are passing.")).toBe("The tests are passing.");
    });

    it("ignores a shorter non-prefix replay through an aliased part id", () => {
      const state = new PromptLoopState();

      expect(state.updateTextDelta("part-1", "The tests are passing.")).toBe("The tests are passing.");
      expect(state.updateTextDelta("part-2", "The tests are passing.")).toBeNull();
      expect(state.updateTextDelta("part-2", "stale replay")).toBeNull();
      expect(state.updateTextDelta("part-2", "The tests are passing. More.")).toBe(" More.");
    });

    it("tracks multiple parts independently (no reset on switch)", () => {
      const state = new PromptLoopState();
      state.updateTextDelta("part-1", "first part text");
      state.updateTextDelta("part-2", "second");
      // Switching back to part-1 should NOT re-emit already-sent text
      const delta = state.updateTextDelta("part-1", "first part text");
      expect(delta).toBeNull();
    });

    it("does not duplicate text on SSE reconnect with interleaved parts", () => {
      const state = new PromptLoopState();
      // First connection: stream text for part-1 and part-2
      state.updateTextDelta("part-1", "Hello world.");
      state.updateTextDelta("part-2", "Tool output here.");

      // SSE reconnects and replays events for both parts
      const replayDelta1 = state.updateTextDelta("part-1", "Hello world.");
      const replayDelta2 = state.updateTextDelta("part-2", "Tool output here.");
      expect(replayDelta1).toBeNull(); // already emitted
      expect(replayDelta2).toBeNull(); // already emitted

      // New text after reconnect is correctly emitted
      const newDelta = state.updateTextDelta("part-1", "Hello world. More text.");
      expect(newDelta).toBe(" More text.");
    });

    it("aliases replayed text from a new part ID back to the original part", () => {
      const state = new PromptLoopState();

      expect(state.updateTextDelta("part-1", "Hello world.")).toBe("Hello world.");
      expect(state.updateTextDelta("part-2", "Hello world.")).toBeNull();
      expect(state.textAliases.get("part-2")).toBe("part-1");
      expect([...state.responseTextByPartId.entries()]).toEqual([["part-1", "Hello world."]]);

      const delta = state.updateTextDelta("part-2", "Hello world. More text.");
      expect(delta).toBe(" More text.");
      expect([...state.responseTextByPartId.entries()]).toEqual([["part-1", "Hello world. More text."]]);
    });

    it("returns the latest assistant text part as the final response text", () => {
      const state = new PromptLoopState();

      state.updateTextDelta("part-1", "First progress update.");
      state.updateTextDelta("part-2", "Final agent message.");
      state.updateTextDelta("part-2", "Final agent message with verification.");

      expect(state.latestResponseText()).toBe("Final agent message with verification.");
    });

    it("returns all text blocks from the latest message when message ids are known", () => {
      const state = new PromptLoopState();

      state.updateTextDelta("msg-a:text:0", "Initial progress.", "msg-a");
      state.updateTextDelta("msg-b:text:0", "Final block one.", "msg-b");
      state.updateTextDelta("msg-b:text:1", "Final block two.", "msg-b");

      expect(state.latestResponseText()).toBe("Final block two.");
      expect(state.latestMessageResponseText()).toBe("Final block one.\n\nFinal block two.");
    });

    it("groups no-message-id text blocks from the latest segment", () => {
      const state = new PromptLoopState();

      state.updateTextDelta("part-1", "Final block one.");
      state.updateTextDelta("part-2", "Final block two.");

      expect(state.latestResponseText()).toBe("Final block two.");
      expect(state.latestMessageResponseText()).toBe("Final block one.\n\nFinal block two.");
    });

    it("does not group no-message-id text across a tool boundary", () => {
      const state = new PromptLoopState();

      state.updateTextDelta("part-1", "Before tool.");
      state.startNewTextSegment();
      state.updateTextDelta("part-2", "After tool one.");
      state.updateTextDelta("part-3", "After tool two.");

      expect(state.latestResponseText()).toBe("After tool two.");
      expect(state.latestMessageResponseText()).toBe("After tool one.\n\nAfter tool two.");
    });

    it("does not group same-message text across a tool boundary", () => {
      const state = new PromptLoopState();

      state.updateTextDelta("msg-a:text:0", "Before tool.", "msg-a");
      state.startNewTextSegment();
      state.updateTextDelta("msg-a:text:1", "Final block one.", "msg-a");
      state.updateTextDelta("msg-a:text:2", "Final block two.", "msg-a");

      expect(state.latestResponseText()).toBe("Final block two.");
      expect(state.latestMessageResponseText()).toBe("Final block one.\n\nFinal block two.");
    });
  });

  describe("updateTrackedDelta", () => {
    it("returns full text on first call for a key", () => {
      const state = new PromptLoopState();
      const delta = state.updateTrackedDelta("child-text-1", "hello");
      expect(delta).toBe("hello");
    });

    it("returns only the delta on subsequent calls", () => {
      const state = new PromptLoopState();
      state.updateTrackedDelta("reasoning-1", "think");
      const delta = state.updateTrackedDelta("reasoning-1", "thinking harder");
      expect(delta).toBe("ing harder");
    });

    it("returns null when no new content", () => {
      const state = new PromptLoopState();
      state.updateTrackedDelta("key-1", "same");
      expect(state.updateTrackedDelta("key-1", "same")).toBeNull();
    });

    it("tracks multiple keys independently", () => {
      const state = new PromptLoopState();
      state.updateTrackedDelta("key-a", "aaa");
      state.updateTrackedDelta("key-b", "bbb");
      expect(state.updateTrackedDelta("key-a", "aaa111")).toBe("111");
      expect(state.updateTrackedDelta("key-b", "bbb222")).toBe("222");
    });
  });

  describe("recordBehavioralSignals", () => {
    it("increments editCount for apply_patch", () => {
      const state = new PromptLoopState();
      state.recordBehavioralSignals("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: /a.ts",
          "@@",
          "-old",
          "+new",
          "*** Update File: /b.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      });
      expect(state.editCount).toBe(1);
    });

    it("does not increment editCount for bash", () => {
      const state = new PromptLoopState();
      state.recordBehavioralSignals("bash", { command: "ls" });
      expect(state.editCount).toBe(0);
    });
  });

  describe("checkExternalStateReferences", () => {
    it("detects PR/issue number patterns", () => {
      const state = new PromptLoopState();
      state.checkExternalStateReferences("Fixed #123 issue");
      expect(state.referencedExternalState).toBe(true);
    });

    it("detects GitHub PR URLs", () => {
      const state = new PromptLoopState();
      state.checkExternalStateReferences("See https://github.com/org/repo/pull/42");
      expect(state.referencedExternalState).toBe(true);
    });

    it("detects GitHub issue URLs", () => {
      const state = new PromptLoopState();
      state.checkExternalStateReferences("See https://github.com/org/repo/issues/7");
      expect(state.referencedExternalState).toBe(true);
    });

    it("does not flag plain text", () => {
      const state = new PromptLoopState();
      state.checkExternalStateReferences("No external references here");
      expect(state.referencedExternalState).toBe(false);
    });

    it("is a no-op once flag is set", () => {
      const state = new PromptLoopState();
      state.referencedExternalState = true;
      state.checkExternalStateReferences("No refs");
      expect(state.referencedExternalState).toBe(true);
    });
  });

  describe("handled-automatically tracking", () => {
    it("sets the handled-automatically prompt signal", () => {
      const state = new PromptLoopState();

      state.recordHandledAutomaticallyViolation();
      expect(state.handledAutomaticallyViolation).toBe(true);

      state.recordHandledAutomaticallyViolation();
      expect(state.handledAutomaticallyViolation).toBe(true);
    });
  });

  describe("malformed-search tracking", () => {
    it("accumulates malformed search command blocks", () => {
      const state = new PromptLoopState();

      state.recordMalformedSearchCommandViolation();
      state.recordMalformedSearchCommandViolation(2);

      expect(state.malformedSearchCommandCount).toBe(3);
    });
  });

  describe("toBehaviorSignals", () => {
    it("builds correct signals from default state", () => {
      const state = new PromptLoopState();
      const signals = state.toBehaviorSignals();
      expect(signals).toEqual({
        toolCallCount: 0,
        handledAutomaticallyViolation: false,
        contextFillPercent: 0,
        editCount: 0,
        questionCount: 0,
        referencedExternalState: false,
        usedVerificationTools: false,
        ranFunctionalCheck: false,
        malformedSearchCommandCount: 0,
        grepSearchCommandCount: 0,
        ripgrepSearchCommandCount: 0,
        structuralInjectionCommentHitCount: 0,
        structuralInjectionZeroWidthHitCount: 0,
        toolFailureCountsByPhase: { auth: 0, provider: 0, policy: 0, wrapper: 0, command: 0 },
      });
    });

    it("reflects accumulated state", () => {
      const state = new PromptLoopState();
      state.toolCallCount = 10;
      state.handledAutomaticallyViolation = true;
      state.lastContextFillPercent = 0.75;
      state.editCount = 2;
      state.questionCount = 1;
      state.referencedExternalState = true;
      state.usedVerificationTools = true;
      state.ranFunctionalCheck = true;
      state.malformedSearchCommandCount = 3;
      state.grepSearchCommandCount = 4;
      state.ripgrepSearchCommandCount = 5;
      state.recordToolFailure("auth");
      state.recordToolFailure("provider");
      state.recordToolFailure("provider");

      const signals = state.toBehaviorSignals();
      expect(signals.toolCallCount).toBe(10);
      expect(signals.handledAutomaticallyViolation).toBe(true);
      expect(signals.contextFillPercent).toBe(0.75);
      expect(signals.editCount).toBe(2);
      expect(signals.questionCount).toBe(1);
      expect(signals.referencedExternalState).toBe(true);
      expect(signals.usedVerificationTools).toBe(true);
      expect(signals.ranFunctionalCheck).toBe(true);
      expect(signals.malformedSearchCommandCount).toBe(3);
      expect(signals.grepSearchCommandCount).toBe(4);
      expect(signals.ripgrepSearchCommandCount).toBe(5);
      expect(signals.structuralInjectionCommentHitCount).toBe(0);
      expect(signals.structuralInjectionZeroWidthHitCount).toBe(0);
      expect(signals.toolFailureCountsByPhase).toEqual({ auth: 1, provider: 2, policy: 0, wrapper: 0, command: 0 });
    });
  });
});
