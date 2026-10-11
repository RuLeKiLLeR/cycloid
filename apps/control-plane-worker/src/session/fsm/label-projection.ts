// ARC-1330 (W11-P2) — the canonical PR-label projection: drive GitHub PR labels from `labelsOf(record)`.
//
// THE MOTIVATING FAILURE MODE. Three hand-maintained label lists — the verification-* axis
// (`VERIFICATION_STATE_LABELS`, `session/verification-state.ts`), the review-loop axis
// (`REVIEW_LOOP_LABEL_META`, `services/review-loop-sweep.ts`), and the head-change teardown set
// (`SYNCHRONIZE_STALE_REVIEW_LOOP_LABELS`, `webhooks/github.ts`) — each derive a label set from
// DIFFERENT legacy session signals and drift independently, so illegal multi-label combinations
// ("verification-done" co-present with "verification-needs-work", a stale "review-loop:done" left on a
// re-opened head) are representable today. `labelsOf(record)` (fsm/project.ts) is the SINGLE canonical
// projection of `(state, verdict, blocked_reason)`; consuming it as the sole label source makes the
// label surface structurally consistent — every illegal combo is unrepresentable by construction (a
// state projects exactly one coherent set).
//
// This module is the PURE core (the managed namespace + META, the record→labels bridge, and the
// reconcile). The GitHub IO writer that applies it lives in `services/fsm-label-sync.ts`.
//
// The FSM is unconditionally live: the legacy writers stand down and this projection is the
// authoritative source of the managed PR-label surface.

import {
  CI_FIX_EXHAUSTED_LABEL,
  INTERNAL_ERROR_LABEL,
  OWNER_APPROVAL_LABEL,
  REVIEW_STUCK_LABEL,
} from "../../constants/pr-labels";
import type { PrCoordinationRecord } from "../pr-coordination-db";
import { labelsOf } from "./project";
import { FSM_STATES, type FsmRecord } from "./types";

/** GitHub label style (color + description) used to `ensureRepoLabel` before an add. */
export interface FsmLabelMeta {
  color: string;
  description: string;
}

/**
 * The COMPLETE managed-label namespace — every Cycloid-owned PR label that `labelsOf` can emit, PLUS the
 * legacy `verification-*` / `review-loop:*` labels that prior writers emitted before PR-E1 scrapped them.
 * This is the reconcile's strip set: a canonical write sets the managed labels to exactly `labelsOf(record)`
 * and leaves every non-managed label (`cycloid`, `cycloid:*`, user labels) untouched. Keeping it exhaustive
 * is what lets the reconcile guarantee no stale managed label (from a prior legacy write or an earlier state)
 * survives.
 *
 * Post PR-E1 the ENTIRE `verification-*` / `review-loop:*` axis is TEARDOWN-ONLY: QA no longer gates the
 * review loop, so `labelsOf` emits NONE of these labels (not `verification-in-progress`/`-done`/`-needs-work`
 * or `review-loop:done` either — the whole axis is gone from the projection). They are kept in the namespace
 * as inline literals — the old `VERIFICATION_STATE_LABELS` / `REVIEW_LOOP_LABEL_META` constants no longer
 * exist — purely so the canonical reconcile STRIPS them from in-flight PRs. Only the surviving NEEDS_YOU
 * terminal labels (from `constants/pr-labels`) are ever emitted.
 */
export const FSM_MANAGED_LABEL_META: Readonly<Record<string, FsmLabelMeta>> = {
  // ── Legacy labels SCRAPPED in PR-E1 — kept in the managed (strip) set as inline literals so the
  // reconcile TEARS THEM DOWN from in-flight PRs. `labelsOf` never emits them; the constants no longer
  // exist. QA no longer gates the review loop, so the whole review-loop:* / verification-* label axis is
  // gone from the projection. ──
  "verification-pending": { color: "d4a72c", description: "(legacy) QA pending — being removed" },
  "verification-in-progress": { color: "1d76db", description: "(legacy) QA in progress — being removed" },
  "verification-done": { color: "0e8a16", description: "(legacy) QA done — being removed" },
  "verification-skipped": { color: "cfd3d7", description: "(legacy) QA skipped — being removed" },
  "verification-stopped": { color: "d73a4a", description: "(legacy) QA stopped — being removed" },
  "verification-exhausted": { color: "b60205", description: "(legacy) QA exhausted — being removed" },
  "verification-needs-work": { color: "d93f0b", description: "(legacy) QA needs-work — being removed" },
  "review-loop:done": { color: "0e8a16", description: "(legacy) review loop caught up — being removed" },
  "review-loop:ci-red": { color: "d73a4a", description: "(legacy) first-pass CI red — being removed" },
  // ── surviving NEEDS_YOU terminal labels (from constants) ──
  [CI_FIX_EXHAUSTED_LABEL]: { color: "b60205", description: "CI fixes exhausted — needs a human" },
  [OWNER_APPROVAL_LABEL]: { color: "5319e7", description: "PR needs owner approval before merge" },
  [REVIEW_STUCK_LABEL]: { color: "d4a72c", description: "Review stalled — needs a human" },
  [INTERNAL_ERROR_LABEL]: { color: "b60205", description: "Cycloid internal inconsistency — needs a human" },
};

/** The managed-label namespace as a set (the reconcile strip set). */
export const FSM_MANAGED_LABELS: ReadonlySet<string> = new Set(Object.keys(FSM_MANAGED_LABEL_META));

const FSM_STATE_SET: ReadonlySet<string> = new Set(FSM_STATES);

/**
 * Bridge a persisted `pr_coordination` row to its canonical projected label set. The DAO types
 * `state`/`verdict`/`blockedReason` loosely (`string | null`); `labelsOf` reads the closed FSM enums.
 * `state` is guarded (like `coerceFsmRecord`/the timeline reader) so a corrupt/unknown state fails
 * LOUDLY here rather than silently projecting an empty set — the writer catches and skips, and a real
 * unknown state is a bug the caller should see. The remaining enum fields ride through as the
 * deliberate loose-persistence → narrow-projection seam (the DB CHECK constraints constrain them).
 */
export function labelsForPersistedRecord(rec: PrCoordinationRecord): readonly string[] {
  if (!FSM_STATE_SET.has(rec.state)) {
    throw new Error(`pr_coordination: unknown FSM state ${JSON.stringify(rec.state)} for label projection`);
  }
  return labelsOf(rec as unknown as FsmRecord);
}

/**
 * Reconcile a PR's current label set toward the canonical desired set. PURE + total: preserves every
 * NON-managed label, sets the managed labels to exactly `desired`. `desired` is expected to be a subset
 * of {@link FSM_MANAGED_LABELS} (every `labelsOf` output is managed) — any stray non-managed entry in
 * `desired` is still carried through (defensive), but the invariant is asserted by the label totality
 * test. Returns the next full set, the managed labels ADDED (net-new to the PR), those REMOVED, and
 * whether the set changed at all (so the caller can skip a no-op write).
 */
export interface LabelReconcileResult {
  next: string[];
  added: string[];
  removed: string[];
  changed: boolean;
}

export function reconcileFsmLabelSet(current: readonly string[], desired: readonly string[]): LabelReconcileResult {
  const desiredSet = new Set(desired);
  const currentSet = new Set(current);
  // Preserve non-managed labels in their current order; the managed axis is replaced wholesale.
  const preserved = current.filter((label) => !FSM_MANAGED_LABELS.has(label));
  const next = [...preserved, ...desired];
  const added = desired.filter((label) => !currentSet.has(label));
  const removed = current.filter((label) => FSM_MANAGED_LABELS.has(label) && !desiredSet.has(label));
  const changed = added.length > 0 || removed.length > 0;
  return { next, added, removed, changed };
}
