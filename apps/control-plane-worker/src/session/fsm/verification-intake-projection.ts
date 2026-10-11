// ARC-1330 W11-V10 — the FSM-owned QA-findings re-intake, and the dual-run parity SAMPLE for the legacy
// needs-work intake it replaces.
//
// The legacy re-entry path for an `app_breaks` (needs-work) verdict is `bootstrapReviewLoopEpochForVerification`
// (`services/review-loop-epochs.ts`), invoked from the cron sweep's needs-work intake block
// (`review-loop-sweep.ts`). That legacy intake STANDS DOWN — the FSM owns re-intake now:
// `record_verification(app_breaks)` registers the finding as an UNDISPOSITIONED disposition-store item
// (`inject_findings`, committed bucket a), keyed `verification:<validated-head>:<run>` in the SAME
// `verification:` namespace legacy keys on. `caught_up` then counts it and the epoch that drains it traces to
// the registered item (W11-V5 `dispatch_epoch`), synthesizing its sole worklist item from the STORED QA verdict
// (`session.verificationResult`/`verificationNeedsWorkLabel`, ARC-1330 D-50A follow-up — the managed QA comment
// that legacy re-parsed is deleted).
//
// This module exposes the parity PREDICATE (is a head-scoped finding registered for this PR?) + a best-effort
// DUAL-RUN parity SAMPLE the soak aggregates to prove the FSM re-intake fires wherever the legacy intake would
// have — so a live stand-down is never a silent drop. Observability-only: it NEVER writes the spine and NEVER
// throws. Under shadow the legacy intake runs unchanged and this sample is not taken.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import { postStructuredEventToDd } from "../../observability/events-exporter";
import type { Env } from "../../types";
import { listUndispositionedActionable } from "../pr-review-item-disposition-db";

/** The `verification:<head>:` disposition-store namespace an FSM QA-findings re-intake registers under. */
export function verificationFindingPrefixForHead(headSha: string): string {
  return `verification:${headSha}:`;
}

/**
 * Does the disposition store hold an UNDISPOSITIONED finding for this PR at `headSha` — i.e. did the FSM
 * re-intake the `app_breaks` verdict the legacy intake would have carried? PURE of I/O: takes the already-read
 * undispositioned source-id set. Head-scoped PREFIX match (not the exact id) so the run-vs-attempt discriminator
 * (`verification:<head>:<run>` FSM-side vs `verification:<head>:<attempt>` legacy-side) never manufactures a
 * false divergence — a head-scoped finding present ⟺ the FSM registered the re-intake.
 */
export function hasRegisteredVerificationFinding(
  undispositionedSourceIds: readonly string[],
  headSha: string,
): boolean {
  const prefix = verificationFindingPrefixForHead(headSha);
  return undispositionedSourceIds.some((sourceId) => sourceId.startsWith(prefix));
}

/**
 * DUAL-RUN parity SAMPLE (best-effort, never throws): at the cron sweep's needs-work
 * intake site, when the legacy intake STANDS DOWN under live, read the committed spine disposition store and
 * record whether the FSM registered the corresponding QA-findings re-intake — the evidence D-59a needs to
 * delete the legacy intake and trust the FSM path.
 *
 * DEDICATED instrument (`fsm.verification_intake_parity`, NOT the `fsm.divergence` monitor): an aggregate
 * agreement-rate sample, not a per-row gate. The FSM `app_breaks` verdict-back can be dispatched through the
 * host's `waitUntil` (deferred), so a sample taken at the sweep can transiently LEAD the registration — that
 * lag shows as a bounded `diverge` floor the soak reads as a rate, exactly like the `fsm.verdict_stamp_parity`
 * dual-run precedent. `fsm_finding_registered` / `head_sha` are emitted so the aggregate is
 * interpretable. A read fault (`store_read_failed`) is a distinct, non-alarming class.
 */
export async function emitVerificationIntakeStanddownParity(
  env: Env,
  args: { sessionId: string; prUrl: string; headSha: string },
): Promise<void> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  try {
    const undispositioned = await listUndispositionedActionable(db, args.sessionId, args.prUrl);
    const registered = hasRegisteredVerificationFinding(undispositioned, args.headSha);
    await postStructuredEventToDd(env, {
      event: "fsm.verification_intake_parity",
      result: registered ? "match" : "diverge",
      fsm_finding_registered: registered,
      session_id: args.sessionId,
      pr_url: args.prUrl,
      head_sha: args.headSha,
    }).catch(() => undefined);
  } catch {
    // Best-effort observability: a parity read/emit fault must never touch the legacy stand-down decision.
    await postStructuredEventToDd(env, {
      event: "fsm.verification_intake_parity",
      result: "store_read_failed",
      session_id: args.sessionId,
      pr_url: args.prUrl,
      head_sha: args.headSha,
    }).catch(() => undefined);
  }
}
