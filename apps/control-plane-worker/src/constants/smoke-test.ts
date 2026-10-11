// The repo Cycloid runs prod smoke tests against. Sessions here are synthetic
// operator traffic, so they are intentionally excluded from customer-session
// tracking alerts to keep that channel free of smoke-test noise.
export const SMOKE_TEST_REPO_OWNER = "jeman-verification";
export const SMOKE_TEST_REPO_NAME = "verification-prod";

/** True when the session targets the prod smoke-test repo (case-insensitive). */
export function isSmokeTestRepo(repoOwner: string | null | undefined, repoName: string | null | undefined): boolean {
  return repoOwner?.toLowerCase() === SMOKE_TEST_REPO_OWNER && repoName?.toLowerCase() === SMOKE_TEST_REPO_NAME;
}
