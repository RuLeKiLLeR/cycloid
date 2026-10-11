// Read-only DAO for the Activity dashboard. Every query is business-scoped;
// user scope adds an owner predicate. The selected window defines a session
// cohort, and usage/outcome aggregates are calculated for those sessions.

export interface ActivityQueryScope {
  businessId: string;
  ownerUserId: string | null;
}

export interface SessionSourceCounts {
  total: number;
  slack: number;
  automation: number;
  child: number;
  user: number;
}

function cohortWhere(
  alias: string,
  scope: ActivityQueryScope & { sinceIso: string },
): { sql: string; binds: unknown[] } {
  const conditions = [`${alias}.business_id = ?`, `${alias}.created_at >= ?`];
  const binds: unknown[] = [scope.businessId, scope.sinceIso];
  if (scope.ownerUserId !== null) {
    conditions.push(`${alias}.owner_user_id = ?`);
    binds.push(scope.ownerUserId);
  }
  return { sql: conditions.join(" AND "), binds };
}

function sourceCase(alias: string): string {
  return `CASE
    WHEN ${alias}.initiation_mode = 'automation' OR ${alias}.scheduled_rule_id IS NOT NULL THEN 'automation'
    WHEN ${alias}.initiation_mode = 'child' AND ${alias}.scheduled_rule_id IS NULL THEN 'child'
    WHEN ${alias}.initiation_mode NOT IN ('automation', 'child') AND ${alias}.scheduled_rule_id IS NULL
      AND json_extract(${alias}.callback_context_json, '$.source') = 'slack' THEN 'slack'
    ELSE 'user'
  END`;
}

export async function countSessionsBySource(
  db: D1Database,
  input: ActivityQueryScope & { sinceIso: string },
): Promise<SessionSourceCounts> {
  const cohort = cohortWhere("s", input);
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN ${sourceCase("s")} = 'automation' THEN 1 ELSE 0 END) AS automation,
         SUM(CASE WHEN ${sourceCase("s")} = 'child' THEN 1 ELSE 0 END) AS child,
         SUM(CASE WHEN ${sourceCase("s")} = 'slack' THEN 1 ELSE 0 END) AS slack,
         SUM(CASE WHEN ${sourceCase("s")} = 'user' THEN 1 ELSE 0 END) AS user
       FROM session_index s
       WHERE ${cohort.sql}`,
    )
    .bind(...cohort.binds)
    .first<{
      total: number;
      automation: number | null;
      child: number | null;
      slack: number | null;
      user: number | null;
    }>();
  return {
    total: row?.total ?? 0,
    slack: row?.slack ?? 0,
    automation: row?.automation ?? 0,
    child: row?.child ?? 0,
    user: row?.user ?? 0,
  };
}

export interface LifecycleEventRow {
  sessionId: string;
  event: string;
  fromState: string;
  toState: string;
  at: number;
  actor: string;
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
}

export async function listRecentLifecycleEvents(
  db: D1Database,
  input: ActivityQueryScope & { sinceIso: string; limit: number },
): Promise<LifecycleEventRow[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const cohort = cohortWhere("s", input);
  const result = await db
    .prepare(
      `SELECT e.session_id, e.event, e.from_state, e.to_state, e.at, e.actor,
              s.repo_owner, s.repo_name, s.title
       FROM pr_coordination_events e
       INNER JOIN session_index s ON s.session_id = e.session_id
       WHERE ${cohort.sql}
       ORDER BY e.at DESC, e.session_id DESC
       LIMIT ?`,
    )
    .bind(...cohort.binds, limit)
    .all<{
      session_id: string;
      event: string;
      from_state: string;
      to_state: string;
      at: number;
      actor: string;
      repo_owner: string | null;
      repo_name: string | null;
      title: string | null;
    }>();
  return (result.results ?? []).map((row) => ({
    sessionId: row.session_id,
    event: row.event,
    fromState: row.from_state,
    toState: row.to_state,
    at: row.at,
    actor: row.actor,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    title: row.title,
  }));
}

export interface ActivityTotals {
  sessions: number;
  sessionsWithPr: number;
  sessionsMerged: number;
  sessionsClosed: number;
  sessionsWithFeedback: number;
  feedbackTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
  mergedAdditions: number;
  mergedDeletions: number;
  mergedLocSessions: number;
}

// Exported for the schema-validation test: queries embed `${analytics.sql}` as
// a WITH-CTE prefix, and the test substitutes the real prefix so EXPLAIN
// validates the full statement (CTEs included) against the migrated schema.
export function analyticsCtes(input: ActivityQueryScope & { sinceIso: string }): { sql: string; binds: unknown[] } {
  const cohort = cohortWhere("s", input);
  return {
    binds: cohort.binds,
    sql: `WITH cohort AS (
    SELECT s.* FROM session_index s WHERE ${cohort.sql}
  ),
  usage_by_session AS (
    SELECT u.session_id,
           COUNT(DISTINCT prompt_id) AS prompt_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros
    FROM usage_records u
    INNER JOIN cohort c ON c.session_id = u.session_id
    GROUP BY u.session_id
  ),
  completion_outcomes AS (
    SELECT completions.session_id,
           MAX(completions.pr_url) AS pr_url,
           MAX(CASE WHEN completions.pr_outcome = 'merged' THEN 2
                    WHEN completions.pr_outcome = 'closed' THEN 1
                    ELSE 0 END) AS outcome_rank
    FROM session_completions completions
    INNER JOIN cohort c ON c.session_id = completions.session_id
    WHERE completions.pr_url IS NOT NULL
    GROUP BY completions.session_id
  ),
  latest_publish_stats AS (
    SELECT e.session_id,
           CAST(json_extract(e.metadata, '$.diffStats.insertions') AS INTEGER) AS additions,
           CAST(json_extract(e.metadata, '$.diffStats.deletions') AS INTEGER) AS deletions
    FROM pr_coordination_events e
    INNER JOIN cohort c ON c.session_id = e.session_id
    WHERE e.event = 'publish.pr_opened'
      AND json_type(e.metadata, '$.diffStats.insertions') IN ('integer', 'real')
      AND json_type(e.metadata, '$.diffStats.deletions') IN ('integer', 'real')
      AND e.version = (
        SELECT MAX(latest.version)
        FROM pr_coordination_events latest
        WHERE latest.session_id = e.session_id AND latest.event = 'publish.pr_opened'
      )
  )`,
  };
}

export async function getActivityTotals(
  db: D1Database,
  input: ActivityQueryScope & { sinceIso: string },
): Promise<ActivityTotals> {
  const analytics = analyticsCtes(input);
  const row = await db
    .prepare(
      `${analytics.sql}
       SELECT COUNT(*) AS sessions,
              SUM(CASE WHEN COALESCE(p.pr_url, completions.pr_url) IS NOT NULL THEN 1 ELSE 0 END) AS sessions_with_pr,
              SUM(CASE WHEN p.state = 'MERGED' OR completions.outcome_rank = 2 THEN 1 ELSE 0 END) AS sessions_merged,
              SUM(CASE WHEN p.state = 'CLOSED' OR (p.state IS NULL AND completions.outcome_rank = 1) THEN 1 ELSE 0 END)
                AS sessions_closed,
              SUM(CASE WHEN COALESCE(u.prompt_count, 0) > 1 THEN 1 ELSE 0 END) AS sessions_with_feedback,
              SUM(MAX(COALESCE(u.prompt_count, 0) - 1, 0)) AS feedback_turns,
              COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(u.cost_usd_micros), 0) AS cost_usd_micros,
              COALESCE(SUM(CASE WHEN p.state = 'MERGED' OR completions.outcome_rank = 2 THEN ps.additions ELSE 0 END), 0)
                AS merged_additions,
              COALESCE(SUM(CASE WHEN p.state = 'MERGED' OR completions.outcome_rank = 2 THEN ps.deletions ELSE 0 END), 0)
                AS merged_deletions,
              SUM(CASE WHEN (p.state = 'MERGED' OR completions.outcome_rank = 2)
                        AND ps.additions IS NOT NULL AND ps.deletions IS NOT NULL THEN 1 ELSE 0 END)
                AS merged_loc_sessions
       FROM cohort s
       LEFT JOIN pr_coordination p ON p.session_id = s.session_id
       LEFT JOIN completion_outcomes completions ON completions.session_id = s.session_id
       LEFT JOIN usage_by_session u ON u.session_id = s.session_id
       LEFT JOIN latest_publish_stats ps ON ps.session_id = s.session_id
      `,
    )
    .bind(...analytics.binds)
    .first<Record<string, number | null>>();
  return {
    sessions: row?.sessions ?? 0,
    sessionsWithPr: row?.sessions_with_pr ?? 0,
    sessionsMerged: row?.sessions_merged ?? 0,
    sessionsClosed: row?.sessions_closed ?? 0,
    sessionsWithFeedback: row?.sessions_with_feedback ?? 0,
    feedbackTurns: row?.feedback_turns ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    cacheWriteTokens: row?.cache_write_tokens ?? 0,
    costUsdMicros: row?.cost_usd_micros ?? 0,
    mergedAdditions: row?.merged_additions ?? 0,
    mergedDeletions: row?.merged_deletions ?? 0,
    mergedLocSessions: row?.merged_loc_sessions ?? 0,
  };
}

export interface ActivitySessionRow {
  sessionId: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  ownerLogin: string | null;
  createdAt: string;
  source: "slack" | "automation" | "child" | "user";
  promptCount: number;
  feedbackTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  prUrl: string | null;
  prStatus: "open" | "merged" | "closed" | null;
  mergedAdditions: number | null;
  mergedDeletions: number | null;
}

export async function listActivitySessions(
  db: D1Database,
  input: ActivityQueryScope & { sinceIso: string; limit: number },
): Promise<ActivitySessionRow[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const analytics = analyticsCtes(input);
  const result = await db
    .prepare(
      `${analytics.sql}
       SELECT s.session_id, s.title, s.repo_owner, s.repo_name, users.login AS owner_login, s.created_at,
              ${sourceCase("s")} AS source,
              COALESCE(u.prompt_count, 0) AS prompt_count,
              MAX(COALESCE(u.prompt_count, 0) - 1, 0) AS feedback_turns,
              COALESCE(u.input_tokens, 0) AS input_tokens,
              COALESCE(u.output_tokens, 0) AS output_tokens,
              COALESCE(u.cost_usd_micros, 0) AS cost_usd_micros,
              COALESCE(p.pr_url, completions.pr_url) AS pr_url,
              CASE WHEN p.state = 'MERGED' OR completions.outcome_rank = 2 THEN 'merged'
                   WHEN p.state = 'CLOSED' OR (p.state IS NULL AND completions.outcome_rank = 1) THEN 'closed'
                   WHEN COALESCE(p.pr_url, completions.pr_url) IS NOT NULL THEN 'open'
                   ELSE NULL END AS pr_status,
              CASE WHEN p.state = 'MERGED' OR completions.outcome_rank = 2 THEN ps.additions ELSE NULL END
                AS merged_additions,
              CASE WHEN p.state = 'MERGED' OR completions.outcome_rank = 2 THEN ps.deletions ELSE NULL END
                AS merged_deletions
       FROM cohort s
       LEFT JOIN users ON users.id = s.owner_user_id
       LEFT JOIN pr_coordination p ON p.session_id = s.session_id
       LEFT JOIN completion_outcomes completions ON completions.session_id = s.session_id
       LEFT JOIN usage_by_session u ON u.session_id = s.session_id
       LEFT JOIN latest_publish_stats ps ON ps.session_id = s.session_id
       ORDER BY s.created_at DESC, s.session_id DESC
       LIMIT ?`,
    )
    .bind(...analytics.binds, limit)
    .all<{
      session_id: string;
      title: string | null;
      repo_owner: string | null;
      repo_name: string | null;
      owner_login: string | null;
      created_at: string;
      source: ActivitySessionRow["source"];
      prompt_count: number;
      feedback_turns: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd_micros: number;
      pr_url: string | null;
      pr_status: ActivitySessionRow["prStatus"];
      merged_additions: number | null;
      merged_deletions: number | null;
    }>();
  return (result.results ?? []).map((row) => ({
    sessionId: row.session_id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    ownerLogin: row.owner_login,
    createdAt: row.created_at,
    source: row.source,
    promptCount: row.prompt_count,
    feedbackTurns: row.feedback_turns,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsdMicros: row.cost_usd_micros,
    prUrl: row.pr_url,
    prStatus: row.pr_status,
    mergedAdditions: row.merged_additions,
    mergedDeletions: row.merged_deletions,
  }));
}
