-- Allow multiple evaluators per session+PR by including evaluator_model in unique index
DROP INDEX IF EXISTS idx_session_evaluations_unique_session_pr;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_evaluations_unique_session_pr
  ON session_evaluations(session_id, pr_number, evaluator_model);
