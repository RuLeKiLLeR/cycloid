import { describe, expect, it } from "vitest";

import type { SandboxStopReason } from "../../apps/control-plane-worker/src/session/do-db.js";
import { computeRichStatus as computeRichStatusInner } from "../../apps/control-plane-worker/src/session/rich-status.js";
import type { SessionState } from "../../apps/control-plane-worker/src/types.js";
import type { PublishStatus } from "../../shared/types/publish.js";

// Positional-argument shim: computeRichStatus now takes a structured inputs
// object (RichStatusInputs). These tests assert the phase contract via the
// historical positional signature, which maps 1:1 onto the object.
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

const activeSession = {
  sessionId: "s-1",
  ownerUserId: "u-1",
  businessId: null,
  status: "active" as const,
  sessionKind: "repo" as const,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
  lastEventId: null,
  title: null,
};

const closedSession = { ...activeSession, status: "archived" as const, closedAt: "2026-01-01T01:00:00Z" };

describe("computeRichStatus", () => {
  it("returns 'archived' when session is undefined", () => {
    expect(computeRichStatus(undefined, undefined, null)).toBe("archived");
  });

  it("returns 'archived' when session is closed", () => {
    expect(computeRichStatus(closedSession, undefined, null)).toBe("archived");
  });

  it("returns 'archived' when session is closed even with active prompt and spawning sandbox", () => {
    expect(computeRichStatus(closedSession, "spawning", "p-1")).toBe("archived");
  });

  it("returns 'running' when sandbox is spawning with active prompt (substate=creating)", () => {
    // Phase model: running + sandboxSubstate=creating. Post-phase-flip the column
    // stores the phase string only; the creating substate lives on the DO state.
    expect(computeRichStatus(activeSession, "spawning", "p-1")).toBe("running");
  });

  it("returns 'running' when sandbox is spawning without active prompt (warm)", () => {
    expect(computeRichStatus(activeSession, "spawning", null)).toBe("running");
  });

  it("returns 'running' when sandbox is ready and prompt is active", () => {
    expect(computeRichStatus(activeSession, "ready", "p-1")).toBe("running");
  });

  it("returns 'idle' for residual repo state (no active prompt, publish not_started)", () => {
    // Residual case (brand-new session or post-reset). Phase model classifies this
    // as `idle` to preserve canSendPrompt semantics from the pre-phase contract.
    expect(computeRichStatus(activeSession, undefined, null)).toBe("idle");
    expect(computeRichStatus(activeSession, "ready", null)).toBe("idle");
  });

  it("returns 'finalizing' for repo sessions awaiting post-execution or publish", () => {
    expect(computeRichStatus(activeSession, "ready", null, null, false, "not_started", true, false)).toBe("finalizing");
    expect(computeRichStatus(activeSession, "ready", null, null, false, "publishing", false, false)).toBe("finalizing");
  });

  it("returns 'completed' for terminal success outcomes", () => {
    expect(computeRichStatus(activeSession, "ready", null, null, false, "published", false, false)).toBe("completed");
    expect(computeRichStatus(activeSession, "ready", null, null, false, "skipped", false, false)).toBe("completed");
    expect(computeRichStatus(activeSession, "ready", null, null, false, "not_started", false, true)).toBe("completed");
  });

  it("returns the failed publish outcome", () => {
    expect(computeRichStatus(activeSession, "ready", null, null, false, "failed", false, false)).toBe("failed");
  });

  it("returns 'stopped' when sandbox is stopped with stopReason 'user'", () => {
    expect(computeRichStatus(activeSession, "stopped", null, "user")).toBe("stopped");
  });

  it("returns 'stopped' for resumable sandbox stops (substate distinguishes user vs resumable)", () => {
    // Post-phase-flip the column stores the phase string only; user/resumable
    // distinction lives in the `stopMode` substate field on the DO.
    expect(computeRichStatus(activeSession, "stopped", null)).toBe("stopped");
    expect(computeRichStatus(activeSession, "stopped", null, null)).toBe("stopped");
    expect(computeRichStatus(activeSession, "stopped", null, "reaped")).toBe("stopped");
    expect(computeRichStatus(activeSession, "stopped", null, "spawn_failed")).toBe("stopped");
  });

  it("returns 'waiting_for_input' when active prompt has a pending question and sandbox is ready", () => {
    expect(computeRichStatus(activeSession, "ready", "p-1", null, true)).toBe("waiting_for_input");
  });

  it("returns 'running' when active prompt has no pending question (default)", () => {
    expect(computeRichStatus(activeSession, "ready", "p-1", null, false)).toBe("running");
    expect(computeRichStatus(activeSession, "ready", "p-1", null)).toBe("running");
  });

  it("transient sandbox states win for terminal/stopped paths; pending question wins over creating-substate", () => {
    // Stopped and pending-question both fire ahead of plain running. Spawning while an
    // active prompt has a pending question now surfaces as waiting_for_input with a
    // creating substate (alias = waiting_for_input) — the legacy short-circuit hid the
    // pending question behind sandbox_creating.
    expect(computeRichStatus(activeSession, "spawning", "p-1", null, true)).toBe("waiting_for_input");
    expect(computeRichStatus(activeSession, "reconnecting", "p-1", null, true)).toBe("waiting_for_input");
    expect(computeRichStatus(activeSession, "stopping", "p-1", null, true)).toBe("waiting_for_input");
    expect(computeRichStatus(activeSession, "stopped", "p-1", "user", true)).toBe("stopped");
    expect(computeRichStatus(activeSession, "stopped", "p-1", "reaped", true)).toBe("stopped");
  });
});
