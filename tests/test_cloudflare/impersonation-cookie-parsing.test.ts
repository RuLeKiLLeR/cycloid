import { describe, expect, it } from "vitest";

import { parseImpersonationTokenCookie, parseSessionTokenCookie } from "../../apps/control-plane-worker/src/utils";

function requestWithCookie(cookie: string | null): Request {
  const headers = cookie === null ? undefined : { cookie };
  return new Request("https://worker.test/api/sessions", { headers });
}

describe("impersonation cookie parsing", () => {
  it("returns null when the cookie is absent", () => {
    expect(parseImpersonationTokenCookie(requestWithCookie(null))).toBeNull();
    expect(parseImpersonationTokenCookie(requestWithCookie("session_token=abc"))).toBeNull();
  });

  it("returns null when the impersonation cookie is empty", () => {
    expect(parseImpersonationTokenCookie(requestWithCookie("impersonation_token="))).toBeNull();
  });

  it("returns the raw impersonation token value when present", () => {
    expect(
      parseImpersonationTokenCookie(requestWithCookie("theme=dark; impersonation_token=imp-abc-123; other=value")),
    ).toBe("imp-abc-123");
  });

  it("is independent of session_token (both can coexist)", () => {
    const req = requestWithCookie("session_token=sess-1; impersonation_token=imp-2");
    expect(parseSessionTokenCookie(req)).toBe("sess-1");
    expect(parseImpersonationTokenCookie(req)).toBe("imp-2");
  });
});
