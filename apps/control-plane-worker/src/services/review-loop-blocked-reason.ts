// Internal review-loop block reason codes (stored verbatim in pr_review_response_epochs.blocked_reason)
// must never leak into the customer-facing PR status comment. Map each code that can land on a
// `blocked` epoch to friendly, non-leaky copy. Any unmapped code falls back to a safe generic line.
//
// Codes are produced by:
//   - review-loop-sweep.ts blockClaimedEpoch(): attempt_cap_reached, no_new_evidence_reprompt_cap,
//     session_not_review_listening,
//     session_mismatch, verification_session, head_changed, missing_installation,
//     prompt_enqueue_failed, sweep_failed, review_listening_enter_timeout,
//     and classifyGithubPollFailure() outputs github_auth_lost, repo_gone, github_validation_failed,
//     github_poll_failed; dispatch transient D1 caps transient_d1_error; CI caps
//     ci_checks_pending_cap_reached, ci_attempt_cap_reached.
//   - review-loop-settings.ts eligibility/checklist: installation_capabilities_missing,
//     expected_bots_changed, empty_expected_bots, review_handling_disabled (manual review mode, ARC-1514).
//   - legacy (ARC-1288, no longer produced; mapped defensively for old blocked rows): auto_response_disabled,
//     ci_response_disabled.
//   - session/publish-service.ts: publish_failed, reply_failed.
//   - review-loop-epochs.ts no-diff terminal resolver: no_progress_unresolved.
//   - review-loop-sweep.ts reconcile mergeability handling: rebase_needed, branch_update_failed.
// (head_changed is filtered out as stale before render, but is mapped here defensively.)
const FRIENDLY_BLOCKED_REASONS: Record<string, string> = {
  attempt_cap_reached: "Paused after repeated attempts to respond. This PR needs a human to take a look.",
  no_progress_unresolved:
    "Paused after repeated attempts that did not address the review work. This PR needs a human to take a look.",
  no_new_evidence_reprompt_cap:
    "Paused after re-prompting the same review feedback with no new changes to work from. This PR needs a human to take a look.",
  publish_failed: "Paused after repeated attempts to push changes. This PR needs a human to take a look.",
  reply_failed: "Paused after repeated attempts to reply. This PR needs a human to take a look.",
  prompt_enqueue_failed: "Paused — couldn't start responding. I'll retry, but this PR may need a human.",
  prompt_send_not_ready: "Paused after repeated attempts to wake this session up. This PR may need a human.",
  sweep_failed: "Paused while reconciling review state. I'll retry, but this PR may need a human.",
  transient_d1_error: "Paused after repeated storage errors. I'll retry, but this PR may need a human.",
  github_poll_failed: "Paused — couldn't reach GitHub to check for new reviews. I'll retry shortly.",
  github_auth_lost: "Paused — Cycloid's GitHub access for this repo isn't available right now.",
  missing_installation: "Paused — Cycloid's GitHub access for this repo isn't available right now.",
  installation_capabilities_missing: "Paused — Cycloid's GitHub App is missing a permission it needs to respond here.",
  repo_gone: "Paused — this repository is no longer reachable.",
  github_validation_failed: "Paused — GitHub rejected the request. This PR may need a human to take a look.",
  // Legacy (ARC-1288): no longer produced; retained for historical blocked rows.
  auto_response_disabled: "Paused — automated review responses are turned off for this repository.",
  ci_response_disabled: "Paused — automated CI-failure responses are turned off for this repository.",
  // Manual review mode (ARC-1514): automatic review handling is off for this user; CI-fix still runs.
  review_handling_disabled:
    "Automatic review handling is off — Cycloid is working CI to green only. Mention @cycloid on a comment to pull it into a review.",
  expected_bots_changed: "Paused — the configured reviewers changed. I'll pick up the new set on the next review.",
  empty_expected_bots: "Paused — no review bots are configured for this repository.",
  session_not_review_listening: "Paused — this session is no longer watching this PR.",
  review_listening_enter_timeout:
    "Paused — this session did not finish entering review mode. This PR needs a human to take a look.",
  session_mismatch: "Paused — this session is no longer watching this PR.",
  verification_session: "Paused — the implementation session for this PR handles review responses.",
  head_changed: "Paused — a new commit arrived; I'll start a fresh round on the latest commit.",
  ci_attempt_cap_reached: "Paused after repeated attempts to fix CI. This PR needs a human to take a look.",
  ci_checks_pending_cap_reached: "Paused — CI checks stayed pending too long. This PR needs human attention.",
  rebase_needed: "Paused — this branch has merge conflicts with its base. Please rebase or resolve them.",
  branch_update_failed: "Paused — couldn't bring this branch up to date with its base. Please update it manually.",
};

const GENERIC_BLOCKED_MESSAGE = "Paused responding to reviews on this PR. This PR may need a human to take a look.";

/**
 * Map an internal block reason code to customer-facing copy. Never echoes the raw code: an unknown
 * or absent code yields a safe generic message.
 */
export function describeReviewLoopBlockedReason(blockedReason: string | null | undefined): string {
  if (typeof blockedReason !== "string" || blockedReason.length === 0) return GENERIC_BLOCKED_MESSAGE;
  return FRIENDLY_BLOCKED_REASONS[blockedReason] ?? GENERIC_BLOCKED_MESSAGE;
}
