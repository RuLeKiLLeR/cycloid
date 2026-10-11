import { describe, expect, it, vi } from "vitest";

import {
  executeFirstPartyDynamicToolCall,
  redactFirstPartyDynamicToolInputForPersistence,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";

describe("cycloid.review_loop_reply dynamic tool", () => {
  it("proxies guarded review-loop replies through the control plane route", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(String(_input)).toBe("https://api.test/api/sessions/sess-1/review-loop/reply");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sandbox-auth");
      expect(JSON.parse(String(init?.body))).toEqual({
        epochId: "epoch-1",
        targetSourceId: "review-comment:10",
        verdict: "fixed",
        body: "Fixed in the latest push.",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          status: "replied",
          operationId: "op-1",
          githubId: "987",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_loop_reply",
        {
          epochId: "epoch-1",
          targetSourceId: "review-comment:10",
          verdict: "fixed",
          body: "Fixed in the latest push.",
        },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
          },
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ ok: true, status: "replied", operationId: "op-1", githubId: "987" }),
        },
      ],
    });
  });

  it("returns cancelled when the control-plane request times out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_loop_reply",
        {
          epochId: "epoch-1",
          targetSourceId: "review-comment:10",
          verdict: "fixed",
          body: "Fixed in the latest push.",
        },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
          },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "cancelled",
    });
  });

  it("redacts reply bodies before persistence", () => {
    expect(
      redactFirstPartyDynamicToolInputForPersistence("cycloid", "review_loop_reply", {
        epochId: "epoch-1",
        promptId: "prompt-1",
        targetSourceId: "issue-comment:20",
        verdict: "fixed",
        body: "Fixed in the latest push.",
      }),
    ).toEqual({
      epochId: "epoch-1",
      promptId: "prompt-1",
      targetSourceId: "issue-comment:20",
      verdict: "fixed",
      bodyLength: 25,
      bodyRedacted: true,
    });
  });
});
