import { isGroupableToolCall, isReadTool, normalizeToolName, TOOL_NAMES } from "../constants/tools";
import type { ActivityEvent } from "../types";
import { isPlanText } from "./plan-summary";

type BatchCall = { tool: string; parameters?: Record<string, unknown> };

/**
 * Determines whether `handlePromptDone` should fetch prompt events from the
 * server when a live prompt completes. Embedded terminal history is a
 * forward-compat path; current producers do not write it.
 */
export function shouldFetchPromptEvents(
  history: Array<{ type: string; data?: Record<string, unknown> }> | undefined,
): boolean {
  if (Array.isArray(history) && history.length > 0) return false;
  return true;
}

/** Extract file path from a tool call's input (works for read, edit, write, glob, grep). */
function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const v = input.file_path ?? input.filePath ?? input.path;
  return typeof v === "string" ? v : undefined;
}

/**
 * Collapse repeated read calls for the same file into a single event with a duplicateCount.
 * Non-consecutive duplicates are still collapsed (the first occurrence is kept).
 */
function deduplicateReads(events: ActivityEvent[]): ActivityEvent[] {
  // First pass: count reads per file path
  const readCounts = new Map<string, number>();
  for (const evt of events) {
    if (evt.type !== "tool_call" || !isReadTool(evt.tool)) continue;
    const fp = extractFilePath(evt.input);
    if (fp) readCounts.set(fp, (readCounts.get(fp) ?? 0) + 1);
  }

  // Second pass: keep first occurrence of each duplicated read, filter the rest
  const seen = new Set<string>();
  const result: ActivityEvent[] = [];
  for (const evt of events) {
    if (evt.type === "tool_call" && isReadTool(evt.tool)) {
      const fp = extractFilePath(evt.input);
      if (fp && (readCounts.get(fp) ?? 0) > 1) {
        if (seen.has(fp)) continue; // skip duplicate
        seen.add(fp);
        result.push({ ...evt, duplicateCount: readCounts.get(fp)! });
        continue;
      }
    }
    result.push(evt);
  }
  return result;
}

export type ToolRunGroup = {
  type: "tool_run_group";
  events: ActivityEvent[];
  groupId: string;
  activityCount: number;
  tally: ToolRunTally;
  hasError: boolean;
  trailing: boolean;
  tokenTotals: {
    inputEstimatedTokens: number;
    outputEstimatedTokens: number;
  };
};

type ToolRunTally = {
  reads: number;
  searches: number;
  edits: number;
  commands: number;
  other: number;
};

type AgentProgressEvent = Extract<ActivityEvent, { type: "agent_progress" }>;
type NonEmptyAgentProgressEvents = [AgentProgressEvent, ...AgentProgressEvent[]];
export type AgentTimelineEvent = Extract<ActivityEvent, { type: "agent_timeline" }>;

export type AgentProgressGroup = {
  type: "agent_progress_group";
  id: string;
  events: NonEmptyAgentProgressEvents;
  latest: AgentProgressEvent;
  trailing: boolean;
};

export type PostExecutionPanelItem = {
  type: "post_execution_panel";
  id: string;
  events: AgentTimelineEvent[];
};

type TranscriptWindowGapItem = {
  type: "window_gap";
  id: string;
  hiddenCount: number;
};

export type TranscriptRenderItem =
  ActivityEvent | ToolRunGroup | AgentProgressGroup | PostExecutionPanelItem | TranscriptWindowGapItem;

const STANDALONE_AGENT_PROGRESS_STEPS = new Set(["workspace_setup_delayed", "workspace_setup_failed"]);
const RENDER_NULL_EVENT_TYPES = new Set<ActivityEvent["type"]>(["prompt_activity"]);

function deduplicatePatches(events: ActivityEvent[]): ActivityEvent[] {
  const result: ActivityEvent[] = [];
  let i = 0;

  while (i < events.length) {
    const evt = events[i];
    if (evt.type !== "patch") {
      result.push(evt);
      i += 1;
      continue;
    }

    const key = evt.files.slice().sort().join("\0");
    let j = i + 1;
    while (j < events.length && events[j].type === "patch") {
      const next = events[j] as ActivityEvent & { type: "patch" };
      if (next.files.length === evt.files.length && next.files.slice().sort().join("\0") === key) j++;
      else break;
    }
    result.push(evt);
    i = j;
  }

  return result;
}

function isToolRunEvent(event: ActivityEvent): boolean {
  switch (event.type) {
    case "tool_call":
    case "customer_activity":
    case "patch":
    case "agent_progress":
    case "retry_status":
    case "tool_truncated":
      return true;
    default:
      return false;
  }
}

function rendersTopLevelToolActivity(event: ActivityEvent): boolean {
  switch (event.type) {
    case "patch":
    case "agent_progress":
    case "retry_status":
    case "tool_truncated":
      return true;
    case "tool_call":
      return !isGroupableToolCall(event.tool);
    case "customer_activity":
      return event.details.length > 0 && event.details.every((detail) => detail.tool === "patch");
    default:
      return false;
  }
}

function activityCountForEvent(event: ActivityEvent): number {
  switch (event.type) {
    case "tool_call":
      return isGroupableToolCall(event.tool) ? 1 : 0;
    case "customer_activity":
      return event.details.every((detail) => detail.tool === "patch") ? 0 : event.count;
    default:
      return 0;
  }
}

function emptyToolRunTally(): ToolRunTally {
  return {
    reads: 0,
    searches: 0,
    edits: 0,
    commands: 0,
    other: 0,
  };
}

function tallyKeyForTool(tool: string): keyof ToolRunTally {
  switch (normalizeToolName(tool)) {
    case TOOL_NAMES.READ:
      return "reads";
    case TOOL_NAMES.GREP:
    case TOOL_NAMES.GLOB:
    case TOOL_NAMES.LS:
      return "searches";
    case TOOL_NAMES.EDIT:
    case TOOL_NAMES.WRITE:
    case "patch":
      return "edits";
    case TOOL_NAMES.BASH:
      return "commands";
    default:
      return "other";
  }
}

function addToToolRunTally(tally: ToolRunTally, key: keyof ToolRunTally, count: number): void {
  tally[key] += count;
}

function fallbackTallyKeyForCustomerActivity(
  event: Extract<ActivityEvent, { type: "customer_activity" }>,
): keyof ToolRunTally {
  switch (event.category) {
    case "change":
      return "edits";
    case "verify":
    case "git":
    case "command":
      return "commands";
    case "inspect":
    case "plan":
      return "other";
  }
}

function tallyCustomerActivityEvent(
  event: Extract<ActivityEvent, { type: "customer_activity" }>,
  tally: ToolRunTally,
): void {
  const detailKeys = event.details.map((detail) => tallyKeyForTool(detail.tool));
  for (const key of detailKeys) addToToolRunTally(tally, key, 1);

  const overflow = event.overflow ?? 0;
  if (overflow <= 0) return;

  const distinctKeys = new Set(detailKeys);
  const overflowKey = distinctKeys.size === 1 ? detailKeys[0] : fallbackTallyKeyForCustomerActivity(event);
  addToToolRunTally(tally, overflowKey ?? fallbackTallyKeyForCustomerActivity(event), overflow);
}

function tallyEvent(event: ActivityEvent, tally: ToolRunTally): void {
  switch (event.type) {
    case "tool_call":
      if (isGroupableToolCall(event.tool)) addToToolRunTally(tally, tallyKeyForTool(event.tool), 1);
      return;
    case "customer_activity":
      tallyCustomerActivityEvent(event, tally);
      return;
    default:
      return;
  }
}

function eventHasError(event: ActivityEvent): boolean {
  switch (event.type) {
    case "tool_call":
      if (event.failure) return event.failure.category !== "command";
      return event.toolStatus === "error";
    case "customer_activity":
      return event.status === "error";
    default:
      return false;
  }
}

function createToolRunGroup(group: ActivityEvent[], trailing: boolean): ToolRunGroup {
  let activityCount = 0;
  let inputEstimatedTokens = 0;
  let outputEstimatedTokens = 0;
  const tally = emptyToolRunTally();
  let hasError = false;
  for (const event of group) {
    activityCount += activityCountForEvent(event);
    tallyEvent(event, tally);
    if (eventHasError(event)) hasError = true;
    if (event.type === "tool_call") {
      inputEstimatedTokens += event.inputEstimatedTokens ?? 0;
      outputEstimatedTokens += event.outputEstimatedTokens ?? 0;
    }
  }

  return {
    type: "tool_run_group",
    events: group,
    groupId: `group-${group[0].id}`,
    activityCount,
    tally,
    hasError,
    trailing,
    tokenTotals: {
      inputEstimatedTokens,
      outputEstimatedTokens,
    },
  };
}

function isRenderNullEvent(event: ActivityEvent): boolean {
  return RENDER_NULL_EVENT_TYPES.has(event.type);
}

/**
 * Whether a groupable tool-run event appears later in the stream, looking past
 * render-null and reasoning events. Used to decide if an interstitial reasoning
 * block sits *between* two actions (absorb it into the run) versus trailing
 * after the last action (leave it standalone).
 */
function hasGroupableToolRunAhead(events: ActivityEvent[], startIndex: number): boolean {
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (isRenderNullEvent(event) || event.type === "reasoning") continue;
    return isToolRunEvent(event) && !rendersTopLevelToolActivity(event);
  }
  return false;
}

function isStandaloneAgentProgress(event: AgentProgressEvent): boolean {
  return STANDALONE_AGENT_PROGRESS_STEPS.has(event.step);
}

function hasLaterVisibleEvent(events: ActivityEvent[], startIndex: number): boolean {
  for (let index = startIndex; index < events.length; index += 1) {
    if (!isRenderNullEvent(events[index])) return true;
  }
  return false;
}

function createAgentProgressGroup(events: NonEmptyAgentProgressEvents, trailing: boolean): AgentProgressGroup {
  const first = events[0];
  return {
    type: "agent_progress_group",
    id: `agent-progress-group-${first.id}`,
    events,
    latest: events[events.length - 1],
    trailing,
  };
}

/** Group sequential command-like tool activity.
 * Also dedup repeated reads and consecutive identical patch events first. */
export function groupConsecutiveToolCalls(events: ActivityEvent[]): TranscriptRenderItem[] {
  const dedupedEvents = deduplicatePatches(deduplicateReads(events));
  const result: TranscriptRenderItem[] = [];
  let i = 0;

  while (i < dedupedEvents.length) {
    const evt = dedupedEvents[i];

    if (evt.type === "agent_progress") {
      if (isStandaloneAgentProgress(evt)) {
        result.push(evt);
        i += 1;
        continue;
      }

      const group: NonEmptyAgentProgressEvents = [evt];
      let j = i + 1;
      while (j < dedupedEvents.length) {
        const nextEvent = dedupedEvents[j];
        if (isRenderNullEvent(nextEvent)) {
          j += 1;
          continue;
        }
        if (nextEvent.type !== "agent_progress" || isStandaloneAgentProgress(nextEvent)) break;
        group.push(nextEvent);
        j += 1;
      }

      result.push(createAgentProgressGroup(group, !hasLaterVisibleEvent(dedupedEvents, j)));
      i = j;
      continue;
    }

    if (isToolRunEvent(evt)) {
      if (rendersTopLevelToolActivity(evt)) {
        result.push(evt);
        i += 1;
        continue;
      }

      const group: ActivityEvent[] = [evt];
      let j = i + 1;
      while (j < dedupedEvents.length) {
        const next = dedupedEvents[j];
        // Render-null events (e.g. prompt_activity) never break a run.
        if (isRenderNullEvent(next)) {
          j += 1;
          continue;
        }
        if (isToolRunEvent(next) && !rendersTopLevelToolActivity(next)) {
          group.push(next);
          j += 1;
          continue;
        }
        // Absorb reasoning that sits *between* two actions so a single agent
        // turn renders as one timeline instead of shattering into a card per
        // call. Trailing reasoning (no action after it) stays standalone.
        if (next.type === "reasoning" && hasGroupableToolRunAhead(dedupedEvents, j + 1)) {
          group.push(next);
          j += 1;
          continue;
        }
        break;
      }

      result.push(createToolRunGroup(group, j >= dedupedEvents.length));
      i = j;
      continue;
    }

    result.push(evt);
    i += 1;
  }
  return result;
}

function isSkippedTrailingItem(item: TranscriptRenderItem, opts: { planTextEventId: string | null }): boolean {
  if (item.type === "window_gap" || item.type === "post_execution_panel") return true;
  if (item.type === "prompt_activity" || item.type === "compaction_start") return true;
  if (item.type !== "text") return false;

  const text = item.text;
  if (!text.trim()) return true;
  return isPlanText(text) && item.id !== opts.planTextEventId;
}

export function trailingItemSelfAnimates(
  items: readonly TranscriptRenderItem[],
  opts: { isActive: boolean; promptCompleted: boolean; planTextEventId: string | null },
): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (isSkippedTrailingItem(item, opts)) continue;

    if (item.type === "tool_run_group") return opts.isActive && item.trailing;
    if (item.type === "agent_progress_group") return opts.isActive && item.trailing && !item.latest.terminal;
    if (item.type === "text" && item.id === opts.planTextEventId) return opts.isActive && !opts.promptCompleted;
    return false;
  }
  return false;
}

export function batchCallSummary(call: BatchCall): string {
  const p = call.parameters;
  if (!p) return call.tool;
  const filePath = extractFilePath(p);
  switch (normalizeToolName(call.tool)) {
    case TOOL_NAMES.EDIT:
    case TOOL_NAMES.WRITE:
    case TOOL_NAMES.READ:
      return filePath ? filePath : "";
    case TOOL_NAMES.BASH:
      if (typeof p.command === "string") {
        return p.command.length > 80 ? p.command.slice(0, 80) + "\u2026" : p.command;
      }
      return "";
    case TOOL_NAMES.GLOB:
      return p.pattern ? String(p.pattern) : "";
    case TOOL_NAMES.GREP:
      return p.pattern ? String(p.pattern) : "";
    default:
      for (const v of Object.values(p)) {
        if (typeof v === "string" && v.length > 0 && v.length < 100) return v;
      }
      return "";
  }
}

export function toolRunCurrentActionSummary(event: ActivityEvent): string {
  switch (event.type) {
    case "tool_call": {
      const summary = batchCallSummary({ tool: event.tool, parameters: event.input });
      return summary || event.summary || event.tool;
    }
    case "customer_activity":
      return event.summary || event.title;
    default:
      return "";
  }
}

export function normalizeQuestionOption(opt: string | { label: string; description?: string }): {
  label: string;
  description?: string;
} {
  return typeof opt === "string" ? { label: opt } : opt;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  baseten: "Baseten",
};

export function formatProviderLabel(provider?: string): string | null {
  if (!provider) return null;
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

/** Human-readable elapsed reasoning duration, e.g. `7s`, `1m`, `1m 5s`. */
export function formatThinkingDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Label for a reasoning block's summary line. Shows `Thought for Ns` once the
 * block has measurable duration (matching Claude Code); falls back to the
 * verb-only label for legacy events that carry no timing.
 */
export function reasoningSummaryLabel(evt: Extract<ActivityEvent, { type: "reasoning" }>, isActive: boolean): string {
  const durationMs =
    typeof evt.startedAtMs === "number" && typeof evt.endedAtMs === "number"
      ? Math.max(0, evt.endedAtMs - evt.startedAtMs)
      : undefined;
  if (durationMs !== undefined && durationMs >= 1000) {
    return `Thought for ${formatThinkingDuration(durationMs)}`;
  }
  return isActive ? "thinking…" : "Thought";
}
