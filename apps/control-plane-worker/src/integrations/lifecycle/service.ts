import {
  BUSINESS_ONLY_SET,
  INTEGRATION_DISPLAY_NAMES,
  type IntegrationId,
} from "../../../../../shared/constants/integration-helpers.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STATUS,
  type IntegrationLifecycleReasonCode,
  type IntegrationLifecycleStage,
} from "../../../../../shared/enums/integration-lifecycle.js";
import { createLogger } from "../../logger";
import { runWithSentryTag } from "../../observability/run-with-sentry-tag";
import {
  getLatestIntegrationLifecycleEvent,
  type IntegrationLifecycleCursor,
  type IntegrationLifecycleEventRow,
  type IntegrationLifecycleScope,
  listIntegrationLifecycleEvents,
  listLatestIntegrationLifecycleEvents,
  recordIntegrationLifecycleEvent,
  recordIntegrationLifecycleEvents,
} from "./db";

const log = createLogger({ bindings: { component: "integration-lifecycle" } });

const ALLOWED_DETAIL_KEYS = new Set([
  "httpStatus",
  "providerErrorCode",
  "providerErrorTag",
  "attemptCount",
  "nextStage",
  "requestId",
  "eventKind",
  "repoOwner",
  "repoName",
  "installationId",
  "workspaceId",
  "teamId",
  "actor",
  "provider",
  "credentialScope",
  "webhookDeliveryId",
  "oauthStateHash",
  "threadKeyHash",
  "clientEventId",
  "latencyMsObserved",
]);
const MAX_DETAILS_BYTES = 4 * 1024;
const MAX_TOP_LEVEL_KEYS = 16;
const MAX_ARRAY_ITEMS = 32;

type IntegrationLifecycleEventDetails = Record<string, unknown>;

interface RecordLifecycleEventInput {
  integrationId: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: "passed" | "failed" | "skipped";
  businessId?: string | null;
  userId?: number | null;
  sessionId?: string | null;
  reasonCode?: IntegrationLifecycleReasonCode | null;
  message?: string | null;
  details?: IntegrationLifecycleEventDetails | null;
  latencyMs?: number;
  createdAt?: number;
}

export type IntegrationLifecycleSummary = {
  integrationId: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: "passed" | "failed" | "skipped";
  reasonCode: IntegrationLifecycleReasonCode | null;
  message: string | null;
  createdAt: number;
};

export function sanitizeLifecycleDetails(details: IntegrationLifecycleEventDetails | null | undefined): string | null {
  if (!details) return null;
  const entries = Object.entries(details).slice(0, MAX_TOP_LEVEL_KEYS);
  if (entries.length === 0) return null;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) {
      log.warn({ event: "integration_lifecycle_detail_key_dropped", key }, "Dropped unsupported lifecycle detail key");
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[key] = value.slice(0, MAX_ARRAY_ITEMS);
      continue;
    }
    if (value && typeof value === "object") {
      continue;
    }
    sanitized[key] = value;
  }
  if (Object.keys(sanitized).length === 0) return null;
  const json = JSON.stringify(sanitized);
  if (json.length > MAX_DETAILS_BYTES) {
    return JSON.stringify({ truncated: true });
  }
  return json;
}

function logLifecycleEvent(input: RecordLifecycleEventInput): void {
  const bindings = {
    event:
      input.status === INTEGRATION_LIFECYCLE_STATUS.FAILED
        ? "integration_lifecycle_failure"
        : "integration_lifecycle_pass",
    integration_id: input.integrationId,
    stage: input.stage,
    status: input.status,
    reason_code: input.reasonCode ?? null,
    business_id: input.businessId ?? null,
    user_id: input.userId ?? null,
    session_id: input.sessionId ?? null,
    latency_ms: input.latencyMs ?? 0,
  };
  if (input.status === INTEGRATION_LIFECYCLE_STATUS.FAILED) {
    log.warn(bindings, input.message ?? "Integration lifecycle failure");
    return;
  }
  log.info(bindings, input.message ?? "Integration lifecycle event");
}

export async function writeIntegrationLifecycleEvent(
  db: D1Database,
  input: RecordLifecycleEventInput,
): Promise<string> {
  const detailsJson = sanitizeLifecycleDetails(input.details);
  try {
    const id = await recordIntegrationLifecycleEvent(db, {
      integrationId: input.integrationId,
      stage: input.stage,
      status: input.status,
      businessId: input.businessId ?? null,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      reasonCode: input.reasonCode ?? null,
      message: input.message ?? null,
      detailsJson,
      latencyMs: input.latencyMs ?? 0,
      createdAt: input.createdAt,
    });
    logLifecycleEvent(input);
    return id;
  } catch (error) {
    log.warn(
      {
        event: "integration_lifecycle_write_failed",
        integration_id: input.integrationId,
        stage: input.stage,
        status: input.status,
        error_class: error instanceof Error ? error.name : typeof error,
      },
      "Failed to persist integration lifecycle event",
    );
    await runWithSentryTag("integration_lifecycle_write_failed", () => Promise.reject(error), log);
    throw error;
  }
}

export async function writeIntegrationLifecycleEvents(
  db: D1Database,
  inputs: RecordLifecycleEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const events = inputs.map((input) => ({
    input,
    detailsJson: sanitizeLifecycleDetails(input.details),
  }));
  try {
    await recordIntegrationLifecycleEvents(
      db,
      events.map(({ input, detailsJson }) => ({
        integrationId: input.integrationId,
        stage: input.stage,
        status: input.status,
        businessId: input.businessId ?? null,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        reasonCode: input.reasonCode ?? null,
        message: input.message ?? null,
        detailsJson,
        latencyMs: input.latencyMs ?? 0,
        createdAt: input.createdAt,
      })),
    );
    for (const { input } of events) {
      logLifecycleEvent(input);
    }
  } catch (error) {
    log.warn(
      {
        event: "integration_lifecycle_batch_write_failed",
        event_count: inputs.length,
        error_class: error instanceof Error ? error.name : typeof error,
      },
      "Failed to persist integration lifecycle events",
    );
    await runWithSentryTag("integration_lifecycle_batch_write_failed", () => Promise.reject(error), log);
    throw error;
  }
}

function encodeIntegrationLifecycleCursor(cursor: IntegrationLifecycleCursor): string {
  return `${cursor.createdAt}:${cursor.id}`;
}

function decodeIntegrationLifecycleCursor(cursor: string | null | undefined): IntegrationLifecycleCursor | null {
  const normalized = cursor?.trim();
  if (!normalized) return null;
  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex <= 0) return null;
  const createdAt = Number(normalized.slice(0, separatorIndex));
  const id = normalized.slice(separatorIndex + 1).trim();
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

export async function getIntegrationLifecycleSummary(
  db: D1Database,
  params: IntegrationLifecycleScope,
): Promise<IntegrationLifecycleSummary | null> {
  const latest = await getLatestIntegrationLifecycleEvent(db, params);
  if (!latest) return null;
  return rowToSummary(latest);
}

export async function getIntegrationLifecycleSummaries(
  db: D1Database,
  scopes: IntegrationLifecycleScope[],
): Promise<Map<IntegrationId, IntegrationLifecycleSummary>> {
  const rows = await listLatestIntegrationLifecycleEvents(db, scopes);
  return new Map(rows.map((row) => [row.integration_id, rowToSummary(row)]));
}

export async function getIntegrationLifecycleEventsPage(
  db: D1Database,
  params: {
    integrationId?: IntegrationId;
    businessId?: string;
    userId?: number;
    sessionId?: string;
    limit: number;
    cursor?: string | null;
  },
): Promise<{ events: IntegrationLifecycleEventRow[]; nextCursor: string | null }> {
  const events = await listIntegrationLifecycleEvents(db, {
    ...params,
    cursor: decodeIntegrationLifecycleCursor(params.cursor),
  });
  return {
    events,
    nextCursor:
      events.length === params.limit && events.at(-1)
        ? encodeIntegrationLifecycleCursor({
            createdAt: events.at(-1)!.created_at,
            id: events.at(-1)!.id,
          })
        : null,
  };
}

function providerDisplayName(integrationId: IntegrationId): string {
  return INTEGRATION_DISPLAY_NAMES[integrationId];
}

function providerReconnectMessage(integrationId: IntegrationId): string {
  return BUSINESS_ONLY_SET.has(integrationId)
    ? `Connect ${providerDisplayName(integrationId)} in business settings and try again.`
    : `Reconnect ${providerDisplayName(integrationId)} and try again.`;
}

type ReasonCodeMessageAudience = "user" | "business";

/**
 * Single source of truth for reason-code -> human message. Only the credential
 * reason codes (token missing/refresh/revoked) and the authn-probe wording
 * diverge between the user-facing and business-facing audiences; every other
 * case is identical.
 */
export function mapReasonCodeToMessage(
  integrationId: IntegrationId,
  reasonCode: IntegrationLifecycleReasonCode | null | undefined,
  audience: ReasonCodeMessageAudience,
  repo?: { owner: string; name: string },
): string {
  const provider = providerDisplayName(integrationId);
  switch (reasonCode) {
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING:
      if (audience === "business") {
        return BUSINESS_ONLY_SET.has(integrationId)
          ? `${provider} is not connected for this business. Connect ${provider} in business settings before starting a session.`
          : `A member needs to reconnect ${provider} before starting a session.`;
      }
      return BUSINESS_ONLY_SET.has(integrationId)
        ? `${provider} is not connected for this business. ${providerReconnectMessage(integrationId)}`
        : `${provider} is not connected for this user. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED:
      if (audience === "business") {
        return BUSINESS_ONLY_SET.has(integrationId)
          ? `${provider} credentials could not be refreshed. Connect ${provider} in business settings and try again.`
          : `A member's ${provider} credentials could not be refreshed. Reconnect ${provider} and try again.`;
      }
      return `${provider} credentials could not be refreshed. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED:
      if (audience === "business") {
        return BUSINESS_ONLY_SET.has(integrationId)
          ? `${provider} credentials were revoked. Connect ${provider} in business settings and try again.`
          : `A member's ${provider} credentials were revoked. Reconnect ${provider} and try again.`;
      }
      return `${provider} credentials were revoked. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED:
      return repo
        ? `${provider} couldn't confirm access to ${repo.owner}/${repo.name}. ${providerReconnectMessage(integrationId)}`
        : `${provider} couldn't confirm repository access. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.ORG_MISMATCH:
      return `${provider} organization access does not match the expected installation. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_MISMATCH:
      return `${provider} workspace access does not match the expected workspace. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_NOT_INSTALLED:
      return integrationId === "slack"
        ? "Cycloid is not installed in this Slack workspace."
        : `${provider} is not installed in the expected workspace.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED:
      return audience === "business"
        ? `${provider} rejected the verification probe. ${providerReconnectMessage(integrationId)}`
        : `${provider} rejected the authentication probe. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING:
      return integrationId === "github"
        ? "Cycloid is not installed on this GitHub organization."
        : `Cycloid is not installed for this ${provider} integration.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.SANDBOX_TOKEN_UNPREPARED:
      return `${provider} credentials could not be prepared for session startup. Try again.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.RUNTIME_ATTACH_FAILED:
      return `${provider} could not be attached to the sandbox runtime. Try again.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOOL_EXECUTION_FAILED:
      return `${provider} failed during the first tool call. Try again.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOOL_UNAVAILABLE:
      return `${provider} tools are unavailable right now. Try again.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_API_UNAVAILABLE:
      return `${provider} is temporarily unavailable. Try again.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_RATE_LIMITED:
      return `${provider} rate limited the request. Try again.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_SIGNATURE_INVALID:
      return `${provider} webhook signature validation failed. Reinstall ${provider} if this keeps happening.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_TIMESTAMP_REJECTED:
      return `${provider} webhook request was rejected because it arrived outside the allowed time window.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_PAYLOAD_MALFORMED:
      return `${provider} webhook payload was malformed.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_DUPLICATE_DELIVERY:
      return `${provider} sent a duplicate webhook delivery, so Cycloid skipped it.`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.OAUTH_STATE_MISMATCH:
      return `${provider} OAuth state verification failed. ${providerReconnectMessage(integrationId)}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.OAUTH_CALLBACK_USER_MISMATCH:
      return `${provider} OAuth callback did not match the expected Cycloid user. ${providerReconnectMessage(
        integrationId,
      )}`;
    case INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED:
      return `${provider} could not map the incoming event to a Cycloid user or workspace.`;
    default:
      return `${provider} verification failed. Try again.`;
  }
}

export function mapReasonCodeToUserMessage(
  integrationId: IntegrationId,
  reasonCode: IntegrationLifecycleReasonCode | null | undefined,
  repo?: { owner: string; name: string },
): string {
  return mapReasonCodeToMessage(integrationId, reasonCode, "user", repo);
}

export function mapReasonCodeToBusinessMessage(
  integrationId: IntegrationId,
  reasonCode: IntegrationLifecycleReasonCode | null | undefined,
  repo?: { owner: string; name: string },
): string {
  return mapReasonCodeToMessage(integrationId, reasonCode, "business", repo);
}

function rowToSummary(row: IntegrationLifecycleEventRow): IntegrationLifecycleSummary {
  return {
    integrationId: row.integration_id,
    stage: row.stage,
    status: row.status,
    reasonCode: row.reason_code,
    message: row.message,
    createdAt: row.created_at,
  };
}
