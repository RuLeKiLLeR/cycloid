import {
  getOpenAIGatewayUsageRowsForOwner,
  type OpenAIGatewayCredentialSource,
  type OpenAIGatewayUsageSummaryRow,
  type OpenAIVirtualKeyDisplayRow,
} from "./db";

type UsagePeriod = {
  periodStartMs: number;
  periodEndMs: number;
};

type OpenAIGatewayUsagePayload = {
  currentMonth: UsagePeriod & {
    spentUsdMicros: number;
    reservedUsdMicros: number;
    monthlyLimitUsdMicros: number;
    settledRequestCount: number;
    reservedRequestCount: number;
    releasedRequestCount: number;
    settlementUnresolvedRequestCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    sources: OpenAIGatewayUsageSourcePayload[];
  };
  virtualKeys: Array<{
    id: string;
    status: string;
    monthlyLimitUsdMicros: number;
    createdAt: number;
    updatedAt: number;
  }>;
};

type OpenAIGatewayUsageSourcePayload = {
  source: OpenAIGatewayCredentialSource;
  label: string;
  spentUsdMicros: number;
  reservedUsdMicros: number;
  settledRequestCount: number;
  reservedRequestCount: number;
  releasedRequestCount: number;
  settlementUnresolvedRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export function currentUtcMonthPeriod(now = Date.now()): UsagePeriod {
  const date = new Date(now);
  const periodStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const periodEndMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { periodStartMs, periodEndMs };
}

function mapKey(row: OpenAIVirtualKeyDisplayRow): OpenAIGatewayUsagePayload["virtualKeys"][number] {
  return {
    id: row.id,
    status: row.status,
    monthlyLimitUsdMicros: row.monthly_limit_usd_micros,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function labelForSource(source: OpenAIGatewayCredentialSource): string {
  switch (source) {
    case "managed_virtual_key":
      return "Cycloid managed key";
    case "user_byok":
      return "Your OpenAI key";
    case "business_byok":
      return "Workspace OpenAI key";
  }
}

function mapSource(row: OpenAIGatewayUsageSummaryRow): OpenAIGatewayUsageSourcePayload {
  const source = row.credential_source ?? "managed_virtual_key";
  return {
    source,
    label: labelForSource(source),
    spentUsdMicros: row.settled_cost_usd_micros,
    reservedUsdMicros: row.reserved_cost_usd_micros,
    settledRequestCount: row.settled_request_count,
    reservedRequestCount: row.reserved_request_count,
    releasedRequestCount: row.released_request_count,
    settlementUnresolvedRequestCount: row.settlement_unresolved_request_count,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
  };
}

function mapSummary(
  period: UsagePeriod,
  row: OpenAIGatewayUsageSummaryRow,
  sources: OpenAIGatewayUsageSourcePayload[],
): OpenAIGatewayUsagePayload["currentMonth"] {
  return {
    ...period,
    spentUsdMicros: row.settled_cost_usd_micros,
    reservedUsdMicros: row.reserved_cost_usd_micros,
    monthlyLimitUsdMicros: row.monthly_limit_usd_micros,
    settledRequestCount: row.settled_request_count,
    reservedRequestCount: row.reserved_request_count,
    releasedRequestCount: row.released_request_count,
    settlementUnresolvedRequestCount: row.settlement_unresolved_request_count,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    sources,
  };
}

export async function getOpenAIGatewayUsagePayload(
  db: D1Database,
  userId: number,
  now = Date.now(),
): Promise<OpenAIGatewayUsagePayload> {
  const period = currentUtcMonthPeriod(now);
  const rows = await getOpenAIGatewayUsageRowsForOwner(db, { ownerUserId: userId, ...period });

  return {
    currentMonth: mapSummary(period, rows.summary, rows.sourceSummaries.map(mapSource)),
    virtualKeys: rows.virtualKeys.map(mapKey),
  };
}
