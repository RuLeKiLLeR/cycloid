/**
 * LLM-synthesized progress narration for the Slack status card.
 *
 * The deterministic mapper (slack/narration.ts) maps a single event to a fixed
 * label ("Editing foo.ts", "Running tests"). Over a long session that gives no
 * sense of what the agent is actually doing or how far along it is. This module
 * periodically synthesizes a rolling buffer of recent activity into ONE
 * first-person progress line ("Found 3 batchable lookups in memory-db.ts,
 * writing the fix") using a cheap/fast model.
 *
 * Contract:
 * - Fail-OPEN: every failure (error, timeout, skip, empty, unchanged) returns
 *   null so the deterministic line simply stays. Never throws.
 * - No raw commands ever reach the buffer or the prompt — tool activity is
 *   ingested through narration.ts's safe rendering.
 * - Cost/safety is enforced by the caller (internal gate, cadence, one-in-flight
 *   guard); this module owns the per-call hard timeout and the prompt shape.
 */
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import type { StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import { isRecord } from "../../../../shared/utils/type-guards.js";
import {
  PROGRESS_NARRATION_BUFFER_MAX_CHARS,
  PROGRESS_NARRATION_BUFFER_SIZE,
  PROGRESS_NARRATION_INTERVAL_MS,
  PROGRESS_NARRATION_ITEM_MAX_CHARS,
  PROGRESS_NARRATION_MAX_LINE_LENGTH,
  PROGRESS_NARRATION_MAX_TOKENS,
  PROGRESS_NARRATION_MODEL,
  PROGRESS_NARRATION_REASONING_EFFORT,
  PROGRESS_NARRATION_TIMEOUT_MS,
} from "../constants/slack-progress-narration.js";
import type { Logger } from "../logger";
import {
  type PlatformStructuredOutputEnv,
  type PlatformStructuredOutputTelemetry,
  queryPlatformStructuredOutput,
} from "../services/platform-structured-output.js";

/** One compact, copy-safe item in the rolling activity buffer. */
export interface ProgressBufferItem {
  /** Coarse activity kind: "reasoning" | "text" | "tool" | "todo" | "edit" | "milestone". */
  kind: string;
  /** Already-truncated, command-free text. */
  text: string;
}

/** Minimal projected-event shape the buffer ingests (a DurableEntry subset). */
export interface ProgressNarrationEvent {
  type: string;
  data?: Record<string, unknown> | null;
}

function truncateItem(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PROGRESS_NARRATION_ITEM_MAX_CHARS
    ? `${trimmed.slice(0, PROGRESS_NARRATION_ITEM_MAX_CHARS)}…`
    : trimmed;
}

function record(data: unknown): Record<string, unknown> {
  return isRecord(data) ? data : {};
}

/**
 * Derive copy-safe buffer items from one projected event. Reuses narration.ts's
 * safe rendering for tool calls (never the raw command line). Returns [] for
 * events that carry no narration-relevant text.
 *
 * `narrationToolCallText` is injected to avoid a static import cycle only where
 * one would exist; callers pass the real function from narration.ts.
 */
export function progressItemsForEvent(
  event: ProgressNarrationEvent,
  toolCallText: (data: Record<string, unknown> | null | undefined) => string | null,
): ProgressBufferItem[] {
  const data = record(event.data);
  switch (event.type) {
    case "reasoning": {
      const text = typeof data.text === "string" ? data.text : "";
      const safe = truncateItem(text);
      return safe ? [{ kind: "reasoning", text: safe }] : [];
    }
    case "text": {
      // Agent's own natural-language output (not a command). Final answers and
      // interim narration both read as progress signal.
      const text = typeof data.text === "string" ? data.text : "";
      const safe = truncateItem(text);
      return safe ? [{ kind: "text", text: safe }] : [];
    }
    case "tool_call": {
      const safe = toolCallText(data);
      return safe ? [{ kind: "tool", text: truncateItem(safe) }] : [];
    }
    case "todo_update": {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      const items: ProgressBufferItem[] = [];
      for (const todo of todos) {
        const rec = record(todo);
        if (rec.status !== "in_progress") continue;
        const content = typeof rec.content === "string" ? rec.content.trim() : "";
        if (content) items.push({ kind: "todo", text: truncateItem(content) });
      }
      return items;
    }
    case "patch": {
      const files = Array.isArray(data.files)
        ? data.files.filter((file): file is string => typeof file === "string")
        : [];
      if (files.length === 0) return [];
      // File paths only — the diff content itself never enters the buffer.
      return [{ kind: "edit", text: truncateItem(`Edited ${files.join(", ")}`) }];
    }
    case "agent_timeline": {
      // Only the pr.open milestone carries distinct progress signal here; the
      // rest is covered by tool/edit activity above.
      if (data.eventType === "pr.open") return [{ kind: "milestone", text: "Opened a pull request" }];
      return [];
    }
    default:
      return [];
  }
}

/** All copy-safe items produced by a batch of events (newest-last). */
export function progressItemsForEvents(
  events: readonly ProgressNarrationEvent[],
  toolCallText: (data: Record<string, unknown> | null | undefined) => string | null,
): ProgressBufferItem[] {
  const items: ProgressBufferItem[] = [];
  for (const event of events) {
    for (const item of progressItemsForEvent(event, toolCallText)) items.push(item);
  }
  return items;
}

/**
 * Enforce the ring bound (most recent N) then the total-char budget (drop
 * oldest) on a buffer. Pure: returns a new array.
 */
export function boundProgressBuffer(items: readonly ProgressBufferItem[]): ProgressBufferItem[] {
  let bounded =
    items.length > PROGRESS_NARRATION_BUFFER_SIZE ? items.slice(-PROGRESS_NARRATION_BUFFER_SIZE) : [...items];
  let total = bounded.reduce((sum, item) => sum + item.text.length, 0);
  while (bounded.length > 1 && total > PROGRESS_NARRATION_BUFFER_MAX_CHARS) {
    total -= bounded[0].text.length;
    bounded = bounded.slice(1);
  }
  return bounded;
}

/**
 * Append items from a batch of events onto the rolling buffer, then enforce the
 * ring bound and total-char budget. Pure: returns a new array, leaving the
 * input untouched.
 */
export function appendProgressBufferItems(
  buffer: readonly ProgressBufferItem[],
  events: readonly ProgressNarrationEvent[],
  toolCallText: (data: Record<string, unknown> | null | undefined) => string | null,
): ProgressBufferItem[] {
  return boundProgressBuffer([...buffer, ...progressItemsForEvents(events, toolCallText)]);
}

const PROGRESS_NARRATION_TOOL: StructuredOutputTool = {
  name: "platform_llm_slack_progress_narration",
  description: "Emit one short first-person progress line for a coding agent's live Slack status card.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      line: {
        type: "string",
        description:
          "One first-person, present-tense progress line (<= ~90 chars) describing what the agent is doing now and roughly how far along it is. Outcomes not mechanics. Empty string when skip is true.",
      },
      skip: {
        type: "boolean",
        description:
          "True when nothing meaningful has changed since the previous line, so the card should not be updated.",
      },
    },
    required: ["line", "skip"],
  },
};

/**
 * Build the compact prompt: the user's task plus recent activity, asking for
 * one first-person progress line and a skip flag. Few-shot-quality style rules
 * are baked into the system prompt.
 */
export function buildProgressNarrationPrompt(
  task: string,
  buffer: readonly ProgressBufferItem[],
  isFirstUpdate = false,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "You are the coding agent itself, giving a teammate a quick live status in Slack — like a sharp colleague dropping a one-line update in a thread. The audience may be non-technical.",
    "Given the user's task and a buffer of your most recent activity, write ONE short first-person, present-tense update and decide whether it is worth refreshing the card.",
    `The line must be <= ${PROGRESS_NARRATION_MAX_LINE_LENGTH} characters.`,
    "Voice — make it feel alive, like a real person working:",
    '- First person, present tense, conversational. "I\'m tracing where proration is computed", "Just found the 3 batchable lookups — writing the fix now", "Tests are red, digging into the projection".',
    '- Vary how you open across updates so it never feels robotic: sometimes lead with "I\'m …", sometimes "Just …", sometimes the finding ("Found …", "Turns out …"), sometimes the next move ("On to the tests").',
    '- Convey momentum and progress: what you just did, what you\'re onto now, and a rough sense of how far along ("3 of 5 files done", "almost there", "last piece now") when you can infer it.',
    "- A little warmth/energy is good; a light, tasteful touch is welcome. Never forced or cutesy.",
    "Content rules:",
    "- Describe outcomes and intent, not mechanics. Never include raw commands, flags, diffs, or code. File names are fine.",
    '- Be concrete and specific to THIS activity; avoid generic filler like "Working on it" or "Making progress".',
    "- Single clause, no trailing punctuation required.",
    "Good examples:",
    '- "Just found 3 batchable lookups in memory-db.ts — writing the fix now"',
    '- "Tests came back red, 2 failing — I\'m on the projection bug"',
    '- "Tracing where the review-loop label gets set before I add the guard"',
    '- "DAO + tests written, running the suite now — almost there"',
    '- "Digging through the memory DAO to map every multi-query function"',
    isFirstUpdate
      ? 'This is your FIRST update for this task: do NOT skip. Say something now, even a brief, energetic orientation like "Cracking open the memory DAO now" or "Getting my bearings in the repo". The card should come alive immediately.'
      : "Set skip=true (and line empty) ONLY when nothing meaningful has changed since your last update — but speak up as soon as there's real activity; a quiet card feels dead.",
  ].join("\n");

  const activity =
    buffer.length === 0
      ? "(no recent activity captured)"
      : buffer.map((item, index) => `${index + 1}. [${item.kind}] ${item.text}`).join("\n");

  const userPrompt = [
    `TASK:\n${truncateItem(task) || "(no task text)"}`,
    "",
    `RECENT ACTIVITY (oldest first):\n${activity}`,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

/** Coerce the model's structured output to a rendered line, or null (fail-open). */
export function coerceProgressLine(
  raw: Record<string, unknown> | null,
  lastLine: string | null,
  isFirstUpdate = false,
): string | null {
  if (!isRecord(raw)) return null;
  // On the first update the card should come alive fast, so a `skip` is
  // ignored as long as the model still gave a usable line.
  if (raw.skip === true && !isFirstUpdate) return null;
  const line = typeof raw.line === "string" ? raw.line.trim() : "";
  if (!line) return null;
  const rendered =
    line.length > PROGRESS_NARRATION_MAX_LINE_LENGTH ? `${line.slice(0, PROGRESS_NARRATION_MAX_LINE_LENGTH)}…` : line;
  if (rendered === lastLine) return null;
  return rendered;
}

export interface SummarizeProgressArgs {
  task: string;
  buffer: readonly ProgressBufferItem[];
  lastLine: string | null;
  telemetry: PlatformStructuredOutputTelemetry;
  log?: Logger;
  /** Injectable clock for tests / duration measurement. */
  now?: () => number;
  /** Hard timeout override (tests); defaults to PROGRESS_NARRATION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** First update for this session: never skip, so the card comes alive fast. */
  isFirstUpdate?: boolean;
}

/**
 * Synthesize one progress line via the cheap model. Fail-OPEN: returns null on
 * skip, error, timeout, empty output, or when the line matches lastLine. Never
 * throws. Emits a metadata-only debug log (model + duration) per call.
 */
export async function summarizeProgress(
  env: PlatformStructuredOutputEnv,
  args: SummarizeProgressArgs,
): Promise<string | null> {
  const now = args.now ?? Date.now;
  const timeoutMs = args.timeoutMs ?? PROGRESS_NARRATION_TIMEOUT_MS;
  const startedAt = now();
  let outcome: "line" | "skip" | "timeout" | "error" = "skip";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { systemPrompt, userPrompt } = buildProgressNarrationPrompt(args.task, args.buffer, args.isFirstUpdate);
    const queryPromise = queryPlatformStructuredOutput(
      env,
      {
        model: PROGRESS_NARRATION_MODEL,
        reasoningEffort: PROGRESS_NARRATION_REASONING_EFFORT,
        // Latency-sensitive live card: standard tier (not Flex), single attempt, hard timeout.
        serviceTier: OpenAIServiceTier.Auto,
        tool: PROGRESS_NARRATION_TOOL,
        systemPrompt,
        userPrompt,
        maxTokens: PROGRESS_NARRATION_MAX_TOKENS,
        timeoutMs,
        spanName: "slack.progress_narration",
      },
      args.telemetry,
    );
    // Swallow the loser's rejection so whichever promise loses the race never
    // surfaces as an unhandled rejection (the race handler still observes it).
    queryPromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProgressNarrationTimeoutError()), timeoutMs);
    });
    const raw = await Promise.race([queryPromise, timeoutPromise]);
    const line = coerceProgressLine(raw, args.lastLine, args.isFirstUpdate);
    outcome = line ? "line" : "skip";
    return line;
  } catch (err) {
    outcome = isTimeout(err) ? "timeout" : "error";
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    args.log?.info(
      {
        event: "slack.progress_narration.call",
        model: PROGRESS_NARRATION_MODEL,
        durationMs: now() - startedAt,
        outcome,
      },
      "Slack progress narration LLM call",
    );
  }
}

class ProgressNarrationTimeoutError extends Error {
  constructor() {
    super("slack progress narration timed out");
    this.name = "ProgressNarrationTimeoutError";
  }
}

function isTimeout(err: unknown): boolean {
  if (err instanceof ProgressNarrationTimeoutError) return true;
  const name = isRecord(err) ? err.name : undefined;
  return name === "AbortError" || name === "TimeoutError" || name === "StructuredOutputAbortError";
}

export interface ProgressNarrationGate {
  /** Slack-bound narration eligibility. */
  eligible: boolean;
  /** isCycloidMember for the session's business (internal-only rollout). */
  internal: boolean;
  /** Session is in the running phase (stale flushes must not repaint the card). */
  running: boolean;
  nowMs: number;
  lastAtMs: number;
  /** Another LLM call is already in flight for this session. */
  inFlight: boolean;
  /** The buffer changed since the last summary was produced. */
  bufferChanged: boolean;
}

/**
 * Pure cadence gate for the LLM narration path. All six conditions must hold.
 * Kept pure and exported so every false branch + the true case are unit-tested.
 */
export function shouldRunProgressNarration(gate: ProgressNarrationGate): boolean {
  if (!gate.eligible) return false;
  if (!gate.internal) return false;
  if (!gate.running) return false;
  if (gate.inFlight) return false;
  if (!gate.bufferChanged) return false;
  return gate.nowMs - gate.lastAtMs >= PROGRESS_NARRATION_INTERVAL_MS;
}
