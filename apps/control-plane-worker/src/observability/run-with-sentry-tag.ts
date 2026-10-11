import * as Sentry from "@sentry/cloudflare";

import { createLogger, type Logger } from "../logger";

const defaultLogger = createLogger({ bindings: { component: "observability" } });

export async function runWithSentryTag(
  operation: string,
  fn: () => Promise<unknown>,
  logger: Logger = defaultLogger,
  context?: {
    message?: string;
    logFields?: Record<string, unknown>;
    tags?: Record<string, string>;
  },
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(
      { ...(context?.logFields ?? {}), error: String(err), operation },
      context?.message ?? "Operation failed",
    );
    Sentry.captureException(err, { tags: { operation, ...(context?.tags ?? {}) } });
  }
}
