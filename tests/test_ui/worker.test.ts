import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the worker module
import worker from "../../apps/ui/src/worker.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      fetch: vi.fn().mockResolvedValue(new Response("<!doctype html>", { status: 200 })),
    },
    WORKER_HOST: "cycloid-control-plane.workers.dev",
    ...overrides,
  };
}

interface R2ObjectBody {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
}

interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBody | null>;
}

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  WORKER_HOST: string;
  WORKER_ENV?: string;
  UI_ASSETS_BUCKET?: R2BucketBinding;
}

function makeRequest(path: string, options: RequestInit = {}): Request {
  return new Request(`https://app.trycycloid.com${path}`, options);
}

describe("Pages worker", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("proxied", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  function mockAuthStatus(authenticated: boolean) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ authenticated }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  describe("API proxy", () => {
    it("proxies /api/* requests to WORKER_HOST", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/sessions?limit=10");

      await worker.fetch(req, env);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const proxiedReq = fetchSpy.mock.calls[0][0] as Request;
      expect(proxiedReq.url).toBe("https://cycloid-control-plane.workers.dev/api/sessions?limit=10");
    });

    it("proxies /auth/* requests to WORKER_HOST", async () => {
      const env = makeEnv();
      const req = makeRequest("/auth/github/callback?code=abc");

      await worker.fetch(req, env);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const proxiedReq = fetchSpy.mock.calls[0][0] as Request;
      expect(proxiedReq.url).toBe("https://cycloid-control-plane.workers.dev/auth/github/callback?code=abc");
    });

    it("does not require auth for /api/* routes", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/health");

      const res = await worker.fetch(req, env);

      expect(res.status).not.toBe(401);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("forwards the original serving host as X-Forwarded-Host on API/auth proxy", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/sessions");

      await worker.fetch(req, env);

      const proxiedReq = fetchSpy.mock.calls[0][0] as Request;
      expect(proxiedReq.headers.get("X-Forwarded-Host")).toBe("app.trycycloid.com");
      // Host is still rewritten to the control-plane target.
      expect(proxiedReq.headers.get("Host")).toBe("cycloid-control-plane.workers.dev");
    });

    it("overwrites a spoofed inbound X-Forwarded-Host with the real serving host", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/sessions", {
        headers: { "X-Forwarded-Host": "attacker.example.com" },
      });

      await worker.fetch(req, env);

      const proxiedReq = fetchSpy.mock.calls[0][0] as Request;
      expect(proxiedReq.headers.get("X-Forwarded-Host")).toBe("app.trycycloid.com");
    });

    it("preserves request method and headers on proxy", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });

      await worker.fetch(req, env);

      const proxiedReq = fetchSpy.mock.calls[0][0] as Request;
      expect(proxiedReq.method).toBe("POST");
      expect(proxiedReq.headers.get("Content-Type")).toBe("application/json");
    });

    it("returns websocket upgrade responses untouched", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/sessions/s-123/ws", {
        headers: { upgrade: "websocket" },
      });
      const upgradeResponse = {
        status: 101,
        headers: new Headers(),
        webSocket: {},
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(upgradeResponse);

      const res = await worker.fetch(req, env);

      expect(res).toBe(upgradeResponse);
    });

    it("returns responses with a webSocket property untouched", async () => {
      const env = makeEnv();
      const req = makeRequest("/api/sessions/s-123/ws", {
        headers: { upgrade: "websocket" },
      });
      const upgradeResponse = {
        status: 200,
        headers: new Headers(),
        webSocket: {},
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(upgradeResponse);

      const res = await worker.fetch(req, env);

      expect(res).toBe(upgradeResponse);
    });
  });

  describe("static assets", () => {
    it("serves file assets without auth", async () => {
      const env = makeEnv();
      const req = makeRequest("/favicon-32.png");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("blocks source map assets before Pages or R2 asset lookup", async () => {
      const r2Bucket: R2BucketBinding = {
        get: vi.fn(async () => null),
      };
      const env = makeEnv({ UI_ASSETS_BUCKET: r2Bucket });
      const req = makeRequest("/assets/index-abc123.js.map");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
      expect(r2Bucket.get).not.toHaveBeenCalled();
    });
  });

  describe("public metadata", () => {
    it("serves security.txt without falling back to the SPA shell", async () => {
      const env = makeEnv();
      const req = makeRequest("/.well-known/security.txt");

      const res = await worker.fetch(req, env);
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(body).toContain("Contact: mailto:shivam@trycycloid.com");
      expect(body).toContain("Preferred-Languages: en");
      expect(body).toContain("Canonical: https://app.trycycloid.com/.well-known/security.txt");
      const expiresLine = body.split("\n").find((line) => line.startsWith("Expires: "));
      if (!expiresLine) throw new Error("security.txt missing Expires field");
      const expires = new Date(expiresLine.replace("Expires: ", ""));
      expect(expires.getTime()).toBeGreaterThan(Date.now() + 364 * 24 * 60 * 60 * 1000);
      expect(body).not.toContain("<!doctype html>");
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    });

    it("serves an explicit robots.txt indexing policy", async () => {
      const env = makeEnv();
      const req = makeRequest("/robots.txt");

      const res = await worker.fetch(req, env);
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(body).toContain("User-agent: *");
      expect(body).toContain("Disallow: /");
      expect(body).toContain("Allow: /.well-known/security.txt");
      expect(body).not.toContain("<!doctype html>");
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    });

    it.each(["/sitemap.xml", "/manifest.webmanifest"])("returns an explicit 404 for %s", async (path) => {
      const env = makeEnv();
      const req = makeRequest(path);

      const res = await worker.fetch(req, env);
      const body = await res.text();

      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(body).toBe("Not found");
      expect(body).not.toContain("<!doctype html>");
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    });

    it("redirects favicon.ico to the supported logo asset", async () => {
      const env = makeEnv();
      const req = makeRequest("/favicon.ico");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://app.trycycloid.com/favicon-32.png");
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    });
  });

  describe("document shell routing", () => {
    it("serves the public shell for signed-out document requests", async () => {
      mockAuthStatus(false);
      const assetsFetch = vi.fn().mockResolvedValue(
        new Response("<!doctype html><title>Public</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      const env = makeEnv({ ASSETS: { fetch: assetsFetch } });
      const req = makeRequest("/");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const authReq = fetchSpy.mock.calls[0][0] as Request;
      expect(authReq.url).toBe("https://cycloid-control-plane.workers.dev/auth/status");
      expect(authReq.headers.get("accept")).toBe("application/json");
      expect(authReq.headers.get("X-Forwarded-Host")).toBe("app.trycycloid.com");
      expect(assetsFetch).toHaveBeenCalledOnce();
      const shellReq = assetsFetch.mock.calls[0][0] as Request;
      expect(new URL(shellReq.url).pathname).toBe("/index.html");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    });

    it("serves the authenticated shell for authenticated document requests", async () => {
      mockAuthStatus(true);
      const assetsFetch = vi.fn().mockResolvedValue(
        new Response("<!doctype html><title>App</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      const env = makeEnv({ ASSETS: { fetch: assetsFetch } });
      const req = makeRequest("/sessions/abc123", {
        headers: { cookie: "session_token=session-123" },
      });

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      const authReq = fetchSpy.mock.calls[0][0] as Request;
      expect(authReq.headers.get("cookie")).toBe("session_token=session-123");
      const shellReq = assetsFetch.mock.calls[0][0] as Request;
      expect(new URL(shellReq.url).pathname).toBe("/authenticated.html");
    });

    it("fails closed to the public shell when auth selection fails", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("auth unavailable"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const assetsFetch = vi.fn().mockResolvedValue(
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      const env = makeEnv({ ASSETS: { fetch: assetsFetch } });
      const req = makeRequest("/settings/general");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      const shellReq = assetsFetch.mock.calls[0][0] as Request;
      expect(new URL(shellReq.url).pathname).toBe("/index.html");
      expect(consoleSpy).toHaveBeenCalledWith("Auth shell selection failed", expect.any(Error));
      consoleSpy.mockRestore();
    });

    it("serves the public shell for transient auth HTTP failures", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("temporary", { status: 500 }));
      const assetsFetch = vi.fn().mockResolvedValue(
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      const env = makeEnv({ ASSETS: { fetch: assetsFetch } });
      const req = makeRequest("/settings/general");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      const shellReq = assetsFetch.mock.calls[0][0] as Request;
      expect(new URL(shellReq.url).pathname).toBe("/index.html");
    });
  });

  describe("SPA fallback", () => {
    it("returns static asset directly when found", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response("body", { status: 200 })),
        },
      });
      const req = makeRequest("/assets/index-abc.js");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    });

    it("does not serve an HTML shell for non-navigation 404s", async () => {
      const assetsFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
      const env = makeEnv({ ASSETS: { fetch: assetsFetch } });
      const req = makeRequest("/extensionless-action", { method: "POST" });

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(assetsFetch).toHaveBeenCalledOnce();
    });
  });

  describe("R2 asset fallback", () => {
    function makeR2Bucket(objects: Record<string, { body: string; contentType?: string }> = {}): R2BucketBinding {
      return {
        get: vi.fn(async (key: string): Promise<R2ObjectBody | null> => {
          const entry = objects[key];
          if (!entry) return null;
          return {
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(entry.body));
                controller.close();
              },
            }),
            httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
          };
        }),
      };
    }

    it("serves from R2 when ASSETS returns HTML fallback for /assets/* path", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi
            .fn()
            .mockResolvedValue(
              new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
            ),
        },
        UI_ASSETS_BUCKET: makeR2Bucket({
          "assets/index-abc123.js": { body: "console.log('ok')", contentType: "application/javascript" },
        }),
      });
      const req = makeRequest("/assets/index-abc123.js");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/javascript");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await res.text()).toBe("console.log('ok')");
    });

    it("serves from R2 when ASSETS returns real 404 for /assets/* path", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
        },
        UI_ASSETS_BUCKET: makeR2Bucket({
          "assets/style-def456.css": { body: "body{}", contentType: "text/css" },
        }),
      });
      const req = makeRequest("/assets/style-def456.css");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/css");
      expect(await res.text()).toBe("body{}");
    });

    it("includes security headers on R2 hit responses", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
        },
        UI_ASSETS_BUCKET: makeR2Bucket({
          "assets/chunk.js": { body: "code", contentType: "application/javascript" },
        }),
      });
      const req = makeRequest("/assets/chunk.js");

      const res = await worker.fetch(req, env);

      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains; preload");
      expect(res.headers.get("content-security-policy")).toContain(
        "script-src 'self' https://challenges.cloudflare.com",
      );
      expect(res.headers.get("content-security-policy")).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(res.headers.get("content-security-policy")).toContain("https://browser-intake-us5-datadoghq.com");
    });

    it("adds local development connect targets only for local worker env", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response("body", { status: 200 })),
        },
        WORKER_ENV: "local",
      });
      const req = makeRequest("/assets/index-abc.js");

      const res = await worker.fetch(req, env);

      expect(res.headers.get("content-security-policy")).toContain("ws://localhost:*");
      expect(res.headers.get("strict-transport-security")).toBeNull();
    });

    it("normalizes upstream HSTS to a single worker-managed value", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(
            new Response("body", {
              status: 200,
              headers: {
                "content-type": "application/javascript",
                "strict-transport-security": "max-age=60",
              },
            }),
          ),
        },
      });
      const req = makeRequest("/assets/index-abc.js");

      const res = await worker.fetch(req, env);
      const hstsHeaders = Array.from(res.headers.entries()).filter(
        ([headerName]) => headerName === "strict-transport-security",
      );

      expect(hstsHeaders).toEqual([["strict-transport-security", "max-age=31536000; includeSubDomains; preload"]]);
    });

    it("returns 404 with no-store when R2 miss", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi
            .fn()
            .mockResolvedValue(
              new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
            ),
        },
        UI_ASSETS_BUCKET: makeR2Bucket({}),
      });
      const req = makeRequest("/assets/gone-chunk.js");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("returns 404 when no R2 binding is present (graceful degradation)", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi
            .fn()
            .mockResolvedValue(
              new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
            ),
        },
      });
      const req = makeRequest("/assets/missing.js");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("falls through to 404 on R2 error", async () => {
      const errorBucket: R2BucketBinding = {
        get: vi.fn().mockRejectedValue(new Error("R2 internal error")),
      };
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
        },
        UI_ASSETS_BUCKET: errorBucket,
      });
      const req = makeRequest("/assets/broken.js");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(consoleSpy).toHaveBeenCalledWith("R2 fallback error", "assets/broken.js", expect.any(Error));
      consoleSpy.mockRestore();
    });

    it("does not query R2 when ASSETS serves the asset directly", async () => {
      const r2Bucket = makeR2Bucket({});
      const env = makeEnv({
        ASSETS: {
          fetch: vi
            .fn()
            .mockResolvedValue(
              new Response("js-code", { status: 200, headers: { "content-type": "application/javascript" } }),
            ),
        },
        UI_ASSETS_BUCKET: r2Bucket,
      });
      const req = makeRequest("/assets/index-abc.js");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(r2Bucket.get).not.toHaveBeenCalled();
    });

    it("does not query R2 for document shell routing", async () => {
      mockAuthStatus(false);
      const r2Bucket = makeR2Bucket({});
      const assetsFetch = vi.fn().mockResolvedValue(
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
      const env = makeEnv({
        ASSETS: { fetch: assetsFetch },
        UI_ASSETS_BUCKET: r2Bucket,
      });
      const req = makeRequest("/sessions/abc123");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      const shellReq = assetsFetch.mock.calls[0][0] as Request;
      expect(new URL(shellReq.url).pathname).toBe("/index.html");
      expect(r2Bucket.get).not.toHaveBeenCalled();
    });

    it("falls back to extension-based content type when R2 metadata is absent", async () => {
      const env = makeEnv({
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
        },
        UI_ASSETS_BUCKET: makeR2Bucket({
          "assets/font.woff2": { body: "font-data" },
        }),
      });
      const req = makeRequest("/assets/font.woff2");

      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
    });
  });
});
