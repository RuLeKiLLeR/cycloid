# --- Datadog: Platform LLM Service Tier ---
#
# Tracks the cost delta and latency tradeoff from routing latency-tolerant background platform
# LLM calls to OpenAI's flex service tier (Batch-rate billing, ~50% off standard for
# gpt-5.4-mini) while interactive calls stay on standard. PR template fill is the retained
# background broker call on Flex; review-loop triage is tracked separately because it sits on an
# interactive review-turn path.
#
# Source metrics live in datadog-log-metrics.tf (cycloid.platform_llm.*), derived from
# the platform_llm.usage_event log emitted by
# apps/control-plane-worker/src/services/platform-structured-output.ts. The two axes use
# different tier sources (both canonical standard|flex):
#   - COST panels (usage_cost) key on the ACTUAL returned tier, so a flex->default fallback
#     is costed and attributed to the tier that was actually billed.
#   - LATENCY/adoption panels (call_duration) key on the ROUTING decision (requested tier),
#     so a flex call that times out or degrades still counts as flex — otherwise failed flex
#     calls (actual tier null on failure) would hide in the standard latency bucket.
#
# Watch the "Flex · call latency" panel after rollout: flex queueing can lengthen the
# tail. PR template fill is the only call type that feeds perceived PR-open time; if its
# p95 regresses materially, revert that one call to standard (constants/platform-llm.ts).

resource "datadog_dashboard" "platform_llm_service_tier" {
  title       = "Platform LLM Service Tier"
  description = "Standard-vs-flex cost delta and per-call-type latency for platform LLM calls."
  layout_type = "ordered"

  # ---- Cost ------------------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Cost · Spend by service tier (USD/day)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "cost_micros"
            data_source = "metrics"
            query       = "sum:arcanist.platform_llm.usage_cost_usd_micros{*} by {service_tier}.as_count()"
          }
        }
        formula {
          # usd_micros -> USD
          formula_expression = "cost_micros / 1000000"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Cost · Spend by call type and service tier (USD/day)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "cost_micros"
            data_source = "metrics"
            query       = "sum:arcanist.platform_llm.usage_cost_usd_micros{*} by {call_type,service_tier}.as_count()"
          }
        }
        formula {
          formula_expression = "cost_micros / 1000000"
        }
      }
    }
  }

  # ---- Adoption --------------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Adoption · Call volume by service tier and outcome"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "calls"
            data_source = "metrics"
            query       = "sum:arcanist.platform_llm.call_duration{*} by {service_tier,outcome}.as_count()"
          }
        }
      }
    }
  }

  # ---- Latency ---------------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Flex · Call latency p50 by call type"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.platform_llm.call_duration{service_tier:flex} by {call_type}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Flex · Call latency p95 by call type"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.platform_llm.call_duration{service_tier:flex} by {call_type}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Review-loop triage · Latency by tier and outcome"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.platform_llm.call_duration{call_type:review_loop_triage} by {service_tier,outcome}"
          }
        }
      }

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.platform_llm.call_duration{call_type:review_loop_triage} by {service_tier,outcome}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Standard vs flex · p95 latency, all call types"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95_by_tier"
            data_source = "metrics"
            query       = "p95:arcanist.platform_llm.call_duration{*} by {service_tier}"
          }
        }
      }
    }
  }
}
