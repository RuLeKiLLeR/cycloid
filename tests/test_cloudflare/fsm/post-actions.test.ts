// PR 20 — universal post-actions + the FG-2 conditional `reset_ci_fix_rounds` (ARC-1330, design §7/§8/§15 inv 11/§18.1).
//
// Pure-fn suite (no DB harness): the post-action layer is a pure function of (decision, ctx). Load-bearing cases:
//   FG-2 / inv 11 — no `ci_fix_rounds > 0` survives a transition INTO a post-PR state where `ci_green ∧
//                   no_inflight_epoch` holds, INCLUDING the `epoch.replied`/`epoch.declined` terminals (the
//                   review-refuter gap a per-terminal enumeration left); a pre-publish state never trips it.
//   inc/reset     — mutual exclusion in one `applyEvent`: a ciFix-dispatch (`inc`, `ci_green=false`) survives;
//                   a green quiescent state resets to 0; the design-impossible both-apply lands inv-11-safe at 0.
//   dwell + meta  — `dwell_ms = now − state_entered_at` (0 on the first transition), and the producer-attached
//                   `EventMetadata` threaded through losslessly for the spine to persist on the appended row.
import { describe, expect, it } from "vitest";

import {
  applyArmDeadlinePostAction,
  applyCiFixResetPostAction,
  CI_FIX_RESET_STATES,
  computeDwellMs,
  PROJECT_EFFECT,
  universalPostActions,
} from "../../../apps/control-plane-worker/src/session/fsm/post-actions";
import type { Decision, EventMetadata, FsmState } from "../../../apps/control-plane-worker/src/session/fsm/types";

/** A minimal handled Decision landing in `to` with the given `ci_fix_rounds` field-write (omitted when undefined). */
function decisionTo(to: FsmState, ciFixRounds?: number): Decision {
  return {
    to,
    fieldWrites: ciFixRounds === undefined ? {} : { ciFixRounds },
    sideEffects: [{ kind: "log_noop" }],
  };
}

const GREEN = { ciGreen: true, noInflightEpoch: true };

describe("applyCiFixResetPostAction (FG-2 / §15 inv 11)", () => {
  it("clears ci_fix_rounds when the resulting post-PR state is ci_green ∧ no_inflight_epoch", () => {
    for (const to of CI_FIX_RESET_STATES) {
      const out = applyCiFixResetPostAction(decisionTo(to, 2), GREEN);
      expect(out.fieldWrites.ciFixRounds).toBe(0);
    }
  });

  it("fires on the epoch.replied / epoch.declined terminals (the review-refuter gap — no code change, quiescent green)", () => {
    // Both epoch terminals land back in REVIEW with no ci_fix write of their own; the post-action must still
    // clear a stale carry when the resulting state is ci_green ∧ no_inflight.
    const replied = applyCiFixResetPostAction(decisionTo("REVIEW"), GREEN);
    const declined = applyCiFixResetPostAction(decisionTo("REVIEW"), GREEN);
    expect(replied.fieldWrites.ciFixRounds).toBe(0);
    expect(declined.fieldWrites.ciFixRounds).toBe(0);
  });

  it("does NOT fire when ci is not green (a red signal — the inc path)", () => {
    const out = applyCiFixResetPostAction(decisionTo("REVIEW", 3), { ciGreen: false, noInflightEpoch: true });
    expect(out.fieldWrites.ciFixRounds).toBe(3);
  });

  it("does NOT fire while an epoch is in flight (no_inflight_epoch=false)", () => {
    const out = applyCiFixResetPostAction(decisionTo("REVIEW", 1), { ciGreen: true, noInflightEpoch: false });
    expect(out.fieldWrites.ciFixRounds).toBe(1);
  });

  it("does NOT fire for a pre-publish state even if ci_green is (nonsensically) true", () => {
    for (const to of ["CREATED", "PROVISIONING", "GENERATING", "FINALIZING", "PUBLISHING"] as const) {
      const out = applyCiFixResetPostAction(decisionTo(to, 4), GREEN);
      expect(out.fieldWrites.ciFixRounds).toBe(4);
    }
  });

  it("returns the SAME decision object when it does not fire (no spurious copy)", () => {
    const d = decisionTo("REVIEW", 2);
    expect(applyCiFixResetPostAction(d, { ciGreen: false, noInflightEpoch: false })).toBe(d);
  });

  it("preserves the rest of the field-writes when it fires", () => {
    const d: Decision = {
      to: "REVIEW",
      fieldWrites: { headSha: "abc", codeChangedSinceVerification: false, ciFixRounds: 5 },
      sideEffects: [],
    };
    const out = applyCiFixResetPostAction(d, GREEN);
    expect(out.fieldWrites).toEqual({ headSha: "abc", codeChangedSinceVerification: false, ciFixRounds: 0 });
  });
});

describe("inc/reset mutual exclusion in one applyEvent (FG-2)", () => {
  it("an inc-dispatch (ci_fix_rounds:=N+1) on a red signal survives — reset cannot fire (ci_green=false)", () => {
    // The REVIEW `ci.signal(failing)[no_inflight ∧ under_cap] / inc_ci_fix_rounds` decision.
    const incDecision = decisionTo("REVIEW", 3);
    const out = applyCiFixResetPostAction(incDecision, { ciGreen: false, noInflightEpoch: true });
    expect(out.fieldWrites.ciFixRounds).toBe(3);
  });

  it("a green quiescent self-loop resets to 0 (the FG-2 green `ci.signal` self-loop)", () => {
    const out = applyCiFixResetPostAction(decisionTo("REVIEW"), GREEN);
    expect(out.fieldWrites.ciFixRounds).toBe(0);
  });

  it("a design-impossible both-apply lands inv-11-safe at 0 (reset merged last wins)", () => {
    // If an inc-decision were ever paired with a ci_green∧no_inflight resulting state, inv 11 demands 0.
    const out = applyCiFixResetPostAction(decisionTo("REVIEW", 7), GREEN);
    expect(out.fieldWrites.ciFixRounds).toBe(0);
  });
});

describe("computeDwellMs (§18.1)", () => {
  it("is now − state_entered_at (the inter-event gap)", () => {
    expect(computeDwellMs(1500, 1000)).toBe(500);
    expect(computeDwellMs(42, 42)).toBe(0);
  });

  it("is 0 on the first transition (state_entered_at still null — no prior event)", () => {
    expect(computeDwellMs(9999, null)).toBe(0);
  });
});

describe("applyArmDeadlinePostAction (§7 bucket a / §10)", () => {
  it("stamps state_entered_at := now and deadline_at := now + deadlineMs, preserving edge writes", () => {
    const d = decisionTo("REVIEW", 2);
    const out = applyArmDeadlinePostAction(d, 1000, 500);
    expect(out.fieldWrites).toEqual({ ciFixRounds: 2, stateEnteredAt: 1000, deadlineAt: 1500 });
  });

  it("a null window (no-backstop terminal) still anchors state_entered_at, deadline_at := null", () => {
    const out = applyArmDeadlinePostAction(decisionTo("MERGED"), 2000, null);
    expect(out.fieldWrites.stateEnteredAt).toBe(2000);
    expect(out.fieldWrites.deadlineAt).toBeNull();
  });
});

describe("universalPostActions (the composed §7 post-actions + §18.1 enrichment)", () => {
  const META: EventMetadata = { type: "ci.signal", ciState: "green" };

  it("arms the deadline, applies the FG-2 reset, appends project, and computes dwell + threads metadata", () => {
    const out = universalPostActions(decisionTo("REVIEW", 4), {
      now: 1500,
      stateEnteredAt: 1000,
      deadlineMs: 600,
      ciGreen: true,
      noInflightEpoch: true,
      metadata: META,
    });
    expect(out.decision.fieldWrites).toEqual({
      ciFixRounds: 0, // FG-2 reset fired (post-PR state, ci_green ∧ no_inflight)
      stateEnteredAt: 1500,
      deadlineAt: 2100,
    });
    expect(out.decision.sideEffects.at(-1)).toEqual(PROJECT_EFFECT);
    expect(out.dwellMs).toBe(500);
    expect(out.metadata).toBe(META); // lossless thread-through for the appended row
  });

  it("dwellNeutral SKIPS arm_deadline (W11-V5 SF10) — state_entered_at / deadline_at are NOT re-stamped", () => {
    const out = universalPostActions(decisionTo("REVIEW", 4), {
      now: 9_999,
      stateEnteredAt: 1000,
      deadlineMs: 600,
      ciGreen: false,
      noInflightEpoch: false,
      metadata: null,
      dwellNeutral: true,
    });
    // No stateEnteredAt / deadlineAt field-writes → the committed anchor is preserved (the give-up
    // clock is not pushed out). project + dwell still computed.
    expect(out.decision.fieldWrites.stateEnteredAt).toBeUndefined();
    expect(out.decision.fieldWrites.deadlineAt).toBeUndefined();
    expect(out.decision.sideEffects.at(-1)).toEqual(PROJECT_EFFECT);
    expect(out.dwellMs).toBe(9_999 - 1000); // dwell is still measured from the (unchanged) anchor
  });

  it("keeps a non-zero ci_fix_rounds on a red transition (no reset) while still arming + projecting", () => {
    const out = universalPostActions(decisionTo("REVIEW", 3), {
      now: 200,
      stateEnteredAt: 100,
      deadlineMs: null,
      ciGreen: false,
      noInflightEpoch: true,
      metadata: null,
    });
    expect(out.decision.fieldWrites.ciFixRounds).toBe(3);
    expect(out.decision.fieldWrites.deadlineAt).toBeNull();
    expect(out.decision.fieldWrites.stateEnteredAt).toBe(200);
    expect(out.decision.sideEffects.filter((e) => e.kind === "project")).toHaveLength(1);
    expect(out.dwellMs).toBe(100);
    expect(out.metadata).toBeNull();
  });

  it("appends project exactly once, after the edge's own side-effects", () => {
    const d: Decision = {
      to: "REVIEW",
      fieldWrites: {},
      sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "ci_fix" } }],
    };
    const out = universalPostActions(d, {
      now: 10,
      stateEnteredAt: 0,
      deadlineMs: 5,
      ciGreen: false,
      noInflightEpoch: false,
      metadata: null,
    });
    expect(out.decision.sideEffects).toHaveLength(2);
    expect(out.decision.sideEffects[1]).toEqual(PROJECT_EFFECT);
  });
});
