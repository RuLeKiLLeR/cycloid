# --- Datadog: PR-open → fully-done E2E latency ---
#
# Backs arcanist.arcanist_done.e2e_duration (distribution over @duration_ms) and
# arcanist.arcanist_done.settled (count), emitted once per PR by
# emitCycloidDoneSettledEvent when the session's aggregate cycloidDoneState
# transitions working → done (review loop done AND verification settled). See
# infra/datadog-log-metrics.tf for the metric definitions. Sliceable by business
# and repo via the template variables below; both metrics carry repo +
# business_id + outcome tags. business_id is omitted from the event when null, so
# those rows fall under the $business_id=* default.

# Tag the duration metric as milliseconds so Datadog's time-unit family auto-scales it
# to human-readable durations (e.g. 898000 -> "14.97 min", smaller values -> "s") across
# every widget, instead of rendering a raw SI-abbreviated number like "898k". This is why
# the widgets below carry no hand-typed "(ms)" label: the unit drives the display.
resource "datadog_metric_metadata" "cycloid_done_e2e_duration" {
  metric = "arcanist.arcanist_done.e2e_duration"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "pr_e2e_latency" {
  title       = "PR E2E Latency (open → fully done)"
  description = "Wall-clock from PR open to Cycloid fully finishing post-PR work (review loop + verification settled), by business and repo."
  layout_type = "ordered"

  template_variable {
    name     = "business_id"
    prefix   = "business_id"
    defaults = ["*"]
  }

  template_variable {
    name     = "repo"
    prefix   = "repo"
    defaults = ["*"]
  }

  widget {
    timeseries_definition {
      title       = "PR-open → done latency (p50 / p90 / p99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.arcanist_done.e2e_duration{$business_id,$repo}"
          }
        }
        formula {
          formula_expression = "p50"
          alias              = "p50"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.arcanist_done.e2e_duration{$business_id,$repo}"
          }
        }
        formula {
          formula_expression = "p90"
          alias              = "p90"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.arcanist_done.e2e_duration{$business_id,$repo}"
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
    query_value_definition {
      title = "Current p90 latency"
      request {
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.arcanist_done.e2e_duration{$business_id,$repo}"
          }
        }
      }
      autoscale  = true
      precision  = 0
      text_align = "center"
    }
  }

  widget {
    toplist_definition {
      title = "p90 latency by repo"
      request {
        formula {
          formula_expression = "p90"
          limit {
            count = 25
            order = "desc"
          }
        }
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.arcanist_done.e2e_duration{$business_id,$repo} by {repo}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Settle volume by outcome"
      show_legend = true
      request {
        display_type = "bars"
        formula {
          formula_expression = "query1"
        }
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.arcanist_done.settled{$business_id,$repo} by {outcome}.as_count()"
          }
        }
      }
    }
  }
}
