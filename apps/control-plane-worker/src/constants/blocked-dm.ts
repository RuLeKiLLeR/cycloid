import { BlockerKind } from "../enums/blocker";

/**
 * Re-notify cadence for a given (session, kind, dedupKey). A blocker that
 * persists past this window can DM again; within it, repeat fires dedupe. Mirror
 * of `sendSlackLinkDm`'s record-after-success TTL approach (`link-service.ts`).
 */
export const BLOCKED_DM_DEDUP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Fixed per-kind DM copy. `headline` names the blocker; `nextStep` tells the
 * owner the out-of-band action only they can take. NEVER interpolate raw error
 * text, paths, or tokens here - those stay in the session UI and logs.
 */
export const BLOCKED_DM_COPY: Record<BlockerKind, { headline: string; nextStep: string }> = {
  [BlockerKind.MergeConflict]: {
    headline: "Your Cycloid session is blocked on a merge conflict.",
    nextStep: "The branch can't be updated automatically. Resolve the conflict, then re-run the session.",
  },
  [BlockerKind.BranchUpdateFailed]: {
    headline: "Your Cycloid session couldn't update its branch.",
    nextStep: "Updating the PR branch from the base failed. Check the branch state, then re-run the session.",
  },
  [BlockerKind.CiRedExhausted]: {
    headline: "Your Cycloid session stopped after CI stayed red.",
    nextStep:
      "The agent retried the fix the maximum number of times and CI is still failing. Review CI and re-run when ready.",
  },
  [BlockerKind.CiPendingTimeout]: {
    headline: "Your Cycloid session stopped waiting on CI.",
    nextStep: "CI didn't finish in time. Check your CI provider, then re-run the session once checks complete.",
  },
  [BlockerKind.ReviewAttemptCap]: {
    headline: "Your Cycloid session hit its review-iteration limit.",
    nextStep:
      "The agent reached the maximum number of review passes. Take a look and re-run the session if more work is needed.",
  },
  [BlockerKind.ReviewResponseFailed]: {
    headline: "Your Cycloid session couldn't post its review response.",
    nextStep:
      "Posting the fix or reply to your PR failed after repeated tries. Review the PR, then re-run the session.",
  },
  [BlockerKind.GithubAppPermission]: {
    headline: "Your Cycloid session is blocked on GitHub App permissions.",
    nextStep:
      "The Cycloid GitHub App is missing access it needs on this repo. Update the installation, then re-run the session.",
  },
  [BlockerKind.GithubAuthLost]: {
    headline: "Your Cycloid session lost GitHub access.",
    nextStep: "GitHub authorization for this repo is no longer valid. Reconnect GitHub, then re-run the session.",
  },
  [BlockerKind.VerificationExhausted]: {
    headline: "Your Cycloid session stopped after verification kept failing.",
    nextStep: "The agent exhausted its verification retries. Review the run, then re-run the session if needed.",
  },
  [BlockerKind.MissingProviderKey]: {
    headline: "Your Cycloid session couldn't start: a required API key is missing.",
    nextStep: "Add the missing provider API key in Cycloid settings, then start the session again.",
  },
  [BlockerKind.RepoAccessDenied]: {
    headline: "Your Cycloid session couldn't access its repository.",
    nextStep:
      "Cycloid can't reach this repo with your current GitHub connection. Reconnect or grant access, then re-run the session.",
  },
  [BlockerKind.AwaitingQuestion]: {
    headline: "Your Cycloid session is waiting on your answer.",
    nextStep: "The agent asked a question and can't continue until you reply. Open the session to respond.",
  },
  [BlockerKind.VerificationIssue]: {
    headline: "Cycloid ran into a verification issue on your PR.",
    nextStep:
      "Verification couldn't finish cleanly (it timed out, was interrupted, or hit its run limit). Your session is still open — review the run when you get a chance.",
  },
  [BlockerKind.PlanReady]: {
    headline: "Your Cycloid plan is ready for review.",
    nextStep: "Open the web session to accept, edit, or discuss the plan.",
  },
  [BlockerKind.OwnerApproval]: {
    headline: "Your Cycloid session is waiting for your merge approval.",
    nextStep: "Review the pending changes and approve the merge when you're ready.",
  },
  [BlockerKind.SessionFailed]: {
    headline: "Your Cycloid session needs your attention after a failure.",
    nextStep: "Review the session and retry it when you're ready.",
  },
};
