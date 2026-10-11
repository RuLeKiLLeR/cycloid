import { describe, expect, it, vi } from "vitest";

import { emitPushErrorEvent } from "../../apps/sandbox-bridge/src/services/git/events.js";

describe("emitPushErrorEvent", () => {
  it("emits the push_error envelope and redacts credential-bearing error text", () => {
    const sendEvent = vi.fn();

    emitPushErrorEvent(
      { sandboxId: "sbx-1", sendEvent },
      {
        messageId: "msg-1",
        branchName: "feature/test",
        error: "fatal: unable to access 'https://x-access-token:secrettoken123@github.com/acme/repo.git/': 403",
      },
    );

    expect(sendEvent).toHaveBeenCalledWith({
      type: "push_error",
      messageId: "msg-1",
      branchName: "feature/test",
      error: "fatal: unable to access 'https://[REDACTED]@github.com/acme/repo.git/': 403",
      sandboxId: "sbx-1",
      timestamp: expect.any(Number),
    });
  });
});
