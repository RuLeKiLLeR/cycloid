import type { User } from "../types";

type TrackedPersonalIntegrationId = "linear" | "jira" | "notion" | "slack";

export type DisconnectedPersonalIntegrationWarning = {
  id: TrackedPersonalIntegrationId;
  label: string;
};

const STORAGE_PREFIX = "arcanist.personal_integrations.connected.v1";

const TRACKED_INTEGRATIONS: Array<{
  id: TrackedPersonalIntegrationId;
  label: string;
  isConnected: (user: User) => boolean;
}> = [
  { id: "linear", label: "Linear", isConnected: (user) => user.linearConnected },
  { id: "jira", label: "Jira", isConnected: (user) => user.jiraConnected },
  { id: "notion", label: "Notion", isConnected: (user) => user.notionConnected },
  { id: "slack", label: "Slack", isConnected: (user) => user.slackConnected },
];

function storageKey(userId: number): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

function readRemembered(userId: number): Partial<Record<TrackedPersonalIntegrationId, true>> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const remembered: Partial<Record<TrackedPersonalIntegrationId, true>> = {};
    for (const integration of TRACKED_INTEGRATIONS) {
      if ((parsed as Record<string, unknown>)[integration.id] === true) {
        remembered[integration.id] = true;
      }
    }
    return remembered;
  } catch {
    return {};
  }
}

function writeRemembered(userId: number, remembered: Partial<Record<TrackedPersonalIntegrationId, true>>): void {
  try {
    if (Object.keys(remembered).length === 0) {
      localStorage.removeItem(storageKey(userId));
      return;
    }
    localStorage.setItem(storageKey(userId), JSON.stringify(remembered));
  } catch {
    // Storage is a best-effort UI hint; failures should not affect app use.
  }
}

export function rememberConnectedPersonalIntegrations(user: User): void {
  const remembered = readRemembered(user.id);
  let changed = false;
  for (const integration of TRACKED_INTEGRATIONS) {
    if (integration.isConnected(user) && remembered[integration.id] !== true) {
      remembered[integration.id] = true;
      changed = true;
    }
  }
  if (changed) writeRemembered(user.id, remembered);
}

export function clearRememberedPersonalIntegration(userId: number, integrationId: TrackedPersonalIntegrationId): void {
  const remembered = readRemembered(userId);
  if (remembered[integrationId] !== true) return;
  delete remembered[integrationId];
  writeRemembered(userId, remembered);
}

export function getDisconnectedPersonalIntegrationWarnings(user: User): DisconnectedPersonalIntegrationWarning[] {
  const remembered = readRemembered(user.id);
  return TRACKED_INTEGRATIONS.filter(
    (integration) => remembered[integration.id] === true && !integration.isConnected(user),
  ).map((integration) => ({ id: integration.id, label: integration.label }));
}
