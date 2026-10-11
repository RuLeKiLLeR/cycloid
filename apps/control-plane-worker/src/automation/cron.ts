/**
 * Strict 5-field Unix cron parser used by scheduled-automation rules.
 *
 * Supports: numeric values, ranges (a-b), lists (a,b,c), step (slash-n)
 * and "*". Day-of-week is 0=Sun..6=Sat. Aliases `@hourly`,
 * `@daily`, `@weekly`, `@monthly`, `@yearly`/`@annually` and `@midnight`
 * are expanded. All times are UTC. Sub-5-minute cadence is rejected.
 */
import { AUTOMATION_MIN_CADENCE_MINUTES } from "../constants/automation";

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const FIELD_BOUNDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 6 },
] as const;

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export class CronValidationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Invalid cron expression: ${reason}`);
    this.name = "CronValidationError";
    this.reason = reason;
  }
}

export type ParsedCron = {
  /** Sorted unique values for each field, expressed in numeric form. */
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /** Canonical normalized string, suitable for duplicate detection. */
  normalized: string;
};

type CronDateFields = Pick<ParsedCron, "dayOfMonth" | "month" | "dayOfWeek">;
type ConsecutiveDatePair = {
  month: number;
  dayOfMonth: number;
  dayOfWeek: number;
  nextMonth: number;
  nextDayOfMonth: number;
  nextDayOfWeek: number;
};

const MAX_DAYS_BY_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const CONSECUTIVE_DATE_PAIRS = buildConsecutiveDatePairs();

function tokenizeAlias(name: string, index: number): number {
  const lower = name.toLowerCase();
  if (index === 3 && lower in MONTH_NAMES) return MONTH_NAMES[lower];
  if (index === 4 && lower in DOW_NAMES) return DOW_NAMES[lower];
  throw new CronValidationError(`unrecognized token "${name}"`);
}

function parseValue(raw: string, index: number, fieldName: string, min: number, max: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") throw new CronValidationError(`${fieldName} has an empty value`);
  let value: number;
  if (/^[a-zA-Z]+$/.test(trimmed)) {
    value = tokenizeAlias(trimmed, index);
  } else if (/^\d+$/.test(trimmed)) {
    value = Number(trimmed);
  } else {
    throw new CronValidationError(`${fieldName} value "${trimmed}" is not a number or known alias`);
  }
  if (value < min || value > max) {
    throw new CronValidationError(`${fieldName} value ${value} out of range [${min}, ${max}]`);
  }
  return value;
}

function expandField(raw: string, index: number): number[] {
  const { name: fieldName, min, max } = FIELD_BOUNDS[index];
  const values = new Set<number>();
  const parts = raw.split(",");
  for (const part of parts) {
    if (part.trim() === "") {
      throw new CronValidationError(`${fieldName} has an empty list element`);
    }
    let range = part;
    let step = 1;
    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      range = part.slice(0, slashIdx);
      const stepStr = part.slice(slashIdx + 1);
      if (!/^\d+$/.test(stepStr)) {
        throw new CronValidationError(`${fieldName} step "${stepStr}" must be a positive integer`);
      }
      step = Number(stepStr);
      if (step <= 0) {
        throw new CronValidationError(`${fieldName} step must be > 0`);
      }
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [loStr, hiStr] = range.split("-", 2);
      lo = parseValue(loStr, index, fieldName, min, max);
      hi = parseValue(hiStr, index, fieldName, min, max);
      if (lo > hi) {
        throw new CronValidationError(`${fieldName} range "${range}" is reversed`);
      }
    } else {
      const single = parseValue(range, index, fieldName, min, max);
      if (slashIdx === -1) {
        values.add(single);
        continue;
      }
      // `a/n` (no upper bound) -> a..max step n, matching common cron semantics.
      lo = single;
      hi = max;
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

function normalizeField(values: number[], index: number): string {
  const { min, max } = FIELD_BOUNDS[index];
  // If field covers the full domain, render as "*".
  if (values.length === max - min + 1) return "*";
  return values.join(",");
}

function isSundayAliased(field: number[]): number[] {
  // Some implementations accept 7 for Sunday; we don't accept 7 above, but
  // if a future caller hands us 7 we collapse to 0 here defensively.
  return field.map((v) => (v === 7 ? 0 : v)).sort((a, b) => a - b);
}

/**
 * Parse and validate a 5-field Unix cron expression. Throws
 * {@link CronValidationError} on any failure. Returns the parsed field sets
 * plus a canonical normalized string for duplicate detection.
 */
export function parseCronExpression(input: string): ParsedCron {
  if (typeof input !== "string") {
    throw new CronValidationError("expression must be a string");
  }
  const collapsed = input.trim().replace(/\s+/g, " ");
  if (collapsed === "") {
    throw new CronValidationError("expression is empty");
  }
  const expanded = collapsed.startsWith("@") ? (ALIASES[collapsed.toLowerCase()] ?? null) : collapsed;
  if (expanded === null) {
    throw new CronValidationError(`unknown alias "${collapsed}"`);
  }
  const fields = expanded.split(" ");
  if (fields.length !== 5) {
    throw new CronValidationError("expression must have exactly 5 fields (minute hour dom month dow)");
  }

  const minute = expandField(fields[0], 0);
  const hour = expandField(fields[1], 1);
  const dayOfMonth = expandField(fields[2], 2);
  const month = expandField(fields[3], 3);
  const dayOfWeek = isSundayAliased(expandField(fields[4], 4));

  enforceMinimumCadence(minute, hour, dayOfMonth, month, dayOfWeek);

  const normalized = [
    normalizeField(minute, 0),
    normalizeField(hour, 1),
    normalizeField(dayOfMonth, 2),
    normalizeField(month, 3),
    normalizeField(dayOfWeek, 4),
  ].join(" ");

  return { minute, hour, dayOfMonth, month, dayOfWeek, normalized };
}

function enforceMinimumCadence(
  minute: number[],
  hour: number[],
  dayOfMonth: number[],
  month: number[],
  dayOfWeek: number[],
): void {
  // The */5 sweep is the runtime ceiling on resolution. Anything that would
  // produce multiple fires within 5 minutes is rejected. We compute the
  // minimum gap between successive minute values within any single hour the
  // schedule fires; if that gap is < 5 minutes we reject.
  if (minute.length === 0) {
    throw new CronValidationError("minute field produced no values");
  }
  // Intra-hour minute density: e.g. `* * * * *` -> gap 1; `0,5,10...` -> gap 5.
  let minGap = Infinity;
  for (let i = 1; i < minute.length; i++) {
    minGap = Math.min(minGap, minute[i] - minute[i - 1]);
  }
  // Cross-hour wraparound: when two consecutive hours fire (including the
  // 23 -> 0 day-wrap when both hour 23 and hour 0 fire), the gap from
  // `:lastMinute` of one hour to `:firstMinute` of the next is
  // `60 - lastMinute + firstMinute`. Without this check, schedules like
  // `0,59 * * * *` slip through (intra gap 59, wraparound gap 1).
  if (hasConsecutiveHourPair(hour, { dayOfMonth, month, dayOfWeek })) {
    const firstMin = minute[0];
    const lastMin = minute[minute.length - 1];
    const wrapGap = 60 - lastMin + firstMin;
    minGap = Math.min(minGap, wrapGap);
  }
  if (minGap < AUTOMATION_MIN_CADENCE_MINUTES) {
    throw new CronValidationError(
      `cadence must be at least ${AUTOMATION_MIN_CADENCE_MINUTES} minutes (effective gap ${minGap} minute${minGap === 1 ? "" : "s"})`,
    );
  }
}

function hasConsecutiveHourPair(hour: number[], dateFields: CronDateFields): boolean {
  if (hour.length < 2) return false;
  for (let i = 1; i < hour.length; i++) {
    if (hour[i] - hour[i - 1] === 1) return true;
  }
  // Day-wrap: 23:xx -> 00:yy of the next day.
  if (hour[0] === 0 && hour[hour.length - 1] === 23) {
    return hasConsecutiveEligibleDatePair(dateFields);
  }
  return false;
}

function hasConsecutiveEligibleDatePair(dateFields: CronDateFields): boolean {
  for (const pair of CONSECUTIVE_DATE_PAIRS) {
    if (!dateFields.month.includes(pair.month) || !dateFields.month.includes(pair.nextMonth)) continue;
    if (
      cronDayMatches(dateFields, pair.dayOfMonth, pair.dayOfWeek) &&
      cronDayMatches(dateFields, pair.nextDayOfMonth, pair.nextDayOfWeek)
    ) {
      return true;
    }
  }
  return false;
}

function buildConsecutiveDatePairs(): ConsecutiveDatePair[] {
  const pairs: ConsecutiveDatePair[] = [];
  const seen = new Set<string>();
  for (let month = 1; month <= 12; month++) {
    for (let dayOfMonth = 1; dayOfMonth <= MAX_DAYS_BY_MONTH[month - 1]; dayOfMonth++) {
      for (const nextDate of possibleNextDates(month, dayOfMonth)) {
        for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
          const pair = {
            month,
            dayOfMonth,
            dayOfWeek,
            nextMonth: nextDate.month,
            nextDayOfMonth: nextDate.dayOfMonth,
            nextDayOfWeek: (dayOfWeek + 1) % 7,
          };
          const key = [
            pair.month,
            pair.dayOfMonth,
            pair.dayOfWeek,
            pair.nextMonth,
            pair.nextDayOfMonth,
            pair.nextDayOfWeek,
          ].join(":");
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push(pair);
          }
        }
      }
    }
  }
  return pairs;
}

function possibleNextDates(month: number, dayOfMonth: number): Array<{ month: number; dayOfMonth: number }> {
  if (month === 2 && dayOfMonth === 28) {
    return [
      { month: 2, dayOfMonth: 29 },
      { month: 3, dayOfMonth: 1 },
    ];
  }
  const maxDay = MAX_DAYS_BY_MONTH[month - 1];
  if (dayOfMonth < maxDay) return [{ month, dayOfMonth: dayOfMonth + 1 }];
  return [{ month: month === 12 ? 1 : month + 1, dayOfMonth: 1 }];
}

/**
 * Compute the next fire time at or after `afterMs` for a parsed cron.
 * All times UTC. Returns Unix-ms.
 *
 * The scheduler advances `next_fire_at` after each successful CAS claim, so
 * this function only needs to find the *next* matching minute boundary. We
 * iterate minute by minute up to a safety cap (4 years; cron can have
 * Feb-29-on-Sunday style schedules that legitimately wait years).
 */
export function computeNextFireAt(parsed: ParsedCron, afterMs: number): number {
  const MAX_ITERATIONS = 4 * 366 * 24 * 60; // ~4 years of minutes
  // Round up to the next whole minute.
  const startMs = Math.ceil(afterMs / 60_000) * 60_000;
  let candidate = startMs;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const d = new Date(candidate);
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    if (parsed.minute.includes(minute) && parsed.hour.includes(hour) && cronDateMatches(parsed, d)) {
      return candidate;
    }
    candidate += 60_000;
  }
  throw new CronValidationError("could not find a next fire time within 4 years");
}

function cronDateMatches(parsed: CronDateFields, date: Date): boolean {
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();
  return parsed.month.includes(month) && cronDayMatches(parsed, dom, dow);
}

function cronDayMatches(parsed: CronDateFields, dom: number, dow: number): boolean {
  // Standard Vixie cron semantics: if both day-of-month and day-of-week are
  // restricted (i.e. not full domain), fire when either matches. Otherwise
  // both must match (which is the same as the active one matching).
  const domIsRestricted = parsed.dayOfMonth.length !== 31;
  const dowIsRestricted = parsed.dayOfWeek.length !== 7;
  const domMatches = parsed.dayOfMonth.includes(dom);
  const dowMatches = parsed.dayOfWeek.includes(dow);
  if (domIsRestricted && dowIsRestricted) return domMatches || dowMatches;
  return domMatches && dowMatches;
}
