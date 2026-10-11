# --- Datadog: D1 latency monitoring ---
#
# D1 spans emitted by the control-plane trace exporter arrive in Datadog Logs
# with:
#   @span.db.system     = "d1"
#   @span.db.operation  = "first" | "all" | "run" | "raw" for prepared statements
#   @span.db.table      = table name for prepared statements
#   @span.duration_ms   = elapsed time in milliseconds
#   @span.status        = "ok" | "error"
#   @span.name          = "d1.<operation>" | "d1.batch" | "d1.exec"
#   service             = "cycloid-control-plane"

resource "datadog_logs_metric" "d1_query_duration" {
  name = "arcanist.d1.query_duration"

  compute {
    aggregation_type    = "distribution"
    path                = "@span.duration_ms"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-control-plane env:production @span.db.system:d1"
  }

  group_by {
    path     = "@span.db.operation"
    tag_name = "operation"
  }

  group_by {
    path     = "@span.db.table"
    tag_name = "table"
  }
}

resource "datadog_metric_metadata" "d1_query_duration" {
  metric = "arcanist.d1.query_duration"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "d1_health" {
  title       = "D1 Health"
  description = "D1 query latency, slow-span shape, and platform error signals for the control plane."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "D1 query duration p95 / p99"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.d1.query_duration{*}"
          }
        }
        formula {
          formula_expression = "p95"
          alias              = "p95"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.d1.query_duration{*}"
          }
        }
        formula {
          formula_expression = "p99"
          alias              = "p99"
        }
      }

      yaxis {
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    toplist_definition {
      title = "D1 p95 by table / operation"
      request {
        formula {
          formula_expression = "p95"
          limit {
            count = 25
            order = "desc"
          }
        }
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.d1.query_duration{*} by {table,operation}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "D1 internal errors"
      show_legend = true

      request {
        display_type = "bars"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.status:error @span.db.system:d1"
          compute_query {
            aggregation = "count"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "D1 overloaded / load-shed errors"
      show_legend = true

      request {
        display_type = "bars"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.status:error @span.db.system:d1 @span.error.message:*overloaded*"
          compute_query {
            aggregation = "count"
          }
        }
      }
    }
  }
}

resource "datadog_monitor" "d1_slow_query_observed" {
  name    = "[D1] Slow query observed"
  type    = "log alert"
  message = <<-EOT
    More than 10 D1 query spans exceeded 750ms across the control plane in 10 minutes.

    This catches a burst of genuinely slow D1 spans before they dominate aggregate p95, without paging once per table/operation group.

    Open the D1 Health dashboard for the table/operation breakdown:
      https://us5.datadoghq.com${datadog_dashboard.d1_health.url}

    Investigate matching logs:
      service:cycloid-control-plane env:production @span.db.system:d1 @span.db.table:* @span.db.operation:* @span.duration_ms:[750 TO *]

    ${var.datadog_slack_handle}
  EOT

  query = "logs(\"service:cycloid-control-plane env:production @span.db.system:d1 @span.db.table:* @span.db.operation:* @span.duration_ms:[750 TO *]\").index(\"*\").rollup(\"count\").last(\"10m\") > 10"

  monitor_thresholds {
    critical          = 10
    critical_recovery = 2
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = ["service:cycloid-control-plane", "component:d1", "signal:slow-query"]
}

resource "datadog_monitor" "d1_errors" {
  name    = "[D1] Internal errors"
  type    = "log alert"
  message = <<-EOT
    D1 is returning errors above the transient-blip baseline. These indicate a D1 platform issue, not application code.

    Counts ALL D1 error spans (internal errors, network-lost, AND overload) so a mixed degradation can't slip under two split thresholds. Overload ALSO trips the sibling "[D1] Overloaded / load-shed" capacity monitor, which classifies it as a write-ceiling signal; this monitor stays the authoritative "D1 is erroring" pager and the composite suppressor.

    Post-retry signal: the control-plane wraps reads (and marked idempotent writes) in a bounded transient-retry loop, so a span only errors here when every retry was exhausted. An alert therefore means user-visible failures, not a single absorbed blip.

    Fires on >5 errors in 10m so isolated transient errors do not flap; recovers below 2.

    Search Datadog Logs for:
      service:cycloid-control-plane env:production @span.status:error @span.db.system:d1

    Check https://www.cloudflarestatus.com for D1 status.
    ${var.datadog_slack_handle}
    {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
    {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
  EOT

  query = "logs(\"service:cycloid-control-plane env:production @span.status:error @span.db.system:d1\").index(\"*\").rollup(\"count\").last(\"10m\") > 5"

  monitor_thresholds {
    critical          = 5
    critical_recovery = 2
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = ["service:cycloid-control-plane", "component:d1"]
}

# D1 load-shed ("D1 DB is overloaded. Requests queued for too long.") is a
# capacity signal, not a transient platform blip: it is deliberately NOT retried
# (retrying amplifies a saturated single writer). It also counts toward the
# combined "[D1] Internal errors" monitor above (so mixed incidents always page
# something); this monitor adds the specific capacity classification on top.
# Sustained overload means our genuine query load is hitting D1's write ceiling -
# the churn-to-Postgres trigger - so it gets its own named signal.
resource "datadog_monitor" "d1_overloaded" {
  name    = "[D1] Overloaded / load-shed"
  type    = "log alert"
  message = <<-EOT
    D1 is shedding load ("overloaded / queued for too long"). This is a capacity signal: these requests are NOT retried (retry amplifies a saturated single writer), so each one is a dropped/failed query.

    A sustained cluster (vs an isolated blip) means our query load is approaching D1's single-writer ceiling. This is the capacity trigger to revisit the Postgres migration, not a transient platform fault. (These spans also count toward "[D1] Internal errors"; this monitor is the capacity-specific classification.)

    Search Datadog Logs for:
      service:cycloid-control-plane env:production @span.status:error @span.db.system:d1 @span.error.message:*overloaded*

    ${var.datadog_slack_handle}
    {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
    {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
  EOT

  query = "logs(\"service:cycloid-control-plane env:production @span.status:error @span.db.system:d1 @span.error.message:*overloaded*\").index(\"*\").rollup(\"count\").last(\"10m\") > 5"

  monitor_thresholds {
    critical          = 5
    critical_recovery = 2
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = ["service:cycloid-control-plane", "component:d1", "signal:capacity"]
}
