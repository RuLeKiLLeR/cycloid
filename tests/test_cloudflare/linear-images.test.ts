import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractLinearMarkdownImageSources,
  fetchLinearIssueImages,
} from "../../apps/control-plane-worker/src/webhooks/linear";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Linear issue image ingestion", () => {
  it("extracts unique uploads.linear.app markdown image links from issue text and comments", () => {
    const sources = extractLinearMarkdownImageSources([
      "Issue ![screen](https://uploads.linear.app/abc/screen.png)",
      "Comment ![dupe](https://uploads.linear.app/abc/screen.png) ![evil](https://example.com/nope.png)",
      "Another ![diagram](https://uploads.linear.app/abc/diagram.webp)",
    ]);

    expect(sources).toEqual([
      { url: "https://uploads.linear.app/abc/screen.png", name: "linear-1-screen.png" },
      { url: "https://uploads.linear.app/abc/diagram.webp", name: "linear-2-diagram.webp" },
    ]);
  });

  it("fetches markdown image sources, auth-downloads images, skips non-images, and caps source attempts at five", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.linear.app/graphql") {
        return Response.json({
          data: {
            issue: {
              description: Array.from(
                { length: 7 },
                (_, index) => `![shot${index}](https://uploads.linear.app/i/shot${index}.png)`,
              ).join("\n"),
              comments: {
                nodes: [{ body: "![dupe](https://uploads.linear.app/i/shot0.png)" }],
              },
            },
          },
        });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer linear-token");
      const isText = url.endsWith("shot1.png");
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": isText ? "text/plain" : "image/png", "content-length": "3" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchLinearIssueImages("linear-token", "issue-1");

    expect(images.map((image) => image.name)).toEqual([
      "linear-1-shot0.png",
      "linear-3-shot2.png",
      "linear-4-shot3.png",
      "linear-5-shot4.png",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("rejects unsafe hosts before sending a bearer token", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.linear.app/graphql") {
        return Response.json({
          data: {
            issue: {
              description: "![evil](https://evil.example.test/screen.png)",
              comments: { nodes: [] },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchLinearIssueImages("linear-token", "issue-1");

    expect(images).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows signed redirects without forwarding the Linear bearer token", async () => {
    const signedUrl = "https://fd-linear-uploads.s3.amazonaws.com/signed";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.linear.app/graphql") {
        return Response.json({
          data: {
            issue: {
              description: "![screen](https://uploads.linear.app/i/screen.png)",
              comments: { nodes: [] },
            },
          },
        });
      }
      if (url === "https://uploads.linear.app/i/screen.png") {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer linear-token");
        return new Response(null, { status: 302, headers: { location: signedUrl } });
      }
      expect(url).toBe(signedUrl);
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchLinearIssueImages("linear-token", "issue-1");

    expect(images).toEqual([
      {
        name: "linear-1-screen.png",
        mediaType: "image/png",
        data: btoa(String.fromCharCode(9, 8, 7)),
      },
    ]);
  });

  it("rejects IPv6 link-local redirects across fe80::/10", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.linear.app/graphql") {
        return Response.json({
          data: {
            issue: {
              description: "![screen](https://uploads.linear.app/i/screen.png)",
              comments: { nodes: [] },
            },
          },
        });
      }
      if (url === "https://uploads.linear.app/i/screen.png") {
        return new Response(null, { status: 302, headers: { location: "https://[fe90::1]/private" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchLinearIssueImages("linear-token", "issue-1");

    expect(images).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips oversized, auth-failed, disallowed redirect, and malformed source fetches fail-soft", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.linear.app/graphql") {
        return Response.json({
          data: {
            issue: {
              description: [
                "![big](https://uploads.linear.app/i/big.png)",
                "![auth](https://uploads.linear.app/i/auth.png)",
                "![redirect](https://uploads.linear.app/i/redirect.png)",
                "![ok](https://uploads.linear.app/i/ok.png)",
              ].join("\n"),
              comments: { nodes: [] },
            },
          },
        });
      }
      if (url.endsWith("/big.png")) {
        return new Response("", { status: 200, headers: { "content-type": "image/png", "content-length": "6000000" } });
      }
      if (url.endsWith("/auth.png")) return new Response("forbidden", { status: 403 });
      if (url.endsWith("/redirect.png")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      }
      return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchLinearIssueImages("linear-token", "issue-1");

    expect(images.map((image) => image.name)).toEqual(["linear-4-ok.png"]);
  });

  it("returns no images when the source query fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await expect(fetchLinearIssueImages("linear-token", "issue-1")).resolves.toEqual([]);
  });
});
