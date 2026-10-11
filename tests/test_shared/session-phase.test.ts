import { describe, expect, it } from "vitest";

import {
  computePhase,
  isAwaitingVerificationVerdict,
  isTerminalPhase,
  type Phase,
  type PhaseInputs,
  richStatusFromPhase,
  TERMINAL_PHASES_ARRAY,
  verificationResultFromAgentVerdict,
} from "../../shared/session/phase.js";

const baseInputs: PhaseInputs = {
  sessionStatus: "active",
  sandboxStatus: undefined,
  activePromptId: null,
  stopReason: null,
  activePromptHasPendingQuestion: false,
  planApprovalPending: false,
  publishStatus: "not_started",
  postExecutionPending: false,
  mostRecentPromptResultNoChanges: false,
};

function withInputs(overrides: Partial<PhaseInputs>): PhaseInputs {
  return { ...baseInputs, ...overrides };
}

describe("isAwaitingVerificationVerdict", () => {
  it("awaits when no verdict has settled yet (null / pending / in-progress)", () => {
    expect(isAwaitingVerificationVerdict(null, null)).toBe(true);
    expect(isAwaitingVerificationVerdict("verification-pending", null)).toBe(true);
    expect(isAwaitingVerificationVerdict("verification-in-progress", null)).toBe(true);
  });

  it("does not await once a terminal verdict has settled", () => {
    expect(isAwaitingVerificationVerdict("verification-done", "merge-ready")).toBe(false);
    expect(isAwaitingVerificationVerdict("verification-skipped", null)).toBe(false);
    expect(isAwaitingVerificationVerdict("verification-exhausted", null)).toBe(false);
    expect(isAwaitingVerificationVerdict("verification-stopped", null)).toBe(false);
  });

  it("treats a verification-done with no recorded result as settled (legacy / pre-result runs)", () => {
    expect(isAwaitingVerificationVerdict("verification-done", null)).toBe(false);
  });

  it("re-engages (awaits) for ANY needs-work verdict (RLA follow-up fires on all needs-work, #5005)", () => {
    expect(isAwaitingVerificationVerdict("verification-done", "needs-work")).toBe(true);
  });
});

describe("verificationResultFromAgentVerdict", () => {
  it("maps QTA terminal verdicts onto internal result state", () => {
    expect(verificationResultFromAgentVerdict("CONCLUSIVE")).toBe("merge-ready");
    expect(verificationResultFromAgentVerdict("INCONCLUSIVE")).toBe("needs-work");
  });
});

describe("computePhase precedence", () => {
  it("archived session short-circuits to archived", () => {
    expect(computePhase(withInputs({ sessionStatus: "archived" }))?.phase).toBe("archived");
  });

  it("undefined inputs map to archived (defensive)", () => {
    expect(computePhase(undefined)?.phase).toBe("archived");
  });

  it("keeps legacy wire inputs unchanged when planApprovalPending is omitted", () => {
    const legacyInputs = { ...baseInputs };
    delete legacyInputs.planApprovalPending;
    expect(computePhase(legacyInputs).phase).toBe("idle");
  });

  it("stopped sandbox + user stopReason -> stopped/user", () => {
    const info = computePhase(withInputs({ sandboxStatus: "stopped", stopReason: "user" }));
    expect(info?.phase).toBe("stopped");
    expect(info?.stopMode).toBe("user");
  });

  it("projects a pending plan approval as waiting_for_input while the sandbox is running or suspended", () => {
    expect(computePhase(withInputs({ sandboxStatus: "ready", planApprovalPending: true })).phase).toBe(
      "waiting_for_input",
    );
    expect(computePhase(withInputs({ sandboxStatus: "stopped", planApprovalPending: true })).phase).toBe(
      "waiting_for_input",
    );
  });

  it("keeps archived and explicit user-stop precedence over a pending plan approval", () => {
    expect(computePhase(withInputs({ sessionStatus: "archived", planApprovalPending: true })).phase).toBe("archived");

    const userStopped = computePhase(
      withInputs({ sandboxStatus: "stopped", stopReason: "user", planApprovalPending: true }),
    );
    expect(userStopped.phase).toBe("stopped");
    expect(userStopped.stopMode).toBe("user");
  });

  it("keeps a pending plan approval ahead of publish-driven completion", () => {
    expect(computePhase(withInputs({ planApprovalPending: true, publishStatus: "published" })).phase).toBe(
      "waiting_for_input",
    );
  });

  it("stopped sandbox + non-user stopReason -> stopped/resumable", () => {
    expect(computePhase(withInputs({ sandboxStatus: "stopped", stopReason: "reaped" }))?.stopMode).toBe("resumable");
    expect(computePhase(withInputs({ sandboxStatus: "stopped", stopReason: null }))?.stopMode).toBe("resumable");
    expect(computePhase(withInputs({ sandboxStatus: "stopped", stopReason: "spawn_failed" }))?.stopMode).toBe(
      "resumable",
    );
  });

  it("projects a failed sandbox without an active prompt as failed", () => {
    expect(computePhase(withInputs({ sandboxStatus: "failed" }))?.phase).toBe("failed");
  });

  it("stopped wins over an active prompt", () => {
    const info = computePhase(withInputs({ sandboxStatus: "stopped", stopReason: "user", activePromptId: "p-1" }));
    expect(info?.phase).toBe("stopped");
  });

  it("review listening wins over completed publish and resumable stopped state", () => {
    expect(
      computePhase(
        withInputs({
          publishStatus: "published",
          sandboxStatus: "stopped",
          stopReason: "reaped",
          reviewListeningActive: true,
        }),
      )?.phase,
    ).toBe("review_listening");
  });

  it("archived, user-stopped, and active prompt states win over review listening", () => {
    expect(computePhase(withInputs({ sessionStatus: "archived", reviewListeningActive: true }))?.phase).toBe(
      "archived",
    );
    expect(
      computePhase(withInputs({ sandboxStatus: "stopped", stopReason: "user", reviewListeningActive: true }))?.phase,
    ).toBe("stopped");
    expect(computePhase(withInputs({ activePromptId: "p-1", reviewListeningActive: true }))?.phase).toBe("running");
  });

  it("sandbox transport substates win over review listening while no prompt is active", () => {
    const spawning = computePhase(withInputs({ sandboxStatus: "spawning", reviewListeningActive: true }));
    expect(spawning?.phase).toBe("running");
    expect(spawning?.sandboxSubstate).toBe("creating");

    const reconnecting = computePhase(withInputs({ sandboxStatus: "reconnecting", reviewListeningActive: true }));
    expect(reconnecting?.phase).toBe("running");
    expect(reconnecting?.sandboxSubstate).toBe("reconnecting");

    const stopping = computePhase(withInputs({ sandboxStatus: "stopping", reviewListeningActive: true }));
    expect(stopping?.phase).toBe("running");
    expect(stopping?.sandboxSubstate).toBe("stopping");
  });

  it("active prompt with pending question -> waiting_for_input", () => {
    const info = computePhase(withInputs({ activePromptId: "p-1", activePromptHasPendingQuestion: true }));
    expect(info?.phase).toBe("waiting_for_input");
  });

  it("pending question wins over sandbox transient states but preserves substate", () => {
    const spawning = computePhase(
      withInputs({ activePromptId: "p-1", activePromptHasPendingQuestion: true, sandboxStatus: "spawning" }),
    );
    expect(spawning?.phase).toBe("waiting_for_input");
    expect(spawning?.sandboxSubstate).toBe("creating");

    const reconnecting = computePhase(
      withInputs({ activePromptId: "p-1", activePromptHasPendingQuestion: true, sandboxStatus: "reconnecting" }),
    );
    expect(reconnecting?.phase).toBe("waiting_for_input");
    expect(reconnecting?.sandboxSubstate).toBe("reconnecting");

    const stopping = computePhase(
      withInputs({ activePromptId: "p-1", activePromptHasPendingQuestion: true, sandboxStatus: "stopping" }),
    );
    expect(stopping?.phase).toBe("waiting_for_input");
    expect(stopping?.sandboxSubstate).toBe("stopping");
  });

  it("active prompt with spawning sandbox -> running + creating substate", () => {
    const info = computePhase(withInputs({ activePromptId: "p-1", sandboxStatus: "spawning" }));
    expect(info?.phase).toBe("running");
    expect(info?.sandboxSubstate).toBe("creating");
  });

  it("active prompt with reconnecting sandbox -> running + reconnecting substate", () => {
    const info = computePhase(withInputs({ activePromptId: "p-1", sandboxStatus: "reconnecting" }));
    expect(info?.phase).toBe("running");
    expect(info?.sandboxSubstate).toBe("reconnecting");
  });

  it("active prompt with ready sandbox -> running with no substate", () => {
    const info = computePhase(withInputs({ activePromptId: "p-1", sandboxStatus: "ready" }));
    expect(info?.phase).toBe("running");
    expect(info?.sandboxSubstate).toBe("none");
  });

  it("publish failed -> failed", () => {
    expect(computePhase(withInputs({ publishStatus: "failed" }))?.phase).toBe("failed");
  });

  it("stored legacy blocked_by_verification rows still map to blocked (D-57 stored-rows compat)", () => {
    // The writer + `PublishStatus` union arm are deleted (ARC-1330 D-57), but rows
    // persisted before that still carry the literal — the read side must keep them
    // `blocked` until D-59 sources phase from the spine. Raw string on purpose.
    const info = computePhase(withInputs({ publishStatus: "blocked_by_verification" as never }));
    expect(info?.phase).toBe("blocked");
  });

  it("publish published/skipped -> completed", () => {
    expect(computePhase(withInputs({ publishStatus: "published" }))?.phase).toBe("completed");
    expect(computePhase(withInputs({ publishStatus: "skipped" }))?.phase).toBe("completed");
  });

  it("publish publishing -> finalizing/publishing", () => {
    const info = computePhase(withInputs({ publishStatus: "publishing" }));
    expect(info?.phase).toBe("finalizing");
    expect(info?.finalizingStep).toBe("publishing");
  });

  it("not_started + postExecutionPending -> finalizing/post_execution", () => {
    const info = computePhase(withInputs({ publishStatus: "not_started", postExecutionPending: true }));
    expect(info?.phase).toBe("finalizing");
    expect(info?.finalizingStep).toBe("post_execution");
  });

  it("not_started + mostRecentPromptResultNoChanges -> completed", () => {
    expect(
      computePhase(withInputs({ publishStatus: "not_started", mostRecentPromptResultNoChanges: true }))?.phase,
    ).toBe("completed");
  });

  it("reaped answered-no-PR sessions stay completed", () => {
    const info = computePhase(
      withInputs({
        publishStatus: "not_started",
        mostRecentPromptResultNoChanges: true,
        sandboxStatus: "stopped",
        stopReason: "reaped",
      }),
    );

    expect(info?.phase).toBe("completed");
    expect(info?.stopMode).toBe("none");
  });

  it("residual repo state (no prompt, not_started, no postExec, no noChanges) -> idle", () => {
    // Residual is genuinely "no work in progress, ready for a prompt" — distinct
    // from `finalizing` (platform doing work) and `completed` (prior work finished).
    const info = computePhase(withInputs({}));
    expect(info?.phase).toBe("idle");
    expect(info?.finalizingStep).toBe("none");
  });

  it("transport substates decorate running between prompts too", () => {
    expect(computePhase(withInputs({ sandboxStatus: "spawning" }))?.sandboxSubstate).toBe("creating");
    expect(computePhase(withInputs({ sandboxStatus: "reconnecting" }))?.sandboxSubstate).toBe("reconnecting");
    expect(computePhase(withInputs({ sandboxStatus: "stopping" }))?.sandboxSubstate).toBe("stopping");
  });

  describe("publish-terminal precedence over no-active-prompt transport (ARC bug fix)", () => {
    // Stale `sandboxStatus="reconnecting"` after the bridge websocket drops must
    // not mask a settled publish state. Single source of truth: computePhase.
    it("published + reconnecting -> completed with no substate", () => {
      const info = computePhase(withInputs({ publishStatus: "published", sandboxStatus: "reconnecting" }));
      expect(info?.phase).toBe("completed");
      expect(info?.sandboxSubstate).toBe("none");
    });

    it("skipped + reconnecting -> completed", () => {
      expect(computePhase(withInputs({ publishStatus: "skipped", sandboxStatus: "reconnecting" }))?.phase).toBe(
        "completed",
      );
    });

    it("failed + reconnecting -> failed", () => {
      expect(computePhase(withInputs({ publishStatus: "failed", sandboxStatus: "reconnecting" }))?.phase).toBe(
        "failed",
      );
    });

    it("publishing + reconnecting -> finalizing/publishing", () => {
      const info = computePhase(withInputs({ publishStatus: "publishing", sandboxStatus: "reconnecting" }));
      expect(info?.phase).toBe("finalizing");
      expect(info?.finalizingStep).toBe("publishing");
    });

    it("not_started + postExecutionPending + reconnecting -> finalizing/post_execution", () => {
      const info = computePhase(
        withInputs({ publishStatus: "not_started", postExecutionPending: true, sandboxStatus: "reconnecting" }),
      );
      expect(info?.phase).toBe("finalizing");
      expect(info?.finalizingStep).toBe("post_execution");
    });

    it("active prompt + published + reconnecting still returns running/reconnecting", () => {
      // Active user-visible work in flight always beats publish state.
      const info = computePhase(
        withInputs({ activePromptId: "p-1", publishStatus: "published", sandboxStatus: "reconnecting" }),
      );
      expect(info?.phase).toBe("running");
      expect(info?.sandboxSubstate).toBe("reconnecting");
    });

    it("completed terminals survive a non-user stopped sandbox", () => {
      expect(
        computePhase(
          withInputs({
            publishStatus: "not_started",
            mostRecentPromptResultNoChanges: true,
            sandboxStatus: "stopped",
            stopReason: "reaped",
            reviewListeningActive: false,
          }),
        )?.phase,
      ).toBe("completed");
      expect(
        computePhase(
          withInputs({
            publishStatus: "published",
            sandboxStatus: "stopped",
            stopReason: "reaped",
            reviewListeningActive: false,
          }),
        )?.phase,
      ).toBe("completed");
      expect(
        computePhase(
          withInputs({
            publishStatus: "skipped",
            sandboxStatus: "stopped",
            stopReason: "reaped",
            reviewListeningActive: false,
          }),
        )?.phase,
      ).toBe("completed");
    });

    it("non-completed sessions still become resumable stopped after a non-user stopped sandbox", () => {
      const info = computePhase(
        withInputs({
          publishStatus: "not_started",
          mostRecentPromptResultNoChanges: false,
          sandboxStatus: "stopped",
          stopReason: "reaped",
        }),
      );
      expect(info?.phase).toBe("stopped");
      expect(info?.stopMode).toBe("resumable");
    });

    it("user stops still win over completed terminals", () => {
      const info = computePhase(
        withInputs({
          publishStatus: "not_started",
          mostRecentPromptResultNoChanges: true,
          sandboxStatus: "stopped",
          stopReason: "user",
        }),
      );
      expect(info?.phase).toBe("stopped");
      expect(info?.stopMode).toBe("user");
    });

    it("review listening still wins over completed terminals and resumable stopped state", () => {
      expect(
        computePhase(
          withInputs({
            publishStatus: "published",
            sandboxStatus: "stopped",
            stopReason: "reaped",
            reviewListeningActive: true,
          }),
        )?.phase,
      ).toBe("review_listening");
    });

    it("active prompt completed-terminal sessions still become resumable stopped after sandbox stop", () => {
      const published = computePhase(
        withInputs({
          activePromptId: "p-1",
          publishStatus: "published",
          sandboxStatus: "stopped",
          stopReason: "reaped",
          reviewListeningActive: false,
        }),
      );
      expect(published?.phase).toBe("stopped");
      expect(published?.stopMode).toBe("resumable");

      const noChanges = computePhase(
        withInputs({
          activePromptId: "p-1",
          publishStatus: "not_started",
          mostRecentPromptResultNoChanges: true,
          sandboxStatus: "stopped",
          stopReason: "reaped",
          reviewListeningActive: false,
        }),
      );
      expect(noChanges?.phase).toBe("stopped");
      expect(noChanges?.stopMode).toBe("resumable");
    });
  });

  it("maps publishStatus=superseded to a neutral terminal phase", () => {
    const info = computePhase(withInputs({ publishStatus: "superseded", sandboxStatus: undefined }));
    expect(info?.phase).toBe("superseded");
  });

  describe("live-idle user stop supersedes waiting-for-input states (userStopped)", () => {
    // Precedence rule: user intent (stop) beats every waiting_for_input
    // classification — a stopped session is not waiting on anyone — but never
    // un-settles a terminal outcome (published/failed/no-changes/superseded).

    it("userStopped beats plan-approval waiting: kept-alive sandbox lands idle (displays stopped)", () => {
      const info = computePhase(withInputs({ sandboxStatus: "ready", planApprovalPending: true, userStopped: true }));
      expect(info.phase).toBe("idle");
      expect(info.stopMode).toBe("none");
    });

    it("userStopped + plan pending + park-paused sandbox lands stopped/resumable", () => {
      // The plan park's idle-pause writes status="stopped", stopReason=null.
      const info = computePhase(
        withInputs({ sandboxStatus: "stopped", stopReason: null, planApprovalPending: true, userStopped: true }),
      );
      expect(info.phase).toBe("stopped");
      expect(info.stopMode).toBe("resumable");
    });

    it("userStopped beats pending-question waiting: the aborting turn reads running until finalize", () => {
      const info = computePhase(
        withInputs({ activePromptId: "p-1", activePromptHasPendingQuestion: true, userStopped: true }),
      );
      expect(info.phase).toBe("running");

      const stopping = computePhase(
        withInputs({
          activePromptId: "p-1",
          activePromptHasPendingQuestion: true,
          sandboxStatus: "stopping",
          userStopped: true,
        }),
      );
      expect(stopping.phase).toBe("running");
      expect(stopping.sandboxSubstate).toBe("stopping");
    });

    it("plain live-idle user stop still lands idle", () => {
      expect(computePhase(withInputs({ sandboxStatus: "ready", userStopped: true })).phase).toBe("idle");
    });

    it("userStopped does not un-settle terminal outcomes", () => {
      expect(computePhase(withInputs({ publishStatus: "published", userStopped: true })).phase).toBe("completed");
      expect(computePhase(withInputs({ publishStatus: "skipped", userStopped: true })).phase).toBe("completed");
      expect(computePhase(withInputs({ publishStatus: "failed", userStopped: true })).phase).toBe("failed");
      expect(computePhase(withInputs({ publishStatus: "superseded", userStopped: true })).phase).toBe("superseded");
      expect(
        computePhase(
          withInputs({ publishStatus: "not_started", mostRecentPromptResultNoChanges: true, userStopped: true }),
        ).phase,
      ).toBe("completed");
    });

    it("userStopped does not override review listening (the stop boundary exits it server-side)", () => {
      expect(
        computePhase(withInputs({ publishStatus: "published", reviewListeningActive: true, userStopped: true })).phase,
      ).toBe("review_listening");
    });

    it("archived and hard user stop still rank above the live-idle flag", () => {
      expect(
        computePhase(withInputs({ sessionStatus: "archived", planApprovalPending: true, userStopped: true })).phase,
      ).toBe("archived");

      const hardStop = computePhase(
        withInputs({ sandboxStatus: "stopped", stopReason: "user", planApprovalPending: true, userStopped: true }),
      );
      expect(hardStop.phase).toBe("stopped");
      expect(hardStop.stopMode).toBe("user");
    });

    it("omitted or false userStopped preserves the waiting classifications", () => {
      const legacyInputs = withInputs({ sandboxStatus: "ready", planApprovalPending: true });
      delete legacyInputs.userStopped;
      expect(computePhase(legacyInputs).phase).toBe("waiting_for_input");
      expect(
        computePhase(withInputs({ sandboxStatus: "ready", planApprovalPending: true, userStopped: false })).phase,
      ).toBe("waiting_for_input");
      expect(
        computePhase(withInputs({ activePromptId: "p-1", activePromptHasPendingQuestion: true, userStopped: false }))
          .phase,
      ).toBe("waiting_for_input");
    });
  });
});

describe("richStatusFromPhase column projection", () => {
  // After the phase-flip, `session_index.rich_status` stores the phase value
  // directly. Substate (sandboxSubstate / stopMode) is no longer collapsed into
  // the column — it stays on the DO state and rides the session_status frame.
  const cases: Array<[Phase, Partial<{ stopMode: "user" | "resumable" | "none"; sandboxSubstate: string }>]> = [
    ["archived", {}],
    ["idle", {}],
    ["running", {}],
    ["running", { sandboxSubstate: "creating" }],
    ["waiting_for_input", {}],
    ["finalizing", {}],
    ["review_listening", {}],
    ["completed", {}],
    ["blocked", {}],
    ["failed", {}],
    ["stopped", { stopMode: "user" }],
    ["stopped", { stopMode: "resumable" }],
  ];

  it.each(cases)("projects phase=%s with %j to its own phase string", (phase, extras) => {
    const info = {
      phase,
      sandboxSubstate: (extras.sandboxSubstate ?? "none") as "creating" | "reconnecting" | "stopping" | "none",
      stopMode: (extras.stopMode ?? "none") as "user" | "resumable" | "none",
      finalizingStep: "none" as const,
    };
    expect(richStatusFromPhase(info)).toBe(phase);
  });
});

describe("isTerminalPhase", () => {
  it("classifies terminal phases", () => {
    expect(isTerminalPhase("completed")).toBe(true);
    expect(isTerminalPhase("blocked")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("stopped")).toBe(true);
    expect(isTerminalPhase("archived")).toBe(true);
  });

  it("classifies non-terminal phases", () => {
    expect(isTerminalPhase("idle")).toBe(false);
    expect(isTerminalPhase("running")).toBe(false);
    expect(isTerminalPhase("waiting_for_input")).toBe(false);
    expect(isTerminalPhase("finalizing")).toBe(false);
    expect(isTerminalPhase("review_listening")).toBe(false);
  });

  it("superseded is terminal", () => {
    expect(isTerminalPhase("superseded")).toBe(true);
  });
});

describe("idle-auto-pause landing phase is reaper-exempt (resume-stopped-session landmine)", () => {
  it("a live-idle kept-alive VM that idle-auto-pauses lands in the resumable terminal `stopped` phase", () => {
    // durable-object.ts:8293-8302 writes status="stopped", stopReason=null, runtime_state="paused".
    const info = computePhase(withInputs({ sandboxStatus: "stopped", stopReason: null, reviewListeningActive: false }));
    expect(info.phase).toBe("stopped");
    expect(info.stopMode).toBe("resumable");
    // "stopped" ∈ terminal set ⇒ the phase reaper SELECT (cleanup.ts:75) excludes it → never archived.
    expect(isTerminalPhase("stopped")).toBe(true);
    expect(TERMINAL_PHASES_ARRAY).toContain("stopped");
  });

  it("a user-stop kept live-idle (not yet paused) stays non-terminal idle so instant dispatch holds", () => {
    // The kept-alive window: sandbox status="ready", no active prompt → idle (non-terminal).
    const info = computePhase(withInputs({ sandboxStatus: "ready", activePromptId: null }));
    expect(info.phase).toBe("idle");
    expect(isTerminalPhase("idle")).toBe(false);
  });
});
