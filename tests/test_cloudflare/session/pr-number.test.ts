import { describe, expect, it } from "vitest";

import { resolveAttachedPrNumber } from "../../../apps/control-plane-worker/src/session/pr-number";

describe("resolveAttachedPrNumber", () => {
  it("uses a valid stored PR number first", () => {
    expect(resolveAttachedPrNumber(6156, "https://github.com/trycycloid/cycloid/pull/1")).toBe(6156);
  });

  it("recovers the PR number from the attached PR URL when storage is missing", () => {
    expect(resolveAttachedPrNumber(null, "https://github.com/trycycloid/cycloid/pull/6156")).toBe(6156);
    expect(resolveAttachedPrNumber(0, "https://github.com/trycycloid/cycloid/pull/6156")).toBe(6156);
  });

  it("returns undefined for missing or invalid PR identity", () => {
    expect(resolveAttachedPrNumber(null, null)).toBeUndefined();
    expect(resolveAttachedPrNumber(null, "https://example.com/not-github")).toBeUndefined();
  });
});
