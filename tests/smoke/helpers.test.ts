import { describe, expect, it, vi } from "vitest";

import { flushAllWaitUntil } from "./helpers";

describe("smoke helpers", () => {
  it("flushes every durable namespace in the env", async () => {
    const flushA = vi.fn(async () => {});
    const flushB = vi.fn(async () => {});

    await flushAllWaitUntil({
      SESSION: { _flushWaitUntil: flushA },
      OTHER: { _flushWaitUntil: flushB },
      DB: {},
    });

    expect(flushA).toHaveBeenCalledOnce();
    expect(flushB).toHaveBeenCalledOnce();
  });
});
