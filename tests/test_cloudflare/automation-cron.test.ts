// Unit tests for the 5-field Unix cron parser used by scheduled automation.
import { describe, expect, it } from "vitest";

import {
  computeNextFireAt,
  CronValidationError,
  parseCronExpression,
} from "../../apps/control-plane-worker/src/automation/cron";

describe("parseCronExpression", () => {
  it("parses every-five-minutes", () => {
    const parsed = parseCronExpression("*/5 * * * *");
    expect(parsed.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parsed.normalized).toBe("0,5,10,15,20,25,30,35,40,45,50,55 * * * *");
  });

  it("parses weekday 14:00 UTC", () => {
    const parsed = parseCronExpression("0 14 * * 1-5");
    expect(parsed.hour).toEqual([14]);
    expect(parsed.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.normalized).toBe("0 14 * * 1,2,3,4,5");
  });

  it("expands @daily alias", () => {
    const parsed = parseCronExpression("@daily");
    expect(parsed.normalized).toBe("0 0 * * *");
  });

  it("collapses whitespace", () => {
    const parsed = parseCronExpression("  0   14  *  *   1-5  ");
    expect(parsed.normalized).toBe("0 14 * * 1,2,3,4,5");
  });

  it("accepts named months and days of week", () => {
    const parsed = parseCronExpression("0 9 * jan-mar mon");
    expect(parsed.month).toEqual([1, 2, 3]);
    expect(parsed.dayOfWeek).toEqual([1]);
  });

  it("rejects sub-5-minute cadence", () => {
    expect(() => parseCronExpression("* * * * *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("*/1 * * * *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("*/4 * * * *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("0,1 * * * *")).toThrow(CronValidationError);
  });

  it("allows every-5-minutes (exact boundary)", () => {
    expect(() => parseCronExpression("*/5 * * * *")).not.toThrow();
  });

  it("rejects cross-hour wraparound that fires under 5 minutes apart", () => {
    // `0,59 * * * *` fires at :59 then :00 one minute later.
    expect(() => parseCronExpression("0,59 * * * *")).toThrow(CronValidationError);
    // `0,56 * * * *` -> 4-minute wrap (:56 -> next :00).
    expect(() => parseCronExpression("0,56 * * * *")).toThrow(CronValidationError);
    // Same minute pattern but only one hour: no consecutive-hour pair, 23h gap, allowed.
    expect(() => parseCronExpression("0,56 14 * * *")).not.toThrow();
  });

  it("rejects 23->0 day-wrap when both fire and the wrap gap is too small", () => {
    // 23:59 -> 00:00 next day is 1 minute apart.
    expect(() => parseCronExpression("0,59 0,23 * * *")).toThrow(CronValidationError);
  });

  it("allows 23->0 hour pair when day-of-month prevents day-wrap firing", () => {
    // Only the first of each month fires, so 23:59 is not followed by 00:00 the next day.
    expect(() => parseCronExpression("0,59 0,23 1 * *")).not.toThrow();
  });

  it("allows 23->0 hour pair when day-of-week prevents day-wrap firing", () => {
    // Only Mondays fire, so 23:59 is not followed by 00:00 the next day.
    expect(() => parseCronExpression("0,59 0,23 * * 1")).not.toThrow();
  });

  it("rejects 23->0 day-wrap when restricted day fields still allow consecutive dates", () => {
    // Standard cron OR semantics for restricted DOM and DOW can make adjacent dates eligible.
    expect(() => parseCronExpression("0,59 0,23 1 * 1")).toThrow(CronValidationError);
  });

  it("allows two non-consecutive hours regardless of minute positions", () => {
    // 00:59 -> 12:00 has 11h+1min gap; no consecutive-hour pair.
    expect(() => parseCronExpression("0,59 0,12 * * *")).not.toThrow();
  });

  it("rejects 6-field expressions", () => {
    expect(() => parseCronExpression("0 0 * * * *")).toThrow(CronValidationError);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("0 24 * * *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("0 0 32 * *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("0 0 * 13 *")).toThrow(CronValidationError);
    expect(() => parseCronExpression("0 0 * * 8")).toThrow(CronValidationError);
  });

  it("rejects reversed ranges", () => {
    expect(() => parseCronExpression("0 0 * * 5-1")).toThrow(CronValidationError);
  });

  it("rejects unknown alias", () => {
    expect(() => parseCronExpression("@every-tuesday")).toThrow(CronValidationError);
  });

  it("rejects empty input", () => {
    expect(() => parseCronExpression("")).toThrow(CronValidationError);
    expect(() => parseCronExpression("   ")).toThrow(CronValidationError);
  });

  it("normalizes equivalent expressions identically", () => {
    expect(parseCronExpression("0 14 * * 1-5").normalized).toBe(parseCronExpression("0 14 * * mon-fri").normalized);
    expect(parseCronExpression("*/15 * * * *").normalized).toBe(parseCronExpression("0,15,30,45 * * * *").normalized);
  });
});

describe("computeNextFireAt", () => {
  it("computes the next weekday 14:00 UTC firing", () => {
    const parsed = parseCronExpression("0 14 * * 1-5");
    // Wednesday 2026-01-07 12:00:00 UTC -> next should be same day 14:00.
    const after = Date.UTC(2026, 0, 7, 12, 0, 0);
    const next = computeNextFireAt(parsed, after);
    expect(next).toBe(Date.UTC(2026, 0, 7, 14, 0, 0));
  });

  it("skips weekends for weekday cron", () => {
    const parsed = parseCronExpression("0 14 * * 1-5");
    // Saturday 2026-01-10 12:00:00 UTC -> next is Monday 2026-01-12 14:00.
    const after = Date.UTC(2026, 0, 10, 12, 0, 0);
    const next = computeNextFireAt(parsed, after);
    expect(next).toBe(Date.UTC(2026, 0, 12, 14, 0, 0));
  });

  it("rounds up partial-minute now to the next minute boundary", () => {
    const parsed = parseCronExpression("*/5 * * * *");
    const after = Date.UTC(2026, 0, 7, 12, 1, 30); // 12:01:30
    const next = computeNextFireAt(parsed, after);
    expect(next).toBe(Date.UTC(2026, 0, 7, 12, 5, 0));
  });
});
