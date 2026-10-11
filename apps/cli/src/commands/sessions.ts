import type { Command } from "commander";

import {
  getRawSessionEventData,
  getRawSessionEventKind,
  type RawSessionEvent,
} from "../../../../shared/transcript/projector.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { apiFetch } from "../api.js";
import { requireConfig } from "../config.js";
import { CliError } from "../errors.js";
import { getRuntimeOptions, isJson, type RuntimeOptions, writeJson } from "../runtime.js";
import { formatSessionResult, renderWatchEvent, type WatchRenderState } from "../utils/session-output.js";
import { fetchPromptLabels, watchCommand } from "./watch.js";

type SessionListOptions = {
  status?: string;
  scope?: "business" | "mine";
  search?: string;
  repo?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  json?: boolean;
} & RuntimeOptions;

const MAX_ALL_PAGES = 1000;

export async function listSessionsCommand(options: SessionListOptions, command?: Command): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  const sessions: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = options.cursor;
  let nextCursor: string | null = null;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (options.all === true && pageCount > MAX_ALL_PAGES) {
      throw new CliError("user", `sessions list --all exceeded ${MAX_ALL_PAGES} pages without reaching the end.`);
    }
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    if (options.scope) query.set("scope", options.scope);
    if (options.search) query.set("q", options.search);
    if (options.repo) query.set("repo", options.repo);
    if (options.limit) query.set("limit", options.limit);
    if (cursor) query.set("cursor", cursor);

    const payload = await apiFetch<{ sessions: Array<Record<string, unknown>>; nextCursor: string | null }>(
      config,
      `/api/sessions${query.size ? `?${query.toString()}` : ""}`,
    );
    sessions.push(...payload.sessions);
    nextCursor = payload.nextCursor;
    cursor = nextCursor ?? undefined;
  } while (options.all === true && nextCursor);
  const payload = { sessions, nextCursor: options.all === true ? null : nextCursor };
  if (isJson(command, options)) {
    writeJson(payload);
    return;
  }
  if (payload.sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  for (const session of payload.sessions) {
    const id = String(session.id ?? session.sessionId ?? "");
    const status = String(session.status ?? "");
    const title = typeof session.title === "string" ? ` ${session.title}` : "";
    console.log(`${id}\t${status}${title}`);
  }
  if (payload.nextCursor) console.log(`Next cursor: ${payload.nextCursor}`);
}

export async function searchSessionsCommand(
  query: string,
  options: Omit<SessionListOptions, "search">,
  command?: Command,
): Promise<void> {
  await listSessionsCommand({ ...options, search: query }, command);
}

export async function getSessionCommand(
  sessionId: string,
  options: { json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  const payload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}`);
  if (isJson(command, options)) {
    writeJson(payload);
    return;
  }
  const session = (payload.session && typeof payload.session === "object" ? payload.session : payload) as Record<
    string,
    unknown
  >;
  console.log(`Session: ${String(session.sessionId ?? session.id ?? sessionId)}`);
  // The GET /api/sessions/:id payload carries the DO state shape, where `status`
  // is the archival flag (active|archived) and `phase` is the lifecycle state
  // (running/completed/failed/...). Surface `phase` to match the UI; fall back to
  // `status` only when `phase` is absent.
  console.log(`Status: ${String(session.phase ?? session.status ?? "unknown")}`);
  if (session.repoUrl) console.log(`Repo: ${String(session.repoUrl)}`);
  if (session.title) console.log(`Title: ${String(session.title)}`);
  const resultLine = formatSessionResult(session);
  if (resultLine) console.log(resultLine);
}

export async function sessionEventsCommand(
  sessionId: string,
  options: {
    afterSequence?: string;
    after?: string;
    beforeSequence?: string;
    before?: string;
    promptId?: string;
    limit?: string;
    follow?: boolean;
    pollInterval?: string;
    json?: boolean;
  } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const afterSequence = resolveSequenceOption(options.afterSequence, options.after, "--after-sequence", "--after");
  const beforeSequence = resolveSequenceOption(options.beforeSequence, options.before, "--before-sequence", "--before");

  if (options.follow) {
    if (beforeSequence) {
      throw new CliError("user", "--before-sequence/--before cannot be used with --follow.");
    }
    if (options.promptId) {
      throw new CliError(
        "user",
        "--prompt-id cannot be used with --follow because the follow endpoint does not support prompt filtering.",
      );
    }
    await watchCommand(
      sessionId,
      { ...options, pollInterval: options.pollInterval, afterSequence, limit: options.limit },
      command,
    );
    return;
  }

  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  const query = new URLSearchParams();
  if (afterSequence) query.set("after_sequence", afterSequence);
  if (beforeSequence) query.set("before_sequence", beforeSequence);
  if (options.promptId) query.set("prompt_id", options.promptId);
  if (options.limit) query.set("limit", options.limit);

  const payload = await apiFetch<{
    events: Array<RawSessionEvent & { sequence?: number }>;
    [key: string]: unknown;
  }>(config, `/api/sessions/${sessionId}/events/history${query.size ? `?${query.toString()}` : ""}`);
  if (isJson(command, options)) {
    writeJson(payload);
    return;
  }
  const promptLabels = await fetchPromptLabels(config, sessionId).catch((err) => {
    console.error(`Warning: failed to fetch prompt labels for session ${sessionId}: ${stringifyError(err)}`);
    return new Map<string, string>();
  });
  const state: WatchRenderState = { promptLabels, toolCalls: new Map() };
  let textOpen = false;
  for (const event of payload.events) {
    const rendered = renderWatchEvent(
      {
        type: getRawSessionEventKind(event),
        data: getRawSessionEventData(event) ?? {},
      },
      state,
    );
    if (rendered?.kind === "line") {
      if (textOpen) {
        process.stdout.write("\n");
        textOpen = false;
      }
      console.log(rendered.line);
    }
    if (rendered?.kind === "text" && rendered.text) {
      process.stdout.write(rendered.text);
      textOpen = true;
    }
  }
  if (textOpen) process.stdout.write("\n");
}

function resolveSequenceOption(
  canonicalValue: string | undefined,
  aliasValue: string | undefined,
  canonicalFlag: string,
  aliasFlag: string,
): string | undefined {
  if (canonicalValue !== undefined && aliasValue !== undefined) {
    throw new CliError("user", `${aliasFlag} cannot be combined with ${canonicalFlag}.`);
  }
  return canonicalValue ?? aliasValue;
}

export async function usageCommand(
  sessionId: string,
  options: { json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  const payload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}/usage`);
  if (isJson(command, options)) {
    writeJson(payload);
    return;
  }
  const usage = (payload.usage && typeof payload.usage === "object" ? payload.usage : payload) as Record<
    string,
    unknown
  >;
  console.log(`Input tokens: ${String(usage.inputTokens ?? 0)}`);
  console.log(`Output tokens: ${String(usage.outputTokens ?? 0)}`);
  console.log(`Total tokens: ${String(usage.totalTokens ?? 0)}`);
  if (usage.totalCostUsd !== undefined) console.log(`Cost: ${String(usage.totalCostUsd)}`);
}
