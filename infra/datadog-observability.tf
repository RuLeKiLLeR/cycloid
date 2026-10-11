# --- Datadog: Control-plane, prompt, and observability integrity ---

# Log-derived metrics live in datadog-log-metrics.tf.
# Monitor alerts live in datadog-monitors.tf.

resource "datadog_dashboard" "prompt_lifecycle_performance" {
  title       = "Prompt Lifecycle Performance"
  description = "Prompt execution latency, outcomes, and failure trends."
  layout_type = "ordered"

  widget {
    query_value_definition {
      title = "P50 prompt duration (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.execution_duration{*}"
          }
        }
      }
      autoscale   = true
      precision   = 0
      text_align  = "center"
      custom_unit = "ms"
    }
  }

  widget {
    query_value_definition {
      title = "P95 prompt duration (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.execution_duration{*}"
          }
        }
      }
      autoscale   = true
      precision   = 0
      text_align  = "center"
      custom_unit = "ms"
    }
  }

  widget {
    query_value_definition {
      title = "P95 time to first message (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.time_to_first_message{*}"
          }
        }
      }
      autoscale   = true
      precision   = 0
      text_align  = "center"
      custom_unit = "ms"
    }
  }

  widget {
    query_value_definition {
      title = "Failures (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.execution_failures{*}.as_count()"
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
      title       = "Prompt duration over time"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.execution_duration{*}"
          }
        }
        style {
          palette    = "dog_classic"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.execution_duration{*}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Time to first message over time"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.time_to_first_message{*}"
          }
        }
        style {
          palette    = "dog_classic"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.time_to_first_message{*}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 time to first message by backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.time_to_first_message{*} by {agent_runtime_backend}"
          }
        }
        style {
          palette    = "dog_classic"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 time to first message: first prompt vs follow-up"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.time_to_first_message{*} by {is_followup}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 queue wait latency by backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.queue_wait_ms{*} by {agent_runtime_backend}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 predispatch latency by backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.predispatch_ms{*} by {agent_runtime_backend}"
          }
        }
        style {
          palette    = "dog_classic"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 dispatch to first visible event by backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.dispatch_to_first_event_ms{*} by {agent_runtime_backend}"
          }
        }
        style {
          palette    = "cool"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 received to first visible event by backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.received_to_first_visible_event_ms{*} by {agent_runtime_backend}"
          }
        }
        style {
          palette    = "dog_classic"
          line_type  = "solid"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Runtime warmup outcomes and P95 duration"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "outcomes"
            data_source = "metrics"
            query       = "sum:arcanist.runtime.warmup_completions{*} by {agent_runtime_backend,outcome,reason}.as_count()"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95_duration"
            data_source = "metrics"
            query       = "p95:arcanist.runtime.warmup_duration{*} by {agent_runtime_backend,outcome}"
          }
        }
      }

      yaxis {
        label        = "ms / count"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Bridge event subscription duration"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.activity_phase_duration{phase:event_subscribing} by {outcome}"
          }
        }
      }

      yaxis {
        label        = "ms"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Prompt completions by outcome"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "count:arcanist.prompt.execution_duration{*} by {outcome}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Prompt failures by error_code"

      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.execution_failures{*} by {error_code}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Time to first message by first event type"

      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.time_to_first_message{*} by {first_event_type}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Memory selector latency by status"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.memory_context.selector_latency_ms{*} by {selector_status}"
          }
        }
        style {
          palette    = "dog_classic"
          line_type  = "solid"
          line_width = "normal"
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
      title       = "Memory selector result rate"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.memory_context.selector_results{*} by {selector_status}.as_count()"
          }
        }
        style {
          palette    = "cool"
          line_type  = "solid"
          line_width = "normal"
        }
      }
    }
  }

  widget {
    query_value_definition {
      title = "Prompt success rate (last 1h, excl. aborts)"
      request {
        query {
          metric_query {
            name        = "success"
            data_source = "metrics"
            query       = "count:arcanist.prompt.execution_duration{outcome:success}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "failures"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.execution_failures{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(default_zero(success) / (default_zero(success) + default_zero(failures))) * 100"
        }
      }
      autoscale   = true
      precision   = 1
      text_align  = "center"
      custom_unit = "%"
    }
  }
}

resource "datadog_dashboard" "sandbox_bridge_health" {
  title       = "Sandbox Bridge Health"
  description = "Reconnect storms, WebSocket close causality, and tracing initialization failures in sandbox-bridge."
  layout_type = "ordered"

  widget {
    query_value_definition {
      title = "Reconnects (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.bridge.reconnects{*}.as_count()"
          }
        }
      }
      autoscale  = true
      precision  = 0
      text_align = "center"
    }
  }

  widget {
    query_value_definition {
      title = "Active-prompt sandbox WS closes (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.control_plane.sandbox_ws_closes{active_prompt_in_flight:true}.as_count()"
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
      title       = "Control-plane sandbox WS closes by decision"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.control_plane.sandbox_ws_closes{*} by {close_decision,active_prompt_in_flight}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Bridge WS closes by initiator"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.bridge.ws_closes{*} by {close_initiator,close_reason_class,prompt_work_in_flight}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }
    }
  }

  widget {
    query_value_definition {
      title = "Tracing init failures (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.tracing_init_failures{*}.as_count()"
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
      title       = "Bridge reconnects by cause"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.bridge.reconnects{*} by {reconnect_reason,connect_error_class}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Tracing init failures by status"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.tracing_init_failures{*} by {init_status}.as_count()"
          }
        }
      }
    }
  }
}

resource "datadog_dashboard" "observability_integrity" {
  title       = "Observability Integrity"
  description = "Health of trace completeness and export paths."
  layout_type = "ordered"

  widget {
    query_value_definition {
      title = "Trace completeness (last 1h)"
      request {
        query {
          metric_query {
            name        = "complete"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.trace_finalization{trace_complete:true}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.trace_finalization{*}.as_count()"
          }
        }
        formula {
          formula_expression = "(complete / total) * 100"
        }
      }
      autoscale   = true
      precision   = 1
      text_align  = "center"
      custom_unit = "%"
    }
  }

  widget {
    query_value_definition {
      title = "Incomplete finalizations (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.trace_finalization{trace_complete:false}.as_count()"
          }
        }
      }
      autoscale  = true
      precision  = 0
      text_align = "center"
    }
  }

  widget {
    query_value_definition {
      title = "Trace queue export failures (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.trace_queue.export_failures{*}.as_count()"
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
      title       = "Prompt trace finalization by completeness"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.trace_finalization{*} by {trace_complete}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Export and tracing-init failures"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "exports"
            data_source = "metrics"
            query       = "sum:arcanist.trace_queue.export_failures{*}.as_count()"
          }
        }
        style {
          palette = "orange"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "init_failures"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.tracing_init_failures{*}.as_count()"
          }
        }
        style {
          palette = "warm"
        }
      }
    }
  }
}
