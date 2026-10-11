variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Domain name for the application (e.g. cycloid.yourdomain.com)"
  type        = string
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "cycloid"
}

variable "control_plane_worker_host" {
  description = "Legacy control-plane worker hostname retained for existing Terraform variable sets. Production Pages now targets the Terraform-managed api.trycycloid.com Workers custom domain."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "datadog_slack_handle" {
  description = "Canonical Slack handle for Datadog monitor notifications. Must match a channel configured in the Datadog Slack integration at https://us5.datadoghq.com/integrations/slack."
  type        = string
  default     = "@slack-datadog-cycloid"
}

variable "datadog_pager_handle" {
  description = "Datadog @-handle that pages a phone (PagerDuty) for critical-only alerts. Routed inside {{#is_alert}}/{{#is_recovery}} blocks so warnings stay Slack-only. Must match the service name registered in the Datadog PagerDuty integration at https://us5.datadoghq.com/integrations/pagerduty (service 'cycloid' => @pagerduty-cycloid). Not a secret."
  type        = string
  default     = "@pagerduty-cycloid"
}

variable "cloudflare_deny_ips" {
  description = "IP addresses or CIDR ranges blocked by the zone-level Cloudflare custom deny rule."
  type        = list(string)
  default     = []
}

variable "alert_email" {
  description = "Deprecated Terraform Cloud workspace input retained to avoid undeclared-variable warnings."
  type        = string
  default     = null
  sensitive   = true
}

variable "ui_basic_auth_password" {
  description = "Deprecated Terraform Cloud workspace input retained to avoid undeclared-variable warnings."
  type        = string
  default     = null
  sensitive   = true
}
