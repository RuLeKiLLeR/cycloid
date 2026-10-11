import { describe, expect, it } from "vitest";

import type { SandboxStopReason } from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { computeRichStatus as computeRichStatusInner } from "../../../apps/control-plane-worker/src/session/rich-status.ts";
import type { SessionState } from "../../../apps/control-plane-worker/src/types.ts";
import type { PublishStatus } from "../../../shared/types/publish.ts";

// Positional-argument shim: computeRichStatus now takes a structured inputs
// object (the positional-boolean threading was collapsed into RichStatusInputs).
// These tests pre-date that change and assert the phase contract via positional
// args, which maps 1:1 onto the object — keep them exercising the real wrapper
// through this thin adapter.
function computeRichStatus(
  session: SessionState | undefined,
  sandboxStatus: string | undefined,
  activePromptId: string | null,
  stopReason?: SandboxStopReason | null,
  activePromptHasPendingQuestion?: boolean,
  publishStatus?: PublishStatus,
  postExecutionPending?: boolean,
  mostRecentPromptResultNoChanges?: boolean,
  reviewListeningActive?: boolean,
): string {
  return computeRichStatusInner(session, {
    sandboxStatus,
    activePromptId,
    stopReason: stopReason ?? null,
    activePromptHasPendingQuestion,
    publishStatus,
    postExecutionPending,
    mostRecentPromptResultNoChanges,
    reviewListeningActive,
  });
}

const baseSession: SessionState = {
  sessionId: "s-1",
  ownerUserId: "u-1",
  businessId: "b-1",
  status: "active",
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
  closedAt: null,
  model: null,
  reasoningEffort: null,
  lastEventId: "event-0",
  title: null,
  sessionKind: "repo",
};

describe("computeRichStatus", () => {
  it("threads pending plan approval through the rich-status projection", () => {
    expect(
      computeRichStatusInner(baseSession, {
        sandboxStatus: "stopped",
        activePromptId: null,
        planApprovalPending: true,
        publishStatus: "published",
      }),
    ).toBe("waiting_for_input");
  });

  it("returns archived for archived sessions regardless of sandbox status", () => {
    expect(computeRichStatus({ ...baseSession, status: "archived" }, "ready", null)).toBe("archived");
  });

  it("preserves the existing 'stopped' for user-initiated stops", () => {
    expect(computeRichStatus(baseSession, "stopped", null, "user")).toBe("stopped");
  });

  it("returns 'stopped' for Modal-reaped sandboxes", () => {
    // Post-phase-flip the column stores the phase string only; the resumable
    // vs user distinction lives in the `stopMode` substate on the DO state.
    expect(computeRichStatus(baseSession, "stopped", null, "reaped")).toBe("stopped");
  });

  it("returns 'stopped' for spawn-failed sandboxes", () => {
    expect(computeRichStatus(baseSession, "stopped", null, "spawn_failed")).toBe("stopped");
  });

  it("returns 'stopped' when stopReason is missing (legacy rows)", () => {
    expect(computeRichStatus(baseSession, "stopped", null, null)).toBe("stopped");
    expect(computeRichStatus(baseSession, "stopped", null)).toBe("stopped");
  });

  it("returns 'running' when an active prompt exists", () => {
    expect(computeRichStatus(baseSession, "ready", "p-1")).toBe("running");
  });

  it("returns 'idle' for residual repo state (no active prompt, publish not_started)", () => {
    expect(computeRichStatus(baseSession, "ready", null)).toBe("idle");
  });

  it("returns 'review_listening' when the session is waiting for PR bot feedback", () => {
    expect(computeRichStatus(baseSession, "stopped", null, "reaped", false, "published", false, false, true)).toBe(
      "review_listening",
    );
  });

  it("returns 'finalizing' while repo post-execution or publish is unresolved", () => {
    expect(computeRichStatus(baseSession, "ready", null, null, false, "not_started", true, false)).toBe("finalizing");
    expect(computeRichStatus(baseSession, "ready", null, null, false, "publishing", false, false)).toBe("finalizing");
  });

  it("returns completed and failed publish outcomes for repo sessions", () => {
    expect(computeRichStatus(baseSession, "ready", null, null, false, "published", false, false)).toBe("completed");
    expect(computeRichStatus(baseSession, "ready", null, null, false, "skipped", false, false)).toBe("completed");
    expect(computeRichStatus(baseSession, "ready", null, null, false, "not_started", false, true)).toBe("completed");
    expect(computeRichStatus(baseSession, "ready", null, null, false, "failed", false, false)).toBe("failed");
  });

  it("returns completed for reaped answered-no-PR sessions", () => {
    expect(computeRichStatus(baseSession, "stopped", null, "reaped", false, "not_started", false, true)).toBe(
      "completed",
    );
  });

  it("returns 'running' for the transient 'stopping' state to avoid stale idle drift", () => {
    // If a stop boundary is interrupted between putSandboxStatus("stopping")
    // and the final "stopped" sync, session_index.rich_status would be left
    // at "idle". Mapping "stopping" -> "running" (which flattens to "Working")
    // keeps the UI in a sensible state until the terminal projection arrives.
    expect(computeRichStatus(baseSession, "stopping", null)).toBe("running");
    expect(computeRichStatus(baseSession, "stopping", "p-1")).toBe("running");
  });

  it("returns 'waiting_for_input' when active prompt has a pending question", () => {
    expect(computeRichStatus(baseSession, "ready", "p-1", null, true)).toBe("waiting_for_input");
  });

  it("returns 'running' for an active prompt without a pending question", () => {
    expect(computeRichStatus(baseSession, "ready", "p-1", null, false)).toBe("running");
  });

  it("stopped wins over pending question; pending question wins over spawning/reconnecting", () => {
    // Plan-documented behavior change: pending question is no longer hidden under
    // sandbox_creating / running on a transient transport. Stopped still wins.
    expect(computeRichStatus(baseSession, "spawning", "p-1", null, true)).toBe("waiting_for_input");
    expect(computeRichStatus(baseSession, "reconnecting", "p-1", null, true)).toBe("waiting_for_input");
    expect(computeRichStatus(baseSession, "stopping", "p-1", null, true)).toBe("waiting_for_input");
    expect(computeRichStatus(baseSession, "stopped", "p-1", "user", true)).toBe("stopped");
    expect(computeRichStatus(baseSession, "stopped", "p-1", "reaped", true)).toBe("stopped");
  });

  it("threads the live-idle user-stop flag so it supersedes waiting_for_input classifications", () => {
    // Stopped plan-approval session: user stop wins over the plan park.
    expect(
      computeRichStatusInner(baseSession, {
        sandboxStatus: "ready",
        activePromptId: null,
        planApprovalPending: true,
        userStopped: true,
      }),
    ).toBe("idle");
    // Stopped while the agent question was pending: the aborting turn stays running.
    expect(
      computeRichStatusInner(baseSession, {
        sandboxStatus: "ready",
        activePromptId: "p-1",
        activePromptHasPendingQuestion: true,
        userStopped: true,
      }),
    ).toBe("running");
    // Omitting the field preserves the waiting classification (additive seam).
    expect(
      computeRichStatusInner(baseSession, {
        sandboxStatus: "ready",
        activePromptId: null,
        planApprovalPending: true,
      }),
    ).toBe("waiting_for_input");
  });

  it("carries reviewListeningActive through the structured RichStatusInputs object", () => {
    // Refactor B: reviewListeningActive now rides inside the inputs object rather
    // than as a trailing positional boolean. Passing it via the field keeps the
    // session in review_listening; omitting it falls back to the publish-driven
    // phase (completed), proving the field — not arg position — drives behavior.
    expect(
      computeRichStatusInner(baseSession, {
        sandboxStatus: "ready",
        activePromptId: null,
        publishStatus: "published",
        reviewListeningActive: true,
      }),
    ).toBe("review_listening");
    expect(
      computeRichStatusInner(baseSession, {
        sandboxStatus: "ready",
        activePromptId: null,
        publishStatus: "published",
      }),
    ).toBe("completed");
  });
});
