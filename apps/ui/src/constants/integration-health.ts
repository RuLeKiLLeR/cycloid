/**
 * Plain-language copy for integration lifecycle reason codes (see
 * shared/enums/integration-lifecycle.ts). Rendered by the workspace
 * integrations status line; the raw code stays available in the `title`
 * attribute for debugging. Unknown codes fall back to a generic sentence so
 * new server codes degrade gracefully.
 */
export const INTEGRATION_REASON_CODE_COPY: Record<string, string> = {
  token_missing: "No credential is connected.",
  token_refresh_failed: "Cycloid could not refresh the saved credential.",
  token_revoked: "The saved credential was revoked.",
  repo_access_denied: "Cycloid does not have access to the repository.",
  repo_access_check_failed: "Cycloid could not verify repository access.",
  repo_url_invalid: "The repository URL is invalid.",
  repo_inference_unavailable: "Cycloid could not determine which repository to use.",
  repo_inference_unknown: "Cycloid could not determine which repository to use.",
  org_mismatch: "The connected account belongs to a different organization.",
  workspace_mismatch: "The connected account belongs to a different workspace.",
  workspace_not_installed: "The app is not installed in this workspace.",
  install_missing: "The GitHub app installation is missing.",
  provider_api_unavailable: "The provider's API is unavailable.",
  provider_rate_limited: "The provider is rate limiting requests.",
  provider_authn_rejected: "The provider rejected the saved credential.",
  sandbox_token_unprepared: "A session credential was not prepared in time.",
  runtime_attach_failed: "The integration could not attach to the session runtime.",
  tool_execution_failed: "A tool call failed in the last session.",
  tool_unavailable: "A required tool was unavailable in the last session.",
  webhook_signature_invalid: "A webhook arrived with an invalid signature.",
  webhook_timestamp_rejected: "A webhook arrived with a stale timestamp.",
  webhook_payload_malformed: "A webhook arrived with a malformed payload.",
  webhook_duplicate_delivery: "A webhook was delivered more than once.",
  oauth_state_mismatch: "The sign-in callback did not match the original request.",
  oauth_callback_user_mismatch: "The sign-in callback came back for a different user.",
  actor_resolution_failed: "Cycloid could not match the event to a user.",
  session_bootstrap_failed: "Cycloid could not start a session from the last event.",
  session_setup_failed: "Session setup failed.",
  session_claim_lost: "Another session claimed the event first.",
  stale_session_ref_displaced: "A stale session reference was replaced.",
  integration_disabled: "This integration is disabled for the workspace.",
  site_not_selected: "No site has been selected yet.",
};

/** Fallback sentence when a failure carries no mapped reason code. */
export const INTEGRATION_FAILURE_FALLBACK_COPY = "The last connection check failed.";
