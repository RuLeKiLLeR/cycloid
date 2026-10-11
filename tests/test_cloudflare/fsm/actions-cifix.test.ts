// PR 12 — ci_fix + block/terminal-bookkeeping action tests (ARC-1330, design §9 / §4 writer table).
//
// Pure-fn suite (no DB harness): each action is a pure function from its live-read inputs to the
// `FsmFieldWrites` partial the edge applies. Load-bearing cases:
//   ci_fix    — `inc_ci_fix_rounds` is the ONLY writer that advances the round counter (`+= 1`),
//               pure of its live-read input; `reset_ci_fix_rounds` zeroes it unconditionally.
//   block     — `set_blocked_reason`/`clear_block` and `set_failure_reason`/`clear_failure_reason`
//               are the set/clear pairs (D14/N6); each writes ONLY its own field.
//   stop      — `set_stop` writes `stop_mode` + `pre_stop_state` together (the →STOPPED concern).
//   deadline  — `arm_deadline` stamps `state_entered_at := now` always, `deadline_at := now+Δ`
//               (or null for a no-backstop terminal state), and is pure of its passed inputs.
import { describe, expect, it } from "vitest";

import {
  armDeadline,
  clearBlock,
  clearFailureReason,
  incCiFixRounds,
  resetCiFixRounds,
  setBlockedReason,
  setCodeChanged,
  setFailureReason,
  setStop,
} from "../../../apps/control-plane-worker/src/session/fsm/actions";

describe("inc_ci_fix_rounds", () => {
  it("advances the round counter by exactly 1 from the live-read current value", () => {
    expect(incCiFixRounds(0)).toEqual({ ciFixRounds: 1 });
    expect(incCiFixRounds(2)).toEqual({ ciFixRounds: 3 });
  });

  it("writes ONLY ci_fix_rounds (no other field)", () => {
    expect(Object.keys(incCiFixRounds(1))).toEqual(["ciFixRounds"]);
  });
});

describe("reset_ci_fix_rounds", () => {
  it("zeroes the round counter unconditionally (pure, no input)", () => {
    expect(resetCiFixRounds()).toEqual({ ciFixRounds: 0 });
  });

  it("writes ONLY ci_fix_rounds", () => {
    expect(Object.keys(resetCiFixRounds())).toEqual(["ciFixRounds"]);
  });
});

describe("inc/reset writer split", () => {
  it("inc is the only round-count advancer; reset always lands at 0", () => {
    expect(incCiFixRounds(4).ciFixRounds).toBe(5);
    expect(resetCiFixRounds().ciFixRounds).toBe(0);
  });
});

describe("set_code_changed", () => {
  it("sets code_changed_since_verification := true and nothing else", () => {
    expect(setCodeChanged()).toEqual({ codeChangedSinceVerification: true });
  });
});

describe("set_blocked_reason / clear_block", () => {
  it("set stamps the closed-enum blocked_reason, writing ONLY that field", () => {
    expect(setBlockedReason("ci_fix_exhausted")).toEqual({ blockedReason: "ci_fix_exhausted" });
    expect(setBlockedReason("owner_approval")).toEqual({ blockedReason: "owner_approval" });
  });

  it("clear_block drops blocked_reason to null (none outside NEEDS_YOU, N6)", () => {
    expect(clearBlock()).toEqual({ blockedReason: null });
  });

  it("neither touches failure_reason", () => {
    expect("failureReason" in setBlockedReason("review_stuck")).toBe(false);
    expect("failureReason" in clearBlock()).toBe(false);
  });
});

describe("set_failure_reason / clear_failure_reason", () => {
  it("set stamps the closed-enum failure_reason, writing ONLY that field", () => {
    expect(setFailureReason("codegen_error")).toEqual({ failureReason: "codegen_error" });
    expect(setFailureReason("publish_failed")).toEqual({ failureReason: "publish_failed" });
    expect(setFailureReason("post_prep_failed")).toEqual({ failureReason: "post_prep_failed" });
  });

  it("clear_failure_reason drops failure_reason to null (the FAILED→PROVISIONING retrigger clear)", () => {
    expect(clearFailureReason()).toEqual({ failureReason: null });
  });

  it("neither touches blocked_reason", () => {
    expect("blockedReason" in setFailureReason("sandbox_failed")).toBe(false);
    expect("blockedReason" in clearFailureReason()).toBe(false);
  });
});

describe("set_stop (stop_mode + pre_stop_state)", () => {
  it("writes both stop bookkeeping fields together (the →STOPPED concern)", () => {
    expect(setStop("resumable", "AWAITING_INPUT")).toEqual({
      stopMode: "resumable",
      preStopState: "AWAITING_INPUT",
    });
    expect(setStop("user", "REVIEW")).toEqual({
      stopMode: "user",
      preStopState: "REVIEW",
    });
  });

  it("writes ONLY the two stop fields", () => {
    expect(Object.keys(setStop("user", "VERIFYING")).sort()).toEqual(["preStopState", "stopMode"]);
  });
});

describe("arm_deadline", () => {
  it("stamps state_entered_at := now and deadline_at := now + Δ", () => {
    expect(armDeadline(1000, 500)).toEqual({
      stateEnteredAt: 1000,
      deadlineAt: 1500,
    });
  });

  it("a null deadline window (no-backstop terminal) writes deadline_at := null but still anchors dwell", () => {
    expect(armDeadline(2000, null)).toEqual({
      stateEnteredAt: 2000,
      deadlineAt: null,
    });
  });

  it("is pure of its passed inputs (always anchors state_entered_at to now)", () => {
    expect(armDeadline(42, 8).stateEnteredAt).toBe(42);
    expect(armDeadline(42, 8).deadlineAt).toBe(50);
  });
});
