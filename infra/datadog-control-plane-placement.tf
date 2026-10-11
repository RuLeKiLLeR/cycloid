# Production-only measurement surface for the Cloudflare Smart Placement trial.
# The worker.fetch span already carries route, duration, status, and error fields,
# so this dashboard reuses logs without adding hot-path instrumentation.
resource "datadog_dashboard" "control_plane_placement_trial" {
  title       = "Control Plane Placement Trial"
  description = "Route-level latency, volume, request failures, and streaming stability guardrails for the production Smart Placement trial."
  layout_type = "ordered"

  widget {
    timeseries_definition {
      title       = "Non-streaming request latency p50 by route"
      show_legend = true

      request {
        display_type = "line"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.name:worker.fetch -@span.http.route:/api/sessions/*/events -@span.http.route:/api/sessions/*/ws -@span.http.route:/api/users/me/feed/ws -@span.http.status_code:101"
          compute_query {
            aggregation = "pc50"
            facet       = "@span.duration_ms"
          }
          group_by {
            facet = "@span.http.route"
            limit = 10
            sort_query {
              aggregation = "pc50"
              facet       = "@span.duration_ms"
              order       = "desc"
            }
          }
        }
      }
      yaxis {
        include_zero = true
        label        = "ms"
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Non-streaming request latency p95 by route"
      show_legend = true

      request {
        display_type = "line"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.name:worker.fetch -@span.http.route:/api/sessions/*/events -@span.http.route:/api/sessions/*/ws -@span.http.route:/api/users/me/feed/ws -@span.http.status_code:101"
          compute_query {
            aggregation = "pc95"
            facet       = "@span.duration_ms"
          }
          group_by {
            facet = "@span.http.route"
            limit = 10
            sort_query {
              aggregation = "pc95"
              facet       = "@span.duration_ms"
              order       = "desc"
            }
          }
        }
      }
      yaxis {
        include_zero = true
        label        = "ms"
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Non-streaming request volume by route"
      show_legend = true

      request {
        display_type = "bars"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.name:worker.fetch -@span.http.route:/api/sessions/*/events -@span.http.route:/api/sessions/*/ws -@span.http.route:/api/users/me/feed/ws -@span.http.status_code:101"
          compute_query {
            aggregation = "count"
          }
          group_by {
            facet = "@span.http.route"
            limit = 10
            sort_query {
              aggregation = "count"
              order       = "desc"
            }
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Root fetch 5xx and thrown errors by route"
      show_legend = true

      request {
        display_type = "bars"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.name:worker.fetch -@span.http.route:/api/sessions/*/events -@span.http.route:/api/sessions/*/ws -@span.http.route:/api/users/me/feed/ws (@span.status:error OR @span.http.status_code:[500 TO 599])"
          compute_query {
            aggregation = "count"
          }
          group_by {
            facet = "@span.http.route"
            limit = 10
            sort_query {
              aggregation = "count"
              order       = "desc"
            }
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Streaming handshake failures by route and status"
      show_legend = true

      request {
        display_type = "bars"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.name:worker.fetch (@span.http.route:/api/sessions/*/events OR @span.http.route:/api/sessions/*/ws OR @span.http.route:/api/users/me/feed/ws) (@span.status:error OR @span.http.status_code:[400 TO 599])"
          compute_query {
            aggregation = "count"
          }
          group_by {
            facet = "@span.http.route"
            limit = 10
            sort_query {
              aggregation = "count"
              order       = "desc"
            }
          }
          group_by {
            facet = "@span.http.status_code"
            limit = 10
            sort_query {
              aggregation = "count"
              order       = "desc"
            }
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "WebSocket upgrade latency"
      show_legend = true

      request {
        display_type = "line"
        log_query {
          index        = "*"
          search_query = "service:cycloid-control-plane env:production @span.name:worker.fetch (@span.http.route:/api/sessions/*/ws OR @span.http.route:/api/users/me/feed/ws) @span.http.status_code:101"
          compute_query {
            aggregation = "pc95"
            facet       = "@span.duration_ms"
          }
          group_by {
            facet = "@span.http.route"
            limit = 10
            sort_query {
              aggregation = "pc95"
              facet       = "@span.duration_ms"
              order       = "desc"
            }
          }
        }
      }
      yaxis {
        include_zero = true
        label        = "ms"
        scale        = "linear"
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Bridge reconnects by cause"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "reconnects"
            data_source = "metrics"
            query       = "sum:arcanist.bridge.reconnects{*} by {reconnect_reason,connect_error_class}.as_count()"
          }
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title       = "Control-plane sandbox WebSocket closes"
      show_legend = true

      request {
        display_type = "bars"
        query {
          metric_query {
            name        = "ws_closes"
            data_source = "metrics"
            query       = "sum:arcanist.control_plane.sandbox_ws_closes{*} by {close_decision,active_prompt_in_flight}.as_count()"
          }
        }
      }
    }
  }
}
