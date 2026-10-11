# Verification reliability: total-session budget, real useful activity, bridge
# liveness, and in-sandbox resource pressure. Session/sandbox ids intentionally
# stay in structured logs; custom metric tags remain bounded to repo/business or
# small enums.

resource "datadog_metric_metadata" "prompt_useful_activity_age_ms" {
  metric = "arcanist.prompt.useful_activity_age_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "prompt_waiting_elapsed_ms" {
  metric = "arcanist.prompt.waiting_elapsed_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "bridge_heartbeat_stall_ms" {
  metric = "arcanist.bridge.heartbeat_stall_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "sandbox_disconnect_recovery_elapsed_ms" {
  metric = "arcanist.sandbox.disconnect_recovery_elapsed_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "sandbox_disconnect_recovery_deadline_overdue_ms" {
  metric = "arcanist.sandbox.disconnect_recovery_deadline_overdue_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "sandbox_heartbeat_age_at_recovery_ms" {
  metric = "arcanist.sandbox.heartbeat_age_at_recovery_ms"
  type   = "gauge"
  unit   = "millisecond"
}

locals {
  sandbox_resource_metric_metadata = {
    memory_used_bytes = {
      metric = "arcanist.sandbox.memory.used_bytes"
      unit   = "byte"
    }
    swap_used_bytes = {
      metric = "arcanist.sandbox.swap.used_bytes"
      unit   = "byte"
    }
    disk_used_bytes = {
      metric = "arcanist.sandbox.disk.used_bytes"
      unit   = "byte"
    }
    disk_avail_bytes = {
      metric = "arcanist.sandbox.disk.avail_bytes"
      unit   = "byte"
    }
    pids_current = {
      metric = "arcanist.sandbox.pids.current"
      unit   = "process"
    }
    pids_limit = {
      metric = "arcanist.sandbox.pids.limit"
      unit   = "process"
    }
    memory_used_percent = {
      metric = "arcanist.sandbox.memory.used_percent"
      unit   = "percent"
    }
    cpu_used_percent = {
      metric = "arcanist.sandbox.cpu.used_percent"
      unit   = "percent"
    }
    cpu_throttled_periods_percent = {
      metric = "arcanist.sandbox.cpu.throttled_periods_percent"
      unit   = "percent"
    }
    cpu_pressure_avg10 = {
      metric = "arcanist.sandbox.cpu.pressure_avg10"
      unit   = "percent"
    }
    memory_pressure_avg10 = {
      metric = "arcanist.sandbox.memory.pressure_avg10"
      unit   = "percent"
    }
    pids_used_percent = {
      metric = "arcanist.sandbox.pids.used_percent"
      unit   = "percent"
    }
    memory_high_events_delta = {
      metric = "arcanist.sandbox.memory.high_events_delta"
      unit   = "event"
    }
    memory_oom_events_delta = {
      metric = "arcanist.sandbox.memory.oom_events_delta"
      unit   = "event"
    }
    memory_oom_kill_events_delta = {
      metric = "arcanist.sandbox.memory.oom_kill_events_delta"
      unit   = "event"
    }
    pids_max_events_delta = {
      metric = "arcanist.sandbox.pids.max_events_delta"
      unit   = "event"
    }
  }
}

resource "datadog_metric_metadata" "sandbox_resource" {
  for_each = local.sandbox_resource_metric_metadata

  metric = each.value.metric
  type   = "gauge"
  unit   = each.value.unit
}

resource "datadog_dashboard" "verification_session_reliability" {
  title       = "Verification Session Reliability"
  description = "Ten-minute completion budget, useful-vs-passive activity, sandbox liveness, desktop startup, and resource pressure. Use structured logs for exact session ids."
  layout_type = "ordered"

  widget {
    query_value_definition {
      title = "Oldest live verifier"
      request {
        query {
          metric_query {
            name        = "age"
            data_source = "metrics"
            query       = "max:arcanist.verification.session_age_oldest_ms{env:production,agent_role:verification}"
          }
        }
      }
      autoscale  = true
      precision  = 1
      text_align = "center"
    }
  }

  widget {
    timeseries_definition {
      title       = "Useful activity age while waiting"
      show_legend = true
      request {
        query {
          metric_query {
            name        = "age"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.useful_activity_age_ms{*} by {active_tool_call,last_useful_event_type}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Bridge heartbeat event-loop stalls"
      show_legend = true
      request {
        query {
          metric_query {
            name        = "stall"
            data_source = "metrics"
            query       = "p95:arcanist.bridge.heartbeat_stall_ms{*} by {prompt_in_flight}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Bridge reconnect / DO liveness outcomes"
      show_legend = true
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "reconnects"
            data_source = "metrics"
            query       = "sum:arcanist.bridge.reconnects{*} by {reconnect_reason,connect_error_class}.as_count()"
          }
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "do_liveness"
            data_source = "metrics"
            query       = "sum:arcanist.bridge.do_liveness_failures{*} by {watchdog_reason}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Disconnect detection to recovery decision"
      show_legend = true
      request {
        query {
          metric_query {
            name        = "elapsed"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.disconnect_recovery_elapsed_ms{*} by {event,lane,active_tool_call}"
          }
        }
      }
      request {
        query {
          metric_query {
            name        = "overdue"
            data_source = "metrics"
            query       = "p95:arcanist.sandbox.disconnect_recovery_deadline_overdue_ms{*} by {event,lane}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Lazy desktop start / readiness latency"
      show_legend = true
      request {
        query {
          metric_query {
            name        = "wait"
            data_source = "metrics"
            query       = "p95:arcanist.desktop.readiness_wait_ms{*} by {readiness_outcome,lazy_start_requested,health_check_mode}"
          }
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "outcome"
            data_source = "metrics"
            query       = "sum:arcanist.desktop.readiness_events{*} by {readiness_outcome,lazy_start_requested,health_check_mode}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Sandbox memory / CPU pressure by repo"
      show_legend = true
      request {
        query {
          metric_query {
            name        = "memory"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.memory.used_percent{env:production} by {repo_owner,repo_name}"
          }
        }
      }
      request {
        query {
          metric_query {
            name        = "cpu"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.cpu.used_percent{env:production} by {repo_owner,repo_name}"
          }
        }
      }
      request {
        query {
          metric_query {
            name        = "throttled"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.cpu.throttled_periods_percent{env:production} by {repo_owner,repo_name}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Sandbox PID pressure by repo"
      show_legend = true
      request {
        query {
          metric_query {
            name        = "pids"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.pids.used_percent{env:production} by {repo_owner,repo_name}"
          }
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "max_events"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.pids.max_events_delta{env:production} by {repo_owner,repo_name}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Kernel memory events by repo"
      show_legend = true
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "high"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.memory.high_events_delta{env:production} by {repo_owner,repo_name}"
          }
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "oom"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.memory.oom_events_delta{env:production} by {repo_owner,repo_name}"
          }
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "oom_kill"
            data_source = "metrics"
            query       = "max:arcanist.sandbox.memory.oom_kill_events_delta{env:production} by {repo_owner,repo_name}"
          }
        }
      }
    }
  }
}

module "datadog_verification_reliability_monitors" {
  source = "./modules/datadog-monitor"

  metric_alerts = {
    sandbox_disconnect_recovery_over_budget = {
      name            = "[Sandbox] Disconnect recovery decision exceeded 60-second budget"
      query           = "max(last_15m):max:arcanist.sandbox.disconnect_recovery_elapsed_ms{event:sandbox_disconnect_terminalize_confirmed} > 75000"
      warning         = 60000
      critical        = 75000
      on_missing_data = "resolve"
      validate        = false
      message         = <<-EOT
        A sandbox loss took more than 75 seconds from its last proven bridge heartbeat to the terminal recovery decision that retries or fails the prompt. The warning begins at the 60-second budget; 15 seconds of critical tolerance covers normal alarm scheduling jitter, not provider-probe delay.

        Open the Verification Session Reliability dashboard and split `arcanist.sandbox.disconnect_recovery_elapsed_ms` by lane/active_tool_call. Search `@event:sandbox_disconnect_terminalize_confirmed` for the exact session, `recoveryDeadlineOverdueMs`, heartbeat age, provider liveness result, and active-tool state.
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags            = ["service:cycloid-control-plane", "component:sandbox-liveness", "slo:disconnect-recovery"]
    }
  }
}
