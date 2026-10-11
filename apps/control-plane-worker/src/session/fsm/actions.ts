// ARC-1330 lifecycle FSM — pure field-write actions (Section B, design §9 / §4 writer table).
//
// PURE FUNCTIONS: each action maps its already-live-read inputs to the `FsmFieldWrites`
// the edge applies — NO DB writes, NO I/O, NO side-effect execution. The Section E
// `applyEvent` spine spreads the returned partial into the Decision's `fieldWrites` and
// commits it under the PR-2 CAS; `transition` stays a pure function of (state, event,
// guards). Side effects (spawn/kill/dispatch) ride the Decision's `sideEffects` bag, NOT
// these actions.
//
// This file grows one action concern per PR (design §9). PR 10 lands the head + verdict
// record/restamp/clear writers; PR 11 adds the verification dispatch field-writers
// (`request_verification`, `redispatch_verification`) plus the ONE side-effect DESCRIPTOR
// builder this concern needs — `kill_verification` (the run-scoped teardown, design §7
// bucket b). That builder still does NOT execute a side effect: it returns the
// `kill_verification` SideEffect the Decision carries, which the Section E spine runs
// post-commit. PR 12 lands the ci_fix / block / terminal-bookkeeping writers
// (`inc_ci_fix_rounds`, `reset_ci_fix_rounds`, `set_code_changed`, `clear_block`,
// `arm_deadline`, and the `blocked_reason`/`failure_reason`/`stop_mode`/`pre_stop_state`
// setters) — all still pure field-write maps (design §4 writer table / §9). PR 13 lands the
// worklist concern: `register_review` + `inject_findings` (committed-bucket (a) worklist
// registrations — pure descriptors, durable-before-`caught_up`-read, FG-5) and the
// `resolve_owned_threads` after-commit side-effect descriptor (bucket b).
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import { verificationPass } from "./guards";
import type {
  BlockedReason,
  Decision,
  Disposition,
  EpochTrigger,
  FailureReason,
  FsmFieldWrites,
  FsmState,
  SideEffect,
  StopMode,
  Verdict,
  WorklistRegistration,
} from "./types";

// ── head ─────────────────────────────────────────────────────────────────────

/**
 * `advance_head{head_sha := event head}` (design §9 / §4). Tracks the live PR head to the
 * new sha carried by a `head.changed`/`head.noop_changed` event and clears ARC-1302's consumed
 * update-branch marker so it cannot prove ownership of a later, unrelated head advance. It never
 * touches `verdict_head_sha` (B4: only `record`/`restamp` stamp that), so callers pair it with
 * `clear_verification`/`restamp_verification`/`record_verification` as the edge requires
 * (e.g. `head.changed / advance_head, set_code_changed, clear_verification`).
 */
export function advanceHead(headSha: string): FsmFieldWrites {
  return { headSha, updateBranchQueuedAt: null };
}

// ── verdict record / restamp / clear ──────────────────────────────────────────
// The three writers of `verdict_head_sha` + `verdict` (design §4 row `qa_head_sha`).
// `record_verification` is the ONLY writer that resets `verification_run_count` (and only
// on an approving verdict — B1), and the freshness invariant (D11/SF8) that makes the
// cascade row-8 catch-all unreachable lives here: `record_verification` stamps
// `verdict_head_sha := head_sha` AND clears `code_changed_since_verification` in the SAME
// write, so `(¬code_changed ∧ pass) ⟹ fresh` holds by construction.

/**
 * `record_verification(verdict){ verdict, verdict_head_sha := head_sha,
 * code_changed_since_verification := false; verification_run_count := 0 only on pass|skipped }`
 * (design §9). The VERIFYING-exit writer that commits a fresh verdict against the live head.
 *
 * B1: `verification_run_count` (consecutive FAILED rounds) is reset to 0 ONLY on an approving
 * verdict (`pass`/`skipped`, via `verificationPass`); `app_breaks` PRESERVES the count — the
 * field is simply omitted from the writes — so the cap (`under_verification_cap`) keeps
 * counting toward the `verification_noconverge` trip across non-converging app_breaks rounds.
 *
 * `verdict_head_sha := head_sha` + `code_changed_since_verification := false` are written
 * together (D11/SF8): this is the sole writer of a fresh approving verdict, so a later
 * `(¬code_changed ∧ pass)` is always `fresh`.
 */
export function recordVerification(verdict: Verdict, headSha: string | null): FsmFieldWrites {
  const writes: FsmFieldWrites = {
    verdict,
    verdictHeadSha: headSha,
    codeChangedSinceVerification: false,
  };
  // B1: reset the consecutive-failed-round counter ONLY on an approving verdict.
  if (verificationPass(verdict)) {
    writes.verificationRunCount = 0;
  }
  return writes;
}

/**
 * `clear_verification{ verdict := none, verdict_head_sha := none }` (design §9, written
 * `clear_qa`). Drops the recorded verdict so the cascade re-dispatches verification — used
 * on `head.changed` (real code change: the prior verdict is stale). Does NOT touch
 * `code_changed_since_verification` (its edge sets that via `set_code_changed`, PR 12) or the
 * run count.
 */
export function clearVerification(): FsmFieldWrites {
  return { verdict: "none", verdictHeadSha: null };
}

/**
 * `restamp_verification{ keep verdict, verdict_head_sha := head_sha }` (design §9, written
 * `restamp_qa`). Advances the recorded verdict's head to the live head on a content-noop push
 * (`head.noop_changed[¬code_changed]` in REVIEW, the `head.noop_changed` self-loops in
 * MERGE_READY/NEEDS_YOU, the in-VERIFYING noop) so the existing verdict stays `fresh` without
 * a spurious re-run (SF9). KEEPS `verdict` (never written here) — only `verdict_head_sha`
 * moves, which (with `request`/`redispatch` NOT writing it, B4) keeps this + `record` the only
 * two stampers.
 */
export function restampVerification(headSha: string | null): FsmFieldWrites {
  return { verdictHeadSha: headSha };
}

// ── verification dispatch: request / redispatch ───────────────────────────────
// The two writers of the active run's identity (design §9, written `request_qa`/`redispatch_qa`).
// Both bump the monotonic `verification_run_id` token (the active run's identity that verdicts
// echo, FG-1/§17) and stamp `verification_run_head := head_sha` (the head the active child runs
// against — the freshness anchor `event.head_sha == verification_run_head`, B4). NEITHER writes
// `verdict_head_sha` (B4 — only `record`/`restamp` stamp that). They DIFFER only on the run cap:
// `request` BURNS a run, `redispatch` does not. The "arm verifying-deadline" the design notes for
// both is realized by the universal `arm_deadline` post-action (PR 12), keyed off the VERIFYING
// target — it is NOT written here, so these stay deadline-clock-free pure field maps.

/**
 * `request_verification{ verification_run_count += 1, verification_run_head := head_sha,
 * verification_run_id += 1; arm verifying-deadline (universal post-action) }` (design §9).
 * The SOLE `REVIEW.caught_up[code_changed ∧ under_cap] → VERIFYING` dispatch (B1): it is the
 * only writer that increments `verification_run_count` (consecutive-failed-round cap), so real
 * head changes re-entering the cascade burn a run until the cap trips → `NEEDS_YOU`. Does NOT
 * stamp `verdict_head_sha` (B4). Takes the live-read current count + run-id so the increment
 * stays a pure function of its inputs.
 */
export function requestVerification(
  currentRunCount: number,
  currentRunId: number,
  headSha: string | null,
): FsmFieldWrites {
  return {
    verificationRunCount: currentRunCount + 1,
    verificationRunHead: headSha,
    verificationRunId: currentRunId + 1,
    // W11-V4: minting a new run clears the prior (completed) run's stale child handle so the per-run
    // spawn idempotency anchor (Section E) reads a NULL child slot at run start. `verification_child_id`
    // is written by exactly ONE thing — the post-commit spawn side-effect (§17-A) — so at run R start
    // `child_id != null` reliably means "run R's spawn already landed". `verification_child_id` is NOT a
    // transition() guard predicate (only the kill_verification resolvers read it), so this write cannot
    // torn-read a guard (§15 inv 1). No active child exists on this REVIEW→VERIFYING entry, so nothing is
    // disarmed — the clear is pure cleanup of the previous run's dead handle.
    verificationChildId: null,
  };
}

/**
 * `redispatch_verification{ verification_run_head := head_sha, verification_run_id += 1;
 * arm verifying-deadline (universal post-action) }` (design §9). The in-VERIFYING re-run writer
 * (in-VERIFYING real `head.changed`, stale-verdict re-run, and the `STOPPED→VERIFYING` resume) —
 * re-points the active run at the new head and mints a fresh run-id, but does NOT touch
 * `verification_run_count` (B1: re-running the in-flight round is not a new `REVIEW→VERIFYING`
 * dispatch, so a head churn / stop-resume cycle can't consume a run) and does NOT stamp
 * `verdict_head_sha` (B4).
 */
export function redispatchVerification(currentRunId: number, headSha: string | null): FsmFieldWrites {
  return {
    verificationRunHead: headSha,
    verificationRunId: currentRunId + 1,
    // W11-V4: minting a fresh run_id clears the superseded run's child handle so the per-run spawn
    // anchor (Section E) reads a NULL slot for the new run (see `requestVerification`). This edge kills
    // the active child (the `kill_verification(guards.verificationChildId)` side-effect built ALONGSIDE
    // these writes), but that side-effect captured the handle from the PRE-write guard bag, so nulling
    // it in the resulting record never disarms the teardown — it only prevents the new run from reading
    // the just-killed child as its own already-spawned marker.
    verificationChildId: null,
  };
}

// ── verification teardown: kill (run-scoped) ──────────────────────────────────

/**
 * `kill_verification(run)` (design §7 bucket b, written `kill_qa`). The ONE side-effect
 * DESCRIPTOR builder in this file: it returns the `kill_verification` SideEffect the Decision
 * carries — it does NOT execute the teardown (the Section E spine runs it post-commit). It is
 * RUN-SCOPED: it targets a SPECIFIC run's child handle (`verification_child_id`, written by the
 * Section E spawn side-effect), passed in by the caller. A fresh-accept exit passes the active
 * run's handle (the run that just reported); the FG-1 ghost-discard edge passes the VERDICT'S
 * (already-dead, superseded) run handle — NEVER the live `verification_run_head` run. Re-killing
 * an already-dead child is idempotent (the executor no-ops), so the ghost edge can fire it
 * safely; a null handle (no child was ever spawned) likewise yields a well-formed no-op
 * descriptor. This builder only ever echoes the handle it is given — it never reaches for the
 * active run on its own (FG-1).
 */
export function killVerification(verificationChildId: string | null): SideEffect {
  return { kind: "kill_verification", args: { verificationChildId } };
}

// ── ci-fix rounds: inc / reset ────────────────────────────────────────────────
// The two writers of `ci_fix_rounds` (design §4 writer table, written `ci_fix_rounds`).
// `inc` is the ONLY writer that advances the consecutive-ciFix-round cap (the dispatch of
// a ciFix epoch, design §9 `ci.signal(failing)[…under_ci_fix_cap] / dispatch_epoch(ciFix),
// inc_ci_fix_rounds`); `reset` zeroes it. Both take the live-read current value so the write
// stays a pure function of its inputs (only `inc` needs it; `reset` is unconditional).

/**
 * `inc_ci_fix_rounds{ ci_fix_rounds += 1 }` (design §9). Bumps the consecutive-ciFix-round
 * counter when a ciFix epoch is dispatched (the `ci.signal(failing)` self-loop in REVIEW /
 * MERGE_READY, gated on `under_ci_fix_cap`). The cap trip (`ci_fix_exhausted → NEEDS_YOU`) is
 * driven by the guard reading this counter, NOT by this writer. Pure of its live-read input.
 */
export function incCiFixRounds(currentRounds: number): FsmFieldWrites {
  return { ciFixRounds: currentRounds + 1 };
}

/**
 * `reset_ci_fix_rounds{ ci_fix_rounds := 0 }` (design §9). Clears the ciFix-round budget. Wired
 * both as an explicit edge action (e.g. `NEEDS_YOU—user.retrigger→REVIEW` gives a retrigger a
 * fresh budget) and, in PR 20, as the §15-inv-11 CONDITIONAL universal post-action (any committed
 * post-PR transition landing in `ci_green ∧ no_inflight_epoch` clears it). Unconditional — takes
 * no input.
 */
export function resetCiFixRounds(): FsmFieldWrites {
  return { ciFixRounds: 0 };
}

/**
 * `reset_verification_run_count{ verification_run_count := 0 }` (design §9, written `reset qa_runs`).
 * Clears the consecutive-FAILED-round counter on a terminal RE-ENTRY into the review loop — the
 * `MERGE_READY`/`NEEDS_YOU` re-opens (`review.received[actionable]`, `head.changed`, `user.retrigger`)
 * — so a re-opened PR gets a fresh verification budget (the prior burn was against a now-superseded
 * head). Distinct from `record_verification`'s CONDITIONAL reset (B1, approving verdict only): this is
 * an UNCONDITIONAL re-entry reset, mirroring `reset_ci_fix_rounds`. Unconditional — takes no input.
 */
export function resetVerificationRunCount(): FsmFieldWrites {
  return { verificationRunCount: 0 };
}

// ── merge-ready reopen cap: inc ────────────────────────────────────────────────

/**
 * `inc_merge_ready_reopen_count{ merge_ready_reopen_count += 1 }` (design §17-D). Bumps the LIFETIME
 * READY⇄REVIEW flap counter on a red-CI re-open out of `MERGE_READY` (the `ci.signal(failing) → REVIEW`
 * edge). It is NEVER reset on `MERGE_READY` entry, so the cap (`under_merge_ready_reopen_cap`) bounds an
 * indefinite flap — once a re-open would push the count past `MAX_MERGE_READY_REOPENS` the edge routes to
 * `NEEDS_YOU(ci_flapping)` instead. The cap trip is driven by the guard reading this counter, NOT by this
 * writer. Pure of its live-read input.
 */
export function incMergeReadyReopenCount(currentReopens: number): FsmFieldWrites {
  return { mergeReadyReopenCount: currentReopens + 1 };
}

// ── code-changed flag: set ────────────────────────────────────────────────────

/**
 * `set_code_changed{ code_changed_since_verification := true }` (design §9, written
 * `set_code_changed`). Marks the recorded verdict stale against the live head so the cascade
 * re-dispatches verification — used on real code-moving edges (`head.changed`, `epoch.committed`,
 * the MERGE_READY/NEEDS_YOU re-opens). The matching clear is `record_verification` (PR 10), which
 * sets it false for ALL verdicts; the two together are the complete writer set (design §4 D12).
 */
export function setCodeChanged(): FsmFieldWrites {
  return { codeChangedSinceVerification: true };
}

// ── block / terminal bookkeeping: blocked_reason / failure_reason / stop ───────
// The closed-enum bookkeeping writers (design §4 rows `blocked_reason`/`failure_reason`/
// `stop_mode`/`pre_stop_state`, D14/N6). Each reason is set on its OWNING edge and is `none`
// (null) outside its owning state; `clear_block` and `clear_failure_reason` are the explicit
// clears (the latter on the sole `FAILED → PROVISIONING` retrigger).

/**
 * `set blocked_reason` (design §9 / §4 D14). Stamps the closed-enum reason on every `→NEEDS_YOU`
 * edge (`ci_fix_exhausted`, `owner_approval`, `verification_*`, `review_stuck`, `ci_flapping`,
 * `internal_inconsistency`). The `loud()` notify rides the Decision's side-effects, not this writer.
 */
export function setBlockedReason(reason: BlockedReason): FsmFieldWrites {
  return { blockedReason: reason };
}

/**
 * `clear_block{ blocked_reason := none }` (design §9, written `clear_block`). Drops the block reason
 * when a `NEEDS_YOU` re-opens back into the review loop (`user.retrigger`, an actionable
 * `review.received`, a real `head.changed`). Keeps `blocked_reason` `none` outside `NEEDS_YOU` (N6).
 */
export function clearBlock(): FsmFieldWrites {
  return { blockedReason: null };
}

/**
 * `set failure_reason` (design §9 / §4 D14). Stamps the closed-enum reason on every `→FAILED` edge
 * (`codegen_error`, `publish_failed`, `post_prep_failed`, `spawn_timeout`, `execution_timeout`,
 * `sandbox_failed`).
 */
export function setFailureReason(reason: FailureReason): FsmFieldWrites {
  return { failureReason: reason };
}

/**
 * `clear_failure_reason{ failure_reason := none }` (design §4 — cleared on the `FAILED → PROVISIONING`
 * retrigger, written into the CAS set). The sole clearer of `failure_reason`, mirroring `clear_block`;
 * keeps the reason `none` outside `FAILED` (N6), so a re-spawned session does not carry a stale failure.
 */
export function clearFailureReason(): FsmFieldWrites {
  return { failureReason: null };
}

/**
 * `set stop_mode / pre_stop_state` (design §9 / §4, written together on every `→STOPPED` edge).
 * `stop_mode ∈ {user, resumable}` records why the session stopped; `pre_stop_state` records the
 * state it stopped FROM so a `resumable` stop can re-enter that phase (§9 phase-aware resume). The
 * two are a single bookkeeping concern (always written together at `→STOPPED`), so one writer maps
 * both; they are `none` outside `STOPPED` (N6).
 */
export function setStop(stopMode: StopMode, preStopState: FsmState): FsmFieldWrites {
  return { stopMode, preStopState };
}

/**
 * `clear_stop{ stop_mode := none, pre_stop_state := none }` (design §9 / §4, the inverse of `setStop`,
 * written on every `STOPPED → …` resume edge). Mirrors `clear_block`/`clear_failure_reason`: the sole
 * clearer of the two stop fields, so they stay `none` outside `STOPPED` (N6) — a resumed session must
 * not carry a stale `stop_mode`/`pre_stop_state`.
 */
export function clearStop(): FsmFieldWrites {
  return { stopMode: null, preStopState: null };
}

// ── deadline: arm (universal post-action, bucket a) ───────────────────────────

/**
 * `arm_deadline{ state_entered_at := now, deadline_at := now + deadline_class(to) }` (design §10,
 * the bucket-a universal post-action — the anti-silent-stall backstop F16/F30 + the dwell anchor
 * F31). PURE: the caller (the PR-20 transition driver) resolves `now` and the target state's
 * deadline window (`deadline_class(decision.to)`) and passes the resolved `deadlineMs` in; this
 * writer only stamps the two fields. A `null` `deadlineMs` (a terminal/no-backstop state) writes
 * `deadline_at := null` while still stamping `state_entered_at` (the dwell anchor is armed for
 * every transition, even when the backstop is not).
 */
export function armDeadline(now: number, deadlineMs: number | null): FsmFieldWrites {
  return {
    stateEnteredAt: now,
    deadlineAt: deadlineMs === null ? null : now + deadlineMs,
  };
}

// ── worklist: register_review (committed bucket a) ───────────
// The two worklist-REGISTRATION builders (design §9 / §13). Each mints UNDISPOSITIONED
// actionable `WorklistRegistration`s the entering transition carries in the Decision's
// COMMITTED bucket (`worklistRegistrations`) — committed in the SAME CAS as `fieldWrites`,
// durable BEFORE the separate `caught_up` recompute reads the worklist (FG-5 / §6 ordering).
// They are NOT after-commit side-effects (bucket b): a deferred registration could let a
// `caught_up` read see a pre-registration snapshot and bounce to `MERGE_READY` (Defect 3 / B6)
// or fire `verification_unresolved` right after `app_breaks` (SF16). PURE descriptor builders —
// no DB write; the Section E spine persists the rows to the disposition store (finalized PR 22).

/**
 * `register_review(undispositioned)` (design §9 / §13, Defect 3). Records a received actionable
 * review as a single UNDISPOSITIONED (`disposition: "none"`) worklist item keyed by its review
 * source id. Fired on the `REVIEW` `review.received[actionable]` self-loop and the
 * `MERGE_READY`/`NEEDS_YOU` re-opens so the triggering review keeps `caught_up` false until
 * addressed — the item is registered, not merely consumed, so the session can't bounce straight
 * back to `MERGE_READY` and drop the review (B6). Caller-supplied source id keeps it pure.
 */
export function registerReview(reviewSourceId: string): WorklistRegistration {
  return { sourceId: reviewSourceId, origin: "review", disposition: "none" };
}

// A4: `inject_findings` is retired. QA `app_breaks` re-intake no longer rides the FSM spine — the QA
// verifier posts a managed PR comment that the review-loop intake admits as `known:cycloid-qa`, so the
// VERIFYING verdict exit is record-only (no injected finding registrations). `registerReview` remains the
// sole worklist registration builder.

// Compile-only (src IS typechecked, tests are NOT): prove the registration builder mints an artifact for
// the Decision's COMMITTED bucket (a) — `Decision.worklistRegistrations` — and NOT the after-commit
// `sideEffects` bag (FG-5 / §6: durable-before-`caught_up`-read). A drift that retyped a registration as a
// side-effect (bucket b) would fail THIS assignment in tsc, not silently in the untyped vitest file.
// Un-exported + `void`-ed so it compiles and tree-shakes out.
const _registrationsRideCommittedBucket: NonNullable<Decision["worklistRegistrations"]> = [registerReview("")];
void _registrationsRideCommittedBucket;

// ── in-flight-epoch CAS field writes (§17-B: the `no_inflight_epoch` read-source + inc anchor) ─
// The two writers of `in_flight_epoch_id` — the committed, same-`applyEvent`-visible model of
// "an epoch is running" (design §17-B). `set` rides the SAME CAS as a `dispatch_epoch` side-effect
// (so the guard read flips in lockstep with the dispatch); `clear` rides the epoch terminals'
// (`committed/replied/declined`) CAS write. `no_inflight_epoch := in_flight_epoch_id IS NULL`
// (the `noInflightEpoch` guard reads exactly this field). Two coupled properties fall out:
//   • inc-anchor — `inc_ci_fix_rounds` rides the SAME NULL→non-null transition that `set` performs
//     (a ciFix dispatch only fires under `no_inflight_epoch`, i.e. from a NULL id), so the inc is
//     keyed to that one transition; the after-commit spawn keyed by the committed id is idempotent
//     and can never double-count rounds on a retry.
//   • inc/reset mutual exclusion (FG-2) — a dispatch leaves `in_flight_epoch_id` non-null in the
//     RESULTING state, so `no_inflight_epoch=false` and the conditional `reset_ci_fix_rounds`
//     universal post-action (PR 20, gated on `ci_green ∧ no_inflight_epoch`) cannot also fire.

/**
 * `set in_flight_epoch_id := epoch_id` (design §17-B). Stamps the dispatching epoch's id under the
 * SAME CAS as the paired `dispatch_epoch` side-effect, flipping `no_inflight_epoch` false the instant
 * the dispatch commits. The caller pre-allocates the id for purity and threads
 * it via `Guards.newEpochId`; the after-commit epoch spawn is keyed by this committed id (idempotent).
 */
export function setInFlightEpoch(epochId: string): FsmFieldWrites {
  return { inFlightEpochId: epochId };
}

/**
 * `clear in_flight_epoch_id := null` (design §17-B). Drops the in-flight marker on the epoch terminals
 * (`epoch.committed/replied/declined`) in their CAS write, re-arming `no_inflight_epoch` so the next
 * actionable item / ciFix can dispatch. Unconditional — takes no input.
 */
export function clearInFlightEpoch(): FsmFieldWrites {
  return { inFlightEpochId: null };
}

// ── epoch dispatch + disposition (after-commit side-effect descriptors, bucket b) ─

/**
 * `dispatch_epoch(trigger)` (design §9, bucket b). A side-effect DESCRIPTOR builder: it returns the
 * `dispatch_epoch` SideEffect the Decision carries — it does NOT spawn the review-loop epoch (the
 * Section E spine runs it post-commit). `trigger` records WHY the epoch dispatched: `ci_fix` (a red
 * `ci.signal(failing)` self-loop, paired with `inc_ci_fix_rounds`) or `review` (the CI-settled
 * epoch-1 trigger and the eager `review.received[actionable]` / `review.item_ready` self-loops).
 * Pure of its input — the spine reads the live worklist to decide what the dispatched epoch carries.
 * §17-B: the spawn is keyed by the committed `in_flight_epoch_id` (set under the same CAS via
 * `setInFlightEpoch`), so a retried spawn for an already-recorded id is a no-op (idempotent).
 */
export function dispatchEpoch(trigger: EpochTrigger): SideEffect {
  return { kind: "dispatch_epoch", args: { trigger } };
}

/**
 * `disposition(value)` (design §9 / §13, bucket b). A side-effect DESCRIPTOR builder: it returns the
 * `disposition` SideEffect the Decision carries — it does NOT write the disposition store (the Section E
 * spine + PR 22 DAO stamp the rows post-commit). Fired on the epoch terminals — `epoch.committed → fixed`,
 * `epoch.replied → replied`, `epoch.declined → declined` — to mark every item the just-finished epoch
 * owns (`epochId`) as dispositioned so `caught_up` stops counting them as actionable-undispositioned.
 * Bucket b is SOUND here (unlike `register_review`, committed bucket a): a delayed disposition only keeps
 * the item counted as undispositioned a little longer, which fails SAFE (the PR can't bounce to
 * `MERGE_READY`), so it carries no FG-5/§6 durable-before-`caught_up`-read constraint. The disposition is
 * never `none` — `none` is the registration state, not a terminal stamp.
 */
export function disposition(epochId: string, value: Exclude<Disposition, "none">): SideEffect {
  return { kind: "disposition", args: { epochId, disposition: value } };
}

// ── worklist: resolve_owned_threads (after-commit side-effect, bucket b) ───────

/**
 * `resolve_owned_threads` (design §9 / §17-C, bucket b). A side-effect DESCRIPTOR builder (like
 * `kill_verification`): it returns the `resolve_owned_threads` SideEffect the Decision carries —
 * it does NOT execute the GitHub thread resolution (the Section E spine runs it post-commit). Fired
 * on the `REVIEW` `epoch.committed` / `epoch.replied` self-loops to resolve the review threads the
 * just-finished epoch owns. Unlike the worklist REGISTRATIONS above (committed bucket a), thread
 * resolution is a genuine after-commit external effect with no `caught_up`-ordering constraint.
 */
export function resolveOwnedThreads(): SideEffect {
  return { kind: "resolve_owned_threads" };
}

// ── cap-trip metric: emit_cap_trip (after-commit side-effect, bucket b) ─────────

/**
 * The retunable-bound caps that emit a dedicated trip metric (tech-spec Locked decision 5b). Today the
 * only wired member is the §17-D `MAX_MERGE_READY_REOPENS` flap cap; extend the union (not the call site)
 * if another cap's trip needs its own retune signal.
 */
export type CapTripName = "merge_ready_reopen";

/**
 * `emit_cap_trip(cap, limit)` (tech-spec Locked decision 5b, bucket b). A side-effect DESCRIPTOR builder:
 * it returns the `emit_cap_trip` SideEffect the Decision carries — it does NOT emit the metric (the Section E
 * spine emits it post-commit as a count). Raised alongside `loud()` on a cap-trip terminal so the bound can
 * be retuned post-shadow from the live trip rate, DISTINCT from `loud()`'s generic `emit_dd`. Pure of input —
 * `cap` names the tripped bound and `limit` records the value it tripped at (the metric's tags).
 */
export function emitCapTrip(cap: CapTripName, limit: number): SideEffect {
  return { kind: "emit_cap_trip", args: { cap, limit } };
}
