import { describe, expect, it } from "vitest";

import {
  buildSessionsFetchOptions,
  filterLoadedSessions,
  parseSessionsFilters,
  type SessionsFilters,
} from "../../apps/ui/src/pages/sessions-page";
import type { SessionMetadata } from "../../apps/ui/src/types";
import { displayStatusFromPhase } from "../../shared/session/display-status";

function session(overrides: Partial<SessionMetadata>): SessionMetadata {
  const phase = overrides.phase ?? "running";
  return {
    sessionId: overrides.sessionId ?? "session",
    phase,
    // Required on SessionMetadata; the API layer derives it server-side, so the
    // fixture mirrors that derivation from the phase.
    displayStatus: displayStatusFromPhase(phase),
    closeReason: null,
    prUrl: overrides.prUrl ?? null,
    createdAt: overrides.createdAt ?? 0,
    model: null,
    title: overrides.title ?? null,
    ...overrides,
  };
}

const FILTERS: SessionsFilters = {
  scope: "personal",
  status: "all",
  archive: "current",
  repo: "",
  query: "",
};

describe("Sessions page filters", () => {
  it("parses valid URL filters and falls back for invalid values", () => {
    expect(
      parseSessionsFilters(
        new URLSearchParams("scope=business&status=attention&archive=archived&repo=acme/widgets&q=fix"),
      ),
    ).toEqual({
      scope: "business",
      status: "attention",
      archive: "archived",
      repo: "acme/widgets",
      query: "fix",
    });
    expect(parseSessionsFilters(new URLSearchParams("scope=other&status=unknown"))).toEqual(FILTERS);
  });

  it("uses the existing API filters for scope, archive, search, and pagination", () => {
    expect(
      buildSessionsFetchOptions(
        { ...FILTERS, scope: "business", archive: "archived", repo: "acme/widgets" },
        "next-page",
      ),
    ).toEqual({
      scope: "business",
      cursor: "next-page",
      status: "archived",
      query: "acme/widgets",
    });
    expect(buildSessionsFetchOptions({ ...FILTERS, repo: "acme/widgets", query: "broken build" }, null).query).toBe(
      "broken build",
    );
  });

  it("applies exact repo, dashboard status, and archive filters to loaded pages", () => {
    const sessions = [
      session({ sessionId: "failed", phase: "failed", repoOwner: "acme", repoName: "widgets" }),
      session({ sessionId: "running", phase: "running", repoOwner: "acme", repoName: "widgets" }),
      session({ sessionId: "other", phase: "failed", repoOwner: "acme", repoName: "other" }),
      session({ sessionId: "archived", phase: "archived", repoOwner: "acme", repoName: "widgets" }),
    ];

    expect(
      filterLoadedSessions(sessions, { ...FILTERS, status: "attention", repo: "ACME/WIDGETS" }).map(
        (item) => item.sessionId,
      ),
    ).toEqual(["failed"]);
    expect(filterLoadedSessions(sessions, { ...FILTERS, archive: "archived" }).map((item) => item.sessionId)).toEqual([
      "archived",
    ]);
  });

  it("treats an FSM-archived row as archived even when its legacy phase lags", () => {
    // FSM says ARCHIVED but the legacy phase mirror still reads a live/terminal
    // value: the row must be hidden from the current view and surface in the
    // archived view, consistent with the dashboard's drop guard.
    const sessions = [
      session({ sessionId: "fsm-archived", phase: "completed", fsmState: "ARCHIVED" }),
      session({ sessionId: "live", phase: "running", fsmState: "REVIEW" }),
    ];

    expect(filterLoadedSessions(sessions, { ...FILTERS }).map((item) => item.sessionId)).toEqual(["live"]);
    expect(filterLoadedSessions(sessions, { ...FILTERS, archive: "archived" }).map((item) => item.sessionId)).toEqual([
      "fsm-archived",
    ]);
  });
});
