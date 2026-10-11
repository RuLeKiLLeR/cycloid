resource "datadog_logs_metric" "metric" {
  for_each = var.metrics

  name = each.value.name

  compute {
    aggregation_type    = each.value.aggregation_type
    path                = each.value.path
    include_percentiles = each.value.include_percentiles
  }

  filter {
    query = each.value.filter_query
  }

  dynamic "group_by" {
    for_each = each.value.group_by

    content {
      path     = group_by.value.path
      tag_name = group_by.value.tag_name
    }
  }
}
