// Substring present in every "review-loop access outside worktree" policy block.
// Single source of truth shared by the bridge, which builds the message
// (apps/sandbox-bridge/src/utils/protection.ts), and the transcript UI, which
// suppresses these blocks. Mirrors the malformed-search sentinel next door.
export const REVIEW_LOOP_WORKTREE_BLOCK_PHRASE = "review-loop access outside worktree";

/**
 * True when a `session_error` is the review-loop worktree-boundary block: an
 * in-sandbox guardrail that refuses tool-call paths outside the review-loop
 * worktree (e.g. scratch/log writes to /tmp). It fires constantly on benign
 * behavior, so the transcript hides it. Enforcement is entirely server-side in
 * the bridge; this only gates display, never the allow/deny decision.
 *
 * Deliberately narrow: `policy_block` is shared by three other, user-actionable
 * situations (generic protected-path, plan-mode read-only, review-loop
 * source-kind), which must keep rendering — hence the phrase check, not a bare
 * code match.
 */
export function isReviewLoopWorktreeBlockError(code: string | undefined, message: string | undefined): boolean {
  return code === "policy_block" && typeof message === "string" && message.includes(REVIEW_LOOP_WORKTREE_BLOCK_PHRASE);
}
