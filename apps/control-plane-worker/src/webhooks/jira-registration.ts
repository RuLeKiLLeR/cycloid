import { DEFAULT_JIRA_TRIGGER_LABEL } from "../../../../shared/constants/sandbox-env.js";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../../../shared/enums/integration-lifecycle.js";
import { getValidJiraToken } from "../auth/db";
import { classifyProviderHttpFailure } from "../integrations/provider-failure";
import { degradeJiraInstallationReactively } from "../integrations/reactive-health";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { normalizeWebhookReference } from "../utils";
import {
  getJiraWebhookInstallationByBusiness,
  type JiraWebhookInstallation,
  listNonRevokedJiraWebhookInstallations,
  markJiraWebhookInstallationDegraded,
  recordJiraWebhookRegistration,
  updateJiraWebhookInstallationExpiry,
} from "./db";

const log = createLogger({ bindings: { component: "jira-registration" } });

const JIRA_WEBHOOK_EVENTS = ["jira:issue_created", "jira:issue_updated"] as const;
const JIRA_WEBHOOK_TIMEOUT_MS = 15_000;
// Atlassian dynamic webhooks expire 30 days after registration/refresh; the
// cron refreshes anything inside this window so a missed week never lapses.
const JIRA_WEBHOOK_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const JIRA_WEBHOOK_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface RegisteredJiraWebhook {
  webhookId: number;
  events: string[];
  expiresAt: number;
}

export function jiraTriggerLabel(env: Env): string {
  return (normalizeWebhookReference(env.JIRA_TRIGGER_LABEL) || DEFAULT_JIRA_TRIGGER_LABEL).toLowerCase();
}

export function jiraWebhookCallbackUrl(env: Env, installationToken: string): string {
  const base = (env.CONTROL_PLANE_URL || env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/webhooks/jira/${installationToken}`;
}

function jiraApiBase(cloudId: string): string {
  return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
}

/**
 * Classify an HTTP failure from a Jira webhook register/refresh call (both are
 * app/token-scoped endpoints, so a 403 is a durable auth failure, not a
 * resource-permission one) and degrade only when warranted:
 * - durable auth (401/403): degrade + emit the reactive metric (installer token dead).
 * - rate-limited (429) / transient (5xx): on the refresh sweep, do NOT degrade
 *   (the remote webhooks are still live and the cron retries; a 429 storm or a
 *   provider 5xx must not disconnect a healthy integration). On registration,
 *   `degradeOnTransient` is set because the delete-then-register flow has already
 *   removed the remote webhooks before the failed POST, so leaving the row active
 *   would silently stop events with stale `webhooks_json`; mark degraded so the
 *   admin sees a reconnect prompt. No metric for transient — it is not an auth signal.
 * - other 4xx: the registration genuinely failed, so degrade so the admin sees a
 *   reconnect prompt, but it is not a token-auth signal, so no reactive metric.
 */
async function degradeJiraOnRegistrationHttpFailure(
  env: Env,
  db: D1Database,
  installation: Pick<JiraWebhookInstallation, "businessId" | "jiraCloudId">,
  status: number,
  operation: string,
  opts: { degradeOnTransient: boolean },
): Promise<void> {
  const { durability } = classifyProviderHttpFailure(status, { resourceScoped: false });
  if (durability === "durable_auth") {
    await degradeJiraInstallationReactively(db, env, {
      businessId: installation.businessId,
      jiraCloudId: installation.jiraCloudId,
      operation,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
      httpStatus: status,
    });
    return;
  }
  if ((durability === "rate_limited" || durability === "transient") && !opts.degradeOnTransient) {
    return;
  }
  await markJiraWebhookInstallationDegraded(db, installation.businessId, installation.jiraCloudId);
}

/**
 * Registers the dynamic webhooks for a business binding and persists the
 * result on the installation row. Any per-item registration failure marks the
 * installation degraded instead of silently storing a partial set.
 * Returns true when registration fully succeeded.
 */
export async function registerJiraWebhooks(
  env: Env,
  db: D1Database,
  installation: Pick<JiraWebhookInstallation, "businessId" | "jiraCloudId" | "installationToken" | "connectedByUserId">,
): Promise<boolean> {
  const { businessId, jiraCloudId, installationToken, connectedByUserId } = installation;
  const accessToken = await getValidJiraToken(db, String(connectedByUserId), env);
  if (!accessToken) {
    log.warn({ businessId, jiraCloudId }, "Jira webhook registration skipped: binding credential unavailable");
    await degradeJiraInstallationReactively(db, env, {
      businessId,
      jiraCloudId,
      operation: "jira.webhook.register",
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
    });
    return false;
  }

  // Delete-then-register: a rebind (new installation token) or recovery
  // re-registration must not leave prior remote webhooks firing at a stale
  // URL until they expire.
  const existing = await getJiraWebhookInstallationByBusiness(db, businessId);
  if (existing && existing.jiraCloudId === jiraCloudId) {
    await deleteJiraWebhooksBestEffort(env, db, existing);
  }

  // Atlassian allows only one callback URL per user per app across all
  // environments, and rejects registration while any other URL is live (for
  // example a stale local-dev tunnel registration this row never recorded).
  // Clear everything the app registered for this user before registering.
  await deleteAllRemoteJiraWebhooksBestEffort(accessToken, jiraCloudId, businessId);

  const triggerLabel = jiraTriggerLabel(env);
  const callbackUrl = jiraWebhookCallbackUrl(env, installationToken);
  const registeredAt = Date.now();

  let response: Response;
  try {
    response = await tracedFetch(
      `${jiraApiBase(jiraCloudId)}/webhook`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          url: callbackUrl,
          webhooks: [
            {
              events: JIRA_WEBHOOK_EVENTS,
              // Escape quotes/backslashes: labels may legally contain them,
              // and an unescaped quote yields syntactically invalid JQL.
              jqlFilter: `labels = "${triggerLabel.replace(/(["\\])/g, "\\$1")}"`,
            },
          ],
        }),
        signal: AbortSignal.timeout(JIRA_WEBHOOK_TIMEOUT_MS),
      },
      "jira.webhook.register",
    );
  } catch (err) {
    log.error({ businessId, jiraCloudId, error: String(err) }, "Jira webhook registration request failed");
    await markJiraWebhookInstallationDegraded(db, businessId, jiraCloudId);
    return false;
  }

  if (!response.ok) {
    log.error({ businessId, jiraCloudId, status: response.status }, "Jira webhook registration rejected");
    // Registration deletes the remote webhooks before this POST, so even a
    // transient failure must surface as degraded rather than leaving the row
    // active with stale webhook IDs and no live webhooks.
    await degradeJiraOnRegistrationHttpFailure(
      env,
      db,
      { businessId, jiraCloudId },
      response.status,
      "jira.webhook.register",
      {
        degradeOnTransient: true,
      },
    );
    return false;
  }

  const body = (await response.json()) as {
    webhookRegistrationResult?: Array<{ createdWebhookId?: number; errors?: string[] }>;
  };
  const results = body.webhookRegistrationResult ?? [];
  const failures = results.filter((result) => !result.createdWebhookId);
  const created = results.map((result) => result.createdWebhookId).filter((id): id is number => typeof id === "number");

  if (failures.length > 0 || created.length === 0) {
    const errors = failures.flatMap((failure) => failure.errors ?? []).slice(0, 3);
    log.error({ businessId, jiraCloudId, errors }, "Jira webhook registration returned per-item failures");
    await markJiraWebhookInstallationDegraded(db, businessId, jiraCloudId);
    return false;
  }

  const expiresAt = registeredAt + JIRA_WEBHOOK_EXPIRY_MS;
  const webhooks: RegisteredJiraWebhook[] = created.map((webhookId) => ({
    webhookId,
    events: [...JIRA_WEBHOOK_EVENTS],
    expiresAt,
  }));
  await recordJiraWebhookRegistration(db, {
    businessId,
    jiraCloudId,
    webhooksJson: JSON.stringify(webhooks),
    triggerLabel,
    webhookExpiresAt: expiresAt,
  });
  log.info({ businessId, jiraCloudId, webhookIds: created }, "Jira dynamic webhooks registered");
  return true;
}

/**
 * Lists every dynamic webhook the app has registered for this user and
 * deletes them. Best-effort: a failure here surfaces as a registration
 * failure right after, which already marks the installation degraded.
 */
async function deleteAllRemoteJiraWebhooksBestEffort(
  accessToken: string,
  jiraCloudId: string,
  businessId: string,
): Promise<void> {
  try {
    const webhookIds: number[] = [];
    let startAt = 0;
    // Page cap is a runaway guard; the app registers a handful of webhooks.
    for (let page = 0; page < 10; page++) {
      const listResponse = await tracedFetch(
        `${jiraApiBase(jiraCloudId)}/webhook?startAt=${startAt}&maxResults=100`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          signal: AbortSignal.timeout(JIRA_WEBHOOK_TIMEOUT_MS),
        },
        "jira.webhook.list",
      );
      if (!listResponse.ok) {
        log.warn({ businessId, jiraCloudId, status: listResponse.status }, "Jira webhook listing failed; continuing");
        return;
      }
      const body = (await listResponse.json()) as {
        values?: Array<{ id?: unknown }>;
        isLast?: boolean;
      };
      const pageValues = body.values ?? [];
      const pageIds = pageValues
        .map((value) => value?.id)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
      webhookIds.push(...pageIds);
      // Missing isLast is treated as the last page on purpose: under-deleting
      // surfaces as a registration failure right after, never an infinite loop.
      if (body.isLast !== false || pageValues.length === 0) break;
      startAt += pageValues.length;
    }
    if (webhookIds.length === 0) return;

    const deleteResponse = await tracedFetch(
      `${jiraApiBase(jiraCloudId)}/webhook`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ webhookIds }),
        signal: AbortSignal.timeout(JIRA_WEBHOOK_TIMEOUT_MS),
      },
      "jira.webhook.delete",
    );
    if (!deleteResponse.ok) {
      log.warn(
        { businessId, jiraCloudId, status: deleteResponse.status, webhookIds },
        "Jira stale webhook deletion returned an error; continuing",
      );
      return;
    }
    log.info({ businessId, jiraCloudId, webhookIds }, "Deleted previously registered Jira webhooks before register");
  } catch (err) {
    log.warn({ businessId, jiraCloudId, error: String(err) }, "Jira stale webhook cleanup failed; continuing");
  }
}

/** Best-effort remote webhook deletion for disconnect/reconnect; never throws. */
export async function deleteJiraWebhooksBestEffort(
  env: Env,
  db: D1Database,
  installation: Pick<JiraWebhookInstallation, "businessId" | "jiraCloudId" | "connectedByUserId" | "webhooksJson">,
): Promise<void> {
  try {
    const webhookIds = parseJiraWebhookIds(installation.webhooksJson);
    if (webhookIds.length === 0) return;
    const accessToken = await getValidJiraToken(db, String(installation.connectedByUserId), env);
    if (!accessToken) return;

    const response = await tracedFetch(
      `${jiraApiBase(installation.jiraCloudId)}/webhook`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ webhookIds }),
        signal: AbortSignal.timeout(JIRA_WEBHOOK_TIMEOUT_MS),
      },
      "jira.webhook.delete",
    );
    if (!response.ok) {
      log.warn(
        { businessId: installation.businessId, status: response.status },
        "Jira webhook deletion returned an error; continuing",
      );
    }
  } catch (err) {
    log.warn({ businessId: installation.businessId, error: String(err) }, "Jira webhook deletion failed; continuing");
  }
}

export function parseJiraWebhookIds(webhooksJson: string | null): number[] {
  if (!webhooksJson) return [];
  try {
    const parsed = JSON.parse(webhooksJson) as Array<{ webhookId?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => entry?.webhookId)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  } catch {
    return [];
  }
}

/**
 * Refreshes dynamic webhook registrations that are inside the refresh window.
 * Refresh extends Atlassian's expiry by 30 days; auth or partial failures mark
 * the installation degraded so the admin sees a reconnect prompt in settings.
 */
export async function refreshDueJiraWebhooks(
  env: Env,
  options: { now?: number; logger?: ReturnType<typeof createLogger> } = {},
): Promise<{ refreshed: number; skipped: number; failed: number }> {
  const db = env.DB;
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now();
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  const installations = await listNonRevokedJiraWebhookInstallations(db);
  for (const installation of installations) {
    const webhookIds = parseJiraWebhookIds(installation.webhooksJson);
    if (webhookIds.length === 0) {
      // Registration never succeeded (e.g. transient failure during connect).
      // Retry the full registration so the installation can recover without a
      // manual reconnect.
      const registered = await registerJiraWebhooks(env, db, installation);
      if (registered) {
        refreshed += 1;
      } else {
        failed += 1;
      }
      continue;
    }
    const expiresAt = installation.webhookExpiresAt ?? 0;
    if (expiresAt > now + JIRA_WEBHOOK_REFRESH_WINDOW_MS) {
      skipped += 1;
      continue;
    }

    try {
      const accessToken = await getValidJiraToken(db, String(installation.connectedByUserId), env);
      if (!accessToken) {
        logger.warn(
          { businessId: installation.businessId, jiraCloudId: installation.jiraCloudId },
          "Jira webhook refresh failed: binding credential unavailable",
        );
        await degradeJiraInstallationReactively(db, env, {
          businessId: installation.businessId,
          jiraCloudId: installation.jiraCloudId,
          operation: "jira.webhook.refresh",
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
        });
        failed += 1;
        continue;
      }

      const response = await tracedFetch(
        `${jiraApiBase(installation.jiraCloudId)}/webhook/refresh`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ webhookIds }),
          signal: AbortSignal.timeout(JIRA_WEBHOOK_TIMEOUT_MS),
        },
        "jira.webhook.refresh",
      );

      if (!response.ok) {
        logger.warn({ businessId: installation.businessId, status: response.status }, "Jira webhook refresh rejected");
        // Refresh leaves the remote webhooks live, so a transient blip must not
        // disconnect a healthy integration; the next sweep retries.
        await degradeJiraOnRegistrationHttpFailure(
          env,
          db,
          { businessId: installation.businessId, jiraCloudId: installation.jiraCloudId },
          response.status,
          "jira.webhook.refresh",
          { degradeOnTransient: false },
        );
        failed += 1;
        continue;
      }

      const body = (await response.json()) as { expirationDate?: unknown };
      const expirationDate =
        typeof body.expirationDate === "number"
          ? body.expirationDate
          : typeof body.expirationDate === "string"
            ? Date.parse(body.expirationDate)
            : NaN;
      await updateJiraWebhookInstallationExpiry(db, {
        businessId: installation.businessId,
        jiraCloudId: installation.jiraCloudId,
        webhookExpiresAt: Number.isFinite(expirationDate) ? expirationDate : now + JIRA_WEBHOOK_EXPIRY_MS,
      });
      refreshed += 1;
    } catch (err) {
      logger.warn(
        { businessId: installation.businessId, error: String(err) },
        "Jira webhook refresh failed; marking installation degraded",
      );
      await markJiraWebhookInstallationDegraded(db, installation.businessId, installation.jiraCloudId);
      failed += 1;
    }
  }

  if (refreshed > 0 || failed > 0) {
    logger.info({ refreshed, skipped, failed }, "Jira webhook refresh sweep completed");
  }
  return { refreshed, skipped, failed };
}
