import { describe, expect, it } from "vitest";

import { classifyResumableSendErrorDecision } from "../../apps/control-plane-worker/src/routes/sessions";

describe("classifyResumableSendErrorDecision", () => {
  it("classifies forwarded resumable-send errors without mislabeling them stale-active", () => {
    expect(classifyResumableSendErrorDecision(429, "Resume is being retried too quickly.")).toBe("reject-rate-limit");
    expect(classifyResumableSendErrorDecision(403, "Repo access denied")).toBe("reject-access");
    expect(classifyResumableSendErrorDecision(400, "Invalid agent")).toBe("reject-invalid-request");
    expect(classifyResumableSendErrorDecision(409, "Session is archived. Start a new session to continue.")).toBe(
      "reject-archived",
    );
    expect(classifyResumableSendErrorDecision(409, "Session is closed")).toBe("reject-closed");
    expect(classifyResumableSendErrorDecision(409, "Prompt already running")).toBe("reject-conflict");
  });
});
