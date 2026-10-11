import { useCallback, useState } from "react";
import { Link } from "react-router";

import {
  type ActivityData,
  type ActivityScope,
  type ActivitySession,
  type ActivityWindowDays,
  fetchActivity,
} from "../api/activity";
import { RefreshIcon } from "../components/icons";
import { useLayoutContext } from "../components/Layout";
import {
  Button,
  ColumnHeader,
  EmptyState,
  PageHeader,
  RowGroup,
  SegmentedControl,
  SkeletonBlock,
  SkeletonRows,
  StatusChip,
} from "../components/ui";
import { useSyncEffect } from "../hooks/useEffects";
import { formatTimestampMinutes } from "../utils/time";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ActivityData };

const NUMBER_FORMATTER = new Intl.NumberFormat();
const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

const WINDOW_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

const SCOPE_OPTIONS = [
  { value: "user", label: "Your usage" },
  { value: "organization", label: "Organization" },
];

const SOURCE_LABELS = { slack: "Slack", automation: "Automations", child: "Child", user: "Manual/API" } as const;

export function ActivityPage() {
  const { user } = useLayoutContext();
  const canViewOrganization = user?.businessRole === "admin";
  const [windowDays, setWindowDays] = useState<ActivityWindowDays>(7);
  const [scope, setScope] = useState<ActivityScope>("user");
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const loadActivity = useCallback(
    async (nextWindowDays: ActivityWindowDays, nextScope: ActivityScope, preserveCurrent = false) => {
      if (preserveCurrent) setRefreshing(true);
      else setLoad({ status: "loading" });
      try {
        const data = await fetchActivity(nextWindowDays, nextScope);
        setLoad({ status: "ready", data });
      } catch (error) {
        if (!preserveCurrent) {
          setLoad({ status: "error", message: error instanceof Error ? error.message : "Failed to load activity" });
        }
      } finally {
        if (preserveCurrent) setRefreshing(false);
      }
    },
    [],
  );

  useSyncEffect(() => {
    void loadActivity(windowDays, scope);
  }, [windowDays, scope, loadActivity]);

  return (
    <div className="control-room-canvas control-room-page">
      <div className="control-room-content flex flex-col gap-6">
        <PageHeader
          eyebrow="Work"
          title="Activity"
          // Scope/window controls live in the header actions slot, so they ride
          // the -1 beat; there is no standalone toolbar row on this page.
          className="editorial-rise editorial-rise-1"
          // No meta readout: the scope control in `actions` already names the
          // active scope, and on mobile the meta clipped behind it.
          actions={
            <>
              {canViewOrganization ? (
                <SegmentedControl
                  ariaLabel="Activity scope"
                  value={scope}
                  onChange={(value) => setScope(value === "organization" ? "organization" : "user")}
                  options={SCOPE_OPTIONS}
                />
              ) : null}
              <SegmentedControl
                ariaLabel="Activity window"
                value={String(windowDays)}
                onChange={(value) => setWindowDays(value === "30" ? 30 : 7)}
                options={WINDOW_OPTIONS}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={refreshing || load.status === "loading"}
                onClick={() => void loadActivity(windowDays, scope, true)}
                aria-label="Refresh activity"
                title="Refresh activity"
              >
                <RefreshIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
              </Button>
            </>
          }
        />

        <div className="editorial-rise editorial-rise-3 flex flex-col gap-6">
          {load.status === "loading" ? (
            <ActivitySkeleton />
          ) : load.status === "error" ? (
            <EmptyState
              title="Could not load activity"
              description={load.message}
              action={<Button onClick={() => void loadActivity(windowDays, scope)}>Retry</Button>}
            />
          ) : (
            <ActivityBody data={load.data} />
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityBody({ data }: { data: ActivityData }) {
  return (
    // Skeleton → content swap: this container mounts when the load flips to
    // ready, fading the whole body in as one unit. In-place refreshes
    // (preserveCurrent) keep it mounted, so data updates never re-animate.
    <div className="editorial-fade flex flex-col gap-6">
      <MetricBand data={data} />
      <OutcomeSection data={data} />
      <SessionLedger data={data} />
    </div>
  );
}

function MetricBand({ data }: { data: ActivityData }) {
  const { totals } = data;
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const tokensPerSession = totals.sessions > 0 ? Math.round(totalTokens / totals.sessions) : 0;
  const mergedLoc = totals.mergedAdditions + totals.mergedDeletions;
  const mergedLocComplete = totals.sessionsMerged === totals.mergedLocSessions;

  const metrics: Array<{ label: string; value: string; detail: string; title?: string }> = [
    {
      label: "Sessions",
      value: formatNumber(totals.sessions),
      detail: `${formatCompactNumber(totalTokens)} total tokens`,
    },
    {
      label: "Tokens / session",
      value: formatCompactNumber(tokensPerSession),
      detail: `${formatCompactNumber(totals.inputTokens)} in · ${formatCompactNumber(totals.outputTokens)} out`,
    },
    {
      label: "PR merged",
      value: formatNumber(totals.sessionsMerged),
      detail: percent(totals.sessionsMerged, totals.sessions),
    },
    { label: "PR closed", value: formatNumber(totals.sessionsClosed), detail: "Closed without merge" },
    {
      label: "Merged LOC",
      value: totals.mergedLocSessions > 0 ? formatNumber(mergedLoc) : "—",
      detail: mergedLocComplete
        ? `+${formatNumber(totals.mergedAdditions)} / -${formatNumber(totals.mergedDeletions)}`
        : `${formatNumber(totals.mergedLocSessions)} of ${formatNumber(totals.sessionsMerged)} measured`,
      title: "Lines added plus deleted across merged PRs, counting only sessions with a measured diff.",
    },
    {
      // "Feedback", not "Feedback sessions": the longer label truncated in the
      // fixed eyebrow slot; the title carries the full meaning.
      label: "Feedback",
      value: formatNumber(totals.sessionsWithFeedback),
      detail: `${formatNumber(totals.feedbackTurns)} follow-up ${totals.feedbackTurns === 1 ? "turn" : "turns"}`,
      title: "Sessions where you sent follow-up prompts after the first result.",
    },
  ];

  return (
    <section
      aria-label="Usage summary"
      className="grid border-y border-border-subtle sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
    >
      {metrics.map((metric) => (
        <div
          key={metric.label}
          title={metric.title}
          className="flex min-w-0 flex-col gap-1 border-b border-border-subtle px-3 py-3 last:border-b-0 sm:border-r lg:[&:nth-child(3n)]:border-r-0 xl:border-b-0 xl:[&:nth-child(3n)]:border-r xl:last:border-r-0"
        >
          <span className="eyebrow truncate">{metric.label}</span>
          <span className="numeral text-xl text-text-primary">{metric.value}</span>
          <span className="truncate font-mono-tabular text-2xs text-text-muted" title={metric.detail}>
            {metric.detail}
          </span>
        </div>
      ))}
    </section>
  );
}

function OutcomeSection({ data }: { data: ActivityData }) {
  const { totals, sessionsBySource } = data;
  const sources = (Object.keys(SOURCE_LABELS) as Array<keyof typeof SOURCE_LABELS>).filter(
    (source) => sessionsBySource[source] > 0,
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.6fr)]">
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="outcome-heading">
        <div>
          <h2 id="outcome-heading" className="text-md font-medium text-text-primary">
            Session outcomes
          </h2>
          <p className="text-sm text-text-muted">Conversion from sessions created in this window.</p>
        </div>
        <div className="flex flex-col border-y border-border-subtle">
          <OutcomeRow label="Sessions" count={totals.sessions} total={totals.sessions} />
          <OutcomeRow label="PR opened" count={totals.sessionsWithPr} total={totals.sessions} />
          <OutcomeRow label="PR merged" count={totals.sessionsMerged} total={totals.sessions} />
          <OutcomeRow label="PR closed" count={totals.sessionsClosed} total={totals.sessions} />
        </div>
      </section>
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="source-heading">
        <div>
          <h2 id="source-heading" className="text-md font-medium text-text-primary">
            Session source
          </h2>
          <p className="text-sm text-text-muted">Where work entered Cycloid.</p>
        </div>
        <div className="flex flex-col border-y border-border-subtle">
          {sources.length === 0 ? (
            <p className="py-5 text-sm text-text-muted">No sessions in this window.</p>
          ) : (
            sources.map((source) => (
              <OutcomeRow
                key={source}
                label={SOURCE_LABELS[source]}
                count={sessionsBySource[source]}
                total={totals.sessions}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function OutcomeRow({ label, count, total }: { label: string; count: number; total: number }) {
  const width = total > 0 ? Math.max(2, Math.round((count / total) * 100)) : 0;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-3 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="h-1.5 bg-surface-2" aria-hidden>
        <span className="block h-full bg-text-secondary" style={{ width: `${width}%` }} />
      </span>
      <span className="text-right font-mono-tabular text-xs text-text-muted">
        {formatNumber(count)} · {percent(count, total)}
      </span>
    </div>
  );
}

function SessionLedger({ data }: { data: ActivityData }) {
  const organization = data.scope === "organization";
  return (
    <RowGroup title="Sessions" count={data.sessions.length} contained={false}>
      {data.sessions.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No sessions"
          description="Sessions created in this window will appear here."
        />
      ) : (
        <>
          <ColumnHeader
            columns={[
              { key: "session", label: "Session", className: "min-w-0 flex-1" },
              ...(organization ? [{ key: "owner", label: "Owner", className: "hidden w-28 lg:inline-flex" }] : []),
              { key: "tokens", label: "Tokens", className: "w-20 justify-end text-right" },
              // w-24 + nowrap: at w-20 the mono "FOLLOW-UPS" label broke across
              // two lines in its own header cell.
              {
                key: "turns",
                label: "Follow-ups",
                className: "hidden w-24 justify-end whitespace-nowrap text-right md:inline-flex",
              },
              { key: "pr", label: "PR", className: "w-24" },
              { key: "loc", label: "Merged LOC", className: "hidden w-24 justify-end text-right xl:inline-flex" },
              { key: "created", label: "Created", className: "hidden w-28 justify-end text-right sm:inline-flex" },
            ]}
          />
          {data.sessions.map((session) => (
            <SessionRow key={session.sessionId} session={session} organization={organization} />
          ))}
        </>
      )}
    </RowGroup>
  );
}

function SessionRow({ session, organization }: { session: ActivitySession; organization: boolean }) {
  const repo =
    session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : SOURCE_LABELS[session.source];
  const mergedLoc =
    session.mergedAdditions !== null && session.mergedDeletions !== null
      ? session.mergedAdditions + session.mergedDeletions
      : null;
  return (
    <Link
      to={`/sessions/${session.sessionId}`}
      className="session-stack-dense row-hover-lift flex items-center gap-3 text-left"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium text-text-primary">
          {session.title?.trim() || session.sessionId.slice(0, 8)}
        </span>
        <span className="eyebrow truncate">{repo}</span>
      </span>
      {organization ? (
        <span className="hidden w-28 truncate text-xs text-text-muted lg:block">{session.ownerLogin ?? "Unknown"}</span>
      ) : null}
      <span className="w-20 text-right font-mono-tabular text-xs text-text-secondary">
        {formatCompactNumber(session.inputTokens + session.outputTokens)}
      </span>
      <span className="hidden w-24 text-right font-mono-tabular text-xs text-text-secondary md:block">
        {formatNumber(session.feedbackTurns)}
      </span>
      <span className="w-24">
        {session.prStatus ? (
          <StatusChip
            status={session.prStatus === "merged" ? "done" : session.prStatus === "closed" ? "failed" : "pr-open"}
            variant="dot"
            label={session.prStatus}
          />
        ) : (
          <span className="text-xs text-text-muted">No PR</span>
        )}
      </span>
      <span className="hidden w-24 text-right font-mono-tabular text-xs text-text-secondary xl:block">
        {session.prStatus === "merged" ? (mergedLoc === null ? "Unavailable" : formatNumber(mergedLoc)) : "—"}
      </span>
      <span className="hidden w-28 text-right font-mono-tabular text-xs text-text-muted sm:block">
        {formatTimestampMinutes(session.createdAt) ?? "n/a"}
      </span>
    </Link>
  );
}

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonBlock key={index} className="h-20" />
        ))}
      </div>
      <SkeletonRows rows={6} />
    </div>
  );
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}
function formatCompactNumber(value: number): string {
  return COMPACT_NUMBER_FORMATTER.format(value);
}
function percent(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
}
