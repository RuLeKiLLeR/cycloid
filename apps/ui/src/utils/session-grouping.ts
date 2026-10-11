import type { SessionMetadata } from "../types";
import { parseTimestamp } from "./time";

type SessionGroupKey = "today" | "yesterday" | "this_week" | "earlier" | "no_date";

export type SessionGroup = {
  key: SessionGroupKey;
  label: string;
  sessions: SessionMetadata[];
};

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const GROUP_ORDER: SessionGroupKey[] = ["today", "yesterday", "this_week", "earlier", "no_date"];
const GROUP_LABEL: Record<SessionGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  earlier: "Earlier",
  no_date: "Undated",
};

/**
 * Bucket sessions into recency groups for the sidebar headers. Preserves the
 * input order within each bucket so the caller's `orderSessionsForSidebar`
 * sort (most-recent first, with children grouped near parents) is retained.
 * Empty buckets are dropped.
 *
 * `now` is parameterized for deterministic tests.
 *
 * `createdAt` is typed as `number` in `SessionMetadata`, but the
 * `/api/sessions` payload ships ISO date strings via `toSessionApiShape`.
 * `parseTimestamp` normalizes both shapes plus `null`/`NaN`/`undefined`;
 * anything that can't be parsed falls into the `no_date` bucket so a single
 * malformed row never crashes the sidebar.
 */
export function groupSessionsByRecency(sessions: SessionMetadata[], now: Date = new Date()): SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfThisWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const buckets: Record<SessionGroupKey, SessionMetadata[]> = {
    today: [],
    yesterday: [],
    this_week: [],
    earlier: [],
    no_date: [],
  };

  for (const session of sessions) {
    const createdAt = parseTimestamp(session.createdAt as number | string | null | undefined);
    if (createdAt === null || createdAt <= 0) {
      buckets.no_date.push(session);
      continue;
    }
    if (createdAt >= startOfToday) buckets.today.push(session);
    else if (createdAt >= startOfYesterday) buckets.yesterday.push(session);
    else if (createdAt >= startOfThisWeek) buckets.this_week.push(session);
    else buckets.earlier.push(session);
  }

  const result: SessionGroup[] = [];
  for (const key of GROUP_ORDER) {
    if (buckets[key].length > 0) {
      result.push({ key, label: GROUP_LABEL[key], sessions: buckets[key] });
    }
  }
  return result;
}

/**
 * Compact relative timestamp for sidebar cards. Tighter than `timeAgo` so the
 * mono-tabular submeta row stays scannable: "2m", "3h", "Mon", "Apr 14".
 *
 * Accepts a number, ISO string, or nullish; returns "" for any value that
 * can't be normalized to a finite ms timestamp. `Intl.DateTimeFormat.format`
 * throws "Invalid time value" on non-finite inputs, so the guard is required
 * — `createdAt` flows in from the API as a string in production.
 */
export function compactTimeAgo(ts: number | string | null | undefined, now: Date = new Date()): string {
  const normalized = parseTimestamp(ts);
  if (normalized === null || normalized <= 0) return "";
  const diffMs = now.getTime() - normalized;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return WEEKDAY_FORMATTER.format(normalized);
  }
  return MONTH_DAY_FORMATTER.format(normalized);
}
