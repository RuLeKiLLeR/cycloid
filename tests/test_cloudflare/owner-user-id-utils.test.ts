import { describe, expect, it } from "vitest";

import { parsePositiveIntegerUserId } from "../../apps/control-plane-worker/src/utils";

describe("parsePositiveIntegerUserId", () => {
  it("accepts positive integer strings and numbers", () => {
    expect(parsePositiveIntegerUserId("42")).toBe(42);
    expect(parsePositiveIntegerUserId(" 42 ")).toBe(42);
    expect(parsePositiveIntegerUserId(42)).toBe(42);
  });

  it("rejects non-numeric, non-positive, and unsafe values", () => {
    expect(parsePositiveIntegerUserId("slack:UNOTLINKED")).toBeNull();
    expect(parsePositiveIntegerUserId("0")).toBeNull();
    expect(parsePositiveIntegerUserId("-1")).toBeNull();
    expect(parsePositiveIntegerUserId("1.5")).toBeNull();
    expect(parsePositiveIntegerUserId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
