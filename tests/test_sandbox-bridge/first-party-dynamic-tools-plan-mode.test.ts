import { describe, expect, it, vi } from "vitest";

import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
  getFirstPartyDynamicToolPlanMode,
  getFirstPartyDynamicToolPlanModeDeclarations,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js";
import {
  checkToolSafety,
  FIRST_PARTY_DYNAMIC_TOOL_NAMESPACES,
} from "../../apps/sandbox-bridge/src/utils/protection.js";
import { PLAN_AGENT_NAME } from "../../shared/agent/constants.js";

const VERIFICATION_ALLOWED_SIDE_EFFECTING_TOOLS = new Set<string>();
const REVIEW_ALLOWED_SIDE_EFFECTING_TOOLS = new Set<string>(["cycloid.publish_pr_review"]);

describe("first-party dynamic tool plan-mode policy", () => {
  it("requires every registered dynamic tool to declare plan-mode disposition", () => {
    expect(getFirstPartyDynamicToolPlanModeDeclarations()).not.toHaveLength(0);
    for (const declaration of getFirstPartyDynamicToolPlanModeDeclarations()) {
      expect(["readOnly", "sideEffecting"], declaration.key).toContain(declaration.planMode);
    }
  });

  it("keeps the fail-closed dynamic tool namespace fallback in sync with the registry", () => {
    const registeredNamespaces = new Set(
      getFirstPartyDynamicToolPlanModeDeclarations().map((declaration) => declaration.namespace),
    );

    expect([...registeredNamespaces].sort()).toEqual([...FIRST_PARTY_DYNAMIC_TOOL_NAMESPACES].sort());
  });

  it("blocks side-effecting dynamic tools before validation or external calls in plan mode", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("blocked tool must not reach fetch");
    }) as unknown as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "send_message",
      {},
      { env: { SLACK_BOT_TOKEN: "x" }, fetchImpl, agentProfile: PLAN_AGENT_NAME },
    );

    expect(result).toEqual({
      success: false,
      errorCode: "blocked",
      contentItems: [
        {
          type: "inputText",
          text: "Policy block: plan mode is read-only; first-party dynamic tool 'slack.send_message' is not permitted.",
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows desktop tools in verification sessions while preserving other side-effecting blocks", () => {
    const verificationToolNames = new Set(
      buildAllDynamicToolSpecs({
        ARCANIST_CUA_ENABLED: "1",
        ARCANIST_AGENT_ROLE: "verification",
        ARCANIST_MEMORY_TOOLS_ENABLED: "1",
        ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1",
        SESSION_ID: "session-1",
        SANDBOX_AUTH_TOKEN: "sandbox-token",
        BRAINTRUST_INTEGRATION_API_KEY: "braintrust-token",
        CF_ACCOUNT_ID: "account",
        CF_D1_DATABASE_ID: "database",
        CF_API_TOKEN: "cloudflare-token",
        DD_API_KEY: "datadog-api",
        DD_APP_KEY: "datadog-app",
        DD_SITE: "datadoghq.com",
        JIRA_ACCESS_TOKEN: "jira-token",
        JIRA_CLOUD_ID: "jira-cloud",
        LAUNCHDARKLY_ACCESS_TOKEN: "launchdarkly-token",
        LINEAR_ACCESS_TOKEN: "linear-token",
        NOTION_ACCESS_TOKEN: "notion-token",
        SENTRY_ACCESS_TOKEN: "sentry-token",
        SENTRY_ORGANIZATION_SLUG: "acme",
        SLACK_SESSION_TEAM_ID: "T123",
        ARCANIST_TERRAFORM_PLAN_TOKEN: "terraform-token",
        VERCEL_ACCESS_TOKEN: "vercel-token",
      }).map((tool) => `${tool.namespace}.${tool.name}`),
    );

    for (const declaration of getFirstPartyDynamicToolPlanModeDeclarations()) {
      if (
        declaration.planMode === "sideEffecting" &&
        declaration.namespace !== "desktop" &&
        !VERIFICATION_ALLOWED_SIDE_EFFECTING_TOOLS.has(declaration.key)
      ) {
        expect(verificationToolNames, declaration.key).not.toContain(declaration.key);
      } else if (
        declaration.namespace === "desktop" ||
        VERIFICATION_ALLOWED_SIDE_EFFECTING_TOOLS.has(declaration.key)
      ) {
        expect(verificationToolNames, declaration.key).toContain(declaration.key);
      }
    }
    expect(verificationToolNames).toContain("linear.get_issue");
  });

  it("gives review sessions only their structured publish mutation", () => {
    const reviewToolNames = new Set(
      buildAllDynamicToolSpecs({
        ARCANIST_AGENT_ROLE: "review",
        SESSION_ID: "session-1",
        SANDBOX_AUTH_TOKEN: "sandbox-token",
        LINEAR_ACCESS_TOKEN: "linear-token",
      }).map((tool) => `${tool.namespace}.${tool.name}`),
    );

    for (const declaration of getFirstPartyDynamicToolPlanModeDeclarations()) {
      if (declaration.planMode === "sideEffecting" && !REVIEW_ALLOWED_SIDE_EFFECTING_TOOLS.has(declaration.key)) {
        expect(reviewToolNames, declaration.key).not.toContain(declaration.key);
      }
    }
    expect(reviewToolNames).toContain("cycloid.publish_pr_review");
  });

  it("blocks side-effecting dynamic tools before validation or external calls in verification sessions", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("blocked tool must not reach fetch");
    }) as unknown as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "send_message",
      {},
      { env: { SLACK_BOT_TOKEN: "x" }, fetchImpl, agentRole: "verification" },
    );

    expect(result).toEqual({
      success: false,
      errorCode: "blocked",
      contentItems: [
        {
          type: "inputText",
          text: "Policy block: verification sessions cannot use side-effecting first-party dynamic tool 'slack.send_message'.",
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks the LaunchDarkly flag patch tool in verification sessions", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("blocked tool must not reach fetch");
    }) as unknown as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "launchdarkly",
      "patch_feature_flag",
      {
        projectKey: "acme",
        featureFlagKey: "checkout-redesign",
        environmentKey: "production",
        operations: [{ kind: "turn_on" }],
      },
      { env: { LAUNCHDARKLY_ACCESS_TOKEN: "launchdarkly-token" }, fetchImpl, agentRole: "verification" },
    );

    expect(result).toEqual({
      success: false,
      errorCode: "blocked",
      contentItems: [
        {
          type: "inputText",
          text: "Policy block: verification sessions cannot use side-effecting first-party dynamic tool 'launchdarkly.patch_feature_flag'.",
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows read-only dynamic tools to reach their normal execution path in plan mode", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "cloudflare",
      "query_d1",
      { sql: "select 1" },
      { env: {}, agentProfile: PLAN_AGENT_NAME },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).not.toBe("blocked");
  });

  it("allows desktop dynamic tools to reach their normal execution path in plan mode", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "desktop",
      "click",
      { scenarioId: "plan-desktop", actionId: "plan-click-1", x: 1, y: 1 },
      { env: {}, agentProfile: PLAN_AGENT_NAME },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).not.toBe("blocked");
  });

  it("allows read-only dynamic tools to reach their normal execution path in verification sessions", async () => {
    const result = await executeFirstPartyDynamicToolCall(
      "cloudflare",
      "query_d1",
      { sql: "select 1" },
      { env: {}, agentRole: "verification" },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).not.toBe("blocked");
  });

  it("uses registry disposition in the model-facing plan-mode safety gate", () => {
    const options = {
      agentProfile: PLAN_AGENT_NAME,
      getPlanModeToolDisposition: getFirstPartyDynamicToolPlanMode,
    };

    expect(checkToolSafety("cloudflare.query_d1", { sql: "select 1" }, options)).toBeNull();
    expect(checkToolSafety("desktop.click", { x: 1, y: 1 }, options)).toBeNull();
    expect(checkToolSafety("slack.send_message", { channel: "C1", text: "hi" }, options)).toMatchObject({
      kind: "blocked_tool",
      reasonKey: "plan_mode_read_only",
    });
    expect(checkToolSafety("linear.future_tool", {}, options)).toMatchObject({
      kind: "blocked_tool",
      reasonKey: "plan_mode_read_only",
    });
  });
});
