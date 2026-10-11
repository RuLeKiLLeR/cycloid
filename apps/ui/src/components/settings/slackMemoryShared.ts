import type { SlackWorkspaceMemoryChannel, SlackWorkspaceMemoryInstall } from "../../api/company-memory";

// Shared by WorkspaceMemorySettings and SlackAlertAutomationSettings so the
// Slack workspace/channel option labels read identically on both surfaces.
export function workspaceLabel(workspace: SlackWorkspaceMemoryInstall): string {
  const name = workspace.teamName ?? workspace.teamDomain ?? workspace.teamId;
  return `${name} (${workspace.teamId})`;
}

export function channelLabel(channel: SlackWorkspaceMemoryChannel): string {
  return `${channel.isPrivate ? "Private" : "Public"} #${channel.name}`;
}
