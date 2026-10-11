import type { SessionMetadata } from "../types";

// A parent session together with the contiguous run of its descendants that
// live in the same recency bucket. `orderSessionsForSidebar` lays subtrees out
// depth-first and contiguous, and `groupSessionsByRecency` preserves that order
// within a bucket, so a family's descendants are always the run immediately
// after the head — until a descendant is bucketed into a different date group,
// in which case it simply isn't part of the run.
export type SidebarFamily = { kind: "family"; head: SessionMetadata; descendants: SessionMetadata[] };
type SidebarRow = { kind: "row"; session: SessionMetadata };
type SidebarItem = SidebarRow | SidebarFamily;

/**
 * Segment an ordered, single-bucket session list into standalone rows and
 * parent-with-descendants families. Pure and order-preserving: pass one recency
 * group's `sessions` at a time.
 *
 * A session becomes a family `head` when the sessions immediately after it are
 * its descendants (child, grandchild, …). Descendants are collected greedily by
 * growing a subtree id set, so grandchildren nested under a present child are
 * pulled in even though their direct parent isn't the head. A child whose parent
 * sits in a different recency bucket has no matching head here, so it starts its
 * own segment — becoming a family head if it has descendants of its own, or a
 * plain row otherwise (it still renders indented via `parentSessionId`).
 */
export function segmentSidebarFamilies(ordered: SessionMetadata[]): SidebarItem[] {
  const items: SidebarItem[] = [];
  let i = 0;
  while (i < ordered.length) {
    const head = ordered[i];
    const subtreeIds = new Set<string>([head.sessionId]);
    const descendants: SessionMetadata[] = [];
    let j = i + 1;
    while (j < ordered.length) {
      const next = ordered[j];
      const parentId = next.parentSessionId;
      // Only extend the run while the next session descends from something we've
      // already claimed for this family. Self-parented rows (parentId === own id)
      // never match because the id isn't added until after this check.
      if (!parentId || parentId === next.sessionId || !subtreeIds.has(parentId)) break;
      descendants.push(next);
      subtreeIds.add(next.sessionId);
      j++;
    }
    items.push(descendants.length > 0 ? { kind: "family", head, descendants } : { kind: "row", session: head });
    i = j;
  }
  return items;
}

/**
 * The single-token status roll-up shown on a collapsed summary line. Names only
 * the state that tells you whether to look; the status dots carry the rest.
 * Callers only render a summary line for families with no `waiting_for_input`
 * descendant, so that case is intentionally absent.
 */
export function subagentRollup(descendants: SessionMetadata[]): string {
  const statuses = descendants.map((d) => d.displayStatus);
  const working = statuses.filter((s) => s === "working").length;
  if (working > 0) return `${working} working`;
  if (statuses.length > 0 && statuses.every((s) => s === "completed")) return "all done";
  return "";
}

/** True when a descendant needs the user specifically — such a family is never collapsed. */
export function familyNeedsInput(descendants: SessionMetadata[]): boolean {
  return descendants.some((d) => d.displayStatus === "waiting_for_input");
}

/** True when a descendant is actively working — keeps a non-overridden family expanded by default. */
export function familyHasWorking(descendants: SessionMetadata[]): boolean {
  return descendants.some((d) => d.displayStatus === "working");
}
