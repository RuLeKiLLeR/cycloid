import { PROMPT_RETRY_BASE_MS, PROMPT_RETRY_MAX_MS, TOOL_SUMMARY_MAX_LENGTH } from "../constants/bridge.js";
import { additiveJitterBackoffMs } from "./backoff.js";

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

export function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Aborted"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function promptRetryDelayMs(attempt: number): number {
  return additiveJitterBackoffMs({
    attempt,
    attemptOffset: 1,
    baseMs: PROMPT_RETRY_BASE_MS,
    maxBaseMs: PROMPT_RETRY_MAX_MS,
    jitterMs: 1000,
  });
}

export function canonicalPartId(part: { callID?: string; id?: string }): string {
  return (part.callID || part.id || "") as string;
}

export function toolSummary(tool: string, input?: Record<string, unknown>): string {
  if (!input) return tool;
  const filePath = input.file_path ?? input.filePath ?? input.path;
  switch (tool.toLowerCase()) {
    case "apply_patch":
      return filePath ? `${tool} ${filePath}` : tool;
    case "bash":
      if (typeof input.command === "string") {
        const cmd =
          input.command.length > TOOL_SUMMARY_MAX_LENGTH
            ? input.command.slice(0, TOOL_SUMMARY_MAX_LENGTH) + "…"
            : input.command;
        return `${tool} ${cmd}`;
      }
      return tool;
    default:
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0 && v.length < 100) {
          return `${tool} ${v}`;
        }
      }
      return tool;
  }
}
