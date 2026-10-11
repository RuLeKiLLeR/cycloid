import { Fragment, memo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";

import { isArchiveAvailable } from "../../../../shared/session/eligibility";
import { STATUS_DISPLAY_RAIL } from "../constants";
import { useSyncEffect } from "../hooks/useEffects";
import { type SubagentCollapse, useSubagentCollapse } from "../hooks/useSubagentCollapse";
import type { SessionMetadata } from "../types";
import { compactTimeAgo, groupSessionsByRecency, type SessionGroup } from "../utils/session-grouping";
import { STATUS_DISPLAY_LABEL } from "../utils/status-display";
import {
  familyHasWorking,
  familyNeedsInput,
  segmentSidebarFamilies,
  type SidebarFamily,
  subagentRollup,
} from "../utils/subagent-family";
import { ArchiveIcon, CaretRightIcon } from "./icons";

type Props = {
  sessions: SessionMetadata[];
  onArchive: (session: SessionMetadata) => void;
  onSelect?: () => void;
  parentTitleFor?: (parentId: string) => string | null;
  readOnly?: boolean;
};

const SESSION_INDENT_PADDING_CLASSES = ["pl-4", "pl-[44px]", "pl-[58px]", "pl-[72px]"] as const;
const SESSION_INDENT_RAIL_CLASSES = ["left-[6px]", "left-[20px]", "left-[34px]", "left-[48px]"] as const;
const SESSION_INDENT_CONNECTOR_CLASSES = ["left-[6px]", "left-[6px]", "left-[20px]", "left-[34px]"] as const;
const SIDEBAR_TIME_TICK_MS = 30_000;

function resolveIndentLevel(spawnDepth?: number) {
  const resolvedDepth = spawnDepth && spawnDepth > 0 ? spawnDepth : 1;
  return Math.min(resolvedDepth, 3);
}

const GroupHeader = memo(
  function GroupHeader({ label, count }: { label: string; count: number }) {
    return (
      <li
        aria-label={`${label} (${count})`}
        className="sticky top-0 z-10 px-2 pt-3 pb-1.5 bg-surface-1 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-8px] after:h-2 after:bg-gradient-to-b after:from-surface-1 after:to-surface-1/0"
      >
        <div className="flex items-center gap-2 text-2xs font-mono-tabular text-text-muted">
          <span>{label}</span>
          <span aria-hidden className="flex-1 h-px bg-border" />
          <span className="tabular-nums">{count}</span>
        </div>
      </li>
    );
  },
  (prev, next) => prev.label === next.label && prev.count === next.count,
);

export function SessionList({ sessions, onArchive, onSelect, parentTitleFor, readOnly = false }: Props) {
  const [now, setNow] = useState(() => new Date());

  useSyncEffect(() => {
    const refreshNow = () => setNow(new Date());
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refreshNow();
    };
    const interval = window.setInterval(refreshNow, SIDEBAR_TIME_TICK_MS);
    window.addEventListener("focus", refreshNow);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshNow);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, []);

  const groups: SessionGroup[] = groupSessionsByRecency(sessions, now);
  const repoNames = new Set(
    sessions
      .map((session) => (session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null))
      .filter((repo): repo is string => Boolean(repo)),
  );
  const showRepoName = repoNames.size > 1;
  const collapse = useSubagentCollapse();
  // The session id of the page currently open, so a collapsed family never
  // hides the row for the session the user is actually viewing.
  const activeSessionId = useLocation().pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;
  const common = { onArchive, onSelect, parentTitleFor, now, readOnly, showRepoName };
  return (
    <ul className="list-none m-0 px-2 pb-3" aria-label="Sessions">
      {groups.map((group) => (
        <Fragment key={group.key}>
          <GroupHeader label={group.label} count={group.sessions.length} />
          {segmentSidebarFamilies(group.sessions).map((item) =>
            item.kind === "row" ? (
              <SessionCard key={item.session.sessionId} session={item.session} {...common} />
            ) : (
              <SessionFamily
                key={item.head.sessionId}
                family={item}
                collapse={collapse}
                activeSessionId={activeSessionId}
                common={common}
              />
            ),
          )}
        </Fragment>
      ))}
    </ul>
  );
}

type CardCommon = Omit<CardProps, "session">;

// A parent row plus its sub-agent descendants. A family with a `waiting_for_input`
// descendant renders fully inline (a pending question is never hidden). Otherwise
// the descendants collapse behind a single summary line: expanded by default only
// while work is live, and remembering the user's explicit choice thereafter.
function SessionFamily({
  family,
  collapse,
  activeSessionId,
  common,
}: {
  family: SidebarFamily;
  collapse: SubagentCollapse;
  activeSessionId: string | null;
  common: CardCommon;
}) {
  const { head, descendants } = family;

  if (familyNeedsInput(descendants)) {
    return (
      <>
        <SessionCard session={head} {...common} />
        {descendants.map((child) => (
          <SessionCard key={child.sessionId} session={child} {...common} />
        ))}
      </>
    );
  }

  const defaultCollapsed = !familyHasWorking(descendants);
  // The row for the page you're viewing must always be visible: if the active
  // session is one of these descendants, force the family open regardless of the
  // default or a stored collapse — otherwise the sidebar shows no active row.
  const containsActive = activeSessionId != null && descendants.some((child) => child.sessionId === activeSessionId);
  const collapsed = containsActive ? false : (collapse.overrideFor(head.sessionId) ?? defaultCollapsed);
  const parentTitle = common.parentTitleFor?.(head.sessionId) ?? head.title ?? null;

  return (
    <>
      <SessionCard session={head} {...common} />
      <SubagentSummaryLine
        descendants={descendants}
        collapsed={collapsed}
        parentTitle={parentTitle}
        onToggle={() => collapse.setCollapsed(head.sessionId, !collapsed)}
      />
      {!collapsed && descendants.map((child) => <SessionCard key={child.sessionId} session={child} {...common} />)}
    </>
  );
}

function SubagentSummaryLine({
  descendants,
  collapsed,
  parentTitle,
  onToggle,
}: {
  descendants: SessionMetadata[];
  collapsed: boolean;
  parentTitle: string | null;
  onToggle: () => void;
}) {
  const count = descendants.length;
  const noun = `${count} sub-agent${count === 1 ? "" : "s"}`;
  const rollup = subagentRollup(descendants);
  const forLabel = parentTitle ? ` for ${parentTitle}` : "";
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Show" : "Hide"} ${noun}${forLabel}${collapsed && rollup ? `, ${rollup}` : ""}`}
        className="group/sa relative flex w-full items-center gap-2 rounded-lg mx-0 my-0.5 pl-[26px] pr-2.5 py-1.5 text-left font-mono-tabular text-xs text-text-muted transition-colors duration-200 ease-[var(--ease-editorial)] hover:bg-surface-2 hover:text-text-secondary"
      >
        <CaretRightIcon
          className={`h-3 w-3 shrink-0 text-text-muted transition-transform duration-200 ease-[var(--ease-editorial)] motion-reduce:transition-none ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="text-text-secondary">{noun}</span>
        <span aria-hidden className="flex items-center gap-1">
          {descendants.map((child, index) => {
            const rail = STATUS_DISPLAY_RAIL[child.displayStatus];
            return (
              <span key={child.sessionId ?? index} className={`h-1.5 w-1.5 rounded-full ${rail.bg} ${rail.opacity}`} />
            );
          })}
        </span>
        {collapsed && rollup ? <span className="ml-auto tabular-nums">{rollup}</span> : null}
        {!collapsed ? <span className="ml-auto tabular-nums">hide</span> : null}
      </button>
    </li>
  );
}

type CardProps = {
  session: SessionMetadata;
  onArchive: (session: SessionMetadata) => void;
  onSelect?: () => void;
  parentTitleFor?: (parentId: string) => string | null;
  now: Date;
  readOnly: boolean;
  showRepoName: boolean;
};

function SessionCard({ session, onArchive, onSelect, parentTitleFor, now, readOnly, showRepoName }: CardProps) {
  const navigate = useNavigate();
  const display = session.displayStatus;
  const rail = STATUS_DISPLAY_RAIL[display];
  // One status word family: the chip canon says "Needs you" for a pending
  // question (sentence case is presentation, the words must match).
  const statusLabel = display === "waiting_for_input" ? "Needs you" : STATUS_DISPLAY_LABEL[display].toLowerCase();
  const repoFullName =
    session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : session.repoName;
  const isChild = Boolean(session.parentSessionId);
  const indentLevel = isChild ? resolveIndentLevel(session.spawnDepth) : 0;
  const paddingClass = SESSION_INDENT_PADDING_CLASSES[indentLevel];
  const railLeftClass = SESSION_INDENT_RAIL_CLASSES[indentLevel];
  const connectorLeftClass = SESSION_INDENT_CONNECTOR_CLASSES[indentLevel];
  const parentTitle = session.parentSessionId ? (parentTitleFor?.(session.parentSessionId) ?? null) : null;
  const age = compactTimeAgo(session.createdAt, now);
  const showStatusLabel = display === "waiting_for_input";

  return (
    <li className="list-none">
      <NavLink
        to={`/sessions/${session.sessionId}`}
        onClick={() => onSelect?.()}
        className={({ isActive }) =>
          `group relative block rounded-lg mx-0 my-0.5 ${paddingClass} pr-2.5 py-2.5 transition-colors duration-200 ease-[var(--ease-editorial)] ${
            isActive ? "bg-surface-3" : "hover:bg-surface-2"
          }`
        }
      >
        {({ isActive }) => (
          <>
            {/* Status rail */}
            <span
              aria-hidden
              className={`absolute ${railLeftClass} top-2 bottom-2 w-[3px] origin-center rounded-full transition-[opacity,transform] duration-200 ease-[var(--ease-editorial)] ${rail.bg} ${
                isActive
                  ? "scale-y-100 opacity-100"
                  : `scale-y-75 ${rail.opacity} group-hover:scale-y-90 group-hover:opacity-80`
              }`}
            />

            {/* Child-session corner connector */}
            {isChild && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (session.parentSessionId) {
                    navigate(`/sessions/${session.parentSessionId}`);
                    onSelect?.();
                  }
                }}
                title={
                  parentTitle ? `Open parent: ${parentTitle}` : `Open parent: ${session.parentSessionId?.slice(0, 8)}`
                }
                aria-label={`Open parent session ${parentTitle ?? session.parentSessionId?.slice(0, 8)}`}
                className={`absolute ${connectorLeftClass} top-0 h-5 w-4 cursor-pointer text-text-muted transition-colors duration-150 hover:text-text-secondary`}
              >
                <svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden className="block">
                  <path d="M2 0 V12 a4 4 0 0 0 4 4 H14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                </svg>
              </button>
            )}

            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={`block flex-1 min-w-0 truncate text-base leading-snug font-medium ${
                    isActive ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary"
                  } transition-colors duration-200`}
                >
                  {session.title || <span className="font-mono-tabular text-xs">{session.sessionId.slice(0, 8)}</span>}
                </span>
                <span className="text-xs font-mono-tabular text-text-muted tabular-nums shrink-0">{age}</span>
              </div>

              <div className="mt-1 flex items-center gap-2 text-xs font-mono-tabular text-text-muted min-w-0">
                {showRepoName && repoFullName && (
                  <>
                    <span className="truncate min-w-0" title={repoFullName} aria-label={`Repository ${repoFullName}`}>
                      {session.repoName ?? repoFullName}
                    </span>
                    {showStatusLabel ? (
                      <span aria-hidden className="opacity-40">
                        ·
                      </span>
                    ) : null}
                  </>
                )}
                {showStatusLabel ? <span className="shrink-0 font-medium text-text-primary">{statusLabel}</span> : null}
                {/* Right rail: PR badge (when present) + archive button.
                    Both can be visible — archiving a session with a PR is a
                    legitimate cleanup action, so the archive control must not
                    hide behind the PR badge. */}
                <span className="ml-auto inline-flex items-center gap-2 shrink-0">
                  {session.prUrl &&
                    (session.prDraft ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning">
                        Draft
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs text-success">
                        PR
                      </span>
                    ))}
                  {!readOnly && isArchiveAvailable(session.phase) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onArchive(session);
                      }}
                      aria-label={session.prUrl ? "Archive and close PR" : "Archive session"}
                      title={session.prUrl ? "Archive and close PR" : "Archive session"}
                      className="inline-flex items-center justify-center min-h-[28px] min-w-[28px] rounded-full opacity-60 md:opacity-0 md:group-hover:opacity-60 md:focus-within:opacity-100 hover:opacity-100 hover:bg-surface-3 transition-[opacity,background-color] duration-150 text-text-muted hover:text-error cursor-pointer"
                    >
                      <ArchiveIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>
            </div>
          </>
        )}
      </NavLink>
    </li>
  );
}
