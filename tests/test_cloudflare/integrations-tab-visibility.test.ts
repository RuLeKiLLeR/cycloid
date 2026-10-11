import { describe, expect, it } from "vitest";

import {
  BUSINESS_ONLY_INTEGRATION_IDS,
  BUSINESS_WIDE_INTEGRATION_IDS,
  INTEGRATION_DISPLAY_NAMES,
  USER_API_KEY_PROVIDER_IDS,
  USER_OAUTH_INTEGRATION_IDS,
} from "../../shared/constants/integration-helpers.js";

/**
 * Tests the visibility rules for the personal Integrations tab.
 *
 * Rules:
 * - GitHub: always shown (hardcoded)
 * - User-managed (Linear, Slack): shown if in availableIntegrations;
 *   "Disabled by admin" if not available; Connect/Disconnect if available
 * - Business-only (Sentry, Datadog, LaunchDarkly, Cloudflare, Braintrust, Neon, Terraform):
 *   shown only when scopes[id] === "business"; hidden otherwise
 */

// Mirrors the logic in IntegrationsSettings.tsx
function isDisabledByAdmin(available: Set<string>, integrationId: string): boolean {
  return !available.has(integrationId);
}

function getVisibleBusinessOnlyIntegrations(scopes: Record<string, string>): string[] {
  return [...BUSINESS_ONLY_INTEGRATION_IDS].filter((id) => scopes[id] === "business");
}

function getUserIntegrationState(
  available: Set<string>,
  connected: boolean,
  id: string,
): "disabled" | "connected" | "not_connected" {
  if (isDisabledByAdmin(available, id)) return "disabled";
  return connected ? "connected" : "not_connected";
}

describe("Integrations tab: user-managed integrations", () => {
  it("shows 'disabled' when integration is not in available set", () => {
    const available = new Set<string>([]);
    expect(getUserIntegrationState(available, false, "linear")).toBe("disabled");
    expect(getUserIntegrationState(available, false, "slack")).toBe("disabled");
  });

  it("shows 'connected' when available and connected", () => {
    const available = new Set(["linear", "slack"]);
    expect(getUserIntegrationState(available, true, "linear")).toBe("connected");
    expect(getUserIntegrationState(available, true, "slack")).toBe("connected");
  });

  it("shows 'not_connected' when available but not connected", () => {
    const available = new Set(["linear", "slack"]);
    expect(getUserIntegrationState(available, false, "linear")).toBe("not_connected");
  });

  it("disabled status overrides connected status", () => {
    const available = new Set<string>([]);
    expect(getUserIntegrationState(available, true, "linear")).toBe("disabled");
  });
});

describe("Integrations tab: business-only integrations", () => {
  it("returns an empty list when no business-only integrations exist", () => {
    const scopes = {};
    const visible = getVisibleBusinessOnlyIntegrations(scopes);
    expect(visible).toEqual([]);
  });

  it("all business-only IDs have labels", () => {
    for (const id of BUSINESS_ONLY_INTEGRATION_IDS) {
      expect(INTEGRATION_DISPLAY_NAMES[id]).toBeDefined();
    }
  });
});

describe("business settings visibility groups", () => {
  it("includes hidden business credential integrations in the business-only group", () => {
    expect([...BUSINESS_ONLY_INTEGRATION_IDS]).toEqual([
      "sentry",
      "datadog",
      "launchdarkly",
      "cloudflare",
      "braintrust",
      "neon",
      "stripe",
      "terraform",
      "vercel",
    ]);
  });

  it("keeps delegated OAuth integrations user-scoped", () => {
    expect([...USER_OAUTH_INTEGRATION_IDS]).toEqual(["slack", "linear", "jira", "notion"]);
  });

  it("includes user API-key providers in the business-wide group", () => {
    const businessScopeApiKeyProviders = USER_API_KEY_PROVIDER_IDS.filter((id) => id !== "baseten");
    expect(BUSINESS_WIDE_INTEGRATION_IDS).toEqual(expect.arrayContaining(businessScopeApiKeyProviders));
    expect(BUSINESS_WIDE_INTEGRATION_IDS).not.toContain("baseten");
  });

  it("keeps user OAuth integrations out of the business-only group", () => {
    for (const id of USER_OAUTH_INTEGRATION_IDS) {
      expect(BUSINESS_ONLY_INTEGRATION_IDS).not.toContain(id);
    }
  });
});
