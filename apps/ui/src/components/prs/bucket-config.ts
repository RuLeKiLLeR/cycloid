import type { PrInboxBucket, PrInboxCycloidDone, PrInboxItem } from "../../api/pr-inbox";
import type { ArtifactKind } from "../ui";

/**
 * Triage order for the PR inbox. Actionable buckets first, terminal states
 * (open/closed) last. These buckets are FSM-derived, not live GitHub state.
 */
export const PR_BUCKET_ORDER: readonly PrInboxBucket[] = [
  "needs_review",
  "changes_requested",
  "checks_failing",
  "approved",
  "draft",
  "open",
  "closed",
];

/** Sentence-case labels. `checks_failing` is the FSM's CI-block state, not a live CI read. */
export const PR_BUCKET_LABELS: Record<PrInboxBucket, string> = {
  needs_review: "Needs review",
  changes_requested: "Changes requested",
  checks_failing: "Checks failing",
  approved: "Approved",
  draft: "Draft",
  open: "Open",
  closed: "Closed",
};

export type PrBucketGroup = {
  bucket: PrInboxBucket;
  label: string;
  items: PrInboxItem[];
};

/**
 * Group inbox items by bucket in triage order, preserving the incoming
 * (updatedAt-desc) item order within each group and dropping empty buckets.
 */
export function groupByBucket(items: PrInboxItem[]): PrBucketGroup[] {
  const byBucket = new Map<PrInboxBucket, PrInboxItem[]>();
  for (const item of items) {
    const list = byBucket.get(item.bucket);
    if (list) list.push(item);
    else byBucket.set(item.bucket, [item]);
  }
  return PR_BUCKET_ORDER.filter((bucket) => (byBucket.get(bucket)?.length ?? 0) > 0).map((bucket) => ({
    bucket,
    label: PR_BUCKET_LABELS[bucket],
    items: byBucket.get(bucket) ?? [],
  }));
}

export type CycloidDoneChipMeta = { kind: ArtifactKind; label: string };

/**
 * Map the FSM `cycloidDone` projection to an artifact chip. `working` is a
 * neutral in-progress marker; a finished session is `Done` unless it flagged
 * `needs_attention`.
 */
export function cycloidDoneChip(done: PrInboxCycloidDone): CycloidDoneChipMeta {
  if (done.state === "working") return { kind: "text", label: "Working" };
  if (done.outcome === "needs_attention") return { kind: "needs-input", label: "Needs attention" };
  return { kind: "verified", label: "Done" };
}
