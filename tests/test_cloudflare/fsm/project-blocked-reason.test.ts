// ARC-1330 (PR 33) — the `blocked_reason` → label/copy total map (design §12 "NEEDS_YOU
// blocked_reason → label/copy", SF10) and its threading through the `labels`/`stageSection`
// projection surfaces.
//
// The contract this PR lands:
//   1. `blockedReasonDisplay(reason)` is TOTAL over the closed `BlockedReason` enum — every reason
//      (incl. `owner_approval` and the §17-D NET-NEW `ci_flapping`) has a non-empty `label` + `copy`.
//   2. The §12 mapping is exact, in the CODE `verification-*`/`ci-*`/`*-error` vocabulary (the design's
//      conceptual `qa-*` copy → `verification`-voiced copy; the four `verification_*` reasons share the
//      `verification-needs-work` label; `ci_fix_exhausted` + `ci_flapping` share `ci-fix-exhausted`).
//   3. `labelsOf({ state: NEEDS_YOU, blockedReason })` projects exactly that reason's single label;
//      with no `blocked_reason` it projects `[]` (the defensive null fallback).
//   4. `stageOf({ state: NEEDS_YOU, blockedReason })` is "Blocked — needs you: <copy>"; with no
//      `blocked_reason` it is the generic "Blocked — needs you".
//   5. `project(record)` threads both surfaces.
//   6. SF12 — no `qa-*` quoted label literal leaks into the map (the rename is the QA owner's job).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CI_FIX_EXHAUSTED_LABEL,
  INTERNAL_ERROR_LABEL,
  OWNER_APPROVAL_LABEL,
  REVIEW_STUCK_LABEL,
} from "../../../apps/control-plane-worker/src/constants/pr-labels";
import {
  blockedReasonDisplay,
  labelsOf,
  project,
  stageOf,
} from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { BlockedReason, FsmRecord } from "../../../apps/control-plane-worker/src/session/fsm/types";

// The closed `blocked_reason` enum (design §12 / tech-spec §4) — a local oracle for the totality sweep.
const BLOCKED_REASONS: readonly BlockedReason[] = [
  "owner_approval",
  "verification_noconverge",
  "verification_unresolved",
  "verification_run_limit",
  "verification_stopped",
  "ci_fix_exhausted",
  "ci_flapping",
  "review_stuck",
  "internal_inconsistency",
];

// The exact §12 total map as an INDEPENDENT local oracle (only the leaf label constants imported, not
// the impl map) so any drift in the impl mapping fails here. Copy is the `verification`-voiced product
// wording (design reads "QA"); the §17-D NET-NEW `ci_flapping` (absent from the design table) shares
// `ci_fix_exhausted`'s label with a distinct copy.
const EXPECTED: Record<BlockedReason, { label: string; copy: string }> = {
  owner_approval: { label: OWNER_APPROVAL_LABEL, copy: "Needs owner approval" },
  verification_noconverge: { label: INTERNAL_ERROR_LABEL, copy: "Verification not converging" },
  verification_unresolved: { label: INTERNAL_ERROR_LABEL, copy: "Verification findings unresolved" },
  verification_run_limit: { label: INTERNAL_ERROR_LABEL, copy: "Verification run limit reached" },
  verification_stopped: { label: INTERNAL_ERROR_LABEL, copy: "Verification stopped / no verdict" },
  ci_fix_exhausted: { label: CI_FIX_EXHAUSTED_LABEL, copy: "CI fixes exhausted" },
  ci_flapping: { label: CI_FIX_EXHAUSTED_LABEL, copy: "CI flapping — needs you" },
  review_stuck: { label: REVIEW_STUCK_LABEL, copy: "Review stalled — needs you" },
  internal_inconsistency: { label: INTERNAL_ERROR_LABEL, copy: "Internal inconsistency — needs you" },
};

function needsYou(blockedReason: BlockedReason | null): FsmRecord {
  return { state: "NEEDS_YOU", blockedReason } as FsmRecord;
}

describe("blockedReasonDisplay — the §12 blocked_reason → label/copy total map (SF10)", () => {
  it("is total over the closed enum — every reason has a non-empty label + copy", () => {
    expect(BLOCKED_REASONS).toHaveLength(9);
    for (const reason of BLOCKED_REASONS) {
      const display = blockedReasonDisplay(reason);
      expect(display, `blockedReasonDisplay(${reason}) must be defined`).toBeDefined();
      expect(display.label.length, `${reason} label non-empty`).toBeGreaterThan(0);
      expect(display.copy.length, `${reason} copy non-empty`).toBeGreaterThan(0);
    }
  });

  it.each(BLOCKED_REASONS.map((r) => [r] as const))("%s → the exact §12 label + copy", (reason) => {
    expect(blockedReasonDisplay(reason)).toEqual(EXPECTED[reason]);
  });

  it("the four (now unreachable) verification_* reasons share the loud internal-error catch-all label", () => {
    for (const reason of [
      "verification_noconverge",
      "verification_unresolved",
      "verification_run_limit",
      "verification_stopped",
    ] as const) {
      expect(blockedReasonDisplay(reason).label).toBe(INTERNAL_ERROR_LABEL);
    }
  });

  it("ci_fix_exhausted and ci_flapping share the ci-fix-exhausted label but carry distinct copy", () => {
    expect(blockedReasonDisplay("ci_fix_exhausted").label).toBe(CI_FIX_EXHAUSTED_LABEL);
    expect(blockedReasonDisplay("ci_flapping").label).toBe(CI_FIX_EXHAUSTED_LABEL);
    expect(blockedReasonDisplay("ci_flapping").copy).not.toBe(blockedReasonDisplay("ci_fix_exhausted").copy);
  });

  it("the net-new label constants are the expected literals (verification-*/ci-*/*-error vocabulary)", () => {
    expect(OWNER_APPROVAL_LABEL).toBe("owner-approval");
    expect(REVIEW_STUCK_LABEL).toBe("review-stuck");
    expect(INTERNAL_ERROR_LABEL).toBe("internal-error");
  });
});

describe("labelsOf — NEEDS_YOU threads the blocked_reason → label map", () => {
  it.each(BLOCKED_REASONS.map((r) => [r] as const))("NEEDS_YOU{%s} → exactly that reason's single label", (reason) => {
    expect(labelsOf(needsYou(reason))).toEqual([EXPECTED[reason].label]);
  });

  it("NEEDS_YOU with no blocked_reason → [] (defensive null fallback)", () => {
    expect(labelsOf(needsYou(null))).toEqual([]);
  });
});

describe("stageOf — NEEDS_YOU splices the per-reason copy", () => {
  it.each(BLOCKED_REASONS.map((r) => [r] as const))("NEEDS_YOU{%s} → 'Blocked — needs you: <copy>'", (reason) => {
    expect(stageOf(needsYou(reason))).toBe(`Blocked — needs you: ${EXPECTED[reason].copy}`);
  });

  it("NEEDS_YOU with no blocked_reason → the generic 'Blocked — needs you'", () => {
    expect(stageOf(needsYou(null))).toBe("Blocked — needs you");
  });
});

describe("project(record) — aggregate threads both NEEDS_YOU surfaces", () => {
  it.each(BLOCKED_REASONS.map((r) => [r] as const))(
    "project(NEEDS_YOU{%s}) labels + stageSection match labelsOf/stageOf",
    (reason) => {
      const p = project(needsYou(reason));
      expect(p.labels).toEqual([EXPECTED[reason].label]);
      expect(p.stageSection).toBe(`Blocked — needs you: ${EXPECTED[reason].copy}`);
    },
  );
});

describe("SF12 — no qa-* quoted label literal in the blocked_reason map source", () => {
  const SOURCES = [
    "../../../apps/control-plane-worker/src/session/fsm/project.ts",
    "../../../apps/control-plane-worker/src/constants/pr-labels.ts",
  ];
  // A quoted label literal starting with `qa-`, excluding the `qa-rename` marker.
  const QA_LABEL_LITERAL = /["'](qa-(?!rename)[a-z0-9:-]+)["']/g;

  it.each(SOURCES)("%s contains no qa-* quoted label literal", (rel) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const hits = [...src.matchAll(QA_LABEL_LITERAL)].map((m) => m[1]);
    expect(hits, `unexpected qa-* label literal(s): ${hits.join(", ")}`).toEqual([]);
  });
});
