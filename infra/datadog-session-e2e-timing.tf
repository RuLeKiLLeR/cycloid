# --- Datadog: session end-to-end timing ---
#
# Uses the close-time `session.completed` / `session.stage_timing` direct-post
# events plus the startup `sandbox.ready` direct-post event to show whole-session
# wall clock, the cold-start slice, and the residual unattributed time.

locals {
  session_e2e_timing_metric_names = toset([
    "arcanist.session.total_duration_ms",
    "arcanist.sandbox.creation_to_ready_ms",
    "arcanist.session.stage_duration_ms",
  ])
}

resource "datadog_metric_metadata" "session_e2e_timing_ms" {
  for_each = local.session_e2e_timing_metric_names

  metric = each.value
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "session_e2e_timing" {
  title       = "Session E2E Timing"
  description = "Session wall clock from session.completed, session.stage_timing, and sandbox.ready direct-post telemetry."
  layout_type = "ordered"

  template_variable {
    name     = "repo"
    prefix   = "repo"
    defaults = ["*"]
  }

  widget {
    timeseries_definition {
      title       = "Session total duration (p50 / p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.session.total_duration_ms{$repo}"
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
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.session.total_duration_ms{$repo}"
          }
        }
        formula {
          formula_expression = "p95"
          alias              = "p95"
        }
      }

      yaxis {
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Session creation -> sandbox ready (p50 / p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.creation_to_ready_ms{$repo}"
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
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.creation_to_ready_ms{$repo}"
          }
        }
        formula {
          formula_expression = "p95"
          alias              = "p95"
        }
      }

      yaxis {
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Session stage duration (p50) by stage"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "stage_p50"
            data_source = "metrics"
            query       = "p50:arcanist.session.stage_duration_ms{$repo} by {stage}"
          }
        }
        formula {
          formula_expression = "stage_p50"
          alias              = "p50"
        }
      }

      yaxis {
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 decomposition: total vs creation->ready vs prompt processing vs unattributed"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "p95:arcanist.session.total_duration_ms{$repo}"
          }
        }
        formula {
          formula_expression = "total"
          alias              = "total"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "ready"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.creation_to_ready_ms{$repo}"
          }
        }
        formula {
          formula_expression = "ready"
          alias              = "creation -> ready"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "processing"
            data_source = "metrics"
            query       = "p95:arcanist.session.stage_duration_ms{$repo,stage:prompt_processing}"
          }
        }
        formula {
          formula_expression = "processing"
          alias              = "prompt processing"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "unattributed"
            data_source = "metrics"
            query       = "p95:arcanist.session.stage_duration_ms{$repo,stage:unattributed}"
          }
        }
        formula {
          formula_expression = "unattributed"
          alias              = "unattributed"
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
      title = "P95 total duration by terminal stage"

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
            query       = "p95:arcanist.session.total_duration_ms{$repo} by {terminal_stage}"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "P95 creation -> ready by spawn path"

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
            query       = "p95:arcanist.sandbox.creation_to_ready_ms{$repo} by {spawn_path}"
          }
        }
      }
    }
  }
}
