import { describe, expect, it } from "vitest";

import { createBoundedTtlMemoryCache } from "../../apps/control-plane-worker/src/bounded-memory-cache";

describe("createBoundedTtlMemoryCache", () => {
  it("returns values within the TTL and null after expiry", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(10);
    const start = 1_000;
    cache.set("a", 1, 1_000, start);

    expect(cache.get("a", start + 500)).toBe(1);
    expect(cache.get("a", start + 1_001)).toBeNull();
    // Subsequent reads should still be null (entry evicted on expiry miss).
    expect(cache.get("a", start + 2_000)).toBeNull();
  });

  it("evicts the least-recently-used entry when exceeding the max size", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(3);
    const now = 1_000;
    cache.set("a", 1, 60_000, now);
    cache.set("b", 2, 60_000, now);
    cache.set("c", 3, 60_000, now);

    // Touch "a" so "b" becomes the LRU entry.
    expect(cache.get("a", now)).toBe(1);

    cache.set("d", 4, 60_000, now);

    expect(cache.get("b", now)).toBeNull(); // evicted
    expect(cache.get("a", now)).toBe(1);
    expect(cache.get("c", now)).toBe(3);
    expect(cache.get("d", now)).toBe(4);
  });

  it("evicts multiple entries when overflow exceeds one", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(2);
    const now = 1_000;
    cache.set("a", 1, 60_000, now);
    cache.set("b", 2, 60_000, now);
    cache.set("c", 3, 60_000, now);
    cache.set("d", 4, 60_000, now);

    expect(cache.get("a", now)).toBeNull();
    expect(cache.get("b", now)).toBeNull();
    expect(cache.get("c", now)).toBe(3);
    expect(cache.get("d", now)).toBe(4);
  });

  it("refreshes insertion order on get so recently-read entries survive overflow", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(2);
    const now = 1_000;
    cache.set("a", 1, 60_000, now);
    cache.set("b", 2, 60_000, now);
    // Read "a" to mark it as most-recently-used.
    expect(cache.get("a", now)).toBe(1);
    cache.set("c", 3, 60_000, now);

    // "b" was LRU and should have been evicted, not "a".
    expect(cache.get("b", now)).toBeNull();
    expect(cache.get("a", now)).toBe(1);
    expect(cache.get("c", now)).toBe(3);
  });

  it("overwrites an existing key without growing past the cap", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(2);
    const now = 1_000;
    cache.set("a", 1, 60_000, now);
    cache.set("b", 2, 60_000, now);
    cache.set("a", 99, 60_000, now);
    cache.set("c", 3, 60_000, now);

    // "a" was refreshed to most-recently-used by the overwrite, so "b" should be evicted.
    expect(cache.get("a", now)).toBe(99);
    expect(cache.get("b", now)).toBeNull();
    expect(cache.get("c", now)).toBe(3);
  });

  it("evicts expired entries during set before checking overflow", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(3);
    const start = 1_000;
    cache.set("a", 1, 1_000, start);
    cache.set("b", 2, 1_000, start);
    cache.set("c", 3, 5_000, start);

    // Well past a and b's TTL; they should be reaped during the next set.
    cache.set("d", 4, 5_000, start + 2_000);

    expect(cache.get("a", start + 2_000)).toBeNull();
    expect(cache.get("b", start + 2_000)).toBeNull();
    expect(cache.get("c", start + 2_000)).toBe(3);
    expect(cache.get("d", start + 2_000)).toBe(4);
  });

  it("supports delete and clear", () => {
    const cache = createBoundedTtlMemoryCache<string, number>(4);
    const now = 1_000;
    cache.set("a", 1, 60_000, now);
    cache.set("b", 2, 60_000, now);

    cache.delete("a");
    expect(cache.get("a", now)).toBeNull();
    expect(cache.get("b", now)).toBe(2);

    cache.clear();
    expect(cache.get("b", now)).toBeNull();
  });

  it("caps growth under high-churn overflow", () => {
    const cache = createBoundedTtlMemoryCache<number, number>(50);
    const now = 1_000;

    for (let i = 0; i < 500; i++) {
      cache.set(i, i, 60_000, now);
    }

    // The first 450 keys should have been evicted.
    for (let i = 0; i < 450; i++) {
      expect(cache.get(i, now)).toBeNull();
    }
    // The last 50 keys should still be present.
    for (let i = 450; i < 500; i++) {
      expect(cache.get(i, now)).toBe(i);
    }
  });
});
