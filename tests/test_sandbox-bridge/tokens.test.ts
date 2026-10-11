// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import {
  estimateJsonTokens,
  estimateTokens,
  estimateTokensForCharLength,
} from "../../apps/sandbox-bridge/src/utils/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for 4 characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("rounds up for 5 characters", () => {
    expect(estimateTokens("12345")).toBe(2);
  });

  it("handles longer strings", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("rounds up partial tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3/4 = 0.75, ceil = 1
  });
});

describe("estimateJsonTokens", () => {
  it("estimates tokens for empty object", () => {
    // JSON.stringify({}) = "{}" = 2 chars, ceil(2/4) = 1
    expect(estimateJsonTokens({})).toBe(1);
  });

  it("estimates tokens for object with data", () => {
    const obj = { file_path: "/src/foo.ts", content: "hello world" };
    const json = JSON.stringify(obj);
    expect(estimateJsonTokens(obj)).toBe(Math.ceil(json.length / 4));
  });

  it("estimates tokens for array", () => {
    const arr = [1, 2, 3];
    const json = JSON.stringify(arr);
    expect(estimateJsonTokens(arr)).toBe(Math.ceil(json.length / 4));
  });
});

describe("estimateTokensForCharLength", () => {
  it("uses the same estimate as estimateTokens without allocating a string", () => {
    expect(estimateTokensForCharLength(101)).toBe(estimateTokens("a".repeat(101)));
  });
});
