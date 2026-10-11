import { describe, expect, it } from "vitest";

import { displayStatusFromPhase } from "../../../../../shared/session/display-status";
import type { SessionMetadata } from "../../types";
import {
  bucketSession,
  groupDashboardSessions,
  isNeedsInput,
  needsInputSessions,
  sessionChipStatus,
  sessionLifecycleChip,
} from "./session-dashboard";

function session(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    sessionId: overrides.sessionId ?? "s",
    phase: overrides.phase ?? "running",
    displayStatus: overrides.displayStatus ?? displayStatusFromPhase(overrides.phase ?? "running"),
    prUrl: overrides.prUrl ?? null,
    createdAt: overrides.createdAt ?? 0,
    model: overrides.model ?? null,
    title: overrides.title ?? null,
    ...overrides,
  } as SessionMetadata;
}

describe("bucketSession", () => {
  it("puts waiting/failed and needs-attention sessions in attention", () => {
    expect(bucketSession(session({ phase: "waiting_for_input" }))).toBe("attention");
    expect(bucketSession(session({ phase: "failed" }))).toBe("attention");
    expect(bucketSession(session({ phase: "blocked" }))).toBe("attention");
    expect(
      bucketSession(
        session({ phase: "completed", prUrl: "u", cycloidDoneState: "done", cycloidDoneOutcome: "needs_attention" }),
      ),
    ).toBe("attention");
  });

  it("puts in-flight sessions in running", () => {
    expect(bucketSession(session({ phase: "running" }))).toBe("running");
    expect(bucketSession(session({ phase: "finalizing" }))).toBe("running");
  });

  it("puts terminal-but-fine sessions in completed", () => {
    expect(bucketSession(session({ phase: "completed", cycloidDoneOutcome: "success" }))).toBe("completed");
    expect(bucketSession(session({ phase: "stopped" }))).toBe("completed");
    expect(bucketSession(session({ phase: "idle" }))).toBe("completed");
  });
});

describe("bucketSession — FSM-first", () => {
  it("buckets attention states from fsmState, not displayStatus", () => {
    // fsmState is authoritative: a NEEDS_YOU row on a review_stuck block is
    // attention even though its legacy displayStatus reads "working".
    expect(bucketSession(session({ phase: "running", fsmState: "NEEDS_YOU", blockedReason: "review_stuck" }))).toBe(
      "attention",
    );
    expect(bucketSession(session({ phase: "completed", fsmState: "FAILED" }))).toBe("attention");
    expect(bucketSession(session({ phase: "completed", fsmState: "AWAITING_INPUT" }))).toBe("attention");
  });

  it("buckets in-flight and terminal fsm states", () => {
    expect(bucketSession(session({ fsmState: "GENERATING" }))).toBe("running");
    expect(bucketSession(session({ fsmState: "REVIEW" }))).toBe("running");
    expect(bucketSession(session({ fsmState: "MERGE_READY" }))).toBe("completed");
    expect(bucketSession(session({ fsmState: "MERGED" }))).toBe("completed");
  });

  it("falls back to legacy displayStatus when fsmState is absent", () => {
    // Identical to today: no fsmState → the displayStatus path decides.
    expect(bucketSession(session({ phase: "waiting_for_input" }))).toBe("attention");
    expect(bucketSession(session({ phase: "running" }))).toBe("running");
    expect(bucketSession(session({ phase: "completed" }))).toBe("completed");
  });
});

describe("sessionLifecycleChip", () => {
  it("returns Needs you + blocked-reason detail for NEEDS_YOU (review_stuck), not Failed", () => {
    const result = sessionLifecycleChip(
      session({ phase: "running", fsmState: "NEEDS_YOU", blockedReason: "review_stuck" }),
    );
    expect(result?.chip.label).toBe("Needs you");
    expect(result?.chip.tone).toBe("warning");
    expect(result?.detail).toBe("Review stalled — needs you");
    expect(result?.chip.label).not.toBe("Failed");
  });

  it("returns the error-tone Failed chip + failure detail for FAILED", () => {
    const result = sessionLifecycleChip(
      session({ phase: "failed", fsmState: "FAILED", failureReason: "codegen_error" }),
    );
    expect(result?.chip.label).toBe("Failed");
    expect(result?.chip.tone).toBe("error");
    expect(result?.detail).toBe("Agent run failed");
  });

  it("returns a live pulse chip with no detail for in-flight states", () => {
    const result = sessionLifecycleChip(session({ fsmState: "GENERATING" }));
    expect(result?.chip.tone).toBe("live");
    expect(result?.chip.pulse).toBe(true);
    expect(result?.detail).toBeNull();
  });

  it("returns null (legacy fallback) when fsmState is absent or ARCHIVED", () => {
    expect(sessionLifecycleChip(session({ phase: "running" }))).toBeNull();
    expect(sessionLifecycleChip(session({ fsmState: "ARCHIVED" }))).toBeNull();
  });
});

describe("groupDashboardSessions — FSM-first", () => {
  it("drops fsm-ARCHIVED rows the same as displayStatus archived", () => {
    const groups = groupDashboardSessions([
      session({ sessionId: "arch-fsm", fsmState: "ARCHIVED", createdAt: 3 }),
      session({ sessionId: "run", fsmState: "GENERATING", createdAt: 2 }),
    ]);
    expect(groups.running.map((s) => s.sessionId)).toEqual(["run"]);
    expect(groups.completed).toEqual([]);
  });

  it("buckets a mixed FSM + legacy list identically to the pure-legacy list when no fsmState", () => {
    const legacy = [
      session({ sessionId: "wait", phase: "waiting_for_input", createdAt: 2 }),
      session({ sessionId: "run", phase: "running", createdAt: 1 }),
    ];
    const groups = groupDashboardSessions(legacy);
    expect(groups.attention.map((s) => s.sessionId)).toEqual(["wait"]);
    expect(groups.running.map((s) => s.sessionId)).toEqual(["run"]);
  });
});

describe("sessionChipStatus", () => {
  it("distinguishes finalizing as verifying and running as running", () => {
    expect(sessionChipStatus(session({ phase: "finalizing" }))).toBe("verifying");
    expect(sessionChipStatus(session({ phase: "running" }))).toBe("running");
  });

  it("maps waiting and failed", () => {
    expect(sessionChipStatus(session({ phase: "waiting_for_input" }))).toBe("waiting");
    expect(sessionChipStatus(session({ phase: "failed" }))).toBe("failed");
  });

  it("flags needs-attention terminal PRs as checks-failing", () => {
    expect(
      sessionChipStatus(
        session({ phase: "completed", prUrl: "u", cycloidDoneState: "done", cycloidDoneOutcome: "needs_attention" }),
      ),
    ).toBe("checks-failing");
  });

  it("shows pr-open for a shipped PR and done otherwise", () => {
    expect(sessionChipStatus(session({ phase: "completed", prUrl: "u" }))).toBe("pr-open");
    expect(sessionChipStatus(session({ phase: "completed", prUrl: null }))).toBe("done");
  });
});

describe("groupDashboardSessions", () => {
  it("groups, drops archived, sorts newest first, and caps completed", () => {
    const sessions = [
      session({ sessionId: "run", phase: "running", createdAt: 100 }),
      session({ sessionId: "wait", phase: "waiting_for_input", createdAt: 200 }),
      session({ sessionId: "arch", phase: "archived", createdAt: 300 }),
      session({ sessionId: "old", phase: "completed", createdAt: 1 }),
      session({ sessionId: "new", phase: "completed", createdAt: 500 }),
    ];
    const groups = groupDashboardSessions(sessions, 1);
    expect(groups.attention.map((s) => s.sessionId)).toEqual(["wait"]);
    expect(groups.running.map((s) => s.sessionId)).toEqual(["run"]);
    // archived dropped; completed newest-first then capped to 1
    expect(groups.completed.map((s) => s.sessionId)).toEqual(["new"]);
    expect(groups.completedOverflow).toBe(1);
    expect(groups.attentionOverflow).toBe(0);
  });

  it("caps the attention bucket and reports overflow, newest first", () => {
    const sessions = [
      session({ sessionId: "a1", phase: "failed", createdAt: 5 }),
      session({ sessionId: "a2", phase: "waiting_for_input", createdAt: 4 }),
      session({ sessionId: "a3", phase: "failed", createdAt: 3 }),
    ];
    // completedLimit=6, attentionLimit=2
    const groups = groupDashboardSessions(sessions, 6, 2);
    expect(groups.attention.map((s) => s.sessionId)).toEqual(["a1", "a2"]);
    expect(groups.attentionOverflow).toBe(1);
    expect(groups.completedOverflow).toBe(0);
    expect(groups.running).toEqual([]);
  });

  it("never truncates the running bucket", () => {
    const sessions = Array.from({ length: 10 }, (_unused, i) =>
      session({ sessionId: `r${i}`, phase: "running", createdAt: i }),
    );
    const groups = groupDashboardSessions(sessions, 1, 1);
    expect(groups.running).toHaveLength(10);
  });
});

describe("needsInputSessions", () => {
  it("returns only waiting sessions newest first", () => {
    expect(isNeedsInput(session({ phase: "waiting_for_input" }))).toBe(true);
    const result = needsInputSessions([
      session({ sessionId: "a", phase: "waiting_for_input", createdAt: 1 }),
      session({ sessionId: "b", phase: "running", createdAt: 2 }),
      session({ sessionId: "c", phase: "waiting_for_input", createdAt: 3 }),
    ]);
    expect(result.map((s) => s.sessionId)).toEqual(["c", "a"]);
  });
});
