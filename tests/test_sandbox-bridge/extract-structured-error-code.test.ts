import { describe, expect, it } from "vitest";

import { extractStructuredErrorCode } from "../../apps/sandbox-bridge/src/utils/classify.ts";

describe("prompt catch: structured errorCode preference (ARC-607)", () => {
  it("promotes codex_not_ready off a thrown error's errorCode field", () => {
    const err = Object.assign(new Error("Codex runtime not ready"), { errorCode: "codex_not_ready" });
    expect(extractStructuredErrorCode(err)).toBe("codex_not_ready");
  });

  it("returns null when the thrown error has no valid errorCode", () => {
    expect(extractStructuredErrorCode(new Error("generic failure"))).toBeNull();
    expect(extractStructuredErrorCode({ errorCode: "made_up_code" })).toBeNull();
    expect(extractStructuredErrorCode(null)).toBeNull();
    expect(extractStructuredErrorCode("string error")).toBeNull();
  });

  it("accepts any valid ErrorCode, not just codex_not_ready", () => {
    const err = new Error("something");
    Object.assign(err, { errorCode: "codex_api_readiness_timeout" });
    expect(extractStructuredErrorCode(err)).toBe("codex_api_readiness_timeout");
  });
});
