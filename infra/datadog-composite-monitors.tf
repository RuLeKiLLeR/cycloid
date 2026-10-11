# --- Datadog: composite monitors (D1 incident de-duplication) ---
#
# A single D1 platform blip used to page multiple monitors at once: the D1
# error monitor PLUS downstream symptom monitors it causes (worker P95 latency,
# worker request errors). The 2026-06-11 incident paged all of them.
#
# Fix: the downstream symptom monitors no longer @-notify on their own
# (their messages dropped the Slack handle in datadog-monitors.tf). Instead each
# feeds a composite below that pages ONLY when the symptom is not explained by a
# firing D1 monitor (errors, latency, or overload). The D1 monitors keep paging
# on their own - they ARE the explanation - so a D1 incident pages once.
#
# Constituent ids come from Terraform resource refs (module outputs + the
# standalone D1 monitors), never hardcoded ids.

locals {
  # "Is this symptom explained by a paging D1 platform issue right now?" Suppress
  # downstream composites only while D1 errors or overload are alerting. The D1
  # latency and slow-query monitors are Slack-only investigation signals; they
  # must not suppress these paging composites.
  d1_explained_suffix = join(" ", [
    "&& !${datadog_monitor.d1_errors.id}",
    "&& !${datadog_monitor.d1_overloaded.id}",
  ])
}

resource "datadog_monitor" "worker_p95_latency_not_d1" {
  name    = "[Control Plane] Worker P95 latency elevated (not explained by D1)"
  type    = "composite"
  message = <<-EOT
    Worker P95 latency on non-streaming routes is elevated and no D1 monitor is firing, so this is not a known D1 platform issue. Investigate the worker.fetch spans (split by @span.http.route) and worker logs.

    (If a D1 monitor is also firing, the D1 monitor pages instead and this one stays quiet to avoid double-paging.)

    Slack-only by design: elevated P95 latency means the control plane is serving
    slowly, not down. It is an investigate-soon signal, not a wake-someone page.
    ${var.datadog_slack_handle}
  EOT

  query = "${module.datadog_monitors.log_alert_ids["worker_p95_latency"]} ${local.d1_explained_suffix}"

  renotify_interval = 120

  tags = ["service:cycloid-control-plane", "component:control-plane", "signal:composite"]
}

resource "datadog_monitor" "worker_errors_not_d1" {
  name    = "[Control Plane] Worker request errors elevated (not explained by D1)"
  type    = "composite"
  message = <<-EOT
    Production control-plane requests are failing (thrown error or 5xx) at elevated volume and no D1 monitor is firing, so this is not a known D1 platform issue. Split by @span.http.route and @span.error.message to find the failing route.

    (If a D1 monitor is also firing, the D1 monitor pages instead and this one stays quiet to avoid double-paging.)
    ${var.datadog_slack_handle}
    {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
    {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
  EOT

  query = "${module.datadog_monitors.log_alert_ids["worker_error_count"]} ${local.d1_explained_suffix}"

  renotify_interval = 120

  tags = ["service:cycloid-control-plane", "component:control-plane", "signal:composite"]
}
