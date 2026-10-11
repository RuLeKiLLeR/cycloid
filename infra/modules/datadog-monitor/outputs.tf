# Monitor ids keyed by the same map key used in metric_alerts / log_alerts.
# Composite monitors (infra/datadog-composite-monitors.tf) reference these so
# the constituent ids come from Terraform resource refs, never hardcoded.

output "metric_alert_ids" {
  description = "Map of metric-alert key -> Datadog monitor id."
  value       = { for key, monitor in datadog_monitor.metric_alert : key => monitor.id }
}

output "log_alert_ids" {
  description = "Map of log-alert key -> Datadog monitor id."
  value       = { for key, monitor in datadog_monitor.log_alert : key => monitor.id }
}
