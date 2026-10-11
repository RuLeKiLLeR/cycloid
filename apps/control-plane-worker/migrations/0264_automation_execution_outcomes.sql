ALTER TABLE automation_slot_jobs ADD COLUMN execution_outcome TEXT CHECK (
  execution_outcome IN ('completed', 'failed', 'blocked', 'superseded')
);
ALTER TABLE automation_slot_jobs ADD COLUMN execution_completed_at INTEGER;
ALTER TABLE automation_slot_jobs ADD COLUMN execution_reason TEXT CHECK (
  execution_reason IS NULL OR length(CAST(execution_reason AS BLOB)) <= 512
);

ALTER TABLE automation_event_jobs ADD COLUMN execution_outcome TEXT CHECK (
  execution_outcome IN ('completed', 'failed', 'blocked', 'superseded')
);
ALTER TABLE automation_event_jobs ADD COLUMN execution_completed_at INTEGER;
ALTER TABLE automation_event_jobs ADD COLUMN execution_reason TEXT CHECK (
  execution_reason IS NULL OR length(CAST(execution_reason AS BLOB)) <= 512
);

CREATE INDEX IF NOT EXISTS idx_automation_slot_jobs_unreconciled_session
  ON automation_slot_jobs (session_id, created_at)
  WHERE session_id IS NOT NULL AND execution_outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_automation_slot_jobs_execution_outcome
  ON automation_slot_jobs (execution_outcome, execution_completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_event_jobs_unreconciled_session
  ON automation_event_jobs (session_id, created_at)
  WHERE session_id IS NOT NULL AND execution_outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_automation_event_jobs_execution_outcome
  ON automation_event_jobs (business_id, execution_outcome, execution_completed_at DESC);
