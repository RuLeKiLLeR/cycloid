// Per-edge unit tests for the ARC-1330 lifecycle-FSM publish spine (PR 6):
// `FINALIZING → PUBLISHING → REVIEW` (with the `init_record` field writes), the
// `FINALIZING`/`PUBLISHING` no-change terminals, the `publish.failed → FAILED` edge, and
// the N9 `PUBLISHING — pr.merged/closed` defensive race (design §9). Pure-fn suite:
// `transition` is a pure function of (state, event, guards), so these import it directly
// and assert the returned Decision per edge — no DB harness.
import { describe, expect, it } from "vitest";

import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";

// Caller-supplied context for the publish edges: the opened PR's URL.
const PUBLISH_GUARDS: Guards = {
  sandboxAlive: true,
  prUrl: "https://github.com/acme/repo/pull/42",
  verificationRunId: 0,
};

describe("transition — FINALIZING post-execution decision", () => {
  it("postexec.done[has_changes] → PUBLISHING / set prompt_intends_change + open_pr", () => {
    const d = transition(
      "FINALIZING",
      { type: "postexec.done", hasChanges: true, promptIntendsChange: true },
      PUBLISH_GUARDS,
    );
    expect(d).toEqual({
      to: "PUBLISHING",
      fieldWrites: { promptIntendsChange: true },
      sideEffects: [{ kind: "open_pr" }],
    });
  });

  it("postexec.done[¬has_changes] → ANSWERED_NO_PR / set prompt_intends_change", () => {
    const d = transition(
      "FINALIZING",
      { type: "postexec.done", hasChanges: false, promptIntendsChange: false },
      PUBLISH_GUARDS,
    );
    expect(d).toEqual({
      to: "ANSWERED_NO_PR",
      fieldWrites: { promptIntendsChange: false },
      sideEffects: [],
    });
  });

  it("persists prompt_intends_change verbatim on the ¬has_changes branch (SF11 projection split)", () => {
    // A diff-intending prompt whose turn produced no diff still records the intent so
    // project() shows "No change produced" rather than "Answered".
    const d = transition(
      "FINALIZING",
      { type: "postexec.done", hasChanges: false, promptIntendsChange: true },
      PUBLISH_GUARDS,
    );
    expect(d?.to).toBe("ANSWERED_NO_PR");
    expect(d?.fieldWrites.promptIntendsChange).toBe(true);
  });
});

describe("transition — PUBLISHING edges", () => {
  it("publish.pr_opened → REVIEW / init_record (pr_url, head, counters reset, run-token mint, spawn verifier)", () => {
    const d = transition("PUBLISHING", { type: "publish.pr_opened", prHead: "deadbeef" }, PUBLISH_GUARDS);
    expect(d).toEqual({
      to: "REVIEW",
      fieldWrites: {
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "deadbeef",
        codeChangedSinceVerification: true,
        verificationRunCount: 0,
        ciFixRounds: 0,
        verificationRunId: 1,
        verificationRunHead: "deadbeef",
        verificationChildId: null,
      },
      sideEffects: [{ kind: "spawn_verification_child" }],
    });
  });

  it("init_record mints run_id = current + 1 (monotonic run token, ABA-safe)", () => {
    const d = transition(
      "PUBLISHING",
      { type: "publish.pr_opened", prHead: "abc123" },
      { ...PUBLISH_GUARDS, verificationRunId: 7 },
    );
    expect(d?.fieldWrites.verificationRunId).toBe(8);
    expect(d?.fieldWrites.verificationRunHead).toBe("abc123");
  });

  it("B5: init_record initializes head_sha from event.pr_head — never null entering REVIEW", () => {
    // The soundness point: head_sha must be a non-null string the moment REVIEW first
    // live-reads ci_green / verification_fresh. It is sourced from the opened PR's head.
    for (const prHead of ["a".repeat(40), "0", "feabc12"]) {
      const d = transition("PUBLISHING", { type: "publish.pr_opened", prHead }, PUBLISH_GUARDS);
      expect(d?.to).toBe("REVIEW");
      expect(d?.fieldWrites.headSha).toBe(prHead);
      expect(d?.fieldWrites.headSha).not.toBeNull();
      expect(typeof d?.fieldWrites.headSha).toBe("string");
    }
  });

  it("publish.no_changes → ANSWERED_NO_PR (N10 net-zero diff, no field writes)", () => {
    const d = transition("PUBLISHING", { type: "publish.no_changes" }, PUBLISH_GUARDS);
    expect(d).toEqual({ to: "ANSWERED_NO_PR", fieldWrites: {}, sideEffects: [] });
  });

  it("publish.failed → FAILED(publish_failed) / loud", () => {
    const d = transition("PUBLISHING", { type: "publish.failed" }, PUBLISH_GUARDS);
    expect(d).toEqual({
      to: "FAILED",
      fieldWrites: { failureReason: "publish_failed" },
      sideEffects: [{ kind: "loud" }],
    });
  });
});

describe("transition — PUBLISHING pr.merged/closed race (N9)", () => {
  // R4: the N9 arms land a FINAL terminal, so they carry `finalTerminalCloseOut` — a null-safe verifier
  // kill (no child is spawned at PUBLISHING) followed by `terminate_runtime` to reclaim the VM.
  const NULL_KILL = { kind: "kill_verification", args: { verificationChildId: null } } as const;
  const TERMINATE_RUNTIME = { kind: "terminate_runtime" } as const;

  it("pr.merged → MERGED (webhook beats publish.pr_opened) + null-safe kill + terminate_runtime", () => {
    const d = transition("PUBLISHING", { type: "pr.merged" }, PUBLISH_GUARDS);
    expect(d).toEqual({ to: "MERGED", fieldWrites: {}, sideEffects: [NULL_KILL, TERMINATE_RUNTIME] });
  });

  it("pr.closed → CLOSED (webhook beats publish.pr_opened) + null-safe kill + terminate_runtime", () => {
    const d = transition("PUBLISHING", { type: "pr.closed" }, PUBLISH_GUARDS);
    expect(d).toEqual({ to: "CLOSED", fieldWrites: {}, sideEffects: [NULL_KILL, TERMINATE_RUNTIME] });
  });
});

describe("transition — publish-spine unhandled events return null (no post-actions)", () => {
  const unhandled: ReadonlyArray<readonly [Parameters<typeof transition>[0], FsmEvent]> = [
    ["FINALIZING", { type: "publish.pr_opened", prHead: "abc" }],
    ["FINALIZING", { type: "user.input" }],
    ["FINALIZING", { type: "pr.merged" }],
    ["PUBLISHING", { type: "postexec.done", hasChanges: true, promptIntendsChange: true }],
    ["PUBLISHING", { type: "user.input" }],
    ["PUBLISHING", { type: "sandbox.ready" }],
  ];

  it.each(unhandled)("%s — %o → null", (state, event) => {
    expect(transition(state, event, PUBLISH_GUARDS)).toBeNull();
  });
});
