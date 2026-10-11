// The single repo-access leak boundary for the per-business sidebar feed
// (ARC-1322). `SessionFeedDO`'s publish loop calls this pure function for every
// connected socket and sends the delta only when it returns `deliver: true`.
// Keeping the decision isolated and side-effect-free makes the security core
// unit-testable with zero Durable Object / WebSocket scaffolding and gives the
// fan-out exactly one place to audit.
//
// The rule mirrors the session-list filter (`routes/sessions.ts`):
//   - The session owner always receives their own deltas.
//   - Any other business member receives a delta only when the session's
//     `owner/name` (lowercased, trimmed) is in their accessible-repo set.
//   - A delta with no repo context is owner-only (fail closed).

export type FeedDeliveryReason = "owner" | "repo-allowed" | "repo-denied" | "no-repo-context";

export interface FeedDeliveryDecision {
  deliver: boolean;
  reason: FeedDeliveryReason;
}

/** The gate keys read off a `FeedDelta` (a structural subset, so the gate has no protocol dependency). */
export interface FeedDeliveryTarget {
  ownerUserId: string;
  repoOwner: string | null;
  repoName: string | null;
}

/**
 * Decide whether the socket owned by `uid` should receive `delta`, given that
 * user's accessible-repo set (lowercased `owner/name` keys, as produced by
 * `getSharedBusinessRepoAccessSnapshot`).
 */
export function decideFeedDelivery(
  uid: string,
  delta: FeedDeliveryTarget,
  repoSet: ReadonlySet<string>,
): FeedDeliveryDecision {
  if (uid === delta.ownerUserId) {
    return { deliver: true, reason: "owner" };
  }
  if (!delta.repoOwner || !delta.repoName) {
    // Missing repo context: a non-owner cannot prove access, so fail closed
    // (mirrors the list filter hiding rows without repo context).
    return { deliver: false, reason: "no-repo-context" };
  }
  const key = `${delta.repoOwner}/${delta.repoName}`.trim().toLowerCase();
  if (repoSet.has(key)) {
    return { deliver: true, reason: "repo-allowed" };
  }
  return { deliver: false, reason: "repo-denied" };
}
