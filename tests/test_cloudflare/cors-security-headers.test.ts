import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";
import { applyStandardHeaders, corsOrigin } from "../../apps/control-plane-worker/src/utils";

function makeRequest(origin?: string): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return new Request("https://api.trycycloid.com/api/sessions", { headers });
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    FRONTEND_URL: "https://app.trycycloid.com",
    ...overrides,
  } as Env;
}

describe("corsOrigin", () => {
  it("returns the origin when it matches FRONTEND_URL", () => {
    const req = makeRequest("https://app.trycycloid.com");
    expect(corsOrigin(req, makeEnv())).toBe("https://app.trycycloid.com");
  });

  it("returns null for a disallowed origin", () => {
    const req = makeRequest("https://evil.com");
    expect(corsOrigin(req, makeEnv())).toBeNull();
  });

  it("returns null when no Origin header is present", () => {
    const req = makeRequest();
    expect(corsOrigin(req, makeEnv())).toBeNull();
  });

  it("rejects localhost in production", () => {
    const req = makeRequest("http://localhost:5173");
    expect(corsOrigin(req, makeEnv())).toBeNull();
  });

  it("allows localhost:5173 in local dev", () => {
    const req = makeRequest("http://localhost:5173");
    expect(corsOrigin(req, makeEnv({ WORKER_ENV: "local" }))).toBe("http://localhost:5173");
  });

  it("allows localhost:3000 in local dev", () => {
    const req = makeRequest("http://localhost:3000");
    expect(corsOrigin(req, makeEnv({ WORKER_ENV: "local" }))).toBe("http://localhost:3000");
  });

  it("still rejects arbitrary origins in local dev", () => {
    const req = makeRequest("https://evil.com");
    expect(corsOrigin(req, makeEnv({ WORKER_ENV: "local" }))).toBeNull();
  });

  it("uses custom FRONTEND_URL when set", () => {
    const req = makeRequest("https://staging.trycycloid.com");
    const env = makeEnv({ FRONTEND_URL: "https://staging.trycycloid.com" });
    expect(corsOrigin(req, env)).toBe("https://staging.trycycloid.com");
  });

  it("defaults to app.trycycloid.com when FRONTEND_URL is unset", () => {
    const req = makeRequest("https://app.trycycloid.com");
    const env = makeEnv({ FRONTEND_URL: undefined });
    expect(corsOrigin(req, env)).toBe("https://app.trycycloid.com");
  });
});

describe("applyStandardHeaders", () => {
  function cspFor(response: Response): string {
    const policy = response.headers.get("content-security-policy");
    if (!policy) throw new Error("missing CSP");
    return policy;
  }

  it("adds CORS headers when origin matches", () => {
    const req = makeRequest("https://app.trycycloid.com");
    const res = applyStandardHeaders(new Response("ok"), req, makeEnv());

    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.trycycloid.com");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("does not add CORS headers for disallowed origin", () => {
    const req = makeRequest("https://evil.com");
    const res = applyStandardHeaders(new Response("ok"), req, makeEnv());

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not add CORS headers when no Origin header", () => {
    const req = makeRequest();
    const res = applyStandardHeaders(new Response("ok"), req, makeEnv());

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds all security headers", () => {
    const req = makeRequest();
    const res = applyStandardHeaders(new Response("ok"), req, makeEnv());

    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("threads a valid internal script nonce into CSP and strips the internal header", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = makeRequest();
    const nonce = crypto.randomUUID();
    const original = new Response("ok", { headers: { "x-script-nonce": nonce } });
    const res = applyStandardHeaders(original, req, makeEnv());

    expect(cspFor(res)).toContain(`script-src 'self' https://challenges.cloudflare.com 'nonce-${nonce}'`);
    expect(res.headers.has("x-script-nonce")).toBe(false);
    const logEntry = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logEntry.level).toBe("info");
    expect(logEntry.msg).toBe("Accepted internal script nonce for CSP generation");
    expect(JSON.stringify(logEntry)).not.toContain(nonce);
  });

  it("drops invalid internal script nonces before CSP generation and strips the internal header", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = makeRequest();
    const baseline = applyStandardHeaders(new Response("ok"), req, makeEnv());
    const original = new Response("ok", { headers: { "x-script-nonce": "bad nonce 'unsafe-inline'" } });
    const res = applyStandardHeaders(original, req, makeEnv());

    expect(cspFor(res)).toBe(cspFor(baseline));
    expect(res.headers.has("x-script-nonce")).toBe(false);
    const logEntry = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logEntry.level).toBe("warn");
    expect(logEntry.msg).toBe("Invalid internal script nonce header dropped before CSP generation");
    expect(JSON.stringify(logEntry)).not.toContain("bad nonce");
  });

  it("keeps CSP byte-identical when no internal script nonce is present", () => {
    const req = makeRequest();
    const first = applyStandardHeaders(new Response("ok"), req, makeEnv());
    const second = applyStandardHeaders(new Response("ok"), req, makeEnv());

    expect(cspFor(second)).toBe(cspFor(first));
  });

  it("adds local development connect targets only in local dev", () => {
    const req = makeRequest();
    const productionRes = applyStandardHeaders(new Response("ok"), req, makeEnv());
    const localRes = applyStandardHeaders(new Response("ok"), req, makeEnv({ WORKER_ENV: "local" }));

    expect(productionRes.headers.get("content-security-policy")).not.toContain("localhost");
    expect(localRes.headers.get("content-security-policy")).toContain("ws://localhost:*");
  });

  it("preserves original response body and status", async () => {
    const req = makeRequest();
    const original = new Response(JSON.stringify({ ok: true }), { status: 201 });
    const res = applyStandardHeaders(original, req, makeEnv());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("preserves existing headers from the response", () => {
    const req = makeRequest();
    const original = new Response("ok", {
      headers: { "content-type": "text/plain", "x-custom": "preserved" },
    });
    const res = applyStandardHeaders(original, req, makeEnv());

    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-custom")).toBe("preserved");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("returns WebSocket upgrade responses untouched (status 101)", () => {
    const req = makeRequest();
    const fakeUpgrade = {
      status: 101,
      headers: new Headers(),
      webSocket: {},
    } as unknown as Response;

    const res = applyStandardHeaders(fakeUpgrade, req, makeEnv());
    expect(res).toBe(fakeUpgrade);
  });

  it("returns responses with a webSocket property untouched even at other statuses", () => {
    const req = makeRequest();
    const fakeUpgrade = {
      status: 200,
      headers: new Headers(),
      webSocket: {},
    } as unknown as Response;

    const res = applyStandardHeaders(fakeUpgrade, req, makeEnv());
    expect(res).toBe(fakeUpgrade);
  });
});
