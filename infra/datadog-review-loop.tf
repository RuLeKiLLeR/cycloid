# --- Datadog: Review Loop (RLA) + QA Tester behavior ---
#
# Fleet-health view of how and why the Review Loop and QA Tester subsystems
# behave: convergence (settle rate, cap-blocks, oscillation), QA Tester
# quality (verdict mix, INCONCLUSIVE/exhaustion rates, runs-to-merge-ready),
# routing decisions, and efficiency (duration/epoch counts per settled PR).
#
# Log-derived metrics live in datadog-log-metrics.tf (the cycloid.review_loop.*
# and cycloid.qa_tester.* families). Monitor alerts + SLOs live in
# datadog-monitors.tf / datadog-review-loop-slos.tf. Tag-value filters use
# Datadog's lowercased tag values (e.g. verdict:inconclusive).

# Tag the QA Tester run duration metric as milliseconds so dashboard widgets use
# Datadog's time-unit scaling instead of hard-coded labels.
resource "datadog_metric_metadata" "qa_tester_run_duration" {
  metric = "arcanist.qa_tester.run_duration"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "review_loop_arrival_to_dispatch_ms" {
  metric = "arcanist.review_loop.arrival_to_dispatch_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "review_loop_arrival_to_first_op_ms" {
  metric = "arcanist.review_loop.arrival_to_first_op_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "review_loop_ready_to_claim_ms" {
  metric = "arcanist.review_loop.ready_to_claim_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_metric_metadata" "review_loop_ci_first_fail_to_dispatch_ms" {
  metric = "arcanist.review_loop.ci_first_fail_to_dispatch_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "pr_review_model_pairing" {
  title       = "PR Review Model Pairing"
  description = "Automatic Zeus review volume by author/reviewer backend pairing."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Zeus reviews by model pairing"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "pairing"
            data_source = "metrics"
            query       = "sum:arcanist.pr_review.trigger_model_pairing{env:production} by {model_pairing}.as_count()"
          }
        }
      }
    }
  }
}

resource "datadog_dashboard" "review_loop_verification" {
  title       = "Review Loop & QA Tester"
  description = "Review Loop and QA Tester fleet health: convergence, QA Tester quality, routing, and efficiency."
  layout_type = "ordered"

  # ---- Convergence -----------------------------------------------------------
  widget {
    query_value_definition {
      title = "Convergence · Loop settle rate (last 1d)"
      request {
        query {
          metric_query {
            name        = "completed"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.epoch_completed{terminal_status:completed}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "blocked_real"
            data_source = "metrics"
            # Only genuine convergence-failure caps count against settle rate (classified at emit time;
            # excludes head_changed restarts, productive truncation parks, teardown/disabled, and
            # operational failures).
            query = "sum:arcanist.review_loop.epoch_completed{convergence_failure:true}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(completed / (completed + blocked_real)) * 100"
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
      title       = "Convergence · Epoch terminal volume by status"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "by_status"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.epoch_completed{*} by {terminal_status}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Convergence · Cap-blocks by reason"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "blocks"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.epoch_completed{terminal_status:blocked} by {blocked_reason}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      # ARC-1244: budget-truncated carried tails that a foreign head change would otherwise have
      # stale-blocked (stranding the un-prompted feedback until a fresh bot re-review). The
      # head-change reconciler now re-keys them onto the new head as a re-driveable `ready` epoch
      # instead; a non-zero rate confirms the recovery path is firing in prod (the wedge it fixes is
      # an otherwise-silent "Waiting on" stall). Direct-post count metric (no log-derived definition).
      title       = "Convergence · Truncated tails recovered on head change (by repo)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "rekeyed"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.head_change_truncated_tail_rekeyed{*} by {repo}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Convergence · Time on settling head (last-head → settle, mins)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.review_loop.settled_duration{*}"
          }
        }
        formula {
          formula_expression = "p50 / 60000"
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.review_loop.settled_duration{*}"
          }
        }
        formula {
          formula_expression = "p90 / 60000"
        }
      }

      yaxis {
        label        = "min"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Convergence · Epochs per settled PR (p50/p90)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.review_loop.settled_epochs{*}"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.review_loop.settled_epochs{*}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Convergence · Epoch attempts p90 by source (oscillation)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "attempts_p90"
            data_source = "metrics"
            query       = "p90:arcanist.review_loop.epoch_attempts{*} by {source_kind}"
          }
        }
      }
    }
  }

  # ---- Immediacy -------------------------------------------------------------
  widget {
    query_value_definition {
      title = "Immediacy · Review-loop cold dispatch share"
      request {
        query {
          metric_query {
            name        = "cold"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.dispatch{dispatch_path:cold}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.dispatch{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(cold / total) * 100"
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
      title       = "Immediacy · Review-loop dispatch path mix"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "dispatch_mix"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.dispatch{*} by {dispatch_path,source_kind}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Immediacy · Arrival → dispatch latency (p50/p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.review_loop.arrival_to_dispatch_ms{*} by {source_kind,trigger}"
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
            query       = "p95:arcanist.review_loop.arrival_to_dispatch_ms{*} by {source_kind,trigger}"
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
      title       = "Immediacy · Arrival → first operation latency (p50/p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.review_loop.arrival_to_first_op_ms{*} by {source_kind,operation_kind}"
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
            query       = "p95:arcanist.review_loop.arrival_to_first_op_ms{*} by {source_kind,operation_kind}"
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
      title       = "Immediacy · Ready → claim queue wait (p50/p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.review_loop.ready_to_claim_ms{*} by {source_kind}"
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
            query       = "p95:arcanist.review_loop.ready_to_claim_ms{*} by {source_kind}"
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
      title       = "Immediacy · CI first failure → dispatch latency (p50/p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.review_loop.ci_first_fail_to_dispatch_ms{*} by {trigger}"
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
            query       = "p95:arcanist.review_loop.ci_first_fail_to_dispatch_ms{*} by {trigger}"
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
      title       = "Immediacy · Webhook ingest outcomes"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "outcomes"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.ingest_outcome{*} by {source_kind,outcome}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Immediacy · Ignored ingest reason mix (last 1d)"
      request {
        query {
          metric_query {
            name        = "ignored_reasons"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.ingest_outcome{outcome:ignored} by {source_kind,reason}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Immediacy · Ignored bot ingests by class/kind/bot (last 1d)"
      request {
        query {
          metric_query {
            name        = "ignored_bot_classes"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.ingest_outcome{source_kind:bot,outcome:ignored} by {ignored_class,webhook_kind,bot}.as_count()"
          }
        }
      }
    }
  }

  # ---- Triage (prompt synthesis) ---------------------------------------------
  # RLA v2 LLM triage (review-loop-triage.ts) synthesizes the worklist into action
  # items; on any failure it falls open to the deterministic whole-worklist prompt
  # (the bot/human/verification builders). A high fallback rate means the loop is
  # shipping the verbose whole-body prompt instead of the synthesized one. The
  # dominant fallback driver is `no_action_items` caused by triage referencing
  # sourceIds outside the candidate set (every such item is discarded — see the
  # "Discarded action items" widget). Unlike the epoch_completed/run_completed/settled
  # metrics above, arcanist.review_loop.triage carries an `env` tag, so these panels
  # scope to env:production to keep qa/local traffic out of the prod health view.
  widget {
    query_value_definition {
      title = "Triage · Fallback rate (last 1d)"
      request {
        query {
          metric_query {
            name        = "fallback"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.triage{outcome:fallback,env:production}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.triage{env:production}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(fallback / total) * 100"
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
      title       = "Triage · Volume by outcome"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "by_outcome"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.triage{env:production} by {outcome}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Triage · Fallback reason mix (last 1d)"
      request {
        query {
          metric_query {
            name        = "reasons"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.triage{outcome:fallback,env:production} by {reason}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      # Volume of action items triage produced that cite a sourceId NOT in the candidate set; the
      # validator (review-loop-triage.ts) discards each one, and an epoch with no surviving items
      # falls back with outcome `no_action_items`. This is the direct hallucinated-sourceId signal —
      # the count the candidate-id enum (shared/llm/prompt-preparation.ts) is meant to drive to zero.
      # NOT grouped by reason: that tag is the parent fallback reason, already broken out by the
      # "Fallback reason mix" toplist above.
      title       = "Triage · Discarded action items (hallucinated sourceIds)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "discarded"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.triage_discarded_action_items{env:production}.as_count()"
          }
        }
      }
    }
  }

  # ---- QA Tester quality -----------------------------------------------------
  widget {
    query_value_definition {
      title = "QA Tester · INCONCLUSIVE rate (last 1d)"
      request {
        query {
          metric_query {
            name        = "inconclusive"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.run_completed{verdict:inconclusive}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.run_completed{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(inconclusive / total) * 100"
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
      title = "QA Tester · Exhaustion rate (last 1d)"
      request {
        query {
          metric_query {
            name        = "exhausted"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.settled{final_state:verification-exhausted}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "settled_total"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.settled{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(exhausted / settled_total) * 100"
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
      title       = "QA Tester · Verdict and result volume"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "verdicts"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.run_completed{*} by {verdict,result}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "QA Tester · Runs to merge-ready (p50/p90)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.qa_tester.run_index{result:merge-ready}"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p90"
            data_source = "metrics"
            query       = "p90:arcanist.qa_tester.run_index{result:merge-ready}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "QA Tester · Run duration (p50/p95, mins)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.qa_tester.run_duration{*}"
          }
        }
        formula {
          formula_expression = "p50 / 60000"
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.qa_tester.run_duration{*}"
          }
        }
        formula {
          formula_expression = "p95 / 60000"
        }
      }

      yaxis {
        label        = "min"
        include_zero = true
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "QA Tester · Backend split"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "backends"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.run_completed{*} by {verifier_backend,parent_backend}.as_count()"
          }
        }
      }
    }
  }

  # ---- Verification phase pipeline ------------------------------------------
  widget {
    timeseries_definition {
      title       = "Phase pipeline · Route selected"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "routes"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.route_selected{*} by {route,agent_runtime_backend}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Phase pipeline · Completed vs failed phases"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "completed"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.phase_completed{*} by {phase,route}.as_count()"
          }
        }
        formula {
          formula_expression = "completed"
          alias              = "completed"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "failed"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.phase_failed{*} by {phase,reason_code}.as_count()"
          }
        }
        formula {
          formula_expression = "failed"
          alias              = "failed"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Phase pipeline · Mean output and handoff size"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "raw"
            data_source = "metrics"
            query       = "avg:arcanist.verification_phase.raw_output_chars{*} by {phase,route}"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "capped"
            data_source = "metrics"
            query       = "avg:arcanist.verification_phase.capped_output_chars{*} by {phase,route}"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "handoff"
            data_source = "metrics"
            query       = "avg:arcanist.verification_phase.handoff_chars{*} by {phase,route}"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "fallback_excerpt"
            data_source = "metrics"
            query       = "avg:arcanist.verification_phase.fallback_excerpt_chars{*} by {phase,route}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Phase pipeline · Handoff truncation and fallback"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "truncated"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.handoff_truncated{*} by {phase,route}.as_count()"
          }
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "fallback"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.fallback_excerpt_used{*} by {phase,route}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Phase pipeline · Terminal verdicts and skipped runs"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "terminal"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.pipeline_terminal{*} by {terminal_kind,verdict,route}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Phase pipeline · Judge repair outcomes (last 1d)"
      request {
        query {
          metric_query {
            name        = "repair"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.judge_repair{*} by {outcome,reason_code,route}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Proof quality · Evidence promotion and upload failures"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "promotion"
            data_source = "metrics"
            query       = "sum:arcanist.verification_phase.evidence_promotion{*} by {outcome,failure_reason_code}.as_count()"
          }
        }
        formula {
          formula_expression = "promotion"
          alias              = "promotion"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "upload_failed"
            data_source = "metrics"
            query       = "sum:arcanist.post_execution.artifacts_failed{*} by {agent_runtime_backend,model}"
          }
        }
        formula {
          formula_expression = "upload_failed"
          alias              = "upload failed"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Coordinator · Admission, duplicate, run cap, and spawn failures"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "admitted"
            data_source = "metrics"
            query       = "sum:arcanist.verification_coordinator.admission_claimed{*} by {source}.as_count()"
          }
        }
        formula {
          formula_expression = "admitted"
          alias              = "admitted"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "duplicate"
            data_source = "metrics"
            query       = "sum:arcanist.verification_coordinator.duplicate_returned{*} by {source}.as_count()"
          }
        }
        formula {
          formula_expression = "duplicate"
          alias              = "duplicate"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "run_limit"
            data_source = "metrics"
            query       = "sum:arcanist.verification_coordinator.run_limit_reached{*} by {source}.as_count()"
          }
        }
        formula {
          formula_expression = "run_limit"
          alias              = "run cap"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "spawn_failed"
            data_source = "metrics"
            query       = "sum:arcanist.verification_coordinator.spawn_failed{*} by {source,reason,failure_stage}.as_count()"
          }
        }
        formula {
          formula_expression = "spawn_failed"
          alias              = "spawn failed"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Coordinator · Verification gate fail-open"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "fail_open"
            data_source = "metrics"
            query       = "sum:arcanist.verification_gate.fail_open{*} by {gate}.as_count()"
          }
        }
      }
    }
  }

  # ---- Routing ---------------------------------------------------------------
  widget {
    query_value_definition {
      title = "Routing · Verify rate (needs_verification, last 1d)"
      request {
        query {
          metric_query {
            name        = "verify"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.routing_decided{needs_verification:true}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.routing_decided{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(verify / total) * 100"
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
      title = "Routing · Fail-closed rate (last 1d)"
      request {
        query {
          metric_query {
            name        = "fail_closed"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.routing_decided{fail_closed:true}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.routing_decided{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(fail_closed / total) * 100"
        }
      }
      autoscale   = true
      precision   = 1
      text_align  = "center"
      custom_unit = "%"
    }
  }

  widget {
    toplist_definition {
      title = "Routing · Reason-code mix (last 1d)"
      request {
        query {
          metric_query {
            name        = "reasons"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.routing_decided{*} by {verification_reason_code}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Routing · App-runtime split"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "app_runtime"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester.routing_decided{*} by {needs_app_runtime}.as_count()"
          }
        }
      }
    }
  }

  # ---- Efficiency / settle outcomes ------------------------------------------
  widget {
    timeseries_definition {
      title       = "Efficiency · Settle outcome volume by final_state"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "final_states"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.settled{*} by {final_state}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Efficiency · Settle schedule reasons (last 1d)"
      request {
        query {
          metric_query {
            name        = "schedule_reasons"
            data_source = "metrics"
            query       = "sum:arcanist.review_loop.settled{*} by {schedule_reason}.as_count()"
          }
        }
      }
    }
  }

  # ARC-1273: QA Tester liveness watchdog. Terminalize is the count of PRs whose
  # interrupted-verifier state we reconciled; lock-read-failed is the fail-closed defer rate;
  # teardown-step-failed is the partial-teardown signal (terminalize fired but a sub-step
  # — comment/stage/lock-release — failed, leaving a leaked lock); rearm is the watchdog
  # re-extending against a live lock (a verifier rerun) — normal once per rerun, but a
  # sustained recurring rearm for one PR is the stuck-verifier canary. Watch terminalize during
  # rollout — it should track real host-death incidents, not spike against live sessions
  # (the false-reap that got the rejected v1 timestamp sweep removed).
  widget {
    timeseries_definition {
      title       = "Server-death teardown · QA Tester liveness watchdog (ARC-1273)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "terminalize"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester_liveness.terminalize{*}.as_count()"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "lock_read_failed"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester_liveness.lock_read_failed{*}.as_count()"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "teardown_step_failed"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester_teardown.step_failed{*}.as_count()"
          }
        }
      }
      request {
        display_type = "line"
        query {
          metric_query {
            name        = "rearm"
            data_source = "metrics"
            query       = "sum:arcanist.qa_tester_liveness.rearm{*}.as_count()"
          }
        }
      }
    }
  }
}
