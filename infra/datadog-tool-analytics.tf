resource "datadog_dashboard" "tool_analytics" {
  title       = "Tool Analytics"
  description = "Per-tool call volume, timeout rate, and latency, plus the coarse MCP-class split."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Tool calls by MCP class and outcome"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "tool_calls"
            data_source = "metrics"
            query       = "sum:arcanist.tool.call_count{*} by {mcp_class,outcome}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Tool call volume by tool and outcome"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "tool_calls"
            data_source = "metrics"
            query       = "sum:arcanist.tool.call_count{*} by {tool_name,outcome}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Tool timeout rate by tool (%)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "timeouts"
            data_source = "metrics"
            query       = "sum:arcanist.tool.call_count{timed_out:true} by {tool_name}.as_count()"
          }
        }
        query {
          metric_query {
            name        = "total"
            data_source = "metrics"
            query       = "sum:arcanist.tool.call_count{*} by {tool_name}.as_count()"
          }
        }
        formula {
          formula_expression = "default_zero(timeouts / total) * 100"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Tool call latency p95 by tool (ms)"
      show_legend = true

      request {
        display_type = "line"
        query {
          metric_query {
            name        = "p95_latency"
            data_source = "metrics"
            query       = "p95:arcanist.tool.call_duration{*} by {tool_name}"
          }
        }
      }
    }
  }
}
