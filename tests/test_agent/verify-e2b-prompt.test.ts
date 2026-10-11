import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest, buildReadmeSmokePrompt, waitForPromptAndPr } from "../../scripts/verify-e2b-session";

const baseArgs = {
  baseUrl: "https://qa.app.trycycloid.com",
  repoOwner: "jeman-verification",
  repoName: "verification-prod",
  token: "secret-token",
  timeoutMs: 20 * 60 * 1000,
  pollIntervalMs: 5_000,
};

function mockResponse(status: number, body = "{}"): Response {
  return new Response(body, { status });
}

async function advanceApiRetries(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
  await vi.advanceTimersByTimeAsync(1_000);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("buildReadmeSmokePrompt", () => {
  const timestamp = "2026-06-24T12:00:00.000Z";
  const prompt = buildReadmeSmokePrompt(timestamp);

  it("names the exact file and checkpoint line with the timestamp", () => {
    expect(prompt).toContain("README.md");
    expect(prompt).toContain(`Prod PR smoke test checkpoint at ${timestamp}`);
    expect(prompt).toContain("first line");
  });

  it("requires a commit but leaves publish to Cycloid", () => {
    expect(prompt).toMatch(/commit/i);
    expect(prompt).toMatch(/Cycloid will publish/i);
    expect(prompt).toMatch(/Do not push the branch or open a pull request yourself/i);
  });

  it("steers the agent to a single prescriptive turn, not exploration", () => {
    expect(prompt).toMatch(/do not explore/i);
    expect(prompt).toMatch(/do not change anything else/i);
  });

  it("keeps the no-screenshots guard so missing browser evidence never blocks", () => {
    expect(prompt).toContain("Do not capture screenshots unless explicitly needed");
    expect(prompt).toContain("missing browser evidence must not block the PR");
  });
});

describe("apiRequest", () => {
  it("retries a default GET after a 5xx and returns a later success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse(500, "temporary"))
      .mockResolvedValueOnce(mockResponse(200, '{"ok":true}'));

    const request = apiRequest(baseArgs, "/api/sessions/session-id/export");
    await vi.advanceTimersByTimeAsync(500);

    await expect(request).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 GET", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse(429, "rate limited"))
      .mockResolvedValueOnce(mockResponse(200, '{"ok":true}'));

    const request = apiRequest(baseArgs, "/api/sessions/session-id");
    await vi.advanceTimersByTimeAsync(500);

    await expect(request).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable 4xx GET immediately", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(403, "forbidden"));

    await expect(apiRequest(baseArgs, "/api/sessions/session-id/export")).rejects.toThrow(
      "GET /api/sessions/session-id/export failed: 403 forbidden",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the original response error after persistent 5xx retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse(500, "temporary"))
      .mockResolvedValueOnce(mockResponse(502, "bad gateway"))
      .mockResolvedValueOnce(mockResponse(500, '{"ok":false,"error":"Internal server error"}'));

    const request = apiRequest(baseArgs, "/api/sessions/session-id/export");
    const expectation = expect(request).rejects.toThrow(
      'GET /api/sessions/session-id/export failed: 500 {"ok":false,"error":"Internal server error"}',
    );
    await advanceApiRetries();

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a sanitized error after persistent network failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));

    const request = apiRequest(baseArgs, "/api/sessions/session-id/export");
    const caught = request.catch((error: unknown) => error);
    await advanceApiRetries();

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("GET /api/sessions/session-id/export failed after 3 attempts: socket hang up");
    expect(String(error)).not.toContain(baseArgs.token);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("waitForPromptAndPr", () => {
  it("keeps polling after a retry-exhausted transient GET", async () => {
    vi.useFakeTimers();
    let exportCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/session-id/export")) {
        exportCalls += 1;
        if (exportCalls <= 3) {
          return mockResponse(500, "temporary");
        }
        return mockResponse(200, JSON.stringify({ prompts: [{ id: "prompt-id", status: "completed" }] }));
      }
      if (url.endsWith("/api/sessions/session-id")) {
        return mockResponse(200, JSON.stringify({ session: { prUrl: "https://github.com/acme/repo/pull/123" } }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const request = waitForPromptAndPr(
      {
        ...baseArgs,
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      },
      "session-id",
      "prompt-id",
    );
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);

    await expect(request).resolves.toEqual({ prUrl: "https://github.com/acme/repo/pull/123" });
    expect(exportCalls).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("throws the real timeout after a stale transient is followed by successful polls", async () => {
    vi.useFakeTimers();
    let exportCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/sessions/session-id/export")) {
        exportCalls += 1;
        if (exportCalls <= 3) {
          return mockResponse(500, "temporary");
        }
        return mockResponse(200, JSON.stringify({ prompts: [{ id: "prompt-id", status: "processing" }] }));
      }
      if (url.endsWith("/api/sessions/session-id")) {
        return mockResponse(200, JSON.stringify({ session: {} }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const request = waitForPromptAndPr(
      {
        ...baseArgs,
        timeoutMs: 2_000,
        pollIntervalMs: 100,
      },
      "session-id",
      "prompt-id",
    );
    const expectation = expect(request).rejects.toThrow(
      "Timed out waiting for prompt prompt-id and PR URL in session session-id",
    );
    await vi.advanceTimersByTimeAsync(3_000);

    await expectation;
    expect(exportCalls).toBeGreaterThan(3);
    expect(fetchMock).toHaveBeenCalled();
  });
});
