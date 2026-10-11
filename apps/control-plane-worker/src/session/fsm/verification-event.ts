// ARC-1330 lifecycle FSM — verification verdict → spine-event mapping (§17-A run-identity carry/echo).
//
// PURE FN: maps a verification child's terminal result (`VerifierTerminalResult`, shared/types/sandbox.ts)
// into the corresponding `verification.*` spine `FsmEvent`, ECHOING the run-identity token the child carried
// back (`result.verificationRunId`) as the event's `runId`. The spine's VERIFYING verdict exits decide
// freshness by `event.runId == record.verification_run_id` (transition.ts), so this echo is what makes the
// H→H′→H ABA ghost-discard work: a verdict whose `runId` no longer matches the active run is dropped as a
// late emission from a SUPERSEDED run, never a stale-pass false accept (gate class B4).
//
// SCOPE: this maps the two VERDICT-bearing outcomes the verifier agent can report — `CONCLUSIVE` (the app is
// verified → `verification.pass`) and `INCONCLUSIVE` (needs-work → `verification.app_breaks`), mirroring the
// legacy `verificationResultFromAgentVerdict` (shared/session/phase.ts: CONCLUSIVE→merge-ready,
// INCONCLUSIVE→needs-work). The non-verdict terminals — `verification.skipped` (planner skip),
// `verification.stopped`/`verification.failed` (infra/contract failure), `verification.run_limit` (cap) — do
// NOT arrive as a `VerifierTerminalResult` and are minted by their own producers in the shadow-phase wiring
// (PR 42); they are intentionally not this fn's concern.
//
// This is the building block PR 42 (`prompt-queue.ts` verdict-back path + `POST /session/verification/result`)
// consumes to dual-emit into `applyEvent`; it does no I/O and is unit-tested directly.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import type { VerifierTerminalResult } from "../../../../../shared/types/sandbox.js";
import type { FsmEvent } from "./types";

/**
 * Map a verification child's terminal verdict to the run-scoped spine event, echoing the carried
 * `verification_run_id`. Returns `null` (mints NO spine verdict) when the result did not echo a
 * `verificationRunId` — the run-identity token is mandatory for run-scoped freshness, and a missing token
 * must fail toward NOT-fresh (discard the verdict as a ghost) rather than mint a token-less false accept.
 *
 * The verdict's head is read from `result.verifiedHeadSha` (the head the verifier actually validated), which
 * the spine stamps as `verdict_head_sha` on a fresh accept.
 */
export function fsmEventFromVerifierResult(result: VerifierTerminalResult): FsmEvent | null {
  const runId = result.verificationRunId;
  if (runId === undefined) return null;

  const headSha = result.verifiedHeadSha;
  return result.verdict === "CONCLUSIVE"
    ? { type: "verification.pass", headSha, runId }
    : { type: "verification.app_breaks", headSha, runId };
}
