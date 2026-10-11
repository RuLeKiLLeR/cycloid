# --- Datadog: user-visible latency SLOs ---

locals {
  # OBS-608: prompt execution metrics do not yet carry an `entrypoint` tag, so
  # start with an unsliced SLO and tighten / split it once the tag work lands.
  # This target is intentionally looser than the latency SLOs because it counts
  # all prompt execution errors, not just narrow platform faults.
  prompt_success_rate_slo_target              = 97.0
  prompt_success_rate_slo_warning             = 98.0
  prompt_success_rate_error_budget_fraction   = (100 - local.prompt_success_rate_slo_target) / 100
  prompt_success_rate_burn_warning_threshold  = 2.0
  prompt_success_rate_burn_critical_threshold = 4.0
}

resource "datadog_service_level_objective" "prompt_ttft_latency" {
  name        = "[Prompts] Time to first message latency"
  type        = "monitor"
  description = "Monitor-based SLO for prompt time-to-first-message staying below the P95 latency budget."

  monitor_ids = [
    module.datadog_monitors.metric_alert_ids["prompt_ttft_p95_latency"],
  ]

  thresholds {
    timeframe = "7d"
    target    = 99.0
    warning   = 99.5
  }

  thresholds {
    timeframe = "30d"
    target    = 99.0
    warning   = 99.5
  }

  tags = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle", "slo:ttft-latency"]
}

resource "datadog_service_level_objective" "sandbox_spawn_latency" {
  name        = "[Sandbox] Spawn latency"
  type        = "monitor"
  description = "Monitor-based SLO for successful sandbox spawn duration staying below the P95 latency budget."

  monitor_ids = [
    module.datadog_monitors.metric_alert_ids["sandbox_spawn_p95_latency"],
  ]

  thresholds {
    timeframe = "7d"
    target    = 99.0
    warning   = 99.5
  }

  thresholds {
    timeframe = "30d"
    target    = 99.0
    warning   = 99.5
  }

  tags = ["service:cycloid-sandbox-bridge", "component:sandbox-spawn", "slo:spawn-latency"]
}

resource "datadog_service_level_objective" "prompt_success_rate" {
  name        = "[Prompts] Success rate"
  type        = "metric"
  description = "Share of non-aborted prompts that completed successfully instead of ending in an execution error. Currently unsliced; add `entrypoint` once prompt execution metrics carry it."

  query {
    # User-aborted prompts should not spend the error budget; count only
    # successful completions vs execution errors.
    numerator   = "count:arcanist.prompt.execution_duration{outcome:success}.as_count()"
    denominator = "count:arcanist.prompt.execution_duration{outcome:success}.as_count() + sum:arcanist.prompt.execution_failures{*}.as_count()"
  }

  thresholds {
    timeframe = "7d"
    target    = local.prompt_success_rate_slo_target
    warning   = local.prompt_success_rate_slo_warning
  }

  thresholds {
    timeframe = "30d"
    target    = local.prompt_success_rate_slo_target
    warning   = local.prompt_success_rate_slo_warning
  }

  tags = ["service:cycloid-sandbox-bridge", "component:prompt-lifecycle", "slo:success-rate"]
}
