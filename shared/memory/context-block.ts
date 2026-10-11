// Single source of truth for the `<cycloid_memory_context>` block rendering,
// the confidence/enforcement coercers, and their thresholds. Shared by the
// control-plane query pipeline (context-query.ts / context-consolidation.ts)
// and the sandbox-bridge memory tool so the rendered block stays byte-identical
// (shared/memory/task-denoising.ts strips it by regex and prompt goldens assert
// the exact format) and there is exactly one confidence-bucketing rule.

import { escapeHtml } from "../utils/html";

export type MemoryContextConfidence = "low" | "medium" | "high";
export type MemoryContextEnforcement = "none" | "suggest" | "warn" | "block";

// Numeric confidence buckets: >= HIGH -> "high", >= MEDIUM -> "medium", else "low".
export const MEMORY_CONFIDENCE_HIGH_THRESHOLD = 0.8;
export const MEMORY_CONFIDENCE_MEDIUM_THRESHOLD = 0.55;

export type MemoryContextBlockMemory = {
  id: string;
  kind: string;
  content: string;
  level: string | null;
  whyReturned: string;
  confidence: string;
  enforcement: string;
  provenance: Array<{ sourceKind: string; sourceId: string; excerpt: string | null }>;
};

// Strict parse: returns the literal or null for anything invalid.
export function parseMemoryConfidence(value: unknown): MemoryContextConfidence | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

// Defaulting coercer used where an unknown/invalid value should degrade to "medium".
export function confidenceValue(value: unknown): MemoryContextConfidence {
  return parseMemoryConfidence(value) ?? "medium";
}

export function confidenceFromNumber(value: number): MemoryContextConfidence {
  if (value >= MEMORY_CONFIDENCE_HIGH_THRESHOLD) return "high";
  if (value >= MEMORY_CONFIDENCE_MEDIUM_THRESHOLD) return "medium";
  return "low";
}

// Strict parse: returns the literal or null for anything invalid.
export function parseMemoryEnforcement(value: unknown): MemoryContextEnforcement | null {
  return value === "none" || value === "suggest" || value === "warn" || value === "block" ? value : null;
}

// Defaulting coercer used where an unknown/invalid value should degrade to "none".
export function enforcementValue(value: unknown): MemoryContextEnforcement {
  return parseMemoryEnforcement(value) ?? "none";
}

export const escapeMemoryXmlText = escapeHtml;

export function formatMemoryContextBlock(
  memories: MemoryContextBlockMemory[],
  traceId: string,
  options?: { unavailable?: boolean },
): string {
  const lines = [`<cycloid_memory_context trace_id="${escapeMemoryXmlText(traceId)}">`];
  for (const memory of memories) {
    const levelAttribute =
      memory.kind === "derived_conclusion" && memory.level ? ` level="${escapeMemoryXmlText(memory.level)}"` : "";
    lines.push(
      `  <memory id="${escapeMemoryXmlText(memory.id)}" kind="${escapeMemoryXmlText(
        memory.kind,
      )}" confidence="${escapeMemoryXmlText(memory.confidence)}" enforcement="${escapeMemoryXmlText(
        memory.enforcement,
      )}"${levelAttribute}>`,
    );
    lines.push(`    ${escapeMemoryXmlText(memory.content)}`);
    lines.push(`    <why>${escapeMemoryXmlText(memory.whyReturned)}</why>`);
    lines.push("    <provenance>");
    for (const source of memory.provenance) {
      lines.push(
        `      <source kind="${escapeMemoryXmlText(source.sourceKind)}" id="${escapeMemoryXmlText(source.sourceId)}">${
          source.excerpt ? escapeMemoryXmlText(source.excerpt) : ""
        }</source>`,
      );
    }
    lines.push("    </provenance>");
    lines.push("  </memory>");
  }
  if (memories.length === 0) {
    lines.push(
      options?.unavailable
        ? "  <empty>Memory context is temporarily unavailable.</empty>"
        : "  <empty>No memory was selected for this request.</empty>",
    );
  }
  lines.push("</cycloid_memory_context>");
  return lines.join("\n");
}
