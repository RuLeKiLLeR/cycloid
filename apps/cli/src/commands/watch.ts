import type { Command } from "commander";

import { isNoChangesPromptResult, noChangeOutcomeCopy } from "../../../../shared/session/no-change-outcome.js";
import type { Phase } from "../../../../shared/session/phase.js";
import type { DisconnectMask, LifecycleView } from "../../../../shared/session/transient-disconnect.js";
import { applyDisconnectMask, nextDisconnectMask } from "../../../../shared/session/transient-disconnect.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { sleep } from "../../../../shared/utils/timing.js";
import { apiFetch, apiFetchText } from "../api.js";
import type { CliConfig } from "../config.js";
import { requireConfig } from "../config.js";
import {
  DEFAULT_WATCH_POLL_INTERVAL_MS,
  isWatchTerminal,
  MAX_WATCH_POLL_INTERVAL_MS,
  MIN_WATCH_POLL_INTERVAL_MS,
  WATCH_REPLAY_PAGE_SIZE,
} from "../constants/watch.js";
import { CliError } from "../errors.js";
import { getRuntimeOptions, isJson, type RuntimeOptions } from "../runtime.js";
import {
  buildPromptLabelMap,
  parseSsePayload,
  renderWatchEvent,
  VALID_PHASES,
  type WatchRenderState,
  type WatchStatusEvent,
} from "../utils/session-output.js";

type PromptSummary = {
  promptId: string;
  prompt: string;
  replyToText?: string | null;
};

export function parsePollInterval(raw: string | undefined): number {
  if (!raw) return DEFAULT_WATCH_POLL_INTERVAL_MS;
  if (!/^\d+$/.test(raw)) {
    throw new CliError("user", "Polling interval must be a non-negative integer.");
  }
  const value = Number(raw);
  if (value < MIN_WATCH_POLL_INTERVAL_MS || value > MAX_WATCH_POLL_INTERVAL_MS) {
    throw new CliError(
      "user",
      `Polling interval must be between ${MIN_WATCH_POLL_INTERVAL_MS} and ${MAX_WATCH_POLL_INTERVAL_MS} milliseconds.`,
    );
  }
  return value;
}

function parseNonNegativeInteger(raw: string | undefined, name: string, defaultValue: number): number {
  if (!raw) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new CliError("user", `${name} must be a non-negative integer.`);
  }
  return Number(raw);
}

function formatStatusLine(status: {
  phase: string | null;
  sandboxSubstate?: string;
  stopMode?: string;
  finalizingStep?: string;
  title?: string;
  spawnDurationMs?: number | null;
}): string {
  const label = status.phase ?? "unknown";
  const substate: string[] = [];
  if (status.sandboxSubstate && status.sandboxSubstate !== "none") substate.push(status.sandboxSubstate);
  if (status.stopMode && status.stopMode !== "none") substate.push(status.stopMode);
  if (status.finalizingStep && status.finalizingStep !== "none") {
    substate.push(status.finalizingStep === "post_execution" ? "verification" : status.finalizingStep);
  }
  const phaseLabel = substate.length > 0 ? `${label}/${substate.join("/")}` : label;
  const details: string[] = [];
  if (status.title) details.push(status.title);
  if (status.spawnDurationMs != null) details.push(`spawn ${(status.spawnDurationMs / 1000).toFixed(1)}s`);
  return details.length > 0 ? `[status] ${phaseLabel} | ${details.join(" | ")}` : `[status] ${phaseLabel}`;
}

// Transient-disconnect mask for the watch status line: a live transition into
// `reconnecting` keeps printing the pre-disconnect phase/substate until the
// disconnect outlives the shared visibility threshold. The terminal-phase
// check below uses the raw status; only the printed line is held back. See
// shared/session/transient-disconnect.ts.
export function advanceStatusDisconnectMask(
  status: WatchStatusEvent,
  mask: DisconnectMask | null,
  lastView: LifecycleView | null,
  now: number,
): { displayStatus: WatchStatusEvent; mask: DisconnectMask | null; view: LifecycleView | null } {
  const view: LifecycleView | null = status.phase
    ? { phase: status.phase, sandboxSubstate: status.sandboxSubstate }
    : null;
  const nextMask = nextDisconnectMask(mask, lastView, view, now);
  const displayStatus = view ? { ...status, ...applyDisconnectMask(view, nextMask, now) } : status;
  return { displayStatus, mask: nextMask, view };
}

// At terminal phase, the polled event stream does not carry prompt result data,
// so a no-change session would end as a bare `[status] completed`. Read the
// latest completed prompt result from the prompts endpoint (same auth the other
// CLI commands use) and render the shared no-change copy. The session view's
// `/view` outcome is not used here because it is repo-access gated and 403s for
// CLI tokens that the prompts/export endpoints accept.
// Best-effort: the terminal status line already printed if this fails.
async function printNoChangeOutcome(config: CliConfig, sessionId: string): Promise<void> {
  try {
    const data = await apiFetch<{ prompts?: Array<{ status?: string; result?: unknown }> }>(
      config,
      `/api/sessions/${sessionId}/prompts`,
    );
    const prompts = data.prompts ?? [];
    // Most recent completed prompt wins, mirroring the session view + transcript.
    for (let i = prompts.length - 1; i >= 0; i--) {
      if (prompts[i].status !== "completed") continue;
      const result = prompts[i].result;
      if (isNoChangesPromptResult(result)) {
        console.log(`[outcome] ${noChangeOutcomeCopy(result.noChangeReason).title}`);
      }
      break;
    }
  } catch {
    // Non-fatal: watch already reported the terminal status.
  }
}

export async function fetchPromptLabels(config: CliConfig, sessionId: string): Promise<Map<string, string>> {
  const data = await apiFetch<{ prompts: PromptSummary[] }>(config, `/api/sessions/${sessionId}/prompts`);
  return buildPromptLabelMap(data.prompts);
}

// Pulls `phase` off the session view payload. Both `payload.session.*` (view shape)
// and a flat `payload.*` shape are tolerated since callers point at different
// endpoints over time.
export function extractSessionLifecycle(payload: Record<string, unknown>): {
  phase: Phase | null;
} {
  const session = payload.session as Record<string, unknown> | undefined;
  const root = session && typeof session === "object" ? session : payload;
  const phaseRaw = root.phase;
  // Validate against the known phase set so unknown strings (e.g. from a newer
  // server) drop to `null` — callers treat that as non-terminal and keep polling.
  const phase = typeof phaseRaw === "string" && VALID_PHASES.has(phaseRaw as Phase) ? (phaseRaw as Phase) : null;
  return { phase };
}

export async function watchCommand(
  sessionId: string,
  options: { pollInterval?: string; afterSequence?: string; limit?: string; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  const pollIntervalMs = parsePollInterval(options.pollInterval);
  const initialAfterSequence = parseNonNegativeInteger(options.afterSequence, "--after-sequence", 0);
  const pageSize = parseNonNegativeInteger(options.limit, "--limit", WATCH_REPLAY_PAGE_SIZE);
  if (pageSize === 0) {
    throw new CliError("user", "--limit must be greater than 0.");
  }
  const json = isJson(command, options);

  let promptLabels = new Map<string, string>();
  if (!json) {
    try {
      promptLabels = await fetchPromptLabels(config, sessionId);
    } catch (err) {
      console.error(`Warning: failed to fetch prompt labels for session ${sessionId}: ${stringifyError(err)}`);
    }
  }

  const renderState: WatchRenderState = {
    promptLabels,
    toolCalls: new Map(),
  };

  let afterSequence = initialAfterSequence;
  let lastStatusLine: string | null = null;
  let textOpen = false;
  // Transient-disconnect mask: keep printing the pre-disconnect phase while a
  // live `reconnecting` transition is younger than the shared visibility
  // threshold. See shared/session/transient-disconnect.ts.
  let disconnectMask: DisconnectMask | null = null;
  let lastStatusView: LifecycleView | null = null;

  if (!json) console.log(`Watching session ${sessionId}...`);

  try {
    while (true) {
      const query = new URLSearchParams({
        afterSequence: String(afterSequence),
        limit: String(pageSize),
      });
      const payload = await apiFetchText(config, `/api/sessions/${sessionId}/events?${query}`);
      const parsed = parseSsePayload(payload);
      const receivedFullPage = parsed.events.length >= pageSize;

      if (!json && parsed.status) {
        const advanced = advanceStatusDisconnectMask(parsed.status, disconnectMask, lastStatusView, Date.now());
        disconnectMask = advanced.mask;
        lastStatusView = advanced.view;
        const nextStatusLine = formatStatusLine(advanced.displayStatus);
        if (nextStatusLine !== lastStatusLine) {
          if (textOpen) {
            process.stdout.write("\n");
            textOpen = false;
          }
          console.log(nextStatusLine);
          lastStatusLine = nextStatusLine;
        }
      }

      for (const event of parsed.events) {
        if (typeof event.id === "number" && event.id > afterSequence) afterSequence = event.id;

        if (json) {
          process.stdout.write(`${JSON.stringify({ sequence: event.id, type: event.type, data: event.data })}\n`);
          continue;
        }

        const rendered = renderWatchEvent(event, renderState);
        if (!rendered) continue;

        if (rendered.kind === "text") {
          if (!rendered.text) continue;
          if (!textOpen) {
            process.stdout.write("assistant> ");
            textOpen = true;
          }
          process.stdout.write(rendered.text);
          continue;
        }

        if (textOpen) {
          process.stdout.write("\n");
          textOpen = false;
        }
        console.log(rendered.line);
      }

      if (receivedFullPage) continue;
      if (parsed.status?.phase && isWatchTerminal(parsed.status.phase)) {
        // Only `completed` carries a no-change outcome, matching the server
        // view's `phase === "completed"` gate. Stopped/failed/archived terminal
        // phases must not print a "completed without changes" line.
        if (!json && parsed.status.phase === "completed") {
          if (textOpen) {
            process.stdout.write("\n");
            textOpen = false;
          }
          await printNoChangeOutcome(config, sessionId);
        }
        break;
      }

      await sleep(pollIntervalMs);
    }
  } finally {
    if (textOpen) process.stdout.write("\n");
  }
}
