export interface CompanyMemorySessionScopeRow {
  business_id: string | null;
  owner_user_id: number | string;
  repo_owner: string | null;
  repo_name: string | null;
  callback_context_json: string | null;
}

export async function getCompanyMemorySessionScopeRow(
  db: D1Database,
  sessionId: string,
): Promise<CompanyMemorySessionScopeRow | null> {
  return db
    .prepare(
      `SELECT business_id, owner_user_id, repo_owner, repo_name, callback_context_json
       FROM session_index
       WHERE session_id = ?
       LIMIT 1`,
    )
    .bind(sessionId)
    .first<CompanyMemorySessionScopeRow>();
}
