import * as Sentry from "@sentry/cloudflare";

type LlmProviderFailureFields = {
  operation: string;
  provider: string;
  model?: string;
  callType?: string;
  phase?: string;
  toolName?: string;
  failureCategory?: string;
  failureKind?: string;
  status?: number | string | null;
  sessionId?: string;
  promptId?: string;
  sandboxId?: string;
};

function toSentryTags(fields: LlmProviderFailureFields): Record<string, string> {
  const tags: Record<string, string> = {
    component: "llm_provider",
    operation: fields.operation,
    provider: fields.provider,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (key === "operation" || key === "provider") continue;
    if (value === undefined || value === null) continue;
    tags[key] = String(value);
  }

  return tags;
}

export function captureLlmProviderFailure(error: unknown, fields: LlmProviderFailureFields): void {
  const capturedError = error instanceof Error ? error : new Error(String(error));
  Sentry.captureException(capturedError, { tags: toSentryTags(fields) });
}
