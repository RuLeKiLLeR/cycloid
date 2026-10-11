import { describe, expect, it } from "vitest";

import { shouldFetchPromptEvents } from "../../apps/ui/src/utils/transcript.js";

const historyEntry = { type: "text", data: { id: "t1", text: "hello" } };

describe("shouldFetchPromptEvents", () => {
  it("returns false when embedded history is a non-empty array", () => {
    expect(shouldFetchPromptEvents([historyEntry])).toBe(false);
  });

  it("returns true when embedded history is absent", () => {
    expect(shouldFetchPromptEvents(undefined)).toBe(true);
    expect(shouldFetchPromptEvents([])).toBe(true);
  });

  it("treats malformed history as missing", () => {
    expect(shouldFetchPromptEvents(null as unknown as undefined)).toBe(true);
    expect(shouldFetchPromptEvents("bad" as unknown as undefined)).toBe(true);
    expect(shouldFetchPromptEvents({} as unknown as undefined)).toBe(true);
  });
});
