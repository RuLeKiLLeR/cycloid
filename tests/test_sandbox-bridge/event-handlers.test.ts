// @ts-nocheck — sandbox-bridge is excluded from root tsconfig

import { describe, expect, it } from "vitest";

import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.js";
import { emitReasoningDelta, emitTextDelta } from "../../apps/sandbox-bridge/src/utils/event-handlers.js";

// ---------------------------------------------------------------------------
// emitTextDelta
// ---------------------------------------------------------------------------

describe("emitTextDelta", () => {
  const SESSION_ID = "sess-1";
  const MSG_ID = "msg-assistant-1";

  function assistantLoopState(): PromptLoopState {
    const s = new PromptLoopState();
    s.recordMessageRole(MSG_ID, "assistant");
    return s;
  }

  it("returns delta for valid parent-session non-synthetic assistant text", () => {
    const loopState = assistantLoopState();
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBe("hello");
  });

  it("returns incremental delta on subsequent calls", () => {
    const loopState = assistantLoopState();
    emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello world", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBe(" world");
  });

  it("returns null for synthetic parts", () => {
    const delta = emitTextDelta({
      part: { type: "text", synthetic: true, sessionID: SESSION_ID, text: "synth", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null for wrong session ID", () => {
    const delta = emitTextDelta({
      part: { type: "text", sessionID: "other", text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null for non-string part.id", () => {
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: 123, messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null for undefined part.id", () => {
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null when no new content (idempotent)", () => {
    const loopState = assistantLoopState();
    emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
  });

  it("returns null for non-text part types", () => {
    const delta = emitTextDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  // ── ARC-761: role gating ──

  it("drops parts whose owning message is a user message", () => {
    const loopState = new PromptLoopState();
    loopState.recordMessageRole("msg-user-1", "user");
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "Repository: foo/bar", id: "part-u", messageID: "msg-user-1" },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
  });

  it("drops parts when message role has not been recorded yet", () => {
    const loopState = new PromptLoopState();
    loopState.recordMessageRole("msg-user-1", "user");
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: "unknown-msg" },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
  });

  it("drops parts with no messageID", () => {
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1" },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  // Regression for the Bandit Heeler case (session 771046af). Codex emits
  // both the user prompt (as a text part on the user message) and the
  // assistant reply (as a text part on the assistant message) on the same
  // session. The bridge must drop the user-prompt part and keep the reply.
  it("ARC-761 regression: drops user-prompt echo, keeps assistant reply", () => {
    const loopState = new PromptLoopState();
    // message.updated for the user message arrives first
    loopState.recordMessageRole("msg-user-1", "user");
    // then a message.part.updated for the user prompt (should be dropped)
    const userEcho = emitTextDelta({
      part: {
        type: "text",
        sessionID: SESSION_ID,
        text: "Repository: trycycloid/cycloid\n\nDo you know who this is?",
        id: "prt_user",
        messageID: "msg-user-1",
      },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(userEcho).toBeNull();

    // message.updated for the assistant message arrives
    loopState.recordMessageRole("msg-assistant-1", "assistant");
    // then the assistant text part streams (should be forwarded)
    const reply = emitTextDelta({
      part: {
        type: "text",
        sessionID: SESSION_ID,
        text: "That's Bandit Heeler, the dad from Bluey.",
        id: "prt_assistant",
        messageID: "msg-assistant-1",
      },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(reply).toBe("That's Bandit Heeler, the dad from Bluey.");
  });
});

// ---------------------------------------------------------------------------
// emitReasoningDelta
// ---------------------------------------------------------------------------

describe("emitReasoningDelta", () => {
  const SESSION_ID = "sess-1";
  const MSG_ID = "msg-assistant-1";

  function assistantLoopState(): PromptLoopState {
    const s = new PromptLoopState();
    s.recordMessageRole(MSG_ID, "assistant");
    return s;
  }

  it("returns delta for valid reasoning part", () => {
    const loopState = assistantLoopState();
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking...", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBe("thinking...");
  });

  it("returns incremental delta on subsequent calls", () => {
    const loopState = assistantLoopState();
    emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "think", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking more", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBe("ing more");
  });

  it("returns null for non-string part.id", () => {
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking", id: 42, messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null for wrong session ID", () => {
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: "other", text: "thinking", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null for non-reasoning part types", () => {
    const delta = emitReasoningDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState: assistantLoopState(),
    });
    expect(delta).toBeNull();
  });

  it("returns null when no new content", () => {
    const loopState = assistantLoopState();
    emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "done", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "done", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
  });

  it("ARC-761: drops parts whose owning message is a user message", () => {
    const loopState = new PromptLoopState();
    loopState.recordMessageRole("msg-user-1", "user");
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking", id: "r-u", messageID: "msg-user-1" },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
  });

  it("drops reasoning parts when message role has not been recorded yet", () => {
    const loopState = new PromptLoopState();
    loopState.recordMessageRole("msg-user-1", "user");
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking", id: "r-1", messageID: "unknown-msg" },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Buffer-and-replay of unknown-role parts (deep-plan 9.4)
// ---------------------------------------------------------------------------

describe("unknown-role part buffering and replay", () => {
  const SESSION_ID = "sess-1";
  const MSG_ID = "msg-1";

  it("(a) holds a text part pending, then flushes it as a token delta when role becomes assistant", () => {
    const loopState = new PromptLoopState();
    // Part arrives before the message.updated that reveals the role.
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello world", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    // Not emitted yet.
    expect(delta).toBeNull();
    expect(loopState.pendingUnknownRolePartCount).toBe(1);

    // Role becomes known -> flush.
    loopState.recordMessageRole(MSG_ID, "assistant");
    const flushed = loopState.flushPendingUnknownRoleParts(MSG_ID, "assistant");
    expect(flushed).toEqual([{ partId: "part-1", kind: "text", delta: "hello world", fullText: "hello world" }]);
    // Buffer cleared and the pending counter decremented, so the prompt-complete
    // warning will not fire for a part that was successfully replayed.
    expect(loopState.pendingUnknownRoleParts.has(MSG_ID)).toBe(false);
    expect(loopState.pendingUnknownRolePartCount).toBe(0);
  });

  it("(b) holds a reasoning part pending, then flushes it as a reasoning delta", () => {
    const loopState = new PromptLoopState();
    const delta = emitReasoningDelta({
      part: { type: "reasoning", sessionID: SESSION_ID, text: "thinking hard", id: "r-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
    expect(loopState.pendingUnknownRolePartCount).toBe(1);

    loopState.recordMessageRole(MSG_ID, "assistant");
    const flushed = loopState.flushPendingUnknownRoleParts(MSG_ID, "assistant");
    expect(flushed).toEqual([{ partId: "r-1", kind: "reasoning", delta: "thinking hard", fullText: "thinking hard" }]);
  });

  it("(c) discards a pending part when the message role resolves to user", () => {
    const loopState = new PromptLoopState();
    const delta = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "Repository: foo/bar", id: "part-u", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(delta).toBeNull();
    expect(loopState.pendingUnknownRolePartCount).toBe(1);

    loopState.recordMessageRole(MSG_ID, "user");
    const flushed = loopState.flushPendingUnknownRoleParts(MSG_ID, "user");
    expect(flushed).toEqual([]);
    expect(loopState.pendingUnknownRoleParts.has(MSG_ID)).toBe(false);
    // Discarded parts are drained too, so the counter returns to zero.
    expect(loopState.pendingUnknownRolePartCount).toBe(0);
  });

  it("(d) preserves content on the persisted path once the role arrives", () => {
    const loopState = new PromptLoopState();
    emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "persisted reply", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    // Nothing persisted yet -- role unknown.
    expect(loopState.latestResponseText()).toBe("");

    loopState.recordMessageRole(MSG_ID, "assistant");
    loopState.flushPendingUnknownRoleParts(MSG_ID, "assistant");
    // updateTextDelta ran through the normal path, so the transcript has it.
    expect(loopState.latestResponseText()).toBe("persisted reply");
  });

  it("(e) keeps the latest stash per part and does not double-count or double-emit", () => {
    const loopState = new PromptLoopState();
    // Two cumulative updates for the same part before the role is known.
    emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hel", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    // Counter reflects one stashed part, not two.
    expect(loopState.pendingUnknownRolePartCount).toBe(1);

    loopState.recordMessageRole(MSG_ID, "assistant");
    const flushed = loopState.flushPendingUnknownRoleParts(MSG_ID, "assistant");
    // Latest full text replayed once.
    expect(flushed).toEqual([{ partId: "part-1", kind: "text", delta: "hello", fullText: "hello" }]);

    // A later real message.part.updated for the same part must not re-emit
    // already-emitted content (the delta path tracks emitted length).
    const after = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(after).toBeNull();
    // Only the new tail emits.
    const more = emitTextDelta({
      part: { type: "text", sessionID: SESSION_ID, text: "hello world", id: "part-1", messageID: MSG_ID },
      codexSessionId: SESSION_ID,
      loopState,
    });
    expect(more).toBe(" world");
  });
});
