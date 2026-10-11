import { type FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { fetchSessions } from "../api/sessions";
import { bucketSession, sessionChipStatus, sessionLifecycleChip } from "../components/home/session-dashboard";
import { useLayoutContext } from "../components/Layout";
import { SessionLifecycleChip, SessionListStatusChip } from "../components/SessionListStatusChip";
import {
  ArtifactChip,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Row,
  RowGroup,
  Select,
  SkeletonRows,
} from "../components/ui";
import { useSyncEffect } from "../hooks/useEffects";
import type { SessionMetadata } from "../types";
import { compactTimeAgo } from "../utils/session-grouping";
import {
  buildSessionsFetchOptions,
  filterLoadedSessions,
  parseSessionsFilters,
  sessionRepoFullName,
  type SessionsArchiveFilter,
  type SessionsScopeFilter,
  type SessionsStatusFilter,
} from "./sessions-page";

const STATUS_OPTIONS: Array<{ value: SessionsStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "attention", label: "Needs attention" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
];

const STATUS_LABEL: Record<SessionsStatusFilter, string> = {
  all: "Sessions",
  attention: "Needs attention",
  running: "Running",
  completed: "Completed",
};

export function SessionsPage() {
  const { capabilities, repos } = useLayoutContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const parsedFilters = useMemo(() => parseSessionsFilters(searchParams), [searchParams]);
  const canUseBusinessSessions = capabilities?.canUseBusinessSessions === true;
  const scope: SessionsScopeFilter = canUseBusinessSessions ? parsedFilters.scope : "personal";
  const filters = useMemo(() => ({ ...parsedFilters, scope }), [parsedFilters, scope]);
  const [searchDraft, setSearchDraft] = useState(filters.query);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const updateParam = useCallback(
    (key: "scope" | "status" | "archive" | "repo" | "q", value: string, defaultValue: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (!value || value === defaultValue) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const updateArchive = useCallback(
    (archive: SessionsArchiveFilter) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (archive === "current") next.delete("archive");
          else next.set("archive", archive);
          next.delete("status");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const loadFirstPage = useCallback(async (nextFilters: typeof filters) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchSessions(buildSessionsFetchOptions(nextFilters, null));
      if (sequence !== requestSequence.current) return;
      setSessions(page.sessions);
      setCursor(page.nextCursor);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setSessions([]);
      setCursor(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load sessions");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useSyncEffect(() => {
    setSearchDraft(filters.query);
  }, [filters.query]);

  useSyncEffect(() => {
    void loadFirstPage(filters);
  }, [filters.scope, filters.status, filters.archive, filters.repo, filters.query, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const sequence = requestSequence.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchSessions(buildSessionsFetchOptions(filters, cursor));
      if (sequence !== requestSequence.current) return;
      setSessions((current) => [
        ...current,
        ...page.sessions.filter((session) => !current.some((loaded) => loaded.sessionId === session.sessionId)),
      ]);
      setCursor(page.nextCursor);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load more sessions");
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  }, [cursor, filters]);

  const filteredSessions = useMemo(() => filterLoadedSessions(sessions, filters), [sessions, filters]);
  const repoOptions = useMemo(() => {
    const names = new Set(repos.map((repo) => repo.fullName));
    if (filters.repo) names.add(filters.repo);
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [repos, filters.repo]);
  const hasFilters =
    filters.status !== "all" ||
    filters.archive !== "current" ||
    filters.repo.length > 0 ||
    filters.query.length > 0 ||
    filters.scope !== "personal";
  const meta = sessions.length > 0 ? `${filteredSessions.length} of ${sessions.length} loaded` : undefined;

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    updateParam("q", searchDraft.trim(), "");
  }

  function clearFilters() {
    setSearchDraft("");
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  return (
    <div className="control-room-canvas control-room-page">
      <div className="control-room-content flex flex-col gap-5">
        {/* No Activity action here: the sidebar already carries the Activity
            nav item under the same capability gate. */}
        <PageHeader eyebrow="Work" title="Sessions" meta={meta} className="editorial-rise editorial-rise-1" />

        <div className="editorial-rise editorial-rise-2 flex flex-wrap items-center gap-2">
          {canUseBusinessSessions && (
            <Select
              controlSize="sm"
              aria-label="Filter by scope"
              value={filters.scope}
              onChange={(event) => updateParam("scope", event.target.value, "personal")}
              wrapperClassName="w-40 max-w-full"
            >
              <option value="personal">Your sessions</option>
              <option value="business">Workspace sessions</option>
            </Select>
          )}

          <Select
            controlSize="sm"
            aria-label="Filter by status"
            value={filters.status}
            disabled={filters.archive === "archived"}
            onChange={(event) => updateParam("status", event.target.value, "all")}
            wrapperClassName="w-44 max-w-full"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>

          <Select
            controlSize="sm"
            aria-label="Filter by repository"
            value={filters.repo}
            onChange={(event) => updateParam("repo", event.target.value, "")}
            wrapperClassName="w-56 max-w-full"
          >
            <option value="">All repositories</option>
            {repoOptions.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </Select>

          <Select
            controlSize="sm"
            aria-label="Filter archived sessions"
            value={filters.archive}
            onChange={(event) => updateArchive(event.target.value as SessionsArchiveFilter)}
            wrapperClassName="w-40 max-w-full"
          >
            <option value="current">Current sessions</option>
            <option value="archived">Archived sessions</option>
          </Select>
        </div>

        {/* Second toolbar band — shares the -2 beat so the whole filter region
            arrives together (three beats per page, not four). */}
        <form onSubmit={submitSearch} className="editorial-rise editorial-rise-2 flex items-center gap-2" role="search">
          <Input
            controlSize="sm"
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            className="min-w-40 flex-1"
          />
          <Button type="submit" size="sm">
            Search
          </Button>
          {hasFilters && (
            <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </form>

        <div className="editorial-rise editorial-rise-3 flex flex-col gap-5">
          {loading ? (
            <div aria-busy="true" aria-label="Loading sessions">
              <SkeletonRows rows={6} />
            </div>
          ) : error && sessions.length === 0 ? (
            <EmptyState
              title="Could not load sessions"
              description={error}
              action={
                <Button size="sm" onClick={() => void loadFirstPage(filters)}>
                  Retry
                </Button>
              }
            />
          ) : filteredSessions.length === 0 ? (
            <EmptyState
              title={filters.archive === "archived" ? "No archived sessions" : "No matching sessions"}
              description={
                hasFilters
                  ? "No sessions match these filters."
                  : "Sessions will appear here after you send Cycloid a task."
              }
              action={
                hasFilters ? (
                  <Button size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <RowGroup
              // Skeleton → content swap: the group remounts when loading flips
              // false, fading the loaded list in as one unit (never per row).
              className="editorial-fade"
              title={filters.archive === "archived" ? "Archived" : STATUS_LABEL[filters.status]}
              count={filteredSessions.length}
              contained={false}
            >
              {filteredSessions.map((session) => (
                <SessionListRow key={session.sessionId} session={session} showOwner={filters.scope === "business"} />
              ))}
            </RowGroup>
          )}

          {!loading && error && sessions.length > 0 && (
            <p role="alert" className="editorial-fade text-sm text-error">
              {error}
            </p>
          )}

          {!loading && cursor && sessions.length > 0 && (
            <div className="flex justify-center pt-2">
              <Button size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function SessionListRow({ session, showOwner }: { session: SessionMetadata; showOwner: boolean }) {
  const repo = sessionRepoFullName(session);
  const lifecycle = sessionLifecycleChip(session);
  // FSM-first: attention rows (Needs you / Failed) keep the repo subtitle for
  // orientation and surface the reason in the meta slot so the user sees both
  // "which project" and "why"; other rows keep repo + model.
  const showDetail = lifecycle?.detail && bucketSession(session) === "attention";
  const owner = showOwner && session.ownerLogin ? session.ownerLogin : null;
  return (
    <Row
      href={`/sessions/${session.sessionId}`}
      ariaLabel={`Open session ${session.title ?? session.sessionId}`}
      leading={
        lifecycle ? (
          <SessionLifecycleChip chip={lifecycle.chip} />
        ) : (
          <SessionListStatusChip status={sessionChipStatus(session)} />
        )
      }
      title={session.title ?? "Untitled session"}
      subtitle={repo || "No repository"}
      meta={showDetail ? lifecycle.detail : session.model?.modelID}
      chips={
        <>
          {owner && <ArtifactChip kind="text" label={owner} showIcon={false} />}
          {session.prUrl && <ArtifactChip kind="pr-open" />}
        </>
      }
      trailing={compactTimeAgo(session.createdAt)}
      className="mb-px last:mb-0"
    />
  );
}
