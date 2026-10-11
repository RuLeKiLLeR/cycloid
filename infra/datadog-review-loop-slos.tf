# --- Datadog: Review Loop (RLA) + QA Tester SLOs ---
#
# The first SLOs in the repo. They state objectives for loop convergence and
# QA Tester conclusiveness; error budgets make "is RLA/QA Tester healthy?" objective
# and turn regressions into budget burn. Metric-based, derived from the
# cycloid.review_loop.* / cycloid.qa_tester.* log metrics
# (datadog-log-metrics.tf). They read "no data" until events accumulate, which is
# expected. Targets are initial and should be revisited once a baseline is visible
# on the "Review Loop & QA Tester" dashboard.

# Settle rate: of epochs that reached a real terminal (head-change restarts
# excluded), the share that completed rather than cap-blocked.
resource "datadog_service_level_objective" "review_loop_settle_rate" {
  name        = "[Review Loop] Epoch settle rate"
  type        = "metric"
  description = "Share of terminal review-loop epochs that completed instead of hitting a cap/block (head-change restarts excluded). The loop's convergence 'availability'."

  # Failure term = ONLY genuine convergence-failure caps. `convergence_failure` is classified at emit
  # time (review-loop-events.ts, mirroring EXHAUSTED_BLOCKED_REASONS) so restarts (head_changed),
  # productive parks (worklist_truncation_unresolved), teardown/disabled blocks, and operational failures
  # do NOT depress the settle rate — and so the filter stays simple `{convergence_failure:true}` (Datadog
  # monitor queries reject the `IN (...)` operator).
  query {
    numerator   = "sum:arcanist.review_loop.epoch_completed{terminal_status:completed}.as_count()"
    denominator = "sum:arcanist.review_loop.epoch_completed{terminal_status:completed}.as_count() + sum:arcanist.review_loop.epoch_completed{convergence_failure:true}.as_count()"
  }

  thresholds {
    timeframe = "30d"
    target    = 95.0
    warning   = 98.0
  }

  tags = ["service:cycloid-control-plane", "component:review-loop"]
}

# Conclusiveness: share of QA Tester runs that returned a conclusive verdict
# (merge-ready / needs-work) rather than INCONCLUSIVE.
resource "datadog_service_level_objective" "verification_conclusiveness" {
  name        = "[QA Tester] Conclusiveness"
  type        = "metric"
  description = "Share of QA Tester runs that returned a conclusive verdict rather than INCONCLUSIVE. A QA Tester effectiveness objective."

  query {
    numerator   = "sum:arcanist.qa_tester.run_completed{verdict:conclusive}.as_count()"
    denominator = "sum:arcanist.qa_tester.run_completed{*}.as_count()"
  }

  thresholds {
    timeframe = "30d"
    target    = 90.0
    warning   = 95.0
  }

  tags = ["service:cycloid-control-plane", "component:qa-tester"]
}
