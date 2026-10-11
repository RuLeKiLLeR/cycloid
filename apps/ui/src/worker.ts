import { ENVIRONMENT } from "../../../shared/constants/environment.js";
import { buildContentSecurityPolicy } from "../../../shared/security/content-security-policy.js";
import { ASSET_CONTENT_TYPES } from "./constants/worker.js";

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

const PUBLIC_SHELL_HTML = "/index.html";
const AUTHENTICATED_SHELL_HTML = "/authenticated.html";

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const STRICT_TRANSPORT_SECURITY_HEADER = "max-age=31536000; includeSubDomains; preload";

const SECURITY_TXT_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000;

function buildSecurityTxt(now = Date.now()): string {
  const expires = new Date(now + SECURITY_TXT_EXPIRATION_MS).toISOString().replace(/\.\d{3}Z$/, "Z");

  return [
    "Contact: mailto:shivam@trycycloid.com",
    "Preferred-Languages: en",
    "Canonical: https://app.trycycloid.com/.well-known/security.txt",
    `Expires: ${expires}`,
    "",
  ].join("\n");
}

const ROBOTS_TXT = [
  "# Cycloid app routes are authenticated and are not intended for indexing.",
  "User-agent: *",
  "Disallow: /",
  "Allow: /.well-known/security.txt",
  "",
].join("\n");

/** Clone a response with strict no-cache headers so CDN edges never serve stale HTML. */
function noCacheHtml(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  return withSecurityHeaders(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    env,
  );
}

function withSecurityHeaders(response: Response, env: Env): Response {
  // WebSocket upgrade responses cannot be reconstructed: recreating the
  // Response drops Cloudflare's non-standard `webSocket` property required
  // to complete the upgrade handshake.
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  if (env.WORKER_ENV === ENVIRONMENT.Local) {
    headers.delete("strict-transport-security");
  } else {
    headers.set("strict-transport-security", STRICT_TRANSPORT_SECURITY_HEADER);
  }
  headers.set(
    "content-security-policy",
    buildContentSecurityPolicy({
      includeLocalDev: env.WORKER_ENV === ENVIRONMENT.Local,
    }),
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function contentTypeFromKey(key: string): string {
  const dotIndex = key.lastIndexOf(".");
  if (dotIndex === -1) return "application/octet-stream";
  return ASSET_CONTENT_TYPES[key.slice(dotIndex)] ?? "application/octet-stream";
}

function proxiedWorkerRequest(request: Request, env: Env, pathname: string, search = ""): Request {
  const target = new URL(pathname + search, `https://${env.WORKER_HOST}`);
  const headers = new Headers(request.headers);
  headers.set("Host", env.WORKER_HOST);
  // Rewriting Host to WORKER_HOST erases which domain the browser actually hit
  // (app / qa.app / internal.app). The control plane treats X-Forwarded-Host as
  // identity-adjacent input for choosing the OAuth redirect host, so carry the
  // original serving host explicitly. Always overwrite: never trust or
  // propagate an inbound X-Forwarded-Host, since a spoofed value would redirect
  // OAuth to an attacker-chosen host.
  headers.set("X-Forwarded-Host", new URL(request.url).hostname);
  return new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    // @ts-expect-error -- required by Node/undici, noop in Workers runtime
    duplex: "half",
  });
}

function htmlShellRequest(request: Request, url: URL, htmlPath: string): Request {
  return new Request(new URL(htmlPath, url.origin), {
    headers: request.headers,
    method: request.method,
  });
}

function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? "";
  return /\.[^/]+$/.test(lastSegment);
}

function isHtmlShellRequest(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (url.pathname.startsWith("/assets/")) return false;
  if (url.pathname === PUBLIC_SHELL_HTML || url.pathname === AUTHENTICATED_SHELL_HTML) return true;
  return !hasFileExtension(url.pathname);
}

async function hasAuthenticatedSession(request: Request, env: Env): Promise<boolean> {
  const authRequest = proxiedWorkerRequest(
    new Request(request.url, {
      headers: request.headers,
      method: "GET",
    }),
    env,
    "/auth/status",
  );
  authRequest.headers.set("accept", "application/json");

  try {
    const response = await fetch(authRequest);
    if (!response.ok) return false;
    const data = (await response.json()) as { authenticated?: unknown };
    return data.authenticated === true;
  } catch (error) {
    console.error("Auth shell selection failed", error);
    return false;
  }
}

async function selectHtmlShell(request: Request, env: Env): Promise<string> {
  if (await hasAuthenticatedSession(request, env)) return AUTHENTICATED_SHELL_HTML;
  return PUBLIC_SHELL_HTML;
}

function isSourceMapAssetPath(pathname: string): boolean {
  return pathname.startsWith("/assets/") && pathname.endsWith(".map");
}

function metadataResponse(url: URL, env: Env): Response | null {
  if (url.pathname === "/.well-known/security.txt") {
    return withSecurityHeaders(
      new Response(buildSecurityTxt(), {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      }),
      env,
    );
  }

  if (url.pathname === "/robots.txt") {
    return withSecurityHeaders(
      new Response(ROBOTS_TXT, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      }),
      env,
    );
  }

  if (url.pathname === "/sitemap.xml" || url.pathname === "/manifest.webmanifest") {
    return withSecurityHeaders(
      new Response("Not found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
      env,
    );
  }

  if (url.pathname === "/favicon.ico") {
    return withSecurityHeaders(Response.redirect(new URL("/favicon-32.png", url.origin), 302), env);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Proxy API and auth routes to the Cloudflare Worker.
    const isApiRoute = url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/");

    if (isApiRoute) {
      const proxyRequest = proxiedWorkerRequest(request, env, url.pathname, url.search);
      return withSecurityHeaders(await fetch(proxyRequest), env);
    }

    if (isSourceMapAssetPath(url.pathname)) {
      return withSecurityHeaders(
        new Response("Not found", {
          status: 404,
          headers: { "cache-control": "no-store" },
        }),
        env,
      );
    }

    const publicMetadataResponse = metadataResponse(url, env);
    if (publicMetadataResponse) {
      return publicMetadataResponse;
    }

    if (isHtmlShellRequest(request, url)) {
      const htmlPath = await selectHtmlShell(request, env);
      const shell = await env.ASSETS.fetch(htmlShellRequest(request, url, htmlPath));
      return noCacheHtml(shell, env);
    }

    // Serve static assets
    const response = await env.ASSETS.fetch(request);

    // Hashed assets (/assets/*): if the current deploy no longer has
    // the file, Pages returns 200 + index.html (SPA fallback) or a
    // real 404. In either case, try R2 before giving up.
    const isAssetPath = url.pathname.startsWith("/assets/");
    const assetMissing =
      isAssetPath && (response.status === 404 || response.headers.get("content-type")?.includes("text/html"));

    if (assetMissing && env.UI_ASSETS_BUCKET) {
      const key = url.pathname.slice(1); // strip leading /
      try {
        const object = await env.UI_ASSETS_BUCKET.get(key);
        if (object) {
          console.log(JSON.stringify({ event: "r2_fallback_hit", key }));
          const contentType = object.httpMetadata?.contentType ?? contentTypeFromKey(key);
          return withSecurityHeaders(
            new Response(object.body, {
              status: 200,
              headers: {
                "content-type": contentType,
                "cache-control": "public, max-age=31536000, immutable",
              },
            }),
            env,
          );
        }
      } catch (err) {
        console.error("R2 fallback error", key, err);
      }
      return withSecurityHeaders(
        new Response("Not found", {
          status: 404,
          headers: { "cache-control": "no-store" },
        }),
        env,
      );
    }

    if (assetMissing) {
      // No R2 binding -- original 404 behavior
      return withSecurityHeaders(
        new Response("Not found", {
          status: 404,
          headers: { "cache-control": "no-store" },
        }),
        env,
      );
    }

    // Prevent edge caching of HTML responses (e.g. / serves index.html but
    // the _headers rule only matches the literal /index.html path).
    if (response.headers.get("content-type")?.includes("text/html")) {
      return noCacheHtml(response, env);
    }

    return withSecurityHeaders(response, env);
  },
};
