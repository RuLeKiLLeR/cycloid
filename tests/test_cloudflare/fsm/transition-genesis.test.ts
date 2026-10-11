// Per-edge unit tests for the ARC-1330 lifecycle-FSM genesis/codegen spine (PR 5).
// Pure-fn suite: `transition` is a pure function of (state, event, guards), so these
// import it directly and assert the returned Decision per edge — no DB harness. Every
// edge in design §9's genesis/codegen block is covered, plus the `null`-on-unhandled
// contract (an unhandled event → no Decision → the caller runs no post-actions).
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";

const SANDBOX_ALIVE: Guards = { sandboxAlive: true };
const SANDBOX_DEAD: Guards = { sandboxAlive: false };

describe("transition — genesis edges", () => {
  it("CREATED — sandbox.spawn_requested → PROVISIONING / spawn_sandbox", () => {
    const d = transition("CREATED", { type: "sandbox.spawn_requested" }, SANDBOX_ALIVE);
    expect(d).toEqual({
      to: "PROVISIONING",
      fieldWrites: {},
      sideEffects: [{ kind: "spawn_sandbox" }],
    });
  });

  it("PROVISIONING — sandbox.ready → GENERATING / dispatch_prompt", () => {
    const d = transition("PROVISIONING", { type: "sandbox.ready" }, SANDBOX_ALIVE);
    expect(d).toEqual({
      to: "GENERATING",
      fieldWrites: {},
      sideEffects: [{ kind: "dispatch_prompt" }],
    });
  });
});

describe("transition — codegen edges", () => {
  it("GENERATING — prompt.enqueued → GENERATING (self-loop) / dispatch_prompt", () => {
    const d = transition("GENERATING", { type: "prompt.enqueued" }, SANDBOX_ALIVE);
    expect(d).toEqual({
      to: "GENERATING",
      fieldWrites: {},
      sideEffects: [{ kind: "dispatch_prompt" }],
    });
    // Handled self-loop (sense ii): a real Decision with to === from, NOT a null noop.
    expect(d).not.toBeNull();
    expect(d?.to).toBe("GENERATING");
  });

  it("GENERATING — prompt.awaiting_input → AWAITING_INPUT (no side effects)", () => {
    const d = transition("GENERATING", { type: "prompt.awaiting_input" }, SANDBOX_ALIVE);
    expect(d).toEqual({ to: "AWAITING_INPUT", fieldWrites: {}, sideEffects: [] });
  });

  it("AWAITING_INPUT — user.input → GENERATING / dispatch_prompt", () => {
    const d = transition("AWAITING_INPUT", { type: "user.input" }, SANDBOX_ALIVE);
    expect(d).toEqual({
      to: "GENERATING",
      fieldWrites: {},
      sideEffects: [{ kind: "dispatch_prompt" }],
    });
  });

  it("GENERATING — prompt.terminal[changes] → FINALIZING", () => {
    const d = transition("GENERATING", { type: "prompt.terminal", outcome: "changes" }, SANDBOX_ALIVE);
    expect(d).toEqual({ to: "FINALIZING", fieldWrites: {}, sideEffects: [] });
  });

  it("GENERATING — prompt.terminal[no_changes] → ANSWERED_NO_PR", () => {
    const d = transition("GENERATING", { type: "prompt.terminal", outcome: "no_changes" }, SANDBOX_ALIVE);
    expect(d).toEqual({ to: "ANSWERED_NO_PR", fieldWrites: {}, sideEffects: [] });
  });

  it("GENERATING — prompt.terminal[error] → FAILED(codegen_error) / loud", () => {
    const d = transition("GENERATING", { type: "prompt.terminal", outcome: "error" }, SANDBOX_ALIVE);
    expect(d).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "codegen_error" },
      sideEffects: [{ kind: "loud" }],
    });
  });

  it("GENERATING — prompt.terminal[error, errorCode≠aborted] keeps FAILED(codegen_error) / loud", () => {
    const d = transition(
      "GENERATING",
      { type: "prompt.terminal", outcome: "error", errorCode: "unknown" },
      SANDBOX_ALIVE,
    );
    expect(d).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "codegen_error" },
      sideEffects: [{ kind: "loud" }],
    });
  });

  it("GENERATING — prompt.terminal[error, aborted + stoppedByUser] → STOPPED(user) QUIET (a user stop is not a codegen failure)", () => {
    const d = transition(
      "GENERATING",
      { type: "prompt.terminal", outcome: "error", errorCode: "aborted", stoppedByUser: true },
      SANDBOX_ALIVE,
    );
    expect(d).toEqual({
      to: "STOPPED",
      fieldWrites: { stopMode: "user", preStopState: "GENERATING" },
      sideEffects: [{ kind: "kill_verification", args: { verificationChildId: null } }],
    });
  });

  it("GENERATING — an UNCORROBORATED aborted terminal stays FAILED(codegen_error) / loud (bridge 'aborted' is overloaded)", () => {
    // classifyError's ABORTED_PATTERN, external session deletes, and failsafe aborts all emit
    // errorCode "aborted" with NO user stop — without the DO's stoppedByUser corroboration these are
    // genuine failures and must stay loud.
    const d = transition(
      "GENERATING",
      { type: "prompt.terminal", outcome: "error", errorCode: "aborted" },
      SANDBOX_ALIVE,
    );
    expect(d).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "codegen_error" },
      sideEffects: [{ kind: "loud" }],
    });
  });
});

describe("transition — ANSWERED_NO_PR follow-up fork", () => {
  it("user.input[sandbox_alive] → GENERATING / dispatch_prompt", () => {
    const d = transition("ANSWERED_NO_PR", { type: "user.input" }, SANDBOX_ALIVE);
    expect(d).toEqual({
      to: "GENERATING",
      fieldWrites: {},
      sideEffects: [{ kind: "dispatch_prompt" }],
    });
  });

  it("user.input[sandbox_dead] → PROVISIONING / spawn_sandbox", () => {
    const d = transition("ANSWERED_NO_PR", { type: "user.input" }, SANDBOX_DEAD);
    expect(d).toEqual({
      to: "PROVISIONING",
      fieldWrites: {},
      sideEffects: [{ kind: "spawn_sandbox" }],
    });
  });
});

describe("transition — unhandled events return null (no post-actions)", () => {
  // (state, event) pairs with no PR-5 edge: each must be the sense-(i) unhandled noop.
  const unhandled: ReadonlyArray<readonly [Parameters<typeof transition>[0], FsmEvent]> = [
    ["CREATED", { type: "sandbox.ready" }],
    ["CREATED", { type: "user.input" }],
    ["PROVISIONING", { type: "prompt.enqueued" }],
    ["GENERATING", { type: "sandbox.ready" }],
    ["GENERATING", { type: "user.input" }],
    ["AWAITING_INPUT", { type: "prompt.enqueued" }],
    ["ANSWERED_NO_PR", { type: "prompt.enqueued" }],
    // States with no PR-5 edges at all (added in later PRs) are also unhandled here.
    ["REVIEW", { type: "user.input" }],
    ["FINALIZING", { type: "user.input" }],
  ];

  it.each(unhandled)("%s — %o → null", (state, event) => {
    expect(transition(state, event, SANDBOX_ALIVE)).toBeNull();
  });
});
