import { useCallback, useState } from "react";

import { fetchOpenAIGatewayUsage } from "../../api/settings";
import { useMountEffect } from "../../hooks/useEffects";
import type { OpenAIGatewayUsage } from "../../types";
import { SettingsError, SettingsPageHeader, SettingsSection, SettingsSkeleton } from "./SettingsLayout";

// Two decimals: micro-dollar readouts like "$0.151087" read as raw data, not a
// bill. Cents precision is what users reason about.
const USD_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUMBER_FORMATTER = new Intl.NumberFormat();

const MONTH_RANGE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatUsd(micros: number): string {
  return USD_FORMATTER.format(micros / 1_000_000);
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatMonthRange(startMs: number, endMs: number): string {
  return `${MONTH_RANGE_FORMATTER.format(new Date(startMs))} – ${MONTH_RANGE_FORMATTER.format(new Date(endMs - 1))}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface-2 px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 font-mono-tabular text-lg font-medium text-text-primary">{value}</p>
    </div>
  );
}

function SourceUsageRow({ source }: { source: OpenAIGatewayUsage["currentMonth"]["sources"][number] }) {
  return (
    <div className="grid gap-3 border-t border-border px-4 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_repeat(4,minmax(7rem,auto))] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">{source.label}</p>
        <p className="mt-1 text-xs text-text-muted">
          <span className="numeral">{formatNumber(source.settledRequestCount)}</span>{" "}
          {source.settledRequestCount === 1 ? "request" : "requests"}
        </p>
      </div>
      <div>
        <p className="eyebrow">Spend</p>
        <p className="mt-1 font-mono-tabular text-sm text-text-primary">{formatUsd(source.spentUsdMicros)}</p>
      </div>
      <div>
        <p className="eyebrow">Reserved</p>
        <p className="mt-1 font-mono-tabular text-sm text-text-primary">{formatUsd(source.reservedUsdMicros)}</p>
      </div>
      <div>
        <p className="eyebrow">Input</p>
        <p className="mt-1 font-mono-tabular text-sm text-text-primary">{formatNumber(source.inputTokens)}</p>
      </div>
      <div>
        <p className="eyebrow">Output</p>
        <p className="mt-1 font-mono-tabular text-sm text-text-primary">{formatNumber(source.outputTokens)}</p>
      </div>
    </div>
  );
}

export function UsageSettings() {
  const [usage, setUsage] = useState<OpenAIGatewayUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchOpenAIGatewayUsage()
      .then((payload) => {
        setUsage(payload);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load usage."));
  }, []);

  useMountEffect(load);

  if (error) return <SettingsError message={error} onRetry={load} />;
  if (!usage) return <SettingsSkeleton rows={3} control={false} />;

  const month = usage.currentMonth;
  const sources = month.sources ?? [];
  return (
    <div className="editorial-fade space-y-6">
      <SettingsPageHeader
        eyebrow="Usage"
        title="Usage"
        description="Current-month OpenAI spend routed through Cycloid. Spend resets on the first of each month."
      />

      <SettingsSection title="OpenAI spend" description={formatMonthRange(month.periodStartMs, month.periodEndMs)}>
        <div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Spend this month" value={formatUsd(month.spentUsdMicros)} />
            {/* The limit is SUM(monthly_limit) over managed keys; 0 means no
                managed key/limit exists, not a $0.00 allowance. */}
            <Metric
              label="Managed limit"
              value={month.monthlyLimitUsdMicros > 0 ? formatUsd(month.monthlyLimitUsdMicros) : "No limit set"}
            />
            <Metric label="Requests" value={formatNumber(month.settledRequestCount)} />
          </div>
          <details className="mt-3 border border-border bg-surface-1">
            <summary className="eyebrow cursor-pointer px-4 py-2.5">Token detail</summary>
            <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-5">
              <Metric label="Reserved" value={formatUsd(month.reservedUsdMicros)} />
              <Metric label="Input" value={formatNumber(month.inputTokens)} />
              <Metric label="Cached input" value={formatNumber(month.cachedInputTokens)} />
              <Metric label="Output" value={formatNumber(month.outputTokens)} />
              <Metric label="Reasoning" value={formatNumber(month.reasoningOutputTokens)} />
            </div>
          </details>
        </div>
      </SettingsSection>

      {sources.length > 1 ? (
        <SettingsSection title="Sources" description="Spend grouped by the OpenAI credential Cycloid routed through.">
          <div className="divide-y divide-border overflow-hidden border border-border">
            {sources.map((source) => (
              <SourceUsageRow key={source.source} source={source} />
            ))}
          </div>
        </SettingsSection>
      ) : null}

      {month.settlementUnresolvedRequestCount > 0 ? (
        <p className="text-xs text-warning">
          {formatNumber(month.settlementUnresolvedRequestCount)}{" "}
          {month.settlementUnresolvedRequestCount === 1 ? "request" : "requests"} finished without recorded usage and{" "}
          {month.settlementUnresolvedRequestCount === 1 ? "was" : "were"} not charged.
        </p>
      ) : null}
    </div>
  );
}
