export const INTEGRATION_LIFECYCLE_STAGE = {
  CONTROL_PLANE_CONFIGURED: "control_plane_configured",
  CREDENTIAL_RESOLVED: "credential_resolved",
  PROVIDER_PROBE_PASSED: "provider_probe_passed",
  SANDBOX_TOKEN_PREPARED: "sandbox_token_prepared",
  RUNTIME_ATTACHED: "runtime_attached",
  FIRST_TOOL_CALL_PASSED: "first_tool_call_passed",
  WEBHOOK_RECEIVED: "webhook_received",
  WEBHOOK_VERIFIED: "webhook_verified",
  WEBHOOK_CONTEXT_RESOLVED: "webhook_context_resolved",
  WEBHOOK_FOLLOWUP_ENQUEUED: "webhook_followup_enqueued",
  SESSION_BOOTSTRAP_SKIPPED: "session_bootstrap_skipped",
  OAUTH_CALLBACK_RECEIVED: "oauth_callback_received",
  OAUTH_TOKEN_EXCHANGED: "oauth_token_exchanged",
  WORKSPACE_BOUND: "workspace_bound",
} as const;

export type IntegrationLifecycleStage = (typeof INTEGRATION_LIFECYCLE_STAGE)[keyof typeof INTEGRATION_LIFECYCLE_STAGE];

export const INTEGRATION_LIFECYCLE_STATUS = {
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export type IntegrationLifecycleStatus =
  (typeof INTEGRATION_LIFECYCLE_STATUS)[keyof typeof INTEGRATION_LIFECYCLE_STATUS];

export const INTEGRATION_LIFECYCLE_REASON_CODE = {
  TOKEN_MISSING: "token_missing",
  TOKEN_REFRESH_FAILED: "token_refresh_failed",
  TOKEN_REVOKED: "token_revoked",
  REPO_ACCESS_DENIED: "repo_access_denied",
  REPO_ACCESS_CHECK_FAILED: "repo_access_check_failed",
  REPO_URL_INVALID: "repo_url_invalid",
  REPO_INFERENCE_UNAVAILABLE: "repo_inference_unavailable",
  REPO_INFERENCE_UNKNOWN: "repo_inference_unknown",
  ORG_MISMATCH: "org_mismatch",
  WORKSPACE_MISMATCH: "workspace_mismatch",
  WORKSPACE_NOT_INSTALLED: "workspace_not_installed",
  INSTALL_MISSING: "install_missing",
  PROVIDER_API_UNAVAILABLE: "provider_api_unavailable",
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  PROVIDER_AUTHN_REJECTED: "provider_authn_rejected",
  SANDBOX_TOKEN_UNPREPARED: "sandbox_token_unprepared",
  RUNTIME_ATTACH_FAILED: "runtime_attach_failed",
  TOOL_EXECUTION_FAILED: "tool_execution_failed",
  TOOL_UNAVAILABLE: "tool_unavailable",
  WEBHOOK_SIGNATURE_INVALID: "webhook_signature_invalid",
  WEBHOOK_TIMESTAMP_REJECTED: "webhook_timestamp_rejected",
  WEBHOOK_PAYLOAD_MALFORMED: "webhook_payload_malformed",
  WEBHOOK_DUPLICATE_DELIVERY: "webhook_duplicate_delivery",
  OAUTH_STATE_MISMATCH: "oauth_state_mismatch",
  OAUTH_CALLBACK_USER_MISMATCH: "oauth_callback_user_mismatch",
  ACTOR_RESOLUTION_FAILED: "actor_resolution_failed",
  SESSION_BOOTSTRAP_FAILED: "session_bootstrap_failed",
  SESSION_SETUP_FAILED: "session_setup_failed",
  SESSION_CLAIM_LOST: "session_claim_lost",
  STALE_SESSION_REF_DISPLACED: "stale_session_ref_displaced",
  INTEGRATION_DISABLED: "integration_disabled",
  SITE_NOT_SELECTED: "site_not_selected",
} as const;

export type IntegrationLifecycleReasonCode =
  (typeof INTEGRATION_LIFECYCLE_REASON_CODE)[keyof typeof INTEGRATION_LIFECYCLE_REASON_CODE];
