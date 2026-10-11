// ARC-1330 lifecycle FSM — the `caught_up` recompute / emitter (Section B, PURE; design §6/§9, B6/F35).
//
// THE BLOCKER FIX (the cascade's producer). The PR-16 8-row `REVIEW.caught_up` cascade and the sole
// `MERGE_READY` door (D10) consume an INTERNAL `caught_up{head}` event — but `caught_up` is not produced
// by any external transport/webhook/cron; NOTHING in the union emits it. This file is that producer: after
// any committed transition, the spine recomputes `caught_up` and, if it newly holds for the live head,
// feeds one internal `caught_up{head}` event back into `applyEvent`.
//
// PURE FUNCTIONS: every export is a function of its arguments — NO DB reads/writes, NO I/O, NO event
// feeding, NO side-effect EXECUTION. The Section E `applyEvent` spine (PR 34) wires these into the write
// path: it classifies the just-committed transition, recomputes the conjunction off the already-loaded
// snapshot, and itself re-enters `applyEvent` with the returned event. The `caught_up` CONJUNCTION
// (`no_inflight_epoch ∧ 0 undispositioned ∧ reviewers settled`, EXCLUDES `ci_green`, D11) is NOT
// re-implemented here — it reuses the PR-9 `caughtUp()` guard. This file owns only the recompute-COMPLETENESS
// (the design §6 trigger set) and the emit decision (when the conjunction newly holds, in REVIEW).
//
// The design §6 recompute set — every transition that changes a cascade input or re-enters REVIEW must
// re-run the cascade (recompute-completeness, B6/SF5). The SIX triggers:
//   1. epoch_terminal    — every `epoch.{committed,replied,declined}` (a disposition just landed).
//   2. review_received   — every `review.received` (an actionable item may have registered).
//   3. ci_green_flip     — a `ci.signal(green|absent)` live-read flip (or the CI re-poll).
//   4. verification_verdict_return — entry to REVIEW from the QA-verdict return (`record_qa`, VERIFYING → REVIEW): a
//                          clean pass returning to an empty queue must evaluate the cascade ON ARRIVAL,
//                          else the sole MERGE_READY door never opens (B6 happy-path stall).
//   5. review_reopen     — entry to REVIEW from a `NEEDS_YOU`/`MERGE_READY` re-open: the triggering review
//                          is consumed by the re-open, so the cascade must be evaluated on arrival.
//   6. publish_pr_opened  — entry to REVIEW from init_record (PUBLISHING → REVIEW).
//
// Idempotent: re-emitting when already-true is a `log_noop`. The emit is gated on the RESULTING state being
// REVIEW (the only state with a `caught_up` edge, D10), so an already-Ready session — which sits in
// MERGE_READY, not REVIEW — never re-emits; and even a raced `caught_up` reaching a non-REVIEW state is
// unhandled by `transition` (→ `null` → the spine's `log_noop`), so both layers fail safe.

import { caughtUp, type CaughtUpStore } from "./guards";
import type { FsmEvent, FsmState } from "./types";

/**
 * The design §6 recompute-trigger set (the recompute-COMPLETENESS class). Any transition that changes a
 * cascade input (`code_changed`, `ci_green`, dispositions, `qa_*`) or re-enters REVIEW must re-run the
 * cascade — these six name every such trigger. PR 21 asserts each is wired (the recompute-completeness
 * invariant) against this list.
 */
export type CaughtUpRecomputeTrigger =
  | "epoch_terminal"
  | "review_received"
  | "ci_green_flip"
  | "verification_verdict_return"
  | "review_reopen"
  | "publish_pr_opened";

/** Runtime list of every §6 recompute trigger — the PR-21 recompute-completeness assertion enumerates this. */
export const CAUGHT_UP_RECOMPUTE_TRIGGERS = [
  "epoch_terminal",
  "review_received",
  "ci_green_flip",
  "verification_verdict_return",
  "review_reopen",
  "publish_pr_opened",
] as const satisfies readonly CaughtUpRecomputeTrigger[];

// Exhaustiveness (compiled, not exported): every `CaughtUpRecomputeTrigger` is a key (missing one → tsc
// "missing property"; extra → "not assignable"). `src/` IS typechecked, so this is the real completeness
// proof that the list above stays in lockstep with the union as triggers are added/removed.
const _TRIGGER_PRESENCE: Record<CaughtUpRecomputeTrigger, true> = {
  epoch_terminal: true,
  review_received: true,
  ci_green_flip: true,
  verification_verdict_return: true,
  review_reopen: true,
  publish_pr_opened: true,
};
void _TRIGGER_PRESENCE;

/** The internal `caught_up{head}` event — the cascade's producer output (the only thing that emits it). */
export type CaughtUpEvent = Extract<FsmEvent, { type: "caught_up" }>;

/** Every recompute trigger is derivable from a committed transition. */
export type TransitionCaughtUpTrigger = CaughtUpRecomputeTrigger;

/**
 * Classify a just-committed transition `from --event--> to` as the design §6 recompute trigger it matches,
 * or `null` when it is none (no recompute fires). PURE.
 *
 * State-entry triggers (4/5) are keyed on the `(from, to)` shape — they fire regardless of WHICH event drove
 * the re-entry (a head.changed re-open re-QAs, a clean re-open settles), exactly the §6 "evaluate on arrival"
 * requirement. The self-loop triggers (1/2/3) are keyed on the event within a `to === REVIEW` self-loop.
 */
export function classifyCaughtUpTrigger(
  from: FsmState,
  event: FsmEvent,
  to: FsmState,
): TransitionCaughtUpTrigger | null {
  // §6.5 — entry to REVIEW from the QA-verdict return (`record_qa`): VERIFYING → REVIEW (a fresh-accept
  // verdict exit). The FG-1 ghost-discard is a VERIFYING → VERIFYING self-loop (to ≠ REVIEW), so it is
  // correctly NOT a trigger.
  if (from === "VERIFYING" && to === "REVIEW") return "verification_verdict_return";
  // §6.6 — entry to REVIEW from a NEEDS_YOU/MERGE_READY re-open (the triggering review/head/retrigger is
  // consumed by the re-open). Covers every re-open edge, including a head.changed re-open (which the
  // recompute correctly routes through the cascade to re-QA).
  if ((from === "MERGE_READY" || from === "NEEDS_YOU") && to === "REVIEW") return "review_reopen";
  // §6.7 — publish arrival (publish.pr_opened landing in REVIEW): a freshly-opened PR with an empty
  // worklist and green CI must evaluate the cascade ON ARRIVAL (else a no-reviewer/green PR never settles).
  // Keyed on the EVENT, not the (from,to) pair, so a future non-publish PUBLISHING→REVIEW edge cannot misclassify.
  if (event.type === "publish.pr_opened" && to === "REVIEW") return "publish_pr_opened";
  // The remaining triggers are REVIEW self-loops keyed on the event. Anything not landing back in REVIEW
  // (a VERIFYING queue, a non-actionable MERGE_READY/NEEDS_YOU noop, a terminal) is not a recompute trigger.
  if (to !== "REVIEW") return null;
  switch (event.type) {
    // §6.1 — every epoch terminal: a disposition just landed (or a real head advanced on `epoch.committed`),
    // or a no-actionable-work settle just cleared the in-flight marker (`epoch.settled`) — either re-opens
    // `no_inflight_epoch`, so the cascade must re-run to re-derive advance / re-dispatch / exhaust.
    case "epoch.committed":
    case "epoch.replied":
    case "epoch.declined":
    case "epoch.settled":
      return "epoch_terminal";
    // §6.2 — every `review.received` (a self-loop here; the re-open case is caught by §6.6 above).
    case "review.received":
      return "review_received";
    // §6.4 — a `ci_green` live-read flip: only the green/absent signal (FG-4: a `failing` signal drives the
    // reactive ciFix self-loop, NOT a caught_up recompute — caught_up excludes ci, it would never newly hold
    // on a red, and the cascade's own row 3/4 owns red).
    case "ci.signal":
      return event.ciState === "failing" ? null : "ci_green_flip";
    default:
      return null;
  }
}

/**
 * The inputs the spine threads into one recompute — all SYNCHRONOUS reads of the already-loaded post-commit
 * record + snapshot store (no I/O at call time), so the recompute stays pure.
 *   - `resultingState` — the post-commit state (`decision.to`, or the current state for the no-show alarm).
 *   - `headSha`        — the live PR head (the record's `head_sha`) that the emitted `caught_up{head}` carries.
 *   - `noInflightEpoch`— the PR-9 `no_inflight_epoch` guard result (also a `caught_up` conjunct).
 *   - `store`          — the disposition + reviewer-settle snapshot the PR-9 `caughtUp()` conjunction reads.
 */
export interface CaughtUpRecomputeInput {
  resultingState: FsmState;
  headSha: string | null;
  noInflightEpoch: boolean;
  store: CaughtUpStore;
}

/**
 * Recompute `caught_up` after a §6 trigger and return the internal `caught_up{head}` event to re-feed into
 * `applyEvent` — or `null` when nothing should be emitted. PURE. Emits IFF all three hold:
 *   1. the resulting state is REVIEW — `caught_up`'s only edge (the sole MERGE_READY door, D10). Outside
 *      REVIEW the event is unhandled (a `log_noop`), so emitting would be wasted — and an already-Ready
 *      session is in MERGE_READY, not REVIEW, which is exactly the IDEMPOTENCE (re-emitting when already-true
 *      is a no-op).
 *   2. the §6 conjunction holds — reuses the PR-9 `caughtUp()` (`no_inflight_epoch ∧ 0 undispositioned ∧
 *      reviewers settled`, EXCLUDES `ci_green`; ci is the cascade's job downstream, D11).
 *   3. the live head is present — a REVIEW session always has one (`init_record` stamps it, B5); a `null`
 *      head is a defensive no-emit (never fabricate a `caught_up` for a headless record).
 */
export function recomputeCaughtUp(input: CaughtUpRecomputeInput): CaughtUpEvent | null {
  if (input.resultingState !== "REVIEW") return null;
  if (!caughtUp(input.noInflightEpoch, input.store)) return null;
  if (input.headSha === null) return null;
  return { type: "caught_up", headSha: input.headSha };
}
