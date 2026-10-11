import { getBusinessIntegrations } from "../integrations/service";
import { getUserSettingsIfExists } from "../settings/db";
import { getPagerDutyDispatchInstallationSummary } from "./pagerduty-dispatch-admin-service";

export type ConnectedTriggerStatus = "active" | "setup_needed" | "degraded" | "policy_enabled" | "policy_disabled";

export type ConnectedTrigger = {
  id: "github" | "slack" | "linear" | "jira" | "pagerduty" | "automatic_review" | "automatic_qa";
  label: string;
  status: ConnectedTriggerStatus;
  scope: "workspace" | "viewer" | "repository";
  gesture: string;
  behavior: "new_session" | "continues_pr_lifecycle";
  settingsPath: string;
  observedAt: number | null;
};

function integrationStatus(info: { scope: string; currentHealth?: { status: string | null } }): ConnectedTriggerStatus {
  if (info.scope === "disabled") return "setup_needed";
  if (info.currentHealth?.status === "failed") return "degraded";
  return "active";
}

function installedIntegrationStatus(
  info: { scope: string; currentHealth?: { status: string | null } },
  installed: boolean,
): ConnectedTriggerStatus {
  const status = integrationStatus(info);
  return status === "active" && !installed ? "setup_needed" : status;
}

export async function listConnectedTriggers(input: {
  db: D1Database;
  businessId: string;
  userId: number;
  publicBaseUrl: string;
}): Promise<ConnectedTrigger[]> {
  const [integrations, settings, pagerDuty] = await Promise.all([
    getBusinessIntegrations(input.db, input.businessId),
    getUserSettingsIfExists(input.db, input.userId),
    getPagerDutyDispatchInstallationSummary(input.db, input.businessId, input.publicBaseUrl),
  ]);
  const jira = integrations.jira.jiraWorkspace;
  const linear = integrations.linear.linearWorkspace;
  const slack = integrations.slack.slackWorkspace;
  return [
    {
      id: "github",
      label: "GitHub mentions and PR lifecycle",
      status: integrationStatus(integrations.github),
      scope: "repository",
      gesture: "Mention @cycloid on an issue or PR; review and CI events continue an owned PR.",
      behavior: "new_session",
      settingsPath: "/settings/repositories",
      observedAt: integrations.github.currentHealth?.checkedAt ?? null,
    },
    {
      id: "slack",
      label: "Slack mention or DM",
      status: installedIntegrationStatus(integrations.slack, slack?.status === "installed"),
      scope: "workspace",
      gesture: "Mention Cycloid in an installed workspace or send it a direct message.",
      behavior: "new_session",
      settingsPath: "/settings/workspace-integrations",
      observedAt: slack?.installedAt ?? null,
    },
    {
      id: "linear",
      label: "Linear issue label",
      status: installedIntegrationStatus(integrations.linear, linear?.status === "active" && linear.webhookBound),
      scope: "workspace",
      gesture: "Add the cycloid label to a Linear issue.",
      behavior: "new_session",
      settingsPath: "/settings/workspace-integrations",
      observedAt: integrations.linear.currentHealth?.checkedAt ?? null,
    },
    {
      id: "jira",
      label: "Jira issue label",
      status: installedIntegrationStatus(integrations.jira, jira?.status === "active" && jira.webhookBound),
      scope: "workspace",
      gesture: `Add the ${jira?.triggerLabel ?? "configured trigger"} label to a Jira issue.`,
      behavior: "new_session",
      settingsPath: "/settings/workspace-integrations",
      observedAt: integrations.jira.currentHealth?.checkedAt ?? null,
    },
    {
      id: "pagerduty",
      label: "PagerDuty incident opened",
      status: pagerDuty.status === "active" ? "active" : "setup_needed",
      scope: "workspace",
      gesture: "Open an incident on the configured PagerDuty service.",
      behavior: "new_session",
      settingsPath: "/settings/workspace-integrations",
      observedAt: pagerDuty.updatedAt,
    },
    {
      id: "automatic_review",
      label: "Automatic review handling",
      status: settings?.automatic_reviews_enabled === 1 ? "policy_enabled" : "policy_disabled",
      scope: "viewer",
      gesture: "Review comments on a Cycloid PR continue its lifecycle automatically.",
      behavior: "continues_pr_lifecycle",
      settingsPath: "/settings/preferences",
      observedAt: null,
    },
    {
      id: "automatic_qa",
      label: "Automatic QA",
      status: settings?.auto_verify_enabled === 1 ? "policy_enabled" : "policy_disabled",
      scope: "viewer",
      gesture: "A settled review loop starts a dedicated QA session.",
      behavior: "continues_pr_lifecycle",
      settingsPath: "/settings/preferences",
      observedAt: null,
    },
  ];
}
