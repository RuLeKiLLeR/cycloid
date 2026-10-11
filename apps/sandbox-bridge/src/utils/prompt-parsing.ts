import type { MemoryRef } from "../../../../shared/events/bridge.js";
import {
  COMPANY_MEMORY_CONTEXT_FOOTER,
  COMPANY_MEMORY_CONTEXT_HEADER,
  SIMILAR_SESSION_TASK_SEPARATOR,
} from "../constants/observability.js";
import { estimateTokens } from "./tokens.js";

/**
 * Context blocks the control plane may prepend to the user message, each terminated by
 * SIMILAR_SESSION_TASK_SEPARATOR. Stacked blocks may contain company memory.
 */
const INJECTED_CONTEXT_BLOCKS = [
  { header: COMPANY_MEMORY_CONTEXT_HEADER, footer: COMPANY_MEMORY_CONTEXT_FOOTER },
] as const;

/**
 * Split injected prompt content into the injected-context prefix (first header through last
 * footer, inclusive) and the current task text. When the content does not start with a
 * complete injected block (header, footer, then task separator), `historical` is empty and
 * `task` is the original content unchanged. Single source of truth for the marker walk used
 * by both {@link splitHistoricalSessionContent} and {@link extractCurrentTaskText}.
 */
export function parseInjectedContext(content: string): { historical: string; task: string } {
  let offset = 0;
  for (;;) {
    const rest = content.slice(offset);
    const block = INJECTED_CONTEXT_BLOCKS.find((candidate) => rest.startsWith(candidate.header));
    if (!block) break;
    const footerIndex = rest.indexOf(block.footer);
    if (footerIndex === -1) break;
    const blockEnd = footerIndex + block.footer.length;
    if (!rest.slice(blockEnd).startsWith(SIMILAR_SESSION_TASK_SEPARATOR)) break;
    offset += blockEnd + SIMILAR_SESSION_TASK_SEPARATOR.length;
  }
  if (offset === 0) return { historical: "", task: content };
  return {
    historical: content.slice(0, offset - SIMILAR_SESSION_TASK_SEPARATOR.length),
    task: content.slice(offset),
  };
}

export function splitHistoricalSessionContent(content: string): {
  historicalSessionTokens: number;
  taskTextTokens: number;
} {
  const { historical, task } = parseInjectedContext(content);
  return {
    historicalSessionTokens: historical ? estimateTokens(historical) : 0,
    taskTextTokens: estimateTokens(task),
  };
}

export function extractCurrentTaskText(content: string): string {
  const trimmed = content.trim();
  const { historical, task } = parseInjectedContext(trimmed);
  if (!historical) return trimmed;
  // When historical is truthy the separator was found intact inside `trimmed`, and `trimmed`
  // never ends in whitespace, so the task suffix always ends in a non-whitespace char — i.e.
  // task.trim() is always non-empty here. No empty-task fallback is reachable.
  return task.trim();
}

export function formatSessionUrl(controlPlaneUrl: string, sessionId: string): string | undefined {
  const base = controlPlaneUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/sessions/${encodeURIComponent(sessionId)}` : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function optionalStringField<T extends string>(key: T, value: unknown): { [K in T]?: string } {
  return typeof value === "string" && value.trim().length > 0 ? ({ [key]: value } as { [K in T]: string }) : {};
}

export function optionalStringArrayField<T extends string>(key: T, value: unknown): { [K in T]?: string[] } {
  const values = stringArray(value);
  return values.length > 0 ? ({ [key]: values } as { [K in T]: string[] }) : {};
}

export function optionalRecordField<T extends string>(key: T, value: unknown): { [K in T]?: Record<string, unknown> } {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ [key]: value } as { [K in T]: Record<string, unknown> })
    : {};
}

export function memoryRefArray(value: unknown): MemoryRef[] {
  if (!Array.isArray(value)) return [];
  const refs: MemoryRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const ref: MemoryRef = { id };
    if (typeof record.path === "string" && record.path.trim()) ref.path = record.path.trim();
    if (typeof record.title === "string" && record.title.trim()) ref.title = record.title.trim();
    refs.push(ref);
  }
  return refs;
}

export function optionalMemoryRefArrayField<T extends string>(key: T, value: unknown): { [K in T]?: MemoryRef[] } {
  const values = memoryRefArray(value);
  return values.length > 0 ? ({ [key]: values } as { [K in T]: MemoryRef[] }) : {};
}
