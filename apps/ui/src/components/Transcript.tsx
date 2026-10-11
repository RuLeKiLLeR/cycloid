import { memo, Suspense, useCallback, useMemo, useState } from "react";

import { MEMORY_FEATURE_DISABLED, MEMORY_TRANSCRIPT_VISUALS_DISABLED } from "../../../../shared/constants/memory";
import { projectCustomerActivityEvents } from "../../../../shared/transcript/customer-activity-projector.js";
import { isReviewLoopWorktreeBlockError } from "../../../../shared/transcript/review-loop-worktree-block.js";
import { formatSessionErrorMessage } from "../../../../shared/types/error-codes.js";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan.js";
import { diffViewerProps } from "../constants/diff-theme";
import { getToolCategory, isBatchTool, isFileChangeTool, isTodoTool, normalizeToolName } from "../constants/tools";
import { readDiffViewPreference } from "../hooks/useDiffViewPreference";
import { useSyncEffect } from "../hooks/useEffects";
import { useTransitionReveal } from "../hooks/useTransitionReveal";
import { lazyWithRetry } from "../lazy-with-retry";
import type { ActivityEvent, PromptRow } from "../types";
import { isPlanText } from "../utils/plan-summary";
import { formatTimestamp } from "../utils/time";
import {
  type AgentProgressGroup,
  type AgentTimelineEvent,
  batchCallSummary,
  formatProviderLabel,
  groupConsecutiveToolCalls,
  normalizeQuestionOption,
  type PostExecutionPanelItem,
  reasoningSummaryLabel,
  toolRunCurrentActionSummary,
  type ToolRunGroup,
  trailingItemSelfAnimates,
  type TranscriptRenderItem,
} from "../utils/transcript";
import { BotAvatar } from "./BotAvatar";
import { CaretRightIcon, RefreshIcon, SpinnerIcon, TodoStatusIcon, WarningIcon } from "./icons";
import { InlineInput } from "./InlineInput";
import { MarkdownEventContent } from "./MarkdownEventContent";
import { MessageBubble } from "./MessageBubble";
import { PlanCard } from "./PlanCard";
import { SessionProgressIndicator } from "./SessionProgressIndicator";
import { Button } from "./ui";
import { verificationEvidenceFromMetadata, VerificationEvidenceList } from "./VerificationEvidenceList";

const LazyReactDiffViewer = lazyWithRetry(() => import("react-diff-viewer-continued"));

type Props = {
  prompt: PromptRow;
  events: ActivityEvent[];
  isActive: boolean;
  showProgressIndicator: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  supportView?: boolean;
  hideAvatar: boolean;
  planApprovalPending: boolean;
  planRevision: number | null;
  planStatus: SessionPlanStatus | null;
  planAutoReason?: string | null;
  onDiscussPlan: (() => void) | null;
};

function formatRetryTime(nextRetryAt?: string): string | null {
  return formatTimestamp(nextRetryAt);
}

const TRANSCRIPT_RENDER_WINDOW_THRESHOLD = 360;
const TRANSCRIPT_INITIAL_RENDER_ITEM_LIMIT = 260;
const TRANSCRIPT_RENDER_ITEM_INCREMENT = 260;
const ACTIVE_TRANSCRIPT_TAIL_ITEM_COUNT = 80;
const TOOL_GROUP_OPEN_INITIAL_LIMIT = 120;
const TOOL_GROUP_OPEN_INCREMENT = 120;
const MEMORY_TRANSCRIPT_ROWS_ENABLED = !MEMORY_FEATURE_DISABLED && !MEMORY_TRANSCRIPT_VISUALS_DISABLED;

type Todo = { id?: number; content?: string; status?: string };

function TodoWriteDetails({ input }: { input: Record<string, unknown> }) {
  const todos = input.todos as Todo[] | undefined;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-text-secondary list-none pl-0">
      {todos.map((t, i) => (
        <li key={t.id ?? i} className={`flex items-start gap-2${t.status === "completed" ? " opacity-60" : ""}`}>
          <TodoStatusIcon status={t.status} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className={t.status === "completed" ? "line-through" : ""}>{t.content ?? "(untitled)"}</span>
        </li>
      ))}
    </ul>
  );
}

type BatchCall = { tool: string; parameters?: Record<string, unknown> };

function BatchToolDetails({ input }: { input: Record<string, unknown> }) {
  const calls = input.tool_calls as BatchCall[] | undefined;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {calls.map((call, i) => {
        const summary = batchCallSummary(call);
        return (
          <div key={`${call.tool}-${i}`} className="flex flex-wrap items-start gap-2 px-3 py-1.5">
            <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent text-2xs font-medium shrink-0">
              {call.tool}
            </span>
            {summary && <span className="min-w-0 flex-1 break-words text-text-secondary text-xs">{summary}</span>}
          </div>
        );
      })}
    </div>
  );
}

const ToolInputDetails = memo(
  function ToolInputDetails({ input, open }: { input: Record<string, unknown>; open: boolean }) {
    const entries = useMemo(() => Object.entries(input).filter(([, v]) => v !== undefined && v !== null), [input]);
    if (!open || entries.length === 0) return null;

    return (
      <div className="mt-2 space-y-1">
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-start gap-2 text-xs">
            <span className="text-text-muted shrink-0">{key}:</span>
            {typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? (
              <span className="text-text-secondary whitespace-pre-wrap break-all">{String(val)}</span>
            ) : (
              <pre className="text-text-secondary whitespace-pre-wrap break-all m-0">
                {JSON.stringify(val, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    );
  },
  (prev, next) => prev.input === next.input && prev.open === next.open,
);

const RawAgentRuntimeDetails = memo(function RawAgentRuntimeDetails({
  evt,
}: {
  evt: ActivityEvent & { type: "raw_agent_runtime" };
}) {
  const [open, setOpen] = useState(false);
  const payload = useMemo(() => (open ? JSON.stringify(evt.data, null, 2) : null), [evt.data, open]);

  return (
    <details
      key={`raw-${evt.id}`}
      className="session-stack-surface overflow-hidden font-mono text-xs"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex flex-wrap items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-2">
        <span className="px-1.5 py-0.5 rounded bg-warning-soft text-warning text-2xs font-medium">
          {evt.partType || evt.eventType || "unknown"}
        </span>
        <span className="text-text-muted text-2xs">raw event</span>
      </summary>
      {open ? (
        <pre className="px-3 py-2 text-xs text-text-secondary overflow-x-auto max-h-48 border-t border-border">
          {payload}
        </pre>
      ) : (
        <div aria-hidden="true" />
      )}
    </details>
  );
});

function InlineDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  // Per-browser preference (Settings → Preferences → Display). Read once per
  // mount: diffs render fresh on navigation, so a settings change applies the
  // next time a transcript mounts.
  const [splitView] = useState(() => readDiffViewPreference() === "split");
  return (
    <div className="border-t border-border">
      <div className="max-h-[400px] overflow-y-auto">
        <Suspense fallback={<div className="px-3 py-2 text-xs text-text-muted">Loading diff…</div>}>
          <LazyReactDiffViewer
            oldValue={oldStr}
            newValue={newStr}
            {...diffViewerProps}
            splitView={splitView}
            useDarkTheme
          />
        </Suspense>
      </div>
    </div>
  );
}

function QuestionOptions({
  id,
  options,
  onSubmit,
  disabled,
}: {
  id: string;
  options: Array<string | { label: string; description?: string }>;
  onSubmit: (id: string, value: string) => void;
  disabled?: boolean;
}) {
  const [showFreeText, setShowFreeText] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const isDisabled = disabled || submitted;

  if (showFreeText) {
    return (
      <InlineInput
        id={id}
        onSubmit={(qid, val) => {
          setSubmitted(true);
          onSubmit(qid, val);
        }}
        placeholder="Type your answer…"
        submitLabel="Answer"
        onCancel={() => setShowFreeText(false)}
        disabled={isDisabled}
      />
    );
  }

  const normalizedOptions = options.map(normalizeQuestionOption);
  const hasExplicitFreeTextOption = normalizedOptions.some(
    (opt) => opt.label.trim().toLowerCase() === "something else",
  );

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {normalizedOptions.map(({ label, description }) => {
        const opensFreeText = label.trim().toLowerCase() === "something else";
        return (
          <Button
            key={label}
            type="button"
            title={description}
            disabled={isDisabled}
            onClick={() => {
              if (opensFreeText) {
                setShowFreeText(true);
                return;
              }
              setSubmitted(true);
              onSubmit(id, label);
            }}
            variant="secondary"
            size="lg"
            className="border-accent-soft-border bg-accent-soft px-3 text-xs hover:bg-accent-soft"
          >
            {label}
          </Button>
        );
      })}
      {!hasExplicitFreeTextOption ? (
        <Button
          type="button"
          disabled={isDisabled}
          onClick={() => setShowFreeText(true)}
          variant="secondary"
          size="lg"
          className="px-3 text-xs text-text-muted"
        >
          Other…
        </Button>
      ) : null}
    </div>
  );
}

function toolSummaryText(summary: string, tool: string): string {
  const trimmedSummary = summary.trim();
  const trimmedTool = tool.trim();
  if (!trimmedSummary || !trimmedTool) return trimmedSummary;

  const summaryLower = trimmedSummary.toLowerCase();
  const toolLower = trimmedTool.toLowerCase();
  if (summaryLower === toolLower) return "";
  if (summaryLower.startsWith(`${toolLower} `)) return trimmedSummary.slice(trimmedTool.length + 1).trimStart();
  return trimmedSummary;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toolRunTallyLabel(group: ToolRunGroup, isActive: boolean): string {
  const { tally } = group;
  const parts = [
    tally.reads > 0 ? `${isActive ? "Reading" : "Read"} ${pluralize(tally.reads, "file")}` : null,
    tally.searches > 0 ? `${isActive ? "Searching" : "Searched"} ${pluralize(tally.searches, "place")}` : null,
    tally.edits > 0 ? `${isActive ? "Editing" : "Edited"} ${pluralize(tally.edits, "file")}` : null,
    tally.commands > 0 ? `${isActive ? "Running" : "Ran"} ${pluralize(tally.commands, "command")}` : null,
    tally.other > 0 ? `${isActive ? "Working through" : "Worked through"} ${pluralize(tally.other, "step")}` : null,
  ].filter((part): part is string => Boolean(part));

  if (parts.length > 0) return `${parts.join(" · ")}${isActive ? "…" : ""}`;
  return `${isActive ? "Working through" : "Worked through"} ${pluralize(group.events.length, "step")}${isActive ? "…" : ""}`;
}

function ToolRunGroupBlock({
  group,
  isOpen,
  onToggle,
  repoOwner,
  repoName,
  supportView,
  isActive,
}: {
  group: ToolRunGroup;
  isOpen: boolean;
  onToggle: () => void;
  repoOwner?: string | null;
  repoName?: string | null;
  supportView?: boolean;
  isActive: boolean;
}) {
  const [nestedToggles, setNestedToggles] = useState<Set<string>>(new Set());
  const [visibleToolEventCount, setVisibleToolEventCount] = useState(TOOL_GROUP_OPEN_INITIAL_LIMIT);
  const visibleToolEvents =
    group.events.length > TOOL_GROUP_OPEN_INITIAL_LIMIT ? group.events.slice(0, visibleToolEventCount) : group.events;
  const hiddenToolEventCount = Math.max(0, group.events.length - visibleToolEvents.length);
  const latestToolEvent = group.events[group.events.length - 1];
  const currentActionSummary = isActive && latestToolEvent ? toolRunCurrentActionSummary(latestToolEvent) : "";
  const summaryLabel = toolRunTallyLabel(group, isActive);
  const toggleNestedTool = useCallback((id: string) => {
    setNestedToggles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div data-tool-run-group="true" className="font-mono text-xs">
      <button
        type="button"
        onClick={onToggle}
        data-tool-run-summary="true"
        className="group/run flex w-full cursor-pointer items-center gap-x-2 gap-y-1 py-0.5 text-left transition-colors duration-150 hover:text-text-primary"
      >
        {isActive ? (
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
        ) : (
          <CaretRightIcon
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
          />
        )}
        <span className="text-xs font-medium text-text-secondary">{summaryLabel}</span>
        {group.hasError ? (
          <span className="rounded px-1.5 py-0.5 text-2xs font-medium bg-error-soft text-error">Error</span>
        ) : null}
        {currentActionSummary ? (
          <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{currentActionSummary}</span>
        ) : null}
      </button>
      {isOpen && (
        <div className="ml-[7px] space-y-0.5 border-l border-border/70 pb-0.5 pl-3 pt-0.5">
          {visibleToolEvents.map((event) =>
            renderActivityEvent(event, {
              isActive: false,
              toggledTools: nestedToggles,
              toggleTool: toggleNestedTool,
              repoOwner: repoOwner ?? null,
              repoName: repoName ?? null,
              supportView: supportView ?? false,
              insideToolRunGroup: true,
              sessionId: "",
              planApprovalPending: false,
              planRevision: null,
              planStatus: null,
              planPromptFailed: false,
              onDiscussPlan: null,
            }),
          )}
          {hiddenToolEventCount > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setVisibleToolEventCount((count) => count + TOOL_GROUP_OPEN_INCREMENT)}
              className="h-auto w-full justify-start bg-transparent py-1 text-left font-normal text-text-muted hover:text-text-primary"
            >
              Show {Math.min(TOOL_GROUP_OPEN_INCREMENT, hiddenToolEventCount)} more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function renderAgentProgressEvent(evt: ActivityEvent & { type: "agent_progress" }): React.ReactNode {
  const isDelayed = evt.step === "workspace_setup_delayed";
  const isFailed = evt.step === "workspace_setup_failed";
  const toneClasses = isFailed
    ? "bg-error-soft text-error border-error-soft-border"
    : isDelayed
      ? "bg-warning-soft text-warning border-warning-soft-border"
      : "bg-surface-2 text-text-secondary border-transparent";

  return (
    <div key={`ap-${evt.id}`} className="flex flex-wrap items-center gap-2 py-0.5 font-mono text-xs text-text-muted">
      <span className={`rounded border px-1.5 py-0.5 text-2xs font-medium ${toneClasses}`}>{evt.label}</span>
    </div>
  );
}

function AgentProgressGroupRow({ group, isActive }: { group: AgentProgressGroup; isActive: boolean }) {
  // Transient progress ("Waiting for model", "Starting agent", ...) is only the
  // "not hung" signal while the model works. Once the turn produces visible
  // output the group is no longer trailing, so it carries no information - drop
  // it instead of leaving a stale muted row behind. Only the trailing group (the
  // current tail state) survives: a live spinner while active, or a settled line
  // if the model never got past it.
  if (!group.trailing) return null;

  if (isActive) {
    return (
      <div className="font-mono text-xs">
        <div className="control-lg flex flex-wrap items-center gap-x-2 gap-y-1 px-4">
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="text-xs font-medium text-text-secondary">{group.latest.label}</span>
        </div>
      </div>
    );
  }

  return <div className="py-0.5 font-mono text-xs text-text-muted">{group.latest.label}</div>;
}

type EventRenderContext = {
  isActive: boolean;
  /** Id of the in-flight (still streaming) text event; only it renders as plain. */
  streamingEventId?: string | null;
  /** Whether this prompt's turn has finished (so the plan card can collapse even
   * while a later turn is still running — a completed plan turn keeps
   * `result === null`, which would otherwise read as still-active). */
  promptCompleted?: boolean;
  /** Id of the single text event rendered as the plan card. The plan can appear
   * more than once in a turn (streamed answer + a recovered/result copy); only
   * this one becomes a card, the rest are suppressed to avoid a duplicate wall. */
  planTextEventId?: string | null;
  toggledTools: Set<string>;
  toggleTool: (id: string) => void;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  promptId?: string;
  sessionId: string;
  planApprovalPending: boolean;
  planRevision: number | null;
  planStatus: SessionPlanStatus | null;
  planAutoReason?: string | null;
  planPromptFailed: boolean;
  onDiscussPlan: (() => void) | null;
  repoOwner?: string | null;
  repoName?: string | null;
  supportView?: boolean;
  /** True when rendering inside a tool-run group, which already draws the
   * timeline rail. Nested renderers suppress their own left rail to avoid a
   * double line. */
  insideToolRunGroup?: boolean;
};

const POST_EXECUTION_TIMELINE_EVENTS = new Set(["git.push", "publish_gate.result", "verification.result", "pr.open"]);

function isPostExecutionTimelineEvent(event: ActivityEvent): event is AgentTimelineEvent {
  return event.type === "agent_timeline" && POST_EXECUTION_TIMELINE_EVENTS.has(event.eventType);
}

function buildTranscriptRenderItems(events: ActivityEvent[]): TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let activityBuffer: ActivityEvent[] = [];
  const postExecutionEvents = events.filter(isPostExecutionTimelineEvent);
  const firstPostExecutionId = postExecutionEvents[0]?.id;
  let postExecutionInserted = false;

  const flushActivity = () => {
    if (activityBuffer.length === 0) return;
    items.push(...groupConsecutiveToolCalls(activityBuffer));
    activityBuffer = [];
  };

  const insertPostExecution = () => {
    if (postExecutionInserted || postExecutionEvents.length === 0) return;
    postExecutionInserted = true;
    const first = postExecutionEvents[0];
    items.push({
      type: "post_execution_panel",
      id: `post-exec-${first?.id ?? "start"}`,
      events: postExecutionEvents,
    });
  };

  for (const event of events) {
    if (isPostExecutionTimelineEvent(event)) {
      flushActivity();
      if (event.id === firstPostExecutionId) insertPostExecution();
      continue;
    }
    activityBuffer.push(event);
  }
  flushActivity();
  insertPostExecution();
  return items;
}

function windowTranscriptRenderItems(
  items: TranscriptRenderItem[],
  visibleLimit: number,
  isActive: boolean,
): { items: TranscriptRenderItem[]; hiddenCount: number; windowed: boolean } {
  if (items.length <= TRANSCRIPT_RENDER_WINDOW_THRESHOLD || visibleLimit >= items.length) {
    return { items, hiddenCount: 0, windowed: false };
  }

  if (isActive) {
    const headCount = Math.max(0, visibleLimit - ACTIVE_TRANSCRIPT_TAIL_ITEM_COUNT);
    const tailStart = Math.max(headCount, items.length - ACTIVE_TRANSCRIPT_TAIL_ITEM_COUNT);
    const hiddenCount = Math.max(0, tailStart - headCount);
    return {
      items:
        hiddenCount > 0
          ? [
              ...items.slice(0, headCount),
              { type: "window_gap", id: "active-window-gap", hiddenCount },
              ...items.slice(tailStart),
            ]
          : items.slice(0, visibleLimit),
      hiddenCount,
      windowed: true,
    };
  }

  return {
    items: items.slice(0, visibleLimit),
    hiddenCount: items.length - visibleLimit,
    windowed: true,
  };
}

function latestByEventType(events: AgentTimelineEvent[], eventType: string): AgentTimelineEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].eventType === eventType) return events[i];
  }
  return undefined;
}

function postExecutionStatus(events: AgentTimelineEvent[]): string {
  const prEvent = latestByEventType(events, "pr.open");
  const terminalVerification = latestTerminalVerificationEvent(events);
  if (prEvent && prEvent.metadata?.superseded === true) return "Superseded";
  if (isBlockedPrPublishEvent(prEvent) || prEvent?.status === "failed") return "Blocked";
  if (prEvent?.status === "completed") return "PR opened";
  if (terminalVerification?.status === "blocked" || terminalVerification?.status === "failed") return "Blocked";
  if (events[events.length - 1]?.status === "started") return "Running";
  return "No PR";
}

function postExecutionStatusTone(status: string): string {
  if (status === "Blocked") return "bg-error-soft text-error";
  if (status === "Superseded") return "bg-surface-2 text-text-muted";
  if (status === "Running") return "bg-warning-soft text-warning";
  if (status === "No PR") return "bg-surface-2 text-text-muted";
  return "bg-success-soft text-success";
}

function isConfiguredTestGateEvent(event: AgentTimelineEvent): boolean {
  return (
    event.metadata?.gate === "tests" &&
    (event.eventType === "publish_gate.result" || event.eventType === "verification.result")
  );
}

function verifyTestEvents(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  return events.filter(isConfiguredTestGateEvent);
}

function metadataString(event: AgentTimelineEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isBlockedPrPublishEvent(event: AgentTimelineEvent | undefined): boolean {
  if (event?.metadata?.superseded === true) return false;
  return Boolean(
    event && (event.status === "blocked" || (event.status === "failed" && metadataString(event, "reason"))),
  );
}

function terminalVerificationEvents(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  return events.filter((event) => event.eventType === "verification.result" && !isConfiguredTestGateEvent(event));
}

function latestTerminalVerificationEvent(events: AgentTimelineEvent[]): AgentTimelineEvent | undefined {
  const terminalEvents = terminalVerificationEvents(events);
  return terminalEvents[terminalEvents.length - 1];
}

function latestVerifyTestCommandEvents(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  const byCommand = new Map<string, AgentTimelineEvent>();
  for (const event of verifyTestEvents(events)) {
    const command = typeof event.metadata?.command === "string" ? event.metadata.command : "";
    if (command) byCommand.set(command, event);
  }
  return [...byCommand.values()];
}

function PostExecutionPanel({
  item,
  isOpen,
  onToggle,
}: {
  item: PostExecutionPanelItem;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const status = postExecutionStatus(item.events);
  const revealStatus = useTransitionReveal(status, "PR opened");
  const commandEvents = latestVerifyTestCommandEvents(item.events);
  const terminalEvents = terminalVerificationEvents(item.events);
  return (
    <div className="session-stack-surface overflow-hidden font-mono text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="w-full cursor-pointer text-left transition-colors duration-150 hover:bg-surface-2/70"
      >
        <div className="control-lg flex flex-wrap items-center gap-x-2 gap-y-1 px-4">
          <CaretRightIcon
            className={`h-3.5 w-3.5 text-text-muted transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
          />
          <span className="text-xs font-medium text-text-secondary">Publish</span>
          <span
            className={`rounded px-1.5 py-0.5 text-2xs font-medium ${postExecutionStatusTone(status)} ${revealStatus ? "review-loop-settle" : ""}`}
          >
            {status}
          </span>
        </div>
      </button>
      {isOpen && (
        <div className="space-y-2 border-t border-border/80 px-4 py-3 text-text-secondary">
          {commandEvents.length > 0 ? (
            <div className="space-y-1">
              {commandEvents.map((event) => (
                <div key={event.id} className="flex flex-wrap items-start gap-2">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-text-muted">
                    {event.status ?? "recorded"}
                  </span>
                  <code className="min-w-0 flex-1 break-all rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                    {String(event.metadata?.command)}
                  </code>
                </div>
              ))}
            </div>
          ) : null}
          {terminalEvents.length > 0 ? (
            <div className="space-y-1">
              {terminalEvents.map((event) => {
                const evidence = verificationEvidenceFromMetadata(event.metadata);
                return (
                  <div key={event.id} className="space-y-1">
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-text-muted">
                        {event.status ?? "recorded"}
                      </span>
                      <span className="min-w-0 flex-1 break-words">
                        <MarkdownEventContent content={event.summary} renderAsPlainText={false} variant="inline" />
                      </span>
                    </div>
                    <VerificationEvidenceList evidence={evidence} />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Small type glyph for a timeline row — `$` for commands, icons for file ops. */
function ToolGlyph({ tool }: { tool: string }) {
  const t = normalizeToolName(tool);
  const wrap = "flex h-4 w-4 shrink-0 items-center justify-center text-text-muted";
  if (t === "bash") {
    return (
      <span className={`${wrap} font-mono`} aria-label="command" title="command">
        $
      </span>
    );
  }
  const icon = (body: React.ReactNode) => (
    <span className={wrap} aria-label={t} title={t}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} className="h-3.5 w-3.5">
        {body}
      </svg>
    </span>
  );
  switch (t) {
    case "read":
      return icon(
        <>
          <path d="M4 2h5l3 3v9H4z" />
          <path d="M9 2v3h3" />
        </>,
      );
    case "edit":
    case "write":
    case "apply_patch":
    case "patch":
      return icon(<path d="M11 2l3 3-8 8-4 1 1-4z" />);
    case "grep":
    case "glob":
    case "ls":
      return icon(
        <>
          <circle cx="7" cy="7" r="4" />
          <path d="M13 13l-3-3" />
        </>,
      );
    default:
      return icon(<circle cx="8" cy="8" r="2.5" />);
  }
}

function renderActivityEvent(evt: ActivityEvent, ctx: EventRenderContext): React.ReactNode {
  if (evt.type === "customer_activity") {
    const details = Array.isArray(evt.details) ? evt.details : [];
    const overflow = evt.overflow ?? 0;
    if (details.length === 0) {
      return (
        <div key={evt.id} className="text-xs text-text-secondary leading-relaxed">
          {evt.summary}
        </div>
      );
    }
    // Inside a tool-run group the rail is already drawn by the group; only add
    // this list's own rail when standing alone (top-level, e.g. an all-patch run).
    const railClasses = ctx.insideToolRunGroup
      ? ""
      : `border-l pl-3 ${evt.status === "error" ? "border-warning-soft-border" : "border-border/60"}`;
    return (
      <ul key={evt.id} className={`list-none space-y-0.5 text-xs text-text-secondary ${railClasses}`}>
        {details.map((detail, index) => (
          <li
            key={`${evt.id}-${detail.tool}-${detail.content}-${index}`}
            className="flex items-start gap-2 break-words"
          >
            <ToolGlyph tool={detail.tool} />
            <code className="min-w-0 break-all font-mono text-xs text-text-secondary">{detail.content}</code>
          </li>
        ))}
        {overflow > 0 && <li className="text-text-muted text-xs italic">+{overflow} more</li>}
      </ul>
    );
  }
  if (evt.type === "tool_call") {
    return renderToolCall(evt, ctx);
  }
  if (evt.type === "reasoning") {
    return (
      <details key={`reasoning-${evt.id}`} className="text-sm text-text-muted italic leading-relaxed">
        <summary className="cursor-pointer select-none text-xs py-0.5 opacity-60 hover:opacity-100 transition-opacity">
          {reasoningSummaryLabel(evt, ctx.isActive)}
        </summary>
        <div className="pl-3 border-l border-border/40 mt-1 opacity-70">
          <MarkdownEventContent content={evt.text} renderAsPlainText={ctx.isActive} />
        </div>
      </details>
    );
  }
  if (evt.type === "patch") {
    return (
      <div
        key={`patch-${evt.id}`}
        className="flex flex-wrap items-start gap-2 py-0.5 font-mono text-xs text-text-muted"
      >
        <span className="px-1.5 py-0.5 rounded bg-success-soft text-success text-2xs font-medium">changed</span>
        <span className="min-w-0 flex-1 break-words">{evt.files.join(", ")}</span>
      </div>
    );
  }
  if (evt.type === "memory_usage") {
    return renderMemoryUsageRow(`memory-${evt.id}`, evt.activeMemoryIds.length || evt.activeMemories.length, "applied");
  }
  if (evt.type === "memory_recall_usage") {
    if (evt.eventName !== "memory_recall.returned") return null;
    return renderMemoryUsageRow(
      `memory-recall-${evt.id}`,
      evt.returnedMemoryIds.length || evt.returnedMemories.length,
      "recalled",
    );
  }
  if (evt.type === "agent_timeline") {
    const label = evt.summary || evt.eventType;
    return (
      <div key={`atl-${evt.id}`} className="flex flex-wrap items-center gap-2 py-0.5 font-mono text-xs text-text-muted">
        <span className="min-w-0 flex-1 break-words">{label}</span>
      </div>
    );
  }
  if (evt.type === "prompt_activity") {
    return null;
  }
  if (evt.type === "agent_progress") return renderAgentProgressEvent(evt);
  if (evt.type === "raw_agent_runtime") {
    if (!ctx.supportView) return null;
    return <RawAgentRuntimeDetails key={`raw-${evt.id}`} evt={evt} />;
  }
  if (evt.type === "question") {
    return (
      <div key={`q-${evt.id}`} className="session-stack-surface session-stack-surface-left-accent px-4 py-3 text-sm">
        <div className="font-medium text-text-primary">{evt.question}</div>
        {evt.answer ? (
          <div className="mt-2 text-text-secondary">
            <span className="text-accent font-medium">Answer:</span> {evt.answer}
          </div>
        ) : ctx.isActive && ctx.onAnswerQuestion ? (
          evt.options?.length ? (
            <QuestionOptions id={evt.id} options={evt.options} onSubmit={ctx.onAnswerQuestion} />
          ) : (
            <InlineInput
              id={evt.id}
              onSubmit={ctx.onAnswerQuestion}
              placeholder="Type your answer…"
              submitLabel="Answer"
            />
          )
        ) : null}
      </div>
    );
  }
  if (evt.type === "compaction_start") {
    return null;
  }
  if (evt.type === "compaction_complete") {
    return (
      <div key={`cc-${evt.id}`} className="my-3 h-px bg-border/70" aria-label="Context compacted">
        <span className="sr-only">Context compacted</span>
      </div>
    );
  }
  if (evt.type === "context_fill_warning") {
    return (
      <div key={`cfw-${evt.id}`} className="text-xs text-text-muted flex items-center gap-2 py-0.5">
        <WarningIcon className="h-3.5 w-3.5 shrink-0" />
        <span>Context nearly full.</span>
      </div>
    );
  }
  if (evt.type === "tool_truncated") {
    return (
      <div key={`tt-${evt.id}`} className="text-xs text-text-muted py-0.5">
        <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent text-2xs font-medium mr-1.5">{evt.tool}</span>
        {evt.reason === "size_threshold" ? "output exceeded safe size" : "output truncated"}
      </div>
    );
  }
  if (evt.type === "retry_status") {
    const providerLabel = formatProviderLabel(evt.provider);
    const retryTime = formatRetryTime(evt.nextRetryAt);
    const meta = [evt.attempt > 0 ? `Attempt ${evt.attempt}` : null, retryTime ? `Next retry ${retryTime}` : null]
      .filter(Boolean)
      .join(" \u00B7 ");
    return (
      <div
        key={`rs-${evt.id}`}
        className="bg-warning-soft border border-warning-soft-border rounded-lg px-4 py-3 text-sm flex items-start gap-2"
      >
        <RefreshIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <div className="font-medium text-warning">
            {providerLabel ? `Retrying ${providerLabel}…` : "Retrying provider…"}
          </div>
          <div className="text-text-secondary break-words">
            <MarkdownEventContent content={evt.message} renderAsPlainText={ctx.isActive} />
          </div>
          {meta && <div className="mt-1 text-xs text-text-muted">{meta}</div>}
        </div>
      </div>
    );
  }
  if (evt.type === "session_error") {
    return (
      <div
        key={`err-${evt.id}`}
        className="bg-error-soft border border-error-soft-border rounded-lg px-4 py-3 text-sm text-error flex items-start gap-2"
      >
        <span className="shrink-0 mt-0.5">&#x26A0;</span>
        <span>{formatSessionErrorMessage(evt.error, evt.code)}</span>
      </div>
    );
  }
  // Default: text event. Skip empty/whitespace-only text so unrecognized or
  // content-less events do not render as a blank message bubble.
  const text = (evt as { text?: string }).text;
  if (!text || !text.trim()) return null;
  // A plan-mode planning turn (`# Plan` document) renders as a compact collapsed
  // card instead of a wall of markdown — collapsed from the first token, showing
  // a "Planning…" state while it streams, so there is no jarring expand→collapse
  // flip when the turn finishes. `promptCompleted` distinguishes the streaming
  // state from the settled one (it does not gate the card, since a finished plan
  // turn keeps `result === null` and would otherwise read as still-active).
  const isStreaming = ctx.isActive && evt.id === ctx.streamingEventId;
  if (isPlanText(text)) {
    // Only one plan text event becomes the card; suppress any duplicate copies
    // of the plan so it is not rendered twice (once as a card, once as a wall).
    if (ctx.planTextEventId && evt.id !== ctx.planTextEventId) return null;
    return (
      <PlanCard
        key={`plan-${evt.id}`}
        content={text}
        generating={!ctx.promptCompleted}
        sessionId={ctx.sessionId}
        promptId={ctx.promptId ?? ""}
        planApprovalPending={ctx.planApprovalPending}
        planRevision={ctx.planRevision}
        planStatus={ctx.planStatus}
        planAutoReason={ctx.planAutoReason ?? null}
        planPromptFailed={ctx.planPromptFailed}
        onDiscuss={ctx.onDiscussPlan}
      />
    );
  }
  return (
    <MessageBubble key={`text-${evt.id}`} data-role="assistant">
      <MarkdownEventContent content={text} renderAsPlainText={isStreaming} />
    </MessageBubble>
  );
}

function renderMemoryUsageRow(key: string, count: number, action: "applied" | "recalled"): React.ReactNode {
  if (!MEMORY_TRANSCRIPT_ROWS_ENABLED || count === 0) return null;
  return (
    <div key={key} className="text-xs text-text-muted py-0.5">
      {count} {count === 1 ? "memory" : "memories"} {action}
    </div>
  );
}

function renderToolCall(evt: ActivityEvent & { type: "tool_call" }, ctx: EventRenderContext): React.ReactNode {
  const toolName = normalizeToolName(evt.tool);
  const isBatch = isBatchTool(toolName);
  const isTodo = isTodoTool(toolName);
  const isFileChange = isFileChangeTool(toolName);
  const canExpand = !isTodo && !isBatch && !!evt.input && Object.keys(evt.input).length > 0;
  const isOpen = ctx.toggledTools.has(evt.id);

  if (isBatch && evt.input) {
    return (
      <div
        key={evt.id}
        data-tool-category="planning"
        className="session-stack-surface session-stack-surface-accent-muted overflow-hidden font-mono text-xs"
      >
        <BatchToolDetails input={evt.input} />
      </div>
    );
  }

  const category = getToolCategory(toolName);
  // Timeline rows are always flat — no card chrome. A small type glyph carries
  // the tool kind (like the prototype), keeping a run dense and scannable.
  const rowClasses = "bg-transparent border-0";
  const toggleClasses = "w-full cursor-pointer text-left transition-colors duration-150 hover:text-text-primary";
  const bodyPadding = "px-0 py-0.5";
  const summaryClasses = "min-w-0 flex-1 break-words text-text-secondary";
  const renderSummary = (renderAsPlainText: boolean) => (
    <>
      <ToolGlyph tool={evt.tool} />
      <span className={summaryClasses}>
        <MarkdownEventContent
          content={toolSummaryText(evt.summary, evt.tool)}
          renderAsPlainText={renderAsPlainText}
          variant="inline"
        />
      </span>
    </>
  );

  return (
    <div key={evt.id} data-tool-category={category} className={`${rowClasses} overflow-hidden font-mono text-xs`}>
      {canExpand ? (
        <button type="button" onClick={() => ctx.toggleTool(evt.id)} className={toggleClasses}>
          <div className={`flex flex-wrap items-start gap-2 ${bodyPadding}`}>
            <span className={`text-text-muted transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}>
              &#x25B8;
            </span>
            {renderSummary(true)}
          </div>
        </button>
      ) : (
        <div className={`flex flex-wrap items-start gap-2 ${bodyPadding}`}>{renderSummary(ctx.isActive)}</div>
      )}
      {isTodo && evt.input && (
        <div className="pb-2 pl-[4.5rem]">
          <TodoWriteDetails input={evt.input} />
        </div>
      )}
      {canExpand &&
        isOpen &&
        evt.input &&
        (isFileChange ? (
          <InlineDiff
            oldStr={String(evt.input.oldString ?? "")}
            newStr={String(evt.input.newString ?? evt.input.content ?? "")}
          />
        ) : (
          <div className="border-t border-border/40 pl-[4.5rem] pt-2">
            <ToolInputDetails input={evt.input} open={isOpen} />
          </div>
        ))}
    </div>
  );
}

function TranscriptComponent({
  prompt,
  events,
  isActive,
  showProgressIndicator,
  repoOwner,
  repoName,
  onAnswerQuestion,
  supportView = false,
  hideAvatar,
  planApprovalPending,
  planRevision,
  planStatus,
  planAutoReason,
  onDiscussPlan,
}: Props) {
  const [toggledTools, setToggledTools] = useState<Set<string>>(new Set());
  const [visibleRenderItemLimit, setVisibleRenderItemLimit] = useState(TRANSCRIPT_INITIAL_RENDER_ITEM_LIMIT);
  const promptSettled = prompt.status === "completed" || prompt.status === "failed";

  const toggleTool = useCallback((id: string) => {
    setToggledTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filteredEvents = useMemo(() => {
    const projectedEvents = projectCustomerActivityEvents(events).filter(
      (evt) => !(evt.type === "text" && prompt.prompt && evt.text?.trim() === prompt.prompt.trim()),
    );
    if (!supportView) {
      // The review-loop worktree-boundary block fires on benign scratch/log
      // writes outside the worktree (e.g. redirecting lint output to /tmp). It
      // is an expected server-side guardrail, not a failure, and shows up as a
      // wall of red error blocks. Hide it from the normal transcript; other
      // policy_block kinds (protected-path, plan-mode, source-kind) stay
      // visible. It remains in projectedEvents, so support view (below) still
      // surfaces it via projectedIds.
      return projectedEvents.filter(
        (evt) => !(evt.type === "session_error" && isReviewLoopWorktreeBlockError(evt.code, evt.error)),
      );
    }
    const projectedIds = new Set(projectedEvents.map((evt) => evt.id));
    return events.filter((evt) => evt.type === "raw_agent_runtime" || projectedIds.has(evt.id));
  }, [events, prompt.prompt, supportView]);

  // During an active turn, only the final text event is still streaming; render
  // every earlier (settled) text event as markdown so the demo surface doesn't
  // show raw markdown source for the bulk of the conversation.
  const streamingEventId = useMemo(() => {
    if (!isActive) return null;
    for (let i = filteredEvents.length - 1; i >= 0; i--) {
      if (filteredEvents[i].type === "text") return filteredEvents[i].id;
    }
    return null;
  }, [filteredEvents, isActive]);

  // The plan document can appear more than once in a turn (the streamed answer
  // plus a recovered/result copy). Pick a single text event to render as the
  // plan card; the others are suppressed so the plan is not shown twice.
  const planTextEventId = useMemo(() => {
    for (const evt of filteredEvents) {
      const text = evt.type === "text" ? (evt as { text?: string }).text : undefined;
      if (typeof text === "string" && isPlanText(text)) return evt.id;
    }
    return null;
  }, [filteredEvents]);

  const renderItems = useMemo(() => buildTranscriptRenderItems(filteredEvents), [filteredEvents]);
  const windowedRenderItems = useMemo(
    () => windowTranscriptRenderItems(renderItems, visibleRenderItemLimit, isActive),
    [isActive, renderItems, visibleRenderItemLimit],
  );
  const trailingSelfAnimates = useMemo(
    () =>
      trailingItemSelfAnimates(windowedRenderItems.items, {
        isActive,
        promptCompleted: promptSettled,
        planTextEventId,
      }),
    [isActive, planTextEventId, promptSettled, windowedRenderItems.items],
  );
  useSyncEffect(() => {
    if (renderItems.length <= TRANSCRIPT_RENDER_WINDOW_THRESHOLD) {
      setVisibleRenderItemLimit(TRANSCRIPT_INITIAL_RENDER_ITEM_LIMIT);
      return;
    }
    setVisibleRenderItemLimit((current) =>
      Math.min(Math.max(current, TRANSCRIPT_INITIAL_RENDER_ITEM_LIMIT), renderItems.length),
    );
  }, [renderItems.length]);
  useSyncEffect(() => {
    void import("../datadog").then(({ trackAction }) =>
      trackAction("session_transcript_render_items", {
        promptId: prompt.promptId,
        eventCount: events.length,
        filteredEventCount: filteredEvents.length,
        renderItemCount: renderItems.length,
        renderedItemCount: windowedRenderItems.items.length,
        hiddenItemCount: windowedRenderItems.hiddenCount,
        windowed: windowedRenderItems.windowed,
        isActive,
      }),
    );
  }, [
    events.length,
    filteredEvents.length,
    isActive,
    prompt.promptId,
    renderItems.length,
    windowedRenderItems.hiddenCount,
    windowedRenderItems.items.length,
    windowedRenderItems.windowed,
  ]);

  if (filteredEvents.length === 0 && !isActive) return null;

  return (
    <div className={`${hideAvatar ? "mt-2" : "mt-4"} flex items-start gap-3 dd-privacy-mask`}>
      {hideAvatar ? <div className="w-7 shrink-0" aria-hidden="true" /> : <BotAvatar />}
      <div className="flex-1 min-w-0 space-y-2">
        {windowedRenderItems.items.map((item) => {
          if (item.type === "window_gap") {
            return (
              <div
                key={item.id}
                className="rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-text-muted"
              >
                {item.hiddenCount} middle transcript items hidden while the prompt is active.
              </div>
            );
          }
          if (item.type === "post_execution_panel") {
            return (
              <PostExecutionPanel
                key={item.id}
                item={item}
                isOpen={toggledTools.has(item.id)}
                onToggle={() => toggleTool(item.id)}
              />
            );
          }
          if (item.type === "tool_run_group") {
            const isActiveTrailingGroup = isActive && item.trailing;
            // Finished runs collapse to their summary line; toggling *expands* one
            // (presence in `toggledTools` marks a group the user opened). The active
            // trailing group streams open and folds itself when the run finishes.
            return (
              <ToolRunGroupBlock
                key={item.groupId}
                group={item}
                isOpen={isActiveTrailingGroup || toggledTools.has(item.groupId)}
                onToggle={() => {
                  if (!isActiveTrailingGroup) toggleTool(item.groupId);
                }}
                repoOwner={repoOwner ?? null}
                repoName={repoName ?? null}
                supportView={supportView}
                isActive={isActiveTrailingGroup}
              />
            );
          }
          if (item.type === "agent_progress_group") {
            return (
              <AgentProgressGroupRow
                key={item.id}
                group={item}
                isActive={isActive && item.trailing && !item.latest.terminal}
              />
            );
          }
          return renderActivityEvent(item, {
            isActive,
            streamingEventId,
            promptCompleted: promptSettled,
            planTextEventId,
            toggledTools,
            toggleTool,
            onAnswerQuestion,
            promptId: prompt.promptId,
            sessionId: prompt.session_id,
            planApprovalPending,
            planRevision,
            planStatus,
            planAutoReason,
            planPromptFailed: prompt.status === "failed",
            onDiscussPlan,
            repoOwner: repoOwner ?? null,
            repoName: repoName ?? null,
            supportView,
          });
        })}
        {windowedRenderItems.hiddenCount > 0 && !isActive && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setVisibleRenderItemLimit((limit) => limit + TRANSCRIPT_RENDER_ITEM_INCREMENT)}
          >
            Show {Math.min(TRANSCRIPT_RENDER_ITEM_INCREMENT, windowedRenderItems.hiddenCount)} more
          </Button>
        )}
        {isActive && showProgressIndicator && !trailingSelfAnimates && <SessionProgressIndicator />}
      </div>
    </div>
  );
}

export const Transcript = memo(TranscriptComponent);
