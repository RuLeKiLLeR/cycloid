import { describe, expect, it } from "vitest";

import { decodeBase64Url, encodeBase64Url, encodeBase64UrlBytes } from "../../apps/control-plane-worker/src/base64url";

describe("base64url", () => {
  it("roundtrips ASCII", () => {
    const original = "session-abc:prompt-123:1729000000000";
    const encoded = encodeBase64Url(original);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(decodeBase64Url(encoded)).toBe(original);
  });

  it("roundtrips unicode (emoji, CJK, combining marks)", () => {
    const original = "hello 🔐 世界 café";
    const encoded = encodeBase64Url(original);
    expect(decodeBase64Url(encoded)).toBe(original);
  });

  it("roundtrips JSON payloads", () => {
    const payload = JSON.stringify({ state: "xyz", initiatingUserId: 42, issuedAt: 1 });
    expect(decodeBase64Url(encodeBase64Url(payload))).toBe(payload);
  });

  it("emits URL-safe alphabet only", () => {
    // Inputs chosen to force `+` and `/` characters under standard base64.
    // Bytes [0xfb, 0xff, 0xbf] encode to `+/+/` in standard alphabet.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0xff, 0xef]);
    const encoded = encodeBase64UrlBytes(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns the empty string for empty input", () => {
    expect(encodeBase64Url("")).toBe("");
    expect(decodeBase64Url("")).toBe("");
  });

  it("decodes accepted input with or without padding", () => {
    // "hi" -> "aGk" (no padding) or "aGk=" (padded). Both should roundtrip.
    expect(decodeBase64Url("aGk")).toBe("hi");
    expect(decodeBase64Url("aGk=")).toBe("hi");
  });

  it("does not throw on arbitrary input", () => {
    // Node's Buffer base64url parser is permissive: it silently accepts
    // non-alphabet characters and replaces invalid UTF-8 sequences with
    // U+FFFD rather than throwing. The null-on-throw branch in
    // decodeBase64Url is a defensive guard, not a routinely-hit path.
    // Token security is gated by the subsequent HMAC comparison, so
    // permissive decoding is safe. This test asserts the non-throwing
    // contract for obviously-malformed input.
    expect(() => decodeBase64Url("not base64 !!! with spaces and $$")).not.toThrow();
    expect(() => decodeBase64Url("!@#$%^&*()")).not.toThrow();
  });

  it("returns null for non-string input", () => {
    // Force the catch branch by passing a value Buffer.from rejects.
    expect(decodeBase64Url(undefined as unknown as string)).toBe(null);
    expect(decodeBase64Url(null as unknown as string)).toBe(null);
    expect(decodeBase64Url(123 as unknown as string)).toBe(null);
  });

  it("encodeBase64UrlBytes matches encodeBase64Url for ASCII", () => {
    const text = "modal-callback";
    const bytes = new TextEncoder().encode(text);
    expect(encodeBase64UrlBytes(bytes)).toBe(encodeBase64Url(text));
  });
});
