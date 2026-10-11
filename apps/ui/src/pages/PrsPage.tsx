import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { fetchPrInbox, type PrInboxBucket, type PrInboxItem } from "../api/pr-inbox";
import { useLayoutContext } from "../components/Layout";
import { groupByBucket, PR_BUCKET_LABELS, PR_BUCKET_ORDER } from "../components/prs/bucket-config";
import { PrRow } from "../components/prs/PrRow";
import { useCollapsedBuckets } from "../components/prs/usePrInboxPrefs";
import { Button, buttonClasses, EmptyState, Input, PageHeader, RowGroup, Select, SkeletonRows } from "../components/ui";
import { PR_INBOX_ALL_STATUSES, PR_INBOX_SEARCH_DEBOUNCE_MS, PR_INBOX_SEARCH_PLACEHOLDER } from "../constants/pr-inbox";
import { useSyncEffect } from "../hooks/useEffects";

const ALL_REPOS = "";

export function PrsPage() {
  const { repos } = useLayoutContext();

  const [repo, setRepo] = useState<string>(ALL_REPOS);
  const [items, setItems] = useState<PrInboxItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [bucketCounts, setBucketCounts] = useState<Record<PrInboxBucket, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState<PrInboxBucket | "">(PR_INBOX_ALL_STATUSES);
  const [collapsedBuckets, setBucketOpen] = useCollapsedBuckets();

  // Filter and pagination generations independently prevent stale responses.
  const requestSeq = useRef(0);
  const loadMoreSeq = useRef(0);

  const invalidateRequests = useCallback(() => {
    requestSeq.current += 1;
    loadMoreSeq.current += 1;
    setLoadingMore(false);
    setLoadMoreError(null);
  }, []);

  useSyncEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), PR_INBOX_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [search]);

  const loadFirstPage = useCallback(async (repoFilter: string, bucket: PrInboxBucket | "", searchQuery: string) => {
    const seq = ++requestSeq.current;
    loadMoreSeq.current += 1;
    setLoading(true);
    setLoadingMore(false);
    setInitialError(null);
    setLoadMoreError(null);
    setItems([]);
    setCursor(null);
    setTotalCount(0);
    setBucketCounts(null);
    try {
      const page = await fetchPrInbox({
        repo: repoFilter || null,
        bucket: bucket || null,
        search: searchQuery.trim() || null,
      });
      if (seq !== requestSeq.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setTotalCount(page.totalCount);
      setBucketCounts(page.bucketCounts);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setInitialError(err instanceof Error ? err.message : "Failed to load PRs");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useSyncEffect(() => {
    void loadFirstPage(repo, bucketFilter, debouncedSearch);
  }, [repo, bucketFilter, debouncedSearch, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const filterSeq = requestSeq.current;
    const pageSeq = ++loadMoreSeq.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchPrInbox({
        repo: repo || null,
        bucket: bucketFilter || null,
        search: debouncedSearch.trim() || null,
        cursor,
      });
      if (filterSeq !== requestSeq.current || pageSeq !== loadMoreSeq.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      setTotalCount(page.totalCount);
      setBucketCounts(page.bucketCounts);
    } catch (err) {
      if (filterSeq !== requestSeq.current || pageSeq !== loadMoreSeq.current) return;
      setLoadMoreError(err instanceof Error ? err.message : "Failed to load more PRs");
    } finally {
      if (filterSeq === requestSeq.current && pageSeq === loadMoreSeq.current) {
        setLoadingMore(false);
      }
    }
  }, [bucketFilter, cursor, debouncedSearch, repo]);

  const groups = useMemo(() => groupByBucket(items), [items]);

  const clearFilters = useCallback(() => {
    invalidateRequests();
    setRepo(ALL_REPOS);
    setSearch("");
    setDebouncedSearch("");
    setBucketFilter(PR_INBOX_ALL_STATUSES);
  }, [invalidateRequests]);

  const hasMatchingFilters = Boolean(bucketFilter || debouncedSearch.trim());

  // The title already says "PRs" — the meta readout is just the count.
  const meta =
    totalCount === 0 ? undefined : items.length < totalCount ? `${items.length} of ${totalCount}` : `${totalCount}`;

  return (
    <div className="control-room-canvas control-room-page">
      <div className="control-room-content flex flex-col gap-5">
        <PageHeader eyebrow="Work" title="PRs" meta={meta} className="editorial-rise editorial-rise-1" />

        <div className="editorial-rise editorial-rise-2 flex flex-wrap items-center gap-2">
          <Select
            controlSize="sm"
            aria-label="Filter by repository"
            value={repo}
            onChange={(event) => {
              invalidateRequests();
              setRepo(event.target.value);
            }}
            wrapperClassName="w-56 max-w-full"
          >
            <option value={ALL_REPOS}>All repositories</option>
            {repos.map((r) => (
              <option key={r.url} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </Select>

          <Select
            controlSize="sm"
            aria-label="Filter by status"
            value={bucketFilter}
            onChange={(event) => {
              invalidateRequests();
              setBucketFilter(event.target.value as PrInboxBucket | "");
            }}
            wrapperClassName="w-44 max-w-full"
          >
            <option value={PR_INBOX_ALL_STATUSES}>All statuses</option>
            {PR_BUCKET_ORDER.map((bucket) => (
              <option key={bucket} value={bucket}>
                {PR_BUCKET_LABELS[bucket]}
              </option>
            ))}
          </Select>

          <Input
            controlSize="sm"
            type="search"
            aria-label="Search PRs"
            placeholder={PR_INBOX_SEARCH_PLACEHOLDER}
            value={search}
            onChange={(event) => {
              invalidateRequests();
              setSearch(event.target.value);
            }}
            className="min-w-40 flex-1"
          />
        </div>

        <div className="editorial-rise editorial-rise-3 flex flex-col gap-3">
          {loading ? (
            <SkeletonRows rows={6} />
          ) : initialError ? (
            <EmptyState
              title="Could not load PRs"
              description={initialError}
              action={
                <Button size="sm" onClick={() => void loadFirstPage(repo, bucketFilter, debouncedSearch)}>
                  Retry
                </Button>
              }
            />
          ) : totalCount === 0 ? (
            hasMatchingFilters ? (
              <EmptyState
                title="No matching PRs"
                description="No pull requests match the current filters."
                action={
                  <Button size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : repo ? (
              <EmptyState
                title="No PRs in this repository"
                description="No pull requests are available for the selected repository."
                action={
                  <Button size="sm" onClick={clearFilters}>
                    View all
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No PRs yet"
                description="Pull requests opened by your sessions will show up here, grouped by review state."
                action={
                  <Link to="/" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    Start a task
                  </Link>
                }
              />
            )
          ) : (
            // Skeleton → content swap: this wrapper mounts when loading flips
            // false, fading the whole loaded list in as one unit (never per row).
            <div className="editorial-fade flex flex-col gap-3">
              {groups.map((group) => (
                <RowGroup
                  key={group.bucket}
                  title={group.label}
                  count={bucketFilter ? totalCount : (bucketCounts?.[group.bucket] ?? group.items.length)}
                  contained={false}
                  open={!collapsedBuckets.has(group.bucket)}
                  onOpenChange={(open) => setBucketOpen(group.bucket, open)}
                >
                  {group.items.map((item) => (
                    <PrRow key={item.sessionId} item={item} />
                  ))}
                </RowGroup>
              ))}
            </div>
          )}
          {!loading && !initialError && loadMoreError && items.length > 0 && (
            <div
              role="alert"
              className="editorial-fade flex flex-wrap items-center justify-between gap-2 border border-error-soft-border bg-error-soft px-3 py-2"
            >
              <span className="text-sm text-error">Could not load more PRs: {loadMoreError}</span>
              <Button size="sm" variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                Retry
              </Button>
            </div>
          )}
          {!loading && !initialError && !loadMoreError && cursor && items.length > 0 && (
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
