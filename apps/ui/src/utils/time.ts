const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function parseTimestamp(value?: string | number | null): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatTimestamp(value?: string | number | null): string | null {
  const ts = parseTimestamp(value);
  if (ts == null) return null;

  return TIMESTAMP_FORMATTER.format(ts);
}

const TIMESTAMP_MINUTE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Like `formatTimestamp` but minute precision — for list/ledger surfaces where
 * seconds are noise. Transcript-style surfaces keep the seconds variant.
 */
export function formatTimestampMinutes(value?: string | number | null): string | null {
  const ts = parseTimestamp(value);
  if (ts == null) return null;

  return TIMESTAMP_MINUTE_FORMATTER.format(ts);
}
