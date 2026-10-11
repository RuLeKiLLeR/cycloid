import { computeSha256Hex, generateRandomHex } from "../utils";

export type OpenAIVirtualKeyRow = {
  id: string;
  key_hash: string;
  owner_user_id: string;
  business_id: string | null;
  monthly_limit_usd_micros: number;
  status: string;
  created_at: number;
  updated_at: number;
};

export type OpenAIVirtualKeyDisplayRow = Pick<
  OpenAIVirtualKeyRow,
  "id" | "status" | "monthly_limit_usd_micros" | "created_at" | "updated_at"
>;

export type OpenAIGatewayUsageSummaryRow = {
  credential_source?: OpenAIGatewayCredentialSource;
  settled_cost_usd_micros: number;
  reserved_cost_usd_micros: number;
  monthly_limit_usd_micros: number;
  settled_request_count: number;
  reserved_request_count: number;
  released_request_count: number;
  settlement_unresolved_request_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type OpenAIGatewayCredentialSource = "managed_virtual_key" | "user_byok" | "business_byok";

export type OpenAIGatewaySessionTokenRow = {
  token_hash: string;
  owner_user_id: number;
  business_id: string | null;
  credential_source: Extract<OpenAIGatewayCredentialSource, "user_byok" | "business_byok">;
  credential_provider: "openai";
  credential_owner_id: string;
  session_id: string;
  expires_at: number;
  created_at: number;
};

export type OpenAIGatewayUsageRows = {
  virtualKeys: OpenAIVirtualKeyDisplayRow[];
  summary: OpenAIGatewayUsageSummaryRow;
  sourceSummaries: OpenAIGatewayUsageSummaryRow[];
};

type OpenAIGatewayLedgerStatus = "reserved" | "settled" | "released" | "settlement_unresolved";
export type OpenAIGatewaySettlementSource =
  | "response_completed"
  | "response_incomplete"
  | "response_retrieve"
  | "openai_costs_reconcile"
  | "compact_estimate"
  | "none";

type CreateLedgerParams = {
  id: string;
  virtualKeyId: string | null;
  ownerUserId: string;
  businessId: string | null;
  sessionId: string | null;
  promptId: string | null;
  requestId: string;
  model: string;
  credentialSource: OpenAIGatewayCredentialSource;
  upstreamCredentialRef: string | null;
  estimatedCostUsdMicros: number;
  reservedCostUsdMicros: number;
  now: number;
};

type SettleLedgerParams = {
  ledgerId: string;
  openaiResponseId: string | null;
  actualCostUsdMicros: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  settlementSource: OpenAIGatewaySettlementSource;
  rawUsageJson: string;
  now: number;
};

type ReleaseLedgerParams = {
  ledgerId: string;
  status: Extract<OpenAIGatewayLedgerStatus, "released" | "settlement_unresolved">;
  openaiResponseId?: string | null;
  unresolvedReason?: string | null;
  now: number;
};

export async function hashVirtualKey(secret: string): Promise<string> {
  return computeSha256Hex(secret);
}

export async function getVirtualKeyBySecret(db: D1Database, secret: string): Promise<OpenAIVirtualKeyRow | null> {
  const keyHash = await hashVirtualKey(secret);
  return db
    .prepare(`SELECT * FROM openai_virtual_keys WHERE key_hash = ? AND status = 'active' LIMIT 1`)
    .bind(keyHash)
    .first<OpenAIVirtualKeyRow>();
}

export async function createOpenAIGatewaySessionToken(
  db: D1Database,
  params: {
    ownerUserId: number;
    businessId: string | null;
    credentialSource: Extract<OpenAIGatewayCredentialSource, "user_byok" | "business_byok">;
    credentialOwnerId: string;
    sessionId: string;
    expiresAt: number;
    now?: number;
  },
): Promise<{ token: string; tokenHash: string }> {
  const token = `arc-gw-${generateRandomHex(32)}`;
  const tokenHash = await computeSha256Hex(token);
  const now = params.now ?? Date.now();
  await db
    .prepare(
      `INSERT INTO openai_gateway_session_tokens (
        token_hash, owner_user_id, business_id, credential_source, credential_provider,
        credential_owner_id, session_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, 'openai', ?, ?, ?, ?)`,
    )
    .bind(
      tokenHash,
      params.ownerUserId,
      params.businessId,
      params.credentialSource,
      params.credentialOwnerId,
      params.sessionId,
      params.expiresAt,
      now,
    )
    .run();
  return { token, tokenHash };
}

export async function getOpenAIGatewaySessionTokenBySecret(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<OpenAIGatewaySessionTokenRow | null> {
  const tokenHash = await computeSha256Hex(token);
  const row = await db
    .prepare(
      `SELECT *
       FROM openai_gateway_session_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<OpenAIGatewaySessionTokenRow>();
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.prepare("DELETE FROM openai_gateway_session_tokens WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return row;
}

function normalizeUsageSummary(
  row: Partial<OpenAIGatewayUsageSummaryRow> | null | undefined,
  monthlyLimitUsdMicros: number,
): OpenAIGatewayUsageSummaryRow {
  const summary: OpenAIGatewayUsageSummaryRow = {
    settled_cost_usd_micros: Number(row?.settled_cost_usd_micros ?? 0),
    reserved_cost_usd_micros: Number(row?.reserved_cost_usd_micros ?? 0),
    monthly_limit_usd_micros: Number(monthlyLimitUsdMicros ?? 0),
    settled_request_count: Number(row?.settled_request_count ?? 0),
    reserved_request_count: Number(row?.reserved_request_count ?? 0),
    released_request_count: Number(row?.released_request_count ?? 0),
    settlement_unresolved_request_count: Number(row?.settlement_unresolved_request_count ?? 0),
    input_tokens: Number(row?.input_tokens ?? 0),
    cached_input_tokens: Number(row?.cached_input_tokens ?? 0),
    output_tokens: Number(row?.output_tokens ?? 0),
    reasoning_output_tokens: Number(row?.reasoning_output_tokens ?? 0),
  };
  if (row?.credential_source) summary.credential_source = row.credential_source;
  return summary;
}

export async function getOpenAIGatewayUsageRowsForOwner(
  db: D1Database,
  params: { ownerUserId: number; periodStartMs: number; periodEndMs: number },
): Promise<OpenAIGatewayUsageRows> {
  const [keyResult, usageResult, limitResult, sourceResult] = await db.batch([
    db
      .prepare(
        `SELECT id, status, monthly_limit_usd_micros, created_at, updated_at
         FROM openai_virtual_keys
         WHERE owner_user_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(String(params.ownerUserId)),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN actual_cost_usd_micros ELSE 0 END), 0) AS settled_cost_usd_micros,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'reserved' THEN reserved_cost_usd_micros ELSE 0 END), 0) AS reserved_cost_usd_micros,
           SUM(CASE WHEN lifecycle_status = 'settled' THEN 1 ELSE 0 END) AS settled_request_count,
           SUM(CASE WHEN lifecycle_status = 'reserved' THEN 1 ELSE 0 END) AS reserved_request_count,
           SUM(CASE WHEN lifecycle_status = 'released' THEN 1 ELSE 0 END) AS released_request_count,
           SUM(CASE WHEN lifecycle_status = 'settlement_unresolved' THEN 1 ELSE 0 END) AS settlement_unresolved_request_count,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN reasoning_output_tokens ELSE 0 END), 0) AS reasoning_output_tokens
         FROM openai_gateway_ledger
         WHERE owner_user_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .bind(String(params.ownerUserId), params.periodStartMs, params.periodEndMs),
    db
      .prepare(
        `SELECT COALESCE(SUM(monthly_limit_usd_micros), 0) AS monthly_limit_usd_micros
         FROM openai_virtual_keys
         WHERE owner_user_id = ? AND status = 'active'`,
      )
      .bind(String(params.ownerUserId)),
    db
      .prepare(
        `SELECT
           credential_source,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN actual_cost_usd_micros ELSE 0 END), 0) AS settled_cost_usd_micros,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'reserved' THEN reserved_cost_usd_micros ELSE 0 END), 0) AS reserved_cost_usd_micros,
           SUM(CASE WHEN lifecycle_status = 'settled' THEN 1 ELSE 0 END) AS settled_request_count,
           SUM(CASE WHEN lifecycle_status = 'reserved' THEN 1 ELSE 0 END) AS reserved_request_count,
           SUM(CASE WHEN lifecycle_status = 'released' THEN 1 ELSE 0 END) AS released_request_count,
           SUM(CASE WHEN lifecycle_status = 'settlement_unresolved' THEN 1 ELSE 0 END) AS settlement_unresolved_request_count,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
           COALESCE(SUM(CASE WHEN lifecycle_status = 'settled' THEN reasoning_output_tokens ELSE 0 END), 0) AS reasoning_output_tokens
         FROM openai_gateway_ledger
         WHERE owner_user_id = ? AND created_at >= ? AND created_at < ?
         GROUP BY credential_source
         ORDER BY credential_source ASC`,
      )
      .bind(String(params.ownerUserId), params.periodStartMs, params.periodEndMs),
  ]);

  const usage = ((usageResult.results as OpenAIGatewayUsageSummaryRow[]) ?? [])[0] ?? {};
  const limit = ((limitResult.results as Array<{ monthly_limit_usd_micros: number }>) ?? [])[0] ?? {
    monthly_limit_usd_micros: 0,
  };
  return {
    virtualKeys: (keyResult.results ?? []) as OpenAIVirtualKeyDisplayRow[],
    summary: normalizeUsageSummary(usage, limit.monthly_limit_usd_micros),
    sourceSummaries: ((sourceResult.results ?? []) as OpenAIGatewayUsageSummaryRow[]).map((row) =>
      normalizeUsageSummary({ ...row, credential_source: row.credential_source ?? "managed_virtual_key" }, 0),
    ),
  };
}

export async function insertGatewayLedgerRow(db: D1Database, params: CreateLedgerParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO openai_gateway_ledger (
        id, virtual_key_id, owner_user_id, business_id, session_id, prompt_id, request_id, model,
        credential_source, upstream_credential_ref, lifecycle_status, estimated_cost_usd_micros,
        reserved_cost_usd_micros, settlement_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 'none', ?, ?)`,
    )
    .bind(
      params.id,
      params.virtualKeyId,
      params.ownerUserId,
      params.businessId,
      params.sessionId,
      params.promptId,
      params.requestId,
      params.model,
      params.credentialSource,
      params.upstreamCredentialRef,
      params.estimatedCostUsdMicros,
      params.reservedCostUsdMicros,
      params.now,
      params.now,
    )
    .run();
}

export async function settleGatewayLedgerRow(db: D1Database, params: SettleLedgerParams): Promise<void> {
  await db
    .prepare(
      `UPDATE openai_gateway_ledger
       SET lifecycle_status = 'settled',
           openai_response_id = COALESCE(?, openai_response_id),
           actual_cost_usd_micros = ?,
           input_tokens = ?,
           cached_input_tokens = ?,
           output_tokens = ?,
           reasoning_output_tokens = ?,
           settlement_source = ?,
           raw_usage_json = ?,
           updated_at = ?,
           settled_at = ?
       WHERE id = ? AND lifecycle_status = 'reserved'`,
    )
    .bind(
      params.openaiResponseId,
      params.actualCostUsdMicros,
      params.inputTokens,
      params.cachedInputTokens,
      params.outputTokens,
      params.reasoningOutputTokens,
      params.settlementSource,
      params.rawUsageJson,
      params.now,
      params.now,
      params.ledgerId,
    )
    .run();
}

export async function releaseGatewayLedgerRow(db: D1Database, params: ReleaseLedgerParams): Promise<void> {
  await db
    .prepare(
      `UPDATE openai_gateway_ledger
       SET lifecycle_status = ?,
           openai_response_id = COALESCE(?, openai_response_id),
           settlement_source = 'none',
           unresolved_reason = ?,
           actual_cost_usd_micros = 0,
           updated_at = ?
       WHERE id = ? AND lifecycle_status = 'reserved'`,
    )
    .bind(params.status, params.openaiResponseId ?? null, params.unresolvedReason ?? null, params.now, params.ledgerId)
    .run();
}

export async function sumManagedVirtualKeySettledGatewayCostMicros(
  db: D1Database,
  params: { periodStartMs: number; periodEndMs: number },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(actual_cost_usd_micros), 0) AS total
       FROM openai_gateway_ledger
       WHERE lifecycle_status = 'settled'
         AND credential_source = 'managed_virtual_key'
         AND settled_at >= ?
         AND settled_at < ?`,
    )
    .bind(params.periodStartMs, params.periodEndMs)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function sumSettledGatewayCostMicrosByCredentialSource(
  db: D1Database,
  params: { periodStartMs: number; periodEndMs: number },
): Promise<Record<OpenAIGatewayCredentialSource, number>> {
  const rows = await db
    .prepare(
      `SELECT credential_source AS credentialSource,
              COALESCE(SUM(actual_cost_usd_micros), 0) AS total
       FROM openai_gateway_ledger
       WHERE lifecycle_status = 'settled'
         AND settled_at >= ?
         AND settled_at < ?
       GROUP BY credential_source`,
    )
    .bind(params.periodStartMs, params.periodEndMs)
    .all<{ credentialSource: OpenAIGatewayCredentialSource | null; total: number }>();
  const totals: Record<OpenAIGatewayCredentialSource, number> = {
    managed_virtual_key: 0,
    user_byok: 0,
    business_byok: 0,
  };
  for (const row of rows.results ?? []) {
    const source = row.credentialSource ?? "managed_virtual_key";
    if (source === "managed_virtual_key" || source === "user_byok" || source === "business_byok") {
      totals[source] = row.total;
    }
  }
  return totals;
}
