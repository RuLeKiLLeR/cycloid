import { describe, expect, it } from "vitest";

import { jsonErrorResponse } from "../../apps/control-plane-worker/src/utils";
import { parseBearerToken } from "../../shared/utils/auth";

describe("parseBearerToken", () => {
  it("returns the token for a well-formed header", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "Bearer abc123" },
    });
    expect(parseBearerToken(req)).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "bearer abc123" },
    });
    expect(parseBearerToken(req)).toBe("abc123");
  });

  it("trims surrounding whitespace from the token", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "Bearer   abc123   " },
    });
    expect(parseBearerToken(req)).toBe("abc123");
  });

  it("returns null when no authorization header is present", () => {
    const req = new Request("https://example.com");
    expect(parseBearerToken(req)).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "Basic abc123" },
    });
    expect(parseBearerToken(req)).toBeNull();
  });

  it("returns null when the scheme alone is sent without a space", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "Bearer" },
    });
    expect(parseBearerToken(req)).toBeNull();
  });

  it("returns null for 'Bearer ' with an empty/whitespace-only credential", () => {
    const empty = new Request("https://example.com", {
      headers: { authorization: "Bearer " },
    });
    expect(parseBearerToken(empty)).toBeNull();

    const whitespace = new Request("https://example.com", {
      headers: { authorization: "Bearer     " },
    });
    expect(parseBearerToken(whitespace)).toBeNull();
  });
});

describe("jsonErrorResponse", () => {
  it("returns a JSON body with ok:false and the given error message", async () => {
    const res = jsonErrorResponse("Unauthorized", 401);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("defaults to status 400 when not provided", () => {
    const res = jsonErrorResponse("bad input");
    expect(res.status).toBe(400);
  });

  it("merges extras into the response body", async () => {
    const res = jsonErrorResponse("PR already exists", 409, { prUrl: "https://github.com/foo/bar/pull/1" });
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: "PR already exists",
      prUrl: "https://github.com/foo/bar/pull/1",
    });
  });

  it("handles undefined extras gracefully", async () => {
    const res = jsonErrorResponse("simple", 500, undefined);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "simple" });
  });
});
