import {
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../../../shared/enums/integration-lifecycle.js";
import { InitiationMode } from "../enums/initiation-mode.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createLogger } from "../logger";
import { gateGithubSessionStart } from "../services/integration-gating";
import { persistInitialSessionProjection } from "../services/session-create";
import { resolveBaseModelForAutomaticRouting } from "../services/session-model-routing";
import { closeSessionForWebhook, createSessionState, enqueueSessionPrompt } from "../session/state";
import { decrypt } from "../settings/encryption";
import type { Env, InternalAuthContext } from "../types";
import { computeSha256Hex, jsonErrorResponse, jsonResponse } from "../utils";
import { readCappedWebhookBody } from "./body-limit";
import {
  buildPagerDutyIncidentWebhookRef,
  deleteSessionWebhookRef,
  getPagerDutyWebhookInstallationByToken,
  listSessionIdsByWebhookRef,
  releaseWebhookIdempotencyClaim,
  SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT,
} from "./db";
import { buildPagerDutyIncidentPrompt } from "./prompts";
import { claimOrSkip, resolveUserSettings } from "./shared";
import { verifyPagerDutyWebhookSignature } from "./verify";

const log = createLogger({ bindings: { component: "pagerduty-webhook" } });

export const WEBHOOK_SOURCE_PAGERDUTY = "pagerduty";
const PAGERDUTY_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const DURABLE_GATE_REASON_CODES = new Set<string>([
  INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING,
  INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED,
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED,
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
  INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
  INTEGRATION_LIFECYCLE_REASON_CODE.ORG_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_NOT_INSTALLED,
  INTEGRATION_LIFECYCLE_REASON_CODE.OAUTH_CALLBACK_USER_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
]);

type PagerDutyIncidentTrigger = {
  deliveryId: string | null;
  eventType: string;
  occurredAt: string | null;
  incidentId: string;
  incidentNumber: string | null;
  incidentUrl: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  urgency: string | null;
  priority: string | null;
  serviceName: string | null;
  serviceId: string | null;
  escalationPolicy: string | null;
  assignees: string[];
  additionalContext: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function summarizeResource(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return firstNonEmptyString(value);
  return firstNonEmptyString(record.summary, record.name, record.title, record.id);
}

function stringifyDetailValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const rendered = value.map((item) => stringifyDetailValue(item)).filter((item): item is string => Boolean(item));
    return rendered.length > 0 ? rendered.join(", ") : null;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function formatAdditionalContext(record: Record<string, unknown>, excludedKeys: string[] = []): string | null {
  const excluded = new Set(excludedKeys);
  const lines = Object.entries(record)
    .filter(([key]) => !excluded.has(key))
    .map(([key, value]) => {
      const rendered = stringifyDetailValue(value);
      return rendered ? `${key}: ${rendered}` : null;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

function extractAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const assignees: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const assignee = summarizeResource(record?.assignee ?? record);
    if (!assignee || seen.has(assignee)) continue;
    seen.add(assignee);
    assignees.push(assignee);
  }
  return assignees;
}

function isIncidentOpenEvent(eventTypeRaw: string | null): eventTypeRaw is string {
  const eventType = eventTypeRaw?.toLowerCase();
  return eventType === "incident.trigger" || eventType === "incident.triggered" || eventType === "triggered";
}

function parseV3PagerDutyTrigger(payload: Record<string, unknown>): PagerDutyIncidentTrigger | null {
  const event = asRecord(payload.event);
  if (!event) return null;

  const eventType = firstNonEmptyString(event.event_type);
  const resourceType = firstNonEmptyString(event.resource_type)?.toLowerCase() ?? null;
  if (!isIncidentOpenEvent(eventType) || (resourceType !== null && resourceType !== "incident")) return null;

  const data = asRecord(event.data);
  const incident = asRecord(data?.incident) ?? data;
  if (!incident) return null;

  const incidentId = firstNonEmptyString(incident.id);
  if (!incidentId) return null;

  const body = asRecord(incident.body);
  return {
    deliveryId: firstNonEmptyString(event.id),
    eventType,
    occurredAt: firstNonEmptyString(event.occurred_at, incident.created_at, incident.last_status_change_at),
    incidentId,
    incidentNumber: firstNonEmptyString(incident.incident_number, incident.incident_number_html),
    incidentUrl: firstNonEmptyString(incident.html_url, incident.self, incident.url),
    title: firstNonEmptyString(incident.title, incident.summary),
    description: firstNonEmptyString(body?.details, incident.description),
    status: firstNonEmptyString(incident.status),
    urgency: firstNonEmptyString(incident.urgency),
    priority: summarizeResource(incident.priority),
    serviceName: summarizeResource(incident.service),
    serviceId: firstNonEmptyString(asRecord(incident.service)?.id),
    escalationPolicy: summarizeResource(incident.escalation_policy),
    assignees: extractAssignees(incident.assignments),
    additionalContext:
      formatAdditionalContext(incident, [
        "id",
        "incident_number",
        "incident_number_html",
        "html_url",
        "self",
        "url",
        "title",
        "summary",
        "description",
        "status",
        "urgency",
        "priority",
        "service",
        "escalation_policy",
        "assignments",
        "body",
        "created_at",
        "last_status_change_at",
      ]) ?? formatAdditionalContext(body ?? {}, ["type", "details"]),
  };
}

function parseLegacyPagerDutyTrigger(payload: Record<string, unknown>): PagerDutyIncidentTrigger | null {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const message = messages.map(asRecord).find((candidate): candidate is Record<string, unknown> => candidate !== null);
  if (!message) return null;

  const eventType = firstNonEmptyString(message.event);
  if (!isIncidentOpenEvent(eventType)) return null;

  const incident = asRecord(message.incident);
  if (!incident) return null;

  const incidentId = firstNonEmptyString(incident.id);
  if (!incidentId) return null;

  const triggerSummaryData = asRecord(incident.trigger_summary_data);
  const body = asRecord(incident.body);
  return {
    deliveryId: firstNonEmptyString(message.id),
    eventType,
    occurredAt: firstNonEmptyString(message.created_on, message.createdAt, incident.created_on),
    incidentId,
    incidentNumber: firstNonEmptyString(incident.incident_number),
    incidentUrl: firstNonEmptyString(incident.html_url, incident.self, incident.url),
    title: firstNonEmptyString(triggerSummaryData?.subject, incident.title, incident.summary),
    description: firstNonEmptyString(body?.details, triggerSummaryData?.description, incident.description),
    status: firstNonEmptyString(incident.status),
    urgency: firstNonEmptyString(incident.urgency),
    priority: summarizeResource(incident.priority),
    serviceName: summarizeResource(incident.service),
    serviceId: firstNonEmptyString(asRecord(incident.service)?.id),
    escalationPolicy: summarizeResource(incident.escalation_policy),
    assignees: extractAssignees(incident.assignments),
    additionalContext:
      formatAdditionalContext(incident, [
        "id",
        "incident_number",
        "html_url",
        "self",
        "url",
        "title",
        "summary",
        "description",
        "status",
        "urgency",
        "priority",
        "service",
        "escalation_policy",
        "assignments",
        "body",
        "trigger_summary_data",
        "created_on",
      ]) ?? formatAdditionalContext(triggerSummaryData ?? {}, ["subject", "description"]),
  };
}

function parsePagerDutyIncidentTrigger(payload: Record<string, unknown>): PagerDutyIncidentTrigger | null {
  return parseV3PagerDutyTrigger(payload) ?? parseLegacyPagerDutyTrigger(payload);
}

function buildPagerDutyStableDeliveryId(trigger: PagerDutyIncidentTrigger): string | null {
  if (trigger.deliveryId) return trigger.deliveryId;
  if (trigger.occurredAt) return `${trigger.incidentId}:${trigger.eventType}:${trigger.occurredAt}`;
  return `${trigger.incidentId}:${trigger.eventType}`;
}

function isDurableGateFailure(reasonCode: string): boolean {
  return DURABLE_GATE_REASON_CODES.has(reasonCode);
}

async function releasePagerDutyClaim(db: D1Database, idempotencyKey: string, context: string): Promise<void> {
  try {
    await releaseWebhookIdempotencyClaim(db, WEBHOOK_SOURCE_PAGERDUTY, idempotencyKey);
  } catch (releaseErr) {
    log.error(
      { idempotencyKey, context, error: String(releaseErr) },
      "Failed to release PagerDuty webhook idempotency claim; redelivery will dedupe until the TTL expires",
    );
  }
}

async function resolvePagerDutyWebhookSigningSecret(
  installation: { webhookSigningSecretEncrypted: string | null },
  encryptionKey: string | undefined,
): Promise<string | null> {
  if (!installation.webhookSigningSecretEncrypted) return null;
  try {
    return await decrypt(installation.webhookSigningSecretEncrypted, encryptionKey);
  } catch (err) {
    log.error({ error: String(err) }, "Failed to decrypt PagerDuty webhook signing secret");
    return null;
  }
}

async function cleanupFailedPagerDutySession(params: {
  env: Env;
  db: D1Database;
  businessId: string;
  incidentId: string;
  sessionId: string;
  cause: unknown;
}): Promise<void> {
  const { env, db, businessId, incidentId, sessionId, cause } = params;
  const incidentRef = buildPagerDutyIncidentWebhookRef(businessId, incidentId);
  try {
    await deleteSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT, incidentRef, sessionId);
  } catch (deleteErr) {
    log.warn(
      { incidentId, incidentRef, sessionId, error: String(deleteErr), cause: String(cause) },
      "Failed to delete PagerDuty webhook ref during bootstrap cleanup",
    );
  }

  try {
    await closeSessionForWebhook(env, db, sessionId, { reason: "pagerduty_bootstrap_failed" });
  } catch (closeErr) {
    log.warn(
      { incidentId, sessionId, error: String(closeErr), cause: String(cause) },
      "Failed to close PagerDuty session during bootstrap cleanup",
    );
  }
}

export async function handlePagerDutyWebhook(
  request: Request,
  env: Env,
  installationToken: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const db = env.DB;
  const bodyResult = await readCappedWebhookBody(request, PAGERDUTY_WEBHOOK_MAX_BODY_BYTES);
  if (bodyResult instanceof Response) {
    return jsonResponse({ ok: true, skipped: true, reason: "payload_too_large" });
  }
  const rawBody = bodyResult;

  const installation = await getPagerDutyWebhookInstallationByToken(db, installationToken);
  if (!installation) {
    return jsonResponse({ ok: true, skipped: true, reason: "unknown_installation_token" });
  }

  const signingSecret = await resolvePagerDutyWebhookSigningSecret(installation, env.TOKEN_ENCRYPTION_KEY);
  if (!signingSecret) {
    return jsonErrorResponse("PagerDuty webhook signing secret is not configured", 401);
  }

  const signatureHeader = request.headers.get("X-PagerDuty-Signature") ?? request.headers.get("x-pagerduty-signature");
  if (!signatureHeader) {
    return jsonErrorResponse("Missing PagerDuty webhook signature", 401);
  }
  const signatureValid = await verifyPagerDutyWebhookSignature(rawBody, signatureHeader, signingSecret);
  if (!signatureValid) {
    return jsonErrorResponse("Invalid PagerDuty webhook signature", 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonErrorResponse("Invalid JSON", 400);
  }

  const trigger = parsePagerDutyIncidentTrigger(payload);
  if (!trigger) {
    return jsonResponse({ ok: true, skipped: true, reason: "unexpected_event_type" });
  }

  const payloadHash = await computeSha256Hex(rawBody);
  const stableDeliveryId = buildPagerDutyStableDeliveryId(trigger);
  const { duplicate, idempotencyKey } = await claimOrSkip(db, WEBHOOK_SOURCE_PAGERDUTY, stableDeliveryId, payloadHash);
  if (duplicate) return duplicate;

  try {
    const incidentRef = buildPagerDutyIncidentWebhookRef(installation.businessId, trigger.incidentId);
    const existingSessionIds = await listSessionIdsByWebhookRef(
      db,
      SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT,
      incidentRef,
    );
    if (existingSessionIds.length > 0) {
      await releasePagerDutyClaim(db, idempotencyKey, "session_already_exists");
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "session_already_exists",
        sessionId: existingSessionIds[0],
      });
    }

    const actorUserId = String(installation.connectedByUserId);
    const sessionId = crypto.randomUUID();
    const gate = await gateGithubSessionStart(env, {
      userId: actorUserId,
      businessId: installation.businessId,
      sessionId,
      repoOwner: installation.repoOwner,
      repoName: installation.repoName,
    });
    if (!gate.ok) {
      if (isDurableGateFailure(gate.body.reasonCode)) {
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: "repo_not_available",
          stage: gate.body.stage,
          reasonCode: gate.body.reasonCode,
        });
      }
      await releasePagerDutyClaim(db, idempotencyKey, "repo_gate_transient_failure");
      return jsonErrorResponse("PagerDuty repo gate unavailable", 503, {
        reasonCode: gate.body.reasonCode,
        stage: gate.body.stage,
      });
    }

    const auth: InternalAuthContext = {
      userId: actorUserId,
      canAccessAllSessions: false,
      businessId: installation.businessId,
    };
    const settings = await resolveUserSettings(db, actorUserId);
    const defaultModel =
      extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(settings?.default_model)) ?? null;
    const baseModel = resolveBaseModelForAutomaticRouting(installation.modelId ?? defaultModel);
    const waitUntil = ctx ? ctx.waitUntil.bind(ctx) : undefined;

    let sessionInitialized = false;
    try {
      const { session, replay } = await createSessionState(env, sessionId, actorUserId, {
        sessionKind: "repo",
        repoContext: { repoOwner: installation.repoOwner, repoName: installation.repoName },
        auth,
        businessId: installation.businessId,
        installationId: gate.installationId,
        model: baseModel.currentModel,
        agentRuntimeBackend: baseModel.agentRuntimeBackend,
        initiationMode: InitiationMode.AUTOMATION,
        entrypoint: SessionEntrypoint.PAGERDUTY,
        waitUntil,
      });
      sessionInitialized = true;

      await persistInitialSessionProjection(env, {
        session,
        replay,
        sessionKind: "repo",
        projectionSource: "webhooks.pagerduty.create",
        projectionUserId: actorUserId,
        webhookRef: {
          source: SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT,
          externalRef: incidentRef,
        },
      });

      const prompt = buildPagerDutyIncidentPrompt({
        repoUrl: `https://github.com/${installation.repoOwner}/${installation.repoName}`,
        incidentId: trigger.incidentId,
        incidentNumber: trigger.incidentNumber,
        incidentUrl: trigger.incidentUrl,
        eventType: trigger.eventType,
        occurredAt: trigger.occurredAt,
        title: trigger.title,
        description: trigger.description,
        status: trigger.status,
        urgency: trigger.urgency,
        priority: trigger.priority,
        serviceName: trigger.serviceName,
        serviceId: trigger.serviceId,
        escalationPolicy: trigger.escalationPolicy,
        assignees: trigger.assignees,
        additionalContext: trigger.additionalContext,
      });
      const enqueueResult = await enqueueSessionPrompt(env, session.sessionId, prompt, actorUserId, { auth });
      if (!enqueueResult.ok) {
        throw new Error(`PagerDuty webhook bootstrap enqueue failed: ${enqueueResult.error}`);
      }

      return jsonResponse({
        ok: true,
        created: true,
        sessionId: session.sessionId,
        incidentId: trigger.incidentId,
        enqueued: true,
      });
    } catch (err) {
      if (sessionInitialized) {
        await cleanupFailedPagerDutySession({
          env,
          db,
          businessId: installation.businessId,
          incidentId: trigger.incidentId,
          sessionId,
          cause: err,
        });
      }
      throw err;
    }
  } catch (err) {
    await releasePagerDutyClaim(db, idempotencyKey, "handler_error");
    throw err;
  }
}
