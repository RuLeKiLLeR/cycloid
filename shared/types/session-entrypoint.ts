export type PersistedSessionEntrypoint =
  | "api"
  | "child_session"
  | "slack"
  | "slack_automation"
  | "jira"
  | "linear"
  | "pagerduty"
  | "github"
  | "scheduled"
  | "github_check_automation"
  | "auto_qa"
  | "auto_pr_review";
