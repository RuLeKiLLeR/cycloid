/**
 * Canonical tool-name constants and classifiers for UI code.
 *
 * Raw tool names arrive from the bridge/sandbox in mixed case. Normalize with
 * `normalizeToolName()` (or just call the classifiers, which handle it) before
 * comparing. Do not compare tool names via raw string literals elsewhere.
 *
 * Semantic tool categories for visual styling tiers in the transcript:
 * - readonly: read, grep, glob, ls -- muted styling
 * - mutating: edit, write, bash -- stronger styling
 * - planning: todowrite, agent, task, batch -- highlighted structural styling
 */

import { normalizeToolName } from "../../../../shared/tools/names.js";

export { normalizeToolName };

export const TOOL_NAMES = {
  READ: "read",
  EDIT: "edit",
  WRITE: "write",
  BASH: "bash",
  GLOB: "glob",
  GREP: "grep",
  LS: "ls",
  TODOWRITE: "todowrite",
  AGENT: "agent",
  TASK: "task",
  BATCH: "batch",
} as const;

type ToolCategory = "readonly" | "mutating" | "planning";

const READONLY_TOOLS = new Set([
  TOOL_NAMES.READ,
  TOOL_NAMES.GREP,
  TOOL_NAMES.GLOB,
  TOOL_NAMES.LS,
  "cat",
  "head",
  "tail",
  "find",
  "git_status",
  "git_log",
  "git_diff",
  "web_search",
  "web_fetch",
  "lsp",
]);

const MUTATING_TOOLS = new Set<string>([
  TOOL_NAMES.EDIT,
  TOOL_NAMES.WRITE,
  TOOL_NAMES.BASH,
  "notebook_edit",
  "git_commit",
  "git_push",
]);

const PLANNING_TOOLS = new Set<string>([
  TOOL_NAMES.TODOWRITE,
  TOOL_NAMES.AGENT,
  TOOL_NAMES.TASK,
  TOOL_NAMES.BATCH,
  "ask_user_question",
]);

export function getToolCategory(toolName: string): ToolCategory {
  const lower = normalizeToolName(toolName);
  if (PLANNING_TOOLS.has(lower)) return "planning";
  if (MUTATING_TOOLS.has(lower)) return "mutating";
  if (READONLY_TOOLS.has(lower)) return "readonly";
  // Default: unknown tools get readonly styling (safest default)
  return "readonly";
}

/** True if this tool name represents the canonical todo-list write. */
export function isTodoTool(tool: string | null | undefined): boolean {
  return normalizeToolName(tool) === TOOL_NAMES.TODOWRITE;
}

/** True if this tool name represents the read tool (single file read). */
export function isReadTool(tool: string | null | undefined): boolean {
  return normalizeToolName(tool) === TOOL_NAMES.READ;
}

/** True if this tool name represents a file-mutating tool (edit or write). */
export function isFileChangeTool(tool: string | null | undefined): boolean {
  const lower = normalizeToolName(tool);
  return lower === TOOL_NAMES.EDIT || lower === TOOL_NAMES.WRITE;
}

/** True if this tool name represents a parallel batch of tool calls. */
export function isBatchTool(tool: string | null | undefined): boolean {
  return normalizeToolName(tool) === TOOL_NAMES.BATCH;
}

/**
 * Tool calls that `groupConsecutiveToolCalls` will collapse into a single
 * block when three or more appear consecutively with the same name.
 * Excludes structural tools (batch, todowrite, agent/task).
 */
export function isGroupableToolCall(tool: string | null | undefined): boolean {
  const lower = normalizeToolName(tool);
  if (!lower) return false;
  if (lower === TOOL_NAMES.BATCH) return false;
  if (lower === TOOL_NAMES.TODOWRITE) return false;
  if (lower === TOOL_NAMES.AGENT || lower === TOOL_NAMES.TASK) return false;
  return true;
}

export const TOOL_CATEGORY_STYLES: Record<ToolCategory, { badge: string; surface?: string }> = {
  readonly: {
    badge: "bg-text-muted/15 text-text-muted",
  },
  mutating: {
    badge: "bg-warning-soft text-warning",
    surface: "session-stack-surface-warning-muted",
  },
  planning: {
    badge: "bg-accent-soft text-accent",
    surface: "session-stack-surface-accent-muted",
  },
};
