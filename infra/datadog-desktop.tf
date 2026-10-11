# --- Datadog: session desktop / VNC / CUA soak observability ---

resource "datadog_logs_metric" "desktop_start_events" {
  name = "arcanist.desktop.start_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "env:production @event:\"desktop.start\""
  }

  group_by {
    path     = "@component"
    tag_name = "component"
  }

  group_by {
    path     = "@outcome"
    tag_name = "outcome"
  }
}

resource "datadog_logs_metric" "desktop_health_events" {
  name = "arcanist.desktop.health_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "env:production @event:\"desktop.health\""
  }

  group_by {
    path     = "@status"
    tag_name = "status"
  }

  group_by {
    path     = "@failed_component"
    tag_name = "failed_component"
  }

  group_by {
    path     = "@phase"
    tag_name = "phase"
  }
}

resource "datadog_logs_metric" "desktop_restart_events" {
  name = "arcanist.desktop.restart_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "env:production @event:\"desktop.restart\""
  }

  group_by {
    path     = "@component"
    tag_name = "component"
  }

  group_by {
    path     = "@outcome"
    tag_name = "outcome"
  }

  group_by {
    path     = "@reason"
    tag_name = "reason"
  }
}

resource "datadog_logs_metric" "desktop_tool_action_events" {
  name = "arcanist.desktop.tool_action_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.tool_action\""
  }

  group_by {
    path     = "@action"
    tag_name = "action"
  }

  group_by {
    path     = "@success"
    tag_name = "success"
  }

  group_by {
    path     = "@errorCode"
    tag_name = "error_code"
  }

  group_by {
    path     = "@warningCode"
    tag_name = "warning_code"
  }

  group_by {
    path     = "@agentRuntimeBackend"
    tag_name = "agent_runtime_backend"
  }
}

resource "datadog_logs_metric" "desktop_tool_action_duration" {
  name = "arcanist.desktop.tool_action_duration"

  compute {
    aggregation_type    = "distribution"
    path                = "@durationMs"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.tool_action\" @durationMs:*"
  }

  group_by {
    path     = "@action"
    tag_name = "action"
  }

  group_by {
    path     = "@success"
    tag_name = "success"
  }
}

resource "datadog_metric_metadata" "desktop_tool_action_duration" {
  metric = datadog_logs_metric.desktop_tool_action_duration.name
  unit   = "millisecond"
}

resource "datadog_logs_metric" "desktop_readiness_events" {
  name = "arcanist.desktop.readiness_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.tool_action\" @desktopReadinessOutcome:*"
  }

  group_by {
    path     = "@desktopReadinessOutcome"
    tag_name = "readiness_outcome"
  }

  group_by {
    path     = "@desktopLazyStartRequested"
    tag_name = "lazy_start_requested"
  }

  group_by {
    path     = "@desktopHealthCheckMode"
    tag_name = "health_check_mode"
  }

  group_by {
    path     = "@action"
    tag_name = "action"
  }
}

resource "datadog_logs_metric" "desktop_readiness_wait" {
  name = "arcanist.desktop.readiness_wait_ms"

  compute {
    aggregation_type    = "distribution"
    path                = "@desktopReadyWaitMs"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.tool_action\" @desktopReadyWaitMs:* @desktopReadinessOutcome:*"
  }

  group_by {
    path     = "@desktopReadinessOutcome"
    tag_name = "readiness_outcome"
  }

  group_by {
    path     = "@desktopLazyStartRequested"
    tag_name = "lazy_start_requested"
  }

  group_by {
    path     = "@desktopHealthCheckMode"
    tag_name = "health_check_mode"
  }

  group_by {
    path     = "@action"
    tag_name = "action"
  }
}

resource "datadog_metric_metadata" "desktop_readiness_wait" {
  metric = datadog_logs_metric.desktop_readiness_wait.name
  unit   = "millisecond"
}

resource "datadog_logs_metric" "desktop_model_image_feedback_events" {
  name = "arcanist.desktop.model_image_feedback_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.model_image_feedback\""
  }

  group_by {
    path     = "@agentRuntimeBackend"
    tag_name = "agent_runtime_backend"
  }

  group_by {
    path     = "@success"
    tag_name = "success"
  }

  group_by {
    path     = "@failureCode"
    tag_name = "failure_code"
  }
}

resource "datadog_logs_metric" "desktop_model_image_feedback_bytes" {
  name = "arcanist.desktop.model_image_feedback_bytes"

  compute {
    aggregation_type    = "distribution"
    path                = "@totalBytes"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.model_image_feedback\" @totalBytes:*"
  }

  group_by {
    path     = "@agentRuntimeBackend"
    tag_name = "agent_runtime_backend"
  }
}

resource "datadog_metric_metadata" "desktop_model_image_feedback_bytes" {
  metric = datadog_logs_metric.desktop_model_image_feedback_bytes.name
  unit   = "byte"
}

resource "datadog_logs_metric" "desktop_model_image_feedback_unsupported" {
  name = "arcanist.desktop.model_image_feedback_unsupported"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "env:production @event:\"desktop.model_image_feedback_unsupported\""
  }

  group_by {
    path     = "@backend"
    tag_name = "backend"
  }

  group_by {
    path     = "@reason"
    tag_name = "reason"
  }

  group_by {
    path     = "@registrationBlocked"
    tag_name = "registration_blocked"
  }
}

resource "datadog_logs_metric" "desktop_model_image_feedback_fixture" {
  name = "arcanist.desktop.model_image_feedback_fixture"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "env:production @event:\"desktop.model_image_feedback_fixture\""
  }

  group_by {
    path     = "@backend"
    tag_name = "backend"
  }

  group_by {
    path     = "@deliveryPath"
    tag_name = "delivery_path"
  }

  group_by {
    path     = "@success"
    tag_name = "success"
  }

  group_by {
    path     = "@failureCode"
    tag_name = "failure_code"
  }
}

resource "datadog_logs_metric" "desktop_model_image_feedback_fixture_latency" {
  name = "arcanist.desktop.model_image_feedback_fixture_latency"

  compute {
    aggregation_type    = "distribution"
    path                = "@latencyMs"
    include_percentiles = true
  }

  filter {
    query = "env:production @event:\"desktop.model_image_feedback_fixture\" @latencyMs:*"
  }

  group_by {
    path     = "@backend"
    tag_name = "backend"
  }

  group_by {
    path     = "@deliveryPath"
    tag_name = "delivery_path"
  }
}

resource "datadog_metric_metadata" "desktop_model_image_feedback_fixture_latency" {
  metric = datadog_logs_metric.desktop_model_image_feedback_fixture_latency.name
  unit   = "millisecond"
}

resource "datadog_logs_metric" "desktop_screenshot_events" {
  name = "arcanist.desktop.screenshot_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.screenshot\""
  }

  group_by {
    path     = "@purpose"
    tag_name = "purpose"
  }

  group_by {
    path     = "@outcome"
    tag_name = "outcome"
  }
}

resource "datadog_logs_metric" "desktop_screenshot_bytes" {
  name = "arcanist.desktop.screenshot_bytes"

  compute {
    aggregation_type    = "distribution"
    path                = "@bytes"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.screenshot\" @bytes:*"
  }

  group_by {
    path     = "@purpose"
    tag_name = "purpose"
  }
}

resource "datadog_metric_metadata" "desktop_screenshot_bytes" {
  metric = datadog_logs_metric.desktop_screenshot_bytes.name
  unit   = "byte"
}

resource "datadog_logs_metric" "desktop_action_path_persist_events" {
  name = "arcanist.desktop.action_path_persist_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"desktop.action_path_persist\""
  }

  group_by {
    path     = "@success"
    tag_name = "success"
  }

  group_by {
    path     = "@screenshotStatus"
    tag_name = "screenshot_status"
  }

  group_by {
    path     = "@idempotentUpdate"
    tag_name = "idempotent_update"
  }
}

resource "datadog_logs_metric" "desktop_action_path_persist_duration" {
  name = "arcanist.desktop.action_path_persist_duration"

  compute {
    aggregation_type    = "distribution"
    path                = "@durationMs"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"desktop.action_path_persist\" @durationMs:*"
  }
}

resource "datadog_metric_metadata" "desktop_action_path_persist_duration" {
  metric = datadog_logs_metric.desktop_action_path_persist_duration.name
  unit   = "millisecond"
}

resource "datadog_logs_metric" "desktop_recording_events" {
  name = "arcanist.desktop.recording_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production (@event:\"desktop.recording_start\" OR @event:\"desktop.recording_stop\" OR @event:\"desktop.recording_failed\")"
  }

  group_by {
    path     = "@event"
    tag_name = "recording_event"
  }

  group_by {
    path     = "@overlay_status"
    tag_name = "overlay_status"
  }

  group_by {
    path     = "@publishable"
    tag_name = "publishable"
  }

  group_by {
    path     = "@reason"
    tag_name = "reason"
  }
}

resource "datadog_logs_metric" "desktop_recording_duration" {
  name = "arcanist.desktop.recording_duration"

  compute {
    aggregation_type    = "distribution"
    path                = "@duration_ms"
    include_percentiles = true
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.recording_stop\" @duration_ms:*"
  }

  group_by {
    path     = "@overlay_status"
    tag_name = "overlay_status"
  }
}

resource "datadog_metric_metadata" "desktop_recording_duration" {
  metric = datadog_logs_metric.desktop_recording_duration.name
  unit   = "millisecond"
}

resource "datadog_logs_metric" "desktop_proxy_events" {
  name = "arcanist.desktop.proxy_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true (@event:\"desktop.proxy_ticket_create\" OR @event:\"desktop.proxy_connect\" OR @event:\"desktop.proxy_close\" OR @event:\"desktop.proxy_input_attempt_blocked\" OR @event:\"desktop.proxy_upstream_resolve\" OR @event:\"desktop.proxy_ws_handshake\" OR @event:\"desktop.proxy_ticket_operation_failed\")"
  }

  group_by {
    path     = "@event"
    tag_name = "proxy_event"
  }

  group_by {
    path     = "@eventSource"
    tag_name = "event_source"
  }

  group_by {
    path     = "@status"
    tag_name = "status"
  }

  group_by {
    path     = "@reason"
    tag_name = "reason"
  }

  group_by {
    path     = "@inputType"
    tag_name = "input_type"
  }

  group_by {
    path     = "@phase"
    tag_name = "phase"
  }

  group_by {
    path     = "@supervisorHealthFailedComponent"
    tag_name = "failed_component"
  }

  group_by {
    path     = "@operation"
    tag_name = "operation"
  }

  group_by {
    path     = "@closeSource"
    tag_name = "close_source"
  }
}

resource "datadog_logs_metric" "desktop_rate_limited_events" {
  name = "arcanist.desktop.rate_limited_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-control-plane env:production @_direct_post:true @event:\"desktop.rate_limited\""
  }

  group_by {
    path     = "@routeClass"
    tag_name = "route_class"
  }
}

resource "datadog_logs_metric" "desktop_artifact_selected_events" {
  name = "arcanist.desktop.artifact_selected_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.artifact_selected\""
  }

  group_by {
    path     = "@video_selected"
    tag_name = "video_selected"
  }
}

resource "datadog_logs_metric" "desktop_artifact_publish_events" {
  name = "arcanist.desktop.artifact_publish_events"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:cycloid-sandbox-bridge env:production @event:\"desktop.artifact_publish\""
  }

  group_by {
    path     = "@artifactType"
    tag_name = "artifact_type"
  }

  group_by {
    path     = "@renderMode"
    tag_name = "render_mode"
  }

  group_by {
    path     = "@success"
    tag_name = "success"
  }

  group_by {
    path     = "@fallbackMode"
    tag_name = "fallback_mode"
  }
}

resource "datadog_dashboard" "desktop_vnc_cua_soak" {
  title       = "Desktop VNC/CUA Soak"
  description = "Dashboard-only soak surface for the session desktop stack. Do not add alert monitors until internal baseline volume establishes actionable thresholds for desktop unavailability, image-feedback failures, recording publish failures, and proxy connect failures."
  layout_type = "ordered"

  widget {
    group_definition {
      title       = "Startup and health"
      layout_type = "ordered"

      widget {
        timeseries_definition {
          title       = "Start, health, and restart events"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "start"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.start_events{*} by {component,outcome}.as_count()"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "health"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.health_events{*} by {status,failed_component,phase}.as_count()"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "restart"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.restart_events{*} by {component,outcome,reason}.as_count()"
              }
            }
          }
        }
      }
    }
  }

  widget {
    group_definition {
      title       = "Tools and model image feedback"
      layout_type = "ordered"

      widget {
        timeseries_definition {
          title       = "Desktop action outcomes"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "actions"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.tool_action_events{*} by {action,success,error_code,warning_code}.as_count()"
              }
            }
          }
        }
      }

      widget {
        timeseries_definition {
          title       = "Action latency"
          show_legend = true

          request {
            display_type = "line"
            query {
              metric_query {
                name        = "p95_action"
                data_source = "metrics"
                query       = "p95:arcanist.desktop.tool_action_duration{*} by {action,success}"
              }
            }
          }
        }
      }

      widget {
        timeseries_definition {
          title       = "Lazy start and readiness latency"
          show_legend = true

          request {
            display_type = "line"
            query {
              metric_query {
                name        = "readiness_wait"
                data_source = "metrics"
                query       = "p95:arcanist.desktop.readiness_wait_ms{*} by {readiness_outcome,lazy_start_requested,health_check_mode}"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "readiness_outcomes"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.readiness_events{*} by {readiness_outcome,lazy_start_requested,health_check_mode}.as_count()"
              }
            }
          }
        }
      }

      widget {
        timeseries_definition {
          title       = "Image feedback delivery"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "delivery"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.model_image_feedback_events{*} by {agent_runtime_backend,success,failure_code}.as_count()"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "unsupported"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.model_image_feedback_unsupported{*} by {backend,reason,registration_blocked}.as_count()"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "fixture"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.model_image_feedback_fixture{*} by {backend,delivery_path,success,failure_code}.as_count()"
              }
            }
          }
        }
      }
    }
  }

  widget {
    group_definition {
      title       = "Screenshots and action path"
      layout_type = "ordered"

      widget {
        timeseries_definition {
          title       = "Screenshot outcomes and bytes"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "screenshots"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.screenshot_events{*} by {purpose,outcome}.as_count()"
              }
            }
          }

          request {
            display_type = "line"
            query {
              metric_query {
                name        = "bytes"
                data_source = "metrics"
                query       = "p95:arcanist.desktop.screenshot_bytes{*} by {purpose}"
              }
            }
          }
        }
      }

      widget {
        timeseries_definition {
          title       = "Action path persistence"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "persist"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.action_path_persist_events{*} by {success,screenshot_status,idempotent_update}.as_count()"
              }
            }
          }

          request {
            display_type = "line"
            query {
              metric_query {
                name        = "duration"
                data_source = "metrics"
                query       = "p95:arcanist.desktop.action_path_persist_duration{*}"
              }
            }
          }
        }
      }
    }
  }

  widget {
    group_definition {
      title       = "Recording, proxy, limits, and PR evidence"
      layout_type = "ordered"

      widget {
        timeseries_definition {
          title       = "Recording lifecycle"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "events"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.recording_events{*} by {recording_event,overlay_status,publishable,reason}.as_count()"
              }
            }
          }

          request {
            display_type = "line"
            query {
              metric_query {
                name        = "duration"
                data_source = "metrics"
                query       = "p95:arcanist.desktop.recording_duration{*} by {overlay_status}"
              }
            }
          }
        }
      }

      widget {
        timeseries_definition {
          title       = "Viewer proxy and blocked input"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "proxy"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.proxy_events{*} by {proxy_event,event_source,status,reason,phase,failed_component,operation,input_type,close_source}.as_count()"
              }
            }
          }
        }
      }

      widget {
        timeseries_definition {
          title       = "Rate limits and PR evidence"
          show_legend = true

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "rate_limits"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.rate_limited_events{*} by {route_class}.as_count()"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "selected"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.artifact_selected_events{*} by {video_selected}.as_count()"
              }
            }
          }

          request {
            display_type = "bars"
            query {
              metric_query {
                name        = "published"
                data_source = "metrics"
                query       = "sum:arcanist.desktop.artifact_publish_events{*} by {artifact_type,render_mode,success,fallback_mode}.as_count()"
              }
            }
          }
        }
      }
    }
  }
}
