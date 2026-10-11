# Planned control-plane handoffs are rare lifecycle events, so keep their
# counters and disconnect duration in Terraform-managed log-derived metrics.
locals {
  control_plane_handoff_metrics = {
    handoffs = {
      name   = "arcanist.control_plane.handoff.count"
      filter = "service:cycloid-session-do @event:sandbox_control_plane_handoff"
      path   = null
    }
    disconnect_duration = {
      name   = "arcanist.control_plane.handoff.disconnect_duration_ms"
      filter = "service:cycloid-session-do @event:sandbox_control_plane_handoff @disconnectDurationMs:*"
      path   = "@disconnectDurationMs"
    }
    failed_handoffs = {
      name   = "arcanist.control_plane.handoff.failed"
      filter = "service:cycloid-session-do @event:sandbox_handoff_record_persist_failed"
      path   = null
    }
    retry_after_deploy = {
      name   = "arcanist.control_plane.handoff.retry_after_deploy"
      filter = "service:cycloid-session-do @event:prompt_retrying @retryAfterDeploy:true"
      path   = null
    }
    deploy_mutations = {
      name   = "arcanist.control_plane.deploy.mutations"
      filter = "service:cycloid-control-plane @event:control_plane_deploy_mutation"
      path   = null
    }
  }
}

resource "datadog_logs_metric" "control_plane_handoff" {
  for_each = local.control_plane_handoff_metrics
  name     = each.value.name

  compute {
    aggregation_type    = each.value.path == null ? "count" : "distribution"
    path                = each.value.path
    include_percentiles = each.value.path == null ? null : true
  }

  filter { query = each.value.filter }

  group_by {
    path     = "@newVersionId"
    tag_name = "worker_version_id"
  }
}

resource "datadog_metric_metadata" "control_plane_handoff_disconnect_duration" {
  metric = datadog_logs_metric.control_plane_handoff["disconnect_duration"].name
  type   = "distribution"
  unit   = "millisecond"
}

resource "datadog_monitor" "control_plane_handoff_failures" {
  name    = "Control-plane handoff persistence failures"
  type    = "metric alert"
  query   = format("sum(last_15m):sum:%s{*}.as_count() > 0", datadog_logs_metric.control_plane_handoff["failed_handoffs"].name)
  message = "A planned control-plane sandbox handoff failed to persist its adoption record. Investigate reconnect-grace behavior."
  monitor_thresholds { critical = 0 }
  notify_no_data = false
  include_tags   = true
}
