import { useState } from "react";
import { Link } from "react-router";

import { displayStatusFromPhase } from "../../../../../shared/session/display-status";
import {
  fetchScheduledRuleRuns,
  type ScheduledRuleRun,
  type ScheduledRuleRunCounts,
  type ScheduledRuleRunsPage,
} from "../../api/automation-schedules";
import { useMountEffect } from "../../hooks/useEffects";
import { Button, type SessionStatus, SkeletonRows, StatusChip } from "../ui";
import { formatUtcTimestamp } from "./format";

export type RunChip = {
  status: SessionStatus;
  label: string;
};

/**
 * Map a run to its status chip. Two layers, rendered honestly: the scheduler
 * outcome first (failed/skipped/starting), then — for fired runs — the
 * session's current status. A fired run whose session row is gone (or whose
 * status was overwritten by archival) is labeled by what we still know.
 */
export function runChip(run: ScheduledRuleRun): RunChip {
  if (run.outcome === null) return { status: "running", label: "Starting" };
  if (run.outcome === "failed") return { status: "failed", label: "Failed" };
  if (run.outcome === "skipped_overlap" || run.outcome === "skipped_concurrency") {
    return { status: "pr-open", label: "Skipped" };
  }
  // Fired: report the created session's current status.
  if (run.sessionId === null) return { status: "pr-open", label: "Ran" };
  switch (displayStatusFromPhase(run.sessionRichStatus)) {
    case "completed":
      return { status: "done", label: "Completed" };
    case "failed":
      return { status: "failed", label: "Failed" };
    case "working":
      return { status: "running", label: "Running" };
    case "waiting_for_input":
      return { status: "waiting", label: "Waiting" };
    case "archived":
      return { status: "pr-open", label: "Archived" };
    case "stopped":
      return { status: "pr-open", label: "Stopped" };
  }
}

/** One-line explanation for non-fired runs; null when there is nothing to add. */
export function runDetail(run: ScheduledRuleRun): string | null {
  if (run.outcome === "skipped_overlap") return "Previous run still active";
  if (run.outcome === "skipped_concurrency") return "Concurrency limit reached";
  if (run.outcome === "failed") return run.failureReason;
  return null;
}

function CountsReadout({ label, counts }: { label: string; counts: ScheduledRuleRunCounts }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="eyebrow">{label}</span>
      <span className="font-mono-tabular text-xs text-text-secondary">
        {counts.fired} fired · {counts.failed} failed · {counts.skipped} skipped
      </span>
    </span>
  );
}

function RunRow({ run }: { run: ScheduledRuleRun }) {
  const chip = runChip(run);
  const detail = runDetail(run);
  const body = (
    <>
      <span className="w-28 shrink-0">
        <StatusChip
          status={chip.status}
          label={chip.label}
          // Failures should draw the eye; everything else is a quiet dot.
          variant={chip.status === "failed" ? "pill" : "dot"}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={detail ?? undefined}>
        {detail ?? ""}
      </span>
      <span className="shrink-0 font-mono-tabular text-xs text-text-muted">{formatUtcTimestamp(run.slotMs)}</span>
    </>
  );
  // A run with a session navigates whole-row; there is no separate text link.
  if (run.sessionId !== null) {
    return (
      <Link
        to={`/sessions/${run.sessionId}`}
        aria-label={`Open session for run ${formatUtcTimestamp(run.slotMs)}`}
        className="row-hover-lift flex min-w-0 items-center gap-3 px-4 py-2"
      >
        {body}
      </Link>
    );
  }
  return <div className="flex min-w-0 items-center gap-3 px-4 py-2">{body}</div>;
}

type RunHistoryProps = {
  ruleId: string;
};

/**
 * Per-rule run history: a rolling 7d outcome count on top, then each firing
 * slot with its status and timestamp; rows with a created session navigate
 * whole-row to it.
 */
export function RunHistory({ ruleId }: RunHistoryProps) {
  const [runs, setRuns] = useState<ScheduledRuleRun[]>([]);
  const [stats, setStats] = useState<ScheduledRuleRunsPage["stats"] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useMountEffect(() => {
    void (async () => {
      try {
        const page = await fetchScheduledRuleRuns(ruleId);
        setRuns(page.items);
        setStats(page.stats);
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load run history");
      } finally {
        setLoading(false);
      }
    })();
  });

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchScheduledRuleRuns(ruleId, nextCursor);
      setRuns((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more runs");
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-surface-2 px-4 py-2">
        <SkeletonRows rows={2} />
      </div>
    );
  }

  return (
    <div className="editorial-fade flex flex-col bg-surface-2" data-testid="run-history">
      {stats !== null ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2">
          <CountsReadout label="Last 7 days" counts={stats.last7d} />
        </div>
      ) : null}

      {error !== null ? (
        <p className="editorial-fade px-4 py-2 text-xs text-error" role="alert">
          {error}
        </p>
      ) : null}

      {!error && runs.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-text-muted">No runs yet. Runs appear after the next scheduled fire.</p>
      ) : (
        runs.map((run) => <RunRow key={run.jobKey} run={run} />)
      )}

      {nextCursor !== null ? (
        <div className="flex justify-center px-4 pb-2">
          <Button size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
