# --- Datadog: Agent Model Efficiency (ARC-1580 / OBS-602) ---
#
# Throughput/efficiency view of agent model usage: prompt-cache hit rate,
# effective output tokens/sec, model-side rate limiting, and mid-turn context
# compactions. Cost has its own guardrail (datadog-baseten.tf, datadog-monitors.tf);
# this dashboard tracks whether we are using the models EFFICIENTLY.
#
# Source metrics live in datadog-log-metrics.tf:
#   - cycloid.sandbox_agent.{input,output,cache_read,cache_write}_tokens — from the
#     control plane's sandbox_agent.usage_event log (writeUsageToD1, one per prompt).
#   - arcanist.prompt.output_tokens_per_second — from the bridge's
#     prompt.behavior.completed log (per-prompt output delta / wall-clock duration).
#   - arcanist.sandbox_agent.rate_limited — bridge log, non-allowed statuses only.
#   - arcanist.prompt.compaction(_tokens_reclaimed) — bridge compaction logs.
#
# The prompt-cache regression monitor lives in datadog-monitors.tf
# (prompt_cache_hit_rate_regression).

resource "datadog_dashboard" "agent_model_efficiency" {
  title       = "Agent Model Efficiency (ARC-1580)"
  description = "Prompt-cache hit rate, output tokens/sec, model rate limits, and context compactions for sandbox agent inference."
  layout_type = "ordered"

  # ---- Prompt cache ----------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Cache · Prompt-cache hit rate by model"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "cache_read"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_read_tokens{*} by {model}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "uncached_input"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.input_tokens{*} by {model}.as_count()"
          }
        }
        formula {
          # Fraction of prompt input served from cache. input_tokens is already
          # cache-exclusive (the bridge normalizes cached reads out of input).
          formula_expression = "default_zero(cache_read / (cache_read + uncached_input))"
          alias              = "cache hit rate"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Cache · Token volume by kind (per day)"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "cache_read"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_read_tokens{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "cache_write"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_write_tokens{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "uncached_input"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.input_tokens{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "output"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.output_tokens{*}.as_count()"
          }
        }
        formula { formula_expression = "cache_read" }
        formula { formula_expression = "cache_write" }
        formula { formula_expression = "uncached_input" }
        formula { formula_expression = "output" }
      }
    }
  }

  # ---- Throughput -------------------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Throughput · Output tokens/sec p50 by model"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p50"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.output_tokens_per_second{*} by {model}"
          }
        }
        formula { formula_expression = "p50" }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Throughput · Output tokens/sec p95 by backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.output_tokens_per_second{*} by {agent_runtime_backend}"
          }
        }
        formula { formula_expression = "p95" }
      }
    }
  }

  # ---- Rate limits & compaction ------------------------------------------------
  widget {
    timeseries_definition {
      title       = "Limits · Model rate-limit events by provider/status"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "rate_limited"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.rate_limited{*} by {provider,status}.as_count()"
          }
        }
        formula { formula_expression = "rate_limited" }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Compaction · Mid-turn compactions by backend"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "compactions"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.compaction{*} by {agent_runtime_backend}.as_count()"
          }
        }
        formula { formula_expression = "compactions" }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Compaction · Tokens reclaimed per compaction (avg)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "reclaimed"
            data_source = "metrics"
            query       = "avg:arcanist.prompt.compaction_tokens_reclaimed{*} by {agent_runtime_backend}"
          }
        }
        formula { formula_expression = "reclaimed" }
      }
    }
  }
}
