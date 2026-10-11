/**
 * Shared structured logger wiring for the sandbox bridge.
 * The core implementation lives in `shared/observability/logger.ts`;
 * this file binds bridge-specific sinks and correlation sources.
 */

import {
  createLogger as createSharedLogger,
  LOG_LEVEL_ORDINALS,
  type Logger,
  type LogLevel,
  phaseLogFields,
  type TraceProvider,
} from "../../../shared/observability/logger.js";
import { redactObject } from "../../../shared/observability/redact.js";
import { currentCorrelation } from "./services/correlation.js";
import { ddLog } from "./services/dd-logs.js";
import { captureBridgeException } from "./services/sentry.js";

export type BridgeLogger = Logger;
export const LOG_ORDINALS = LOG_LEVEL_ORDINALS;
export type { LogLevel };
export { phaseLogFields };

export function createBridgeLogger(
  minLevel: number,
  bindings: Record<string, unknown>,
  traceProvider?: TraceProvider,
): BridgeLogger {
  return createSharedLogger({
    minLevel,
    bindings,
    traceProvider,
    correlationProvider: currentCorrelation,
    entrySink: ddLog,
    entryRedactor: redactObject,
    errorHandler: captureBridgeException,
  });
}
