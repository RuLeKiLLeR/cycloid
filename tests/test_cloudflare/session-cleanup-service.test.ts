import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../apps/control-plane-worker/src/logger";
import { cleanupOrphanedSession } from "../../apps/control-plane-worker/src/session/cleanup";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function createMockDb(batchImpl?: () => Promise<unknown>) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(function bind() {
        return this;
      }),
    })),
    batch: vi.fn(batchImpl ?? (() => Promise.resolve([]))),
  } as unknown as D1Database;
}

describe("cleanupOrphanedSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs success after deleting index and webhook refs", async () => {
    const db = createMockDb();
    const logger = createMockLogger();

    await cleanupOrphanedSession(db, "session-1", logger);

    expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith({ sessionId: "session-1" }, "Orphaned session cleaned up from D1");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs and swallows cleanup failures", async () => {
    const db = createMockDb(() => Promise.reject(new Error("boom")));
    const logger = createMockLogger();

    await expect(cleanupOrphanedSession(db, "session-2", logger)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      { sessionId: "session-2", error: "Error: boom" },
      "Failed to clean up orphaned session from D1",
    );
  });
});
