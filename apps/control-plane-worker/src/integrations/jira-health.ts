import { JIRA_ACCESSIBLE_RESOURCES_URL } from "../auth/constants";
import { getValidJiraToken } from "../auth/db";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { listNonRevokedJiraWebhookInstallations } from "../webhooks/db";
import {
  type BusinessIntegrationHealthCheckRow,
  type IntegrationHealthStatus,
  listLatestBusinessIntegrationHealthChecks,
  recordBusinessIntegrationHealthCheck,
} from "./health-db";
import { parsePositiveEnvMs, sanitizedHealthExceptionDetails } from "./health-util";

const log = createLogger({ bindings: { component: "jira-health" } });

const JIRA_HEALTH_OPERATION = "jira.accessible_resources";
const JIRA_HEALTH_CHECK_KIND = "basic";
const DEFAULT_JIRA_HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const JIRA_HEALTH_TIMEOUT_MS = 10_000;

interface JiraHealthInstallation {
  businessId: string;
  jiraCloudId: string;
  connectedByUserId: number;
  updatedAt: number | null;
  status: "active" | "degraded";
  webhookExpiresAt: number | null;
}

interface JiraBusinessHealthCheckResult {
  businessId: string;
  status: IntegrationHealthStatus;
  operation: string;
  checkedAt: number;
  latencyMs: number;
  diagnostic: string;
  failureReason: string | null;
  details: Record<string, unknown> | null;
}

function summarizeJiraApiFailure(response: Response): string {
  if (response.status === 401 || response.status === 403) return "jira_auth_rejected";
  if (response.status === 429) return "jira_rate_limited";
  if (response.status >= 500) return "jira_server_error";
  return "jira_api_error";
}

function buildBasicResult(
  businessId: string,
  checkedAt: number,
  startedAt: number,
  params: {
    status: IntegrationHealthStatus;
    diagnostic: string;
    failureReason: string | null;
    details: Record<string, unknown> | null;
  },
): JiraBusinessHealthCheckResult {
  return {
    businessId,
    status: params.status,
    operation: JIRA_HEALTH_OPERATION,
    checkedAt,
    latencyMs: Date.now() - startedAt,
    diagnostic: params.diagnostic,
    failureReason: params.failureReason,
    details: params.details,
  };
}

export async function runJiraBusinessHealthCheck(
  db: D1Database,
  env: Env,
  installation: JiraHealthInstallation,
  options: { now?: number; logger?: Logger },
): Promise<JiraBusinessHealthCheckResult> {
  const logger = options.logger ?? log;
  const checkedAt = options.now ?? Date.now();
  const startedAt = Date.now();
  const { businessId, jiraCloudId } = installation;

  try {
    // getValidJiraToken exercises the rotating-refresh path; an unrefreshable
    // binding credential is exactly what this check exists to surface.
    const accessToken = await getValidJiraToken(db, String(installation.connectedByUserId), env);
    if (!accessToken) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "jira_installer_token_missing",
        failureReason:
          "The Jira installer's OAuth token is missing or can no longer be refreshed; the installer must reconnect Jira.",
        details: { installerUserId: installation.connectedByUserId, expectedCloudId: jiraCloudId },
      });
    }

    const response = await tracedFetch(
      JIRA_ACCESSIBLE_RESOURCES_URL,
      {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(JIRA_HEALTH_TIMEOUT_MS),
      },
      "jira.health.accessible_resources",
    );

    if (!response.ok) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: summarizeJiraApiFailure(response),
        failureReason: `Atlassian accessible-resources returned HTTP ${response.status}.`,
        details: { expectedCloudId: jiraCloudId },
      });
    }

    const sites = (await response.json()) as Array<{ id?: string; url?: string }>;
    if (!Array.isArray(sites)) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "jira_response_shape_invalid",
        failureReason: "Atlassian accessible-resources response was not an array.",
        details: { expectedCloudId: jiraCloudId },
      });
    }

    const boundSite = sites.find((site) => site?.id === jiraCloudId);
    if (!boundSite) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "jira_site_access_lost",
        failureReason: `The installer's token no longer has access to the bound Jira site ${jiraCloudId}.`,
        details: { expectedCloudId: jiraCloudId, accessibleCount: sites.length },
      });
    }

    return buildBasicResult(businessId, checkedAt, startedAt, {
      status: "passed",
      diagnostic: "jira_ok",
      failureReason: null,
      details: {
        expectedCloudId: jiraCloudId,
        siteUrl: boundSite.url ?? null,
        installationStatus: installation.status,
        webhookExpiresAt: installation.webhookExpiresAt,
      },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    const sanitizedError = sanitizedHealthExceptionDetails(error, {
      timeoutFailureReason: "Atlassian accessible-resources request timed out.",
      defaultFailureReason: "Jira health check failed unexpectedly.",
    });
    const diagnostic = isTimeout ? "jira_api_timeout" : "jira_health_exception";
    logger.warn({ businessId, diagnostic, errorName: sanitizedError.errorName }, "Jira health check failed");
    return buildBasicResult(businessId, checkedAt, startedAt, {
      status: "failed",
      diagnostic,
      failureReason: sanitizedError.failureReason,
      details: null,
    });
  }
}

function shouldCheckJiraBusiness(
  latest: BusinessIntegrationHealthCheckRow | null,
  installationUpdatedAt: number | null,
  now: number,
  intervalMs: number,
): boolean {
  return !latest || latest.checked_at <= now - intervalMs || latest.checked_at < (installationUpdatedAt ?? 0);
}

export async function runDueJiraHealthChecks(
  env: Env,
  options: { now?: number; logger?: Logger },
): Promise<{ checked: number; skipped: number; failed: number }> {
  const db = env.DB;
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now();
  const intervalMs = parsePositiveEnvMs(env.JIRA_HEALTH_INTERVAL_MS, DEFAULT_JIRA_HEALTH_INTERVAL_MS);

  const installations = await listNonRevokedJiraWebhookInstallations(db);
  // One health row per business: prefer the most recently updated installation.
  const seen = new Set<string>();
  const candidates: JiraHealthInstallation[] = [];
  for (const installation of [...installations].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.jiraCloudId.localeCompare(b.jiraCloudId),
  )) {
    if (seen.has(installation.businessId)) continue;
    seen.add(installation.businessId);
    candidates.push({
      businessId: installation.businessId,
      jiraCloudId: installation.jiraCloudId,
      connectedByUserId: installation.connectedByUserId,
      updatedAt: installation.updatedAt,
      status: installation.status === "degraded" ? "degraded" : "active",
      webhookExpiresAt: installation.webhookExpiresAt,
    });
  }

  const latestChecks = await listLatestBusinessIntegrationHealthChecks(
    db,
    candidates.map((candidate) => candidate.businessId),
    "jira",
    JIRA_HEALTH_CHECK_KIND,
  );
  const latestChecksByBusinessId = new Map(latestChecks.map((check) => [check.business_id, check]));
  let checked = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (
      !shouldCheckJiraBusiness(
        latestChecksByBusinessId.get(candidate.businessId) ?? null,
        candidate.updatedAt,
        now,
        intervalMs,
      )
    ) {
      skipped += 1;
      continue;
    }

    try {
      const result = await runJiraBusinessHealthCheck(db, env, candidate, { now, logger });
      await recordBusinessIntegrationHealthCheck(db, {
        businessId: result.businessId,
        integrationId: "jira",
        checkKind: JIRA_HEALTH_CHECK_KIND,
        status: result.status,
        operation: result.operation,
        checkedAt: result.checkedAt,
        latencyMs: result.latencyMs,
        diagnostic: result.diagnostic,
        failureReason: result.failureReason,
        details: result.details,
      });
      checked += 1;
      if (result.status !== "passed") failed += 1;
    } catch (error) {
      const sanitizedError = sanitizedHealthExceptionDetails(error, {
        timeoutFailureReason: "Atlassian accessible-resources request timed out.",
        defaultFailureReason: "Jira health check failed unexpectedly.",
      });
      checked += 1;
      failed += 1;
      logger.warn(
        {
          businessId: candidate.businessId,
          installerUserId: candidate.connectedByUserId,
          errorName: sanitizedError.errorName,
        },
        "Jira health check candidate failed",
      );
    }
  }

  if (checked > 0 || failed > 0) {
    logger.info({ checked, skipped, failed }, "Jira integration health sweep completed");
  }

  return { checked, skipped, failed };
}
