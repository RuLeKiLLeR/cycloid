import type { IntegrationLifecycleReasonCode } from "../../../../shared/enums/integration-lifecycle.js";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { Env } from "../types";
import { markJiraWebhookInstallationDegraded } from "../webhooks/db";

const log = createLogger({ bindings: { component: "reactive-health" } });

/**
 * Stable event name for the reactive-degrade Datadog metric. A log-derived
 * metric (`infra/datadog-log-metrics.tf`) counts rows with this `@event`, so we
 * can confirm reactive detection actually fires before widening the poll
 * interval. Keep in sync with the Terraform filter query.
 */
export const REACTIVE_DEGRADE_EVENT = "integration.reactive_degrade";

interface ReactiveDegradeMetricFields {
  integration: "jira";
  operation: string;
  reasonCode: IntegrationLifecycleReasonCode;
  businessId: string;
  httpStatus?: number;
}

/**
 * Emit the reactive-degrade observability event. Fire-and-forget: a metrics
 * failure must never break the webhook/registration path that observed the
 * provider failure. Carries only stable IDs and a status code — never tokens or
 * provider response bodies (docs/security.md).
 */
async function emitReactiveDegradeMetric(env: Env, fields: ReactiveDegradeMetricFields): Promise<void> {
  try {
    await postStructuredEventToDd(env, {
      event: REACTIVE_DEGRADE_EVENT,
      integration: fields.integration,
      operation: fields.operation,
      reason_code: fields.reasonCode,
      business_id: fields.businessId,
      http_status: fields.httpStatus ?? null,
    });
  } catch (error) {
    log.warn(
      { event: "reactive_degrade_metric_failed", integration: fields.integration, operation: fields.operation },
      error instanceof Error ? error.message : "reactive degrade metric emission failed",
    );
  }
}

/**
 * Reactively degrade a Jira installation after a control-plane call observed a
 * durable installer-auth failure. The sticky signal is the installation `status`
 * column (`active` -> `degraded`), which `deriveCurrentIntegrationHealth` cannot
 * mask and inbound webhooks never reset; it clears on the next successful
 * registration/refresh/reconnect.
 *
 * Caller decides this is durable (via `classifyProviderHttpFailure`); this
 * function performs the degrade and emits the metric only on the
 * `active -> degraded` transition. Coalescing is inherent: the underlying UPDATE
 * matches `status = 'active'`, so repeat calls while already degraded change zero
 * rows and emit nothing — no extra read, no metric spam under a revoked-token
 * traffic storm.
 */
export async function degradeJiraInstallationReactively(
  db: D1Database,
  env: Env,
  params: {
    businessId: string;
    jiraCloudId: string;
    operation: string;
    reasonCode: IntegrationLifecycleReasonCode;
    httpStatus?: number;
  },
): Promise<void> {
  const transitioned = await markJiraWebhookInstallationDegraded(db, params.businessId, params.jiraCloudId);
  if (!transitioned) return;
  log.warn(
    {
      event: "integration_reactive_degrade",
      integration: "jira",
      operation: params.operation,
      reason_code: params.reasonCode,
      business_id: params.businessId,
      http_status: params.httpStatus ?? null,
    },
    "Reactively degraded Jira installation after durable provider auth failure",
  );
  await emitReactiveDegradeMetric(env, {
    integration: "jira",
    operation: params.operation,
    reasonCode: params.reasonCode,
    businessId: params.businessId,
    httpStatus: params.httpStatus,
  });
}
