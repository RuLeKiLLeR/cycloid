import { describe, expect, it, vi } from "vitest";

import { validateFirstPartyDynamicToolInput } from "../../apps/sandbox-bridge/src/services/dynamic-tool-input-schemas.js";
import { executeFirstPartyDynamicToolCall } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js";

describe("validateFirstPartyDynamicToolInput", () => {
  it("fails closed for tools without a schema", () => {
    const result = validateFirstPartyDynamicToolInput("unknown", "tool", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no registered input schema");
  });

  it("accepts a valid company-memory input and returns the parsed value", () => {
    const result = validateFirstPartyDynamicToolInput("cycloid", "company_memory_recall", {
      intent: "find conventions",
      files: ["src/index.ts"],
    });
    expect(result).toEqual({ ok: true, value: { intent: "find conventions", files: ["src/index.ts"] } });
  });

  it("normalizes undefined input to an empty object for all-optional tools", () => {
    const result = validateFirstPartyDynamicToolInput("braintrust", "list_projects", undefined);
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("accepts infer_schema's published where filter and requires its core fields", () => {
    const valid = validateFirstPartyDynamicToolInput("braintrust", "infer_schema", {
      source_type: "project_logs",
      object_id: "proj-1",
      where: "scores.accuracy < 0.5",
    });
    expect(valid.ok).toBe(true);

    const missing = validateFirstPartyDynamicToolInput("braintrust", "infer_schema", {});
    expect(missing.ok).toBe(false);
  });

  it("rejects missing required fields with a path-qualified message", () => {
    const result = validateFirstPartyDynamicToolInput("slack", "send_message", { channel: "C1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("text");
  });

  it("rejects unknown fields", () => {
    const result = validateFirstPartyDynamicToolInput("jira", "get_issue", { keyOrId: "ENG-1", extra: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("extra");
  });

  it("rejects out-of-range numeric fields", () => {
    const result = validateFirstPartyDynamicToolInput("datadog", "search_datadog_logs", {
      query: "service:api",
      limit: 500,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("limit");
  });

  it("accepts Datadog pagination and trace lookback fields", () => {
    expect(
      validateFirstPartyDynamicToolInput("datadog", "search_datadog_logs", {
        query: "service:api",
        cursor: "next-page",
      }).ok,
    ).toBe(false);
    expect(
      validateFirstPartyDynamicToolInput("datadog", "search_datadog_logs", {
        query: "service:api",
        from: "2026-05-12T11:30:00.000Z",
        to: "2026-05-12T12:00:00.000Z",
        cursor: "next-page",
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("datadog", "get_datadog_trace", { traceId: "abc123", lookback: "72h" }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("datadog", "get_datadog_trace", { traceId: "abc123", lookback: "1w" }).ok,
    ).toBe(false);
    expect(
      validateFirstPartyDynamicToolInput("datadog", "get_datadog_trace", { traceId: "abc123", lookback: "16d" }).ok,
    ).toBe(false);
  });

  it("accepts Datadog metrics and monitor inputs", () => {
    expect(
      validateFirstPartyDynamicToolInput("datadog", "query_metrics", {
        query: "avg:system.cpu.user{*}",
        from: 1,
        to: 2,
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("datadog", "get_monitors", {
        name: "checkout",
        tags: ["team:core"],
        groupStates: "alert,warn",
        limit: 25,
      }).ok,
    ).toBe(true);
    expect(validateFirstPartyDynamicToolInput("datadog", "get_monitors", { limit: 26 }).ok).toBe(false);
  });

  it("accepts LaunchDarkly flag inputs and rejects conflicting patch operations", () => {
    expect(
      validateFirstPartyDynamicToolInput("launchdarkly", "list_feature_flags", {
        projectKey: "acme",
        environmentKey: "production",
        includeEnvironmentDetails: true,
        limit: 10,
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("launchdarkly", "list_feature_flags", {
        projectKey: "acme",
        includeEnvironmentDetails: true,
      }).ok,
    ).toBe(false);
    expect(
      validateFirstPartyDynamicToolInput("launchdarkly", "patch_feature_flag", {
        projectKey: "acme",
        featureFlagKey: "checkout-redesign",
        environmentKey: "production",
        operations: [{ kind: "set_fallthrough_variation", variationId: "var-1" }, { kind: "turn_on" }],
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("launchdarkly", "patch_feature_flag", {
        projectKey: "acme",
        featureFlagKey: "checkout-redesign",
        environmentKey: "production",
        operations: [{ kind: "turn_on" }, { kind: "turn_off" }],
      }).ok,
    ).toBe(false);
    expect(
      validateFirstPartyDynamicToolInput("launchdarkly", "patch_feature_flag", {
        projectKey: "acme",
        featureFlagKey: "checkout-redesign",
        environmentKey: "production",
        operations: [
          { kind: "set_off_variation", variationId: "var-1" },
          { kind: "set_off_variation", variationId: "var-2" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("accepts Sentry issue search input and rejects out-of-range limits", () => {
    expect(
      validateFirstPartyDynamicToolInput("sentry", "search_issues", {
        query: "is:unresolved",
        project: "web",
        statsPeriod: "24h",
        limit: 25,
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("sentry", "search_issues", { query: "is:unresolved", limit: 26 }).ok,
    ).toBe(false);
    expect(
      validateFirstPartyDynamicToolInput("sentry", "search_issues", {
        query: "is:unresolved",
        statsPeriod: "forever",
      }).ok,
    ).toBe(false);
  });

  it("accepts Jira comment and search inputs", () => {
    expect(validateFirstPartyDynamicToolInput("jira", "list_comments", { keyOrId: "ENG-1", maxResults: 50 }).ok).toBe(
      true,
    );
    expect(validateFirstPartyDynamicToolInput("jira", "list_comments", { keyOrId: "ENG-1", maxResults: 51 }).ok).toBe(
      false,
    );
    expect(validateFirstPartyDynamicToolInput("jira", "add_comment", { keyOrId: "ENG-1", body: "done" }).ok).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("jira", "search_issues", {
        jql: "project = ENG",
        nextPageToken: "next-1",
        maxResults: 25,
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("jira", "search_issues", { jql: "project = ENG", maxResults: 26 }).ok,
    ).toBe(false);
  });

  it("accepts Vercel deployment lookup inputs", () => {
    expect(
      validateFirstPartyDynamicToolInput("vercel", "get_deployment_for_ref", {
        projectId: "prj_Bqdyj3q4mVCKqNnMA2mXfoOYbJWo",
        gitRef: "main",
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("vercel", "get_preview_url", {
        projectId: "prj_Bqdyj3q4mVCKqNnMA2mXfoOYbJWo",
        gitSha: "1ea5d401db3e2ac68148fe5187ad664a0e64b4cb",
      }).ok,
    ).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("vercel", "get_preview_url", {
        projectId: "prj_Bqdyj3q4mVCKqNnMA2mXfoOYbJWo",
      }).ok,
    ).toBe(false);
    expect(validateFirstPartyDynamicToolInput("vercel", "get_preview_url", { gitRef: "main" }).ok).toBe(false);
  });

  it("requires valid per-finding confidence for native PR review publication", () => {
    const validPayload = {
      summaryMarkdown: "## Summary",
      verdict: "clear",
      checks: [
        {
          command: "",
          reason: "No checks configured",
          status: "skipped",
          exitCode: null,
          detail: "No checks configured",
        },
      ],
      scopeNotVerified: ["Browser and runtime behavior are not verified."],
      confidenceScore: 4,
      importantFiles: [],
      findings: [
        {
          path: "src/index.ts",
          line: 12,
          side: "RIGHT",
          severity: "P2",
          title: "Handle missing value",
          confidence: 3,
          bodyMarkdown: "When input is empty, this returns the wrong state.",
        },
      ],
      headSha: "a".repeat(40),
    };

    expect(validateFirstPartyDynamicToolInput("cycloid", "publish_pr_review", validPayload).ok).toBe(true);
    expect(
      validateFirstPartyDynamicToolInput("cycloid", "publish_pr_review", {
        ...validPayload,
        findings: validPayload.findings.map(({ confidence: _confidence, ...finding }) => finding),
      }).ok,
    ).toBe(false);
    expect(
      validateFirstPartyDynamicToolInput("cycloid", "publish_pr_review", {
        ...validPayload,
        findings: [{ ...validPayload.findings[0], confidence: 0 }],
      }).ok,
    ).toBe(false);
  });
});

describe("executeFirstPartyDynamicToolCall input enforcement", () => {
  it("returns invalid_input before reaching the tool", async () => {
    const fetchImpl = (() => {
      throw new Error("network must not be reached for invalid input");
    }) as unknown as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "linear",
      "create_issue",
      { teamId: "team-1" },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
    expect(result.contentItems[0]?.text).toContain("linear.create_issue input invalid");
    expect(result.contentItems[0]?.text).toContain("Recovery: Fix the arguments to match the tool schema and retry.");
  });

  it("scrubs JQL values from dynamic tool failure prompt logs", async () => {
    const promptLog = { warn: vi.fn() };
    const jql = 'assignee = "ada@example.com"';
    const result = await executeFirstPartyDynamicToolCall(
      "jira",
      "search_issues",
      { jql },
      {
        env: { JIRA_ACCESS_TOKEN: "jira-token", JIRA_CLOUD_ID: "cloud-1" },
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify({ errorMessages: [`Bad JQL: ${jql}`] }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        ) as typeof fetch,
        promptLog,
      },
    );

    expect(result).toMatchObject({ success: false, errorCode: "upstream_error" });
    const logged = promptLog.warn.mock.calls[0]?.[0] as { reason?: string } | undefined;
    expect(logged?.reason).toContain("Bad JQL: [redacted]");
    expect(logged?.reason).not.toContain("ada@example.com");
  });
});
