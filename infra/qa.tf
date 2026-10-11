# QA/staging environment for Cycloid end-to-end session validation.
# See docs/qa-environment.md.

# --- QA SSM Parameters ---
# Mirrors /cycloid/* but scoped to QA so prod and QA secret sync paths
# remain disjoint. Values are populated out-of-band (same as prod).
#
# Removed parameters (destroyed by TFC apply on merge):
#   CONTROL_PLANE_URL / NOTION_OAUTH_CALLBACK_URL -- non-secret public Worker
#     config moved to apps/control-plane-worker/wrangler.toml [env.qa.vars].
#   DD_SITE -- internal Datadog site is fixed to us5.datadoghq.com in code and
#     Logpush Terraform config; SSM no longer owns this routing value.

locals {
  qa_ssm_parameters = {
    ARCANIST_ADMIN_TOKEN           = "SecureString"
    ARCANIST_ANTHROPIC_API_KEY     = "SecureString"
    ARCANIST_BASETEN_API_KEY       = "SecureString"
    ARCANIST_OPENAI_API_KEY        = "SecureString"
    BUILD_CALLBACK_SECRET          = "SecureString"
    CI_AUTOMATION_TOKEN            = "SecureString"
    E2B_API_KEY                    = "SecureString"
    GITHUB_APP_ID                  = "String"
    GITHUB_CLIENT_ID               = "String"
    GITHUB_CLIENT_SECRET           = "SecureString"
    GITHUB_PRIVATE_KEY             = "SecureString"
    GITHUB_WEBHOOK_SECRET          = "SecureString"
    JIRA_OAUTH_CLIENT_ID           = "String"
    JIRA_OAUTH_CLIENT_SECRET       = "SecureString"
    LINEAR_OAUTH_CLIENT_ID         = "String"
    LINEAR_OAUTH_CLIENT_SECRET     = "SecureString"
    NOTION_OAUTH_CLIENT_ID         = "String"
    NOTION_OAUTH_CLIENT_SECRET     = "SecureString"
    SANDBOX_CALLBACK_SECRET        = "SecureString"
    SANDBOX_RUNTIME_CLEANUP_SECRET = "SecureString"
    SLACK_BOT_TOKEN                = "SecureString"
    SLACK_SIGNING_SECRET           = "SecureString"
    SLACK_LINK_SIGNING_KEY         = "SecureString"
    SLACK_CLIENT_ID                = "String"
    SLACK_CLIENT_SECRET            = "SecureString"
    TOKEN_ENCRYPTION_KEY           = "SecureString"
    GITHUB_HEALTH_OWNER_USER_ID    = "String"

    # Observability
    DD_API_KEY           = "SecureString"
    DD_APP_KEY           = "SecureString"
    BRAINTRUST_API_KEY   = "SecureString"
    S3_ACCESS_KEY_ID     = "SecureString"
    S3_SECRET_ACCESS_KEY = "SecureString"
    S3_SESSION_BUCKET    = "String"
    SENTRY_DSN           = "String"

    # Optional QA customer-tool fixtures seeded by npm run qa:seed.
    QA_CLOUDFLARE_D1_API_TOKEN   = "SecureString"
    QA_CLOUDFLARE_D1_ACCOUNT_ID  = "String"
    QA_CLOUDFLARE_D1_DATABASE_ID = "String"
    QA_DATADOG_API_KEY           = "SecureString"
    QA_DATADOG_APP_KEY           = "SecureString"
    QA_DATADOG_SITE              = "String"
    QA_BRAINTRUST_API_KEY        = "SecureString"
    QA_BRAINTRUST_API_URL        = "String"
  }
}

resource "aws_ssm_parameter" "qa_env" {
  for_each = local.qa_ssm_parameters

  name  = "/cycloid/qa/${each.key}"
  type  = each.value
  value = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value, tags]
  }
}

resource "aws_ssm_parameter" "qa_turnstile_site_key" {
  name  = "/cycloid/qa/TURNSTILE_SITE_KEY"
  type  = "String"
  value = cloudflare_turnstile_widget.github_auth.sitekey
}

resource "aws_ssm_parameter" "qa_turnstile_secret_key" {
  name  = "/cycloid/qa/TURNSTILE_SECRET_KEY"
  type  = "SecureString"
  value = cloudflare_turnstile_widget.github_auth.secret
}

# --- QA Cloudflare Logpush (Workers -> Datadog) ---
# Mirror of the prod logpush job, scoped to the QA worker and tagged env:qa
# so Datadog filters cleanly separate the two streams.

locals {
  qa_control_plane_worker_script_name = "cycloid-control-plane-qa"

  # Internal Cycloid telemetry must stay on US5; hardcode rather than reading
  # DD_SITE from SSM so an accidental edit cannot route QA logs elsewhere.
  qa_control_plane_logpush_destination_conf = format(
    "datadog://http-intake.logs.%s/api/v2/logs?header_DD-API-KEY=%s&ddsource=cloudflare&service=%s&host=%s&ddtags=%s",
    "us5.datadoghq.com",
    urlencode(data.aws_ssm_parameter.dd_api_key.value),
    urlencode("cycloid-control-plane"),
    urlencode("cf-worker-qa"),
    urlencode("env:qa,worker:control-plane,script:${local.qa_control_plane_worker_script_name}"),
  )
}

resource "cloudflare_logpush_job" "qa_control_plane_worker_datadog" {
  account_id       = var.cloudflare_account_id
  dataset          = "workers_trace_events"
  destination_conf = local.qa_control_plane_logpush_destination_conf
  enabled          = false
  name             = "control-plane-worker-qa-datadog"

  filter = jsonencode({
    where = {
      and = [
        {
          key      = "ScriptName"
          operator = "eq"
          value    = local.qa_control_plane_worker_script_name
        },
        {
          key      = "EventType"
          operator = "!eq"
          value    = "alarm"
        },
      ]
    }
  })

  output_options = {
    field_names = [
      "CPUTimeMs",
      "Entrypoint",
      "EventTimestampMs",
      "EventType",
      "Exceptions",
      "Logs",
      "Outcome",
      "ScriptName",
      "ScriptVersion",
      "WallTimeMs",
    ]
    output_type      = "ndjson"
    sample_rate      = 1
    timestamp_format = "rfc3339"
  }
}

# --- QA DNS ---
# qa.trycycloid.com is bound to the QA worker via a Workers custom domain.
# Custom domains manage DNS automatically, so we do NOT declare a separate
# cloudflare_dns_record here. The worker must already exist before this
# resource is applied. `cycloid-control-plane-qa` was brought online by
# workflow_dispatch run 24754158107 on 2026-04-22.
#
# Prerequisite: the Cloudflare API token used by HCP Terraform must carry
# `Account > Workers Scripts: Edit` and `Account > Workers Routes: Edit`.
# PR 2203 tried to land this resource without those scopes and Cloudflare
# returned a misleading 403 `Authentication error`; see PR 2204 for the
# revert and docs/qa-environment.md for the bring-up sequence.
resource "cloudflare_workers_custom_domain" "qa" {
  account_id = var.cloudflare_account_id
  hostname   = "qa.trycycloid.com"
  service    = local.qa_control_plane_worker_script_name
  zone_id    = cloudflare_zone.main.id
}

# --- QA Frontend (Cloudflare Pages) ---
# Mirrors the prod Pages setup in infra/cloudflare-pages.tf but bound to the
# QA control-plane worker at qa.trycycloid.com. Deploys are manual via
# .github/workflows/deploy-frontend-qa.yml with a `ref` input so an engineer
# can smoke-test any feature branch end-to-end against the QA API.
resource "cloudflare_pages_project" "ui_qa" {
  account_id        = var.cloudflare_account_id
  name              = "cycloid-ui-qa"
  production_branch = "qa"

  deployment_configs = {
    production = {
      fail_open = true
      env_vars = {
        WORKER_HOST = {
          type  = "plain_text"
          value = "qa.trycycloid.com"
        }
      }
      # No UI_ASSETS_BUCKET binding: prod's deploy populates the shared R2
      # bucket as a cross-deploy fallback for hashed chunks held by stale
      # tabs, but QA has no R2 upload step, so binding the bucket would be
      # misleading — the fallback would always 404. The worker handles a
      # missing binding cleanly (apps/ui/src/worker.ts `No R2 binding`
      # branch). Stale-tab 404 in QA is acceptable; user refreshes.
    }
    preview = {
      fail_open = true
    }
  }
}

resource "cloudflare_pages_domain" "app_qa" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.ui_qa.name
  name         = "qa.app.trycycloid.com"
}

resource "cloudflare_dns_record" "app_qa" {
  zone_id = cloudflare_zone.main.id
  name    = "qa.app"
  type    = "CNAME"
  content = "${cloudflare_pages_project.ui_qa.name}.pages.dev"
  proxied = true
  ttl     = 1
}
