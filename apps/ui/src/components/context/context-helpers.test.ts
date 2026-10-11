import { describe, expect, it } from "vitest";

import { mcpValidationTone, splitRepoFullName, transportLabel } from "./context-helpers";

describe("mcpValidationTone", () => {
  it("maps known statuses to semantic tones", () => {
    // Two hues only: live (violet) for actively-validating, error for failed;
    // valid and untested read grayscale.
    expect(mcpValidationTone("valid")).toBe("default");
    expect(mcpValidationTone("invalid")).toBe("error");
    expect(mcpValidationTone("validating")).toBe("accent");
    expect(mcpValidationTone("untested")).toBe("default");
  });

  it("falls back to default for unknown statuses", () => {
    expect(mcpValidationTone("something-else")).toBe("default");
  });
});

describe("transportLabel", () => {
  it("uppercases acronyms and preserves stdio", () => {
    expect(transportLabel("http")).toBe("HTTP");
    expect(transportLabel("sse")).toBe("SSE");
    expect(transportLabel("stdio")).toBe("stdio");
  });

  it("returns unknown transports unchanged", () => {
    expect(transportLabel("ws")).toBe("ws");
  });
});

describe("splitRepoFullName", () => {
  it("splits a valid owner/name", () => {
    expect(splitRepoFullName("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
  });

  it("keeps the remainder of names containing slashes", () => {
    expect(splitRepoFullName("acme/nested/widget")).toEqual({ owner: "acme", name: "nested/widget" });
  });

  it("returns null for malformed values", () => {
    expect(splitRepoFullName("noslash")).toBeNull();
    expect(splitRepoFullName("/leading")).toBeNull();
    expect(splitRepoFullName("trailing/")).toBeNull();
  });
});
