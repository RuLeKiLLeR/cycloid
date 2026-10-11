import { describe, expect, it } from "vitest";

import {
  BUSINESS_ONLY_SET,
  type IntegrationScope,
  TOGGLEABLE_INTEGRATION_IDS,
  type ToggleableIntegrationId,
} from "../../apps/control-plane-worker/src/enums/integrations.js";
import { defaultScope, deriveAvailableIntegrations } from "../../apps/control-plane-worker/src/integrations/service.js";

function makeScopes(
  overrides: Partial<Record<ToggleableIntegrationId, IntegrationScope>> = {},
): Record<ToggleableIntegrationId, IntegrationScope> {
  const scopes = {} as Record<ToggleableIntegrationId, IntegrationScope>;
  for (const id of TOGGLEABLE_INTEGRATION_IDS) {
    scopes[id] = defaultScope(id);
  }
  return { ...scopes, ...overrides };
}

describe("deriveAvailableIntegrations", () => {
  it("excludes disabled integrations", () => {
    const scopes = makeScopes({ linear: "disabled" });
    const available = deriveAvailableIntegrations(scopes);
    expect(available).toContain("github");
    expect(available).not.toContain("linear");
  });

  it("includes user-scoped integrations", () => {
    const scopes = makeScopes({ linear: "user" });
    const available = deriveAvailableIntegrations(scopes);
    expect(available).toContain("linear");
  });

  it("includes business-scoped provider integrations", () => {
    const scopes = makeScopes({ openai: "business" });
    const available = deriveAvailableIntegrations(scopes);
    expect(available).toContain("openai");
  });

  it("always includes github", () => {
    const scopes = makeScopes();
    const available = deriveAvailableIntegrations(scopes);
    expect(available).toContain("github");
  });

  it("jira defaults to user scope and is available", () => {
    const scopes = makeScopes();
    expect(scopes.jira).toBe("user");
    expect(deriveAvailableIntegrations(scopes)).toContain("jira");
  });

  it("jira can be disabled per business", () => {
    const scopes = makeScopes({ jira: "disabled" });
    expect(deriveAvailableIntegrations(scopes)).not.toContain("jira");
  });
});

describe("business-only integration defaults", () => {
  it("business-only integrations default to disabled scope", () => {
    const scopes = makeScopes();
    for (const id of BUSINESS_ONLY_SET) {
      expect(scopes[id as ToggleableIntegrationId]).toBe("disabled");
    }
  });

  it("business-only integrations are excluded from available when at default scope", () => {
    const scopes = makeScopes();
    const available = new Set(deriveAvailableIntegrations(scopes));
    for (const id of BUSINESS_ONLY_SET) {
      expect(available.has(id as ToggleableIntegrationId)).toBe(false);
    }
  });

  it("non-business-only integrations default to user scope", () => {
    const scopes = makeScopes();
    for (const id of TOGGLEABLE_INTEGRATION_IDS) {
      if (!BUSINESS_ONLY_SET.has(id)) {
        expect(scopes[id]).toBe("user");
      }
    }
  });
});
