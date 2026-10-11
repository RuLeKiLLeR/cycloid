import { describe, expect, it } from "vitest";

import { paginateQuery } from "../../apps/control-plane-worker/src/routes/shared";

describe("paginateQuery", () => {
  it("normalizes absent or empty query parameters", () => {
    expect(paginateQuery(null, null)).toEqual({ cursor: null, limit: undefined });
    expect(paginateQuery("", "")).toEqual({ cursor: null, limit: undefined });
    expect(paginateQuery("   ", "not-a-number")).toEqual({ cursor: null, limit: undefined });
  });

  it("trims cursor and parses positive integer limits", () => {
    expect(paginateQuery("  cursor-1  ", "25")).toEqual({ cursor: "cursor-1", limit: 25 });
  });

  it("ignores zero and negative limits so callers keep their defaults", () => {
    expect(paginateQuery("cursor-1", "0")).toEqual({ cursor: "cursor-1", limit: undefined });
    expect(paginateQuery("cursor-1", "-5")).toEqual({ cursor: "cursor-1", limit: undefined });
  });

  it("floors decimal limits and caps them to maxLimit", () => {
    expect(paginateQuery(null, "12.9")).toEqual({ cursor: null, limit: 12 });
    expect(paginateQuery(null, "250")).toEqual({ cursor: null, limit: 100 });
    expect(paginateQuery(null, "250", 200)).toEqual({ cursor: null, limit: 200 });
  });

  it("uses the default cap when maxLimit is invalid", () => {
    expect(paginateQuery(null, "250", 0)).toEqual({ cursor: null, limit: 100 });
    expect(paginateQuery(null, "250", -1)).toEqual({ cursor: null, limit: 100 });
    expect(paginateQuery(null, "250", Number.NaN)).toEqual({ cursor: null, limit: 100 });
  });
});
