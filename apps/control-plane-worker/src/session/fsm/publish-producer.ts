// ARC-1330 lifecycle FSM (PR 37) — PUBLISH-PATH producer: `publish-service.ts` outcomes → spine events.
//
// `publishSessionResultInner` (`session/publish-service.ts`) is the control-plane half that opens the
// PR. This producer maps its three terminal publish outcomes onto the spine's PUBLISHING-state events so
// the shadow `pr_coordination` row advances PUBLISHING→REVIEW (a PR opened), PUBLISHING→ANSWERED_NO_PR
// (a `has_changes` turn whose diff is net-zero against base at publish — N10), or PUBLISHING→FAILED (a
// durable publish failure). Pure builders here; the DO/publish-service wires the best-effort `applyEvent`.
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught
// OFF the legacy critical path (the publish-service call sites), so a producer fault never perturbs the
// live publish. Observe-only — the divergence metric (PR 45)
// measures where the shadow row tracks legacy.
//
// SOUNDNESS over completeness (the shadow rule): we emit a spine event ONLY at an UNAMBIGUOUS legacy
// publish terminal — the `status:"published"` return (a real opened/adopted PR), the durable
// `failPublish` terminal (`publish_status = failed`), and the "head branch matches base — no changes"
// guard (the net-zero N10 case). The continuation of the transport-driven codegen arc (postexec.done →
// PUBLISHING in PR 36) into PUBLISHING→REVIEW keeps the same `transport` actor for a coherent spine
// attribution. The head sha rides the `publish.pr_opened` event payload; optional structured diff stats
// ride observability metadata so reporting does not have to parse prose.

import type { FsmGuardResolver } from "./apply-event";
import type { EventActor, EventMetadata, FsmEvent } from "./types";

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface PublishEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/**
 * Every publish-produced spine event continues the transport-driven codegen arc (FINALIZING→PUBLISHING
 * was emitted by the PR-36 transport producer as `transport`), so PUBLISHING→{REVIEW,ANSWERED_NO_PR,
 * FAILED} keeps the same actor for a single coherent spine attribution.
 */
const PUBLISH_ACTOR: EventActor = "transport";

/**
 * The `status:"published"` terminal → `publish.pr_opened{prHead}` (PUBLISHING→REVIEW, design §9). The
 * head sha rides the event payload (`init_record` seeds `head_sha := event.pr_head`, so it is never null
 * when REVIEW first live-reads CI/verification freshness, B5); the PR url is threaded via the resolver
 * (`prUrl` guard) since §5 pins the event payload to `{pr_head}` only.
 */
export function buildPublishPrOpenedEmission(
  prHead: string,
  diffStats?: { insertions: number; deletions: number } | null,
): PublishEmission {
  return {
    event: { type: "publish.pr_opened", prHead },
    metadata: {
      type: "publish.pr_opened",
      ...(diffStats
        ? {
            diffStats: {
              insertions: Math.max(0, diffStats.insertions),
              deletions: Math.max(0, diffStats.deletions),
            },
          }
        : {}),
    },
    actor: PUBLISH_ACTOR,
  };
}

/**
 * The net-zero-diff terminal → `publish.no_changes` (PUBLISHING→ANSWERED_NO_PR, design §9 / N10). A
 * `has_changes` turn whose diff is net-zero against base at publish (e.g. the change was already merged,
 * or the head branch equals the base) is a legitimate "no change produced" terminal, NOT a D3 violation.
 */
export function buildPublishNoChangesEmission(): PublishEmission {
  return {
    event: { type: "publish.no_changes" },
    metadata: { type: "publish.no_changes" },
    actor: PUBLISH_ACTOR,
  };
}

/**
 * The durable `failPublish` terminal → `publish.failed` (PUBLISHING→FAILED, design §9). Mirrors the
 * legacy `publish_status = failed` write — the loud give-up the watchdog/thrown-error paths converge on.
 */
export function buildPublishFailedEmission(): PublishEmission {
  return {
    event: { type: "publish.failed" },
    metadata: { type: "publish.failed" },
    actor: PUBLISH_ACTOR,
  };
}

/**
 * The benign review-loop publish block → `publish.superseded` ({REVIEW,VERIFYING}→SUPERSEDED, ARC-1389).
 * The PR/session moved on (head advanced under the epoch, session moved on, stale epoch) while the PR
 * stays OPEN — the neutral terminal, distinct from CLOSED so `project()` renders the `superseded` phase.
 * Actor `internal`: this terminal is an internal review-loop coordination outcome (the epoch publish
 * guard), not part of the transport-driven codegen arc the other publish events continue.
 */
export function buildPublishSupersededEmission(): PublishEmission {
  return {
    event: { type: "publish.superseded" },
    metadata: { type: "publish.superseded" },
    actor: "internal",
  };
}

/**
 * The `FsmGuardResolver` the publish producer feeds `applyEvent`. The PUBLISHING edges read only
 * `prUrl` (`publish.pr_opened`, threaded here since §5 keeps it off the event payload); the
 * `publish.superseded` edge ({REVIEW,VERIFYING}→SUPERSEDED, ARC-1389) additionally reads
 * `verificationChildId` when it LEAVES `VERIFYING` (the run-scoped `kill_verification` teardown of an
 * in-flight verifier). The rest of the bag is conservative no-ops — the same shape the transport resolver
 * supplies — so even if the post-`publish.pr_opened` REVIEW entry reaches the `caught_up` recompute it
 * can NEVER spuriously settle a MERGE_READY:
 *   - `prUrl` — the opened PR's URL for the `PUBLISHING — publish.pr_opened` `init_record` (design §4).
 *   - `verificationChildId` — supplied FROM THE COMMITTED RECORD (the active run's child — faithful
 *     `kill_verification` on the VERIFYING supersede), like the cron/deadline resolvers. In shadow the
 *     sink no-ops; this keeps the flip-time teardown sound.
 *   - `sandboxAlive` defaults true (no publish edge reads it; keeps the bag well-formed).
 *   - `caughtUpInputs` returns a NON-caught-up store (`countUndispositionedActionable() = 1`).
 *   - `resetContext` / `deadlineMs` stay conservative/observe-only (PR 44 wires the real backstops).
 */
export function publishShadowResolver(sessionId: string, prUrl?: string): FsmGuardResolver {
  void sessionId;
  return {
    guards: (rec) => ({
      sandboxAlive: true,
      verificationChildId: rec.verificationChildId,
      ...(prUrl ? { prUrl } : {}),
    }),
    resetContext: () => ({ ciGreen: false, noInflightEpoch: true }),
    caughtUpInputs: () => ({
      noInflightEpoch: true,
      store: { countUndispositionedActionable: () => 1 },
    }),
    deadlineMs: () => null,
  };
}
