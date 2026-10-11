# --- Datadog: Baseten / opencode observability ---
#
# Makes Baseten inference spend and opencode runtime health observable ahead of
# opencode's production gate flip (docs/agent-runtime-backends.md "OpenCode (GA
# candidate)" requires spend observability to land BEFORE selectability opens).
#
# Source metrics:
#   - arcanist.sandbox_agent.usage_cost_usd_micros (datadog-log-metrics.tf), a
#     log-derived distribution keyed by provider/agent_runtime_backend/model. Baseten
#     spend is the provider:baseten slice. This is the REAL sandbox agent inference cost
#     emitted by writeUsageToD1 (ARC-1397); the old arcanist.platform_llm.usage_cost_usd_micros
#     slice only captured the control-plane structured-output broker, not agent inference.
#   - arcanist.opencode.raw_fallback (emitted by the opencode event translator),
#     the untranslated-event drift signal.
#
# Credential-resolution-failure and opencode startup-error COUNT metrics need new
# control-plane emission; they are intentionally a separate PR so this infra change
# stays decoupled from runtime code.

resource "datadog_dashboard" "baseten_opencode" {
  title       = "Baseten / opencode"
  description = "Baseten inference spend and opencode runtime health for the opencode agent-runtime backend."
  layout_type = "ordered"

  # ---- Spend -----------------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Spend · Baseten cost by model (USD/day)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "cost_micros"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.usage_cost_usd_micros{provider:baseten} by {model}.as_count()"
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
    query_value_definition {
      title     = "Spend · Baseten cost (USD, selected range)"
      precision = 2
      autoscale = true

      request {
        aggregator = "sum"
        query {
          metric_query {
            name        = "cost_micros"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.usage_cost_usd_micros{provider:baseten}.as_count()"
          }
        }
        formula {
          formula_expression = "cost_micros / 1000000"
        }
      }
    }
  }

  # ---- Runtime health --------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Health · opencode raw-fallback drift by event/part type"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "fallbacks"
            data_source = "metrics"
            query       = "sum:arcanist.opencode.raw_fallback{*} by {opencode_event_type,opencode_part_type}.as_count()"
          }
        }
      }
    }
  }
}
