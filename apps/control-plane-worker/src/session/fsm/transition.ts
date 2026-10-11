// ARC-1330 lifecycle FSM — the pure `transition()` driver (Section B).
//
// PURE FUNCTION: transition(state, event, guards) → Decision | null. No DB writes,
// no I/O, no producers, no side-effect EXECUTION — it only DESCRIBES the next state,
// the CAS field writes, and the side effects to run (design §7 bucket b). The caller
// (the Section E `applyEvent` spine) commits the writes and dispatches the effects.
//
// Two senses of "no-op", do NOT conflate them (design §8, FG-2 depends on it):
//   (i)  UNHANDLED event — no edge matches → `transition` returns `null`. The caller
//        logs a `log_noop` and RETURNS EARLY, running NO universal post-actions.
//   (ii) HANDLED self-loop — a real Decision with `to === from`. It bumps version and
//        RUNS the universal post-actions. (None of PR 5's self-loops are the FG-2
//        `log_noop` kind yet; `GENERATING — prompt.enqueued → GENERATING` is a real
//        forward self-loop that re-dispatches the next prompt.)
//
// This file grows one concern per PR (design §9). PR 5 lands the driver shell plus the
// genesis/codegen spine; PR 6 adds the publish spine (`FINALIZING → PUBLISHING → REVIEW`,
// the `init_record` field writes, and the N9 `PUBLISHING — pr.merged/closed` race). PR 15/16
// add the REVIEW self-loops + the 8-row `caught_up` cascade. PR 17 adds the VERIFYING state:
// the in-place head/review/ci self-loops + run-scoped-freshness verdict exits, including the
// FG-1 ghost-discard (a verdict from a SUPERSEDED run is dropped, never recorded/terminating,
// and its `kill_verification` is run-scoped to the VERDICT's run — never the live one). PR 18 adds
// the terminal re-entry edges: the `MERGE_READY`/`NEEDS_YOU` re-opens (with the §17-D `ci_flapping`
// flap cap and the `NEEDS_YOU`-only queue drain) and the `FAILED → PROVISIONING` infra retrigger.
// Cross-cutting deadline + remaining terminal edges arrive in later PRs.

import { MAX_MERGE_READY_REOPENS } from "../../constants/review-loop";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../../constants/verification";
import {
  advanceHead,
  clearBlock,
  clearFailureReason,
  clearInFlightEpoch,
  clearStop,
  clearVerification,
  dispatchEpoch,
  disposition,
  emitCapTrip,
  incCiFixRounds,
  incMergeReadyReopenCount,
  killVerification,
  recordVerification,
  redispatchVerification,
  registerReview,
  requestVerification,
  resetCiFixRounds,
  resetVerificationRunCount,
  resolveOwnedThreads,
  restampVerification,
  setBlockedReason,
  setCodeChanged,
  setFailureReason,
  setInFlightEpoch,
  setStop,
} from "./actions";
import type { CiBucket } from "./guards";
import type {
  BlockedReason,
  Decision,
  EpochBlockReason,
  FsmEvent,
  FsmFieldWrites,
  FsmState,
  SideEffect,
  StopMode,
  Verdict,
  WorklistRegistration,
} from "./types";

// Total map: an epoch-block reason → its NEEDS_YOU `blocked_reason`. tsc-exhaustive — a new
// EpochBlockReason with no arm fails to compile, forcing the routing decision at the type boundary.
function mapEpochBlockReason(reason: EpochBlockReason): BlockedReason {
  switch (reason) {
    case "owner_approval":
      return "owner_approval";
    case "response_failed":
      return "review_response_failed";
  }
}

// The evaluated-input bag handed to `transition`. Mostly pure predicates computed by the
// caller BEFORE the transition (keeping `transition` itself a pure function of its three
// arguments), plus caller-pre-computed handles the publish spine needs that are
// NOT derivable from `(state, event)` alone (design §4/§5: the `publish.pr_opened` event
// carries `{pr_head}` only).
// Grown additively as later PRs add their guarded edges.
export interface Guards {
  /** The session's E2B sandbox is live (vs. torn down) — decides the follow-up target. */
  sandboxAlive: boolean;
  /** Live record blocked reason, only meaningful while the record is in NEEDS_YOU. */
  blockedReason?: BlockedReason | null;
  /**
   * The opened PR's URL, supplied by the caller for the `PUBLISHING — publish.pr_opened`
   * `init_record` (design §4 `pr_url`). NOT carried on the event — §5 pins the payload to
   * `publish.pr_opened{pr_head}`, and `init_record` writes `pr_url` with no `:= event`
   * source — so the spine threads it in here. Absent on every other edge.
   */
  prUrl?: string;

  // ── REVIEW guards (PR 15, design §6/§9) — caller live-reads these BEFORE `transition` ──
  // All optional + additive (the existing genesis/publish edges never read them): a missing
  // value defaults conservatively (fails toward NOT dispatching). The Section E spine always
  // supplies them on a REVIEW event; the pure tests pass exactly the ones their edge reads.
  /** `no_inflight_epoch` — no review/ciFix epoch currently running (gates eager + ciFix dispatch). */
  noInflightEpoch?: boolean;
  /**
   * §17-B: the pre-allocated id stamped into `in_flight_epoch_id` under the SAME CAS as a
   * `dispatch_epoch` side-effect (caller-supplied for purity, like `prUrl` —
   * the spine mints a fresh id per dispatch since epochs are not deterministic from `session_id`).
   * The after-commit epoch spawn is keyed by this committed id (idempotent). Supplied by the spine
   * on every dispatching edge; absent (→ `""`) on the pure tests' non-dispatch edges.
   */
  newEpochId?: string;
  /** `under_ci_fix_cap` — `ci_fix_rounds < MAX_CI_FIX_ROUNDS` (gates the ciFix self-loop vs the cap trip). */
  underCiFixCap?: boolean;
  /** The live-read `ci_fix_rounds` counter, so `inc_ci_fix_rounds` stays a pure function of its input. */
  ciFixRounds?: number;
  /** `epoch_1_fired` — the first REVIEW epoch has already dispatched (the CI-settled trigger fires only when NOT). */
  epoch1Fired?: boolean;
  /** `actionable_exists` — ≥1 undispositioned actionable item is registered on the worklist (the trigger carries it). */
  actionableExists?: boolean;
  /**
   * `ci_settled` — the CI-settled detection keyed on REQUIRED checks + a short debounce (NOT "every check
   * object currently present"). A late-registered NON-required check can't flip it, so it can't false-fire
   * epoch 1 (the late-check guard, design §9/§17). Only the green/absent CI-settled epoch-1 trigger reads it.
   */
  ciSettled?: boolean;
  /** `code_changed_since_verification` — the stored bool, picks the `head.noop_changed` branch (restamp vs not, N4). */
  codeChangedSinceVerification?: boolean;
  /** The received review's disposition-store source id (`review.received` carries it in metadata, not on the event). */
  reviewSourceId?: string;
  /** The head the committed epoch produced (`epoch.committed` carries it in metadata, not on the event) — for `advance_head`. */
  committedHead?: string;
  /**
   * ARC-1445 / ARC-1556: source ids of undispositioned actionable items NOT covered by a LIVE
   * (non-terminal) epoch — traced by the same-head epoch-terminal producer
   * (`listUndispositionedActionable` − `listLiveEpochCoveredSourceIds`). The `epoch.settled`,
   * `epoch.replied`, and `epoch.declined` REVIEW edges ARM THE DRAIN when this is non-empty: they stamp a
   * FRESH `in_flight_epoch_id` + `dispatch_epoch(review)` so those items get an epoch immediately (at live
   * `release_queued_reviews` is inert and `caught_up` cannot fire with undispositioned ≥ 1, so nothing
   * else drains them). Traced only for SAME-HEAD terminals; `epoch.committed` still waits for the head
   * webhook to advance the record before any follow-up dispatch. Absent/empty → no drain.
   */
  uncoveredActionableSourceIds?: readonly string[];

  // ── `caught_up` cascade guards (PR 16, design §9 rows 1-8) — caller live-reads these ──
  // The cascade is total over `(code_changed × ci × verification_pass × verification_fresh ×
  // under_verification_cap × under_ci_fix_cap)`; each guard is a pre-computed pure read of the
  // record the caller supplies on the `caught_up` event. All optional/additive (the genesis,
  // publish, and PR-15 REVIEW self-loop edges never read them); a missing value defaults
  // conservatively (toward the loud catch-all / a wait), never toward a false MERGE_READY.
  /** `under_verification_cap` — `verification_run_count < MAX_VERIFICATION_RUNS_PER_PR` (rows 1/2 split). */
  underVerificationCap?: boolean;
  /**
   * `auto_verify_disabled` — the per-user/session auto-verify opt-out (#6395 `user_settings`
   * toggle), resolved from the owning session by the live resolver at the `caught_up` snapshot.
   * TRUE waives the verification gate: cascade rows 1/2/6 are skipped and row 7's pass/fresh
   * conjuncts are vacuous, so the CI ladder + `no_inflight_epoch` alone decide MERGE_READY.
   * Missing/false keeps the full gate (fail-safe toward current behavior).
   */
  autoVerifyDisabled?: boolean;
  /**
   * The 3-valued CI live-read bucket for the `¬code_changed` branch (`ci_green | ci_red |
   * ci_pending`, the FG-4 partition of `reduceCiState`). Rows 3/4 fire on `ci_red`, row 5 is the
   * `ci_pending` wait, rows 6/7 are `ci_green`. NOT `¬ci_green` (that conflates red + pending).
   */
  ciBucket?: CiBucket;
  /** `verification_pass` — `verdict ∈ {pass, skipped}` (rows 6 vs 7). */
  verificationPass?: boolean;
  /** `verification_fresh` — recorded `verdict_head_sha == head_sha` (row 7 vs the row-8 residual cell). */
  verificationFresh?: boolean;
  /** Live-read `verification_run_count`, so row 1's `request_verification(count+1)` stays pure of its input. */
  verificationRunCount?: number;
  /** Live-read `verification_run_id`, so row 1's `request_verification(id+1)` mints the run token purely. */
  verificationRunId?: number;
  /** Live-read row head, so explicit QA requests can reset the per-head budget when the requested head advanced. */
  headSha?: string | null;

  // ── VERIFYING guards (PR 17, design §9 QA contract — caller live-reads these on a VERIFYING event) ──
  // Run-scoped verdict freshness (FG-1, inv 10) is decided by `event.run_id == verification_run_id`
  // (the run token bumped by `request`/`redispatch_verification`), NOT a head match — so a head revert
  // `H→H′→H` can't alias a superseded run's late verdict as fresh (ABA). All optional/additive; a
  // missing `verificationRunId` fails toward NOT-fresh (the verdict is discarded as a ghost, never a
  // false accept). `verificationRunId` is reused from the cascade guards above for this check.
  /**
   * The ACTIVE run's verification child handle (`verification_child_id`), supplied by the caller for the
   * run-scoped `kill_verification` on every VERIFYING EXIT (fresh accept, `run_limit`, `stopped`/`failed`)
   * and the in-VERIFYING `head.changed` re-run (kill the superseded active child, then spawn the new run's).
   */
  verificationChildId?: string | null;
  /**
   * The VERDICT's run's child handle, resolved by the spine from `event.run_id` for the FG-1 ghost-discard
   * `kill_verification(verdict's run)` ONLY. It is a DIFFERENT handle from `verificationChildId` (the live
   * run) on purpose: FG-1 requires the ghost teardown target the verdict's already-dead run and NEVER touch
   * the live `verification_run_head` run. Absent on every non-ghost edge.
   */
  verdictVerificationChildId?: string | null;
  // ── Terminal re-entry guards (PR 18, design §9 lines / §17-D — caller live-reads these) ──
  // The `MERGE_READY`/`NEEDS_YOU`/`FAILED` re-open edges. All optional/additive (no prior edge
  // reads them); a missing value defaults conservatively — `underMergeReadyReopenCap` absent reads
  // FALSE (fail toward the `ci_flapping` trip, never an unbounded flap), `mergeReadyReopenCount`
  // absent reads 0.
  /**
   * `under_merge_ready_reopen_cap` — `merge_ready_reopen_count < MAX_MERGE_READY_REOPENS` (§17-D).
   * Gates the `MERGE_READY — ci.signal(failing)` red-CI re-open: under cap → re-open to REVIEW
   * (bump the lifetime count + start a fresh ciFix budget); at/over cap → `NEEDS_YOU{ci_flapping}`.
   */
  underMergeReadyReopenCap?: boolean;
  /** The live-read `merge_ready_reopen_count`, so `inc_merge_ready_reopen_count` stays pure of its input. */
  mergeReadyReopenCount?: number;

  // ── A4 QA re-run guards (the REVIEW `epoch.committed` re-verify arm) — caller live-reads these ──
  // All optional/additive; a missing value fails toward NO re-run (never a spurious extra verification run).
  /** The recorded verification verdict (`record.verdict`) — the re-run fires only while it is `app_breaks`. */
  recordedVerdict?: Verdict | null;
  /** The verified head the recorded verdict was produced at — the re-run head-advanced check compares it to `currentHeadSha`. */
  verdictHeadSha?: string | null;
  /** The live PR head (`record.head_sha`) — head advanced past the verified head ⇒ re-verify at this head. */
  currentHeadSha?: string | null;
  /**
   * The head the most recent verification run was REQUESTED at (`record.verification_run_head`). Re-entrancy
   * fence for the re-run arm: `requestVerification` stamps this to `currentHeadSha`, so once a run is already
   * in flight at the current head, `verificationRunHead === currentHeadSha` blocks a redelivered/retried
   * `epoch.committed` from spawning a duplicate verifier and burning a second run at the same head. (The
   * `verdictHeadSha` head-advanced check does NOT dedup this: `requestVerification` writes
   * `verification_run_head`, not `verdict_head_sha`, so `verdictHeadSha` stays at the old head until the new
   * verdict returns — leaving `headAdvanced` true across re-applications.)
   */
  verificationRunHead?: string | null;
  /** Whether the just-committed epoch dispositioned ≥1 item keyed `known:cycloid-qa` (a QA-sourced finding was fixed). */
  committedEpochDispositionedQaFinding?: boolean;

  // ── Phase-aware resume guards (PR 19c, design §10 "Resume") — caller live-reads these on a `STOPPED — user.input` ──
  // All optional/additive (no prior edge reads them); a missing value defaults conservatively (a missing
  // `stopMode`/`preStopState` makes the resume unhandled → null, never a wrong re-entry).
  /** `stop_mode` — the recorded stop reason; only a `resumable` stop re-enters the loop on `user.input` (the `[resumable]` guard). */
  stopMode?: StopMode;
  /** `pre_stop_state` — the state the session stopped FROM; selects the phase-aware resume target (codegen / publish / review; a VERIFYING stop resumes into REVIEW). */
  preStopState?: FsmState;
  /** Publish-phase resume only: the diff is NOT yet pushed (branch absent). A dead sandbox with an unpushed diff has nothing to retry → re-provision (SF12). */
  unpushedDiff?: boolean;
}

function decide(
  to: FsmState,
  fieldWrites: FsmFieldWrites,
  sideEffects: readonly SideEffect[],
  worklistRegistrations?: readonly WorklistRegistration[],
): Decision {
  return worklistRegistrations
    ? { to, fieldWrites, sideEffects, worklistRegistrations }
    : { to, fieldWrites, sideEffects };
}

const LOG_NOOP: SideEffect = { kind: "log_noop" };
const LOUD: SideEffect = { kind: "loud" };
// `terminate_runtime` (R4) — reclaim the session's runtime VM on a FINAL terminal. Carries no args;
// the executor resolves the runtime projection itself. Only ever added via `finalTerminalCloseOut`.
const TERMINATE_RUNTIME: SideEffect = { kind: "terminate_runtime" };

/** Merge several `FsmFieldWrites` partials left-to-right (later keys win), preserving design action order. */
function mergeWrites(...parts: readonly FsmFieldWrites[]): FsmFieldWrites {
  return Object.assign({}, ...parts);
}

const EMIT_SETTLE: SideEffect = { kind: "emit_settle" };
const NOTIFY_USER: SideEffect = { kind: "notify_user" };
const NOTIFY_QA_ISSUE: SideEffect = { kind: "notify_qa_issue" };
const SPAWN_VERIFICATION_CHILD: SideEffect = { kind: "spawn_verification_child" };
const verificationRequestUnderCap = (event: FsmEvent, guards: Guards): boolean =>
  event.type === "verification.requested" &&
  (event.bypassRunLimitForMergeConflict === true || (guards.underVerificationCap ?? false));
// `release_queued_reviews` ("re-evaluate dispatch", design §9 queue-drain rule): drains the transient
// VERIFYING hold on EVERY VERIFYING exit so registered-but-undispositioned reviews dispatch once the head
// is free again. NOT run on the FG-1 ghost-discard (a `VERIFYING→VERIFYING` self-loop, not an exit).
const RELEASE_QUEUED_REVIEWS: SideEffect = { kind: "release_queued_reviews" };
/**
 * `in_flight_epoch_id` must be a real, non-empty id. A `?? ""` silent fallback would write an
 * EMPTY in_flight_epoch_id, which poisons the `no_inflight_epoch` dispatch gate (every later epoch
 * reads a non-null id and looks already-in-flight). The producers always supply a version-keyed id,
 * so a missing one is a wiring bug — fail loud at the dispatch boundary.
 */
function requireNewEpochId(newEpochId: string | undefined): string {
  if (!newEpochId) {
    throw new Error(
      "epoch dispatch requires a non-empty guards.newEpochId (empty in_flight_epoch_id poisons no_inflight_epoch)",
    );
  }
  return newEpochId;
}

/**
 * Initialize the post-publish coordination record for both a normally published PR and an adopted PR.
 * Adoption starts from CREATED and intentionally skips the codegen/publish states because the PR already exists.
 */
function initializeReviewFromPublishedPr(event: Extract<FsmEvent, { type: "publish.pr_opened" }>, guards: Guards) {
  if (guards.prUrl == null) {
    throw new Error(
      "publish.pr_opened init_record (B5) requires guards.prUrl — pr_url must be non-null on REVIEW entry",
    );
  }
  return decide(
    "REVIEW",
    {
      prUrl: guards.prUrl,
      headSha: event.prHead,
      codeChangedSinceVerification: true,
      verificationRunCount: 0,
      ciFixRounds: 0,
      verificationRunId: (guards.verificationRunId ?? 0) + 1,
      verificationRunHead: event.prHead,
      verificationChildId: null,
    },
    [SPAWN_VERIFICATION_CHILD],
  );
}

/**
 * The `REVIEW.caught_up` cascade — a PURE CI LADDER (ARC-1330 CI-ladder cut). Verification is no longer
 * a merge-ready gate: it is spawned fire-and-forget at publish and recorded via the record-only
 * bookkeeping edges (see `verificationBookkeeping`), so the cascade reads ONLY the 3-valued CI bucket
 * (FG-4) and `no_inflight_epoch`. ORDERED, TOTAL, and pairwise-DISJOINT over `{ci_green, ci_red,
 * ci_pending} × no_inflight_epoch`, so it ALWAYS returns a Decision (never `null`). `MERGE_READY` is
 * emitted from the green ∧ no-inflight rung ALONE (the sole emitter, D10).
 *
 *   ci_red   ∧ under_ci_fix_cap  → REVIEW / inc_ci_fix_rounds, set_in_flight_epoch, dispatch_epoch(ci_fix)
 *   ci_red   ∧ ¬under_ci_fix_cap → NEEDS_YOU(ci_fix_exhausted) / loud
 *   ci_pending                   → REVIEW / log_noop            (the WAIT rung, §10 review-stuck backstop owns it)
 *   ci_green ∧ no_inflight_epoch → MERGE_READY / reset_ci_fix_rounds, emit_settle, notify_user
 *   ci_green ∧ ¬no_inflight      → REVIEW / log_noop            (W11-T1 stale-green WAIT)
 *
 * Fail-safe defaults: a missing `ciBucket` reads `ci_pending` (WAIT) and a missing `noInflightEpoch`
 * reads false (WAIT), so an under-populated guard bag can only route to a wait — never a false MERGE_READY.
 */
function caughtUpCascade(guards: Guards): Decision {
  const ci: CiBucket = guards.ciBucket ?? "ci_pending";
  if (ci === "ci_red") {
    if (guards.underCiFixCap ?? false) {
      return decide(
        "REVIEW",
        mergeWrites(incCiFixRounds(guards.ciFixRounds ?? 0), setInFlightEpoch(requireNewEpochId(guards.newEpochId))),
        [dispatchEpoch("ci_fix")],
      );
    }
    return decide("NEEDS_YOU", setBlockedReason("ci_fix_exhausted"), [LOUD]);
  }
  if (ci === "ci_pending") {
    return decide("REVIEW", {}, [LOG_NOOP]);
  }
  // ci_green: the SOLE MERGE_READY rung, gated on no_inflight_epoch (W11-T1 stale-green race fix). A
  // concurrent ciFix dispatch stamps in_flight_epoch_id between an honest green read and this re-entrant
  // evaluation → WAIT; the epoch's own terminal re-triggers the recompute so the WAIT never wedges.
  if (guards.noInflightEpoch ?? false) {
    return decide("MERGE_READY", resetCiFixRounds(), [EMIT_SETTLE, NOTIFY_USER]);
  }
  return decide("REVIEW", {}, [LOG_NOOP]);
}

/**
 * Record-only verification-verdict bookkeeping (self-loop, NO state change). Verification is decoupled
 * from the merge-ready gate: a returning verdict is PERSISTED (so the QA re-run trigger and product
 * surfaces can read it) and the run's child is torn down, but the FSM state never moves. A verdict from
 * a SUPERSEDED run (event.run_id ≠ the active run) is ghost-discarded (`log_noop` + kill the verdict's
 * own run, NEVER the live run — FG-1). The infra terminals (`run_limit`/`stopped`/`failed`) fire a
 * NON-BLOCKING QA-issue DM instead of blocking. Returns `null` for any non-verification event so the
 * caller keeps its existing unhandled-event fallthrough. Hosted in REVIEW / MERGE_READY / NEEDS_YOU (NOT
 * VERIFYING — that state keeps its own verbatim drain-exit edges).
 */
function verificationBookkeeping(state: FsmState, event: FsmEvent, guards: Guards): Decision | null {
  switch (event.type) {
    case "verification.pass":
    case "verification.skipped":
    case "verification.app_breaks": {
      const fresh = guards.verificationRunId !== undefined && event.runId === guards.verificationRunId;
      if (!fresh) {
        return decide(state, {}, [LOG_NOOP, killVerification(guards.verdictVerificationChildId ?? null)]);
      }
      const verdict =
        event.type === "verification.pass" ? "pass" : event.type === "verification.skipped" ? "skipped" : "app_breaks";
      return decide(state, recordVerification(verdict, event.headSha), [
        killVerification(guards.verificationChildId ?? null),
      ]);
    }
    case "verification.run_limit":
    case "verification.stopped":
    case "verification.failed": {
      const fresh = guards.verificationRunId !== undefined && event.runId === guards.verificationRunId;
      if (!fresh) {
        return decide(state, {}, [LOG_NOOP, killVerification(guards.verdictVerificationChildId ?? null)]);
      }
      // Infra non-verdict on the active run: DM the user (non-blocking) and tear the child down — no
      // blocked_reason, no state change. Track INTAKE's re-run trigger decides whether QA respawns.
      return decide(state, {}, [NOTIFY_QA_ISSUE, killVerification(guards.verificationChildId ?? null)]);
    }
    default:
      return null;
  }
}

/**
 * The per-STATE core edges (genesis/codegen/publish spine, REVIEW cascade + self-loops, VERIFYING, and the
 * terminal re-entry edges). Returns the Decision for the matching edge, or `null` when no per-state edge
 * matches — at which point `transition` falls through to the cross-cutting (§10) layer below.
 */
function coreTransition(state: FsmState, event: FsmEvent, guards: Guards): Decision | null {
  switch (state) {
    // ── Genesis ──────────────────────────────────────────────────────────────
    case "CREATED":
      if (event.type === "sandbox.spawn_requested") {
        return decide("PROVISIONING", {}, [{ kind: "spawn_sandbox" }]);
      }
      if (event.type === "publish.pr_opened") {
        return initializeReviewFromPublishedPr(event, guards);
      }
      return null;

    case "PROVISIONING":
      if (event.type === "sandbox.ready") {
        return decide("GENERATING", {}, [{ kind: "dispatch_prompt" }]);
      }
      return null;

    // ── Codegen ──────────────────────────────────────────────────────────────
    case "GENERATING":
      switch (event.type) {
        case "prompt.enqueued":
          // Real forward self-loop (sense ii): re-dispatch the next queued prompt.
          return decide("GENERATING", {}, [{ kind: "dispatch_prompt" }]);
        case "prompt.awaiting_input":
          return decide("AWAITING_INPUT", {}, []);
        case "prompt.terminal":
          switch (event.outcome) {
            case "changes":
              return decide("FINALIZING", {}, []);
            case "no_changes":
              return decide("ANSWERED_NO_PR", {}, []);
            case "error":
              // A CORROBORATED user-stop abort is NOT a codegen failure: fall through (null) to the
              // cross-cutting aborted→STOPPED edge so the stop policy has a single site (§10 layer
              // below). "aborted" alone is not trusted — the bridge overloads it (see types.ts).
              if (event.errorCode === "aborted" && event.stoppedByUser === true) return null;
              // F10/S — codegen error routes to FAILED, never ANSWERED_NO_PR.
              return decide("FAILED", { failureReason: "codegen_error" }, [{ kind: "loud" }]);
            default: {
              // Exhaustiveness: a new `outcome` variant must be handled here, not silently
              // demoted to the outer `return null` (an unhandled-event noop, sense i).
              const _exhaustive: never = event.outcome;
              return _exhaustive;
            }
          }
      }
      return null;

    case "AWAITING_INPUT":
      if (event.type === "user.input") {
        return decide("GENERATING", {}, [{ kind: "dispatch_prompt" }]);
      }
      return null;

    // ── Publish: post-execution decision (design §9) ──────────────────────────
    // `prompt_intends_change` is persisted on BOTH branches so a later
    // `publish.no_changes → ANSWERED_NO_PR` (or this `¬has_changes` branch) projects
    // "Answered" vs "No change produced" correctly (SF11). On `has_changes` we publish on
    // the diff ALONE — no sensitive-path / owner-approval pre-publish gate (D3/P1).
    case "FINALIZING":
      if (event.type === "postexec.done") {
        if (event.hasChanges) {
          return decide("PUBLISHING", { promptIntendsChange: event.promptIntendsChange }, [{ kind: "open_pr" }]);
        }
        return decide("ANSWERED_NO_PR", { promptIntendsChange: event.promptIntendsChange }, []);
      }
      return null;

    // ── Publish: opening the PR (design §9) ───────────────────────────────────
    case "PUBLISHING":
      switch (event.type) {
        case "publish.pr_opened":
          // `init_record` (B5): set `pr_url` + `head_sha := event.pr_head` on the existing row and reset
          // the per-PR review-loop counters. Verification is now spawned fire-and-forget HERE (decoupled
          // from the merge-ready gate): mint the run token (`verification_run_id += 1`), stamp the run
          // head, clear the child slot (the spawn executor's IS-NULL claim reads it), and return
          // SPAWN_VERIFICATION_CHILD. The executor declines when the session has auto-verify off
          // (verification-spawn.ts) and no-ops until PR-A3 re-keys resolveSpawnAnchor off run-id.
          return initializeReviewFromPublishedPr(event, guards);
        case "publish.no_changes":
          // N10: a `has_changes` turn whose diff is net-zero against base at publish (e.g.
          // the change was already merged) is a legitimate "no change produced" terminal,
          // not a contradiction of D3 (which only forbids discarding a NON-empty diff).
          return decide("ANSWERED_NO_PR", {}, []);
        case "publish.failed":
          return decide("FAILED", { failureReason: "publish_failed" }, [{ kind: "loud" }]);
        // N9 defensive race: a `pr.merged`/`pr.closed` webhook for the just-opened PR can
        // beat the `publish.pr_opened` transport event — terminate here so the session
        // can't proceed to `REVIEW` on an already-closed PR. This lands a FINAL terminal, so it
        // carries `finalTerminalCloseOut` (R4) too — the verifier child is not yet spawned at
        // PUBLISHING, so `killVerification` fires null-safe, and `terminate_runtime` reclaims the VM.
        case "pr.merged":
          return decide("MERGED", {}, finalTerminalCloseOut(guards));
        case "pr.closed":
          return decide("CLOSED", {}, finalTerminalCloseOut(guards));
      }
      return null;

    // ── Follow-up after a no-PR answer (design §9 follow-up edge) ─────────────
    case "ANSWERED_NO_PR":
      if (event.type === "user.input") {
        // Live sandbox → resume codegen directly; dead sandbox → re-provision first
        // (the spawned sandbox's `sandbox.ready` then re-dispatches the prompt).
        return guards.sandboxAlive
          ? decide("GENERATING", {}, [{ kind: "dispatch_prompt" }])
          : decide("PROVISIONING", {}, [{ kind: "spawn_sandbox" }]);
      }
      return null;

    // ── REVIEW: non-cascade self-loops + owner_approval (PR 15) + the caught_up cascade (PR 16) ─
    // The reactive self-loops drive the loop BETWEEN cascade evaluations (CI ciFix/cap/green, the
    // CI-settled + eager (v8) review-epoch dispatch, the epoch terminals, the head edges, the
    // owner_approval block); the `caught_up` event runs the 8-row merge-ready cascade (rows 1-8,
    // the sole MERGE_READY emitter). Everything else (`verification.*`, terminals) falls through to
    // `null` (unhandled — the caller logs a noop, runs no post-actions).
    case "REVIEW": {
      const noInflight = guards.noInflightEpoch ?? false;
      switch (event.type) {
        case "verification.requested":
          if (!verificationRequestUnderCap(event, guards)) {
            return decide("NEEDS_YOU", setBlockedReason("verification_run_limit"), [NOTIFY_QA_ISSUE]);
          }
          return decide(
            "VERIFYING",
            mergeWrites(
              advanceHead(event.headSha),
              setCodeChanged(),
              clearVerification(),
              requestVerification(guards.verificationRunCount ?? 0, guards.verificationRunId ?? 0, event.headSha),
            ),
            [],
          );

        // ── The 8-row `caught_up` cascade (PR 16, design §9 rows 1-8 — the merge-ready heart) ──
        case "caught_up":
          return caughtUpCascade(guards);

        // ── CI signals (folded PR 14 ciFix self-loops + the CI-settled epoch-1 trigger) ──
        case "ci.signal": {
          if (event.ciState === "failing") {
            // A discrete red exists. `[in_flight_epoch] / log_noop` — don't double-dispatch
            // or double-count while an epoch runs; a head advance supersedes a stale CI result.
            if (!noInflight) return decide("REVIEW", {}, [LOG_NOOP]);
            // `[no_inflight ∧ under_ci_fix_cap] / dispatch_epoch(ciFix), inc_ci_fix_rounds`
            // (this is also the CI-settled epoch-1 trigger's red case — epoch 1 = this ciFix).
            if (guards.underCiFixCap ?? false) {
              return decide(
                "REVIEW",
                mergeWrites(
                  incCiFixRounds(guards.ciFixRounds ?? 0),
                  setInFlightEpoch(requireNewEpochId(guards.newEpochId)),
                ),
                [dispatchEpoch("ci_fix")],
              );
            }
            // `[no_inflight ∧ ¬under_ci_fix_cap] → NEEDS_YOU(ci_fix_exhausted) / set blocked_reason, loud()`
            return decide("NEEDS_YOU", setBlockedReason("ci_fix_exhausted"), [LOUD]);
          }
          // green | absent. `[in_flight_epoch] / log_noop` — no reset yet (the green is re-observed
          // when the in-flight epoch completes, where the universal post-action fires; FG-2).
          if (!noInflight) return decide("REVIEW", {}, [LOG_NOOP]);
          // CI-settled epoch-1 trigger (no-actionable-review cohort): epoch 1 fires when CI SETTLES
          // (`ci_settled`, keyed on required checks/debounce so a late non-required check can't
          // false-fire it) carrying whatever is actionable. Green-with-nothing-actionable → no fire.
          if ((guards.ciSettled ?? false) && !(guards.epoch1Fired ?? false) && (guards.actionableExists ?? false)) {
            return decide("REVIEW", setInFlightEpoch(requireNewEpochId(guards.newEpochId)), [dispatchEpoch("review")]);
          }
          // FG-2 green self-loop: a green observed in REVIEW clears `ci_fix_rounds` (the §7-sanctioned
          // per-edge instance — the inv-11 universal form is wired PR 20) so a later red flap can't
          // trip `ci_fix_exhausted` on a stale carry. VALUE-GATED (W11-V5 SF10, MAJOR-1): only WRITE the
          // reset when there is a budget to clear — a no-op reset (`ci_fix_rounds` already 0) would make
          // this a non-empty field-write that ESCAPES the dwell-neutral shape rule and re-arms the
          // give-up on every no-inflight-green sweep tick. When already 0, emit the empty churn self-loop
          // (dwell-neutral); a REAL reset (was > 0 — CI just recovered) still writes AND re-arms (progress).
          return (guards.ciFixRounds ?? 0) > 0
            ? decide("REVIEW", resetCiFixRounds(), [LOG_NOOP])
            : decide("REVIEW", {}, [LOG_NOOP]);
        }

        // ── Review-epoch dispatch (v8 eager epoch-1 for the actionable-review-present cohort) ──
        case "review.received": {
          // Non-actionable noise (approving/empty review) registers nothing and re-opens nothing.
          if (!event.actionable) return decide("REVIEW", {}, [LOG_NOOP]);
          // Register the actionable review as UNDISPOSITIONED on arrival (committed bucket a, FG-5) —
          // never parked in a CI-first queue (delta §B1). v8: dispatch EAGERLY on `no_inflight ∧ actionable`
          // (the same predicate as epochs 2..n) WITHOUT waiting for CI-settled; if an epoch is in flight,
          // register only (the item accumulates and dispatches on the next no-inflight trigger).
          const reg = registerReview(guards.reviewSourceId ?? "");
          // §17-B: stamp `in_flight_epoch_id` ONLY when actually dispatching (an in-flight epoch keeps
          // its own id — don't overwrite); if in flight, register only (the item accumulates).
          return noInflight
            ? decide("REVIEW", setInFlightEpoch(requireNewEpochId(guards.newEpochId)), [dispatchEpoch("review")], [reg])
            : decide("REVIEW", {}, [], [reg]);
        }
        case "review.item_ready":
          // A previously-registered item became ready: dispatch eagerly when no epoch is in flight
          // (stamp the in-flight id under the same CAS, §17-B), else accumulate (no double-dispatch).
          return noInflight
            ? decide("REVIEW", setInFlightEpoch(requireNewEpochId(guards.newEpochId)), [dispatchEpoch("review")])
            : decide("REVIEW", {}, [LOG_NOOP]);

        // ── Epoch terminals (disposition + thread resolution; head/code on commit) ──
        case "epoch.committed": {
          // advance_head, set_code_changed, disposition(fixed), resolve_owned_threads. The committed
          // epoch's new head rides via guards (the event carries only epochId; head is in metadata).
          // §17-B: the terminal CLEARS `in_flight_epoch_id` in the same CAS, re-arming `no_inflight_epoch`.
          const writes =
            typeof guards.committedHead === "string"
              ? mergeWrites(advanceHead(guards.committedHead), setCodeChanged(), clearInFlightEpoch())
              : mergeWrites(setCodeChanged(), clearInFlightEpoch());
          const effects: SideEffect[] = [disposition(event.epochId, "fixed"), resolveOwnedThreads()];
          // A4 QA re-run: a review epoch just fixed a QA-sourced finding (a `known:cycloid-qa` item). If the
          // recorded verdict is still `app_breaks` and the fix advanced the head PAST the verified head,
          // re-verify — but only UNDER the per-PR run cap (else the caught_up cascade trips
          // NEEDS_YOU(verification_run_limit) on its own, never another run). `requestVerification` burns a run,
          // repoints the run head, mints a fresh run id, and nulls the child handle; the SPAWN executor declines
          // when the session has auto-verify off (verification-spawn.ts). NEVER re-run on head change alone — the
          // trigger is the QA-finding fix landing, observed here on `epoch.committed`.
          const headAdvanced =
            typeof guards.currentHeadSha === "string" && guards.currentHeadSha !== (guards.verdictHeadSha ?? null);
          // Re-entrancy fence: skip the re-arm if a run was already REQUESTED at this head (`requestVerification`
          // stamps `verification_run_head = currentHeadSha`). Without it, a redelivered/retried `epoch.committed`
          // for the same committed epoch re-fires the arm — `verdictHeadSha` still lags the old head so
          // `headAdvanced` stays true — spawning a duplicate concurrent verifier and burning a second run.
          const noRunAtCurrentHead = (guards.verificationRunHead ?? null) !== (guards.currentHeadSha ?? null);
          if (
            (guards.committedEpochDispositionedQaFinding ?? false) &&
            guards.recordedVerdict === "app_breaks" &&
            headAdvanced &&
            noRunAtCurrentHead &&
            (guards.verificationRunCount ?? 0) < MAX_VERIFICATION_RUNS_PER_PR
          ) {
            return decide(
              "REVIEW",
              mergeWrites(
                writes,
                requestVerification(
                  guards.verificationRunCount ?? 0,
                  guards.verificationRunId ?? 0,
                  guards.currentHeadSha ?? null,
                ),
              ),
              [...effects, SPAWN_VERIFICATION_CHILD],
            );
          }
          return decide("REVIEW", writes, effects);
        }
        case "epoch.replied": {
          const uncovered = guards.uncoveredActionableSourceIds ?? [];
          const effects: SideEffect[] = [disposition(event.epochId, "replied"), resolveOwnedThreads()];
          // ARC-1556: reply-only terminals keep the head stable, so queued actionable reviews can be
          // re-dispatched immediately instead of waiting for the 1-minute self-heal cron.
          return uncovered.length > 0
            ? decide("REVIEW", setInFlightEpoch(requireNewEpochId(guards.newEpochId)), [
                ...effects,
                dispatchEpoch("review"),
              ])
            : decide("REVIEW", clearInFlightEpoch(), effects);
        }
        case "epoch.declined": {
          const uncovered = guards.uncoveredActionableSourceIds ?? [];
          const effects: SideEffect[] = [disposition(event.epochId, "declined")];
          // Same-head decline terminals can chain the next queued wave immediately for the same reason as
          // reply-only terminals above: no code/head change means no need to wait for cron.
          return uncovered.length > 0
            ? decide("REVIEW", setInFlightEpoch(requireNewEpochId(guards.newEpochId)), [
                ...effects,
                dispatchEpoch("review"),
              ])
            : decide("REVIEW", clearInFlightEpoch(), effects);
        }
        case "epoch.settled": {
          // A review-loop epoch finalized with nothing to commit/reply/decline (bot-wait fallback drain, or
          // a benign block — head moved / not-this-session / CI-cap). ARC-1445: if the settle leaves items
          // no LIVE epoch covers (`uncoveredActionableSourceIds`, `disposition='none'` minus live-covered),
          // ARM THE DRAIN — mirroring the app_breaks verdict-return edge: stamp a FRESH `in_flight_epoch_id`
          // (setInFlightEpoch OVERWRITES the settling epoch's id; the producer supplies a synthetic id, never
          // the settling epoch's own, so the W11-V5 executor CREATES rather than re-observing the terminal
          // row) + `dispatch_epoch(review)` under the SAME CAS. At live `release_queued_reviews` is inert and
          // `caught_up` cannot fire with undispositioned ≥ 1, so the settle edge itself must dispatch.
          // Coupled to a NON-EMPTY set (like app_breaks' hard floor): with nothing uncovered, CLEAR the
          // marker ONLY so `no_inflight_epoch` re-opens and the cascade re-derives — never a bare-trigger
          // dispatch that would strand `in_flight_epoch_id` on a never-created epoch.
          const uncovered = guards.uncoveredActionableSourceIds ?? [];
          if (uncovered.length > 0) {
            return decide("REVIEW", setInFlightEpoch(requireNewEpochId(guards.newEpochId)), [dispatchEpoch("review")]);
          }
          return decide("REVIEW", clearInFlightEpoch(), []);
        }

        // ── epoch block → NEEDS_YOU (owner_approval P1/D8; response_failed ARC-1330) ──
        case "epoch.blocked":
          // Map the epoch-block reason to its NEEDS_YOU blocked_reason (owner_approval → owner_approval;
          // response_failed → review_response_failed). §17-B: a blocked epoch is no longer running — CLEAR
          // `in_flight_epoch_id` (like the other epoch terminals) so a later NEEDS_YOU re-open that does
          // NOT itself dispatch (user.retrigger / head.changed) isn't wedged by a stale non-null id.
          return decide(
            "NEEDS_YOU",
            mergeWrites(setBlockedReason(mapEpochBlockReason(event.reason)), clearInFlightEpoch()),
            [LOUD],
          );

        // ── Head edges (advance + verdict staleness bookkeeping; N4 two noop branches) ──
        case "head.changed":
          // Real code change: advance, mark stale, drop the recorded verdict so the cascade re-QAs.
          return decide("REVIEW", mergeWrites(advanceHead(event.headSha), setCodeChanged(), clearVerification()), []);
        case "head.noop_changed":
          // Content-noop push: both branches advance the head. `restamp_verification` rides ONLY the
          // `¬code_changed` branch (if code already changed the verdict is stale and re-QA is forced
          // anyway, so don't restamp). Total over `head.noop_changed` (N4).
          return (guards.codeChangedSinceVerification ?? false)
            ? decide("REVIEW", advanceHead(event.headSha), [])
            : decide("REVIEW", mergeWrites(advanceHead(event.headSha), restampVerification(event.headSha)), []);
      }
      // Verification verdicts are recorded off-gate (record-only self-loops); everything else is unhandled.
      return verificationBookkeeping("REVIEW", event, guards);
    }

    // ── VERIFYING: in-place head/review/ci self-loops + run-scoped-freshness verdict exits (PR 17, design §9 QA contract) ──
    // VERIFYING owns the head while a verification child runs. In-place edges keep the run alive (head churn
    // re-runs it, a noop keeps its verdict fresh, reviews queue into the disposition store, CI is ignored);
    // verdict events EXIT (every exit runs `kill_verification` on the ACTIVE run + `release_queued_reviews`),
    // EXCEPT the FG-1 ghost-discard: a verdict whose `run_id` doesn't match the active run is a late emission
    // from a SUPERSEDED run, dropped as a `VERIFYING→VERIFYING` `log_noop` that kills only the VERDICT's run.
    case "VERIFYING": {
      switch (event.type) {
        // ── Manual "Verify" button supersede (force-new-session) ──
        // A FORCED `verification.requested` (the manual PR "Verify" button) while a verifier is already
        // in flight must SUPERSEDE it — tear down the active run's child and admit a FRESH run at the
        // requested head — so each click yields a new session rather than reusing the in-flight one.
        // Unlike the FSM-native `head.changed` re-run, the spawn is owned by the coordinator (this edge
        // returns no SPAWN_VERIFICATION_CHILD, mirroring the REVIEW→VERIFYING dispatch which also spawns
        // via the coordinator), so it only kills the superseded child. A NON-forced request while
        // VERIFYING stays unhandled (falls through to null) — the coordinator returns the in-flight
        // verifier. `request_verification` BURNS a run (B1), so the manual supersede is still bounded by
        // the per-PR run cap unless the coordinator has confirmed a merge-conflicted PR and set the
        // targeted manual-QA bypass flag.
        case "verification.requested": {
          if (!event.force) return null;
          if (!verificationRequestUnderCap(event, guards)) {
            return decide("NEEDS_YOU", setBlockedReason("verification_run_limit"), [NOTIFY_QA_ISSUE]);
          }
          return decide(
            "VERIFYING",
            mergeWrites(
              advanceHead(event.headSha),
              setCodeChanged(),
              clearVerification(),
              requestVerification(guards.verificationRunCount ?? 0, guards.verificationRunId ?? 0, event.headSha),
            ),
            [killVerification(guards.verificationChildId ?? null)],
          );
        }

        // ── In-place self-loops (design §9: the run keeps owning the head) ──
        case "head.changed":
          // Real code change → tear down the superseded active child, re-run @ the new head. `redispatch`
          // mints a fresh `verification_run_id` but does NOT burn `verification_run_count` (B1); the spine
          // spawns the new run's child. `kill_verification` targets the ACTIVE run (it is being superseded).
          return decide(
            "VERIFYING",
            mergeWrites(
              advanceHead(event.headSha),
              redispatchVerification(guards.verificationRunId ?? 0, event.headSha),
            ),
            [killVerification(guards.verificationChildId ?? null), SPAWN_VERIFICATION_CHILD],
          );
        case "head.noop_changed":
          // Content-identical push: advance the live head and `restamp_verification` so the in-flight verdict
          // stays fresh (`verification_run_head`/the run is UNCHANGED → no re-run, SF9). No kill, no redispatch.
          return decide("VERIFYING", mergeWrites(advanceHead(event.headSha), restampVerification(event.headSha)), []);
        case "review.received": {
          // `queue_review` — the transient VERIFYING hold (design §9 queue-drain rule): VERIFYING owns the
          // head so a code-fix epoch can't dispatch; register the actionable review UNDISPOSITIONED in the
          // disposition store (committed bucket a) and DON'T dispatch — `release_queued_reviews` re-evaluates
          // dispatch on the next exit. Non-actionable noise queues nothing.
          if (!event.actionable) return decide("VERIFYING", {}, [LOG_NOOP]);
          return decide("VERIFYING", {}, [], [registerReview(guards.reviewSourceId ?? "")]);
        }
        case "ci.signal":
          // CI signals during VERIFYING are no-ops: `ci_green` is re-checked at the MERGE_READY gate via the
          // REVIEW cascade, so a red flip during VERIFYING can't reach READY (design §9 QA contract, S).
          return decide("VERIFYING", {}, [LOG_NOOP]);

        // ── Verdict exits — run-scoped freshness (fresh = event.run_id == verification_run_id, FG-1/inv 10) ──
        case "verification.pass":
        case "verification.skipped":
        case "verification.app_breaks": {
          const fresh = guards.verificationRunId !== undefined && event.runId === guards.verificationRunId;
          if (!fresh) {
            // FG-1 ghost-discard: a verdict from a SUPERSEDED run. Stay in VERIFYING (this is a self-loop, NOT
            // an exit, so it does NOT drain the queue) — `log_noop`, and `kill_verification` RUN-SCOPED to the
            // VERDICT's (already-dead) run, NEVER the live `verification_run_head` run. Do NOT record, NOT
            // redispatch, NOT consult the cap, NOT terminate: the live run still reports (cascade row 2 handles
            // genuine non-convergence, B1).
            return decide("VERIFYING", {}, [LOG_NOOP, killVerification(guards.verdictVerificationChildId ?? null)]);
          }
          // Fresh accept → REVIEW. `record_verification` stamps the verdict fresh against the live head (so the
          // cascade's `verification_fresh` holds, D11); every exit `release_queued_reviews` (drain the hold) +
          // `kill_verification` the ACTIVE run. A4: QA re-intake for an `app_breaks` verdict NO LONGER rides the
          // spine — the QA verifier posts a managed PR comment that the review-loop intake admits as
          // `known:cycloid-qa`, so there is no `inject_findings` and no epoch dispatch here. Every verdict exit
          // is record-only. `record_verification` still PRESERVES `verification_run_count` for `app_breaks` (B1;
          // it resets only on an approving verdict), so the cascade's cap accounting is unchanged.
          const verdict =
            event.type === "verification.pass"
              ? "pass"
              : event.type === "verification.skipped"
                ? "skipped"
                : "app_breaks";
          const writes = recordVerification(verdict, event.headSha);
          const effects = [RELEASE_QUEUED_REVIEWS, killVerification(guards.verificationChildId ?? null)];
          return decide("REVIEW", writes, effects);
        }

        // ── Terminal exits ──
        case "verification.run_limit":
          // Cap reached → NEEDS_YOU (re-openable, post-publish — not FAILED, S). Drain + teardown + loud.
          // NOT freshness-gated (deliberate): the run cap is a PER-PR budget property, not a per-run
          // verdict — a stale run's cap-exhaustion signal still reflects the PR's spent budget, and the
          // FSM's own cascade row 2 independently bounds genuine non-convergence.
          return decide("NEEDS_YOU", setBlockedReason("verification_run_limit"), [
            RELEASE_QUEUED_REVIEWS,
            LOUD,
            killVerification(guards.verificationChildId ?? null),
          ]);
        case "verification.stopped":
        case "verification.failed": {
          // RUN-SCOPED like the verdict exits (PR 47, the #6046-deferred soundness fix): stopped/failed
          // carry the run they died in. A STALE one (event.runId ≠ the active run) is a late emission
          // from a SUPERSEDED run — e.g. the killed child of an in-VERIFYING `head.changed` re-run
          // reporting its teardown — and must NOT terminalize the NEWER live run: ghost-discard it
          // (`log_noop` self-loop, NOT an exit — no drain) and kill only the VERDICT's (already-dead)
          // run, exactly the FG-1 rule. The live run still reports its own terminal.
          const terminalFresh = guards.verificationRunId !== undefined && event.runId === guards.verificationRunId;
          if (!terminalFresh) {
            return decide("VERIFYING", {}, [LOG_NOOP, killVerification(guards.verdictVerificationChildId ?? null)]);
          }
          // Fresh: verification infra failure / contract violation on the ACTIVE run →
          // NEEDS_YOU(verification_stopped). Drain + teardown + loud.
          return decide("NEEDS_YOU", setBlockedReason("verification_stopped"), [
            RELEASE_QUEUED_REVIEWS,
            LOUD,
            killVerification(guards.verificationChildId ?? null),
          ]);
        }
      }
      // Terminals (`pr.merged`/`pr.closed`/`user.stop`/`session.archived`) and cross-cutting deadline edges
      // arrive in PR 19; everything else is unhandled in VERIFYING → null (the caller logs a noop).
      return null;
    }

    // ── MERGE_READY: terminal re-entry edges (PR 18, design §9 lines 296-300 / §17-D) ──
    // `MERGE_READY` is signal-only (a human merges). These re-opens send a settled-Ready PR back into the
    // review loop on new work. The re-opens OMIT `release_queued_reviews`: the queue is PROVABLY empty —
    // `MERGE_READY` was reached via the `caught_up` cascade (`no_inflight_epoch ∧ no undispositioned items`),
    // so there is nothing transient to drain (contrast `NEEDS_YOU`, which CAN sit on a stranded queue). The
    // §17-D flap cap (`merge_ready_reopen_count`, NEVER reset on entry) bounds an indefinite red-CI flap.
    case "MERGE_READY":
      switch (event.type) {
        case "verification.requested":
          if (!verificationRequestUnderCap(event, guards)) {
            return decide("NEEDS_YOU", setBlockedReason("verification_run_limit"), [NOTIFY_QA_ISSUE]);
          }
          return decide(
            "VERIFYING",
            mergeWrites(
              advanceHead(event.headSha),
              setCodeChanged(),
              clearVerification(),
              requestVerification(guards.verificationRunCount ?? 0, guards.verificationRunId ?? 0, event.headSha),
            ),
            [],
          );
        case "review.received":
          // Non-actionable noise (approving/empty review) does NOT re-open a Ready PR.
          if (!event.actionable) return decide("MERGE_READY", {}, [LOG_NOOP]);
          // Defect 3 / B6: register the triggering review UNDISPOSITIONED and dispatch it — it is not merely
          // "consumed", so `caught_up` stays false (open epoch + undispositioned item) and the session can't
          // bounce straight back to MERGE_READY and drop the review. `reset qa_runs` gives a fresh verification
          // budget; `ci_fix_rounds` is already 0 (reset at the green that produced READY). No epoch is in flight
          // in MERGE_READY, so dispatch is unconditional (no `no_inflight_epoch` guard).
          return decide(
            "REVIEW",
            mergeWrites(resetVerificationRunCount(), setInFlightEpoch(requireNewEpochId(guards.newEpochId))),
            [dispatchEpoch("review")],
            [registerReview(guards.reviewSourceId ?? "")],
          );
        case "head.changed":
          // Real code change after Ready: advance, mark stale, drop the recorded verdict so the cascade re-QAs,
          // and reset the verification budget for the fresh head.
          return decide(
            "REVIEW",
            mergeWrites(advanceHead(event.headSha), setCodeChanged(), clearVerification(), resetVerificationRunCount()),
            [],
          );
        case "head.noop_changed":
          // Content-noop push: advance the live head and restamp the verdict fresh — stays Ready (no re-QA).
          return decide("MERGE_READY", mergeWrites(advanceHead(event.headSha), restampVerification(event.headSha)), []);
        case "ci.signal":
          // Only a red flip re-opens a Ready PR (SF7: NO `set_code_changed` — a flaky CI flip on identical code
          // must not force a spurious re-QA). Green/absent is a no-op (already Ready) → unhandled, falls to null.
          if (event.ciState !== "failing") return null;
          // §17-D flap cap: a red-CI re-open past `MAX_MERGE_READY_REOPENS` trips `ci_flapping` instead of
          // re-opening yet again (READY⇄REVIEW flap bound). The dedicated `emit_cap_trip` count metric
          // (Locked decision 5b) rides alongside `loud()` so the bound is retunable post-shadow from the
          // trip rate — distinct from `loud()`'s generic `emit_dd`.
          if (!(guards.underMergeReadyReopenCap ?? false)) {
            return decide("NEEDS_YOU", setBlockedReason("ci_flapping"), [
              LOUD,
              emitCapTrip("merge_ready_reopen", MAX_MERGE_READY_REOPENS),
            ]);
          }
          // Under cap: re-open to REVIEW — bump the lifetime reopen count + start a fresh ciFix budget
          // (`ci_fix_rounds` was 0 at the row-7 green, so `inc`→1).
          return decide(
            "REVIEW",
            mergeWrites(
              incMergeReadyReopenCount(guards.mergeReadyReopenCount ?? 0),
              incCiFixRounds(guards.ciFixRounds ?? 0),
              setInFlightEpoch(requireNewEpochId(guards.newEpochId)),
            ),
            [dispatchEpoch("ci_fix")],
          );
      }
      // Everything else (terminals, `caught_up`, etc.) is unhandled in MERGE_READY → null.
      return verificationBookkeeping("MERGE_READY", event, guards);

    // ── NEEDS_YOU: terminal re-entry edges (PR 18, design §9 lines 301-305) ──
    // The re-openable loud terminal. Every re-open back into the review loop CLEARS the block, DRAINS any
    // transient QA queue stranded before the block (`release_queued_reviews`, B2), and resets BOTH caps
    // (`reset qa_runs` + `reset_ci_fix_rounds`) so the re-opened loop starts with a fresh budget.
    case "NEEDS_YOU":
      switch (event.type) {
        case "verification.requested":
          const requestHeadChanged = "headSha" in guards && guards.headSha !== event.headSha;
          if (!requestHeadChanged && !verificationRequestUnderCap(event, guards)) {
            return decide("NEEDS_YOU", setBlockedReason("verification_run_limit"), [NOTIFY_QA_ISSUE]);
          }
          return decide(
            "VERIFYING",
            mergeWrites(
              clearBlock(),
              resetCiFixRounds(),
              advanceHead(event.headSha),
              setCodeChanged(),
              clearVerification(),
              requestVerification(
                requestHeadChanged ? 0 : (guards.verificationRunCount ?? 0),
                guards.verificationRunId ?? 0,
                event.headSha,
              ),
            ),
            [RELEASE_QUEUED_REVIEWS],
          );
        case "review.received":
          // Non-actionable noise does not re-open a blocked session or re-arm the caps.
          if (!event.actionable) return decide("NEEDS_YOU", {}, [LOG_NOOP]);
          return decide(
            "REVIEW",
            mergeWrites(
              clearBlock(),
              resetVerificationRunCount(),
              resetCiFixRounds(),
              setInFlightEpoch(requireNewEpochId(guards.newEpochId)),
            ),
            [RELEASE_QUEUED_REVIEWS, dispatchEpoch("review")],
            [registerReview(guards.reviewSourceId ?? "")],
          );
        case "user.retrigger":
          // The sole MANUAL retrigger back into the review loop (the `FAILED → PROVISIONING` retrigger re-spawns
          // codegen pre-publish, not the loop). `set_code_changed` forces the cascade to re-QA on retrigger.
          // Only a review-stuck terminal carries a stale in-flight epoch marker; other NEEDS_YOU reasons can
          // coexist with a still-live epoch and must not clear its ownership marker.
          return decide(
            "REVIEW",
            mergeWrites(
              clearBlock(),
              setCodeChanged(),
              resetVerificationRunCount(),
              resetCiFixRounds(),
              guards.blockedReason === "review_stuck" ? clearInFlightEpoch() : {},
            ),
            [RELEASE_QUEUED_REVIEWS],
          );
        case "head.changed":
          // Real code change while blocked: advance + mark stale + drop the verdict, clear the block, drain, reset.
          return decide(
            "REVIEW",
            mergeWrites(
              advanceHead(event.headSha),
              setCodeChanged(),
              clearVerification(),
              clearBlock(),
              resetVerificationRunCount(),
              resetCiFixRounds(),
              clearInFlightEpoch(),
            ),
            [RELEASE_QUEUED_REVIEWS],
          );
        case "head.noop_changed":
          // Content-noop push: advance + restamp the verdict; stays blocked (no re-open).
          return decide("NEEDS_YOU", mergeWrites(advanceHead(event.headSha), restampVerification(event.headSha)), []);
      }
      // Everything else (terminals, `caught_up`, etc.) is unhandled in NEEDS_YOU → null.
      return verificationBookkeeping("NEEDS_YOU", event, guards);

    // ── FAILED: infra retrigger (PR 18, design §9 line 306) + system-retry re-entry (ARC-1470) ──
    // `FAILED` is the loud INFRA terminal, re-openable by a manual retrigger that re-spawns codegen from
    // scratch (PROVISIONING), distinct from the `NEEDS_YOU` retrigger (which re-enters the review loop). N6:
    // `clear_failure_reason` so a re-spawned session doesn't carry the stale reason through PROVISIONING/GENERATING.
    // `prompt.enqueued` is the SYSTEM retry (ARC-1470): the platform re-enqueues on the live sandbox after a
    // transient prompt error (verifier reuse, auto-retry) — without this edge the record rests FAILED forever
    // while the session heals. Recovery is quiet (the FAILED entry already fired loud), same N6 hygiene; if
    // the retry dies too, the GENERATING core / hard-failure edges simply re-fail it.
    case "FAILED":
      switch (event.type) {
        case "user.retrigger":
          return decide("PROVISIONING", clearFailureReason(), [{ kind: "spawn_sandbox" }]);
        case "prompt.enqueued":
          return decide("GENERATING", clearFailureReason(), [{ kind: "dispatch_prompt" }]);
      }
      return null;

    // ── STOPPED: phase-aware resume (PR 19c, design §10 "Resume (phase-aware)") ──
    // Only a `resumable` stop re-enters on `user.input` (the `[resumable]` guard); a `user` cancel does not.
    // The target is selected by `pre_stop_state` so a resume re-enters the phase it stopped in WITHOUT
    // discarding work: codegen re-dispatches (or re-provisions a dead sandbox), publish re-runs post-exec /
    // retries `open_pr` (only a dead sandbox with an UNPUSHED diff falls back to PROVISIONING, SF12), REVIEW
    // re-arms its watch, and a VERIFYING resume re-enters REVIEW (QA is non-blocking; the CI ladder owns
    // merge-readiness, so the interrupted run is not re-dispatched — resuming to the live REVIEW phase is
    // drain-consistent and avoids stranding the session in STOPPED). The map is TOTAL over the resumable
    // phases (SF12). Terminal close-out (`pr.merged`/`pr.closed`)
    // and `session.archived` for a STOPPED session fall through to the cross-cutting layer.
    case "STOPPED": {
      if (event.type === "prompt.enqueued") {
        // Re-prompt re-entry (mirrors the FAILED ARC-1470 edge): a stopped session resumes via a new
        // composer prompt, which reaches the spine as `prompt.enqueued` (`user.input` is plan-approval-
        // only) — without this edge the record rests STOPPED forever while the session actually resumes.
        // stop_mode-agnostic: a user cancel and a resumable stop both recover on a real re-prompt. But
        // pre_stop_state-AWARE: ANY post-publish stop (e.g. a backfilled live-PR stop) must re-enter
        // its live post-publish phase, never pre-publish GENERATING (which would misproject a
        // published session as codegen). REVIEW is the drain-consistent target for the whole group:
        // VERIFYING resumes there like the user.input map (QA is non-blocking and drain-only), and a
        // MERGE_READY/NEEDS_YOU pre_stop_state — unreachable today (user.stop is unhandled in the
        // resting terminals) — re-arms the loop and lets the caught_up cascade re-derive the outcome.
        // N6: clear the stop fields on exit, like every STOPPED → … edge.
        return guards.preStopState !== undefined && POST_PUBLISH_PR_STATES.includes(guards.preStopState)
          ? decide("REVIEW", clearStop(), [])
          : decide("GENERATING", clearStop(), [{ kind: "dispatch_prompt" }]);
      }
      if (event.type !== "user.input") return null;
      if (guards.stopMode !== "resumable") return null;
      let resumed: Decision | null;
      switch (guards.preStopState) {
        case "GENERATING":
        case "AWAITING_INPUT":
          resumed = guards.sandboxAlive
            ? decide("GENERATING", {}, [{ kind: "dispatch_prompt" }])
            : decide("PROVISIONING", {}, [{ kind: "spawn_sandbox" }]);
          break;
        case "FINALIZING":
        case "PUBLISHING":
          resumed =
            !guards.sandboxAlive && (guards.unpushedDiff ?? false)
              ? decide("PROVISIONING", {}, [{ kind: "spawn_sandbox" }])
              : guards.preStopState === "PUBLISHING"
                ? decide("PUBLISHING", {}, [{ kind: "open_pr" }])
                : decide("FINALIZING", {}, []);
          break;
        case "REVIEW":
          resumed = decide("REVIEW", {}, []);
          break;
        case "VERIFYING":
          // A VERIFYING resume re-enters REVIEW, not VERIFYING: QA is non-blocking and the CI ladder owns
          // merge-readiness, so a stopped verification run does not need to be re-dispatched — resuming to
          // REVIEW is drain-consistent (the loop re-arms its watch) and drops the prompt into a live phase
          // instead of stranding the session in STOPPED.
          resumed = decide("REVIEW", {}, []);
          break;
        default:
          return null;
      }
      // N6: leaving STOPPED clears the stop fields on EVERY resume target (none persist outside
      // STOPPED) — mirrors clear_block / clear_failure_reason. Merged here so no path can forget it.
      return { ...resumed, fieldWrites: mergeWrites(resumed.fieldWrites, clearStop()) };
    }

    default:
      return null;
  }
}

// ── Cross-cutting edges (§10) — group-membership edges layered UNDER the per-state core ──
// These are NOT keyed to a single state: they fire for an event from any state in a named GROUP. The
// per-state core wins first (so GENERATING's own `prompt.terminal{error}→FAILED(codegen_error)` and
// PUBLISHING's N9 `pr.merged/closed` race keep their specific Decisions); only events the core leaves
// UNHANDLED reach this layer. Each group is the exact §10 set (membership is the test surface).

/** Hard-failure group (§10): infra/agent death pre-publish → `FAILED`. `AWAITING_INPUT` is deliberately NOT here (F4). */
const HARD_FAILURE_STATES: readonly FsmState[] = ["CREATED", "PROVISIONING", "GENERATING", "FINALIZING", "PUBLISHING"];
/** Post-publish group (§10): a live PR exists → `pr.merged/closed` close it out. `PUBLISHING` is the N9 race (core). */
const POST_PUBLISH_PR_STATES: readonly FsmState[] = ["REVIEW", "VERIFYING", "MERGE_READY", "NEEDS_YOU", "STOPPED"];
/** The non-terminal states (§10): `user.stop` stops these; the resting terminals are excluded. */
const NON_TERMINAL_STATES: readonly FsmState[] = [
  "CREATED",
  "PROVISIONING",
  "GENERATING",
  "AWAITING_INPUT",
  "FINALIZING",
  "PUBLISHING",
  "REVIEW",
  "VERIFYING",
];
/** Final terminals (§10 / F26): `session.archived` does NOT re-target these (they are already final). */
const FINAL_TERMINAL_STATES: readonly FsmState[] = ["MERGED", "CLOSED", "SUPERSEDED", "ARCHIVED"];

/**
 * `kill_verification` rides every terminal close-out that ABANDONS the PR — it tears down the ACTIVE
 * run's verifier child (`verification_child_id`), a null handle being a safe no-op.
 *
 * A3: gated on the HANDLE, not the state. Pre-A3 the only state that could own a verifier child was
 * `VERIFYING`, so the kill was `state === "VERIFYING"`-gated. A3 spawns the verifier fire-and-forget on
 * the `publish.pr_opened → REVIEW` edge, running in PARALLEL with the review loop, so a live
 * `verification_child_id` can now ride a REVIEW row and OUTLIVE it into MERGE_READY / NEEDS_YOU. Keeping
 * the old `VERIFYING`-only gate would orphan that child on a `pr.merged`/`pr.closed`/`publish.superseded`/
 * `user.stop`/`session.archived` close-out from any non-VERIFYING state, leaving the QA session running
 * (and publishing/syncing results) against a PR the lifecycle has already abandoned. Reading the kill off
 * the record-sourced handle covers every owner state; the childless close-out stays an inert null kill.
 *
 * QUEUE-DRAIN NOTE (§9, the #6046-deferred `RELEASE_QUEUED_REVIEWS` re-review, PR 47): these
 * cross-cutting close-outs (`pr.merged`/`pr.closed`/`publish.superseded`/`user.stop`/
 * `session.archived`) DELIBERATELY carry the kill WITHOUT `release_queued_reviews`. The drain is
 * "re-evaluate dispatch of held reviews once the head is free" — meaningful only where the review
 * loop CONTINUES: the verdict returns to REVIEW, the `run_limit`/`stopped`/`failed` + deadline
 * NEEDS_YOU terminals (all drain, per-edge above/`deadlineTransition`), and the NEEDS_YOU→REVIEW
 * re-opens. Every exit here lands a CLOSE-OUT terminal (MERGED/CLOSED/SUPERSEDED/ARCHIVED, or a
 * user STOPPED) — there is no loop left to dispatch into, so draining would emit `review.item_ready`
 * triggers against a dead/parked PR. §9's "every VERIFYING exit drains" is scoped to the loop-
 * continuing exits; the ghost-discard self-loop and the terminal close-outs are the two exceptions.
 */
function killOwnedVerifierOnTerminalExit(guards: Guards): readonly SideEffect[] {
  return [killVerification(guards.verificationChildId ?? null)];
}

/**
 * `finalTerminalCloseOut` (R4) — the close-out effect bag for a FINAL terminal
 * (`MERGED`/`CLOSED`/`SUPERSEDED`/`ARCHIVED`, including the N9 `PUBLISHING` race): tear down any owned
 * verifier child (`killOwnedVerifierOnTerminalExit`) AND reclaim the session's runtime VM
 * (`terminate_runtime`) so a final-terminal session never parks a paused VM for the 72h retention window.
 *
 * ONLY for FINAL terminals. `user.stop → STOPPED` MUST NOT use this — a user stop keeps the session
 * RESUMABLE, so its VM is deliberately retained (the idle/lease/72h paths own it); it stays on
 * `killOwnedVerifierOnTerminalExit`. The other re-openable terminals (`NEEDS_YOU`/`FAILED`/`STOPPED`)
 * likewise keep today's retention semantics — they carry no `terminate_runtime`.
 */
function finalTerminalCloseOut(guards: Guards): readonly SideEffect[] {
  return [...killOwnedVerifierOnTerminalExit(guards), TERMINATE_RUNTIME];
}

/** The `deadline_exceeded` targets (§10 Deadlines). Loud terminals per D1; `MERGE_READY` is a non-terminal cron reconcile (D17). */
function deadlineTransition(state: FsmState, guards: Guards): Decision | null {
  switch (state) {
    case "CREATED":
    case "PROVISIONING":
      return decide("FAILED", setFailureReason("spawn_timeout"), [LOUD]);
    case "GENERATING":
    case "FINALIZING":
    case "PUBLISHING":
      return decide("FAILED", setFailureReason("execution_timeout"), [LOUD]);
    case "AWAITING_INPUT":
      // Resumable, NO blocked_reason (a wait-state abandon, not a block).
      return decide("STOPPED", setStop("resumable", "AWAITING_INPUT"), []);
    case "REVIEW":
      // Drain the transient VERIFYING queue so it isn't stranded on the REVIEW timeout (B2); loud per D1.
      //
      // SF10 (W11-V5 — the accepted retry-budget re-expression, form (b)): this {epoch-state} deadline
      // → NEEDS_YOU(review_stuck) IS the loud give-up that REPLACES the legacy epoch
      // `transient_failure_count` cap. An in-flight epoch lives in REVIEW; a stuck/permanently-deferred
      // epoch never terminates, so the dwell deadline fires and hands the session to the user loudly.
      // No FSM guard/field carries a per-epoch transient counter (design §14 KEEP#2: "the CAS gives
      // mutual exclusion, not liveness"). CRITICAL (the adversarial-review fix): this give-up is
      // CHURN-IMMUNE. Every per-tick REVIEW self-loop that changes nothing — `epoch.deferred` AND the
      // re-observed `ci.signal(green|absent|failing)[in_flight]` the sweep co-emits every tick, AND the
      // cascade row-5 ci_pending WAIT — is dwell-neutral (transition.isDwellNeutralSelfLoop, the
      // decision-SHAPE authority; VERIFYING's 1h backstop is covered the same way), so it journals
      // WITHOUT re-arming this deadline. Unbounded contention/
      // transient re-claims + settled-CI polling can NOT push the give-up out; the backstop fires
      // `REVIEW_STUCK_DEADLINE_MS` (constants/review-loop.ts — 4h since #6667, was 24h) after the last
      // REAL progress (a field-write / registration). D-53 drops the legacy counter columns
      // on the strength of this pin; see apply-event.test.ts (the MIXED-churn continuous proof).
      return decide("NEEDS_YOU", setBlockedReason("review_stuck"), [RELEASE_QUEUED_REVIEWS, LOUD]);
    case "VERIFYING":
      // The COARSE CONTRACT BACKSTOP for a verification child that emitted no terminal event — explicitly NOT a
      // liveness signal (P2). Drain (B2) + run-scoped teardown + loud (D1).
      return decide("NEEDS_YOU", setBlockedReason("verification_stopped"), [
        RELEASE_QUEUED_REVIEWS,
        killVerification(guards.verificationChildId ?? null),
        LOUD,
      ]);
    case "MERGE_READY":
      // D17: NOT a terminal — the long reconcile deadline re-polls PR state via a CROSS-SESSION cron sweep
      // (DE-3), catching a dropped `pr.merged`/`pr.closed` webhook. The pure edge stays Ready and re-arms (the
      // universal `arm_deadline` post-action), so the FSM is a handled self-loop `log_noop` (every active/wait
      // state has a `deadline_exceeded` target, inv 12); the actual reconcile is cron-owned, not an FSM edge.
      return decide("MERGE_READY", {}, [LOG_NOOP]);
    default:
      // The resting terminals (`NEEDS_YOU`/`STOPPED`/`ANSWERED_NO_PR`/final) have no §10 deadline target → unhandled.
      return null;
  }
}

function crossCuttingTransition(state: FsmState, event: FsmEvent, guards: Guards): Decision | null {
  switch (event.type) {
    // ── Hard-failure → FAILED (loud, set failure_reason); the F4 exception: AWAITING_INPUT death → STOPPED(resumable) ──
    case "sandbox.death":
    case "sandbox.liveness_expired":
      if (state === "AWAITING_INPUT") {
        // Wait-state sandbox death is RESUMABLE, not a hard failure (F4) — the user's pending input survives.
        return decide("STOPPED", setStop("resumable", "AWAITING_INPUT"), []);
      }
      return HARD_FAILURE_STATES.includes(state) ? decide("FAILED", setFailureReason("sandbox_failed"), [LOUD]) : null;
    case "sandbox.spawn_failed":
      return HARD_FAILURE_STATES.includes(state) ? decide("FAILED", setFailureReason("sandbox_failed"), [LOUD]) : null;
    case "prompt.max_duration_exceeded":
      return HARD_FAILURE_STATES.includes(state)
        ? decide("FAILED", setFailureReason("execution_timeout"), [LOUD])
        : null;
    case "prompt.terminal": {
      // Only the `{error}` outcome is a hard failure here (N3); `{changes,no_changes}` are GENERATING-core
      // concerns and unhandled elsewhere. GENERATING's own `{error}` Decision wins via the core (same reason).
      if (event.outcome !== "error" || !HARD_FAILURE_STATES.includes(state)) return null;
      // errorCode "aborted" + the DO's stoppedByUser corroboration = a delivered control-plane stop —
      // the transport-delivered `user.stop` signal, not a codegen failure. Same close-out shape as the
      // `user.stop` edge below: quiet STOPPED(user), verifier kill (null-safe pre-publish), NO loud,
      // NO failure_reason. The GENERATING core deliberately falls through here so this is the stop
      // policy's single site. An UNCORROBORATED "aborted" (classifyError text-match, external session
      // delete, failsafe abort) is a genuine failure and stays on the loud FAILED path below.
      if (event.errorCode === "aborted" && event.stoppedByUser === true) {
        return decide("STOPPED", setStop("user", state), killOwnedVerifierOnTerminalExit(guards));
      }
      return decide("FAILED", setFailureReason("codegen_error"), [LOUD]);
    }

    // ── PR closed out → terminal-final (post-publish group; PUBLISHING's N9 race is the core's) ──
    case "pr.merged":
      return POST_PUBLISH_PR_STATES.includes(state) ? decide("MERGED", {}, finalTerminalCloseOut(guards)) : null;
    case "pr.closed":
      return POST_PUBLISH_PR_STATES.includes(state) ? decide("CLOSED", {}, finalTerminalCloseOut(guards)) : null;
    case "publish.superseded":
      // Benign publish supersede (ARC-1389): a review-loop epoch publish was benignly overtaken (head
      // moved / the session moved on) while the PR stays OPEN — so `pr.closed` is semantically wrong; the
      // session settles in the neutral SUPERSEDED terminal and `project()` renders the `superseded` phase
      // faithfully (not `completed`). Scoped to the review-listening states where the legacy write site
      // (`blockReviewLoopPublish`'s benign branch) can fire; anywhere else the event is unhandled (null).
      return state === "REVIEW" || state === "VERIFYING"
        ? decide("SUPERSEDED", {}, finalTerminalCloseOut(guards))
        : null;

    // ── Stop / archive ──
    case "user.stop":
      return NON_TERMINAL_STATES.includes(state)
        ? decide("STOPPED", setStop("user", state), killOwnedVerifierOnTerminalExit(guards))
        : null;
    case "session.archived":
      // Non-terminal AND the non-final terminals (F26) = every state EXCEPT the final terminals.
      return FINAL_TERMINAL_STATES.includes(state) ? null : decide("ARCHIVED", {}, finalTerminalCloseOut(guards));

    // ── Epoch deferral journal (W11-V5, §17-B) ──
    // A dispatch tick for an in-flight epoch could not proceed (contention / transient poll failure)
    // and re-observes it next tick. This is NEVER a state change — the epoch stays in-flight and the
    // §10 REVIEW deadline is the give-up (SF10). It journals as a `log_noop` self-loop ONLY in REVIEW,
    // where an in-flight epoch lives; anywhere else (the FSM already moved on) it is a benign unhandled
    // no-op. The legacy `pr_review_response_epochs` lease-defer write still runs alongside until D-53.
    case "epoch.deferred":
      return state === "REVIEW" ? decide("REVIEW", {}, [LOG_NOOP]) : null;

    // ── Deadlines (§10) ──
    case "deadline_exceeded":
      return deadlineTransition(state, guards);

    default:
      return null;
  }
}

/**
 * Pure FSM transition: map (state, event, guards) to the Decision for that edge, or `null` when no edge
 * matches (an unhandled event — the caller logs a noop and runs no post-actions). The per-state core edges
 * win first; an event the core leaves unhandled falls through to the cross-cutting (§10) group edges.
 */
export function transition(state: FsmState, event: FsmEvent, guards: Guards): Decision | null {
  return coreTransition(state, event, guards) ?? crossCuttingTransition(state, event, guards);
}

/**
 * The states whose dwell-based §10 give-up would be blinded by per-tick churn — so a pure-churn
 * self-loop in one of them must NOT re-arm the deadline. REVIEW (the `REVIEW_STUCK_DEADLINE_MS`
 * `review_stuck` backstop) and
 * VERIFYING (the 1h verification backstop, `fireStuckVerificationBackstops`). MERGE_READY is
 * DELIBERATELY EXCLUDED: its reconcile self-loop is an INTENTIONAL keep-alive re-arm of a healthy poll.
 */
export const DWELL_NEUTRAL_SELF_LOOP_STATES: ReadonlySet<FsmState> = new Set(["REVIEW", "VERIFYING"]);

/**
 * The AUTHORITY for dwell-neutrality (W11-V5 SF10 — generalized after adversarial re-review). A handled
 * SELF-LOOP (`decision.to === fromState`) in a {@link DWELL_NEUTRAL_SELF_LOOP_STATES} state whose Decision
 * changes NOTHING observable — EMPTY `fieldWrites`, side-effects ⊆ `{log_noop}`, and NO worklist
 * registrations — is PURE CHURN, so the spine SKIPS its `arm_deadline` post-action: `state_entered_at`/
 * `deadline_at` are PRESERVED, keeping the dwell-based §10 give-up REACHABLE. The deadline then fires the
 * full window after the last REAL progress, immune to per-tick churn.
 *
 * WHY SHAPE, NOT EVENT: the sweep co-emits `ci.signal(green|absent|failing)` EVERY tick for the SAME
 * review-listening sessions (review-loop-sweep.ts), and a re-observed-identical signal decides a
 * `log_noop` self-loop in BOTH REVIEW (the `[in_flight_epoch]` branches) AND VERIFYING (ci ignored while
 * a verifier runs) — IDENTICAL churn to `epoch.deferred`. An event-only rule missed it, leaving the
 * give-up unreachable for the settled-CI contended class (a LATENT pre-existing bug this rule also
 * closes — the VERIFYING half is the live symptom the T0 triage saw as 3 rows stuck 16-17h).
 *
 * COMPLETE churn set this covers, each verified genuine churn (constraint b):
 *   • REVIEW: cascade row-5 `ci_pending` WAIT (its own comment relies on review_stuck firing for
 *     permanently-pending CI); `ci.signal(failing|green|absent)[in_flight]`; `review.received[¬actionable]`
 *     (noise); `review.item_ready[in_flight]` (accumulate); `epoch.deferred`.
 *   • VERIFYING: `ci.signal` (ignored during VERIFYING, §9 QA contract); `review.received[¬actionable]`
 *     (noise queued into nothing).
 * Everything representing PROGRESS writes a field/registration or carries a non-`log_noop` effect and
 * correctly STILL re-arms: an actionable `review.received` (`decide(state, {}, [], [reg])` — EXCLUDED by
 * the worklist clause), a ci-bucket transition dispatching a ciFix epoch, a head advance / re-run, an
 * epoch terminal, the value-gated FG-2 green reset that WRITES `ci_fix_rounds` (MAJOR-1 — a no-op reset
 * is empty, a real one re-arms), and the FG-1 ghost-discard verdicts (they carry a `kill_verification`
 * side-effect — not `log_noop`-only — and are rare/not-per-tick, so re-arming is harmless).
 */
export function isDwellNeutralSelfLoop(fromState: FsmState, decision: Decision): boolean {
  return (
    DWELL_NEUTRAL_SELF_LOOP_STATES.has(fromState) &&
    decision.to === fromState &&
    Object.keys(decision.fieldWrites).length === 0 &&
    decision.sideEffects.every((effect) => effect.kind === "log_noop") &&
    (decision.worklistRegistrations?.length ?? 0) === 0
  );
}
