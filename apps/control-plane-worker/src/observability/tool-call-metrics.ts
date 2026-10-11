import { isToolFailureTimeout, type ToolFailureReport } from "../../../../shared/tool-failure.js";
import { classifyMcpServer, normalizeToolName, parseMcpServerName } from "../../../../shared/tools/names.js";
import type { Logger } from "../logger";
import type { PromptToolRollupRow } from "../session/tool-rollup-db";
import type { Env } from "../types";
import { baseControlPlaneMetricTags } from "./metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "./pr-metrics";

const TOOL_CALLS_METRIC = "arcanist.tool.calls";
export const TOOL_CALL_OBSERVED_EVENT = "tool_call.observed";

export interface ToolCallObservedEvent extends Record<string, unknown> {
  event: typeof TOOL_CALL_OBSERVED_EVENT;
  sessionId: string;
  promptId: string;
  businessId: string | null;
  ownerUserId: number | null;
  agent: string;
  callId: string;
  toolName: string;
  mcpServer: string | null;
  mcpClass: ReturnType<typeof classifyMcpServer>;
  outcome: "ok" | "error";
  timedOut: boolean;
  durationMs?: number;
}

interface ToolCallObservedEventArgs {
  sessionId: string;
  promptId: string;
  businessId: string | null;
  ownerUserId: number | null;
  agent: string | null;
  callId: string;
  toolName: string;
  status: string;
  durationMs?: number;
  failure?: ToolFailureReport;
}

function coerceDurationMs(durationMs: number | undefined): number | undefined {
  return typeof durationMs === "number" && Number.isFinite(durationMs)
    ? Math.max(0, Math.round(durationMs))
    : undefined;
}

export function buildToolCallObservedEvent(args: ToolCallObservedEventArgs): ToolCallObservedEvent | null {
  const toolName = normalizeToolName(args.toolName);
  const outcome = args.status === "completed" ? "ok" : args.status === "error" ? "error" : null;
  if (!toolName || !outcome) return null;

  const mcpServer = parseMcpServerName(toolName);
  const durationMs = coerceDurationMs(args.durationMs);
  return {
    event: TOOL_CALL_OBSERVED_EVENT,
    sessionId: args.sessionId,
    promptId: args.promptId,
    businessId: args.businessId,
    ownerUserId: typeof args.ownerUserId === "number" && Number.isFinite(args.ownerUserId) ? args.ownerUserId : null,
    agent: args.agent ? args.agent : "unknown",
    callId: args.callId,
    toolName,
    mcpServer,
    mcpClass: classifyMcpServer(mcpServer),
    outcome,
    timedOut: outcome === "error" && isToolFailureTimeout(args.failure),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function emitToolCallObservedEvent(log: Pick<Logger, "info">, args: ToolCallObservedEventArgs): void {
  const event = buildToolCallObservedEvent(args);
  if (!event) return;
  log.info(event, "Tool call observed");
}

export async function emitToolCallRollupMetrics(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  rows: PromptToolRollupRow[],
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey || rows.length === 0) return;

  const series: CountMetricSeries[] = [];
  for (const row of rows) {
    const baseTags = [
      ...baseControlPlaneMetricTags(env),
      `agent:${row.agent ?? "unknown"}`,
      `mcp_class:${classifyMcpServer(row.mcpServer)}`,
    ];
    if (row.okCount > 0) {
      series.push({ metric: TOOL_CALLS_METRIC, tags: [...baseTags, "outcome:ok"], value: row.okCount });
    }
    if (row.errorCount > 0) {
      series.push({ metric: TOOL_CALLS_METRIC, tags: [...baseTags, "outcome:error"], value: row.errorCount });
    }
  }

  await postCountMetricSeries(apiKey, series, "tool-calls");
}
