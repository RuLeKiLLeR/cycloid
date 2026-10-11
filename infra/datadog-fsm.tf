# --- Datadog: Lifecycle FSM (ARC-1330) dashboard ---
#
# The permanent post-flip soak/observability dashboard. Its live instruments are the W11-G1/G4
# metrics (fsm_transition / fsm_stage_dwell / fsm_commit_latency / fsm.sideeffect.* / arcanist.fsm.parity)
# emitted by the spine + the parity checker.
#
# RETIRED (D-60): the `arcanist.fsm.divergence` shadow-rollout metric + its `fsm_divergence_rate` monitor
# were removed (the shadow/divergence scaffolding is gone; the flip is complete). The closeout (ARC-1330
# Wave 11) then dropped the flip-gate / attribution / cohort / genesis-divergence widgets that queried that
# now-absent metric and read empty. Only the permanent post-flip instruments remain.
#
resource "datadog_metric_metadata" "fsm_stage_dwell_ms" {
  metric = "arcanist.fsm.stage_dwell_ms"
  type   = "gauge"
  unit   = "millisecond"
}

# ARC-1330 W11-G4 — producer→spine commit latency (log-metric in datadog-log-metrics.tf).
resource "datadog_metric_metadata" "fsm_commit_latency_ms" {
  metric = "arcanist.fsm.commit_latency_ms"
  type   = "gauge"
  unit   = "millisecond"
}

resource "datadog_dashboard" "lifecycle_fsm" {
  title       = "Lifecycle FSM (ARC-1330)"
  description = "FSM lifecycle health: the W11-G1 post-flip soak instruments — side-effect sink failures, unhandled-event facet, non-tautological GitHub/verifier parity, and the volume floor — plus committed transition volume, stage dwell latency, and producer→spine commit latency."
  layout_type = "ordered"

  # ---- Transition timeline ---------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Timeline · Committed transitions by stage edge"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "stage_edges"
            data_source = "metrics"
            # Exclude BOTH noop facets (W11-G1 split `unhandled`/`no_record`) so a no-op never counts as a
            # committed transition here.
            query = "sum:arcanist.fsm.transition{!noop:unhandled,!noop:no_record} by {stage_from,stage_to}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Timeline · Stage dwell latency (p50/p95)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.fsm.stage_dwell_ms{*} by {stage}"
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
            query       = "p95:arcanist.fsm.stage_dwell_ms{*} by {stage}"
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
    toplist_definition {
      title = "Timeline · Event mix (last 1d)"
      request {
        query {
          metric_query {
            name        = "events"
            data_source = "metrics"
            # Both noop facets excluded (W11-G1) — committed transitions only.
            query = "sum:arcanist.fsm.transition{!noop:unhandled,!noop:no_record} by {fsm_event}.as_count()"
          }
        }
      }
    }
  }

  # W11-G1 facet split: `noop` now carries two values — `unhandled` (event hit an existing row with no
  # edge, a producer/edge bug) and `no_record` (event for a session with no spine row yet, backfill gap).
  # `{noop:*}` selects only the no-op points (committed transitions carry no `noop` tag), split by kind.
  widget {
    toplist_definition {
      title = "Noop events · by kind (unhandled / no_record, last 1d)"
      request {
        query {
          metric_query {
            name        = "noops"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.transition{noop:*} by {noop,from,fsm_event}.as_count()"
          }
        }
      }
    }
  }

  # ---- review_stuck CI-drop watch (PR #6667) ---------------------------------
  # Measures the Codex-flagged risk of lowering REVIEW_STUCK_DEADLINE_MS 24h→4h: a caught-up PR waiting only
  # on pending CI can trip `review_stuck` at 4h, and a later `ci.signal(green)` is UNHANDLED in NEEDS_YOU —
  # the NEEDS_YOU arm reopens only on an actionable review / push / retrigger (transition.ts), never on a CI
  # signal — so a slow-but-real CI loses its auto-settle path and stays loudly blocked until a human acts.
  # This widget counts CI signals dropped while blocked so we can decide, on evidence, whether to build the
  # durable fix: a guarded `ci.signal(green) → REVIEW` reopen edge (which makes ANY window safe). Measurement
  # only — deliberately NO `@slack` monitor, so it never pages per-occurrence.
  #
  # SUPERSET CAVEAT: the `fsm.transition` log-metric carries {noop, from, fsm_event} but NOT `blocked_reason`
  # or the green|failing signal polarity. So this counts ci.signal drops across ALL NEEDS_YOU blocks (incl.
  # `verification_stopped` / `owner_approval`, where dropping is correct) and BOTH polarities. The `by {from}`
  # split isolates NEEDS_YOU; if that bar reads non-trivial, add `blocked_reason` + a signal-bucket tag to
  # `emitNoopEvent` to narrow to the exact green-in-`review_stuck` harm before acting.
  widget {
    timeseries_definition {
      title       = "review_stuck watch · ci.signal dropped while blocked, by from-state (superset; PR #6667)"
      show_legend = true
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "ci_signal_dropped_blocked"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.transition{noop:unhandled,fsm_event:ci.signal} by {from}.as_count()"
          }
        }
      }
    }
  }

  # ---- Volume floor (empty-metric ≠ GO) --------------------------------------
  # W11-G1 gate signal #3. A "clean" failure monitor + a "flat" unhandled rate mean nothing if the FSM is
  # not actually driving live sessions (the empty-metric-reads-as-GO trap). This is the throughput proof:
  # committed transitions over the window MUST be non-zero for a soak day to count. Read alongside the
  # side-effect and parity volumes below — if any read zero, the instrument is dark, not clean.
  widget {
    query_value_definition {
      title = "Volume floor · Committed transitions (last 1d) — MUST be non-zero"
      request {
        query {
          metric_query {
            name        = "committed"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.transition{!noop:unhandled,!noop:no_record}.as_count()"
          }
        }
        formula {
          formula_expression = "committed"
        }
        conditional_formats {
          comparator = "<="
          value      = 0
          palette    = "white_on_red"
        }
        conditional_formats {
          comparator = ">"
          value      = 0
          palette    = "white_on_green"
        }
      }
      autoscale  = true
      precision  = 0
      text_align = "center"
    }
  }

  widget {
    timeseries_definition {
      title       = "Volume floor · Side-effect + parity check volume (last 1d)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "sideeffects"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.sideeffect.skipped{*}.as_count()"
          }
        }
        formula {
          formula_expression = "sideeffects"
          alias              = "side-effects (skipped)"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "parity_checks"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.parity{*}.as_count()"
          }
        }
        formula {
          formula_expression = "parity_checks"
          alias              = "parity checks"
        }
      }
    }
  }

  # ---- Side effects (post-flip live sink health) -----------------------------
  # W11-G1 gate signal #1. `failed`/`sink_failed` are the true-error signals (baseline ~0; monitor:
  # fsm_sideeffect_failure_rate). `skipped`/`redelivered` are expected-noisy context — the 85% skip is
  # `epoch_row_not_materialized_legacy_owns_dispatch` and D17 redelivers against the report-only executor;
  # both baselines STEP DOWN when W11-V5 transfers epoch authority (annotate the drop when it lands).
  widget {
    timeseries_definition {
      title       = "Side effects · Failures (failed + sink_failed) — baseline ~0"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "failed"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.sideeffect.failed{*} by {kind}.as_count()"
          }
        }
        formula {
          formula_expression = "failed"
        }
      }
      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "sink_failed"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.sideeffect.sink_failed{*} by {sink}.as_count()"
          }
        }
        formula {
          formula_expression = "sink_failed"
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Side effects · Skips by reason (W11-V5 steps this down)"
      request {
        query {
          metric_query {
            name        = "skipped_by_reason"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.sideeffect.skipped{*} by {reason}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Side effects · D17 redeliveries by kind (W11-V5 steps this down)"
      request {
        query {
          metric_query {
            name        = "redelivered_by_kind"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.sideeffect.redelivered{*} by {kind}.as_count()"
          }
        }
      }
    }
  }

  # ---- Parity (legacy-INDEPENDENT ground truth) ------------------------------
  # W11-G1's non-tautological check (session/fsm/parity-check.ts). Compares the spine's terminal/stage
  # state against the GitHub PR's own state + the verifier child outcome — sources project() does NOT
  # write, so agreement is real evidence (unlike the self-agreeing divergence metric post-flip). W11-G3
  # runs the checker in batch over terminal sessions and classifies each `diverge` regression/benign.
  widget {
    timeseries_definition {
      title       = "Parity · Result mix (agree / diverge / no_ground_truth)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "by_result"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.parity{*} by {result}.as_count()"
          }
        }
      }
    }
  }

  widget {
    toplist_definition {
      title = "Parity · Divergences by spine state + source"
      request {
        query {
          metric_query {
            name        = "parity_diverged"
            data_source = "metrics"
            query       = "sum:arcanist.fsm.parity{result:diverge} by {spine_state,source}.as_count()"
          }
        }
      }
    }
  }

  # ---- Producer latency (W11-G4) ---------------------------------------------
  # The producer→spine commit latency (`arcanist.fsm.commit_latency_ms`): the entry→durable-commit span per
  # committed transition, grouped by `fsm_event` (the per-producer facet). Watch the p90/p99 TAIL — a rise
  # is a slow guard-resolver (GitHub-backed live reads) or slow D1 on some producer path. The p50 runs
  # 0-heavy by construction: producers that PIN the injected clock to a captured observation time
  # (epoch/deadline/noshow alarms) report ~0, so the honest signal is the tail on the live-clock producers
  # (verification/ci/head/review/cron/transport).
  widget {
    timeseries_definition {
      title       = "Producer latency · commit_latency_ms p50/p90/p99 by producer (last 1d)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.fsm.commit_latency_ms{*} by {fsm_event}"
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
            query       = "p90:arcanist.fsm.commit_latency_ms{*} by {fsm_event}"
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
            query       = "p99:arcanist.fsm.commit_latency_ms{*} by {fsm_event}"
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
}
