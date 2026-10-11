import { describe, expect, it } from "vitest";

import { parseCookies, parseSessionTokenCookie } from "../../apps/control-plane-worker/src/utils";

function requestWithCookie(cookie: string | null): Request {
  const headers = cookie === null ? undefined : { cookie };
  return new Request("https://worker.test/api/sessions", { headers });
}

describe("auth cookie parsing", () => {
  describe("parseSessionTokenCookie", () => {
    it("returns null when the session cookie is absent", () => {
      expect(parseSessionTokenCookie(requestWithCookie(null))).toBeNull();
      expect(parseSessionTokenCookie(requestWithCookie("other=value"))).toBeNull();
    });

    it("returns null when the session cookie is empty", () => {
      expect(parseSessionTokenCookie(requestWithCookie("session_token="))).toBeNull();
    });

    it("returns the raw session token value", () => {
      expect(parseSessionTokenCookie(requestWithCookie("theme=dark; session_token=abc123; other=value"))).toBe(
        "abc123",
      );
    });

    it("preserves equals signs in the raw session token value", () => {
      expect(parseSessionTokenCookie(requestWithCookie("session_token=abc=123"))).toBe("abc=123");
    });

    it("does not decode or throw on malformed percent encoding", () => {
      expect(parseSessionTokenCookie(requestWithCookie("session_token=abc%"))).toBe("abc%");
    });

    it("does not URL-decode cookie values", () => {
      expect(parseSessionTokenCookie(requestWithCookie("session_token=abc%20123"))).toBe("abc%20123");
    });
  });

  describe("parseCookies", () => {
    it("does not throw on malformed percent encoding", () => {
      expect(parseCookies(requestWithCookie("session_token=abc%; other=value"))).toEqual({
        session_token: "abc%",
        other: "value",
      });
    });
  });
});
