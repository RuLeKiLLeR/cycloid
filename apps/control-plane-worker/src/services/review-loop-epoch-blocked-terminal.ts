// ARC-1330 blocked-epoch class — the spine terminal for a just-blocked review-loop epoch.
//
// Legacy `markReviewLoopEpochBlocked` writes `status='blocked'` to `pr_review_response_epochs` but never
// emitted a spine `epoch.*` terminal, so `pr_coordination.in_flight_epoch_id` stranded and the PR wedged
// in REVIEW (caught_up's `no_inflight_epoch` conjunct stuck false). This module maps a legacy block
// reason to the terminal that un-strands it.
//
// RUNTIME LEAF (deliberate): the only top-level imports here are `import type` (erased by esbuild), and
// every runtime dependency is a DYNAMIC import inside the function. `review-loop-epochs` sits in a module
// cycle with `review-producer` and is dynamically imported by `live-side-effects` during dispatch; a
// STATIC runtime edge from this file (which the sweep imports, and which `live-side-effects` in turn
// dynamically imports) into that cycle perturbs its init order and broke the live review-producer
// dispatch test. Keeping this file edge-free at eval time avoids that.

import type { EpochTerminalKind } from "../session/fsm/epoch-producer";
import type { Env } from "../types";
import type { ReviewLoopEpoch } from "./review-loop-epochs";

// Three routes:
//   • `response_failed` — an agent fix/reply POST failed past its retry cap, or its runtime died
//     unrecoverably mid-response; the caught_up cascade cannot re-derive either from ground truth →
//     epoch.blocked{response_failed} → NEEDS_YOU.
//   • `skip` — the "loop is intentionally not acting / the session moved on" set (mirrors
//     review-loop-rollup's DISABLED_BLOCKED_REASONS). These legacy rows can still retain the in-flight
//     marker, so they use the same marker-clearing terminal as the settled cohort; the terminal reducer
//     preserves the projected REVIEW/terminal state.
//   • `settled` — everything else (head_changed, CI-cap exhaustion owned by cascade row 4, missing
//     installation, pr merged/closed, transient/attempt/no-progress caps, and `review_handling_disabled`
//     — manual review mode, ARC-1514): clear the marker and let the cascade / head / terminal producer
//     re-derive. This is the class that actually strands + wedges. `review_handling_disabled` is NOT a
//     `skip` reason: the session is still review-listening (the CI arm keeps running), so its marker must
//     be cleared here AND its registered items dispositioned (see the manual-mode branch below) so
//     `caught_up → CI-ladder → MERGE_READY` stays reachable.
// Pure + total.
const RESPONSE_FAILED_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "publish_failed",
  "reply_failed",
  "runtime_unrecoverable",
]);
const SKIP_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "auto_response_disabled",
  "ci_response_disabled",
  "empty_expected_bots",
  "expected_bots_changed",
  "merge_conflict_resolution_disabled",
  "session_not_review_listening",
  "session_mismatch",
]);

export function classifyBlockedEpochSpineTerminal(blockReason: string): "settled" | "response_failed" | "skip" {
  if (RESPONSE_FAILED_BLOCK_REASONS.has(blockReason)) return "response_failed";
  if (SKIP_BLOCK_REASONS.has(blockReason)) return "skip";
  return "settled";
}

/**
 * Emit the spine terminal for a just-blocked epoch so `in_flight_epoch_id` clears (the missing terminal
 * that stranded the marker). Routes by `classifyBlockedEpochSpineTerminal`: `response_failed` →
 * `epoch.blocked{response_failed}` (→ NEEDS_YOU), everything else → `epoch.settled` (→ REVIEW, cascade
 * re-derives). Best-effort — `shadowEmitReviewLoopEpochTerminal` is try-caught OFF the legacy block path.
 */
export async function shadowEmitReviewLoopEpochBlockedTerminal(
  env: Env,
  epoch: ReviewLoopEpoch,
  blockReason: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
  options?: { clearDisabledMarker?: boolean },
): Promise<boolean> {
  // MATCH GUARD: the epoch-terminal transitions clear `in_flight_epoch_id` UNconditionally, so only emit
  // when this epoch IS the record's in-flight one. The blocked class spans looser reasons than the
  // prompt-driven terminals (session_mismatch, not-this-session, stale carry-forward), where the blocked
  // epoch may not be in-flight; clearing then would wrongly un-strand a DIFFERENT active epoch. A missing
  // record / mismatch is a benign no-op (the D17 self-heal owns any genuinely stranded terminal row).
  const route = classifyBlockedEpochSpineTerminal(blockReason);
  const clearDisabledMarker = options?.clearDisabledMarker === true;
  if (route === "skip" && !clearDisabledMarker) return false;
  const { getPrCoordination } = await import("../session/pr-coordination-db");
  const record = await getPrCoordination(env.DB, epoch.sessionId).catch(() => null);
  if (!record || record.inFlightEpochId !== epoch.id) return false;
  // Manual review mode (ARC-1514) settlement fix: an already-registered review epoch blocked because
  // automatic review handling is off (the deploy-time flip, or a mid-flight toggle) would otherwise leave
  // its `pr_review_item_dispositions` rows at `none`, wedging `caught_up`'s second conjunct forever — the
  // session stays review-listening (CI arm on) so it never reaches MERGE_READY. Stamp the PR's
  // undispositioned review items `no_action_needed_informational` (insert-or-convert-from-`none`, never
  // rewinds a real fixed/replied/declined stamp) so `caught_up` is reachable while the CI arm keeps
  // running. New reviews register nothing in manual mode (the humanSource ingest returns `ignored` before
  // the shadow intake), so this one stamp clears the whole strand for this PR.
  if (blockReason === "review_handling_disabled") {
    const { listUndispositionedActionable, stampInformationalDispositions } =
      await import("../session/pr-review-item-disposition-db");
    const sourceIds = await listUndispositionedActionable(env.DB, epoch.sessionId, epoch.prUrl);
    if (sourceIds.length > 0) {
      await stampInformationalDispositions(
        env.DB,
        sourceIds.map((sourceId) => ({
          sessionId: epoch.sessionId,
          prUrl: epoch.prUrl,
          sourceId,
          basis: "review_handling_disabled",
        })),
        Date.now(),
      );
    }
  }
  const kind: EpochTerminalKind = route === "response_failed" ? "blocked_response_failed" : "settled";
  const { shadowEmitReviewLoopEpochTerminal } = await import("./review-loop-epochs");
  await shadowEmitReviewLoopEpochTerminal(env, epoch, kind, log, waitUntil, {
    clearOnly: route === "skip" && clearDisabledMarker,
  });
  const after = await getPrCoordination(env.DB, epoch.sessionId).catch(() => null);
  return after?.inFlightEpochId === null;
}
