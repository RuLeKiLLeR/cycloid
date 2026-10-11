import { describe, expect, it } from "vitest";

import { BlockerKind } from "../../apps/control-plane-worker/src/enums/blocker.js";
import { EPOCH_BLOCK_DM_KIND } from "../../apps/control-plane-worker/src/services/review-loop-sweep.js";

// processEpoch's blockClaimedEpoch fires an owner DM exactly for the reasons in
// this map (proven end-to-end for attempt_cap_reached in review-loop-sweep.test).
// These assertions pin which comment-less block reasons notify and with what kind.
describe("EPOCH_BLOCK_DM_KIND", () => {
  it("maps the review-attempt cap to review_attempt_cap", () => {
    expect(EPOCH_BLOCK_DM_KIND.attempt_cap_reached).toBe(BlockerKind.ReviewAttemptCap);
  });

  it("maps missing/insufficient GitHub App installation to github_app_permission", () => {
    expect(EPOCH_BLOCK_DM_KIND.missing_installation).toBe(BlockerKind.GithubAppPermission);
    expect(EPOCH_BLOCK_DM_KIND.installation_capabilities_missing).toBe(BlockerKind.GithubAppPermission);
  });

  it("maps lost GitHub authorization to github_auth_lost", () => {
    expect(EPOCH_BLOCK_DM_KIND.github_auth_lost).toBe(BlockerKind.GithubAuthLost);
  });

  it("does not DM for self-recovering / non-actionable block reasons", () => {
    expect(EPOCH_BLOCK_DM_KIND.head_changed).toBeUndefined();
    expect(EPOCH_BLOCK_DM_KIND.session_mismatch).toBeUndefined();
    expect(EPOCH_BLOCK_DM_KIND.verification_session).toBeUndefined();
  });
});
