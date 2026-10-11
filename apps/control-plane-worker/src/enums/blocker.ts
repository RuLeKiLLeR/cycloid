/**
 * Classes of session blocker that warrant a Slack DM to the owner. Each kind has
 * a fixed copy template (see `constants/blocked-dm.ts`); no free-form/raw error
 * text is ever interpolated into a DM. Keep these values stable: they are used
 * as KV/DO dedup-key segments and as observability tags.
 */
export enum BlockerKind {
  MergeConflict = "merge_conflict",
  BranchUpdateFailed = "branch_update_failed",
  CiRedExhausted = "ci_red_exhausted",
  CiPendingTimeout = "ci_pending_timeout",
  ReviewAttemptCap = "review_attempt_cap",
  ReviewResponseFailed = "review_response_failed",
  GithubAppPermission = "github_app_permission",
  GithubAuthLost = "github_auth_lost",
  VerificationExhausted = "verification_exhausted",
  MissingProviderKey = "missing_provider_key",
  RepoAccessDenied = "repo_access_denied",
  AwaitingQuestion = "awaiting_question",
  VerificationIssue = "verification_issue",
  PlanReady = "plan_ready",
  OwnerApproval = "owner_approval",
  SessionFailed = "session_failed",
}
