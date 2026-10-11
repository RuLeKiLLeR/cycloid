// ARC-1330 lifecycle FSM — universal post-actions (Section B, PURE; design §7 / §8 / §15 inv 11 / §18.1).
//
// PURE FUNCTIONS: every export is a function of its arguments — NO DB writes, NO I/O, NO side-effect
// EXECUTION. The Section E `applyEvent` spine (PR 34) calls these on the Decision `transition` returns
// (a HANDLED transition — never an unhandled `null`, which returns early running NO post-actions, §8
// sense i) to realize the design §7 "universal post-actions on every transition":
//
//   • `arm_deadline` (bucket a field-writes) — stamp `state_entered_at := now`, `deadline_at := now +
//     deadline_class(to)`. The caller resolves the per-state window (`deadlineMs`) and `now`, keeping
//     this pure (the existing `armDeadline` action does the field map); a `null` window still anchors
//     the dwell clock (terminal/no-backstop states).
//   • the CONDITIONAL `reset_ci_fix_rounds` (FG-2 / §15 inv 11) — every committed post-PR transition
//     whose RESULTING state satisfies `ci_green ∧ no_inflight_epoch` clears `ci_fix_rounds`. Realized
//     as a post-action (not a per-edge action) so it is STRUCTURAL — an un-annotated edge cannot miss
//     it (the FG-2 review-refuter gap: `epoch.replied`/`epoch.declined` reach a quiescent green with no
//     code change and must clear it too). It can never coincide with `inc_ci_fix_rounds`, which only
//     rides a `¬ci_green` red signal; and if a malformed both-apply ever occurred the reset is merged
//     LAST, so the counter lands at 0 (the inv-11-safe direction — no `ci_fix_rounds > 0` survives).
//   • `project` (bucket b side-effect) — appended to every handled transition's side-effects so the
//     spine's post-commit dispatch re-projects the session card.
//   • `append_event_log` enrichment (§18.1) — `dwell_ms = now − state_entered_at` (the inter-event gap;
//     `0` on the first transition when `state_entered_at` is still null) and the producer-attached
//     `EventMetadata` (O1: observability-only, never read by a guard) threaded through losslessly for
//     the spine to persist on the appended `pr_coordination_events` row.
//
// `bump_version` is intentionally NOT here: `version` is CAS-owned (omitted from `FsmFieldWrites`), so
// the spine's `UPDATE … SET version = version + 1 WHERE version = ?` does it — it is not a Decision
// field-write (§8). The actual DB append/emit/project EXECUTION is the spine's (PR 34); this layer only
// PURELY DESCRIBES the augmented Decision + the enrichment values.

import { armDeadline, resetCiFixRounds } from "./actions";
import type { Decision, EventMetadata, FsmFieldWrites, FsmState, SideEffect } from "./types";

/**
 * The post-PR active loop states where the FG-2 `reset_ci_fix_rounds` post-action can fire (design §15
 * inv 11 — "any post-PR state" with a live `ci_green`/`no_inflight_epoch` read). The pre-publish states
 * (`CREATED…PUBLISHING`) have no CI concept and the resting terminals do not run the loop, so a stale
 * `ci_green=true` there can NEVER trip the reset (defence-in-depth on top of the `ciGreen ∧ noInflight`
 * conjunction the spine supplies).
 */
export const CI_FIX_RESET_STATES: readonly FsmState[] = ["REVIEW", "VERIFYING", "MERGE_READY", "NEEDS_YOU"];

/** The universal bucket-b `project()` post-action (design §7) — re-project the session card after every commit. */
export const PROJECT_EFFECT: SideEffect = { kind: "project" };

/** Merge several `FsmFieldWrites` partials left-to-right (later keys win) — preserves the edge's writes, post-action last. */
function mergeWrites(...parts: readonly FsmFieldWrites[]): FsmFieldWrites {
  return Object.assign({}, ...parts);
}

/**
 * The live-read post-state predicates the FG-2 reset keys on. Both are computed by the spine from the
 * RESULTING record (`decision.to` + its field-writes) BEFORE the reset is applied, so this stays pure:
 *   - `ciGreen` — `reduceCiState(head) ∈ {green, absent}` of the resulting state (false where CI is not read).
 *   - `noInflightEpoch` — no review/ciFix epoch in flight in the resulting state.
 */
export interface CiFixResetContext {
  ciGreen: boolean;
  noInflightEpoch: boolean;
}

/**
 * The conditional universal post-action `reset_ci_fix_rounds` (FG-2 / §15 inv 11). Returns `decision`
 * with `ci_fix_rounds := 0` merged into its field-writes when the RESULTING state is a post-PR loop state
 * AND `ci_green ∧ no_inflight_epoch` both hold; otherwise returns it unchanged. Structural: works on ANY
 * Decision regardless of which edge produced it, so the reset cannot be missed by an un-annotated edge.
 * The reset is merged LAST, so even a (design-impossible) both-apply with `inc_ci_fix_rounds` lands at 0 —
 * inv 11 ("no `ci_fix_rounds > 0` survives into a `ci_green ∧ no_inflight` state") holds either way.
 */
export function applyCiFixResetPostAction(decision: Decision, ctx: CiFixResetContext): Decision {
  if (!CI_FIX_RESET_STATES.includes(decision.to) || !ctx.ciGreen || !ctx.noInflightEpoch) {
    return decision;
  }
  return { ...decision, fieldWrites: mergeWrites(decision.fieldWrites, resetCiFixRounds()) };
}

/**
 * The universal `arm_deadline` post-action (design §7 bucket a / §10). Returns `decision` with the
 * `state_entered_at := now` / `deadline_at := now + deadlineMs` field-writes merged in (reusing the pure
 * `armDeadline` action). The caller resolves `now` and the per-state window `deadlineMs` (= `deadline_class(to)`,
 * `null` for a no-backstop terminal — which still anchors the dwell clock). Pure of its passed inputs.
 */
export function applyArmDeadlinePostAction(decision: Decision, now: number, deadlineMs: number | null): Decision {
  return { ...decision, fieldWrites: mergeWrites(decision.fieldWrites, armDeadline(now, deadlineMs)) };
}

/**
 * `dwell_ms = now − rec.state_entered_at` (design §18.1) — the inter-event gap (`state_entered_at` re-arms
 * on EVERY transition, so this aggregates cleanly per `from_state`). The first transition of a session has
 * no prior `state_entered_at` (still `null`), so dwell is `0` — there is no preceding event to span.
 */
export function computeDwellMs(now: number, stateEnteredAt: number | null): number {
  // Clamp at 0: `now` and `state_entered_at` can come from different hosts/clocks, so under
  // clock skew `now - stateEnteredAt` could be negative — a negative dwell is meaningless and
  // would poison the `stage_dwell_ms` aggregation.
  return stateEnteredAt === null ? 0 : Math.max(0, now - stateEnteredAt);
}

/**
 * The inputs the spine threads into the single universal-post-action call per handled transition.
 *   - `now` / `stateEnteredAt` — the dwell clock + the `arm_deadline` anchor (the record's PRE-commit
 *     `state_entered_at`, read once in `applyEvent` before the CAS, §8/§18.1).
 *   - `deadlineMs` — the resolved `deadline_class(decision.to)` window (`null` = no backstop).
 *   - `ciGreen` / `noInflightEpoch` — the resulting-state live-reads gating the FG-2 reset.
 *   - `metadata` — the producer-attached typed `EventMetadata` (§18.2), persisted as-is on the appended
 *     row; `null` when the producer attached none. Observability-only (O1) — never read by a guard.
 */
export interface UniversalPostActionContext extends CiFixResetContext {
  now: number;
  stateEnteredAt: number | null;
  deadlineMs: number | null;
  metadata: EventMetadata | null;
  /**
   * DWELL-NEUTRAL (W11-V5 SF10): when true, SKIP the `arm_deadline` post-action so `state_entered_at`/
   * `deadline_at` are PRESERVED (not re-stamped to `now`). The spine sets it for a pure-CHURN self-loop
   * in REVIEW or VERIFYING — empty fieldWrites, `log_noop`-only side-effects, no worklist registration (a
   * re-observed ci.signal on an in-flight epoch / during VERIFYING, cascade row-5 ci_pending WAIT,
   * epoch.deferred) — so per-tick churn cannot push the §10 give-up out. AUTHORITY:
   * `transition.isDwellNeutralSelfLoop` (a DECISION-SHAPE rule scoped to {REVIEW, VERIFYING}, so
   * MERGE_READY's intentional reconcile keep-alive still re-arms). Any progress transition (a field-write
   * / registration / non-log_noop effect) re-arms. Defaults false.
   */
  dwellNeutral?: boolean;
}

/** What the spine commits + appends for one handled transition: the post-action-augmented Decision + the §18.1 enrichment. */
export interface UniversalPostActionResult {
  /** The Decision with `arm_deadline` + the conditional `reset_ci_fix_rounds` field-writes merged and `project` appended. */
  decision: Decision;
  /** `now − state_entered_at` (§18.1) — written to the appended `pr_coordination_events.dwell_ms`. */
  dwellMs: number;
  /** The producer-attached metadata, threaded through losslessly — written to `pr_coordination_events.metadata`. */
  metadata: EventMetadata | null;
}

/**
 * Apply the design §7 universal post-actions to one HANDLED transition's Decision and compute the §18.1
 * `append_event_log` enrichment. Composition (order matters only for the `ci_fix_rounds` last-write-wins):
 *   1. `arm_deadline` — stamp `state_entered_at`/`deadline_at`.
 *   2. `reset_ci_fix_rounds` (conditional, FG-2) — merged LAST so it wins inv-11-safe.
 *   3. append `project` (bucket b).
 * plus `dwell_ms` and the threaded `metadata`. PURE — the spine commits the returned Decision under the
 * CAS (where `bump_version` lives) and INSERTs the appended row with `dwell_ms`/`metadata`.
 */
export function universalPostActions(decision: Decision, ctx: UniversalPostActionContext): UniversalPostActionResult {
  // W11-V5 SF10: a dwell-neutral event (epoch.deferred) SKIPS arm_deadline — it journals but does not
  // re-stamp state_entered_at/deadline_at, so the §10 give-up stays anchored to the last real progress
  // and remains reachable under unbounded contention. Every other transition re-arms as before.
  const armed = ctx.dwellNeutral ? decision : applyArmDeadlinePostAction(decision, ctx.now, ctx.deadlineMs);
  const reset = applyCiFixResetPostAction(armed, ctx);
  const withProject: Decision = { ...reset, sideEffects: [...reset.sideEffects, PROJECT_EFFECT] };
  return {
    decision: withProject,
    dwellMs: computeDwellMs(ctx.now, ctx.stateEnteredAt),
    metadata: ctx.metadata,
  };
}
