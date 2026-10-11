import type { PlanContext } from "./types/sandbox.js";

export const PLAN_CAPTURE_MAX_CHARS = 60_000;
export const PLAN_CONTEXT_MAX_CHARS = 12_000;

export type PlanModeSetting = "off" | "on" | "auto";

export function normalizePlanModeSetting(value: string | undefined): PlanModeSetting | undefined {
  if (value === "off" || value === "on" || value === "auto") return value;
  return undefined;
}

const REQUIRED_PLAN_HEADINGS = ["intent restatement", "ordered steps", "files to touch"] as const;

export type PlanValidationResult = {
  valid: boolean;
  missingHeadings: string[];
  reason?: string;
};

export type PlanModeToolEvent = {
  type: string;
  tool?: string;
  status?: string;
  toolStatus?: string;
  input?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

export type PlanModeResearchReuseCounts = {
  discoveryOps: number;
  readOps: number;
};

export function normalizePlanMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").trim();
}

function normalizeHeadingText(heading: string): string {
  return heading
    .replace(/[`*_~:[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function validatePlanMarkdown(markdown: string): PlanValidationResult {
  const normalized = normalizePlanMarkdown(markdown);
  if (!normalized) {
    return { valid: false, missingHeadings: [...REQUIRED_PLAN_HEADINGS], reason: "empty_plan" };
  }
  if (!/^#\s+Plan\b/m.test(normalized)) {
    return { valid: false, missingHeadings: [...REQUIRED_PLAN_HEADINGS], reason: "missing_plan_title" };
  }

  const headings = new Set<string>();
  for (const match of normalized.matchAll(/^#{2,3}\s+(.+)$/gm)) {
    headings.add(normalizeHeadingText(match[1] ?? ""));
  }

  const missingHeadings = REQUIRED_PLAN_HEADINGS.filter((heading) => {
    if (headings.has(heading)) return false;
    return ![...headings].some((candidate) => candidate.includes(heading));
  });
  return {
    valid: missingHeadings.length === 0,
    missingHeadings,
    ...(missingHeadings.length > 0 ? { reason: "missing_required_headings" } : {}),
  };
}

export function truncatePlanText(markdown: string, maxChars = PLAN_CAPTURE_MAX_CHARS): string {
  if (markdown.length <= maxChars) return markdown;
  return `${markdown.slice(0, maxChars)}\n\n[plan truncated]`;
}

export function countPlanFilesToTouch(markdown: string): number {
  const normalized = normalizePlanMarkdown(markdown);
  const lines = normalized.split("\n");
  const headingIndex = lines.findIndex((line) => /^#{2,3}\s+Files To Touch\s*$/i.test(line.trim()));
  if (headingIndex < 0) return 0;
  const section: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{2,3}\s+\S/.test(line.trim())) break;
    section.push(line);
  }
  return section.map((line) => line.trim()).filter((line) => /^[-*+]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line))
    .length;
}

export function isPlanContextExcerptTruncated(excerpt: string): boolean {
  return excerpt.includes("[plan excerpt truncated]");
}

function toolInputCommand(input: Record<string, unknown> | undefined): string {
  const command = input?.command;
  return typeof command === "string" ? command : "";
}

function isSuccessfulToolCall(event: PlanModeToolEvent): boolean {
  const status =
    event.toolStatus ??
    event.status ??
    (typeof event.data?.toolStatus === "string" ? event.data.toolStatus : undefined) ??
    (typeof event.data?.status === "string" ? event.data.status : undefined);
  return status !== "error" && status !== "running";
}

function toolName(event: PlanModeToolEvent): string {
  const value = event.tool ?? event.data?.tool;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function toolInput(event: PlanModeToolEvent): Record<string, unknown> | undefined {
  if (event.input && typeof event.input === "object") return event.input;
  const input = event.data?.input;
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function commandContainsExecutable(command: string, executables: readonly string[]): boolean {
  const escaped = executables.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(^|[\\s;&|()])(?:${escaped})(?=$|[\\s;&|()])`).test(command);
}

function classifyToolCall(event: PlanModeToolEvent): "discovery" | "read" | null {
  if (event.type !== "tool_call" || !isSuccessfulToolCall(event)) return null;

  const tool = toolName(event);
  if (["grep", "glob", "list", "ls", "find"].includes(tool)) return "discovery";
  if (["read", "open"].includes(tool)) return "read";

  if (tool !== "bash") return null;

  const command = toolInputCommand(toolInput(event)).toLowerCase();
  if (!command) return null;
  if (commandContainsExecutable(command, ["rg", "grep", "find", "ls"])) return "discovery";
  if (commandContainsExecutable(command, ["sed", "cat", "head", "tail", "nl", "less", "awk", "jq"])) return "read";
  return null;
}

export function summarizePlanModeResearchReuse(events: PlanModeToolEvent[]): PlanModeResearchReuseCounts {
  let discoveryOps = 0;
  let readOps = 0;
  for (const event of events) {
    const classification = classifyToolCall(event);
    if (classification === "discovery") discoveryOps += 1;
    if (classification === "read") readOps += 1;
  }
  return { discoveryOps, readOps };
}

export function buildPlanContext(input: {
  markdown?: string | null;
  artifactId?: string | null;
  missingReason?: string | null;
  planPromptId: string;
  revision?: number;
  userEdited?: boolean;
  valid: boolean;
}): PlanContext {
  const normalized = normalizePlanMarkdown(input.markdown ?? "");
  const excerpt =
    normalized.length > PLAN_CONTEXT_MAX_CHARS
      ? `${normalized.slice(0, PLAN_CONTEXT_MAX_CHARS)}\n\n[plan excerpt truncated]`
      : normalized;
  return {
    planPromptId: input.planPromptId,
    valid: input.valid,
    excerpt,
    artifactId: input.artifactId ?? null,
    missingReason: input.missingReason ?? null,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.userEdited === undefined ? {} : { userEdited: input.userEdited }),
  };
}
