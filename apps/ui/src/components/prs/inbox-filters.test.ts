import { describe, expect, it } from "vitest";

import type { PrInboxBucket } from "../../api/pr-inbox";
import { parseCollapsedBuckets } from "./inbox-filters";

describe("parseCollapsedBuckets", () => {
  it("returns nothing collapsed for null input", () => {
    expect(parseCollapsedBuckets(null)).toEqual([]);
  });

  it("parses stored buckets and drops unknown names and non-strings", () => {
    const raw = JSON.stringify(["closed", "needs_review", "not_a_bucket", 42, null]);
    expect(parseCollapsedBuckets(raw)).toEqual<PrInboxBucket[]>(["closed", "needs_review"]);
  });

  it("falls back to nothing collapsed on corrupt JSON or non-arrays", () => {
    expect(parseCollapsedBuckets("{not json")).toEqual([]);
    expect(parseCollapsedBuckets(JSON.stringify({ closed: true }))).toEqual([]);
  });
});
