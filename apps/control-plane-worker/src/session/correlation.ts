import { parseCorrelation, serializeCorrelation, type SerializedCorrelation } from "../../../../shared/correlation.js";
import { injectTraceparent } from "../observability/context";

type BuildSerializedCorrelationOptions = {
  sessionId: string;
  promptId: string;
  sandboxId?: string;
};

export function buildSerializedCorrelation(
  options: BuildSerializedCorrelationOptions,
): SerializedCorrelation | undefined {
  const traceparent = injectTraceparent();
  if (!traceparent) return undefined;

  const correlation = parseCorrelation({
    traceparent,
    sessionId: options.sessionId,
    promptId: options.promptId,
    ...(options.sandboxId ? { sandboxId: options.sandboxId } : {}),
  });

  return correlation ? serializeCorrelation(correlation) : undefined;
}

export function addSandboxIdToCorrelation(
  correlation: SerializedCorrelation | undefined,
  sandboxId: string | null | undefined,
): SerializedCorrelation | undefined {
  if (!correlation || !sandboxId) return correlation;
  const parsed = parseCorrelation(correlation);
  if (!parsed) return correlation;
  if (parsed.sandboxId === sandboxId) return correlation;
  return serializeCorrelation({ ...parsed, sandboxId });
}
