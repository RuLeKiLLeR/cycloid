variable "metrics" {
  description = "Datadog log-derived metrics keyed by Terraform resource name."
  type = map(object({
    name                = string
    aggregation_type    = string
    filter_query        = string
    path                = optional(string)
    include_percentiles = optional(bool)
    group_by = optional(list(object({
      path     = string
      tag_name = string
    })), [])
  }))
  default = {}
}
