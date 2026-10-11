// ARC-1330 lifecycle FSM (PR 41) — EPOCH-TERMINAL producer: review-loop epoch terminals → `epoch.*`.
//
// A review-loop "epoch" (one RLA cycle: dispatch a fix/reply prompt for a wave of review/CI feedback,
// then settle) terminates at three legacy chokepoints, all in `services/review-loop-epochs.ts`:
//   - `markReviewLoopEpochCompleted` — the dominant "work published" completion (the epoch pushed a
//     fix commit) → `epoch.committed` (advance is owned by the head webhook producer, see below).
//   - `resolveReviewLoopEpochForTerminalPrompt` — a reply-only / no-diff terminal turn (the agent
//     replied to reviewers without changing code) → `epoch.replied`.
//   - `markReviewLoopEpochWaitingForOwner` (the publish-guard owner-approval surfacing reached from
//     `session/publish-service.ts`) → `epoch.blocked{reason=owner_approval}` — the design's SOLE
//     owner-approval path (PR 15's `REVIEW—epoch.blocked{owner_approval}→NEEDS_YOU` edge), so this
//     producer is what makes that edge reachable (the spec's blocker fix).
// `epoch.declined` (triage-with-basis: a reasoned classification + reply that declines a suggestion,
// never an unchecked self-signal — design §13, finalized PR 22) is also supported here so the producer
// is fully wired (PR 46's flip gate requires the `epoch.declined` producer wired in PR 41); the
// disposition store REFUSES a `declined` write with no basis at its single boundary.
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught
// OFF the legacy critical path (the epoch terminal DAO writes), so a producer fault never perturbs the
// live review loop.
//
// SOUNDNESS over completeness (the shadow rule):
//   - The `epoch.committed` head advance is NOT re-emitted here. The PR head SHA advance is owned by the
//     `head.changed` webhook producer (PR 40), which fires from the `synchronize` delivery the fix push
//     triggers; so the spine `committedHead` guard is left unset and `epoch.committed` runs only
//     `set_code_changed` + `clear_in_flight_epoch` + `disposition(fixed)`. `set_code_changed` forces a
//     re-QA — the SAFE direction, never a path that keeps a stale verdict (mirroring the head producer's
//     re-QA-biased default). `headBefore`/`headAfter` on the §18.6 slice document the head the epoch
//     operated on (the RLA-cycle head context), not a spine advance.
//   - The terminal `disposition` (`fixed`/`replied`/`declined`) is WRITTEN to the disposition store
//     (one row per owned source id) via an injected side-effect sink, so the shadow `caught_up` snapshot
//     reflects the just-settled items (the "+ write dispositions (shadow)" half of the PR). `epoch.blocked`
//     writes NO disposition — its items stay undispositioned and the PR routes to `NEEDS_YOU{owner_approval}`.
//   - The classifier is a PURE function of the terminal kind + the epoch's `{epochId, trigger, sourceIds,
//     head}` — fully unit-testable without GitHub or D1.

import { isTransientD1StorageError } from "../../db/errors";
import type { Env } from "../../types";
import {
  type ItemDisposition,
  listUndispositionedActionable,
  upsertDispositionsBatch,
} from "../pr-review-item-disposition-db";
import { applyEvent, type ApplyEventDeps, type FsmSideEffectSink } from "./apply-event";
import { buildLiveGuardResolver } from "./live-resolver";
import {
  buildLiveSideEffectSink,
  buildLiveWorklistSink,
  combineSideEffectSinks,
  liveFsmSinks,
} from "./live-side-effects";
import type {
  Disposition,
  EpochBlockReason,
  EpochDeferralKind,
  EpochTrigger,
  EventActor,
  EventMetadata,
  FsmEvent,
} from "./types";

/**
 * Which legacy epoch terminal fired. Maps 1:1 to a spine `epoch.*` event:
 *   `committed` → `epoch.committed` (disposition `fixed`), `replied` → `epoch.replied` (disposition
 *   `replied`), `declined` → `epoch.declined` (disposition `declined`), `blocked_owner_approval` →
 *   `epoch.blocked{owner_approval}` (no disposition — the items stay undispositioned, routing to
 *   `NEEDS_YOU`).
 */
// `settled` → `epoch.settled` (no disposition): a no-actionable-work settle that only CLEARS
// `in_flight_epoch_id`; items keep whatever disposition they already carry.
// `blocked_response_failed` → `epoch.blocked{response_failed}` (no disposition): an agent fix/reply POST
// that failed past its retry cap → NEEDS_YOU(review_response_failed) (ARC-1330 blocked-epoch class).
export type EpochTerminalKind =
  "committed" | "replied" | "declined" | "blocked_owner_approval" | "blocked_response_failed" | "settled";

export interface EpochTerminalItemDisposition {
  sourceId: string;
  disposition: Exclude<Disposition, "none">;
  basis?: string | null;
}

/** The raw, terminal-sourced inputs the pure classifier reads — exactly what the epoch terminal seams hold. */
export interface EpochTerminalInput {
  kind: EpochTerminalKind;
  /** The settling epoch's id — rides the `epoch.*` event (the spine clears `in_flight_epoch_id` for it). */
  epochId: string;
  /** Why the epoch ran: `ci_fix` (a CI-failure epoch) or `review` (a bot/human review epoch). §18.6 slice. */
  epochTrigger: EpochTrigger;
  /** The disposition-store source ids the epoch owns (its prompted/triggering items) — one row stamped each. */
  sourceIds: readonly string[];
  /** The PR head the epoch operated on → the §18.6 `head_before`/`head_after` slice (no spine advance here). */
  headSha: string | null;
  /** Optional per-item terminal truth; falls back to the terminal kind's blanket disposition when absent. */
  itemDispositions?: readonly EpochTerminalItemDisposition[];
  /** REQUIRED for `declined` (triage-with-basis, §13): the reasoning. Ignored for the other kinds. */
  basis?: string | null;
}

/** The classified terminal: the spine event + the §18.6 observability slice + the disposition to stamp. */
export interface EpochTerminalClassification {
  event: FsmEvent;
  metadata: EventMetadata;
  /** The disposition the side-effect sink writes for each owned source id (`null` for `blocked` — no write). */
  disposition: Exclude<Disposition, "none"> | null;
  sourceIds: readonly string[];
  itemDispositions: readonly EpochTerminalItemDisposition[];
  basis: string | null;
}

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface EpochTerminalEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every epoch-terminal spine event is the RLA cycle's own settle — attributed to the `internal` actor. */
const EPOCH_ACTOR: EventActor = "internal";

/** The terminal-kind → spine-disposition map (the `none` registration state is never a terminal stamp). */
function dispositionFor(kind: EpochTerminalKind): Exclude<Disposition, "none"> | null {
  switch (kind) {
    case "committed":
      return "fixed";
    case "replied":
      return "replied";
    case "declined":
      return "declined";
    case "blocked_owner_approval":
      return null;
    case "blocked_response_failed":
      return null;
    case "settled":
      return null;
  }
}

// A blocked epoch-terminal kind → the spine `epoch.blocked` reason it carries (tsc-exhaustive over the
// blocked kinds). Non-blocked kinds never reach here.
function epochBlockReasonForKind(kind: "blocked_owner_approval" | "blocked_response_failed"): EpochBlockReason {
  switch (kind) {
    case "blocked_owner_approval":
      return "owner_approval";
    case "blocked_response_failed":
      return "response_failed";
  }
}

/**
 * The pure classifier: a legacy epoch terminal → its spine `epoch.*` event + the §18.6 metadata slice +
 * the disposition to stamp. `headBefore`/`headAfter` are both the epoch's operating head (the head advance
 * is owned by the head webhook producer, PR 40 — see file header). Total over `EpochTerminalKind`.
 */
export function classifyEpochTerminal(input: EpochTerminalInput): EpochTerminalClassification {
  const disposition = dispositionFor(input.kind);
  const sourceIds = [...input.sourceIds];
  const itemDispositions =
    input.itemDispositions && input.itemDispositions.length > 0
      ? input.itemDispositions.map((item) => ({ ...item, basis: item.basis ?? null }))
      : disposition
        ? sourceIds.map((sourceId) => ({ sourceId, disposition, basis: input.basis ?? null }))
        : [];
  const basis = input.basis ?? null;
  const metadataDisposition =
    itemDispositions.length > 0 && new Set(itemDispositions.map((item) => item.disposition)).size > 1
      ? "mixed"
      : disposition;
  const metadataBase = {
    epochId: input.epochId,
    epochTrigger: input.epochTrigger,
    sourceIds,
    headBefore: input.headSha,
    headAfter: input.headSha,
    disposition: metadataDisposition,
  } as const;

  if (input.kind === "blocked_owner_approval" || input.kind === "blocked_response_failed") {
    const reason = epochBlockReasonForKind(input.kind);
    return {
      event: { type: "epoch.blocked", epochId: input.epochId, reason, trigger: input.epochTrigger },
      metadata: { type: "epoch.blocked", reason, ...metadataBase },
      disposition,
      sourceIds,
      itemDispositions,
      basis,
    };
  }

  const eventType = (
    {
      committed: "epoch.committed",
      replied: "epoch.replied",
      declined: "epoch.declined",
      settled: "epoch.settled",
    } as const
  )[input.kind];
  return {
    event: { type: eventType, epochId: input.epochId },
    metadata: { type: eventType, ...metadataBase },
    disposition,
    sourceIds,
    itemDispositions,
    basis,
  };
}

/** The pure builder: a classification → the spine emission (event + §18.6 metadata + `internal` actor). */
export function buildEpochTerminalEmission(classification: EpochTerminalClassification): EpochTerminalEmission {
  return { event: classification.event, metadata: classification.metadata, actor: EPOCH_ACTOR };
}

/**
 * The injected side-effect sink that WRITES the terminal disposition to the store (the "+ write
 * dispositions (shadow)" half of PR 41). On the committed bucket-b `disposition` side-effect the epoch
 * terminal carries, it upserts ONE row per owned source id keyed `(session, pr, source_id)` with the
 * terminal stamp + owning `epochId` (+ `basis` for `declined` — the DAO refuses a basis-less decline).
 * Any other side-effect (`resolve_owned_threads`, `loud`, …) is a no-op here (observe-only in shadow).
 */
export function epochDispositionSink(args: {
  db: D1Database;
  sessionId: string;
  prUrl: string;
  sourceIds: readonly string[];
  itemDispositions?: readonly EpochTerminalItemDisposition[];
  basis: string | null;
  now: number;
}): FsmSideEffectSink {
  return {
    async dispatch(dispatch) {
      for (const sideEffect of dispatch.sideEffects) {
        if (sideEffect.kind !== "disposition") continue;
        const value = sideEffect.args?.disposition as ItemDisposition | undefined;
        const epochId = (sideEffect.args?.epochId as string | undefined) ?? null;
        if (value === undefined || value === "none") continue;
        const itemDispositions =
          args.itemDispositions && args.itemDispositions.length > 0
            ? args.itemDispositions
            : args.sourceIds.map((sourceId) => ({ sourceId, disposition: value, basis: args.basis }));
        await upsertDispositionsBatch(
          args.db,
          itemDispositions.map((item) => ({
            sessionId: args.sessionId,
            prUrl: args.prUrl,
            sourceId: item.sourceId,
            disposition: item.disposition,
            epochId,
            basis: item.basis ?? null,
          })),
          args.now,
        );
      }
    },
  };
}

/**
 * DUAL-EMIT a settled epoch terminal onto the shadow spine as `epoch.committed/replied/declined/blocked`,
 * writing the terminal disposition for each owned source id. SHADOW/observe-only — the whole body is
 * try-caught OFF the legacy critical path (the epoch terminal DAO write), so a producer fault is isolated
 * here and never perturbs the live review loop (the producer dual-emit contract, mirroring PR 36-40).
 * No-op when D1 is unbound (local/test).
 */
export async function shadowEmitEpochTerminal(
  env: Env,
  sessionId: string,
  prUrl: string,
  input: EpochTerminalInput,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
  options?: { clearOnly?: boolean },
): Promise<void> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  const classification = classifyEpochTerminal(input);
  const emission = buildEpochTerminalEmission(classification);
  const now = Date.now();
  // PR 47 emitter rewire: the shared live resolver — the epoch terminals are the primary `caught_up`
  // recompute trigger (§6.1), so this is where the REAL disposition snapshot drives the cascade (rows
  // 1/2 on `code_changed`; the CI rows source an HONEST one-head read at the conjunction-complete moment
  // via the resolver's `caughtUpInputs` — W11-T1 — so a settled green PR reaches MERGE_READY on the
  // terminal instead of parking at `ci_pending`). The settling LEGACY epoch id is threaded so any
  // same-commit dispatch anchors to reality.
  //
  // ARC-1445 / ARC-1556: SAME-HEAD terminals that leave undispositioned items no LIVE epoch covers must
  // ARM THE DRAIN on the terminal edge — at live `release_queued_reviews` is inert and `caught_up`
  // cannot fire with undispositioned ≥ 1, so nothing else re-dispatches them. That applies to:
  //   • `settled` — the no-actionable-work terminal (existing ARC-1445 path)
  //   • `replied` / `declined` — reply-only / no-diff terminals that keep the PR head stable
  // It does NOT apply to `committed`: the fix push advances the head via the separate head webhook, so
  // dispatching immediately here would run the next epoch against a stale record head. Trace the uncovered
  // set and thread it in, and OMIT the terminal epoch's `legacyEpochId` so `newEpochId` is a FRESH
  // synthetic id — else the dispatch executor re-observes the just-finished terminal row and creates
  // nothing (`in_flight_epoch_id` re-stranded). `review-loop-epochs` is dynamically imported to stay off
  // its module cycle with this producer. A trace fault leaves the set empty → today's clear-only behavior
  // (no drain, never a bad dispatch).
  const clearOnly = options?.clearOnly === true;
  const sameHeadDrainTerminal =
    !clearOnly && (input.kind === "settled" || input.kind === "replied" || input.kind === "declined");
  let terminalUncovered: readonly string[] = [];
  if (sameHeadDrainTerminal) {
    try {
      const { listLiveEpochCoveredSourceIds } = await import("../../services/review-loop-epochs");
      const [actionable, covered] = await Promise.all([
        listUndispositionedActionable(db, sessionId, prUrl),
        listLiveEpochCoveredSourceIds(db, { sessionId, prUrl }),
      ]);
      // Reply/decline terminals trace BEFORE the disposition sink below writes their terminal stamp, so
      // their own source ids can still appear as `disposition='none'` here. Exclude the just-finished
      // epoch's soon-to-be-dispositioned items from the drain trace; otherwise a reply-only terminal with
      // no queued follow-up work can arm a bare synthetic epoch that the live dispatcher later skips,
      // re-stranding `in_flight_epoch_id`. `settled` carries no itemDispositions, so this exclusion is a
      // no-op there and the ARC-1445 settle drain behavior stays unchanged.
      const dispositionedByTerminal = new Set(classification.itemDispositions.map((item) => item.sourceId));
      terminalUncovered = actionable.filter(
        (sourceId) => !covered.has(sourceId) && !dispositionedByTerminal.has(sourceId),
      );
    } catch (err) {
      log?.warn(
        { sessionId, epochId: input.epochId, kind: input.kind, error: String(err) },
        "fsm same-head terminal drain trace failed (ignored)",
      );
    }
  }
  // A4: on a COMMITTED review epoch, flag whether any owned source id is a QA-sourced item (the QA managed
  // comment is admitted under `qa-verdict:<id>`). The REVIEW `epoch.committed` arm re-verifies QA when a
  // QA-sourced finding was fixed and the head advanced (guarded by the record's verdict + heads + run cap).
  const committedQaFinding =
    input.kind === "committed" && classification.sourceIds.some((sourceId) => sourceId.startsWith("qa-verdict:"));
  const resolver = clearOnly
    ? buildLiveGuardResolver(env, sessionId, { uncoveredActionableSourceIds: [] })
    : sameHeadDrainTerminal
      ? buildLiveGuardResolver(env, sessionId, { uncoveredActionableSourceIds: terminalUncovered })
      : buildLiveGuardResolver(env, sessionId, {
          legacyEpochId: input.epochId,
          committedEpochDispositionedQaFinding: committedQaFinding,
        });
  const deps: ApplyEventDeps = {
    db,
    env,
    now: () => now,
    resolver,
    // The disposition sink is the authoritative disposition write, wired at the ONE seam that holds the
    // owned source ids, composed with the real live sink (the live sink's `disposition` kind stays inert,
    // so the two never double-write). The disposition sink is NOT deferred through waitUntil — its writes
    // must land BEFORE the post-commit `caught_up` recompute reads the store (§6.1).
    sideEffects: combineSideEffectSinks(env, [
      {
        name: "epochDispositionSink",
        sink: epochDispositionSink({
          db,
          sessionId,
          prUrl,
          sourceIds: classification.sourceIds,
          itemDispositions: classification.itemDispositions,
          basis: classification.basis,
          now,
        }),
      },
      { name: "liveSideEffectSink", sink: buildLiveSideEffectSink(env, { now: () => now, waitUntil }) },
    ]),
    worklist: buildLiveWorklistSink(env, { now: () => now }),
    // Thread the alarm/sweep seam onto deps too (#6414 parity): apply-event reads `deps.waitUntil` to
    // ride the transition DD POST OFF the commit path; without it the emit blocks the epoch cascade.
    // (Only the telemetry emit rides this — the disposition sink above stays synchronous, per its note.)
    waitUntil,
  };
  try {
    await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });
  } catch (err) {
    log?.warn({ sessionId, epochId: input.epochId, error: String(err) }, "fsm epoch producer failed (ignored)");
  }
}

/**
 * DUAL-EMIT an epoch dispatch DEFERRAL onto the spine as `epoch.deferred` (W11-V5). The legacy sweep
 * defers a claimed epoch when a precondition is not ready (`contention` — verification in progress,
 * CI/mergeability pending, head lagging) or when a GitHub poll fails transiently (`transient`). Today
 * that write lands ONLY on the legacy `pr_review_response_epochs` lease/defer counters, OUTSIDE the
 * spine CAS; this producer moves the OBSERVATION onto the spine so D-53 can drop those counters while
 * the deferral stays visible in the journal. The spine handles it as a REVIEW `log_noop` self-loop:
 * NO state change (the epoch stays in-flight, `in_flight_epoch_id` untouched), so the give-up stays the
 * §10 REVIEW deadline (SF10) and an active retry re-arms it as a keep-alive — the SAME established
 * pattern as the MERGE_READY reconcile self-loop. Anywhere but REVIEW the event is a benign unhandled
 * no-op (the FSM already moved on).
 *
 * CRITICAL (keystone claim 3): the legacy defer write is NOT dropped here — it already ran at the call
 * site and legacy's sweep still depends on it as a parallel fallback until D-53. This is purely
 * ADDITIVE, best-effort/try-caught OFF the legacy sweep path, so a spine fault never perturbs the loop.
 * No-op when D1 is unbound (local/test).
 */
export async function emitEpochDeferralToSpine(
  env: Env,
  sessionId: string,
  input: { epochId: string; deferralKind: EpochDeferralKind; reason: string },
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  const event: FsmEvent = { type: "epoch.deferred", epochId: input.epochId, deferralKind: input.deferralKind };
  const metadata: EventMetadata = {
    type: "epoch.deferred",
    epochId: input.epochId,
    deferralKind: input.deferralKind,
    reason: input.reason,
  };
  // The edge reads no guards (a pure REVIEW self-loop); the live resolver keeps the resulting-state
  // deadline re-arm matching the rest of the loop.
  const resolver = buildLiveGuardResolver(env, sessionId);
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    ...liveFsmSinks(env, { waitUntil }),
  };
  try {
    await applyEvent(deps, { sessionId, event, metadata, actor: "cron" });
  } catch (err) {
    if (isTransientD1StorageError(err)) {
      log?.warn(
        { sessionId, epochId: input.epochId, transientError: String(err) },
        "fsm epoch-deferral producer failed (ignored)",
      );
      return;
    }
    log?.warn(
      { sessionId, epochId: input.epochId, error: String(err) },
      "fsm epoch-deferral producer failed (ignored)",
    );
  }
}
