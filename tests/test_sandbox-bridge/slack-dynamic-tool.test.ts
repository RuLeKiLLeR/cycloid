import { beforeEach, describe, expect, it, vi } from "vitest";

describe("slack dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("maps request TimeoutError to cancelled", async () => {
    const { executeSlackGetThreadDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/slack-dynamic-tool.js");

    await expect(
      executeSlackGetThreadDynamicToolCall(
        { channel: "C1", ts: "1.0" },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.com",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "tok-1",
            SLACK_SESSION_TEAM_ID: "T1",
          },
          fetchImpl: vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Slack dynamic tool request was cancelled." }],
    });
  });

  it("preserves Slack workspace failure codes from the control plane", async () => {
    const { executeSlackGetThreadDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/slack-dynamic-tool.js");

    await expect(
      executeSlackGetThreadDynamicToolCall(
        { channel: "C1", ts: "1.0" },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.com",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "tok-1",
            SLACK_SESSION_TEAM_ID: "T1",
          },
          fetchImpl: vi.fn(async () =>
            Response.json(
              { ok: false, error: "Workspace is not installed.", errorCode: "workspace_uninstalled" },
              { status: 409 },
            ),
          ) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "workspace_uninstalled",
      contentItems: [{ type: "inputText", text: "Workspace is not installed." }],
    });
  });
});
