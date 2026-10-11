// ARC-1330 lifecycle FSM (PR 36) — TRANSPORT-REDUCER producer: `reduceLifecycle` boundary → spine events.
//
// The transport sub-machine (`session/lifecycle/reducer.ts`, driven from `durable-object.ts`'s
// `processLifecycleEvent`) governs sandbox transport + prompt dispatch — the codegen half of the
// lifecycle. This producer maps that reducer's BOUNDARY activity onto the spine's `sandbox.*` /
// `prompt.*` events, and the post-execution diff-decision onto `postexec.done`, so the shadow
// `pr_coordination` row advances CREATED→PROVISIONING→GENERATING→FINALIZING→PUBLISHING alongside legacy
// (and onto the hard-failure terminals). Pure mapping here; the DO wires the best-effort `applyEvent`.
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught
// OFF the legacy critical path (the DO call sites), so a producer fault never perturbs the live session,
// and nothing consumes the spine output yet. Mapping is observe-only — the divergence metric (PR 45)
// measures where the shadow row tracks legacy.
//
// SOUNDNESS over completeness (the shadow rule): we emit a spine event ONLY when the reducer GENUINELY
// acted (a stale/noop reducer decision emits nothing — the legacy state didn't move, so the spine must
// not either), and only for events whose spine mapping is unambiguous. The legacy reducer event carries
// no diff/awaiting-input result, so two refinements are intentionally DEFERRED (surfaced by the
// divergence metric, never emitted wrong): (1) `prompt.awaiting_input` — the pending-question pause is
// not a reducer signal, so a successful terminal maps to the FINALIZING-bound `prompt.terminal{changes}`
// (a `postexec.done{¬hasChanges}` then settles a no-diff turn to ANSWERED_NO_PR); (2) `prompt.terminal`
// `{no_changes}` vs `{changes}` is likewise decided downstream at `postexec.done`, not at the terminal.
// `prompt.abort_requested` (user-driven) belongs to the `user.stop` producer, not this transport one.

import type { ErrorCode } from "../../../../../shared/types/sandbox.js";
import type { LifecycleDecision, LifecycleEvent } from "../lifecycle/types";
import type { FsmGuardResolver } from "./apply-event";
import type { EventActor, EventMetadata, FsmEvent } from "./types";

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface TransportEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every transport-produced spine event is attributed to the transport actor. */
const TRANSPORT_ACTOR: EventActor = "transport";

function tx(event: FsmEvent, metadata: EventMetadata): TransportEmission {
  return { event, metadata, actor: TRANSPORT_ACTOR };
}

/** True when the reducer did MORE than no-op — the legacy state actually moved (so the spine may too). */
function reducerActed(decisions: readonly LifecycleDecision[]): boolean {
  return decisions.some((d) => d.action !== "noop");
}

/** The `sandbox.state` the reducer's `persist_state` patch wrote (e.g. `ready`/`failed`), or undefined. */
function persistedSandboxState(decisions: readonly LifecycleDecision[]): string | undefined {
  for (const d of decisions) {
    if (d.action === "persist_state" && d.patch.sandbox?.state) return d.patch.sandbox.state;
  }
  return undefined;
}

/** The `prompt.phase` the reducer's `persist_state` patch wrote (`queued`/`terminal`/…), or undefined. */
function persistedPromptPhase(decisions: readonly LifecycleDecision[]): string | undefined {
  for (const d of decisions) {
    if (d.action === "persist_state" && d.patch.prompt?.phase) return d.patch.prompt.phase;
  }
  return undefined;
}

/** The reducer flagged a hard prompt terminal (an error/abort/timeout) when it emits a terminal decision. */
function emittedTerminal(decisions: readonly LifecycleDecision[]): boolean {
  return decisions.some((d) => d.action === "emit_terminal");
}

/** The `errorCode` the reducer's `emit_terminal` decision classified the terminal with, or null. */
function emittedTerminalErrorCode(decisions: readonly LifecycleDecision[]): ErrorCode | null {
  for (const d of decisions) {
    if (d.action === "emit_terminal") return d.errorCode;
  }
  return null;
}

/**
 * Map ONE transport reducer boundary `(event, decisions)` onto its spine `FsmEvent`(s) — the PR-36
 * "reducer-decision → spine-event mapping". Returns `[]` for an event the reducer staled (a noop), an
 * event with no spine analog (transient heartbeat/keepalive/dispatch-progress, the boundary/review-
 * listening events owned by other producers), or a deferred refinement (see file header). Pure: the DO
 * call site wraps the emit best-effort.
 */
export function mapLifecycleEventToFsmEvents(
  event: LifecycleEvent,
  decisions: readonly LifecycleDecision[],
): TransportEmission[] {
  switch (event.type) {
    // ── Sandbox transport (genesis spine + hard-failure group) ──────────────────
    case "sandbox.spawn_requested":
      // Emit only when the reducer actually launched the spawn (the open-circuit branch noops or
      // terminalizes instead — no PROVISIONING transition there).
      return decisions.some((d) => d.action === "spawn_sandbox")
        ? [tx({ type: "sandbox.spawn_requested" }, { type: "sandbox.spawn_requested" })]
        : [];
    case "sandbox.ws_connected":
      // Transport accepted → the FSM's `sandbox.ready` (PROVISIONING→GENERATING). The reducer marks
      // `sandbox.state = ready` here (spawn_succeeded only reaches `connecting`).
      return persistedSandboxState(decisions) === "ready"
        ? [tx({ type: "sandbox.ready" }, { type: "sandbox.ready" })]
        : [];
    case "sandbox.spawn_failed":
      return persistedSandboxState(decisions) === "failed"
        ? [tx({ type: "sandbox.spawn_failed" }, { type: "sandbox.spawn_failed" })]
        : [];
    case "sandbox.liveness_expired":
      return reducerActed(decisions)
        ? [tx({ type: "sandbox.liveness_expired" }, { type: "sandbox.liveness_expired" })]
        : [];
    case "sandbox.reconnect_grace_expired":
      // The unexpected-teardown give-up = the FSM's hard-failure `sandbox.death` signal.
      return reducerActed(decisions) ? [tx({ type: "sandbox.death" }, { type: "sandbox.death" })] : [];

    // ── Prompt dispatch (codegen spine + codegen-failure group) ─────────────────
    case "prompt.enqueued":
      return persistedPromptPhase(decisions) === "queued"
        ? [tx({ type: "prompt.enqueued" }, { type: "prompt.enqueued" })]
        : [];
    case "prompt.terminal_received": {
      // A genuine terminal transition writes `prompt.phase = terminal`; the stale/precedence-merge
      // branches write no phase → nothing to emit.
      if (persistedPromptPhase(decisions) !== "terminal") return [];
      // The `{error}` outcome carries the reducer's terminal errorCode plus the DO's stop corroboration
      // so the transition can route a genuine user stop ("aborted" + stoppedByUser) to the quiet
      // STOPPED close-out instead of FAILED(codegen_error). Uncorroborated aborts stay loud failures.
      const errorCode = emittedTerminalErrorCode(decisions);
      if (errorCode !== null) {
        const stoppedByUser = event.stoppedByUser === true;
        return [
          tx(
            { type: "prompt.terminal", outcome: "error", errorCode, stoppedByUser },
            { type: "prompt.terminal", outcome: "error", errorCode, stoppedByUser },
          ),
        ];
      }
      return [tx({ type: "prompt.terminal", outcome: "changes" }, { type: "prompt.terminal", outcome: "changes" })];
    }
    case "prompt.running_inactivity_elapsed":
      // The running-inactivity give-up = the FSM's `prompt.max_duration_exceeded` (hard-failure group).
      return emittedTerminal(decisions)
        ? [tx({ type: "prompt.max_duration_exceeded" }, { type: "prompt.max_duration_exceeded" })]
        : [];
    case "prompt.startup_deadline_elapsed":
    case "prompt.dispatch_deadline_elapsed":
      // A codegen startup/dispatch timeout terminal = the FSM's `prompt.terminal{error}` → FAILED.
      return emittedTerminal(decisions)
        ? [tx({ type: "prompt.terminal", outcome: "error" }, { type: "prompt.terminal", outcome: "error" })]
        : [];

    // ── Archive boundaries → the spine's ARCHIVED close-out ──────
    case "boundary.close_finalize":
      // User/API archive is terminal, so emit session.archived and let the FSM
      // run final-terminal closeout. PR webhook closes are excluded: their
      // producer emits pr.closed/pr.merged before closeSessionState, and a
      // second session.archived would be an unhandled final-terminal noop.
      return event.reason === "fsm_kill_verification" ||
        event.reason === "session_archived" ||
        event.reason === "dashboard_archive" ||
        event.reason === "api_archive"
        ? [tx({ type: "session.archived" }, { type: "session.archived" })]
        : [];

    default:
      // Transient/keepalive/dispatch-progress events, the remaining boundary.* + review_listening.*
      // events (other producers), and the deferred `prompt.abort_requested` → no transport spine emission.
      return [];
  }
}

/**
 * The post-execution diff decision → `postexec.done{hasChanges, promptIntendsChange}` (FINALIZING→
 * PUBLISHING vs ANSWERED_NO_PR, design §9). NOT a reducer boundary event: `hasChanges` /
 * `promptIntendsChange` ride the bridge `post_execution` event, so the DO emits this from that handler
 * (not `processLifecycleEvent`). `promptIntendsChange` is observability/projection-only (D3, SF11) —
 * it never gates publish.
 */
export function buildPostexecDoneEmission(hasChanges: boolean, promptIntendsChange: boolean): TransportEmission {
  return {
    event: { type: "postexec.done", hasChanges, promptIntendsChange },
    metadata: { type: "postexec.done", hasChanges, promptIntendsChange },
    actor: TRANSPORT_ACTOR,
  };
}

/** Plan capture committed and the gated session is now waiting on its owner. */
export function buildPlanAwaitingInputEmission(): TransportEmission {
  return tx({ type: "prompt.awaiting_input" }, { type: "prompt.awaiting_input" });
}

/** Discuss/approve released a parked plan. Approval uses this same producer seam in its later PR. */
export function buildPlanUserInputEmission(): TransportEmission {
  return {
    event: { type: "user.input" },
    metadata: { type: "user.input" },
    actor: "user",
  };
}

/**
 * The `FsmGuardResolver` the transport producer feeds `applyEvent`. Every transport spine edge lives in
 * the pre-REVIEW states (CREATED→PROVISIONING→GENERATING→AWAITING_INPUT→FINALIZING→PUBLISHING) plus the
 * hard-failure/terminal cross-cutting edges, NONE of which read a CI / review / verification guard — so
 * the resolver supplies only the value these edges actually use and conservative no-ops for the
 * rest:
 *   - `sandboxAlive` — defaults true (the `ANSWERED_NO_PR — user.input` follow-up target is a `user.*`
 *     producer concern, not transport; supplying it keeps the bag well-formed).
 *   - `stopMode`/`preStopState` — RECORD-sourced (pure record columns, not live reads): the
 *     `STOPPED — prompt.enqueued` re-prompt re-entry routes on `pre_stop_state` (post-publish stops
 *     re-enter REVIEW, pre-publish stops re-dispatch codegen), so the transport's own event must see
 *     them. Mirrors the live resolver's record-sourced supply; absent ⇒ the pre-publish default.
 *   - `caughtUpInputs` returns a NON-caught-up store (`countUndispositionedActionable() = 1`), so even
 *     if a transport edge ever reached the recompute it could never spuriously settle a MERGE_READY.
 *   - `deadlineMs() = null`: deadlines stay observe-only until PR 44 wires the real backstops.
 */
export function transportShadowResolver(_sessionId: string): FsmGuardResolver {
  return {
    guards: (rec) => ({
      sandboxAlive: true,
      stopMode: rec.stopMode ?? undefined,
      preStopState: rec.preStopState ?? undefined,
    }),
    resetContext: () => ({ ciGreen: false, noInflightEpoch: true }),
    caughtUpInputs: () => ({
      noInflightEpoch: true,
      store: { countUndispositionedActionable: () => 1, allReviewersSettled: () => false },
    }),
    deadlineMs: () => null,
  };
}

/**
 * PR 47 SCOPE GUARD (Wave-10 decision — live authority is POST-PUBLISH families ONLY). The transport
 * producer stays EMIT-ONLY: its events keep advancing the spine row (the post-publish states are
 * unreachable without the genesis arc), but it NEVER gets the live guard resolver — the transport/
 * lifecycle reducer keeps its decision authority, its bucket-b kinds stay inert in the live sink, and
 * its `caughtUpInputs` floor stands. This selector is the STRUCTURAL hold; any future "live transport
 * authority" must consciously replace this single emit-only return with a distinct live resolver.
 */
export function transportResolver(sessionId: string): FsmGuardResolver {
  return transportShadowResolver(sessionId);
}
