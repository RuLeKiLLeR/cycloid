import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STATUS,
  type IntegrationLifecycleReasonCode,
} from "../../../../shared/enums/integration-lifecycle.js";
import type {
  IntegrationCurrentHealth,
  IntegrationHealthCheck,
  IntegrationLifecycleSummary,
} from "../../../../shared/types/integrations.js";

const DISCONNECTED_REASON_CODES = new Set<string>([
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED,
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED,
  INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
  INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING,
  INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED,
  INTEGRATION_LIFECYCLE_REASON_CODE.ORG_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_NOT_INSTALLED,
]);

function stateFromFailure(
  reasonCode: IntegrationLifecycleReasonCode | string | null,
): IntegrationCurrentHealth["state"] {
  // Any failure that is not a known disconnect reason is treated as degraded
  // (this covers the transient codes — rate-limited / unavailable — and the
  // catch-all alike).
  if (reasonCode && DISCONNECTED_REASON_CODES.has(reasonCode)) return "disconnected";
  return "degraded";
}

function stateFromDiagnostic(diagnostic: string | null): IntegrationCurrentHealth["state"] {
  const normalized = diagnostic?.toLowerCase() ?? "";
  if (
    normalized.includes("token") ||
    normalized.includes("auth_rejected") ||
    normalized.includes("not_found") ||
    normalized.includes("access_denied") ||
    normalized.includes("missing") ||
    normalized.includes("mismatch")
  ) {
    return "disconnected";
  }
  return "degraded";
}

export function unknownIntegrationHealth(): IntegrationCurrentHealth {
  return {
    state: "unknown",
    source: "none",
    status: null,
    checkedAt: null,
    reasonCode: null,
    diagnostic: null,
    message: null,
  };
}

export function deriveCurrentIntegrationHealth(params: {
  health?: IntegrationHealthCheck | null;
  lifecycle?: IntegrationLifecycleSummary | null;
}): IntegrationCurrentHealth {
  const health = params.health ?? null;
  const lifecycle = params.lifecycle ?? null;
  const healthAt = health?.checkedAt ?? null;
  const lifecycleAt = lifecycle?.createdAt ?? null;

  if (health && (lifecycleAt === null || (healthAt !== null && healthAt >= lifecycleAt))) {
    return {
      state:
        health.status === "passed"
          ? "healthy"
          : health.status === "skipped"
            ? "degraded"
            : stateFromDiagnostic(health.diagnostic),
      source: "health_check",
      status: health.status,
      checkedAt: health.checkedAt,
      reasonCode: null,
      diagnostic: health.diagnostic,
      message: health.status === "passed" ? null : health.failureReason,
    };
  }

  if (lifecycle) {
    return {
      state:
        lifecycle.status === INTEGRATION_LIFECYCLE_STATUS.PASSED
          ? "healthy"
          : lifecycle.status === INTEGRATION_LIFECYCLE_STATUS.SKIPPED
            ? "degraded"
            : stateFromFailure(lifecycle.reasonCode),
      source: "lifecycle",
      status: lifecycle.status,
      checkedAt: lifecycle.createdAt,
      reasonCode: lifecycle.reasonCode,
      diagnostic: lifecycle.stage,
      message: lifecycle.status === INTEGRATION_LIFECYCLE_STATUS.PASSED ? null : lifecycle.message,
    };
  }

  return unknownIntegrationHealth();
}
