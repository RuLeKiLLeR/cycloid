resource "datadog_monitor" "metric_alert" {
  for_each = var.metric_alerts

  name    = each.value.name
  type    = "metric alert"
  message = each.value.message
  query   = each.value.query

  monitor_thresholds {
    warning           = each.value.warning
    critical          = each.value.critical
    warning_recovery  = each.value.warning_recovery
    critical_recovery = each.value.critical_recovery
  }

  notify_no_data    = each.value.on_missing_data == null ? each.value.notify_no_data : null
  on_missing_data   = each.value.on_missing_data
  renotify_interval = each.value.renotify_interval

  validate = each.value.validate

  tags = each.value.tags
}

resource "datadog_monitor" "log_alert" {
  for_each = var.log_alerts

  name    = each.value.name
  type    = "log alert"
  message = each.value.message
  query   = each.value.query

  monitor_thresholds {
    warning           = each.value.warning
    critical          = each.value.critical
    warning_recovery  = each.value.warning_recovery
    critical_recovery = each.value.critical_recovery
  }

  notify_no_data    = each.value.on_missing_data == null ? each.value.notify_no_data : null
  on_missing_data   = each.value.on_missing_data
  renotify_interval = each.value.renotify_interval

  validate = each.value.validate

  tags = each.value.tags
}
