// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import {
  RUNTIME_READINESS_PATH,
  RuntimeReadinessTracker,
} from "../../apps/sandbox-bridge/src/services/runtime-readiness-tracker.js";

const PATH = "/tmp/test-runtime-readiness.json";

function makeTracker() {
  const files = new Map<string, string>();
  const tracker = new RuntimeReadinessTracker({
    path: PATH,
    writeFileSync: (path, data) => files.set(path, data),
    rmSync: (path) => files.delete(path),
  });
  const read = (): unknown => {
    const raw = files.get(PATH);
    return raw === undefined ? undefined : JSON.parse(raw);
  };
  return { tracker, files, read };
}

describe("RuntimeReadinessTracker", () => {
  it("exports the path the wrapper reads", () => {
    expect(RUNTIME_READINESS_PATH).toBe("/tmp/cycloid-runtime-readiness.json");
  });

  it("writes a starting record with startedAt + deadline", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000);
    expect(read()).toEqual({ state: "starting", startedAt: 1_000, deadline: 931_000 });
    expect(tracker.getState()).toEqual({ state: "starting", startedAt: 1_000, deadline: 931_000 });
  });

  it("preserves boot ownership metadata through terminal transitions", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000, {
      attemptId: "boot-1",
      owner: "planner",
      promptId: "prompt-1",
    });
    tracker.markReady();
    expect(read()).toEqual({
      state: "ready",
      attemptId: "boot-1",
      owner: "planner",
      promptId: "prompt-1",
      startedAt: 1_000,
      deadline: 931_000,
    });
  });

  it("transitions to ready while preserving startedAt/deadline", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000);
    tracker.markReady();
    expect(read()).toEqual({ state: "ready", startedAt: 1_000, deadline: 931_000 });
  });

  it("records an error on failure and timeout", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000);
    tracker.markFailed("boom");
    expect(read()).toEqual({ state: "failed", startedAt: 1_000, deadline: 931_000, error: "boom" });
    // Terminal states are immutable; reopen with a fresh start for the timeout case.
    tracker.markStarting(2_000, 932_000);
    tracker.markTimedOut("too slow");
    expect(read()).toEqual({ state: "timed_out", startedAt: 2_000, deadline: 932_000, error: "too slow" });
  });

  it("clear() removes the file and in-process state", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000);
    tracker.clear();
    expect(read()).toBeUndefined();
    expect(tracker.getState()).toBeNull();
  });

  it("does not resurrect state with a terminal transition after clear()", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000);
    tracker.clear();
    // A background boot that resolves after teardown must not rewrite the file.
    tracker.markReady();
    expect(read()).toBeUndefined();
    expect(tracker.getState()).toBeNull();
  });

  it("ignores a terminal transition before any start", () => {
    const { tracker, read } = makeTracker();
    tracker.markFailed("no boot");
    expect(read()).toBeUndefined();
    expect(tracker.getState()).toBeNull();
  });

  it("treats a terminal state as immutable until the next start/clear", () => {
    const { tracker, read } = makeTracker();
    tracker.markStarting(1_000, 931_000);
    tracker.markFailed("boom");
    // A stray second terminal transition must not overwrite the recorded failure
    // (e.g. a false `ready` after `failed`).
    tracker.markReady();
    tracker.markTimedOut("slow");
    expect(read()).toEqual({ state: "failed", startedAt: 1_000, deadline: 931_000, error: "boom" });
    // A fresh boot reopens the state machine.
    tracker.markStarting(2_000, 932_000);
    tracker.markReady();
    expect(read()).toEqual({ state: "ready", startedAt: 2_000, deadline: 932_000 });
  });
});
