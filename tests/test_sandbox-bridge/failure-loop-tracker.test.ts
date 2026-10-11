import { describe, expect, it } from "vitest";

import {
  codeStateTokenFromSnapshot,
  FailureLoopTracker,
} from "../../apps/sandbox-bridge/src/services/failure-loop-tracker.js";

describe("FailureLoopTracker", () => {
  it("flags the second exhaustion of the same prompt + class + code state", () => {
    const tracker = new FailureLoopTracker();
    expect(tracker.recordBudgetExhaustion("p1", "failed_edits", "sha:abc")).toEqual({
      suspectedLoop: false,
      exhaustionCount: 1,
    });
    expect(tracker.recordBudgetExhaustion("p1", "failed_edits", "sha:abc")).toEqual({
      suspectedLoop: true,
      exhaustionCount: 2,
    });
  });

  it("a new prompt id starts a fresh count (a later prompt is never aborted by an earlier failure)", () => {
    const tracker = new FailureLoopTracker();
    tracker.recordBudgetExhaustion("p1", "failed_edits", "sha:abc");
    expect(tracker.recordBudgetExhaustion("p2", "failed_edits", "sha:abc").suspectedLoop).toBe(false);
  });

  it("a code-state change (new commit / successful edits) starts a fresh count", () => {
    const tracker = new FailureLoopTracker();
    tracker.recordBudgetExhaustion("p1", "failed_edits", "sha:abc");
    expect(tracker.recordBudgetExhaustion("p1", "failed_edits", "sha:def").suspectedLoop).toBe(false);
  });

  it("a different failure class starts a fresh count", () => {
    const tracker = new FailureLoopTracker();
    tracker.recordBudgetExhaustion("p1", "failed_edits", "sha:abc");
    expect(tracker.recordBudgetExhaustion("p1", "rate_limit", "sha:abc").suspectedLoop).toBe(false);
  });

  it("treats unknown code state as constant so identical repeats still trip", () => {
    const tracker = new FailureLoopTracker();
    tracker.recordBudgetExhaustion("p1", "failed_edits", null);
    expect(tracker.recordBudgetExhaustion("p1", "failed_edits", null).suspectedLoop).toBe(true);
  });

  it("evicted hot key re-enters at count 1 and still trips on the next exhaustion", () => {
    const tracker = new FailureLoopTracker();
    tracker.recordBudgetExhaustion("hot", "failed_edits", "sha:abc");
    for (let i = 0; i < 250; i++) {
      tracker.recordBudgetExhaustion(`cold-${i}`, "rate_limit", "sha:abc");
    }
    // The hot key was evicted (LRU bound) — but a re-exhaustion still counts up from 1.
    const verdict = tracker.recordBudgetExhaustion("hot", "failed_edits", "sha:abc");
    expect(verdict.exhaustionCount).toBeGreaterThanOrEqual(1);
    expect(tracker.recordBudgetExhaustion("hot", "failed_edits", "sha:abc").suspectedLoop).toBe(true);
  });
});

describe("codeStateTokenFromSnapshot", () => {
  it("derives a stable token from head sha + porcelain", () => {
    const a = codeStateTokenFromSnapshot({ headSha: "abc", porcelain: " M src/x.ts" });
    const b = codeStateTokenFromSnapshot({ headSha: "abc", porcelain: " M src/x.ts" });
    const c = codeStateTokenFromSnapshot({ headSha: "abc", porcelain: "" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^abc:[0-9a-f]{12}$/);
  });

  it("returns null without a head sha", () => {
    expect(codeStateTokenFromSnapshot({ porcelain: "" })).toBeNull();
  });
});
