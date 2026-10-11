import {
  NARRATION_BUILD_COMMAND_TOKENS,
  NARRATION_COMMAND_LABELS,
  NARRATION_COMMAND_LAUNCHER_TOKENS,
  NARRATION_MAX_LINE_LENGTH,
  NARRATION_SKIP_EVENT_TYPES,
  NARRATION_SUMMARY_SAFE_TOOLS,
  NARRATION_TEST_COMMAND_TOKENS,
  NARRATION_TIMELINE_MILESTONE_LABELS,
} from "../constants/slack-narration";
import { NARRATION_MIN_UPDATE_INTERVAL_MS } from "../constants/slack-thread-budget";
import { generateToolSummary } from "../session/tool-summary";

/**
 * Deterministic live-narration line for the Slack status card. No LLM: every
 * line is derived from projected session events with fixed copy. Returns null
 * for events that should not move the card.
 */
export interface NarrationEvent {
  type: string;
  data?: Record<string, unknown> | null;
}

function truncateLine(line: string): string {
  return line.length > NARRATION_MAX_LINE_LENGTH ? `${line.slice(0, NARRATION_MAX_LINE_LENGTH)}…` : line;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type CommandClass = keyof typeof NARRATION_COMMAND_LABELS;

/**
 * Classify a shell command into tests / build / script from its first
 * meaningful token(s). The raw command line must NEVER render on the card
 * (copy principle + long/sensitive command text), so unknown shapes always
 * fall back to the generic script label.
 */
export function classifyCommandForNarration(command: string): CommandClass {
  // Strip leading env assignments (FOO=bar cmd) and take the first tokens.
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const classifyToken = (token: string | undefined, next: string | undefined): CommandClass | null => {
    if (!token) return null;
    // `path/to/vitest` and `./gradlew` should classify by basename.
    const base = token.split("/").pop() ?? token;
    if (NARRATION_TEST_COMMAND_TOKENS.has(base)) return "tests";
    if (NARRATION_BUILD_COMMAND_TOKENS.has(base)) return "build";
    if (NARRATION_COMMAND_LAUNCHER_TOKENS.has(base)) {
      if (!next) return null;
      // `npm run test:unit` / `yarn run build` — the intent rides the run target.
      if (next === "run") return null;
      if (next === "test" || next.startsWith("test")) return "tests";
      if (next === "build" || next.startsWith("build")) return "build";
      return classifyToken(next, undefined);
    }
    return null;
  };

  const direct = classifyToken(tokens[0], tokens[1]);
  if (direct) return direct;
  // Second pass for `npm run <target>` / `pnpm run <target>` shapes.
  if (tokens[1] === "run") {
    const target = tokens[2];
    if (target?.startsWith("test")) return "tests";
    if (target?.startsWith("build")) return "build";
  }
  return "script";
}

/**
 * Signals that a string is a shell command, not a prose intent description:
 * a wrapper invocation (`/bin/bash -lc`, `sh -c`), a redirect/pipe/chain, a
 * substitution, or a single bare token (a bare binary/path). Codex sets the
 * tool `summary` to the raw command (often wrapped as `/bin/bash -lc "…"`), so
 * a plain substring check misses the differently-quoted inner command — this
 * catches the whole class.
 */
const COMMAND_LIKE_PATTERN = /\/bin\/|(^|\s)(sh|bash|zsh)\s+-l?c\b|[|;`]|&&|\$\(|(^|\s)\d?[<>]/;

function looksLikeShellCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/\s/.test(trimmed)) return true; // a single bare token is a binary/path, not prose
  return COMMAND_LIKE_PATTERN.test(trimmed);
}

/**
 * The agent's own intent description of a command ("Run the memory DAO tests"),
 * when it gave one. Preference order: the explicit `input.description` field
 * (Claude Code's Bash tool provides one) over the projected `summary` (which
 * falls back to `generateToolSummary` and echoes the raw command for shell
 * tools). Either source is used ONLY when it reads like prose, not a command:
 * the raw command line must never render on the card. Returns null to signal
 * "no usable description — classify instead".
 */
function agentCommandDescription(
  data: Record<string, unknown>,
  input: Record<string, unknown>,
  command: string,
): string | null {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description && !looksLikeShellCommand(description)) return truncateLine(description);

  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  const cmd = command.trim();
  if (!summary) return null;
  if (cmd && (summary === cmd || summary.includes(cmd) || cmd.includes(summary))) return null;
  if (looksLikeShellCommand(summary)) return null;
  return truncateLine(summary);
}

function toolCallLine(data: Record<string, unknown>): string | null {
  const tool = typeof data.tool === "string" ? data.tool : null;
  if (!tool) return null;
  const input = recordOrNull(data.input) ?? {};

  // Any tool carrying a `command` string is a command runner. Prefer the
  // agent's own intent description ("Running the memory DAO tests"); only when
  // it gave none do we fall back to the generic tests/build/script bucket. The
  // raw command line itself is never rendered (copy principle + long/sensitive).
  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return (
      agentCommandDescription(data, input, input.command) ??
      NARRATION_COMMAND_LABELS[classifyCommandForNarration(input.command)]
    );
  }
  if (tool === "bash") {
    return agentCommandDescription(data, input, "") ?? NARRATION_COMMAND_LABELS.script;
  }
  if (NARRATION_SUMMARY_SAFE_TOOLS.has(tool)) {
    const summary = generateToolSummary(tool, input);
    // generateToolSummary falls back to the bare tool name when the expected
    // input field is missing; that reads as mechanics, so skip it.
    return summary === tool ? null : truncateLine(summary);
  }
  if (tool === "todowrite") {
    // todo_update events narrate plan progress with better signal.
    return null;
  }
  if (tool === "batch") {
    // Mixed sub-tools can embed raw command lines; no safe single line exists.
    return null;
  }
  return "Working…";
}

function todoUpdateLine(data: Record<string, unknown>): string | null {
  const todos = Array.isArray(data.todos) ? data.todos : [];
  for (const todo of todos) {
    const record = recordOrNull(todo);
    if (!record || record.status !== "in_progress") continue;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (content) return truncateLine(`Working on: ${content}`);
  }
  return null;
}

function agentTimelineLine(data: Record<string, unknown>): string | null {
  if (data.status === "failed") return null;
  const eventType = typeof data.eventType === "string" ? data.eventType : "";
  return NARRATION_TIMELINE_MILESTONE_LABELS[eventType] ?? null;
}

export function narrationLineForEvent(event: NarrationEvent): string | null {
  if (NARRATION_SKIP_EVENT_TYPES.has(event.type)) return null;
  const data = recordOrNull(event.data) ?? {};
  switch (event.type) {
    case "todo_update":
      return todoUpdateLine(data);
    case "tool_call":
      return toolCallLine(data);
    case "agent_timeline":
      return agentTimelineLine(data);
    default:
      return null;
  }
}

/**
 * Safe activity text for a `tool_call` event's `data`, reusing the exact copy
 * rules of the card mapper (agent intent summary or a classified label — the
 * raw command line is NEVER surfaced). Exposed so the LLM progress-narration
 * buffer can ingest tool activity through the same safe rendering instead of
 * re-deriving it (and risking a raw command leaking into the prompt).
 */
export function narrationToolCallText(data: Record<string, unknown> | null | undefined): string | null {
  return toolCallLine(recordOrNull(data) ?? {});
}

/** Latest narration-worthy line in an appended batch (later events win). */
export function narrationLineForEvents(events: readonly NarrationEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const line = narrationLineForEvent(events[i]);
    if (line !== null) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Throttle / dedup (pure; the DO persists this state across restarts)
// ---------------------------------------------------------------------------

export interface NarrationThrottleState {
  /** Last line delivered to the card (dedup baseline). */
  lastLine: string | null;
  /** unix-ms of the last delivered update. */
  lastUpdateAtMs: number;
  /** Newest line stashed during a throttle window, flushed lazily on a later event. */
  pendingLine: string | null;
}

export const INITIAL_NARRATION_THROTTLE_STATE: NarrationThrottleState = {
  lastLine: null,
  lastUpdateAtMs: 0,
  pendingLine: null,
};

export interface NarrationThrottlePlan {
  /** Line to deliver now, or null when nothing should be sent. */
  send: string | null;
  state: NarrationThrottleState;
}

/**
 * Decide whether an incoming line (or a previously stashed one) should render
 * now. Rules: identical-to-displayed lines are dropped (and clear any stale
 * pending line, since the incoming line is newer); inside the throttle window
 * the newest line is stashed; past the window the newest candidate is sent.
 * Flushing is lazy — a null incoming line only flushes an existing stash.
 */
/**
 * Coalesce a phase-transition card edit with the narration throttle. Phase
 * edits are once-per-transition and never deferred (a blocked/stopped session
 * may produce no further event to lazily flush on), but they participate in
 * the shared throttle:
 * - a running-stage edit CARRIES the freshest narration line (pending wins
 *   over last-rendered), so phase + narration land as ONE chat.update;
 * - every phase edit advances `lastUpdateAtMs`, so the next narration tick
 *   keeps the min-interval spacing relative to this edit;
 * - the pending stash is cleared — on non-running stages it is stale copy
 *   that must never repaint later.
 */
export function coalescePhaseCardNarration(
  state: NarrationThrottleState,
  stageIsRunning: boolean,
  nowMs: number,
): { carriedLine: string | undefined; state: NarrationThrottleState } {
  const carriedLine = stageIsRunning ? (state.pendingLine ?? state.lastLine ?? undefined) : undefined;
  return {
    carriedLine,
    state: {
      lastLine: carriedLine ?? state.lastLine,
      lastUpdateAtMs: nowMs,
      pendingLine: null,
    },
  };
}

export function planNarrationUpdate(
  state: NarrationThrottleState,
  line: string | null,
  nowMs: number,
  minIntervalMs = NARRATION_MIN_UPDATE_INTERVAL_MS,
): NarrationThrottlePlan {
  const candidate = line ?? state.pendingLine;
  if (candidate === null) {
    return { send: null, state };
  }
  if (candidate === state.lastLine) {
    // Already displayed. An incoming duplicate also invalidates any older stash.
    if (line !== null && state.pendingLine !== null) {
      return { send: null, state: { ...state, pendingLine: null } };
    }
    if (line === null && state.pendingLine === state.lastLine) {
      return { send: null, state: { ...state, pendingLine: null } };
    }
    return { send: null, state };
  }
  if (nowMs - state.lastUpdateAtMs >= minIntervalMs) {
    return { send: candidate, state: { lastLine: candidate, lastUpdateAtMs: nowMs, pendingLine: null } };
  }
  if (state.pendingLine === candidate) {
    return { send: null, state };
  }
  return { send: null, state: { ...state, pendingLine: candidate } };
}
