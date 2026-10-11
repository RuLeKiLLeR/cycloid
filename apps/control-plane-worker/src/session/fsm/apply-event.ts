// ARC-1330 lifecycle FSM — `applyEvent`, the single-writer write path (Section E, design §8).
//
// THE SPINE. Every external signal (CI / review / head / verification webhook, transport reducer,
// DO alarm, cron backstop) drives ONE `applyEvent(session_id, event)`. It is the ONLY writer of
// `pr_coordination` (the §8/§15-inv-1 single-writer guarantee): read the record, run the PURE
// `transition`, commit the decision under the version CAS, append the activity-log row, recompute
// `caught_up` (the PR-20A producer), dispatch the after-commit bucket-b side-effects, and emit the
// centralized observability event (design §18.4). The pure layers (`transition`, `guards`,
// `post-actions`, `caught-up`, `project`) own the DECISIONS; this file owns the ORCHESTRATION + I/O.
//
// UNCONDITIONALLY LIVE (ARC-1330 D-60 — the FSM_MODE kill-switch + shadow/off arms are removed).
// The injected sinks are REAL: the worklist sink persists bucket-a registrations to the disposition
// store (fail-loud) and the live side-effect sink (`live-side-effects.ts`) executes the post-publish
// bucket-b effects, each keyed to a committed idempotency anchor. Producers still DUAL-EMIT into
// `applyEvent` wrapped in their own try/caught OFF the legacy critical path (fault isolation, so a
// producer fault never perturbs the live session), and within `applyEvent` the observability emit is
// INDIVIDUALLY try/caught (invariant O2: a thrown emit never blocks the CAS commit).
//
// LIVE READS ARE INJECTED. `transition` needs a fully live-read `Guards` bag and `caught_up` needs a
// disposition snapshot — both are GitHub/D1 live reads owned by the producers. The
// spine takes them through the `FsmGuardResolver` seam so this module stays a pure orchestrator that
// the integration test can drive with in-memory fakes + a real migrated D1. Bucket-a worklist
// registrations (FG-5: durable BEFORE the `caught_up` read) and bucket-b side-effects ride their own
// injected sinks; PR 22/36-44 wire the real DAO/dispatch implementations.

import { postStructuredEventToDd } from "../../observability/events-exporter";
import type { Env } from "../../types";
import { casUpdatePrCoordination, getPrCoordination, type PrCoordinationRecord } from "../pr-coordination-db";
import { appendPrCoordinationEvent } from "../pr-coordination-events-db";
import { classifyCaughtUpTrigger, recomputeCaughtUp } from "./caught-up";
import type { CaughtUpStore } from "./guards";
import { type CiFixResetContext, universalPostActions } from "./post-actions";
import { stageOf } from "./project";
import { type Guards, isDwellNeutralSelfLoop, transition } from "./transition";
import type {
  Decision,
  EventActor,
  EventMetadata,
  FsmEvent,
  FsmFieldWrites,
  FsmRecord,
  FsmState,
  SideEffect,
  WorklistRegistration,
} from "./types";
import { FSM_STATES } from "./types";

// Bounded CAS re-evaluation: on a lost race (`changed === 0`) the spine re-reads and re-evaluates the
// event idempotently (§8). A small cap stops a pathological hot-loop; in practice one retry settles it.
const MAX_CAS_ATTEMPTS = 4;
// The internal `caught_up` re-entry is depth-1 by construction (a `caught_up` event is unhandled
// outside REVIEW and the cascade never re-emits `caught_up`), but cap defensively against any cycle.
const MAX_REENTRY_DEPTH = 4;

// ── Injected live-read / I/O seams (producers supply the real implementations) ─

/**
 * The live-read seam `transition` + `caught_up` need. The spine reads the committed record; the
 * producer resolves the GitHub/D1-backed guard inputs from it (CI state, disposition counts, reviewer
 * settle, caps, freshness). All methods are SYNCHRONOUS reads of state the producer has already loaded
 * (or can read cheaply) — keeping the pure layers pure. PR 36-44 wire the real resolvers; tests fake it.
 */
export interface FsmGuardResolver {
  /** The `Guards` bag for `transition(rec.state, event, …)` — live-read for THIS `(rec, event)`. */
  guards(rec: FsmRecord, event: FsmEvent): Guards;
  /**
   * The FG-2 `reset_ci_fix_rounds` post-action context (`ci_green ∧ no_inflight_epoch` of the RESULTING
   * record). `no_inflight_epoch` is the resulting `in_flight_epoch_id`; `ci_green` is a live CI read of
   * the resulting head — neither derivable from `ci_fix_rounds`, so resolved from the pre-reset record.
   */
  resetContext(resultingRecord: FsmRecord): CiFixResetContext;
  /**
   * The `caught_up` recompute inputs (design §6) read AFTER the bucket-a worklist registrations commit,
   * so the disposition snapshot reflects a just-registered/​injected item (FG-5 / §6 ordering).
   * MAY BE ASYNC (PR 47): the live resolver reads the authoritative disposition store
   * from D1 at recompute time (the FG-5-honest point — a pre-`applyEvent` preload would race the
   * just-committed registrations). `finishCommit` awaits it ONLY when the committed transition is a §6
   * recompute trigger, so non-trigger transitions never pay the read.
   */
  caughtUpInputs(resultingRecord: FsmRecord, event: FsmEvent): FsmCaughtUpInputs | Promise<FsmCaughtUpInputs>;
  /** `deadline_class(state)` → backstop window ms (`null` = no backstop). */
  deadlineMs(state: FsmState): number | null;
}

/** The `caught_up` recompute snapshot the resolver supplies (design §6): the conjunction's inputs. */
export interface FsmCaughtUpInputs {
  noInflightEpoch: boolean;
  store: CaughtUpStore;
}

/** What the bucket-b side-effect sink receives for one committed transition (design §7(b)). */
export interface SideEffectDispatch {
  sessionId: string;
  /** The post-commit version the side-effects are keyed to (idempotency / cleaner redelivery, D17). */
  version: number;
  from: FsmState;
  to: FsmState;
  event: FsmEvent;
  sideEffects: readonly SideEffect[];
  /** True when bucket-a worklist registration failed but bucket-b side effects are still owed. */
  worklistFailed?: boolean;
  /**
   * The PRE-transition committed record (`version - 1`) — the sink's PURE before-image for a
   * transition-driven canonical label reconcile (W11: compare `labelsOf(priorRecord)` against
   * `labelsOf(resultingRecord)`). Threaded so the live sink can decide the managed-label diff without a
   * GitHub read and stay quiet on no-change self-loops (e.g. `ci.signal` that projects an identical
   * label set). Optional: a state-derived redelivery (D17 `repairDispatch`) synthesizes a self-loop
   * dispatch with no distinct prior image, so it is absent there — the label reconcile then no-ops and
   * the sweep's periodic reconcile self-heals.
   */
  priorRecord?: FsmRecord;
  /**
   * The post-commit record at `version` — the committed values the live executors key their
   * idempotency anchors to (PR 46): `in_flight_epoch_id` for `dispatch_epoch`, `pr_url` +
   * `verification_run_head`/`verification_run_id` for `spawn_verification_child`. Threading the
   * spine's own resulting record (not a re-read) keeps the effects keyed to THIS version even if a
   * concurrent CAS has already advanced the row by dispatch time.
   */
  resultingRecord: FsmRecord;
}

/**
 * Bucket-b external side-effects, dispatched AFTER commit. The real sink (`live-side-effects.ts`, PR 46)
 * executes the bag unconditionally.
 */
export interface FsmSideEffectSink {
  dispatch(dispatch: SideEffectDispatch): Promise<void> | void;
}

/**
 * Bucket-a committed worklist registrations (disposition store). Durable BEFORE the `caught_up` read
 * (FG-5). `record` is the post-commit record at `version` (the registrations' PR context — `pr_url`).
 * FAIL-LOUD CONTRACT (PR 46): a commit failure still THROWS out of `applyEvent` (the producer's
 * try/catch isolates legacy) — silently advancing state without its registrations would let a later
 * `caught_up` recompute miss the items and mint a premature MERGE_READY. The throw is DEFERRED past
 * the bucket-b side-effect dispatch, though: the CAS already committed the decision, so its effects
 * are owed regardless (DE-2) — only the `caught_up` recompute (the sole consumer endangered by the
 * missing registrations) is skipped. See `finishCommit`.
 */
export interface FsmWorklistSink {
  commit(
    sessionId: string,
    version: number,
    registrations: readonly WorklistRegistration[],
    record: FsmRecord,
  ): Promise<void> | void;
}

/** No-op side-effect sink — never executes anything. Test-only; every prod caller passes a live sink. */
export const noopSideEffectSink: FsmSideEffectSink = { dispatch() {} };

/** No-op worklist sink — registers nothing. Test-only; every prod caller passes a live sink. */
export const noopWorklistSink: FsmWorklistSink = { commit() {} };

/** The structured-DD emit seam (defaults to the real exporter); injectable so the O2 isolation test can throw. */
export type FsmDdEmit = (
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  event: Record<string, unknown>,
) => Promise<boolean>;

export interface ApplyEventDeps {
  db: D1Database;
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  /**
   * Clock seam (deterministic in tests). The STATE-MUTATION clock is read once per committed transition
   * (state_entered_at / dwell / activity-log `at` must share ONE value). `applyEvent` additionally reads
   * it at entry + at the emit to measure `commit_latency_ms` (the entry→durable-commit span, W11-G4) —
   * honest for producers wiring a live `Date.now` (verification/ci/head/review/cron/transport), ~0 for
   * producers that PIN `now` to a captured observation time (epoch/deadline/noshow alarms).
   */
  now: () => number;
  resolver: FsmGuardResolver;
  /**
   * REQUIRED live sinks (D-60: the spine is unconditionally live, no observe-only mode). Every prod
   * caller passes `liveFsmSinks(env)` (or the build* equivalents); tests pass the exported noop
   * constants explicitly. No default fallback — a missing sink is a wiring bug, not a silent no-op.
   */
  sideEffects: FsmSideEffectSink;
  worklist: FsmWorklistSink;
  /** Drill-down only on the DD event (never grouped — design §18.4 cardinality discipline). */
  businessId?: string | null;
  /** Defaults to {@link postStructuredEventToDd}; overridable for the O2 isolation test. */
  emit?: FsmDdEmit;
  /** Fire-and-forget dispatcher (Workers `waitUntil`) for the transition emit, so it never blocks the commit path. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface ApplyEventInput {
  sessionId: string;
  event: FsmEvent;
  /** The producer-attached typed metadata (design §18.2). Observability-only (O1) — never read by a guard. */
  metadata?: EventMetadata | null;
  actor: EventActor;
}

/** The committed transition outcome. `unhandled`/`no_record`/`lost_race` write no row. */
export type ApplyEventOutcome = "no_record" | "unhandled" | "handled" | "lost_race";

export interface ApplyEventResult {
  outcome: ApplyEventOutcome;
  from: FsmState | null;
  to: FsmState | null;
  /** The post-commit version on `handled`, else null. */
  version: number | null;
}

// ── Record coercion ───────────────────────────────────────────────────────────

const FSM_STATE_SET: ReadonlySet<string> = new Set(FSM_STATES);

/**
 * Refine a persisted `PrCoordinationRecord` (loose string enums) into the FSM's closed-enum
 * `FsmRecord`. Every value the spine reads back was written by the spine as a valid enum; `state` is
 * guarded (like the timeline reader) so a corrupt/legacy row fails loudly instead of feeding `stageOf`
 * an unknown state — the remaining enum fields ride through unchanged (the persistence layer is the
 * source of truth and the type refinement is a cast).
 */
function coerceFsmRecord(rec: PrCoordinationRecord): FsmRecord {
  if (!FSM_STATE_SET.has(rec.state)) {
    throw new Error(`pr_coordination: unknown FSM state ${JSON.stringify(rec.state)}`);
  }
  return rec as FsmRecord;
}

/**
 * The spine's CAS write = the pure transition's field-writes PLUS the `state` column the spine sets
 * from `Decision.to`. `FsmFieldWrites` itself omits `state` (so `Decision.to` is its ONLY source);
 * the spine re-adds it here when building the actual commit.
 */
type CommitFieldWrites = FsmFieldWrites & { state: FsmState };

/** Build the resulting record from the pre-commit record + the (final) field-writes + the bumped version. */
function applyResult(prev: FsmRecord, fieldWrites: CommitFieldWrites): FsmRecord {
  return { ...prev, ...fieldWrites, version: prev.version + 1 } as FsmRecord;
}

// ── Observability (design §18.4) ──────────────────────────────────────────────

/** camelCase → snake_case for flattening the typed metadata onto the structured event. */
function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Flatten the producer metadata (minus its `type`, which `fsm_event` already carries) onto the event
 * in snake_case (design §18.4 "…flattened metadata"). The load-bearing `reviewer_id` (the count
 * metric's group tag) falls out as `reviewer_id`. Cardinality discipline (review-loop-events.ts) is a
 * Terraform concern: every field is safe to LOG, but only bounded enums may be grouped in a metric.
 */
function flattenMetadata(metadata: EventMetadata | null): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "type") continue;
    out[toSnakeCase(key)] = value;
  }
  return out;
}

/**
 * The centralized observability emit (design §18.4). After the CAS commit + the event-log INSERT,
 * emit ONE structured DD event carrying the transition + `dwell_ms` + the from/to stage axis +
 * flattened metadata. Following the established RLA/VA telemetry convention (review-loop-events.ts),
 * we do NOT also post v2 metric series: the two design metrics — `arcanist.fsm.transition` (count;
 * grouped by bounded state/event/stage tags) and `arcanist.fsm.stage_dwell_ms` (distribution over
 * `dwell_ms`, grouped by `stage`) — are Terraform log-based metrics over THIS event. One write per
 * transition; one source of truth. It also carries `commit_latency_ms` (W11-G4) — the producer→spine
 * commit latency, feeding the `arcanist.fsm.commit_latency_ms` log distribution (Terraform, grouped by
 * `fsm_event` = the per-producer facet). BEST-EFFORT: the whole body is try/caught here, so a DD failure
 * (O2) never surfaces — the caller may fire it via `waitUntil` (off the commit path) or await it.
 */
async function emitTransitionEvent(
  deps: ApplyEventDeps,
  input: ApplyEventInput,
  from: FsmState,
  to: FsmState,
  version: number,
  dwellMs: number,
  stageFrom: string,
  stageTo: string,
  metadata: EventMetadata | null,
  commitLatencyMs: number,
): Promise<void> {
  const emit = deps.emit ?? postStructuredEventToDd;
  try {
    await emit(deps.env, {
      event: "fsm.transition",
      session_id: input.sessionId,
      business_id: deps.businessId ?? null,
      version,
      from,
      to,
      fsm_event: input.event.type,
      dwell_ms: dwellMs,
      // Producer→spine commit latency (W11-G4). Only committed transitions carry it (the noop emits do
      // not), so the log-metric filters on `@commit_latency_ms:>=0` to select committed transitions.
      commit_latency_ms: commitLatencyMs,
      stage_from: stageFrom,
      stage_to: stageTo,
      // `stage` mirrors `stage_from` so the dwell-distribution metric groups on a single field (the
      // dwell of an event is time spent in its `from_state`'s stage, design §18.1/§18.3).
      stage: stageFrom,
      ...flattenMetadata(metadata),
    });
  } catch (err) {
    console.warn("[fsm.applyEvent] observability emit failed (ignored, O2):", err);
  }
}

/**
 * The no-op DD emit (design §18 / §8 sense-i). Two distinct no-record shapes ride ONE structured event
 * (both write NO row, NO append — the log stays a record of committed transitions), split by the `noop`
 * tag so the dashboard/monitor can facet them:
 *   • `unhandled` — an event arrived at an EXISTING row with no matching edge (`transition` returned
 *     null). Carries the real current `from` state.
 *   • `no_record` — an event arrived for a session with NO `pr_coordination` row yet (pre-genesis /
 *     backfill gap). There is no `from` state, so the field is OMITTED rather than reporting a
 *     fabricated `CREATED` placeholder (which would masquerade as a real starting state in the noop
 *     facet). "The FSM ignored an event" is a primary debugging question either way, so emit to DD
 *     ONLY, best-effort. Try/caught — never blocks the (no-op) return.
 */
async function emitNoopEvent(
  deps: ApplyEventDeps,
  input: ApplyEventInput,
  noop: "unhandled" | "no_record",
  from: FsmState | null,
): Promise<void> {
  const emit = deps.emit ?? postStructuredEventToDd;
  try {
    await emit(deps.env, {
      event: "fsm.transition",
      noop,
      session_id: input.sessionId,
      business_id: deps.businessId ?? null,
      // `no_record` has no originating state (the row does not exist) — omit the field instead of
      // stamping a placeholder. `unhandled` carries the real current state.
      ...(from ? { from } : {}),
      fsm_event: input.event.type,
    });
  } catch (err) {
    console.warn("[fsm.applyEvent] noop emit failed (ignored, O2):", err);
  }
}

// ── The write path (design §8) ────────────────────────────────────────────────

/**
 * Apply one `FsmEvent` to a session's `pr_coordination` record — the design §8 single-writer write
 * path. Returns the committed outcome (the spine output is not yet consumed; producers ignore it but
 * the integration test asserts on it). NOT wrapped in a try/caught here — the PRODUCER wraps the call
 * best-effort off the legacy path (so a producer fault is isolated); the only INTERNAL isolation is the
 * observability emit (O2). Re-entrant for the internal `caught_up` event (the PR-20A cascade producer).
 */
export async function applyEvent(deps: ApplyEventDeps, input: ApplyEventInput, depth = 0): Promise<ApplyEventResult> {
  // Producer-latency instrument (W11-G4): the entry wall-clock, captured ONCE before the CAS loop so a
  // contended retry legitimately widens the measured `commit_latency_ms`. Sourced via the injected clock
  // (never a bare `Date.now`, per the repo clock-injection pattern) — see the `now` seam doc for the
  // pinned-producer caveat.
  const applyStartedAt = deps.now();

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const persisted = await getPrCoordination(deps.db, input.sessionId);
    if (!persisted) {
      // No record yet (a pre-genesis or backfill gap, PR 35A) — nothing to drive. Best-effort
      // `noop:no_record` to DD so a frozen session is visible, then return (no `from` placeholder).
      await emitNoopEvent(deps, input, "no_record", null);
      return { outcome: "no_record", from: null, to: null, version: null };
    }

    const rec = coerceFsmRecord(persisted);
    const decision = transition(rec.state, input.event, deps.resolver.guards(rec, input.event));

    // §8 sense (i): unhandled event → early return, NO post-actions, NO append, DD-only noop.
    if (!decision) {
      await emitNoopEvent(deps, input, "unhandled", rec.state);
      return { outcome: "unhandled", from: rec.state, to: rec.state, version: rec.version };
    }

    const now = deps.now();
    const deadlineMs = deps.resolver.deadlineMs(decision.to);
    // W11-V5 SF10: a dwell-neutral self-loop in REVIEW or VERIFYING (empty fieldWrites + log_noop-only +
    // no worklist registration — pure churn, e.g. a re-observed ci.signal on an in-flight epoch / during
    // VERIFYING, cascade row-5 ci_pending WAIT, or epoch.deferred) does NOT re-stamp the dwell/deadline
    // anchor: it commits + journals but keeps `state_entered_at`/`deadline_at` at their prior values, so
    // the §10 give-up (`REVIEW_STUCK_DEADLINE_MS` review_stuck / 1h verification_stopped) stays reachable under unbounded
    // per-tick churn (the SF10 keystone). The DECISION-SHAPE rule is the authority — see
    // transition.isDwellNeutralSelfLoop.
    const dwellNeutral = isDwellNeutralSelfLoop(rec.state, decision);

    // The FG-2 reset reads the RESULTING record's live `ci_green ∧ no_inflight_epoch` (independent of
    // the `ci_fix_rounds` the reset itself sets), so resolve it off a pre-reset resulting record that
    // already carries the edge's field-writes + (for a re-arming event) the armed dwell anchor. For a
    // dwell-neutral event the anchor is PRESERVED (the record's existing `state_entered_at`/`deadline_at`).
    const preResetResult = applyResult(rec, {
      ...decision.fieldWrites,
      state: decision.to,
      ...(dwellNeutral ? {} : { stateEnteredAt: now, deadlineAt: deadlineMs === null ? null : now + deadlineMs }),
    });
    const resetContext = deps.resolver.resetContext(preResetResult);

    // Universal post-actions (§7): arm_deadline (skipped when dwell-neutral) + the conditional
    // reset_ci_fix_rounds + project, plus dwell_ms (§18.1) and the threaded metadata.
    const post = universalPostActions(decision, {
      now,
      stateEnteredAt: rec.stateEnteredAt,
      deadlineMs,
      ciGreen: resetContext.ciGreen,
      noInflightEpoch: resetContext.noInflightEpoch,
      metadata: input.metadata ?? null,
      dwellNeutral,
    });

    // The CAS write rides ALL field-writes + `state` (transition omits it; the spine sets it, §8).
    const casFields: CommitFieldWrites = { ...post.decision.fieldWrites, state: post.decision.to };
    const changed = await casUpdatePrCoordination(deps.db, input.sessionId, rec.version, casFields);
    if (changed === 0) {
      // Lost the race — a concurrent writer bumped the version. Re-read + re-evaluate idempotently (§8).
      continue;
    }

    const newVersion = rec.version + 1;
    const resultingRecord = applyResult(rec, casFields);
    return finishCommit(
      deps,
      input,
      rec,
      post.decision,
      newVersion,
      now,
      post.dwellMs,
      post.metadata,
      resultingRecord,
      depth,
      applyStartedAt,
    );
  }

  // Exhausted the CAS budget under sustained contention — the producer's redelivery/cleaner retries (D17).
  return { outcome: "lost_race", from: null, to: null, version: null };
}

/**
 * Post-CAS commit steps (design §8 tail), factored out of the retry loop: append the activity-log
 * row (journal-first — a later failure can never leave a committed version with no log row) →
 * bucket-a worklist registrations (durable BEFORE the `caught_up` read, FG-5; fail-loud, but the
 * failure is CAUGHT + marked and rethrown at the tail) → centralized observability emit (O2
 * isolated) → bucket-b side-effects (observe-only in shadow) → recompute `caught_up` and re-enter
 * `applyEvent` (the PR-20A cascade producer) ONLY if the worklist committed → rethrow the worklist
 * failure. Rationale for the deferred throw: the CAS already committed the decision, so its
 * side-effect bag is OWED regardless of the registration write (DE-2 commit-before-side-effects —
 * skipping dispatch wedged committed decisions, e.g. a stamped `in_flight_epoch_id` whose epoch
 * never dispatched, or a committed VERIFYING that never spawned). The `caught_up` recompute is the
 * ONLY consumer a missing registration endangers (FG-5: reading a store without just-registered
 * items mints a premature MERGE_READY), so exactly that step is skipped and the error still
 * surfaces loudly to the producer.
 */
async function finishCommit(
  deps: ApplyEventDeps,
  input: ApplyEventInput,
  prev: FsmRecord,
  decision: Decision,
  newVersion: number,
  now: number,
  dwellMs: number,
  metadata: EventMetadata | null,
  resultingRecord: FsmRecord,
  depth: number,
  applyStartedAt: number,
): Promise<ApplyEventResult> {
  const worklistSink = deps.worklist;
  const sideEffectSink = deps.sideEffects;

  // The append-only activity log (the §8 / §18 substrate): one row per committed transition. Appended
  // FIRST — before the worklist commit — so a worklist failure can never leave a committed CAS row
  // with no activity-log row (a permanent version gap in the journal the §18 reconstruction and the
  // D17 reconciles read). Both failure modes now fail loud with the journal intact.
  await appendPrCoordinationEvent(deps.db, {
    sessionId: input.sessionId,
    version: newVersion,
    fromState: prev.state,
    toState: decision.to,
    event: input.event.type,
    // The SAME clock read used for `state_entered_at`/dwell above (read once per applyEvent before
    // the CAS, §8/§18.1) — keeps the activity-log timestamp consistent with the dwell accounting.
    at: now,
    actor: input.actor,
    metadata,
    dwellMs,
  });

  // (a) Worklist registrations — committed BEFORE the caught_up recompute reads the disposition store
  // (FG-5 / §6 ordering: the `caughtUpInputs` snapshot below is taken AFTER this await, so a
  // just-registered item keeps `caught_up` false). A failure is CAUGHT here — marked loudly
  // (`fsm.worklist.failed` + log.error) — and RETHROWN at the tail of this function, AFTER the
  // bucket-b dispatch: the CAS already committed the decision, so its effects are owed regardless
  // (DE-2); only the caught_up recompute (the sole consumer endangered by missing registrations,
  // FG-5) is skipped. The producer's try/catch still isolates legacy and logs the surfaced failure;
  // the D17 cron reconciles own the registration repair.
  let worklistFailure: { error: unknown } | null = null;
  if (decision.worklistRegistrations && decision.worklistRegistrations.length > 0) {
    try {
      await worklistSink.commit(input.sessionId, newVersion, decision.worklistRegistrations, resultingRecord);
    } catch (err) {
      worklistFailure = { error: err };
      console.error(
        `[fsm.applyEvent] worklist commit FAILED for session ${input.sessionId} v${newVersion} ` +
          `(${prev.state} → ${decision.to} on ${input.event.type}) — dispatching the committed side-effects, ` +
          `skipping the caught_up recompute, rethrowing:`,
        err,
      );
      const emit = deps.emit ?? postStructuredEventToDd;
      try {
        await emit(deps.env, {
          event: "fsm.worklist.failed",
          session_id: input.sessionId,
          business_id: deps.businessId ?? null,
          version: newVersion,
          from: prev.state,
          to: decision.to,
          fsm_event: input.event.type,
          error: String(err),
        });
      } catch (emitErr) {
        console.warn("[fsm.applyEvent] fsm.worklist.failed emit failed (ignored, O2):", emitErr);
      }
    }
  }

  // Producer-latency (W11-G4): the entry→durable-commit span — by here the CAS row, the activity-log
  // journal, and the bucket-a worklist registrations are all durable. Measured just BEFORE the telemetry
  // POST so the best-effort DD emit itself never counts toward it. Same injected clock as the entry read;
  // `max(0, …)` guards a non-monotonic wall clock stepping backward.
  const commitLatencyMs = Math.max(0, deps.now() - applyStartedAt);

  // Centralized observability emit (design §18.4) — best-effort, O2-isolated inside the helper. Fired via
  // `waitUntil` when available so the DD POST rides OFF the commit path (mirrors the divergence hook
  // below); else awaited best-effort. `emitTransitionEvent` swallows its own errors, so a fire-and-forget
  // POST can never reject into the runtime.
  const transitionEmit = emitTransitionEvent(
    deps,
    input,
    prev.state,
    decision.to,
    newVersion,
    dwellMs,
    stageOf(prev),
    stageOf(resultingRecord),
    metadata,
    commitLatencyMs,
  );
  if (deps.waitUntil) deps.waitUntil(transitionEmit);
  else await transitionEmit;

  // (b) External side-effects — dispatched AFTER commit. The CAS row already exists, so a crash
  // before/within dispatch is redelivered by the cleaner (D17): commit before side-effect, never a
  // rollback-on-side-effect.
  await sideEffectSink.dispatch({
    sessionId: input.sessionId,
    version: newVersion,
    from: prev.state,
    to: decision.to,
    event: input.event,
    sideEffects: decision.sideEffects,
    worklistFailed: worklistFailure !== null,
    // The pre-transition record (`prev`) is the sink's pure before-image for the transition-driven
    // canonical label reconcile — see SideEffectDispatch.priorRecord.
    priorRecord: prev,
    resultingRecord,
  });

  // FG-5 fail-loud tail: with the owed side-effects dispatched, surface the worklist failure to the
  // producer BEFORE the caught_up recompute — a recompute over a store missing the just-committed
  // registrations is exactly the premature-MERGE_READY read FG-5 forbids.
  if (worklistFailure) {
    throw worklistFailure.error;
  }

  // Recompute caught_up (PR-20A producer): if it newly holds for the live head in REVIEW, feed one
  // internal caught_up{head} back into applyEvent. Classify FIRST, then resolve the snapshot: the
  // store is read NOW — after the bucket-a worklist commit — so a just-registered item keeps
  // caught_up false (FG-5 / §6 ordering), and a possibly-async live snapshot (PR 47) is only paid
  // when the committed transition is actually a §6 recompute trigger.
  if (depth < MAX_REENTRY_DEPTH && classifyCaughtUpTrigger(prev.state, input.event, decision.to) !== null) {
    const inputs = await deps.resolver.caughtUpInputs(resultingRecord, input.event);
    const caughtUpEvent = recomputeCaughtUp({
      resultingState: decision.to,
      headSha: resultingRecord.headSha,
      noInflightEpoch: inputs.noInflightEpoch,
      store: inputs.store,
    });
    if (caughtUpEvent) {
      await applyEvent(
        deps,
        { sessionId: input.sessionId, event: caughtUpEvent, metadata: { type: "caught_up" }, actor: "internal" },
        depth + 1,
      );
    }
  }

  return { outcome: "handled", from: prev.state, to: decision.to, version: newVersion };
}
