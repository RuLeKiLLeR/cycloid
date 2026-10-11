import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeFirstPartyDynamicToolCall } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "../../apps/sandbox-bridge/src/services/memory-dynamic-tool";
import {
  buildPrReviewPublishDynamicToolSpec,
  didPublishPrReviewForCurrentPrompt,
  executePrReviewPublishDynamicToolCall,
  resetPrReviewPublishContract,
  setPrReviewPublishCheckEvidence,
} from "../../apps/sandbox-bridge/src/services/pr-review-publish-dynamic-tool";

const finding = {
  path: "src/index.ts",
  line: 12,
  side: "RIGHT",
  severity: "P2",
  title: "Handle missing value",
  confidence: 3,
  bodyMarkdown: "When input is empty, this returns the wrong state.",
};

const payload = {
  summaryMarkdown: "## Summary",
  verdict: "issues_found",
  checks: [
    { command: "", reason: "No checks configured", status: "skipped", exitCode: null, detail: "No checks configured" },
  ],
  scopeNotVerified: ["Browser and runtime behavior are not verified."],
  confidenceScore: 4,
  importantFiles: [],
  findings: [finding],
  headSha: "a".repeat(40),
};
const emptyFindingsPayload = { ...payload, findings: [] };

beforeEach(() => {
  resetPrReviewPublishContract();
  setPrReviewPublishCheckEvidence("session-1", payload.checks);
});

describe("cycloid.publish_pr_review dynamic tool", () => {
  it("requires per-finding confidence in the model-facing tool schema", () => {
    const spec = buildPrReviewPublishDynamicToolSpec()[0]!;
    const findings = spec.inputSchema.properties.findings as {
      items: { properties: Record<string, unknown>; required: string[] };
    };

    expect(findings.items.properties.confidence).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 5,
    });
    expect(findings.items.required).toContain("confidence");
  });

  it("rejects calls outside the review profile", async () => {
    await expect(
      executePrReviewPublishDynamicToolCall(payload, {
        env: {},
        agentProfile: "verify",
      }),
    ).resolves.toMatchObject({ success: false, errorCode: "forbidden" });
  });

  it("publishes the structured payload and satisfies the prompt contract", async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://api.test/api/sessions/session-1/pr-review/publish");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sandbox-token");
      expect(JSON.parse(String(init?.body))).toEqual(payload);
      return new Response(JSON.stringify({ ok: true, outcome: "published" }), { status: 200 });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(CYCLOID_DYNAMIC_TOOL_NAMESPACE, "publish_pr_review", payload, {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "session-1",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        agentProfile: "review",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(didPublishPrReviewForCurrentPrompt("session-1")).toBe(true);
    expect(didPublishPrReviewForCurrentPrompt("session-2")).toBe(false);
  });

  it("publishes an empty-findings review payload", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(emptyFindingsPayload);
      return new Response(JSON.stringify({ ok: true, outcome: "published" }), { status: 200 });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(CYCLOID_DYNAMIC_TOOL_NAMESPACE, "publish_pr_review", emptyFindingsPayload, {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "session-1",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        agentProfile: "review",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(didPublishPrReviewForCurrentPrompt("session-1")).toBe(true);
  });

  it("rejects malformed input at the shared dispatch boundary", async () => {
    await expect(
      executeFirstPartyDynamicToolCall(
        CYCLOID_DYNAMIC_TOOL_NAMESPACE,
        "publish_pr_review",
        { ...payload, headSha: "short" },
        { env: {}, agentProfile: "review" },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });
  });

  it("does not satisfy the contract when publication fails", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "stale" }), { status: 409 }),
    ) as typeof fetch;

    await expect(
      executePrReviewPublishDynamicToolCall(payload, {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "session-1",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        agentProfile: "review",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ success: false, errorCode: "blocked" });
    expect(didPublishPrReviewForCurrentPrompt("session-1")).toBe(false);
  });

  it("resets only the current session publish contract", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, outcome: "published" }), { status: 200 }),
    ) as typeof fetch;

    await executePrReviewPublishDynamicToolCall(payload, {
      env: {
        CONTROL_PLANE_URL: "https://api.test",
        SESSION_ID: "session-1",
        SANDBOX_AUTH_TOKEN: "sandbox-token",
      },
      agentProfile: "review",
      fetchImpl,
    });
    setPrReviewPublishCheckEvidence("session-2", payload.checks);
    await executePrReviewPublishDynamicToolCall(payload, {
      env: {
        CONTROL_PLANE_URL: "https://api.test",
        SESSION_ID: "session-2",
        SANDBOX_AUTH_TOKEN: "sandbox-token",
      },
      agentProfile: "review",
      fetchImpl,
    });

    resetPrReviewPublishContract("session-2");

    expect(didPublishPrReviewForCurrentPrompt("session-1")).toBe(true);
    expect(didPublishPrReviewForCurrentPrompt("session-2")).toBe(false);
  });
});
