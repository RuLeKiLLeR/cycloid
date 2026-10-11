# --- Cloudflare Logpush (Workers -> Datadog) ---

data "aws_ssm_parameter" "dd_api_key" {
  name            = "/cycloid/DD_API_KEY"
  with_decryption = true
}

locals {
  control_plane_worker_script_name = "cycloid-control-plane-production"

  # Internal Cycloid telemetry must stay on US5; hardcode rather than reading
  # DD_SITE from SSM so an accidental edit cannot route prod logs elsewhere.
  control_plane_logpush_destination_conf = format(
    "datadog://http-intake.logs.%s/api/v2/logs?header_DD-API-KEY=%s&ddsource=cloudflare&service=%s&host=%s&ddtags=%s",
    "us5.datadoghq.com",
    urlencode(data.aws_ssm_parameter.dd_api_key.value),
    urlencode("cycloid-control-plane"),
    urlencode("cf-worker"),
    urlencode("env:production,worker:control-plane,script:${local.control_plane_worker_script_name}"),
  )
}

resource "cloudflare_logpush_job" "control_plane_worker_datadog" {
  account_id       = var.cloudflare_account_id
  dataset          = "workers_trace_events"
  destination_conf = local.control_plane_logpush_destination_conf
  enabled          = false
  name             = "control-plane-worker-datadog"

  filter = jsonencode({
    where = {
      and = [
        {
          key      = "ScriptName"
          operator = "eq"
          value    = local.control_plane_worker_script_name
        },
        {
          key      = "EventType"
          operator = "!eq"
          value    = "alarm"
        },
      ]
    }
  })

  # The control plane already direct-posts the structured logs and metrics we
  # alert on, so keep the Cloudflare worker-trace Logpush job disabled by
  # default. The worker trace stream is dominated by low-signal SessionDO alarm
  # invocations and duplicates request-success telemetry that we already emit
  # explicitly from the app.
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
