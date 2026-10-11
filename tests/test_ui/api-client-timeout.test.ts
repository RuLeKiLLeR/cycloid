import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchWithTimeout } from "../../apps/ui/src/api/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A fetch that never resolves on its own and rejects only when its signal aborts. */
function hangingFetch(): typeof globalThis.fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as unknown as typeof globalThis.fetch;
}

describe("fetchWithTimeout", () => {
  it("rejects with a 408 ApiError when the request exceeds the timeout", async () => {
    globalThis.fetch = hangingFetch();
    await expect(fetchWithTimeout("/api/slow", undefined, 10)).rejects.toMatchObject({
      name: "ApiError",
      status: 408,
      code: "timeout",
    });
  });

  it("propagates a caller-initiated abort unchanged (not converted to a timeout ApiError)", async () => {
    globalThis.fetch = hangingFetch();
    const controller = new AbortController();
    const promise = fetchWithTimeout("/api/cancelled", { signal: controller.signal }, 10_000);
    const reason = new DOMException("user cancelled", "AbortError");
    controller.abort(reason);

    const err = await promise.catch((e) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("returns the response when fetch resolves before the timeout", async () => {
    const body = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn(async () => body) as unknown as typeof globalThis.fetch;
    await expect(fetchWithTimeout("/api/fast", undefined, 10_000)).resolves.toBe(body);
  });

  it("propagates a genuine network error instead of masking it as a timeout", async () => {
    const networkError = new TypeError("Failed to fetch");
    globalThis.fetch = vi.fn(async () => {
      throw networkError;
    }) as unknown as typeof globalThis.fetch;
    const err = await fetchWithTimeout("/api/down", undefined, 10_000).catch((e) => e);
    expect(err).toBe(networkError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  describe("without AbortSignal.any (older browser fallback)", () => {
    let originalAny: typeof AbortSignal.any;
    beforeEach(() => {
      originalAny = AbortSignal.any;
      // @ts-expect-error simulate a browser that lacks AbortSignal.any
      AbortSignal.any = undefined;
    });
    afterEach(() => {
      AbortSignal.any = originalAny;
    });

    it("still converts a timeout into a 408 ApiError when a caller signal is present", async () => {
      globalThis.fetch = hangingFetch();
      const controller = new AbortController();
      await expect(fetchWithTimeout("/api/slow", { signal: controller.signal }, 10)).rejects.toMatchObject({
        name: "ApiError",
        status: 408,
        code: "timeout",
      });
    });

    it("still propagates a caller-initiated abort through the fallback composition", async () => {
      globalThis.fetch = hangingFetch();
      const controller = new AbortController();
      const promise = fetchWithTimeout("/api/cancelled", { signal: controller.signal }, 10_000);
      controller.abort(new DOMException("user cancelled", "AbortError"));
      const err = await promise.catch((e) => e);
      expect(err).not.toBeInstanceOf(ApiError);
      expect((err as DOMException).name).toBe("AbortError");
    });
  });
});
