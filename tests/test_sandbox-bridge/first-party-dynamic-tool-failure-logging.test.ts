import { describe, expect, it, vi } from "vitest";

import type { BridgeLogger } from "../../apps/sandbox-bridge/src/logger";
import { executeFirstPartyDynamicToolCall } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";

function makePromptLog(): BridgeLogger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log as unknown as BridgeLogger;
}

function firstWarnFields(log: BridgeLogger): Record<string, unknown> {
  const warn = vi.mocked(log.warn);
  expect(warn).toHaveBeenCalledTimes(1);
  return warn.mock.calls[0]![0] as Record<string, unknown>;
}

describe("first-party dynamic tool failure logging", () => {
  it("logs structured post-execute failures without raw input or an error field", async () => {
    const promptLog = makePromptLog();
    const rawReplyBody = "Fixed in the latest push. secret-token";
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          reason: `Rejected reply body: ${rawReplyBody}`,
        }),
        { status: 409 },
      );
    }) as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "cycloid",
      "review_loop_reply",
      {
        epochId: "epoch-1",
        targetSourceId: "review-comment:10",
        verdict: "fixed",
        body: rawReplyBody,
      },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-1",
          PROMPT_ID: "prompt-1",
          SANDBOX_AUTH_TOKEN: "sandbox-auth",
        },
        fetchImpl,
        promptLog,
      },
    );

    expect(result).toMatchObject({ success: false, errorCode: "blocked" });
    const fields = firstWarnFields(promptLog);
    expect(fields).toMatchObject({
      event: "first_party_dynamic_tool_failed",
      namespace: "cycloid",
      name: "review_loop_reply",
      errorCode: "blocked",
      sessionId: "sess-1",
      promptId: "prompt-1",
      targetSourceId: "review-comment:10",
    });
    expect(fields).not.toHaveProperty("error");
    expect(String(fields.reason)).toContain("[redacted]");
    expect(String(fields.reason)).not.toContain(rawReplyBody);
  });

  it("logs not_registered early exits", async () => {
    const promptLog = makePromptLog();

    const result = await executeFirstPartyDynamicToolCall("missing", "tool", { id: "ENG-1" }, { env: {}, promptLog });

    expect(result).toMatchObject({ success: false, errorCode: "not_registered" });
    expect(firstWarnFields(promptLog)).toMatchObject({
      event: "first_party_dynamic_tool_failed",
      namespace: "missing",
      name: "tool",
      errorCode: "not_registered",
    });
  });

  it("logs invalid_input early exits", async () => {
    const promptLog = makePromptLog();

    const result = await executeFirstPartyDynamicToolCall(
      "linear",
      "create_issue",
      { teamId: "team-1" },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, promptLog },
    );

    expect(result).toMatchObject({ success: false, errorCode: "invalid_input" });
    expect(firstWarnFields(promptLog)).toMatchObject({
      event: "first_party_dynamic_tool_failed",
      namespace: "linear",
      name: "create_issue",
      errorCode: "invalid_input",
    });
  });

  it("does not log successful calls", async () => {
    const promptLog = makePromptLog();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { channel: "C123", messages: [] } }), { status: 200 });
    }) as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-1",
          SANDBOX_AUTH_TOKEN: "sandbox-auth",
        },
        fetchImpl,
        promptLog,
      },
    );

    expect(result.success).toBe(true);
    expect(promptLog.warn).not.toHaveBeenCalled();
  });

  it("retries rate-limited requests with exponential backoff", async () => {
    const promptLog = makePromptLog();
    let attemptCount = 0;
    const fetchImpl = vi.fn(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        return new Response(JSON.stringify({ errors: [{ detail: "Rate limit exceeded" }] }), { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true, result: { channel: "C123", messages: [] } }), { status: 200 });
    }) as typeof fetch;

    const startTime = Date.now();
    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-1",
          SANDBOX_AUTH_TOKEN: "sandbox-auth",
        },
        fetchImpl,
        promptLog,
      },
    );
    const elapsedMs = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(attemptCount).toBe(3);
    expect(promptLog.warn).not.toHaveBeenCalled();
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
  });

  it("does not retry non-rate-limited failures", async () => {
    const promptLog = makePromptLog();
    let attemptCount = 0;
    const fetchImpl = vi.fn(async () => {
      attemptCount++;
      return new Response(JSON.stringify({ errors: [{ detail: "Not found" }] }), { status: 404 });
    }) as typeof fetch;

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-1",
          SANDBOX_AUTH_TOKEN: "sandbox-auth",
        },
        fetchImpl,
        promptLog,
      },
    );

    expect(result.success).toBe(false);
    expect(attemptCount).toBe(1);
    expect(result.errorCode).toBe("not_found");
    expect(firstWarnFields(promptLog)).toMatchObject({
      event: "first_party_dynamic_tool_failed",
      namespace: "slack",
      name: "get_thread",
      errorCode: "not_found",
    });
  });

  it("honors provider retry windows on rate-limited retries", async () => {
    vi.useFakeTimers();
    try {
      const promptLog = makePromptLog();
      let attemptCount = 0;
      const fetchImpl = vi.fn(async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return new Response("rate limited", { status: 429, headers: { "X-RateLimit-Period": "1" } });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch;

      const resultPromise = executeFirstPartyDynamicToolCall(
        "datadog",
        "search_datadog_logs",
        { query: "service:api", limit: 5 },
        {
          env: {
            DD_API_KEY: "api-key",
            DD_APP_KEY: "app-key",
            DD_SITE: "us5.datadoghq.com",
          },
          fetchImpl,
          promptLog,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(promptLog.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
