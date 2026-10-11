import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  type Environment,
  isEnvironment,
  normalizeEnvironment,
} from "../../shared/constants/environment.js";

describe("isEnvironment", () => {
  it("accepts every known environment", () => {
    for (const value of Object.values(ENVIRONMENT)) {
      expect(isEnvironment(value)).toBe(true);
    }
  });

  it("rejects unknown values, typos, undefined, and empty string", () => {
    expect(isEnvironment("propduction")).toBe(false);
    expect(isEnvironment("staging")).toBe(false);
    expect(isEnvironment("")).toBe(false);
    expect(isEnvironment(undefined)).toBe(false);
  });
});

describe("normalizeEnvironment", () => {
  it("passes through every known environment regardless of fallback", () => {
    for (const value of Object.values(ENVIRONMENT)) {
      expect(normalizeEnvironment(value, ENVIRONMENT.Production)).toBe(value);
    }
  });

  it("returns the provided fallback for unknown or unset values", () => {
    expect(normalizeEnvironment(undefined, ENVIRONMENT.Production)).toBe(ENVIRONMENT.Production);
    expect(normalizeEnvironment("", ENVIRONMENT.Production)).toBe(ENVIRONMENT.Production);
    expect(normalizeEnvironment("propduction", ENVIRONMENT.Production)).toBe(ENVIRONMENT.Production);
  });

  it("honors a non-production fallback (UI surface default)", () => {
    expect(normalizeEnvironment(undefined, ENVIRONMENT.Development)).toBe(ENVIRONMENT.Development);
    expect(normalizeEnvironment("nope", ENVIRONMENT.Development)).toBe(ENVIRONMENT.Development);
  });

  it("preserves a known value distinct from the fallback", () => {
    const result: Environment = normalizeEnvironment("qa", ENVIRONMENT.Production);
    expect(result).toBe(ENVIRONMENT.Qa);
  });
});
