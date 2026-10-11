import { PROMPT_RUNS_DEFAULT_LIMIT, PROMPT_RUNS_MAX_LIMIT } from "../constants/observability";
import { getAllSessionFeedback } from "../session/feedback-db";
import type { AuthInfo } from "../types";
import { buildSessionDebugSummary } from "./session-debug";

const SEARCH_SESSIONS_DEFAULT_LIMIT = 50;
const SEARCH_SESSIONS_MAX_LIMIT = 200;

/**
 * Get telemetry data for a specific session.
 */
export async function getSessionTelemetry(db: D1Database, sessionId: string, limit = PROMPT_RUNS_DEFAULT_LIMIT) {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), PROMPT_RUNS_MAX_LIMIT);
  const runs = await db
    .prepare(
      `SELECT id, session_id, prompt_id, owner_user_id, sandbox_id, modal_object_id,
              opencode_session_id, repo, model, agent, source, outcome, error_code,
              input_tokens, output_tokens, cost_usd_micros, duration_ms,
              tool_call_count, dd_trace_id, bt_span_id, created_at, completed_at
       FROM (
         SELECT id, session_id, prompt_id, owner_user_id, sandbox_id, modal_object_id,
                opencode_session_id, repo, model, agent, source, outcome, error_code,
                input_tokens, output_tokens, cost_usd_micros, duration_ms,
                tool_call_count, dd_trace_id, bt_span_id, created_at, completed_at
         FROM prompt_runs
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       )
       ORDER BY created_at ASC`,
    )
    .bind(sessionId, safeLimit)
    .all();

  return {
    sessionId,
    promptRuns: runs.results ?? [],
    links: {},
  };
}

/**
 * Query prompt runs with dynamic filters and access scoping.
 */
export async function queryPromptRuns(
  db: D1Database,
  filters: {
    repo?: string | null;
    model?: string | null;
    agent?: string | null;
    outcome?: string | null;
    errorCode?: string | null;
    sessionId?: string | null;
    promptId?: string | null;
    source?: string | null;
    createdAfter?: number | null;
    createdBefore?: number | null;
    limit?: number;
    offset?: number;
  },
  auth: AuthInfo,
) {
  // Clamp to a sane lower bound: a negative limit is truthy and would otherwise
  // pass straight through as `LIMIT -1`, which SQLite treats as unlimited and
  // returns the entire table in one unbounded response.
  const limit = Math.min(Math.max(1, filters.limit ?? PROMPT_RUNS_DEFAULT_LIMIT), PROMPT_RUNS_MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Cross-session observability intentionally stays owner-scoped for non-admins.
  // Shared business access requires per-session repo verification, which this
  // endpoint cannot prove across an arbitrary result set.
  if (auth.canAccessAllSessions) {
    // API tokens / admin — see everything
  } else {
    conditions.push("owner_user_id = ?");
    params.push(auth.userId);
  }

  if (filters.repo) {
    conditions.push("repo = ?");
    params.push(filters.repo);
  }
  if (filters.model) {
    conditions.push("model = ?");
    params.push(filters.model);
  }
  if (filters.agent) {
    conditions.push("agent = ?");
    params.push(filters.agent);
  }
  if (filters.outcome) {
    conditions.push("outcome = ?");
    params.push(filters.outcome);
  }
  if (filters.errorCode) {
    conditions.push("error_code = ?");
    params.push(filters.errorCode);
  }
  if (filters.sessionId) {
    conditions.push("session_id = ?");
    params.push(filters.sessionId);
  }
  if (filters.promptId) {
    conditions.push("prompt_id = ?");
    params.push(filters.promptId);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters.createdAfter != null) {
    conditions.push("created_at >= ?");
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore != null) {
    conditions.push("created_at <= ?");
    params.push(filters.createdBefore);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM prompt_runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();

  return {
    runs: result.results ?? [],
    limit,
    offset,
  };
}

/**
 * Session-deduped harm ranking over the outcome-truth layer (table `session_outcomes`).
 *
 * This is the metric the sandbox-reliability program is measured against: distinct
 * SESSIONS (not prompt-runs, so #4734 retry row-inflation is gone) that failed to reach
 * their intended terminal, by single attributed cause. `abandoned` sessions (no work /
 * user walked away) are excluded from the harm denominator. Admin-scoped: callers gate on
 * canAccessAllSessions before invoking — a per-owner harm aggregate is not meaningful.
 */
export async function querySessionOutcomeHarm(
  db: D1Database,
  range: { createdAfter?: number | null; createdBefore?: number | null },
) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (range.createdAfter != null) {
    conditions.push("recorded_at >= ?");
    params.push(range.createdAfter);
  }
  if (range.createdBefore != null) {
    conditions.push("recorded_at <= ?");
    params.push(range.createdBefore);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // SQL built into variables (not inlined into .prepare()) so the schema-validation
  // test skips the dynamic ${where} interpolation, matching queryPromptRuns above.
  const totalsSql = `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned
       FROM session_outcomes ${where}`;
  const totalsRow = await db
    .prepare(totalsSql)
    .bind(...params)
    .first<{ total: number; succeeded: number; failed: number; abandoned: number }>();

  const causeConditions = [...conditions, "outcome = 'failed'"];
  const causeWhere = `WHERE ${causeConditions.join(" AND ")}`;
  const causeSql = `SELECT COALESCE(failure_cause, 'unknown') AS failureCause, COUNT(*) AS failedSessions
       FROM session_outcomes ${causeWhere}
       GROUP BY COALESCE(failure_cause, 'unknown')
       ORDER BY failedSessions DESC, failureCause ASC`;
  const byCause = await db
    .prepare(causeSql)
    .bind(...params)
    .all<{ failureCause: string; failedSessions: number }>();

  const succeeded = totalsRow?.succeeded ?? 0;
  const failed = totalsRow?.failed ?? 0;
  const attempted = succeeded + failed;

  return {
    range,
    totals: {
      total: totalsRow?.total ?? 0,
      succeeded,
      failed,
      abandoned: totalsRow?.abandoned ?? 0,
      // Harm rate excludes abandoned sessions; null when no session attempted work.
      harmRate: attempted > 0 ? failed / attempted : null,
    },
    byCause: byCause.results ?? [],
  };
}

/**
 * Search sessions with filters that span session_index and prompt_runs.
 * When repo/model/outcome filters are used, joins through prompt_runs to find matching sessions.
 */
export async function searchSessions(
  db: D1Database,
  filters: {
    repo?: string | null;
    status?: string | null;
    model?: string | null;
    outcome?: string | null;
    createdAfter?: number | null;
    createdBefore?: number | null;
    limit?: number;
  },
  auth: AuthInfo,
) {
  // Same clamp as queryPromptRuns: a negative limit would pass through as the
  // SQLite `LIMIT -1` unlimited sentinel and dump every matching session row.
  const limit = Math.min(Math.max(1, filters.limit ?? SEARCH_SESSIONS_DEFAULT_LIMIT), SEARCH_SESSIONS_MAX_LIMIT);
  const needsPromptRunsJoin = !!(filters.repo || filters.model || filters.outcome);

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Cross-session observability intentionally stays owner-scoped for non-admins.
  // Shared business access requires per-session repo verification, which this
  // aggregate endpoint cannot prove across an arbitrary result set.
  if (auth.canAccessAllSessions) {
    // admin — see everything
  } else {
    conditions.push("s.owner_user_id = ?");
    params.push(auth.userId);
  }

  // Session-level filters
  if (filters.status) {
    conditions.push("s.status = ?");
    params.push(filters.status);
  }
  if (filters.createdAfter != null) {
    conditions.push("s.created_at >= ?");
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore != null) {
    conditions.push("s.created_at <= ?");
    params.push(filters.createdBefore);
  }

  // Prompt-runs-level filters
  if (filters.repo) {
    conditions.push("pr.repo = ?");
    params.push(filters.repo);
  }
  if (filters.model) {
    conditions.push("pr.model = ?");
    params.push(filters.model);
  }
  if (filters.outcome) {
    conditions.push("pr.outcome = ?");
    params.push(filters.outcome);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let sql: string;
  if (needsPromptRunsJoin) {
    sql = `
      SELECT s.session_id, s.owner_user_id, s.business_id, s.status, s.created_at, s.updated_at,
             s.closed_at, s.title, s.model, s.reasoning_effort,
             COUNT(pr.id) AS matching_prompt_count,
             SUM(CASE WHEN pr.outcome = 'failed' THEN 1 ELSE 0 END) AS matching_failed_count,
             SUM(COALESCE(pr.cost_usd_micros, 0)) AS matching_total_cost_usd_micros
      FROM session_index s
      INNER JOIN prompt_runs pr ON s.session_id = pr.session_id
      ${where}
      GROUP BY s.session_id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `;
  } else {
    sql = `
      SELECT s.session_id, s.owner_user_id, s.business_id, s.status, s.created_at, s.updated_at,
             s.closed_at, s.title, s.model, s.reasoning_effort,
             NULL AS matching_prompt_count,
             NULL AS matching_failed_count,
             NULL AS matching_total_cost_usd_micros
      FROM session_index s
      ${where}
      ORDER BY s.updated_at DESC
      LIMIT ?
    `;
  }
  params.push(limit);

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();

  return {
    sessions: result.results ?? [],
    limit,
  };
}

export async function getSessionFeedbackSummaries(db: D1Database, sessionId: string) {
  return getAllSessionFeedback(db, sessionId);
}

export { buildSessionDebugSummary };
