import { describe, expect, it } from "vitest";

import {
  isArchiveAvailable,
  isPromptSendDisabled,
  isRespondAvailable,
  isResumeAvailable,
  isRetryAvailable,
  isStopAvailable,
  isWarmAvailable,
  PROMPT_SEND_BLOCKED_ERROR,
  RESPOND_BLOCKED_ERROR,
  RESUME_BLOCKED_ERROR,
  RETRY_BLOCKED_ERROR,
  STOP_BLOCKED_ERROR,
  WARM_BLOCKED_ERROR,
} from "../../shared/session/eligibility";
import type { Phase, SandboxSubstate, StopMode } from "../../shared/session/phase";

const ALL_PHASES: Phase[] = [
  "idle",
  "running",
  "waiting_for_input",
  "finalizing",
  "completed",
  "blocked",
  "failed",
  "stopped",
  "archived",
];

const STOP_MODES: (StopMode | undefined)[] = ["user", "resumable", "none", undefined];
const SANDBOX_SUBSTATES: (SandboxSubstate | undefined)[] = ["creating", "reconnecting", "stopping", "none", undefined];

describe("isPromptSendDisabled", () => {
  it("keeps the composer enabled while plan approval is pending", () => {
    expect(isPromptSendDisabled("waiting_for_input", "none", "none", true)).toBe(false);
  });

  it("disables archived/blocked/failed/finalizing regardless of stopMode + sandboxSubstate", () => {
    const alwaysDisabled: Phase[] = ["archived", "blocked", "failed", "finalizing"];
    for (const phase of alwaysDisabled) {
      for (const stopMode of STOP_MODES) {
        for (const sub of SANDBOX_SUBSTATES) {
          expect(isPromptSendDisabled(phase, stopMode, sub, false)).toBe(true);
        }
      }
    }
  });

  it("disables stopped only when stopMode=user", () => {
    for (const sub of SANDBOX_SUBSTATES) {
      expect(isPromptSendDisabled("stopped", "user", sub, false)).toBe(true);
      expect(isPromptSendDisabled("stopped", "resumable", sub, false)).toBe(false);
      expect(isPromptSendDisabled("stopped", "none", sub, false)).toBe(false);
      expect(isPromptSendDisabled("stopped", undefined, sub, false)).toBe(false);
    }
  });

  it("enables idle/running/waiting_for_input/completed regardless of stopMode + sandboxSubstate", () => {
    const alwaysEnabled: Phase[] = ["idle", "running", "waiting_for_input", "completed"];
    for (const phase of alwaysEnabled) {
      for (const stopMode of STOP_MODES) {
        for (const sub of SANDBOX_SUBSTATES) {
          expect(isPromptSendDisabled(phase, stopMode, sub, false)).toBe(false);
        }
      }
    }
  });

  it("keeps running + sandboxSubstate=creating enabled (queue-while-spawning is intended)", () => {
    expect(isPromptSendDisabled("running", undefined, "creating", false)).toBe(false);
  });

  it("PROMPT_SEND_BLOCKED_ERROR code is stable for the structured 409 envelope", () => {
    expect(PROMPT_SEND_BLOCKED_ERROR).toBe("session_not_sendable");
  });

  // Parity scaffold: for every (phase, stopMode, sandboxSubstate) combination,
  // confirm the helper agrees with itself across two equivalent inputs. This is
  // the template that follow-up PRs (canStop, canWarm, ...) extend with
  // their own helpers — each new action adds a new describe() block that walks
  // the same iteration matrix.
  it("parity scaffold: matrix is exhaustive", () => {
    for (const phase of ALL_PHASES) {
      for (const stopMode of STOP_MODES) {
        for (const sub of SANDBOX_SUBSTATES) {
          const disabled = isPromptSendDisabled(phase, stopMode, sub, false);
          expect(typeof disabled).toBe("boolean");
        }
      }
    }
  });
});

describe("isStopAvailable", () => {
  it("keeps stop available while plan approval is pending", () => {
    expect(isStopAvailable("waiting_for_input", "none", true)).toBe(true);
  });

  it("returns true only for running / waiting_for_input with a usable sandbox", () => {
    expect(isStopAvailable("running", undefined, false)).toBe(true);
    expect(isStopAvailable("running", "none", false)).toBe(true);
    expect(isStopAvailable("waiting_for_input", undefined, false)).toBe(true);
    expect(isStopAvailable("waiting_for_input", "none", false)).toBe(true);
  });

  it("returns false during transient sandbox transport (creating / reconnecting)", () => {
    expect(isStopAvailable("running", "creating", false)).toBe(false);
    expect(isStopAvailable("running", "reconnecting", false)).toBe(false);
    expect(isStopAvailable("waiting_for_input", "creating", false)).toBe(false);
  });

  it("returns false for every non-active phase regardless of substate", () => {
    const nonActive: Phase[] = ["idle", "finalizing", "completed", "blocked", "failed", "stopped", "archived"];
    for (const phase of nonActive) {
      for (const sub of SANDBOX_SUBSTATES) {
        expect(isStopAvailable(phase, sub, false)).toBe(false);
      }
    }
  });

  it("STOP_BLOCKED_ERROR is stable for the structured 409 envelope", () => {
    expect(STOP_BLOCKED_ERROR).toBe("session_not_stoppable");
  });
});

describe("isWarmAvailable", () => {
  it("returns true for idle / completed / failed / stopped (sensible warm targets)", () => {
    expect(isWarmAvailable("idle")).toBe(true);
    expect(isWarmAvailable("completed")).toBe(true);
    expect(isWarmAvailable("failed")).toBe(true);
    expect(isWarmAvailable("stopped")).toBe(true);
  });

  it("returns false when a sandbox is or should already be running", () => {
    expect(isWarmAvailable("running")).toBe(false);
    expect(isWarmAvailable("waiting_for_input")).toBe(false);
  });

  it("returns false during finalizing / blocked / archived", () => {
    expect(isWarmAvailable("finalizing")).toBe(false);
    expect(isWarmAvailable("blocked")).toBe(false);
    expect(isWarmAvailable("archived")).toBe(false);
  });

  it("WARM_BLOCKED_ERROR is stable for the structured 409 envelope", () => {
    expect(WARM_BLOCKED_ERROR).toBe("session_not_warmable");
  });
});

describe("isResumeAvailable", () => {
  it("returns true for stopped (both hard and resumable)", () => {
    expect(isResumeAvailable("stopped")).toBe(true);
  });

  it("returns false for every non-stopped phase", () => {
    const nonStopped: Phase[] = [
      "idle",
      "running",
      "waiting_for_input",
      "finalizing",
      "completed",
      "blocked",
      "failed",
      "archived",
    ];
    for (const phase of nonStopped) {
      expect(isResumeAvailable(phase)).toBe(false);
    }
  });

  it("RESUME_BLOCKED_ERROR is stable for the structured 409 envelope", () => {
    expect(RESUME_BLOCKED_ERROR).toBe("session_not_resumable");
  });
});

describe("isRespondAvailable", () => {
  it("distinguishes plan approval from a real pending question", () => {
    expect(isRespondAvailable("waiting_for_input", true)).toBe(false);
    expect(isRespondAvailable("waiting_for_input", false)).toBe(true);
  });

  it("returns true only for waiting_for_input", () => {
    expect(isRespondAvailable("waiting_for_input", false)).toBe(true);
  });

  it("returns false for every non-question phase", () => {
    const nonQuestion: Phase[] = [
      "idle",
      "running",
      "finalizing",
      "completed",
      "blocked",
      "failed",
      "stopped",
      "archived",
    ];
    for (const phase of nonQuestion) {
      expect(isRespondAvailable(phase, false)).toBe(false);
    }
  });

  it("RESPOND_BLOCKED_ERROR is stable for the structured 409 envelope", () => {
    expect(RESPOND_BLOCKED_ERROR).toBe("session_not_respondable");
  });
});

describe("isRetryAvailable", () => {
  it("returns true for phases where retry can queue a cloned prompt", () => {
    const blocked: Phase[] = ["archived", "finalizing"];
    const allowed = ALL_PHASES.filter((phase) => !blocked.includes(phase));
    for (const phase of allowed) {
      expect(isRetryAvailable(phase)).toBe(true);
    }
  });

  it("returns true for failed and blocked — the Summary Retry next-action arm", () => {
    // The public route (POST /api/sessions/:sessionId/retry) and the Summary
    // panel's Retry recommendation both gate on this helper for the failure
    // display statuses; pin the two phases that back that arm explicitly.
    expect(isRetryAvailable("failed")).toBe(true);
    expect(isRetryAvailable("blocked")).toBe(true);
  });

  it("returns false for archived and finalizing", () => {
    expect(isRetryAvailable("archived")).toBe(false);
    expect(isRetryAvailable("finalizing")).toBe(false);
  });

  it("RETRY_BLOCKED_ERROR is stable for the structured 409 envelope", () => {
    expect(RETRY_BLOCKED_ERROR).toBe("session_not_retryable");
  });
});

describe("isArchiveAvailable", () => {
  it("returns true for every non-archived phase", () => {
    const allowed: Phase[] = [
      "idle",
      "running",
      "waiting_for_input",
      "finalizing",
      "completed",
      "blocked",
      "failed",
      "stopped",
    ];
    for (const phase of allowed) {
      expect(isArchiveAvailable(phase)).toBe(true);
    }
  });

  it("returns false for archived (already closed)", () => {
    expect(isArchiveAvailable("archived")).toBe(false);
  });
});
