# --- Datadog: Sandbox spawn observability ---

# Log-based metric: extract spawn_duration_ms from bridge logs.
# Source logs are emitted by sandbox-bridge on each first "ready" transition.
resource "datadog_logs_metric" "sandbox_spawn_duration" {
  name = "arcanist.sandbox.spawn_duration"

  compute {
    aggregation_type    = "distribution"
    path                = "@spawn_duration_ms"
    include_percentiles = true
  }

  filter {
    query = "env:production @event:\"sandbox.spawn\" @phase_status:completed"
  }

  group_by {
    path     = "@repo"
    tag_name = "repo"
  }

  group_by {
    path     = "@spawn_path"
    tag_name = "spawn_path"
  }

  group_by {
    path     = "@runtime_backend"
    tag_name = "runtime_backend"
  }

  group_by {
    path     = "@provider"
    tag_name = "provider"
  }
}

# Separate by-path metric so optional/mixed-deploy spawn_path tags cannot
# suppress untagged successes from the base spawn_duration metric used by
# monitors, totals, and repo-level charts. Not retroactive: spawn_path-tagged
# duration series exist from this apply forward and only for logs carrying the
# field.
resource "datadog_logs_metric" "sandbox_spawn_duration_by_path" {
  name = "arcanist.sandbox.spawn_duration_by_path"

  compute {
    aggregation_type    = "distribution"
    path                = "@spawn_duration_ms"
    include_percentiles = true
  }

  filter {
    query = "env:production @event:\"sandbox.spawn\" @phase_status:completed @spawn_path:*"
  }

  group_by {
    path     = "@repo"
    tag_name = "repo"
  }

  group_by {
    path     = "@spawn_path"
    tag_name = "spawn_path"
  }
}

# Log-based metric: count terminal/retrying spawn failures by phase.
# Source log is emitted by the control plane (prompt-queue handleSpawnTimeout /
# unrecoverable spawn-failure path) as @event:"sandbox.spawn_failed". A failed
# spawn never reaches the bridge "ready" transition that feeds
# sandbox_spawn_duration, so this is the only spawn-phase signal for failures.
# Grouped so Step 2a can answer: are remaining spawn_deadline_no_object cases
# retry-exhausted, outside the retry path, or misclassified provider-latency vs
# bridge-startup. Log-derived metrics are not retroactive: tags exist from this
# apply forward.
resource "datadog_logs_metric" "sandbox_spawn_failures" {
  name = "arcanist.sandbox.spawn_failures"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @event:\"sandbox.spawn_failed\""
  }

  group_by {
    path     = "@phase"
    tag_name = "phase"
  }

  group_by {
    path     = "@spawn_retry_cap_reached"
    tag_name = "retry_cap_reached"
  }

  group_by {
    path     = "@spawn_path"
    tag_name = "spawn_path"
  }
}

# --- Resume-stopped-session (live-idle) dispatch observability ---
# All four are sourced from control-plane events direct-posted via
# postStructuredEventToDd (service:cycloid-control-plane, env:production,
# @_direct_post:true). NOT RETROACTIVE: series exist from this apply forward and
# only for logs carrying the field, so this file must deploy after PR-4's emit.

# Every prompt-admit decision, split by the path the prompt took to the agent.
# dispatch_path:live == straight to the kept-alive socket (the feature's happy
# path); warm == paused+resumed; cold == full respawn. runtime_backend rides the
# same event (PR-4).
resource "datadog_logs_metric" "sandbox_dispatch" {
  name = "arcanist.sandbox.dispatch"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"prompt_admit_decision\" @dispatch_path:*"
  }

  group_by {
    path     = "@dispatch_path"
    tag_name = "dispatch_path"
  }

  group_by {
    path     = "@runtime_backend"
    tag_name = "runtime_backend"
  }
}

# Stop -> dispatch latency for dispatches that follow a user soft-stop. Filtered on
# @resumed_after_stop:true (PR-4 captures host.isUserStopped() at enqueue entry,
# before the admit clear), so this metric's population IS the "after stop" set. Its
# per-dispatch_path sample count is the true post-stop path mix that the
# cold-after-stop monitor reads.
resource "datadog_logs_metric" "sandbox_resume_latency" {
  name = "arcanist.sandbox.resume_latency"

  compute {
    aggregation_type    = "distribution"
    path                = "@resume_latency_ms"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"prompt_admit_decision\" @resumed_after_stop:true"
  }

  group_by {
    path     = "@dispatch_path"
    tag_name = "dispatch_path"
  }

  group_by {
    path     = "@provider"
    tag_name = "provider"
  }
}

resource "datadog_logs_metric" "sandbox_resume_wall_ms" {
  name = "arcanist.sandbox.resume_wall_ms"

  compute {
    aggregation_type    = "distribution"
    path                = "@resume_wall_ms"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"sandbox.resume_wall\" @resume_wall_ms:*"
  }

  group_by {
    path     = "@outcome"
    tag_name = "outcome"
  }

  group_by {
    path     = "@runtime_backend"
    tag_name = "runtime_backend"
  }

  group_by {
    path     = "@operation"
    tag_name = "operation"
  }

  group_by {
    path     = "@error_class"
    tag_name = "error_class"
  }
}

resource "datadog_logs_metric" "sandbox_warm_trigger" {
  name = "arcanist.sandbox.warm_trigger"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"sandbox.warm_trigger\""
  }

  group_by {
    path     = "@trigger"
    tag_name = "trigger"
  }

  group_by {
    path     = "@outcome"
    tag_name = "outcome"
  }

  group_by {
    path     = "@runtime_backend"
    tag_name = "runtime_backend"
  }

  group_by {
    path     = "@sandboxStatus"
    tag_name = "sandbox_status"
  }

  group_by {
    path     = "@sandboxRuntimeState"
    tag_name = "sandbox_runtime_state"
  }

  group_by {
    path     = "@error_class"
    tag_name = "error_class"
  }
}

# One count per user manual stop that kept the sandbox live-idle instead of
# pausing (the feature firing). stop_reason:user scopes out any non-user soft
# stops; runtime_backend lets us see cost per backend.
resource "datadog_logs_metric" "sandbox_stop_kept_alive" {
  name = "arcanist.sandbox.stop_kept_alive"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"sandbox.stop_kept_alive\" @stop_reason:user"
  }

  group_by {
    path     = "@runtime_backend"
    tag_name = "runtime_backend"
  }
}

# How long a kept-alive VM stayed live-idle before the idle-pause boundary.
# resumed:true == the user came back and the VM resumed; resumed:false == a
# walk-away that paused. This is the spend/observability signal for decision #3
# (reuse the existing idle window). PR-4 emits @event:"sandbox.live_idle".
resource "datadog_logs_metric" "sandbox_live_idle_ms" {
  name = "arcanist.sandbox.live_idle_ms"

  compute {
    aggregation_type    = "distribution"
    path                = "@live_idle_ms"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"sandbox.live_idle\" @live_idle_ms:*"
  }

  group_by {
    path     = "@resumed"
    tag_name = "resumed"
  }

  group_by {
    path     = "@runtime_backend"
    tag_name = "runtime_backend"
  }
}

# Declare the time unit on the two duration metrics so widgets auto-scale
# (898000 ms -> "~15 min") instead of hand-typed "(ms)" labels -- required by
# docs/infrastructure.md. type="gauge" matches the repo's convention for
# distribution log-metrics (see cycloid.review_loop.*_ms, arcanist.plan_mode.duration).
resource "datadog_metric_metadata" "sandbox_resume_latency" {
  metric = "arcanist.sandbox.resume_latency"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "sandbox_resume_wall_ms" {
  metric = "arcanist.sandbox.resume_wall_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "sandbox_live_idle_ms" {
  metric = "arcanist.sandbox.live_idle_ms"
  type   = "gauge"
  unit   = "millisecond"
}

# Dashboard: sandbox spawn times
resource "datadog_dashboard" "sandbox_spawn" {
  title       = "Sandbox Spawn Times"
  description = "Tracks sandbox spawn duration across repos"
  layout_type = "ordered"

  # --- Row 1: summary cards ---

  widget {
    group_definition {
      title       = "Overview"
      layout_type = "ordered"

      widget {
        query_value_definition {
          title = "P50 spawn time (last 1h)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "p50:arcanist.sandbox.spawn_duration{*}"
              }
            }
            formula {
              formula_expression = "query1 / 1000"
            }
          }
          autoscale   = true
          precision   = 1
          text_align  = "center"
          custom_unit = "s"
        }
        widget_layout {
          x      = 0
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "P95 spawn time (last 1h)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "p95:arcanist.sandbox.spawn_duration{*}"
              }
            }
            formula {
              formula_expression = "query1 / 1000"
            }
          }
          autoscale   = true
          precision   = 1
          text_align  = "center"
          custom_unit = "s"
        }
        widget_layout {
          x      = 3
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "P99 spawn time (last 1h)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "p99:arcanist.sandbox.spawn_duration{*}"
              }
            }
            formula {
              formula_expression = "query1 / 1000"
            }
          }
          autoscale   = true
          precision   = 1
          text_align  = "center"
          custom_unit = "s"
        }
        widget_layout {
          x      = 6
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "Total spawns (last 1h)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "count:arcanist.sandbox.spawn_duration{*}.as_count()"
              }
            }
          }
          autoscale  = true
          precision  = 0
          text_align = "center"
        }
        widget_layout {
          x      = 9
          y      = 0
          width  = 3
          height = 2
        }
      }
    }
  }

  # --- Row 2: timeseries ---

  widget {
    timeseries_definition {
      title       = "Spawn duration over time (P50 / P95 / P99)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.spawn_duration{*}"
          }
        }
        formula {
          formula_expression = "p50 / 1000"
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
            query       = "p95:arcanist.sandbox.spawn_duration{*}"
          }
        }
        formula {
          formula_expression = "p95 / 1000"
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
            query       = "p99:arcanist.sandbox.spawn_duration{*}"
          }
        }
        formula {
          formula_expression = "p99 / 1000"
        }
        style {
          palette    = "orange"
          line_type  = "dotted"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "s"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Spawn duration by spawn_path (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.spawn_duration_by_path{*} by {spawn_path}"
          }
        }
        formula {
          formula_expression = "p50 / 1000"
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
            query       = "p95:arcanist.sandbox.spawn_duration_by_path{*} by {spawn_path}"
          }
        }
        formula {
          formula_expression = "p95 / 1000"
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "s"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Repo prep duration by path (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.repo_prep_ms{*} by {repo_prep_path}"
          }
        }
        formula {
          formula_expression = "p50 / 1000"
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
            query       = "p95:arcanist.sandbox.repo_prep_ms{*} by {repo_prep_path}"
          }
        }
        formula {
          formula_expression = "p95 / 1000"
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      yaxis {
        label        = "s"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  # --- Row 3: by repo ---

  widget {
    timeseries_definition {
      title       = "P95 spawn duration by repo"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.spawn_duration{*} by {repo}"
          }
        }
        formula {
          formula_expression = "query1 / 1000"
        }
      }

      yaxis {
        label        = "s"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 spawn duration by spawn path"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.spawn_duration{*} by {spawn_path}"
          }
        }
        formula {
          formula_expression = "query1 / 1000"
        }
      }

      yaxis {
        label        = "s"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "P95 spawn duration by runtime backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.spawn_duration{*} by {runtime_backend}"
          }
        }
        formula {
          formula_expression = "query1 / 1000"
        }
      }

      yaxis {
        label        = "s"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    toplist_definition {
      title = "Slowest repos by P95 spawn time"

      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.spawn_duration{*} by {repo}"
          }
        }
        formula {
          formula_expression = "query1 / 1000"
        }
      }
    }
  }

  # --- Row 4: spawn volume ---

  widget {
    timeseries_definition {
      title       = "Spawn count over time"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "count:arcanist.sandbox.spawn_duration{*}.as_count()"
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
      title       = "Spawn count by repo"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "count:arcanist.sandbox.spawn_duration{*} by {repo}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "E2B orphan sandboxes reaped per day"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.e2b.orphan_reaper.reaped_per_sweep{*}.rollup(sum, 86400)"
          }
        }
        style {
          palette = "warm"
        }
      }
    }
  }

  # --- Row 5: spawn failures ---

  widget {
    timeseries_definition {
      title       = "Spawn failures by phase"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.spawn_failures{*} by {phase}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Spawn failures by retry-exhausted"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.spawn_failures{*} by {retry_cap_reached}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Spawn failures by spawn path (warm/cold)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox.spawn_failures{*} by {spawn_path}.as_count()"
          }
        }
      }
    }
  }

  # --- Row 6: resume / live-idle (manual stop) ---

  widget {
    group_definition {
      title       = "Resume & live-idle (manual stop)"
      layout_type = "ordered"

      widget {
        query_value_definition {
          title = "Stops kept alive (last 1d)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "sum:arcanist.sandbox.stop_kept_alive{*}.as_count()"
              }
            }
          }
          autoscale  = true
          precision  = 0
          text_align = "center"
        }
        widget_layout {
          x      = 0
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "P50 resume latency (last 1d)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "p50:arcanist.sandbox.resume_latency{*}"
              }
            }
          }
          autoscale  = true
          precision  = 1
          text_align = "center"
        }
        widget_layout {
          x      = 3
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "P95 resume latency (last 1d)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "p95:arcanist.sandbox.resume_latency{*}"
              }
            }
          }
          autoscale  = true
          precision  = 1
          text_align = "center"
        }
        widget_layout {
          x      = 6
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "P95 live-idle window (last 1d)"
          request {
            query {
              metric_query {
                name        = "query1"
                data_source = "metrics"
                query       = "p95:arcanist.sandbox.live_idle_ms{*}"
              }
            }
          }
          autoscale  = true
          precision  = 1
          text_align = "center"
        }
        widget_layout {
          x      = 9
          y      = 0
          width  = 3
          height = 2
        }
      }

      widget {
        query_value_definition {
          title = "Warm reuse ratio (last 1d)"
          request {
            query {
              metric_query {
                name        = "warm"
                data_source = "metrics"
                query       = "count:arcanist.sandbox.resume_latency{dispatch_path:warm}.as_count()"
              }
            }
            query {
              metric_query {
                name        = "cold"
                data_source = "metrics"
                query       = "count:arcanist.sandbox.resume_latency{dispatch_path:cold}.as_count()"
              }
            }
            formula {
              formula_expression = "default_zero(warm / (warm + cold)) * 100"
            }
          }
          autoscale   = true
          precision   = 1
          text_align  = "center"
          custom_unit = "%"
        }
        widget_layout {
          x      = 0
          y      = 2
          width  = 3
          height = 2
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Dispatch path split (live / warm / cold)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
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
      title       = "Post-stop dispatch mix by path (resume dispatches only)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "count:arcanist.sandbox.resume_latency{*} by {dispatch_path}.as_count()"
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
      title       = "Resume latency by dispatch path (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.resume_latency{*} by {dispatch_path}"
          }
        }
        formula {
          formula_expression = "p50"
          alias              = "p50"
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
            query       = "p95:arcanist.sandbox.resume_latency{*} by {dispatch_path}"
          }
        }
        formula {
          formula_expression = "p95"
          alias              = "p95"
        }
        style {
          palette    = "warm"
          line_type  = "dashed"
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
      title       = "Live-idle window by resumed (P50 / P95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.sandbox.live_idle_ms{*} by {resumed}"
          }
        }
        formula {
          formula_expression = "p50"
          alias              = "p50"
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
            query       = "p95:arcanist.sandbox.live_idle_ms{*} by {resumed}"
          }
        }
        formula {
          formula_expression = "p95"
          alias              = "p95"
        }
        style {
          palette    = "purple"
          line_type  = "dashed"
          line_width = "normal"
        }
      }

      yaxis {
        include_zero = true
        scale        = "linear"
      }
    }
  }
}
