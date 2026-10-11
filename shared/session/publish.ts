// Publish-status interpretation helpers. Centralizing these predicates means any
// future publish state additions only need to update one place.

import type { PublishStatus } from "../types/publish.js";

/**
 * `true` when the session reached a terminal failure on publish. Used by the UI
 * reducer to know when to stop expecting a PR URL to appear.
 */
export function isPublishTerminalFailure(publishStatus: PublishStatus | null | undefined): boolean {
  // The `blocked_by_verification` comparison is stored-rows compat (see `computePhase`):
  // the writer and union arm are deleted (ARC-1330 D-57) but pre-existing rows persist
  // the literal, and those sessions never got a PR — still a terminal publish outcome.
  return publishStatus === "failed" || (publishStatus as string | null | undefined) === "blocked_by_verification";
}
