import { describe, expect, it } from "vitest";

import type { SessionMetadata } from "../../apps/ui/src/types";
import { compactTimeAgo, groupSessionsByRecency } from "../../apps/ui/src/utils/session-grouping";
import { displayStatusFromPhase } from "../../shared/session/display-status";

const NOW = new Date("2026-05-13T15:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeSession(overrides: Partial<SessionMetadata> & { sessionId: string; createdAt: number }): SessionMetadata {
  const phase = overrides.phase ?? "idle";
  return {
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    model: null,
    title: null,
    ...overrides,
  };
}

describe("groupSessionsByRecency", () => {
  it("buckets sessions into Today / Yesterday / This week / Earlier", () => {
    const sessions: SessionMetadata[] = [
      makeSession({ sessionId: "today", createdAt: NOW.getTime() - 2 * HOUR }),
      makeSession({ sessionId: "yesterday", createdAt: NOW.getTime() - 30 * HOUR }),
      makeSession({ sessionId: "this-week", createdAt: NOW.getTime() - 4 * DAY }),
      makeSession({ sessionId: "earlier", createdAt: NOW.getTime() - 30 * DAY }),
    ];

    const groups = groupSessionsByRecency(sessions, NOW);

    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday", "this_week", "earlier"]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["today"]);
    expect(groups[1].sessions.map((s) => s.sessionId)).toEqual(["yesterday"]);
    expect(groups[2].sessions.map((s) => s.sessionId)).toEqual(["this-week"]);
    expect(groups[3].sessions.map((s) => s.sessionId)).toEqual(["earlier"]);
  });

  it("drops empty buckets and preserves input order within each bucket", () => {
    const sessions: SessionMetadata[] = [
      makeSession({ sessionId: "a", createdAt: NOW.getTime() - HOUR }),
      makeSession({ sessionId: "b", createdAt: NOW.getTime() - 2 * HOUR }),
      makeSession({ sessionId: "c", createdAt: NOW.getTime() - 30 * HOUR }),
    ];

    const groups = groupSessionsByRecency(sessions, NOW);

    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday"]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("falls back to the Undated bucket when createdAt is missing or invalid", () => {
    const groups = groupSessionsByRecency([makeSession({ sessionId: "no-date", createdAt: 0 })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("no_date");
  });

  it("normalizes ISO-string createdAt values that arrive from /api/sessions", () => {
    // The control plane's toSessionApiShape ships row.created_at directly as
    // an ISO string even though SessionMetadata.createdAt is typed as number.
    // Without normalization this would crash Intl.DateTimeFormat downstream.
    const todayIso = new Date(NOW.getTime() - HOUR).toISOString();
    const yesterdayIso = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    const groups = groupSessionsByRecency(
      [
        makeSession({ sessionId: "today-iso", createdAt: todayIso as unknown as number }),
        makeSession({ sessionId: "yesterday-iso", createdAt: yesterdayIso as unknown as number }),
        makeSession({ sessionId: "garbage", createdAt: "not-a-date" as unknown as number }),
        makeSession({ sessionId: "nan", createdAt: Number.NaN }),
      ],
      NOW,
    );
    const idsByGroup = Object.fromEntries(groups.map((g) => [g.key, g.sessions.map((s) => s.sessionId)]));
    expect(idsByGroup.today).toEqual(["today-iso"]);
    expect(idsByGroup.yesterday).toEqual(["yesterday-iso"]);
    expect(idsByGroup.no_date).toEqual(["garbage", "nan"]);
  });
});

describe("compactTimeAgo", () => {
  it("renders minutes / hours / weekday / month-day for increasing distances", () => {
    expect(compactTimeAgo(NOW.getTime() - 30 * 1000, NOW)).toBe("now");
    expect(compactTimeAgo(NOW.getTime() - 5 * 60_000, NOW)).toBe("5m");
    expect(compactTimeAgo(NOW.getTime() - 3 * HOUR, NOW)).toBe("3h");
    // 30 hours ago — within a week. Just assert it's the locale weekday (3 chars).
    const weekday = compactTimeAgo(NOW.getTime() - 30 * HOUR, NOW);
    expect(weekday).toMatch(/^[A-Za-z]{3}$/);
    // 20 days ago — should switch to month/day formatting.
    const monthDay = compactTimeAgo(NOW.getTime() - 20 * DAY, NOW);
    expect(monthDay).toMatch(/\d/);
  });

  it("returns empty string for non-positive timestamps", () => {
    expect(compactTimeAgo(0, NOW)).toBe("");
    expect(compactTimeAgo(-1, NOW)).toBe("");
  });

  it("accepts ISO-string timestamps without crashing Intl.DateTimeFormat", () => {
    // Regression: server returns createdAt as ISO string via toSessionApiShape;
    // passing it straight through used to throw "Invalid time value".
    expect(compactTimeAgo(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe("5m");
    expect(compactTimeAgo(new Date(NOW.getTime() - 3 * HOUR).toISOString(), NOW)).toBe("3h");
  });

  it("returns empty string for null, undefined, NaN, and unparseable strings", () => {
    expect(compactTimeAgo(null, NOW)).toBe("");
    expect(compactTimeAgo(undefined, NOW)).toBe("");
    expect(compactTimeAgo(Number.NaN, NOW)).toBe("");
    expect(compactTimeAgo("not-a-date", NOW)).toBe("");
  });
});
