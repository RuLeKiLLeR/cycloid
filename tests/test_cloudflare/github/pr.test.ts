import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: async (url: string, options?: { method?: string; body?: string }) => {
    fetchCalls.push({ url, method: options?.method ?? "GET", body: options?.body ?? null });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected fetch: ${url}`);
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => null },
      json: async () => response.body,
      text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    };
  },
}));

import { getIssueComment } from "../../../apps/control-plane-worker/src/github/pr";

type MockResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

let responses: MockResponse[] = [];
let fetchCalls: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(() => {
  responses = [];
  fetchCalls = [];
});

describe("getIssueComment", () => {
  it("returns the comment body on a 200 and issues a GET to the comment endpoint", async () => {
    responses.push({ ok: true, status: 200, body: { body: "hello world" } });

    const result = await getIssueComment("ghs_token", "acme", "repo", 555);

    expect(result).toBe("hello world");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe("GET");
    expect(fetchCalls[0].url).toBe("https://api.github.com/repos/acme/repo/issues/comments/555");
  });

  it("returns null when the comment no longer exists (404) without throwing", async () => {
    responses.push({ ok: false, status: 404, body: "Not Found" });

    const result = await getIssueComment("ghs_token", "acme", "repo", 555);

    expect(result).toBeNull();
  });

  it("throws on a non-404 error response", async () => {
    responses.push({ ok: false, status: 500, body: "boom" });

    await expect(getIssueComment("ghs_token", "acme", "repo", 555)).rejects.toThrow(
      /GitHub issue comment lookup failed \(500\)/,
    );
  });

  it("returns an empty string when the comment has no body field", async () => {
    responses.push({ ok: true, status: 200, body: { id: 555 } });

    const result = await getIssueComment("ghs_token", "acme", "repo", 555);

    expect(result).toBe("");
  });

  it("url-encodes the owner and repo segments", async () => {
    responses.push({ ok: true, status: 200, body: { body: "x" } });

    await getIssueComment("ghs_token", "ac me", "re/po", 7);

    expect(fetchCalls[0].url).toBe("https://api.github.com/repos/ac%20me/re%2Fpo/issues/comments/7");
  });
});
