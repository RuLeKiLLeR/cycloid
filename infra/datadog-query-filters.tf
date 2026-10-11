locals {
  datadog_non_pr_dashboard_exclusion_terms = [
    "@ownerUserId:1",
    "@ownerUserId:2",
    "@ownerUserId:14",
    "@ownerUserId:1002",
    "@owner_user_id:1",
    "@owner_user_id:2",
    "@owner_user_id:14",
    "@owner_user_id:1002",
    "@repo:trycycloid/demo-env",
  ]
  datadog_non_pr_dashboard_exclusion_query = "-(${join(" OR ", local.datadog_non_pr_dashboard_exclusion_terms)})"
}
