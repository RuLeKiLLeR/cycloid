// ARC-1330 lifecycle FSM (PR 38) — CI-WEBHOOK producer: GitHub CI rollup → `ci.signal` spine events.
//
// The CI webhook handlers (`webhooks/github.ts` `handleStatusEvent` / `handleCheckRunEvent`) funnel a
// terminal CI signal for a head into `emitReviewLoopCiSignalFromWebhook` (`services/
// review-loop-ci-signal.ts`), which is the ONE place that polls the head's full check-run +
// status-context set and collapses it via `reduceCiState` into a single 4-valued verdict, then calls
// `shadowEmitCiSignal` below per resolved `session_id`. That rollup IS the spine's `ci.signal` payload —
// this producer dual-emits `ci.signal{green|failing|absent}` from exactly where `reduceCiState` is
// computed (the cheat-sheet's "name the symbol, not the line"): emitting per-event in the handlers
// would either re-poll GitHub (a rate-limit cost the shadow phase must not add) or carry only a single
// check's state, never the head's collapsed verdict the FSM's CI guards read. (ARC-1330 D-59a: the
// legacy done-state reconcile that used to host this poll is deleted; the poll + emit skeleton moved to
// `review-loop-ci-signal.ts` intact.)
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught
// OFF the legacy critical path (the reconcile's done-state poll), so a producer fault never perturbs the
// live review loop.
//
// SOUNDNESS over completeness (the shadow rule): `reduceCiState` is 4-valued, but `pending` DOMINATES
// and is a LIVE-READ GUARD, never an event (a `ci.signal` event only carries a SETTLED verdict — design
// §5 / `CiSignalState`). So `pending` maps to NO emission (the row must not move on a still-running CI
// read; the cascade's `ci_pending` wait is decided live at the `caught_up` recompute, not from a stale
// event). `green`/`failing`/`absent` map to a `ci.signal` event carrying `ci_state` for the §18.6
// observability slice. The producer only sees rollups for the CI-first cohort the reconcile actually
// polls (its own laziness, unchanged here); broader-cohort CI reads stay surfaced by the divergence
// metric rather than bought with extra GitHub polls.

import type { ReviewLoopCiState } from "../../services/review-loop-rollup";
import type { Env } from "../../types";
import { applyEvent, type ApplyEventDeps } from "./apply-event";
import { classifyCi } from "./guards";
import { buildLiveGuardResolver } from "./live-resolver";
import { liveFsmSinks } from "./live-side-effects";
import type { CiSignalState, EventActor, EventMetadata, FsmEvent } from "./types";

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface CiEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every CI-produced spine event is attributed to the `webhook` actor (the CI webhook that drove it). */
const CI_ACTOR: EventActor = "webhook";

/**
 * The pure builder: a SETTLED CI verdict → `ci.signal{ciState}`. The `ci_state` rides BOTH the event
 * (the cascade's CI guard reads it) AND the `EventMetadata` (the §18.6 observability slice — PR 38's
 * slice fill). `pending` is excluded by the `CiSignalState` type: it is never an event (see file header).
 */
export function buildCiSignalEmission(ciState: CiSignalState): CiEmission {
  return {
    event: { type: "ci.signal", ciState },
    metadata: { type: "ci.signal", ciState },
    actor: CI_ACTOR,
  };
}

/**
 * Map `reduceCiState`'s 4-valued rollup to a spine emission: `green`/`failing`/`absent` → a `ci.signal`
 * emission; `pending` → `null` (NO event — `pending` is a live-read guard, not a settled verdict, so the
 * shadow row must not move on it; the cascade decides the `ci_pending` wait live at the recompute). This
 * is the "webhook → ci.signal via reduceCiState" contract.
 */
export function ciSignalEmissionForRollup(rollup: ReviewLoopCiState): CiEmission | null {
  if (rollup === "pending") return null;
  return buildCiSignalEmission(rollup);
}

/**
 * DUAL-EMIT a CI rollup onto the shadow spine as `ci.signal{green|failing|absent}`. SHADOW/observe-only
 * — the whole body is try-caught OFF the legacy critical path (the reconcile's done-state poll), so a
 * shadow fault is isolated here and never perturbs the live review loop (the producer dual-emit
 * contract, mirroring PR 36/37). No-op when the rollup is `pending` (no settled event) or when
 * D1 is unbound (local/test).
 */
export async function shadowEmitCiSignal(
  env: Env,
  sessionId: string,
  rollup: ReviewLoopCiState,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  // `pending` is a live-read guard, never a settled event (file header) — narrows `rollup` to a
  // `CiSignalState` for the builder + resolver.
  if (rollup === "pending") return;
  const ciState: CiSignalState = rollup;
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  const emission = buildCiSignalEmission(ciState);
  // PR 47 emitter rewire: the shared live resolver supplies the REAL reads — this is the ONE producer
  // with an honest CI observation, so it threads the observed rollup as the cascade's `ciBucket` + the
  // FG-2 `resetContext.ciGreen`.
  const resolver = buildLiveGuardResolver(env, sessionId, { ciBucket: classifyCi(ciState) });
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    // PR 47: effect execution defers through the caller's waitUntil off the webhook/cron hot path.
    ...liveFsmSinks(env, { waitUntil }),
  };
  try {
    await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });
  } catch (err) {
    log?.warn({ sessionId, error: String(err) }, "fsm ci producer failed (ignored)");
  }
}
