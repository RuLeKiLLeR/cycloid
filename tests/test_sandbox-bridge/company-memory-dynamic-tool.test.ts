import { beforeEach, describe, expect, it, vi } from "vitest";

const CONFIGURED_ENV = {
  SESSION_ID: "session-1",
  SANDBOX_AUTH_TOKEN: "sandbox-token",
  CONTROL_PLANE_URL: "https://control.example.com",
};

describe("company memory dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("maps a body-read TimeoutError to cancelled", async () => {
    const { executeCompanyMemoryRecallDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/company-memory-dynamic-tool.js");

    const result = await executeCompanyMemoryRecallDynamicToolCall(
      { intent: "why did we choose X" },
      {
        env: CONFIGURED_ENV,
        fetchImpl: vi.fn(async () => {
          const response = new Response(null, { status: 200, statusText: "OK" });
          response.json = async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          };
          return response;
        }) as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("cancelled");
  });

  it("keeps a non-cancellation body-read error as upstream_error", async () => {
    const { executeCompanyMemoryRecallDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/company-memory-dynamic-tool.js");

    const result = await executeCompanyMemoryRecallDynamicToolCall(
      { intent: "why did we choose X" },
      {
        env: CONFIGURED_ENV,
        fetchImpl: vi.fn(async () => {
          const response = new Response(null, { status: 200, statusText: "OK" });
          response.json = async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          };
          return response;
        }) as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("upstream_error");
  });
});
