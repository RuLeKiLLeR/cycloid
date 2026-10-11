import { describe, expect, it } from "vitest";

import {
  collapseAndTruncate,
  describeError,
  isAbortError,
  sanitizeErrorMessage,
} from "../../apps/sandbox-bridge/src/utils/llm-errors.ts";
import { ProviderUserAbortError } from "../../shared/llm/errors.ts";

describe("llm-errors helpers", () => {
  it("detects abort errors from signals and provider aborts", () => {
    const controller = new AbortController();
    controller.abort();

    expect(isAbortError(new ProviderUserAbortError(), undefined)).toBe(true);
    expect(isAbortError(new DOMException("aborted", "AbortError"), undefined)).toBe(true);
    expect(isAbortError(new Error("other"), controller.signal)).toBe(true);
  });

  it("sanitizes and truncates error messages", () => {
    const message = sanitizeErrorMessage(`line 1\nline 2\u0000${"x".repeat(700)}`);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\u0000");
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("collapses long excerpts", () => {
    expect(collapseAndTruncate(" a\n\nb ", 10)).toBe("a b");
    expect(collapseAndTruncate("x".repeat(20), 5)).toBe("xx...");
  });
});

describe("describeError", () => {
  it("unwraps undici-style fetch failed error causes", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), {
      errno: -3008,
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
      hostname: "api.openai.com",
    });
    const outer = new TypeError("fetch failed");
    (outer as Error & { cause?: unknown }).cause = cause;

    const details = describeError(outer);

    expect(details?.message).toBe("fetch failed");
    expect(details?.name).toBe("TypeError");
    expect(details?.cause?.message).toContain("ENOTFOUND");
    expect(details?.cause?.code).toBe("ENOTFOUND");
    expect(details?.cause?.syscall).toBe("getaddrinfo");
    expect(details?.cause?.hostname).toBe("api.openai.com");
    expect(details?.cause?.errno).toBe("-3008");
  });

  it("extracts Codex APIError payload shape", () => {
    const apiError = {
      name: "APIError",
      data: {
        message: "500 Internal Server Error",
        statusCode: 500,
        isRetryable: true,
        responseBody: "x".repeat(800),
      },
    };

    const details = describeError(apiError);

    expect(details?.name).toBe("APIError");
    expect(details?.message).toBe("500 Internal Server Error");
    expect(details?.statusCode).toBe(500);
    expect(details?.isRetryable).toBe(true);
    expect(details?.responseBodyPreview?.length).toBeLessThanOrEqual(500);
    expect(details?.stack).toBeUndefined();
  });

  it("extracts Codex ProviderAuthError providerID", () => {
    const details = describeError({
      name: "ProviderAuthError",
      data: { providerID: "openai", message: "invalid api key" },
    });

    expect(details?.name).toBe("ProviderAuthError");
    expect(details?.providerID).toBe("openai");
  });

  it("handles primitives and nullish", () => {
    expect(describeError(undefined)).toBeUndefined();
    expect(describeError(null)).toBeUndefined();
    expect(describeError("boom")?.message).toBe("boom");
  });

  it("stops recursion at max cause depth", () => {
    const innermost = new Error("innermost");
    const level3 = Object.assign(new Error("level3"), { cause: innermost });
    const level2 = Object.assign(new Error("level2"), { cause: level3 });
    const level1 = Object.assign(new Error("level1"), { cause: level2 });
    const top = Object.assign(new Error("top"), { cause: level1 });

    const details = describeError(top);

    let node = details;
    let depth = 0;
    while (node?.cause) {
      depth++;
      node = node.cause;
    }
    expect(depth).toBeLessThanOrEqual(4);
  });
});
