import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { getLinearTokens } from "./db";
import {
  type BusinessIntegrationHealthCheckRow,
  type IntegrationHealthStatus,
  listLatestBusinessIntegrationHealthChecks,
  recordBusinessIntegrationHealthCheck,
} from "./health-db";
import { parsePositiveEnvMs, sanitizedHealthExceptionDetails } from "./health-util";

const log = createLogger({ bindings: { component: "linear-health" } });

const LINEAR_HEALTH_OPERATION = "linear.viewer_org";
const LINEAR_HEALTH_CHECK_KIND = "basic";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LINEAR_HEALTH_TIMEOUT_MS = 10_000;

interface LinearHealthInstallationRow {
  business_id: string;
  linear_organization_id: string;
  linear_webhook_id: string | null;
  connected_by_user_id: number;
  updated_at: number | null;
}

interface RunLinearBusinessHealthCheckOptions {
  now?: number;
  logger?: Logger;
}

interface LinearBusinessHealthCheckResult {
  businessId: string;
  status: IntegrationHealthStatus;
  operation: string;
  checkedAt: number;
  latencyMs: number;
  diagnostic: string;
  failureReason: string | null;
  details: Record<string, unknown> | null;
}

interface LinearGraphQLError {
  message?: string;
  extensions?: { code?: string; statusCode?: number };
}

interface LinearGraphQLResponse {
  data?: {
    viewer?: { id?: string | null } | null;
    organization?: { id?: string | null; urlKey?: string | null; name?: string | null } | null;
  } | null;
  errors?: LinearGraphQLError[] | null;
}

function isAuthErrorCode(err: LinearGraphQLError): boolean {
  const code = err.extensions?.code;
  const statusCode = err.extensions?.statusCode;
  return code === "AUTHENTICATION_ERROR" || code === "FORBIDDEN" || statusCode === 401 || statusCode === 403;
}

// Linear's webhook(id:) query is gated behind the `admin` OAuth scope, which
// Cycloid does not request. Verifying webhook state from this check would
// require broadening every customer's OAuth consent. Webhook deletion remains
// detectable via Linear's webhook lifecycle events instead.
const LINEAR_HEALTH_QUERY = `query CycloidHealth {
  viewer { id }
  organization { id urlKey name }
}`;

async function listLinearHealthInstallations(db: D1Database): Promise<LinearHealthInstallationRow[]> {
  // A business can have multiple active rows (PK is business_id+org_id). The
  // sweep records one health row per business, so dedupe to the most-recent
  // active installation per business — otherwise the order rows come back in
  // determines which org gets checked and the rest are silently skipped.
  const rows = await db
    .prepare(
      `SELECT business_id, linear_organization_id, linear_webhook_id, connected_by_user_id, updated_at
       FROM linear_webhook_installations
       WHERE status = 'active'
       ORDER BY business_id ASC, updated_at DESC, linear_organization_id ASC`,
    )
    .all<LinearHealthInstallationRow>();
  const results = rows.results ?? [];
  const seen = new Set<string>();
  const deduped: LinearHealthInstallationRow[] = [];
  for (const row of results) {
    if (seen.has(row.business_id)) continue;
    seen.add(row.business_id);
    deduped.push(row);
  }
  return deduped;
}

function shouldCheckLinearBusiness(
  latest: BusinessIntegrationHealthCheckRow | null,
  installationUpdatedAt: number | null,
  now: number,
  intervalMs: number,
): boolean {
  return !latest || latest.checked_at <= now - intervalMs || latest.checked_at < (installationUpdatedAt ?? 0);
}

function summarizeLinearApiFailure(response: Response): string {
  if (response.status === 401 || response.status === 403) return "linear_auth_rejected";
  if (response.status === 429) return "linear_rate_limited";
  if (response.status >= 500) return "linear_server_error";
  return "linear_api_error";
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
): LinearBusinessHealthCheckResult {
  return {
    businessId,
    status: params.status,
    operation: LINEAR_HEALTH_OPERATION,
    checkedAt,
    latencyMs: Date.now() - startedAt,
    diagnostic: params.diagnostic,
    failureReason: params.failureReason,
    details: params.details,
  };
}

export async function runLinearBusinessHealthCheck(
  db: D1Database,
  env: Env,
  installation: LinearHealthInstallationRow,
  options: RunLinearBusinessHealthCheckOptions = {},
): Promise<LinearBusinessHealthCheckResult> {
  const logger = options.logger ?? log;
  const checkedAt = options.now ?? Date.now();
  const startedAt = Date.now();
  const businessId = installation.business_id;
  const expectedOrgId = installation.linear_organization_id;
  const webhookId = installation.linear_webhook_id;

  try {
    const tokens = await getLinearTokens(db, String(installation.connected_by_user_id), env.TOKEN_ENCRYPTION_KEY);
    if (!tokens?.accessToken) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "linear_installer_token_missing",
        failureReason:
          "The Linear installer's OAuth token is missing or could not be decrypted; the installer must reconnect Linear.",
        details: { installerUserId: installation.connected_by_user_id, expectedOrgId },
      });
    }

    const body = JSON.stringify({ query: LINEAR_HEALTH_QUERY });

    const response = await tracedFetch(
      LINEAR_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(LINEAR_HEALTH_TIMEOUT_MS),
      },
      "linear.health.viewer_org",
    );

    if (!response.ok) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: summarizeLinearApiFailure(response),
        failureReason: `Linear GraphQL API returned HTTP ${response.status}.`,
        details: { expectedOrgId, webhookId: webhookId ?? null },
      });
    }

    const parsed = (await response.json()) as LinearGraphQLResponse;
    if (parsed.errors && parsed.errors.length > 0) {
      const messages = parsed.errors
        .map((err) => err.message?.trim())
        .filter((m): m is string => Boolean(m))
        .slice(0, 3);
      const isAuth = parsed.errors.some(isAuthErrorCode);
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: isAuth ? "linear_auth_rejected" : "linear_graphql_error",
        failureReason: isAuth
          ? "Linear rejected the installer's OAuth token; the installer must reconnect Linear."
          : `Linear GraphQL returned errors: ${messages.join("; ") || "unspecified"}.`,
        details: { expectedOrgId, errors: messages },
      });
    }

    const data = parsed.data;
    if (!data || typeof data !== "object") {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "linear_response_shape_invalid",
        failureReason: "Linear GraphQL response did not include a data object.",
        details: { expectedOrgId },
      });
    }

    if (!data.viewer?.id) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "linear_viewer_missing",
        failureReason: "Linear GraphQL viewer field was missing or null.",
        details: { expectedOrgId },
      });
    }

    const orgId = data.organization?.id ?? null;
    if (!orgId || orgId !== expectedOrgId) {
      return buildBasicResult(businessId, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "linear_organization_mismatch",
        failureReason: orgId
          ? `Linear token now resolves to organization ${orgId}, but ${expectedOrgId} is on record.`
          : "Linear GraphQL did not return an organization for the installer's token.",
        details: { expectedOrgId, observedOrgId: orgId },
      });
    }

    return buildBasicResult(businessId, checkedAt, startedAt, {
      status: "passed",
      diagnostic: "linear_ok",
      failureReason: null,
      details: {
        expectedOrgId,
        organizationUrlKey: data.organization?.urlKey ?? null,
        webhookId: webhookId ?? null,
      },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    const sanitizedError = sanitizedHealthExceptionDetails(error, {
      timeoutFailureReason: "Linear GraphQL request timed out.",
      defaultFailureReason: "Linear health check failed unexpectedly.",
    });
    const diagnostic = isTimeout ? "linear_api_timeout" : "linear_health_exception";
    logger.warn({ businessId, diagnostic, errorName: sanitizedError.errorName }, "Linear health check failed");
    return buildBasicResult(businessId, checkedAt, startedAt, {
      status: "failed",
      diagnostic,
      failureReason: sanitizedError.failureReason,
      details: null,
    });
  }
}

async function recordLinearBusinessHealthCheck(db: D1Database, result: LinearBusinessHealthCheckResult): Promise<void> {
  await recordBusinessIntegrationHealthCheck(db, {
    businessId: result.businessId,
    integrationId: "linear",
    checkKind: LINEAR_HEALTH_CHECK_KIND,
    status: result.status,
    operation: result.operation,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    diagnostic: result.diagnostic,
    failureReason: result.failureReason,
    details: result.details,
  });
}

export async function runDueLinearHealthChecks(
  env: Env,
  options: { now?: number; logger?: Logger },
): Promise<{ checked: number; skipped: number; failed: number }> {
  const db = env.DB;
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now();
  const intervalMs = parsePositiveEnvMs(env.LINEAR_HEALTH_INTERVAL_MS, DEFAULT_LINEAR_HEALTH_INTERVAL_MS);
  const candidates = await listLinearHealthInstallations(db);
  const latestChecks = await listLatestBusinessIntegrationHealthChecks(
    db,
    candidates.map((candidate) => candidate.business_id),
    "linear",
    LINEAR_HEALTH_CHECK_KIND,
  );
  const latestChecksByBusinessId = new Map(latestChecks.map((check) => [check.business_id, check]));
  let checked = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (
      !shouldCheckLinearBusiness(
        latestChecksByBusinessId.get(candidate.business_id) ?? null,
        candidate.updated_at,
        now,
        intervalMs,
      )
    ) {
      skipped += 1;
      continue;
    }

    try {
      const result = await runLinearBusinessHealthCheck(db, env, candidate, { now, logger });
      await recordLinearBusinessHealthCheck(db, result);
      checked += 1;
      if (result.status !== "passed") failed += 1;
    } catch (error) {
      const sanitizedError = sanitizedHealthExceptionDetails(error, {
        timeoutFailureReason: "Linear GraphQL request timed out.",
        defaultFailureReason: "Linear health check failed unexpectedly.",
      });
      checked += 1;
      failed += 1;
      logger.warn(
        {
          businessId: candidate.business_id,
          installerUserId: candidate.connected_by_user_id,
          errorName: sanitizedError.errorName,
        },
        "Linear health check candidate failed",
      );
    }
  }

  if (checked > 0 || failed > 0) {
    logger.info({ checked, skipped, failed }, "Linear integration health sweep completed");
  }

  return { checked, skipped, failed };
}
