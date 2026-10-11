// ARC-1330 lifecycle FSM (PR 40) — HEAD-WEBHOOK producer: GitHub PR head advance → `head.changed`/`head.noop_changed`.
//
// The PR head-SHA webhook (`webhooks/github.ts` `handlePullRequestSynchronizeEvent`) is the ONE place a
// `synchronize` delivery is matched to a live review-listening session and the session's stored head is
// advanced out-of-band (the sweep's head-change branch is then skipped next tick because
// `previousHeadSha === newHeadSha`). That handler ALSO already computes the content-noop determination —
// `isNoOpHeadTreeChange(prev, new)` (same tree SHA: rebase / reword / no-op force-push) — to decide
// whether to PRESERVE vs CLEAR the prior-head verification verdict (ARC-1243). So this producer dual-emits
// `head.changed`/`head.noop_changed` from exactly the handler's resolved head-advance, reusing that
// already-computed no-op flag (the cheat-sheet's "name the symbol, not the line"): re-deriving the tree
// equality here would add a second GitHub compare per head advance — the rate-limit cost the shadow phase
// must not add.
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught OFF the
// legacy critical path (the handler's head reconciliation), so a producer fault never perturbs the
// live review loop.
//
// SOUNDNESS over completeness: the `head.changed` vs `head.noop_changed` split (N4) is
// the load-bearing discrimination — `head.changed` advances + `set_code_changed` + `clear_verification`
// (forces a re-QA), while `head.noop_changed` advances + (conditionally) `restamp_verification` (keeps the
// verdict fresh, no re-QA). The producer defaults to `head.changed` whenever the handler did NOT compute a
// no-op determination (it only reads the tree compare when a settled verdict is present to preserve). That
// default is not merely conservative — it is BEHAVIORALLY FAITHFUL: with no settled verdict, `head.changed`
// and `head.noop_changed` differ only by `restamp_verification`, which is vacuous on a null verdict. When a
// verdict IS present (the path that mints the no-op read) the producer uses the real determination, so the
// only direction the default can ever bias is toward a re-QA — never toward keeping a stale verdict. The
// classification is a PURE function of `{headSha, prevHeadSha, isContentNoop}`, fully unit-testable without
// GitHub.

import { createLogger } from "../../logger";
import type { Env } from "../../types";
import { applyEvent, type ApplyEventDeps } from "./apply-event";
import { buildLiveGuardResolver } from "./live-resolver";
import { liveFsmSinks } from "./live-side-effects";
import type { EventActor, EventMetadata, FsmEvent } from "./types";

// Module logger for the D-59 counterpart legacy-store maintenance (the FSM producer convention:
// backfill/genesis/live-side-effects each carry their own bound logger).
const verdictStoreLog = createLogger({ bindings: { component: "fsm-head-verdict-store" } });

/** The raw, handler-sourced inputs the pure classifier reads — exactly what the synchronize handler holds. */
export interface HeadChangeInput {
  /** The new PR head SHA (`pull_request.head.sha`) — rides the event for `advance_head`. */
  headSha: string;
  /** The session's prior stored head (`reviewListeningHeadSha`); null/"" on a first advance → the §18.6 slice. */
  prevHeadSha: string | null;
  /**
   * The content-noop determination the handler already computed (`isNoOpHeadTreeChange`): the new head has the
   * SAME tree SHA as the prior head (rebase / reword / no-op force-push). `false` when unknown (no settled
   * verdict to preserve → the handler skipped the tree compare); the default biases toward a re-QA, never
   * toward keeping a stale verdict (see file header).
   */
  isContentNoop: boolean;
}

/** The classified head-advance: which spine event fires, plus the head pair for the §18.6 observability slice. */
export interface HeadClassification {
  kind: "head.changed" | "head.noop_changed";
  headSha: string;
  prevHeadSha: string | null;
}

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface HeadEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every head-produced spine event is attributed to the `webhook` actor (the synchronize webhook that drove it). */
const HEAD_ACTOR: EventActor = "webhook";

/**
 * The pure classifier — the spec-named "real-vs-noop discrimination": a content-noop tree advance →
 * `head.noop_changed` (advance + restamp the still-valid verdict); anything else → `head.changed` (a real
 * code change: advance + `set_code_changed` + `clear_verification`, forcing a re-QA). Total over the input.
 */
export function classifyHeadChange(input: HeadChangeInput): HeadClassification {
  return {
    kind: input.isContentNoop ? "head.noop_changed" : "head.changed",
    headSha: input.headSha,
    prevHeadSha: input.prevHeadSha,
  };
}

/**
 * The pure builder: a `HeadClassification` → a head emission. `headSha` rides the event (the head edges read
 * it for `advance_head`); the full `{headSha, prevHeadSha}` pair rides the `EventMetadata` for the §18.6
 * observability slice (the head-pair group tag — design §18.6 "head shas").
 */
export function buildHeadChangeEmission(classification: HeadClassification): HeadEmission {
  return {
    event: { type: classification.kind, headSha: classification.headSha },
    metadata: { type: classification.kind, headSha: classification.headSha, prevHeadSha: classification.prevHeadSha },
    actor: HEAD_ACTOR,
  };
}

/**
 * DUAL-EMIT a classified head advance onto the spine as `head.changed`/`head.noop_changed`.
 * The whole body is try-caught OFF the legacy critical path (the synchronize handler's head
 * reconciliation), so a producer fault is isolated here and never perturbs the live review loop (the
 * producer dual-emit contract, mirroring PR 36/37/38/39). No-op when D1 is unbound (local/test).
 *
 * Returns whether the spine transition COMMITTED (`applyEvent` outcome `handled`). Callers that read a
 * post-commit spine row (the sweep's canonical label reproject) must gate on this — a swallowed fault or
 * non-committing outcome means the spine row still carries the OLD head, and reprojecting off it would
 * act on stale state (review P2 on #6525). Fire-and-forget callers may ignore it.
 */
export async function shadowEmitHeadChange(
  env: Env,
  sessionId: string,
  classification: HeadClassification,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return false;
  const emission = buildHeadChangeEmission(classification);
  // PR 47 emitter rewire: the shared live resolver supplies the REAL reads (a head advance has no
  // honest CI observation → the cascade waits at `ci_pending`; the VERIFYING `head.changed` re-run
  // reads the record's run handles).
  const resolver = buildLiveGuardResolver(env, sessionId);
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    // PR 47: effect execution defers through the caller's waitUntil off the webhook hot path.
    ...liveFsmSinks(env, { waitUntil }),
  };
  // D-59 counterpart (W11 verdict-stamp): at LIVE, the producer ALSO maintains the LEGACY session
  // verification store on this head advance — the side-effect the D-59 fold needs so the standalone
  // webhook writers (`clearVerificationVerdictForHeadChange` / `stampVerificationVerdictHeadForHeadChange`)
  // become provably redundant (see the helper doc).
  //
  // ORDER MATTERS — run it BEFORE applyEvent (ChatGPT P2, #6527). applyEvent queues the FSM spawn
  // side-effect on the caller's `waitUntil`, and a DECLINING spawn writes a FRESH CURRENT-head terminal
  // state (e.g. `checkVerificationConflict` → `verification-stopped`). Maintenance that ran AFTER — and
  // especially deferred onto the SAME `waitUntil` — could re-read that new-run state and clear it,
  // mistaking a current-head verifier state for a stale prior-head verdict. Sequencing the maintenance
  // before the spawn is even queued closes that race by construction: it observes, and acts on, only the
  // PRE-spawn snapshot — exactly the position the legacy inline webhook writer held (github.ts). The
  // helper is LIVE-gated + best-effort (self-swallows) internally, so this is a no-op at shadow/off and
  // its fault can never block or perturb the spine transition below.
  await syncLegacyVerificationStoreForHeadChange(env, sessionId, classification);

  try {
    const result = await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });
    return result.outcome === "handled";
  } catch (err) {
    log?.warn({ sessionId, error: String(err) }, "fsm head producer failed (ignored, shadow)");
    return false;
  }
}

/**
 * D-59 COUNTERPART — mirror the legacy head-change verdict-store maintenance from the FSM head producer
 * at LIVE so the standalone `clearVerificationVerdictForHeadChange` /
 * `stampVerificationVerdictHeadForHeadChange` calls (webhooks/github.ts) become provably redundant and
 * the D-59 residue fold (deferred at #6523, PR-47 LIVE NOTE) can delete them without stranding a stale
 * session-store verdict.
 *
 * WHY the SESSION store, not the spine: the head edge's `clear_verification` / `restamp_verification`
 * already maintains the SPINE verdict (`pr_coordination.verdict` / `verdict_head_sha`). But a DIFFERENT
 * store — the session's `verificationState` / `verificationResult` / `verificationVerdictHeadSha` — is
 * what the ARC-1243 scheduler skip-gate (`currentVerificationVerdictHeadSha` in verification-spawn.ts),
 * the legacy review-loop `review-loop:done` gate, and the needs-work re-ingestion all read. The spine
 * edge never touches it, so deleting the legacy writers today would leave a stale settled verdict that
 * mis-skips / wedges re-verification (the PR-47 LIVE NOTE). Rather than repoint ~30 legacy readers onto
 * the spine (the later display-surface cutover slice — a far larger blast radius), this keeps the store
 * correct by relocating the WRITE into the FSM producer, with the EXACT legacy semantics (same functions).
 *
 * FAITHFUL BY CONSTRUCTION: `head.changed` (real code change) → `clearVerificationVerdictForHeadChange`;
 * `head.noop_changed` (content-identical rebase/reword/no-op force-push) → the verdict-head restamp.
 * The same guard the legacy sites use is mirrored exactly: never wipe an ACTIVE run
 * (`verification-in-progress`), and skip when there is no settled verdict to maintain (the legacy
 * needless-write guard). `classification.kind` is the same real-vs-noop discriminator the legacy path
 * derived from `isNoOpHeadTreeChange`.
 *
 * PRE-SPAWN ORDERING: the caller (`shadowEmitHeadChange`) runs this SYNCHRONOUSLY BEFORE `applyEvent`, so
 * it observes only the pre-spawn snapshot and can never re-read (and clear) a fresh CURRENT-head state a
 * declining spawn side-effect writes on the same `waitUntil` (ChatGPT P2, #6527) — the position the legacy
 * inline webhook writer held. The `head.changed` branch additionally head-scopes the clear: a store already
 * stamped for the new head is left untouched.
 *
 * LIVE-ONLY: this writes the legacy store only at `live`; at shadow/off it is a no-op. BOTH CALLERS: the
 * synchronize webhook (webhooks/github.ts) AND the review-loop sweep (review-loop-sweep.ts) route their head
 * advance through `shadowEmitHeadChange`, so at live this helper is the SOLE session-store maintainer for
 * both. The D-59 residue fold DELETED both standalone writer copies — that fold is merge-gated on the live
 * flip, so post-flip `live` is the only prod mode and the store is never left unmaintained. (The full sweep
 * head-change branch — the legacy poll itself — is deleted separately by the legacy-poll-deletion unit; this
 * fold only removed the two verdict writers from it, leaving the classifier + in-memory reconcile intact.)
 * Best-effort: a fault self-heals on the new head's own verification; it runs before the spine transition
 * and self-swallows, so it can never block or perturb it. Dynamic imports break the producer↔verification-
 * module cycle (the established `spawnVerificationChildExecutor` pattern).
 *
 * SOLE MAINTAINER (post-fold): the standalone writers no longer run, so this helper's write is the live
 * behavior (not an idempotent backstop). Its pre-spawn ordering is what makes that safe — the isolation
 * tests (fsm/head-verdict-store-counterpart.test.ts) prove it clears/restamps correctly and BEFORE the
 * spawn side-effect can write a fresh current-head state.
 */
export async function syncLegacyVerificationStoreForHeadChange(
  env: Env,
  sessionId: string,
  classification: HeadClassification,
): Promise<void> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  try {
    const { getSessionState } = await import("../state");
    const session = await getSessionState(env, sessionId);
    if (!session) return;
    // Mirror the legacy guard EXACTLY: never wipe an active run's state (clearing in-progress would drop
    // the running verifier's state/labels), and skip when there is no settled verdict to maintain.
    if (session.verificationState === "verification-in-progress") return;
    if (session.verificationState == null && session.verificationResult == null) return;

    const { clearVerificationVerdictForHeadChange, stampVerificationVerdictHeadForHeadChange } =
      await import("../verification-state");
    if (classification.kind === "head.changed") {
      // Real content change: discard the now-stale PRIOR-head verdict (both result AND state) so it cannot
      // bind to the new head. HEAD-SCOPE the clear (ChatGPT P2, #6527): only a verdict stamped for a head
      // OTHER than the new head is stale. A store already stamped for THIS head
      // (`verificationVerdictHeadSha === classification.headSha`) is validated for the new head, not a
      // prior one — leave it untouched. Belt-and-braces with the pre-spawn ordering at the call site:
      // together they guarantee this never clears a current-head verifier state.
      if (session.verificationVerdictHeadSha === classification.headSha) return;
      // Needs the PR the session is review-listening on (the verdict store is per-PR); a review-listening
      // session with a settled verdict always carries it.
      const prUrl = session.reviewListeningPrUrl ?? null;
      if (!prUrl) return;
      await clearVerificationVerdictForHeadChange(env, { prUrl, sessionId, logger: verdictStoreLog });
    } else {
      // Content-noop advance: PRESERVE the verdict, restamp the head it is validated for so the ARC-1243
      // scheduler skip positively identifies the no-op and suppresses re-verification on the new SHA.
      await stampVerificationVerdictHeadForHeadChange(env, {
        sessionId,
        headSha: classification.headSha,
        currentState: session.verificationState ?? null,
        attemptCount: session.verificationAttemptCount,
        maxAttempts: session.verificationMaxAttempts,
        logger: verdictStoreLog,
      });
    }
  } catch (err) {
    // Best-effort: a maintenance fault self-heals on the new head's own verification and must never
    // perturb the committed spine transition (mirrors the legacy writers' best-effort contract).
    verdictStoreLog.warn(
      { sessionId, kind: classification.kind, error: String(err) },
      "fsm head producer: legacy verdict-store maintenance failed (ignored, best-effort)",
    );
  }
}
