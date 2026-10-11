# --- Datadog: Slack @mention → "eyes" ack latency ---
#
# Backs arcanist.slack.mention_ack_latency_ms (gauge, ms), emitted by the control
# plane (observability/slack-ack-metrics.ts) once the "eyes" reaction lands on the
# mentioned message. Measures perceived snappiness: server-side time from webhook
# receipt to the ack reaction. Tagged by `path` (new_session|follow_up).

# Tag as milliseconds so Datadog auto-scales the display to human-readable
# durations; this is why the widgets carry no hand-typed "(ms)" label.
resource "datadog_metric_metadata" "slack_mention_ack_latency" {
  metric = "arcanist.slack.mention_ack_latency_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "slack_mention_ack_latency" {
  title       = "Slack Mention Ack Latency (@mention → eyes reaction)"
  description = "Server-side time from Slack webhook receipt to the 'eyes' ack reaction landing, split by path (new session vs thread follow-up)."
  layout_type = "ordered"

  template_variable {
    name     = "path"
    prefix   = "path"
    defaults = ["*"]
  }

  widget {
    timeseries_definition {
      title       = "Ack latency (p50 / p90 / p99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.slack.mention_ack_latency_ms{$path}"
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
            query       = "p90:arcanist.slack.mention_ack_latency_ms{$path}"
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
            query       = "p99:arcanist.slack.mention_ack_latency_ms{$path}"
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
      title = "Current p90 ack latency"
      request {
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.slack.mention_ack_latency_ms{$path}"
          }
        }
      }
      autoscale  = true
      precision  = 0
      text_align = "center"
    }
  }

  widget {
    timeseries_definition {
      title       = "p90 ack latency by path"
      show_legend = true
      request {
        display_type = "line"
        formula {
          formula_expression = "p90"
        }
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.slack.mention_ack_latency_ms{$path} by {path}"
          }
        }
      }
      yaxis {
        include_zero = true
        scale        = "linear"
      }
    }
  }
}
