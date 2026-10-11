import type { Env } from "../types";
import { postStructuredEventToDd } from "./events-exporter";

const ERROR_MESSAGE_TRUNCATE_CHARS = 500;

export type SwallowedFailureSurface = "slack" | "session_projection";

export interface ReportSwallowedFailureInput {
  surface: SwallowedFailureSurface;
  operation: string;
  sessionId?: string;
  error?: unknown;
  errorClass?: string;
  errorMessage?: string;
  slackErrorCode?: string;
  reason?: string;
  stage?: string;
}

function truncate(value: string): string {
  return value.length > ERROR_MESSAGE_TRUNCATE_CHARS ? value.slice(0, ERROR_MESSAGE_TRUNCATE_CHARS) : value;
}

function errorClass(error: unknown, fallback = "UnknownError"): string {
  if (error instanceof Error) return error.name || "Error";
  if (error !== undefined && error !== null) return typeof error;
  return fallback;
}

function errorMessage(error: unknown, fallback?: string): string {
  if (fallback) return truncate(fallback);
  if (error instanceof Error) return truncate(error.message);
  return truncate(String(error ?? "unknown"));
}

export function buildSwallowedFailureEvent(input: ReportSwallowedFailureInput): Record<string, unknown> {
  return {
    event: "integration.failure",
    surface: input.surface,
    operation: input.operation,
    error_class: errorClass(input.error, input.errorClass),
    error_message_truncated: errorMessage(input.error, input.errorMessage),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.slackErrorCode ? { slack_error_code: input.slackErrorCode } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
  };
}

export async function reportSwallowedFailure(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  input: ReportSwallowedFailureInput,
): Promise<boolean> {
  return postStructuredEventToDd(env, buildSwallowedFailureEvent(input));
}

export async function reportSlackPostFailure(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  input: Omit<ReportSwallowedFailureInput, "surface" | "slackErrorCode"> & {
    slackErrorCode?: string;
  },
): Promise<boolean> {
  return reportSwallowedFailure(env, {
    ...input,
    surface: "slack",
    slackErrorCode: input.slackErrorCode,
    errorClass: input.errorClass ?? (input.error === undefined || input.error === null ? "SlackApiError" : undefined),
    errorMessage:
      input.errorMessage ??
      (input.error === undefined || input.error === null ? (input.slackErrorCode ?? "unknown_slack_error") : undefined),
  });
}
