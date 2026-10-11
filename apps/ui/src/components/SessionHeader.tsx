import { useState } from "react";
import { Link } from "react-router";

import { isStopAvailable } from "../../../../shared/session/eligibility";
import { TERMINAL_CHILD_STATUSES } from "../../../../shared/types/child-session";
import type { ChildSessionSummary } from "../api/sessions";
import { fetchChildSessions } from "../api/sessions";
import { useSyncEffect } from "../hooks/useEffects";
import type { SessionDetail } from "../types";
import { parseRepoFullNameFromUrl } from "../utils/repos";
import { safeHttpsUrl } from "../utils/safe-url";
import { sessionEntrypointLabel } from "../utils/session-entrypoint";
import { ChipIcon, GitBranchIcon, GithubIcon } from "./icons";
import { type CanonicalSessionStatus, getCanonicalSessionStatus } from "./session/workbench";
import { Badge, Button } from "./ui";

export type { CanonicalSessionStatus } from "./session/workbench";
export { getCanonicalSessionStatus } from "./session/workbench";

type Props = {
  session: SessionDetail;
  /** Routed through the page's shared confirm dialog (useConfirm). */
  onStop: () => void;
  hydrated: boolean;
  readOnly?: boolean;
  onOpenArtifacts?: (trigger: HTMLButtonElement) => void;
};

const CHILDREN_POLL_INTERVAL_MS = 8000;
const CHILDREN_POLL_MAX_INTERVAL_MS = 60_000;
const CHILD_SESSION_STATUS_LABELS: Record<ChildSessionSummary["status"], string> = {
  pending: "Queued",
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export function CanonicalStatusChip({ status }: { status: CanonicalSessionStatus }) {
  // Monochrome Control chip vocabulary, matching the Badge/StatusChip family:
  // violet is reserved for the live/running accent state, the error hue only
  // for failed/blocked, and success/completed/muted stay grayscale so the mono
  // label and dot carry the state, never a hue. Sharp corners, 1px border.
  const isLive = status.tone === "accent";
  const isError = status.tone === "error";
  const toneClass = isLive
    ? "border-live-border bg-live-tint text-live"
    : isError
      ? "border-error-soft-border bg-error-soft text-error"
      : status.tone === "muted"
        ? "border-border-strong bg-transparent text-text-secondary"
        : "border-border-hover bg-transparent text-text-primary";
  const dotClass = isLive
    ? "bg-live review-loop-breathe"
    : isError
      ? "bg-error"
      : status.tone === "muted"
        ? "bg-text-muted"
        : "bg-text-secondary";

  return (
    <span
      aria-label={`Session status: ${status.label}`}
      title={status.title}
      className={`status-pill inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono-tabular text-xs ${toneClass}`}
    >
      <span aria-hidden className={`status-dot size-1.5 shrink-0 rounded-full ${dotClass}`} />
      {status.label}
    </span>
  );
}

export function SessionHeader({ session, onStop, hydrated, readOnly = false, onOpenArtifacts }: Props) {
  // Fetch child summaries (with each child's prUrl) so the parent page can
  // link directly to each child's PR. Only runs when the session has spawned
  // children. Re-runs if the children list grows.
  //
  // While any child is still in a non-terminal lifecycle state we poll on a
  // short interval so the row picks up status transitions and PR-creation
  // events without a full page refresh. Once every child is terminal the
  // poll stops on its own.
  const childIdsKey = session.childSessionIds?.join(",") ?? "";
  const [children, setChildren] = useState<ChildSessionSummary[]>([]);
  const [childrenFetchFailed, setChildrenFetchFailed] = useState(false);
  useSyncEffect(() => {
    if (typeof document === "undefined") return;
    // Reset enriched state whenever the child-id list changes (e.g. a new
    // child was just spawned). Without this, a stale `children` array from a
    // previous fetch keeps rendering N-1 rows while the header already shows
    // N children until the next tick resolves.
    setChildren([]);
    setChildrenFetchFailed(false);
    if (!hydrated || !session.childSessionIds || session.childSessionIds.length === 0) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let nextPollDelayMs = CHILDREN_POLL_INTERVAL_MS;
    // Guards against concurrent ticks. Without this, a rapid hide → show
    // sequence can launch a second `tick()` from `handleVisibilityChange`
    // while the previous one is still awaiting `fetchChildSessions`, and
    // both would interleave reads/writes of `nextPollDelayMs` between
    // `await` boundaries — corrupting the intended backoff.
    let tickInFlight = false;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = (delayMs: number) => {
      clearTimer();
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      if (tickInFlight) return;
      tickInFlight = true;
      try {
        const rows = await fetchChildSessions(session.sessionId, { includePrUrl: true });
        if (cancelled) return;
        setChildren(rows);
        setChildrenFetchFailed(false);
        nextPollDelayMs = CHILDREN_POLL_INTERVAL_MS;
        // Empty result is treated as "still in flight" so a transient D1 lag
        // (session_index hasn't caught up to the parent's in-memory child
        // list yet) doesn't permanently stop the poll. `every` is vacuously
        // true on `[]`, which would otherwise leave the UI stuck.
        const allTerminal = rows.length > 0 && rows.every((r) => TERMINAL_CHILD_STATUSES.has(r.status));
        if (!allTerminal) {
          scheduleNext(nextPollDelayMs);
        }
      } catch {
        if (cancelled) return;
        setChildrenFetchFailed(true);
        const delayMs = nextPollDelayMs;
        nextPollDelayMs = Math.min(nextPollDelayMs * 2, CHILDREN_POLL_MAX_INTERVAL_MS);
        scheduleNext(delayMs);
      } finally {
        tickInFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void tick();
      } else {
        clearTimer();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") {
      void tick();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimer();
    };
  }, [hydrated, session.sessionId, childIdsKey]);

  const repoParsed = session.repoUrl ? parseRepoFullNameFromUrl(session.repoUrl) : null;
  const repoHref = session.repoUrl ? safeHttpsUrl(session.repoUrl) : null;
  const repoLabel = repoParsed ? `${repoParsed.owner}/${repoParsed.repo}` : session.repoUrl;
  const sessionBranch =
    session.startBranch?.trim() ||
    session.baseBranch?.trim() ||
    session.lastBranch?.trim() ||
    session.publishedBranch?.trim() ||
    null;
  const sessionBranchLabel = sessionBranch ? `Branch: ${sessionBranch}` : null;
  const modelLabel = session.model?.label?.trim() || session.model?.modelID?.trim() || null;
  const canonicalStatus = hydrated ? getCanonicalSessionStatus(session) : null;
  const showBranch = Boolean(sessionBranch && !session.prUrl);
  const showChildren = Boolean(hydrated && session.childSessionIds && session.childSessionIds.length > 0);
  const hasMeta = Boolean(session.repoUrl || showBranch || modelLabel || session.parentSessionId);

  return (
    <>
      {/* Page-header rhythm: top padding matches .control-room-content (32px
          mobile / 56px desktop) since the session column self-pads. */}
      <div className="pt-8 md:pt-14 mb-8 pb-4 border-b border-border">
        {/* Below md the actions row stacks under the title block — never beside
            it — so Stop/status/Details can't squeeze the title to a sliver on
            narrow viewports. */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 max-w-full md:flex-1 md:max-w-3xl">
            <h1
              className={`min-w-0 line-clamp-2 break-words ${session.title ? "font-display-tight text-3xl md:text-4xl leading-[0.95] text-text-primary" : "font-mono-tabular font-normal tracking-normal leading-tight text-base text-text-secondary"}`}
            >
              {session.title || session.sessionId.slice(0, 8)}
            </h1>
            {hasMeta && (
              /* Uniform tight meta stack: one gap token for every line so
                 repo → branch → parent read as a single left-aligned group. */
              <div className="mt-4 flex flex-col items-start gap-2">
                {session.repoUrl &&
                  (repoHref ? (
                    <a
                      href={repoHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-base text-text-secondary transition-colors hover:text-text-primary"
                    >
                      {repoParsed && <GithubIcon className="h-3.5 w-3.5 shrink-0" />}
                      <span className="font-mono break-all">{repoLabel}</span>
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-2 font-mono text-base break-all text-text-muted">
                      {repoLabel}
                    </span>
                  ))}
                {showBranch && (
                  <span
                    className="inline-flex max-w-full items-center gap-2 text-xs text-text-muted"
                    aria-label={sessionBranchLabel ?? undefined}
                    title={sessionBranchLabel ?? undefined}
                  >
                    <GitBranchIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono-tabular break-all">{sessionBranch}</span>
                  </span>
                )}
                {modelLabel && (
                  <span
                    className="inline-flex max-w-full items-center gap-2 text-xs text-text-muted"
                    aria-label={`Model: ${modelLabel}`}
                    title={`Model: ${modelLabel}`}
                  >
                    <ChipIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono-tabular break-all">{modelLabel}</span>
                  </span>
                )}
                {session.parentSessionId && (
                  <div className="flex items-center gap-2 text-xs font-mono-tabular text-text-muted">
                    <span>Parent:</span>
                    <Link
                      to={`/sessions/${session.parentSessionId}`}
                      className="text-accent hover:underline"
                      aria-label={`Open parent session ${session.parentSessionId.slice(0, 8)}`}
                    >
                      {session.parentSessionId.slice(0, 8)}
                    </Link>
                  </div>
                )}
              </div>
            )}
            {showChildren && session.childSessionIds && (
              <div
                className="mt-2 flex flex-col gap-1 text-xs font-mono-tabular text-text-muted"
                aria-label="Related sessions"
              >
                <span>Related sessions ({session.childSessionIds.length})</span>
                {/*
                 * If the fetch hasn't returned yet or it errored, render bare
                 * ID rows without a status field — never invent a synthetic
                 * lifecycle string, since the children may already be
                 * terminal. Status + PR link appear once the fetch succeeds.
                 */}
                {children.length === 0
                  ? session.childSessionIds.map((id) => (
                      <div key={id} className="flex flex-wrap items-center gap-2 pl-3">
                        <Link
                          to={`/sessions/${id}`}
                          className="text-accent hover:underline"
                          aria-label={`Open child session ${id.slice(0, 8)}`}
                        >
                          {id.slice(0, 8)}
                        </Link>
                        {childrenFetchFailed && (
                          <span className="text-text-secondary" title="Failed to load child status">
                            ·<span className="ml-2 text-error">unknown</span>
                          </span>
                        )}
                      </div>
                    ))
                  : children.map((c) => (
                      <div key={c.childSessionId} className="flex flex-wrap items-center gap-2 pl-3">
                        <Link
                          to={`/sessions/${c.childSessionId}`}
                          className="text-accent hover:underline"
                          aria-label={`Open child session ${c.childSessionId.slice(0, 8)}`}
                        >
                          {c.title?.trim() || c.childSessionId.slice(0, 8)}
                        </Link>
                        <span className="text-text-secondary">·</span>
                        <span className="text-text-secondary">{CHILD_SESSION_STATUS_LABELS[c.status]}</span>
                        {(() => {
                          const safe = safeHttpsUrl(c.prUrl);
                          if (!safe) return null;
                          return (
                            <>
                              <span className="text-text-secondary">·</span>
                              <a
                                href={safe}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent hover:underline"
                                aria-label={`Open PR for child session ${c.childSessionId.slice(0, 8)}`}
                              >
                                PR
                              </a>
                            </>
                          );
                        })()}
                      </div>
                    ))}
              </div>
            )}
          </div>
          {/* Desktop: pt optically centers the pill row against the title's
              first line (38px cap height vs ~22px pill). Mobile: its own row
              below the title block, wrapping when tight. */}
          <div className="flex flex-wrap items-center gap-3 md:shrink-0 md:pt-2">
            {onOpenArtifacts && (
              <Button
                type="button"
                onClick={(event) => onOpenArtifacts(event.currentTarget)}
                variant="secondary"
                size="sm"
                className="xl:hidden"
              >
                Details
              </Button>
            )}
            {/* The chip is a readout, never a secret link — PR navigation has
                its own labelled affordances (sticky bar, PR tab). */}
            {canonicalStatus ? <CanonicalStatusChip status={canonicalStatus} /> : null}
            {(session.entrypoint || session.initiationMode === "automation") && (
              <Badge
                tone="default"
                title={[
                  session.ruleNameSnapshot ? `Rule: ${session.ruleNameSnapshot}` : null,
                  session.cronSnapshot ? `Cron: ${session.cronSnapshot} (UTC)` : null,
                ]
                  .filter(Boolean)
                  .join("\n")}
                aria-label={sessionEntrypointLabel(session.entrypoint, session.initiationMode)}
              >
                {sessionEntrypointLabel(session.entrypoint, session.initiationMode)}
              </Badge>
            )}
            {/* `isStopAvailable` encodes the same rule: active-prompt phase
                with a usable sandbox socket. Sharing one helper across the
                server view, the stop route gate, the DO handler, and this
                button keeps the four sites from drifting. */}
            {/* Stop is resumable, so it reads as a secondary action (danger is
                reserved for archive); confirmation runs through the page's
                shared useConfirm dialog. */}
            {!readOnly &&
              hydrated &&
              isStopAvailable(session.phase, session.sandboxSubstate, session.planApprovalPending ?? false) && (
                <Button type="button" onClick={onStop} variant="secondary" size="sm">
                  Stop
                </Button>
              )}
          </div>
        </div>
      </div>
    </>
  );
}
