import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const captureUiError = vi.fn();
vi.mock("../../apps/ui/src/sentry.js", () => ({ captureUiError }));

import { ApiError, requestJson } from "../../apps/ui/src/api/client.js";

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Let any pending import("../sentry") microtask from this test resolve before
  // clearing, so a deferred capture cannot bleed into the next test's count.
  await new Promise((r) => setTimeout(r, 0));
  captureUiError.mockClear();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
}

const Session = z.object({ id: z.string(), title: z.string() });

describe("requestJson runtime validation", () => {
  it("returns schema-parsed data for a well-formed response", async () => {
    globalThis.fetch = jsonResponse({ id: "s1", title: "hi" });
    const result = await requestJson("/api/session", undefined, undefined, { schema: Session });
    expect(result).toEqual({ id: "s1", title: "hi" });
  });

  it("throws an invalid_response ApiError on a malformed success response (fail-closed default)", async () => {
    globalThis.fetch = jsonResponse({ id: "s1" }); // missing `title`
    const err = await requestJson("/api/session", undefined, undefined, { schema: Session }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(200);
  });

  it("does not leak the response body into the thrown error", async () => {
    globalThis.fetch = jsonResponse({ id: "s1", secret: "leak-me" });
    const err = await requestJson("/api/session", undefined, undefined, { schema: Session }).catch((e) => e);
    expect(JSON.stringify(err.data)).not.toContain("leak-me");
    expect(err.data).toEqual({ issues: expect.stringContaining("title") });
  });

  it("fail-soft mode 'warn' logs and casts instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = jsonResponse({ id: "s1" });
    const result = await requestJson<{ id: string; title: string }>("/api/session", undefined, undefined, {
      schema: Session,
      mode: "warn",
    });
    expect(result).toEqual({ id: "s1" });
    expect(consoleError).toHaveBeenCalledWith(
      "[api] Response validation failed",
      expect.objectContaining({ url: "/api/session" }),
    );
  });

  it("does not capture to Sentry in throw mode (boundary owns it; avoids double report)", async () => {
    globalThis.fetch = jsonResponse({ id: "s1" }); // missing `title`
    await requestJson("/api/session", undefined, undefined, { schema: Session }).catch(() => {});
    // Flush the dynamic import("../sentry") microtask the capture path would use.
    await new Promise((r) => setTimeout(r, 0));
    expect(captureUiError).not.toHaveBeenCalled();
  });

  it("captures to Sentry exactly once in warn mode (no boundary to rely on)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = jsonResponse({ id: "s1" }); // missing `title`
    await requestJson("/api/session", undefined, undefined, { schema: Session, mode: "warn" });
    await new Promise((r) => setTimeout(r, 0));
    expect(captureUiError).toHaveBeenCalledTimes(1);
  });

  it("casts without validating when no schema is provided (transitional fallback)", async () => {
    globalThis.fetch = jsonResponse({ anything: true });
    const result = await requestJson<{ anything: boolean }>("/api/session");
    expect(result).toEqual({ anything: true });
  });

  it("still surfaces HTTP errors as ApiError even when a schema is provided", async () => {
    globalThis.fetch = jsonResponse({ error: "nope", code: "forbidden" }, 403);
    const err = await requestJson("/api/session", undefined, undefined, { schema: Session }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("forbidden");
  });
});
