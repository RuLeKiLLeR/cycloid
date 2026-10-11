import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INTEGRATION_IDS } from "../../shared/constants/integration-helpers.js";

const doc = readFileSync(join(process.cwd(), "docs/adding-integrations.md"), "utf8");

const INVENTORY_LABEL_BY_ID = {
  anthropic: "Anthropic",
  baseten: "Baseten",
  braintrust: "Braintrust",
  cloudflare: "Cloudflare D1",
  codex_subscription: "Codex subscription",
  datadog: "Datadog",
  github: "GitHub",
  jira: "Jira",
  launchdarkly: "LaunchDarkly",
  linear: "Linear",
  neon: "Neon",
  notion: "Notion",
  openai: "OpenAI",
  sentry: "Sentry",
  slack: "Slack",
  stripe: "Stripe",
  terraform: "Terraform Cloud",
  vercel: "Vercel",
} satisfies Record<(typeof INTEGRATION_IDS)[number], string>;

describe("integration documentation", () => {
  it("documents scope rules for adding integrations", () => {
    expect(doc).toContain("## Scope decision rules");
    expect(doc).toContain("Use `CredentialScope.USER`");
    expect(doc).toContain("Use `CredentialScope.BUSINESS`");
    expect(doc).toContain("Do not expose business credentials to the agent child env");
  });

  it("documents every registered integration in the inventory", () => {
    for (const integrationId of INTEGRATION_IDS) {
      expect(doc).toContain(`| ${INVENTORY_LABEL_BY_ID[integrationId]}`);
    }
  });
});
