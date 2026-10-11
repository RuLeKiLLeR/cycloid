# --- Datadog: scheduled-automation Slack delivery (ARC-1195) ---
#
# Scheduled automations (scheduled_rules; e.g. the daily changelog dogfood)
# deliver the agent's final digest to a Slack channel via the control plane.
# The control plane emits `arcanist.automation.slack_delivery` (a COUNT tagged
# by `outcome`) from two places: the scheduler's starting-message post
# (outcome:workspace_not_connected | post_failed) and the session-completion
# delivery path (outcome:delivered | empty | post_failed). The failure monitor
# lives in datadog-monitors.tf (module "datadog_monitors").

resource "datadog_metric_metadata" "automation_slack_delivery" {
  metric      = "arcanist.automation.slack_delivery"
  type        = "count"
  description = "Scheduled-automation Slack channel delivery outcomes, tagged by outcome (delivered|empty|workspace_not_connected|post_failed)."
}
