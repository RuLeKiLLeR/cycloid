import { describe, expect, it, vi } from "vitest";

vi.mock("../../../apps/control-plane-worker/src/observability/context", () => ({
  injectTraceparent: () => null,
}));

vi.mock("../../../apps/control-plane-worker/src/session/db", () => ({
  buildUpsertReplayMetadataStatement: vi.fn(),
  buildUpsertSessionIndexStatement: vi.fn(),
}));

import { openSandboxWebSocket } from "../../../apps/control-plane-worker/src/session/state";
import type { Env } from "../../../apps/control-plane-worker/src/types";

describe("openSandboxWebSocket", () => {
  it("forwards the session id required by the sandbox auth exchange", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const env = {
      SESSION: {
        idFromName: vi.fn().mockReturnValue("fake-do-id"),
        get: vi.fn().mockReturnValue({ fetch }),
      },
    } as unknown as Env;
    const request = new Request("https://app.trycycloid.com/api/sessions/session-1/ws?type=sandbox", {
      headers: {
        authorization: "Bearer sandbox-token",
        "CF-Connecting-IP": "203.0.113.1",
        upgrade: "websocket",
      },
    });

    await openSandboxWebSocket(env, "session-1", request, "sandbox-1");

    expect(fetch).toHaveBeenCalledOnce();
    const forwardedRequest = fetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.pathname).toBe("/session/ws");
    expect(forwardedUrl.searchParams.get("type")).toBe("sandbox");
    expect(forwardedUrl.searchParams.get("sessionId")).toBe("session-1");
    expect(forwardedUrl.searchParams.get("sandboxId")).toBe("sandbox-1");
  });
});
