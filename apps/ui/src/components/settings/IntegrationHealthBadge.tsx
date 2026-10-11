import type { BusinessIntegrationInfo } from "../../api/integrations";
import { INTEGRATION_FAILURE_FALLBACK_COPY, INTEGRATION_REASON_CODE_COPY } from "../../constants/integration-health";
import { CheckIcon, WarningIcon } from "../icons";
import { formatHealthCheckedAt } from "./integrationsShared";

type ResolvedStatus = {
  state: "healthy" | "degraded" | "disconnected";
  checkedAt: number | null;
  /** Plain-language detail sentence (omitted when healthy). */
  detail: string | null;
  /** Raw machine detail (reason code / diagnostic) surfaced via `title`. */
  raw: string | null;
};

function reasonCopy(reasonCode: string | null | undefined): string | null {
  return reasonCode ? (INTEGRATION_REASON_CODE_COPY[reasonCode] ?? null) : null;
}

/**
 * Collapse the server's three health signals (currentHealth projection,
 * lifecycle summary, last health check) into one renderable status. The
 * server-side `currentHealth` projection already merges the other two, so it
 * wins when present; the fallbacks only cover older payloads without it.
 */
function resolveStatus(info: BusinessIntegrationInfo): ResolvedStatus | null {
  const current = info.currentHealth;
  const lifecycle = info.lifecycle ?? null;
  const health = info.health ?? null;

  if (current && current.state !== "unknown") {
    // Server-curated messages (lifecycle or health-check failureReason) are
    // already audience-safe and more specific than the generic reason-code
    // copy, so they win when present.
    const detail =
      current.state === "healthy"
        ? null
        : (current.message ??
          (current.source === "lifecycle" ? (lifecycle?.message ?? null) : null) ??
          reasonCopy(current.reasonCode) ??
          INTEGRATION_FAILURE_FALLBACK_COPY);
    return {
      state: current.state,
      checkedAt: current.checkedAt,
      detail,
      raw: current.reasonCode ?? current.diagnostic,
    };
  }

  if (lifecycle && lifecycle.status === "failed") {
    return {
      state: "disconnected",
      checkedAt: lifecycle.createdAt,
      detail: lifecycle.message ?? reasonCopy(lifecycle.reasonCode) ?? INTEGRATION_FAILURE_FALLBACK_COPY,
      raw: lifecycle.reasonCode ?? lifecycle.stage,
    };
  }

  if (health) {
    if (health.status === "passed") {
      return { state: "healthy", checkedAt: health.checkedAt, detail: null, raw: health.operation };
    }
    return {
      state: health.status === "skipped" ? "degraded" : "disconnected",
      checkedAt: health.checkedAt,
      detail: health.failureReason ?? INTEGRATION_FAILURE_FALLBACK_COPY,
      raw: health.diagnostic || health.operation,
    };
  }

  return null;
}

/**
 * The one status line per workspace integration. Grayscale + icon for
 * working/degraded (per the accent discipline); the error hue is reserved for
 * the disconnected/failed state.
 */
export function IntegrationStatusLine({ info }: { info: BusinessIntegrationInfo }) {
  const status = resolveStatus(info);
  if (!status) return null;

  const checkedAt = formatHealthCheckedAt(status.checkedAt);
  const label = status.state === "healthy" ? "Working" : status.state === "degraded" ? "Degraded" : "Needs attention";
  const toneClass =
    status.state === "healthy"
      ? "text-text-secondary"
      : status.state === "degraded"
        ? "text-text-primary"
        : "text-error";

  return (
    <p
      role={status.state === "healthy" ? "status" : "alert"}
      title={status.raw ?? undefined}
      className={`mt-2 flex items-start gap-1.5 text-sm leading-relaxed ${toneClass}`}
    >
      {status.state === "healthy" ? (
        <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span>
        {label}.{status.detail ? ` ${status.detail}` : ""}
        {checkedAt ? ` Last checked ${checkedAt}.` : ""}
      </span>
    </p>
  );
}
