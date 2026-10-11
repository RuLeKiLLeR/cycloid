import { describe, expect, it } from "vitest";

import { truncateDepth } from "../../apps/control-plane-worker/src/utils";

const TRUNCATED = "[truncated: max depth exceeded]";

describe("truncateDepth", () => {
  describe("primitives pass through unchanged", () => {
    it("passes through strings", () => {
      expect(truncateDepth("hello")).toBe("hello");
    });

    it("passes through numbers", () => {
      expect(truncateDepth(42)).toBe(42);
      expect(truncateDepth(0)).toBe(0);
      expect(truncateDepth(-1.5)).toBe(-1.5);
    });

    it("passes through booleans", () => {
      expect(truncateDepth(true)).toBe(true);
      expect(truncateDepth(false)).toBe(false);
    });

    it("passes through null", () => {
      expect(truncateDepth(null)).toBeNull();
    });

    it("passes through undefined", () => {
      expect(truncateDepth(undefined)).toBeUndefined();
    });
  });

  describe("shallow structures pass through unchanged", () => {
    it("passes through a flat object", () => {
      expect(truncateDepth({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
    });

    it("passes through a flat array", () => {
      expect(truncateDepth([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("passes through an empty object", () => {
      expect(truncateDepth({})).toEqual({});
    });

    it("passes through an empty array", () => {
      expect(truncateDepth([])).toEqual([]);
    });
  });

  describe("custom maxDepth", () => {
    it("passes through an object nested exactly at maxDepth", () => {
      // maxDepth=3: depth 0 -> depth 1 -> depth 2 -> depth 3 value (leaf is fine)
      // The object at depth 3 is at currentDepth=3 which equals maxDepth, so it gets truncated.
      // The object at depth 2 (currentDepth=2) passes through and its child at currentDepth=3 is truncated.
      const input = { a: { b: { c: "leaf" } } };
      const result = truncateDepth(input, 3) as Record<string, unknown>;
      expect(result.a).toEqual({ b: { c: "leaf" } });
    });

    it("truncates an object one level beyond maxDepth", () => {
      // At maxDepth=3, currentDepth=3 triggers truncation.
      // { a: { b: { c: { d: "deep" } } } } -> 'c' value is at depth 3, gets truncated.
      const input = { a: { b: { c: { d: "deep" } } } };
      const result = truncateDepth(input, 3) as Record<string, unknown>;
      const level1 = result.a as Record<string, unknown>;
      const level2 = level1.b as Record<string, unknown>;
      expect(level2.c).toBe(TRUNCATED);
    });

    it("truncates an array one level beyond maxDepth", () => {
      const input = { a: { b: { c: [1, 2, 3] } } };
      const result = truncateDepth(input, 3) as Record<string, unknown>;
      const level1 = result.a as Record<string, unknown>;
      const level2 = level1.b as Record<string, unknown>;
      expect(level2.c).toBe(TRUNCATED);
    });

    it("handles maxDepth=1 (only top-level object, children truncated)", () => {
      const input = { a: { b: "nested" }, x: 42 };
      const result = truncateDepth(input, 1) as Record<string, unknown>;
      expect(result.a).toBe(TRUNCATED);
      expect(result.x).toBe(42);
    });

    it("handles maxDepth=0 (root object itself truncated)", () => {
      expect(truncateDepth({ a: 1 }, 0)).toBe(TRUNCATED);
      expect(truncateDepth([1, 2], 0)).toBe(TRUNCATED);
    });
  });

  describe("arrays nested beyond maxDepth", () => {
    it("truncates deeply nested arrays", () => {
      const input = [[[[1]]]];
      const result = truncateDepth(input, 3) as unknown[];
      const level1 = result[0] as unknown[];
      const level2 = level1[0] as unknown[];
      expect(level2[0]).toBe(TRUNCATED);
    });

    it("preserves array items within depth limit", () => {
      const input = [
        [1, 2],
        [3, 4],
      ];
      expect(truncateDepth(input, 3)).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });
  });

  describe("mixed objects and arrays", () => {
    it("handles objects containing arrays containing objects", () => {
      const input = { items: [{ name: "a" }, { name: "b" }] };
      expect(truncateDepth(input, 3)).toEqual({ items: [{ name: "a" }, { name: "b" }] });
    });

    it("truncates mixed structure beyond maxDepth", () => {
      // At maxDepth=2: root(0) -> items(1) -> each item object is at depth 2, gets truncated
      const input = { items: [{ name: "a" }] };
      const result = truncateDepth(input, 2) as Record<string, unknown>;
      const items = result.items as unknown[];
      expect(items[0]).toBe(TRUNCATED);
    });

    it("truncates only the parts that exceed maxDepth, leaves others intact", () => {
      const input = {
        shallow: "value",
        deep: { nested: { tooDeep: { x: 1 } } },
      };
      const result = truncateDepth(input, 3) as Record<string, unknown>;
      expect(result.shallow).toBe("value");
      const deep = result.deep as Record<string, unknown>;
      const nested = deep.nested as Record<string, unknown>;
      expect(nested.tooDeep).toBe(TRUNCATED);
    });
  });

  describe("default depth of 64", () => {
    it("passes through an object nested 63 levels deep", () => {
      let obj: unknown = "leaf";
      for (let i = 0; i < 63; i++) {
        obj = { child: obj };
      }
      // 63 levels of wrapping: root is depth 0, leaf is at depth 63 which is < 64, so it passes through
      const result = truncateDepth(obj) as Record<string, unknown>;
      expect(result.child).toBeDefined();
    });

    it("truncates an object nested 65 levels deep", () => {
      // Build 65 levels of nesting so the innermost object is at depth 65 > 64
      let obj: unknown = { leaf: true };
      for (let i = 0; i < 65; i++) {
        obj = { child: obj };
      }
      // Walk 64 levels down and verify the next level is truncated
      let current = truncateDepth(obj) as Record<string, unknown>;
      for (let i = 0; i < 63; i++) {
        current = current.child as Record<string, unknown>;
      }
      expect(current.child).toBe(TRUNCATED);
    });
  });
});
