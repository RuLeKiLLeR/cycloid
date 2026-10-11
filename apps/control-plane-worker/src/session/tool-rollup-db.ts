import { d1Changed } from "../db/errors";

export interface PromptToolRollupRow {
  sessionId: string;
  promptId: string;
  businessId: string;
  ownerUserId: number;
  agent: string | null;
  toolName: string;
  mcpServer: string | null;
  okCount: number;
  errorCount: number;
  totalDurationMs: number;
  durationSampleCount: number;
  createdAt: number;
}

const MAX_BATCH_STATEMENTS = 50;

export async function insertToolRollupRows(
  db: D1Database,
  rows: PromptToolRollupRow[],
): Promise<PromptToolRollupRow[]> {
  if (rows.length === 0) return [];

  const inserted: PromptToolRollupRow[] = [];
  for (let index = 0; index < rows.length; index += MAX_BATCH_STATEMENTS) {
    const chunk = rows.slice(index, index + MAX_BATCH_STATEMENTS);
    const statements = chunk.map((row) =>
      db
        .prepare(
          `INSERT INTO prompt_tool_rollup (
            session_id, prompt_id, business_id, owner_user_id, agent, tool_name, mcp_server,
            ok_count, error_count, total_duration_ms, duration_sample_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, prompt_id, tool_name) DO NOTHING`,
        )
        .bind(
          row.sessionId,
          row.promptId,
          row.businessId,
          row.ownerUserId,
          row.agent,
          row.toolName,
          row.mcpServer,
          row.okCount,
          row.errorCount,
          row.totalDurationMs,
          row.durationSampleCount,
          row.createdAt,
        ),
    );
    const results = await db.batch(statements);
    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      if (results[resultIndex] && d1Changed(results[resultIndex])) {
        inserted.push(chunk[resultIndex]!);
      }
    }
  }

  return inserted;
}
