// ARC-1330 lifecycle FSM (PR 44) — DEADLINE producer: the per-session DO alarm → `deadline_exceeded`
// spine event → the §10 anti-silent-stall backstop.
//
// THE v7 DE-3 MOVE (cont.). Every active/wait state has a `deadline_at` (the universal `arm_deadline`
// post-action stamps `now + deadline_class(state)` on every transition) and a `deadline_exceeded`
// target (§10, inv 12). The backstop fires from a PER-SESSION DO alarm, NOT the cron sweep (DE-3:
// happy-path timers are alarms). This producer is what that alarm FIRES: it checks whether the session's
// current state has dwelt past its deadline-class window and, if so, dual-emits `deadline_exceeded` into
// `applyEvent`. The §10 edges then route it — `{CREATED,PROVISIONING}→FAILED(spawn_timeout)`,
// `{GENERATING,FINALIZING,PUBLISHING}→FAILED(execution_timeout)`, `{AWAITING_INPUT}→STOPPED(resumable)`,
// `{REVIEW}→NEEDS_YOU(review_stuck)`+drain, `{VERIFYING}→NEEDS_YOU(verification_stopped)`+kill+drain,
// `{MERGE_READY}→MERGE_READY` (the D17 cron-reconcile self-loop, re-armed).
//
// FIRE GATE (F39). The producer is gated by the PURE dwell check `deadlineWouldFire(record, now)` =
// `now − state_entered_at ≥ deadline_class(state)`, reading `state_entered_at` (always stamped by
// `arm_deadline`). On a due fire it dual-emits `deadline_exceeded` into `applyEvent`, whose §10 edges
// route the teardown bag (kill_verification / loud notify / drain) executed by the live sink. It logs
// one structured line per fire so each `deadline_class` can be tuned against the live per-state dwell
// distribution (§18).
//
// FAULT ISOLATION: the whole body is try-caught OFF the legacy critical path (the DO alarm tick), so a
// producer fault never perturbs the live alarm.
//
// THE RESOLVER. This producer wires the REAL `deadline_class` map into `deadlineMs` (via the shared live
// resolver), so the resulting state's `deadline_at` re-arms faithfully — e.g. the `MERGE_READY →
// MERGE_READY` reconcile self-loop re-arms its long window.

import {
  AWAITING_INPUT_DEADLINE_MS,
  MERGE_READY_RECONCILE_DEADLINE_MS,
  REVIEW_STUCK_DEADLINE_MS,
  VERIFYING_BACKSTOP_DEADLINE_MS,
} from "../../constants/review-loop";
import {
  POST_EXECUTION_DEADLINE_MS,
  PUBLISHING_DEADLINE_MS,
  SPAWN_CONNECT_TIMEOUT_MS,
  STALE_PROMPT_TIMEOUT_MS,
} from "../../constants/sessions";
import type { Env } from "../../types";
import { getPrCoordination } from "../pr-coordination-db";
import { applyEvent, type ApplyEventDeps, type FsmSideEffectSink } from "./apply-event";
import { buildLiveGuardResolver } from "./live-resolver";
import { buildLiveSideEffectSink, buildLiveWorklistSink } from "./live-side-effects";
import type { EventActor, EventMetadata, FsmEvent, FsmState } from "./types";

/**
 * `deadline_class(state)` — the per-state backstop window in ms, or `null` for a state with NO §10
 * deadline target (the resting terminals: `ANSWERED_NO_PR` / `NEEDS_YOU` / `STOPPED` / `MERGED` /
 * `CLOSED` / `FAILED` / `ARCHIVED`). The total `Record` is the compile-time exhaustiveness proof: a new
 * `FsmState` without a class is a `tsc` "missing property" break right here (`src/` is the typechecked
 * surface), so the "every active/wait state has a deadline" invariant (§15 inv 12) can never silently
 * regress. The codegen-phase windows reuse the legacy watchdog timeouts so the shadow deadline tracks
 * legacy; the post-publish/wait windows are the new FSM tunables (`constants/review-loop.ts`). All values
 * are PROVISIONAL — the shadow phase runs observe-only (F39) to tune them.
 */
export const DEADLINE_CLASS_MS: Record<FsmState, number | null> = {
  // Spawn timeout (`→ FAILED(spawn_timeout)`).
  CREATED: SPAWN_CONNECT_TIMEOUT_MS,
  PROVISIONING: SPAWN_CONNECT_TIMEOUT_MS,
  // Execution timeout (`→ FAILED(execution_timeout)`).
  GENERATING: STALE_PROMPT_TIMEOUT_MS,
  FINALIZING: POST_EXECUTION_DEADLINE_MS,
  PUBLISHING: PUBLISHING_DEADLINE_MS,
  // Wait/abandon windows.
  AWAITING_INPUT: AWAITING_INPUT_DEADLINE_MS,
  REVIEW: REVIEW_STUCK_DEADLINE_MS,
  VERIFYING: VERIFYING_BACKSTOP_DEADLINE_MS,
  MERGE_READY: MERGE_READY_RECONCILE_DEADLINE_MS,
  // Resting terminals — no §10 deadline target (a `deadline_exceeded` here is unhandled).
  ANSWERED_NO_PR: null,
  NEEDS_YOU: null,
  FAILED: null,
  STOPPED: null,
  MERGED: null,
  CLOSED: null,
  SUPERSEDED: null,
  ARCHIVED: null,
};

/** The per-state `deadline_class` window in ms (`null` = the state has no §10 deadline). PURE. */
export function deadlineClassMs(state: FsmState): number | null {
  return DEADLINE_CLASS_MS[state];
}

/**
 * Whether the session's CURRENT state has dwelt past its `deadline_class` window at `now` — i.e. the
 * alarm's "would-fire" gate. PURE. TRUE iff the state HAS a deadline class (`!= null`) AND
 * `now − state_entered_at ≥ deadline_class(state)`. Uses `state_entered_at` (always stamped by
 * `arm_deadline`, even in shadow) rather than the stored `deadline_at` so the would-fire observation
 * works against live dwell from day one — `deadline_at` itself stays null in shadow (the other producers'
 * resolvers pass `deadlineMs() = null`). A resting terminal (`deadline_class = null`) never fires.
 */
export function deadlineWouldFire(record: { state: FsmState; stateEnteredAt: number | null }, now: number): boolean {
  const windowMs = deadlineClassMs(record.state);
  if (windowMs === null) return false;
  // A missing `state_entered_at` (a legacy/partial row) has no dwell anchor → conservatively never fires.
  if (record.stateEnteredAt === null) return false;
  return now - record.stateEnteredAt >= windowMs;
}

/** One spine emission: the `deadline_exceeded` event, its observability metadata, and the actor tag. */
export interface DeadlineEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** A fired deadline is attributed to the `internal` actor — a spine-internal timer, not a webhook/cron/user. */
const DEADLINE_ACTOR: EventActor = "internal";

/** The pure builder: a would-fire deadline → `deadline_exceeded` (the §10 backstop event). PURE. */
export function buildDeadlineEmission(): DeadlineEmission {
  return { event: { type: "deadline_exceeded" }, metadata: { type: "deadline_exceeded" }, actor: DEADLINE_ACTOR };
}

/** The would-fire fire outcome (for the caller's observability/tests). `wouldFire=false` = a clean no-op. */
export interface DeadlineFireResult {
  wouldFire: boolean;
  from: FsmState | null;
  to: FsmState | null;
}

const NO_FIRE: DeadlineFireResult = { wouldFire: false, from: null, to: null };

export interface DeadlineFireLogger {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * FIRE the per-session deadline DO alarm: if the session's current state has dwelt past its
 * `deadline_class` window (`deadlineWouldFire`), log one structured fire line (the F39 tuning signal —
 * captures WHEN the deadline fired so each class can be tuned against live dwell), then dual-emit
 * `deadline_exceeded` into `applyEvent`, which routes the §10 teardown bag (kill / loud / drain) through
 * the live sink. The whole body is try-caught OFF the legacy critical path so a producer fault is
 * isolated. No-op when D1 is unbound (local/test), when there is no spine record yet, or when the state
 * has not dwelt past its window (the common case).
 *
 * `sideEffects` is an injectable seam (defaulting to the live sink) so a test can assert the dispatched
 * teardown bag directly.
 */
export async function shadowFireDueDeadline(
  env: Env,
  sessionId: string,
  now: number,
  log?: DeadlineFireLogger,
  sideEffects?: FsmSideEffectSink,
  waitUntil?: (promise: Promise<unknown>) => void,
  planApprovalPending = false,
): Promise<DeadlineFireResult> {
  if (planApprovalPending) return NO_FIRE;
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return NO_FIRE;

  try {
    const record = await getPrCoordination(db, sessionId);
    if (!record) return NO_FIRE;
    const state = record.state as FsmState;
    const stateEnteredAt = record.stateEnteredAt;
    if (!deadlineWouldFire({ state, stateEnteredAt }, now)) return NO_FIRE;

    // The "would-fire"/fire signal (F39): one structured line per fire, carrying the state, its class
    // window, and the dwell that elapsed — the data each `deadline_class` is tuned against.
    // `stateEnteredAt` is non-null here (`deadlineWouldFire` returns false on a null anchor).
    log?.info?.(
      {
        sessionId,
        state,
        deadlineClassMs: deadlineClassMs(state),
        dwellMs: stateEnteredAt === null ? null : now - stateEnteredAt,
      },
      "fsm deadline fired (DE-3)",
    );

    const emission = buildDeadlineEmission();
    // PR 47 emitter rewire: the shared live resolver — a dwelt-past-deadline REVIEW/VERIFYING routes to
    // NEEDS_YOU with the REAL teardown bag (drain + run-scoped kill + loud) executed by the live sink,
    // and the resulting state's deadline re-arms off the real class map.
    const resolver = buildLiveGuardResolver(env, sessionId);
    const deps: ApplyEventDeps = {
      db,
      env,
      now: () => now,
      resolver,
      // The injectable seam still wins (tests assert side-effect dispatch through it); production
      // defaults to the real live sink. PR 47: effect execution defers through the DO alarm's waitUntil.
      sideEffects: sideEffects ?? buildLiveSideEffectSink(env, { now: () => now, waitUntil }),
      worklist: buildLiveWorklistSink(env, { now: () => now }),
      // Thread the DO-alarm seam onto deps too (#6414 parity): apply-event reads `deps.waitUntil` to
      // ride the transition DD POST OFF the commit path; without it the emit blocks the alarm cascade.
      waitUntil,
    };
    const result = await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });
    return { wouldFire: true, from: result.from, to: result.to };
  } catch (err) {
    log?.warn?.({ sessionId, error: String(err) }, "fsm deadline producer failed (ignored)");
    return NO_FIRE;
  }
}
