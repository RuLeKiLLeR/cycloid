// ARC-1330 lifecycle FSM (PR 43) — CRON-POLL producer: the review-loop sweep's cross-session
// reconciles → `pr.merged` / `pr.closed` (and, via the PR-38 CI producer, `ci.signal`) spine events.
//
// The `*/5` cron sweep (`services/review-loop-sweep.ts` `runReviewLoopSweep`) is the cross-session
// backstop that catches DROPPED webhooks (DE-3): it polls each review-listening PR's live state once
// per tick. Two of its polls map onto the spine:
//   • the merge/close poll (`getPrMergeStatus` → `prState === "merged" | "closed"`) — the ONE place
//     the cron observes a PR terminal that a missed `pull_request.closed` webhook would otherwise lose.
//     This producer dual-emits `pr.merged` / `pr.closed` from exactly that resolved terminal.
//   • the absent-CI re-poll (the per-tick `reduceCiState(headCheckRuns, commitStatuses)` rollup fed to
//     `reconcileReviewLoopDoneState`) — the cron's own collapsed 4-valued CI verdict for the head, the
//     dropped-`check_run`-webhook backstop. That rollup is emitted via the PR-38 `shadowEmitCiSignal`
//     (reused at the cron site), so `ci.signal{green|failing|absent}` lands whether the settling signal
//     arrived by webhook OR was only seen by the cron re-poll. `absent` (no checks configured) is the
//     re-poll's load-bearing case: no webhook ever fires for a PR with no CI, so without the cron emit
//     the spine would never learn CI is `absent` and the cascade's `ci_green` (green|absent) flip stalls.
//
// FAULT ISOLATION: each producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught OFF the
// legacy critical path (the sweep's poll → notify/close + done-rollup), so a producer fault never
// perturbs the live sweep. The polls THEMSELVES are untouched (the legacy merge-notify / close /
// done-reconcile keep running unchanged); the dual-emit is a sibling call.
//
// SOUNDNESS over completeness (the shadow rule): only the UNAMBIGUOUS cron terminals map to an event.
// `getPrMergeStatus.state` is `"merged" | "closed" | "open"`; only `merged`/`closed` mint a terminal
// event (`open` is no spine signal — the live PR keeps flowing through the webhook producers). A
// `pr.merged`/`pr.closed` lands in the §10 POST_PUBLISH group (REVIEW/VERIFYING/MERGE_READY/NEEDS_YOU/
// STOPPED → MERGED/CLOSED) and is a §8 `log_noop`/unhandled anywhere else, so a re-delivered cron poll on
// an already-terminal session never moves the row (the terminal is idempotent).
//
// W11-T2 (ARC-1330): the terminal mapping + applyEvent wiring here is the ONE place a `pr.merged`/`pr.closed`
// terminal is minted, now shared by three more sources (all reusing {@link emitObservedPrTerminal}, no
// duplicated mapping): the `pull_request.closed` WEBHOOK per-session loop ({@link emitWebhookPrTerminal} —
// the real-time primary; this cron poll is its dropped-webhook backstop), the SPINE-DRIVEN D17 reconcile
// (`spine-terminal-reconcile.ts` — enumerates the spine's own open-PR rows the legacy working set drops),
// and the admin STOCK re-emit (`routes/admin-fsm-parity-check.ts` `{reconcile:true}`). Soundness is
// unchanged: only an OBSERVED merged/closed PR mints an event, and every source lands the same §10 edge
// (idempotent no-op in a final terminal).

import type { Env } from "../../types";
import { applyEvent, type ApplyEventDeps, type ApplyEventResult } from "./apply-event";
import { buildLiveGuardResolver } from "./live-resolver";
import { liveFsmSinks } from "./live-side-effects";
import type { EventActor, EventMetadata, FsmEvent } from "./types";

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface CronEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every cron-produced spine event is attributed to the `cron` actor (the sweep that polled it). */
const CRON_ACTOR: EventActor = "cron";

/** The two cron-observed PR terminals the sweep's merge/close poll resolves (`getPrMergeStatus.state`). */
export type CronPrTerminal = "merged" | "closed";

/** The pure builder: a cron-observed `merged` PR terminal → `pr.merged` (POST_PUBLISH → MERGED, §10). */
export function buildPrMergedEmission(): CronEmission {
  return { event: { type: "pr.merged" }, metadata: { type: "pr.merged" }, actor: CRON_ACTOR };
}

/** The pure builder: a cron-observed `closed` PR terminal → `pr.closed` (POST_PUBLISH → CLOSED, §10). */
export function buildPrClosedEmission(): CronEmission {
  return { event: { type: "pr.closed" }, metadata: { type: "pr.closed" }, actor: CRON_ACTOR };
}

/**
 * Map the cron merge/close poll's resolved terminal to a spine emission. PURE. `merged → pr.merged`,
 * `closed → pr.closed`; the `open` state never reaches here (the caller only dual-emits on a terminal).
 */
export function cronTerminalEmission(terminal: CronPrTerminal): CronEmission {
  return terminal === "merged" ? buildPrMergedEmission() : buildPrClosedEmission();
}

/**
 * The GENERIC observed-PR-terminal emit — the SINGLE applyEvent-wiring site every source of a
 * `pr.merged` / `pr.closed` terminal funnels through (the cron merge/close poll, the `pull_request.closed`
 * webhook per-session loop, the spine-driven D17 reconcile, and the admin stock re-emit). Reuses the ONE
 * terminal mapping ({@link cronTerminalEmission}) — no source duplicates the merged→pr.merged decision.
 * `actor` tags WHICH source observed the terminal (a bounded {@link EventActor}, e.g. `cron` / `webhook` /
 * `internal`) for the transition journal; the resolver + sinks + edge are identical across sources because a
 * `pr.merged` / `pr.closed` lands in the same §10 POST_PUBLISH group (→ MERGED/CLOSED, idempotent in a final
 * terminal). Returns the {@link ApplyEventResult} so a caller that needs the outcome (the reconcile counts a
 * `handled` transition vs a `no_record`/`unhandled` no-op); `null` = the emit never ran (unbound D1)
 * or threw (isolated best-effort). The whole body is try-caught OFF any legacy critical path — a producer
 * fault is contained here and never perturbs the live path (the producer dual-emit contract).
 */
export async function emitObservedPrTerminal(
  env: Env,
  sessionId: string,
  terminal: CronPrTerminal,
  actor: EventActor,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ApplyEventResult | null> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return null;
  const emission = cronTerminalEmission(terminal);
  // PR 47 emitter rewire: the shared live resolver (real reads incl. the VERIFYING-exit kill handle +
  // real deadlines). Terminal-generic — the only guard a `pr.merged`/`pr.closed` edge reads is the
  // run-scoped VERIFYING-exit kill handle.
  const resolver = buildLiveGuardResolver(env, sessionId);
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    // PR 47: effect execution defers through the caller's waitUntil.
    ...liveFsmSinks(env, { waitUntil }),
  };
  try {
    // The emission's baked `cron` actor is overridden by the caller-supplied `actor` (applyEvent's own
    // `actor` field) so the journal attributes the terminal to the source that observed it.
    return await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor,
    });
  } catch (err) {
    log?.warn({ sessionId, terminal, actor, error: String(err) }, "fsm pr-terminal producer failed (ignored)");
    return null;
  }
}

/**
 * DUAL-EMIT a cron-observed PR terminal onto the shadow spine as `pr.merged` / `pr.closed`. SHADOW/
 * observe-only — try-caught OFF the legacy critical path (the sweep's merge-notify + close), so a fault is
 * isolated here and never perturbs the live sweep (the producer dual-emit contract, mirroring PR 36-42).
 * No-op when D1 is unbound (local/test). Thin `cron`-actor wrapper over the generic
 * {@link emitObservedPrTerminal}.
 */
export async function shadowEmitCronPrTerminal(
  env: Env,
  sessionId: string,
  terminal: CronPrTerminal,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  await emitObservedPrTerminal(env, sessionId, terminal, CRON_ACTOR, log, waitUntil);
}

/**
 * EMIT a `pull_request.closed`-webhook-observed PR terminal onto the spine (W11-T2). The webhook's
 * per-session close-out loop (`webhooks/github.ts`) observes the terminal DIRECTLY (`pull_request.merged`),
 * but the legacy handler emits NO FSM event — so a manually-fixed-and-merged `NEEDS_YOU` PR (dropped by the
 * cron sweep's working set) would leave the spine wedged. This is the primary, real-time terminal-delivery
 * path (the cron poll is the dropped-webhook backstop). Attributed to the `webhook` actor. Best-effort /
 * try-caught inside {@link emitObservedPrTerminal} — never perturbs the webhook's notify/close.
 */
export async function emitWebhookPrTerminal(
  env: Env,
  sessionId: string,
  terminal: CronPrTerminal,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  await emitObservedPrTerminal(env, sessionId, terminal, "webhook", log, waitUntil);
}
