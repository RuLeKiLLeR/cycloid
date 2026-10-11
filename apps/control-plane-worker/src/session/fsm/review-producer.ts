// ARC-1330 lifecycle FSM (PR 39) — REVIEW-WEBHOOK producer: GitHub review signals → `review.received`.
//
// The three review webhook handlers (`webhooks/github.ts` `handlePullRequestReviewEvent` /
// `handleIssueCommentEvent` / `handlePullRequestReviewCommentEvent`) all funnel a real reviewer signal
// for a PR through the SAME ingest seam — `runReviewLoopWebhookIngest` (`services/review-loop-epochs.ts`),
// reached via `ingestReviewLoopPullRequestReviewWebhook` (bot + human reviews),
// `ingestReviewLoopPullRequestReviewCommentWebhook` (inline review comments), and
// `ingestReviewLoopPrIssueCommentWebhook` (PR issue comments). That ingest is the ONE place a review is
// matched to a live review-listening session (the resolved `session_id` rides the `handled` epoch) and is
// confirmed a genuine reviewer signal (not stale-head / not an unconfigured actor / not a self-trigger).
// So this producer dual-emits `review.received{bot|human, actionable}` from exactly the `handled` ingest
// outcome (the cheat-sheet's "ingest fns in services/review-loop-epochs.ts" + "name the symbol, not the
// line"): emitting raw in each handler would fire before session resolution and re-classify each webhook
// against GitHub, the cost the shadow phase must not add.
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught
// OFF the legacy critical path (the ingest's epoch upsert), so a producer fault never perturbs the live
// review loop. Observe-only — the divergence metric (PR 45)
// measures where the shadow row tracks legacy.
//
// SOUNDNESS over completeness (the shadow rule): `review.received` carries `{reviewerKind, actionable}` on
// the event and the full `{reviewerKind, reviewerId, reviewSourceId, actionable}` §18.6 slice on the
// metadata (design §13). `actionable` is the load-bearing classification (the REVIEW self-loop registers +
// dispatches an epoch ONLY for an actionable review; an approval / empty comment is `log_noop` noise that
// re-opens nothing — transition.ts REVIEW/MERGE_READY/NEEDS_YOU `review.received`). The classification is a
// PURE function of the webhook shape (review submission state / comment body) + the actor's GitHub `type`,
// so it is fully unit-testable without GitHub.

import type { Env } from "../../types";
import { applyEvent, type ApplyEventDeps } from "./apply-event";
import { buildLiveGuardResolver } from "./live-resolver";
import { liveFsmSinks } from "./live-side-effects";
import type { EventActor, EventMetadata, FsmEvent, ReviewerKind } from "./types";

/** The webhook shape a review signal arrived on — selects the `actionable` rule (review state vs body). */
export type ReviewWebhookKind = "review_submission" | "review_comment" | "issue_comment";

/** The raw, GitHub-sourced inputs the pure classifier reads — exactly what the three ingest fns hold. */
export interface ReviewClassificationInput {
  webhookKind: ReviewWebhookKind;
  /** The reviewer's GitHub user `type` ("User" = human; "Bot"/"Organization"/… = bot) — the §2540 handler rule. */
  actorType: string;
  /** The reviewer's GitHub app-slug/login (Greptile/Strix/Copilot/human) → the §18.6 `reviewer_id` slice. */
  actorLogin: string | null;
  /** The disposition-store source id the ingest minted (`review-body:<id>` / `review-comment:<id>` / `issue-comment:<id>`). */
  sourceId: string;
  /** Review-submission only: the review state ("approved" | "changes_requested" | "commented" | "dismissed"). */
  reviewState?: string | null;
  /** The review/comment body — the `actionable` signal for the comment shapes (and a `commented` review). */
  body?: string | null;
}

/** The classified `review.received` payload: event fields + the full §18.6 observability slice. */
export interface ReviewClassification {
  reviewerKind: ReviewerKind;
  reviewerId: string;
  reviewSourceId: string;
  actionable: boolean;
}

/** One spine emission: the `FsmEvent` to apply, its observability `EventMetadata`, and the actor tag. */
export interface ReviewEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every review-produced spine event is attributed to the `webhook` actor (the review webhook that drove it). */
const REVIEW_ACTOR: EventActor = "webhook";

/** A body carries reviewer feedback only when it is present and non-blank. */
function hasMeaningfulBody(body: string | null | undefined): boolean {
  return typeof body === "string" && body.trim().length > 0;
}

/**
 * The reviewer-kind rule, identical to the live handler's `isBot = reviewUserType !== "User"` (github.ts):
 * GitHub stamps a human author `type: "User"` and every app/bot a non-`User` type. Defaults a missing/blank
 * type to `bot` (an unattributed automated signal is the safer shadow assumption — it never gates a human).
 */
export function classifyReviewerKind(actorType: string): ReviewerKind {
  return actorType === "User" ? "human" : "bot";
}

/**
 * Is this review signal ACTIONABLE — i.e. does it carry work the FSM must register + dispatch an epoch for
 * (vs. noise that re-opens nothing)? Pure over the webhook shape:
 *   - `review_submission`: `approved` → NOT actionable (an approval is a merge-positive signal, no work, and
 *     in MERGE_READY/NEEDS_YOU it must not re-open the PR); `changes_requested` → actionable; `commented` /
 *     `dismissed` / unknown → actionable IFF it carries a non-blank body (an empty "commented" review is the
 *     bot/GitHub wrapper noise the live loop already drops).
 *   - `review_comment` (inline) / `issue_comment`: actionable IFF a non-blank body (a line/PR comment with
 *     content is feedback; an empty one is noise).
 * This mirrors the live loop's "an approval / empty review re-opens nothing" classification; the divergence
 * metric (PR 45) surfaces any drift against legacy for retuning in shadow.
 */
export function classifyReviewActionable(input: ReviewClassificationInput): boolean {
  if (input.webhookKind === "review_submission") {
    const state = (input.reviewState ?? "").trim().toLowerCase();
    if (state === "approved") return false;
    if (state === "changes_requested") return true;
    return hasMeaningfulBody(input.body);
  }
  // review_comment | issue_comment: content presence is the actionable signal.
  return hasMeaningfulBody(input.body);
}

/** The pure classifier: a raw review webhook → the `review.received` payload (event + §18.6 slice). */
export function classifyReviewReceived(input: ReviewClassificationInput): ReviewClassification {
  return {
    reviewerKind: classifyReviewerKind(input.actorType),
    reviewerId: input.actorLogin ?? "unknown",
    reviewSourceId: input.sourceId,
    actionable: classifyReviewActionable(input),
  };
}

/**
 * The pure builder: a `ReviewClassification` → a `review.received` emission. `reviewerKind`/`actionable`
 * ride the event (the REVIEW cascade reads `actionable`); the full slice (`reviewerId`/`reviewSourceId`
 * too) rides the `EventMetadata` for the §18.6 observability emit (the `reviewer_id` group tag).
 */
export function buildReviewReceivedEmission(classification: ReviewClassification): ReviewEmission {
  return {
    event: {
      type: "review.received",
      reviewerKind: classification.reviewerKind,
      actionable: classification.actionable,
    },
    metadata: {
      type: "review.received",
      reviewerKind: classification.reviewerKind,
      reviewerId: classification.reviewerId,
      reviewSourceId: classification.reviewSourceId,
      actionable: classification.actionable,
    },
    actor: REVIEW_ACTOR,
  };
}

/**
 * DUAL-EMIT a classified review signal onto the shadow spine as `review.received{bot|human, actionable}`.
 * SHADOW/observe-only — the whole body is try-caught OFF the legacy critical path (the ingest's epoch
 * upsert), so a producer fault is isolated here and never perturbs the live review loop (the producer
 * dual-emit contract, mirroring PR 36/37/38). No-op when D1 is unbound (local/test).
 */
export async function shadowEmitReviewReceived(
  env: Env,
  sessionId: string,
  classification: ReviewClassification,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  opts?: {
    /** Hot-path seam: live side-effect execution defers through it (the webhook handler's ctx). */
    waitUntil?: (promise: Promise<unknown>) => void;
    /**
     * The LEGACY-created epoch id the ingest holds (`result.epoch.id`). Under live the dispatching
     * edges stamp THIS id into `in_flight_epoch_id` (legacy creates, the FSM records, the live
     * sink's exists-check anchors on the real id — closing the PR 46 dispatch_epoch deferral).
     */
    legacyEpochId?: string;
  },
): Promise<void> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  const emission = buildReviewReceivedEmission(classification);
  // PR 47 emitter rewire: the shared live resolver supplies the REAL reads (the review source id + the
  // legacy epoch id thread through the ctx).
  const resolver = buildLiveGuardResolver(env, sessionId, {
    reviewSourceId: classification.reviewSourceId,
    legacyEpochId: opts?.legacyEpochId,
  });
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    // PR 47: effect execution defers through the caller's waitUntil off the webhook hot path.
    ...liveFsmSinks(env, { waitUntil: opts?.waitUntil }),
  };
  try {
    await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });
  } catch (err) {
    log?.warn({ sessionId, error: String(err) }, "fsm review producer failed (ignored)");
  }
}

/**
 * ARC-1445: drive one internal `review.item_ready{itemId}` through `applyEvent` to RE-DISPATCH review items
 * stranded undispositioned with no in-flight epoch. The self-heal sweep reconcile calls this for the oldest
 * undispositioned item of a wedged REVIEW row; the live `REVIEW — review.item_ready / dispatch_epoch` edge
 * stamps a FRESH `in_flight_epoch_id` + `dispatch_epoch(review)` (no `legacyEpochId` → synthetic id, so the
 * executor CREATES rather than re-observing a terminal row), and the executor traces ALL undispositioned
 * items (`listUndispositionedActionable`) into that one epoch — so a single `item_ready` drains the whole
 * set. `release_queued_reviews` (which WOULD emit this event on VERIFYING/NEEDS_YOU exits) is inert at live,
 * so the reconcile feeds the EVENT directly. Best-effort — try-caught off the sweep's critical path.
 * Returns TRUE when `applyEvent` committed the drive, FALSE when the DB was unbound or the drive threw — so
 * the caller's telemetry counts confirmed drives, not swallowed attempts.
 */
export async function shadowEmitReviewItemReady(
  env: Env,
  sessionId: string,
  itemId: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return false;
  // No `legacyEpochId` → `newEpochId` is the fresh synthetic `epoch-<sid>-<version>` (the settled-arm rule):
  // the dispatch executor must CREATE, never re-observe a terminal row.
  const resolver = buildLiveGuardResolver(env, sessionId, {});
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    ...liveFsmSinks(env, { waitUntil }),
  };
  try {
    await applyEvent(deps, {
      sessionId,
      event: { type: "review.item_ready", itemId },
      metadata: { type: "review.item_ready" },
      actor: "internal",
    });
    return true;
  } catch (err) {
    log?.warn({ sessionId, itemId, error: String(err) }, "fsm review.item_ready producer failed (ignored)");
    return false;
  }
}
