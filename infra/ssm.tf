# --- SSM Parameters ---
# Defines control-plane env vars stored in SSM under /cycloid/.
# Values are managed via Terraform.
#
# Removed parameters (destroyed by TFC apply on merge):
#   ALLOWED_GITHUB_USERS -- replaced by GITHUB_USER_BUSINESSES in
#     apps/control-plane-worker/src/constants/auth.ts
#   ARCANIST_API_TOKEN -- replaced by scoped tokens (ARCANIST_ADMIN_TOKEN,
#     BUILD_CALLBACK_SECRET, SANDBOX_CALLBACK_SECRET, CI_AUTOMATION_TOKEN) in
#     the API token hardening plan
#   MCP_API_TOKEN -- removed after runtime MCP support was deleted
#   Legacy Pages entry parameter -- removed with the browser-facing entry check
#   OPENAI_API_KEY -- replaced by explicit CYCLOID_* platform provider keys.
#     Bare provider env names remain sandbox BYOK env vars.
#   cycloid-sandbox-runtime -- speculative JSON-payload placeholder that was
#     never read.
#   OTEL_COLLECTOR_URL / COLLECTOR_AUTH_KEY -- retired the dead Modal OTEL
#     collector path. Spans now export via the Datadog Logs API only.
#   POSTHOG_API_KEY -- never read by the control plane.
#   SELF_HOSTED_E2B_* -- self-hosted E2B runtime was removed; the only
#     SandboxRuntimeBackend is e2b_cloud (shared/types/sandbox.ts) and
#     parsePersistedRuntimeBackend rejects anything else. No consumer remained.
#   ARCANIST_ADMIN_GITHUB_IDS -- internal-admin gating moved to Cycloid-business
#     membership (business_members role). No runtime reader remained.
#   SENTRY_AUTH_TOKEN -- never read by the control-plane worker. The CI sourcemap
#     upload uses the GitHub Actions secret of the same name, not this SSM param.
#   PENDING_SIGNUP_NOTIFY_SLACK_CHANNEL_ID / SLACK_FEEDBACK_CHANNEL_ID /
#     SLACK_MEMORY_FEEDBACK_CHANNEL_ID / SLACK_MEMORY_PR_CHANNEL_ID -- non-secret
#     Slack channel IDs moved to code
#     (apps/control-plane-worker/src/slack/internal-channels.ts). SSM is for
#     secrets only; these are routing config.
#   CONTROL_PLANE_URL / JIRA_OAUTH_CALLBACK_URL / LINEAR_OAUTH_CALLBACK_URL /
#     NOTION_OAUTH_CALLBACK_URL -- non-secret public Worker config moved to
#     apps/control-plane-worker/wrangler.toml [vars].
#   DD_SITE -- internal Datadog site is fixed to us5.datadoghq.com in code and
#     Logpush Terraform config; SSM no longer owns this routing value.

locals {
  control_plane_ssm_parameters = {
    ARCANIST_ADMIN_TOKEN           = "SecureString"
    ARCANIST_ANTHROPIC_API_KEY     = "SecureString"
    ARCANIST_BASETEN_API_KEY       = "SecureString"
    ARCANIST_OPENAI_API_KEY        = "SecureString"
    BUILD_CALLBACK_SECRET          = "SecureString"
    CI_AUTOMATION_TOKEN            = "SecureString"
    E2B_API_KEY                    = "SecureString"
    FREESTYLE_API_KEY              = "SecureString" # value rotated out-of-band 2026-07-06; this comment-touch re-syncs Worker secrets on the flip deploy
    GITHUB_APP_ID                  = "String"
    GITHUB_CLIENT_ID               = "String"
    GITHUB_CLIENT_SECRET           = "SecureString"
    GITHUB_PRIVATE_KEY             = "SecureString"
    GITHUB_WEBHOOK_SECRET          = "SecureString"
    JIRA_OAUTH_CLIENT_ID           = "String"
    JIRA_OAUTH_CLIENT_SECRET       = "SecureString"
    LINEAR_OAUTH_CLIENT_ID         = "String"
    LINEAR_OAUTH_CLIENT_SECRET     = "SecureString"
    LINEAR_WEBHOOK_SECRET          = "SecureString"
    NOTION_OAUTH_CLIENT_ID         = "String"
    NOTION_OAUTH_CLIENT_SECRET     = "SecureString"
    SANDBOX_CALLBACK_SECRET        = "SecureString"
    SENTRY_DSN                     = "String"
    SLACK_BOT_TOKEN                = "SecureString"
    SANDBOX_RUNTIME_CLEANUP_SECRET = "SecureString"
    SLACK_SIGNING_SECRET           = "SecureString"
    SLACK_LINK_SIGNING_KEY         = "SecureString"
    SLACK_CLIENT_ID                = "String"
    SLACK_CLIENT_SECRET            = "SecureString"
    TOKEN_ENCRYPTION_KEY           = "SecureString"

    # Observability
    DD_API_KEY                  = "SecureString"
    DD_APP_KEY                  = "SecureString"
    BRAINTRUST_API_KEY          = "SecureString"
    S3_ACCESS_KEY_ID            = "SecureString"
    S3_SECRET_ACCESS_KEY        = "SecureString"
    S3_SESSION_BUCKET           = "String"
    GITHUB_HEALTH_OWNER_USER_ID = "String"

    OPENAI_ADMIN_API_KEY = "SecureString"
  }

  ssm_parameters = local.control_plane_ssm_parameters
}

resource "aws_ssm_parameter" "env" {
  for_each = local.ssm_parameters

  name = "/cycloid/${each.key}"
  type = each.value
  # Placeholder only: most live secret values are rotated out-of-band and then
  # synced to Worker secrets during deploy. See docs/security.md#secret-rotation.
  value = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value, type, tags]
  }
}

resource "aws_ssm_parameter" "turnstile_site_key" {
  name  = "/cycloid/TURNSTILE_SITE_KEY"
  type  = "String"
  value = cloudflare_turnstile_widget.github_auth.sitekey
}

resource "aws_ssm_parameter" "turnstile_secret_key" {
  name  = "/cycloid/TURNSTILE_SECRET_KEY"
  type  = "SecureString"
  value = cloudflare_turnstile_widget.github_auth.secret
}
