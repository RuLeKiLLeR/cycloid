import { describe, expect, it } from "vitest";

import { buildNextSteps, ctaForStep } from "../../apps/ui/src/components/settings/GetStartedSettings";
import { ONBOARDING_STEP_STATUS } from "../../shared/constants/onboarding";

describe("GetStartedSettings next steps", () => {
  it("keeps optional setup focused on integrations and omits the review-loop tile", () => {
    const { optional } = buildNextSteps({
      linearConnected: false,
      slackConnected: false,
      notionConnected: false,
      jiraConnected: false,
      canManageWorkspaceIntegrations: true,
      canManageCliTokens: false,
      workspaceAvailable: new Set(),
      slackWorkspaceInstalled: false,
    });

    expect(optional.map((step) => step.key)).toEqual(["workspace-integrations", "personal-integrations"]);
    expect(optional.find((step) => step.key === "review-loop")).toBeUndefined();
  });
});

describe("GetStartedSettings required-step CTAs point at canonical homes", () => {
  it("routes the default-repo step to Preferences", () => {
    expect(ctaForStep("default_repo", ONBOARDING_STEP_STATUS.NOT_CONNECTED, null)).toEqual({
      kind: "internal",
      to: "/settings/preferences",
      label: "Choose default repo",
    });
    expect(ctaForStep("default_repo", ONBOARDING_STEP_STATUS.CONNECTED, null)).toMatchObject({
      kind: "internal",
      to: "/settings/preferences",
      label: "Change default repo",
    });
  });

  it("routes the model-key step to the Model API keys page", () => {
    expect(ctaForStep("openai_key", ONBOARDING_STEP_STATUS.NOT_CONNECTED, null)).toEqual({
      kind: "internal",
      to: "/settings/api-keys",
      label: "Add a model API key",
    });
    expect(ctaForStep("openai_key", ONBOARDING_STEP_STATUS.CONNECTED, null)).toMatchObject({
      kind: "internal",
      to: "/settings/api-keys",
      label: "Manage API keys",
    });
  });

  it("suppresses the model-key CTA when the key is admin-managed or disabled", () => {
    expect(ctaForStep("openai_key", ONBOARDING_STEP_STATUS.BUSINESS_MANAGED, null)).toBeNull();
    expect(ctaForStep("openai_key", ONBOARDING_STEP_STATUS.DISABLED, null)).toBeNull();
  });
});
