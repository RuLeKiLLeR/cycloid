# --- Datadog: prompt latency decomposition ---

resource "datadog_dashboard" "cold_start_latency_decomposition" {
  title       = "Cold-start Latency Decomposition"
  description = "Breaks user-visible prompt startup latency into control-plane queue wait, predispatch, dispatch-to-first-event, and prompt activity phases using log-derived metrics."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Queue wait latency (P50 / P95 / P99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.queue_wait_ms{*}"
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
            query       = "p95:arcanist.prompt.queue_wait_ms{*}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.prompt.queue_wait_ms{*}"
          }
        }
        style {
          palette    = "orange"
          line_type  = "dotted"
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
      title       = "Predispatch latency (P50 / P95 / P99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.predispatch_ms{*}"
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
            query       = "p95:arcanist.prompt.predispatch_ms{*}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.prompt.predispatch_ms{*}"
          }
        }
        style {
          palette    = "orange"
          line_type  = "dotted"
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
      title       = "Dispatch to first event (P50 / P95 / P99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.dispatch_to_first_event_ms{*}"
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
            query       = "p95:arcanist.prompt.dispatch_to_first_event_ms{*}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.prompt.dispatch_to_first_event_ms{*}"
          }
        }
        style {
          palette    = "orange"
          line_type  = "dotted"
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
      title       = "Backend first token offset (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.backend_first_token_ms{*}"
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
            query       = "p95:arcanist.prompt.backend_first_token_ms{*}"
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
      title       = "Bridge delay after backend first token (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.bridge_delay_ms{*}"
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
            query       = "p95:arcanist.prompt.bridge_delay_ms{*}"
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
      title       = "Received to thinking (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.received_to_thinking_ms{*}"
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
            query       = "p95:arcanist.prompt.received_to_thinking_ms{*}"
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
      title       = "Resume wall time (P50 / P95 by outcome)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.resume_wall_ms{*} by {outcome}"
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
            query       = "p95:arcanist.sandbox.resume_wall_ms{*} by {outcome}"
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
      title       = "Dispatch path mix"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "dispatch_path"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.dispatch{*} by {dispatch_path}.as_count()"
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
      title       = "Warm trigger outcomes"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "trigger"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.warm_trigger{*} by {trigger}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "outcome"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.warm_trigger{*} by {outcome}.as_count()"
          }
        }
        style {
          palette = "warm"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Prompt activity phase duration (P50 / P95 / P99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.activity_phase_duration{*}"
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
            query       = "p95:arcanist.prompt.activity_phase_duration{*}"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.prompt.activity_phase_duration{*}"
          }
        }
        style {
          palette    = "orange"
          line_type  = "dotted"
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
      title       = "Workspace setup duration by setup kind (P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.workspace_setup_ms{*} by {setup_kind}"
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
      title       = "Workspace setup timeouts"
      show_legend = false

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.workspace_setup_timeouts{*}.as_count()"
          }
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "count"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Predispatch P95 by agent / model / follow-up / memories"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "agent"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.predispatch_ms{*} by {agent}"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "model"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.predispatch_ms{*} by {model}"
          }
        }
        style {
          palette   = "orange"
          line_type = "dotted"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "is_followup"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.predispatch_ms{*} by {is_followup}"
          }
        }
        style {
          palette   = "dog_classic"
          line_type = "dashed"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "has_memories"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.predispatch_ms{*} by {has_memories}"
          }
        }
        style {
          palette   = "warm"
          line_type = "dotted"
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
      title       = "Dispatch-to-first-event P95 by model / effort / follow-up / first event"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "model"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.dispatch_to_first_event_ms{*} by {model}"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "reasoning_effort"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.dispatch_to_first_event_ms{*} by {reasoning_effort}"
          }
        }
        style {
          palette   = "warm"
          line_type = "dashed"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "is_followup"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.dispatch_to_first_event_ms{*} by {is_followup}"
          }
        }
        style {
          palette   = "orange"
          line_type = "dotted"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "first_event_type"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.dispatch_to_first_event_ms{*} by {first_event_type}"
          }
        }
        style {
          palette   = "dog_classic"
          line_type = "dashed"
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
      title       = "Activity phase P95 by phase / outcome"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "phase"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.activity_phase_duration{*} by {phase}"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "outcome"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.activity_phase_duration{*} by {outcome}"
          }
        }
        style {
          palette   = "warm"
          line_type = "dashed"
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
      title       = "Agent runtime initializing P95 by follow-up / backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "is_followup"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.agent_runtime_initializing_ms{*} by {is_followup}"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "agent_runtime_backend"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.agent_runtime_initializing_ms{*} by {agent_runtime_backend}"
          }
        }
        style {
          palette   = "warm"
          line_type = "dashed"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "outcome"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.agent_runtime_initializing_ms{*} by {outcome}"
          }
        }
        style {
          palette   = "orange"
          line_type = "dotted"
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
      title       = "Sandbox reaper and sandbox-state refusals"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "liveness_protected"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.reaper.liveness_protected{*}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "zombie_reclaimed"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.reaper.zombie_reclaimed{*}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "prompt_activity_refused"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_state.prompt_activity_refused{*}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "runtime_lease_refused"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_state.runtime_lease_refresh_refused{*}.as_count()"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "platform_llm_refused"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_state.platform_llm_prompt_status_refused{*}.as_count()"
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
      title       = "Post-execution artifact upload results"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "uploaded"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.artifacts_uploaded{*} by {e2e_runtime}"
          }
        }
        style {
          palette = "dog_classic"
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "failed"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.artifacts_failed{*} by {e2e_runtime}"
          }
        }
        style {
          palette = "warm"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Dispatch waterfall milestone offsets and prompt-send duration (P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "span"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.dispatch_subspan_offset_ms{*} by {span}"
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
            name        = "prompt_send"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.prompt_send_duration_ms{*}"
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
}
