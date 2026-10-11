// ARC-1330 (PR 27) — the `prompt_intends_change` projection split for `ANSWERED_NO_PR`.
//
// Two halves of the contract:
//   1. BOTH `postexec.done` branches persist `prompt_intends_change` (the `transition` field write).
//   2. `ANSWERED_NO_PR` projects "Answered" vs "No change produced" from that persisted field.
//
// Together they prove the round-trip: the field the FSM writes at FINALIZING is exactly the field the
// projection later reads — and that the split is total over `boolean | null` (projection-only, D3).
import { describe, expect, it } from "vitest";

import { projectAnsweredNoPr } from "../../../apps/control-plane-worker/src/session/fsm/answered-projection";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";

const GUARDS: Guards = {
  sandboxAlive: true,
  prUrl: "https://github.com/acme/repo/pull/42",
};

describe("projectAnsweredNoPr — ANSWERED_NO_PR stage-section split (design §12)", () => {
  it("prompt_intends_change=true → 'No change produced'", () => {
    expect(projectAnsweredNoPr({ promptIntendsChange: true })).toBe("No change produced");
  });

  it("prompt_intends_change=false → 'Answered'", () => {
    expect(projectAnsweredNoPr({ promptIntendsChange: false })).toBe("Answered");
  });

  it("prompt_intends_change=null (unset) → 'Answered' (total over boolean | null)", () => {
    expect(projectAnsweredNoPr({ promptIntendsChange: null })).toBe("Answered");
  });
});

describe("both postexec.done branches persist prompt_intends_change (the projection source)", () => {
  // The field the projection reads is the field `transition` writes at FINALIZING — verbatim from
  // the event, on BOTH the has_changes (→PUBLISHING) and ¬has_changes (→ANSWERED_NO_PR) branches.
  it.each([true, false] as const)(
    "FINALIZING postexec.done[has_changes, promptIntendsChange=%s] → PUBLISHING sets the field",
    (intends) => {
      const d = transition(
        "FINALIZING",
        { type: "postexec.done", hasChanges: true, promptIntendsChange: intends },
        GUARDS,
      );
      expect(d?.to).toBe("PUBLISHING");
      expect(d?.fieldWrites.promptIntendsChange).toBe(intends);
    },
  );

  it.each([true, false] as const)(
    "FINALIZING postexec.done[¬has_changes, promptIntendsChange=%s] → ANSWERED_NO_PR sets the field, which projects correctly",
    (intends) => {
      const d = transition(
        "FINALIZING",
        { type: "postexec.done", hasChanges: false, promptIntendsChange: intends },
        GUARDS,
      );
      expect(d?.to).toBe("ANSWERED_NO_PR");
      expect(d?.fieldWrites.promptIntendsChange).toBe(intends);
      // Round-trip: feed the written field straight into the projection.
      expect(projectAnsweredNoPr({ promptIntendsChange: d?.fieldWrites.promptIntendsChange ?? null })).toBe(
        intends ? "No change produced" : "Answered",
      );
    },
  );
});
