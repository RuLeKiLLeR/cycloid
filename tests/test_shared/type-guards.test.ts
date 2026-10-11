import { describe, expect, it } from "vitest";

import { asNonEmptyString, isRecord } from "../../shared/utils/type-guards";

describe("isRecord", () => {
  it("accepts plain objects and rejects nullish or array values", () => {
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});

describe("asNonEmptyString", () => {
  it("trims non-empty strings", () => {
    expect(asNonEmptyString("  hello  ")).toBe("hello");
  });

  it("rejects blank and non-string values", () => {
    expect(asNonEmptyString("   ")).toBeUndefined();
    expect(asNonEmptyString(123)).toBeUndefined();
    expect(asNonEmptyString(null)).toBeUndefined();
  });
});
