import type { EvalRating } from "../constants/eval";

const SESSION_EVALUATION_LOOKUP_BATCH_SIZE = 100;

export interface EvalSummaryRow {
  id: string;
  session_id: string;
  status: string;
  process_rating: EvalRating | null;
  code_rating: EvalRating | null;
  completeness_rating: EvalRating | null;
  overall_rating: EvalRating | null;
  summary: string | null;
  gap_classifications: string | null;
  memory_review_json: string | null;
  error: string | null;
  evaluator_model: string;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export async function getEvaluationsBySessions(
  db: D1Database,
  sessionIds: string[],
): Promise<Map<string, EvalSummaryRow[]>> {
  const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
  const evaluationsBySession = new Map<string, EvalSummaryRow[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return evaluationsBySession;

  for (let start = 0; start < ids.length; start += SESSION_EVALUATION_LOOKUP_BATCH_SIZE) {
    const batchIds = ids.slice(start, start + SESSION_EVALUATION_LOOKUP_BATCH_SIZE);
    const placeholders = batchIds.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT id, session_id, status, process_rating, code_rating, completeness_rating, overall_rating,
              summary, gap_classifications, memory_review_json, error, evaluator_model, duration_ms, created_at, completed_at
       FROM session_evaluations WHERE session_id IN (${placeholders}) ORDER BY session_id ASC, created_at DESC`,
      )
      .bind(...batchIds)
      .all<EvalSummaryRow>();

    for (const row of result.results) {
      const evaluations = evaluationsBySession.get(row.session_id);
      if (evaluations) {
        evaluations.push(row);
      }
    }
  }
  return evaluationsBySession;
}
