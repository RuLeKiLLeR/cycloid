import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../apps/status-worker/src/index";

interface StatusBody {
  state: "up" | "down";
  message: string;
  updatedAt: number | null;
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const statusFlag = { get: vi.fn() };
let cacheStore: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

beforeEach(() => {
  ctx.waitUntil.mockClear();
  statusFlag.get.mockReset();
  cacheStore = {
    match: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  };
  (globalThis as { caches?: unknown }).caches = { default: cacheStore };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function env() {
  return { STATUS_FLAG: statusFlag };
}

async function call(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://status.trycycloid.com${path}`, init), env() as never, ctx as never);
}

async function callJson(path = "/api/status"): Promise<StatusBody> {
  return (await (await call(path)).json()) as StatusBody;
}

describe("status worker", () => {
  it("renders an up status from the manual flag", async () => {
    statusFlag.get.mockResolvedValue({ state: "up", message: "Maintenance complete", updatedAt: 1_765_000_000_000 });

    const body = await callJson();
    expect(body).toEqual({ state: "up", message: "Maintenance complete", updatedAt: 1_765_000_000_000 });

    const page = await (await call("/")).text();
    expect(page).toContain("All systems operational");
    expect(page).toContain("Maintenance complete");
  });

  it("renders a down status from the manual flag", async () => {
    statusFlag.get.mockResolvedValue({ state: "down", message: "Sessions are degraded", updatedAt: 1_765_000_000_000 });

    const body = await callJson();
    expect(body.state).toBe("down");
    expect(body.message).toBe("Sessions are degraded");

    const page = await (await call("/")).text();
    expect(page).toContain("Cycloid is down");
    expect(page).toContain("Sessions are degraded");
  });

  it("treats a missing key as operational with an empty message", async () => {
    statusFlag.get.mockResolvedValue(null);

    expect(await callJson()).toEqual({ state: "up", message: "", updatedAt: null });

    const page = await (await call("/")).text();
    expect(page).toContain("All systems operational");
    expect(page).not.toContain("Updated ");
  });

  it.each([
    ["non-JSON value", () => statusFlag.get.mockRejectedValue(new SyntaxError("bad json"))],
    ["bad state", () => statusFlag.get.mockResolvedValue({ state: "broken", message: "", updatedAt: 1 })],
    ["missing message", () => statusFlag.get.mockResolvedValue({ state: "up", updatedAt: 1 })],
    [
      "over-long message",
      () => statusFlag.get.mockResolvedValue({ state: "up", message: "x".repeat(1_001), updatedAt: 1 }),
    ],
    ["non-numeric updatedAt", () => statusFlag.get.mockResolvedValue({ state: "up", message: "", updatedAt: "now" })],
    [
      "out-of-range updatedAt (ns epoch)",
      () => statusFlag.get.mockResolvedValue({ state: "up", message: "", updatedAt: 9e15 }),
    ],
  ])("falls back safely for malformed flag data: %s", async (_name, setup) => {
    setup();

    const body = await callJson();
    expect(body).toEqual({ state: "up", message: "", updatedAt: null });
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalled();
  });

  it("serves the HTML page (not a 500) when updatedAt is an out-of-range epoch", async () => {
    // A human-edited KV flag with a ns/us epoch (> 8.64e15) would otherwise make
    // new Date(x).toISOString() throw RangeError out of the fetch handler, 500ing
    // the one page that must stay up during an incident. The bad timestamp now
    // invalidates the flag (same as any other malformed field) and we fall back
    // to operational rather than crashing.
    statusFlag.get.mockResolvedValue({
      state: "down",
      message: "Sessions are degraded",
      updatedAt: 9e15,
    });

    const res = await call("/");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("All systems operational");
    expect(page).not.toContain("Updated ");
  });

  it("escapes dynamic message HTML in the rendered page", async () => {
    statusFlag.get.mockResolvedValue({
      state: "down",
      message: '<script>alert("x")</script><b>bold</b>',
      updatedAt: 1_765_000_000_000,
    });

    const page = await (await call("/")).text();
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<b>bold</b>");
    expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;b&gt;bold&lt;/b&gt;");
    expect((await call("/")).headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("clamps rendered messages to the configured 200 character limit", async () => {
    statusFlag.get.mockResolvedValue({
      state: "down",
      message: "x".repeat(300),
      updatedAt: 1_765_000_000_000,
    });

    const page = await (await call("/")).text();
    expect(page).toContain(`${"x".repeat(197)}...`);
    expect(page).not.toContain("x".repeat(201));
  });

  it("serves the last-known-good status when KV throws", async () => {
    statusFlag.get.mockRejectedValue(new Error("kv unavailable"));
    cacheStore.match.mockResolvedValue(
      new Response(JSON.stringify({ state: "down", message: "Current incident", updatedAt: 1_765_000_000_000 })),
    );

    expect(await callJson()).toEqual({
      state: "down",
      message: "Current incident",
      updatedAt: 1_765_000_000_000,
    });
  });

  it("serves static operational status when KV throws and no last-known-good exists", async () => {
    statusFlag.get.mockRejectedValue(new Error("kv unavailable"));
    cacheStore.match.mockResolvedValue(undefined);

    expect(await callJson()).toEqual({ state: "up", message: "", updatedAt: null });
  });

  it("logs and serves static operational status when last-known-good cache is invalid", async () => {
    statusFlag.get.mockRejectedValue(new Error("kv unavailable"));
    cacheStore.match.mockResolvedValue(
      new Response(JSON.stringify({ state: "unknown", message: "", updatedAt: null })),
    );

    expect(await callJson()).toEqual({ state: "up", message: "", updatedAt: null });
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("status_worker_last_known_good_invalid"));
  });

  it("sets the pinned JSON headers for /api/status", async () => {
    statusFlag.get.mockResolvedValue(null);

    const res = await call("/api/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 405 for non-GET requests", async () => {
    const res = await call("/", { method: "POST" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(statusFlag.get).not.toHaveBeenCalled();
  });

  it("serves HEAD for both public endpoints without a response body", async () => {
    statusFlag.get.mockResolvedValue({
      state: "down",
      message: "Sessions are degraded",
      updatedAt: 1_765_000_000_000,
    });

    const html = await call("/", { method: "HEAD" });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html; charset=utf-8");
    expect(await html.text()).toBe("");

    const json = await call("/api/status", { method: "HEAD" });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toContain("application/json; charset=utf-8");
    expect(await json.text()).toBe("");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await call("/anything-else");

    expect(res.status).toBe(404);
    expect(statusFlag.get).not.toHaveBeenCalled();
  });
});
