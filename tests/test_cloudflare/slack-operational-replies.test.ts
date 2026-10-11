import { describe, expect, it } from "vitest";

import {
  SLACK_MISSING_MODEL_KEY_REPLY_PREFIX,
  SLACK_OPERATIONAL_REPLY_PREFIXES,
  SLACK_WAKE_ARCHIVED_REPLY,
  SLACK_WAKE_RESUME_FAILED_REPLY,
  SLACK_WAKE_RETRY_NUDGE_REPLY,
  slackLinkDmAlreadySentReply,
  slackLinkDmSentReply,
  slackMissingModelKeyReply,
  slackThreadAlreadyAssociatedReply,
} from "../../apps/control-plane-worker/src/webhooks/slack-operational-replies";
import { ONBOARDING_REASON_CODES, type OnboardingReasonCode } from "../../shared/constants/onboarding";

describe("slack magic-link DM replies", () => {
  it("distinguishes a just-sent DM from an already-sent (rate-limited) DM", () => {
    const sent = slackLinkDmSentReply();
    const alreadySent = slackLinkDmAlreadySentReply();

    expect(sent).not.toBe(alreadySent);
    expect(sent).toContain("I just sent you a DM");
    expect(alreadySent).toContain("I already sent you a DM");
    expect(alreadySent).toContain("mention me again");
  });

  it("registers both reply prefixes as operational replies", () => {
    expect(SLACK_OPERATIONAL_REPLY_PREFIXES.some((p) => slackLinkDmSentReply().startsWith(p))).toBe(true);
    expect(SLACK_OPERATIONAL_REPLY_PREFIXES.some((p) => slackLinkDmAlreadySentReply().startsWith(p))).toBe(true);
  });
});

describe("slack missing model key replies", () => {
  const base = {
    modelLabel: "Anthropic / Claude Opus 4.8",
    provider: "anthropic" as const,
    integrationsUrl: "https://app.trycycloid.com/settings/integrations",
    workspaceIntegrationsUrl: "https://app.trycycloid.com/settings/workspace-integrations",
    generalUrl: "https://app.trycycloid.com/settings/preferences",
  };

  it.each([
    [ONBOARDING_REASON_CODES.CREDENTIALS_MISSING, "Add an Anthropic key"],
    [ONBOARDING_REASON_CODES.CREDENTIALS_INVALID, "failed validation"],
    [ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT, "saved but not yet validated"],
    [ONBOARDING_REASON_CODES.BUSINESS_MANAGED, "business manages the Anthropic key"],
    [ONBOARDING_REASON_CODES.INTEGRATION_DISABLED, "Anthropic is disabled for your business"],
    [ONBOARDING_REASON_CODES.DB_LOOKUP_FAILED, "Add or fix your Anthropic key"],
  ] satisfies Array<[OnboardingReasonCode, string]>)("tailors copy for %s", (reasonCode, expectedCopy) => {
    const reply = slackMissingModelKeyReply({ ...base, reasonCode });

    expect(reply).toContain(SLACK_MISSING_MODEL_KEY_REPLY_PREFIX);
    expect(reply).toContain("Anthropic / Claude Opus 4.8");
    expect(reply).toContain(expectedCopy);
    expect(reply).toContain("<https://app.trycycloid.com/settings/preferences|change your default model>");
  });

  it("uses the correct article for OpenAI provider key copy", () => {
    const reply = slackMissingModelKeyReply({
      ...base,
      modelLabel: "OpenAI / GPT-5.5",
      provider: "openai",
      reasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_MISSING,
    });

    expect(reply).toContain("Add an OpenAI key");
    expect(reply).toContain("<https://app.trycycloid.com/settings/integrations|add or fix your OpenAI key>");
  });

  it("names Baseten keys for opencode models", () => {
    const reply = slackMissingModelKeyReply({
      ...base,
      modelLabel: "Baseten / Kimi-K2.7-Code",
      provider: "baseten",
      reasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_MISSING,
    });

    expect(reply).toContain("Add a Baseten key");
    expect(reply).toContain("<https://app.trycycloid.com/settings/integrations|add or fix your Baseten key>");
    expect(reply).not.toContain("Anthropic key");
  });

  it("routes business-scoped fixes to workspace integrations", () => {
    const businessManaged = slackMissingModelKeyReply({
      ...base,
      reasonCode: ONBOARDING_REASON_CODES.BUSINESS_MANAGED,
    });
    const disabled = slackMissingModelKeyReply({ ...base, reasonCode: ONBOARDING_REASON_CODES.INTEGRATION_DISABLED });

    for (const reply of [businessManaged, disabled]) {
      expect(reply).toContain("<https://app.trycycloid.com/settings/workspace-integrations|workspace integrations>");
      expect(reply).not.toContain("<https://app.trycycloid.com/settings/integrations|add or fix your Anthropic key>");
      expect(reply).toContain("<https://app.trycycloid.com/settings/preferences|change your default model>");
    }
  });

  it("registers the reply prefix as operational", () => {
    expect(SLACK_OPERATIONAL_REPLY_PREFIXES).toContain(SLACK_MISSING_MODEL_KEY_REPLY_PREFIX);
  });
});

describe("slack wake replies", () => {
  it("only the still-starting association variant survives (dead-end copy retired)", () => {
    const reply = slackThreadAlreadyAssociatedReply();
    expect(reply).toContain("still starting");
    expect(reply).not.toContain("terminated");
  });

  it("tells archived sessions to start fresh", () => {
    expect(SLACK_WAKE_ARCHIVED_REPLY).toBe("This session is archived. Start a new session to continue.");
  });

  it("registers every wake reply prefix as operational", () => {
    for (const reply of [SLACK_WAKE_RETRY_NUDGE_REPLY, SLACK_WAKE_ARCHIVED_REPLY, SLACK_WAKE_RESUME_FAILED_REPLY]) {
      expect(SLACK_OPERATIONAL_REPLY_PREFIXES.some((prefix) => reply.startsWith(prefix))).toBe(true);
    }
  });
});
