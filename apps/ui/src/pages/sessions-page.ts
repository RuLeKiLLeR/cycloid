import type { FetchSessionsOptions } from "../api/sessions";
import { bucketSession, type DashboardBucket } from "../components/home/session-dashboard";
import type { SessionMetadata } from "../types";

export type SessionsScopeFilter = "personal" | "business";
export type SessionsStatusFilter = "all" | DashboardBucket;
export type SessionsArchiveFilter = "current" | "archived";

export type SessionsFilters = {
  scope: SessionsScopeFilter;
  status: SessionsStatusFilter;
  archive: SessionsArchiveFilter;
  repo: string;
  query: string;
};

const STATUS_FILTERS = new Set<SessionsStatusFilter>(["all", "attention", "running", "completed"]);

export function parseSessionsFilters(params: URLSearchParams): SessionsFilters {
  const requestedStatus = params.get("status");
  return {
    scope: params.get("scope") === "business" ? "business" : "personal",
    status: STATUS_FILTERS.has(requestedStatus as SessionsStatusFilter)
      ? (requestedStatus as SessionsStatusFilter)
      : "all",
    archive: params.get("archive") === "archived" ? "archived" : "current",
    repo: params.get("repo")?.trim() ?? "",
    query: params.get("q")?.trim() ?? "",
  };
}

export function buildSessionsFetchOptions(filters: SessionsFilters, cursor: string | null): FetchSessionsOptions {
  return {
    scope: filters.scope,
    cursor,
    status: filters.archive === "archived" ? "archived" : null,
    query: filters.query || filters.repo || null,
  };
}

export function sessionRepoFullName(session: SessionMetadata): string {
  if (session.repoOwner && session.repoName) return `${session.repoOwner}/${session.repoName}`;
  return session.repoName ?? "";
}

export function filterLoadedSessions(sessions: SessionMetadata[], filters: SessionsFilters): SessionMetadata[] {
  const repo = filters.repo.toLowerCase();
  return sessions.filter((session) => {
    // FSM-first archived detection, mirroring the dashboard's
    // groupDashboardSessions drop guard: an FSM-archived row whose legacy phase
    // lags must still be treated as archived, so it's hidden from the "current"
    // view (and shown in the "archived" view) consistently across both surfaces.
    const archived = session.fsmState === "ARCHIVED" || session.phase === "archived";
    if (filters.archive === "archived" ? !archived : archived) return false;
    if (repo && sessionRepoFullName(session).toLowerCase() !== repo) return false;
    return filters.status === "all" || bucketSession(session) === filters.status;
  });
}
