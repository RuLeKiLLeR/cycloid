import { useOutletContext } from "react-router";

import { displayStatusFromSession } from "../../../../../shared/session/display-status.js";
import type { SessionTokenUsage } from "../../hooks/session-state/types";
import type { SessionDetail } from "../../types";
import { parseRepoFullNameFromUrl } from "../../utils/repos";
import { formatProviderLabel } from "../../utils/transcript";
import type { LayoutContext } from "../Layout";
import { Badge, Button, cx, EmptyState } from "../ui";
import {
  type ContextUsage,
  deriveRuntimeActions,
  deriveSandboxConnection,
  deriveSandboxMeta,
  deriveSandboxState,
  formatContextReadout,
  formatExactContextReadout,
  formatExactTokenCount,
  formatUsd,
  hasTokenUsage,
  mergeExactContextUsage,
  RUNTIME_ACTIVITY_KIND_LABELS,
  type RuntimeActionId,
  type RuntimeLogEntry,
} from "./runtime";
import { sessionDisplayBranch } from "./workbench";

type Props = {
  session: SessionDetail;
  logTail: RuntimeLogEntry[];
  contextUsage: ContextUsage | null;
  tokenUsage: SessionTokenUsage;
  pendingAction: RuntimeActionId | null;
  onAction: (id: RuntimeActionId) => void;
};

const ACTION_LABELS: Record<RuntimeActionId, string> = {
  stop: "Stop",
  wake: "Wake",
  archive: "Archive",
};

function formatSpawnDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LogStatusDot({ status }: { status: RuntimeLogEntry["status"] }) {
  const dotClass =
    status === "error"
      ? "bg-error"
      : status === "running"
        ? "bg-live review-loop-breathe"
        : status === "completed"
          ? "bg-text-secondary"
          : "bg-text-muted";
  return <span aria-hidden className={cx("status-dot size-1.5 shrink-0 rounded-full", dotClass)} />;
}

function ReadoutRow({ label, value, breakAll }: { label: string; value: string; breakAll?: boolean }) {
  return (
    <>
      <dt className="eyebrow pt-0.5">{label}</dt>
      <dd
        className={cx("min-w-0 font-mono-tabular text-text-secondary", breakAll ? "break-all" : "truncate")}
        title={value}
      >
        {value}
      </dd>
    </>
  );
}

/**
 * Runtime tab: operational cockpit for the session's sandbox — state, identity
 * and provenance, lifecycle actions with real endpoints, agent config, exact
 * context usage, and a categorized recent-activity tail. Everything renders
 * from data the session page already receives; sections and readouts are
 * omitted (never faked) when their data has not reached the client.
 */
export function SessionRuntimePanel({ session, logTail, contextUsage, tokenUsage, pendingAction, onAction }: Props) {
  // Outlet context is absent in isolated renders (tests); treat that as a
  // normal, non-impersonated view.
  const layoutContext = useOutletContext<LayoutContext | null>();
  const isSupportView = Boolean(layoutContext?.user?.impersonation?.readOnly);

  const sandbox = deriveSandboxState(session);
  const connection = deriveSandboxConnection(session);
  const meta = deriveSandboxMeta(session);
  const actions = isSupportView ? [] : deriveRuntimeActions(session);
  const modelLabel = session.model?.modelID ?? null;
  const providerLabel = session.model?.providerID ?? null;
  const providerDisplayLabel = formatProviderLabel(providerLabel ?? undefined) ?? providerLabel;
  const reasoningEffort = session.reasoningEffort ?? null;
  const branch = sessionDisplayBranch(session);
  const repo = session.repoUrl ? parseRepoFullNameFromUrl(session.repoUrl) : null;
  const repoLabel = repo ? `${repo.owner}/${repo.repo}` : null;
  const spawnMs = session.spawnDurationMs ?? null;
  const exactContextUsage = mergeExactContextUsage(tokenUsage, contextUsage);
  const hasUsage = hasTokenUsage(tokenUsage);
  const usageReadout = exactContextUsage
    ? hasUsage
      ? formatExactContextReadout(exactContextUsage)
      : formatContextReadout(exactContextUsage)
    : null;
  // The activity tail implies live work; a settled session gets no tail at all
  // (the thread and Report already hold the history).
  const displayStatus = displayStatusFromSession(session);
  const isTerminal =
    displayStatus === "completed" ||
    displayStatus === "failed" ||
    displayStatus === "archived" ||
    displayStatus === "stopped";

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <p className="eyebrow">Environment</p>
        {/* One badge: the label is the sandbox state, the dot carries the
            bridge-connection state (violet only while live — accent
            discipline; disconnected/unknown stays grayscale). */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={sandbox.live ? "accent" : "default"}
            title={connection ? `${sandbox.label} · ${connection.label}` : sandbox.label}
          >
            <span
              aria-hidden
              className={cx(
                "status-dot size-1.5 shrink-0 rounded-full",
                (connection ? connection.live : sandbox.live) ? "bg-live review-loop-breathe" : "bg-text-muted",
              )}
            />
            {sandbox.label}
          </Badge>
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {actions.map((id) => (
              <Button
                key={id}
                size="sm"
                variant={id === "archive" ? "danger" : "secondary"}
                disabled={pendingAction !== null}
                onClick={() => onAction(id)}
              >
                {ACTION_LABELS[id]}
              </Button>
            ))}
          </div>
        )}
        <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-2 pt-1 text-sm">
          {repoLabel && <ReadoutRow label="Repo" value={repoLabel} />}
          {branch && <ReadoutRow label="Branch" value={branch} breakAll />}
          {/* Sandbox identity/provenance is operator debug data — support views only. */}
          {isSupportView && (
            <>
              {meta.sandboxId && <ReadoutRow label="Sandbox ID" value={meta.sandboxId} breakAll />}
              {meta.runtime && <ReadoutRow label="Runtime" value={meta.runtime} />}
              {meta.bootMode && <ReadoutRow label="Boot" value={meta.bootMode} />}
              {meta.imageVersion && <ReadoutRow label="Image" value={meta.imageVersion} />}
              {spawnMs !== null && <ReadoutRow label="Spawn time" value={formatSpawnDuration(spawnMs)} />}
            </>
          )}
        </dl>
      </section>

      {(modelLabel || providerDisplayLabel || reasoningEffort) && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Agent</p>
          <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-2 text-sm">
            {modelLabel && <ReadoutRow label="Model" value={modelLabel} />}
            {providerDisplayLabel && <ReadoutRow label="Provider" value={providerDisplayLabel} />}
            {reasoningEffort && <ReadoutRow label="Reasoning" value={reasoningEffort} />}
          </dl>
        </section>
      )}

      {hasUsage && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Usage</p>
          {/* Two rows: the number you care about and what it cost. The
              input/output/cache split is noise at this surface. */}
          <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-2 text-sm">
            <ReadoutRow label="Total tokens" value={formatExactTokenCount(tokenUsage.totalTokens)} />
            <ReadoutRow label="Cost" value={formatUsd(tokenUsage.cost)} />
          </dl>
        </section>
      )}

      {exactContextUsage && usageReadout && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Context</p>
          <p className="px-0.5 font-mono-tabular text-sm text-text-secondary">{usageReadout}</p>
          {exactContextUsage.events.length > 0 && (
            <details>
              <summary className="cursor-pointer px-0.5 text-sm text-text-muted">
                Compaction history ({exactContextUsage.events.length})
              </summary>
              <ul className="flex flex-col gap-px pt-1">
                {exactContextUsage.events.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 px-2 py-1">
                    <span className="w-24 shrink-0 text-2xs text-text-muted">{entry.label}</span>
                    {entry.detail && (
                      <span
                        className="min-w-0 flex-1 truncate font-mono-tabular text-xs text-text-secondary"
                        title={entry.detail}
                      >
                        {entry.detail}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {!isTerminal && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Recent activity</p>
          {logTail.length === 0 ? (
            <EmptyState
              className="px-2 py-6"
              headingLevel={4}
              title="No activity yet"
              description="Tool calls and work steps will appear here as the agent runs."
            />
          ) : (
            /* Static log rows: no hover treatment — hover implies navigation. */
            <ul className="flex flex-col gap-px">
              {logTail.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 px-2 py-1.5">
                  <LogStatusDot status={entry.status} />
                  <span
                    className={cx("w-14 shrink-0 text-2xs", entry.kind === "error" ? "text-error" : "text-text-muted")}
                  >
                    {RUNTIME_ACTIVITY_KIND_LABELS[entry.kind]}
                  </span>
                  {entry.label && <span className="shrink-0 text-xs text-text-secondary">{entry.label}</span>}
                  {entry.detail && (
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted" title={entry.detail}>
                      {entry.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
