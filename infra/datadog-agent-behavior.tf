# --- Datadog: Agent behavior and post-execution visibility ---

# Log-derived metrics live in datadog-log-metrics.tf.
# Monitor alerts live in datadog-monitors.tf.

resource "datadog_dashboard" "agent_behavior" {
  title       = "Agent Behavior"
  description = "Prompt behavioral signals for intervention, context pressure, and verification gaps."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Prompt behavioral shape"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "tool_calls"
            data_source = "metrics"
            query       = "avg:arcanist.prompt.behavior_tool_calls{*}"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "questions"
            data_source = "metrics"
            query       = "avg:arcanist.prompt.behavior_questions{*}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Context pressure and intervention signals"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "context_pressure"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_context_pressure{*}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "questions_asked"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_questions_asked{*}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "handled_automatically"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_handled_automatically{*}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Behavioral gaps"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "verification_gap"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_verification_gap{*}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "functional_check_gap"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_functional_check_gap{*}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Execution quality guardrails"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "first_turn_errors"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_first_turn_errors{*} by {agent_runtime_backend,error_code}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "start_timeouts"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_start_timeouts{*} by {agent_runtime_backend}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "empty_completions"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_empty_completions{*} by {agent_runtime_backend}.as_count()"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95_retry_count"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.behavior_retry_count{*} by {agent_runtime_backend,outcome}"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "no_repo_progress"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_no_repo_progress{*} by {agent_runtime_backend}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Plan mode events and duration"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "events"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.events{*} by {plan_event,valid,reason}.as_count()"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95_duration"
            data_source = "metrics"
            query       = "p95:arcanist.plan_mode.duration{*}"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "hygiene_violation"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.worktree_hygiene_violation{*} by {reset}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Plan-mode clarification rate"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "questions"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_questions_asked{agent:plan}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "plan_prompts"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_completions{agent:plan}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(questions / plan_prompts) * 100"
          alias              = "plan prompts asking a question"
        }
      }

      yaxis {
        label        = "%"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Auto plan-mode decision rates"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "plan_needed"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.auto_decision{plan_needed:true}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "null_fallback"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.auto_decision{null_fallback:true}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "decisions"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.auto_decision{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(plan_needed / decisions) * 100"
          alias              = "auto decisions choosing plan"
        }
        formula {
          formula_expression = "default_zero(null_fallback / decisions) * 100"
          alias              = "auto decisions using null fallback"
        }
      }

      yaxis {
        label        = "%"
        include_zero = true
        max          = "100"
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Plan mode approval gate"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "parked"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.events{plan_event:arcanist.plan_mode.parked}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "approved"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.events{plan_event:arcanist.plan_mode.approved}.as_count()"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95_time_to_approval"
            data_source = "metrics"
            query       = "p95:arcanist.plan_mode.time_to_approval{*}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Plan mode research reuse ops"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "discovery_ops"
            data_source = "metrics"
            query       = "avg:arcanist.plan_mode.research_reuse.discovery_ops{*} by {backend,outcome}"
          }
        }
        query {
          metric_query {
            name        = "read_ops"
            data_source = "metrics"
            query       = "avg:arcanist.plan_mode.research_reuse.read_ops{*} by {backend,outcome}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Plan mode handoff diagnosis"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "truncated"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.research_reuse.events{excerpt_truncated:true}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "all_reuse"
            data_source = "metrics"
            query       = "sum:arcanist.plan_mode.research_reuse.events{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "p95_implementation_duration"
            data_source = "metrics"
            query       = "p95:arcanist.plan_mode.research_reuse.duration{*} by {backend,outcome}"
          }
        }
        query {
          metric_query {
            name        = "plan_files_touched"
            data_source = "metrics"
            query       = "avg:arcanist.plan_mode.research_reuse.plan_files_touched{*} by {backend,outcome}"
          }
        }
        formula {
          formula_expression = "default_zero(truncated / all_reuse)"
          alias              = "excerpt truncation rate"
        }
        formula {
          formula_expression = "p95_implementation_duration"
          alias              = "p95 implement-turn duration"
        }
        formula {
          formula_expression = "plan_files_touched"
          alias              = "avg plan files touched"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Bash-shelled search tool choice"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "grep"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_grep_search_commands{*}"
          }
        }
        query {
          metric_query {
            name        = "ripgrep"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.behavior_ripgrep_search_commands{*}"
          }
        }
        formula {
          formula_expression = "default_zero(grep / (grep + ripgrep))"
          alias              = "grep share of bash-shelled searches"
        }
        formula {
          formula_expression = "grep"
          alias              = "grep commands"
        }
        formula {
          formula_expression = "ripgrep"
          alias              = "ripgrep commands"
        }
      }
    }
  }
}

resource "datadog_dashboard" "child_session_spawning" {
  title       = "Child Session Spawning"
  description = "Spawn-child-session tool calls, outcomes, and per-prompt fan-out distribution."
  layout_type = "ordered"

  widget {
    query_value_definition {
      title = "Spawn calls (last 1h)"
      request {
        query {
          metric_query {
            name        = "calls"
            data_source = "metrics"
            query       = "sum:arcanist.spawn_child_session.calls{surface:control_plane}.as_count()"
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
      title = "Spawn success rate (last 1h)"
      request {
        query {
          metric_query {
            name        = "success"
            data_source = "metrics"
            query       = "sum:arcanist.spawn_child_session.calls{surface:control_plane,outcome:success}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "replay"
            data_source = "metrics"
            query       = "sum:arcanist.spawn_child_session.calls{surface:control_plane,outcome:replay}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.spawn_child_session.calls{surface:control_plane}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero((success + replay) / total) * 100"
        }
      }
      autoscale   = true
      precision   = 1
      text_align  = "center"
      custom_unit = "%"
    }
  }

  widget {
    timeseries_definition {
      title       = "Spawn outcomes by surface"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "outcomes"
            data_source = "metrics"
            query       = "sum:arcanist.spawn_child_session.calls{*} by {surface,outcome,error_code}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Per-prompt child count after create"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.spawn_child_session.per_prompt_count{*}"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.spawn_child_session.per_prompt_count{*}"
          }
        }
      }

      yaxis {
        label        = "children"
        include_zero = true
        scale        = "linear"
      }
    }
  }
}

resource "datadog_dashboard" "post_execution_behavior" {
  title       = "Post-Execution and PR Pipeline"
  description = "Post-prompt git/verification/summary pipeline outcomes and latency. The platform-LLM stale-prior publish-window widget is a diagnostic baseline only: the raw fingerprint can include benign no-diff sessions, so page only on a future loss-only predicate."
  layout_type = "ordered"

  widget {
    query_value_definition {
      title = "Post-exec completions (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.completions{*}.as_count()"
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
      title = "Post-exec errors (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.completions{outcome:error}.as_count()"
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
      title = "P95 post-exec duration (last 1h)"
      request {
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "p95:arcanist.post_execution.duration{*}"
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
  }

  widget {
    query_value_definition {
      title = "LLM timeout rate (last 1h)"
      request {
        query {
          metric_query {
            name        = "timeouts"
            data_source = "metrics"
            query       = "sum:arcanist.llm_call.timeouts{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.llm_call.completions{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(timeouts / total) * 100"
        }
      }
      autoscale   = true
      precision   = 1
      text_align  = "center"
      custom_unit = "%"
    }
  }

  widget {
    timeseries_definition {
      title       = "Post-exec outcome volume"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "query1"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.completions{*} by {outcome,has_changes,no_change_reason}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Stale publish-window status refusals"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "stale_publish_window"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_state.platform_llm_prompt_status_refused{reason:stale_prior,target_status:post_execution_pending} by {observed_status}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "LLM timeout rate by call type"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "timeouts"
            data_source = "metrics"
            query       = "sum:arcanist.llm_call.timeouts{*} by {call_type}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.llm_call.completions{*} by {call_type}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(timeouts / total) * 100"
        }
      }

      yaxis {
        label        = "%"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "LLM call duration by call type"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.llm_call.duration{*} by {call_type}"
          }
        }
        formula {
          formula_expression = "p95 / 1000"
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p99"
            data_source = "metrics"
            query       = "p99:arcanist.llm_call.duration{*} by {call_type}"
          }
        }
        formula {
          formula_expression = "p99 / 1000"
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
      title       = "Post-exec duration by publish mode"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.post_execution.duration{*} by {publish_mode}"
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
            query       = "p95:arcanist.post_execution.duration{*} by {publish_mode}"
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
      title       = "Runtime evidence and verification gates"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "runtime_evidence_required"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.runtime_evidence_required{*}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "publish_mode"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.completions{*} by {publish_mode}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "publish_verdict"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.publish_mode{*} by {publish_mode,verdict}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Post-exec artifact gaps"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "missing_git_ref"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.missing_git_ref{*}.as_count()"
          }
        }
      }

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "summary_generation_gap"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.summary_generation_gap{*}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Triggered PR reviews"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "outcomes"
            data_source = "metrics"
            query       = "sum:arcanist.pr_review.trigger{*} by {outcome}.as_count()"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "publish_latency"
            data_source = "metrics"
            query       = "p95:arcanist.pr_review.trigger_to_published_ms{*} by {outcome}"
          }
        }
      }
    }
  }
}
