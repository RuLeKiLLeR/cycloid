import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeLogger } from "../../apps/sandbox-bridge/src/logger.js";
import { installFetchLogger } from "../../apps/sandbox-bridge/src/services/fetch-logger.js";

const originalFetch = globalThis.fetch;

let uninstallFetchLogger: (() => void) | undefined;

afterEach(() => {
  uninstallFetchLogger?.();
  uninstallFetchLogger = undefined;
  globalThis.fetch = originalFetch;
  delete process.env.BRAINTRUST_API_URL;
  vi.restoreAllMocks();
});

describe("installFetchLogger", () => {
  it.each(["/logs", "/logs3"])(
    "classifies Braintrust %s flush failures separately from product fetch failures",
    async (path) => {
      const logger = createMockLogger();
      const fetchError = new Error("headers timeout");
      globalThis.fetch = vi.fn(async () => {
        throw fetchError;
      }) as typeof fetch;

      const handle = installFetchLogger(logger.root);
      uninstallFetchLogger = handle.uninstall;

      await expect(fetch(`https://api.braintrust.dev${path}?query=redacted`, { method: "POST" })).rejects.toThrow(
        "headers timeout",
      );

      expect(logger.child.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "observability_flush_failed",
          host: "api.braintrust.dev",
          path,
          url: `https://api.braintrust.dev${path}`,
          errorSummary: "headers timeout",
        }),
        "Observability flush failed",
      );
      expect(logger.child.error).not.toHaveBeenCalledWith(expect.anything(), "Fetch request failed");
    },
  );

  it("classifies proxied Braintrust logs3 POST failures separately from product fetch failures", async () => {
    process.env.BRAINTRUST_API_URL = "https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust";
    const logger = createMockLogger();
    const fetchError = new Error("proxy timeout");
    globalThis.fetch = vi.fn(async () => {
      throw fetchError;
    }) as typeof fetch;

    const handle = installFetchLogger(logger.root);
    uninstallFetchLogger = handle.uninstall;

    await expect(
      fetch("https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust/logs3?x=1", {
        method: "POST",
      }),
    ).rejects.toThrow("proxy timeout");

    expect(logger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "observability_flush_failed",
        host: "api.trycycloid.com",
        path: "/api/sessions/session-123/sandbox/telemetry/braintrust/logs3",
        url: "https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust/logs3",
        errorSummary: "proxy timeout",
      }),
      "Observability flush failed",
    );
    expect(logger.child.error).not.toHaveBeenCalledWith(expect.anything(), "Fetch request failed");
  });

  it("matches proxied Braintrust flush paths when the configured base has a trailing slash", async () => {
    process.env.BRAINTRUST_API_URL =
      "https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust/";
    const logger = createMockLogger();
    const fetchError = new Error("proxy timeout");
    globalThis.fetch = vi.fn(async () => {
      throw fetchError;
    }) as typeof fetch;

    const handle = installFetchLogger(logger.root);
    uninstallFetchLogger = handle.uninstall;

    await expect(
      fetch("https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust/logs3", {
        method: "POST",
      }),
    ).rejects.toThrow("proxy timeout");

    expect(logger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "observability_flush_failed",
        path: "/api/sessions/session-123/sandbox/telemetry/braintrust/logs3",
      }),
      "Observability flush failed",
    );
    expect(logger.child.error).not.toHaveBeenCalledWith(expect.anything(), "Fetch request failed");
  });

  it("falls back to direct Braintrust matching when the configured base is unparseable", async () => {
    process.env.BRAINTRUST_API_URL = "not a url";
    const logger = createMockLogger();
    const fetchError = new Error("headers timeout");
    globalThis.fetch = vi.fn(async () => {
      throw fetchError;
    }) as typeof fetch;

    const handle = installFetchLogger(logger.root);
    uninstallFetchLogger = handle.uninstall;

    await expect(fetch("https://api.braintrust.dev/logs3", { method: "POST" })).rejects.toThrow("headers timeout");

    expect(logger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "observability_flush_failed",
        host: "api.braintrust.dev",
        path: "/logs3",
      }),
      "Observability flush failed",
    );
    expect(logger.child.error).not.toHaveBeenCalledWith(expect.anything(), "Fetch request failed");
  });

  it("keeps non-POST Braintrust flush-shaped failures logged as errors", async () => {
    process.env.BRAINTRUST_API_URL = "https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust";
    const logger = createMockLogger();
    const fetchError = new Error("get failed");
    globalThis.fetch = vi.fn(async () => {
      throw fetchError;
    }) as typeof fetch;

    const handle = installFetchLogger(logger.root);
    uninstallFetchLogger = handle.uninstall;

    await expect(
      fetch("https://api.trycycloid.com/api/sessions/session-123/sandbox/telemetry/braintrust/logs3"),
    ).rejects.toThrow("get failed");

    expect(logger.child.error).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "api.trycycloid.com",
        path: "/api/sessions/session-123/sandbox/telemetry/braintrust/logs3",
        error: "get failed",
      }),
      "Fetch request failed",
    );
    expect(logger.child.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "observability_flush_failed" }),
      "Observability flush failed",
    );
  });

  it("keeps non-Braintrust fetch failures logged as errors", async () => {
    const logger = createMockLogger();
    const fetchError = new Error("network down");
    globalThis.fetch = vi.fn(async () => {
      throw fetchError;
    }) as typeof fetch;

    const handle = installFetchLogger(logger.root);
    uninstallFetchLogger = handle.uninstall;

    await expect(fetch("https://api.github.com/repos/trycycloid/cycloid")).rejects.toThrow("network down");

    expect(logger.child.error).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "api.github.com",
        path: "/repos/trycycloid/cycloid",
        error: "network down",
      }),
      "Fetch request failed",
    );
    expect(logger.child.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "observability_flush_failed" }),
      "Observability flush failed",
    );
  });

  it("keeps non-flush Braintrust fetch failures logged as errors", async () => {
    const logger = createMockLogger();
    const fetchError = new Error("dataset request failed");
    globalThis.fetch = vi.fn(async () => {
      throw fetchError;
    }) as typeof fetch;

    const handle = installFetchLogger(logger.root);
    uninstallFetchLogger = handle.uninstall;

    await expect(fetch("https://api.braintrust.dev/datasets?project=redacted")).rejects.toThrow(
      "dataset request failed",
    );

    expect(logger.child.error).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "api.braintrust.dev",
        path: "/datasets",
        url: "https://api.braintrust.dev/datasets",
        error: "dataset request failed",
      }),
      "Fetch request failed",
    );
    expect(logger.child.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "observability_flush_failed" }),
      "Observability flush failed",
    );
  });

  it("keeps non-ok response logging unchanged", async () => {
    const logger = createMockLogger();
    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;

    const handle = installFetchLogger(logger.root, { slowThresholdMs: 60_000 });
    uninstallFetchLogger = handle.uninstall;

    await fetch("https://example.com/api");

    expect(logger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "example.com",
        path: "/api",
        status: 503,
        slowThresholdMs: 60_000,
      }),
      "Fetch request non-ok",
    );
    expect(logger.child.error).not.toHaveBeenCalled();
  });

  it("keeps slow response logging unchanged", async () => {
    const logger = createMockLogger();
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;

    const handle = installFetchLogger(logger.root, { slowThresholdMs: 0 });
    uninstallFetchLogger = handle.uninstall;

    await fetch("https://example.com/slow");

    expect(logger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "example.com",
        path: "/slow",
        status: 200,
        slowThresholdMs: 0,
      }),
      "Fetch request slow",
    );
    expect(logger.child.error).not.toHaveBeenCalled();
  });
});

function createMockLogger(): { root: BridgeLogger; child: BridgeLogger } {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  child.child.mockReturnValue(child);

  const root = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => child),
  };

  return { root, child };
}
