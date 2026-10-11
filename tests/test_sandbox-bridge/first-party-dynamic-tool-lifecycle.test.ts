import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeFirstPartyDynamicToolCall } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../shared/enums/integration-lifecycle";

describe("first-party dynamic tool lifecycle callbacks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("records runtime attach and first tool success around Slack tool execution", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/integration-lifecycle")) {
        return new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 });
      }
      if (url.endsWith("/slack/get-thread")) {
        return new Response(JSON.stringify({ ok: true, result: { channel: "C123", messages: [] } }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-lifecycle-success",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const runtimeCall = fetchImpl.mock.calls[0]!;
    expect(String(runtimeCall[0])).toBe("https://api.test/api/sessions/sess-lifecycle-success/integration-lifecycle");
    expect(JSON.parse(String((runtimeCall[1] as RequestInit).body))).toMatchObject({
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.RUNTIME_ATTACHED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    });

    const toolCall = fetchImpl.mock.calls[1]!;
    expect(String(toolCall[0])).toBe("https://api.test/api/sessions/sess-lifecycle-success/slack/get-thread");

    const successCall = fetchImpl.mock.calls[2]!;
    expect(JSON.parse(String((successCall[1] as RequestInit).body))).toMatchObject({
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.FIRST_TOOL_CALL_PASSED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    });
  });

  it("records mapped failure reasons for the first failed dynamic tool call", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/integration-lifecycle")) {
        return new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 });
      }
      if (url.endsWith("/slack/get-thread")) {
        return new Response(
          JSON.stringify({
            ok: false,
            errorCode: "scope_missing",
            error: "Slack scopes are missing.",
          }),
          { status: 403 },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-lifecycle-failure",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("scope_missing");
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const failureCall = fetchImpl.mock.calls[2]!;
    expect(JSON.parse(String((failureCall[1] as RequestInit).body))).toMatchObject({
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.FIRST_TOOL_CALL_PASSED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
      details: {
        provider: "slack",
        providerErrorCode: "scope_missing",
      },
    });
  });

  it("maps Slack 403 responses without an error body code to forbidden", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/integration-lifecycle")) {
        return new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 });
      }
      if (url.endsWith("/slack/get-thread")) {
        return new Response(JSON.stringify({ ok: false, error: "Slack channel is restricted." }), { status: 403 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-lifecycle-forbidden",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("forbidden");

    const failureCall = fetchImpl.mock.calls[2]!;
    expect(JSON.parse(String((failureCall[1] as RequestInit).body))).toMatchObject({
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.FIRST_TOOL_CALL_PASSED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOOL_EXECUTION_FAILED,
      details: {
        provider: "slack",
        providerErrorCode: "forbidden",
      },
    });
  });

  it("preserves Slack forbidden errors from the control-plane response body", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/integration-lifecycle")) {
        return new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 });
      }
      if (url.endsWith("/slack/get-thread")) {
        return new Response(
          JSON.stringify({
            ok: false,
            errorCode: "forbidden",
            error: "Slack conversations.replies failed.",
          }),
          { status: 403 },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await executeFirstPartyDynamicToolCall(
      "slack",
      "get_thread",
      { channel: "C123", ts: "1710000000.000100" },
      {
        env: {
          CONTROL_PLANE_URL: "https://api.test",
          SESSION_ID: "sess-lifecycle-forbidden-body",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "forbidden",
      contentItems: [
        {
          type: "inputText",
          text:
            "Slack conversations.replies failed.\n\n" +
            "Recovery: Verify the identifier and arguments before retrying; do not repeat the identical call.",
        },
      ],
    });

    const failureCall = fetchImpl.mock.calls[2]!;
    expect(JSON.parse(String((failureCall[1] as RequestInit).body))).toMatchObject({
      integrationId: "slack",
      stage: INTEGRATION_LIFECYCLE_STAGE.FIRST_TOOL_CALL_PASSED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOOL_EXECUTION_FAILED,
      details: {
        provider: "slack",
        providerErrorCode: "forbidden",
      },
    });
  });

  it("does not block tool execution on a hung lifecycle callback", async () => {
    const lifecycleGate = new Promise<Response>(() => {});
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/integration-lifecycle")) {
        return lifecycleGate;
      }
      if (url.endsWith("/slack/get-thread")) {
        return new Response(JSON.stringify({ ok: true, result: { channel: "C123", messages: [] } }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(
      executeFirstPartyDynamicToolCall(
        "slack",
        "get_thread",
        { channel: "C123", ts: "1710000000.000100" },
        {
          env: {
            CONTROL_PLANE_URL: "https://api.test",
            SESSION_ID: "sess-lifecycle-nonblocking",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
          },
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: true });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      "https://api.test/api/sessions/sess-lifecycle-nonblocking/slack/get-thread",
    );
  });
});
