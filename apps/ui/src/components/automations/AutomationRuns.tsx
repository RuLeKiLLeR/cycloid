import { Link } from "react-router";

import type { AutomationRunHistoryItem } from "../../api/automation-runs";
import { Button } from "../ui";
import { formatUtcTimestamp } from "./format";
const FAILURE_COPY: Record<string, string> = {
  execution_failed: "Execution failed",
  missing_slack_token: "Slack connection unavailable",
  missing_configured_user: "Configured user unavailable",
  repo_gate_failed: "Repository access failed",
  thread_already_claimed: "Slack thread already handled",
  enqueue_failed: "Session could not start",
  lease_expired: "Worker lease expired",
  stale_unclaimed: "Run expired before start",
  resolved_alert: "Resolved alert",
  duplicate_recent_alert: "Duplicate recent alert",
  skipped: "Skipped",
  rule_disabled: "Rule was paused before dispatch",
  dispatch_failed: "Session dispatch failed",
};
export function AutomationRuns({
  runs,
  loading,
  error,
  nextCursor,
  loadingMore,
  loadMoreError,
  onLoadMore,
}: {
  runs: AutomationRunHistoryItem[];
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
}) {
  if (loading) return <p className="text-sm text-text-muted">Loading automation runs…</p>;
  if (error) return <p className="text-sm text-error">{error}</p>;
  if (runs.length === 0)
    return <p className="text-sm text-text-muted">No retained runs yet. Deleted rules remove their history.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-border border border-border">
        {runs.map((run) => {
          const content = (
            <>
              <div>
                <p className="font-medium text-text-primary">
                  {run.ruleName ??
                    (run.source === "schedule"
                      ? "Scheduled rule"
                      : run.source === "slack_alert"
                        ? "Slack alert rule"
                        : "Failed GitHub check rule")}
                </p>
                <p className="text-xs text-text-muted">
                  {run.source === "schedule"
                    ? "Schedule"
                    : run.source === "slack_alert"
                      ? `${run.triggerProvider ?? "Alert"} via Slack`
                      : "Failed GitHub check"}{" "}
                  · orchestration: {run.orchestrationStatus}
                </p>
                {run.failureCode ? (
                  <p className="text-xs text-error">{FAILURE_COPY[run.failureCode] ?? "Run failed"}</p>
                ) : null}
                {run.executionOutcome || run.sessionStatus ? (
                  <p className="text-xs text-text-secondary">
                    {run.executionOutcome
                      ? `Execution: ${run.executionOutcome}`
                      : `Session: ${run.sessionStatus ?? "started"}`}
                  </p>
                ) : null}
                {run.executionReason ? <p className="text-xs text-text-muted">{run.executionReason}</p> : null}
              </div>
              <span className="font-mono-tabular text-xs text-text-muted">{formatUtcTimestamp(run.createdAt)}</span>
            </>
          );
          const classes = "grid gap-3 bg-surface-1 p-4 sm:grid-cols-[minmax(0,1fr)_auto]";
          return run.sessionId ? (
            <Link key={`${run.source}:${run.id}`} to={`/sessions/${run.sessionId}`} className={classes}>
              {content}
            </Link>
          ) : (
            <div key={`${run.source}:${run.id}`} className={classes}>
              {content}
            </div>
          );
        })}
      </div>
      {loadMoreError ? <p className="text-xs text-error">{loadMoreError}</p> : null}
      {nextCursor ? (
        <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? "Loading…" : "Load older runs"}
        </Button>
      ) : null}
    </div>
  );
}
