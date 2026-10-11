import { describe, expect, it } from "vitest";

import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.js";

// ---------------------------------------------------------------------------
// Change 1: Modified file tracking
// ---------------------------------------------------------------------------
describe("PromptLoopState.recordModifiedFile", () => {
  it("deduplicates resolved paths", () => {
    const state = new PromptLoopState();
    state.recordModifiedFile("/workspace/repo/src/foo.ts");
    state.recordModifiedFile("/workspace/repo/src/foo.ts");
    expect(state.modifiedFiles.size).toBe(1);
  });

  it("resolves relative paths", () => {
    const state = new PromptLoopState();
    state.recordModifiedFile("src/foo.ts");
    // Should contain a resolved absolute path
    for (const p of state.modifiedFiles) {
      expect(p.startsWith("/")).toBe(true);
    }
  });
});

describe("recordBehavioralSignals tracks edit tools", () => {
  it("increments editCount for apply_patch", () => {
    const state = new PromptLoopState();
    state.recordBehavioralSignals("apply_patch", {
      patch: "*** Update File: /workspace/repo/src/foo.ts\n--- old\n+++ new\n",
    });
    expect(state.editCount).toBe(1);
    expect(state.modifiedFiles.size).toBe(1);
  });

  it("tracks comma-delimited paths from apply_patch metadata", () => {
    const state = new PromptLoopState();
    state.recordBehavioralSignals("apply_patch", { path: "/workspace/repo/a.ts, /workspace/repo/b.ts" });
    expect(state.modifiedFiles.size).toBe(2);
  });
});
