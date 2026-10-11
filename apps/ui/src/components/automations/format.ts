// Presentation-only formatters for the Automations surface. `humanizeCron` is
// the read-side inverse of `buildCronFromPreset` (constants/scheduleCron.ts): it
// turns the crons this app writes back into human labels for installed rows.
// Anything it does not recognize falls back to the raw expression so a
// hand-written custom cron is still shown verbatim rather than mislabeled.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CRON_ALIAS_LABELS: Record<string, string> = {
  "@hourly": "Every hour",
  "@daily": "Every day",
  "@midnight": "Every day",
  "@weekly": "Every week",
  "@monthly": "Every month",
  "@yearly": "Every year",
  "@annually": "Every year",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toBoundedInt(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  const mod10 = day % 10;
  if (mod10 === 1) return `${day}st`;
  if (mod10 === 2) return `${day}nd`;
  if (mod10 === 3) return `${day}rd`;
  return `${day}th`;
}

/**
 * Human label for a 5-field cron or supported alias. Falls back to the trimmed
 * raw expression for anything outside the presets this app emits so a custom
 * cron is never silently mislabeled.
 */
export function humanizeCron(cron: string): string {
  const trimmed = cron.trim();
  if (!trimmed) return "—";

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("@")) return CRON_ALIAS_LABELS[lower] ?? trimmed;

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return trimmed;
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = fields;

  if (minuteRaw === "0" && hourRaw === "*" && dayRaw === "*" && monthRaw === "*" && weekdayRaw === "*") {
    return "Every hour";
  }

  const minute = toBoundedInt(minuteRaw, 0, 59);
  const hour = toBoundedInt(hourRaw, 0, 23);
  if (minute == null || hour == null) return trimmed;
  const time = `${pad2(hour)}:${pad2(minute)} UTC`;

  // Specific month → a yearly cron (e.g. "0 9 1 1 *" → Yearly on Jan 1).
  if (monthRaw !== "*") {
    const month = toBoundedInt(monthRaw, 1, 12);
    const monthDay = toBoundedInt(dayRaw, 1, 31);
    if (month != null && monthDay != null && weekdayRaw === "*") {
      return `Yearly on ${MONTH_NAMES[month - 1]} ${monthDay} at ${time}`;
    }
    return trimmed;
  }

  if (dayRaw === "*" && weekdayRaw === "*") return `Daily at ${time}`;
  if (dayRaw === "*" && weekdayRaw === "1-5") return `Weekdays at ${time}`;
  if (dayRaw === "*" && /^[0-7]$/.test(weekdayRaw)) {
    const index = Number(weekdayRaw) === 7 ? 0 : Number(weekdayRaw);
    return `${DAY_NAMES[index]}s at ${time}`;
  }
  if (weekdayRaw === "*") {
    const monthDay = toBoundedInt(dayRaw, 1, 31);
    if (monthDay != null) return `Monthly on the ${ordinal(monthDay)} at ${time}`;
  }

  return trimmed;
}

/** Short UTC timestamp for `nextFireAt` / `lastDeliveredAt`; `—` when absent. */
export function formatUtcTimestamp(ms: number | null): string {
  // Strict null-check: `!ms` would also swallow epoch 0.
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
