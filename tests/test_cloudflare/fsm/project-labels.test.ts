// ARC-1330 (PR 29) — the `labels[]` surface of `project(record)` (design §12 "Key labels").
//
// The contract this PR lands:
//   1. `labelsOf(record)` is TOTAL over every one of the 16 spine states (incl. `ARCHIVED`, N8) — no
//      state falls through to `undefined`; every result is a real (possibly empty) label array.
//   2. The §12 "Key labels" mapping is exact in the CODE `verification-*` vocabulary (the design's
//      conceptual `qa-*` labels map to `verification-*`): `REVIEW ∧ verdict=app_breaks` →
//      `verification-needs-work`; `VERIFYING` → `verification-in-progress`; `MERGE_READY` →
//      `review-loop:done` + `verification-done`; every other state (incl. the `NEEDS_YOU`
//      blocked_reason map, which is PR 33) → no labels.
//   3. `project(record).labels` threads the record through that mapping.
//   4. SF12 — NO `qa-*` quoted label literal survives in the projection source (the rename is the QA
//      owner's job; only the `// TODO(qa-rename, …)` marker may name `qa-`, and it is not a label).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CI_FIX_EXHAUSTED_LABEL } from "../../../apps/control-plane-worker/src/constants/pr-labels";
import { FSM_STATES, labelsOf, project } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { FsmRecord, FsmState, Verdict } from "../../../apps/control-plane-worker/src/session/fsm/types";

// A minimal record for the labels surface: only `state` (+ `verdict` for `REVIEW`) is read this PR.
function rec(state: FsmState, verdict: Verdict | null = null): FsmRecord {
  return { state, verdict } as FsmRecord;
}

// The exact §12 "Key labels" table as an INDEPENDENT local oracle (not imported from the impl mapping,
// only the leaf constants) so a drift in the impl fails here. `REVIEW` is verdict-dependent, so it is
// covered separately below; this map is the verdict-INDEPENDENT expectation for every state.
const EXPECTED_NO_APP_BREAKS: Record<FsmState, readonly string[]> = {
  CREATED: [],
  PROVISIONING: [],
  GENERATING: [],
  AWAITING_INPUT: [],
  FINALIZING: [],
  PUBLISHING: [],
  ANSWERED_NO_PR: [],
  REVIEW: [], // QA no longer gates → no in-progress/needs-work label on REVIEW
  VERIFYING: [], // no entering VERIFYING edge remains; drain-only, no label
  MERGE_READY: [], // review-loop:done + verification-done SCRAPPED
  NEEDS_YOU: [], // blocked_reason → label total map is PR 33
  FAILED: [],
  STOPPED: [],
  MERGED: [],
  CLOSED: [],
  SUPERSEDED: [],
  ARCHIVED: [],
};

describe("labelsOf — record → PR labels projection (design §12, totality incl. ARCHIVED)", () => {
  it("is total over the 16 spine states (no fall-through to undefined)", () => {
    expect(FSM_STATES).toHaveLength(17);
    for (const state of FSM_STATES) {
      const labels = labelsOf(rec(state));
      expect(labels, `labelsOf(${state}) must be defined`).toBeDefined();
      expect(Array.isArray(labels), `labelsOf(${state}) must be an array`).toBe(true);
    }
  });

  it.each(FSM_STATES.map((s) => [s] as const))("%s (verdict≠app_breaks) → the §12 label set", (state) => {
    expect(labelsOf(rec(state))).toEqual(EXPECTED_NO_APP_BREAKS[state]);
  });

  it("REVIEW ∧ verdict=app_breaks → no label (QA is a parallel signal now, not a gating label)", () => {
    expect(labelsOf(rec("REVIEW", "app_breaks"))).toEqual([]);
  });

  it.each([["pass"], ["skipped"], ["none"]] as const)(
    "REVIEW ∧ verdict=%s → no label (copy distinguishes the sub-stages, PR 30)",
    (verdict) => {
      expect(labelsOf(rec("REVIEW", verdict))).toEqual([]);
    },
  );

  it("MERGE_READY → no managed labels (review-loop:done / verification-done scrapped)", () => {
    expect(labelsOf(rec("MERGE_READY"))).toEqual([]);
  });

  it("NEEDS_YOU with no blocked_reason → no labels (the per-reason total map is exercised in PR 33's test)", () => {
    expect(labelsOf(rec("NEEDS_YOU"))).toEqual([]);
  });

  it("terminal/cleared states (MERGED/CLOSED/ARCHIVED) → no labels (N8)", () => {
    expect(labelsOf(rec("MERGED"))).toEqual([]);
    expect(labelsOf(rec("CLOSED"))).toEqual([]);
    expect(labelsOf(rec("ARCHIVED"))).toEqual([]);
  });

  it("the surviving NEEDS_YOU terminal constant is the expected literal", () => {
    expect(CI_FIX_EXHAUSTED_LABEL).toBe("ci-fix-exhausted");
  });
});

describe("project(record).labels — aggregate surface threads the record → labels", () => {
  it.each(FSM_STATES.map((s) => [s] as const))("project({ state: %s }).labels matches labelsOf", (state) => {
    expect(project(rec(state)).labels).toEqual(labelsOf(rec(state)));
  });

  it("project surfaces the (now empty) REVIEW+app_breaks label set through the aggregate too", () => {
    expect(project(rec("REVIEW", "app_breaks")).labels).toEqual([]);
  });
});

describe("SF12 — no qa-* quoted label literal in the projection source (the rename is the QA owner's job)", () => {
  // The projection + its label constants. A `qa-*` LABEL literal here would mean the rename leaked
  // into code; the only permitted `qa-` token is the `qa-rename` marker, which is not a quoted label.
  const SOURCES = [
    "../../../apps/control-plane-worker/src/session/fsm/project.ts",
    "../../../apps/control-plane-worker/src/constants/pr-labels.ts",
  ];
  // A quoted label literal that starts with `qa-` (single or double quoted). Excludes `qa-rename`
  // (the intended-rename marker) explicitly so the marker is never a false positive.
  const QA_LABEL_LITERAL = /["'](qa-(?!rename)[a-z0-9:-]+)["']/g;

  it.each(SOURCES)("%s contains no qa-* quoted label literal", (rel) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const hits = [...src.matchAll(QA_LABEL_LITERAL)].map((m) => m[1]);
    expect(hits, `unexpected qa-* label literal(s): ${hits.join(", ")}`).toEqual([]);
  });
});
