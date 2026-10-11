import { describe, expect, it } from "vitest";

import { formatTimestamp, formatTimestampMinutes, parseTimestamp } from "../../apps/ui/src/utils/time";

describe("ui time utils", () => {
  it("parses ISO timestamps", () => {
    expect(parseTimestamp("2026-03-31T18:36:00.000Z")).toBe(Date.parse("2026-03-31T18:36:00.000Z"));
  });

  it("parses millisecond timestamp strings", () => {
    expect(parseTimestamp("1775679366348")).toBe(1775679366348);
  });

  it("formats millisecond timestamp strings as readable dates", () => {
    expect(formatTimestamp("1775679366348")).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(1775679366348),
    );
  });

  it("formats minute-precision timestamps without seconds", () => {
    expect(formatTimestampMinutes("1775679366348")).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(1775679366348),
    );
  });

  it("returns null for invalid timestamps", () => {
    expect(parseTimestamp("not-a-date")).toBeNull();
    expect(formatTimestamp("not-a-date")).toBeNull();
    expect(formatTimestampMinutes("not-a-date")).toBeNull();
  });
});
