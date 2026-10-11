# --- Datadog: Agent Model Throughput / Efficiency ---
#
# Cache-aware throughput and cost-efficiency for sandbox-agent usage across all
# production agent backends. Source metrics:
#   - cycloid.sandbox_agent.{input,output,cache_read,cache_write,total}_tokens
#   - arcanist.sandbox_agent.usage_cost_usd_micros
#
# The token metrics are derived from sandbox_agent.usage_event at the single
# usage_records write path (writeUsageToD1). Cache buckets stay separate because
# Claude and Codex report them outside raw input tokens; panels that ignore cache
# under-count the busiest cached models and misstate cost efficiency.

resource "datadog_dashboard" "agent_model_throughput_efficiency" {
  title       = "Agent Model Throughput / Efficiency"
  description = "Cache-aware token throughput and cost-efficiency for sandbox agent models."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Throughput · Total tokens by model"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "total_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.total_tokens{*} by {model}.as_count()"
          }
        }
      }
    }
  }

  widget {
    query_value_definition {
      title = "Throughput · Total tokens (selected range)"
      request {
        query {
          metric_query {
            name        = "total_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.total_tokens{*}.as_count()"
          }
        }
        formula {
          formula_expression = "total_tokens"
        }
      }
      autoscale  = true
      precision  = 0
      text_align = "center"
    }
  }

  widget {
    timeseries_definition {
      title       = "Efficiency · Cache-token share by model"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "input_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.input_tokens{*} by {model}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "cache_read_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_read_tokens{*} by {model}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "cache_write_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_write_tokens{*} by {model}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero((cache_read_tokens + cache_write_tokens) / (input_tokens + cache_read_tokens + cache_write_tokens)) * 100"
          alias              = "cache-token share"
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
    query_value_definition {
      title = "Efficiency · Cache-token share (selected range)"
      request {
        query {
          metric_query {
            name        = "input_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.input_tokens{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "cache_read_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_read_tokens{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "cache_write_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.cache_write_tokens{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero((cache_read_tokens + cache_write_tokens) / (input_tokens + cache_read_tokens + cache_write_tokens)) * 100"
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
      title       = "Efficiency · USD per 1M total tokens by model"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "cost_micros"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.usage_cost_usd_micros{*} by {model}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.total_tokens{*} by {model}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(cost_micros / total_tokens)"
          alias              = "USD / 1M total tokens"
        }
      }
    }
  }

  widget {
    query_value_definition {
      title = "Efficiency · USD per 1M total tokens (selected range)"
      request {
        query {
          metric_query {
            name        = "cost_micros"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.usage_cost_usd_micros{*}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total_tokens"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.total_tokens{*}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(cost_micros / total_tokens)"
        }
      }
      autoscale   = true
      precision   = 2
      text_align  = "center"
      custom_unit = "$/1M tok"
    }
  }

  widget {
    timeseries_definition {
      title       = "Throughput · Output tokens/sec p50 by model and backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "throughput"
            data_source = "metrics"
            query       = "p50:arcanist.prompt.output_tokens_per_second{*} by {model,agent_runtime_backend}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Throughput · Output tokens/sec p95 by model and backend"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "throughput"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.output_tokens_per_second{*} by {model,agent_runtime_backend}"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Reliability · Model-side rate limits by provider and model"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "rate_limited"
            data_source = "metrics"
            query       = "sum:arcanist.sandbox_agent.rate_limited{*} by {provider,model}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Compaction · Count by model"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "compactions"
            data_source = "metrics"
            query       = "sum:arcanist.prompt.compaction{*} by {model}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Compaction · Tokens reclaimed p95 by model"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "tokens_reclaimed"
            data_source = "metrics"
            query       = "p95:arcanist.prompt.compaction_tokens_reclaimed{*} by {model}"
          }
        }
      }
    }
  }
}
