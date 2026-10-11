import type { DiagnosticEntry } from "../../../../shared/types/sandbox.js";
import { DIAGNOSTICS_SECTION_HEADER, DIAGNOSTICS_SYSTEM_CONTEXT_TOKEN_BUDGET } from "../constants/bridge.js";
import { estimateTokens, estimateTokensForCharLength } from "./tokens.js";

export type PromptSystemContextPhase = "initial" | "followup";
export type SystemContextCadence = "always_on" | "conditional";
export type SystemContextSection = {
  name: string;
  content: string;
  promptPhase: PromptSystemContextPhase;
  cadence: SystemContextCadence;
};
export type MeasuredSystemContextSection = SystemContextSection & {
  tokenCountEstimate: number;
};
export type MeasuredSystemContext = {
  text: string | undefined;
  sections: MeasuredSystemContextSection[];
  totalTokenCountEstimate: number;
};

const DIAGNOSTIC_LINE_FORMAT_OVERHEAD = "(".length + ",".length + "): ".length + " — ".length;

function renderSectionsToText(sections: readonly SystemContextSection[]): string | undefined {
  return assembleSystemContext(sections.map((section) => section.content));
}

/**
 * Join non-empty sections into a single system context string.
 * Returns undefined if there are no sections (so the field can be omitted).
 */
function assembleSystemContext(sections: string[]): string | undefined {
  const filtered = sections.filter((s) => s.length > 0);
  return filtered.length > 0 ? filtered.join("\n\n") : undefined;
}

/**
 * Format accumulated diagnostics into a system context section that instructs the
 * agent to fix errors before continuing with new work.
 */
export function formatDiagnosticsReminder(
  entries: DiagnosticEntry[],
  tokenBudget = DIAGNOSTICS_SYSTEM_CONTEXT_TOKEN_BUDGET,
): string {
  if (entries.length === 0) return "";

  const normalizedTokenBudget = Math.max(0, Math.floor(tokenBudget));
  if (normalizedTokenBudget === 0) return "";

  const headerLines = [DIAGNOSTICS_SECTION_HEADER, "", "Fix these errors before continuing with new work.", ""];
  const headerCharLength = totalLineCharLength(headerLines);

  let selectedStart = entries.length;
  let selectedLineLength = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const nextSelectedLineLength = selectedLineLength + diagnosticLineLength(entries[i]);
    const nextSelectedCount = entries.length - i;
    const omittedCount = i;
    const candidateTokenCount = estimateTokensForCharLength(
      renderedDiagnosticsLength(
        headerCharLength,
        headerLines.length,
        nextSelectedLineLength,
        nextSelectedCount,
        omittedCount,
      ),
    );
    if (candidateTokenCount > normalizedTokenBudget) break;

    selectedStart = i;
    selectedLineLength = nextSelectedLineLength;
  }

  const selectedEntries = entries.slice(selectedStart);
  const omitted = entries.length - selectedEntries.length;
  if (selectedEntries.length === 0) {
    return formatNewestDiagnosticReminderWithinBudget(entries, headerLines, headerCharLength, normalizedTokenBudget);
  }

  // Group by file for readability
  const byFile = new Map<string, string[]>();
  for (const e of selectedEntries) {
    const lines = byFile.get(e.file) ?? [];
    lines.push(`(${e.line},${e.column}): ${e.severity} — ${e.message}`);
    byFile.set(e.file, lines);
  }

  const lines: string[] = [...headerLines];
  for (const [file, msgs] of byFile) {
    for (const msg of msgs) {
      lines.push(`${file}${msg}`);
    }
  }

  if (omitted > 0) {
    lines.push("", `[${omitted} more errors omitted]`);
  }

  return lines.join("\n");
}

function formatNewestDiagnosticReminderWithinBudget(
  entries: DiagnosticEntry[],
  headerLines: readonly string[],
  headerCharLength: number,
  tokenBudget: number,
): string {
  const newest = entries[entries.length - 1];
  const omitted = entries.length - 1;
  const diagnosticLine = formatDiagnosticLineWithinBudget(
    newest,
    headerCharLength,
    headerLines.length,
    omitted,
    tokenBudget,
  );
  if (!diagnosticLine) return "";

  const lines = [...headerLines, diagnosticLine];
  if (omitted > 0) {
    lines.push("", `[${omitted} more errors omitted]`);
  }

  return lines.join("\n");
}

function formatDiagnosticLine(entry: DiagnosticEntry): string {
  return `${entry.file}(${entry.line},${entry.column}): ${entry.severity} — ${entry.message}`;
}

function formatDiagnosticLineWithinBudget(
  entry: DiagnosticEntry,
  headerCharLength: number,
  headerLineCount: number,
  omitted: number,
  tokenBudget: number,
): string | undefined {
  if (diagnosticLineFits(headerCharLength, headerLineCount, diagnosticLineLength(entry), 1, omitted, tokenBudget)) {
    return formatDiagnosticLine(entry);
  }

  const prefix = formatDiagnosticLinePrefix(entry);
  const truncatedSuffix = " ...[message truncated]";
  const prefixOnly = `${entry.file}(${entry.line},${entry.column}): ${entry.severity}`;
  if (!diagnosticLineFits(headerCharLength, headerLineCount, prefixOnly.length, 1, omitted, tokenBudget)) {
    return undefined;
  }

  if (
    !diagnosticLineFits(
      headerCharLength,
      headerLineCount,
      prefix.length + truncatedSuffix.length,
      1,
      omitted,
      tokenBudget,
    )
  ) {
    return prefixOnly;
  }

  let low = 0;
  let high = entry.message.length;
  let selectedMessageLength = 0;
  while (low <= high) {
    const candidateMessageLength = Math.floor((low + high) / 2);
    const candidateLineLength = prefix.length + candidateMessageLength + truncatedSuffix.length;
    if (diagnosticLineFits(headerCharLength, headerLineCount, candidateLineLength, 1, omitted, tokenBudget)) {
      selectedMessageLength = candidateMessageLength;
      low = candidateMessageLength + 1;
    } else {
      high = candidateMessageLength - 1;
    }
  }

  return `${prefix}${entry.message.slice(0, selectedMessageLength)}${truncatedSuffix}`;
}

function formatDiagnosticLinePrefix(entry: DiagnosticEntry): string {
  return `${entry.file}(${entry.line},${entry.column}): ${entry.severity} — `;
}

function diagnosticLineLength(entry: DiagnosticEntry): number {
  return (
    entry.file.length +
    String(entry.line).length +
    String(entry.column).length +
    entry.severity.length +
    entry.message.length +
    DIAGNOSTIC_LINE_FORMAT_OVERHEAD
  );
}

function diagnosticLineFits(
  headerCharLength: number,
  headerLineCount: number,
  diagnosticLineLength: number,
  diagnosticLineCount: number,
  omitted: number,
  tokenBudget: number,
): boolean {
  return (
    estimateTokensForCharLength(
      renderedDiagnosticsLength(headerCharLength, headerLineCount, diagnosticLineLength, diagnosticLineCount, omitted),
    ) <= tokenBudget
  );
}

function totalLineCharLength(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0);
}

function omittedLineLength(omitted: number): { lineCount: number; charCount: number } {
  if (omitted <= 0) return { lineCount: 0, charCount: 0 };

  const omittedLine = `[${omitted} more errors omitted]`;
  return {
    lineCount: 2,
    charCount: omittedLine.length,
  };
}

function renderedDiagnosticsLength(
  headerLength: number,
  headerLineCount: number,
  diagnosticLineLength: number,
  diagnosticLineCount: number,
  omitted: number,
): number {
  const omittedLines = omittedLineLength(omitted);
  const lineCount = headerLineCount + diagnosticLineCount + omittedLines.lineCount;
  if (lineCount === 0) return 0;

  return headerLength + diagnosticLineLength + omittedLines.charCount + lineCount - 1;
}

export function measureSystemContextSections(sections: readonly SystemContextSection[]): MeasuredSystemContext {
  const filtered = sections.filter((section) => section.content.length > 0);
  if (filtered.length === 0) {
    return { text: undefined, sections: [], totalTokenCountEstimate: 0 };
  }

  const measuredSections: MeasuredSystemContextSection[] = [];
  const renderedSections: SystemContextSection[] = [];
  let previousTotal = 0;

  // Measure each section by its incremental contribution to the fully rendered
  // payload so the per-section estimates reconcile exactly with the final total.
  for (const section of filtered) {
    renderedSections.push(section);
    const renderedText = renderSectionsToText(renderedSections) ?? "";
    const currentTotal = estimateTokens(renderedText);
    measuredSections.push({
      ...section,
      tokenCountEstimate: currentTotal - previousTotal,
    });
    previousTotal = currentTotal;
  }

  return {
    text: renderSectionsToText(filtered),
    sections: measuredSections,
    totalTokenCountEstimate: previousTotal,
  };
}
