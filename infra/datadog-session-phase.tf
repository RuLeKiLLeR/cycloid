# --- Datadog: Session phase observability ---
#
# Backs the `arcanist.session.phase.transition` count metric emitted from the
# control-plane DO when computePhase resolves a new phase. Tags carried with
# every point: env, previous_phase, next_phase, sandbox_substate,
# finalizing_step, stop_mode, cause, agent_runtime_backend.
#
# `arcanist.session.phase.drift` is emitted when the persisted
# `session_index.rich_status` projection disagrees with the phase the DO
# re-derives from its live inputs (DO restart / lagged projection). Tags:
# env, persisted_phase, derived_phase.

resource "datadog_dashboard" "session_phase" {
  title       = "Session Phase"
  description = "Distribution and transition rate of computePhase outcomes across the control plane."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title = "Phase transitions by next phase (per minute)"
      request {
        formula {
          formula_expression = "query1"
        }
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase.transition{service:cycloid-control-plane} by {next_phase}.as_rate()"
          }
        }
        display_type = "bars"
      }
      show_legend = true
    }
  }

  widget {
    timeseries_definition {
      title = "Phase transitions by cause"
      request {
        formula {
          formula_expression = "query1"
        }
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase.transition{service:cycloid-control-plane} by {cause}.as_rate()"
          }
        }
        display_type = "line"
      }
      show_legend = true
    }
  }

  widget {
    toplist_definition {
      title = "Top previous → next phase pairs (last 1h)"
      request {
        formula {
          formula_expression = "query1"
          limit {
            count = 25
            order = "desc"
          }
        }
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase.transition{service:cycloid-control-plane} by {previous_phase,next_phase}.as_count()"
          }
        }
      }
    }
  }

  widget {
    query_value_definition {
      title = "Failed terminal transitions (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase.transition{service:cycloid-control-plane,next_phase:failed}.as_count()"
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
      title = "Blocked terminal transitions (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase.transition{service:cycloid-control-plane,next_phase:blocked}.as_count()"
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
      title       = "Completed session active duration"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.session.active_duration{*} by {terminal_stage}"
          }
        }
        formula {
          formula_expression = "p50 / 1000"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.session.active_duration{*} by {terminal_stage}"
          }
        }
        formula {
          formula_expression = "p95 / 1000"
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
      title = "Phase drift counter"
      request {
        formula {
          formula_expression = "query1"
        }
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase.drift{service:cycloid-control-plane} by {persisted_phase,derived_phase}.as_count()"
          }
        }
        display_type = "line"
      }
      show_legend = true
    }
  }

  widget {
    timeseries_definition {
      title = "Phase reaper outcomes"
      request {
        formula {
          formula_expression = "query1"
        }
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.session.phase_reaper{service:cycloid-control-plane} by {outcome,reason}.as_count()"
          }
        }
        display_type = "bars"
      }
      show_legend = true
    }
  }
}

module "datadog_session_phase_monitors" {
  source = "./modules/datadog-monitor"

  metric_alerts = {
    session_phase_failed_spike = {
      name     = "[Sessions] failed terminal phase spike"
      query    = "sum(last_15m):sum:arcanist.session.phase.transition{service:cycloid-control-plane,next_phase:failed,env:production}.as_count() > 20"
      warning  = 10
      critical = 20
      message  = <<-EOT
        Spike in sessions transitioning to phase=failed over the last 15 minutes.

        Likely cause: a deploy regression in the publish path or a verification gate flipping closed. Check the Session Phase dashboard, recent deploys, and Sentry for control-plane errors.
        ${var.datadog_slack_handle}
        {{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}
        {{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}
      EOT
      tags     = ["service:cycloid-control-plane", "component:session-phase"]
    }

    session_phase_blocked_spike = {
      name     = "[Sessions] blocked terminal phase spike"
      query    = "sum(last_15m):sum:arcanist.session.phase.transition{service:cycloid-control-plane,next_phase:blocked,env:production}.as_count() > 20"
      warning  = 10
      critical = 20
      message  = <<-EOT
        Spike in sessions transitioning to phase=blocked (verification-failed) over the last 15 minutes.

        Likely cause: a deploy regression in the verification path or a strict gate that should be relaxed. Check the Session Phase dashboard and the most recent verification failures.
        ${var.datadog_slack_handle}
      EOT
      tags     = ["service:cycloid-control-plane", "component:session-phase"]
    }

    session_phase_drift_observed = {
      name     = "[Sessions] phase projection drift observed"
      query    = "sum(last_15m):sum:arcanist.session.phase.drift{service:cycloid-control-plane,env:production}.as_count() > 0"
      critical = 0
      message  = <<-EOT
        The session_index.rich_status projection disagreed with the DO's re-derived phase. Drift counters should be zero in steady state — investigate the DO state vs D1 column for the tagged sessions.
        ${var.datadog_slack_handle}
      EOT
      tags     = ["service:cycloid-control-plane", "component:session-phase"]
    }
  }
}
