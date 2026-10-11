// ARC-1330 lifecycle FSM — the `release_queued_reviews` → `review.item_ready` producer (§17-C).
//
// PURE FN: given the RELEASED ITEM SET (the source ids of the undispositioned actionable items held
// for a PR — `pr-review-item-disposition-db.ts#listUndispositionedActionable`, `disposition = 'none'`),
// mint one internal `review.item_ready{itemId}` spine `FsmEvent` per released item. No I/O.
//
// WHY (design §17-C, the queue-drain rule): `release_queued_reviews` is the side-effect every VERIFYING
// EXIT and every NEEDS_YOU / MERGE_READY re-open raises (transition.ts). While VERIFYING owns the head,
// actionable reviews are `queue_review`'d into the disposition store as undispositioned but NOT dispatched;
// the same holds for `inject_findings` (an `app_breaks` verdict's findings). On exit the head is free again,
// so each held item must re-run the REVIEW cascade and get an epoch. The spine dispatches that by feeding
// these `review.item_ready` events back into `applyEvent`; the existing `REVIEW — review.item_ready /
// dispatch_epoch` self-loop (PR 15) consumes them (eager dispatch when `no_inflight_epoch`, else accumulate —
// no double-dispatch). This guarantees released/injected items are never wedged behind a `caught_up` that
// would otherwise read them as undispositioned-but-undispatched.
//
// The events are deduped (a source id appears at most once per drain) and emitted in the released-set order
// (the DAO returns oldest-first), so a drain is deterministic and idempotent. An empty released set mints no
// events (nothing held → nothing to release; the exit/re-open proceeds with no spurious dispatch).
//
// This is the building block the Section E `applyEvent` spine (PR 34) consumes to realize the
// `release_queued_reviews` side-effect; it does no I/O and is unit-tested directly.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import type { FsmEvent } from "./types";

/**
 * Map the released item set (undispositioned actionable item source ids) to the internal
 * `review.item_ready{itemId}` events the spine re-feeds into `applyEvent`. Deduped, released-set order.
 * An empty/absent set mints no events.
 */
export function reviewItemReadyEvents(releasedItemIds: readonly string[]): FsmEvent[] {
  const seen = new Set<string>();
  const events: FsmEvent[] = [];
  for (const itemId of releasedItemIds) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    events.push({ type: "review.item_ready", itemId });
  }
  return events;
}
