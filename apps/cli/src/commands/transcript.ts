import type { Command } from "commander";

import { getRawSessionEventKind, getRawSessionEventPromptId } from "../../../../shared/transcript/projector.js";
import { apiFetch } from "../api.js";
import { CliError } from "../errors.js";
import { emit, isJson, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";
import type { SessionExportData } from "../utils/session-output.js";
import { renderSessionTranscript } from "../utils/session-output.js";

export async function transcriptCommand(
  sessionId: string,
  options: { last?: string; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const last = parseLast(options.last);

  const exportData = await apiFetch<SessionExportData>(config, `/api/sessions/${sessionId}/export`);
  const payload =
    last == null ? exportData : sliceTranscript(exportData, last, { includeBoundaryEvent: !isJson(command, options) });
  emit(command, options, payload, (data) => console.log(renderSessionTranscript(data)));
}

function parseLast(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliError("user", "--last must be a positive integer.");
  return parsed;
}

function sliceTranscript(
  exportData: SessionExportData,
  last: number,
  options: { includeBoundaryEvent: boolean },
): SessionExportData {
  const start = Math.max(0, exportData.events.length - last);
  const boundary = findPromptBoundary(exportData.events, start);
  const tail = exportData.events.slice(start);
  const events =
    options.includeBoundaryEvent && boundary !== null && boundary < start
      ? [exportData.events[boundary], ...tail]
      : tail;
  const promptIds = promptIdsForEvents(events);
  if (boundary !== null) {
    const boundaryPromptId = getRawSessionEventPromptId(exportData.events[boundary]);
    if (boundaryPromptId) promptIds.add(boundaryPromptId);
  }
  const prompts = exportData.prompts.filter((prompt) => promptIds.has(prompt.id));
  return { ...exportData, prompts, events };
}

function findPromptBoundary(events: SessionExportData["events"], start: number): number | null {
  for (let index = start; index >= 0; index--) {
    const event = events[index];
    if (event && getRawSessionEventKind(event) === "prompt_processing") return index;
  }
  return null;
}

function promptIdsForEvents(events: SessionExportData["events"]): Set<string> {
  const promptIds = new Set<string>();
  for (const event of events) {
    const promptId = getRawSessionEventPromptId(event);
    if (promptId) promptIds.add(promptId);
  }
  return promptIds;
}
