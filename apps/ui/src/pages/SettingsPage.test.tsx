import { describe, expect, it } from "vitest";

import type { BootstrapCapabilities } from "../../../../shared/types/bootstrap";
import { getSettingsTabAccess, SETTINGS_GROUPS, type SettingsTabAccess } from "./SettingsPage";

function capabilities(overrides: Partial<BootstrapCapabilities>): BootstrapCapabilities {
  return {
    canAccessIntegrationDebug: false,
    canManageBusinessIntegrations: false,
    canManageCliTokens: false,
    canUseBusinessSessions: false,
    canAdminPendingSignups: false,
    canStartSupportView: false,
    canUseInternalModelProviderKeys: false,
    computerUse: false,
    canUseControlRoom: false,
    planApproval: false,
    ...overrides,
  };
}

const ADMIN = capabilities({ canManageBusinessIntegrations: true, canAccessIntegrationDebug: true });
const MEMBER = capabilities({});

function accessByRoute(caps: BootstrapCapabilities | null): Record<string, SettingsTabAccess> {
  const result: Record<string, SettingsTabAccess> = {};
  for (const group of SETTINGS_GROUPS) {
    for (const tab of group.tabs) {
      result[tab.to] = getSettingsTabAccess(tab, caps);
    }
  }
  return result;
}

describe("getSettingsTabAccess", () => {
  it("keeps every Account tab enabled regardless of capabilities (no CLI-token gate)", () => {
    const access = accessByRoute(MEMBER);
    for (const to of [
      "/settings/get-started",
      "/settings/preferences",
      "/settings/integrations",
      "/settings/api-keys",
      "/settings/cli-tokens",
      "/settings/usage",
    ]) {
      expect(access[to]).toBe("enabled");
    }
  });

  it("shows workspace admin tabs to members but disabled", () => {
    const access = accessByRoute(MEMBER);
    expect(access["/settings/workspace-policies"]).toBe("disabled");
    expect(access["/settings/workspace-integrations"]).toBe("disabled");
    expect(access["/settings/slack-memory"]).toBe("disabled");
    expect(access["/settings/mcp-servers"]).toBe("disabled");
  });

  it("enables all workspace tabs for admins", () => {
    const access = accessByRoute(ADMIN);
    for (const to of [
      "/settings/workspace-policies",
      "/settings/workspace-integrations",
      "/settings/slack-memory",
      "/settings/mcp-servers",
    ]) {
      expect(access[to]).toBe("enabled");
    }
  });

  it("keeps the Repositories tab visible and enabled for everyone (member-usable review checklist)", () => {
    expect(accessByRoute(MEMBER)["/settings/repositories"]).toBe("enabled");
    expect(accessByRoute(ADMIN)["/settings/repositories"]).toBe("enabled");
    expect(accessByRoute(null)["/settings/repositories"]).toBe("enabled");
  });

  it("places the Repositories group between Account and Workspace", () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual(["Account", "Repositories", "Workspace", "System"]);
  });

  it("hides capability-gated tabs from members entirely", () => {
    const access = accessByRoute(MEMBER);
    expect(access["/settings/diagnostics"]).toBe("hidden");
  });

  it("treats missing capabilities as no access", () => {
    const access = accessByRoute(null);
    expect(access["/settings/workspace-policies"]).toBe("disabled");
    expect(access["/settings/diagnostics"]).toBe("hidden");
  });

  it("keeps the Getting started label static (no setup-complete flip)", () => {
    const accountTab = SETTINGS_GROUPS.find((group) => group.label === "Account")?.tabs[0];
    expect(accountTab?.label).toBe("Getting started");
    expect(accountTab?.to).toBe("/settings/get-started");
  });
});
