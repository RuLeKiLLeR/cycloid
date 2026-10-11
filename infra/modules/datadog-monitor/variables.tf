variable "metric_alerts" {
  description = "Datadog metric alert monitors keyed by Terraform resource name."
  type = map(object({
    name              = string
    query             = string
    message           = string
    critical          = number
    warning           = optional(number)
    critical_recovery = optional(number)
    warning_recovery  = optional(number)
    notify_no_data    = optional(bool, false)
    on_missing_data   = optional(string)
    renotify_interval = optional(number, 60)
    # Set false for a monitor on an event-counter metric that may have zero data
    # points at create time (Datadog rejects a metric-alert query it can't validate
    # against a known metric). Defaults true (validate normally).
    validate = optional(bool, true)
    tags     = list(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for alert in values(var.metric_alerts) :
      alert.on_missing_data == null ? true : contains(["default", "show_no_data", "show_and_notify_no_data", "resolve"], alert.on_missing_data)
    ])
    error_message = "on_missing_data must be one of: default, show_no_data, show_and_notify_no_data, resolve."
  }
}

variable "log_alerts" {
  description = "Datadog log alert monitors keyed by Terraform resource name."
  type = map(object({
    name              = string
    query             = string
    message           = string
    critical          = number
    warning           = optional(number)
    critical_recovery = optional(number)
    warning_recovery  = optional(number)
    notify_no_data    = optional(bool, false)
    on_missing_data   = optional(string)
    renotify_interval = optional(number, 60)
    validate          = optional(bool, true)
    tags              = list(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for alert in values(var.log_alerts) :
      alert.on_missing_data == null ? true : contains(["default", "show_no_data", "show_and_notify_no_data", "resolve"], alert.on_missing_data)
    ])
    error_message = "on_missing_data must be one of: default, show_no_data, show_and_notify_no_data, resolve."
  }
}
