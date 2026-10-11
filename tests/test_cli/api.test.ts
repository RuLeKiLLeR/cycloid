import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, parseHttpTimeoutMs, resolveBusinessId } from "../../apps/cli/src/api.js";

describe("CLI API helpers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalTimeout = process.env.ARCANIST_HTTP_TIMEOUT_MS;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.ARCANIST_HTTP_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalTimeout === undefined) {
      delete process.env.ARCANIST_HTTP_TIMEOUT_MS;
    } else {
      process.env.ARCANIST_HTTP_TIMEOUT_MS = originalTimeout;
    }
  });

  it("uses the explicit business option without a whoami request", async () => {
    await expect(
      resolveBusinessId({ apiUrl: "https://api.example.test", token: "arc_test" }, { business: " biz-1 " }),
    ).resolves.toBe("biz-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the authenticated business context", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ businessId: "biz-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(resolveBusinessId({ apiUrl: "https://api.example.test", token: "arc_test" }, {})).resolves.toBe(
      "biz-2",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/auth/whoami",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it("requires --business when whoami has no business context", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ businessId: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      resolveBusinessId({ apiUrl: "https://api.example.test", token: "arc_test" }, {}),
    ).rejects.toMatchObject({
      message: "--business is required when the authenticated token has no business context.",
    });
  });

  it("rejects invalid HTTP timeout configuration", () => {
    expect(() => parseHttpTimeoutMs({ ARCANIST_HTTP_TIMEOUT_MS: "999" })).toThrow("between 1000 and 600000");
    expect(() => parseHttpTimeoutMs({ ARCANIST_HTTP_TIMEOUT_MS: "600001" })).toThrow("between 1000 and 600000");
    expect(() => parseHttpTimeoutMs({ ARCANIST_HTTP_TIMEOUT_MS: "oops" })).toThrow("positive integer");
  });

  it("maps request timeout aborts to exit 10", async () => {
    vi.useFakeTimers();
    process.env.ARCANIST_HTTP_TIMEOUT_MS = "1000";
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    const request = expect(
      apiFetch({ apiUrl: "https://api.example.test", token: "arc_test" }, "/api/slow"),
    ).rejects.toMatchObject({
      exitCode: 10,
      message: "Network timeout after 1000ms.",
      hint: expect.stringContaining("ARCANIST_HTTP_TIMEOUT_MS"),
    });
    await vi.advanceTimersByTimeAsync(1000);

    await request;
  });

  it("preserves server error codes and command-aware 404 hints", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: "token_missing", message: "Token not found." } }, { status: 404 }),
    );

    await expect(
      apiFetch({ apiUrl: "https://api.example.test", token: "arc_test" }, "/api/cli-tokens/tok_1/revoke", {
        method: "POST",
      }),
    ).rejects.toMatchObject({
      exitCode: 3,
      message: "Token not found.",
      hint: "List tokens with `cycloid tokens list`.",
      data: { serverCode: "token_missing" },
    });
  });

  it("prefers sibling stable error codes over prose error strings", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: false, error: "Build request not found", code: "build_request_not_found" }, { status: 404 }),
    );

    await expect(
      apiFetch({ apiUrl: "https://api.example.test", token: "arc_test" }, "/api/sandbox/build-requests/build_1"),
    ).rejects.toMatchObject({
      message: "Build request not found",
      data: { serverCode: "build_request_not_found" },
    });
  });
});
