export type SlackAlertPromptProvider = "datadog" | "sentry";

export const SLACK_ALERT_AUTOMATION_DEFAULT_PROMPTS: Record<SlackAlertPromptProvider, string> = {
  datadog: `Investigate this Datadog alert before making changes.

First determine whether the alert is still firing, already resolved, duplicate, flaky, expected, or not actionable. Use Datadog context, logs, traces, deploy history, recent PRs, and repo code as needed.

Only implement a code fix when the evidence shows a real product or infrastructure defect that should be fixed in this repository.

If the alert is not actionable as written, do not make a code fix. Instead explain what makes the alert noisy or unactionable and, when appropriate, propose monitor tuning, and implement it only if this repository manages its Datadog monitors as code (e.g. Terraform); otherwise describe the recommended change. If the monitor should be deleted or disabled, recommend that clearly and explain why.

If a code or monitor change is made, use a PR title that describes the actual change, not the investigation. Prefer titles like "Reduce noisy Datadog session timeout alerting" or "Handle missing Slack callback context" over "Investigate Datadog alert".`,
  sentry: `Investigate this Sentry alert before making changes.

First determine whether the issue is still active, already resolved, duplicate, flaky, expected, or not actionable. Use Sentry context, logs, traces, deploy history, recent PRs, and repo code as needed.

Only implement a code fix when the evidence shows a real product or infrastructure defect that should be fixed in this repository.

If the alert is not actionable as written, do not make a code fix. Instead explain what makes the alert noisy or unactionable and, when appropriate, propose alert tuning or deletion.

If a code or monitor change is made, use a PR title that describes the actual change, not the investigation. Prefer titles like "Guard Slack alert callback parsing" over "Investigate Sentry alert".`,
};
