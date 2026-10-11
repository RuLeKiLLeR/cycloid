import { type PerPromptUsage, USD_TO_MICROS } from "../constants/sessions";
import { resolveRequiredBusinessId } from "./business-id";

// ---------------------------------------------------------------------------
// D1 write: insert a usage record on prompt completion
// ---------------------------------------------------------------------------

export async function insertUsageRecord(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string | null;
    ownerUserId: string;
    businessId: string | null;
    source: string;
    usage: PerPromptUsage;
  },
): Promise<void> {
  const id =
    params.promptId === null ? crypto.randomUUID() : `usage:${params.sessionId}:${params.promptId}:${params.source}`;
  const businessId = await resolveRequiredBusinessId(db, {
    operation: "usage_records insert",
    sessionId: params.sessionId,
    ownerUserId: params.ownerUserId,
    businessId: params.businessId,
  });

  await db
    .prepare(
      `INSERT INTO usage_records (id, session_id, prompt_id, owner_user_id, business_id, source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         business_id = excluded.business_id,
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         cost_usd_micros = excluded.cost_usd_micros`,
    )
    .bind(
      id,
      params.sessionId,
      params.promptId,
      params.ownerUserId,
      businessId,
      params.source,
      params.usage.model ?? null,
      params.usage.inputTokens,
      params.usage.outputTokens,
      params.usage.cacheReadTokens,
      params.usage.cacheWriteTokens,
      Math.round(params.usage.totalCostUsd * USD_TO_MICROS),
      Date.now(),
    )
    .run();
}
