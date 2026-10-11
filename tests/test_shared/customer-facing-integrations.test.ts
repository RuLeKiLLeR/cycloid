import { describe, expect, it } from "vitest";

import {
  CUSTOMER_FACING_API_KEY_PROVIDER_IDS,
  isCustomerFacingIntegration,
  TOGGLEABLE_INTEGRATION_IDS,
  USER_API_KEY_PROVIDER_IDS,
  USER_OAUTH_INTEGRATION_IDS,
} from "../../shared/constants/integration-helpers";
import { INTEGRATION_REGISTRY } from "../../shared/constants/integrations";

describe("customer-facing API-key provider gating", () => {
  it("hides customerFacing:false providers from the customer-facing list", () => {
    expect(INTEGRATION_REGISTRY.anthropic.customerFacing).toBe(false);
    expect(CUSTOMER_FACING_API_KEY_PROVIDER_IDS).not.toContain("anthropic");
  });

  it("keeps customerFacing (default) providers visible", () => {
    expect(CUSTOMER_FACING_API_KEY_PROVIDER_IDS).toContain("openai");
    expect(CUSTOMER_FACING_API_KEY_PROVIDER_IDS).toContain("baseten");
  });

  it("leaves the backend USER_API_KEY_PROVIDER_IDS allowlist unchanged", () => {
    // Load-bearing invariant: the backend list still includes anthropic, so credential
    // storage, validation, and spawn-time resolution for claude_code keep working.
    expect(USER_API_KEY_PROVIDER_IDS).toContain("anthropic");
    expect(USER_API_KEY_PROVIDER_IDS).toContain("baseten");
    expect(USER_API_KEY_PROVIDER_IDS).toContain("openai");
  });

  it("customer-facing list is a subset of the backend list", () => {
    for (const id of CUSTOMER_FACING_API_KEY_PROVIDER_IDS) {
      expect(USER_API_KEY_PROVIDER_IDS).toContain(id);
    }
  });
});

describe("isCustomerFacingIntegration", () => {
  it("returns false only for customerFacing:false entries", () => {
    expect(isCustomerFacingIntegration("anthropic")).toBe(false);
    expect(isCustomerFacingIntegration("baseten")).toBe(true);
    expect(isCustomerFacingIntegration("openai")).toBe(true);
    expect(isCustomerFacingIntegration("slack")).toBe(true);
  });

  it("hides anthropic from the business integrations row list (TOGGLEABLE)", () => {
    const visible = TOGGLEABLE_INTEGRATION_IDS.filter(isCustomerFacingIntegration);
    expect(visible).not.toContain("anthropic");
    expect(visible).toContain("slack");
    expect(visible).toContain("linear");
  });

  it("leaves OAuth rows unchanged (no OAuth integration is hidden today)", () => {
    const visible = USER_OAUTH_INTEGRATION_IDS.filter(isCustomerFacingIntegration);
    expect(visible).toEqual([...USER_OAUTH_INTEGRATION_IDS]);
    expect(USER_OAUTH_INTEGRATION_IDS).toContain("jira");
  });
});
