import { describe, expect, it } from "vitest";

import {
  attributeSessionOutcome,
  countRealFailedPrompts,
  isHarmfulTerminationReason,
  type SessionOutcomeFacts,
} from "../../apps/control-plane-worker/src/session/lifecycle/session-outcome";

function facts(overrides: Partial<SessionOutcomeFacts> = {}): SessionOutcomeFacts {
  return {
    prCreated: false,
    lastPromptStatus: null,
    completedPromptCount: 0,
    failedPromptCount: 0,
    queuedPromptCount: 0,
    promptCount: 0,
    promptErrorCodes: [],
    closeReason: "user_closed",
    ...overrides,
  };
}

describe("attributeSessionOutcome", () => {
  it("treats a created PR as succeeded regardless of prior failures", () => {
    const out = attributeSessionOutcome(
      facts({
        prCreated: true,
        lastPromptStatus: "completed",
        completedPromptCount: 1,
        failedPromptCount: 2,
        promptCount: 3,
        promptErrorCodes: ["sandbox_disconnected", null],
        closeReason: "user_closed",
      }),
    );
    expect(out.outcome).toBe("succeeded");
    expect(out.reachedTerminal).toBe(true);
    expect(out.terminalStage).toBe("pr_created");
    expect(out.failureCause).toBeNull();
  });

  it("keeps terminalStage consistent with a succeeded outcome after recovering from a failed prompt", () => {
    // Early prompt failed, final prompt completed, no PR: outcome is succeeded, so the
    // stage must read prompt_completed_no_pr, never prompt_failed.
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "completed",
        completedPromptCount: 1,
        failedPromptCount: 1,
        promptCount: 2,
        promptErrorCodes: ["sandbox_disconnected"],
      }),
    );
    expect(out.outcome).toBe("succeeded");
    expect(out.reachedTerminal).toBe(true);
    expect(out.terminalStage).toBe("prompt_completed_no_pr");
    expect(out.failureCause).toBeNull();
  });

  it("treats a completed last prompt with no PR as a succeeded answer", () => {
    const out = attributeSessionOutcome(
      facts({ lastPromptStatus: "completed", completedPromptCount: 1, promptCount: 1 }),
    );
    expect(out.outcome).toBe("succeeded");
    expect(out.terminalStage).toBe("prompt_completed_no_pr");
    expect(out.failureCause).toBeNull();
  });

  it("classifies a session with no prompts as abandoned (excluded from harm)", () => {
    const out = attributeSessionOutcome(facts({ promptCount: 0, closeReason: "user_closed" }));
    expect(out.outcome).toBe("abandoned");
    expect(out.terminalStage).toBe("no_prompts");
    expect(out.failureCause).toBeNull();
  });

  it("treats a user closing an unfinished session with no failure as abandoned", () => {
    const out = attributeSessionOutcome(
      facts({ lastPromptStatus: "processing", queuedPromptCount: 1, promptCount: 1, closeReason: "user_closed" }),
    );
    expect(out.outcome).toBe("abandoned");
  });

  it("treats Slack stop closes as user-initiated abandonment", () => {
    for (const closeReason of ["slack_stop_interaction", "slack_stop_message"]) {
      const out = attributeSessionOutcome(
        facts({ lastPromptStatus: "processing", queuedPromptCount: 1, promptCount: 1, closeReason }),
      );
      expect(out.outcome).toBe("abandoned");
      expect(out.failureCause).toBeNull();
    }
  });

  it("attributes a failed session to the precedence-deduped prompt error code", () => {
    // spawn_timeout outranks sandbox_disconnected in TERMINAL_ERROR_PRECEDENCE.
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 2,
        promptCount: 2,
        promptErrorCodes: ["sandbox_disconnected", "spawn_timeout"],
        closeReason: "sandbox_disconnected",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.terminalStage).toBe("prompt_failed");
    expect(out.failureCause).toBe("spawn_timeout");
  });

  it("falls back to the close reason when no prompt error code is present", () => {
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 1,
        promptCount: 1,
        promptErrorCodes: [null, undefined],
        closeReason: "sandbox_disconnected",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.failureCause).toBe("sandbox_disconnected");
  });

  it("canonicalizes spawn_modal_error to spawn_provider_error", () => {
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 1,
        promptCount: 1,
        promptErrorCodes: ["spawn_modal_error"],
        closeReason: "spawn_modal_error",
      }),
    );
    expect(out.failureCause).toBe("spawn_provider_error");
  });

  it("falls back to unknown when neither prompts nor close reason are valid error codes", () => {
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 1,
        promptCount: 1,
        promptErrorCodes: ["not_a_real_code"],
        closeReason: "publish_push_failed",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.failureCause).toBe("unknown");
  });

  it("treats a non-user close of an unfinished session as failure, not abandonment", () => {
    // queued-but-never-ran prompt killed by a sandbox disconnect = real harm.
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "queued",
        queuedPromptCount: 1,
        promptCount: 1,
        promptErrorCodes: [],
        closeReason: "sandbox_disconnected",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.terminalStage).toBe("queued_unprocessed");
    expect(out.failureCause).toBe("sandbox_disconnected");
    expect(out.terminationReason).toBeNull();
  });

  it("treats a user closing mid-prompt (archive-failed active prompt) as abandoned, not failed", () => {
    // The pre-relaxation guard (failedPromptCount === 0) would have called this failed
    // because the close force-fails the active prompt with session_archived.
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 1,
        realFailedPromptCount: 0,
        promptCount: 1,
        promptErrorCodes: ["session_archived"],
        closeReason: "user_closed",
      }),
    );
    expect(out.outcome).toBe("abandoned");
    expect(out.failureCause).toBeNull();
    // The benign archive force-fail must not read as prompt_failed; the prompt never
    // reached terminal, so the stage stays consistent with the abandoned outcome.
    expect(out.terminalStage).toBe("queued_unprocessed");
  });

  it("keeps a user close with a prior real failure classified as failed", () => {
    // A genuine spawn failure earlier in the session must not be hidden by a later user close.
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 2,
        realFailedPromptCount: 1,
        promptCount: 2,
        promptErrorCodes: ["spawn_timeout", "session_archived"],
        closeReason: "user_closed",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.failureCause).toBe("spawn_timeout");
  });

  it("downgrades a routine-cleanup termination with no real failure to abandoned", () => {
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "queued",
        queuedPromptCount: 1,
        promptCount: 1,
        realFailedPromptCount: 0,
        closeReason: "max_duration",
        terminationReason: "runtime_cleanup",
      }),
    );
    expect(out.outcome).toBe("abandoned");
    expect(out.failureCause).toBeNull();
    expect(out.terminationReason).toBe("runtime_cleanup");
  });

  it("treats a harmful termination (orphan_reaper) with no failed prompt as failed harm", () => {
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "queued",
        queuedPromptCount: 1,
        promptCount: 1,
        realFailedPromptCount: 0,
        closeReason: "system_kill",
        terminationReason: "orphan_reaper",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.terminationReason).toBe("orphan_reaper");
  });

  it("keeps a real failure classified as failed even when a cleanup termination follows", () => {
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 1,
        realFailedPromptCount: 1,
        promptCount: 1,
        promptErrorCodes: ["sandbox_disconnected"],
        closeReason: "max_duration",
        terminationReason: "runtime_cleanup",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.failureCause).toBe("sandbox_disconnected");
    expect(out.terminationReason).toBe("runtime_cleanup");
  });

  it("echoes terminationReason through a succeeded outcome as metadata", () => {
    const out = attributeSessionOutcome(
      facts({ prCreated: true, lastPromptStatus: "completed", promptCount: 1, terminationReason: "orphan_reaper" }),
    );
    expect(out.outcome).toBe("succeeded");
    expect(out.terminationReason).toBe("orphan_reaper");
  });

  it("defaults realFailedPromptCount to failedPromptCount when omitted (backfill behavior)", () => {
    // No realFailedPromptCount provided: a user close with a failed prompt stays failed,
    // matching the original pre-relaxation guard so historical/backfill rows do not shift.
    const out = attributeSessionOutcome(
      facts({
        lastPromptStatus: "failed",
        failedPromptCount: 1,
        promptCount: 1,
        promptErrorCodes: ["sandbox_disconnected"],
        closeReason: "user_closed",
      }),
    );
    expect(out.outcome).toBe("failed");
    expect(out.failureCause).toBe("sandbox_disconnected");
  });
});

describe("countRealFailedPrompts", () => {
  it("excludes the archive-failed active prompt and settled archive/abort failures", () => {
    const count = countRealFailedPrompts(
      [
        { promptId: "a", errorCode: "spawn_timeout" },
        { promptId: "b", errorCode: "session_archived" },
        { promptId: "c", errorCode: "aborted" },
        { promptId: "d", errorCode: null },
      ],
      "d",
    );
    // a is real; b/c benign by code; d benign as the archived active prompt.
    expect(count).toBe(1);
  });

  it("counts a failed prompt with no code and no archive match as real harm", () => {
    expect(countRealFailedPrompts([{ promptId: "x", errorCode: null }], null)).toBe(1);
  });

  it("returns 0 for no failed prompts", () => {
    expect(countRealFailedPrompts([], "anything")).toBe(0);
  });
});

describe("isHarmfulTerminationReason", () => {
  it("classifies live-work kills as harm", () => {
    for (const r of [
      "orphan_reaper",
      "cold_create_unusable",
      "bridge_start_failed",
      "stale_spawn_after_bridge",
    ] as const) {
      expect(isHarmfulTerminationReason(r)).toBe(true);
    }
  });

  it("classifies routine resource-management kills as non-harm", () => {
    for (const r of ["runtime_cleanup", "resume_stale_cleanup", "duplicate_spawn_retry"] as const) {
      expect(isHarmfulTerminationReason(r)).toBe(false);
    }
  });
});
