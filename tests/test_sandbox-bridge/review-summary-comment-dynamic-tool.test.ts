import { describe, expect, it, vi } from "vitest";

import {
  executeFirstPartyDynamicToolCall,
  redactFirstPartyDynamicToolInputForPersistence,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import { REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME } from "../../apps/sandbox-bridge/src/services/review-summary-comment-dynamic-tool";

describe("cycloid.review_summary_comment dynamic tool", () => {
  it("exports the expected tool name", () => {
    expect(REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME).toBe("review_summary_comment");
  });

  it("rejects missing epochId with invalid_input", async () => {
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        { body: "Summary body here." },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("rejects missing body with invalid_input", async () => {
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        { epochId: "epoch-1" },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("rejects body exceeding 8 KB with invalid_input", async () => {
    const oversizedBody = "x".repeat(8 * 1024 + 1);
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        { epochId: "epoch-1", body: oversizedBody },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("forwards epochId and body to the right control-plane path and surfaces githubCommentId", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(String(_input)).toBe("https://api.test/api/sessions/sess-1/review-loop/summary-comment");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sandbox-auth");
      expect(JSON.parse(String(init?.body))).toEqual({
        epochId: "epoch-1",
        body: "Here is a summary of my changes.",
      });
      return new Response(JSON.stringify({ ok: true, githubCommentId: "github-comment-42" }), { status: 200 });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        {
          epochId: "epoch-1",
          body: "Here is a summary of my changes.",
        },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ ok: true, githubCommentId: "github-comment-42" }),
        },
      ],
    });
  });

  it("includes optional promptId in the request body when provided", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        epochId: "epoch-1",
        body: "Summary here.",
        promptId: "prompt-abc",
      });
      return new Response(JSON.stringify({ ok: true, githubCommentId: "github-comment-99" }), { status: 200 });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        {
          epochId: "epoch-1",
          body: "Summary here.",
          promptId: "prompt-abc",
        },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({ success: true });
  });

  it.each([
    [400, "invalid_input"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "blocked"],
    [429, "upstream_rate_limited"],
    [503, "upstream_rate_limited"],
    [500, "upstream_error"],
    [502, "upstream_error"],
  ])("maps HTTP status %i to errorCode %s", async (status, expectedErrorCode) => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, reason: "some error" }), { status }),
    ) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        { epochId: "epoch-1", body: "Summary." },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: expectedErrorCode,
    });
  });

  it("returns cancelled on abort", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        { epochId: "epoch-1", body: "Summary." },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
          signal: controller.signal,
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "cancelled",
    });
  });

  it("returns cancelled when the control-plane request times out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "review_summary_comment",
        { epochId: "epoch-1", body: "Summary." },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            REVIEW_LOOP_SOURCE_KIND: "human",
          },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "cancelled",
    });
  });

  it("redacts summary bodies before persistence", () => {
    expect(
      redactFirstPartyDynamicToolInputForPersistence("cycloid", "review_summary_comment", {
        epochId: "epoch-1",
        promptId: "prompt-1",
        body: "Summary body here.",
      }),
    ).toEqual({
      epochId: "epoch-1",
      promptId: "prompt-1",
      bodyLength: 18,
      bodyRedacted: true,
    });
  });
});
