import type { PersistedSessionEntrypoint } from "../../../../shared/types/session-entrypoint.js";

const LABELS: Record<PersistedSessionEntrypoint, string> = {
  api: "Session",
  child_session: "Spawned session",
  slack: "Slack message",
  slack_automation: "Slack alert",
  jira: "Jira issue",
  linear: "Linear issue",
  pagerduty: "PagerDuty incident",
  github: "GitHub trigger",
  scheduled: "Scheduled run",
  github_check_automation: "Failed GitHub check automation",
  auto_qa: "Automatic QA",
  auto_pr_review: "Automatic PR review",
};

export function sessionEntrypointLabel(
  entrypoint: PersistedSessionEntrypoint | null | undefined,
  initiationMode: "user" | "child" | "automation" | undefined,
): string {
  if (entrypoint) return LABELS[entrypoint];
  if (initiationMode === "automation") return "Automation";
  if (initiationMode === "child") return "Spawned session";
  return "Session";
}

export function sessionEntrypointSearchTokens(entrypoint: PersistedSessionEntrypoint | null | undefined): string[] {
  return entrypoint ? [entrypoint.replace(/_/g, " "), LABELS[entrypoint]] : [];
}
