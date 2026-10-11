import { describe, expect, it } from "vitest";

import { buildCronFromPreset } from "../../constants/scheduleCron";
import { humanizeCron } from "./format";

describe("humanizeCron", () => {
  it("labels the hourly preset", () => {
    expect(humanizeCron(buildCronFromPreset("hourly", 0, 0))).toBe("Every hour");
  });

  it("labels daily with padded UTC time", () => {
    expect(humanizeCron(buildCronFromPreset("daily", 9, 5))).toBe("Daily at 09:05 UTC");
  });

  it("labels the weekday preset", () => {
    expect(humanizeCron(buildCronFromPreset("weekday", 14, 30))).toBe("Weekdays at 14:30 UTC");
  });

  it("labels each weekly preset by day name", () => {
    expect(humanizeCron(buildCronFromPreset("weekly-1", 9, 0))).toBe("Mondays at 09:00 UTC");
    expect(humanizeCron(buildCronFromPreset("weekly-5", 9, 0))).toBe("Fridays at 09:00 UTC");
    expect(humanizeCron(buildCronFromPreset("weekly-0", 9, 0))).toBe("Sundays at 09:00 UTC");
  });

  it("treats cron weekday 7 as Sunday", () => {
    expect(humanizeCron("0 9 * * 7")).toBe("Sundays at 09:00 UTC");
  });

  it("labels the monthly preset", () => {
    expect(humanizeCron(buildCronFromPreset("monthly", 6, 15))).toBe("Monthly on the 1st at 06:15 UTC");
  });

  it("labels other days of the month with ordinals", () => {
    expect(humanizeCron("0 9 15 * *")).toBe("Monthly on the 15th at 09:00 UTC");
    expect(humanizeCron("30 6 2 * *")).toBe("Monthly on the 2nd at 06:30 UTC");
    expect(humanizeCron("0 9 23 * *")).toBe("Monthly on the 23rd at 09:00 UTC");
    expect(humanizeCron("0 9 11 * *")).toBe("Monthly on the 11th at 09:00 UTC");
    expect(humanizeCron("0 9 31 * *")).toBe("Monthly on the 31st at 09:00 UTC");
  });

  it("labels a specific month and day as yearly", () => {
    expect(humanizeCron("0 9 1 1 *")).toBe("Yearly on Jan 1 at 09:00 UTC");
    expect(humanizeCron("15 6 25 12 *")).toBe("Yearly on Dec 25 at 06:15 UTC");
  });

  it("resolves supported aliases", () => {
    expect(humanizeCron("@daily")).toBe("Every day");
    expect(humanizeCron("@weekly")).toBe("Every week");
  });

  it("falls back to the raw expression for unrecognized crons", () => {
    expect(humanizeCron("*/5 * * * *")).toBe("*/5 * * * *");
    // Specific month + weekday constraint is outside the recognized shapes.
    expect(humanizeCron("0 9 15 6 1")).toBe("0 9 15 6 1");
    expect(humanizeCron("@reboot")).toBe("@reboot");
  });

  it("returns an em dash for empty input", () => {
    expect(humanizeCron("")).toBe("—");
    expect(humanizeCron("   ")).toBe("—");
  });
});
