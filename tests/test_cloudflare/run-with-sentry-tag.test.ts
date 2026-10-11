import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: sentry.captureException,
}));

import type { Logger } from "../../apps/control-plane-worker/src/logger";
import { runWithSentryTag } from "../../apps/control-plane-worker/src/observability/run-with-sentry-tag";

function createMockLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

describe("runWithSentryTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs successful work without logging or reporting", async () => {
    const logger = createMockLogger();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(runWithSentryTag("successfulOperation", fn, logger)).resolves.toBeUndefined();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("logs and reports rejected work with the operation tag", async () => {
    const logger = createMockLogger();
    const err = new Error("boom");

    await expect(runWithSentryTag("failingOperation", () => Promise.reject(err), logger)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      { error: "Error: boom", operation: "failingOperation" },
      "Operation failed",
    );
    expect(sentry.captureException).toHaveBeenCalledWith(err, { tags: { operation: "failingOperation" } });
  });
});
