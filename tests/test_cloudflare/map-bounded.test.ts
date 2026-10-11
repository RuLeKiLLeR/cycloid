import { describe, expect, it } from "vitest";

import { mapBounded } from "../../apps/control-plane-worker/src/utils";

describe("mapBounded", () => {
  it("maps all items in order with bounded waves", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapBounded([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return item * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("clamps non-positive or fractional concurrency instead of looping forever", async () => {
    await expect(mapBounded([1, 2, 3], 0, async (item) => item)).resolves.toEqual([1, 2, 3]);
    await expect(mapBounded([1, 2, 3], -4, async (item) => item)).resolves.toEqual([1, 2, 3]);
    await expect(mapBounded([1, 2, 3], 1.7, async (item) => item)).resolves.toEqual([1, 2, 3]);
  });

  it("returns an empty array for no items", async () => {
    await expect(mapBounded([], 0, async (item) => item)).resolves.toEqual([]);
  });

  it("rejects when a mapper rejects", async () => {
    await expect(
      mapBounded([1, 2], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
