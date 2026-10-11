/** Observability constants for the sandbox bridge. */

import { ENVIRONMENT, type Environment } from "../../../../shared/constants/environment.js";
export {
  COMPANY_MEMORY_CONTEXT_FOOTER,
  COMPANY_MEMORY_CONTEXT_HEADER,
  SIMILAR_SESSION_TASK_SEPARATOR,
} from "../../../../shared/constants/prompt-context.js";

export const OTEL_SERVICE_NAME = "cycloid-sandbox-bridge";
export const BRAINTRUST_PROJECT = "cycloid";

export const DD_DEFAULT_SITE = "us5.datadoghq.com";
export const SHUTDOWN_TIMEOUT_MS = 5000;
export const POST_EXECUTION_SHUTDOWN_WAIT_MS = 30_000;

/**
 * Per-turn Braintrust flush timeout. Bounds the end-of-turn flush so a slow or
 * unreachable broker cannot stall the bridge between turns. Deliberately much
 * shorter than POST_EXECUTION_SHUTDOWN_WAIT_MS because it runs on the hot
 * per-turn path, not only at shutdown.
 */
export const BRAINTRUST_TURN_FLUSH_TIMEOUT_MS = 3000;
export const BT_DEFAULT_ENV: Environment = ENVIRONMENT.Production;

/** Max length of text/output fields sent to Braintrust to avoid payload bloat. */
export const BT_MAX_TEXT_LENGTH = 4000;

/** Max tool input/output length for Braintrust logging. */
export const BT_MAX_TOOL_IO_LENGTH = 2000;

/**
 * Stable structured-log event marker for configured pre-publish test failures.
 * Operators query `@event:configured_pre_publish_test_failed` in Datadog us5 to find the
 * redacted failing-output tail that is deliberately kept out of the customer PR.
 */
export const CONFIGURED_TEST_FAILURE_EVENT = "configured_pre_publish_test_failed";

/** Datadog Logs HTTP intake constants. */
export const DD_LOGS_SOURCE = "cycloid-bridge";
export const DD_LOGS_HOSTNAME = "e2b-sandbox";
export const DD_LOGS_FLUSH_INTERVAL_MS = 5000;
export const DD_LOGS_MAX_BATCH_SIZE = 200;
export const DD_LOGS_MAX_BUFFER_SIZE = 2000;
export const DD_LOGS_MAX_BUFFER_BYTES = 10_000_000; // 10MB memory cap for DD buffer
export const DD_LOGS_MAX_PAYLOAD_BYTES = 4_000_000;
export const DD_LOGS_MAX_ENTRY_BYTES = 900_000;
export const DD_LOGS_FETCH_TIMEOUT_MS = 5000;
